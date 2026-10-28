'use strict';

// Projects made inside a platform preview: production's half.
//
// A preview of the platform runs the proposal's own code, unreviewed, so it
// gets no right to create a database, no image builder or container runtime
// and no git host (SELF-HOSTING.md "Spawning child apps from inside a
// staging clone"). That is right, and it also meant nobody could make a
// project in a preview: setup stopped at its first step, the database. So
// a change to what a new project gets (a starter template, the scaffold,
// template.js, project creation, the first deploy) could not be tried in
// its own preview, or shot.
//
// The preview's own code still makes the project, the same way production
// does: the create dialog, app-creation's setup, app delivery's first
// deploy. Only the three steps it may not do itself come here, through
// services/preview-projects-client.js and routes/preview-projects.js:
//
//   database  an EMPTY database with its own role, on the preview database
//             server, named under the parent preview's session
//             (app_pp<id>_staging_s<session>_<hex>): the shape the orphan
//             sweep already drops once that session has no preview;
//   build     the files the preview generated, committed as a parentless
//             commit on a branch of one source repository on the git host
//             (Kubernetes builds fetch a commit, as starter-images.js does),
//             then built like any app;
//   run       a runtime like an app proposal's preview: the apps namespace,
//             no service account token, non-root, half a core, at
//             <slug>--s<session>.<apps domain>.
//
// WHAT A PREVIEW MAY ASK FOR, AND NOTHING ELSE:
//
//   * Its credential (`svpp_…`) is minted when production deploys it, given
//     to it in its env, stored only as a SHA-256, and names one session.
//     Every operation is on that session's projects alone: the session comes
//     from the token, never from the request.
//   * Only a preview of the PLATFORM gets one (config.selfAppSlug), only when
//     PREVIEW_PROJECTS_ENABLED is on (the chart's config.previewProjects,
//     default off), and only on Kubernetes.
//   * At most MAX_PER_PREVIEW projects per preview and MAX_TOTAL at once.
//   * A project's slug is its own: never the platform's, never with `--`
//     (the host would read as another preview's), short enough that
//     <slug>--s<session> is one DNS label. The host is under the parent's
//     session, so a preview can never claim a real app's address.
//   * Its runtime carries the app id `pp-<id>`, which no app has, so the
//     platform-preview retirement (app-id = the platform's) and the leftover
//     sweep (sv-preview-<app>-s<session>) never take it for something else.
//   * The env it is given is the preview's to choose (its project's identity
//     and settings), within size limits; DATABASE_URL, PORT and USERNODE_ENV
//     are production's.
//
// RETIRED WITH THE PREVIEW: the preview machine's retire work removes every
// project of the session (retireForSession) before the session's own
// databases go, and sweep() is the backstop for a session that went some
// other way. Deleting a project in the preview removes it here too.
//
// Building and deploying take minutes, so each runs in the process that
// accepted it and the row says how it went; the preview polls. One whose
// process went away is `failed` after STALE_MINUTES, and can be asked again.
//
// Not covered yet: the before & after shots copies (they get no credential),
// and APP_GATE=on, whose host lookup does not know these projects (it is off
// in production).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('./logger');

const TOKEN_PREFIX = 'svpp_';
const TOKEN_RE = /^svpp_[A-Za-z0-9_-]{43}$/;
const TOKEN_TTL_DAYS = 14;
// Each deploy of a preview mints one; the newest few stay live, so pods of
// the rollout before keep working until they are gone.
const MAX_LIVE_TOKENS_PER_SESSION = 3;
const RUNTIME_KIND = 'broker';
const SOURCE_REPO = 'homeroom-preview-projects';
const STALE_MINUTES = 40;
const CPUS = '0.5';
const MEMORY = '512m';
const MAX_FILES = 2000;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_PATH_CHARS = 300;
const MAX_ENV_KEYS = 200;
const MAX_ENV_VALUE_BYTES = 32 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const MAX_ERROR_CHARS = 2000;
const MAX_LOG_LINES = 500;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const RESERVED_ENV = new Set(['DATABASE_URL', 'PORT', 'USERNODE_ENV']);
const PARENT_LABEL = 'social.usernode.io/preview-parent';
const PROJECT_LABEL = 'social.usernode.io/preview-project';

function intFromEnv(name, fallback) {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : fallback;
}
const maxPerPreview = () => intFromEnv('PREVIEW_PROJECTS_PER_PREVIEW', 3);
const maxTotal = () => intFromEnv('PREVIEW_PROJECTS_MAX', 30);

function fail(code, message, status = 400) {
  return { ok: false, code, message, status };
}

function isStaging() {
  return process.env.USERNODE_ENV === 'staging';
}

// On, here: production (never a preview itself), switched on, on Kubernetes.
function enabled(config) {
  if (isStaging() || config?.previewProjectsEnabled !== true) return false;
  return require('./application-runtime').mode(config) === 'kubernetes';
}

// ── The credential ─────────────────────────────────────────────────────

function makeToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// `Authorization: Bearer svpp_…`, exactly.
function tokenFromHeader(header) {
  const m = /^Bearer (svpp_[A-Za-z0-9_-]{43})$/.exec(String(header || '').trim());
  return m ? m[1] : null;
}

async function issueToken(pool, sessionId) {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const token = makeToken();
  const { rows } = await pool.query(
    `INSERT INTO preview_project_tokens (session_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + make_interval(days => $3::int))
     RETURNING id`,
    [id, hashToken(token), TOKEN_TTL_DAYS]
  );
  if (!rows[0]) return null;
  await pool.query(
    `DELETE FROM preview_project_tokens
      WHERE session_id = $1
        AND id NOT IN (SELECT id FROM preview_project_tokens WHERE session_id = $1 ORDER BY id DESC LIMIT $2)`,
    [id, MAX_LIVE_TOKENS_PER_SESSION]
  );
  return token;
}

// The session a token is for, if it is live and that session is a preview
// of the platform. A token for anything else matches nothing.
async function authenticate(config, pool, token) {
  if (!TOKEN_RE.test(String(token || ''))) return fail('invalid_token', 'That credential is not valid.', 401);
  const { rows } = await pool.query(
    `SELECT k.session_id, a.slug AS app_slug
       FROM preview_project_tokens k
       JOIN chat_sessions s ON s.id = k.session_id
       JOIN apps a ON a.id = s.app_id
      WHERE k.token_hash = $1 AND k.expires_at > NOW()`,
    [hashToken(token)]
  );
  const row = rows[0];
  if (!row || row.app_slug !== config.selfAppSlug) return fail('invalid_token', 'That credential is not valid.', 401);
  return { ok: true, sessionId: Number(row.session_id) };
}

// The starters a proposal changed: each `app-templates/<dir>/` its files
// touch, from the shared ones (`_scaffold`, `_game-room`) apart, up to the
// per-preview cap. Directories, not ready-made ids: the preview maps them
// with its OWN app-templates.js, the proposal's, so a starter the proposal
// adds is made too.
function starterDirsIn(files) {
  const dirs = [];
  for (const file of Array.isArray(files) ? files : []) {
    const m = /^app-templates\/([a-z0-9][a-z0-9-]*)\//.exec(String(file || ''));
    if (m && !dirs.includes(m[1])) dirs.push(m[1]);
  }
  return dirs.slice(0, maxPerPreview());
}

async function changedStarterDirs(config, { app, commitHash }) {
  if (!/^[0-9a-f]{40}$/i.test(String(commitHash || ''))) return [];
  const ref = require('./repo-ref').parse(app.repo_url || config.platformRepoUrl);
  if (!ref) return [];
  try {
    const { files } = await require('./github').compareRefs(ref.owner, ref.repo, `main...${commitHash}`);
    return starterDirsIn(files);
  } catch (err) {
    log.warn('preview-projects', 'Could not list a preview\'s changed starters', { commitHash, err: err.message });
    return [];
  }
}

// What production adds to a platform preview's env when it deploys it
// (services/staging.js), so the preview can reach this. Nothing for any
// other app, or with the switch off. The token differs on every deploy, so
// it is kept out of the env fingerprint (staging-env.js).
//
// Two more things a preview that can make projects needs:
//   * no server-wide app cap (MAX_APPS=0, as a shots copy of the platform
//     has: shots-environment.js shotsCapacityEnv). Its sample tiles alone
//     fill the 50, so nobody could press Make it; this broker caps it at
//     MAX_PER_PREVIEW instead.
//   * the starters this proposal changed (PREVIEW_PROJECTS_STARTER_DIRS),
//     which the preview makes as it boots, ready to open
//     (preview-projects-client.js seedChangedStarters).
async function previewEnv(config, { app, sessionId, commitHash = null, pool = null }) {
  if (!enabled(config) || !app || app.slug !== config.selfAppSlug) return {};
  const token = await issueToken(pool || require('../db/pool').getPool(config), sessionId);
  if (!token) return {};
  const starterDirs = await changedStarterDirs(config, { app, commitHash });
  const caddy = require('./caddy');
  const applicationRuntime = require('./application-runtime');
  const kubernetes = require('./kubernetes');
  const base = (process.env.PLATFORM_INTERNAL_URL || 'http://usernode:3000').replace(/\/$/, '');
  const internalOrigin = applicationRuntime.appOrigin(config, {
    runtimeKind: 'kubernetes', runtimeName: kubernetes.appResourceName(app, 'staging', sessionId),
  });
  return {
    PREVIEW_PROJECTS_URL: base,
    PREVIEW_PROJECTS_TOKEN: token,
    PREVIEW_PROJECTS_SESSION_ID: String(sessionId),
    PREVIEW_PROJECTS_ORIGIN: `https://${caddy.stagingHostname(app.slug, `s${sessionId}`)}`,
    ...(internalOrigin ? { PREVIEW_PROJECTS_INTERNAL_ORIGIN: internalOrigin } : {}),
    ...(starterDirs.length ? { PREVIEW_PROJECTS_STARTER_DIRS: starterDirs.join(',') } : {}),
    MAX_APPS: '0',
  };
}

// ── Names ──────────────────────────────────────────────────────────────

function checkSlug(config, slug, sessionId) {
  const value = String(slug || '');
  if (!SLUG_RE.test(value) || value.includes('--')) {
    return fail('invalid_slug', 'A project name must be lowercase letters, digits and single dashes.');
  }
  if (value === config.selfAppSlug) return fail('invalid_slug', 'A project cannot be named after the platform.');
  if (`${value}--s${sessionId}`.length > 63) return fail('invalid_slug', 'That project name is too long for its address.');
  return null;
}

// The project as its runtime sees it: its own slug, which is what its host
// is made from.
function childApp(row) {
  return { id: `pp-${row.id}`, slug: row.slug, name: row.name || row.slug };
}

// The project as its BUILD sees it. A build names its image repository and
// its layer cache after the slug (kubernetes.js createKpackBuild), so a
// project named like a real app would push into that app's repository and
// write the cache its next build reads. A build therefore gets a slug of
// its own that no app can have.
function buildApp(row, repoUrl) {
  return { id: `pp-${row.id}`, slug: `preview-project-${row.id}`, name: row.name || row.slug, repo_url: repoUrl };
}

function runtimeNameOf(row) {
  return `sv-pp-${row.id}-s${row.session_id}`;
}

// The same name on every try for one project, so a try that stopped between
// its role and its database is dropped by the next (db-manager dropOldTarget).
function dbNameOf(row) {
  const tag = crypto.createHash('sha256').update(`preview-project:${row.id}:${row.session_id}`).digest('hex').slice(0, 6);
  return `app_pp${row.id}_staging_s${row.session_id}_${tag}`;
}

function isStale(row) {
  if (!['creating', 'building', 'deploying'].includes(row.state) || !row.op_started_at) return false;
  return Date.now() - new Date(row.op_started_at).getTime() > STALE_MINUTES * 60 * 1000;
}

// What the preview is told about a project. Never the database password.
function view(row) {
  const stale = isStale(row);
  return {
    slug: row.slug,
    state: stale ? 'failed' : row.state,
    error: stale ? 'That step stopped part way through. Try again.' : (row.error || null),
    imageRef: row.image_ref || null,
    hostname: row.hostname || null,
    url: row.hostname ? `https://${row.hostname}` : null,
    builds: Number(row.builds) || 0,
  };
}

async function rowFor(pool, sessionId, slug) {
  const { rows } = await pool.query(
    'SELECT * FROM preview_projects WHERE session_id = $1 AND slug = $2', [sessionId, slug]
  );
  return rows[0] || null;
}

async function lookup(config, pool, { sessionId, slug }) {
  const bad = checkSlug(config, slug, sessionId);
  if (bad) return bad;
  const row = await rowFor(pool, sessionId, slug);
  if (!row) return fail('not_found', 'There is no such project in this preview.', 404);
  return { ok: true, row };
}

function setFailed(pool, id, err) {
  const message = String((err && (err.buildLog || err.message)) || err).slice(-MAX_ERROR_CHARS);
  return pool.query(
    `UPDATE preview_projects SET state = 'failed', error = $2, op_started_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [id, message]
  ).catch((dbErr) => log.warn('preview-projects', 'Could not record a failure', { id, err: dbErr.message }));
}

// ── Database ───────────────────────────────────────────────────────────

// The project's row and its empty database. Again for the same slug: the
// project as it is, or, when an earlier try stopped before its database
// was kept, that try taken over. Synchronous: a database takes a second.
async function createProject(config, pool, { sessionId, slug, appId, name }) {
  const bad = checkSlug(config, slug, sessionId);
  if (bad) return bad;
  const previewAppId = Number(appId);
  if (!Number.isSafeInteger(previewAppId) || previewAppId <= 0) return fail('invalid_request', 'appId must be the project\'s id in the preview.');
  const title = String(name || '').slice(0, 255);

  let row = await rowFor(pool, sessionId, slug);
  if (row && row.db_password) return { ok: true, project: view(row) };
  if (!row) {
    const { rows } = await pool.query(
      `INSERT INTO preview_projects (session_id, slug, preview_app_id, name, state, op_started_at)
       SELECT $1, $2, $3, $4, 'creating', NOW()
        WHERE (SELECT COUNT(*) FROM preview_projects WHERE session_id = $1) < $5
          AND (SELECT COUNT(*) FROM preview_projects) < $6
       ON CONFLICT (session_id, slug) DO NOTHING
       RETURNING *`,
      [sessionId, slug, previewAppId, title, maxPerPreview(), maxTotal()]
    );
    row = rows[0] || null;
    if (!row) {
      const existing = await rowFor(pool, sessionId, slug);
      if (existing) return { ok: true, project: view(existing) };
      return fail('limit_reached', `A preview can make up to ${maxPerPreview()} projects. Delete one to make another.`, 409);
    }
  } else {
    // An earlier try that did not keep its database: take it over unless it
    // is still running somewhere.
    const { rows } = await pool.query(
      `UPDATE preview_projects SET state = 'creating', op_started_at = NOW(), error = NULL, updated_at = NOW()
        WHERE id = $1 AND db_password IS NULL
          AND (state <> 'creating' OR op_started_at IS NULL
               OR op_started_at < NOW() - make_interval(mins => $2::int))
        RETURNING *`,
      [row.id, STALE_MINUTES]
    );
    if (!rows[0]) return { ok: true, project: view(row) };
    row = rows[0];
  }

  try {
    const dbName = dbNameOf(row);
    const db = await require('./db-manager').createPreviewProjectDatabase(dbName);
    const { rows } = await pool.query(
      `UPDATE preview_projects
          SET db_name = $2, db_server = $3, db_password = $4, state = 'created', op_started_at = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [row.id, dbName, db.server, db.password]
    );
    log.info('preview-projects', 'Project made in a preview', { sessionId, slug, id: row.id });
    return { ok: true, project: view(rows[0] || row) };
  } catch (err) {
    log.warn('preview-projects', 'Making a project\'s database failed', { sessionId, slug, err: err.message });
    await setFailed(pool, row.id, err);
    return fail('database_failed', 'The project\'s database could not be made. Try again.', 502);
  }
}

// ── Build ──────────────────────────────────────────────────────────────

// The files the preview sends: [{ path, content (base64), mode? }], paths
// relative and plain, within the limits. Resolves the decoded list, or a
// refusal.
function checkFiles(files) {
  if (!Array.isArray(files) || !files.length) return fail('invalid_files', 'There are no files to build.');
  if (files.length > MAX_FILES) return fail('invalid_files', `A project's source can have up to ${MAX_FILES} files.`, 413);
  const out = [];
  const seen = new Set();
  let bytes = 0;
  for (const f of files) {
    const rel = typeof f?.path === 'string' ? f.path : '';
    const parts = rel.split('/');
    if (!rel || rel.length > MAX_PATH_CHARS || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')
        || parts.some((p) => !p || p === '.' || p === '..') || parts[0] === '.git' || seen.has(rel)) {
      return fail('invalid_files', `Not a usable file path: ${rel.slice(0, 120)}`);
    }
    if (typeof f.content !== 'string') return fail('invalid_files', `No content for ${rel.slice(0, 120)}`);
    const content = Buffer.from(f.content, 'base64');
    bytes += content.length;
    if (bytes > MAX_SOURCE_BYTES) return fail('invalid_files', `A project's source can be up to ${MAX_SOURCE_BYTES / 1024 / 1024} MB.`, 413);
    seen.add(rel);
    out.push({ path: rel, content, mode: f.mode === '100755' ? '100755' : '100644' });
  }
  return { ok: true, files: out };
}

let sourceRepo = null;
async function pushSource(row, files) {
  const gitHost = require('./git-host');
  if (!gitHost.isConfigured()) throw new Error('A preview project is built from the git host, which is not configured');
  if (!sourceRepo) {
    await gitHost.createRepo(SOURCE_REPO, {
      description: 'Projects made inside Homeroom platform previews, as they are built',
      private: true,
      adoptExisting: true,
    });
    sourceRepo = SOURCE_REPO;
  }
  const branch = `project-${row.id}-b${row.builds}`;
  const sha = await gitHost.pushInitialFiles(SOURCE_REPO, files.map((f) => ({
    path: f.path, content: f.content.toString('base64'), encoding: 'base64', mode: f.mode,
  })), { branch, message: `Preview project ${row.slug} (session ${row.session_id}), build ${row.builds}` });
  return { repoUrl: gitHost.repoUrl(SOURCE_REPO), sha: String(sha).toLowerCase(), branch };
}

function dropBranch(branch) {
  if (!branch) return Promise.resolve();
  return require('./git-host').deleteRef(SOURCE_REPO, branch)
    .catch((err) => log.warn('preview-projects', 'Could not delete a source branch', { branch, err: err.message }));
}

async function startBuild(config, pool, { sessionId, slug, files }) {
  const found = await lookup(config, pool, { sessionId, slug });
  if (!found.ok) return found;
  const checked = checkFiles(files);
  if (!checked.ok) return checked;
  const { rows } = await pool.query(
    `UPDATE preview_projects
        SET state = 'building', op_started_at = NOW(), error = NULL, builds = builds + 1, updated_at = NOW()
      WHERE id = $1 AND db_password IS NOT NULL
        AND (state NOT IN ('creating', 'building', 'deploying')
             OR op_started_at < NOW() - make_interval(mins => $2::int))
      RETURNING *`,
    [found.row.id, STALE_MINUTES]
  );
  if (!rows[0]) return fail('busy', 'This project is busy with another step. Wait for it to finish.', 409);
  runBuild(config, pool, rows[0], checked.files).catch((err) => {
    log.error('preview-projects', 'A build stopped unexpectedly', { id: rows[0].id, err: err.message });
  });
  return { ok: true, project: view(rows[0]) };
}

async function runBuild(config, pool, row, files) {
  const applicationRuntime = require('./application-runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `usernode-preview-project-${row.id}-`));
  let source = null;
  try {
    for (const f of files) {
      const abs = path.join(dir, f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content, { mode: f.mode === '100755' ? 0o755 : 0o644 });
    }
    source = await pushSource(row, files);
    const build = await require('./build-retention-guard').withBuildUse(config, () => applicationRuntime.build(config, {
      app: buildApp(row, source.repoUrl),
      revision: source.sha,
      environment: 'staging',
      sessionId: row.session_id,
      sourceDir: dir,
    }));
    const { rowCount } = await pool.query(
      `UPDATE preview_projects
          SET state = 'built', image_ref = $2, build_ref = $3, source_branch = $4, source_sha = $5,
              op_started_at = NULL, error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'building'`,
      [row.id, build.imageRef, build.buildRef || null, source.branch, source.sha]
    );
    // Removed while it built: its branch goes too.
    if (!rowCount) await dropBranch(source.branch);
    else if (row.source_branch && row.source_branch !== source.branch) await dropBranch(row.source_branch);
    log.info('preview-projects', 'Preview project built', { id: row.id, slug: row.slug, imageRef: build.imageRef });
  } catch (err) {
    log.warn('preview-projects', 'Preview project build failed', { id: row.id, slug: row.slug, err: err.message });
    if (source) await dropBranch(source.branch);
    await setFailed(pool, row.id, err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Run ────────────────────────────────────────────────────────────────

// The env the preview chose for its project, within the limits, without the
// three production sets.
function checkEnv(env) {
  if (env == null) return { ok: true, env: {} };
  if (typeof env !== 'object' || Array.isArray(env)) return fail('invalid_env', 'env must be an object of strings.');
  const entries = Object.entries(env).filter(([key]) => !RESERVED_ENV.has(key));
  if (entries.length > MAX_ENV_KEYS) return fail('invalid_env', `A project can be given up to ${MAX_ENV_KEYS} settings.`, 413);
  let total = 0;
  const out = {};
  for (const [key, value] of entries) {
    if (!ENV_KEY_RE.test(key)) return fail('invalid_env', `Not a usable setting name: ${key.slice(0, 64)}`);
    if (value == null) continue;
    if (typeof value !== 'string') return fail('invalid_env', `The setting ${key} must be a string.`);
    const size = Buffer.byteLength(value, 'utf8');
    total += size + key.length;
    if (size > MAX_ENV_VALUE_BYTES || total > MAX_ENV_BYTES) return fail('invalid_env', 'Those settings are too large.', 413);
    out[key] = value;
  }
  return { ok: true, env: out };
}

async function startDeploy(config, pool, { sessionId, slug, imageRef, env }) {
  const found = await lookup(config, pool, { sessionId, slug });
  if (!found.ok) return found;
  const checked = checkEnv(env);
  if (!checked.ok) return checked;
  if (!imageRef || imageRef !== found.row.image_ref) {
    return fail('image_unknown', 'Only the image this project last built can be run. Build it first.', 409);
  }
  const { rows } = await pool.query(
    `UPDATE preview_projects
        SET state = 'deploying', op_started_at = NOW(), error = NULL, updated_at = NOW()
      WHERE id = $1 AND db_password IS NOT NULL AND image_ref = $2
        AND (state IN ('built', 'running', 'failed')
             OR (state IN ('building', 'deploying') AND op_started_at < NOW() - make_interval(mins => $3::int)))
      RETURNING *`,
    [found.row.id, imageRef, STALE_MINUTES]
  );
  if (!rows[0]) return fail('busy', 'This project is busy with another step. Wait for it to finish.', 409);
  runDeploy(config, pool, rows[0], checked.env).catch((err) => {
    log.error('preview-projects', 'A deploy stopped unexpectedly', { id: rows[0].id, err: err.message });
  });
  return { ok: true, project: view(rows[0]) };
}

async function runDeploy(config, pool, row, env) {
  const applicationRuntime = require('./application-runtime');
  const dbManager = require('./db-manager');
  const runtimeName = runtimeNameOf(row);
  try {
    const deployed = await applicationRuntime.deploy(config, {
      app: childApp(row),
      environment: 'staging',
      sessionId: row.session_id,
      imageRef: row.image_ref,
      env: {
        ...env,
        DATABASE_URL: dbManager.connectionUrl(row.db_name, row.db_password, { server: row.db_server }),
        PORT: '3000',
        USERNODE_ENV: 'staging',
      },
      dockerName: runtimeName,
      runtimeName,
      cpus: CPUS,
      memory: MEMORY,
      labels: { [PARENT_LABEL]: String(row.session_id), [PROJECT_LABEL]: String(row.id) },
    });
    const { rowCount } = await pool.query(
      `UPDATE preview_projects
          SET state = 'running', runtime_name = $2, hostname = $3, op_started_at = NULL, error = NULL, updated_at = NOW()
        WHERE id = $1 AND state = 'deploying'`,
      [row.id, deployed.runtimeName || runtimeName, deployed.hostname || null]
    );
    // Removed while it deployed: what it started goes too.
    if (!rowCount) await removeRuntime(config, row).catch(() => {});
    log.info('preview-projects', 'Preview project running', { id: row.id, slug: row.slug, hostname: deployed.hostname });
  } catch (err) {
    log.warn('preview-projects', 'Preview project deploy failed', { id: row.id, slug: row.slug, err: err.message });
    await setFailed(pool, row.id, err);
  }
}

function runtimeRef(row) {
  return { runtimeKind: 'kubernetes', runtimeName: row.runtime_name || runtimeNameOf(row), appId: childApp(row).id };
}

async function restart(config, pool, { sessionId, slug }) {
  const found = await lookup(config, pool, { sessionId, slug });
  if (!found.ok) return found;
  if (found.row.state !== 'running') return fail('not_running', 'This project is not running.', 409);
  await require('./application-runtime').restart(config, runtimeRef(found.row));
  return { ok: true, project: view(found.row) };
}

// The project, and with `runtime` how its runtime is doing.
async function describe(config, pool, { sessionId, slug, runtime = false }) {
  const found = await lookup(config, pool, { sessionId, slug });
  if (!found.ok) return found;
  const project = view(found.row);
  if (runtime && found.row.state === 'running') {
    const applicationRuntime = require('./application-runtime');
    const ref = runtimeRef(found.row);
    const inspected = await applicationRuntime.inspect(config, ref).catch(() => null);
    project.runtime = inspected
      ? { status: inspected.status, rolloutReady: !!inspected.rolloutReady, imageRef: inspected.imageRef || null }
      : null;
    project.healthy = await applicationRuntime.probeHealth(config, ref, { timeoutMs: 3000 });
  }
  return { ok: true, project };
}

async function logs(config, pool, { sessionId, slug, tail }) {
  const found = await lookup(config, pool, { sessionId, slug });
  if (!found.ok) return found;
  if (!found.row.runtime_name) return { ok: true, text: '' };
  const lines = Math.min(Math.max(parseInt(tail, 10) || 200, 1), MAX_LOG_LINES);
  const text = await require('./application-runtime').logs(config, runtimeRef(found.row), lines).catch((err) => `(logs unavailable: ${err.message})`);
  return { ok: true, text: String(text || '').slice(-256 * 1024) };
}

// ── Removal ────────────────────────────────────────────────────────────

async function removeRuntime(config, row) {
  await require('./application-runtime').remove(config, runtimeRef(row), { deleteBuilds: true });
}

// The runtime, the database, the source branch, then the row. A step that
// fails stops it, and the row stays for the next try.
async function removeRow(config, pool, row) {
  await removeRuntime(config, row);
  if (row.db_name) await require('./db-manager').dropDatabase(row.db_name, { strict: true });
  await dropBranch(row.source_branch);
  await pool.query('DELETE FROM preview_projects WHERE id = $1', [row.id]);
  log.info('preview-projects', 'Preview project removed', { id: row.id, slug: row.slug, sessionId: row.session_id });
}

async function remove(config, pool, { sessionId, slug }) {
  const found = await lookup(config, pool, { sessionId, slug });
  if (!found.ok) return found.status === 404 ? { ok: true, removed: false } : found;
  await removeRow(config, pool, found.row);
  return { ok: true, removed: true };
}

// Every project of a session, and its credentials: the preview machine's
// retire work, before the session's own databases go. Throws when one could
// not be removed, so the retirement is tried again.
async function retireForSession(config, pool, sessionId) {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0) return { removed: 0 };
  const { rows } = await pool.query('SELECT * FROM preview_projects WHERE session_id = $1 ORDER BY id', [id]);
  let firstError = null;
  for (const row of rows) {
    try {
      await removeRow(config, pool, row);
    } catch (err) {
      log.warn('preview-projects', 'Could not remove a preview project', { id: row.id, sessionId: id, err: err.message });
      firstError = firstError || err;
    }
  }
  await pool.query('DELETE FROM preview_project_tokens WHERE session_id = $1', [id]);
  if (firstError) throw firstError;
  return { removed: rows.length };
}


// The backstop: projects whose session no longer has a preview, however it
// went, and expired credentials. Runs with the orphan-database pass
// (staging-reap.js), on or off. NEVER THROWS.
async function sweep(config, pool, { limit = 50 } = {}) {
  const summary = { examined: 0, removed: 0, failed: 0 };
  if (isStaging()) return summary;
  try {
    await pool.query('DELETE FROM preview_project_tokens WHERE expires_at < NOW()');
    const { rows } = await pool.query(
      `SELECT p.* FROM preview_projects p
        WHERE p.created_at < NOW() - INTERVAL '10 minutes'
          AND NOT EXISTS (SELECT 1 FROM chat_sessions s WHERE s.id = p.session_id AND s.staging_url IS NOT NULL)
          -- Nor one the preview machine holds: a build's attempt exists
          -- before staging_url points at it (staging-reap.js).
          AND NOT EXISTS (SELECT 1 FROM wf_instances w
                           WHERE w.machine = 'preview' AND w.key = 'session:' || p.session_id
                             AND w.state NOT IN ('retired', 'detached', '(none)'))
        ORDER BY p.id
        LIMIT $1`,
      [limit]
    );
    summary.examined = rows.length;
    for (const row of rows) {
      try {
        await removeRow(config, pool, row);
        summary.removed += 1;
      } catch (err) {
        summary.failed += 1;
        log.warn('preview-projects', 'Sweep could not remove a preview project', { id: row.id, err: err.message });
      }
    }
    if (rows.length) log.info('preview-projects', 'Preview project sweep', summary);
  } catch (err) {
    log.warn('preview-projects', 'Preview project sweep failed (continuing)', { err: err.message });
  }
  return summary;
}

module.exports = {
  TOKEN_PREFIX,
  RUNTIME_KIND,
  SOURCE_REPO,
  STALE_MINUTES,
  MAX_SOURCE_BYTES,
  PARENT_LABEL,
  PROJECT_LABEL,
  enabled,
  makeToken,
  hashToken,
  tokenFromHeader,
  issueToken,
  authenticate,
  starterDirsIn,
  changedStarterDirs,
  previewEnv,
  checkSlug,
  checkFiles,
  checkEnv,
  childApp,
  runtimeNameOf,
  dbNameOf,
  view,
  createProject,
  startBuild,
  startDeploy,
  restart,
  describe,
  logs,
  remove,
  retireForSession,
  sweep,
  maxPerPreview,
  maxTotal,
};
