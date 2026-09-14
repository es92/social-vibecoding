'use strict';

// Producing a HEAD in the app's own repository, for the connector.
//
// Why this file exists at all: `submit_work`'s original and only shape was a
// CROSS-FORK pull request — `head: "<forkOwner>:<branch>"` into the
// bot-owned app repo. That call has failed on every attempt ever made in
// production (three runs, 2026-08-07, all `platform_error`), while every
// same-repo `createPR` in the codebase succeeded the same afternoon. Rather
// than keep guessing at GitHub's reason, the connector now has two ways to
// put the commits somewhere the same-repo shape works:
//
//   * MIRROR — fetch the branch out of the user's public fork and push it,
//     unchanged, into the app's own repo (`mirrorForkBranch` below);
//   * PATCH  — apply a `git format-patch` / `git diff` the agent produced at
//     the recorded base commit and commit it there (services/
//     external-agent-patch.js, which reuses everything in here).
//
// Both end in a PLAIN same-repo pull request, which is the shape the rest of
// the platform has always used.
//
// TWO PROPERTIES THIS FILE IS RESPONSIBLE FOR.
//
// 1. The write credential is resolved PAT-FIRST — `GITHUB_BOT_TOKEN`, then
//    an App installation token, matching services/github.js getOctokit. This
//    is not cosmetic: services/conflict-resolver.js records that the
//    installation path THROWS for `Usernode-Labs` (the self-app's owner has
//    no installation), and `getInstallationToken` has no other caller in the
//    tree. An installation-first helper would break on the platform's own
//    app and nowhere else, which is the worst possible place to find out.
//
// 2. PROVENANCE IS VERIFIED BEFORE ANYTHING IS COPIED. The attribution gate
//    in external-agent-tasks compares a pull request's head-repo owner to
//    the caller's linked GitHub login; a mirrored head is owned by the BOT,
//    so that comparison would pass vacuously. The gate is therefore not
//    skipped but RELOCATED into `verifyForkBranch` here: the source repo's
//    owner must equal the linked login, and the fetched commit must be a
//    descendant of the base commit the platform itself recorded. A caller
//    who names someone else's fork gets `fork_mismatch`, exactly as before.
//
// Nothing here takes a user credential. The fetch from the user's fork is
// unauthenticated (app forks are public); the only secret in the file is the
// platform's own bot token, and it appears only inside a remote URL passed
// to git as an argv element, never logged.

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const log = require('./logger');
const githubService = require('./github');

const execFileAsync = promisify(execFile);

// The same ceiling services/staging.js puts on its own shallow clone. A
// depth-1 fetch of one branch is far cheaper than that, so this is a
// backstop against a hung remote rather than a real budget.
const GIT_TIMEOUT_MS = 120000;

// Branch namespaces written into the APP's repository. Deliberately distinct
// from `dev/…` (native sessions) and `dev/cli-…` (CLI handoff) so a
// connector-produced head can never be mistaken for, or collide with, a
// branch some other part of the platform owns.
const MIRROR_BRANCH_PREFIX = 'usernode/from-';
const PATCH_BRANCH_PREFIX = 'usernode/patch-';

function nonce() {
  return crypto.randomBytes(4).toString('hex');
}

// Is `name` inside the namespace above — the one this file owns?
//
// services/proposal-update.js asks the same question of a session's stored
// branch (`platformOwnedBranch`), and asks it about a name it READ. This asks
// it about a name it is about to WRITE: the only branches a mirror may create
// in an app's repository are ones nothing else on the platform could have
// meant.
function isMirrorNamespace(name) {
  const branch = String(name == null ? '' : name).trim();
  return branch.startsWith(MIRROR_BRANCH_PREFIX) || branch.startsWith(PATCH_BRANCH_PREFIX);
}

// The app-repo branch name for work SHARED to the in-progress area (#1347).
//
// Minted from the Homeroom user id, not from a login or a username: 194 of
// 303 production usernames are email addresses (see services/branch-names.js
// on what that cost the dev-session path), and `@`/`+` are outside `REF_RE`
// here. An integer is always a valid ref segment.
//
// It sits in the same namespace as the mirror rung's own names, which is what
// makes the branch recognisably the platform's rather than the caller's — and
// `usernode/from-` is exactly what `platformOwnedBranch` looks for when it has
// to decide, later and from the row alone, where a session's head lives.
function shareBranchName(userId) {
  return `${MIRROR_BRANCH_PREFIX}u${Number(userId) || 0}-s${nonce()}`;
}

function sameLogin(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

// A GitHub owner/repo segment, conservatively. Everything that reaches this
// helper is either a platform-recorded value or a caller-supplied fork name,
// and both end up inside a URL handed to git — so the shape is checked here
// rather than trusted.
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;

function validSegment(value) {
  return typeof value === 'string' && SEGMENT_RE.test(value) && !value.includes('..');
}

// A git ref the connector will accept from a caller. Conservative on
// purpose: this string becomes a `git fetch` argument and a `head` in a
// GitHub API call.
const REF_RE = /^[A-Za-z0-9._/-]{1,200}$/;

function validRef(value) {
  if (typeof value !== 'string' || !REF_RE.test(value)) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  if (value.includes('..') || value.includes('@{') || value.includes('//')) return false;
  if (value.startsWith('-')) return false;
  return true;
}

// ── The write credential ───────────────────────────────────────────────
//
// PAT-first, matching services/github.js getOctokit. Returns
// { token, source } so the caller can log WHICH credential ran without ever
// touching the value; `source` is the same vocabulary listActionsSecrets
// reports ('pat' | 'installation').
async function resolveWriteCredential(owner) {
  const pat = process.env.GITHUB_BOT_TOKEN;
  if (pat) return { token: pat, source: 'pat' };
  const token = await githubService.getInstallationToken(owner);
  if (!token) throw new Error('no GitHub write credential is configured');
  return { token, source: 'installation' };
}

function authenticatedRemote(token, owner, repo) {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

// Where the mirror READS from: the user's fork, over plain public HTTPS with
// no credential at all. App forks are public (services/github.js createRepo
// sets `private: false`), and reaching into a user's account with the bot's
// token is precisely what this whole design removed. Named as a function so
// the "reads are unauthenticated" property is one line to check.
function sourceCloneUrl(forkOwner, forkRepo) {
  return `https://github.com/${forkOwner}/${forkRepo}.git`;
}

// ── The scratch directory ──────────────────────────────────────────────
//
// Every git operation in this file runs in a throwaway directory that is
// removed in a `finally`, on the success path and on every failure path.
// The token lives only in a remote URL passed as an argv element inside it;
// nothing is ever written to a git config that outlives the call.
async function withScratchRepo(label, fn) {
  const dir = path.join(os.tmpdir(), `usernode-head-${label}-${nonce()}`);
  await fs.mkdir(dir, { recursive: true });
  const git = (args, opts = {}) => execFileAsync('git', ['-C', dir, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/true',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: dir,
    },
  });
  try {
    await git(['init', '--quiet']);
    await git(['config', 'user.name', 'usernode-bot']);
    await git(['config', 'user.email', 'usernode-bot@users.noreply.github.com']);
    return await fn({ dir, git });
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Provenance ─────────────────────────────────────────────────────────
//
// The relocated attribution gate. Called BEFORE any copy, and the reason a
// mirrored/patched head — whose GitHub owner is the bot — is allowed to skip
// the pull-request-level check afterwards.
//
// `githubPublic` is injected rather than imported so the property test in
// tests/external-agent-tasks.test.js ("every direct GitHub call is a public
// read") keeps describing one file, and so this module holds no fetch of
// its own.
async function verifyForkBranch({
  githubPublic, forkOwner, forkRepo, branch, expectedLogin,
}) {
  if (!validSegment(forkOwner) || !validSegment(forkRepo)) {
    return { ok: false, code: 'invalid_request', message: 'That fork name is not a valid GitHub repository name.' };
  }
  if (!validRef(branch)) {
    return { ok: false, code: 'invalid_request', message: 'That branch name is not a valid git ref.' };
  }
  // The owner gate. Never compared against anything the caller passed in —
  // only against the login THIS user verified through the GitHub link.
  if (!sameLogin(forkOwner, expectedLogin)) {
    return {
      ok: false,
      code: 'fork_mismatch',
      message: `That branch is in ${forkOwner}'s repository, not in a repository owned by your linked GitHub `
        + `account (${expectedLogin}). Homeroom only submits work from your own GitHub account under your name.`,
    };
  }

  const repoRead = await githubPublic('GET', `/repos/${forkOwner}/${forkRepo}`);
  if (repoRead.status === 404) {
    return {
      ok: false,
      code: 'branch_not_found',
      message: `GitHub has no repository ${forkOwner}/${forkRepo}.`,
      retryable: true,
    };
  }
  if (!repoRead.ok || !repoRead.body) {
    return {
      ok: false,
      code: 'platform_unavailable',
      message: 'Homeroom could not read that repository on GitHub just now. Try again shortly.',
      retryable: true,
    };
  }
  // GitHub's own answer for who owns it, not the caller's claim.
  const actualOwner = (repoRead.body.owner && repoRead.body.owner.login) || '';
  if (!sameLogin(actualOwner, expectedLogin)) {
    return {
      ok: false,
      code: 'fork_mismatch',
      message: `${forkOwner}/${forkRepo} is owned by ${actualOwner || 'somebody else'}, not by your linked `
        + 'GitHub account. Homeroom only submits work from your own GitHub account under your name.',
    };
  }

  const branchRead = await githubPublic(
    'GET',
    `/repos/${forkOwner}/${forkRepo}/branches/${encodeURIComponent(branch)}`
  );
  if (branchRead.status === 404) {
    return {
      ok: false,
      code: 'branch_not_found',
      message: `GitHub has no branch ${branch} in ${forkOwner}/${forkRepo}. Push it, then submit again.`,
      retryable: true,
    };
  }
  const headSha = branchRead.body && branchRead.body.commit && branchRead.body.commit.sha;
  if (!branchRead.ok || !headSha) {
    return {
      ok: false,
      code: 'platform_unavailable',
      message: 'Homeroom could not read that branch on GitHub just now. Try again shortly.',
      retryable: true,
    };
  }
  return { ok: true, headSha: String(headSha).toLowerCase(), ownerLogin: actualOwner };
}

// ── The mirror ─────────────────────────────────────────────────────────
//
// Copy a verified branch out of the user's fork into the app's own repo,
// byte for byte — same commits, same authorship, same tree. Returns the
// branch name it wrote plus a `cleanup()` the caller MUST call if the
// subsequent createPR or pr-import fails, so a failed submission does not
// leave a stray branch on somebody's app.
async function mirrorForkBranch({
  gh, githubPublic, owner, repo, forkOwner, forkRepo, branch, expectedLogin,
  baseSha, taskId, targetBranch,
}) {
  // `targetBranch` names a branch the CALLER already recorded — #1347's share
  // path, where the session row is written before the commits land and has to
  // carry the name the landing will use. Without it the name is minted below,
  // which is what the pr-import rung has always done.
  //
  // Either way the name must be one of ours: this pushes into the APP's
  // repository with the platform's own credential, so a caller-supplied name
  // is checked against the namespace rather than trusted. Checked FIRST, like
  // every other argument on this path: an argument that can never be accepted
  // is not worth a read of somebody's fork.
  if (targetBranch !== undefined && targetBranch !== null) {
    if (!validRef(targetBranch) || !isMirrorNamespace(targetBranch)) {
      return {
        ok: false,
        code: 'invalid_request',
        message: 'A mirrored branch has to be named in Homeroom\'s own branch namespace.',
        retryable: false,
      };
    }
  }

  const verified = await verifyForkBranch({
    githubPublic, forkOwner, forkRepo, branch, expectedLogin,
  });
  if (!verified.ok) return verified;

  // The recorded base commit is the platform's own value, so "is this
  // actually built on the work we handed out?" is answerable and worth
  // answering: a mirror writes into the APP's repository with the
  // platform's credentials, which is a stronger action than opening a
  // cross-fork PR and deserves the stricter check.
  if (baseSha) {
    try {
      const cmp = await gh.compareCommitAncestry(owner, repo, baseSha, verified.headSha);
      if (cmp && cmp.status !== 'ahead' && cmp.status !== 'identical') {
        return {
          ok: false,
          code: 'base_mismatch',
          message: `${branch} is not built on the commit this piece of work was reserved at (${baseSha}). `
            + 'Rebase it onto that commit and push again, or open the pull request yourself.',
          retryable: false,
        };
      }
    } catch (err) {
      // A comparison the platform cannot make is not a licence to copy:
      // this check is the reason the head is trusted at all.
      log.warn('external-agent-head', 'ancestry check failed', {
        owner, repo, err: err && err.message,
      });
      return {
        ok: false,
        code: 'platform_unavailable',
        message: 'Homeroom could not verify that branch against the recorded base commit. Try again shortly.',
        retryable: true,
      };
    }
  }

  const mirrorBranch = targetBranch || `${MIRROR_BRANCH_PREFIX}${forkOwner}-t${taskId || 0}-${nonce()}`;
  let credential;
  try {
    credential = await resolveWriteCredential(owner);
  } catch (err) {
    log.error('external-agent-head', 'no write credential for mirror', { owner, err: err && err.message });
    return {
      ok: false,
      code: 'platform_unavailable',
      message: 'Homeroom cannot write to the app repository right now. Try again shortly.',
      retryable: true,
    };
  }

  try {
    await withScratchRepo(`mirror-${taskId || 0}`, async ({ git }) => {
      // UNAUTHENTICATED: the fork is public, and reaching into a user's
      // account with the bot's credential is exactly what this design does
      // not do.
      await git(['fetch', '--depth', '1', '--no-tags',
        sourceCloneUrl(forkOwner, forkRepo), branch]);
      await git(['push', authenticatedRemote(credential.token, owner, repo),
        `FETCH_HEAD:refs/heads/${mirrorBranch}`]);
    });
  } catch (err) {
    log.error('external-agent-head', 'mirror push failed', {
      owner, repo, forkOwner, credential: credential.source,
      err: redactToken(err && err.message, credential.token),
    });
    return {
      ok: false,
      code: 'platform_unavailable',
      message: 'Homeroom could not copy that branch into the app repository. Try again shortly.',
      retryable: true,
    };
  }

  log.info('external-agent-head', 'mirrored fork branch into app repo', {
    owner, repo, forkOwner, mirrorBranch, credential: credential.source,
  });
  return {
    ok: true,
    branch: mirrorBranch,
    headSha: verified.headSha,
    credential: credential.source,
    cleanup: () => deleteBranch({ owner, repo, branch: mirrorBranch, token: credential.token }),
  };
}

// ── The update push ────────────────────────────────────────────────────
//
// #1056. The mirror above writes a NEW branch, for work that has no proposal
// yet. This one advances an EXISTING proposal's branch: the bot-owned
// `dev/…` ref in the app's repository that a live pull request already points
// at. Same three properties as the mirror — the attribution gate runs first,
// the read from the fork is unauthenticated, the only credential is the
// platform's own — plus one this needs and the mirror does not:
//
//   A LEASE. `--force-with-lease=refs/heads/<target>:<expectedRemoteSha>`
//   makes the push conditional on the branch still pointing where the caller
//   was told it points. Without it, two agents updating the same proposal
//   minutes apart would silently discard one of the two, and the votes
//   cleared for the losing revision would never come back. A failed lease is
//   `branch_moved` — a refusal the caller can act on, not a lost commit.
//
// The fetch is DEEPER than the mirror's `--depth 1`: a lease-checked push
// must be able to name the objects between the old tip and the new one, and a
// single-commit fetch cannot. 50 commits covers every real update; a fork
// that has diverged further falls back to a full fetch rather than failing.
const UPDATE_FETCH_DEPTH = 50;

async function pushForkBranchToAppBranch({
  githubPublic, owner, repo, forkOwner, forkRepo, branch, expectedLogin,
  targetBranch, expectedRemoteSha, sessionId,
}) {
  // THE ATTRIBUTION GATE, unchanged and unrelaxed. This path writes into the
  // app's own repository with the platform's credentials on behalf of a
  // proposal that is already up for a vote, so if anything it matters more
  // here than on the mirror path.
  const verified = await verifyForkBranch({
    githubPublic, forkOwner, forkRepo, branch, expectedLogin,
  });
  if (!verified.ok) return verified;

  if (!validRef(targetBranch)) {
    return { ok: false, code: 'invalid_request', message: 'That proposal branch name is not a valid git ref.' };
  }
  // The lease is the whole point: refusing to push without one would be a
  // blind overwrite of a branch under review.
  if (typeof expectedRemoteSha !== 'string' || !/^[0-9a-f]{40}$/i.test(expectedRemoteSha)) {
    return {
      ok: false,
      code: 'platform_unavailable',
      message: 'Homeroom does not know which commit this proposal is currently at, so it will not move its branch. Try again shortly.',
      retryable: true,
    };
  }
  const lease = `refs/heads/${targetBranch}:${expectedRemoteSha.toLowerCase()}`;

  let credential;
  try {
    credential = await resolveWriteCredential(owner);
  } catch (err) {
    log.error('external-agent-head', 'no write credential for update push', { owner, err: err && err.message });
    return {
      ok: false,
      code: 'platform_unavailable',
      message: 'Homeroom cannot write to the app repository right now. Try again shortly.',
      retryable: true,
    };
  }

  try {
    await withScratchRepo(`update-${sessionId || 0}`, async ({ git }) => {
      // UNAUTHENTICATED, exactly as the mirror reads: the fork is public and
      // Homeroom holds no credential for the user's GitHub account.
      const forkUrl = sourceCloneUrl(forkOwner, forkRepo);
      try {
        await git(['fetch', '--depth', String(UPDATE_FETCH_DEPTH), '--no-tags', forkUrl, branch]);
      } catch (err) {
        // A fork whose branch is more than UPDATE_FETCH_DEPTH commits from
        // its root cannot be fetched shallowly at that depth in every case
        // (an unrelated-history fork, a squashed rewrite). Pay for the full
        // fetch rather than refuse finished work.
        log.warn('external-agent-head', 'shallow fetch failed — retrying unshallowed', {
          forkOwner, err: redactToken(err && err.message, credential.token),
        });
        await git(['fetch', '--no-tags', forkUrl, branch]);
      }
      await git(['push', `--force-with-lease=${lease}`,
        authenticatedRemote(credential.token, owner, repo),
        `FETCH_HEAD:refs/heads/${targetBranch}`]);
    });
  } catch (err) {
    // Redacted twice on purpose, once for the classification below and once at
    // the log call itself: git puts the whole remote URL — token included — in
    // its error text, and a redaction that is applied at the log line is one a
    // reader (and tests/external-agent-tasks.js's scrape) can see is there.
    const raw = err && (err.stderr || err.message);
    const text = redactToken(raw, credential.token);
    // "stale info" is git's own words for a lease that no longer holds.
    // `non-fast-forward` / `fetch first` mean the same thing from the other
    // direction, and both are the branch having moved rather than a fault.
    if (/stale info|non-fast-forward|fetch first|rejected/i.test(text)) {
      log.info('external-agent-head', 'update push refused — the proposal branch moved', {
        owner, repo, targetBranch, sessionId: sessionId || null,
      });
      return {
        ok: false,
        code: 'branch_moved',
        message: `${targetBranch} is no longer at the commit this update was built against. Somebody else advanced `
          + 'this proposal in the meantime. Re-read the proposal, rebase your branch onto its current head and '
          + 'submit again.',
        retryable: false,
      };
    }
    log.error('external-agent-head', 'update push failed', {
      owner,
      repo,
      forkOwner,
      targetBranch,
      credential: credential.source,
      err: redactToken(raw, credential.token),
    });
    return {
      ok: false,
      code: 'platform_unavailable',
      message: 'Homeroom could not push that branch onto the proposal. Try again shortly.',
      retryable: true,
    };
  }

  log.info('external-agent-head', 'advanced a proposal branch from a fork branch', {
    owner, repo, forkOwner, targetBranch, sessionId: sessionId || null,
    credential: credential.source,
  });
  // No `cleanup()`: unlike the mirror this wrote no new ref, and rolling the
  // branch back to `expectedRemoteSha` on a later failure would throw away
  // the commits it just accepted.
  return { ok: true, headSha: verified.headSha, credential: credential.source };
}

// Best-effort removal of a branch this module wrote. Never throws: it runs
// on a path that is already failing, and a leftover branch is a smaller
// problem than a masked error.
async function deleteBranch({ owner, repo, branch, token }) {
  try {
    await withScratchRepo('cleanup', async ({ git }) => {
      await git(['push', authenticatedRemote(token, owner, repo), '--delete', branch]);
    });
    log.info('external-agent-head', 'removed branch after a failed submission', { owner, repo, branch });
  } catch (err) {
    log.warn('external-agent-head', 'could not remove branch after a failed submission', {
      owner, repo, branch, err: redactToken(err && err.message, token),
    });
  }
}

// git puts the whole remote URL in its error text, and the URL carries the
// bot token. Nothing from a git failure reaches a log without going through
// this first.
function redactToken(message, token) {
  const text = String(message || '');
  if (!token) return text.slice(0, 500);
  return text.split(token).join('***').slice(0, 500);
}

module.exports = {
  GIT_TIMEOUT_MS,
  MIRROR_BRANCH_PREFIX,
  PATCH_BRANCH_PREFIX,
  UPDATE_FETCH_DEPTH,
  nonce,
  isMirrorNamespace,
  shareBranchName,
  sameLogin,
  validSegment,
  validRef,
  resolveWriteCredential,
  authenticatedRemote,
  sourceCloneUrl,
  withScratchRepo,
  verifyForkBranch,
  mirrorForkBranch,
  pushForkBranchToAppBranch,
  deleteBranch,
  redactToken,
};
