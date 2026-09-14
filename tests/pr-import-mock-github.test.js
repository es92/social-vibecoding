// Unit tests for #687 — the staging mock-GitHub adapter and the sync
// poller driving off it (the mock is selected whenever
// USERNODE_ENV === 'staging'; production always uses the real client). Covers:
//   - github-mock: candidates (listOpenPulls), getPR/listChangedFiles shape,
//     bumpHead advancing the head, mergePR success + exact-sha 409 refusal.
//   - pr-import-sync in mock mode: an unchanged head no-ops; after a simulated
//     push (bumpHead) the head-change path fires — tally cleared, re-review
//     note posted, checks recorded 'skipped' (no real build in mock mode).
//
// Run with: node --test tests/pr-import-mock-github.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// Fake the modules pr-import-sync pulls lazily (the worker unit env lacks
// their transitive deps: ws→'ws', visuals→'jsonwebtoken', etc.). github-mock
// and github are left REAL — the mock is the system under test, and github
// only supplies the HeadMovedError sentinel.
function fakeModule(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
  return exports;
}

const fakeWs = fakeModule('../src/services/ws', {
  sendSystemMessage: async () => {},
  pushVoteUpdate: () => {},
  pushSessionUpdate: () => {},
  broadcastGlobal: () => {},
});
const fakeVisuals = fakeModule('../src/services/visuals', {
  setChecksPending: async () => {},
  notifyChecksPending: () => {},
  storeChecksSkipped: async () => {},
  captureForSession: async () => {},
});
fakeModule('../src/services/staging', {
  buildAndDeployStaging: async () => ({ containerId: 'c', stagingUrl: 'u', hostname: 'h' }),
  verifyStagingEdge: async () => {},
});
fakeModule('../src/services/sync-main', {
  persistBehindMain: async () => {},
  persistConflictState: async () => {},
});
fakeModule('../src/services/staging-recovery', { recordStagingBootFailure: async () => {} });

const githubMock = require('../src/services/github-mock');
const prImportSync = require('../src/services/pr-import-sync');

// The mock client is selected whenever USERNODE_ENV === 'staging' (see
// usesMockGithubForImports in config.js) — run the body in staging.
function withStagingEnv(fn) {
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  return (async () => {
    try { return await fn(); }
    finally {
      if (prev === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prev;
    }
  })();
}

// Records every statement. The head install is a compare-and-swap on the
// row's pin (RETURNING the epoch), so it is answered the way Postgres would
// for a pin that still matches; everything else returns no rows.
function recordingPool() {
  const calls = [];
  let epoch = 0;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SET imported_pr_head_sha = \$1[\s\S]*RETURNING approval_epoch/.test(sql)) {
        if (params[2]) epoch += 1;
        return { rows: [{ approval_epoch: epoch }] };
      }
      return { rows: [] };
    },
  };
}

// ── github-mock adapter ───────────────────────────────────────────────

test('github-mock: isEnabled is always true (the mock is "connected")', () => {
  assert.equal(githubMock.isEnabled(), true);
});

test('github-mock: listOpenPulls returns the importable candidate catalog', async () => {
  githubMock._resetForTests();
  const pulls = await githubMock.listOpenPulls('acme', 'demo');
  assert.ok(pulls.length >= 2, 'at least two importable candidates');
  const numbers = pulls.map((p) => p.number);
  assert.ok(numbers.includes(9401) && numbers.includes(9402));
  for (const p of pulls) {
    assert.equal(p.state, 'open');
    assert.ok(p.head && p.head.sha, 'each candidate carries a head sha');
    assert.ok(p.user && p.user.login, 'each carries an author');
  }
});

test('github-mock: getPR + listChangedFiles produce a preview-shaped payload', async () => {
  githubMock._resetForTests();
  const pr = await githubMock.getPR('acme', 'demo', 9401);
  assert.equal(pr.number, 9401);
  assert.equal(pr.state, 'open');
  assert.equal(pr.base.ref, 'main');
  assert.equal(pr.head.sha, githubMock.currentHead(9401));
  assert.equal(pr.mergeable, true);
  const files = await githubMock.listChangedFiles('acme', 'demo', 'main...mock/x');
  assert.ok(Array.isArray(files) && files.length >= 1);
});

test('github-mock: bumpHead advances the head sha (simulated push)', () => {
  githubMock._resetForTests();
  const before = githubMock.currentHead(9401);
  const after = githubMock.bumpHead(9401);
  assert.notEqual(before, after, 'head sha changes after a push');
  assert.equal(githubMock.currentHead(9401), after);
});

test('github-mock: mergePR merges when the pinned sha matches the current head', async () => {
  githubMock._resetForTests();
  const head = githubMock.currentHead(9401);
  const res = await githubMock.mergePR('acme', 'demo', 9401, head);
  assert.equal(res.merged, true);
  assert.ok(res.sha && res.sha !== head, 'returns a distinct merge commit sha');
});

test('github-mock: mergePR refuses with HeadMovedError when the pinned sha is stale', async () => {
  githubMock._resetForTests();
  await assert.rejects(
    () => githubMock.mergePR('acme', 'demo', 9401, 'stale'.padEnd(40, '0')),
    (err) => {
      assert.equal(err.headMoved, true);
      assert.equal(err.name, 'HeadMovedError');
      return true;
    }
  );
});

// ── pr-import-sync driven by the mock ─────────────────────────────────

const PR = 9401;
function importedSession() {
  return {
    id: 55, app_id: 9, app_slug: 'demo', app_name: 'Demo',
    status: 'promoted',
    source: 'imported', pr_number: PR, pr_title: 'Mock imported PR',
    branch_name: 'mock/importable-widget', repo_url: 'https://github.com/acme/demo',
    imported_pr_head_sha: null, // set per test
  };
}

test('pr-import-sync (mock): unchanged head no-ops', async () => {
  githubMock._resetForTests();
  await withStagingEnv(async () => {
    const session = importedSession();
    session.imported_pr_head_sha = githubMock.currentHead(PR); // matches rev-0
    const pool = recordingPool();
    const res = await prImportSync.syncImportedProposal({ config: {}, pool, session });
    assert.equal(res, 'unchanged');
    assert.equal(pool.calls.length, 0, 'no writes on an unchanged head');
  });
});

test('pr-import-sync (mock): a simulated push resets the tally + records skipped checks', async () => {
  githubMock._resetForTests();
  await withStagingEnv(async () => {
    const session = importedSession();
    session.imported_pr_head_sha = githubMock.currentHead(PR); // rev 0

    // Simulate the external author pushing a new commit.
    const newHead = githubMock.bumpHead(PR);

    const sysMessages = [];
    let skippedSha = null;
    const origSend = fakeWs.sendSystemMessage;
    const origSkip = fakeVisuals.storeChecksSkipped;
    fakeWs.sendSystemMessage = async (_pool, _appId, content, _t, _m, thread) => {
      sysMessages.push({ content, thread });
    };
    fakeVisuals.storeChecksSkipped = async (_pool, _sid, sha) => { skippedSha = sha; };
    try {
      const pool = recordingPool();
      const res = await prImportSync.syncImportedProposal({ config: {}, pool, session });
      assert.equal(res, 'updated');

      const headUpdate = pool.calls.find((c) => /SET imported_pr_head_sha = \$1/.test(c.sql));
      assert.ok(headUpdate, 'stored head advanced');
      assert.equal(headUpdate.params[0], newHead);
      assert.match(headUpdate.sql, /approval_epoch = approval_epoch \+ CASE WHEN \$3::boolean THEN 1 ELSE 0 END/);
      assert.equal(headUpdate.params[2], true,
        'tally cleared by moving the epoch on (#2038) rather than deleting rows — a mock push is an author push');

      assert.equal(sysMessages.length, 1, 'one re-review note');
      assert.match(sysMessages[0].content, /updated on GitHub/i);
      assert.match(sysMessages[0].content, /re-review/i);
      assert.deepEqual(sysMessages[0].thread, { type: 'session', ref: 55 });

      // Mock mode records a gate-passing 'skipped' verdict — no real build.
      assert.equal(skippedSha, newHead, 'checks re-recorded as skipped against the new head');
    } finally {
      fakeWs.sendSystemMessage = origSend;
      fakeVisuals.storeChecksSkipped = origSkip;
    }
  });
});

test('pr-import-sync: mock is NOT used outside staging (real github, disabled → skipped)', async () => {
  githubMock._resetForTests();
  const prev = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'production'; // real client selected
  try {
    const session = importedSession();
    session.imported_pr_head_sha = 'whatever';
    const pool = recordingPool();
    // Real github.isEnabled() is false in this unit env (no App creds) → the
    // poller short-circuits to 'skipped' without touching the mock.
    const res = await prImportSync.syncImportedProposal({ config: {}, pool, session });
    assert.equal(res, 'skipped');
    assert.equal(pool.calls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prev;
  }
});

// #866 — the mock fleet needs a fork-headed PR in it. Fork imports are the
// case the SHA-pinned clone exists for, and the import picker's "from a fork"
// label is derived by comparing head.repo.full_name with base.repo.full_name;
// without a candidate where those differ, neither is reviewable on staging.
test('mock candidates include a fork-headed PR, and same-repo PRs stay same-repo', async () => {
  githubMock._resetForTests();
  const pulls = await githubMock.listOpenPulls('acme', 'widget');

  const fork = pulls.find((p) => p.number === 9403);
  assert.ok(fork, 'a fork-headed candidate is seeded');
  assert.equal(fork.base.repo.full_name, 'acme/widget');
  assert.equal(fork.head.repo.full_name, 'octo-forker/usernode-mock-fork');
  assert.notEqual(fork.head.repo.full_name, fork.base.repo.full_name,
    'this is exactly the comparison the fork label and the PR-ref clone key off');
  assert.equal(fork.head.repo.fork, true);

  for (const n of [9401, 9402]) {
    const p = pulls.find((x) => x.number === n);
    assert.ok(p, `candidate ${n} still listed`);
    assert.equal(p.head.repo.full_name, p.base.repo.full_name,
      'a same-repo candidate must not be mislabelled as a fork');
  }

  // getPR (the path the preview route and the poller use) agrees.
  const one = await githubMock.getPR('acme', 'widget', 9403);
  assert.equal(one.head.repo.full_name, 'octo-forker/usernode-mock-fork');
  assert.equal(one.base.repo.full_name, 'acme/widget');
});
