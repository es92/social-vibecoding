// The rule that decides what a head move costs a proposal's approvals.
//
// This replaces services/sync-main.js's provenance ledger — a table of every
// commit the platform pushed, a five-hop first-parent walk, and a fail-closed
// branch for an unreadable parent list. All of that existed because a commit's
// SHAPE can be forged. Recomputing the merge cannot be, so these tests are the
// whole safety argument and they run against real git.
//
// The direction of failure matters more than the rate. Classifying an authored
// push as mechanical would let somebody change approved code without being
// re-approved — a governance bypass. Classifying a mechanical merge as authored
// only costs people their votes, which is the bug being fixed. Both are
// asserted, but the first is the one that must never happen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const integration = require('../src/services/integration');

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}
function tryGit(dir, ...args) {
  try { return git(dir, ...args); } catch { return null; }
}

// A repository with a proposal branch and a main that has moved. Returns the
// shas plus helpers to push the story further.
function scenario({ propEdit, mainEdit }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usernode-classify-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  git(dir, 'config', 'user.email', 'test@usernode.invalid');
  git(dir, 'config', 'user.name', 'Homeroom Test');

  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'untouched\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');

  git(dir, 'checkout', '-qb', 'prop');
  propEdit(dir);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'the proposal');
  const approvedHead = git(dir, 'rev-parse', 'HEAD');

  git(dir, 'checkout', '-q', 'main');
  mainEdit(dir);
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'main moves');

  return {
    dir,
    approvedHead,
    main: () => git(dir, 'rev-parse', 'main'),
    // What the platform's sync turn does: merge main into the proposal.
    syncMain() {
      git(dir, 'checkout', '-q', 'prop');
      try {
        execFileSync('git', ['-C', dir, 'merge', '--no-edit', 'main'], { stdio: 'ignore' });
      } catch { /* conflict — the caller resolves */ }
      return this;
    },
    resolve(write) {
      write(this.dir);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', 'resolved');
      return this;
    },
    head: () => git(dir, 'rev-parse', 'prop'),
    advanceMain(write) {
      git(dir, 'checkout', '-q', 'main');
      write(dir);
      git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'main moves again');
      return this;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const edit = (file, body) => (d) => fs.writeFileSync(path.join(d, file), body);

test('an unmoved head is "same"', async () => {
  const s = scenario({
    propEdit: edit('a.txt', 'PROP\nl2\nl3\nl4\nl5\n'),
    mainEdit: edit('a.txt', 'l1\nl2\nl3\nl4\nMAIN\n'),
  });
  try {
    const r = await integration.classifyHeadMove(s.dir, {
      approvedHead: s.approvedHead, newHead: s.approvedHead, mainSha: s.main(),
    });
    assert.equal(r.kind, 'same');
  } finally { s.cleanup(); }
});

test('a clean platform sync is "mechanical" and costs nothing', async () => {
  const s = scenario({
    propEdit: edit('a.txt', 'PROP\nl2\nl3\nl4\nl5\n'),
    mainEdit: edit('a.txt', 'l1\nl2\nl3\nl4\nMAIN\n'),
  });
  try {
    s.syncMain();
    const r = await integration.classifyHeadMove(s.dir, {
      approvedHead: s.approvedHead, newHead: s.head(), mainSha: s.main(),
    });
    assert.equal(r.kind, 'mechanical',
      'a merge nobody edited must never cost a proposal its approvals');
  } finally { s.cleanup(); }
});

test('main moving AFTER the sync does not retroactively make it authored', async () => {
  // The false positive the classifier is specifically shaped to avoid. If it
  // compared against main's current tip instead of the slice the proposal
  // absorbed, every mechanical merge would look authored the moment anything
  // else landed — and people would lose votes for standing still.
  const s = scenario({
    propEdit: edit('a.txt', 'PROP\nl2\nl3\nl4\nl5\n'),
    mainEdit: edit('a.txt', 'l1\nl2\nl3\nl4\nMAIN\n'),
  });
  try {
    s.syncMain();
    const headAfterSync = s.head();
    s.advanceMain(edit('other.txt', 'main moved on again\n'));
    s.advanceMain(edit('other.txt', 'and again\n'));

    const r = await integration.classifyHeadMove(s.dir, {
      approvedHead: s.approvedHead, newHead: headAfterSync, mainSha: s.main(),
    });
    assert.equal(r.kind, 'mechanical',
      'the comparison must use the main the proposal absorbed, not main today');
  } finally { s.cleanup(); }
});

test('a conflict resolved only inside the conflicted files is "resolved"', async () => {
  const s = scenario({
    propEdit: edit('a.txt', 'PROP\nl2\nl3\nl4\nl5\n'),
    mainEdit: edit('a.txt', 'MAIN\nl2\nl3\nl4\nl5\n'),
  });
  try {
    s.syncMain().resolve(edit('a.txt', 'PROP-AND-MAIN\nl2\nl3\nl4\nl5\n'));
    const r = await integration.classifyHeadMove(s.dir, {
      approvedHead: s.approvedHead, newHead: s.head(), mainSha: s.main(),
    });
    assert.equal(r.kind, 'resolved');
    assert.deepEqual(r.conflictPaths, ['a.txt']);
  } finally { s.cleanup(); }
});

test('a resolution that also edits an unconflicted file is "authored"', async () => {
  // The governance-relevant case: the resolver (or a person) slipping a change
  // into a file the conflict never touched. Bounded means bounded.
  const s = scenario({
    propEdit: edit('a.txt', 'PROP\nl2\nl3\nl4\nl5\n'),
    mainEdit: edit('a.txt', 'MAIN\nl2\nl3\nl4\nl5\n'),
  });
  try {
    s.syncMain().resolve((d) => {
      fs.writeFileSync(path.join(d, 'a.txt'), 'PROP-AND-MAIN\nl2\nl3\nl4\nl5\n');
      fs.writeFileSync(path.join(d, 'other.txt'), 'smuggled in\n');
    });
    const r = await integration.classifyHeadMove(s.dir, {
      approvedHead: s.approvedHead, newHead: s.head(), mainSha: s.main(),
    });
    assert.equal(r.kind, 'authored',
      'an edit outside the conflict must re-open approval — this is the bypass to prevent');
    assert.equal(r.reason, 'edits_outside_conflicts');
    assert.deepEqual(r.paths, ['other.txt']);
  } finally { s.cleanup(); }
});

test('an ordinary author push is "authored"', async () => {
  const s = scenario({
    propEdit: edit('a.txt', 'PROP\nl2\nl3\nl4\nl5\n'),
    mainEdit: edit('other.txt', 'main touched this\n'),
  });
  try {
    git(s.dir, 'checkout', '-q', 'prop');
    fs.writeFileSync(path.join(s.dir, 'a.txt'), 'PROP-CHANGED-AGAIN\nl2\nl3\nl4\nl5\n');
    git(s.dir, 'add', '-A'); git(s.dir, 'commit', '-qm', 'author pushes more');

    const r = await integration.classifyHeadMove(s.dir, {
      approvedHead: s.approvedHead, newHead: s.head(), mainSha: s.main(),
    });
    assert.equal(r.kind, 'authored');
  } finally { s.cleanup(); }
});

test('a forged merge commit does not buy a free pass', async () => {
  // The attack the provenance ledger existed to stop: craft a commit that
  // LOOKS like a platform sync — a merge whose first parent is the approved
  // head — while smuggling a change in. Shape is not consulted, so it fails.
  const s = scenario({
    propEdit: edit('a.txt', 'PROP\nl2\nl3\nl4\nl5\n'),
    mainEdit: edit('other.txt', 'main touched this\n'),
  });
  try {
    s.syncMain(); // a genuine merge, first parent = approvedHead
    fs.writeFileSync(path.join(s.dir, 'a.txt'), 'PROP\nl2\nl3\nl4\nSMUGGLED\n');
    git(s.dir, 'add', '-A');
    git(s.dir, 'commit', '-q', '--amend', '--no-edit'); // still a merge, still that first parent

    assert.equal(tryGit(s.dir, 'rev-parse', 'HEAD^1'), s.approvedHead,
      'precondition: the forged commit really does sit on the approved head');

    const r = await integration.classifyHeadMove(s.dir, {
      approvedHead: s.approvedHead, newHead: s.head(), mainSha: s.main(),
    });
    assert.equal(r.kind, 'authored',
      'commit shape must buy nothing — only the recomputed tree decides');
  } finally { s.cleanup(); }
});

test('a commit the mirror has never seen is "unknown", not "mechanical"', async () => {
  const s = scenario({
    propEdit: edit('a.txt', 'PROP\nl2\nl3\nl4\nl5\n'),
    mainEdit: edit('a.txt', 'l1\nl2\nl3\nl4\nMAIN\n'),
  });
  try {
    const r = await integration.classifyHeadMove(s.dir, {
      approvedHead: s.approvedHead, newHead: 'b'.repeat(40), mainSha: s.main(),
    });
    assert.equal(r.kind, 'unknown',
      'an unanswerable question must never resolve in the permissive direction');
  } finally { s.cleanup(); }
});

test('the vote predicate compares epochs, and validates its aliases', () => {
  assert.match(integration.currentVotePredicateSql(),
    /pv\.approval_epoch = cs\.approval_epoch/);
  assert.throws(() => integration.currentVotePredicateSql('pv; DROP TABLE', 'cs'),
    /Invalid SQL alias/);
});
