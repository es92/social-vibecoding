// Updating a proposal that is already up for a vote (#1054).
//
// This is the one path on the platform where a user's work is pushed onto a
// BRANCH THEY DO NOT OWN, with the platform's own bot credential, over a head
// the group has already been voting on. Three properties make that safe, and
// they are what these tests are weighted towards:
//
//   1. NO USER GITHUB CREDENTIAL. The fork is read unauthenticated and the app
//      repository is written with the platform's credential, resolved by
//      services/external-agent-head.js. Nothing here holds a user token.
//   2. THE ATTRIBUTION GATE IS NEVER RELAXED. `verifyForkBranch` runs against a
//      FRESHLY READ `githubLink.linkStatus`, and there is no path from a
//      caller's arguments to a push that skips it — the source is asserted for
//      that, not just the behaviour, because a future edit that reorders the
//      calls would still pass a behavioural test that only checks the happy
//      path.
//   3. NOTHING IS CLOBBERED. The push's lease is pinned to the head this call
//      read from GitHub moments earlier, so a proposal somebody else advanced
//      produces `branch_moved` instead of a discarded revision. And a branch
//      that does not build on the reviewed head is refused with
//      `base_mismatch` rather than dropping reviewed commits.
//
// Run with: node --test tests/proposal-update.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const svc = require('../src/services/proposal-update');

const SRC = fs.readFileSync(
  path.join(__dirname, '../src/services/proposal-update.js'), 'utf8'
);

// The same file with its `//` comments stripped. Several assertions below are
// about what the code does NOT do, and this file's header comment names those
// things in order to say it does not do them — asserting against the prose
// would fail on the very comment that documents the rule.
const CODE = SRC.replace(/^\s*\/\/.*$/gm, '');

// ── Fakes ──────────────────────────────────────────────────────────────

// A pool that dispatches on a substring of the SQL, so a test says what it
// expects to be asked rather than in which order.
function fakePool(handlers, queries = []) {
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [needle, rows] of handlers) {
        if (sql.includes(needle)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      throw new Error(`unstubbed query: ${String(sql).slice(0, 90)}`);
    },
  };
}

const NATIVE_HEAD = 'a'.repeat(40);
const FORK_HEAD = 'b'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);

function nativeSession(over) {
  return Object.assign({
    id: 501,
    user_id: 7,
    app_id: 3,
    status: 'promoted',
    source: 'native',
    branch_name: 'dev/evan-1786376366569',
    pr_number: 42,
    pr_url: 'https://github.com/o/r/pull/42',
    app_slug: 'recipe-box',
    repo_url: 'https://github.com/o/r',
    reviewed_head_sha: NATIVE_HEAD,
  }, over);
}

function importedSession(over) {
  return Object.assign({
    id: 601,
    user_id: 7,
    app_id: 3,
    status: 'promoted',
    source: 'imported',
    branch_name: 'usernode/add-a-button',
    pr_number: 91,
    pr_url: 'https://github.com/o/r/pull/91',
    app_slug: 'recipe-box',
    repo_url: 'https://github.com/o/r',
    imported_pr_head_sha: NATIVE_HEAD,
  }, over);
}

const USER = { id: 7, username: 'evan' };

// Every dependency the service takes, stubbed at its happy value. A test
// overrides only the one it is about, so an assertion about `base_mismatch`
// cannot accidentally also be asserting how the fork is read.
function deps(over = {}, log = {}) {
  const session = over.session || nativeSession();
  const pool = over.pool || fakePool([
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['FROM pr_votes', [{ n: 4 }]],
  ]);
  return {
    pool,
    config: {},
    gh: Object.assign({
      isEnabled: () => true,
      parseGithubUrl: () => ({ owner: 'o', repo: 'r' }),
      getBranchSha: async () => NATIVE_HEAD,
      compareCommitAncestry: async () => ({ status: 'ahead' }),
      getPR: async () => ({
        state: 'open',
        merged: false,
        html_url: 'https://github.com/o/r/pull/91',
        head: { ref: 'usernode/add-a-button', sha: FORK_HEAD, repo: { owner: { login: 'evan-gh' } } },
      }),
    }, over.gh),
    githubLink: Object.assign({
      isEnabled: () => true,
      linkStatus: async () => ({ linked: true, login: 'evan-gh' }),
    }, over.githubLink),
    head: Object.assign({
      validRef: (v) => typeof v === 'string' && v.length > 0 && !v.includes(' '),
      validSegment: (v) => /^[A-Za-z0-9._-]+$/.test(v),
      sameLogin: (a, b) => String(a).toLowerCase() === String(b).toLowerCase(),
      verifyForkBranch: async (args) => {
        (log.verify = log.verify || []).push(args);
        return { ok: true, headSha: FORK_HEAD, forkRepo: args.forkRepo };
      },
      pushForkBranchToAppBranch: async (args) => {
        (log.push = log.push || []).push(args);
        return { ok: true, headSha: FORK_HEAD, credential: { source: 'bot' } };
      },
      // The lease-less create. Real one is external-agent-head.mirrorForkBranch,
      // which the pr-import rung has always used and which the first landing
      // of a shared session now reaches too.
      mirrorForkBranch: async (args) => {
        (log.mirror = log.mirror || []).push(args);
        return { ok: true, branch: args.targetBranch, headSha: FORK_HEAD, credential: 'pat' };
      },
    }, over.head),
    votes: Object.assign({
      reconcileNativeReviewedHead: async (args) => {
        (log.reconcile = log.reconcile || []).push(args);
        return { updated: true };
      },
    }, over.votes),
    prImportSync: Object.assign({
      applyHeadChange: async (args) => {
        (log.applied = log.applied || []).push(args);
        return { ok: true };
      },
      // The sweep's own per-proposal step, which the app-repo path calls for
      // an imported row instead of the native reconcile (#1196).
      syncImportedProposal: async (args) => {
        (log.synced = log.synced || []).push(args);
        return 'updated';
      },
    }, over.prImportSync),
    githubPublic: over.githubPublic || { marker: 'public-reader' },
    // Both of these are real behaviours elsewhere; here they only have to be
    // observable, so a test can assert the update ran INSIDE them.
    serialize: over.serialize || (async (id, fn) => {
      (log.serialized = log.serialized || []).push(id);
      return fn();
    }),
    busy: over.busy || (() => false),
    // #1199: the same-commit resubmit path's re-run. Only that path uses it,
    // and the real one rebuilds a container.
    recovery: over.recovery,
    beginOperation: over.beginOperation || ((id) => {
      (log.began = log.began || []).push(id);
      return () => { (log.released = log.released || []).push(id); };
    }),
  };
}

function run(over = {}, params = {}, log = {}) {
  const session = over.session || nativeSession();
  return svc.updateProposalFromForkBranch(deps(over, log), Object.assign({
    user: USER,
    session,
    branch: 'fix/failing-check',
    origin: 'https://usernode.test',
  }, params));
}

// ── 1. Branch home ─────────────────────────────────────────────────────

test('branch home is where the head IS, and only a head in the caller\'s own fork is theirs to push', () => {
  assert.equal(svc.branchHomeOf(importedSession()), 'user_fork');
  assert.equal(svc.authorCanPush(importedSession()), true);
  // Every non-imported source is a branch only the platform bot can write —
  // which is the whole reason this service exists.
  for (const source of ['native', 'headless', 'cli', 'platform', null, undefined, '']) {
    const session = nativeSession({ source });
    assert.equal(svc.branchHomeOf(session), 'app_repo', `source ${String(source)}`);
    assert.equal(svc.authorCanPush(session), false, `source ${String(source)}`);
  }
  // The home itself is still never stored — a second column recording it is a
  // second thing that can be wrong. What IS stored is the fact underneath it:
  // which repository GitHub said the pull request's head branch was in.
  assert.doesNotMatch(SRC, /branch_home/, 'branch home stays derived, never persisted');
});

// #1196. A connector submission whose cross-fork pull request GitHub refuses
// is MIRRORED: the agent's verified fork branch is copied into a
// `usernode/from-…` branch in the APP repository and a same-repo pull request
// is opened from the bot, then imported. The row says `source='imported'` and
// its head is a branch its author cannot push to. Reading the source alone
// called that a fork, which is what sent get_proposal's advice — and this
// service's own dispatch — to the wrong path.
test('an imported head that is really in the app repository is app_repo, not a fork', () => {
  const mirrored = importedSession({
    branch_name: 'usernode/from-es92-t3-8510c5ac',
    imported_pr_head_repo: 'o/r',
  });
  assert.equal(svc.branchHomeOf(mirrored), 'app_repo');
  assert.equal(svc.authorCanPush(mirrored, 'es92'), false, 'not even for the agent whose fork it was copied from');

  // Same repository, written the way GitHub and the app URL each happen to
  // write it. A case difference is not a different repository.
  assert.equal(svc.branchHomeOf(importedSession({
    repo_url: 'https://github.com/O/R.git', imported_pr_head_repo: 'o/r',
  })), 'app_repo');
});

test('an imported head in a fork stays user_fork, and answers the gate\'s own question', () => {
  const fork = importedSession({
    branch_name: 'add-a-button',
    imported_pr_head_repo: 'es92/r',
  });
  assert.equal(svc.branchHomeOf(fork), 'user_fork');
  // The exact comparison advanceForkHead makes: the head repository's owner
  // against the login linked to the account asking.
  assert.equal(svc.authorCanPush(fork, 'es92'), true);
  assert.equal(svc.authorCanPush(fork, 'ES92'), true, 'GitHub logins are compared case-insensitively');
  assert.equal(svc.authorCanPush(fork, 'someone-else'), false,
    'a proposal following another user\'s fork is not the caller\'s to push');
  // Nothing to compare against is not evidence of a refusal: an unlinked
  // caller still gets the answer this returned before the head repo was
  // recorded, and the gate itself does the refusing.
  assert.equal(svc.authorCanPush(fork, null), true);
  assert.equal(svc.headRepoOwnerOf(fork), 'es92');
  assert.equal(svc.headRepoOwnerOf(importedSession()), null, 'unknown, not guessed');
});

test('a row imported before the head repo was recorded falls back to the branch namespace', () => {
  // `usernode/from-` and `usernode/patch-` are the platform's own prefixes for
  // branches it writes into an app repository, so a legacy row carrying one is
  // the mirrored case above.
  for (const branch of ['usernode/from-es92-t3-8510c5ac', 'usernode/patch-t9-1a2b3c4d']) {
    const legacy = importedSession({ branch_name: branch, imported_pr_head_repo: null });
    assert.equal(svc.branchHomeOf(legacy), 'app_repo', branch);
    assert.equal(svc.authorCanPush(legacy, 'es92'), false, branch);
  }
  // And everything else is read as the fork it almost always is — including
  // `dev/…`, which no imported row carries and which people name fork branches
  // all the time.
  for (const branch of ['dev/my-fix', 'add-a-button', 'usernode-ideas', '']) {
    const legacy = importedSession({ branch_name: branch, imported_pr_head_repo: null });
    assert.equal(svc.branchHomeOf(legacy), 'user_fork', branch);
  }
  // An app that has lost its repository URL cannot be compared against either.
  assert.equal(svc.branchHomeOf(importedSession({
    repo_url: null, imported_pr_head_repo: 'o/r', branch_name: 'usernode/from-es92-t3-8510c5ac',
  })), 'app_repo');
});

// ── 2. Ownership and status ────────────────────────────────────────────

test('somebody else\'s proposal is refused before GitHub is touched', async () => {
  const log = {};
  const result = await run({ session: nativeSession({ user_id: 99 }) }, {}, log);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_your_proposal');
  assert.equal(result.retryable, false);
  assert.equal(log.verify, undefined, 'no fork read');
  assert.equal(log.push, undefined, 'and certainly no push');
});

test('a proposal that is no longer up for a vote cannot take a revision', async () => {
  for (const [status, fragment] of [
    ['merging', /already passed its vote/],
    ['merged', /already passed its vote/],
    ['closed', /cannot take a new revision/],
    ['building', /cannot take a new revision/],
  ]) {
    const log = {};
    const result = await run({ session: nativeSession({ status }) }, {}, log);
    assert.equal(result.ok, false, status);
    assert.equal(result.code, 'proposal_closed', status);
    assert.match(result.message, fragment, status);
    assert.equal(log.push, undefined, `${status} never reaches a push`);
  }
});

test('the ownership gate is applied a SECOND time under the lock, against the re-read row', async () => {
  // The caller's copy was loaded before the queue. This one merged while the
  // update waited — the interesting case, because the first gate passed.
  const log = {};
  const pool = fakePool([
    ['FROM chat_sessions cs JOIN apps a', [nativeSession({ status: 'merged' })]],
    ['FROM pr_votes', [{ n: 4 }]],
  ]);
  const result = await run({ pool }, {}, log);
  assert.equal(result.code, 'proposal_closed');
  assert.equal(log.push, undefined, 'nothing is pushed onto a proposal that merged while we queued');
  assert.deepEqual(log.serialized, [501], 'and it did get that far — the refusal is the re-read one');
});

// ── 3. The bot-owned branch: the happy path ────────────────────────────

test('an app-repo proposal is advanced with a lease pinned to the head just read', async () => {
  const log = {};
  const result = await run({}, {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.branchHome, 'app_repo');
  assert.equal(result.branch, 'dev/evan-1786376366569');
  assert.equal(result.headSha, FORK_HEAD);
  assert.equal(result.previousHeadSha, NATIVE_HEAD);
  assert.equal(result.submittedVia, 'update_branch');
  assert.equal(result.votesCleared, 4, 'counted BEFORE the write, reported after it settled');
  assert.equal(result.checksRerun, true);
  assert.equal(result.previewRebuilding, true);

  // The push: the target is the proposal's own branch and the lease is the
  // live head, never anything the caller supplied.
  assert.equal(log.push.length, 1);
  const pushed = log.push[0];
  assert.equal(pushed.targetBranch, 'dev/evan-1786376366569');
  assert.equal(pushed.expectedRemoteSha, NATIVE_HEAD);
  assert.equal(pushed.owner, 'o');
  assert.equal(pushed.repo, 'r');
  assert.equal(pushed.branch, 'fix/failing-check');
  assert.equal(pushed.sessionId, 501);

  // And the existing machinery — not a reimplementation of it — moved the
  // votes, with a fresh read rather than the stored pin.
  assert.equal(log.reconcile.length, 1);
  assert.equal(log.reconcile[0].fresh, true);
  assert.equal(log.reconcile[0].notify, true);
  assert.equal(log.reconcile[0].session.id, 501);
});

test('the update runs inside the session queue, the lock and a session operation', async () => {
  const log = {};
  await run({}, {}, log);
  assert.deepEqual(log.serialized, [501], 'serialized on the session, as the handoff pipeline is');
  assert.deepEqual(log.began, [501]);
  assert.deepEqual(log.released, [501], 'and released — a leaked operation marks the session busy forever');
});

test('the session operation is released even when the push fails', async () => {
  const log = {};
  const result = await run({
    head: { pushForkBranchToAppBranch: async () => ({ ok: false, code: 'platform_unavailable', message: 'boom', retryable: true }) },
  }, {}, log);
  assert.equal(result.ok, false);
  assert.deepEqual(log.released, [501]);
});

// ── 4. The attribution gate ────────────────────────────────────────────

test('the fork owner comes from the freshly-read link, never from the caller', async () => {
  const log = {};
  const reads = [];
  await run({
    githubLink: {
      isEnabled: () => true,
      linkStatus: async (pool, userId) => { reads.push(userId); return { linked: true, login: 'evan-gh' }; },
    },
  }, {
    // A caller trying to name somebody else's fork owner: there is no such
    // parameter, and `forkRepo` is only ever the repository's NAME.
    forkRepo: 'recipe-box-fork',
  }, log);
  assert.deepEqual(reads, [7], 'the link is read for THIS user, at update time');
  assert.equal(log.verify[0].forkOwner, 'evan-gh');
  assert.equal(log.verify[0].expectedLogin, 'evan-gh');
  assert.equal(log.verify[0].forkRepo, 'recipe-box-fork', 'only the name is the caller\'s to choose');
  assert.equal(log.push[0].forkOwner, 'evan-gh');
  assert.equal(log.push[0].expectedLogin, 'evan-gh');
});

test('a branch that is not in the author\'s own fork is refused, and nothing is pushed', async () => {
  const log = {};
  const result = await run({
    head: { verifyForkBranch: async () => ({ ok: false, code: 'fork_mismatch', message: 'internal wording' }) },
  }, {}, log);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_your_fork', 'renamed for what the CALLER did, not for the mirror path');
  assert.match(result.message, /owned by the GitHub account linked to your Homeroom profile/);
  assert.equal(log.push, undefined);
});

test('a fork branch that does not exist yet says so, retryably', async () => {
  const result = await run({
    head: { verifyForkBranch: async () => ({ ok: false, code: 'branch_not_found', message: 'internal wording' }) },
  });
  assert.equal(result.code, 'fork_branch_not_found');
  assert.equal(result.retryable, true, 'they can push and try again — this is not a dead end');
  assert.match(result.message, /Push it first/);
});

test('the gate runs before the push in the source, and the push re-runs it itself', () => {
  // Behavioural tests cover the refusals; this covers the ORDER, which is the
  // property a reviewer is asked to confirm: there is no path from submit_work
  // to a push where verifyForkBranch did not run against a freshly-read
  // linkStatus.
  const linkRead = SRC.indexOf('githubLink.linkStatus(');
  const verify = SRC.indexOf('head.verifyForkBranch(');
  const push = SRC.indexOf('head.pushForkBranchToAppBranch(');
  assert.ok(linkRead > 0 && verify > linkRead, 'the link is read before the fork is verified');
  assert.ok(push > verify, 'and the fork is verified before anything is pushed');
  // Both fork-shaped arguments come from the verified link, textually.
  assert.match(SRC, /forkOwner: link\.login/);
  assert.match(SRC, /expectedLogin: link\.login/);
  // And the second, load-bearing run lives inside the head service.
  const HEAD_SRC = fs.readFileSync(
    path.join(__dirname, '../src/services/external-agent-head.js'), 'utf8'
  );
  const fn = HEAD_SRC.slice(HEAD_SRC.indexOf('async function pushForkBranchToAppBranch'));
  const body = fn.slice(0, fn.indexOf('\nmodule.exports'));
  assert.ok(body.indexOf('verifyForkBranch(') > 0, 'the push verifies the fork itself');
  assert.ok(
    body.indexOf('verifyForkBranch(') < body.indexOf('force-with-lease'),
    'and does so BEFORE it pushes'
  );
});

// ── 5. Nothing is clobbered ────────────────────────────────────────────

test('a proposal that moved since the caller read it is refused, with where it is now', async () => {
  const log = {};
  const result = await run({}, { expectedHeadSha: OTHER_HEAD }, log);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'branch_moved');
  assert.equal(result.headSha, NATIVE_HEAD, 'the caller is told the head it must rebase onto');
  assert.match(result.message, /rebase onto its current head/);
  assert.equal(log.push, undefined);
});

test('expectedHeadSha is OPTIONAL — a second update in a row is not refused for having moved', async () => {
  // The trap this avoids: pinning the expectation to the task's recorded base
  // would refuse every update after the first, because the proposal moved
  // for the author's OWN previous update. The lease still prevents a clobber.
  const log = {};
  const result = await run({}, { expectedHeadSha: undefined }, log);
  assert.equal(result.ok, true);
  assert.equal(log.push[0].expectedRemoteSha, NATIVE_HEAD, 'the lease is the live head either way');
});

test('a branch that does not build on the reviewed head is refused with the commit to rebase onto', async () => {
  const log = {};
  const result = await run({
    gh: { compareCommitAncestry: async () => ({ status: 'diverged' }) },
  }, {}, log);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'base_mismatch');
  assert.equal(result.expectedBase, NATIVE_HEAD);
  assert.match(result.message, /would drop commits that are already under review/);
  assert.equal(log.push, undefined, 'reviewed commits are never overwritten by a divergent branch');
});

test('an ancestry comparison the platform cannot make is a refusal, not a pass', async () => {
  for (const cmp of [
    async () => { throw new Error('502 from GitHub'); },
    async () => null,
    async () => ({}),
  ]) {
    const log = {};
    const result = await run({ gh: { compareCommitAncestry: cmp } }, {}, log);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'platform_unavailable');
    assert.equal(result.retryable, true);
    assert.equal(log.push, undefined);
  }
});

test('a lease the remote refused is reported as branch_moved, not as a platform fault', async () => {
  const result = await run({
    head: {
      pushForkBranchToAppBranch: async () => ({
        ok: false, code: 'branch_moved', message: 'somebody advanced it', retryable: false,
      }),
    },
  });
  assert.equal(result.code, 'branch_moved');
  assert.equal(result.retryable, undefined, 'a moved branch is not fixed by retrying the same push');
});

test('an unreadable proposal head refuses rather than pushing without a lease', async () => {
  const log = {};
  // None of these is GitHub saying the branch is NOT THERE — that is a 404
  // STATUS, and it is a first landing (below), not a failure. An error whose
  // message merely reads '404' is an unread head like any other.
  for (const getBranchSha of [
    async () => { throw new Error('404'); },
    async () => null,
    async () => 'not-a-sha',
  ]) {
    const result = await run({ gh: { getBranchSha } }, {}, log);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'platform_unavailable');
    assert.equal(log.push, undefined);
  }
});

// ── 5b. The FIRST landing (#1347's share) ──────────────────────────────
//
// A shared session's row is written before its commits reach the app
// repository, so the branch it names does not exist yet. Everything this
// function does before a push exists to protect a head that is already there
// — the lease against a concurrent revision, the ancestry check against the
// reviewed commit — and neither has anything to guard when there is no head.
// So a 404 is a CREATE, and the two guards that have nothing to guard are the
// only things it skips.

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
const missingBranch = { getBranchSha: async () => { throw notFound(); } };

// The row #1347's share route writes: no `source`, a branch minted into the
// platform's OWN namespace, and no commits behind it yet.
const SHARE_BRANCH = 'usernode/from-u7-s1a2b3c4d';
const sharedRow = (over) => nativeSession(Object.assign({
  source: null,
  branch_name: SHARE_BRANCH,
  pr_number: null,
  pr_url: null,
  shared_at: '2026-08-24T00:00:00Z',
}, over));
const shared = (over = {}, log = {}) => {
  const session = sharedRow();
  return run({ session, pool: fakePool([
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['FROM pr_votes', [{ n: 0 }]],
  ]), ...over }, {}, log);
};

test('a proposal branch that does not exist yet is created, not reported unreadable', async () => {
  const log = {};
  const result = await shared({ gh: missingBranch }, log);

  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.headSha, FORK_HEAD);
  assert.equal(result.previousHeadSha, null, 'there was no previous head to name');
  assert.equal(log.push, undefined, 'no lease-checked push — there is nothing to lease against');
  assert.equal(log.mirror.length, 1);
  assert.equal(log.mirror[0].targetBranch, SHARE_BRANCH,
    'the branch the ROW recorded, not one the mirror minted for itself');
});

test('a first landing makes no ancestry comparison, because there is nothing to be ahead of', async () => {
  const log = {};
  let compared = 0;
  const result = await shared({
    gh: { ...missingBranch, compareCommitAncestry: async () => { compared += 1; return { status: 'diverged' }; } },
  }, log);

  assert.equal(result.ok, true);
  assert.equal(compared, 0, 'a diverged answer cannot refuse a branch with no reviewed head');
});

test('the attribution gate still runs on a first landing, twice', async () => {
  const log = {};
  await shared({ gh: missingBranch }, log);
  // Once here, for the caller's answer...
  assert.equal(log.verify.length, 1);
  assert.equal(log.verify[0].expectedLogin, 'evan-gh');
  // ...and once inside the push itself, which is the load-bearing run. The
  // real mirrorForkBranch opens with verifyForkBranch; asserted on the source
  // because a stub cannot show it.
  assert.match(
    fs.readFileSync(path.join(__dirname, '../src/services/external-agent-head.js'), 'utf8'),
    /async function mirrorForkBranch\(\{[\s\S]*?const verified = await verifyForkBranch\(/,
    'the mirror re-runs the gate itself'
  );
});

test("a fork branch that is not the caller's is refused on a first landing too", async () => {
  const log = {};
  const result = await shared({
    gh: missingBranch,
    head: { verifyForkBranch: async () => ({ ok: false, code: 'fork_mismatch', message: 'not yours' }) },
  }, log);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'not_your_fork', 'renamed for the caller, as on every other path');
  assert.equal(log.mirror, undefined, 'nothing is created for a branch that failed the gate');
});

test('only a 404 is a first landing — every other read failure still refuses', async () => {
  const log = {};
  for (const status of [403, 500, 502, undefined]) {
    const result = await shared({
      gh: { getBranchSha: async () => { throw Object.assign(new Error('nope'), { status }); } },
    }, log);
    assert.equal(result.ok, false, `status ${String(status)}`);
    assert.equal(result.code, 'platform_unavailable');
  }
  assert.equal(log.mirror, undefined);
  assert.equal(log.push, undefined);
});

test('and a missing branch outside the platform namespace is still unreadable, not a create', async () => {
  // A `dev/…` head absent from the app repository is a different story with a
  // different cause: routes/sessions.js creates that branch best-effort, so a
  // session whose creation failed can have a pull request — and a tally —
  // pinned to a branch that is not there. Re-creating it underneath the
  // proposal from whatever a caller pushed is not this function's call.
  const log = {};
  const result = await run({ gh: missingBranch }, {}, log);

  assert.equal(result.ok, false);
  assert.equal(result.code, 'platform_unavailable');
  assert.equal(result.retryable, true);
  assert.equal(log.mirror, undefined);
});

test('expectedHeadSha cannot refuse a first landing — no head has moved', async () => {
  // It names the commit the caller believes the proposal is at. On a first
  // share there is no such commit, so there is nothing for it to disagree
  // with; refusing here would be refusing the caller's optimism.
  const log = {};
  const session = sharedRow();
  const result = await run({ session, gh: missingBranch, pool: fakePool([
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['FROM pr_votes', [{ n: 0 }]],
  ]) }, { expectedHeadSha: OTHER_HEAD }, log);

  assert.equal(result.ok, true);
  assert.equal(log.mirror.length, 1);
});

test('a first landing on an active session ends in the SAME tail as any other push', async () => {
  // Which is the point of putting it here rather than in the share route: the
  // shared card gets its checks marked pending and its staging pipeline
  // started, exactly as a session that took a second commit does.
  const log = {};
  const session = sessionRow('active', {
    source: null,
    branch_name: 'usernode/from-u7-s1a2b3c4d',
    checks_commit_sha: null,
    shared_at: '2026-08-24T00:00:00Z',
  });
  const result = await runSession('active', { session, gh: missingBranch }, log);

  assert.equal(result.ok, true);
  assert.equal(result.previewRebuilding, true);
  assert.equal(result.votesCleared, 0, 'nobody is voting on a shared card');
  assert.equal(log.started.length, 1);
  assert.equal(log.started[0].headSha, FORK_HEAD);
  assert.equal(log.mirror[0].targetBranch, 'usernode/from-u7-s1a2b3c4d');
  // pr_votes is never read for a row that cannot have any.
  assert.equal(sqlsOf(log).some((sql) => sql.includes('FROM pr_votes')), false);
});

test('the mirror is the existing rung, not a second push implementation', () => {
  // The create and the advance are the same push with the same gate in front
  // of it. If this ever grows its own fetch/push here, the attribution gate
  // has a second place to be subtly wrong — the thing this whole service
  // exists to avoid.
  assert.match(CODE, /firstLanding[\s\S]*?head\.mirrorForkBranch\(\{/);
  assert.doesNotMatch(CODE, /git\(\[.?fetch/, 'no git plumbing in this file');
});

// ── 6. Nothing to do ───────────────────────────────────────────────────

test('a fork branch that is already the proposal\'s head is a no-op, not a failure', async () => {
  const log = {};
  const result = await run({
    gh: { getBranchSha: async () => FORK_HEAD },
  }, {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.updated, false);
  assert.equal(result.unchanged, true);
  assert.equal(result.votesCleared, 0, 'no votes are cleared for a head that did not move');
  assert.equal(log.push, undefined);
  assert.equal(log.reconcile, undefined);
});

// ── 7. The imported pull request ───────────────────────────────────────

test('an imported proposal advances the head the platform TRACKS, and pushes nothing', async () => {
  const log = {};
  const session = importedSession();
  const result = await run(
    { session, pool: fakePool([
      ['FROM chat_sessions cs JOIN apps a', [session]],
      ['FROM pr_votes', [{ n: 2 }]],
    ]) },
    { branch: 'usernode/add-a-button' },
    log
  );
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.branchHome, 'user_fork');
  assert.equal(result.submittedVia, 'update_fork_head');
  assert.equal(result.headSha, FORK_HEAD);
  assert.equal(result.previousHeadSha, NATIVE_HEAD);
  assert.equal(result.votesCleared, 2);
  assert.equal(log.push, undefined, 'the author owns this branch — there is nothing for the bot to push');
  assert.equal(log.applied.length, 1, 'the existing imported-head machinery does the work');
  assert.equal(log.applied[0].newHead, FORK_HEAD);
  assert.equal(log.applied[0].oldHead, NATIVE_HEAD);
});

// #1196. The proposal the connector's mirror rung opens: imported, but its
// head is a branch in the app repository. Before this, `branchHomeOf` sent it
// to the fork path, which read the pull request, saw it came from
// `usernode-bot` and refused it with `not_your_fork` — so the agent that wrote
// the code could not fix a failing check on its own proposal at all.
test('an imported proposal on a bot-owned branch is pushed, then reconciled as an import', async () => {
  const log = {};
  const session = importedSession({
    branch_name: 'usernode/from-es92-t3-8510c5ac',
    imported_pr_head_repo: 'o/r',
  });
  const result = await run(
    { session, pool: fakePool([
      ['FROM chat_sessions cs JOIN apps a', [session]],
      ['FROM pr_votes', [{ n: 3 }]],
    ]) },
    {},
    log
  );
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.branchHome, 'app_repo');
  assert.equal(result.branch, 'usernode/from-es92-t3-8510c5ac');
  assert.equal(result.submittedVia, 'update_branch');

  // The author's fork branch was copied onto the proposal's own branch, under
  // the same lease every other app-repo push carries.
  assert.equal(log.push.length, 1);
  assert.equal(log.push[0].targetBranch, 'usernode/from-es92-t3-8510c5ac');
  assert.equal(log.push[0].expectedRemoteSha, NATIVE_HEAD);

  // And it settled through the IMPORT machinery. An imported row's votes and
  // checks hang off imported_pr_head_sha, and reconcileNativeReviewedHead
  // returns without doing anything for `source='imported'` — so the native
  // reconcile would have left the tally describing code nobody has read.
  assert.equal(log.reconcile, undefined, 'the native reconcile is not the one that can move this row');
  assert.equal(log.synced.length, 1);
  assert.equal(log.synced[0].session.id, 601);
  assert.equal(result.votesCleared, 3);
  assert.equal(result.checksRerun, true);
  assert.equal(result.previewRebuilding, true);
});

test('a mirrored proposal GitHub has not caught up with reports no rebuild, not a failure', async () => {
  // 'unchanged' means the pull request still reads the old head — GitHub is a
  // second or two behind the push. The commit landed; the sweeper finishes it.
  const log = {};
  const session = importedSession({
    branch_name: 'usernode/from-es92-t3-8510c5ac',
    imported_pr_head_repo: 'o/r',
  });
  const result = await run({
    session,
    pool: fakePool([
      ['FROM chat_sessions cs JOIN apps a', [session]],
      ['FROM pr_votes', [{ n: 3 }]],
    ]),
    prImportSync: { syncImportedProposal: async () => 'unchanged' },
  }, {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.updated, true, 'the push happened — saying otherwise sends the author to push again');
  assert.equal(result.votesCleared, 0, 'honest: only reported cleared when the clearing ran');
  assert.equal(result.checksRerun, false);
  assert.equal(result.previewRebuilding, false);
});

test('an imported proposal is only advanced from ITS OWN branch', async () => {
  const session = importedSession();
  const result = await run({ session }, { branch: 'some-other-branch' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_request');
  assert.match(result.message, /an open pull request cannot be repointed/);
});

test('an imported proposal whose pull request comes from another account is refused', async () => {
  const session = importedSession();
  const result = await run({
    session,
    gh: {
      getPR: async () => ({
        state: 'open',
        head: { ref: 'usernode/add-a-button', sha: FORK_HEAD, repo: { owner: { login: 'someone-else' } } },
      }),
    },
  }, { branch: 'usernode/add-a-button' });
  assert.equal(result.code, 'not_your_fork');
});

test('a pull request that GitHub says is closed cannot take a revision', async () => {
  const session = importedSession();
  for (const pr of [
    { state: 'closed', head: { ref: 'usernode/add-a-button', sha: FORK_HEAD, repo: { owner: { login: 'evan-gh' } } } },
    { state: 'open', merged: true, head: { ref: 'usernode/add-a-button', sha: FORK_HEAD, repo: { owner: { login: 'evan-gh' } } } },
  ]) {
    const result = await run({ session, gh: { getPR: async () => pr } }, { branch: 'usernode/add-a-button' });
    assert.equal(result.code, 'proposal_closed');
  }
});

test('GitHub\'s two views of the fork branch disagreeing writes nothing', async () => {
  const log = {};
  const session = importedSession();
  const result = await run({
    session,
    gh: {
      getPR: async () => ({
        state: 'open',
        head: { ref: 'usernode/add-a-button', sha: OTHER_HEAD, repo: { owner: { login: 'evan-gh' } } },
      }),
    },
  }, { branch: 'usernode/add-a-button' }, log);
  assert.equal(result.code, 'platform_unavailable');
  assert.equal(result.retryable, true);
  assert.equal(log.applied, undefined);
});

// ── 8. Busy, and the arguments ─────────────────────────────────────────

test('a proposal mid-build is told to retry rather than pushed onto', async () => {
  const log = {};
  const result = await run({ busy: () => true }, {}, log);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session_busy');
  assert.equal(result.retryable, true);
  assert.equal(log.push, undefined);
  assert.equal(log.began, undefined, 'refused before an operation is even opened');
});

test('the busy check asks the same four questions the commit-upload route asks', () => {
  const block = SRC.slice(SRC.indexOf('function defaultBusyCheck'));
  for (const needle of [
    'isSessionBusy', 'hasInFlightHandoffPipeline', 'hasInFlightBuild', 'hasInFlightCapture',
  ]) {
    assert.ok(block.includes(needle), `${needle} is one of the four`);
  }
});

test('the branch, the fork name and the expected head are all validated first', async () => {
  const log = {};
  for (const params of [
    { branch: undefined },
    { branch: '' },
    { branch: 'has a space' },
    { branch: 'ok', forkRepo: 'not/a/name' },
    { branch: 'ok', expectedHeadSha: 'zzzz' },
    { branch: 'ok', expectedHeadSha: 'abc123' },
  ]) {
    const result = await run({}, params, log);
    assert.equal(result.ok, false, JSON.stringify(params));
    assert.equal(result.code, 'invalid_request', JSON.stringify(params));
  }
  assert.equal(log.verify, undefined, 'a bad argument never reaches GitHub');
});

test('a deployment that cannot verify GitHub identity refuses, and says whose problem it is', async () => {
  const unconfigured = await run({ githubLink: { isEnabled: () => false } });
  assert.equal(unconfigured.code, 'github_link_unavailable');
  assert.match(unconfigured.message, /Ask an admin/, 'an operator\'s missing value is not the user\'s missing click');

  const unlinked = await run({
    githubLink: { isEnabled: () => true, linkStatus: async () => ({ linked: false }) },
  });
  assert.equal(unlinked.code, 'github_not_linked');
  assert.equal(unlinked.settingsUrl, 'https://usernode.test/#settings/connectors');

  const noGithub = await run({ gh: { isEnabled: () => false } });
  assert.equal(noGithub.code, 'platform_unavailable');
  assert.equal(noGithub.retryable, true);

  const noRepo = await run({ gh: { parseGithubUrl: () => null } });
  assert.equal(noRepo.code, 'no_repository');
});

// ── 9. The lock ────────────────────────────────────────────────────────

test('the advisory lock is taken on the session and released in finally', async () => {
  const calls = [];
  const client = {
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; },
    release: () => calls.push({ sql: 'RELEASE' }),
  };
  const out = await svc.withProposalLock({ connect: async () => client }, 501, async () => 'body ran');
  assert.equal(out, 'body ran');
  assert.match(calls[0].sql, /pg_advisory_lock/);
  assert.equal(calls[0].params[1], 501, 'keyed on the session id');
  assert.match(calls[1].sql, /pg_advisory_unlock/);
  assert.equal(calls[2].sql, 'RELEASE');

  // Released even when the body throws — a held session lock would wedge
  // every later update of this proposal.
  calls.length = 0;
  await assert.rejects(
    svc.withProposalLock({ connect: async () => client }, 501, async () => { throw new Error('nope'); }),
    /nope/
  );
  assert.match(calls[1].sql, /pg_advisory_unlock/);
});

test('a pool that cannot lock still runs the update', async () => {
  // Degrading to unlocked is right: the lease is what prevents a clobber, and
  // a database that cannot hand out a client is not a reason to refuse
  // finished work.
  assert.equal(await svc.withProposalLock({}, 501, async () => 'ran'), 'ran');
  assert.equal(await svc.withProposalLock(null, 501, async () => 'ran'), 'ran');
  assert.equal(
    await svc.withProposalLock({ connect: async () => { throw new Error('pool exhausted'); } }, 501, async () => 'ran'),
    'ran'
  );
  // A nonsense session id is not lockable either — and must not be silently
  // locked on 0, which would serialize unrelated updates against each other.
  assert.equal(await svc.withProposalLock({ connect: async () => ({}) }, 0, async () => 'ran'), 'ran');
});

test('the lock is the one reserved for this path, not a borrowed key', () => {
  const { PROPOSAL_UPDATE_LOCK, ADMIN_MUTATION_LOCK, EXTERNAL_TASK_SUBMIT_LOCK } =
    require('../src/services/advisory-locks');
  assert.equal(typeof PROPOSAL_UPDATE_LOCK, 'number');
  assert.notEqual(PROPOSAL_UPDATE_LOCK, ADMIN_MUTATION_LOCK);
  assert.notEqual(PROPOSAL_UPDATE_LOCK, EXTERNAL_TASK_SUBMIT_LOCK);
  assert.match(SRC, /PROPOSAL_UPDATE_LOCK/);
});

// ── 10. What this path must never do ───────────────────────────────────

test('no user GitHub credential is used, held or forwarded', async () => {
  // The service asks for no token, and the only credential in the push is the
  // platform's own, resolved inside services/external-agent-head.js.
  assert.doesNotMatch(CODE, /access_token|accessToken|authorization|Bearer/i);
  assert.doesNotMatch(CODE, /github_tokens|user_token|userToken|\.token\b/);
  assert.doesNotMatch(CODE, /resolveWriteCredential|GITHUB_BOT_TOKEN|getInstallationToken/,
    'credential resolution stays where it already was, reused unchanged');
  // The fork is read through the PUBLIC reader, which is what makes the read
  // credential-free rather than merely un-credentialled today.
  const log = {};
  await run({}, {}, log);
  assert.deepEqual(log.verify[0].githubPublic, { marker: 'public-reader' });
  assert.deepEqual(log.push[0].githubPublic, { marker: 'public-reader' });
});

test('recordPlatformPush is never called, so the head classifies as the author\'s', () => {
  // If this path recorded a platform push, classifyNativeHeadMove would carry
  // every existing approval onto code nobody in the group has read. The
  // comment says so; this makes it true.
  assert.doesNotMatch(CODE, /recordPlatformPush/);
  assert.doesNotMatch(CODE, /sync-main/);
  // And the header comment says WHY, so the next person does not add it back.
  assert.match(SRC, /recordPlatformPush/, 'the omission is documented, not accidental');
});

test('the vote-clearing and check-rerunning machinery is reused, not reimplemented', () => {
  // Two calls out, both to code that already existed. Anything that deleted
  // from pr_votes or kicked a build in here would be a second implementation
  // of the platform's most consequential rule.
  assert.match(SRC, /votes\.reconcileNativeReviewedHead/);
  assert.match(SRC, /prImportSync\.applyHeadChange/);
  assert.match(SRC, /prImportSync\.syncImportedProposal/);
  assert.doesNotMatch(SRC, /DELETE\s+FROM\s+pr_votes/i);
  assert.doesNotMatch(SRC, /kickNativeRevisionChecks|rerunChecksForNewHead|startStagingBuild/);
  // pr_votes is read, and only read.
  const votesReads = SRC.match(/FROM pr_votes/g) || [];
  assert.equal(votesReads.length, 1);
});

test('a reconciliation that fails after a successful push still reports the update', async () => {
  // The push landed. Telling the author it did not would send them to push
  // again over their own work.
  const log = {};
  const result = await run({
    votes: { reconcileNativeReviewedHead: async () => { throw new Error('notify failed'); } },
  }, {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.votesCleared, 0, 'honest: the votes are only reported cleared when the clearing ran');
  assert.equal(result.checksRerun, false);
  assert.equal(log.push.length, 1);
});

// ── 8. Continuing a session nobody has voted on (#1071) ────────────────
//
// The same push, onto a session that is still being built rather than a
// proposal up for a vote. The mechanics are identical — same bot-owned branch,
// same lease, same attribution gate — and everything AFTERWARDS is different:
// there are no votes to clear, no re-review note to post, and what the session
// needs instead is its checks re-pointed at the new commit.

// The three modules the session tails reach for, as observable stubs. The real
// ones start a container, tear one down and fan out over a websocket; a test
// about which tail ran must not do any of that.
function sessionParts(log, over = {}) {
  return Object.assign({
    visuals: {
      setChecksPending: async (...args) => {
        (log.pending = log.pending || []).push(args);
        return true;
      },
      notifyChecksPending: (...args) => { (log.notified = log.notified || []).push(args); },
    },
    pipeline: {
      OWNED_SOURCE_SQL: "source = 'native'",
      beginHandoffPipeline: (id) => {
        (log.pipelineBegan = log.pipelineBegan || []).push(id);
        return () => { (log.pipelineReleased = log.pipelineReleased || []).push(id); };
      },
      startHandoffPipeline: (config, pool, session, app, headSha) => {
        (log.started = log.started || []).push({ sessionId: session.id, headSha, app });
      },
    },
    lifecycle: {
      teardownStagingForSession: async (args) => {
        (log.tornDown = log.tornDown || []).push(args);
        return { ok: true };
      },
    },
    pushSessionUpdate: (payload) => { (log.pushed = log.pushed || []).push(payload); },
  }, over);
}

// A session (not a proposal) whose row answers the tail's guarded UPDATE.
function sessionRow(status, over) {
  return nativeSession(Object.assign({
    status,
    pr_number: null,
    pr_url: null,
    checks_commit_sha: OTHER_HEAD,
  }, over));
}

function runSession(status, over = {}, log = {}, params = {}) {
  const session = over.session || sessionRow(status);
  const pool = over.pool || fakePool([
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['UPDATE chat_sessions', () => (over.adopted === false ? [] : [{ id: session.id }])],
    ['FROM pr_votes', [{ n: 4 }]],
  ]);
  // rowCount, which the tails branch on, is not what fakePool reports — wrap
  // it so an UPDATE answers with the count the service actually reads.
  const counting = {
    queries: pool.queries,
    async query(sql, params2) {
      const res = await pool.query(sql, params2);
      return Object.assign({}, res, { rowCount: res.rows.length });
    },
  };
  log.queries = pool.queries;
  return svc.updateProposalFromForkBranch(
    Object.assign(deps({ ...over, session, pool: counting }, log), over.parts || sessionParts(log)),
    Object.assign({
      user: USER, session, branch: 'fix/failing-check', origin: 'https://usernode.test',
    }, params)
  );
}

// The queries a run actually issued — used both ways round: to assert an
// UPDATE's shape, and to assert that pr_votes was never read.
const sqlsOf = (log) => (log.queries || []).map((q) => String(q.sql));
const queryOf = (log, needle) => (log.queries || []).find((q) => String(q.sql).includes(needle));

test('active and paused are continuable; archived and merged are not', () => {
  // ONE predicate, shared with describeTargetProposal — the options menu's
  // label and this gate cannot disagree, which is the whole point of it being
  // exported rather than copied.
  assert.equal(svc.isContinuableStatus('promoted'), 'proposal');
  assert.equal(svc.isContinuableStatus('active'), 'session');
  assert.equal(svc.isContinuableStatus('paused'), 'session');
  for (const status of ['archived', 'merging', 'merged', 'closed', 'building', '', null, undefined]) {
    assert.equal(svc.isContinuableStatus(status), null, `${String(status)} is not continuable`);
  }
  // And the gate is written in terms of it, not in terms of a second list.
  assert.match(CODE, /if \(!isContinuableStatus\(session\.status\)\)/);
});

test('managed promoted upload reconciliation resets the exact head and defers its pipeline', async () => {
  const calls = [];
  const session = nativeSession({ source: 'cli_handoff' });
  const result = await svc.reconcileManagedCommitUpload({
    config: { marker: 'config' },
    pool: { marker: 'pool' },
    votes: {
      async reconcileNativeReviewedHead(args) {
        calls.push(args);
        return { headSha: FORK_HEAD, updated: true, votesDropped: 2, checksDeferred: true };
      },
    },
  }, { session, expectedHeadSha: FORK_HEAD });

  assert.equal(result.ok, true);
  assert.equal(result.votesDropped, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session, session);
  assert.equal(calls[0].fresh, true);
  assert.equal(calls[0].notify, true);
  assert.equal(calls[0].deferChecks, true);
});

test('managed promoted upload reconciliation fails closed when GitHub moved again', async () => {
  const result = await svc.reconcileManagedCommitUpload({
    config: {}, pool: {},
    votes: {
      async reconcileNativeReviewedHead() {
        return { headSha: OTHER_HEAD, updated: true };
      },
    },
  }, { session: nativeSession({ source: 'cli_handoff' }), expectedHeadSha: FORK_HEAD });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'branch_moved');
  assert.equal(result.headSha, OTHER_HEAD);
});

test('an archived session is refused before anything is pushed', async () => {
  const log = {};
  const result = await runSession('archived', {}, log);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'proposal_closed');
  assert.equal(log.push, undefined, 'an explicit put-away is not silently reopened');
});

test('an ACTIVE session gets the commit, pending checks and a staging rebuild', async () => {
  const log = {};
  const result = await runSession('active', {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.targetKind, 'session');
  assert.equal(result.submittedVia, 'update_branch');
  assert.equal(result.votesCleared, 0, 'nobody has voted, so nothing is cleared');
  assert.equal(result.checksRerun, true);
  assert.equal(result.previewRebuilding, true);
  assert.equal(result.resumeRequired, undefined, 'the build is running now, not on reopen');

  // The commit landed on the session's own branch, with the lease pinned to
  // the head read under the lock.
  assert.equal(log.push.length, 1);
  assert.equal(log.push[0].targetBranch, 'dev/evan-1786376366569');
  assert.equal(log.push[0].expectedRemoteSha, NATIVE_HEAD);

  // And the platform's ordinary post-commit machinery ran, rather than a
  // second implementation of it.
  // #1144: the phase and the trigger ride along on the same call — a reviewer
  // watching this run sees "preparing the staging preview", started by a push.
  assert.deepEqual(log.pending[0].slice(1), [501, FORK_HEAD, 'building', 'commit-push']);
  assert.equal(log.notified.length, 1);
  assert.deepEqual(log.pipelineBegan, [501]);
  assert.equal(log.started.length, 1);
  assert.equal(log.started[0].headSha, FORK_HEAD);
  assert.equal(log.started[0].sessionId, 501);

  // Nothing about votes: no count, no reconciliation.
  assert.equal(log.reconcile, undefined);
  assert.ok(!sqlsOf(log).some((s) => /FROM pr_votes/.test(s)),
    'a session with no votes is not asked how many it has');
});

test('the checks UPDATE is guarded on the status and the commit it replaces', async () => {
  const log = {};
  await runSession('active', {}, log);
  const update = queryOf(log, 'UPDATE chat_sessions');
  assert.match(update.sql, /status = 'active'/, 'a pause between the lock and here wins');
  assert.match(update.sql, /checks_commit_sha IS NOT DISTINCT FROM \$3/,
    'a newer head that took the session is not regressed to an older pending state');
  assert.match(update.sql, /check_state = 'pending'/);
  assert.deepEqual(update.params, [FORK_HEAD, 501, OTHER_HEAD]);
});

test('an active session that stopped being active falls back to the paused tail', async () => {
  // The guarded UPDATE matched nothing: something paused or archived the
  // session between the lock and the write. The commit is already on the
  // branch, so the answer is "it landed, reopen to rebuild" — never a failure.
  const log = {};
  const result = await runSession('active', { adopted: false }, log);
  assert.equal(result.ok, true);
  assert.equal(result.checksRerun, false);
  assert.equal(result.previewRebuilding, false);
  assert.equal(result.resumeRequired, true);
  assert.equal(log.started, undefined, 'no build is started for a session that is not active');
  assert.equal(log.tornDown.length, 1, 'and the stale preview is reclaimed');
});

test('a PAUSED session takes the commit and defers the build to its reopen', async () => {
  const log = {};
  const result = await runSession('paused', {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.targetKind, 'session');
  assert.equal(result.votesCleared, 0);
  assert.equal(result.checksRerun, false);
  assert.equal(result.previewRebuilding, false);
  assert.equal(result.resumeRequired, true);

  // The push happened; the pipeline deliberately did not. handoff-pipeline's
  // persistence UPDATE only matches an active row, so a build started here
  // would run for minutes and discard its own result.
  assert.equal(log.push.length, 1);
  assert.equal(log.started, undefined);
  assert.equal(log.pipelineBegan, undefined);

  // The stale verdict is cleared and the stale preview torn down.
  const cleared = queryOf(log, 'UPDATE chat_sessions');
  assert.match(cleared.sql, /status = 'paused'/);
  assert.match(cleared.sql, /check_state = NULL/,
    "a 'pending' no pipeline will resolve is a spinner forever");
  assert.doesNotMatch(cleared.sql, /checks_commit_sha =/,
    'the commit the last verdict described is what the resume path compares against');
  assert.deepEqual(log.tornDown[0].sessionId, 501);
  assert.equal(log.tornDown[0].reason, 'external_update');

  // And the page the session is open in hears about it.
  assert.equal(log.pushed.length, 1);
  assert.equal(log.pushed[0].action, 'session_update');
  assert.equal(log.pushed[0].sessionId, 501);
});

test('a teardown that throws does not turn a landed commit into a failed update', async () => {
  const log = {};
  const result = await runSession('paused', {
    parts: sessionParts(log, {
      lifecycle: {
        teardownStagingForSession: async () => { throw new Error('docker is down'); },
      },
    }),
  }, log);
  assert.equal(result.ok, true, 'the commit is on the branch either way');
  assert.equal(result.resumeRequired, true);
  // Same for the websocket fan-out.
  const log2 = {};
  const result2 = await runSession('paused', {
    parts: sessionParts(log2, {
      pushSessionUpdate: () => { throw new Error('no sockets'); },
    }),
  }, log2);
  assert.equal(result2.ok, true);
});

test('the tail is chosen by the status read UNDER THE LOCK, not the caller\'s copy', async () => {
  // The caller's snapshot says active; the row read under the lock says
  // promoted — it was promoted while the agent worked. The push must take the
  // PROPOSAL tail, votes and all, because that is what it is landing on now.
  const log = {};
  const locked = nativeSession({ status: 'promoted' });
  const pool = fakePool([
    ['FROM chat_sessions cs JOIN apps a', [locked]],
    ['FROM pr_votes', [{ n: 4 }]],
  ]);
  const result = await svc.updateProposalFromForkBranch(
    Object.assign(deps({ pool, session: locked }, log), sessionParts(log)),
    {
      user: USER,
      session: sessionRow('active'),
      branch: 'fix/failing-check',
      origin: 'https://usernode.test',
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.targetKind, 'proposal');
  assert.equal(result.votesCleared, 4, 'it IS up for a vote now, so the votes are cleared');
  assert.equal(log.reconcile.length, 1);
  assert.equal(log.started, undefined, 'and the session tails did not run');

  // And the reverse: a caller who thinks it is promoted, against a row that
  // was paused back. No votes are counted for a session that has none.
  const log2 = {};
  const paused = sessionRow('paused');
  const pool2 = fakePool([
    ['FROM chat_sessions cs JOIN apps a', [paused]],
    ['UPDATE chat_sessions', [{ id: 501 }]],
  ]);
  const result2 = await svc.updateProposalFromForkBranch(
    Object.assign(deps({ pool: pool2, session: paused }, log2), sessionParts(log2)),
    {
      user: USER,
      session: nativeSession({ status: 'promoted' }),
      branch: 'fix/failing-check',
      origin: 'https://usernode.test',
    }
  );
  assert.equal(result2.ok, true);
  assert.equal(result2.targetKind, 'session');
  assert.equal(result2.resumeRequired, true);
  assert.equal(log2.reconcile, undefined);
});

test('a fork-owned proposal is refused unless it is up for a vote', () => {
  // advanceForkHead only ever meant "the author pushed to their own PR
  // branch", which exists only for an imported, promoted proposal — a native
  // session is always app_repo. The guard is there so a future caller cannot
  // reach it with a session and quietly skip the whole session tail.
  assert.match(CODE, /async function advanceForkHead/);
  const fork = CODE.slice(CODE.indexOf('async function advanceForkHead'));
  assert.match(fork.slice(0, 900), /proposal_closed/,
    'the fork path states the one status it accepts');
});

// ── 11. The revision's testing metadata (#1199) ────────────────────────
//
// A revision changes which SCREEN the group should be looking at. Until this
// section existed, submit_work accepted `testingPaths`, every layer between it
// and here dropped them, and chat_sessions kept whatever the FIRST submission
// said — NULL for a proposal imported without any. The capture then fell back
// to '/' and flagged `captureDefaultedToRoot`, so a change to a dialog behind
// a deep link was voted on from screenshots of the app's home page. And the
// obvious correction — resubmit with the right routes — was a silent no-op,
// because nothing but a moved head ever re-read them.
//
// Two properties these tests are about:
//
//   1. THE ROUTES ARE STORED BEFORE THE CAPTURE RUNS. Every tail ends in
//      visuals.captureForSession, which reads `testing_paths` off the
//      IN-MEMORY session object it is handed — so the row is mutated as well
//      as written, or the run that follows still shoots the old routes.
//   2. A SAME-COMMIT RESUBMIT IS NOT A NO-OP WHEN THE ROUTES DIFFER. It
//      stores them, forces a fresh capture, and says so — while clearing no
//      votes, because not one line of code changed.

const TESTING = {
  testingPaths: [{ path: '/?shot=invite', viewport: 'desktop' }, { path: '/?shot=members', viewport: 'mobile' }],
  testingSteps: '1. Open the invite dialog.',
};

// A pool that answers the metadata UPDATE too, and records it.
function testingPool(session, log = {}, extra = []) {
  const queries = [];
  log.queries = queries;
  return fakePool([
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['FROM pr_votes', [{ n: 4 }]],
    ['SET testing_paths', []],
    ['SET testing_md', []],
    ...extra,
  ], queries);
}

const testingWrite = (log) => (log.queries || []).find((q) => /SET testing_/.test(String(q.sql)));

test('an update stores the routes it was given, and stores them BEFORE the capture reads them', async () => {
  const log = {};
  const session = nativeSession();
  const result = await run({ session, pool: testingPool(session, log) }, { testing: TESTING }, log);

  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.testingUpdated, true);
  assert.deepEqual(result.testingPaths, ['/?shot=invite', '/?shot=members @mobile'],
    'reported back in the form they were written, annotation intact');

  const write = testingWrite(log);
  assert.ok(write, 'the routes reached the column');
  assert.match(String(write.sql), /testing_paths = \$1::jsonb/);
  assert.match(String(write.sql), /testing_path = \$2/);
  assert.match(String(write.sql), /testing_md = \$3/);
  assert.deepEqual(JSON.parse(write.params[0]), TESTING.testingPaths);
  assert.equal(write.params[1], '/?shot=invite', 'the PRIMARY path is the first entry, same rule as the block parser');
  assert.equal(write.params[2], '1. Open the invite dialog.');
  assert.equal(write.params[3], 501);

  // Property 1: the row the tails hand to captureForSession says the new
  // routes, not the old ones — and it said so before the tail ran.
  assert.deepEqual(session.testing_paths, TESTING.testingPaths);
  assert.equal(session.testing_path, '/?shot=invite');
  const sqls = (log.queries || []).map((q) => String(q.sql));
  assert.ok(sqls.findIndex((s) => /SET testing_/.test(s)) >= 0);
});

test('an update that says nothing about testing leaves the stored routes alone', async () => {
  // The common case: a one-line fix to a failing check. Blanking the routes
  // the first submission got right would be worse than dropping them ever was.
  const log = {};
  const session = nativeSession({
    testing_paths: [{ path: '/board', viewport: 'desktop' }], testing_path: '/board',
  });
  const result = await run({ session, pool: testingPool(session, log) }, {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.testingUpdated, false);
  assert.equal(result.testingPaths, null);
  assert.equal(testingWrite(log), undefined, 'no write at all');
  assert.deepEqual(session.testing_paths, [{ path: '/board', viewport: 'desktop' }]);
});

test('an unusable route is dropped rather than stored, and the rules are the block parser\'s', async () => {
  const log = {};
  const session = nativeSession();
  const result = await run({ session, pool: testingPool(session, log) }, {
    testing: {
      testingPaths: [
        'https://evil.test/steal', '//evil.test', '/ok?x=1', '/ok?x=1',
        '/a', '/b', '/c', '/d',
      ],
    },
  }, log);
  assert.equal(result.ok, true);
  // Off-origin and protocol-relative dropped, the duplicate collapsed, and
  // the list capped at CAPTURE_MAX_PATHS — every one of those rules coming
  // from services/testing-notes.js rather than from a second copy here.
  assert.deepEqual(result.testingPaths, ['/ok?x=1', '/a', '/b']);
  const write = testingWrite(log);
  assert.deepEqual(JSON.parse(write.params[0]).map((p) => p.path), ['/ok?x=1', '/a', '/b']);

  // …and every one of those drops is NAMED (#1214). Dropping is right —
  // one bad route must not cost an update that already landed on GitHub —
  // but doing it silently left the author with no signal at all until
  // `captureDefaultedToRoot` came back minutes later on another endpoint.
  assert.deepEqual(result.testingPathsRejected, [
    'https://evil.test/steal (not a usable in-app path: it must start with a single "/")',
    '//evil.test (not a usable in-app path: it must start with a single "/")',
    '/ok?x=1 (already listed)',
    '/c (over the 3-route cap)',
    '/d (over the 3-route cap)',
  ]);
});

test('a route the caller already had rejected is still reported back (#1214)', async () => {
  // The route parses the RAW body and hands this service its shaped output, so
  // a second parse here sees nothing to reject. The list has to travel.
  const log = {};
  const session = nativeSession();
  const result = await run({ session, pool: testingPool(session, log) }, {
    testing: {
      testingPaths: [{ path: '/kept', viewport: 'desktop' }],
      dropped: [{ index: 0, entry: 'nope', reason: 'invalid_path' }],
    },
  }, log);
  assert.equal(result.ok, true);
  assert.deepEqual(result.testingPaths, ['/kept']);
  assert.deepEqual(result.testingPathsRejected, [
    'nope (not a usable in-app path: it must start with a single "/")',
  ]);
});

test('nothing rejected reports null, not an empty list', async () => {
  const log = {};
  const session = nativeSession();
  const result = await run({ session, pool: testingPool(session, log) }, { testing: TESTING }, log);
  assert.equal(result.testingPathsRejected, null);
});

test('a submission whose every route is rejected changes nothing but says why', async () => {
  // Nothing is stored, so the capture keeps whatever the proposal already had
  // — which is exactly why the caller has to be told, rather than reading
  // `testingUpdated: false` as "the routes I sent were already the ones set".
  const log = {};
  const session = nativeSession();
  const result = await run({ session, pool: testingPool(session, log) }, {
    testing: { testingPaths: ['nope', '//evil.test'] },
  }, log);
  assert.equal(result.ok, true);
  assert.equal(result.updated, true, 'the commit still landed');
  assert.equal(result.testingUpdated, false);
  assert.equal(result.testingPaths, null);
  assert.equal(result.testingPathsRejected.length, 2);
  assert.equal(testingWrite(log), undefined, 'and nothing was written');
});

test('the @mobile annotation survives an update written as a plain string (#1214)', async () => {
  // The spelling every agent-facing description teaches. It used to be read as
  // part of the path, fail the no-whitespace rule, and take the route with it.
  const log = {};
  const session = nativeSession();
  const result = await run({ session, pool: testingPool(session, log) }, {
    testing: { testingPaths: ['/?shot=invite @mobile', '/?shot=members @mobile'] },
  }, log);
  assert.equal(result.ok, true);
  assert.deepEqual(result.testingPaths, ['/?shot=invite @mobile', '/?shot=members @mobile']);
  assert.equal(result.testingPathsRejected, null);
  assert.deepEqual(JSON.parse(testingWrite(log).params[0]), [
    { path: '/?shot=invite', viewport: 'mobile' },
    { path: '/?shot=members', viewport: 'mobile' },
  ]);
});

test('an imported proposal\'s new routes are stored before its head change re-runs the checks', async () => {
  const log = {};
  const session = importedSession();
  const result = await run(
    { session, pool: testingPool(session, log) },
    { branch: 'usernode/add-a-button', testing: TESTING },
    log
  );
  assert.equal(result.ok, true);
  assert.equal(result.submittedVia, 'update_fork_head');
  assert.equal(result.testingUpdated, true);
  assert.deepEqual(result.testingPaths, ['/?shot=invite', '/?shot=members @mobile']);
  // applyHeadChange's own tail is what shoots the screenshots, and it reads
  // the session object handed to it — so the mutation has to be visible in
  // the very object that reached it.
  assert.equal(log.applied.length, 1);
  assert.deepEqual(log.applied[0].session.testing_paths, TESTING.testingPaths);
});

test('a same-commit resubmit with new routes stores them and forces a fresh capture', async () => {
  const log = {};
  const rechecks = [];
  const session = nativeSession({
    testing_paths: [{ path: '/', viewport: 'desktop' }], testing_path: '/',
  });
  const result = await run({
    session,
    pool: testingPool(session, log),
    gh: { getBranchSha: async () => FORK_HEAD },
    recovery: { recheckSessionChecks: async (args) => { rechecks.push(args); return 'rechecked'; } },
  }, { testing: TESTING }, log);

  assert.equal(result.ok, true);
  assert.equal(result.updated, false);
  assert.equal(result.unchanged, true, 'still honest that no commit moved');
  assert.equal(result.testingUpdated, true);
  assert.equal(result.captureRerun, true);
  assert.equal(result.checksRerun, true);
  assert.deepEqual(result.testingPaths, ['/?shot=invite', '/?shot=members @mobile']);

  // Not one vote, because not one line of code changed.
  assert.equal(result.votesCleared, 0);
  assert.equal(log.push, undefined, 'nothing is pushed');
  assert.equal(log.reconcile, undefined, 'and nothing reconciles a head that did not move');
  assert.ok(!(log.queries || []).some((q) => /FROM pr_votes/.test(String(q.sql))), 'no tally is even counted');

  // The stored routes, and the re-run that shoots them.
  const write = testingWrite(log);
  assert.deepEqual(JSON.parse(write.params[0]), TESTING.testingPaths);
  assert.equal(rechecks.length, 1);
  assert.equal(rechecks[0].reason, 'testing-update');
  assert.deepEqual(rechecks[0].session.testing_paths, TESTING.testingPaths,
    'the recheck is handed the row that already says the new routes');
});

test('a same-commit resubmit of the SAME routes stays the no-op it always was', async () => {
  const log = {};
  const rechecks = [];
  const session = nativeSession({
    testing_paths: TESTING.testingPaths,
    testing_path: '/?shot=invite',
    testing_md: TESTING.testingSteps,
  });
  const result = await run({
    session,
    pool: testingPool(session, log),
    gh: { getBranchSha: async () => FORK_HEAD },
    recovery: { recheckSessionChecks: async (args) => { rechecks.push(args); return 'rechecked'; } },
  }, { testing: TESTING }, log);

  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.testingUpdated, false);
  assert.equal(result.captureRerun, false);
  assert.equal(testingWrite(log), undefined, 'nothing written');
  assert.equal(rechecks.length, 0, 'and no capture burned on routes that already applied');

  // A row written before #768 holds plain strings for the same routes. That
  // is the same list, not a change — otherwise every legacy proposal re-shoots
  // its screenshots the first time anything resubmits.
  const legacy = nativeSession({ testing_paths: ['/board'], testing_path: '/board' });
  const log2 = {};
  const again = await run({
    session: legacy,
    pool: testingPool(legacy, log2),
    gh: { getBranchSha: async () => FORK_HEAD },
    recovery: { recheckSessionChecks: async () => 'rechecked' },
  }, { testing: { testingPaths: ['/board'] } }, log2);
  assert.equal(again.testingUpdated, false);
  assert.equal(testingWrite(log2), undefined);
});

test('a same-commit resubmit with nothing new is still not an error', async () => {
  const log = {};
  const session = nativeSession();
  const result = await run({
    session,
    pool: testingPool(session, log),
    gh: { getBranchSha: async () => FORK_HEAD },
    recovery: { recheckSessionChecks: async () => { throw new Error('must not run'); } },
  }, {}, log);
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.testingUpdated, false);
  assert.equal(result.captureRerun, false);
  assert.equal(result.votesCleared, 0);
});

test('a paused session takes the new routes but never starts a build for them', async () => {
  // Same reason settlePausedSession exists: there is no container to shoot
  // against, and handoff-pipeline's write only matches an active session.
  const log = {};
  const rechecks = [];
  const session = sessionRow('paused');
  const result = await run({
    session,
    pool: testingPool(session, log),
    gh: { getBranchSha: async () => FORK_HEAD },
    recovery: { recheckSessionChecks: async (args) => { rechecks.push(args); return 'rechecked'; } },
  }, { testing: TESTING }, log);

  assert.equal(result.ok, true);
  assert.equal(result.testingUpdated, true);
  assert.equal(result.captureRerun, false);
  assert.equal(result.resumeRequired, true, 'the caller is told why no screenshots are coming yet');
  assert.equal(rechecks.length, 0);
  assert.ok(testingWrite(log), 'the routes are stored either way');
});

test('a metadata write that fails is reported, never fatal to an update that landed', async () => {
  // The commit is already on the branch by the time this runs.
  const log = {};
  const session = nativeSession();
  const queries = [];
  log.queries = queries;
  const pool = fakePool([
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['FROM pr_votes', [{ n: 4 }]],
    ['SET testing_paths', () => { throw new Error('column is on fire'); }],
  ], queries);
  const result = await run({ session, pool }, { testing: TESTING }, log);
  assert.equal(result.ok, true);
  assert.equal(result.updated, true, 'the push still counts');
  assert.equal(result.testingUpdated, false, 'and the caller is told the routes did not take');
  assert.equal(session.testing_paths, undefined, 'the in-memory row is not lied to either');
});

test('the metadata write happens before the tails, and the resubmit path clears no votes', () => {
  // Source-level, because the ORDER is the property: a future edit that moved
  // applyTestingMetadata below the tails would still pass a behavioural test
  // whose stubs do not read the row.
  const fn = CODE.slice(
    CODE.indexOf('async function advanceAppRepoBranch'),
    CODE.indexOf('async function settleActiveSession')
  );
  const applied = fn.indexOf('applyTestingMetadata');
  assert.ok(applied > 0, 'the app-repo path stores the routes');
  for (const tail of ['syncImportedProposal', 'settleActiveSession', 'settlePausedSession', 'reconcileNativeReviewedHead']) {
    assert.ok(fn.indexOf(tail) > applied, `${tail} runs after the routes are stored`);
  }
  const resubmit = CODE.slice(
    CODE.indexOf('async function resubmitUnchanged'),
    CODE.indexOf('async function advanceAppRepoBranch')
  );
  assert.doesNotMatch(resubmit, /countVotes|pr_votes|reconcileNativeReviewedHead|pushForkBranchToAppBranch/,
    'a resubmit that moves no commit touches neither the votes nor the branch');
});

// ── 12. The Changes-ready card (session 3401) ──────────────────────────
//
// The dev chat's ONLY route to "Propose to group" is the Changes-ready card,
// and the card renders off a persisted `changesReady: true` system row (or a
// synthetic fallback that needs a staging URL or a CLI-handoff head — see
// _hydrateChangesReadyFromSession). A session advanced ONLY through
// submit_work had none of those: the paused tail tears staging down and the
// active tail starts with neither, so the owner of a work-order-built
// session had no way to put the change up for a vote at all. Both session
// tails now persist the same marker every build tail does.

function cardPool(session, cards, extra = []) {
  return fakePool([
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['UPDATE chat_sessions', [{ id: session.id }]],
    ['INSERT INTO chat_session_messages', (params) => { cards.push(params); return []; }],
    ...extra,
  ]);
}

test('a paused-session update persists the Changes-ready card its reopen promotes from', async () => {
  const log = {};
  const cards = [];
  const session = sessionRow('paused');
  const result = await runSession('paused', { session, pool: cardPool(session, cards) }, log);
  assert.equal(result.ok, true);
  assert.equal(result.resumeRequired, true);
  assert.equal(cards.length, 1, 'exactly one card per landed update');
  const [sid, content, metaJson] = cards[0];
  assert.equal(sid, 501);
  assert.match(content, /bbbbbbbb/, 'the card names the commit that arrived');
  const meta = JSON.parse(metaJson);
  assert.equal(meta.changesReady, true, 'the flag the dev chat card renders off');
  assert.equal(meta.externalUpdate, true);
  assert.equal(meta.prNumber, null, 'a session has no PR yet — promote creates it lazily');
});

test('an active-session update persists the card too, ahead of the staging rebuild', async () => {
  // Without the row the card only appears once the pipeline sets staging_url
  // (the synthetic fallback) — and disappears again when the idle sweeper
  // reclaims the preview, taking Propose with it.
  const log = {};
  const cards = [];
  const session = sessionRow('active');
  const result = await runSession('active', { session, pool: cardPool(session, cards) }, log);
  assert.equal(result.ok, true);
  assert.equal(result.checksRerun, true);
  assert.equal(cards.length, 1);
  assert.equal(JSON.parse(cards[0][2]).changesReady, true);
});

test('a card insert that fails never fails the update that landed', async () => {
  const log = {};
  const session = sessionRow('paused');
  const pool = fakePool([
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['UPDATE chat_sessions', [{ id: session.id }]],
    ['INSERT INTO chat_session_messages', () => { throw new Error('table is on fire'); }],
  ]);
  const result = await runSession('paused', { session, pool }, log);
  assert.equal(result.ok, true);
  assert.equal(result.resumeRequired, true);
});

test('the card is written by both session tails and only the session tails', () => {
  // Source-level, matching the tails-order test above: a future refactor that
  // dropped one call would still pass a behavioural test whose pool stubs
  // swallow the insert.
  const active = CODE.slice(
    CODE.indexOf('async function settleActiveSession'),
    CODE.indexOf('async function settlePausedSession')
  );
  const paused = CODE.slice(
    CODE.indexOf('async function settlePausedSession'),
    CODE.indexOf('async function recordChangesReadyCard')
  );
  assert.match(active, /recordChangesReadyCard\(/, 'the active tail records the card');
  assert.match(paused, /recordChangesReadyCard\(/, 'the paused tail records the card');
  const beforeTails = CODE.slice(
    CODE.indexOf('async function advanceAppRepoBranch'),
    CODE.indexOf('function sessionParts')
  );
  assert.doesNotMatch(beforeTails, /recordChangesReadyCard/,
    'promoted proposals keep their own re-review machinery — no session card');
});

// ── 13. The submitted title ────────────────────────────────────────────
//
// submit_work's `title` used to be dropped on the update path, so the PR
// lazily created at propose time was born "<user>'s changes · auto-title
// pending". A session update now stores it (proposed_pr_title), and the
// promote path hands it to pr-metadata as preferredTitle. A target that
// already has a PR is RENAMED instead — the author's fix for a wrong
// auto-generated name ("Initialize repository" over a Klondike rebuild,
// PR #171) — with the votes untouched, exactly as the title-heal sweeper
// already renames under a standing tally.

test('a session update stores the submitted title for the lazily-created PR', async () => {
  const log = {};
  const titles = [];
  const session = sessionRow('paused');
  const pool = fakePool([
    ['SET proposed_pr_title', (params) => { titles.push(params); return []; }],
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['UPDATE chat_sessions', [{ id: session.id }]],
    ['INSERT INTO chat_session_messages', []],
  ]);
  const result = await runSession('paused', { session, pool }, log,
    { title: '  Klondike Solitaire:   canvas board for mobile  ' });
  assert.equal(result.ok, true);
  assert.equal(result.titleUpdated, true);
  assert.deepEqual(titles[0], ['Klondike Solitaire: canvas board for mobile', 501],
    'trimmed and single-spaced, the shape the PR will carry');
  assert.equal(session.proposed_pr_title, 'Klondike Solitaire: canvas board for mobile',
    'the in-memory row is mutated too — promote reads it off the session');
});

test('a same-commit resubmit is how a title correction arrives', async () => {
  // The update that should have carried the title may already have landed —
  // same reasoning as #1199's capture routes, applied to the name.
  const log = {};
  const titles = [];
  const session = sessionRow('paused');
  const pool = fakePool([
    ['SET proposed_pr_title', (params) => { titles.push(params); return []; }],
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['UPDATE chat_sessions', [{ id: session.id }]],
  ]);
  const result = await runSession('paused',
    { session, pool, gh: { getBranchSha: async () => FORK_HEAD } }, log,
    { title: 'Klondike Solitaire: canvas board for mobile' });
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.titleUpdated, true);
  assert.equal(titles.length, 1);

  // And repeating the stored value is a no-op, not a rewrite.
  const log2 = {};
  const titles2 = [];
  const session2 = sessionRow('paused', { proposed_pr_title: 'Klondike Solitaire: canvas board for mobile' });
  const pool2 = fakePool([
    ['SET proposed_pr_title', (params) => { titles2.push(params); return []; }],
    ['FROM chat_sessions cs JOIN apps a', [session2]],
    ['UPDATE chat_sessions', [{ id: session2.id }]],
  ]);
  const r2 = await runSession('paused',
    { session: session2, pool: pool2, gh: { getBranchSha: async () => FORK_HEAD } }, log2,
    { title: 'Klondike Solitaire: canvas board for mobile' });
  assert.equal(r2.ok, true);
  assert.equal(r2.titleUpdated, false);
  assert.equal(titles2.length, 0);
});

test('a same-commit resubmit with a title renames an existing PR, votes untouched', async () => {
  // The PR #171 case: the auto-titler landed "Initialize repository" on a
  // promoted proposal, and the author's agent resubmits the same commit
  // with the real name.
  const log = {};
  const renames = [];
  const ghRenames = [];
  const session = nativeSession({ pr_title: 'Initialize repository', pr_title_fallback: false });
  const pool = fakePool([
    ['SET pr_title', (params) => { renames.push(params); return []; }],
    ['FROM chat_sessions cs JOIN apps a', [session]],
  ]);
  const result = await run({
    session, pool,
    gh: {
      getBranchSha: async () => FORK_HEAD,
      updatePR: async (...args) => { ghRenames.push(args); },
    },
  }, { title: '  Klondike Solitaire:   canvas board for mobile  ' }, log);
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(result.titleUpdated, true);
  assert.equal(result.votesCleared, 0, 'a rename is not a code change — the tally stands');
  assert.deepEqual(renames[0], ['Klondike Solitaire: canvas board for mobile', 501]);
  assert.equal(session.pr_title, 'Klondike Solitaire: canvas board for mobile');
  assert.equal(session.session_title, 'Klondike Solitaire: canvas board for mobile');
  assert.equal(session.pr_title_fallback, false,
    'the heal sweeper must not re-rename a deliberate name');
  assert.deepEqual(ghRenames[0], ['o', 'r', 42, { title: 'Klondike Solitaire: canvas board for mobile' }],
    'the GitHub PR is renamed too');
  assert.ok(!sqlsOf(log).some((s) => /proposed_pr_title/.test(s)),
    'a row with a PR is renamed directly — nothing is deferred to a promote that already happened');

  // Repeating the current title is a no-op.
  const log2 = {};
  const session2 = nativeSession({ pr_title: 'Initialize repository' });
  const pool2 = fakePool([['FROM chat_sessions cs JOIN apps a', [session2]]]);
  const r2 = await run({
    session: session2, pool: pool2,
    gh: { getBranchSha: async () => FORK_HEAD, updatePR: async () => { throw new Error('must not run'); } },
  }, { title: 'Initialize repository' }, log2);
  assert.equal(r2.titleUpdated, false);
  // #1319. WHOSE pull request it is decides the rename — not whether the row
  // is imported. Reading the source alone disabled the rename for every
  // proposal an agent pushes from its author's own fork, because
  // branchHomeOf marks a row 'user_fork' only when it IS imported.
  const fn = CODE.slice(
    CODE.indexOf('async function applyProposedTitle'),
    CODE.indexOf('async function applyTestingMetadata')
  );
  assert.match(fn, /callerOwnsPr/, 'the rename asks whose PR it is');
  assert.doesNotMatch(fn, /=== 'imported'/,
    'source alone is not the question — it is true of every fork-tracked proposal');
});

test('a GitHub rename failure keeps the panel rename and never fails the update', async () => {
  const log = {};
  const renames = [];
  const session = nativeSession({ pr_title: 'Initialize repository' });
  const pool = fakePool([
    ['SET pr_title', (params) => { renames.push(params); return []; }],
    ['FROM chat_sessions cs JOIN apps a', [session]],
  ]);
  const result = await run({
    session, pool,
    gh: {
      getBranchSha: async () => FORK_HEAD,
      updatePR: async () => { throw new Error('GitHub is down'); },
    },
  }, { title: 'Klondike Solitaire: canvas board for mobile' }, log);
  assert.equal(result.ok, true);
  assert.equal(result.titleUpdated, true, 'the panel — what voters see — is renamed either way');
  assert.equal(renames.length, 1);
});

// #1319. The rename reached applyProposedTitle and stopped there for the
// entire external-agent path. `branchHomeOf` marks a row 'user_fork' ONLY
// when `source === 'imported'`, so the "imported PRs keep their external
// author's title" guard skipped every proposal an agent had pushed from its
// author's OWN fork — the ordinary shape of connector work. Game Corner's
// PR #173 grew from one game's board to a migration of all 33 plus their
// controls; three submit_work calls carrying the new title were accepted,
// dropped, and reported as success, and the group kept voting under the old
// name. The fork path made it worse: it never called applyProposedTitle at
// all, so the ordinary head-moving update dropped the name too.

test('a fork-tracked proposal is the author\'s own, and its title is theirs to fix', async () => {
  const log = {};
  const renames = [];
  const ghRenames = [];
  // The agent's own shape: an imported row whose head branch lives in the
  // fork owned by the caller's verified GitHub login.
  const session = importedSession({
    imported_pr_head_repo: 'evan-gh/r',
    pr_title: 'Canvas wave 1: Spider and Mahjong boards',
  });
  const pool = fakePool([
    ['SET pr_title', (params) => { renames.push(params); return []; }],
    ['FROM chat_sessions cs JOIN apps a', [session]],
  ]);
  const result = await run({
    session, pool,
    gh: {
      getBranchSha: async () => NATIVE_HEAD,
      updatePR: async (...args) => { ghRenames.push(args); },
    },
  }, { branch: 'usernode/add-a-button', title: 'Canvas everywhere: boards and controls' }, log);
  assert.equal(result.ok, true);
  assert.equal(result.titleUpdated, true, 'the author renames their own proposal');
  assert.equal(result.titleRejected, undefined);
  assert.equal(result.votesCleared, 0, 'a rename moves no code');
  assert.deepEqual(renames[0], ['Canvas everywhere: boards and controls', 601]);
  assert.equal(session.pr_title, 'Canvas everywhere: boards and controls');
  assert.deepEqual(ghRenames[0], ['o', 'r', 91, { title: 'Canvas everywhere: boards and controls' }]);
});

test('somebody else\'s pull request keeps its title, and the caller is TOLD it did', async () => {
  const log = {};
  // The head branch is in a repository the caller does not own — a genuine
  // outside contribution imported onto the board.
  const session = importedSession({
    imported_pr_head_repo: 'other-person/r',
    pr_title: 'Their own name for it',
  });
  const pool = fakePool([['FROM chat_sessions cs JOIN apps a', [session]]]);
  const result = await run({
    session, pool,
    gh: {
      getBranchSha: async () => NATIVE_HEAD,
      updatePR: async () => { throw new Error('must not rename an external author\'s PR'); },
    },
  }, { branch: 'usernode/add-a-button', title: 'A name of my own choosing' }, log);
  assert.equal(result.ok, true);
  assert.equal(result.titleUpdated, false);
  assert.equal(result.titleRejected, 'imported_pr',
    'a refusal reported as success is what made this invisible for three attempts');
  assert.equal(session.pr_title, 'Their own name for it');
});

test('the fork path applies the title when the head MOVES, not only on a resubmit', async () => {
  const log = {};
  const renames = [];
  const session = importedSession({
    imported_pr_head_repo: 'evan-gh/r',
    pr_title: 'Canvas wave 1: Spider and Mahjong boards',
  });
  const pool = fakePool([
    ['SET pr_title', (params) => { renames.push(params); return []; }],
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['FROM pr_votes', [{ n: 2 }]],
  ]);
  const result = await run({
    session, pool,
    // A new commit on the fork branch: the ordinary way an agent revises.
    gh: {
      getBranchSha: async () => FORK_HEAD,
      updatePR: async () => {},
    },
  }, { branch: 'usernode/add-a-button', title: 'Canvas everywhere: boards and controls' }, log);
  assert.equal(result.ok, true);
  assert.equal(result.submittedVia, 'update_fork_head');
  assert.equal(result.titleUpdated, true,
    'an update that moves the head carries the name with it');
  assert.deepEqual(renames[0], ['Canvas everywhere: boards and controls', 601]);

  // Structural, so the call cannot be dropped from the path again — the same
  // guard #1310 keeps over applyLinkedIssues.
  const fork = CODE.slice(
    CODE.indexOf('async function advanceForkHead'),
    CODE.indexOf('async function checkAncestry')
  );
  assert.match(fork, /applyProposedTitle/, 'the fork path applies the submitted title');
  assert.match(fork, /titleUpdated/, 'and reports whether it landed');
});

// ── #1323: the description, and asking for a re-check ──────────────────
//
// submit_work has always ACCEPTED a description on an update and, until now,
// submitUpdate never forwarded it — so the body the group votes on kept
// whatever the FIRST submission said, silently. Same shape as the title bug
// (#1319), on the surface that matters more. And the only way to get a fresh
// verdict on an unchanged commit was to CHANGE a capture route, because the
// re-run sat behind the testing-metadata early return.

test('an author\'s description rewrites the PR body and keeps its managed blocks', async () => {
  const log = {};
  const bodies = [];
  const mirrors = [];
  const session = importedSession({ imported_pr_head_repo: 'evan-gh/r' });
  const pool = fakePool([
    ['SET pr_body', (params) => { mirrors.push(params); return []; }],
    ['FROM chat_sessions cs JOIN apps a', [session]],
  ]);
  const result = await run({
    session, pool,
    gh: {
      getBranchSha: async () => NATIVE_HEAD,
      getPR: async () => ({
        state: 'open', merged: false, html_url: 'https://github.com/o/r/pull/91',
        head: { ref: 'usernode/add-a-button', sha: FORK_HEAD, repo: { owner: { login: 'evan-gh' } } },
        body: 'The old description.\n\nCloses #91\n\n<!-- usernode:visuals -->\nBEFORE/AFTER\n<!-- /usernode:visuals -->',
      }),
      updatePR: async (o, r, n, patch) => { bodies.push(patch); },
    },
  }, { branch: 'usernode/add-a-button', description: '  The new description.  ' }, log);

  assert.equal(result.ok, true);
  assert.equal(result.descriptionUpdated, true);
  assert.equal(result.descriptionRejected, undefined);
  assert.equal(result.votesCleared, 0, 'rewriting prose moves no code');
  const written = bodies[0].body;
  assert.match(written, /The new description\./);
  assert.doesNotMatch(written, /The old description/);
  // The two managed blocks SURVIVE. Dropping the visuals block would delete
  // the before/after screenshots the group is looking at — a worse bug than
  // the one being fixed.
  assert.match(written, /<!-- usernode:visuals -->[\s\S]*BEFORE\/AFTER[\s\S]*<!-- \/usernode:visuals -->/);
  assert.match(written, /Closes #91/);
  assert.equal(mirrors[0][0], written, 'and the row mirrors it so get_proposal can report it');
});

test('somebody else\'s pull request keeps its body, and the caller is told', async () => {
  const log = {};
  const session = importedSession({ imported_pr_head_repo: 'other-person/r' });
  const pool = fakePool([['FROM chat_sessions cs JOIN apps a', [session]]]);
  const result = await run({
    session, pool,
    gh: {
      getBranchSha: async () => NATIVE_HEAD,
      updatePR: async () => { throw new Error('must not rewrite an external author\'s body'); },
    },
  }, { branch: 'usernode/add-a-button', description: 'Mine now' }, log);
  assert.equal(result.ok, true);
  assert.equal(result.descriptionUpdated, false);
  assert.equal(result.descriptionRejected, 'imported_pr');
});

test('recheck re-runs the checks on a commit that did not move', async () => {
  const log = {};
  const session = nativeSession();
  const pool = fakePool([['FROM chat_sessions cs JOIN apps a', [session]]]);
  const rechecks = [];
  const result = await run({
    session, pool,
    gh: { getBranchSha: async () => FORK_HEAD },
    recovery: { recheckSessionChecks: async (args) => { rechecks.push(args.reason); return true; } },
  }, { recheck: true }, log);

  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true, 'no commit moved');
  assert.equal(result.votesCleared, 0, 'and no vote was cast on anything different');
  assert.equal(result.checksRerun, true);
  assert.equal(rechecks.length, 1, 'the same run the "Re-run checks" button performs');

  // Without it, an unchanged resubmit that changes no testing metadata still
  // re-runs NOTHING — the early return this flag exists to reach past.
  const quiet = [];
  const session2 = nativeSession();
  const r2 = await run({
    session: session2,
    pool: fakePool([['FROM chat_sessions cs JOIN apps a', [session2]]]),
    gh: { getBranchSha: async () => FORK_HEAD },
    recovery: { recheckSessionChecks: async () => { quiet.push(1); return true; } },
  }, {}, {});
  assert.notEqual(r2.checksRerun, true, 'the base reports it plainly as not re-run');
  assert.equal(quiet.length, 0, 'and nothing was asked to run');
});

// ── 13. The request linkage (#1310) ────────────────────────────────────
//
// #1217 linked a proposal to the request it implements — `Closes #N` in the
// PR body, `chat_sessions.linked_issues` on the row — but only on the CREATE
// path. An update dropped the task's request number on the floor, the same
// shape of loss #1199 names for the capture routes. The failure that shipped:
// a work-order continuation of a dev SESSION has no PR yet, its PR is built
// at promote time from chat_sessions.linked_issues, and nothing had written
// them — so the PR opened without its closing line, GitHub never linked the
// issue, and it had to be closed by hand after the merge (recipebot #45).

test('applyLinkedIssues: a row with no PR stores the union and touches GitHub not at all', async () => {
  const writes = [];
  const pool = fakePool([
    ['SET linked_issues', (params) => { writes.push(params); return []; }],
  ]);
  const session = { id: 3430, source: 'native', linked_issues: [], pr_number: null };
  const gh = { getPR: async () => { throw new Error('must not run'); } };
  const changed = await svc.applyLinkedIssues({
    pool, gh, session, owner: 'o', repo: 'r', linkedIssues: [45],
  });
  assert.equal(changed, true);
  assert.deepEqual(session.linked_issues, [45],
    'promote reads THIS object when it assembles the PR — the in-memory row must not lag the write');
  assert.deepEqual(writes, [[[45], 3430]]);
});

test('applyLinkedIssues: omission is not erasure, and a number already linked is a no-op', async () => {
  const pool = { query: async () => { throw new Error('must not run'); } };
  const session = { id: 1, source: 'native', linked_issues: [45], pr_number: null };
  const gh = {};
  assert.equal(await svc.applyLinkedIssues({ pool, gh, session, owner: 'o', repo: 'r', linkedIssues: [] }), false);
  assert.equal(await svc.applyLinkedIssues({ pool, gh, session, owner: 'o', repo: 'r' }), false);
  assert.equal(await svc.applyLinkedIssues({ pool, gh, session, owner: 'o', repo: 'r', linkedIssues: [45] }), false);
  assert.deepEqual(session.linked_issues, [45], 'nothing was removed and nothing was doubled');
});

test('applyLinkedIssues: a live PR gets the closing line appended, hand-written keywords not doubled', async () => {
  const writes = [];
  const bodies = [];
  const pool = fakePool([
    ['SET linked_issues', (params) => { writes.push(['linked', params]); return []; }],
    ['SET pr_linked_issues_applied', (params) => { writes.push(['applied', params]); return []; }],
  ]);
  const session = {
    id: 501, source: 'native', linked_issues: [], pr_number: 42, pr_linked_issues_applied: [],
  };
  const gh = {
    getPR: async () => ({ state: 'open', merged: false, body: 'Adds the thing.\n\nFixes #7' }),
    updatePR: async (owner, repo, prNumber, patch) => { bodies.push(patch.body); },
  };
  const changed = await svc.applyLinkedIssues({
    pool, gh, session, owner: 'o', repo: 'r', linkedIssues: [7, 45],
  });
  assert.equal(changed, true);
  assert.deepEqual(session.linked_issues, [7, 45]);
  // #7 is already declared by the author's own "Fixes #7" — only #45 lands,
  // via the same parser the migrate-time backfill trusts.
  assert.deepEqual(bodies, ['Adds the thing.\n\nFixes #7\n\nCloses #45']);
  // But BOTH are recorded as reflected in the body, so pr-metadata's drift
  // gate does not rewrite a body that is already right.
  assert.deepEqual(session.pr_linked_issues_applied, [7, 45]);
});

test('applyLinkedIssues: a merged or closed PR is left alone — only an open body can still close anything', async () => {
  const pool = fakePool([
    ['SET linked_issues', () => []],
  ]);
  const session = { id: 501, source: 'native', linked_issues: [], pr_number: 42, pr_linked_issues_applied: [] };
  const gh = {
    getPR: async () => ({ state: 'closed', merged: true, body: '' }),
    updatePR: async () => { throw new Error('must not run'); },
  };
  assert.equal(await svc.applyLinkedIssues({ pool, gh, session, owner: 'o', repo: 'r', linkedIssues: [45] }), true);
  assert.deepEqual(session.pr_linked_issues_applied, [], 'nothing was pretended to be in the body');
});

test('applyLinkedIssues: an imported PR keeps its author\'s body — the row is still linked', async () => {
  const writes = [];
  const pool = fakePool([
    ['SET linked_issues', (params) => { writes.push(params); return []; }],
  ]);
  const session = { id: 601, source: 'imported', linked_issues: [], pr_number: 91 };
  const gh = { getPR: async () => { throw new Error('must not run'); } };
  assert.equal(await svc.applyLinkedIssues({ pool, gh, session, owner: 'o', repo: 'r', linkedIssues: [12] }), true);
  assert.deepEqual(session.linked_issues, [12],
    'the close watcher and the Dev board read the row, whoever owns the body');
});

test('applyLinkedIssues: neither a DB failure nor a GitHub failure escapes', async () => {
  // The write failing means the linkage did not take — say so, lie to nobody.
  const broken = fakePool([
    ['SET linked_issues', () => { throw new Error('column is on fire'); }],
  ]);
  const s1 = { id: 1, source: 'native', linked_issues: [], pr_number: null };
  assert.equal(await svc.applyLinkedIssues({
    pool: broken, gh: {}, session: s1, owner: 'o', repo: 'r', linkedIssues: [45],
  }), false);
  assert.deepEqual(s1.linked_issues, [], 'the in-memory row is not lied to either');

  // The body patch failing does NOT undo the stored linkage: the row is the
  // source of truth, and the drift gate catches the body up later.
  const pool = fakePool([
    ['SET linked_issues', () => []],
  ]);
  const s2 = { id: 2, source: 'native', linked_issues: [], pr_number: 42, pr_linked_issues_applied: [] };
  const gh = { getPR: async () => { throw new Error('GitHub is down'); } };
  assert.equal(await svc.applyLinkedIssues({
    pool, gh, session: s2, owner: 'o', repo: 'r', linkedIssues: [45],
  }), true);
  assert.deepEqual(s2.linked_issues, [45]);
  assert.deepEqual(s2.pr_linked_issues_applied, [], 'not marked applied when the body was never patched');
});

test('updateLinkedIssues: removals rewrite only Usernode-managed closing lines', async () => {
  const writes = [];
  const bodies = [];
  const pool = fakePool([
    ['SET linked_issues', (params) => { writes.push(['linked', params]); return []; }],
    ['SET pr_body', (params) => { writes.push(['body_mirror', params]); return []; }],
    ['SET pr_linked_issues_applied', (params) => { writes.push(['applied', params]); return []; }],
  ]);
  const session = {
    id: 501,
    source: 'native',
    linked_issues: [12, 18],
    pr_number: 42,
    pr_linked_issues_applied: [12, 18],
  };
  const gh = {
    getPR: async () => ({
      state: 'open', merged: false,
      body: 'Summary\n\nCloses #12\nCloses #18\n\nFixes #99',
    }),
    updatePR: async (_owner, _repo, _number, patch) => { bodies.push(patch.body); },
  };

  const result = await svc.updateLinkedIssues({
    pool, gh, session, owner: 'o', repo: 'r', addIssues: [27], removeIssues: [12],
  });

  assert.deepEqual(result, {
    changed: true,
    linkedIssues: [18, 27],
    addedIssues: [27],
    removedIssues: [12],
    prBodyUpdated: true,
    prBodyStatus: 'updated',
  });
  assert.deepEqual(bodies, ['Summary\n\nCloses #18\n\nFixes #99\n\nCloses #27']);
  assert.deepEqual(session.pr_linked_issues_applied, [18, 27]);
  assert.deepEqual(writes.map(([kind]) => kind), ['linked', 'body_mirror', 'applied']);
});

test('updateLinkedIssues: repeating a DB no-op repairs a previously missed PR body update', async () => {
  const writes = [];
  const pool = fakePool([
    ['SET pr_body', () => []],
    ['SET pr_linked_issues_applied', (params) => { writes.push(params); return []; }],
  ]);
  const session = {
    id: 501,
    source: 'native',
    linked_issues: [27],
    pr_number: 42,
    pr_linked_issues_applied: [],
  };
  let body = 'Summary';
  const gh = {
    getPR: async () => ({ state: 'open', merged: false, body }),
    updatePR: async (_owner, _repo, _number, patch) => { body = patch.body; },
  };

  const result = await svc.updateLinkedIssues({
    pool, gh, session, owner: 'o', repo: 'r', addIssues: [27], removeIssues: [],
  });

  assert.equal(result.changed, false, 'the durable association was already present');
  assert.equal(result.prBodyUpdated, true, 'the same delta still repairs GitHub');
  assert.equal(body, 'Summary\n\nCloses #27');
  assert.deepEqual(writes, [[[27], 501]]);
  assert.ok(!pool.queries.some(({ sql }) => sql.includes('SET linked_issues')),
    'a retry does not rewrite the source-of-truth column');
});

test('updateLinkedIssues: imported and closed PR bodies remain outside Usernode ownership', async () => {
  for (const [source, pr, status] of [
    ['imported', null, 'imported_pr'],
    ['native', { state: 'closed', merged: false, body: 'Closes #12' }, 'pr_not_open'],
  ]) {
    let githubWrites = 0;
    const pool = fakePool([['SET linked_issues', () => []]]);
    const session = {
      id: 501, source, linked_issues: [12], pr_number: 42,
      pr_linked_issues_applied: [12],
    };
    const gh = {
      getPR: async () => {
        if (source === 'imported') throw new Error('must not read imported body');
        return pr;
      },
      updatePR: async () => { githubWrites++; },
    };
    const result = await svc.updateLinkedIssues({
      pool, gh, session, owner: 'o', repo: 'r', addIssues: [], removeIssues: [12],
    });
    assert.deepEqual(result.linkedIssues, []);
    assert.equal(result.prBodyStatus, status);
    assert.equal(githubWrites, 0);
  }
});

test('an update that carries linkedIssues stores them before the tails, on every path', async () => {
  // Behavioural half: the promoted-native path end to end.
  const log = {};
  const order = [];
  const session = nativeSession({ linked_issues: [], pr_linked_issues_applied: [] });
  const pool = fakePool([
    ['FROM chat_sessions cs JOIN apps a', [session]],
    ['FROM pr_votes', [{ n: 4 }]],
    ['SET linked_issues', (params) => { order.push(['linked', params]); return []; }],
    ['SET pr_linked_issues_applied', () => []],
  ]);
  const result = await run({
    session, pool,
    gh: {
      getPR: async () => ({ state: 'open', merged: false, body: 'Dev session by evan via Homeroom' }),
      updatePR: async (owner, repo, prNumber, patch) => { order.push(['body', patch.body]); },
    },
    votes: {
      reconcileNativeReviewedHead: async () => { order.push(['reconcile']); return { updated: true }; },
    },
  }, { linkedIssues: [45] }, log);
  assert.equal(result.ok, true);
  assert.equal(result.linkedIssuesUpdated, true);
  assert.deepEqual(session.linked_issues, [45]);
  assert.deepEqual(order.map((o) => o[0]), ['linked', 'body', 'reconcile'],
    'stored, then the live body patched, then the tail — never the other way round');
  assert.equal(order[1][1], 'Dev session by evan via Homeroom\n\nCloses #45');

  // Source half, for the ORDER on the paths the stubs above do not read
  // (same reasoning as the testing-metadata order test).
  const fn = CODE.slice(
    CODE.indexOf('async function advanceAppRepoBranch'),
    CODE.indexOf('async function settleActiveSession')
  );
  const applied = fn.indexOf('applyLinkedIssues');
  assert.ok(applied > 0, 'the app-repo path stores the linkage');
  for (const tail of ['syncImportedProposal', 'settleActiveSession', 'settlePausedSession', 'reconcileNativeReviewedHead']) {
    assert.ok(fn.indexOf(tail) > applied, `${tail} runs after the linkage is stored`);
  }
  const resubmit = CODE.slice(
    CODE.indexOf('async function resubmitUnchanged'),
    CODE.indexOf('async function advanceAppRepoBranch')
  );
  assert.match(resubmit, /applyLinkedIssues/,
    'a same-commit resubmit is also how a dropped linkage arrives');
  const fork = CODE.slice(
    CODE.indexOf('async function advanceForkHead'),
    CODE.indexOf('async function checkAncestry')
  );
  assert.match(fork, /applyLinkedIssues/, 'an imported proposal is linked too');
});
