'use strict';

// A conflicting proposal whose checks fail or could not run is one the
// conflict lane never resolves (src/workflow/merge-queue/machine.ts
// admission), and every surface said "the platform will resolve it" anyway.
// On 19 Oct 2026, 33 of the 35 conflicting proposals in review were such
// heads, some up since September, none ever asked to resolve. The lane now
// writes its verdict on the row like its other reasons, and each surface
// names who acts.
//
// Run with: node --test tests/conflict-lane-checks-reason.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { admission } = require('../src/workflow/merge-queue/machine.ts');

const candidate = (over = {}) => ({
  forkHead: false, gaveUp: null, head: 'a'.repeat(40), integrationMain: 'b'.repeat(40), backoffUntil: 0,
  unmergeable: null, approved: true, forced: false, resolutionSpent: false, conflictFiles: [], githubConflict: false, ...over,
});

test('a stale failing verdict is resolved first, and named on the row only once the free resolution is spent', () => {
  // #6531: its verdict was measured against an older main, and a conflicting
  // head gets no fresh automatic run, so the lane resolves it and the new
  // head gets its own checks run.
  assert.deepEqual(admission(candidate({ unmergeable: 'checks_failing', resolutionSpent: false, approved: false }), Date.now()),
    { admit: true, reason: 'first_conflict' });
  assert.deepEqual(admission(candidate({ unmergeable: 'checks_error', resolutionSpent: false, approved: false }), Date.now()),
    { admit: true, reason: 'first_conflict' });
  // Approved: the yes lets the lane resolve it too.
  assert.deepEqual(admission(candidate({ unmergeable: 'checks_failing', resolutionSpent: true }), Date.now()),
    { admit: true, reason: 'approved' });
  // Spent and still failing: nobody but its author (or the bot) moves it.
  assert.deepEqual(admission(candidate({ unmergeable: 'checks_failing', resolutionSpent: true, approved: false }), Date.now()),
    { admit: false, reason: 'checks_failing' });
  assert.deepEqual(admission(candidate({ unmergeable: 'checks_error', resolutionSpent: true, approved: false }), Date.now()),
    { admit: false, reason: 'checks_error' });
  assert.deepEqual(admission(candidate(), Date.now()), { admit: true, reason: 'approved' });
  const src = read('src/workflow/merge-queue/machine.ts');
  assert.match(src, /const LANE_REASONS: ReadonlySet<string> = new Set\(\['awaiting_approval', 'unresolvable', 'fork_head', 'checks_failing', 'checks_error'\]\);/,
    'a declined head\'s reason reaches the card only through LANE_REASONS');
});

test('a conflict only in a mechanical file is settled without spending the free resolution', () => {
  const mechanical = candidate({ conflictFiles: ['tests/baselines/test-durations.json'], resolutionSpent: true, approved: false });
  assert.deepEqual(admission(mechanical, Date.now()), { admit: true, reason: 'mechanical' });
  assert.deepEqual(admission(candidate({ conflictFiles: ['src/db/migrations/manifest.json'] }), Date.now()),
    { admit: true, reason: 'mechanical' });
  // One real file alongside it is a real conflict.
  assert.deepEqual(admission(candidate({ conflictFiles: ['tests/baselines/test-durations.json', 'src/a.ts'], approved: false }), Date.now()),
    { admit: true, reason: 'first_conflict' });
  // GitHub's own refusal is measured afresh; it is not the mechanical lane's.
  assert.deepEqual(admission(candidate({ conflictFiles: ['tests/baselines/test-durations.json'], githubConflict: true,
    resolutionSpent: true, approved: false }), Date.now()), { admit: false, reason: 'awaiting_approval' });
});

test('the gate\'s thread line and the dev-chat pill say the checks come first', () => {
  const votes = read('src/routes/votes.js');
  assert.match(votes, /Its checks are failing too, so the platform waits for \$\{owner\} to fix them before it resolves the conflict\./);
  assert.match(votes, /Its checks could not run either; once they are re-run and pass, the platform resolves the conflict\./);
  const pill = read('public/js/merge-status.js');
  assert.match(pill, /served\.indexOf\('checks_failing'\) !== -1\s*\? t\('session:merge\.title\.conflictChecksFailing'\)/);
  assert.match(pill, /served\.indexOf\('checks_error'\) !== -1\s*\? t\('session:merge\.title\.conflictChecksError'\)/);
  const session = JSON.parse(read('frontend/locales/en/session.json'));
  assert.match(session['merge.title.conflictChecksFailing'].text, /creator fixes the checks first/);
  assert.match(session['merge.title.conflictChecksError'].text, /once they are re-run and pass/);
});

test('the change card and the bot tab word a yes-only conflict the same way', () => {
  const core = JSON.parse(read('frontend/locales/en/core.json'));
  assert.equal(core['work.line.conflictOnYes'].text,
    'Conflicts with main: Homeroom resolves it once you approve');
  assert.equal(core['work.stage.syncing'].text, 'Syncing with main');
  const changes = JSON.parse(read('frontend/locales/en/changes.json'));
  assert.equal(changes['page.votes.note.conflictOnYes'].text,
    'Conflicts with main: Homeroom resolves it once you approve.');
  assert.match(changes['page.votes.note.syncing'].text, /^Syncing with main: Homeroom asks for votes when it is caught up/);
  const view = read('public/js/app-view.js');
  assert.match(view, /blocked\.indexOf\('awaiting_approval'\) !== -1\) note\.push\(PlatformI18n\.t\('changes:page\.votes\.note\.conflictOnYes'\)\)/);
  assert.match(view, /blocked\.indexOf\('integrating'\) !== -1 \|\| !blocked\.some/);
  // The bot tab's row: the feed item carries the flag, and the row words it.
  assert.match(read('src/routes/workshop-overview.js'), /AS conflict_on_yes/);
  assert.match(read('frontend/src/features/ai/model.ts'), /row\.voteConflict/);
});

test('the card\'s integration line says it too, before the automatic fallbacks', () => {
  const view = read('public/js/app-view.js');
  const line = view.slice(view.indexOf('  _integrationLine(g, p, viewer) {'), view.indexOf('  INTEGRATION_LINE_IDS: {'));
  const checks = line.indexOf("served.includes('checks_failing')");
  const queued = line.indexOf('conflict(IDS.queued)');
  assert.ok(checks > 0 && queued > checks, 'checked before the "queued to fix" fallback');
  assert.match(line, /if \(served\.includes\('checks_error'\)\) return conflict\(IDS\.checksRerun\);/);
  const changes = JSON.parse(read('frontend/locales/en/changes.json'));
  assert.equal(changes['step.integration.checksFirstMain'].text, 'Conflict with main · fix the checks first');
  assert.equal(changes['step.integration.checksRerunMain'].text, 'Conflict with main · re-run the checks first');
  assert.ok(changes['step.integration.checksFirstFiles_one'] && changes['step.integration.checksFirstFiles_other']);
});
