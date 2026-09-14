'use strict';

// Staging rebuild trigger — no functional effect.
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const github = require('./github');
const docker = require('./docker');
const dbManager = require('./db-manager');
const appManifest = require('./app-manifest');
const appSecrets = require('./app-secrets');
const deployFailure = require('./deploy-failure');
const { getPool } = require('../db/pool');
const { pushAppStatusUpdate } = require('./ws');
const { createApp, finalizeDeploy, reportPhase, endPhases } = require('./app-creator');
const { getConnectorScaffoldFiles } = require('./template');

// Rewrite (or create) the top-level `name` in the forked working tree's
// dapp.json to the forker's chosen name. dapp.json's `name` is the
// source of truth for the display name and reconcileAppName() would
// otherwise overwrite apps.name back to the ORIGINAL's name on the
// fork's first deploy. Everything else in the manifest (visibility,
// icon, secrets, tests) is left untouched so it carries over verbatim.
//
// The one other field stripped here is the top-level `admins` block
// (issue #788): a fork is a NEW app owned by the forker, so carrying
// the source's per-app admin roster over would silently hand strangers
// management + force-merge rights on someone else's app. The forker
// keeps their own creator rights; the fork starts with no app admins.
function rewriteDappName(dir, name) {
  const p = path.join(dir, 'dapp.json');
  let obj = null;
  try {
    obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (_) {
    obj = null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  obj.name = name;
  delete obj.admins;
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

// Place the `.claude/` connector scaffold in the fork's working tree, so a
// fork of an app created before #1218 — or of an imported repo that never had
// one — stops prompting on every read-only connector call too.
//
// Write-if-absent, never overwrite: whatever the source repo carries in
// `.claude/` is the app's own, and a fork copies the app rather than
// normalising it. A source scaffolded by today's template already has these
// two files byte-for-byte, so the common case is a no-op.
//
// Plain fs on the tree that has just been flattened and not yet committed, so
// the files land in the single squashed commit below rather than needing a
// second push.
function writeConnectorScaffold(dir) {
  for (const file of getConnectorScaffoldFiles()) {
    const dest = path.join(dir, file.path);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, file.content);
  }
}

// Resolve the source row recorded in a fork's reference-only lineage. New
// rows carry appId + slug; the slug fallback keeps retries/recovery working
// for older rows that predate the appId form. This deliberately returns the
// live row rather than trusting display-enriched lineage from an API payload.
async function findForkSource(pool, forkApp) {
  let ref = forkApp && forkApp.forked_from;
  if (typeof ref === 'string') {
    try { ref = JSON.parse(ref); } catch (_) { ref = null; }
  }
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;

  if (Number.isInteger(ref.appId) && ref.appId > 0) {
    const { rows } = await pool.query('SELECT * FROM apps WHERE id = $1', [ref.appId]);
    // An appId is immutable and authoritative. If that row was deleted, do
    // not fall through to a slug that may since have been reused by a wholly
    // different app.
    return rows.length ? rows[0] : null;
  }
  if (typeof ref.slug === 'string' && ref.slug.trim()) {
    const { rows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [ref.slug.trim()]);
    if (rows.length) return rows[0];
  }
  return null;
}

// Copy the SOURCE app's current `main` tree into a brand-new bot-owned
// repo as a single, history-free commit — preserving binary assets
// (icon images, etc.) that github.pushFiles would corrupt. NOT a
// GitHub fork: both repos are bot-owned (GitHub disallows self-forks)
// and we want an independent app with its own issues/PRs. Leaves the
// fork's working tree on disk at `tempDir` for finalizeDeploy to build
// from, and returns { repoUrl, mainSha }.
async function copyRepoTree({ sourceApp, botUsername, forkSlug, forkName, tempDir }) {
  const botToken = process.env.GITHUB_BOT_TOKEN || '';
  if (!botToken) {
    throw new Error('GITHUB_BOT_TOKEN required to fork a repo');
  }

  // Resolve the source clone URL from repo_url (fall back to bot/<slug>).
  const parsed = github.parseGithubUrl(sourceApp.repo_url || '');
  const srcOwner = parsed ? parsed.owner : botUsername;
  const srcRepo = parsed ? parsed.repo : sourceApp.slug;
  const cloneUrl = await github.getCloneUrl(srcOwner, srcRepo);

  await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});
  try {
    await docker.execFileAsync('git', [
      'clone', '--depth', '1',
      '--recurse-submodules', '--shallow-submodules',
      cloneUrl, tempDir,
    ], { timeout: 120000 });
  } catch (err) {
    // Let deploy-failure classify this as a source-clone problem instead of
    // the undifferentiated `other` stage the old fork path exposed.
    err.cloneFailed = true;
    throw err;
  }

  // Flatten to a history-free tree: strip every .git (top-level dir and
  // any submodule .git files) plus .gitmodules, so `git add -A` commits
  // the materialised working tree (submodule contents become plain
  // files) rather than gitlinks. Then rewrite the display name.
  await docker.execFileAsync('bash', ['-c',
    'set -e; find "$DIR" -name .git -prune -exec rm -rf {} + ; rm -f "$DIR/.gitmodules"',
  ], { timeout: 30000, env: { ...process.env, DIR: tempDir } });
  rewriteDappName(tempDir, forkName);
  writeConnectorScaffold(tempDir);

  // Create the fork's repo (bot PAT, public, auto_init) then force-push
  // our single squashed commit over the auto-init commit. The bot PAT is
  // supplied via an inline credential helper scoped to this one push
  // (same pattern as services/worker.js execPushFromWorker) and passed
  // through the process env so it never lands in argv.
  // adoptExisting: a fork retry after a partial failure re-uses the same
  // fork slug, so the repo may already exist on the bot account — adopt
  // it rather than 422ing; the force-push below overwrites its content.
  const repo = await github.createRepo(botUsername, forkSlug, {
    description: `${forkName}: forked on Homeroom`,
    adoptExisting: true,
  });
  const repoUrl = repo.html_url;
  const pushUrl = `https://github.com/${botUsername}/${forkSlug}.git`;

  const script =
    'set -e; cd "$DIR" && ' +
    'git init -q -b main && ' +
    'git add -A && ' +
    'git -c user.email="bot@usernode" -c user.name="usernode-bot" commit -q -m "$MSG" && ' +
    'git -c credential.helper="!f() { echo username=x-access-token; echo password=$PAT; }; f" ' +
    'push -q --force "$PUSHURL" HEAD:main >&2 && ' +
    'git rev-parse HEAD';

  let mainSha = null;
  try {
    const { stdout } = await docker.execFileAsync('bash', ['-c', script], {
      timeout: 120000,
      env: {
        ...process.env,
        DIR: tempDir,
        MSG: `Forked from ${sourceApp.slug}`,
        PAT: botToken,
        PUSHURL: pushUrl,
      },
    });
    mainSha = (stdout || '').trim().split('\n').pop() || null;
  } catch (err) {
    const clean = String(err.message || '').replace(botToken, '***');
    const pushError = new Error(`fork repo push failed: ${clean}`);
    pushError.repoFailed = true;
    throw pushError;
  }

  return { repoUrl, mainSha };
}

// Copy the SOURCE app's non-private stored secrets into the fork's
// app_secrets (re-encrypted for the new app_id). Private secrets are
// deliberately NOT copied — they're kept out of forks for the same
// reason they're kept out of staging containers; the fork's owner
// re-enters them, and finalizeDeploy's required-secrets gate lands the
// fork in `awaiting_secrets` if a required private key is unset.
// Platform-provided keys (DATABASE_URL, JWT_SECRET, the LLM proxy pair,
// …) are never in app_secrets, so they're minted fresh by the shared
// deploy tail automatically.
async function copyNonPrivateSecrets(pool, config, sourceAppId, forkAppId, manifest) {
  try {
    const declaredByKey = new Map(
      (manifest.secrets || []).map((s) => [s.key, s])
    );
    const sourceValues = await appSecrets.getRawValues(pool, sourceAppId, config.dataEncryptionKey);
    for (const [key, value] of Object.entries(sourceValues)) {
      const declared = declaredByKey.get(key);
      // Skip orphans (no longer declared → treat as private) and any
      // entry marked private.
      if (!declared || declared.private) continue;
      await appSecrets.setValue(pool, forkAppId, key, value, {
        sensitive: false, userId: null, dataKey: config.dataEncryptionKey,
      });
    }
  } catch (err) {
    log.warn('app-forker', 'Non-private secret copy failed (continuing)', {
      forkAppId, err: err.message,
    });
  }
}

// Async worker mirroring app-creator.createApp, but instead of a fresh
// template it clones the SOURCE app's repo, its per-app Postgres DB
// (public data only — cloneDatabase applies the staging:private
// redaction), and its non-private secrets. Everything after (build →
// run → health → reconcile → finalize) runs through the exact same
// finalizeDeploy() the create path uses, so the two can't drift.
async function forkApp(config, appRow, sourceApp) {
  const pool = getPool(config);
  const { id: appId, name, slug } = appRow;

  // Once repo_url is present, copyRepoTree completed and the fork's own
  // immutable source snapshot is already in its independent repository.
  // Resume from that repository instead of re-copying a source app that may
  // since have changed or been deleted. createApp's import branch never
  // writes template files, and its template-boundary guard below protects
  // this contract if repo_url is ever absent.
  if (appRow.repo_url) {
    log.info('app-forker', 'Resuming fork from copied repository', { appId, slug });
    return createApp(config, appRow);
  }

  const tempDir = `/tmp/usernode-fork-${slug}`;
  let failureStage = 'other';
  let mainSha = null;

  try {
    // These are also route guards, but the worker is callable from Retry and
    // background repair. Keep the invariant at the operation boundary too.
    if (appRow.self_hosted || (sourceApp && sourceApp.self_hosted)) {
      throw new Error('The platform app cannot be forked.');
    }
    if (!sourceApp) {
      throw new Error('The source app for this fork no longer exists.');
    }
    if (!sourceApp.repo_url) {
      const err = new Error('The source app repository is not ready to copy yet.');
      err.cloneFailed = true;
      throw err;
    }
    if (!github.isEnabled()) {
      const err = new Error('Forking is unavailable because GitHub integration is not configured.');
      err.repoFailed = true;
      throw err;
    }

    log.info('app-forker', 'Starting fork', { appId, slug, sourceSlug: sourceApp.slug });
    await pool.query('UPDATE apps SET status = $1 WHERE id = $2', ['creating', appId]);

    // 1. Clone the source's per-app Postgres DB into the fork's DB. This
    // reuses the exact staging-clone path: public tables copy with rows,
    // staging:private tables copy schema-only (empty), staging:private
    // columns are scrubbed — the right trust boundary for a new,
    // independently-owned app. Returns a fresh per-fork role password.
    failureStage = 'database';
    reportPhase(appId, slug, 'database');
    const forkDbName = dbManager.appDbName(slug);
    const sourceDbName = dbManager.appDbName(sourceApp.slug);
    const { password: dbPassword } = await dbManager.cloneDatabase(sourceDbName, forkDbName);
    await pool.query('UPDATE apps SET db_password = $1 WHERE id = $2', [dbPassword, appId]);
    const dbUrl = dbManager.connectionUrl(forkDbName, dbPassword);

    // 2. Copy the source repo's current main tree into a fresh bot-owned
    // repo (history-free, binary-safe), rewriting dapp.json's name.
    failureStage = 'repo';
    reportPhase(appId, slug, 'repository');
    const botUsername = await github.getBotUsername();
    const copied = await copyRepoTree({
      sourceApp, botUsername, forkSlug: slug, forkName: name, tempDir,
    });
    const { repoUrl } = copied;
    mainSha = copied.mainSha;
    await pool.query('UPDATE apps SET repo_url = $1 WHERE id = $2', [repoUrl, appId]);

    // 3. Copy non-private secrets (must land BEFORE finalizeDeploy's
    // required-secrets gate runs). Read the fork's manifest from the
    // freshly-cloned tree to know which keys are non-private.
    const manifest = appManifest.read(tempDir);
    await copyNonPrivateSecrets(pool, config, sourceApp.id, appId, manifest);

    // 4. Shared deploy tail (identical to createApp): manifest reconcile,
    // secrets gate, build, run, health, finalize.
    await finalizeDeploy(config, { appId, name, slug, tempDir, dbUrl, repoUrl, mainSha });
  } catch (err) {
    log.error('app-forker', 'Fork failed', { appId, slug, err: err.message });
    const failure = deployFailure.record(err, {
      ...(failureStage === 'database' && !err.cloneFailed && !err.repoFailed
        ? { stage: 'database' } : {}),
      ...(failureStage === 'repo' && !err.cloneFailed && !err.repoFailed
        ? { stage: 'repo' } : {}),
      sha: mainSha || null,
    });
    await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});
    await pool.query(
      'UPDATE apps SET status = $1, last_failure = $2 WHERE id = $3',
      ['error', JSON.stringify(failure), appId]
    ).catch(() => {});
    endPhases(slug);
    pushAppStatusUpdate({ id: appId, slug, status: 'error', errorReason: failure.reason });
  }
}

module.exports = { forkApp, copyRepoTree, findForkSource };
