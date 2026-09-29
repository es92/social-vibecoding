'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PNG } = require('pngjs');
const contract = require('../src/services/visual-evidence-plan');
const capture = require('../src/services/visual-evidence-capture');
const controlPlane = require('../src/services/visual-evidence-control');
const fixtures = require('./fixtures/visual-evidence');

function png(width = 4, height = 3, shade = 0) {
  const image = new PNG({ width, height });
  image.data.fill(shade);
  return PNG.sync.write(image);
}

function twoStoryIntent() {
  const base = fixtures.intent();
  const story = base.stories[0];
  return contract.parseIntent({
    ...base,
    stories: [
      { ...story, viewports: [
        { name: 'desktop', width: 1280, height: 800 },
        { name: 'phone', width: 390, height: 844 },
      ] },
      { ...story, id: 'invite-empty', claim: 'An empty search says no users match.' },
    ],
  });
}

test('a capture must be one complete PNG of a sane size', () => {
  const info = capture.inspectPng(png(4, 3));
  assert.equal(info.width, 4);
  assert.equal(info.height, 3);
  assert.match(info.sha256, /^[0-9a-f]{64}$/);
  const valid = png(4, 3);
  assert.throws(() => capture.inspectPng(Buffer.from('not a png at all, just text padding here')),
    { code: 'invalid_capture_image' });
  assert.throws(() => capture.inspectPng(valid.subarray(0, valid.length - 12)),
    { code: 'invalid_capture_image' }, 'a truncated upload has no IEND');
  assert.throws(() => capture.inspectPng(Buffer.concat([valid, Buffer.alloc(capture.MAX_CAPTURE_BYTES)])),
    { code: 'capture_too_large', status: 413 });
});

test('a capture is addressed only to an accepted story, viewport, and side', () => {
  const intent = twoStoryIntent();
  assert.deepEqual(capture.captureTarget(intent, { storyId: 'invite-suggestions', viewport: 'phone', side: 'head' }),
    { storyId: 'invite-suggestions', viewport: 'phone', side: 'head', variant: 'context' });
  assert.throws(() => capture.captureTarget(intent, { storyId: 'invented', viewport: 'desktop', side: 'head' }),
    { code: 'unknown_capture_story' });
  assert.throws(() => capture.captureTarget(intent, { storyId: 'invite-empty', viewport: 'phone', side: 'head' }),
    { code: 'unknown_capture_viewport' });
  assert.throws(() => capture.captureTarget(intent, { storyId: 'invite-empty', viewport: 'desktop', side: 'paired' }),
    { code: 'invalid_capture_side' });
  assert.throws(() => capture.captureTarget(intent, {
    storyId: 'invite-empty', viewport: 'desktop', side: 'base', variant: 'animation',
  }), { code: 'invalid_capture_variant' });
});

test('each claim is published or explained on its own', () => {
  const intent = twoStoryIntent();
  const captures = new Map();
  const add = (storyId, viewport, side, variant = 'context', shade = 0) => {
    const buffer = png(4, 3, shade);
    const target = { storyId, viewport, side, variant };
    captures.set(capture.captureKey(target), capture.artifactFor(target, buffer, capture.inspectPng(buffer)));
  };
  add('invite-suggestions', 'desktop', 'base');
  add('invite-suggestions', 'desktop', 'head', 'context', 9);
  add('invite-suggestions', 'phone', 'base');
  add('invite-suggestions', 'phone', 'head', 'context', 9);
  add('invite-suggestions', 'phone', 'head', 'focus', 7);
  add('invite-empty', 'desktop', 'head');
  const blocked = capture.summarize(intent, captures, new Map([
    ['invite-empty', 'The member cannot see any users to search in this fixture.'],
  ]));
  assert.equal(blocked.hardVerdict.passed, true);
  assert.equal(blocked.hardVerdict.mode, capture.CAPTURE_MODE);
  assert.deepEqual(blocked.stories, [
    { id: 'invite-suggestions', status: 'captured', captures: 5 },
    { id: 'invite-empty', status: 'blocked', reason: 'The member cannot see any users to search in this fixture.' },
  ]);
  assert.equal(blocked.artifacts.length, 5, 'only the complete claim is published');
  assert.ok(blocked.artifacts.every((artifact) => artifact.storyId === 'invite-suggestions'));
  assert.match(blocked.manifestHash, /^[0-9a-f]{64}$/);

  const unexplained = capture.summarize(intent, captures);
  assert.equal(unexplained.stories[1].reason, 'The preview agent did not capture desktop base.');
  assert.equal(unexplained.manifestHash, blocked.manifestHash, 'the hash covers published images only');

  add('invite-suggestions', 'desktop', 'head', 'context', 200);
  assert.notEqual(capture.summarize(intent, captures).manifestHash, blocked.manifestHash,
    'a retaken image changes the published manifest');

  const none = capture.summarize(intent, new Map());
  assert.equal(none.hardVerdict.passed, false);
  assert.equal(none.capturedCount, 0);
  assert.equal(capture.isCaptureVerdict(blocked.hardVerdict), true);
  assert.equal(capture.isCaptureVerdict({ passed: true, runs: 2 }), false);
});

test('a capture-mode control accepts screenshots and per-claim blockers; a replay control refuses them', () => {
  controlPlane._clearForTests();
  const intent = twoStoryIntent();
  const { control, unregister } = controlPlane.registerRun({
    runId: 'c'.repeat(32), sessionId: 42, intent, context: { origins: {} }, mode: 'capture',
  });
  try {
    assert.equal(control.getContext().mode, 'capture');
    assert.deepEqual(control.getContext().captureStatus.stories.map((story) => story.status), ['missing', 'missing']);
    const accepted = control.submitCapture({ storyId: 'invite-empty', viewport: 'desktop', side: 'base' }, png());
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.width, 4);
    control.submitCapture({ storyId: 'invite-empty', viewport: 'desktop', side: 'head' }, png(4, 3, 1));
    // Retaking the same slot replaces it rather than adding a second image.
    control.submitCapture({ storyId: 'invite-empty', viewport: 'desktop', side: 'head' }, png(4, 3, 2));
    assert.equal(control.captures.size, 2);
    assert.throws(() => control.submitCapture({ storyId: 'invite-empty', viewport: 'desktop', side: 'head' },
      Buffer.from('nope')), { code: 'invalid_capture_image' });
    assert.equal(control.lastToolFailure.operation, 'capture');

    control.blockStory({ storyId: 'invite-suggestions', reason: 'No list with members exists for this persona.' });
    assert.throws(() => control.blockStory({ storyId: 'invented', reason: 'x' }), { code: 'unknown_capture_story' });
    assert.throws(() => control.blockStory({ storyId: 'invite-empty', reason: '  ' }), { code: 'evidence_reason_required' });
    const summary = control.captureSummary();
    assert.deepEqual(summary.stories.map((story) => story.status), ['blocked', 'captured']);
    assert.equal(summary.stories[0].reason, 'No list with members exists for this persona.');
    assert.equal(summary.artifacts.length, 2);
  } finally { unregister(); }

  const replay = controlPlane.registerRun({
    runId: 'd'.repeat(32), sessionId: 42, intent, context: { origins: {} },
  });
  try {
    assert.equal(replay.control.getContext().mode, 'replay');
    assert.equal(Object.hasOwn(replay.control.getContext(), 'captureStatus'), false);
    assert.throws(() => replay.control.submitCapture({ storyId: 'invite-empty', viewport: 'desktop', side: 'base' }, png()),
      { code: 'evidence_capture_unavailable' });
  } finally { replay.unregister(); }
});

test('a whole-run blocker explains every claim that has no reason of its own', () => {
  controlPlane._clearForTests();
  const { control, unregister } = controlPlane.registerRun({
    runId: 'e'.repeat(32), sessionId: 42, intent: twoStoryIntent(), context: {}, mode: 'capture',
  });
  try {
    control.blockStory({ storyId: 'invite-empty', reason: 'Search is admin-only here.' });
    control.finish({ status: 'failed', reason: 'The preview shows a sign-in page on both revisions.' });
    assert.deepEqual(control.captureSummary().stories.map((story) => story.reason), [
      'The preview shows a sign-in page on both revisions.',
      'Search is admin-only here.',
    ]);
    assert.throws(() => control.submitCapture({ storyId: 'invite-empty', viewport: 'desktop', side: 'base' }, png()),
      { code: 'evidence_turn_finished' });
  } finally { unregister(); }
});

test('author shot-list hints are optional, bounded, and never widen the contract', () => {
  const withHints = fixtures.intent();
  withHints.stories[0].intent.hints = {
    setup: 'Create a list with two members from the + button first.',
    expectText: ['Invite', 'mara'],
    focusTarget: { by: 'role', role: 'dialog', name: 'Invite member' },
  };
  const parsed = contract.parseIntent(withHints);
  assert.deepEqual(parsed.stories[0].intent.hints.expectText, ['Invite', 'mara']);
  assert.equal(parsed.stories[0].intent.hints.focusTarget.exact, true);
  assert.equal(Object.hasOwn(contract.parseIntent(fixtures.intent()).stories[0].intent, 'hints'), false,
    'an intent without hints keeps its canonical form and hash');

  const unknown = fixtures.intent();
  unknown.stories[0].intent.hints = { script: 'document.body.remove()' };
  assert.throws(() => contract.parseIntent(unknown), { code: 'invalid_visual_evidence' });
  const tooMany = fixtures.intent();
  tooMany.stories[0].intent.hints = { expectText: ['a', 'b', 'c', 'd', 'e', 'f'] };
  assert.throws(() => contract.parseIntent(tooMany), { code: 'invalid_visual_evidence' });
});
