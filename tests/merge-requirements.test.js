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
  assert.deepEqual(keys, ['approvals', 'integration', 'checks', 'main_healthy', 'github']);

  const t2 = requirements.trace().context({ locked: true, selfHosted: true, explicitApproval: true });
  t2.pass('approvals');
  assert.deepEqual(requirements.describe(t2.toRecord()).map((g) => g.key),
    ['approvals', 'explicit', 'admin_yes', 'integration', 'checks', 'platform_env', 'main_healthy', 'github']);
});

test('everything after the refusal is "pending", never "done"', () => {
  // The whole reconstruction rests on this: evaluation stops at the first
  // refusal, so a gate it never reached must not read as satisfied.
  const t = requirements.trace().context({ locked: false, selfHosted: false });
  t.pass('approvals').stop('integration', 'active', { conflictPaths: ['a.js'] });
  const list = requirements.describe(t.toRecord());
  assert.deepEqual(list.map((g) => `${g.key}:${g.state}`),
    ['approvals:done', 'integration:active', 'checks:pending', 'main_healthy:pending', 'github:pending']);
});

test('an evaluated integration entry may name who resolves the conflict', () => {
  // The gate's default actor is the platform. The conflict lane can decide
  // otherwise about a head — the author's fork, a resolution the AI already
  // failed — and the recorded entry carries that, so the card asks the
  // right person.
  const t = requirements.trace().context({ locked: false, selfHosted: false });
  t.pass('approvals').stop('integration', 'blocked', { actor: 'author', note: 'could not resolve it' });
  const list = requirements.describe(t.toRecord());
  assert.equal(list.find((g) => g.key === 'integration').actor, 'author');
  assert.equal(requirements.summarize(list, { isAuthor: true }).headline, 'Waiting on you');

  // Anything that is not an actor is ignored, and the default stands.
  const t2 = requirements.trace().context({ locked: false, selfHosted: false });
  t2.pass('approvals').stop('integration', 'active', { actor: 'robot' });
  assert.equal(requirements.describe(t2.toRecord()).find((g) => g.key === 'integration').actor, 'auto');
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
  assert.deepEqual(block.gates.map((g) => g.key), ['approvals', 'admin_yes', 'integration', 'checks', 'main_healthy', 'github']);
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
  t.pass('approvals').pass('integration').pass('checks').pass('main_healthy').stop('github', 'active');
  t.revise('github', 'done', { note: 'merged' });
  const s = requirements.summarize(requirements.describe(t.toRecord()), {});
  assert.equal(s.headline, 'Merging now');
  assert.equal(s.done, 5);
  assert.equal(s.total, 5);
});

// ── Direct-merge lanes: what the integration step says off the columns ──

test('a clean head is done, however far behind main; the drift is a note', () => {
  // Under direct-merge lanes being behind is not a step — a clean head
  // merges as it stands — so the card must not show a sync that is not
  // going to happen.
  const far = requirements.integrationStep({ integration_merges_clean: true, integration_behind_by: 37 });
  assert.equal(far.state, 'done');
  assert.match(far.note, /37 commits behind main; merges as it stands/);
  const level = requirements.integrationStep({ integration_merges_clean: true, integration_behind_by: 0 });
  assert.equal(level.state, 'done');
  assert.equal(level.note, 'level with main');
  assert.equal(requirements.integrationStep({ integration_merges_clean: null }).state, 'pending');
});

test('a conflict names who resolves it, from what the conflict lane wrote on the row', () => {
  const step = (reasons) => requirements.integrationStep({
    integration_merges_clean: false, integration_conflict_paths: ['a.js', 'b.js'],
    integration_block_reasons: reasons,
  });
  // Nothing decided yet: the platform's.
  assert.deepEqual([step([]).state, step([]).actor], ['active', 'auto']);
  assert.deepEqual([step(['integrating']).state, step(['integrating']).actor], ['active', 'auto']);
  assert.match(step(['integrating']).note, /resolving a conflict with main in 2 files/);
  // The lane will not spend a turn until the vote: the group's.
  assert.deepEqual([step(['awaiting_approval']).state, step(['awaiting_approval']).actor], ['waiting', 'group']);
  assert.match(step(['awaiting_approval']).note, /once the group approves/);
  // The author's, two ways.
  assert.deepEqual([step(['unresolvable']).state, step(['unresolvable']).actor], ['blocked', 'author']);
  assert.deepEqual([step(['fork_head']).state, step(['fork_head']).actor], ['waiting', 'author']);
  // Out of budget: an admin's.
  assert.deepEqual([step(['budget']).state, step(['budget']).actor], ['waiting', 'admin']);
});

test('the provisional list reads a deferred verdict as waiting on the conflict, not on a runner', () => {
  const gates = requirements.provisional({
    votes_required: 1, yes_count: 0, check_state: 'pending', check_phase: 'deferred',
    integration_merges_clean: false, integration_conflict_paths: ['a.js'],
  });
  const checks = gates.find((g) => g.key === 'checks');
  assert.equal(checks.state, 'active');
  assert.match(checks.detail.note, /waiting for the head to merge cleanly/);
});

test('the provisional list names main health only when the serializer has the app columns', () => {
  const without = requirements.provisional({ votes_required: 1, yes_count: 1 }).map((g) => g.key);
  assert.ok(!without.includes('main_healthy'), 'an answer only the gate has is not invented');

  const red = requirements.provisional({
    votes_required: 1, yes_count: 1, check_state: 'passing',
    integration_merges_clean: true, integration_behind_by: 2,
    app_main_check_state: 'failing', app_main_check_sha: 'f'.repeat(40), app_main_check_resumed_sha: null,
  });
  const main = red.find((g) => g.key === 'main_healthy');
  assert.equal(main.state, 'blocked');
  assert.equal(main.actor, 'admin');
  assert.match(main.detail.note, /failing since fffffff/);
  assert.equal(requirements.summarize(red, { isAdmin: true }).headline, 'Waiting on you');

  const resumed = requirements.provisional({
    votes_required: 1, yes_count: 1, check_state: 'passing',
    integration_merges_clean: true, integration_behind_by: 2,
    app_main_check_state: 'failing', app_main_check_sha: 'f'.repeat(40), app_main_check_resumed_sha: 'F'.repeat(40),
  });
  assert.equal(resumed.find((g) => g.key === 'main_healthy').state, 'done', 'an admin resumed merges');
  assert.equal(requirements.summarize(resumed, {}).detail, 'merging shortly',
    'and with every knowable step done the platform is about to try');

  const green = requirements.provisional({
    votes_required: 1, yes_count: 1, app_main_check_state: 'passing', app_main_check_sha: 'g'.repeat(40),
  });
  assert.equal(green.find((g) => g.key === 'main_healthy').state, 'done');
  const never = requirements.provisional({ votes_required: 1, yes_count: 1, app_main_check_state: null });
  assert.equal(never.find((g) => g.key === 'main_healthy').state, 'done', 'never watched is not red');
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
    // Under direct-merge lanes only a CONFLICT stops here; a clean head
    // merges as it stands however far behind (see the case after this).
    name: 'conflicts with main → integration',
    world: { yes: 4, no: 0 },
    load: { measured: { behindBy: 3, mergesClean: false, conflictPaths: ['a.js'] } },
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
    assert.equal(byKey.main_healthy, 'done');
    assert.ok(['done', 'active', 'blocked'].includes(byKey.github),
      'gate 7 reports a real outcome rather than staying unreached');
  } finally {
    restore();
  }
});

test('a clean head behind main passes the integration gate as it stands', async () => {
  // The direct lane. #2038's gate refused here and queued a sync; now the
  // drift is a note on a passed step and the run goes on to the checks.
  const { subject, restore } = loadVotes({ measured: { behindBy: 3, mergesClean: true, conflictPaths: [] } });
  try {
    const { pool, saved } = makePool({ yes: 4, no: 0, sessionId: 7, appId: 5 });
    await subject.checkAndMerge({ jwtSecret: 's' }, pool, session, {});
    const list = requirements.describe(saved[saved.length - 1]);
    const integration = list.find((g) => g.key === 'integration');
    assert.equal(integration.state, 'done');
    assert.match(integration.detail.note, /3 commits behind main; merges as it stands/);
  } finally {
    restore();
  }
});

test('a red main stops the run at main_healthy, for the admin', async () => {
  const { subject, restore } = loadVotes({});
  try {
    const { pool, saved } = makePool({ yes: 4, no: 0, sessionId: 7, appId: 5 });
    const inner = pool.query.bind(pool);
    pool.query = async (sql, params) => {
      if (/SELECT main_check_state, main_check_sha/.test(sql)) {
        return { rows: [{ main_check_state: 'failing', main_check_sha: 'f'.repeat(40), main_check_resumed_sha: null }] };
      }
      return inner(sql, params);
    };
    const r = await subject.checkAndMerge({ jwtSecret: 's' }, pool, session, {});
    assert.equal(r.merged, false);
    assert.equal(r.blockReason, 'main_failing');
    const list = requirements.describe(saved[saved.length - 1]);
    const current = list.find((g) => g.state !== 'done' && g.state !== 'pending');
    assert.equal(current.key, 'main_healthy');
    assert.equal(current.state, 'blocked');
    assert.equal(requirements.summarize(list, { isAdmin: true }).headline, 'Waiting on you');
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
