'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const evidence = require('../src/services/visual-evidence-plan');
const { intent, motionIntent } = require('./fixtures/visual-evidence');

test('semantic intent accepts a bounded visible-change story and fills safe defaults', () => {
  const parsed = evidence.parseIntent(intent());
  assert.equal(parsed.version, 1);
  assert.equal(parsed.stories[0].intent.animation, 'steps');
  assert.equal(parsed.stories[0].intent.baseState, 'present');
  assert.deepEqual(parsed.stories[0].viewports[0], { name: 'desktop', width: 1280, height: 800 });
});

test('semantic intent can require the isolated full-admin evidence persona', () => {
  const candidate = intent();
  candidate.stories[0].persona = 'full_admin';
  assert.equal(evidence.parseIntent(candidate).stories[0].persona, 'full_admin');
});

test('new UI may explicitly label base absence without treating missing media as proof', () => {
  const candidate = intent();
  candidate.stories[0].intent.baseState = 'not_present';
  assert.equal(evidence.parseIntent(candidate).stories[0].intent.baseState, 'not_present');
  candidate.stories[0].intent.baseState = 'missing_image_means_absent';
  assert.equal(evidence.safeParseIntent(candidate).ok, false);
});

test('no-impact intent carries a rationale but no manufactured story', () => {
  const parsed = evidence.parseIntent({
    version: 1, impact: 'none', rationale: 'Only server-side retry accounting changed.', stories: [],
  });
  assert.equal(parsed.impact, 'none');
  assert.deepEqual(parsed.stories, []);
  assert.throws(() => evidence.parseIntent(intent({ impact: 'none' })), /No stories are allowed/);
});

test('visible impact requires a story and stories/viewports are capped', () => {
  assert.throws(() => evidence.parseIntent(intent({ stories: [] })), /At least one evidence story/);
  assert.throws(() => evidence.parseIntent(intent({ stories: Array.from({ length: 4 }, (_, i) => ({
    ...intent().stories[0], id: `story-${i}`,
  })) })), /at most 3/i);
  assert.throws(() => evidence.parseIntent(intent({ stories: [{
    ...intent().stories[0],
    viewports: [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'mobile', width: 390, height: 844 },
      { name: 'tablet', width: 768, height: 1024 },
    ],
  }] })), /at most 2/i);
});

test('story ids and viewport names are unique slugs', () => {
  const duplicateStory = intent();
  duplicateStory.stories.push(structuredClone(duplicateStory.stories[0]));
  assert.throws(() => evidence.parseIntent(duplicateStory), /Story ids must be unique/);

  const duplicateViewport = intent();
  duplicateViewport.stories[0].viewports.push({ name: 'desktop', width: 390, height: 844 });
  assert.throws(() => evidence.parseIntent(duplicateViewport), /Viewport names must be unique/);

  const badSlug = intent();
  badSlug.stories[0].id = 'Invite Suggestions';
  const result = evidence.safeParseIntent(badSlug);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors[0], {
    path: ['stories', '0', 'id'],
    message: 'Use a lowercase slug with letters, digits, hyphens or underscores',
  });
});

test('viewports stay within the phone-to-desktop bounds a browser can render', () => {
  for (const viewport of [
    { name: 'narrow', width: 319, height: 800 },
    { name: 'wide', width: 1921, height: 800 },
    { name: 'short', width: 1280, height: 479 },
    { name: 'tall', width: 1280, height: 1441 },
    { name: 'fractional', width: 1280.5, height: 800 },
    { name: 'desktop', width: 1280, height: 800, deviceScaleFactor: 2 },
  ]) {
    const candidate = intent();
    candidate.stories[0].viewports = [viewport];
    assert.equal(evidence.safeParseIntent(candidate).ok, false, JSON.stringify(viewport));
  }
  const edges = intent();
  edges.stories[0].viewports = [
    { name: 'smallest', width: 320, height: 480 },
    { name: 'largest', width: 1920, height: 1440 },
  ];
  assert.equal(evidence.safeParseIntent(edges).ok, true);
});

test('a motion change requires a motion declaration', () => {
  const candidate = intent();
  candidate.stories[0].intent.animation = 'motion';
  assert.throws(() => evidence.parseIntent(candidate), /requires impact "motion"/);
  assert.equal(evidence.parseIntent(motionIntent()).stories[1].intent.animation, 'motion');
});

test('paths are relative and cannot smuggle an origin or credential', () => {
  for (const value of [
    'https://evil.example/x', '//evil.example/x', 'settings', '/\\evil', '/%2f%2fevil',
    '/settings?token=secret', '/settings?password=demo',
    `/open/${encodeURIComponent('eyJabcdefgh.abcdefgh.abcdefgh')}`,
    '/invite/person@company.com',
  ]) {
    const candidate = intent();
    candidate.stories[0].intent.startPath = value;
    assert.equal(evidence.safeParseIntent(candidate).ok, false, value);
  }
  assert.equal(evidence.validRelativePath('/settings?tab=profile#name'), true);
});

test('credentials and real email addresses are recognised, fixture addresses are not', () => {
  for (const value of [
    'Bearer abcdefghijklmnop', 'ghp_abcdefghijklmnop', 'person@company.com',
    'eyJabcdefgh.abcdefgh.abcdefgh', '-----BEGIN RSA PRIVATE KEY-----',
  ]) {
    assert.equal(evidence.credentialLike(value), true, value);
    const candidate = intent();
    candidate.stories[0].intent.startPath = `/open/${encodeURIComponent(value)}`;
    assert.equal(evidence.safeParseIntent(candidate).ok, false, value);
  }
  assert.equal(evidence.credentialLike('reviewer@example.test'), false);
  const fixture = intent();
  fixture.stories[0].intent.startPath = '/invite/reviewer@example.test';
  assert.equal(evidence.safeParseIntent(fixture).ok, true);
});

test('shot-list hints are optional, bounded guidance for the preview agent', () => {
  assert.equal(Object.hasOwn(evidence.parseIntent(intent()).stories[0].intent, 'hints'), false);

  const candidate = intent();
  candidate.stories[0].intent.hints = {
    setup: 'Create a list from the + button first',
    expectText: ['Suggestions'],
    focusTarget: { by: 'role', role: 'dialog', name: 'Invite member' },
  };
  assert.deepEqual(evidence.parseIntent(candidate).stories[0].intent.hints, {
    setup: 'Create a list from the + button first',
    expectText: ['Suggestions'],
    // Locators fill the same exact-match default everywhere they appear.
    focusTarget: { by: 'role', role: 'dialog', name: 'Invite member', exact: true },
  });

  for (const hints of [
    { expectText: [] },
    { expectText: Array.from({ length: 6 }, (_, i) => `Text ${i}`) },
    { expectText: ['x'.repeat(121)] },
    { setup: 'x'.repeat(501) },
    { setup: 'Two\nlines' },
    { script: 'document.body.click()' },
  ]) {
    const bad = intent();
    bad.stories[0].intent.hints = hints;
    assert.equal(evidence.safeParseIntent(bad).ok, false, JSON.stringify(hints));
  }
});

test('a hinted focus target is a bounded locator, never xpath or the page root', () => {
  for (const focusTarget of [
    { by: 'xpath', value: '//dialog' },
    { by: 'css', value: 'body' },
    { by: 'css', value: ' * ' },
    { by: 'testId', value: 'x'.repeat(evidence.MAX_LOCATOR_VALUE + 1) },
    { by: 'role', role: 'x'.repeat(65) },
  ]) {
    const candidate = intent();
    candidate.stories[0].intent.hints = { focusTarget };
    assert.equal(evidence.safeParseIntent(candidate).ok, false, JSON.stringify(focusTarget));
  }

  const xpath = intent();
  xpath.stories[0].intent.hints = { focusTarget: { by: 'xpath', value: '//dialog' } };
  assert.deepEqual(evidence.safeParseIntent(xpath).errors[0], {
    path: ['stories', '0', 'intent', 'hints', 'focusTarget'],
    message: `Expected a locator with "by" set to one of: ${evidence.LOCATOR_KINDS.join(', ')}`,
  });
});

test('validation diagnostics do not copy unrecognized submitted field names', () => {
  const candidate = intent();
  candidate.stories[0].intent.hints = { 'private-token': 'secret-value' };
  const result = evidence.safeParseIntent(candidate);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /Unexpected field/);
  assert.doesNotMatch(JSON.stringify(result.errors), /private-token|secret-value/);
});

test('controlled failure paths are exact same-origin API GET paths', () => {
  for (const path of ['/outside', '/api/list#fragment', '/api/*',
    'https://example.test/api/list', '/api/list?token=secret']) {
    const candidate = intent();
    candidate.stories[0].intent.controlledFailurePath = path;
    assert.equal(evidence.safeParseIntent(candidate).ok, false, path);
  }
  const candidate = intent();
  candidate.stories[0].intent.controlledFailurePath = '/api/list?item=one';
  assert.equal(evidence.safeParseIntent(candidate).ok, false);
  candidate.stories[0].intent.steps.unshift(evidence.CONTROLLED_FAILURE_LABEL);
  assert.equal(evidence.safeParseIntent(candidate).ok, true);
});

test('a controlled failure must lead its steps with the reviewer-visible label', () => {
  const candidate = intent();
  candidate.stories[0].intent.controlledFailurePath = '/api/lists/demo';
  const result = evidence.safeParseIntent(candidate);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors[0].path, ['stories', '0', 'intent', 'steps', '0']);
  assert.match(result.errors[0].message, /Controlled test: deliberately block the declared API GET on both revisions\./);

  // The label anywhere but first does not count.
  candidate.stories[0].intent.steps.push(evidence.CONTROLLED_FAILURE_LABEL);
  assert.equal(evidence.safeParseIntent(candidate).ok, false);
  candidate.stories[0].intent.steps = [evidence.CONTROLLED_FAILURE_LABEL, 'Open Members'];
  assert.equal(evidence.parseIntent(candidate).stories[0].intent.controlledFailurePath, '/api/lists/demo');
});

test('needsClip asks for clips only for a motion change', () => {
  const parsed = evidence.parseIntent(motionIntent());
  assert.equal(evidence.needsClip(parsed.stories[0]), false);
  assert.equal(evidence.needsClip(parsed.stories[1]), true);
  for (const animation of ['none', 'steps']) {
    assert.equal(evidence.needsClip({ intent: { animation } }), false, animation);
  }
  assert.equal(evidence.needsClip(undefined), false);
  assert.equal(evidence.needsClip({}), false);
});

test('the replay plan contract is gone from the declaration module', () => {
  for (const name of ['parseReplayPlan', 'safeParseReplayPlan', 'planHash', 'semanticIntentFromPlan',
    'replayPlanFromIntent', 'parseAuthorPlanSubmission', 'containsRelativePointer']) {
    assert.equal(Object.hasOwn(evidence, name), false, name);
  }
});
