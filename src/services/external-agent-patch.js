'use strict';

// The patch path — a head for an agent that could not push.
//
// The normal connector flow is: the user's coding agent pushes a branch to
// their own fork, and Homeroom opens the pull request. Two of the three real
// production runs never got past the push, because the agent's sandbox
// refused every GitHub write. The remedy for THAT is documented in the work
// order (install the Claude GitHub App on the user's own account), but a
// remedy the agent has to ask a human to perform is a dead end inside one
// session. So there is a second way in: the agent exports the change as a
// patch and submits the patch, and Homeroom applies it in the app's own
// repository at the exact commit the work order named.
//
// The result is indistinguishable downstream — a plain same-repo pull
// request, imported through the same `pr-import` route, with the same
// staging preview, the same checks, the same vote and the same
// "built with Claude Code" credit under the submitting user's name.
//
// WHAT MAKES THIS SAFE TO DO WITH THE PLATFORM'S OWN CREDENTIALS. The commit
// is written by the bot into a repository the bot owns, from content a
// caller supplied — a stronger action than opening a cross-fork pull
// request, so it is bounded harder:
//
//   * the caller's caps (promoted sessions, proposals/day) are checked by
//     the caller BEFORE this runs, so a refused submit leaves no branch;
//   * the patch is size-bounded before a single git command runs, and what
//     it adds, inflated, is bounded again before anything is pushed;
//   * `.github/**` is refused outright — the work order forbids CI edits,
//     and this is the one path where such an edit would be committed with
//     platform credentials rather than a contributor's;
//   * every file path is enumerated with `git apply --numstat` first, and
//     `--unsafe-paths` is never passed, so nothing escapes the work tree;
//   * the base commit is the platform's own recorded value, never input.
//
// The tmpdir, the PAT-first credential and the cleanup all come from
// services/external-agent-head.js, shared with the mirror path.

const log = require('./logger');
const head = require('./external-agent-head');

// The MCP transport caps a JSON-RPC body at 512 KB (routes/mcp-remote.js),
// so a quarter of that leaves comfortable envelope headroom while still
// carrying anything a scoped change produces — the real patch from the
// production runs this was written for was 13.9 KB.
const MAX_PATCH_BYTES = 256 * 1024;

// Matching services/proposal-commit-upload.js, the other route by which
// caller-supplied content becomes a bot-authored commit.
const MAX_PATCH_FILES = 200;
const MAX_PATCH_GROWTH_BYTES = 8 * 1024 * 1024;

// `git format-patch --stdout` writes an mbox whose every message begins with
// this line. Anything else is treated as a plain `git diff`.
const MBOX_RE = /^From [0-9a-f]{40}(?: |\t)/;

function isMbox(patch) {
  return MBOX_RE.test(String(patch || '').split('\n')[0] || '');
}

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

// Paths this path will never write. The work order tells the agent not to
// touch CI, and unlike the branch path — where the commit is the
// contributor's own and lands in THEIR fork first — a patch is committed by
// the bot directly into the app's repository.
function forbiddenPath(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  if (normalized.startsWith('.github/')) return true;
  if (normalized === '.github') return true;
  if (normalized.startsWith('/') || normalized.split('/').includes('..')) return true;
  return false;
}

// `git apply --numstat` prints "<added>\t<deleted>\t<path>" per file, with
// `-` for a binary file's counts and an optional `{old => new}` rename form.
function parseNumstat(stdout) {
  const files = [];
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const target = parts.slice(2).join('\t').trim();
    if (!target) continue;
    // A rename prints "a/{old => new}/c"; both sides matter for the
    // forbidden-path check, so expand rather than pick one.
    const rename = /\{(.*?) => (.*?)\}/.exec(target);
    if (rename) {
      files.push(target.replace(rename[0], rename[1]));
      files.push(target.replace(rename[0], rename[2]));
    } else {
      files.push(target);
    }
  }
  return files;
}

// What the applied patch ADDS to the repository (#3198): the size of every
// blob the new commits reach that the base commit does not.
//
// `rev-list --objects HEAD ^base` walks exactly those, through every commit
// `git am` wrote rather than only the last, so a file added in one commit and
// deleted in the next still counts: both commits are pushed. Sizes are
// UNCOMPRESSED, like the changed-file total services/proposal-commit-upload.js
// caps. A binary patch carries its content deflated, so a few KB of patch
// text can inflate to a file of any size, and an on-disk measure (a pack or a
// loose object) would see only the few KB. Only blobs count: the trees and
// commits around them are bookkeeping, bounded by the file-count and
// patch-size limits, and a tree's size is its directory's listing rather than
// anything the patch wrote.
//
// This replaced `count-objects`'s `size-pack`, which measured the whole
// scratch repository. That is mostly the base commit fetched to apply
// against, and none of the patch, whose objects `git am` and `git add` write
// loose. It asked whether the APP was over the limit, and the platform's own
// repository always is.
async function patchGrowthBytes(git, baseSha) {
  const { stdout: listed } = await git(['rev-list', '--objects', 'HEAD', `^${baseSha}`]);
  const ids = String(listed || '').split('\n').map((line) => line.split(' ')[0]).filter(Boolean);
  if (!ids.length) return 0;
  // `git` is the promisified execFile, whose promise carries the child.
  const sizing = git(['cat-file', '--batch-check=%(objecttype) %(objectsize)']);
  // A cat-file that exits early rejects `sizing` itself; without a listener
  // the EPIPE on its stdin would throw out of the process instead.
  sizing.child.stdin.on('error', () => {});
  sizing.child.stdin.end(`${ids.join('\n')}\n`);
  const { stdout: sizes } = await sizing;
  let total = 0;
  for (const line of String(sizes || '').split('\n')) {
    const [type, size] = line.split(' ');
    if (type === 'blob') total += Number(size) || 0;
  }
  return total;
}

// Apply a caller-supplied patch at the recorded base commit and push the
// result to the app's own repository as a fresh branch.
//
// Returns { ok: true, branch, headSha, credential, cleanup } — `cleanup()`
// removes the pushed branch and MUST be called if the caller's subsequent
// createPR or pr-import fails.
async function applyPatch({
  owner, repo, patch, baseSha, userId, taskId,
}) {
  const text = String(patch || '');
  if (!text.trim()) {
    return fail('invalid_request', 'The patch is empty. Send the output of `git format-patch <baseSha>..HEAD --stdout`.');
  }

  // Size FIRST, before anything is parsed or any process is spawned.
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_PATCH_BYTES) {
    return fail(
      'patch_too_large',
      `That patch is ${Math.round(bytes / 1024)} KB, over the ${Math.round(MAX_PATCH_BYTES / 1024)} KB a patch can `
      + 'be. Push the branch to your fork instead and submit it with `branch` — there is no size limit on that route.',
      { retryable: false }
    );
  }
  if (!baseSha || !/^[0-9a-f]{40}$/i.test(String(baseSha))) {
    return fail('invalid_request', 'This piece of work has no recorded base commit to apply a patch at.');
  }

  let credential;
  try {
    credential = await head.resolveWriteCredential(owner);
  } catch (err) {
    log.error('external-agent-patch', 'no write credential for patch', { owner, err: err && err.message });
    return fail('platform_unavailable', 'Homeroom cannot write to the app repository right now. Try again shortly.', { retryable: true });
  }

  const branch = `${head.PATCH_BRANCH_PREFIX}u${userId || 0}-t${taskId || 0}-${head.nonce()}`;
  let pushed = false;
  let headSha = null;

  try {
    await head.withScratchRepo(`patch-${taskId || 0}`, async ({ dir, git }) => {
      const remote = head.authenticatedRemote(credential.token, owner, repo);
      // A shallow fetch of the base commit is enough: the full tree and
      // every blob AT that commit are present, which is what `git apply
      // --3way` needs to reconstruct context from the index lines. Pushing
      // from a shallow clone works because the boundary commit exists on
      // the remote already.
      await git(['fetch', '--depth', '1', '--no-tags', remote, String(baseSha)]);
      await git(['checkout', '--detach', 'FETCH_HEAD']);

      const fs = require('fs/promises');
      const path = require('path');
      const patchFile = path.join(dir, '.usernode-submission.patch');
      await fs.writeFile(patchFile, text, 'utf8');

      // ── Enumerate before applying ──────────────────────────────────
      let numstat;
      try {
        ({ stdout: numstat } = await git(['apply', '--numstat', '--', patchFile]));
      } catch (err) {
        const e = new Error('patch_did_not_apply');
        e.reason = head.redactToken(err && (err.stderr || err.message), credential.token);
        throw e;
      }
      const files = parseNumstat(numstat);
      if (!files.length) {
        const e = new Error('patch_did_not_apply');
        e.reason = 'the patch changes no files';
        throw e;
      }
      if (files.length > MAX_PATCH_FILES) {
        const e = new Error('patch_too_many_files');
        e.count = files.length;
        throw e;
      }
      const blocked = files.find(forbiddenPath);
      if (blocked) {
        const e = new Error('patch_forbidden_path');
        e.file = blocked;
        throw e;
      }

      // ── Apply ──────────────────────────────────────────────────────
      //
      // `--3way` reconstructs from the blob SHAs in the patch's index
      // lines rather than from line offsets, so whitespace damage in
      // transit through a chat product does not defeat it. Never
      // `--unsafe-paths`: every write stays inside the work tree.
      try {
        if (isMbox(text)) {
          await git(['am', '--3way', '--keep-non-patch', '--committer-date-is-author-date', patchFile]);
        } else {
          await git(['apply', '--3way', '--whitespace=nowarn', '--', patchFile]);
          await git(['add', '-A', '--', ':!.usernode-submission.patch']);
          await git(['commit', '--quiet', '-m',
            `Apply patch submitted through the Homeroom connector\n\nBase: ${baseSha}`]);
        }
      } catch (err) {
        // `git am` leaves the repo mid-rebase on failure; the tmpdir is
        // removed wholesale in withScratchRepo's finally, so there is
        // nothing to unwind.
        const e = new Error('patch_did_not_apply');
        e.reason = head.redactToken(err && (err.stderr || err.message), credential.token);
        throw e;
      }

      // The scratch file must never reach the commit.
      await fs.rm(patchFile, { force: true }).catch(() => {});

      const { stdout: growth } = await git(['diff', '--numstat', `${baseSha}`, 'HEAD']);
      const grown = String(growth || '').split('\n').filter(Boolean).length;
      if (grown > MAX_PATCH_FILES) {
        const e = new Error('patch_too_many_files');
        e.count = grown;
        throw e;
      }
      if (await patchGrowthBytes(git, baseSha) > MAX_PATCH_GROWTH_BYTES) {
        const e = new Error('patch_too_large');
        throw e;
      }

      const { stdout: sha } = await git(['rev-parse', 'HEAD']);
      headSha = String(sha).trim().toLowerCase();
      if (headSha === String(baseSha).toLowerCase()) {
        const e = new Error('patch_did_not_apply');
        e.reason = 'the patch produced no commit';
        throw e;
      }

      await git(['push', remote, `HEAD:refs/heads/${branch}`]);
      pushed = true;
    });
  } catch (err) {
    const kind = err && err.message;
    if (kind === 'patch_forbidden_path') {
      return fail(
        'patch_rejected',
        `That patch changes ${err.file}. Homeroom applies patches with the platform's own GitHub credentials, so `
        + 'it will not commit changes under `.github/` — CI workflow files are out of scope for a proposal.',
        { retryable: false }
      );
    }
    if (kind === 'patch_too_many_files') {
      return fail(
        'patch_rejected',
        `That patch changes ${err.count} files, over the ${MAX_PATCH_FILES}-file limit. Push the branch to your `
        + 'fork instead and submit it with `branch`.',
        { retryable: false }
      );
    }
    if (kind === 'patch_too_large') {
      return fail(
        'patch_too_large',
        'That patch adds more than 8 MB to the repository. Push the branch to your fork instead and submit it '
        + 'with `branch`.',
        { retryable: false }
      );
    }
    if (kind === 'patch_did_not_apply') {
      return fail(
        'patch_did_not_apply',
        `That patch does not apply cleanly at ${baseSha}, the commit this piece of work was reserved at. Rebase `
        + `onto ${baseSha} and export the patch again, or push the branch to your fork and submit it with `
        + '`branch`.',
        { retryable: false, detail: (err && err.reason) || null }
      );
    }
    log.error('external-agent-patch', 'patch pipeline failed', {
      owner, repo, taskId, credential: credential.source,
      err: head.redactToken(err && err.message, credential.token),
    });
    if (pushed) {
      await head.deleteBranch({ owner, repo, branch, token: credential.token });
    }
    return fail('platform_unavailable', 'Homeroom could not apply that patch just now. Try again shortly.', { retryable: true });
  }

  log.info('external-agent-patch', 'patch applied and pushed', {
    owner, repo, branch, taskId, credential: credential.source,
  });
  return {
    ok: true,
    branch,
    headSha,
    credential: credential.source,
    cleanup: () => head.deleteBranch({ owner, repo, branch, token: credential.token }),
  };
}

module.exports = {
  MAX_PATCH_BYTES,
  MAX_PATCH_FILES,
  MAX_PATCH_GROWTH_BYTES,
  isMbox,
  forbiddenPath,
  parseNumstat,
  applyPatch,
};
