// Unit tests for #687 Slice 3 — the imported-PR sync poller, the
// head-change vote-tally reset, and revision-scoped approval counting.
//
// Covers (spec "Tests"):
//   - governedGate/qualifiedCounts head-scoping: an imported proposal's
//     gate counts only approvals cast against the CURRENT head SHA, so a
//     superseded head's approvals are ignored;
//   - syncImportedProposal: no-op on an unchanged head; on a head change it
//     advances imported_pr_head_sha, CLEARS the tally, posts the re-review
//     note, refreshes drift, and re-runs checks pinned to the new head;
//   - non-imported rows are skipped without any DB work.
//
// Run with: node --test tests/pr-import-sync.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const governance = require('../src/services/governance');
const config = require('../src/config');

// The client picker (usesMockGithubForImports) selects the in-memory mock
// GitHub source when USERNODE_ENV === 'staging'. These tests exercise the
// REAL-client path via the fakeGithub stub below, so pin the env to
// production regardless of what the harness set.
process.env.USERNODE_ENV = 'production';

// The worker's unit environment ships a minimal node_modules (no `ws`,
// `jsonwebtoken`, etc.), so several service modules can't be require()'d for
// real here. pr-import-sync pulls all of its heavy collaborators lazily via
// require('./x') at call time, and binds `github` at module load, so we
// pre-seed the module cache with controllable fakes BEFORE requiring
// pr-import-sync. Tests replace individual methods on these fakes to script
// GitHub responses and observe side effects.
function fakeModule(relPath, exports) {
  const p = require.resolve(relPath);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
  return exports;
}

const fakeGithub = fakeModule('../src/services/github', {
  isEnabled: () => true,
  getPR: async () => ({}),
  getOctokit: async () => ({ rest: { repos: { compareCommits: async () => ({ data: { behind_by: 0 } }) } } }),
});
const fakeWs = fakeModule('../src/services/ws', {
  sendSystemMessage: async () => {},
  pushVoteUpdate: () => {},
  pushSessionUpdate: () => {},
  broadcastGlobal: () => {},
});
fakeModule('../src/services/visuals', {
  setChecksPending: async () => {},
  notifyChecksPending: () => {},
  captureForSession: async () => {},
});
fakeModule('../src/services/staging', {
  buildAndDeployStaging: async () => ({ containerId: 'c', stagingUrl: 'u', hostname: 'h' }),
  verifyStagingEdge: async () => {},
});
const fakeSyncMain = fakeModule('../src/services/sync-main', {
  // Mirror the real persistBehindMain's DB write so the recording pool
  // captures it (the test asserts drift is refreshed).
  persistBehindMain: async (pool, session, n) => {
    await pool.query('UPDATE chat_sessions SET behind_main = $1 WHERE id = $2', [n, session.id]);
  },
  persistConflictState: async () => {},
});
fakeModule('../src/services/staging-recovery', {
  recordStagingBootFailure: async () => {},
});
// The head-move classifier (#2038) redoes the merge from the app's mirror.
// Neither a mirror nor git belongs in this suite: `scriptedMove` is what the
// classifier answers, and the mirror fake records the branch it was asked to
// resolve. tests/integration-classify.test.js drives the real classifier.
let scriptedMove = { kind: 'authored' };
let mirrorBranchHead = null;
const fakeMirror = fakeModule('../src/services/repo-mirror', {
  ensureMirror: async () => '/nonexistent/mirror',
  defaultBranchSha: async () => 'f'.repeat(40),
  resolveBranch: async () => mirrorBranchHead,
});
fakeModule('../src/services/integration', {
  _parseRepo: (url) => {
    const [, owner, repo] = (url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    return owner && repo ? { owner, repo } : null;
  },
  classifyHeadMove: async () => scriptedMove,
});

const fakeVisuals = require('../src/services/visuals');
const fakeStaging = require('../src/services/staging');
const fakeRecovery = require('../src/services/staging-recovery');
const prImportSync = require('../src/services/pr-import-sync');

// ── governedGate head-scoping ─────────────────────────────────────────
//
// A scripted pool that answers the governance queries AND honours the
// optional `head_sha = $N` predicate Slice 3 threads into qualifiedCounts.
// Votes carry an optional `headSha`; when the gate is head-scoped only
// matching votes count.
function mockPool({ policy, atLeast, members, admins, votes, activeCount, epoch = 0 }) {
  return {
    query: async (sql, params) => {
      if (/SELECT approver_policy, approvals_required FROM apps/.test(sql)) {
        return { rows: [{ approver_policy: policy, approvals_required: atLeast }] };
      }
      if (/SELECT user_id FROM app_approvers/.test(sql)) {
        return { rows: (members || []).map((id) => ({ user_id: id })) };
      }
      if (/SELECT id FROM users WHERE is_admin = TRUE/.test(sql)) {
        return { rows: (admins || []).map((id) => ({ id })) };
      }
      if (/FILTER \(WHERE vote = /.test(sql)) {
        // Restricted electorate. #2038: scoped by approval epoch, which is a
        // scalar subquery rather than a bound parameter — so the mock keys on
        // the vote's own epoch against the session's.
        const allowed = params[1];
        const scoped = /approval_epoch = \(SELECT approval_epoch/.test(sql);
        const counted = (votes || []).filter((v) =>
          allowed.includes(v.userId) && (!scoped || (v.epoch ?? 0) === (epoch ?? 0)));
        return {
          rows: [{
            yes: String(counted.filter((v) => v.vote === 'yes').length),
            no: String(counted.filter((v) => v.vote === 'no').length),
          }],
        };
      }
      if (/SELECT COUNT\(\*\) as cnt FROM (pr_votes|issue_votes)/.test(sql)) {
        // Unrestricted electorate, same epoch scoping as above.
        const side = /vote = 'yes'/.test(sql) ? 'yes' : 'no';
        const scoped = /approval_epoch = \(SELECT approval_epoch/.test(sql);
        const counted = (votes || []).filter((v) =>
          v.vote === side && (!scoped || (v.epoch ?? 0) === (epoch ?? 0)));
        return { rows: [{ cnt: String(counted.length) }] };
      }
      if (/SELECT self_hosted, collab_visibility FROM apps/.test(sql)) {
        return { rows: [{ self_hosted: false, collab_visibility: 'public' }] };
      }
      if (/COUNT\(DISTINCT a\.user_id\) AS cnt/.test(sql)) {
        return { rows: [{ cnt: String(activeCount || 0) }] };
      }
      return { rows: [] };
    },
  };
}

let nextAppId = 5000;

test('governedGate: an imported gate counts only approvals from the current epoch', async () => {
  // An imported head moving is always an author push — the platform does not
  // write to the author's fork — so services/pr-import-sync.js moves the
  // epoch on, and the approvals cast before it stop counting.
  const appId = nextAppId++;
  const pool = mockPool({
    policy: 'invited', atLeast: 1, activeCount: 50,
    members: [10, 11], epoch: 1,
    votes: [
      { userId: 10, vote: 'yes', epoch: 0 },
      { userId: 11, vote: 'yes', epoch: 1 },
    ],
  });
  const gate = await governance.governedGate(pool, appId, {
    kind: 'pr', id: 42, openedAt: Date.now(),
  });
  assert.equal(gate.qualifiedYes, 1, 'only the current-epoch approval counts');
  assert.equal(gate.mergeable, true);
});

test('governedGate: a superseded approval alone does NOT satisfy the gate', async () => {
  const appId = nextAppId++;
  const pool = mockPool({
    policy: 'invited', atLeast: 1, activeCount: 50,
    members: [10, 11], epoch: 1,
    votes: [{ userId: 10, vote: 'yes', epoch: 0 }],
  });
  const gate = await governance.governedGate(pool, appId, {
    kind: 'pr', id: 43, openedAt: Date.now(),
  });
  assert.equal(gate.qualifiedYes, 0, 'the superseded approval is ignored');
  assert.equal(gate.mergeable, false, 'the change re-opened approval');
});

test('governedGate: approvals at the current epoch all count, whatever commit they saw', async () => {
  // The point of the change. Two people approved the same proposal while it
  // sat at two different commits — because the platform rebased it between
  // their clicks. Both approvals describe the same work, and both count.
  const appId = nextAppId++;
  const pool = mockPool({
    policy: 'invited', atLeast: 1, activeCount: 50,
    members: [10, 11], epoch: 2,
    votes: [
      { userId: 10, vote: 'yes', epoch: 2 },
      { userId: 11, vote: 'yes', epoch: 2 },
    ],
  });
  const gate = await governance.governedGate(pool, appId, {
    kind: 'pr', id: 44, openedAt: Date.now(),
  });
  assert.equal(gate.qualifiedYes, 2);
});

test('qualifiedCounts: the anyone policy is epoch-scoped too', async () => {
  const pool = mockPool({
    policy: 'anyone', atLeast: null, activeCount: 4, epoch: 1,
    votes: [
      { userId: 1, vote: 'yes', epoch: 1 },
      { userId: 2, vote: 'yes', epoch: 0 },
      { userId: 3, vote: 'no', epoch: 1 },
    ],
  });
  assert.deepEqual(await governance.qualifiedCounts(pool, 'pr', 7, null),
    { yes: 1, no: 1 }, 'only current-epoch votes count, under either policy');
});

test('issue votes are never epoch-scoped: they have no revision to go stale', async () => {
  // A governance proposal is not a branch. There is no commit for anybody to
  // push over, so scoping its votes would only ever hide valid ones. Asserted
  // on the SQL the counter builds rather than through the mock's vote shape,
  // which uses the up/down vocabulary and would test the fixture instead.
  const seen = [];
  const pool = {
    query: async (sql) => {
      seen.push(String(sql));
      if (/approver_policy/.test(sql)) return { rows: [{ approver_policy: 'anyone', approvals_required: null }] };
      return { rows: [{ cnt: '0', yes: '0', no: '0' }] };
    },
  };
  await governance.qualifiedCounts(pool, 'issue', 7, null);
  const counts = seen.filter((q) => /issue_votes/.test(q));
  assert.ok(counts.length > 0, 'it did count something');
  assert.ok(counts.every((q) => !/approval_epoch/.test(q)),
    'no epoch clause may reach an issue vote');
});


// ── syncImportedProposal ──────────────────────────────────────────────

// Save/restore individual fake methods so tests don't leak stubs.
function withStubs(stubs, fn) {
  const originals = stubs.map(([mod, key]) => [mod, key, mod[key]]);
  for (const [mod, key, val] of stubs) mod[key] = val;
  return (async () => {
    try { return await fn(); }
    finally { for (const [mod, key, val] of originals) mod[key] = val; }
  })();
}

const SESSION_HEAD = 'a'.repeat(40);

// `pinnedHead` is what the row's imported_pr_head_sha currently holds. The
// head install is a compare-and-swap on it (RETURNING the epoch), so the pool
// answers that statement the way Postgres would: a row iff the pin matched,
// with the epoch bumped iff the statement asked for it. Everything else
// records and returns no rows.
function recordingPool({ pinnedHead = SESSION_HEAD, epoch = 0 } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SET imported_pr_head_sha = \$1[\s\S]*RETURNING approval_epoch/.test(sql)) {
        const [, , bump] = params;
        const expectedOld = params[4];
        if (expectedOld !== pinnedHead) return { rows: [] };
        return { rows: [{ approval_epoch: epoch + (bump ? 1 : 0) }] };
      }
      return { rows: [] };
    },
  };
}

const SESSION = {
  id: 321, app_id: 9, app_slug: 'demo', app_name: 'Demo',
  status: 'promoted',
  source: 'imported', pr_number: 77, pr_title: 'External work',
  branch_name: 'feature/x', repo_url: 'https://github.com/acme/demo',
  imported_pr_head_sha: SESSION_HEAD,
  approval_epoch: 0,
};

test('syncImportedProposal: unchanged head no-ops (one getPR, no writes)', async () => {
  await withStubs([
    [fakeGithub, 'getPR', async () => ({ head: { sha: 'a'.repeat(40), ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true })],
  ], async () => {
    let getPrCalls = 0;
    const realGetPr = fakeGithub.getPR;
    fakeGithub.getPR = async (...a) => { getPrCalls++; return realGetPr(...a); };
    const pool = recordingPool();
    const res = await prImportSync.syncImportedProposal({ config: {}, pool, session: { ...SESSION } });
    assert.equal(res, 'unchanged');
    assert.equal(getPrCalls, 1);
    assert.equal(pool.calls.length, 0, 'unchanged head performs no writes');
  });
});

// ── #1365: a stranded conflict snapshot is re-derived on an unchanged head ──
//
// refreshDriftState only ran from applyHeadChange (head MOVED) and wrote
// nothing when GitHub answered `mergeable: null` — which is what GitHub
// returns for the first read after a push, i.e. exactly the read
// applyHeadChange makes. Its "the next sweep re-checks" could therefore never
// happen: every later sweep returned at the unchanged-head check first, so
// "Conflict resolution failed" stuck to a pull request that had since become
// a clean fast-forward.

test('syncImportedProposal: a stranded failed snapshot is re-derived once GitHub decides', async () => {
  const conflictWrites = [];
  await withStubs([
    [fakeGithub, 'getPR', async () => ({
      head: { sha: 'a'.repeat(40), ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true,
    })],
    [fakeSyncMain, 'persistConflictState', async (_pool, _session, snapshot) => {
      conflictWrites.push(snapshot);
    }],
  ], async () => {
    const pool = recordingPool();
    const res = await prImportSync.syncImportedProposal({
      config: {}, pool, session: { ...SESSION, merge_conflict_state: 'failed' },
    });
    assert.equal(res, 'unchanged', 'the head really has not moved');
    assert.deepEqual(
      conflictWrites.map((w) => w.state), ['clean'],
      'the resolved pull request is written back as clean without the head moving'
    );
  });
});

test('syncImportedProposal: a stranded conflict snapshot that is still conflicted stays conflicted', async () => {
  const conflictWrites = [];
  await withStubs([
    [fakeGithub, 'getPR', async () => ({
      head: { sha: 'a'.repeat(40), ref: 'feature/x' }, base: { ref: 'main' }, mergeable: false,
    })],
    [fakeSyncMain, 'persistConflictState', async (_pool, _session, snapshot) => {
      conflictWrites.push(snapshot);
    }],
  ], async () => {
    const pool = recordingPool();
    await prImportSync.syncImportedProposal({
      config: {}, pool, session: { ...SESSION, merge_conflict_state: 'conflict' },
    });
    assert.deepEqual(conflictWrites.map((w) => w.state), ['conflict']);
  });
});

test('syncImportedProposal: an undecided mergeable writes nothing and leaves it for the next sweep', async () => {
  const conflictWrites = [];
  await withStubs([
    [fakeGithub, 'getPR', async () => ({
      head: { sha: 'a'.repeat(40), ref: 'feature/x' }, base: { ref: 'main' }, mergeable: null,
    })],
    [fakeSyncMain, 'persistConflictState', async (_pool, _session, snapshot) => {
      conflictWrites.push(snapshot);
    }],
  ], async () => {
    const pool = recordingPool();
    await prImportSync.syncImportedProposal({
      config: {}, pool, session: { ...SESSION, merge_conflict_state: 'failed' },
    });
    assert.deepEqual(conflictWrites, [], 'nothing is written while GitHub is still computing');
    assert.equal(pool.calls.length, 0, 'and no drift query is paid for either');
  });
});

test('syncImportedProposal: a settled snapshot is not re-read on an unchanged head', async () => {
  for (const state of ['clean', 'behind', 'resolving', null]) {
    const conflictWrites = [];
    // eslint-disable-next-line no-await-in-loop
    await withStubs([
      [fakeGithub, 'getPR', async () => ({
        head: { sha: 'a'.repeat(40), ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true,
      })],
      [fakeSyncMain, 'persistConflictState', async (_pool, _session, snapshot) => {
        conflictWrites.push(snapshot);
      }],
    ], async () => {
      const pool = recordingPool();
      await prImportSync.syncImportedProposal({
        config: {}, pool, session: { ...SESSION, merge_conflict_state: state },
      });
      assert.deepEqual(conflictWrites, [], `${state} is settled — nothing to correct`);
      assert.equal(pool.calls.length, 0, `${state} costs no queries`);
    });
  }
});

test('syncImportedProposal: active imports refresh without vote reset or re-review copy', async () => {
  const NEW = 'c'.repeat(40);
  const sysMessages = [];
  let buildSha = null;
  await withStubs([
    [fakeGithub, 'getPR', async () => ({ head: { sha: NEW, ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true })],
    [fakeWs, 'sendSystemMessage', async (_pool, _appId, content) => { sysMessages.push(content); }],
    [fakeStaging, 'buildAndDeployStaging', async (_c, _s, _a, sha) => {
      buildSha = sha;
      return { containerId: 'cid', stagingUrl: 'https://s', hostname: 'h' };
    }],
  ], async () => {
    const pool = recordingPool();
    const res = await prImportSync.syncImportedProposal({
      config: {}, pool, session: { ...SESSION, status: 'active' },
    });
    assert.equal(res, 'updated');
    assert.equal(buildSha, NEW, 'preview follows the new GitHub head');
    assert.ok(!pool.calls.some((c) => /DELETE FROM pr_votes/.test(c.sql)),
      'an item not yet up for vote has no tally to clear');
    assert.equal(sysMessages.length, 1);
    assert.match(sysMessages[0], /preview and automated checks are being rebuilt/i);
    assert.doesNotMatch(sysMessages[0], /votes were cleared|re-review/i);
  });
});

test('syncImportedProposal: an authored push resets the tally, posts re-review, re-runs pinned checks', async () => {
  const NEW = 'b'.repeat(40);
  const sysMessages = [];
  let buildSha = null;
  let captureSha = null;
  scriptedMove = { kind: 'authored' };

  await withStubs([
    [fakeGithub, 'getPR', async () => ({ head: { sha: NEW, ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true })],
    [fakeGithub, 'getOctokit', async () => ({ rest: { repos: { compareCommits: async () => ({ data: { behind_by: 3 } }) } } })],
    [fakeWs, 'sendSystemMessage', async (_pool, _appId, content, msgType, meta, thread) => {
      sysMessages.push({ content, msgType, meta, thread });
    }],
    [fakeStaging, 'buildAndDeployStaging', async (_c, _s, _a, sha) => { buildSha = sha; return { containerId: 'cid', stagingUrl: 'https://s', hostname: 'h' }; }],
    [fakeVisuals, 'captureForSession', async (_c, _s, _a, sha) => { captureSha = sha; }],
  ], async () => {
    const pool = recordingPool();
    const res = await prImportSync.syncImportedProposal({ config: {}, pool, session: { ...SESSION } });
    assert.equal(res, 'updated');

    const headUpdate = pool.calls.find((c) => /SET imported_pr_head_sha = \$1/.test(c.sql));
    assert.ok(headUpdate, 'imported_pr_head_sha is advanced');
    assert.equal(headUpdate.params[0], NEW);
    assert.equal(headUpdate.params[2], true,
      'the tally is cleared by moving the epoch on IN THE SAME STATEMENT as the head install — '
      + 'no half-cleared window, and the votes survive as a record');
    assert.equal(headUpdate.params[4], SESSION_HEAD,
      'the install is a compare-and-swap on the pin the decision was made about');

    assert.equal(sysMessages.length, 1, 'exactly one re-review note');
    assert.match(sysMessages[0].content, /updated on GitHub/i);
    assert.match(sysMessages[0].content, /re-review/i);
    assert.deepEqual(sysMessages[0].thread, { type: 'session', ref: SESSION.id });
    assert.equal(sysMessages[0].meta.votesKept, false);
    // #866: the rebuild rides as an appended clause on that ONE note rather
    // than a second post — the card's Preview slot going back to
    // "building…" is a consequence of the same event.
    assert.match(sysMessages[0].content, /preview and automated checks are being rebuilt/i);

    const sqls = pool.calls.map((c) => c.sql);
    assert.ok(sqls.some((s) => /SET behind_main = \$1/.test(s)), 'behind_main refreshed');

    assert.equal(buildSha, NEW, 'staging build pinned to the new head SHA');
    assert.equal(captureSha, NEW, 'checks captured against the new head SHA');
  });
});

// ── #2100 / #2095: a platform sync is not an author push ──────────────
//
// The merge queue (#2038) brings an imported proposal up to date with main
// by pushing a merge commit onto its branch. The poller then sees a head
// move — and used to treat every one as the author changing the proposal:
// votes cleared, "please re-review" posted, a preview rebuilt, for a tree
// nobody had changed. The classifier now answers what the move cost, and a
// mechanical merge costs nothing.

test('syncImportedProposal: a mechanical sync keeps the votes and carries a settled verdict', async () => {
  const NEW = 'b'.repeat(40);
  const sysMessages = [];
  const voteUpdates = [];
  let built = false;
  scriptedMove = { kind: 'mechanical' };

  await withStubs([
    [fakeGithub, 'getPR', async () => ({ head: { sha: NEW, ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true })],
    [fakeWs, 'sendSystemMessage', async (_pool, _appId, content, msgType, meta) => { sysMessages.push({ content, meta }); }],
    [fakeWs, 'pushVoteUpdate', (u) => { voteUpdates.push(u); }],
    [fakeStaging, 'buildAndDeployStaging', async () => { built = true; return { containerId: 'cid', stagingUrl: 'https://s', hostname: 'h' }; }],
  ], async () => {
    const pool = recordingPool({ epoch: 4 });
    const session = { ...SESSION, approval_epoch: 4, checks_commit_sha: SESSION_HEAD, check_state: 'passing' };
    const res = await prImportSync.syncImportedProposal({ config: {}, pool, session });
    assert.equal(res, 'updated');

    const headUpdate = pool.calls.find((c) => /SET imported_pr_head_sha = \$1/.test(c.sql));
    assert.ok(headUpdate, 'the pin still advances — the next merge attempt must offer GitHub the live head');
    assert.equal(headUpdate.params[0], NEW);
    assert.equal(headUpdate.params[2], false, 'the epoch does NOT move: the votes still stand');
    assert.equal(headUpdate.params[3], true, 'the passing verdict is carried onto the merged commit');
    assert.equal(session.approval_epoch, 4);
    assert.equal(session.checks_commit_sha, NEW);

    assert.equal(built, false, 'nothing to rebuild: a mechanical merge is pure git over a tested branch and a tested main');
    assert.equal(sysMessages.length, 1);
    assert.match(sysMessages[0].content, /brought up to date with main/i);
    assert.match(sysMessages[0].content, /votes still stand/i);
    assert.doesNotMatch(sysMessages[0].content, /re-review|votes were cleared/i);
    assert.equal(sysMessages[0].meta.votesKept, true);
    assert.deepEqual(voteUpdates.map((u) => u.votesKept), [true], 'the card learns the tally survived');
  });
});

test('syncImportedProposal: a mechanical sync over a run still in flight rebuilds instead of carrying', async () => {
  // #1728's shape: carrying a 'pending' stamp forward would leave the row
  // pending with nothing building. Only a finished verdict rides along.
  const NEW = 'b'.repeat(40);
  let buildSha = null;
  scriptedMove = { kind: 'mechanical' };

  await withStubs([
    [fakeGithub, 'getPR', async () => ({ head: { sha: NEW, ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true })],
    [fakeStaging, 'buildAndDeployStaging', async (_c, _s, _a, sha) => { buildSha = sha; return { containerId: 'cid', stagingUrl: 'https://s', hostname: 'h' }; }],
  ], async () => {
    const pool = recordingPool({ epoch: 4 });
    const session = { ...SESSION, approval_epoch: 4, checks_commit_sha: SESSION_HEAD, check_state: 'pending' };
    await prImportSync.syncImportedProposal({ config: {}, pool, session });

    const headUpdate = pool.calls.find((c) => /SET imported_pr_head_sha = \$1/.test(c.sql));
    assert.equal(headUpdate.params[2], false, 'still no epoch bump — the tree is unchanged');
    assert.equal(headUpdate.params[3], false, 'but an unfinished verdict is not carried');
    assert.equal(buildSha, NEW, 'the checks re-run against the merged commit');
  });
});

test('syncImportedProposal: a resolved sync keeps the votes but re-tests the merged tree', async () => {
  const NEW = 'b'.repeat(40);
  const sysMessages = [];
  let buildSha = null;
  scriptedMove = { kind: 'resolved', conflictPaths: ['src/a.js', 'src/b.js'] };

  await withStubs([
    [fakeGithub, 'getPR', async () => ({ head: { sha: NEW, ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true })],
    [fakeWs, 'sendSystemMessage', async (_pool, _appId, content) => { sysMessages.push(content); }],
    [fakeStaging, 'buildAndDeployStaging', async (_c, _s, _a, sha) => { buildSha = sha; return { containerId: 'cid', stagingUrl: 'https://s', hostname: 'h' }; }],
  ], async () => {
    const pool = recordingPool({ epoch: 2 });
    const session = { ...SESSION, approval_epoch: 2, checks_commit_sha: SESSION_HEAD, check_state: 'passing' };
    await prImportSync.syncImportedProposal({ config: {}, pool, session });

    const headUpdate = pool.calls.find((c) => /SET imported_pr_head_sha = \$1/.test(c.sql));
    assert.equal(headUpdate.params[2], false, 'the votes survive an automatic resolution');
    assert.equal(headUpdate.params[3], false, 'a resolved tree is one nobody has tested: no carry');
    assert.equal(buildSha, NEW);
    assert.match(sysMessages[0], /2 conflicting files were resolved automatically/i);
    assert.match(sysMessages[0], /votes still stand/i);
  });
});

test('syncImportedProposal: a move the mirror cannot classify is treated as authored, and says so', async () => {
  const NEW = 'b'.repeat(40);
  const sysMessages = [];
  scriptedMove = { kind: 'unknown', reason: 'mirror unavailable' };

  await withStubs([
    [fakeGithub, 'getPR', async () => ({ head: { sha: NEW, ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true })],
    [fakeWs, 'sendSystemMessage', async (_pool, _appId, content) => { sysMessages.push(content); }],
  ], async () => {
    const pool = recordingPool();
    await prImportSync.syncImportedProposal({ config: {}, pool, session: { ...SESSION } });
    const headUpdate = pool.calls.find((c) => /SET imported_pr_head_sha = \$1/.test(c.sql));
    assert.equal(headUpdate.params[2], true, 'failing open here would let a real push inherit approvals');
    assert.match(sysMessages[0], /could not verify \(mirror unavailable\)/i);
    assert.match(sysMessages[0], /re-review/i);
  });
});

test('applyHeadChange: a second applier of the same move writes and posts nothing', async () => {
  // The sweep and the queue can both notice one move (PR #2101 saw two epoch
  // bumps and two "please re-review" notes for it). The install is a CAS on
  // the pin: whoever loses it must be a no-op.
  const NEW = 'b'.repeat(40);
  const sysMessages = [];
  let built = false;
  scriptedMove = { kind: 'authored' };

  await withStubs([
    [fakeGithub, 'getPR', async () => ({ head: { sha: NEW, ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true })],
    [fakeWs, 'sendSystemMessage', async (_pool, _appId, content) => { sysMessages.push(content); }],
    [fakeStaging, 'buildAndDeployStaging', async () => { built = true; return { containerId: 'cid', stagingUrl: 'https://s', hostname: 'h' }; }],
  ], async () => {
    // The row's pin already reads NEW: another pass got there first.
    const pool = recordingPool({ pinnedHead: NEW });
    const res = await prImportSync.applyHeadChange({
      config: {}, pool, session: { ...SESSION }, newHead: NEW, oldHead: SESSION_HEAD,
    });
    assert.equal(res.applied, false);
    const writes = pool.calls.filter((c) => /^\s*(UPDATE|INSERT|DELETE)/i.test(c.sql));
    assert.equal(writes.length, 1, 'the failed CAS is the only write');
    assert.ok(pool.calls.some((c) => /SELECT imported_pr_head_sha, approval_epoch/.test(c.sql)),
      'and the row is re-read so the caller carries on with the pin as it now stands');
    assert.deepEqual(sysMessages, []);
    assert.equal(built, false);
  });
});

// ── reconcileImportedHead: re-pin from the mirror without asking GitHub ──
//
// The queue has just pushed a sync commit onto the branch and is about to
// offer GitHub the pinned commit. Waiting for the poller to notice would
// guarantee the 409 ("wasn't merged, because the PR was updated on GitHub")
// loop of #2100.

// A branch in the app's own repository — the only kind the mirror can see.
const IN_APP_REPO = { ...SESSION, imported_pr_head_repo: 'acme/demo' };

test('reconcileImportedHead: a head on the author fork is left to the poller', async () => {
  const res = await prImportSync.reconcileImportedHead({
    config: {}, pool: recordingPool(),
    session: { ...SESSION, imported_pr_head_repo: 'someone/demo' },
  });
  assert.equal(res.reconciled, false);
  assert.equal(res.reason, 'fork_head');
});

test('reconcileImportedHead: an unmoved branch is reported as such and nothing is written', async () => {
  mirrorBranchHead = SESSION_HEAD;
  const pool = recordingPool();
  const res = await prImportSync.reconcileImportedHead({ config: {}, pool, session: { ...IN_APP_REPO } });
  assert.deepEqual(res, { reconciled: true, changed: false, headSha: SESSION_HEAD });
  assert.equal(pool.calls.length, 0);
});

test('reconcileImportedHead: a mechanical move re-pins, keeps the votes, and defers the checks to the caller', async () => {
  const NEW = 'd'.repeat(40);
  mirrorBranchHead = NEW;
  scriptedMove = { kind: 'mechanical' };
  const sysMessages = [];
  let built = false;
  await withStubs([
    [fakeWs, 'sendSystemMessage', async (_pool, _appId, content) => { sysMessages.push(content); }],
    [fakeStaging, 'buildAndDeployStaging', async () => { built = true; return { containerId: 'cid', stagingUrl: 'https://s', hostname: 'h' }; }],
  ], async () => {
    const pool = recordingPool({ epoch: 1 });
    const session = { ...IN_APP_REPO, approval_epoch: 1, checks_commit_sha: 'e'.repeat(40), check_state: 'passing' };
    const res = await prImportSync.reconcileImportedHead({ config: {}, pool, session, checks: 'defer', notify: false });
    assert.equal(res.reconciled, true);
    assert.equal(res.changed, true);
    assert.equal(res.headSha, NEW);
    assert.equal(res.kind, 'mechanical');
    assert.equal(res.votesKept, true);
    assert.equal(session.imported_pr_head_sha, NEW, 'the in-memory row follows, so the caller merges the live head');
    assert.equal(session.approval_epoch, 1);
    assert.equal(built, false, "'defer': the caller's checks gate rebuilds exactly the pinned head");
    assert.deepEqual(sysMessages, [], "'notify: false': the caller is about to say something more specific");
    assert.ok(!pool.calls.some((c) => /SET behind_main/.test(c.sql)),
      'no GitHub read in hand, so no drift snapshot is written from a stale one');
  });
});

test('reconcileImportedHead: an authored move under `defer` still kicks the rebuild', async () => {
  // A run that cleared the approvals stops at the approvals gate and never
  // reaches the checks gate — so 'defer' would strand the rebuild forever.
  const NEW = 'd'.repeat(40);
  mirrorBranchHead = NEW;
  scriptedMove = { kind: 'authored' };
  let buildSha = null;
  await withStubs([
    [fakeStaging, 'buildAndDeployStaging', async (_c, _s, _a, sha) => { buildSha = sha; return { containerId: 'cid', stagingUrl: 'https://s', hostname: 'h' }; }],
  ], async () => {
    const pool = recordingPool();
    const res = await prImportSync.reconcileImportedHead({ config: {}, pool, session: { ...IN_APP_REPO }, checks: 'defer', notify: false });
    assert.equal(res.votesKept, false);
    // The rebuild is fire-and-forget on this path; let it start.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(buildSha, NEW);
  });
});

test('reconcileImportedHead: an unreadable mirror leaves the pin alone rather than guessing', async () => {
  await withStubs([
    [fakeMirror, 'ensureMirror', async () => { throw new Error('clone failed'); }],
  ], async () => {
    const pool = recordingPool();
    const res = await prImportSync.reconcileImportedHead({ config: {}, pool, session: { ...IN_APP_REPO } });
    assert.equal(res.reconciled, false);
    assert.equal(res.reason, 'mirror_unreadable');
    assert.equal(pool.calls.length, 0);
  });
});

// #866 — the rebuild path shares the withdrawn-mid-build guard with the
// import-time kick: a proposal closed while the (minutes-long) rebuild ran
// must not have the finished preview persisted onto it.
test('rerunChecksForNewHead discards the rebuild when the proposal is no longer open', async () => {
  const NEW = 'c'.repeat(40);
  let toreDown = null;
  await withStubs([
    [fakeStaging, 'buildAndDeployStaging', async () => ({ containerId: 'cid2', stagingUrl: 'https://s2', hostname: 'h' })],
    [fakeStaging, 'teardownStaging', async (s, app) => {
      toreDown = { containerId: s.staging_container_id, url: s.staging_url, slug: app && app.slug };
    }],
  ], async () => {
    const calls = [];
    const pool = {
      calls,
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (/SELECT status FROM chat_sessions/.test(sql)) return { rows: [{ status: 'archived' }] };
        return { rows: [] };
      },
    };
    await prImportSync.rerunChecksForNewHead({
      config: {}, pool, session: { ...SESSION }, newHead: NEW,
    });

    assert.ok(!calls.some((c) => /UPDATE chat_sessions SET staging_container_id/.test(c.sql)),
      'no staging_url written onto a withdrawn proposal');
    assert.deepEqual(toreDown, { containerId: 'cid2', url: 'https://s2', slug: 'demo' },
      'the fresh container + URL are torn down instead');
  });
});

// #866 — a failed rebuild records the terminal verdict (which is what
// narrates the reason into the thread — see recordStagingBootFailure) and
// pushes staging_failed so open cards flip to "Preview unavailable" live
// instead of holding a spinner until something else refetches.
test('rerunChecksForNewHead records the failure and pushes staging_failed', async () => {
  const NEW = 'd'.repeat(40);
  const pushes = [];
  const recorded = [];
  await withStubs([
    [fakeStaging, 'buildAndDeployStaging', async () => { throw new Error('missing secret OPENAI_KEY'); }],
    [fakeRecovery, 'recordStagingBootFailure', async ({ commitHash, err }) => {
      recorded.push({ commitHash, message: err.message });
    }],
    [fakeWs, 'pushSessionUpdate', (payload) => { pushes.push(payload); }],
  ], async () => {
    const pool = recordingPool();
    await assert.rejects(
      prImportSync.rerunChecksForNewHead({ config: {}, pool, session: { ...SESSION }, newHead: NEW }),
      /missing secret/,
      'the failure still propagates to the caller (which logs it)'
    );
    assert.deepEqual(recorded, [{ commitHash: NEW, message: 'missing secret OPENAI_KEY' }],
      'verdict recorded against the new head');
    assert.deepEqual(pushes.map((p) => p.action), ['staging_failed']);
    assert.equal(pushes[0].appSlug, 'demo');
    assert.ok(!pool.calls.some((c) => /UPDATE chat_sessions SET staging_container_id/.test(c.sql)),
      'no preview persisted for a build that failed');
  });
});

test('syncImportedProposal: native rows are skipped', async () => {
  const pool = recordingPool();
  const res = await prImportSync.syncImportedProposal({ config: {}, pool, session: { ...SESSION, source: 'native' } });
  assert.equal(res, 'skipped');
  assert.equal(pool.calls.length, 0);
});

// ── #1333: the description mirror ────────────────────────────────────────
//
// get_proposal reports chat_sessions.pr_body as `description` — what the
// group is voting on. #1323 wired only the author's own submit_work update,
// so the field read null on essentially every proposal. The sweep already
// holds a fresh PR on every pass, which makes it the one place that can heal
// rows written before the column existed, at no extra API cost.

test('syncImportedProposal: a changed body is mirrored even when the head has not moved', async () => {
  await withStubs([
    [fakeGithub, 'getPR', async () => ({
      head: { sha: 'a'.repeat(40), ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true,
      body: 'The description as it now reads on GitHub.',
    })],
  ], async () => {
    const pool = recordingPool();
    const session = { ...SESSION, pr_body: null };
    const res = await prImportSync.syncImportedProposal({ config: {}, pool, session });
    // Still 'unchanged' — mirroring a description is not a revision.
    assert.equal(res, 'unchanged');
    const write = pool.calls.find((c) => /SET pr_body/.test(c.sql));
    assert.ok(write, 'the row learned the description');
    assert.deepEqual(write.params, ['The description as it now reads on GitHub.', 321]);
    assert.equal(session.pr_body, 'The description as it now reads on GitHub.',
      'and the in-memory row matches, like every other mirror here');
  });
});

test('syncImportedProposal: an unchanged body still writes nothing', async () => {
  await withStubs([
    [fakeGithub, 'getPR', async () => ({
      head: { sha: 'a'.repeat(40), ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true,
      body: 'Same as it ever was.',
    })],
  ], async () => {
    const pool = recordingPool();
    const res = await prImportSync.syncImportedProposal({
      config: {}, pool, session: { ...SESSION, pr_body: 'Same as it ever was.' },
    });
    assert.equal(res, 'unchanged');
    assert.equal(pool.calls.length, 0,
      'the no-writes guarantee for an unchanged head survives the mirror');
  });
});

test('syncImportedProposal: a failed mirror write never fails the sweep', async () => {
  await withStubs([
    [fakeGithub, 'getPR', async () => ({
      head: { sha: 'a'.repeat(40), ref: 'feature/x' }, base: { ref: 'main' }, mergeable: true,
      body: 'New words.',
    })],
  ], async () => {
    const pool = { query: async () => { throw new Error('database is having a moment'); } };
    const res = await prImportSync.syncImportedProposal({
      config: {}, pool, session: { ...SESSION, pr_body: null },
    });
    assert.equal(res, 'unchanged', 'a display field must never wedge the poller');
  });
});
