'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const contract = require('../src/services/visual-evidence-plan');
const state = require('../src/services/visual-evidence-state');
const runner = require('../evidence/replay-runner');

const button = (name) => ({ by: 'role', role: 'button', name, exact: true });
const region = (value) => ({ by: 'testId', value });

function action(id, stage, type, fields = {}) {
  return { id, stage, type, ...fields };
}

function scenario({
  id,
  claim,
  impact = 'ui',
  animation = 'none',
  baseState = 'present',
  viewport = { name: 'desktop', width: 1280, height: 800 },
  beforePath = '/fixture',
  afterPath = beforePath,
  beforeActions = [],
  afterActions = beforeActions,
  beforeAssertion = { type: 'visible', target: region('evidence-focus') },
  afterAssertion = { type: 'visible', target: region('evidence-focus') },
  beforeFocus = region('evidence-focus'),
  afterFocus = region('evidence-focus'),
}) {
  const intent = {
    startPath: afterPath,
    steps: (afterActions.length ? afterActions : [{ stage: 'checkpoint' }]).map((item) => item.stage),
    checkpoint: `Checkpoint for ${id}`,
    focus: `Focus for ${id}`,
    baseState,
    animation,
  };
  return {
    version: 1,
    impact,
    rationale: `Stable synthetic fixture for ${id}.`,
    stories: [{
      id,
      claim,
      persona: 'member',
      viewports: [viewport],
      intent,
      replay: {
        before: { startPath: beforePath, actions: beforeActions },
        after: { startPath: afterPath, actions: afterActions },
        checkpoint: {
          id: `${id}-checkpoint`,
          label: `Review ${id}`,
          focus: { before: beforeFocus, after: afterFocus },
          assertions: { before: [beforeAssertion], after: [afterAssertion] },
          animation,
        },
      },
    }],
  };
}

const fixtures = [
  {
    name: 'modal reached through two clicks',
    plan: scenario({
      id: 'modal-two-clicks',
      claim: 'The invite dialog shows the new helper copy after opening members and invite.',
      animation: 'steps',
      beforeActions: [
        action('open-members', 'members', 'click', { target: button('Members') }),
        action('open-invite', 'invite', 'click', { target: button('Invite') }),
      ],
      beforeFocus: { by: 'role', role: 'dialog', name: 'Invite member', exact: true },
      afterFocus: { by: 'role', role: 'dialog', name: 'Invite member', exact: true },
    }),
    actionTypes: ['click', 'click'],
  },
  {
    name: 'typeahead reached through typing',
    plan: scenario({
      id: 'typeahead',
      claim: 'Typing a fixture username opens matching suggestions.',
      animation: 'steps',
      beforeActions: [
        action('type-query', 'query', 'fill', {
          target: { by: 'label', value: 'Username', exact: true }, value: 'ma',
        }),
      ],
      beforeAssertion: { type: 'hidden', target: { by: 'role', role: 'listbox' } },
      afterAssertion: { type: 'visible', target: { by: 'role', role: 'listbox' } },
    }),
    actionTypes: ['fill'],
  },
  {
    name: 'hover-only menu',
    plan: scenario({
      id: 'hover-menu',
      claim: 'Hovering the account tile reveals the revised quick actions.',
      beforeActions: [action('hover-account', 'hover', 'hover', { target: region('account-tile') })],
      beforeAssertion: { type: 'visible', target: region('quick-actions') },
      afterAssertion: { type: 'visible', target: region('quick-actions') },
    }),
    actionTypes: ['hover'],
  },
  {
    name: 'relative canvas interaction',
    plan: scenario({
      id: 'canvas-drag',
      claim: 'Dragging across the board updates the fixture selection.',
      animation: 'steps',
      beforeActions: [
        action('select-cell', 'select', 'clickPoint', {
          surface: region('board'), xRatio: 0.25, yRatio: 0.4,
        }),
        action('drag-selection', 'drag', 'dragPoints', {
          surface: region('board'),
          from: { xRatio: 0.25, yRatio: 0.4 },
          to: { xRatio: 0.75, yRatio: 0.6 },
        }),
      ],
      beforeFocus: region('board'),
      afterFocus: region('board'),
    }),
    actionTypes: ['clickPoint', 'dragPoints'],
    relativePointer: true,
  },
  {
    name: 'mobile-only layout',
    plan: scenario({
      id: 'mobile-layout',
      claim: 'The mobile action bar keeps the primary action visible.',
      viewport: { name: 'mobile', width: 390, height: 844 },
      beforeFocus: region('mobile-actions'),
      afterFocus: region('mobile-actions'),
    }),
    viewport: 'mobile',
  },
  {
    name: 'brand-new route with explicit base absence',
    plan: scenario({
      id: 'new-route',
      claim: 'The new audit screen is available at its declared route.',
      baseState: 'not_present',
      beforePath: '/audit',
      afterPath: '/audit',
      beforeAssertion: { type: 'text', target: { by: 'css', value: 'main' }, value: 'Not found', exact: false },
      afterAssertion: { type: 'visible', target: { by: 'role', role: 'heading', name: 'Audit', exact: true } },
      beforeFocus: { by: 'css', value: 'main' },
      afterFocus: { by: 'css', value: 'main' },
    }),
    baseState: 'not_present',
  },
  {
    name: 'removed control',
    plan: scenario({
      id: 'removed-control',
      claim: 'The deprecated export control is absent from the revised toolbar.',
      beforeAssertion: { type: 'visible', target: button('Legacy export') },
      afterAssertion: { type: 'detached', target: button('Legacy export') },
      beforeFocus: region('toolbar'),
      afterFocus: region('toolbar'),
    }),
  },
  {
    name: 'motion-specific transition',
    plan: scenario({
      id: 'motion-transition',
      claim: 'The panel transition follows the revised motion curve.',
      impact: 'motion',
      animation: 'motion',
      beforeActions: [action('open-panel', 'open', 'click', { target: button('Open panel') })],
      beforeFocus: region('sliding-panel'),
      afterFocus: region('sliding-panel'),
    }),
    animation: 'motion',
  },
];

test('the eight visible acceptance fixtures compile to strict bounded replay plans', () => {
  assert.equal(fixtures.length, 8);
  for (const fixture of fixtures) {
    const parsed = contract.parseReplayPlan(fixture.plan);
    const story = parsed.stories[0];
    assert.equal(story.claim, fixture.plan.stories[0].claim, fixture.name);
    assert.equal(story.replay.before.actions.length, story.replay.after.actions.length, fixture.name);
    if (fixture.actionTypes) {
      assert.deepEqual(story.replay.after.actions.map((item) => item.type), fixture.actionTypes, fixture.name);
    }
    if (fixture.viewport) assert.equal(story.viewports[0].name, fixture.viewport, fixture.name);
    if (fixture.baseState) assert.equal(story.intent.baseState, fixture.baseState, fixture.name);
    if (fixture.animation) assert.equal(story.replay.checkpoint.animation, fixture.animation, fixture.name);
    if (fixture.relativePointer) assert.equal(contract.containsRelativePointer(parsed), true, fixture.name);
    assert.match(contract.planHash(parsed), /^[0-9a-f]{64}$/, fixture.name);
    assert.deepEqual(contract.semanticIntentFromPlan(parsed), contract.parseIntent({
      version: parsed.version,
      impact: parsed.impact,
      rationale: parsed.rationale,
      stories: parsed.stories.map(({ replay: _replay, ...storyValue }) => storyValue),
    }), fixture.name);
  }
});
test('an explicit no-impact declaration is not required, whatever files it touched', () => {
  const intent = contract.parseIntent({
    version: 1,
    impact: 'none',
    rationale: 'The API-only change does not alter rendered behavior.',
    stories: [],
  });
  assert.equal(state.requiredForIntent(intent, { heuristicUi: false }), false);
  // A heuristic veto only ever produced a run with zero stories, which can
  // never submit a plan and always failed as missing_evidence_replay.
  assert.equal(state.requiredForIntent(intent, { heuristicUi: true }), false);
  assert.throws(() => contract.parseReplayPlan({ ...intent }), { code: 'invalid_visual_evidence' });
});

test('broken-plan fixture cannot silently land on a generic fallback page', () => {
  const origin = 'http://fixture-base:3000';
  for (const path of ['/', '/login', '/signin?next=%2Ffixture', '/error#failed']) {
    assert.throws(
      () => runner.expectedFinalPath('/fixture', `${origin}${path}`, origin, 'base'),
      { code: 'unexpected_fallback' },
      path
    );
  }
});
