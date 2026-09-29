'use strict';

// The run-scoped control plane behind the preview agent's shots tools
// (src/services/visual-evidence-control.js). It holds what one run saved and
// skipped, refuses anything outside the declared changes, and is reachable
// only by the session that owns the run while the run is live.

const test = require('node:test');
const assert = require('node:assert/strict');
const controlPlane = require('../src/services/visual-evidence-control');
const fixtures = require('./fixtures/visual-evidence');

const { RunControl } = controlPlane;

function control(overrides = {}) {
  return new RunControl({
    runId: 'a'.repeat(32),
    sessionId: 42,
    intent: fixtures.motionIntent(),
    context: { addresses: { before: 'http://base.test', after: 'http://head.test' } },
    expiresAt: Date.now() + 10_000,
    ...overrides,
  });
}

// Two still changes and one motion change: enough to show per-change reasons
// next to a reason that covers everything.
function threeChanges() {
  const raw = fixtures.motionIntent();
  raw.stories.push({
    ...structuredClone(raw.stories[0]),
    id: 'member-count',
    claim: 'The members list shows how many people have joined.',
  });
  return raw;
}

const statuses = (run) => run.progress().map((entry) => [entry.change, entry.status]);

function shootBothSides(run, change) {
  for (const side of ['before', 'after']) {
    run.saveShot({ change, screen: 'desktop', side }, fixtures.png());
  }
}

test('a saved shot maps before/after to the stored sides and a retake replaces its slot', () => {
  const run = control();
  const first = run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before' },
    fixtures.png({ shade: 1 }));
  assert.deepEqual({ ...first, progress: undefined }, {
    saved: true, change: 'invite-suggestions', screen: 'desktop', side: 'before', kind: 'screen',
    bytes: fixtures.png({ shade: 1 }).length, width: 4, height: 3, progress: undefined,
  });
  assert.equal(run.saved.size, 1);

  const retake = fixtures.png({ width: 6, height: 2, shade: 2 });
  assert.equal(run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before' }, retake).width, 6);
  assert.equal(run.saved.size, 1, 'the same change, screen, side and kind is one slot');
  const [stored] = run.saved.values();
  assert.equal(stored.side, 'base');
  assert.equal(stored.variant, 'context');
  assert.equal(stored.data, retake);

  const element = run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'before', kind: 'element' },
    fixtures.png());
  assert.equal(element.kind, 'element');
  run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' }, fixtures.png());
  assert.equal(run.saved.size, 3);
  assert.deepEqual([...run.saved.values()].map((file) => [file.side, file.variant]),
    [['base', 'context'], ['base', 'focus'], ['head', 'context']]);
  assert.ok(run.summary().files.some((file) => file.data === retake), 'the retake is what gets published');
});

test('a clip is saved only for a motion change, and a refused file saves nothing', () => {
  const run = control();
  const clip = run.saveShot({ change: 'saved-toast', screen: 'desktop', side: 'after', kind: 'clip' },
    fixtures.webm());
  assert.equal(clip.kind, 'clip');
  assert.equal(clip.side, 'after');
  assert.equal(clip.bytes, 2048);
  assert.equal('width' in clip, false, 'a clip reports no dimensions');
  assert.equal([...run.saved.values()][0].contentType, 'video/webm');

  assert.throws(() => run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after', kind: 'clip' },
    fixtures.webm()), { code: 'clip_not_needed', status: 400 });
  assert.throws(() => run.saveShot({ change: 'saved-toast', screen: 'desktop', side: 'before', kind: 'clip' },
    fixtures.png()), { code: 'invalid_clip', status: 400 });
  assert.throws(() => run.saveShot({ change: 'saved-toast', screen: 'desktop', side: 'before' },
    fixtures.webm()), { code: 'invalid_shot_image', status: 400 });
  assert.throws(() => run.saveShot({ change: 'saved-toast', screen: 'mobile', side: 'before' },
    fixtures.png()), { code: 'unknown_screen', status: 400 });
  assert.throws(() => run.saveShot({ change: 'not-declared', screen: 'desktop', side: 'before' },
    fixtures.png()), { code: 'unknown_change', status: 400 });
  assert.equal(run.saved.size, 1);
});

test('progress reports each change as missing, ready or skipped', () => {
  const run = control();
  const initial = run.progress();
  assert.deepEqual(statuses(run), [['invite-suggestions', 'missing'], ['saved-toast', 'missing']]);
  assert.equal(initial[0].detail,
    'The preview agent did not save the before shot on desktop, the after shot on desktop.');
  assert.equal(initial[1].detail, 'The preview agent did not save the before shot on desktop, '
    + 'the before clip on desktop, the after shot on desktop, the after clip on desktop.');

  shootBothSides(run, 'invite-suggestions');
  assert.deepEqual(run.progress()[0], { change: 'invite-suggestions', status: 'ready' });

  const skipped = run.skipChange({
    change: 'saved-toast', reason: '  The toast needs a saved list, and members cannot create one.  ',
  });
  assert.equal(skipped.skipped, 'saved-toast');
  assert.deepEqual(skipped.progress, run.progress());
  assert.deepEqual(run.progress()[1], {
    change: 'saved-toast', status: 'skipped',
    detail: 'The toast needs a saved list, and members cannot create one.',
  });

  const summary = run.summary();
  assert.equal(summary.readyCount, 1);
  assert.deepEqual(summary.verdict, {
    passed: true, mode: 'shots', runs: 1,
    stories: [
      { id: 'invite-suggestions', status: 'ready', files: 2 },
      { id: 'saved-toast', status: 'skipped', reason: 'The toast needs a saved list, and members cannot create one.' },
    ],
  });
  // The agent may still come back to a change it skipped and shoot it.
  for (const side of ['before', 'after']) {
    run.saveShot({ change: 'saved-toast', screen: 'desktop', side }, fixtures.png());
    run.saveShot({ change: 'saved-toast', screen: 'desktop', side, kind: 'clip' }, fixtures.webm());
  }
  assert.deepEqual(statuses(run), [['invite-suggestions', 'ready'], ['saved-toast', 'ready']]);
});

test('skipping every change keeps what was shot and closes the turn', () => {
  const run = control({ intent: threeChanges() });
  shootBothSides(run, 'invite-suggestions');
  run.skipChange({ change: 'saved-toast', reason: 'The toast is behind a paid plan.' });
  const all = run.skipChange({ reason: 'Every other screen shows a sign-in page.' });
  assert.equal(all.skipped, 'all');
  assert.deepEqual(all.progress, [
    { change: 'invite-suggestions', status: 'ready' },
    // A change's own reason wins over the one that covers everything.
    { change: 'saved-toast', status: 'skipped', detail: 'The toast is behind a paid plan.' },
    { change: 'member-count', status: 'skipped', detail: 'Every other screen shows a sign-in page.' },
  ]);
  assert.equal(run.summary().verdict.passed, true, 'the shot change is still published');

  const before = run.saved.size;
  assert.throws(() => run.saveShot({ change: 'member-count', screen: 'desktop', side: 'after' }, fixtures.png()),
    { code: 'evidence_turn_finished', status: 409 });
  assert.throws(() => run.skipChange({ change: 'member-count', reason: 'Changed my mind.' }),
    { code: 'evidence_turn_finished', status: 409 });
  assert.throws(() => run.skipChange({ reason: 'Again.' }), { code: 'evidence_turn_finished' });
  assert.equal(run.saved.size, before);
  assert.equal(run.skippedAll, 'Every other screen shows a sign-in page.');
});

test('nothing shot and everything skipped is a run that does not pass', () => {
  const run = control();
  run.skipChange({ change: null, reason: 'The app does not start on either build.' });
  const summary = run.summary();
  assert.equal(summary.readyCount, 0);
  assert.equal(summary.verdict.passed, false);
  assert.deepEqual(summary.files, []);
  assert.deepEqual(summary.stories.map((story) => story.reason), [
    'The app does not start on either build.', 'The app does not start on either build.',
  ]);
});

test('a skip needs a reason and a declared change', () => {
  const run = control();
  assert.throws(() => run.skipChange({ change: 'invite-suggestions', reason: '   ' }),
    { code: 'reason_required', status: 400 });
  assert.throws(() => run.skipChange({ change: 'invite-suggestions' }), { code: 'reason_required' });
  assert.throws(() => run.skipChange(), { code: 'reason_required' });
  assert.throws(() => run.skipChange({ reason: '' }), { code: 'reason_required' },
    'an empty reason cannot close the whole turn');
  assert.throws(() => run.skipChange({ change: 'someone-elses-change', reason: 'Not reachable.' }),
    { code: 'unknown_change', status: 400 });
  assert.equal(run.skipped.size, 0);
  assert.equal(run.skippedAll, null);

  run.skipChange({ change: 'invite-suggestions', reason: 'y'.repeat(1500) });
  assert.equal(run.skipped.get('invite-suggestions').length, 1000);
});

test('the last refused tool call is kept for the owner\'s diagnostics', () => {
  const run = control();
  assert.equal(run.lastToolFailure, null);
  assert.throws(() => run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' },
    Buffer.from('not an image')));
  assert.equal(run.lastToolFailure.operation, 'save-shot');
  assert.equal(run.lastToolFailure.error.code, 'invalid_shot_image');

  assert.throws(() => run.skipChange({ change: 'invite-suggestions', reason: '' }));
  assert.equal(run.lastToolFailure.operation, 'skip-change');
  assert.equal(run.lastToolFailure.error.code, 'reason_required');

  // A later success does not erase the refusal the owner may need to read.
  shootBothSides(run, 'invite-suggestions');
  assert.equal(run.lastToolFailure.operation, 'skip-change');
});

test('an expired run refuses its brief, shots and skips with 410', () => {
  const run = control({ expiresAt: Date.now() - 1 });
  const expired = { code: 'evidence_control_expired', status: 410 };
  assert.throws(() => run.getContext(), expired);
  assert.throws(() => run.saveShot({ change: 'invite-suggestions', screen: 'desktop', side: 'after' },
    fixtures.png()), expired);
  assert.throws(() => run.skipChange({ change: 'invite-suggestions', reason: 'Too late.' }), expired);
  assert.equal(run.saved.size, 0);
  assert.equal(run.skipped.size, 0);
  assert.equal(run.lastToolFailure.error.code, 'evidence_control_expired');
});

test('the brief is a copy of the context with progress attached', () => {
  const context = { runId: 'a'.repeat(32), addresses: { before: 'http://base.test', after: 'http://head.test' } };
  const run = control({ context });
  context.addresses.before = 'http://elsewhere.test';
  const brief = run.getContext();
  assert.deepEqual(brief, {
    runId: 'a'.repeat(32),
    addresses: { before: 'http://base.test', after: 'http://head.test' },
    progress: run.progress(),
  });
  brief.addresses.after = 'http://elsewhere.test';
  assert.equal(run.getContext().addresses.after, 'http://head.test');
});

test('a control only accepts an intent the author could have declared', () => {
  assert.throws(() => control({ intent: fixtures.intent({ impact: 'none' }) }), { code: 'invalid_visual_evidence' });
  assert.throws(() => control({ intent: { version: 1, impact: 'ui', rationale: 'x', stories: [] } }),
    { code: 'invalid_visual_evidence' });
  // The stored intent is the parsed one, with its defaults.
  assert.equal(control({ intent: fixtures.intent() }).intent.stories[0].intent.baseState, 'present');
});

test('one registration owns a run id at a time', (t) => {
  controlPlane._clearForTests();
  t.after(() => controlPlane._clearForTests());
  const options = {
    runId: 'b'.repeat(32), sessionId: 42, intent: fixtures.intent(), context: {},
    expiresAt: Date.now() + 10_000,
  };
  assert.throws(() => controlPlane.registerRun({ ...options, runId: 'not-a-run' }),
    { code: 'invalid_evidence_run', status: 400 });
  assert.throws(() => controlPlane.registerRun({ ...options, runId: 'B'.repeat(32) }),
    { code: 'invalid_evidence_run' });

  const first = controlPlane.registerRun(options);
  assert.throws(() => controlPlane.registerRun(options), { code: 'evidence_control_exists', status: 409 });
  first.unregister();
  const second = controlPlane.registerRun(options);
  assert.notEqual(second.control, first.control);
  // A stale unregister cannot remove the registration that replaced it.
  first.unregister();
  assert.equal(controlPlane.forRequest({ runId: options.runId, sessionId: 42 }), second.control);
  second.unregister();
  assert.throws(() => controlPlane.forRequest({ runId: options.runId, sessionId: 42 }),
    { code: 'evidence_control_not_found' });
});

test('a request reaches a control only for its own session while the run is live', (t) => {
  controlPlane._clearForTests();
  t.after(() => controlPlane._clearForTests());
  const runId = 'c'.repeat(32);
  const { control: live } = controlPlane.registerRun({
    runId, sessionId: 42, intent: fixtures.intent(), context: {}, expiresAt: Date.now() + 10_000,
  });
  assert.equal(controlPlane.forRequest({ runId, sessionId: 42 }), live);
  assert.equal(controlPlane.forRequest({ runId, sessionId: '42' }), live, 'a JWT claim may carry the id as text');
  assert.throws(() => controlPlane.forRequest({ runId, sessionId: 43 }),
    { code: 'evidence_scope_mismatch', status: 403 });
  assert.throws(() => controlPlane.forRequest({ runId, sessionId: undefined }),
    { code: 'evidence_scope_mismatch', status: 403 });
  assert.throws(() => controlPlane.forRequest({ runId: 'd'.repeat(32), sessionId: 42 }),
    { code: 'evidence_control_not_found', status: 410 });
  assert.throws(() => controlPlane.forRequest({ sessionId: 42 }),
    { code: 'evidence_control_not_found', status: 410 });

  const expiredRun = 'e'.repeat(32);
  controlPlane.registerRun({
    runId: expiredRun, sessionId: 42, intent: fixtures.intent(), context: {}, expiresAt: Date.now() - 1,
  });
  assert.throws(() => controlPlane.forRequest({ runId: expiredRun, sessionId: 42 }),
    { code: 'evidence_control_expired', status: 410 });
});
