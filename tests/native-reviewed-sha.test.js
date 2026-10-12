// What a head move costs a native proposal's approvals (#2038).
//
// This suite used to drive a provenance ledger: session_platform_pushes, a
// five-hop first-parent walk, a "platform sync in flight, defer" race state,
// and a fail-closed branch for an unreadable parent list. All of that existed
// because a commit's SHAPE can be forged — a merge whose first parent is the
// reviewed sha proves nothing — so the platform had to remember every commit
// it pushed in order to recognise its own work later.
//
// The reconciler redoes the merge and compares trees instead. So does this
// suite: only the CLONE is stubbed, and every question the reconciler asks is
// answered by real git against a real repository. Mocking git here would test
// the mock, and the whole argument for the change is that git's answer is the
// one that cannot be forged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function stub(rel, exports) {
  const id = require.resolve(path.join(__dirname, '..', rel));
  const prev = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  return () => { if (prev) require.cache[id] = prev; else delete require.cache[id]; };
}

// A repository with `main`, a proposal branch, and helpers to move either.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-reconcile-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'user.email', 'test@usernode.invalid');
  git(dir, 'config', 'user.name', 'Homeroom Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');

  git(dir, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'PROPOSAL\nl2\nl3\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'the proposal');
  const approved = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');

  return {
    dir, approved,
    moveMain(file, body) {
      git(dir, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(dir, file), body);
      git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'main moves');
      return this;
    },
    // Returns with `main` checked out on a clean merge. On a CONFLICT it
    // leaves `feature` checked out with the index unresolved, because that is
    // the state the caller has to resolve from — and because `git checkout`
    // refuses to move off an unresolved index, which is what makes the
    // cleanest-looking version of this helper fail.
    syncIntoFeature() {
      git(dir, 'checkout', '-q', 'feature');
      try {
        execFileSync('git', ['-C', dir, 'merge', '--no-edit', 'main'], { stdio: 'ignore' });
      } catch {
        return { ...this, conflicted: true };
      }
      git(dir, 'checkout', '-q', 'main');
      return this;
    },
    writeOnFeature(file, body, message = 'author push') {
      git(dir, 'checkout', '-q', 'feature');
      fs.writeFileSync(path.join(dir, file), body);
      git(dir, 'add', '-A'); git(dir, 'commit', '-qm', message);
      git(dir, 'checkout', '-q', 'main');
      return this;
    },
    featureHead: () => git(dir, 'rev-parse', 'feature'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// A pool that records what the reconciler writes, and answers the one
// conditional UPDATE it depends on.
function makePool({ epoch = 0, voters = 0 }) {
  const writes = [];
  let currentEpoch = epoch;
  return {
    writes,
    get epoch() { return currentEpoch; },
    async query(sql, params) {
      const text = String(sql);
      writes.push({ sql: text, params });
      if (/UPDATE chat_sessions[\s\S]*approval_epoch = approval_epoch \+/.test(text)) {
        const keeps = params[2];
        if (!keeps) currentEpoch += 1;
        return { rows: [{ approval_epoch: currentEpoch }], rowCount: 1 };
      }
      if (/SELECT 1 FROM pr_votes WHERE session_id = \$1 AND approval_epoch = \$2/.test(text)) {
        // `voters` votes were cast under the epoch the proposal started in.
        return { rows: params[1] === epoch && voters ? [{ '?column?': 1 }] : [], rowCount: 0 };
      }
      if (/SELECT reviewed_head_sha, approval_epoch/.test(text)) {
        return { rows: [{ reviewed_head_sha: null, approval_epoch: currentEpoch }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    kickedChecks() {
      return this.writes.some((w) => /checks_commit_sha/.test(w.sql));
    },
  };
}

function load(r, posted = []) {
  const rebuilds = [];
  const restores = [
    stub('src/services/github.js', { isEnabled: () => true }),
    stub('src/services/ws.js', {
      pushVoteUpdate() {},
      pushSessionUpdate() {},
      async sendSystemMessage(pool_, appId, content, type, meta, thread) {
        posted.push({ appId, content, type, meta, thread });
      },
    }),
    stub('src/services/visuals.js', {
      async setChecksPending(pool_, id, sha) { rebuilds.push(sha); }, notifyChecksPending() {},
    }),
    stub('src/services/pr-import-sync.js', { async rerunChecksForNewHead() {} }),
  ];
  // Only the clone is stubbed: every plumbing call underneath runs for real.
  const mirror = require('../src/services/repo-mirror');
  const realEnsure = mirror.ensureMirror;
  mirror.ensureMirror = async () => r.dir;
  restores.push(() => { mirror.ensureMirror = realEnsure; });

  delete require.cache[require.resolve('../src/routes/votes')];
  // eslint-disable-next-line global-require
  const votes = require('../src/routes/votes');
  return {
    votes,
    rebuilds,
    restore() {
      restores.reverse().forEach((f) => f());
      delete require.cache[require.resolve('../src/routes/votes')];
    },
  };
}

function session(r, overrides = {}) {
  return {
    id: 42, app_id: 7, app_slug: 'demo', source: null, status: 'promoted',
    repo_url: 'https://github.com/acme/demo', branch_name: 'feature',
    pr_number: 99, pr_title: 'A proposal',
    reviewed_head_sha: r.approved, checks_commit_sha: r.approved, check_state: 'passing',
    approval_epoch: 0,
    ...overrides,
  };
}

test('a clean merge of main keeps the approvals and carries the checks', async () => {
  const r = repo().moveMain('b.txt', 'main moved b\n').syncIntoFeature();
  const { votes, rebuilds, restore } = load(r);
  const pool = makePool({ epoch: 0 });
  try {
    const out = await votes.reconcileNativeReviewedHead({
      config: {}, pool, session: session(r), notify: false,
    });
    assert.equal(out.kind, 'mechanical');
    assert.equal(out.votesKept, true);
    assert.equal(out.epoch, 0, 'a merge nobody edited must not move the epoch');
    assert.equal(out.headSha, r.featureHead());
    assert.equal(pool.kickedChecks(), true, 'the passing verdict is stamped onto the merged commit');
    assert.equal(out.checksCarry, true, 'and says so, for a caller that reports it');
    assert.deepEqual(rebuilds, [], 'and nothing is rebuilt');
  } finally { restore(); r.cleanup(); }
});

test('a clean merge over a run still in flight rebuilds instead of carrying', async () => {
  // The queue supersedes any run in flight before it moves the branch
  // (#1728), so a 'pending' stamp on the old head describes a run that will
  // never report. Carrying it forward left the row pending with nothing
  // building until the stale sweeper noticed ten minutes later.
  for (const state of ['pending', 'error', null]) {
    const r = repo().moveMain('b.txt', 'main moved b\n').syncIntoFeature();
    const { votes, rebuilds, restore } = load(r);
    const pool = makePool({ epoch: 0 });
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await votes.reconcileNativeReviewedHead({
        config: {}, pool, session: session(r, { check_state: state }), notify: false,
      });
      assert.equal(out.kind, 'mechanical');
      assert.equal(out.votesKept, true, `${state}: the votes still stand — only the checks policy differs`);
      assert.equal(pool.kickedChecks(), false, `${state}: an unfinished verdict is not carried`);
      assert.equal(out.checksCarry, false, `${state}: and the answer says it did not carry`);
      assert.deepEqual(rebuilds, [r.featureHead()], `${state}: the checks re-run against the merged commit`);
    } finally { restore(); r.cleanup(); }
  }
});

test('a settled failure does NOT carry: main may be what fixes it, so the merged tree is re-checked (#2693)', async () => {
  // This used to assert the opposite — "a merge of main does not change what
  // the author must fix". It does when the failure was main's: proposal 4654
  // went red on a red base, main was repaired, the sync merged the repair in
  // and carried the old failure onto the merged commit with nothing building.
  const r = repo().moveMain('b.txt', 'main moved b\n').syncIntoFeature();
  const { votes, rebuilds, restore } = load(r);
  const pool = makePool({ epoch: 0 });
  try {
    const out = await votes.reconcileNativeReviewedHead({
      config: {}, pool, session: session(r, { check_state: 'failing' }), notify: false,
    });
    assert.equal(out.kind, 'mechanical');
    assert.equal(out.votesKept, true, 'the votes still stand — only the checks policy differs');
    assert.equal(pool.kickedChecks(), false, 'the failing verdict is not stamped onto the merged commit');
    assert.deepEqual(rebuilds, [r.featureHead()], 'the checks re-run against the merged commit');
  } finally { restore(); r.cleanup(); }
});

test('an author push clears the approvals and re-runs the checks', async () => {
  const r = repo().writeOnFeature('a.txt', 'PROPOSAL CHANGED\nl2\nl3\n');
  const { votes, restore } = load(r);
  const pool = makePool({ epoch: 0 });
  try {
    const revised = session(r, { pr_summary_md: 'The earlier explanation.' });
    const out = await votes.reconcileNativeReviewedHead({
      config: {}, pool, session: revised, notify: false,
    });
    assert.equal(out.kind, 'authored');
    assert.equal(out.votesKept, false);
    assert.equal(out.epoch, 1, 'the epoch moves, which is what stops the old votes counting');
    assert.equal(revised.pr_summary_md, 'The earlier explanation.',
      'the previous explanation remains readable while its freshness is reviewed');
    assert.equal(revised.pr_summary_stale, true);
    assert.ok(pool.writes.some((w) => /pr_summary_previous_md = COALESCE/.test(w.sql)),
      'the prior explanation is retained when the reviewed head moves');
  } finally { restore(); r.cleanup(); }
});

test('a resolved conflict keeps the approvals but re-checks the merged tree', async () => {
  const r = repo().moveMain('a.txt', 'MAIN\nl2\nl3\n');
  const merged = r.syncIntoFeature();
  assert.equal(merged.conflicted, true, 'precondition: the merge really does conflict');
  // Resolve it the way the worker's conflict turn does: write bytes, inside
  // the conflicted file only. `feature` is already checked out.
  fs.writeFileSync(path.join(r.dir, 'a.txt'), 'PROPOSAL AND MAIN\nl2\nl3\n');
  git(r.dir, 'add', '-A'); git(r.dir, 'commit', '-qm', 'resolved');
  git(r.dir, 'checkout', '-q', 'main');

  const { votes, restore } = load(r);
  const pool = makePool({ epoch: 0 });
  try {
    const out = await votes.reconcileNativeReviewedHead({
      config: {}, pool, session: session(r), notify: false,
    });
    assert.equal(out.kind, 'resolved');
    assert.equal(out.votesKept, true, 'the resolution is bounded by the conflict');
    assert.equal(out.epoch, 0);
    assert.equal(pool.kickedChecks(), false,
      'a Claude-edited tree is unverified, so its verdict must NOT be carried');
    assert.equal(out.checksCarry, false);
  } finally { restore(); r.cleanup(); }
});

test('a merge commit shaped like ours but carrying an edit is an author push', async () => {
  // The forgery the provenance ledger existed to stop. The commit really is a
  // merge, and its first parent really is the approved head.
  const r = repo().moveMain('b.txt', 'main moved b\n').syncIntoFeature();
  git(r.dir, 'checkout', '-q', 'feature');
  fs.writeFileSync(path.join(r.dir, 'a.txt'), 'PROPOSAL\nl2\nSMUGGLED\n');
  git(r.dir, 'add', '-A'); git(r.dir, 'commit', '-q', '--amend', '--no-edit');
  const forged = git(r.dir, 'rev-parse', 'HEAD');
  git(r.dir, 'checkout', '-q', 'main');
  assert.equal(git(r.dir, 'rev-parse', `${forged}^1`), r.approved,
    'precondition: it really does sit on the approved head');

  const { votes, restore } = load(r);
  const pool = makePool({ epoch: 0 });
  try {
    const out = await votes.reconcileNativeReviewedHead({
      config: {}, pool, session: session(r), notify: false,
    });
    assert.equal(out.kind, 'authored', 'commit shape must buy nothing');
    assert.equal(out.epoch, 1);
  } finally { restore(); r.cleanup(); }
});

test('an unmoved head writes nothing at all', async () => {
  const r = repo();
  git(r.dir, 'checkout', '-q', 'feature');
  git(r.dir, 'checkout', '-q', 'main');
  const { votes, restore } = load(r);
  const pool = makePool({ epoch: 4 });
  try {
    const out = await votes.reconcileNativeReviewedHead({
      config: {}, pool, session: session(r, { approval_epoch: 4 }), notify: false,
    });
    assert.equal(out.unchanged, true);
    assert.equal(out.epoch, 4);
    assert.equal(pool.writes.length, 0, 'nothing to reconcile means nothing to write');
  } finally { restore(); r.cleanup(); }
});

test('a row with no pin yet is bound without clearing its unbound votes', async () => {
  const r = repo();
  const { votes, restore } = load(r);
  const pool = makePool({ epoch: 0 });
  try {
    const out = await votes.reconcileNativeReviewedHead({
      config: {}, pool, session: session(r, { reviewed_head_sha: null }), notify: false,
    });
    assert.equal(out.initialized, true);
    assert.equal(out.epoch, 0, 'binding a legacy row must not cost it its votes');
  } finally { restore(); r.cleanup(); }
});

test('an unreadable mirror leaves the revision alone rather than blocking', async () => {
  // Fail OPEN, deliberately: the mirror is a cache, and the authority is the
  // exact-sha merge, which pins to the recorded revision and is refused by
  // GitHub if the head moved. Failing closed would wedge every vote and merge
  // on every app behind one unreachable git host.
  const r = repo();
  const { votes, restore } = load(r);
  const mirror = require('../src/services/repo-mirror');
  mirror.ensureMirror = async () => { throw new Error('network down'); };
  const pool = makePool({ epoch: 2 });
  try {
    const out = await votes.reconcileNativeReviewedHead({
      config: {}, pool, session: session(r, { approval_epoch: 2 }), notify: false,
    });
    assert.equal(out.blocked, undefined, 'a cache miss must never block a merge');
    assert.equal(out.measurementUnavailable, true);
    assert.equal(out.epoch, 2, 'and must never cost anybody their vote');
  } finally { restore(); r.cleanup(); }
});

test('a proposal with no recorded branch is left alone, not blocked', async () => {
  // Legacy rows, and imported proposals whose head is on the author's fork
  // where the mirror cannot see it.
  const r = repo();
  const { votes, restore } = load(r);
  const pool = makePool({ epoch: 1 });
  try {
    const out = await votes.reconcileNativeReviewedHead({
      config: {}, pool, session: session(r, { branch_name: null, approval_epoch: 1 }),
      notify: false,
    });
    assert.equal(out.blocked, undefined);
    assert.equal(out.measurementUnavailable, true);
  } finally { restore(); r.cleanup(); }
});

test('a row with no repository at all still fails closed', async () => {
  // The one case with nothing to fail open TO: a proposal claiming a pull
  // request but carrying no repository identity cannot be verified by any
  // means, and must not merge on an unverified head.
  const r = repo();
  const { votes, restore } = load(r);
  const pool = makePool({ epoch: 0 });
  try {
    const out = await votes.reconcileNativeReviewedHead({
      config: {}, pool, session: session(r, { repo_url: null }), notify: false,
    });
    assert.equal(out.blocked, true);
  } finally { restore(); r.cleanup(); }
});

test('imported proposals are not reconciled here at all', async () => {
  const r = repo();
  const { votes, restore } = load(r);
  const pool = makePool({ epoch: 0 });
  try {
    const out = await votes.reconcileNativeReviewedHead({
      config: {}, pool,
      session: session(r, { source: 'imported', imported_pr_head_sha: 'c'.repeat(40) }),
      notify: false,
    });
    assert.equal(out.enforced, false, 'the import sweeper owns that head');
    assert.equal(pool.writes.length, 0);
  } finally { restore(); r.cleanup(); }
});

test('a caller that has just pushed asks the mirror for a fetch of its own (#2619)', async () => {
  // `fresh` was accepted here and then never read: seven call sites asked to
  // re-read the branch and silently got whatever fetch happened to be in
  // flight for the repository. For the four that call this immediately AFTER
  // pushing, that fetch can predate their own push — so the reconcile saw the
  // old tip, concluded the head had not moved, and returned `unchanged`.
  // Upstream that became `votesCleared: 0, checksRerun: false,
  // previewRebuilding: false`, leaving the verdict and the tally on the
  // previous commit until a sweep caught up minutes later.
  const r = repo().moveMain('b.txt', 'main moved b\n').syncIntoFeature();
  const { votes, restore } = load(r);
  const mirror = require('../src/services/repo-mirror');
  const asked = [];
  mirror.ensureMirror = async (owner, name, options) => { asked.push(options); return r.dir; };
  const pool = makePool({ epoch: 0 });
  try {
    await votes.reconcileNativeReviewedHead({
      config: {}, pool, session: session(r), notify: false, fresh: true,
    });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].fresh, true,
      'the push and this read are in one request, so it must not join an older fetch');

    // And the sweeps, which have no write of their own to see, still coalesce.
    asked.length = 0;
    await votes.reconcileNativeReviewedHead({
      config: {}, pool, session: session(r), notify: false,
    });
    assert.equal(asked[0].fresh, false);
  } finally { restore(); r.cleanup(); }
});

// #3411: the tally counts only votes on the current version, while the
// Discussion keeps each "Voted yes" line forever. A silent caller (the merge
// queue's re-pin) used to retire those votes with no word in the thread, so
// the page read "Voted yes" beside "Yes 0" and nothing said why.
test('a silent caller that retires votes still says so, in the proposal\'s own thread', async () => {
  const r = repo().writeOnFeature('a.txt', 'PROPOSAL CHANGED\nl2\nl3\n');
  const posted = [];
  const { votes, restore } = load(r, posted);
  try {
    const out = await votes.reconcileNativeReviewedHead({
      config: {}, pool: makePool({ epoch: 3, voters: 1 }), session: session(r, { approval_epoch: 3 }), notify: false,
    });
    assert.equal(out.epoch, 4);
    assert.equal(posted.length, 1, 'one notice, not one per path');
    assert.match(posted[0].content, /^PR #99: A proposal was updated on GitHub\. Earlier votes were cleared/);
    assert.deepEqual(posted[0].thread, { type: 'session', ref: 42 }, 'the proposal\'s thread, never a channel');
  } finally { restore(); r.cleanup(); }
});

// One request, one story: an update Homeroom made (the bot's, or one sent
// through Homeroom) is one plain line in the change's thread, with no
// "on GitHub" and no pull request number; the bot's own note does not
// repeat it.
test('an update Homeroom made says so in one line, without GitHub or a pull request number', async () => {
  const r = repo().writeOnFeature('a.txt', 'PROPOSAL CHANGED\nl2\nl3\n');
  const posted = [];
  const { votes, restore } = load(r, posted);
  try {
    await votes.reconcileNativeReviewedHead({
      config: {}, pool: makePool({ epoch: 3, voters: 1 }), session: session(r, { approval_epoch: 3 }), notify: true, madeBy: 'bot',
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].content, 'Updated. Earlier votes were cleared, so take another look.');
    assert.deepEqual(posted[0].thread, { type: 'session', ref: 42 });
  } finally { restore(); r.cleanup(); }
});

test('a silent caller posts nothing when the move cleared no votes, kept them, or its caller announces it', async () => {
  const pushed = repo().writeOnFeature('a.txt', 'PROPOSAL CHANGED\nl2\nl3\n');
  const posted = [];
  let loaded = load(pushed, posted);
  try {
    await loaded.votes.reconcileNativeReviewedHead({
      config: {}, pool: makePool({ epoch: 0, voters: 0 }), session: session(pushed), notify: false,
    });
    assert.equal(posted.length, 0, 'nobody had voted, so nothing was cleared');
    await loaded.votes.reconcileNativeReviewedHead({
      config: {}, pool: makePool({ epoch: 0, voters: 2 }), session: session(pushed), notify: false,
      announceClearedVotes: false,
    });
    assert.equal(posted.length, 0, 'the merge\'s 409 writes its own line about the cleared votes');
  } finally { loaded.restore(); pushed.cleanup(); }

  const synced = repo().moveMain('b.txt', 'main moved b\n').syncIntoFeature();
  loaded = load(synced, posted);
  try {
    const out = await loaded.votes.reconcileNativeReviewedHead({
      config: {}, pool: makePool({ epoch: 0, voters: 2 }), session: session(synced), notify: false,
    });
    assert.equal(out.votesKept, true);
    assert.equal(posted.length, 0, 'a clean sync keeps the votes, so a silent caller stays silent');
  } finally { loaded.restore(); synced.cleanup(); }
});

test('the merge\'s head-moved 409 announces the cleared votes itself, so the reconciler does not', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/votes.js'), 'utf8');
  assert.match(src, /nativeRefresh = await reconcileNativeReviewedHead\(\{\s*config, pool, session, fresh: true, notify: false,\s*announceClearedVotes: false,\s*\}\)/);
  assert.match(src, /Earlier-revision votes were cleared and the new commit is being checked/);
});
