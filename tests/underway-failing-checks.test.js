// Failing checks on an Underway card: which ones, and re-run them (#1766).
//
// The report, from a usernode admin, is two sentences: "On underway
// proposals, there is no way to see the failed checks" and "There is no way
// to re-run them either from the UI."
//
// Both were true, and the first is the sharper one. The card could already
// say "Checks failing · 3" — MergeStatus.lifecycle counts the blocking rows
// for the pill — but nothing in the UI named the three, while the coding
// agent's prompt was handed the full list, with names, paths and reasons.
// The agent knew; the person watching the card did not.
//
// So the card renders the rows summarizeFailingChecks derives, the same
// function a fix turn's prompt reads (services/unit-suite-row.js).
//
// Run with: node --test tests/underway-failing-checks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { summarizeFailingChecks } = require('../src/routes/sessions');

const results = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({
  name: `check ${i + 1}`,
  path: `/?shot=x${i + 1}`,
  status: 'fail',
  failureReason: `reason ${i + 1}`,
  ...extra,
}));

test('#1766: nothing is summarised unless the run actually failed', () => {
  for (const state of ['passing', 'pending', 'error', '', null, undefined]) {
    const s = summarizeFailingChecks(state, results(3));
    assert.equal(s.total, 0, `${state} reports no failures`);
    assert.deepEqual(s.rows, []);
  }
});

test('#1766: passing rows are not failures, whatever else is in the array', () => {
  const mixed = [
    { name: 'a', status: 'pass' },
    { name: 'b', status: 'fail', failureReason: 'boom' },
    { name: 'c', status: 'pass' },
  ];
  const s = summarizeFailingChecks('failing', mixed);
  assert.equal(s.total, 1);
  assert.deepEqual(s.rows.map((r) => r.name), ['b']);
});

test('#1766: advisory rows are counted apart, because they do not block a merge', () => {
  const mixed = [
    { name: 'blocking one', status: 'fail', failureReason: 'x' },
    { name: 'advisory one', status: 'fail', failureReason: 'y', advisory: true },
  ];
  const s = summarizeFailingChecks('failing', mixed);
  // Both are failing and both are named — a reviewer wants to see it.
  assert.equal(s.total, 2);
  // Only one is holding the merge up. Counting the advisory row as a blocker
  // would report a merge held by something that is not holding it.
  assert.equal(s.blocking, 1);
  assert.equal(s.rows.find((r) => r.name === 'advisory one').advisory, true);
});

test('#1766: the payload is bounded, because test_results holds a row per declared check', () => {
  // 500+ rows today, on a polled endpoint. The cap is the whole reason this
  // is a summary rather than the column.
  const s = summarizeFailingChecks('failing', results(40));
  assert.equal(s.total, 40, 'the true total still travels');
  assert.ok(s.rows.length < 40, 'the rows are capped');
  assert.ok(s.rows.length <= 12);
  // Each row is capped in width too: a failureReason can be long.
  const wide = summarizeFailingChecks('failing', [{
    name: 'n'.repeat(500), status: 'fail', failureReason: 'r'.repeat(1000), path: 'p'.repeat(500),
  }]);
  assert.ok(wide.rows[0].name.length <= 160);
  assert.ok(wide.rows[0].reason.length <= 300);
  assert.ok(wide.rows[0].path.length <= 160);
});

test('#1766: the endpoint sends the summary and never the raw column', () => {
  const src = read('src/routes/sessions.js');
  // #6793: only the rows that did not pass are selected, and only for a
  // failing run, so the 800 passing ones are never read to be summarised.
  assert.ok(src.includes("CASE WHEN cs.check_state = 'failing' AND jsonb_typeof(cs.test_results) = 'array'"));
  assert.ok(src.includes("FILTER (WHERE (e.v->>'status' = 'pass') IS NOT TRUE), '[]'::jsonb)"));
  assert.ok(src.includes("ELSE '[]'::jsonb END AS failing_results,"));
  assert.ok(!/cs\.check_error_detail,\s*\n\s*cs\.test_results,/.test(src), 'the whole column is no longer selected');
  // ...and deleted so a 500-row array is not on a polled feed — except on
  // imported rows, which already shipped it (enrichImportedUnderwaySessions)
  // and whose contract me-active-sessions.test.js pins. Dropping it there
  // would be a silent breaking change in the name of a new one.
  assert.match(src, /if \(row\.source !== 'imported'\) delete row\.test_results;/);
  assert.match(src, /summarizeFailingChecks\(row\.check_state, row\.failing_results\)/);
  assert.match(src, /delete row\.failing_results;/);
  assert.match(src, /if \(summary\.total\) row\.failing_checks = summary;/);
});

test('#1766: the Underway card names the failures, and offers the re-run', () => {
  const src = read('public/js/app-view.js');

  // The names, on the card's own meta lines.
  assert.match(src, /_sessionCardMeta\(s, subtitle\)/, 'the card uses the meta builder');
  const meta = src.slice(src.indexOf('_sessionCardMeta(s, subtitle) {'));
  const body = meta.slice(0, meta.indexOf('_sessionStatusTagSpec'));
  assert.match(body, /s\.failing_checks/);
  assert.match(body, /PlatformI18n\.t\('changes:session\.failing\.names', \{ checks: names \}\)/);
  assert.equal(message('changes:session.failing.names', { checks: 'boots · saves' }), 'Failing: boots · saves');
  assert.equal(message('changes:session.failing.namesAndMore', { checks: 'boots · saves', count: 3 }), 'Failing: boots · saves · +3 more');
  // A card is a pointer: two names then a count, not the whole ledger.
  assert.match(body, /f\.rows\.slice\(0, 2\)/);
  assert.match(body, /PlatformI18n\.t\('changes:session\.failing\.namesAndMore', \{ checks: names, count: rest \}\)/);
  // Advisory rows are marked in the detail, for the same reason they are
  // counted apart on the server.
  assert.match(body, /advisory/);

  // The re-run, on the card's menu, through the action that already carries
  // every guard: owner-or-admin, never when passing, disabled mid-request.
  const menu = src.slice(src.indexOf("// #1766: the second half of the report"));
  assert.match(menu.slice(0, 1100), /const recheck = AppView\._recheckAction\(s\);/);
  assert.match(menu.slice(0, 1100), /label: PlatformI18n\.t\('changes:session\.menu\.rerunChecks'\)/);
  assert.equal(message('changes:session.menu.rerunChecks'), 'Re-run checks');
  assert.match(menu.slice(0, 1100), /AppView\.castRecheck\(s\.id\)/);
  // Not offered when the action itself says it would be inert.
  assert.match(menu.slice(0, 1100), /if \(recheck && !recheck\.disabled\)/);
});

test('#1766: the re-run reuses the existing guards rather than restating them', () => {
  const src = read('public/js/app-view.js');
  const act = src.slice(src.indexOf('_recheckAction(pr) {'));
  const body = act.slice(0, act.indexOf('_checksStatusNotes'));
  // These are the guards the menu item inherits by going through it. If any
  // moved out of this function, the card would silently start offering a
  // re-run to someone who cannot ask for one.
  assert.match(body, /if \(AppView\.readOnly\) return null;/);
  // #6521 narrowed this guard without moving it: a pass earns no re-run
  // unless it was earned on an older version of the change, where it says
  // nothing about the code up now and the request asks for the re-run.
  assert.match(body, /if \(pr\.check_state === 'passing' && pr\.checks_on_head !== false\) return null;/);
  assert.match(body, /if \(!owner && !App\.user\?\.canAdminWrite && !pr\.recheckable\) return null;/);
  assert.match(body, /_recheckInFlight\.has\(pr\.id\)/);
});
