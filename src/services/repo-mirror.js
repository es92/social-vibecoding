'use strict';

// #2038 — a per-app bare git mirror, and the exact answers it makes cheap.
//
// ── Why this exists ────────────────────────────────────────────────────
//
// Most of the merge subsystem's complexity is a workaround for one bad
// oracle. GitHub's REST API cannot answer the questions the merge gate
// actually asks:
//
//   - `mergeable` is computed lazily and returns `null` while it thinks, so
//     services/conflict-resolver.js polls it twice — up to 6 reads over 10s
//     to decide whether a sync is needed, then up to 8 more over 17.5s (plus
//     a 2s settling delay) before it dares call pulls.merge. Three env vars
//     tune that, and a 405 recovery path exists because the window can still
//     be missed.
//   - `mergeable` keeps saying `false` forever for a CLOSED pull request, so
//     the resolver needs a PR-state gate before it can read the field at all.
//   - There is no "which files conflict" endpoint. services/proposal-
//     freshness.js approximates it with the intersection of two `compare`
//     calls and documents the result, honestly, as an upper bound: "two edits
//     to opposite ends of the same file land in here and would merge fine".
//   - Every read costs rate limit, which is why the freshness sweeper is
//     capped at 10 rows a pass with a 5-minute per-row cooldown — and why a
//     proposal nobody is looking at can carry numbers that are hours old.
//
// A bare mirror answers all of it locally, exactly, in milliseconds, with no
// rate limit and no lazily-computed anything. `git merge-tree --write-tree`
// in particular does the real merge and reports both the resulting tree and
// the genuinely conflicted paths — not a superset. It is the tool that
// DIAGNOSED #1442 by hand ("ten conflicting hunks across seven files"); this
// module is that diagnosis run automatically.
//
// ── Why /tmp is the right home ─────────────────────────────────────────
//
// A mirror is a cache with a re-derivable source, exactly like the staging
// and rebuild clones beside it (`/tmp/usernode-staging-*`,
// `/tmp/usernode-rebuild-*`). Losing one on a restart costs a re-clone, not
// correctness, so nothing here needs a persistent volume or a backup story.
// ensureMirror re-creates a missing or corrupt mirror on demand.
//
// ── What this module does NOT do ───────────────────────────────────────
//
// It never writes to a repository and never authenticates. Homeroom app
// repositories are public by contract (services/github.js rejects a private
// import outright), so plain unauthenticated HTTPS is enough to read them —
// the same assumption the build worker already runs on. Nothing here can
// push, merge, or mutate GitHub state.

const path = require('path');
const docker = require('./docker');
const log = require('./logger');

const MIRROR_ROOT = process.env.USERNODE_MIRROR_ROOT || '/tmp';

// Generous but bounded. A first clone of the self-app is the worst case;
// every later fetch is incremental and lands well inside a second.
const CLONE_TIMEOUT_MS = 180000;
const FETCH_TIMEOUT_MS = 60000;
// Plumbing on an existing mirror is local CPU. A second is already an
// eternity; the timeout exists so a wedged process can never hang a caller.
const PLUMB_TIMEOUT_MS = 20000;

const SHA_RE = /^[0-9a-f]{7,40}$/i;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

// Reject anything that could escape the mirror root or reach a shell. These
// come from apps.repo_url, which is user-supplied at import time.
function safeName(value, what) {
  const s = String(value || '');
  if (!NAME_RE.test(s) || s === '.' || s === '..') {
    throw new Error(`Unsafe ${what} for a git mirror: ${JSON.stringify(s)}`);
  }
  return s;
}

function mirrorPath(owner, repo) {
  return path.join(
    MIRROR_ROOT,
    `usernode-mirror-${safeName(owner, 'owner')}-${safeName(repo, 'repo')}.git`
  );
}

// A committish we are willing to hand to git. Callers pass SHAs read out of
// Postgres or GitHub; a ref name would work too, but allowing one would mean
// allowing `--upload-pack=…`, so the surface stays closed.
function safeSha(value, what = 'commit') {
  const s = String(value || '').trim();
  if (!SHA_RE.test(s)) {
    throw new Error(`Not a usable ${what}: ${JSON.stringify(String(value || ''))}`);
  }
  return s.toLowerCase();
}

// Run one git command against a mirror. Returns { stdout, stderr, code } with
// stdout as a Buffer, because merge-tree's conflicted-path list is
// NUL-delimited and a string round-trip drops the separators.
async function git(dir, args, { timeout = PLUMB_TIMEOUT_MS, allowFail = false } = {}) {
  try {
    const { stdout, stderr } = await docker.execFileAsync(
      'git', ['-C', dir, ...args],
      { timeout, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 }
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    // execFile rejects on a non-zero exit, but a non-zero exit is a real
    // ANSWER for some plumbing (merge-tree says "conflicts" with 1,
    // merge-base --is-ancestor says "no" with 1). Those callers pass
    // allowFail and read the code.
    if (allowFail && typeof err.code === 'number') {
      return { stdout: err.stdout || Buffer.alloc(0), stderr: err.stderr || Buffer.alloc(0), code: err.code };
    }
    throw err;
  }
}

function text(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf || '');
}

// ── The mirror itself ──────────────────────────────────────────────────

// One in-flight ensure per repository. Several proposals on the same app are
// measured together, and without this each would start its own fetch of the
// same refs. Process-local, matching the single-flight registries in
// services/conflict-resolver.js and services/proposal-freshness.js.
const _inFlight = new Map();

async function ensureMirrorInner(owner, repo, { refs = [] } = {}) {
  const dir = mirrorPath(owner, repo);
  const url = `https://github.com/${safeName(owner, 'owner')}/${safeName(repo, 'repo')}.git`;

  // `rev-parse --git-dir` is the cheapest honest "is there a usable mirror
  // here?". A half-written directory from a killed clone fails it, which is
  // what sends us down the re-clone path rather than fetching into rubble.
  let usable = false;
  try {
    await git(dir, ['rev-parse', '--git-dir']);
    usable = true;
  } catch { usable = false; }

  if (!usable) {
    await docker.execFileAsync('rm', ['-rf', dir]).catch(() => {});
    await docker.execFileAsync(
      'git', ['clone', '--bare', '--filter=blob:none', url, dir],
      { timeout: CLONE_TIMEOUT_MS }
    );
    log.info('repo-mirror', 'Mirror created', { owner, repo, dir });
  }

  // Always refresh the default branch: "how far behind is main" is the
  // question every caller is really asking, and a stale mirror answers it
  // confidently and wrongly — the exact failure #1442 was about.
  //
  // --filter=blob:none keeps the clone small; git fetches the blobs it
  // actually needs on demand, which for merge-tree is only the files both
  // sides touched.
  const wanted = ['HEAD', ...refs.filter((r) => SHA_RE.test(String(r || '')))];
  await git(dir, ['fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], {
    timeout: FETCH_TIMEOUT_MS,
  });

  // Proposal heads live on branches the mirror already fetched above, but a
  // head can also be a commit on a fork (an imported PR) or one that has just
  // been force-pushed away from every branch tip. Fetch those by SHA; GitHub
  // permits it for a reachable commit, and a failure here is not fatal — the
  // caller finds out when the plumbing says the commit is unknown.
  for (const sha of wanted) {
    if (sha === 'HEAD') continue;
    const have = await git(dir, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true });
    if (have.code === 0) continue;
    await git(dir, ['fetch', '--quiet', 'origin', sha], { timeout: FETCH_TIMEOUT_MS })
      .catch((err) => log.debug('repo-mirror', 'Could not fetch commit by sha', {
        owner, repo, sha, err: err.message,
      }));
  }

  return dir;
}

/**
 * Make sure a current bare mirror of owner/repo exists, and return its path.
 *
 * `refs` names commits the caller is about to ask about (proposal heads), so
 * they are fetched in the same pass rather than one round trip each.
 *
 * Throws if the repository cannot be cloned or fetched. Callers that must
 * degrade rather than fail (the measurement sweep, a read path a voter is
 * waiting on) catch and record the reason — see services/integration.js.
 */
function ensureMirror(owner, repo, options = {}) {
  const key = `${owner}/${repo}`;
  const existing = _inFlight.get(key);
  if (existing) return existing;
  const p = ensureMirrorInner(owner, repo, options)
    .finally(() => { _inFlight.delete(key); });
  _inFlight.set(key, p);
  return p;
}

// ── The five questions ─────────────────────────────────────────────────

/** The commit the repository's default branch points at right now. */
async function defaultBranchSha(dir) {
  // The mirror's own HEAD follows origin's default branch, so this needs no
  // hardcoded 'main' — services/main-drift-poller.js hardcodes it and would
  // be wrong on a repository that renamed its default branch.
  const { stdout } = await git(dir, ['rev-parse', 'HEAD']);
  return text(stdout).trim().toLowerCase() || null;
}

/** How many commits `head` is missing from `base`. Exact, not an estimate. */
async function behindBy(dir, base, head) {
  const { stdout } = await git(dir, [
    'rev-list', '--count', `${safeSha(head)}..${safeSha(base)}`,
  ]);
  const n = parseInt(text(stdout).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** How many commits `head` has that `base` does not. */
async function aheadBy(dir, base, head) {
  const { stdout } = await git(dir, [
    'rev-list', '--count', `${safeSha(base)}..${safeSha(head)}`,
  ]);
  const n = parseInt(text(stdout).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Their common ancestor, or null when they share none. */
async function mergeBase(dir, a, b) {
  const r = await git(dir, ['merge-base', safeSha(a), safeSha(b)], { allowFail: true });
  if (r.code !== 0) return null;
  return text(r.stdout).trim().toLowerCase() || null;
}

/**
 * Is `maybeAncestor` still on `descendant`'s history?
 *
 * This is the honest form of "did main move out from under the base those
 * checks ran against?" — services/proposal-freshness.js spends a whole
 * `compare` call and a status-string interpretation on it.
 */
async function isAncestor(dir, maybeAncestor, descendant) {
  const r = await git(dir, [
    'merge-base', '--is-ancestor', safeSha(maybeAncestor), safeSha(descendant),
  ], { allowFail: true });
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(`git merge-base --is-ancestor failed: ${text(r.stderr).trim()}`);
}

/** The tree a commit points at — the identity of its content. */
async function treeOf(dir, committish) {
  const { stdout } = await git(dir, ['rev-parse', `${safeSha(committish)}^{tree}`]);
  return text(stdout).trim().toLowerCase() || null;
}

// Under `-z --name-only` merge-tree emits three sections:
//
//   <tree OID> NUL  <path> NUL ... NUL  <informational messages>
//
// The conflicted-path list is terminated by an EMPTY field, and that boundary
// is the whole trick: the informational messages that follow are themselves
// NUL-separated and contain the same paths again ("1", "a.txt",
// "Auto-merging", "Auto-merging a.txt"), so a parser that reads to the end of
// the buffer reports each conflict several times over. Stop at the empty
// field. `--name-only` already collapses the three index stages to one entry
// per path, so nothing else has to dedupe.
//
// `buf` is everything AFTER the tree's NUL.
function parseConflictPaths(buf) {
  const out = [];
  for (const field of text(buf).split('\0')) {
    if (field === '') break; // end of the conflicted-file section
    const p = field.trim();
    if (p) out.push(p);
  }
  return out.sort();
}

/**
 * Really merge `ours` with `theirs`, without a worktree, and report what
 * happened.
 *
 * Returns `{ clean, tree, conflicts }`:
 *   clean     — true when git merged it with no human needed.
 *   tree      — the resulting tree OID. Present either way: on a conflict it
 *               is the tree WITH conflict markers, which is not useful to
 *               merge but is a stable identity for "this exact attempt".
 *   conflicts — the genuinely conflicted paths. Not a superset: these are the
 *               files git could not resolve, which is what
 *               proposal-freshness.js's two-compare intersection could only
 *               approximate.
 *
 * The `tree` on a CLEAN merge is the load-bearing value. It is bit-for-bit
 * what an actual `git merge` produces (verified across content edits, renames
 * and mode changes), which is what lets a caller ask the only question that
 * matters for an approval: did anybody write new bytes, or is this exactly
 * what git would have done on its own?
 */
async function mergeTree(dir, ours, theirs) {
  const r = await git(dir, [
    'merge-tree', '--write-tree', '--name-only', '-z',
    safeSha(ours, 'ours commit'), safeSha(theirs, 'theirs commit'),
  ], { allowFail: true });

  // Exit 0 = clean, 1 = conflicts, anything else = git could not run the
  // merge at all (an unknown commit, an unrelated history). The last case is
  // a real error, not a conflict, and must not be reported as one.
  if (r.code !== 0 && r.code !== 1) {
    throw new Error(`git merge-tree failed: ${text(r.stderr).trim() || `exit ${r.code}`}`);
  }

  // Under -z the first NUL-terminated field is the tree OID; the conflicted
  // -file records follow it.
  const buf = r.stdout;
  const firstNul = buf.indexOf(0);
  const tree = (firstNul === -1 ? text(buf) : text(buf.slice(0, firstNul)))
    .trim().toLowerCase() || null;

  return {
    clean: r.code === 0,
    tree,
    conflicts: r.code === 1 && firstNul !== -1
      ? parseConflictPaths(buf.slice(firstNul + 1))
      : [],
  };
}

/** Paths that differ between two commits. Used to scope a resolution. */
async function changedPaths(dir, from, to) {
  const { stdout } = await git(dir, [
    'diff', '--name-only', '-z', safeSha(from), safeSha(to),
  ]);
  return text(stdout).split('\0').map((s) => s.trim()).filter(Boolean).sort();
}

// A branch name we are willing to hand to git. Deliberately stricter than
// git's own rules: no leading dash (which would be read as an option), no
// `..` (which would make a range), no `.lock` suffix, and nothing outside a
// conservative character set. Branch names reach us from chat_sessions rows
// that the platform wrote, but the validator is the cheap place to be sure.
const REF_RE = /^(?!-)(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9._\/-]{1,255}$/;

function safeRef(value) {
  const s = String(value || '').trim();
  if (!REF_RE.test(s)) {
    throw new Error(`Not a usable branch name: ${JSON.stringify(String(value || ''))}`);
  }
  return s;
}

/**
 * The commit a branch points at, or null when the mirror has no such branch.
 *
 * This is what makes the mirror a live view rather than a cache of one: the
 * fetch in ensureMirror pulls every branch, so ONE network round trip per app
 * answers "where is each open proposal's head right now?" for every proposal
 * on it. The old path spent a `getPR` per proposal, which is why the freshness
 * sweeper had to cap itself at ten rows a pass — and why a proposal nobody had
 * opened could carry a head that had moved hours ago.
 */
async function resolveBranch(dir, branchName) {
  const r = await git(dir, [
    'rev-parse', '--verify', '--quiet', `refs/heads/${safeRef(branchName)}^{commit}`,
  ], { allowFail: true });
  if (r.code !== 0) return null;
  return text(r.stdout).trim().toLowerCase() || null;
}

/** Does the mirror know this commit at all? */
async function hasCommit(dir, committish) {
  const r = await git(dir, ['cat-file', '-e', `${safeSha(committish)}^{commit}`], { allowFail: true });
  return r.code === 0;
}

module.exports = {
  ensureMirror,
  mirrorPath,
  defaultBranchSha,
  behindBy,
  aheadBy,
  mergeBase,
  isAncestor,
  treeOf,
  mergeTree,
  changedPaths,
  resolveBranch,
  hasCommit,
  // Exported for the unit tests, which drive the plumbing against a real
  // temporary repository rather than a mock — the whole point of this module
  // is that the answers are git's, so stubbing git would test nothing.
  _git: git,
  _safeSha: safeSha,
  _safeRef: safeRef,
  _parseConflictPaths: parseConflictPaths,
};
