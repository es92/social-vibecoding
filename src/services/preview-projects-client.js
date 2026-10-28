'use strict';

// Projects made inside a platform preview: the preview's half.
//
// In a preview, making a project runs the platform's own code end to end,
// as in production: the create dialog, app-creation's setup, app delivery's
// first deploy. The steps a preview may not take itself are handed to
// production (services/preview-projects.js has the why and the limits):
//
//   app-creator.js     the project's database (createDatabase below)
//   application-runtime.js
//                      build and deploy, and everything later done to the
//                      running project (status, health, logs, restart,
//                      removal): a project made here has runtime_kind
//                      'broker', and every one of those dispatches on it.
//
// What the project is given is what production gives one, with the four
// things a preview has differently:
//
//   * the key the PREVIEW signs app tokens with
//     (platform-jwt.signingPublicKeyPem), not the production parent's it was
//     given, or the project would refuse every token the preview mints;
//   * the preview's own address as its platform (USERNODE_PLATFORM_ORIGIN),
//     the shell it is framed in;
//   * the preview's in-cluster address for the app platform API, which the
//     project's server calls with its per-app token;
//   * no LLM proxy and no file storage, which a preview has neither of.
//     DATABASE_URL, PORT and USERNODE_ENV ('staging') are production's.
//
// Active only when production gave this process the four PREVIEW_PROJECTS_
// values (staging.js, when the switch is on), and only in staging.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

const RUNTIME_KIND = 'broker';
const POLL_MS = 3000;
const BUILD_WAIT_MS = 35 * 60 * 1000;
const DEPLOY_WAIT_MS = 12 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const UPLOAD_TIMEOUT_MS = 120 * 1000;
// What a build is never sent: the checkout's own git data and anything
// installed into it.
const SKIP_DIRS = new Set(['.git', 'node_modules']);

function settings(env = process.env) {
  if (env.USERNODE_ENV !== 'staging') return null;
  const url = String(env.PREVIEW_PROJECTS_URL || '').replace(/\/+$/, '');
  const token = String(env.PREVIEW_PROJECTS_TOKEN || '');
  const sessionId = Number(env.PREVIEW_PROJECTS_SESSION_ID);
  const origin = String(env.PREVIEW_PROJECTS_ORIGIN || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url) || !token || !Number.isSafeInteger(sessionId) || sessionId <= 0 || !/^https:\/\//.test(origin)) {
    return null;
  }
  const internalOrigin = String(env.PREVIEW_PROJECTS_INTERNAL_ORIGIN || '').replace(/\/+$/, '') || null;
  const starterDirs = String(env.PREVIEW_PROJECTS_STARTER_DIRS || '').split(',')
    .map((d) => d.trim()).filter((d) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(d));
  return { url, token, sessionId, origin, internalOrigin, starterDirs };
}

function active(env = process.env) {
  return !!settings(env);
}

function projectPath(slug) {
  return `/api/preview-projects/${encodeURIComponent(String(slug || ''))}`;
}

async function call(method, pathname, body = undefined, { timeoutMs = REQUEST_TIMEOUT_MS, allow = [] } = {}) {
  const s = settings();
  if (!s) throw new Error('Projects cannot be made in this preview');
  const res = await fetch(`${s.url}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${s.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !allow.includes(res.status)) {
    const err = new Error(json.message || `Production refused (${res.status})`);
    err.status = res.status;
    err.code = json.error || null;
    throw err;
  }
  return { status: res.status, ...json };
}

// The address a project made here answers on: under this preview's session,
// never a production app's.
function appUrl(slug) {
  const s = settings();
  if (!s) return null;
  return `https://${require('./caddy').stagingHostname(slug, `s${s.sessionId}`)}`;
}

// ── app-creator.js: the database ───────────────────────────────────────

// Production makes the project and its empty database. The preview still
// keeps a password on the row, because the rest of its own code expects
// one (staging.js deployProduction refuses a row without), but this one
// opens nothing: production's own goes into the project's DATABASE_URL.
async function createDatabase(row) {
  await call('PUT', projectPath(row.slug), { appId: row.id, name: row.name });
  return { password: crypto.randomBytes(24).toString('hex') };
}

// ── The starters this proposal changed, made as the preview boots ──────
//
// A proposal that changes a starter (app-templates/<dir>/) is best tried in
// a project made from it, so the preview makes one per changed starter
// itself (production names the directories: PREVIEW_PROJECTS_STARTER_DIRS),
// ready to open: `<starter id>-this-change`, e.g. /app/tier-list-
// restaurants-this-change, a fixed address a proposal's testing path and the
// "Test this change" link can name. Each is the first ready-made starter of
// its directory in THIS preview's app-templates.js, the proposal's own.
//
// It is made the way the create dialog makes one (routes/apps.js POST
// /api/apps): the row with its creator's membership, which starts
// app-creation's setup, the rule a new project gets, and the template. Its
// setup then runs through production as any project made here does. It is
// owned by the seeded demo identity, never by whoever opens the preview, and
// open to everyone, so anyone looking can open it and join it.
//
// Run with the staging seeds on every boot (db/migrate.js); one already
// made is left as it is. NEVER THROWS.

const CHANGE_SUFFIX = '-this-change';
const DEMO_OWNER = 'staging-demo-user';

function changeStarterSlug(templateId) {
  return `${templateId}${CHANGE_SUFFIX}`;
}

async function seedChangedStarters(pool, _config = null, env = process.env) {
  const made = [];
  const s = settings(env);
  if (!s || !s.starterDirs.length) return { made };
  try {
    const appTemplates = require('./app-templates');
    const ids = [];
    for (const dir of s.starterDirs) {
      const id = appTemplates.READY_IDS.find((t) => appTemplates.dirOf(t) === dir);
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (!ids.length) return { made };
    const { rows: [owner] } = await pool.query('SELECT id FROM users WHERE username = $1', [DEMO_OWNER]);
    if (!owner) {
      log.warn('preview-projects', 'No demo owner to make the changed starters with', { username: DEMO_OWNER });
      return { made };
    }
    const createOptions = require('./create-options');
    const governanceRules = require('./governance-rules');
    for (const id of ids) {
      const t = appTemplates.get(id);
      const slug = changeStarterSlug(id);
      const options = createOptions.parseCreateOptions({ name: t.title, audience: 'open', template: id }, { imported: false });
      if (options.error) {
        log.warn('preview-projects', 'A changed starter could not be made', { template: id, err: options.error });
        continue;
      }
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        const { rows: [app] } = await db.query(
          `WITH new_app AS (
             INSERT INTO apps (name, slug, repo_url, created_by, status, collab_visibility, view_visibility)
             VALUES ($1, $2, NULL, $3, 'creating', $4, $5)
             ON CONFLICT (slug) DO NOTHING
             RETURNING *
           ), membership AS (
             INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
             SELECT id, $3, 'member', NOW() FROM new_app
             ON CONFLICT (app_id, user_id) DO NOTHING
           )
           SELECT * FROM new_app`,
          [`${t.title} (this change)`, slug, owner.id, options.collabVisibility, options.viewVisibility]
        );
        if (app) {
          await db.query('UPDATE apps SET governance_rules = $1::jsonb WHERE id = $2',
            [JSON.stringify(governanceRules.storedForm(options.governance)), app.id]);
          await db.query('UPDATE apps SET template = $1, icon_emoji = COALESCE($3, icon_emoji) WHERE id = $2',
            [id, app.id, t.icon || null]);
          made.push(slug);
        }
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        log.warn('preview-projects', 'A changed starter could not be made', { template: id, err: err.message });
      } finally {
        db.release();
      }
    }
    if (made.length) log.info('preview-projects', 'Made the starters this change touches', { made });
  } catch (err) {
    log.warn('preview-projects', 'Making the changed starters failed (continuing)', { err: err.message });
  }
  return { made };
}

// ── application-runtime.js: build and deploy ───────────────────────────

function readTree(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(child);
      } else if (entry.isFile()) {
        const abs = path.join(dir, child);
        const executable = (fs.statSync(abs).mode & 0o111) !== 0;
        out.push({
          path: child,
          content: fs.readFileSync(abs).toString('base64'),
          ...(executable ? { mode: '100755' } : {}),
        });
      }
    }
  };
  walk('');
  return out;
}

async function waitFor(slug, wanted, { deadlineMs, onPoll = null }) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const { project } = await call('GET', projectPath(slug));
    if (project && wanted.includes(project.state)) return project;
    if (!project || project.state === 'failed') {
      throw new Error(project?.error || 'Production could not finish that step');
    }
    if (typeof onPoll === 'function') { try { onPoll(project); } catch { /* observer only */ } }
    if (Date.now() > until) throw new Error(`Production did not finish ${wanted.join(' or ')} in time`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function build(_config, { app, sourceDir, onProgress = null }) {
  const files = readTree(sourceDir);
  await call('POST', `${projectPath(app.slug)}/build`, { files }, { timeoutMs: UPLOAD_TIMEOUT_MS });
  const project = await waitFor(app.slug, ['built'], {
    deadlineMs: BUILD_WAIT_MS,
    onPoll: onProgress ? () => onProgress({ phase: 'build', detail: 'building in production' }) : null,
  });
  log.info('preview-projects', 'Project built by production', { slug: app.slug, imageRef: project.imageRef });
  return { runtimeKind: RUNTIME_KIND, imageRef: project.imageRef, buildRef: null, engine: RUNTIME_KIND };
}

// The env app delivery made for the project, as a project here needs it
// (the four differences in the header).
function projectEnv(env, s = settings()) {
  const out = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (value == null) continue;
    out[key] = String(value);
  }
  for (const key of ['DATABASE_URL', 'PORT', 'USERNODE_ENV',
    'USERNODE_LLM_PROXY_URL', 'USERNODE_STORAGE_URL', 'USERNODE_STORAGE_TOKEN']) delete out[key];
  const key = require('./platform-jwt').signingPublicKeyPem();
  if (key) {
    out.USERNODE_JWT_PUBLIC_KEY = key;
    out.JWT_SECRET = key;
    out.IFRAME_JWT_PUBLIC_KEY = key;
  } else {
    log.warn('preview-projects', 'This preview signs no app tokens; its project will refuse every one');
  }
  if (s?.origin) out.USERNODE_PLATFORM_ORIGIN = s.origin;
  if (s?.internalOrigin) {
    out.USERNODE_PLATFORM_API_URL = `${s.internalOrigin}/api/app-platform`;
    out.USERNODE_PLATFORM_API_V1_URL = `${s.internalOrigin}/api/app-platform/v1`;
  } else {
    delete out.USERNODE_PLATFORM_API_URL;
    delete out.USERNODE_PLATFORM_API_V1_URL;
  }
  return out;
}

async function deploy(_config, { app, imageRef, env, onRollout = null }) {
  await call('POST', `${projectPath(app.slug)}/deploy`, { imageRef, env: projectEnv(env) });
  if (typeof onRollout === 'function') { try { onRollout(); } catch { /* observer only */ } }
  const project = await waitFor(app.slug, ['running'], { deadlineMs: DEPLOY_WAIT_MS });
  return {
    runtimeKind: RUNTIME_KIND,
    runtimeName: app.slug,
    imageRef,
    hostname: project.hostname,
    url: project.url || appUrl(app.slug),
  };
}

// ── application-runtime.js: a project already made ────────────────────
// `ref.runtimeName` is the project's slug.

async function inspect(_config, ref) {
  const { project } = await call('GET', `${projectPath(ref.runtimeName)}?runtime=1`, undefined, { allow: [404] });
  if (!project) return { status: 'not_found', labels: {} };
  if (project.runtime) return { ...project.runtime, labels: {} };
  return { status: project.state === 'running' ? 'not_found' : 'created', labels: {}, imageRef: project.imageRef };
}

async function status(config, ref) {
  return (await inspect(config, ref)).status;
}

async function probeHealth(_config, ref, { timeoutMs = 3000 } = {}) {
  try {
    const { project } = await call('GET', `${projectPath(ref.runtimeName)}?runtime=1`, undefined,
      { timeoutMs: Math.max(timeoutMs, 5000), allow: [404] });
    return !!project?.healthy;
  } catch {
    return false;
  }
}

async function logs(_config, ref, tailLines) {
  const { text } = await call('GET', `${projectPath(ref.runtimeName)}/logs?tail=${Number(tailLines) || 200}`);
  return text || '';
}

async function restart(_config, ref) {
  await call('POST', `${projectPath(ref.runtimeName)}/restart`);
}

async function remove(_config, ref) {
  if (!ref?.runtimeName) return;
  await call('DELETE', projectPath(ref.runtimeName), undefined, { allow: [404] });
}

function appOrigin(_config, ref) {
  return ref?.runtimeName ? appUrl(ref.runtimeName) : null;
}

module.exports = {
  RUNTIME_KIND,
  settings,
  active,
  appUrl,
  changeStarterSlug,
  seedChangedStarters,
  createDatabase,
  readTree,
  projectEnv,
  build,
  deploy,
  inspect,
  status,
  probeHealth,
  logs,
  restart,
  remove,
  appOrigin,
};
