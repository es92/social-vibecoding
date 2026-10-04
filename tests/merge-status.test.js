// #405: unit tests for the shared merge-lifecycle helper
// (public/js/merge-status.js). The helper is the single source of truth for
// a proposal's canonical merge state across the feed card, the home strip,
// and the dev session header — so its lifecycle derivation precedence and its
// missing-vote-data fallback are the contract every surface relies on.
//
// merge-status.js is UMD (module.exports under Node), so it's required
// directly with no vm/sandbox harness.
//
// Run with: node --test tests/merge-status.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const MergeStatus = require('../public/js/merge-status.js');

// Convenience: derive just the canonical key.
const key = (p, opts) => MergeStatus.lifecycle(p, opts).key;

test('state 1 — merged outranks everything', () => {
  const life = MergeStatus.lifecycle({
    status: 'merged', check_state: 'failing', merge_conflict_state: 'failed',
    behind_main: 5, yes_count: 0, majority: 9,
  });
  assert.equal(life.key, 'merged');
  assert.equal(life.label, 'Merged');
  assert.equal(life.tone, 'violet');
  assert.equal(life.spinner, false);
});

test('state 2 — merging outranks behind_main / checks', () => {
  const life = MergeStatus.lifecycle({
    status: 'merging', behind_main: 3, check_state: 'failing',
  });
  assert.equal(life.key, 'merging');
  assert.equal(life.label, 'Merging…');
  assert.equal(life.tone, 'amber');
  assert.equal(life.spinner, true);
});

test('state 3 — resolving from persisted snapshot AND from the process-local flag', () => {
  assert.equal(key({ status: 'promoted', merge_conflict_state: 'resolving' }), 'resolving');
  assert.equal(key({ status: 'promoted', resolving: true }), 'resolving');
  const life = MergeStatus.lifecycle({ status: 'promoted', resolving: true });
  assert.equal(life.tone, 'amber');
  assert.equal(life.spinner, true);
});

test('state 4 — conflict_failed beats checks pending (precedence)', () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', merge_conflict_state: 'failed', check_state: 'pending',
  });
  assert.equal(life.key, 'conflict_failed');
  assert.equal(life.tone, 'red');
});

test('state 5b — checks failing is amber, with failing-test count in the label', () => {
  const failing = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'failing',
    test_results: [
      { status: 'pass' }, { status: 'fail' }, { status: 'fail' },
    ],
  });
  assert.equal(failing.key, 'checks_failing');
  assert.equal(failing.label, 'Checks failing · 2');
  assert.equal(failing.tone, 'amber');
});

// #2328: check-run errors and preview boot failures are separate facts.
// A generic error keeps the healthy preview available and names the runner;
// an explicit staging_error keeps the established boot-failure badge.
test("state 5a — checks error renders a distinct red \"Checks couldn't run\" badge", () => {
  const runnerError = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'error',
    check_error_detail: 'capture worker disappeared before writing browser rows',
  });
  assert.equal(runnerError.key, 'checks_error');
  assert.equal(runnerError.label, "Checks couldn't run");
  assert.equal(runnerError.tone, 'red');
  assert.match(runnerError.title, /capture worker/);

  // Without a captured reason it still names the checks runner, not the app.
  const bare = MergeStatus.lifecycle({ status: 'promoted', check_state: 'error' });
  assert.equal(bare.key, 'checks_error');
  assert.equal(bare.tone, 'red');

  const boot = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'error', preview_state: 'failed',
    staging_error: '[exited (exit=1)] app failed to start',
  });
  assert.equal(boot.key, 'preview_failed');
  assert.equal(boot.label, "Preview won't boot");
  assert.match(boot.title, /app failed to start/);
});

test('state 6 — checks pending is neutral + spinner (not amber)', () => {
  const life = MergeStatus.lifecycle({ status: 'promoted', check_state: 'pending' });
  assert.equal(life.key, 'checks_running');
  assert.equal(life.label, 'Checks running…');
  assert.equal(life.tone, 'neutral');
  assert.equal(life.spinner, true);
});

test('state 6 — a run older than a minute says how long it has been going (#3232)', () => {
  const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'pending', checks_checked_at: minsAgo(12.5),
  });
  assert.equal(life.key, 'checks_running');
  assert.equal(life.label, 'Checks running · 12 min');
  assert.equal(life.tone, 'neutral');
  assert.equal(life.spinner, true);
  assert.match(MergeStatus.pillHtml(life), /Checks running · 12 min/);
  assert.equal(MergeStatus.lifecycle({
    status: 'promoted', check_state: 'pending', checks_checked_at: minsAgo(1),
  }).label, 'Checks running · 1 min');
});

test('state 6 — under a minute, or with no usable start time, keeps "Checks running…" (#3232)', () => {
  const at = (ms) => new Date(Date.now() + ms).toISOString();
  for (const checks_checked_at of [at(-30 * 1000), at(5 * 60000), 'not-a-date', null, undefined]) {
    const life = MergeStatus.lifecycle({ status: 'promoted', check_state: 'pending', checks_checked_at });
    assert.equal(life.label, 'Checks running…', String(checks_checked_at));
  }
  // A deferred run is not running, so it never carries a duration.
  assert.equal(MergeStatus.lifecycle({
    status: 'promoted', check_state: 'pending', check_phase: 'deferred',
    checks_checked_at: at(-20 * 60000),
  }).label, 'Checks deferred');
});

test('state 6b — checks skipped (#461) is neutral, terminal (no spinner) and carries the reason', () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'skipped',
    check_error_detail: 'branch has no commits beyond main, so there is nothing to test',
  });
  assert.equal(life.key, 'checks_skipped');
  assert.equal(life.label, 'Checks skipped');
  assert.equal(life.tone, 'neutral');
  assert.equal(life.spinner, false);
  assert.ok(/nothing to test/.test(life.title), 'tooltip carries the recorded reason');
  assert.ok(/can still go live/.test(life.title), 'tooltip says it is not blocked');
  // No recorded reason → generic non-blocking tooltip, never "undefined".
  const bare = MergeStatus.lifecycle({ status: 'promoted', check_state: 'skipped' });
  assert.equal(bare.key, 'checks_skipped');
  assert.ok(!/undefined/.test(bare.title));
});

test('state 6b — checks skipped outranks behind_main (precedence)', () => {
  // Per the #461 precedence, the explicit skipped verdict sits between the
  // pending rung and the behind-main rung.
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'skipped', behind_main: 2,
  });
  assert.equal(life.key, 'checks_skipped');
});

test('state 10b — active draft with green checks says checks passed', () => {
  const life = MergeStatus.lifecycle({ status: 'active', check_state: 'passing' });
  assert.equal(life.key, 'checks_passed');
  assert.equal(life.label, 'Checks passed');
  assert.equal(life.tone, 'green');
  assert.equal(life.spinner, false);
  assert.match(life.title, /ready to send for approval/);
});

test('state 7 — behind main, with the commit count in the label', () => {
  const life = MergeStatus.lifecycle({ status: 'promoted', behind_main: 4, check_state: 'passing' });
  assert.equal(life.key, 'behind');
  assert.equal(life.label, 'Behind main · 4');
  assert.equal(life.tone, 'amber');
  // A 'behind' snapshot with no count still resolves. (A verdict is set —
  // with none recorded the #607 checks-starting rung would outrank behind,
  // same as 'pending' does.)
  assert.equal(key({ status: 'promoted', merge_conflict_state: 'behind', check_state: 'passing' }), 'behind');
});

// Silent-merge-failure fix: a 'conflict' snapshot means a REAL merge attempt
// 405'd at GitHub (routes/votes.js is the only writer). It no longer hides
// behind the reassuring "Behind main" badge — the auto-resolver only picks
// up vote-eligible proposals, so below the gate nothing would ever happen
// and nobody was told. Red, and the tooltip names the way out (the creator
// finishing the merge from their session).
test("state 4b — 'conflict' (merge attempt failed) is red and says the creator must finish", () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', merge_conflict_state: 'conflict', check_state: 'passing', behind_main: 1,
  });
  assert.equal(life.key, 'merge_conflict');
  assert.equal(life.label, 'Merge failed: conflict');
  assert.equal(life.tone, 'red');
  assert.match(life.title, /creator needs to bring it up to date/);
  assert.match(life.title, /Sync with main/);
  // While the auto-resolver actually runs, the in-flight state wins so the
  // card shows progress, not a stale failure.
  assert.equal(
    key({ status: 'promoted', merge_conflict_state: 'conflict', resolving: true }),
    'resolving'
  );
  // 'failed' (resolver ran and gave up) still outranks it.
  assert.equal(
    key({ status: 'promoted', merge_conflict_state: 'failed' }),
    'conflict_failed'
  );
});

test('state 8 — awaiting admin: locked + majority reached', () => {
  const life = MergeStatus.lifecycle(
    { status: 'promoted', check_state: 'passing', yes_count: 5 },
    { majority: 3, locked: true }
  );
  assert.equal(life.key, 'awaiting_admin');
  assert.equal(life.tone, 'amber');
  // Not locked → falls through to ready.
  assert.equal(
    key({ status: 'promoted', check_state: 'passing', yes_count: 5 }, { majority: 3 }),
    'ready'
  );
});

test('state 9 — ready: passed the vote with green checks and not behind', () => {
  const life = MergeStatus.lifecycle(
    { status: 'promoted', check_state: 'passing', behind_main: 0, yes_count: 3 },
    { majority: 3 }
  );
  assert.equal(life.key, 'ready');
  assert.equal(life.label, 'Approved, going live shortly');
  assert.equal(life.tone, 'green');
  // Past threshold but checks NOT passing → not ready (the gate blocks it).
  // #607: with no verdict recorded at all the row reads as checks-starting
  // (in progress), never falsely "ready".
  assert.equal(
    key({ status: 'promoted', check_state: null, yes_count: 9 }, { majority: 3 }),
    'checks_running'
  );
});

// #607: a promoted row with NO verdict recorded yet (fresh proposal whose
// first run hasn't stamped 'pending' — e.g. the promote-time staging build
// is still going) reads as checks-in-progress, not as a plain vote state.
// Rows carrying a console snapshot are genuine pre-#47 legacy and keep
// falling through.
test('state 6a (#607) — promoted with no verdict and no console snapshot reads as checks starting', () => {
  const life = MergeStatus.lifecycle({ status: 'promoted' });
  assert.equal(life.key, 'checks_running');
  assert.equal(life.label, 'Checks starting…');
  assert.equal(life.tone, 'neutral');
  assert.equal(life.spinner, true);
  // Legacy pre-#47 row (console snapshot recorded, no check_state) falls
  // through to the vote states as before.
  assert.equal(
    key({ status: 'promoted', console_check_state: 'clean', yes_count: 1 }, { majority: 3 }),
    'in_vote'
  );
});

test('state 10 — in vote (below majority)', () => {
  const life = MergeStatus.lifecycle(
    { status: 'promoted', check_state: 'passing', yes_count: 1 },
    { majority: 3 }
  );
  assert.equal(life.key, 'in_vote');
  assert.equal(life.label, 'Waiting for approval');
  assert.equal(life.tone, 'violet');
  // votes ride along for the pill renderer.
  assert.deepEqual(life.votes, { yes: 1, majority: 3, reached: false });
});

test('state 11 — draft (active, not yet proposed)', () => {
  const life = MergeStatus.lifecycle({ status: 'active' });
  assert.equal(life.key, 'draft');
  assert.equal(life.label, 'Draft');
  assert.equal(life.tone, 'neutral');
});

test('missing vote data → in_vote stays tally-free (never falsely "ready")', () => {
  // No yes_count: a promoted+passing row with unknown votes must not be
  // treated as past-threshold. It reads as plain "In vote".
  const life = MergeStatus.lifecycle({ status: 'promoted', check_state: 'passing' });
  assert.equal(life.key, 'in_vote');
  assert.equal(life.votes, undefined);
});

test('unknown / non-merge status → none (no badge)', () => {
  assert.equal(key({ status: 'paused' }), 'none');
  assert.equal(key({ status: 'archived' }), 'none');
  assert.equal(key({}), 'none');
  assert.equal(MergeStatus.lifecycle({ status: 'paused' }).label, '');
});

test('badgeHtml: renders the label with the tone class + spinner; escapes the label', () => {
  const merging = MergeStatus.badgeHtml(MergeStatus.lifecycle({ status: 'merging' }));
  assert.match(merging, /ms-badge-amber/);
  assert.match(merging, /dc-status-spinner-arc/);
  assert.match(merging, /Merging…/);

  // 'none' renders nothing.
  assert.equal(MergeStatus.badgeHtml(MergeStatus.lifecycle({ status: 'paused' })), '');
});

test('pillHtml: in-vote pill appends the tally; badgeHtml does not', () => {
  const life = MergeStatus.lifecycle(
    { status: 'promoted', check_state: 'passing', yes_count: 2 },
    { majority: 5 }
  );
  const pill = MergeStatus.pillHtml(life);
  assert.match(pill, /ms-pill-violet/);
  assert.match(pill, /Waiting for approval · 2\/5/);
  // The text-style badge stays compact (the surfaces that use it show a
  // separate vote pill), so it must NOT carry the tally.
  assert.match(MergeStatus.badgeHtml(life), /Waiting for approval/);
  assert.doesNotMatch(MergeStatus.badgeHtml(life), /2\/5/);
});

// #695: the per-row votes_required (the governed gate's electorate-based
// requirement, and the merge-time snapshot on merged rows) beats any
// app-level majority — matching voteCountPill's precedence. On
// invited-approver apps the app-level majority counts the wrong electorate.
test('#695 — votes_required outranks opts.majority / p.majority', () => {
  const life = MergeStatus.lifecycle(
    { status: 'promoted', check_state: 'passing', yes_count: 1, votes_required: 1, majority: 3 },
    { majority: 3 }
  );
  assert.equal(life.key, 'ready');
  assert.equal(life.votes.majority, 1);
  // Absent votes_required → app-level majority resolves as before.
  assert.equal(
    key({ status: 'promoted', check_state: 'passing', yes_count: 1, majority: 3 }),
    'in_vote'
  );
});

test('#695 — invited policy: qualified tally is the headline, surplus is advisory', () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'passing',
    yes_count: 2, qualified_yes_count: 0, votes_required: 1,
    approval_policy: 'invited',
  });
  // Two non-approver Yes votes must NOT read as passed.
  assert.equal(life.key, 'in_vote');
  assert.equal(life.votes.yes, 0);
  assert.equal(life.votes.advisory, 2);
});

test('#695 — advisory is only computed under the invited policy', () => {
  const anyone = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'passing',
    yes_count: 2, qualified_yes_count: 2, votes_required: 3,
    approval_policy: 'anyone',
  });
  assert.equal(anyone.key, 'in_vote');
  assert.equal(anyone.votes.advisory, undefined);
  // No qualified count serialized → no advisory either, even when invited.
  const stale = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'passing',
    yes_count: 2, votes_required: 3, approval_policy: 'invited',
  });
  assert.equal(stale.votes.advisory, undefined);
});

test('#695 — pillHtml appends the muted +N advisory suffix to the in-vote tally', () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'passing',
    yes_count: 3, qualified_yes_count: 1, votes_required: 2,
    approval_policy: 'invited',
  });
  assert.equal(life.key, 'in_vote');
  const pill = MergeStatus.pillHtml(life);
  assert.match(pill, /Waiting for approval · 1\/2/);
  assert.match(pill, /ms-advisory/);
  assert.match(pill, /\+2</);
  // The compact text badge (separate vote pill beside it) stays tally-free.
  assert.doesNotMatch(MergeStatus.badgeHtml(life), /ms-advisory/);
});

// STATE_BADGE_KEYS and its test are deleted (#2038). The constant was
// exported and documented as "keys whose badge belongs in the feed card's
// state slot", but no renderer ever read it — only this test and
// platform-update-nudge did. #2026 moved that decision into
// AppView.statusTagSpecs, so the list was pinned in step with a card it did
// not drive.


// ── #1442: predicted conflict and the measured behind count ────────────
//
// behind_main and merge_conflict_state are both written by events a WAITING
// proposal does not have, so proposal 3590 read "in vote, all checks passed"
// while it was eight commits behind and conflicting in seven files. The
// freshness measurement is the only thing that knows, so the lifecycle has to
// read it — under a real merge attempt, over the checks states.

test('#1442 state 4c — a predicted conflict is a red rung of its own', () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'passing', yes_count: 1, majority: 1,
    freshness: { mergeability: 'conflict', mergeabilityFiles: ['a.js', 'b.js'], behindBy: 8 },
  });
  assert.equal(life.key, 'mergeability_conflict');
  assert.equal(life.label, 'Conflicts with main · 2');
  assert.equal(life.tone, 'red');
  assert.equal(life.spinner, false);
  assert.match(life.title, /no longer merges/i);
  assert.match(life.title, /Sync with main/);
});

test('#1442 state 4c — with no located files the count is dropped, not zeroed', () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'passing',
    freshness: { mergeability: 'conflict', mergeabilityFiles: [] },
  });
  assert.equal(life.label, 'Conflicts with main');
});

test('#1442 — an ATTEMPTED merge failure still outranks the prediction', () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', merge_conflict_state: 'conflict', check_state: 'passing',
    freshness: { mergeability: 'conflict', mergeabilityFiles: ['a.js'] },
  });
  assert.notEqual(life.key, 'mergeability_conflict', 'the real attempt is the better answer');
});

test('#1442 — a predicted conflict outranks failing checks', () => {
  // Deliberate, and the same order AppView.blockReasons uses: a conflict has
  // one remedy (sync and resolve), and checks that failed against a base main
  // has moved past are frequently a symptom of the same drift. Fixing the
  // drift is what makes the checks meaningful again, so it is the thing to
  // put in front of the voter.
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'failing',
    freshness: { mergeability: 'conflict', mergeabilityFiles: ['a.js'] },
  });
  assert.equal(life.key, 'mergeability_conflict');
  assert.equal(life.tone, 'red', 'either way the pill is blocked, never a tally');
});

test("#1442 — 'clean' and 'unknown' never produce a conflict rung", () => {
  for (const m of ['clean', 'unknown', null, undefined, 'mergeable']) {
    const life = MergeStatus.lifecycle({
      status: 'promoted', check_state: 'passing', yes_count: 0, majority: 3,
      freshness: { mergeability: m },
    });
    assert.notEqual(life.key, 'mergeability_conflict', `${m} is not a conflict`);
  }
});

test('#1442 — the measured behind count beats a stale behind_main', () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'passing', behind_main: 0,
    freshness: { mergeability: 'clean', behindBy: 8 },
  });
  assert.equal(life.key, 'behind');
  assert.equal(life.label, 'Behind main · 8',
    'the frozen 0 is exactly the number that made 3590 look ready');
});

test('#1442 — a measured zero clears a stale non-zero behind_main', () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'passing', behind_main: 5, yes_count: 0, majority: 3,
    freshness: { mergeability: 'clean', behindBy: 0 },
  });
  assert.notEqual(life.key, 'behind', 'a sync happened; the badge goes away');
});

test('#1442 — an unmeasured row behaves exactly as before', () => {
  const before = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'passing', behind_main: 3,
  });
  const after = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'passing', behind_main: 3,
    freshness: { mergeability: null, behindBy: null },
  });
  assert.equal(after.key, before.key);
  assert.equal(after.label, before.label);
  assert.equal(after.label, 'Behind main · 3');
});

test('#1442 — the flat columns are read when no nested block is present', () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'passing',
    mergeability: 'conflict', mergeability_files: ['x.js'],
  });
  assert.equal(life.key, 'mergeability_conflict');
  assert.equal(life.label, 'Conflicts with main · 1');
});

test('#1442 — merged and merging still outrank everything measured', () => {
  for (const status of ['merged', 'merging']) {
    const life = MergeStatus.lifecycle({
      status,
      freshness: { mergeability: 'conflict', mergeabilityFiles: ['a.js'], behindBy: 9 },
    });
    assert.equal(life.key, status);
  }
});

test('#1442 — junk in the freshness block cannot throw', () => {
  for (const freshness of ['nope', 42, [], { mergeabilityFiles: 'oops' }, null]) {
    assert.doesNotThrow(() => MergeStatus.lifecycle({ status: 'promoted', freshness }));
  }
});

// B10a: one word for a change that waits on its Yes votes, and the
// creator's own words on a project that is just them.
test('B10a: waiting for approval, and for your approval on a project that is just you', () => {
  const p = { status: 'promoted', check_state: 'passing', yes_count: 0, votes_required: 1 };
  assert.equal(MergeStatus.lifecycle(p).label, 'Waiting for approval');
  assert.equal(MergeStatus.lifecycle({ ...p, app_audience: 'solo' }).label, 'Waiting for your approval');
  assert.equal(MergeStatus.lifecycle(p, { audience: 'solo' }).label, 'Waiting for your approval');
  assert.equal(MergeStatus.lifecycle({ ...p, app_audience: 'solo', votes_required: 2 }).label, 'Waiting for approval',
    'a rule asking for two Yes votes is not one tap of yours');
  assert.equal(MergeStatus.lifecycle({ ...p, app_audience: 'invited' }).label, 'Waiting for approval');
});

test('B10a: the session payload says whose project it is, so the header pill can say "your approval"', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8');
  assert.match(src, /const membership = await communities\.getMembership\(pool, \{ id: rows\[0\]\.app_id \}, req\.user\.id\);\n\s+rows\[0\]\.app_audience = membership \? membership\.audience : null;/);
});
