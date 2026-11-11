'use strict';

// #6593 — how many of GitHub's required checks have finished on a change's
// head, while its merge is held on `github_checks`.
//
// Homeroom's own checks test how the change behaves. GitHub's required
// checks (main's branch protection) build and scan the release images
// production will run, and GitHub merges only once they pass. While they are
// still running the Merging card can say "7 of 10 done" instead of only that
// it is waiting. This is a courtesy, never a fact the merge depends on:
// anything that stops Homeroom reading them (no `checks: read`, branch
// protection not returned, a 404, a rate limit, a network error) answers
// null and the card draws no line rather than guessing a number.
//
// One read is kept for a minute per head, so many viewers of one change cost
// GitHub one pair of requests a minute. The key includes the SHA, so a head
// that moves is read fresh.

const github = require('./github');
const githubPause = require('./github-pause');
const repoRef = require('./repo-ref');

const CACHE_TTL_MS = 60 * 1000;
const READ_TIMEOUT_MS = 2000;
const MAX_CHECK_RUNS = 100;
const SHA_RE = /^[0-9a-f]{40}$/i;

// `owner/repo@sha` -> { answer, at }. Null answers are kept too: a GitHub
// that refuses reads once will refuse the next page load as well.
const cache = new Map();

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return { found: false, answer: null };
  if (Date.now() - hit.at >= CACHE_TTL_MS) {
    cache.delete(key);
    return { found: false, answer: null };
  }
  return { found: true, answer: hit.answer };
}

// The required checks' names from branch protection, old and new shapes.
function requiredNames(protection) {
  const spec = protection && typeof protection === 'object' ? protection : {};
  const checks = Array.isArray(spec.checks) ? spec.checks : [];
  const contexts = Array.isArray(spec.contexts) ? spec.contexts : [];
  const names = checks.map((check) => check && check.context).concat(contexts)
    .filter((name) => typeof name === 'string' && name);
  return [...new Set(names)];
}

async function load(owner, repo, sha) {
  const octokit = await github.getReadOctokit(owner);
  const [branch, runs] = await Promise.all([
    octokit.rest.repos.getBranch({ owner, repo, branch: 'main' }),
    octokit.rest.checks.listForRef({ owner, repo, ref: sha, filter: 'latest', per_page: MAX_CHECK_RUNS }),
  ]);
  const required = requiredNames(branch && branch.data && branch.data.protection
    && branch.data.protection.required_status_checks);
  if (!required.length) return null;

  // The latest run of each name. A required check with no run yet (queued
  // but not started, or beyond the page read) is not done.
  const latest = new Map();
  for (const run of (runs && runs.data && Array.isArray(runs.data.check_runs) ? runs.data.check_runs : [])) {
    if (run && typeof run.name === 'string' && !latest.has(run.name)) latest.set(run.name, run);
  }
  let done = 0;
  for (const name of required) {
    const run = latest.get(name);
    if (run && run.status === 'completed') done += 1;
  }
  return { done, total: required.length };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      // A page read must not be held open by a timer once its answer is in.
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
  ]);
}

/**
 * `{ done, total }` of GitHub's required checks on `headSha`, or null.
 *
 * Never throws. `repoUrl` is the app's repository and `headSha` the commit
 * GitHub is checking; a repository on Homeroom's own git host has no GitHub
 * checks and answers null without a request.
 */
async function readProgress({ repoUrl, headSha } = {}) {
  if (!repoUrl || repoRef.isHosted(repoUrl)) return null;
  if (!github.isEnabled() || githubPause.isPaused()) return null;
  const parsed = repoRef.parse(repoUrl);
  if (!parsed || parsed.host !== 'github' || !parsed.owner || !parsed.repo) return null;
  const sha = typeof headSha === 'string' ? headSha.trim().toLowerCase() : '';
  if (!SHA_RE.test(sha)) return null;

  const key = `${parsed.owner}/${parsed.repo}@${sha}`;
  const hit = cached(key);
  if (hit.found) return hit.answer;

  let answer = null;
  try {
    answer = await withTimeout(load(parsed.owner, parsed.repo, sha), READ_TIMEOUT_MS);
  } catch (_) {
    answer = null;
  }
  cache.set(key, { answer, at: Date.now() });
  return answer;
}

function _resetForTests() {
  cache.clear();
}

module.exports = {
  readProgress,
  _resetForTests,
};
