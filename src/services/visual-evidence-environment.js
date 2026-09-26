'use strict';

// #2380 — exact-revision, internal-only base/head environments for visual
// evidence. Both databases are recreated from one immutable redacted source
// before exploration and before each clean replay pass. No caller receives a
// public hostname and the app is not told which side it is rendering.

const fs = require('fs/promises');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const applicationRuntime = require('./application-runtime');
const appManifest = require('./app-manifest');
const appSecrets = require('./app-secrets');
const dbManager = require('./db-manager');
const docker = require('./docker');
const github = require('./github');
const log = require('./logger');
const pendingSecrets = require('./pending-secrets');
const stagingEnv = require('./staging-env');
const evidenceFixtures = require('./visual-evidence-fixtures');
const { getPool } = require('../db/pool');

const IMAGE_RECIPE = 'v1';
const EVIDENCE_LABEL = 'social.usernode.io/evidence-run';
const EVIDENCE_SIDE_LABEL = 'social.usernode.io/evidence-side';

class VisualEvidenceEnvironmentError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'VisualEvidenceEnvironmentError';
    this.code = code;
    this.detail = detail;
  }
}

// Promise.all rejects before sibling work settles. That is unsafe for source
// checkouts, image builds, database clones, and deploys because cleanup could
// remove a directory or template while the sibling still uses it.
async function allSettledValues(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((result) => result.value);
}

function exactSha(value, label = 'revision') {
  const sha = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new VisualEvidenceEnvironmentError('invalid_evidence_revision', `${label} must be an exact 40-character commit SHA.`);
  }
  return sha;
}

function repoParts(repoUrl) {
  const match = String(repoUrl || '').match(/^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?$/i);
  if (!match) throw new VisualEvidenceEnvironmentError('invalid_evidence_repository', 'The visual change preview requires an HTTPS GitHub repository.');
  return { owner: match[1], repo: match[2] };
}

function runtimeName(runId, side, kind = 'docker') {
  if (!/^[0-9a-f]{32}$/.test(String(runId || '')) || !['base', 'head'].includes(side)) {
    throw new VisualEvidenceEnvironmentError('invalid_evidence_runtime', 'Evidence runtime identity is invalid.');
  }
  const token = runId.slice(0, 16);
  return kind === 'kubernetes'
    ? `sv-evidence-${token}-${side === 'base' ? 'b' : 'h'}`
    : `usernode-evidence-${token}-${side}`;
}

function dockerImageName(app, sha) {
  const appId = Number(app?.id);
  if (!Number.isInteger(appId) || appId <= 0) throw new VisualEvidenceEnvironmentError('invalid_evidence_app', 'Evidence app id is invalid.');
  return `usernode-evidence-${appId}:${exactSha(sha).slice(0, 16)}-${IMAGE_RECIPE}`;
}

function evidenceCapacityEnv(config, app) {
  return app?.slug === config?.selfAppSlug ? { MAX_APPS: '0' } : {};
}

async function git(args, options = {}) {
  return docker.execFileAsync('git', args, { timeout: options.timeout || 120_000, maxBuffer: 4 * 1024 * 1024 });
}

async function checkoutExactRevision({ app, session, sha, side, parentDir }) {
  const revision = exactSha(sha, `${side} SHA`);
  const { owner, repo } = repoParts(app.repo_url);
  const cloneUrl = await github.getCloneUrl(owner, repo);
  const checkoutDir = path.join(parentDir, side);
  await git(['clone', '--depth', '1', '--no-tags', '--recurse-submodules', '--shallow-submodules', cloneUrl, checkoutDir]);

  const refs = [];
  if (side === 'head' && Number(session?.pr_number) > 0) refs.push(`refs/pull/${Number(session.pr_number)}/head`);
  refs.push(revision);
  let checkedOut = false;
  let lastError = null;
  try {
    await git(['-C', checkoutDir, 'checkout', '--detach', revision], { timeout: 30_000 });
    checkedOut = true;
  } catch (err) { lastError = err; }
  for (const ref of refs) {
    if (checkedOut) break;
    try {
      await git(['-C', checkoutDir, 'fetch', '--depth', '1', '--no-tags', 'origin', ref]);
      await git(['-C', checkoutDir, 'checkout', '--detach', revision], { timeout: 30_000 });
      checkedOut = true;
    } catch (err) { lastError = err; }
  }
  if (!checkedOut) {
    throw new VisualEvidenceEnvironmentError('evidence_revision_unreachable', `Could not check out the exact ${side} revision.`, lastError?.message || null);
  }
  await git(['-C', checkoutDir, 'submodule', 'update', '--init', '--recursive', '--depth', '1']).catch(() => {});
  const { stdout } = await git(['-C', checkoutDir, 'rev-parse', 'HEAD'], { timeout: 5_000 });
  const resolved = String(stdout || '').trim().toLowerCase();
  if (resolved !== revision) {
    throw new VisualEvidenceEnvironmentError('evidence_revision_mismatch', `${side} checkout resolved to a different commit.`);
  }
  return { side, sha: revision, dir: checkoutDir };
}

async function resolvedStagingEnv(config, pool, session, app, checkoutDir) {
  const manifest = appManifest.read(checkoutDir);
  const stored = await appSecrets.getRawValues(pool, app.id, config.dataEncryptionKey);
  try {
    const held = await pendingSecrets.rawValuesForSession(pool, session.id, config.dataEncryptionKey);
    for (const [key, value] of Object.entries(held || {})) {
      if (!Object.prototype.hasOwnProperty.call(stored, key)) stored[key] = value;
    }
  } catch (err) {
    log.warn('visual-evidence', 'Pending proposal secrets unavailable for evidence environment', {
      sessionId: session.id, error: err.message,
    });
  }
  const merged = appSecrets.mergeForDeploy(
    manifest, stored, appSecrets.platformDefaultsFromEnv(), { forStaging: true }
  );
  if (merged.missingRequired.length || merged.missingPrivateStagingDefault.length) {
    throw new VisualEvidenceEnvironmentError(
      'evidence_missing_secrets',
      'The paired evidence environment cannot start because its exact revision is missing staging-safe variables.',
      {
        missingRequired: merged.missingRequired,
        missingPrivateStagingDefault: merged.missingPrivateStagingDefault,
      }
    );
  }
  return { ...stagingEnv.platformStagingEnv(app, config), ...merged.env };
}

async function immutableImageDigest(config, imageRef) {
  return applicationRuntime.mode(config) === 'docker' ? docker.imageDigest(imageRef) : imageRef;
}

async function buildRevision(config, { app, session, checkout, reuseImageRef = null, onProgress = null }) {
  if (reuseImageRef && session.staging_commit_sha === checkout.sha) {
    const reusable = applicationRuntime.mode(config) !== 'docker' || await docker.imageExists(reuseImageRef);
    if (reusable) {
      return {
        imageRef: reuseImageRef,
        buildRef: session.staging_build_ref || null,
        imageDigest: await immutableImageDigest(config, reuseImageRef),
        reused: true,
      };
    }
  }

  const dockerImage = dockerImageName(app, checkout.sha);
  if (applicationRuntime.mode(config) === 'docker' && await docker.imageExists(dockerImage)) {
    return {
      imageRef: dockerImage, buildRef: null,
      imageDigest: await docker.imageDigest(dockerImage), reused: true,
    };
  }
  const built = await applicationRuntime.build(config, {
    app,
    revision: checkout.sha,
    environment: 'staging',
    sessionId: session.id,
    sourceDir: checkout.dir,
    dockerImage,
    onProgress,
  });
  return {
    ...built,
    imageDigest: await immutableImageDigest(config, built.imageRef),
    reused: !!built.reused,
  };
}

async function preparePair(config, { pool = getPool(config), run, session, app, onProgress = null }) {
  if (!run?.id) throw new VisualEvidenceEnvironmentError('invalid_evidence_run', 'Evidence run is required.');
  const baseSha = exactSha(run.base_sha || run.baseSha, 'base SHA');
  const headSha = exactSha(run.head_sha || run.headSha, 'head SHA');
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `usernode-evidence-${run.id.slice(0, 8)}-`));
  let prepared = null;
  const stage = (name) => {
    if (typeof onProgress === 'function') onProgress({ stage: name });
  };
  try {
    stage('checkout_revisions');
    const [baseCheckout, headCheckout] = await allSettledValues([
      checkoutExactRevision({ app, session, sha: baseSha, side: 'base', parentDir: rootDir }),
      checkoutExactRevision({ app, session, sha: headSha, side: 'head', parentDir: rootDir }),
    ]);
    stage('resolve_staging_env');
    const [baseEnv, headEnv] = await allSettledValues([
      resolvedStagingEnv(config, pool, session, app, baseCheckout.dir),
      resolvedStagingEnv(config, pool, session, app, headCheckout.dir),
    ]);
    stage('prepare_fixture');
    const source = await dbManager.prepareStagingCloneSource(
      dbManager.appDbName(app.slug), { sourceId: run.id }
    );
    prepared = source;
    stage('build_revisions');
    const [baseImage, headImage] = await allSettledValues([
      buildRevision(config, { app, session, checkout: baseCheckout, onProgress }),
      buildRevision(config, {
        app, session, checkout: headCheckout,
        reuseImageRef: session.staging_image_ref || null, onProgress,
      }),
    ]);
    const kind = applicationRuntime.mode(config);
    return {
      runId: run.id,
      sessionId: session.id,
      app,
      rootDir,
      preparedSource: source,
      fixtureFingerprint: source.fingerprint,
      fixtureProfileSet: false,
      fixtureProfile: null,
      availableFixtures: [],
      sides: {
        base: {
          sha: baseSha, checkout: baseCheckout.dir, env: baseEnv,
          dbName: dbManager.evidenceDbName(app.slug, run.id, 'base'),
          runtimeName: runtimeName(run.id, 'base', kind), ...baseImage,
        },
        head: {
          sha: headSha, checkout: headCheckout.dir, env: headEnv,
          dbName: dbManager.evidenceDbName(app.slug, run.id, 'head'),
          runtimeName: runtimeName(run.id, 'head', kind), ...headImage,
        },
      },
      deployments: null,
    };
  } catch (err) {
    if (prepared) await dbManager.releasePreparedCloneSource(prepared).catch(() => {});
    await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function runtimeRef(config, pair, side) {
  return { runtimeKind: applicationRuntime.mode(config), runtimeName: pair.sides[side].runtimeName };
}

async function stopPair(config, pair, { strict = false } = {}) {
  const results = await Promise.allSettled(['base', 'head'].map((side) => applicationRuntime.remove(
    config, runtimeRef(config, pair, side), { stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC }
  )));
  const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  for (const err of errors) {
    log.warn('visual-evidence', 'Evidence runtime cleanup failed', {
      runId: pair.runId, error: err.message,
    });
  }
  pair.deployments = null;
  if (strict && errors.length) {
    throw new VisualEvidenceEnvironmentError(
      'evidence_runtime_reset_failed',
      'The previous evidence runtimes could not be stopped cleanly.',
      errors.map((err) => err.message).slice(0, 4)
    );
  }
  return { stopped: errors.length === 0, errors };
}

async function resetPair(config, pair, { onProgress = null } = {}) {
  if (!pair?.preparedSource || !pair?.sides) throw new VisualEvidenceEnvironmentError('invalid_evidence_pair', 'Prepared evidence pair is required.');
  await stopPair(config, pair, { strict: true });
  try {
    // Two real evidence resets timed out while the clone passes ran together.
    // The ownership/redaction passes scan this app's large schema; serialize
    // them to reduce contention against the same immutable source.
    const clones = [];
    for (const side of ['base', 'head']) {
      onProgress?.({ stage: `clone_${side}` });
      const spec = pair.sides[side];
      const cloned = await dbManager.cloneFromPreparedSource(pair.preparedSource, spec.dbName, {
        onProgress: (phase) => onProgress?.({ stage: `clone_${side}_${phase}` }),
      });
      clones.push([side, cloned]);
    }
    const cloneBySide = Object.fromEntries(clones);
    onProgress?.({ stage: 'deploy_pair' });
    const deployments = await allSettledValues(['base', 'head'].map(async (side) => {
      const spec = pair.sides[side];
      // A production clone can legitimately sit at the platform's app cap.
      // That makes ordinary create-dialog stories unreachable even though
      // the feature works for a member on a server with capacity. Disable
      // only this self-app limit inside disposable evidence runtimes; neither
      // production nor an ordinary staging preview receives the override.
      const evidenceEnv = evidenceCapacityEnv(config, pair.app);
      const deployed = await applicationRuntime.deploy(config, {
        app: pair.app,
        environment: 'staging',
        sessionId: pair.sessionId,
        imageRef: spec.imageRef,
        dockerName: spec.runtimeName,
        runtimeName: spec.runtimeName,
        internalOnly: true,
        env: {
          DATABASE_URL: dbManager.connectionUrl(spec.dbName, cloneBySide[side].password),
          ...spec.env,
          ...evidenceEnv,
        },
        port: 3000,
        memory: docker.STAGING_MEMORY,
        cpus: docker.STAGING_CPUS,
        labels: {
          [EVIDENCE_LABEL]: pair.runId,
          [EVIDENCE_SIDE_LABEL]: side,
          [stagingEnv.LABEL_ENV_FP]: stagingEnv.envFingerprint({ ...spec.env, ...evidenceEnv }),
        },
      });
      return [side, deployed];
    }));
    pair.deployments = Object.fromEntries(deployments);
    let fixtureProfile = null;
    let availableFixtures = [];
    if (pair.app.slug === config.selfAppSlug) {
      const fixtureProfiles = [];
      const fixtureInputs = Object.fromEntries(['base', 'head'].map((side) => [side, {
        databaseUrl: dbManager.connectionUrl(pair.sides[side].dbName, cloneBySide[side].password),
        slug: pair.app.slug, runId: pair.runId, side,
      }]));
      onProgress?.({ stage: 'seed_evidence_identities' });
      const admins = await allSettledValues(['base', 'head'].map((side) =>
        evidenceFixtures.ensureFullAdminIdentity(fixtureInputs[side])));
      fixtureProfiles.push(evidenceFixtures.FULL_ADMIN_PROFILE);
      availableFixtures.push(admins[0]);
      onProgress?.({ stage: 'inspect_evidence_fixtures' });
      const ready = await allSettledValues(['base', 'head'].map((side) =>
        evidenceFixtures.canCopyMemberAgentSession(fixtureInputs[side])));
      // A fixture must exist on BOTH exact revisions. Never insert a state
      // on only one side of a before/after comparison.
      if (ready.every(Boolean)) {
        onProgress?.({ stage: 'seed_evidence_fixtures' });
        const seeded = await allSettledValues(['base', 'head'].map((side) =>
          evidenceFixtures.copyMemberAgentSession({
            ...fixtureInputs[side], selfAppSlug: config.selfAppSlug,
          })));
        fixtureProfiles.push(evidenceFixtures.PROFILE);
        availableFixtures.push(seeded[0]);
      }
      fixtureProfile = fixtureProfiles.join('+');
    }
    if (pair.fixtureProfileSet && pair.fixtureProfile !== fixtureProfile) {
      throw new VisualEvidenceEnvironmentError('evidence_fixture_mismatch',
        'A paired evidence reset changed the available fixture profile.');
    }
    pair.fixtureProfileSet = true;
    pair.fixtureProfile = fixtureProfile;
    pair.availableFixtures = availableFixtures;
    pair.fixtureFingerprint = fixtureProfile
      ? crypto.createHash('sha256').update(`${pair.preparedSource.fingerprint}\n${fixtureProfile}`).digest('hex')
      : pair.preparedSource.fingerprint;
    return {
      origins: {
        base: applicationRuntime.appOrigin(config, pair.deployments.base),
        head: applicationRuntime.appOrigin(config, pair.deployments.head),
      },
      baseSha: pair.sides.base.sha,
      headSha: pair.sides.head.sha,
      fixtureFingerprint: pair.fixtureFingerprint,
      availableFixtures,
      baseImageDigest: pair.sides.base.imageDigest,
      headImageDigest: pair.sides.head.imageDigest,
    };
  } catch (err) {
    await stopPair(config, pair);
    await Promise.all(['base', 'head'].map((side) => dbManager.dropDatabase(pair.sides[side].dbName, { strict: true }).catch(() => {})));
    throw err;
  }
}

async function cleanupPair(config, pair) {
  if (!pair) return { cleaned: true, errors: [] };
  const errors = [];
  const stopped = await stopPair(config, pair).catch((err) => ({ errors: [err] }));
  errors.push(...(stopped.errors || []));
  for (const side of ['base', 'head']) {
    const dbName = pair.sides?.[side]?.dbName;
    if (dbName) await dbManager.dropDatabase(dbName, { strict: true }).catch((err) => errors.push(err));
  }
  if (pair.preparedSource) {
    await dbManager.releasePreparedCloneSource(pair.preparedSource).catch((err) => errors.push(err));
  }
  if (pair.rootDir) await fs.rm(pair.rootDir, { recursive: true, force: true }).catch((err) => errors.push(err));
  if (errors.length) {
    log.warn('visual-evidence', 'Evidence pair cleanup completed with leaks to sweep', {
      runId: pair.runId, errors: errors.map((err) => err.message).slice(0, 6),
    });
  }
  return { cleaned: errors.length === 0, errors: errors.map((err) => err.message) };
}

module.exports = {
  IMAGE_RECIPE,
  EVIDENCE_LABEL,
  EVIDENCE_SIDE_LABEL,
  VisualEvidenceEnvironmentError,
  allSettledValues,
  exactSha,
  repoParts,
  runtimeName,
  dockerImageName,
  evidenceCapacityEnv,
  checkoutExactRevision,
  resolvedStagingEnv,
  buildRevision,
  preparePair,
  resetPair,
  stopPair,
  cleanupPair,
};
