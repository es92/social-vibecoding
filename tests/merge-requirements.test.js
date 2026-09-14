// What a proposal still needs before it merges — the list, and the promise
// that it describes the REAL gate rather than a second opinion about it.
//
// The card's tags are a negative surface: they name what is wrong and say
// nothing about what is required, so an absent tag is ambiguous between "the
// gate passed", "the gate does not apply here" and "the gate has no UI at
// all". Two of the seven were the third case.
//
// The risk in fixing that is obvious and worth stating: a description of a
// gate is a second implementation of the gate unless something holds the two
// together. Nothing here re-derives a condition. checkAndMerge records what it
// actually did, and the last test in this file drives the real function
// through four different refusals and asserts the recording matches the
// refusal every time.
//
// Run with: node --test tests/merge-requirements.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const _origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'express') return { Router: () => ({}) };
  return _origLoad.call(this, request, ...rest);
};

const requirements = require('../src/services/merge-requirements');

// ── The spec ────────────────────────────────────────────────────────────

test('a gate that does not apply is omitted, not greyed', () => {
  // A locked-app row on an unlocked app is noise, and the count has to read
  // "4 of 4" rather than "4 of 7" or it is telling the reader a proposal is
  // further from merging than it is.
  const t = requirements.trace().context({ locked: false, selfHosted: false, explicitApproval: false });
  t.pass('approvals');
  const keys = requirements.describe(t.toRecord()).map((g) => g.key);
  assert.deepEqual(keys, ['approvals', 'integration', 'checks', 'github']);

  const t2 = requirements.trace().context({ locked: true, selfHosted: true, explicitApproval: true });
  t2.pass('approvals');
  assert.deepEqual(requirements.describe(t2.toRecord()).map((g) => g.key),
    ['approvals', 'explicit', 'admin_yes', 'integration', 'checks', 'platform_env', 'github']);
});

test('everything after the refusal is "pending", never "done"', () => {
  // The whole reconstruction rests on this: evaluation stops at the first
  // refusal, so a gate it never reached must not read as satisfied.
  const t = requirements.trace().context({ locked: false, selfHosted: false });
  t.pass('approvals').stop('integration', 'active', { behindBy: 2 });
  const list = requirements.describe(t.toRecord());
  assert.deepEqual(list.map((g) => `${g.key}:${g.state}`),
    ['approvals:done', 'integration:active', 'checks:pending', 'github:pending']);
});

test('a mark after the stop is ignored, so one run cannot report two refusals', () => {
  const t = requirements.trace().context({ locked: false, selfHosted: false });
  t.pass('approvals').stop('checks', 'blocked').pass('github');
  const list = requirements.describe(t.toRecord());
  assert.equal(list.find((g) => g.key === 'github').state, 'pending');
});

test('revise corrects the recorded stop, and only its own gate', () => {
  // Gate 7 is marked in flight before the merge is attempted — which is what
  // is actually happening — and the attempt's real outcome lands after.
  const t = requirements.trace().context({ locked: false, selfHosted: false });
  t.pass('approvals').pass('integration').pass('checks').stop('github', 'active');
  t.revise('github', 'blocked', { note: 'GitHub refused the merge' });
  const list = requirements.describe(t.toRecord());
  assert.equal(list.find((g) => g.key === 'github').state, 'blocked');
  assert.equal(list.find((g) => g.key === 'github').detail.note, 'GitHub refused the merge');

  // It must not be able to reopen an earlier gate's verdict.
  t.revise('checks', 'blocked', { note: 'nope' });
  assert.equal(requirements.describe(t.toRecord()).find((g) => g.key === 'checks').state, 'done');
});

test('an unknown gate or state is a programming error, not a silent no-op', () => {
  assert.throws(() => requirements.trace().pass('nonsense'), /Unknown merge gate/);
  assert.throws(() => requirements.trace().stop('checks', 'sideways'), /Unknown gate state/);
});

test('a row the gate has never run against still says what it can', () => {
  // This file originally asserted the opposite — that an un-run row describes
  // nothing — and that was the bug. checkAndMerge records only when it runs,
  // and it runs on a vote or on the sweep for proposals ALREADY at threshold.
  // So a proposal below threshold, which is the case the checklist is most
  // useful for, showed nothing at all, and a freshly cloned staging database
  // showed nothing anywhere. A feature that appears only after somebody votes
  // is not a feature.
  const block = requirements.readRequirements({
    votes_required: 3, yes_count: 1, check_state: 'passing',
    integration_behind_by: 0, integration_merges_clean: true,
  });
  assert.equal(block.provisional, true, 'and it says that it is provisional');
  assert.equal(block.evaluated, false);
  assert.deepEqual(block.gates.map((g) => `${g.key}:${g.state}`),
    ['approvals:waiting', 'integration:done', 'checks:done', 'github:pending']);
  assert.equal(requirements.summarize(block.gates, { hasVoted: false }).headline, 'Waiting on your vote');
});

test('the provisional list never guesses a gate only the merge gate can answer', () => {
  // Whether the app is locked, and whether a platform variable is unset, are
  // answers no column on the row carries. Absent beats assumed-satisfied: a
  // tick against a requirement nothing checked is the precise lie this whole
  // change exists to remove.
  const keys = requirements.provisional({ votes_required: 1, yes_count: 1 }).map((g) => g.key);
  assert.ok(!keys.includes('admin_yes'), 'a locked-app requirement must not be invented');
  assert.ok(!keys.includes('platform_env'), 'nor a platform-variables one');
});

test('an unmeasured row does not read as finished', () => {
  // "Nothing left to check" on a row nothing has looked at is the exact
  // misreading the feature exists to stop, in a new place.
  const block = requirements.readRequirements({ votes_required: 3, yes_count: 3 });
  const s = requirements.summarize(block.gates, {});
  assert.notEqual(s.headline, 'Merging now');
  assert.match(s.detail || '', /working out/);
});

test('every knowable requirement met reads as about to merge, not as unresolved', () => {
  const block = requirements.readRequirements({
    votes_required: 3, yes_count: 3, check_state: 'passing',
    integration_behind_by: 0, integration_merges_clean: true,
  });
  const s = requirements.summarize(block.gates, {});
  assert.equal(s.headline, 'Nothing needs you');
  assert.match(s.detail || '', /merging shortly/);
});

test('a recording supersedes the provisional list wholesale', () => {
  const t = requirements.trace().context({ locked: true, selfHosted: false });
  t.pass('approvals').stop('admin_yes', 'waiting');
  const block = requirements.readRequirements({
    merge_requirements: t.toRecord(),
    // Columns that would have produced a DIFFERENT provisional list.
    votes_required: 3, yes_count: 0, check_state: 'failing',
  });
  assert.equal(block.provisional, false);
  assert.deepEqual(block.gates.map((g) => g.key), ['approvals', 'admin_yes', 'integration', 'checks', 'github']);
  assert.equal(block.gates.find((g) => g.key === 'approvals').state, 'done',
    'the recording wins: the gate saw the real tally, the columns are a snapshot');
});

// ── #2100 / #2095: a recording is about one (head, epoch) ──────────────
//
// "Merging now" stayed on the card after a head move had released the claim,
// and "enough approvals" after an epoch bump had cleared them: the recording
// described the proposal as it was, and nothing retired it.

test('a recording whose approval epoch has moved on is retired in favour of the live columns', () => {
  const t = requirements.trace().context({ locked: false, selfHosted: false, headSha: 'a'.repeat(40), approvalEpoch: 2 });
  t.pass('approvals').pass('integration').pass('checks').stop('github', 'active');
  const block = requirements.readRequirements({
    merge_requirements: t.toRecord(),
    source: 'native', reviewed_head_sha: 'a'.repeat(40), approval_epoch: 3,
    votes_required: 3, yes_count: 0, check_state: 'pending',
  });
  assert.equal(block.provisional, true);
  assert.equal(block.superseded, true);
  assert.notEqual(block.gates.find((g) => g.key === 'approvals').state, 'done',
    'the approvals the run counted belong to an epoch that no longer exists');
  assert.notEqual(block.gates.find((g) => g.key === 'github').state, 'active',
    '"merging now" must not outlive the claim');
});

test('a recording about a commit the proposal has left behind is retired too', () => {
  for (const [source, column] of [['native', 'reviewed_head_sha'], ['imported', 'imported_pr_head_sha']]) {
    const t = requirements.trace().context({ locked: false, selfHosted: false, headSha: 'a'.repeat(40), approvalEpoch: 1 });
    t.pass('approvals').stop('github', 'active');
    const block = requirements.readRequirements({
      merge_requirements: t.toRecord(), source, [column]: 'b'.repeat(40), approval_epoch: 1,
    });
    assert.equal(block.provisional, true, `${source}: the pin moved`);
    assert.equal(block.superseded, true);
  }
});

test('a recording that still matches, or that predates the stamps, is trusted', () => {
  const stamped = requirements.trace().context({ locked: false, selfHosted: false, headSha: 'A'.repeat(40), approvalEpoch: 1 });
  stamped.pass('approvals').stop('checks', 'active');
  const same = requirements.readRequirements({
    merge_requirements: stamped.toRecord(),
    source: 'native', reviewed_head_sha: 'a'.repeat(40), approval_epoch: 1,
  });
  assert.equal(same.provisional, false, 'case-insensitive sha match, same epoch');

  const unstamped = requirements.trace().context({ locked: false, selfHosted: false });
  unstamped.pass('approvals').stop('checks', 'active');
  const legacy = requirements.readRequirements({
    merge_requirements: unstamped.toRecord(),
    source: 'native', reviewed_head_sha: 'b'.repeat(40), approval_epoch: 7,
  });
  assert.equal(legacy.provisional, false, 'no stamps: nothing to compare, trusted as before');
});

// ── The collapsed line, and who it opens for ────────────────────────────

const listStuckOn = (key, actorState, ctx) => {
  const t = requirements.trace().context(ctx || { locked: true, selfHosted: true });
  for (const g of ['approvals', 'explicit', 'admin_yes', 'integration', 'checks', 'platform_env']) {
    if (g === key) break;
    try { t.pass(g); } catch { /* not in this context */ }
  }
  t.stop(key, actorState || 'waiting');
  return requirements.describe(t.toRecord());
};

test('an automatic step needs nobody, whoever is looking', () => {
  const list = listStuckOn('integration', 'active');
  for (const viewer of [{ isAuthor: true }, { isAdmin: true }, { hasVoted: false }, {}]) {
    const s = requirements.summarize(list, viewer);
    assert.equal(s.headline, 'Nothing needs you');
    assert.equal(s.needsViewer, false, 'an automatic step must never open a card');
    assert.equal(s.opensFor, null);
  }
});

test('a blocked step names its role to everyone, and says "you" to the one person', () => {
  const checks = listStuckOn('checks', 'blocked');
  assert.equal(requirements.summarize(checks, { isAuthor: false }).headline, 'Waiting on the author');
  assert.equal(requirements.summarize(checks, { isAuthor: true }).headline, 'Waiting on you');

  const admin = listStuckOn('admin_yes', 'waiting');
  assert.equal(requirements.summarize(admin, { isAdmin: false }).headline, 'Waiting on an admin');
  assert.equal(requirements.summarize(admin, { isAdmin: true }).headline, 'Waiting on you');
});

test('the opening rule: a card opens only for the person who can clear it', () => {
  // The table this feature turns on. An admin-approval row put in front of
  // somebody who is not an admin is a chore they cannot do, and a card that
  // opens for everybody is a card everybody learns to ignore.
  const cases = [
    { stuck: 'checks', state: 'blocked', opensFor: 'author' },
    { stuck: 'admin_yes', state: 'waiting', opensFor: 'admin' },
    { stuck: 'approvals', state: 'waiting', opensFor: 'voter' },
    { stuck: 'platform_env', state: 'waiting', opensFor: 'admin' },
    { stuck: 'integration', state: 'active', opensFor: null },
  ];
  // Each viewer is exactly one role. The roles are NOT exclusive in real life
  // — an author who has not voted is both, and gets their own card opened on
  // the approvals step, which is right: their vote really is missing. Pinning
  // `hasVoted` here is what makes the table a table.
  const viewers = {
    author: { isAuthor: true, hasVoted: true },
    admin: { isAdmin: true, hasVoted: true },
    voter: { hasVoted: false },
    none: { hasVoted: true },
  };
  for (const c of cases) {
    const list = listStuckOn(c.stuck, c.state);
    assert.equal(requirements.summarize(list, {}).opensFor, c.opensFor, `${c.stuck} opensFor`);
    for (const [name, viewer] of Object.entries(viewers)) {
      const opened = requirements.summarize(list, viewer).needsViewer;
      assert.equal(opened, c.opensFor === name,
        `stuck on ${c.stuck}, viewed as ${name}: expected ${c.opensFor === name ? 'open' : 'shut'}`);
    }
  }
});

test('every step done reads as merging, not as an empty checklist', () => {
  const t = requirements.trace().context({ locked: false, selfHosted: false });
  t.pass('approvals').pass('integration').pass('checks').stop('github', 'active');
  t.revise('github', 'done', { note: 'merged' });
  const s = requirements.summarize(requirements.describe(t.toRecord()), {});
  assert.equal(s.headline, 'Merging now');
  assert.equal(s.done, 4);
  assert.equal(s.total, 4);
});

// ── The promise: the description matches the gate that decided ──────────

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// Captures the merge_requirements write so the recording can be read back.
function makePool(opts) {
  const saved = [];
  const pool = {
    async query(sql, params) {
      if (/SET merge_requirements/.test(sql)) {
        saved.push(JSON.parse(params[1]));
        return { rows: [] };
      }
      if (/vote = 'yes'/.test(sql)) return { rows: [{ cnt: String(opts.yes) }] };
      if (/vote = 'no'/.test(sql)) return { rows: [{ cnt: String(opts.no) }] };
      if (/SET status = 'merging'/.test(sql)) return { rows: [{ id: opts.sessionId }] };
      if (/SELECT \* FROM apps WHERE id/.test(sql)) {
        return { rows: [{ id: opts.appId, self_hosted: false, slug: 'widget' }] };
      }
      if (/SELECT id, repo_url, self_hosted FROM apps/.test(sql)) {
        return { rows: [{ id: opts.appId, repo_url: '', self_hosted: false }] };
      }
      if (/SELECT check_state, test_results, checks_checked_at/.test(sql)) {
        return { rows: [{ check_state: opts.checkState || 'passing', test_results: [], checks_checked_at: new Date().toISOString() }] };
      }
      return { rows: [] };
    },
  };
  return { pool, saved };
}

function loadVotes(over) {
  const o = over || {};
  const realActiveUsers = require('../src/services/active-users');
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    docker: require.resolve('../src/services/docker'),
    resolver: require.resolve('../src/services/conflict-resolver'),
    ws: require.resolve('../src/services/ws'),
    activeUsers: require.resolve('../src/services/active-users'),
    notifications: require.resolve('../src/services/notifications'),
    adminApproval: require.resolve('../src/services/admin-approval'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    worker: require.resolve('../src/services/worker'),
    mergeDebug: require.resolve('../src/services/merge-debug'),
    integration: require.resolve('../src/services/integration'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => ({}) });
  stub(ids.github, { isEnabled: () => false, mergePR: async () => ({}) });
  stub(ids.staging, { teardownStaging: async () => {}, rebuildProduction: async () => ({}) });
  stub(ids.docker, {});
  stub(ids.resolver, {
    checkAndResolveConflicts: async () => {}, resolveAndMaybeRetry: async () => ({ ok: true }), isResolving: () => false,
  });
  stub(ids.ws, {
    sendSystemMessage: async () => {}, pushNotificationToUser() {}, pushVoteUpdate() {},
    pushSessionUpdate() {}, pushIssueUpdate() {}, broadcastGlobalScoped() {},
  });
  stub(ids.activeUsers, {
    ...realActiveUsers,
    getActiveUserStats: async () => ({ active: 4, majority: 3 }),
    isUserActive: async () => true,
  });
  stub(ids.notifications, {});
  stub(ids.adminApproval, {
    isAppLocked: async () => !!o.locked,
    hasAdminYesVote: async () => !!o.adminYes,
  });
  stub(ids.events, { record() {}, EVENT_TYPES: { PR_MERGED: 'pr_merged', BOUNTY_AWARDED: 'bounty_awarded' } });
  stub(ids.appAccess, { sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.worker, { destroyCcVolume: async () => {}, isInFlight: () => false });
  stub(ids.mergeDebug, { startRun: async () => 1, step() {}, endRun() {}, pruneOldRuns: async () => {} });
  stub(ids.integration, {
    ...require('../src/services/integration'),
    measureDeduped: async () => o.measured || { behindBy: 0, mergesClean: true, conflictPaths: [] },
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  return {
    subject,
    restore() {
      for (const [k, id] of Object.entries(ids)) {
        if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
      }
    },
  };
}

const DAY = 24 * 60 * 60 * 1000;
const session = {
  id: 7, app_id: 5, app_slug: 'widget', app_self_hosted: false,
  repo_url: '', pr_number: 12, pr_title: 'Tweak', user_id: 3,
  behind_main: 0, linked_issues: [],
  promoted_at: new Date(Date.now() - 30 * DAY).toISOString(),
};

// Each case: the world checkAndMerge is run in, and the gate that must end up
// recorded as the one it stopped at. The point is not that these strings are
// right — it is that they come from the SAME run that refused, so they cannot
// describe a different gate than the one that actually decided.
const DRIFT = [
  {
    name: 'below threshold → approvals',
    world: { yes: 0, no: 0 },
    stuckAt: 'approvals',
  },
  {
    name: 'locked app with no admin yes → admin_yes',
    world: { yes: 4, no: 0 },
    load: { locked: true, adminYes: false },
    stuckAt: 'admin_yes',
  },
  {
    name: 'behind main → integration',
    world: { yes: 4, no: 0 },
    load: { measured: { behindBy: 3, mergesClean: true, conflictPaths: [] } },
    stuckAt: 'integration',
  },
  {
    name: 'checks failing → checks',
    world: { yes: 4, no: 0, checkState: 'failing' },
    stuckAt: 'checks',
  },
];

for (const c of DRIFT) {
  test(`the recording names the gate that actually refused: ${c.name}`, async () => {
    const { subject, restore } = loadVotes(c.load || {});
    try {
      const { pool, saved } = makePool({ ...c.world, sessionId: 7, appId: 5 });
      const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, session, {});
      assert.equal(r.merged, false, 'precondition: this world must not merge');
      assert.ok(saved.length, 'the run recorded what it did');

      const list = requirements.describe(saved[saved.length - 1]);
      const current = list.find((g) => g.state !== 'done' && g.state !== 'pending');
      assert.ok(current, 'a refused run must record where it stopped');
      assert.equal(current.key, c.stuckAt);

      // And the shape holds: nothing past the stop claims to be satisfied.
      const after = list.slice(list.indexOf(current) + 1);
      assert.ok(after.every((g) => g.state === 'pending'),
        `gates after ${c.stuckAt} must all be pending, got ${after.map((g) => g.state).join()}`);
    } finally {
      restore();
    }
  });
}

test('a passing run records every gate as done', async () => {
  const { subject, restore } = loadVotes({});
  try {
    const { pool, saved } = makePool({ yes: 4, no: 0, sessionId: 7, appId: 5 });
    await subject.checkAndMerge({ jwtSecret: 's' }, pool, session, {});
    assert.ok(saved.length, 'the run recorded what it did');
    const list = requirements.describe(saved[saved.length - 1]);
    const byKey = Object.fromEntries(list.map((g) => [g.key, g.state]));
    assert.equal(byKey.approvals, 'done');
    assert.equal(byKey.integration, 'done');
    assert.equal(byKey.checks, 'done');
    assert.ok(['done', 'active', 'blocked'].includes(byKey.github),
      'gate 7 reports a real outcome rather than staying unreached');
  } finally {
    restore();
  }
});

test('the recording is descriptive only — a failed write never blocks a merge', async () => {
  const failing = { async query(sql) {
    if (/SET merge_requirements/.test(sql)) throw new Error('disk on fire');
    if (/vote = 'yes'/.test(sql)) return { rows: [{ cnt: '4' }] };
    if (/vote = 'no'/.test(sql)) return { rows: [{ cnt: '0' }] };
    if (/SET status = 'merging'/.test(sql)) return { rows: [{ id: 7 }] };
    if (/SELECT \* FROM apps WHERE id/.test(sql)) return { rows: [{ id: 5, self_hosted: false, slug: 'widget' }] };
    if (/SELECT check_state/.test(sql)) return { rows: [{ check_state: 'passing', test_results: [] }] };
    return { rows: [] };
  } };
  const { subject, restore } = loadVotes({});
  try {
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, failing, session, {});
    assert.ok(r && typeof r === 'object', 'the merge ran to a verdict despite the write failing');
  } finally {
    restore();
  }
});
