'use strict';

// The hand-off the launchpad copies (#2092): step 0 catches the checkout up.
//
// "Copy instructions" hands a coding agent the prefill built by
// getLaunchpadInstructions in src/services/prompts.js. It used to open with
// the question — ask what to build, then prepare_work — and nothing in it
// said where the agent was standing. A session is routinely dispatched into
// a fork whose main is far behind the app's repository, and nothing in the
// checkout says so: `git fetch origin` compares a fork with itself. An agent
// that asked first and then read THAT code planned the change against a
// version that no longer existed.
//
// The request asked for a step 0 that catches up to upstream main before the
// question is asked. This pins it in both variants of the text, pins that it
// is a precondition rather than a step among steps, and pins that it does not
// turn into the one thing the platform forbids — the agent merging a default
// branch into a proposal base of its own choosing. The rendering tests in
// launchpad.test.js and dev-flow-select.test.js hand the card a stub string
// on purpose, so nothing else holds the real text.
//
// Run with: node --test tests/launchpad-instructions.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { getLaunchpadInstructions } = require('../src/services/prompts');

const SLUG = 'recipe-box';
const PROPOSAL_ID = 4242;

const VARIANTS = [
  ['a new change', () => getLaunchpadInstructions({ appName: 'Recipe Box', slug: SLUG })],
  ['a continuation', () => getLaunchpadInstructions({
    appName: 'Recipe Box', slug: SLUG, targetProposalId: PROPOSAL_ID,
  })],
];

const STEP_0 = '0. Catch your checkout up to the app\'s upstream main';
const ASK = 'IF THE USER HAS NOT ALREADY TOLD YOU WHAT TO BUILD, ASK THEM.';
const STEP_1 = '1. Call prepare_work with slug';

for (const [label, build] of VARIANTS) {
  test(`step 0 comes before the agent asks what to build, for ${label}`, () => {
    const text = build();
    const step0 = text.indexOf(STEP_0);
    const ask = text.indexOf(ASK);
    const step1 = text.indexOf(STEP_1);
    assert.ok(step0 > -1, 'the step is there');
    assert.ok(ask > step0, 'and it precedes the question');
    assert.ok(step1 > ask, 'which still precedes prepare_work');
    // A precondition, not a step among steps: nothing numbered comes before
    // it, and the question is no longer labelled "first" — step 0 is.
    assert.doesNotMatch(text.slice(0, step0), /^\d+\. /m);
    assert.doesNotMatch(text, /^FIRST,/m);
    assert.match(text, /^NEXT, IF THE USER HAS NOT ALREADY TOLD YOU WHAT TO BUILD, ASK THEM\.$/m);
  });

  test(`step 0 names the check, its inputs and what to do with the answer, for ${label}`, () => {
    const text = build();
    // The false pass is named, because it is the reason an agent skips this:
    // a fork really is current with its own remote.
    assert.match(text, /may be a fork whose main is\s+far behind, and `git fetch origin` cannot tell you/);
    // The connector's check, with the two inputs that make it answerable, and
    // the slug spelled out so the agent has nothing to look up.
    assert.match(text, new RegExp(`call get_checkout_status with slug "${SLUG}"`));
    assert.match(text, /`headSha` \(from\s+`git rev-parse HEAD`\)/);
    assert.match(text, /`remoteUrl` \(from `git remote get-url origin`\)/);
    // The remedy is the commit the answer carries, fetched from the
    // repository the answer names — never a merge of the agent's own making.
    assert.match(text, /Unless it says `current` or `ahead`, fetch the `baseToUse` commit it returns\s+from the `canonicalRepo` it names and check that commit out/);
  });

  test(`step 0 moves the working copy only; the proposal base is still prepare_work's, for ${label}`, () => {
    const text = build();
    // Which commit a change is diffed against decides what the group votes
    // on, so it is the work order's call. Catching up must not read as a
    // licence to merge main into a proposal branch.
    assert.match(text, /That moves your\s+working copy only: the commit a proposal starts from still comes from\s+prepare_work, never from merging main yourself\./);
    assert.match(text, /the exact commit to start from/, 'step 1 still hands over the base');
    assert.match(text, /^2\. Build it, starting from that commit\.$/m);
  });

  test(`the steps that follow keep their numbers and their order, for ${label}`, () => {
    const text = build();
    const order = [
      STEP_0, 'NEXT, IF THE USER', 'Then, through your Homeroom connector:',
      STEP_1, '2. Build it', '3. Push the branch', '4. Call submit_work',
    ];
    const at = order.map((s) => text.indexOf(s));
    assert.ok(at.every((i) => i > -1), `every step is present: ${JSON.stringify(at)}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'and in this order');
    assert.doesNotMatch(text, /^5\. /m, 'nothing was renumbered');
  });
}

test('a continuation still names the proposal it updates, and a new change does not', () => {
  const [[, fresh], [, continuing]] = VARIANTS;
  assert.match(continuing(), new RegExp(`proposalId ${PROPOSAL_ID}`));
  assert.doesNotMatch(fresh(), /proposalId/);
  // Step 0 is the same sentence in both: a continuation is based at the
  // proposal's own head, which prepare_work returns, so the guard against
  // merging main applies there too.
  assert.equal(
    continuing().slice(0, continuing().indexOf(ASK)),
    fresh().slice(0, fresh().indexOf(ASK)),
  );
});
