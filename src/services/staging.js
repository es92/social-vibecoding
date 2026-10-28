const fs = require('fs');
const path = require('path');
const { withBuildUse, withResourceUse } = require('./build-retention-guard');
const { PRODUCTION_BUILD_LOCK } = require('./advisory-locks');
const log = require('./logger');
const docker = require('./docker');
const applicationRuntime = require('./application-runtime');
const caddy = require('./caddy');
const dbManager = require('./db-manager');
const github = require('./github');
const appManifest = require('./app-manifest');
const appSecrets = require('./app-secrets');
const appLlmEnv = require('./app-llm-env');
const appStorageEnv = require('./app-storage-env');
const { appIdentityEnv } = require('./app-identity-env');
const stagingEnv = require('./staging-env');
const events = require('./events');
const { getPool } = require('../db/pool');
const repoRef = require('./repo-ref');

// Custom error thrown by both staging + prod build paths when the cloned
// repo's `dapp.json` declares required secrets that have no stored value. Callers (votes.js merge path, drift poller, dev-chat
// retries) inspect `.missingSecrets` to render a tailored "fix this"
// toast instead of a generic "build failed".
class MissingSecretsError extends Error {
  constructor(missingSecrets) {
    super(`Cannot deploy: missing required secrets [${missingSecrets.join(', ')}]`);
    this.name = 'MissingSecretsError';
    this.missingSecrets = missingSecrets;
  }
}

// A production rebuild of the commit whose image was already refused for
// running as root (deploy-failure.js waitsForNewCommit): building and rolling
// it out again can only end the same way, so it stops after the clone, with
// the original failure left on the row. A new commit, or a deploy asked for
// by hand (options.retrySameCommit), goes ahead.
class WaitsForNewCommitError extends Error {
  constructor(sha) {
    super(`Not deploying ${String(sha).slice(0, 7)} again: its image runs as root, so it waits for a commit that changes the Dockerfile`);
    this.name = 'WaitsForNewCommitError';
    this.sha = sha;
  }
}

// Distinct error for the staging-specific case where a `required + private`
// secret has no manifest-committed `staging_default` (or `default`). Surfaces
// with a different message because the remediation is different from
// MissingSecretsError: the user can't fix this from Settings → Secrets
// (private secrets are *intentionally* not staged from the prod store).
// They have to either commit a `staging_default` to dapp.json or unmark
// the entry private. See app-conventions.md "Public vs private secrets".
class PrivateSecretMissingStagingDefaultError extends Error {
  constructor(missingKeys) {
    super(
      `Cannot stage: required+private secret(s) [${missingKeys.join(', ')}] ` +
      `have no staging fallback. Add a \`staging_default\` (or \`default\`) ` +
      `to each entry in dapp.json, or unmark them private.`
    );
    this.name = 'PrivateSecretMissingStagingDefaultError';
    this.missingKeys = missingKeys;
  }
}

// Local-dev URLs are emitted with `localhost` as the host and rewritten to
// whatever hostname the client is actually reaching the platform on. See
// public/js/dev-host.js — this keeps laptop + phone-on-LAN working without
// any env-var config.

// #866 — display-only preview state for a proposal row, derived on read.
//
// An imported PR is promoted the instant it's imported, so its card exists
// for minutes before its preview does. With nothing but `staging_url` to go
// on the client can't tell "still building" from "will never build", and a
// row with no Preview button reads as a bug either way. These two derived
// fields close that gap WITHOUT a persisted staging_state column: building
// is the row's own phase, which the preview machine writes when it starts a
// build (every Pod sees it, and it survives a restart); the error is the
// reason the checks pass already captured in check_error_detail.
function previewDisplayState(row) {
  const missing = !row.staging_url;
  const stagingBuilding = !!(missing && row.check_state === 'pending' && row.check_phase === 'building');
  const stagingError = (missing && row.check_state === 'error' && row.check_error_detail)
    ? row.check_error_detail
    : null;
  return {
    staging_building: stagingBuilding,
    staging_error: stagingError,
    preview_state: stagingBuilding ? 'building'
      : stagingError ? 'failed'
        : missing ? 'unavailable' : 'ready',
  };
}

// Publish which build step a preview is on (and how long the finished
// ones took) so "Preview building…" can say what it is doing. Rides the
// checks progress row and event (services/visuals.js). Best-effort and
// lazy-required: the build must never fail, or wait, on a status write,
// and visuals requires this module at load.
function reportBuildStep(config, session, step, timings, startedAt, image = null) {
  try {
    const visuals = require('./visuals');
    const build = {
      step,
      startedAt: new Date(startedAt).toISOString(),
      steps: visuals.buildProgressFromTimings(timings)?.steps || [],
      ...(image ? { image } : {}),
      ...(Number.isFinite(timings.totalMs) ? { totalMs: Math.round(timings.totalMs) } : {}),
    };
    visuals.setChecksBuildProgress(getPool(config), session.id, build).catch(() => {});
    visuals.notifyChecksBuildProgress(session.id, build);
  } catch { /* status only */ }
}

// The image build's own progress, inside the "build image" step: the
// runtime reports each phase or step line as it happens, and this hands it
// on at most once a second (a build prints many lines a second), with the
// trailing one always delivered.
const IMAGE_PROGRESS_MIN_GAP_MS = 1000;
// How many of the image build's own steps the finished record keeps, and how
// much of each instruction it keeps. A Dockerfile build reports ~36 steps;
// listing all of them would bury the one that cost the time, which is the
// whole reason for recording them.
const IMAGE_SLOW_STEPS_KEPT = 4;
const IMAGE_STEP_LABEL_MAX = 32;

// One instruction, as a label: `RUN npm ci --no-audit --loglevel=error`
// carries nothing after the verb and its first argument that helps identify
// which step this was.
function imageStepLabel(detail, index) {
  const text = String(detail == null ? '' : detail).replace(/\s+/g, ' ').trim();
  if (!text) return `step ${index}`;
  return text.length > IMAGE_STEP_LABEL_MAX ? `${text.slice(0, IMAGE_STEP_LABEL_MAX - 1)}…` : text;
}

function makeImageProgressReporter(config, session, timings, startedAt, now = () => Date.now()) {
  let last = null;
  let lastAt = 0;
  let timer = null;
  // Per-step wall clock, for a runtime that reports a step COUNTER rather
  // than named phases (docker). A step's cost is the gap between its line
  // and the next one's, so each step is closed when the next begins and the
  // final one when the build ends. This is what turns "image build: 3m 4s"
  // into which instruction spent it.
  const stepTimes = [];
  let openStep = null;
  const closeStep = (at) => {
    if (!openStep) return;
    stepTimes.push({ name: openStep.label, ms: Math.max(0, at - openStep.startedAt) });
    openStep = null;
  };
  const flush = () => {
    timer = null;
    lastAt = now();
    reportBuildStep(config, session, 'image_build', timings, startedAt, last);
  };
  return {
    report(image) {
      if (!image || typeof image !== 'object') return;
      const at = now();
      if (Number.isInteger(image.index) && (!openStep || openStep.index !== image.index)) {
        closeStep(at);
        openStep = { index: image.index, label: imageStepLabel(image.detail, image.index), startedAt: at };
      }
      last = { ...(last || {}), ...image };
      const gap = at - lastAt;
      if (gap >= IMAGE_PROGRESS_MIN_GAP_MS) {
        if (timer) { clearTimeout(timer); timer = null; }
        flush();
      } else if (!timer) {
        timer = setTimeout(flush, IMAGE_PROGRESS_MIN_GAP_MS - gap);
        if (typeof timer.unref === 'function') timer.unref();
      }
    },
    close() {
      if (timer) { clearTimeout(timer); timer = null; }
      closeStep(now());
    },
    last() { return last; },
    // The steps worth naming: the slowest few, back in the order they ran.
    slowestSteps() {
      if (!stepTimes.length) return null;
      const top = stepTimes.slice().sort((a, b) => b.ms - a.ms).slice(0, IMAGE_SLOW_STEPS_KEPT);
      const keep = new Set(top);
      return stepTimes.filter((s) => keep.has(s));
    },
  };
}

// A root-only checkout (the Kubernetes lane, below) has no files under the
// root, so a root entry that is a link into a subdirectory points at nothing
// there: a dapp.json kept behind a link to `config/dapp.json` would read as
// "no manifest". True when the directory holds such a link.
function rootHasDanglingLink(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isSymbolicLink() && !fs.existsSync(path.join(dir, entry.name)));
  } catch {
    return false;
  }
}

// `attempt` (the workflow's preview machine, preview.prepare): build attempt
// `n` into its own checkout and database `dbName`, deploy it with its own
// env Secret and the attempt fence (restoring attempt `servingN`'s template
// if the rollout fails), call `checkpoint()` before each thing it
// creates (it throws once the attempt is cancelled), and record nothing on
// the row: the machine publishes the receipt. Reached only through
// prepareAttempt.
async function buildAndDeployStagingInner(config, session, app, commitHash, { attempt }) {
  const containerName = `usernode-staging-${app.slug}--${session.id}`;
  const imageName = `usernode-staging-${app.slug}-${session.id}:${commitHash.substring(0, 6)}`;

  log.info('staging', 'Building staging', { sessionId: session.id, app: app.slug });

  // Per-phase wall-clock for the build half of a checks run. Nothing
  // persisted how long any of this took, which is why diagnosing the
  // proposal-checks slowdown meant reading a container log tail.
  const buildStartedAt = Date.now();
  // startedAt: when this build began. The checks run that follows starts its
  // clock here (visuals.captureForSession), so its time to a verdict counts
  // the build as well as the checks (#4696).
  const timings = { startedAt: buildStartedAt };
  reportBuildStep(config, session, 'source_fetch', timings, buildStartedAt);

  try {
    // 1. Clone the PR branch
    const { owner, repo } = repoRef.ownerRepo(app.repo_url) || {};
    if (!owner || !repo) throw new Error('Could not parse repo URL');

    const cloneUrl = await github.getCloneUrl(owner, repo);
    // One checkout per claim of an attempt: a claim that lost its lease may
    // still be using its own when the next one starts.
    const cloneDir = `/tmp/usernode-preview-${session.id}-a${attempt.n}-c${attempt.claim || 0}`;

    // Whether the caller pinned a concrete commit. 'latest' (and any falsy
    // value) keeps the historical "build the current branch tip" behaviour
    // used by native sessions and the recovery/manual-deploy callers; a real
    // SHA means we must build EXACTLY that commit even if the branch has
    // advanced since it was captured. The image tag and clone-DB name below
    // already key off commitHash, so before this the build could tag one SHA
    // but actually compile the branch tip — harmless while the platform owns
    // the branch, but wrong for an imported PR whose external author keeps
    // pushing (#687). Pinning the checkout closes that gap.
    const pinnedSha = commitHash && commitHash !== 'latest' ? commitHash : null;

    // #866: a PR opened FROM A FORK has a head ref that doesn't exist in this
    // app's repo, so `git clone --branch <head ref>` fails outright and the
    // preview never builds (the reviewer just sees "Checks couldn't run").
    // GitHub publishes every PR's head commit — fork or not — under
    // refs/pull/<N>/head in the BASE repo, so when the caller pinned a
    // concrete commit and the session carries a PR number we clone the repo's
    // default branch and fetch that ref instead of the head branch. One path
    // covers both same-repo and fork imports.
    //
    // Native sessions (branches the platform itself owns and pushed) keep the
    // historical branch clone untouched — same behaviour, same timings.
    const prNumber = Number(session.pr_number) || null;
    // GitHub's pull refs only: a repository on Homeroom's git host has none
    // (its proposals are branches there), so it keeps the branch clone.
    const viaPullRef = !!(pinnedSha && prNumber && !repoRef.isHosted(app.repo_url));

    // #1350: a native session gets its branch on its first turn, so a
    // session that has never run one has nothing to clone. Refuse with a
    // reason rather than letting `git clone --branch null` fail: the
    // sweeps that call this already filter `branch_name IS NOT NULL`, so
    // reaching here means a direct caller (a manual redeploy, a recovery
    // pass) asked for a preview of work that does not exist yet.
    if (!viaPullRef && !session.branch_name) {
      throw new Error(
        'This session has no branch yet, so there is nothing to build a preview from. '
        + 'Send a message in the session first.'
      );
    }

    // A Kubernetes build fetches the commit from GitHub itself, so a whole
    // clone here downloads the same source a second time: for the self-app
    // 22 MB and 3,254 files, written to /tmp and deleted again once the
    // image is back. Everything read from this directory on that lane sits
    // at its root: dapp.json below, and inside the runtime's build the
    // scripts in package.json and which Dockerfile the tree carries. So the
    // clone there carries the commit's directory listing and its root files,
    // nothing under them and no submodules (the build fetches none either).
    // Docker builds FROM this directory and keeps the whole tree.
    const rootOnly = !applicationRuntime.buildReadsWholeSource(config);

    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
    // --recurse-submodules + --shallow-submodules so dapps that vendor
    // upstream sources via submodules (e.g. falling-sands → sandspiel)
    // get a complete tree at build time. No-op for dapps without
    // submodules. Timeout bumped to absorb worst-case submodule fetch.
    await docker.execFileAsync('git', [
      'clone', '--depth', '1',
      ...(rootOnly
        ? ['--filter=blob:none', '--sparse']
        : ['--recurse-submodules', '--shallow-submodules']),
      ...(viaPullRef ? [] : ['--branch', session.branch_name]),
      cloneUrl, cloneDir,
    ], { timeout: 120000 });

    // Exact-SHA pin (#687): when a concrete commit was requested, check out
    // exactly that commit. The shallow clone above only carries one tip, so
    // the commit usually isn't present yet: fetch it first (via the PR head
    // ref when we have a PR number — the only way to reach a fork's commit
    // through the base repo — else the bare SHA, which GitHub permits for a
    // reachable commit), then check it out. Detaches HEAD at the pinned
    // commit; a no-op detach when the tip already IS that SHA. Submodules are
    // re-synced to the checked-out commit afterwards (a no-op for dapps
    // without any). Scoped strictly to this checkout step — the rest of the
    // build (secrets gating, DB clone, container run, teardown) is unchanged.
    if (pinnedSha) {
      // The root-only checkout fetches the commit's root files as it detaches,
      // so it gets a network timeout.
      const detach = () => docker.execFileAsync('git', [
        '-C', cloneDir, 'checkout', '--detach', pinnedSha,
      ], { timeout: rootOnly ? 120000 : 30000 });
      // A whole-tree clone fails to detach at a commit it lacks, and that
      // failure is what sends the loop below to its shallow fetch. A clone
      // made with a filter does not fail: it fetches the commit on demand,
      // with its history (2,582 commits and about four seconds for the
      // self-app). So on the root-only path a commit is detached at only
      // once a ref of this clone is known to name it. The clone holds one
      // commit per fetch, and asking what that one is costs nothing.
      const holdsPinned = async (ref) => {
        if (!rootOnly) return true;
        const { stdout } = await docker.execFileAsync('git', [
          '-C', cloneDir, 'rev-parse', ref,
        ], { timeout: 5000 });
        return String(stdout || '').trim().toLowerCase().startsWith(pinnedSha.toLowerCase());
      };
      const fetchRefs = [
        ...(viaPullRef ? [`refs/pull/${prNumber}/head`] : []),
        pinnedSha,
      ];
      let checkedOut = false;
      // A plain detach only works when the pinned commit is already in the
      // shallow clone (same-repo import whose branch tip IS the pinned SHA).
      // Skip it for the pull-ref path: we cloned the default branch there, so
      // it can only ever fail.
      if (!viaPullRef) {
        try {
          if (!await holdsPinned('HEAD')) throw new Error(`The branch tip is not ${pinnedSha}`);
          await detach();
          checkedOut = true;
        } catch { /* fall through to the fetch attempts below */ }
      }
      let lastErr = null;
      for (const ref of fetchRefs) {
        if (checkedOut) break;
        try {
          await docker.execFileAsync('git', [
            '-C', cloneDir, 'fetch', '--depth', '1', 'origin', ref,
          ], { timeout: 120000 });
          if (!await holdsPinned('FETCH_HEAD')) throw new Error(`${ref} is not at ${pinnedSha}`);
          await detach();
          checkedOut = true;
        } catch (err) { lastErr = err; }
      }
      if (!checkedOut) throw lastErr || new Error(`Could not check out ${pinnedSha}`);
      if (!rootOnly) {
        await docker.execFileAsync('git', [
          '-C', cloneDir, 'submodule', 'update', '--init', '--recursive', '--depth', '1',
        ], { timeout: 120000 }).catch(() => {});
      }
    }

    // A tree whose root links into a subdirectory needs that subdirectory
    // for the reads below to see what a whole clone shows them. Rare enough
    // not to work out which one: give such a tree all of its files, and its
    // submodules' with them. The directory linked into can be a submodule,
    // whose files are in another repository: with the sparse checkout off
    // it is still an empty directory, and a dapp.json kept behind such a
    // link read as "no manifest", so the preview was built without the
    // secrets it requires. A submodule that cannot be fetched fails the
    // build here, as it fails the whole clone.
    if (rootOnly && rootHasDanglingLink(cloneDir)) {
      await docker.execFileAsync('git', [
        '-C', cloneDir, 'sparse-checkout', 'disable',
      ], { timeout: 120000 });
      await docker.execFileAsync('git', [
        '-C', cloneDir, 'submodule', 'update', '--init', '--recursive', '--depth', '1',
      ], { timeout: 120000 });
    }

    // 2. Read the dapp's manifest from the PR branch and check that all
    //    required secrets have stored values. Staging shares the prod
    //    secrets store for *non-private* keys (one set of values per
    //    app, not per env), so a PR introducing a new required key
    //    needs that key set in the app's Settings → Secrets first —
    //    same gate prod uses below.
    //
    //    Private secrets (the staging:private analog for env vars;
    //    see app-conventions.md "Public vs private secrets") are
    //    NOT propagated from the prod store. They resolve from
    //    manifest-committed `staging_default` / `default` only; if
    //    neither is set on a `required + private` entry, we fail
    //    loudly so the operator knows to commit a staging fallback or
    //    unmark private.
    const stagingManifest = appManifest.read(cloneDir);
    const stagingPool = getPool(config);
    const stagingStored = await appSecrets.getRawValues(stagingPool, app.id, config.dataEncryptionKey);
    // A proposal may DECLARE a new secret and carry its value (the panel's
    // "+ New variable" flow — services/pending-secrets.js). That value is
    // not in `app_secrets` yet, so without this a PR adding a new required
    // secret couldn't build its own preview. Only NON-private pending
    // values are injected: a private value is kept out of an unreviewed
    // PR's container exactly as mergeForDeploy's private-in-staging branch
    // keeps the stored one out. Best-effort — a lookup failure must not
    // fail a build that would otherwise succeed.
    try {
      // eslint-disable-next-line global-require
      const pendingSecrets = require('./pending-secrets');
      const heldValues = await pendingSecrets.rawValuesForSession(
        stagingPool, session.id, config.dataEncryptionKey
      );
      for (const [k, v] of Object.entries(heldValues)) {
        if (!Object.prototype.hasOwnProperty.call(stagingStored, k)) stagingStored[k] = v;
      }
      if (Object.keys(heldValues).length) {
        log.info('staging', 'Injected pending declared secrets into staging env', {
          sessionId: session.id, keys: Object.keys(heldValues),
        });
      }
    } catch (err) {
      log.warn('staging', 'Pending declared-secret lookup failed', {
        sessionId: session.id, err: err.message,
      });
    }
    const stagingMerge = appSecrets.mergeForDeploy(
      stagingManifest, stagingStored, appSecrets.platformDefaultsFromEnv(),
      { forStaging: true }
    );
    if (stagingMerge.missingRequired.length) {
      await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
      throw new MissingSecretsError(stagingMerge.missingRequired);
    }
    if (stagingMerge.missingPrivateStagingDefault.length) {
      await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
      throw new PrivateSecretMissingStagingDefaultError(
        stagingMerge.missingPrivateStagingDefault
      );
    }

    const { stdout: revisionOut } = await docker.execFileAsync('git', [
      '-C', cloneDir, 'rev-parse', 'HEAD',
    ], { timeout: 5000 });
    const resolvedRevision = (revisionOut || '').trim();
    const prodDbName = dbManager.appDbName(app.slug);
    const stagingDbNameStr = attempt.dbName;
    // Retries may address the database of a still-serving preview. Only
    // overlap a clone when its target is confirmed absent; otherwise keep
    // the old image-before-clone ordering. A failed lookup is not absence.
    let parallelPreparation = false;
    try {
      parallelPreparation = !await dbManager.databaseExists(stagingDbNameStr, { strict: true });
    } catch (err) {
      log.warn('staging', 'Database lookup failed; preparing preview sequentially', { sessionId: session.id, err: err.message });
    }
    const imageBuildStartedAt = Date.now();
    timings.sourceFetchMs = imageBuildStartedAt - buildStartedAt;
    reportBuildStep(config, session, 'image_build', timings, imageBuildStartedAt);
    const imageProgress = makeImageProgressReporter(config, session, timings, imageBuildStartedAt);
    let imageFinished = false;
    let cloneFinished = false;
    let cloneStartedAt;
    const buildImage = async () => {
      let result;
      try {
        result = await applicationRuntime.build(config, {
          app, revision: resolvedRevision, environment: 'staging', sessionId: session.id,
          sourceDir: cloneDir, dockerImage: imageName, onProgress: imageProgress.report,
        });
        return result;
      } finally {
        imageProgress.close();
        imageFinished = true;
        timings.imageBuildMs = Date.now() - imageBuildStartedAt;
        const reportedPhases = result && Array.isArray(result.phases) && result.phases.length ? result.phases : null;
        const countedSteps = reportedPhases ? null : imageProgress.slowestSteps();
        if (reportedPhases) timings.imagePhases = reportedPhases;
        else if (countedSteps && countedSteps.length) timings.imagePhases = countedSteps;
        if (cloneStartedAt && !cloneFinished) reportBuildStep(config, session, 'clone', timings, cloneStartedAt);
      }
    };
    const cloneDatabase = async () => {
      await attempt.checkpoint({ step: 'clone', db: stagingDbNameStr });
      cloneStartedAt = Date.now();
      if (imageFinished) reportBuildStep(config, session, 'clone', timings, cloneStartedAt);
      try {
        // Each clone retains its own role/password and template redaction.
        const cloned = await dbManager.cloneDatabase(prodDbName, stagingDbNameStr, { viaTemplate: true });
        timings.cloneVia = cloned.via || 'direct';
        if (cloned.templateRefreshed) timings.templateRefreshed = true;
        if (cloned.templateStale) timings.templateRefreshQueued = true;
        return cloned;
      } finally {
        cloneFinished = true;
        timings.cloneMs = Date.now() - cloneStartedAt;
      }
    };
    let build, cloned;
    try {
      if (parallelPreparation) {
        // Settle both before cleanup or releasing the per-session guard:
        // neither a late clone nor a build using cloneDir may outlive us.
        const [imageResult, cloneResult] = await Promise.allSettled([buildImage(), cloneDatabase()]);
        const failed = [imageResult, cloneResult].find(result => result.status === 'rejected');
        // An attempt's database is the preview machine's to retire: a claim
        // that lost its lease shares it with the retry now using it.
        if (failed) throw failed.reason;
        build = imageResult.value;
        cloned = cloneResult.value;
      } else {
        build = await buildImage();
        cloned = await cloneDatabase();
      }
    } finally {
      await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
    }
    // The clone says which server it was made on (the preview server when
    // STAGING_DB_ADMIN_URL names one). The container keeps this URL for its
    // whole life, so it goes on reaching that server whatever the setting
    // says later.
    const stagingDbUrl = dbManager.connectionUrl(stagingDbNameStr, cloned.password, { server: cloned.server });

    // 4. Still this machine's attempt? The replacement of what serves is the
    // deploy's, after its fence (an older attempt never removes a newer
    // one's container).
    await attempt.checkpoint({ step: 'deploy', db: stagingDbNameStr });

    // 5. Run staging container
    //
    // Forward display-only locators so a fork running self-hosted under its
    // own domain / GitHub org sees correct URLs in its self-app staging
    // preview (otherwise the staging UI falls back to the canonical
    // Usernode-Labs defaults baked into services/caddy.js + config.js).
    //
    // Explicitly NOT forwarded:
    //   - DOCKER_NETWORK: only consumed by docker.js / worker.js when
    //     spawning containers, which staging cannot do anyway (no Docker
    //     socket mount, Phase 2g). Forwarding adds nothing.
    //   - DB_ADMIN_URL: staging gets only its dedicated DATABASE_URL and
    //     never the platform's database-admin connection. No legitimate
    //     staging consumer needs cross-database administrative access.
    //     See SELF-HOSTING.md Phase 5 risks.
    //
    // The platform-owned half of the env (identity trio, PORT, USERNODE_ENV,
    // the inherited locators) now comes from services/staging-env.js, which
    // ALSO fingerprints it into the `usernode.env.fp` label below. Assembling
    // it there rather than inline is what guarantees the label describes the
    // env that was actually injected: a future var added to platformStagingEnv
    // moves the fingerprint automatically, so previews built before it are
    // detected as stale with no change to the sweeper (#851).
    const platformEnv = stagingEnv.platformStagingEnv(app, config);
    // A platform preview's way to have projects made in it
    // (services/preview-projects.js): its address for production and its own
    // credential. Nothing for any other app, or with the switch off. The
    // credential is new on every deploy, so it stays out of the fingerprint
    // above, beside the database URL.
    const previewProjectsEnv = await require('./preview-projects').previewEnv(config, {
      app, sessionId: session.id, commitHash,
    });

    const healthStartedAt = Date.now();
    reportBuildStep(config, session, 'health', timings, healthStartedAt);
    const deployed = await applicationRuntime.deploy(config, {
      app,
      environment: 'staging',
      sessionId: session.id,
      imageRef: build.imageRef,
      dockerName: containerName,
      env: {
        DATABASE_URL: stagingDbUrl,
        ...platformEnv,
        ...stagingMerge.env,
        ...previewProjectsEnv,
      },
      port: 3000,
      // #816: state the preview's resourcing rather than inheriting the
      // production-app defaults by omission. See docker.STAGING_CPUS for
      // why a preview needs more than half a core.
      memory: docker.STAGING_MEMORY,
      cpus: docker.STAGING_CPUS,
      labels: {
        [stagingEnv.LABEL_ENV_FP]: stagingEnv.envFingerprint(platformEnv),
        ...require('./platform-preview-data-policy').runtimeLabels(cloned),
        // Which database this runtime was given, and on which server: what
        // the heal pass checks when a preview database server can be wiped
        // or drained. Empty, so nothing is added, without such a server.
        ...(dbManager.previewDatabaseLabels?.(stagingDbNameStr, cloned.server) || {}),
      },
      attempt: attempt.n, servingAttempt: attempt.servingN ?? null, claim: attempt.claim || 0,
    });
    timings.healthMs = Date.now() - healthStartedAt;
    const { hostname, url: stagingUrl } = deployed;

    // NOTE: the edge verification intentionally does NOT happen here. The
    // machine records the receipt (its `published` write) when this returns,
    // and that is the point at which the URL becomes referenceable at all;
    // the prepare handler verifies the edge right after.

    timings.totalMs = Date.now() - buildStartedAt;
    // The container is up, but the checks are not yet running: the caller
    // still verifies the edge, persists the URL and announces the preview,
    // and captureForSession may then park this run behind an earlier one on
    // the same proposal. That hand-off used to be invisible — the bar read
    // 4/4 under a title still saying "Preparing…" — so it is the fifth step,
    // 'prepare_checks', opened here and closed by captureForSession when the
    // phase flips to testing (see visuals.finishPrepareChecks).
    const deployedAt = Date.now();
    timings.deployedAt = deployedAt;
    reportBuildStep(config, session, 'prepare_checks', timings, deployedAt);
    // The node says which data centre served the checks; a preview far from
    // its database fails them on data that arrives late.
    log.info('staging', 'Staging deployed', {
      sessionId: session.id, url: stagingUrl, ...(deployed.node ? { node: deployed.node } : {}), ...timings,
    });

    // `timings` is threaded out so the checks tracer can attribute the wait
    // to a phase (visuals.captureForSession opens the kind='checks' run and
    // records these as its build-half steps). Purely diagnostic — no caller
    // branches on it, and it is absent on paths that reuse a live preview.
    return {
      containerId: deployed.runtimeKind === 'docker' ? deployed.runtimeName : null,
      runtimeKind: deployed.runtimeKind,
      runtimeName: deployed.runtimeName,
      imageRef: build.imageRef,
      buildRef: build.buildRef,
      // The commit this preview is of; the recheck path compares it to the
      // head before trusting the preview.
      commitSha: resolvedRevision || null,
      stagingUrl,
      hostname,
      timings,
    };
  } catch (err) {
    log.error('staging', 'Staging build failed', { sessionId: session.id, err: err.message });
    // Cleanup on failure — short grace, this container is being discarded.
    // Best-effort (the build already failed; nothing downstream forgets this
    // container, and the by-name sweeper is the backstop) but logged rather
    // than swallowed, same reasoning as step 4 above (#851).
    // Kubernetes deploys reconcile deterministic resource names on retry;
    // Docker needs an explicit by-name cleanup after a partial start. An
    // attempt removes only the container it started, by its id: one that
    // failed before its deploy step started nothing (the container by that
    // name still serves), and by name a superseded attempt failing late
    // would remove its successor.
    const failedContainer = err.servingRemoved && err.containerId;
    if (applicationRuntime.mode(config) === 'docker' && failedContainer) {
      const cleaned = await docker.stopAndRemove(failedContainer, {
        stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC,
      }).catch((e) => ({ removed: false, error: e.message })) || {};
      if (cleaned.removed === false) {
        log.warn('staging', 'Failed-build cleanup left a container behind', {
          sessionId: session.id, container: failedContainer, err: cleaned.error || null,
        });
      }
    }
    throw err;
  }
}

// Make ONE real end-to-end request to a freshly-deployed staging host,
// before its preview button is revealed (#816).
//
// This used to be `warmStagingCert`, a handshake-only probe sized for the
// on-demand-TLS era. That era is gone: every preview is served by the single
// pre-existing wildcard cert (see Caddyfile + services/caddy.js), so there is
// no certificate to warm and the handshake alone proves almost nothing.
//
// What DOES still cost the first visitor is everything past the handshake:
// Caddy resolving the upstream container name, the forward_auth gate round
// trip, and the app's own lazy first-request work. `handshakeOnly: false`
// makes the PLATFORM pay that once, at reveal time, instead of the reviewer
// paying it on the click — and it is the only signal that proves the edge can
// actually route to the new container rather than merely terminate TLS.
//
// Ordering contract: call this only AFTER the session's staging_url has been
// persisted to chat_sessions. That persist is what makes the hostname a
// referenceable preview; probing before it just measures a URL nothing points
// at yet.
//
// Bounded by probeEdge's internal timeout and always resolves, so a slow or
// failed probe never blocks or fails a deploy. No-op for local-dev http URLs.
async function verifyStagingEdge(session, hostname, stagingUrl) {
  if (!hostname || !stagingUrl || !stagingUrl.startsWith('https://')) return;
  log.info('staging', 'Verifying edge before exposing preview', { sessionId: session.id, hostname });
  const raw = await caddy.probeEdge(hostname, { handshakeOnly: false });
  // A completed request is not necessarily a usable preview. In particular,
  // a 5xx proves that the public hostname reached a broken/default upstream,
  // which is exactly the state Preview must not advertise as ready (#2328).
  // 4xx remains acceptable here: the edge probe intentionally has no iframe
  // identity token, so an app may auth-gate the root while still routing to
  // the correct runtime. The authenticated iframe load follows only after
  // this transport/upstream gate passes.
  const serverError = raw?.code != null && raw.code >= 500;
  const probe = serverError
    ? { ...raw, ok: false, error: raw.error || new Error(`Preview edge returned HTTP ${raw.code}`) }
    : raw;
  if (probe?.ok) {
    log.info('staging', 'Edge verified', {
      sessionId: session.id, hostname, code: probe.code,
      ttfbMs: probe.timings ? probe.timings.ttfbMs : null,
    });
  } else {
    log.warn('staging', 'Edge verification did not complete; preview is not ready', {
      sessionId: session.id, hostname, code: probe?.code ?? null,
      err: probe?.error?.message,
    });
  }
  return probe;
}

// Deprecated alias (#816). Kept so any caller still on the old name keeps
// working; new code calls verifyStagingEdge. Remove once no references
// remain.

// Tear down a session's preview: the single chokepoint every teardown caller
// (a merge, idle reclaim, the stale-preview sweeper, a bench preview that
// expired) funnels through. The preview machine retires it, by identity (one
// it does not hold yet is adopted from the row first). Only the moves that
// end a proposal retire it for good (`terminal`: a merge, a deleted session;
// a close is the proposal machine's own message): every other retirement is
// an idle reclaim, which the machine refuses while someone works on the
// session or while the proposal is under review. The caller says which; when
// it does not, only a proposal that has ended is (one being merged is not).
//
// Returns { removed: false, handedOff: true } when the machine took it (its
// retirement removes the runtime, then the databases and Secrets, then the
// row's pointers), or { removed: false, leaked: true, busy: true, refused }
// when it refused: the preview is left as it is, and the row still names it.
async function teardownStaging(session, app, { terminal = null, reason = null } = {}) {
  const { rows: [row] } = await getPool().query('SELECT app_id, status FROM chat_sessions WHERE id = $1', [session.id]);
  // Unsaid, only a proposal that has ended (deleted, closed, merged) is
  // retired for good; one being merged is not ended yet.
  const final = terminal == null ? (!row || row.status === 'archived' || row.status === 'merged') : !!terminal;
  const out = await require('./preview-workflow').retire({
    session: { id: session.id, app_id: row?.app_id ?? session.app_id ?? app?.id },
    reason: reason || (final ? (row ? 'closed' : 'deleted') : 'idle'), terminal: final,
  });
  return out.taken ? { removed: false, handedOff: true } : { removed: false, leaked: true, busy: true, refused: out.reason };
}

// Per-app rebuild serialization. Every production deploy is the
// app-delivery machine's (deployProduction), which runs one deploy of an
// app at a time; rollover's respawn of an existing image is the other
// writer of an app's runtime. When two deploys of the SAME app ran close
// together (before app delivery) — e.g. PR #25 and #26 both
// merging within a minute, each kicking off its own rebuild — their
// `stopAndRemove(name)` / `runContainer(name)` calls interleave and the
// second `docker run` 405s with "container name is already in use"
// (exactly the failure that left whiteboard #26 merged-on-GitHub but
// not-marked-merged). The local promise chain orders calls within a Pod;
// the Kubernetes advisory lock below extends this across rollout overlap.
// Each rebuild clones the latest main. Different apps remain parallel.
const _rebuildChains = new Map(); // slug -> Promise (rejection-swallowing tail)

function serializeRebuild(slug, fn) {
  const prev = _rebuildChains.get(slug) || Promise.resolve();
  // Run after the predecessor settles, regardless of whether it
  // succeeded — one app's failed rebuild must not block the next one.
  const result = prev.then(() => fn(), () => fn());
  // The stored tail never rejects, so the next waiter's `.then` always
  // runs and an unhandled rejection is never parked on the chain.
  const tail = result.then(() => {}, () => {});
  _rebuildChains.set(slug, tail);
  // Self-clean the map once we're the last link, so idle apps don't leak
  // entries. Guard the identity check so a newer rebuild isn't dropped.
  tail.finally(() => {
    if (_rebuildChains.get(slug) === tail) _rebuildChains.delete(slug);
  });
  return result; // callers still get the real containerId/sha or the real error
}

// `options.reuseImage` — { imageRef, buildRef, treeSha, fromSha } — offers an
// image that is ALREADY built, to be deployed instead of building a new one.
// It is used only when the tree this rebuild is about to build is the same
// tree that image was built from, which the caller states as `treeSha` and
// this function verifies against the clone it just made. Same source, same
// Dockerfile, same builder: the same image.
//
// What it saves is the build — measured at ~9s of an ~18s merge-to-live on a
// small app, even with the layer cache warm, because a build is a Kubernetes
// Job to schedule, a daemon to start and a push. What it costs is that the
// image's baked GIT_SHA names `fromSha` (the commit whose code it is) rather
// than the commit main now points at, so the caller has to be one for which
// that is true and harmless. Today that is demo mode, and the
// merge-followups machine gates it there (machine.ts reuseOf); a general "deploy the artifact the checks ran against"
// needs that difference resolved rather than tolerated.
//
// Every production deploy, for the app-delivery workflow machine
// (src/workflow/app-delivery/), which owns the "deploying" state
// (apps.deploy_state, with its pushes), writes the result columns and tells
// whoever asked. The machine runs one deploy of an app at a time; the chain
// still orders it against rollover's respawn in this process, which is all
// that orders anything on Docker, where the lock is not taken.
//
// A project's FIRST deploy (its row still `creating`: the app-creation
// machine asked for it, src/workflow/app-creation/) is the same deploy,
// with what creation needs: the steps the made screen follows (build,
// deploy), where its time went (services/app-creation-timing.js, returned
// as `timing`), and no app-health notification (the made screen shows a
// failure). `options.starter` — { sha, template, key } — is the starter
// commit its setup made: a clone of exactly that commit may write the
// starter's shared layer cache, and a ready-made app's image built ahead
// under `key` (services/starter-images.js) is deployed instead of a build.
function deployProduction(config, app, options = {}) {
  const watch = app.status === 'creating' ? require('./app-creation-timing').stopwatch() : null;
  watch?.start('lock');
  return serializeRebuild(app.slug, () => withResourceUse(config, PRODUCTION_BUILD_LOCK, app.slug, () => {
    watch?.end('lock');
    return rebuildProductionInner(config, app, { ...options, watch });
  }));
}

// A project's starter files as the working tree, for an install without
// GitHub (no repository to clone).
function writeStarter(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  for (const f of files) {
    const filePath = path.join(dir, f.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, f.content);
  }
}

// Whether an offered image is of the tree that was just cloned, and so the
// image this rebuild would otherwise spend a build producing. Pure, and the
// whole guarantee: same tree sha means the same source, byte for byte, so the
// same Dockerfile and the same builder produce the same image. Anything
// missing or unequal answers null, which means build.
function reusedBuild(offered, mergedTree) {
  if (!offered || !offered.imageRef || !offered.treeSha) return null;
  if (!mergedTree || mergedTree !== String(offered.treeSha).toLowerCase()) return null;
  return { imageRef: offered.imageRef, buildRef: offered.buildRef || null, reused: true };
}

// The tree the working copy is at, or null when git cannot say — in which
// case no reuse happens, which is the safe direction.
async function treeShaOf(dir) {
  try {
    const { stdout } = await docker.execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD^{tree}'], { timeout: 5000 });
    const sha = (stdout || '').trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (err) {
    log.warn('staging', 'Could not read the merged tree; building rather than reusing', { err: err.message });
    return null;
  }
}

async function rebuildProductionInner(config, app, options = {}) {
  const containerName = `usernode-app-${app.slug}`;
  const imageName = `usernode-app-${app.slug}:latest`;

  // Recovery may arrive after the runtime switched successfully but before
  // apps.main_sha was saved. Read the running revision under the production
  // rebuild lock before doing another external deploy. Ordinary/manual
  // rebuilds never pass this option: they may need to apply changed secrets.
  if (options.reuseRunningRevision) {
    const expected = String(options.reuseRunningRevision).toLowerCase();
    const ref = applicationRuntime.productionRef(config, app);
    try {
      const live = await applicationRuntime.inspect(config, ref);
      if (live.status === 'running'
          && live.labels?.['social.usernode.io/source-revision'] === expected
          && await applicationRuntime.probeHealth(config, ref)) {
        return {
          containerId: ref.runtimeKind === 'docker' ? ref.runtimeName : null,
          runtimeKind: ref.runtimeKind, runtimeName: ref.runtimeName,
          sha: expected, recovered: true,
        };
      }
    } catch (err) {
      log.warn('staging', 'Could not inspect production for merge recovery', {
        app: app.slug, err: err.message,
      });
    }
  }

  log.info('staging', 'Rebuilding production', { app: app.slug });

  // Hoisted out of the try so the catch can stamp the failed commit
  // onto the apps.last_failure record (#416).
  let mainSha = null;

  const watch = options.watch || null;
  const first = app.status === 'creating';
  const phase = (name) => {
    if (!first) return;
    try { require('./ws').pushAppCreationPhase({ id: app.id, slug: app.slug, phase: name }); } catch {}
  };
  try {
    const cloneDir = `/tmp/usernode-rebuild-${app.slug}`;
    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
    watch?.start('checkout');
    if (!app.repo_url) {
      // No repository: GitHub is off on this install (app delivery serves
      // such an app only then), and the project is its starter's files.
      writeStarter(cloneDir, require('./app-creator').starterFiles(app, {
        sketch: await require('./app-sketch').readSketch(getPool(config), app.id)
          .then((r) => (r && r.status === 'ready' ? r : null), () => null),
      }));
    } else {
      const { owner, repo } = repoRef.ownerRepo(app.repo_url) || {};
      if (!owner || !repo) throw new Error('Could not parse repo URL');

      const cloneUrl = await github.getCloneUrl(owner, repo);

      // --recurse-submodules + --shallow-submodules so dapps that vendor
      // upstream sources via submodules (e.g. falling-sands → sandspiel)
      // get a complete tree at build time. No-op for dapps without
      // submodules. Timeout bumped to absorb worst-case submodule fetch.
      try {
        await docker.execFileAsync('git', [
          'clone', '--depth', '1',
          '--recurse-submodules', '--shallow-submodules',
          cloneUrl, cloneDir,
        ], { timeout: 120000 });
      } catch (err) {
        // Stage marker for the last_failure classifier (#416).
        err.cloneFailed = true;
        throw err;
      }

      // Capture the exact SHA this build is pinned to so the UI can show
      // what commit is running in production (#21). The shallow clone's
      // HEAD is the tip of the default branch at clone time.
      try {
        const { stdout } = await docker.execFileAsync('git', [
          '-C', cloneDir, 'rev-parse', 'HEAD',
        ], { timeout: 5000 });
        mainSha = (stdout || '').trim() || null;
      } catch (err) {
        log.warn('staging', 'Failed to capture main SHA', { app: app.slug, err: err.message });
      }
    }
    watch?.end('checkout');
    watch?.start('manifest');

    if (!options.retrySameCommit && mainSha) {
      const { rows: [current] } = await getPool(config).query('SELECT last_failure FROM apps WHERE id = $1', [app.id]);
      if (require('./deploy-failure').waitsForNewCommit(current?.last_failure, mainSha)) {
        await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
        throw new WaitsForNewCommitError(mainSha);
      }
    }

    // Read manifest from the cloned working tree. Snapshot it onto
    // the app row first so the Secrets UI knows about a brand-new
    // required key the moment we observe it (even if the deploy then
    // blocks because that key has no stored value). Then block before
    // docker build if any required secret is unset — no point
    // compiling an image we can't run. The thrown MissingSecretsError
    // carries the list so callers (votes.js merge, drift poller,
    // manual rebuild) can render an actionable error.
    const manifest = appManifest.read(cloneDir);
    const prodPool = getPool(config);
    await prodPool.query(
      `UPDATE apps SET manifest_snapshot = $1 WHERE id = $2`,
      [JSON.stringify(manifest), app.id]
    );

    // dapp.json's top-level `name` takes precedence over the platform
    // name. Reconciling here is what makes a merged rename PR (which
    // edits dapp.json's name and triggers this rebuild) actually apply
    // the new display name — no rename-specific apply code needed.
    // No-op when the manifest carries no name; best-effort so a rename
    // hiccup never fails the rebuild.
    await appManifest.reconcileAppName(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Name reconcile failed', { app: app.slug, err: err.message }));
    // Same deal for the manifest's `visibility` block (issue #124): a
    // merged visibility-change PR applies here, on the rebuild its
    // merge triggered. No-op when the manifest carries no visibility;
    // best-effort so it never fails the rebuild.
    await appManifest.reconcileAppVisibility(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Visibility reconcile failed', { app: app.slug, err: err.message }));
    // And the manifest's `governance` block (issue #646): a merged
    // governance-change PR applies here, on the rebuild its merge
    // triggered. No-op when the block is absent; best-effort.
    await appManifest.reconcileAppGovernance(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Governance reconcile failed', { app: app.slug, err: err.message }));
    // And the manifest's `admins` block (issue #788): a merged PR that
    // edits the per-app admin roster applies here, on the rebuild its
    // merge triggered — which is why such a PR needs explicit approval
    // to get merged in the first place. An ABSENT block is a no-op; an
    // explicit [] clears the roster. Best-effort.
    await appManifest.reconcileAppAdmins(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Admins reconcile failed', { app: app.slug, err: err.message }));
    // And the manifest's `topics` array (#4417), after the name, visibility
    // and governance: a merged topics PR (a new topic, a rename, a merge, an
    // archive) applies here, on the rebuild its merge triggered. An absent
    // block is a no-op. Best-effort.
    await appManifest.reconcileAppTopics(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Topics reconcile failed', { app: app.slug, err: err.message }));
    // And the manifest's `screenshot.deviceScaleFactor` (issue #360): a
    // merged PR that toggles the capture density applies here on the
    // rebuild it triggered. readScreenshot defaults to 2×, so this keeps
    // apps.screenshot_device_scale current on every prod rebuild.
    await appManifest.reconcileAppScreenshot(prodPool, app, manifest)
      .catch((err) => log.warn('staging', 'Screenshot reconcile failed', { app: app.slug, err: err.message }));
    // And the manifest's `icon` block: a merged PR that changes the
    // homescreen icon (emoji or committed image file) applies here, on
    // the rebuild its merge triggered. The manifest is fully
    // authoritative for the icon — an absent block clears it back to
    // the letter tile. Best-effort; needs cloneDir for the image bytes.
    await appManifest.reconcileAppIcon(prodPool, app, manifest, cloneDir)
      .catch((err) => log.warn('staging', 'Icon reconcile failed', { app: app.slug, err: err.message }));
    const stored = await appSecrets.getRawValues(prodPool, app.id, config.dataEncryptionKey);
    const merge = appSecrets.mergeForDeploy(
      manifest, stored, appSecrets.platformDefaultsFromEnv()
    );
    watch?.end('manifest');
    if (merge.missingRequired.length) {
      await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});
      throw new MissingSecretsError(merge.missingRequired);
    }

    // An image built from this exact tree already exists: deploy it. The
    // comparison is the whole guarantee, so it is made HERE, against the tree
    // just cloned, rather than taken from the caller's word about which
    // commits ought to match.
    const offered = options.reuseImage;
    const mergedTree = offered ? await treeShaOf(cloneDir) : null;
    let build = reusedBuild(offered, mergedTree);
    if (offered) {
      log.info('staging', build
        ? 'Deploying an image already built from this tree'
        : 'Offered image is of a different tree; building', {
        app: app.slug, mergedTree, offeredTree: offered.treeSha || null,
        fromSha: offered.fromSha || null, imageRef: offered.imageRef || null,
      });
    }
    // The starter commit a project's setup just made, cloned back exactly:
    // its build may write the starter's shared layer cache, and a ready-made
    // app's image is built already (the same key).
    const starter = options.starter && mainSha && String(options.starter.sha || '').toLowerCase() === String(mainSha).toLowerCase()
      ? options.starter : null;
    phase('build');
    watch?.start('build');
    const buildStartedAt = Date.now();
    let solveStartMs = null;
    if (!build && starter?.key) {
      build = await require('./starter-images').imageFor(config, prodPool, { key: starter.key, slug: app.slug });
    }
    if (!build) {
      build = await applicationRuntime.build(config, {
        app,
        revision: mainSha,
        environment: 'production',
        sourceDir: cloneDir,
        dockerImage: imageName,
        ...(starter ? { starterTree: true } : {}),
        ...(watch ? { onProgress: (image) => {
          if (solveStartMs == null && image?.phase === 'source' && /^building /.test(image.detail || '')) {
            solveStartMs = Date.now() - buildStartedAt;
          }
        } } : {}),
      });
    }
    watch?.end('build');
    watch?.note('build', require('./app-creation-timing').buildNote({
      engine: build.prebuilt ? 'prebuilt' : build.runtimeKind === 'broker' ? 'broker'
        : applicationRuntime.mode(config) === 'docker' ? 'docker' : (build.engine || 'kpack'),
      result: build, solveStartMs,
    }));
    await docker.execFileAsync('rm', ['-rf', cloneDir]).catch(() => {});

    // Reload the app row to pick up apps.db_password — the per-role
    // migration in db/migrate.js may have populated it after the
    // caller fetched `app`, and createApp may have set it on a
    // first-deploy path that arrives here on the next rebuild.
    const { rows: dbPwdRows } = await prodPool.query(
      'SELECT db_password FROM apps WHERE id = $1', [app.id]
    );
    const appDbPassword = dbPwdRows[0]?.db_password;
    if (!appDbPassword) {
      throw new Error(
        `deployProduction: app ${app.slug} has no db_password — ` +
        `migrateAppDbsToPerRole should have populated it at platform boot.`
      );
    }
    const dbUrl = dbManager.connectionUrl(dbManager.appDbName(app.slug), appDbPassword);
    // Production containers get the LLM-proxy env pair (URL + per-app
    // token); the staging path above deliberately does not — staging
    // containers must not be able to spend LLM grants (issue #34).
    const llmEnv = await appLlmEnv.productionLlmEnv(prodPool, app.id);
    // Likewise the app-storage env pair (#752) — production only; the
    // staging path above deliberately injects neither storage var.
    const storageEnv = await appStorageEnv.productionStorageEnv(prodPool, app.id);
    phase('deploy');
    watch?.start('deploy');
    const deployed = await applicationRuntime.deploy(config, {
      app,
      environment: 'production',
      imageRef: build.imageRef,
      dockerName: containerName,
      labels: /^[a-f0-9]{40}$/i.test(mainSha || '')
        ? { 'social.usernode.io/source-revision': mainSha.toLowerCase() } : {},
      env: {
        DATABASE_URL: dbUrl,
        ...appIdentityEnv(app, config),
        PORT: '3000',
        USERNODE_ENV: 'production',
        ...llmEnv,
        ...storageEnv,
        ...merge.env,
      },
      // Applied: from here it is the container starting and answering
      // /health (the 'rollout' stage).
      ...(watch ? { onRollout: () => { watch.end('deploy'); watch.start('rollout'); } } : {}),
    });
    watch?.end('deploy');
    watch?.end('rollout');
    if (deployed.podTimeline) watch?.note('pod', deployed.podTimeline);

    // No Caddy route to register. The wildcard site in the Caddyfile
    // maps `<slug>.<domain>` straight to this container
    // (usernode-app-<slug>) and issues TLS on-demand, so a healthy,
    // correctly-named container is automatically reachable. This closed
    // the old "Secure Connection Failed" class of bug where a rebuild
    // came up healthy but its per-host route block was missing or got
    // clobbered by a concurrent conf rewrite.

    // Clear any stale last_failure (#416): every successful deploy
    // funnels through here, so this is the single reset chokepoint for
    // the rebuild paths (dev-chat merge, drift poller, /redeploy).
    await prodPool.query(
      `UPDATE apps SET last_failure = NULL, container_id = $1, image_ref = $2,
         build_ref = $3, runtime_kind = $4, runtime_name = $5 WHERE id = $6`,
      [deployed.runtimeKind === 'docker' ? deployed.runtimeName : null,
       build.imageRef, build.buildRef, deployed.runtimeKind, deployed.runtimeName, app.id]
    ).catch((e) => log.warn('staging', 'Failed to clear last_failure', { app: app.slug, err: e.message }));

    log.info('staging', 'Production rebuilt', { app: app.slug, sha: mainSha });
    return {
      containerId: deployed.runtimeKind === 'docker' ? deployed.runtimeName : null,
      runtimeKind: deployed.runtimeKind,
      runtimeName: deployed.runtimeName,
      imageRef: build.imageRef,
      buildRef: build.buildRef,
      imageReused: !!build.reused,
      sha: mainSha,
      url: deployed.url || null,
      ...(watch ? { timing: watch.snapshot() } : {}),
    };
  } catch (err) {
    if (err instanceof WaitsForNewCommitError) {
      // The row already says why and which commit; nobody needs telling again.
      log.info('staging', 'Production rebuild skipped: this commit\'s image runs as root', {
        app: app.slug, sha: err.sha,
      });
    } else if (err instanceof MissingSecretsError) {
      log.warn('staging', 'Production rebuild blocked — missing required secrets', {
        app: app.slug, missing: err.missingSecrets,
      });
      // This failure happens before runtime replacement. Persist its exact
      // attempted revision so a merged proposal never reads as delivered
      // while the previous container still serves.
      try {
        await getPool(config).query('UPDATE apps SET last_failure = $1 WHERE id = $2',
          [JSON.stringify(require('./deploy-failure').record(err, { sha: mainSha || null })), app.id]);
      } catch (e) {
        log.warn('staging', 'Failed to persist missing-secret deploy failure', {
          app: app.slug, err: e.message,
        });
      }
    } else {
      log.error('staging', 'Production rebuild failed', { app: app.slug, err: err.message });
      // Persist the failure detail (#416) so the "View build log" panel
      // covers failed rebuilds too. Status deliberately stays 'running'
      // (the old container keeps serving) — see app-deploy-status.js for
      // why rebuild progress never touches apps.status. Best-effort.
      const deployFailure = require('./deploy-failure');
      let failureRecord = null;
      // The record this one replaces, read in the same statement that
      // writes the new one so the comparison below is against what was
      // actually there. Left undefined when the write fails: "unknown" must
      // read as a new incident, not a repeat.
      let previousFailure;
      try {
        failureRecord = deployFailure.record(err, { sha: mainSha || null });
        const { rows } = await getPool(config).query(
          `WITH before AS (SELECT last_failure FROM apps WHERE id = $2)
           UPDATE apps SET last_failure = $1 WHERE id = $2
           RETURNING (SELECT last_failure FROM before) AS previous_failure`,
          [JSON.stringify(failureRecord), app.id]
        );
        previousFailure = rows[0] ? rows[0].previous_failure : null;
      } catch (e) {
        log.warn('staging', 'Failed to persist last_failure', { app: app.slug, err: e.message });
      }

      // #1374: tell the people who can fix it. Before this the failure was
      // recorded on the app row and surfaced only to whoever happened to
      // look, so a production rebuild could stay broken until somebody
      // noticed. Addressed to the creator and the app's admins, gated on
      // the adminOnly `app_health` category.
      //
      // Once per incident, not per attempt. The drift poller retries a
      // failed rebuild every tick, and a failure that is deterministic (a
      // Dockerfile the build sandbox cannot build) fails the same way each
      // time; the notification is about the commit that is broken, which
      // has not changed. The row above still records every attempt, so
      // "View build log" stays current. See deployFailure.sameIncident for
      // what counts as the same incident.
      //
      // Best-effort, and deliberately after the row is persisted: the
      // failure record is the durable part and must not depend on this.
      if (first) {
        // A project's first deploy: its made screen shows the failure, with
        // Retry (the app-creation machine writes it to the row).
      } else if (deployFailure.sameIncident(previousFailure, failureRecord)) {
        log.info('staging', 'Production rebuild failed again for the same commit; already notified', {
          app: app.slug, sha: failureRecord.sha, stage: failureRecord.stage,
        });
      } else {
        try {
          const notifications = require('./notifications');
          const pool = getPool(config);
          const created = await notifications.createAppHealthNotification(pool, {
            appId: app.id,
            // A short token, not the reason: notifications.detail is
            // VARCHAR(32) and the full reason is on apps.last_failure, which
            // the UPDATE above just wrote.
            detail: 'deploy_failed',
          });
          await Promise.all(created.map((row) => notifications.hydrateAndPush(pool, row)));
        } catch (e) {
          log.warn('staging', 'App-health notification failed', { app: app.slug, err: e.message });
        }
      }
    }
    throw err;
  }
}

// One attempt of the preview machine (src/workflow/preview/services.ts):
// no per-process queue, no lifecycle run, no row writes.
// The preview machine's build of attempt n. It holds the shared
// build-retention lock for the whole build, as every build does: the image
// pruner (build-retention.js) takes that lock exclusively before deleting an
// unreferenced Build, so it never removes this one between its build and its
// deploy. The machine serialises a session's attempts itself.
function prepareAttempt(config, session, app, head, attempt) {
  return withBuildUse(config, () => buildAndDeployStagingInner(config, session, app, head, { attempt }));
}

module.exports = {
  _makeImageProgressReporterForTest: makeImageProgressReporter,
  _imageStepLabelForTest: imageStepLabel,
  prepareAttempt,
  previewDisplayState,
  verifyStagingEdge,
  teardownStaging,
  deployProduction,
  // The image-reuse decision and the tree read behind it, unit-tested
  // directly: the decision IS the guarantee, and rebuildProductionInner
  // around it is a clone, a database and a cluster.
  reusedBuild,
  treeShaOf,
  // Exported for services/app-rollover.js: its cheap respawn path
  // (appRespawn.runExistingImage) does its own stopAndRemove +
  // runContainer without going through deployProduction, so it has to
  // take the same per-slug lock or it can interleave with a deploy of the
  // same app — the exact "container name is already in use" race the
  // comment above documents. Do NOT call it from inside a function that
  // deployProduction already wraps: the chain is not re-entrant.
  serializeRebuild,
  MissingSecretsError,
  WaitsForNewCommitError,
  PrivateSecretMissingStagingDefaultError,
};
