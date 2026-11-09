// #6546: an approved change GitHub refuses over its required status checks.
//
// On 9 Nov 2026 two approved, green, cleanly merging Homeroom bot changes
// read "Up for a vote" while GitHub refused to merge them: PR 6520 while its
// required checks were still running (it merged at the next 4-minute retry),
// PR 6521 because two of them had failed against an older main (a network
// blip, and an image scan main had fixed since). Nothing re-ran those, so
// every retry met the same failures.
//
// What this pins, without a database:
//   - routes/votes.js githubChecksOf tells GitHub's words apart (still
//     running, failed, or a refusal about something else), and the thread's
//     refusal line says when it is really tried again;
//   - the proposal machine records the hold by kind, and a failed one on a
//     head behind main is brought up to date with main once per approval
//     epoch, in the refusal's own transition;
//   - a sync that pushed nothing spends nothing;
//   - the work state reads an approved change GitHub holds as Going live,
//     with its line, on the server and in the browser's words;
//   - the change card and the Votes card say the same.
//
// Run with: node --test tests/github-checks-hold.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── GitHub's words ─────────────────────────────────────────────────────

test('githubChecksOf: GitHub\'s required-checks refusals, told apart by its own words', () => {
  const { githubChecksOf } = require('../src/routes/votes');
  // PR 6520, 9 Nov: voted 7 s before its last required job finished.
  assert.equal(githubChecksOf('3 of 6 required status checks are in progress.'), 'pending');
  assert.equal(githubChecksOf('Required status check "Build and scan worker" is expected.'), 'pending');
  // PR 6521, 9 Nov: two required jobs had failed.
  assert.equal(githubChecksOf('3 of 7 required status checks have not succeeded: 1 expected and 2 failing.'), 'failing');
  assert.equal(githubChecksOf('Required status check "Build and scan platform" is failing.'), 'failing');
  assert.equal(githubChecksOf('2 of 6 required status checks have not succeeded.'), 'failing', 'nothing says they are still running');
  // Anything else is not about the checks.
  assert.equal(githubChecksOf('At least 1 approving review is required by reviewers with write access.'), null);
  assert.equal(githubChecksOf('Pull Request is not mergeable'), null);
  assert.equal(githubChecksOf(''), null);
  assert.equal(githubChecksOf(null), null);
});

test('the refusal line says when it is tried again, by kind', () => {
  const src = read('src/routes/votes.js');
  assert.doesNotMatch(src, /tried again when its commit, main or its votes change/,
    'a plain refusal is retried on the queue\'s clock (REFUSAL_RETRY_MS), not only when something changes');
  assert.match(src, /GitHub refused it \(\$\{said \|\| 'no reason given'\}\)\. It is tried again in a few minutes\./);
  assert.match(src, /GitHub's required checks on it are still running\. Homeroom tries again every few minutes and merges it once they pass\./);
  assert.match(src, /GitHub's required checks on it failed \(\$\{said\}\)\. Homeroom brings it up to date with main once, which runs them again/);
  assert.match(src, /\.\.\.\(githubChecks \? \{ githubChecks \} : \{\}\)/, 'the refusal carries what the checks said to the machine');
});

// ── The proposal machine ───────────────────────────────────────────────

const SHA = (c) => c.repeat(40);
const NOW = new Date('2026-11-09T18:49:19Z');

function machine() {
  const { proposal } = require('../src/workflow/proposal/machine.ts');
  return proposal({ idleMs: 0, exemptFixtures: false, reviewCheckMs: 60 * 60 * 1000, staleNotifyMs: 0, staleGraceMs: 0 });
}

function rowWith(over = {}) {
  return {
    id: 13183, appId: 10, appSlug: 'usernode-2d5619', selfHosted: true, repo: { owner: 'Usernode-Labs', repo: 'social-vibecoding' },
    userId: 3, ownerName: 'homeroom_bot', ownerSynthetic: false, status: 'merging', imported: false, headless: false,
    prNumber: 6521, prTitle: 'Let people mention Homeroom bot as @homeroombot', branch: 'dev/homeroom_bot-6542',
    head: SHA('7'), reviewedHead: SHA('7'), importedHead: null, epoch: 4, promotedAt: '2026-11-09T18:33:26Z',
    createdAt: '2026-11-09T18:20:00Z', staleNotifiedAt: null, lastActivityAt: '2026-11-09T18:40:00Z', linkedIssues: [6542],
    agentSessionId: null, explicitApproval: false, explicitReason: null, mergeAttemptAt: null, shots: false, fixture: false,
    activeTurn: false, workedOn: false, moving: false, shotsRunning: false, buildHold: false, pendingSecret: false,
    checkState: 'passing', checksCommitSha: SHA('7'), bootFailureSyncHead: null, fixedCheckSyncHead: null, fixedCheckSyncKeys: [],
    integrationHead: SHA('7'), integrationMain: SHA('4'), integrationBehindBy: 4, integrationResolvedEpoch: null, forkHead: false,
    baseRef: null, waitsFor: null, ...over,
  };
}

function merging(data = {}) {
  return {
    name: 'merging',
    data: {
      sessionId: 13183, appId: 10, imported: false, slot: 'none', promoting: null, answer: null, reason: null,
      claim: { n: 3, at: '2026-11-09T18:49:13Z' }, pr: { running: null, next: [] }, doomed: [], n: 3,
      attempt: { n: 3, queueN: 9, stage: 'merge', head: SHA('7'), epoch: 4, force: false, forcedBy: null, tally: null },
      ...data,
    },
  };
}

function refusedBy(m, s, result, row = {}) {
  const { WORK } = require('../src/workflow/proposal/machine.ts');
  const event = { id: 237182, type: 'WorkSucceeded', source: { kind: 'service', workId: 'w1' },
    payload: { sessionId: 13183, kind: WORK.attempt, workKey: 'attempt:3', result: { outcome: 'refused', kind: 'blocked', ...result } } };
  const facts = { row: rowWith(row), caps: null, gate: null, interestAt: null, mergesPaused: false, electorate: null, waiting: [] };
  return m.entryFor(s.name, 'WorkSucceeded').to(s, event, facts, { now: NOW, key: 'session:13183' });
}

const held = (out) => (out.writes || []).filter((w) => w.type === 'mergeHeld').map((w) => w.reason);
const syncWork = (out) => {
  const { WORK } = require('../src/workflow/proposal/machine.ts');
  return (out.work || []).filter((w) => w.kind === WORK.sync);
};

test('failed required checks on a head behind main: brought up to date with main in the same transition, once per epoch', () => {
  const out = refusedBy(machine(), merging(), {
    message: 'GitHub\'s required checks on it failed', githubMessage: '3 of 7 required status checks have not succeeded: 1 expected and 2 failing.',
    githubChecks: 'failing',
  });
  assert.equal(out.next.name, 'in_review', 'back in review, its votes kept');
  assert.deepEqual(held(out), ['github_checks'], 'the card says it waits on GitHub\'s checks');
  assert.equal(out.next.data.refused.checks, 'failing');
  assert.ok(out.next.data.refused.retryAt, 'still tried again on the queue\'s clock');
  const [sync] = syncWork(out);
  assert.ok(sync, 'a sync with main begins');
  assert.equal(sync.input.reason, 'github_checks');
  assert.equal(sync.input.measureFirst, true, 'only a head behind main that merges cleanly is synced');
  assert.equal(sync.input.waitForIdle, true);
  assert.equal(out.next.data.sync.reason, 'github_checks');
  assert.deepEqual(out.next.data.githubChecksSync, { epoch: 4, head: SHA('7'), at: NOW.toISOString() });
});

test('failed again in the same approval epoch: no second sync, and the card says they are failing', () => {
  const out = refusedBy(machine(), merging({ githubChecksSync: { epoch: 4, head: SHA('6'), at: '2026-11-09T18:50:00Z' } }),
    { githubChecks: 'failing' });
  assert.deepEqual(syncWork(out), [], 'not synced on every move of main');
  assert.deepEqual(held(out), ['github_checks_failing']);
  // A new approval epoch (an authored push cleared the votes) may sync again.
  const fresh = refusedBy(machine(), merging({ githubChecksSync: { epoch: 3, head: SHA('6'), at: '2026-11-09T12:00:00Z' } }),
    { githubChecks: 'failing' });
  assert.equal(syncWork(fresh).length, 1);
  assert.deepEqual(held(fresh), ['github_checks']);
});

test('still running: no sync, the hold says so, and the clock retries', () => {
  const out = refusedBy(machine(), merging(), { githubChecks: 'pending', githubMessage: '3 of 6 required status checks are in progress.' });
  assert.deepEqual(syncWork(out), []);
  assert.deepEqual(held(out), ['github_checks']);
  assert.equal(out.next.data.refused.checks, 'pending');
  assert.ok(out.next.data.refused.retryAt);
});

test('no sync for a head level with main, or one on its author\'s fork', () => {
  const level = refusedBy(machine(), merging(), { githubChecks: 'failing' }, { integrationBehindBy: 0 });
  assert.deepEqual(syncWork(level), [], 'nothing to bring in: it waits for main to move');
  assert.deepEqual(held(level), ['github_checks']);
  const fork = refusedBy(machine(), merging(), { githubChecks: 'failing' }, { forkHead: true });
  assert.deepEqual(syncWork(fork), [], 'an author\'s fork is theirs to bring up to date');
});

test('any other refusal keeps its old hold, and is named again when the checks turn from running to failed', () => {
  const plain = refusedBy(machine(), merging(), { githubMessage: 'Repository rule violations found' });
  assert.deepEqual(held(plain), ['github_refused']);
  assert.deepEqual(syncWork(plain), []);
  assert.equal(plain.next.data.refused.checks, null);
  const said = (out) => (out.writes || []).filter((w) => w.type === 'line').length;
  const running = merging({ refused: { head: SHA('7'), main: SHA('4'), kind: 'blocked', checks: 'pending', retryAt: null } });
  assert.equal(said(refusedBy(machine(), running, { message: 'still running', githubChecks: 'pending' })), 0, 'the same refusal is named once per head');
  assert.equal(said(refusedBy(machine(), running, { message: 'failed', githubChecks: 'failing' })), 1, 'a new verdict is named');
});

test('a GitHub-checks sync that pushed nothing gives its once-record back', () => {
  const { WORK } = require('../src/workflow/proposal/machine.ts');
  const m = machine();
  for (const outcome of ['level', 'conflict_skipped', 'busy', 'unmeasured']) {
    const s = { name: 'in_review', data: { ...merging().data, attempt: null, claim: null, n: 4,
      sync: { n: 4, reason: 'github_checks', head: SHA('7'), queueN: null, approved: false, at: NOW.toISOString() },
      githubChecksSync: { epoch: 4, head: SHA('7'), at: NOW.toISOString() } } };
    const event = { id: 9, type: 'WorkSucceeded', source: { kind: 'service', workId: 'w2' },
      payload: { sessionId: 13183, kind: WORK.sync, workKey: 'sync:4', result: { outcome } } };
    const facts = { row: rowWith({ status: 'promoted' }), caps: null, gate: null, interestAt: null, mergesPaused: false, electorate: null, waiting: [] };
    const out = m.entryFor('in_review', 'WorkSucceeded').to(s, event, facts, { now: NOW, key: 'session:13183' });
    assert.equal(out.next.data.githubChecksSync, null, `${outcome}: may be asked again`);
  }
  const s = { name: 'in_review', data: { ...merging().data, attempt: null, claim: null, n: 4,
    sync: { n: 4, reason: 'github_checks', head: SHA('7'), queueN: null, approved: false, at: NOW.toISOString() },
    githubChecksSync: { epoch: 4, head: SHA('7'), at: NOW.toISOString() } } };
  const event = { id: 9, type: 'WorkSucceeded', source: { kind: 'service', workId: 'w2' },
    payload: { sessionId: 13183, kind: WORK.sync, workKey: 'sync:4', result: { outcome: 'clean', pushOk: true, sha: SHA('8') } } };
  const facts = { row: rowWith({ status: 'promoted' }), caps: null, gate: null, interestAt: null, mergesPaused: false, electorate: null, waiting: [] };
  const out = machine().entryFor('in_review', 'WorkSucceeded').to(s, event, facts, { now: NOW, key: 'session:13183' });
  assert.deepEqual(out.next.data.githubChecksSync, { epoch: 4, head: SHA('7'), at: NOW.toISOString() }, 'a sync that pushed keeps it');
});

test('the hold is written and cleared as one set: a new head starts without it', () => {
  const src = read('src/workflow/proposal/machine.ts');
  const strip = "- 'github_busy' - 'github_refused' - 'github_checks' - 'github_checks_failing'";
  const mergeHeld = src.slice(src.indexOf('  mergeHeld: async'), src.indexOf('  // The once-records of the platform'));
  assert.ok(mergeHeld.includes(strip), 'mergeHeld replaces any earlier hold');
  const headMoved = src.slice(src.indexOf('  headMoved: async'), src.indexOf('  approvalsCleared: async'));
  assert.ok(headMoved.includes(strip), 'a head move clears the hold of the head it replaced');
  const { GITHUB_HOLD_REASONS, SYNC_REASONS } = require('../src/workflow/proposal/machine.ts');
  assert.deepEqual([...GITHUB_HOLD_REASONS], ['github_busy', 'github_refused', 'github_checks', 'github_checks_failing']);
  assert.ok(SYNC_REASONS.has('github_checks'));
  assert.match(read('src/services/sync-main.js'), /\['github_checks', 'github_checks'\]/);
  assert.match(read('src/workflow/proposal/facts.ts'), /cs\.integration_behind_by/);
});

// ── Where it stands ────────────────────────────────────────────────────

test('work state: an approved change GitHub holds is going live, with what it waits on', () => {
  const ws = require('../src/services/work-state');
  const change = (reasons) => ws.deriveChange({ status: 'promoted', check_state: 'passing', integration_merges_clean: true,
    integration_block_reasons: reasons, promoted_at: '2026-11-09T18:33:26Z' });
  assert.deepEqual([change(['github_checks']).stage, change(['github_checks']).line], ['going_live', { code: 'github_checks' }]);
  assert.deepEqual([change(['github_refused']).stage, change(['github_refused']).line], ['going_live', { code: 'github_wait' }]);
  assert.deepEqual([change(['github_busy']).stage, change(['github_busy']).line], ['going_live', { code: 'github_wait' }]);
  assert.deepEqual([change(['github_checks_failing']).stage, change(['github_checks_failing']).line], ['checking', { code: 'github_checks_failing' }]);
  assert.equal(change([]).stage, 'up_for_vote', 'nothing held: still up for a vote');
  assert.equal(ws.WORDS['work.line.githubChecks'], "Waiting for GitHub's checks");
  assert.equal(ws.WORDS['work.line.githubChecksFailing'], "GitHub's checks are failing");
  assert.equal(ws.WORDS['work.line.githubWait'], 'Waiting on GitHub');
  const core = JSON.parse(read('frontend/locales/en/core.json'));
  for (const key of ['work.line.githubChecks', 'work.line.githubChecksFailing', 'work.line.githubWait']) {
    assert.equal(ws.WORDS[key], core[key].text, `${key}: the server and the browser say the same`);
  }
  const lines = read('frontend/src/lib/work-state.ts');
  assert.match(lines, /github_checks: 'core:work\.line\.githubChecks'/);
  assert.match(lines, /github_checks_failing: 'core:work\.line\.githubChecksFailing'/);
  assert.match(lines, /github_wait: 'core:work\.line\.githubWait'/);
});

test('work state: the bot\'s own change at its vote step reads the same', () => {
  const src = read('src/services/work-state.js');
  const vote = src.slice(src.indexOf("    case 'vote':"), src.indexOf("    case 'merging':"));
  assert.match(vote, /const hold = githubHold\(row\);\s*if \(hold\) return state\(hold\.stage, \{ since, line: \{ code: hold\.code \} \}\);/);
});

test('the change page: its badge, its status title and its Votes card say the same', () => {
  const changes = JSON.parse(read('frontend/locales/en/changes.json'));
  const session = JSON.parse(read('frontend/locales/en/session.json'));
  for (const key of ['badge.reason.githubChecks.label', 'badge.reason.githubChecks.detail', 'badge.reason.githubChecks.detailSoon',
    'badge.reason.githubChecksFailing.label', 'badge.reason.githubChecksFailing.detail',
    'page.votes.note.githubChecks', 'page.votes.note.githubChecksFailing']) {
    assert.ok(changes[key] && changes[key].text && changes[key].description, key);
  }
  for (const key of ['merge.title.githubChecks', 'merge.title.githubChecksSoon']) assert.ok(session[key] && session[key].text, key);
  const view = read('public/js/app-view.js');
  assert.match(view, /served\.includes\('github_checks'\)/);
  assert.match(view, /served\.includes\('github_checks_failing'\)/);
  assert.match(view, /changes:page\.votes\.note\.githubChecks'/);
  assert.match(read('public/js/merge-status.js'), /served\.indexOf\('github_checks'\) !== -1 \? 'github_checks'/);
  for (const text of Object.values(changes).map((v) => v.text).filter((t) => /GitHub's/.test(t))) {
    assert.doesNotMatch(text, /—/, 'no em dashes');
  }
});
