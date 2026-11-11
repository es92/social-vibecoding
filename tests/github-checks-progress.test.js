// #6593: how many of GitHub's required checks are done on a change's head.
//
// The Merging card says "GitHub's checks: 7 of 10 done" while GitHub is
// building and scanning the release images, but only when Homeroom could
// read that from GitHub. Every failure answers null and the card draws no
// line, and one answer is kept for a minute per head so many viewers cost
// GitHub one pair of requests.
//
// Run with: node --test tests/github-checks-progress.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const github = require('../src/services/github');
const githubPause = require('../src/services/github-pause');
const progress = require('../src/services/github-checks-progress');

const REPO = 'https://github.com/Usernode-Labs/social-vibecoding';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function reset() {
  progress._resetForTests();
  githubPause._resetForTests();
  github._setOctokitFactoryForTests(null);
  github._setAppForTests(null);
}

function failure(status) {
  return Object.assign(new Error(`GitHub answered ${status}`), { status });
}

// A stubbed octokit: `branch` is the getBranch payload's protection, `runs`
// the check run list. `fail` names a call that throws instead.
function stub({ branch = {}, runs = [], fail = null } = {}) {
  const calls = { branch: 0, runs: 0 };
  github._setAppForTests({});
  github._setOctokitFactoryForTests(() => ({
    rest: {
      repos: {
        getBranch: async (args) => {
          calls.branch += 1;
          calls.branchArgs = args;
          if (fail === 'branch') throw failure(403);
          return { data: { protection: { required_status_checks: branch } } };
        },
      },
      checks: {
        listForRef: async (args) => {
          calls.runs += 1;
          calls.runsArgs = args;
          if (fail === 'runs') throw failure(404);
          return { data: { check_runs: runs } };
        },
      },
    },
  }));
  return calls;
}

test('counts only the required checks, a completed run is done, a missing one is not', async () => {
  reset();
  const calls = stub({
    branch: {
      checks: [
        { context: 'Build and scan worker' },
        { context: 'Security merge gate' },
        { context: 'Build and scan worker' },
      ],
    },
    runs: [
      { name: 'Build and scan worker', status: 'completed' },
      { name: 'Security merge gate', status: 'in_progress' },
      { name: 'A check nobody requires', status: 'completed' },
    ],
  });
  assert.deepEqual(await progress.readProgress({ repoUrl: REPO, headSha: SHA }), { done: 1, total: 2 });
  assert.equal(calls.branchArgs.branch, 'main');
  assert.equal(calls.runsArgs.ref, SHA);
  assert.equal(calls.runsArgs.filter, 'latest');
});

test('a required check with no run yet is not done, and any completed result counts', async () => {
  reset();
  stub({
    branch: { checks: [{ context: 'Audit all three lockfiles' }, { context: 'Security regressions' }] },
    runs: [{ name: 'Security regressions', status: 'completed', conclusion: 'failure' }],
  });
  assert.deepEqual(await progress.readProgress({ repoUrl: REPO, headSha: SHA }), { done: 1, total: 2 },
    'a failure is finished; the card shows the failing state separately');
});

test('branch protection\'s old contexts list works as the required names', async () => {
  reset();
  stub({
    branch: { contexts: ['Audit all three lockfiles', 'Security merge gate'] },
    runs: [
      { name: 'Audit all three lockfiles', status: 'completed' },
      { name: 'Security merge gate', status: 'completed' },
    ],
  });
  assert.deepEqual(await progress.readProgress({ repoUrl: REPO, headSha: SHA }), { done: 2, total: 2 });
});

test('a refusal or a missing branch protection answers null, never a guessed count', async () => {
  reset();
  stub({ fail: 'branch', branch: { checks: [{ context: 'x' }] } });
  assert.equal(await progress.readProgress({ repoUrl: REPO, headSha: SHA }), null, '403 without checks: read');

  reset();
  stub({ fail: 'runs', branch: { checks: [{ context: 'x' }] } });
  assert.equal(await progress.readProgress({ repoUrl: REPO, headSha: SHA }), null, '404');

  reset();
  stub({ branch: {}, runs: [{ name: 'x', status: 'completed' }] });
  assert.equal(await progress.readProgress({ repoUrl: REPO, headSha: SHA }), null, 'no required checks');
});

test('a repository on the git host, a short SHA, or GitHub off answers null without asking', async () => {
  reset();
  const calls = stub({ branch: { checks: [{ context: 'x' }] } });
  assert.equal(await progress.readProgress({
    repoUrl: { host: 'git_host', owner: 'apps', repo: 'shop' }, headSha: SHA,
  }), null);
  assert.equal(await progress.readProgress({ repoUrl: REPO, headSha: 'abc123' }), null);
  assert.equal(await progress.readProgress({ repoUrl: REPO }), null);
  assert.equal(calls.branch + calls.runs, 0);

  reset();
  github._setAppForTests(null);
  assert.equal(await progress.readProgress({ repoUrl: REPO, headSha: SHA }), null, 'GitHub is not enabled');
});

test('one answer is kept for a minute per head, null included', async () => {
  reset();
  const calls = stub({ branch: { checks: [{ context: 'x' }] }, runs: [] });
  assert.deepEqual(await progress.readProgress({ repoUrl: REPO, headSha: SHA }), { done: 0, total: 1 });
  assert.deepEqual(await progress.readProgress({ repoUrl: REPO, headSha: SHA }), { done: 0, total: 1 });
  assert.equal(calls.branch, 1, 'the second read is the cached answer');
  assert.equal(calls.runs, 1);

  // A head that moves is read fresh.
  await progress.readProgress({ repoUrl: REPO, headSha: OTHER_SHA });
  assert.equal(calls.branch, 2);

  // A refusal is kept too, so a page reload does not hammer GitHub.
  reset();
  const refused = stub({ fail: 'branch' });
  assert.equal(await progress.readProgress({ repoUrl: REPO, headSha: SHA }), null);
  assert.equal(await progress.readProgress({ repoUrl: REPO, headSha: SHA }), null);
  assert.equal(refused.branch, 1);
});
