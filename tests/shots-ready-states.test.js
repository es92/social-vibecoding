'use strict';

// What a visible declaration's answer says about the data the before &
// after copies hold (src/services/shots-ready-states.js): the ready-made
// states by name, where anything else comes from, and a warning only for a
// change whose own words name a state no ready-made state holds and that
// says nothing of how to make it (hints.setup). The words of the changes
// that ended with no shots for want of data are the cases here.

const test = require('node:test');
const assert = require('node:assert/strict');
const readyStates = require('../src/services/shots-ready-states');
const demoStates = require('../src/services/shots-demo-states');

const story = (id, claim, { persona = 'member', steps = ['Open it'], setup = null } = {}) => ({
  id, claim, persona,
  intent: { startPath: '/', steps, checkpoint: 'It shows', focus: 'It', ...(setup ? { hints: { setup } } : {}) },
});
const declare = (...stories) => ({ version: 1, impact: 'ui', rationale: 'A change.', stories });
const warned = (intent, selfApp) => readyStates.declarationAdvice(intent, { selfApp }).warnings;

test('every demo state is a ready-made state with a name, in the same order, for its persona', () => {
  assert.deepEqual(readyStates.READY_STATES.map((state) => state.id), demoStates.STATE_IDS);
  for (const [index, state] of readyStates.READY_STATES.entries()) {
    assert.equal(state.personas[0], demoStates.STATES[index].persona, state.id);
    assert.ok(state.name.length > 10 && state.name.length < 90, state.id);
  }
  const ids = new Set(demoStates.STATE_IDS);
  const fixtures = require('../src/services/shots-fixtures');
  const fixtureIds = new Set([fixtures.INVITED_FIRST_VISIT_PROFILE, fixtures.INVITED_LISTED_PROFILE,
    fixtures.INVITE_LINK_PROFILE]);
  for (const need of readyStates.NEEDS) {
    assert.ok(need.states.every((id) => ids.has(id) || fixtureIds.has(id)), need.needs);
  }
});

test('Homeroom\'s answer lists the ready-made states; a child app\'s says it has none and where its data comes from', () => {
  const own = readyStates.declarationAdvice(declare(story('a', 'The settings page groups its rows.')), { selfApp: true });
  assert.equal(own.availableStates.length, demoStates.STATE_IDS.length);
  assert.deepEqual(Object.keys(own.availableStates[0]), ['name', 'personas']);
  assert.match(own.dataNote, /src\/db\/migrate\.js/);
  assert.match(own.dataNote, /hints\.setup/);
  assert.match(own.dataNote, /reaches only the after copy/);
  // A file to choose, and a loading or error state behind one request, the
  // shots agent reaches itself (upload_file, control_request).
  assert.match(own.dataNote, /chooses one of Homeroom's sample files \(landscape\.png, portrait\.png, table\.csv, document\.pdf\)/);
  assert.match(own.dataNote, /hold or fail one API GET on both copies to show a loading or error state: name the file or the request in hints\.setup/);
  assert.deepEqual(own.warnings, []);
  // A state new in the proposal is seeded in it: the after copy is the side
  // that needs it (22 failed runs and 13 skipped changes, 2026-10-09 to 10-12).
  // What a seed may hold keeps the platform's seed rule.
  assert.match(own.dataNote, /A seed is idempotent and obviously fake: rows for the shots' fixture accounts \(usernode-capture is the member\) and fake people, never a signal the code reads to decide something\./);
  assert.match(own.dataNote, /which is the side a state new in this proposal needs: seed such a state in this proposal\./);
  assert.match(own.dataNote, /A change to a state that already existed needs it on both copies, so its seed merges first, in its own proposal\./);
  assert.doesNotMatch(own.dataNote, /merged before this one/);

  const child = readyStates.declarationAdvice(declare(story('a', 'The list shows its items.')), { selfApp: false });
  assert.deepEqual(child.availableStates, []);
  assert.match(child.dataNote, /IS_STAGING seed/);
  assert.match(child.dataNote, /no ready-made states/);
  assert.deepEqual(child.warnings, []);

  // Nothing to shoot, nothing to say.
  assert.equal(readyStates.declarationAdvice({ version: 1, impact: 'none', rationale: 'x', stories: [] }), null);
  assert.equal(readyStates.declarationAdvice(null), null);
  assert.equal(readyStates.declarationAdvice({ impact: 'ui', stories: 'nope' }), null);
});

test('the states that cost changes their shots are ready-made on Homeroom\'s copies, and named on a child app\'s', () => {
  const held = declare(
    story('approval-chip', 'Hide Build it now while a change awaits approval.'),
    story('activity-times', 'Points activities show when they happened.',
      { steps: ['Open the Leaderboard standings', 'Open a row'] }),
    story('bot-thanks', 'Homeroom bot thanks you for answering its plan, with your app\'s card.'),
  );
  assert.deepEqual(warned(held, true), [], 'each has a ready-made state');
  const child = warned(held, false);
  assert.equal(child.length, 3);
  assert.match(child[0], /^approval-chip seems to need a change waiting for approval, and this app's copies have no ready-made states\./);
  assert.match(child[0], /or seed it in the app's own staging seed \(its IS_STAGING seed\)\. A seed this proposal adds reaches only the after copy/);
  assert.match(child[0], /seed such a state in this proposal\. A change to a state that already existed needs it on both copies, so its seed merges first, in its own proposal\./);
  // 18 Nov 2026 (#6822): said outright, since PR #6819's author declared a
  // state the copies lacked though this answer said where data comes from.
  assert.match(child[0], /A claim about a screen that already exists \(a story whose baseState is "present"\) therefore needs a ready-made state these copies already hold, from availableStates: declare it against one, and a seed in this proposal cannot stand in for it\.$/);
  assert.match(readyStates.declarationAdvice(held, { selfApp: false }).dataNote, /A seed is idempotent and obviously fake/);
  assert.match(child[1], /^activity-times seems to need standings rows with recorded activities/);
  assert.match(child[2], /^bot-thanks seems to need an answered first-version plan/);
});

// The changes that ended with no shots from 9 to 12 October 2026, in the
// words their authors declared them with.
test('the states the October changes went unshot for are ready-made on Homeroom\'s copies, and named on a child app\'s', () => {
  const held = declare(
    story('voted-merged-bell-row', 'When a change you voted on goes live, your bell now has one new row for it.',
      { steps: ['Open the notifications panel from the bell in the header'] }),
    story('low-credits-note', 'Starting a brand new conversation when the credits pill is already red, a short red note appears.',
      { steps: ['Sign in as a member whose weekly AI allowance is almost spent, so the credits pill beside Send is red'] }),
    story('your-work-bot-tag', 'In Your work, a change Homeroom bot built from your request now wears a small tag.'),
    story('working-line', 'Messaging the bot on its change gets a line in that change\'s discussion.',
      { steps: ['Open a change built by Homeroom bot that is up for a vote', 'Open its Discussion'] }),
    story('person-card', 'In the chat with Homeroom bot, a request on a project somebody else runs says who decides there.',
      { steps: ['Find the newest card about a request that needs a person to decide'] }),
    story('testing-card', 'While a change\'s tests run, the Testing card\'s bar fills only as far as the slower half.',
      { steps: ['Open a change whose checks are mid-run'] }),
  );
  const own = readyStates.declarationAdvice(held, { selfApp: true });
  // Each has a ready-made state. PR 4622's line still needs the bot to take
  // its turn, which no state makes, so it is warned about the model; and
  // the nearly spent allowance is the full admin's, so a member's change
  // that needs it is told whose it is. 18 Nov 2026: a request's hand-off to
  // a person is on its page now, never in the chat with the bot, and the
  // state that drew it there is retired, so PR 4763's line is told nothing
  // ready-made holds it.
  assert.equal(own.warnings.length, 3);
  assert.match(own.warnings[0], /^low-credits-note seems to need a weekly allowance nearly spent, and the ready-made state that holds it on these copies is for full_admin \(see availableStates\)\. Declare the change for full_admin, or add hints\.setup/);
  assert.match(own.warnings[1], /^working-line seems to need a live reply from a model/);
  assert.match(own.warnings[2], /^person-card seems to need a Homeroom bot hand-off that needs a person to decide, and no ready-made state on these copies holds it \(see availableStates\)/);
  const asFullAdmin = declare(story('low-credits-note', held.stories[1].claim,
    { persona: 'full_admin', steps: held.stories[1].intent.steps }));
  assert.deepEqual(warned(asFullAdmin, true), [], 'declared for the persona the state is for');
  const names = own.availableStates.map((state) => state.name);
  for (const id of ['shots-demo-member-voted-change-live-v1', 'shots-demo-full-admin-allowance-low-v1',
    'shots-demo-member-bot-built-proposal-v1', 'shots-demo-member-checks-part-way-v1']) {
    const state = readyStates.READY_STATES.find((each) => each.id === id);
    assert.ok(names.includes(state.name), id);
  }
  // The allowance is the full admin's: the member is shot far more often.
  assert.deepEqual(own.availableStates.find((state) => /allowance/.test(state.name)).personas, ['full_admin']);
  const child = warned(held, false).map((w) => w.split(' to need ')[1].split(', and ')[0]);
  assert.deepEqual(child.filter((need) => !/^a live reply/.test(need)).sort(), [
    'a change you voted on that went live',
    'a change Homeroom bot built from a request',
    'a Homeroom bot hand-off that needs a person to decide',
    'checks part-way through',
    'a weekly allowance nearly spent',
    // PR 4622's steps open the bot's change "that is up for a vote".
    'a change waiting for approval',
  ].sort());
});

test('every answer says another persona\'s browser can be the second account', () => {
  for (const selfApp of [true, false]) {
    const { dataNote } = readyStates.declarationAdvice(declare(story('a', 'A reply shows in the thread.')), { selfApp });
    assert.match(dataNote, /Each signed-in persona is its own account, so a step somebody else takes \(a reply to the member's message, a vote on their change\) can be one of those steps, in another persona's browser\./);
  }
});

test('a change needing a state no ready-made state holds is warned about, once per state', () => {
  const warnings = warned(declare(
    story('tour-plan', 'The tour\'s last card names the plan.'),
    story('invited-home', 'An invited private member who has not been Home yet sees a welcome.'),
    story('waitlisted', 'A signed-in private member on the waitlist sees when they get in.'),
    story('tour-again', 'Only the first-session tour says it.'),
  ), true);
  assert.deepEqual(warnings.map((w) => w.split(' to need ')[0]), [
    'tour-plan, tour-again seem',
    'invited-home seems',
    'invited-home seems',
    'waitlisted seems',
  ]);
  assert.match(warnings[0], /a member in their first session \(its tour\), and no ready-made state on these copies holds it \(see availableStates\)/);
  assert.match(warnings[0], /seed it in the staging seeds in src\/db\/migrate\.js/);
  assert.match(warnings[0], /A seed this proposal adds reaches only the after copy, which is the side a state new in this proposal needs/);
  assert.match(warnings[0], /its seed merges first, in its own proposal\./);
  assert.match(warnings[0], /A claim about a screen that already exists \(a story whose baseState is "present"\) therefore needs a ready-made state/);
  assert.doesNotMatch(warnings.join(' '), /merged before this one/, 'a new state is seeded in the proposal that makes it');
  assert.match(warnings[1], /an account somebody invited/);
  assert.match(warnings[2], /an empty state, or an account with nothing of its own yet/);
  assert.match(warnings[3], /an account on the waitlist/);

  // A child app's empty state its own seed fills (Todo List #90).
  assert.equal(warned(declare(story('no-lists', 'A new user with no lists sees how to start one.')), false).length, 1);
});

// The invited fixtures (#4437) hold a change for the persona they answer
// for on Homeroom's own copies, so a change declared for one of them is not
// warned about a state the copies lack.
test('the invited fixtures hold a change declared for the persona they answer for', () => {
  const held = declare(
    story('first-visit', 'An invited member who has not been Home yet sees the welcome.',
      { persona: 'invited_member' }),
    story('listed', 'An invited member on the waitlist sees when they get in.',
      { persona: 'invited_member_listed' }),
    story('link', 'The invite link shows the project before somebody accepts an invitation.',
      { persona: 'guest' }),
  );
  assert.deepEqual(warned(held, true), []);
  // On a child app's copies there are no such people, and no such link.
  const child = warned(held, false).map((w) => w.split(' to need ')[0].split(' seem')[0]);
  assert.deepEqual(child, ['first-visit, listed, link', 'listed']);
  // A member persona is not one of them: the fixtures do not hold its
  // change, so both needs that match its words are warned about.
  assert.equal(warned(declare(story('invited-home',
    'An invited private member who has not been Home yet sees a welcome.')), true).length, 2);
});

test('no warning when the author says how to make it, for the guest\'s own state, or for ordinary words', () => {
  assert.deepEqual(warned(declare(story('empty', 'No lists yet shows a Start button.',
    { setup: 'Delete every list from its menu first' })), false), []);
  assert.deepEqual(warned(declare(story('landing', 'A first-time visitor sees the landing page.',
    { persona: 'guest' })), true), []);
  for (const claim of [
    'The settings page groups notifications under one heading.',
    'Say plan where people read spec.',
    'The Invite people sheet shows a QR code.',
    'Requests board rows say how long ago each was asked.',
    'The proposal card shows its vote tally on one line.',
    'Messages are drawn with the new avatar ring.',
  ]) {
    assert.deepEqual(warned(declare(story('ordinary', claim)), true), [], claim);
    assert.deepEqual(warned(declare(story('ordinary', claim)), false), [], claim);
  }
  // The steps and the checkpoint are its words too.
  assert.equal(warned(declare(story('steps', 'The card has a new line.',
    { steps: ['Open the hub as a member on the waitlist'] })), true).length, 1);
});

// 18 Nov 2026: the bot's own screens whose shots failed for want of data
// (PRs 6695, 6682, 6662, among others): a request waiting its turn, one
// nobody picked up under Not moving, and a change whose votes are in while
// its checks run. Each is the member's on Homeroom's copies, and named on a
// child app's.
test('the bot tab\'s waiting rows and an approved change still checking are ready-made for the member', () => {
  const held = declare(
    story('queued-row', 'A request waiting its turn says its number in line on the bot\'s tab.'),
    story('still-lit', 'A row under Not moving stays lit while its panel is open.'),
    story('approved-checking', 'When a change\'s votes are all in while its checks are still running, it says Approved.'),
  );
  assert.deepEqual(warned(held, true), [], 'each has a ready-made state for the member');
  const needs = warned(held, false).map((w) => w.split(' to need ')[1].split(', and ')[0]);
  assert.deepEqual(needs, [
    'a request waiting its turn to be built',
    'a request nobody has picked up (Not moving)',
    'a change whose votes are in while its checks still run',
  ]);
  // The read-only admin is not who they are for.
  const asAdmin = warned(declare(story('queued-row', held.stories[0].claim, { persona: 'read_only_admin' })), true);
  assert.equal(asAdmin.length, 1);
  assert.match(asAdmin[0], /is for member \(see availableStates\)/);
  const names = readyStates.declarationAdvice(held, { selfApp: true }).availableStates.map((state) => state.name);
  for (const id of ['shots-demo-member-request-queued-v1', 'shots-demo-member-request-not-moving-v1',
    'shots-demo-member-approved-checks-running-v1']) {
    assert.ok(names.includes(readyStates.READY_STATES.find((state) => state.id === id).name), id);
  }
  // Retired: the chat with the bot draws neither any more.
  for (const id of ['shots-demo-member-bot-run-card-v1', 'shots-demo-member-bot-deciders-v1']) {
    assert.ok(!demoStates.STATE_IDS.includes(id), id);
  }
});

// 18 Nov 2026 (#6822): PR #6819's change (an update on its way takes a
// change out of Needs you) could not be shot: no copy held a change being
// updated. Its family is ready-made for the member now.
test('a change being updated, one syncing with main and one back up for a vote are ready-made for the member', () => {
  const held = declare(
    story('updating-row', 'While an update is on its way to a change, its row says Updating.'),
    story('sync-line', 'A change catching up with main says it is syncing with main.'),
  );
  assert.deepEqual(warned(held, true), [], 'each has a ready-made state for the member');
  const needs = warned(held, false).map((w) => w.split(' to need ')[1].split(', and ')[0]);
  assert.deepEqual(needs, ['a Homeroom bot update running on a change (Updating)', 'a change syncing with main']);
  const names = readyStates.declarationAdvice(held, { selfApp: true }).availableStates.map((state) => state.name);
  for (const id of ['shots-demo-member-vote-update-running-v1', 'shots-demo-member-approved-syncing-v1',
    'shots-demo-member-vote-after-update-v1']) {
    const state = readyStates.READY_STATES.find((each) => each.id === id);
    assert.ok(state, id);
    assert.ok(names.includes(state.name), id);
    assert.deepEqual([...state.personas], ['member'], id);
  }
});

test('a change whose steps wait for a model\'s reply is warned about whatever setup or state it names', () => {
  // PR 4536's own words: its shots ended on "I can't reach my model".
  const asked = story('close-offer', 'When you ask the Homeroom bot in chat to close a request, or say one is done '
    + 'and can be closed, it now offers a vote on closing it under its reply, with Propose to close and Keep it open.',
  { setup: 'Open your chat with Homeroom bot first' });
  const [own] = warned(declare(asked), true);
  assert.match(own, /^close-offer seems to need a live reply from a model \(the Homeroom bot, or an app's own AI feature\)/);
  assert.match(own, /nothing on these copies answers with a model: they have no model key/);
  assert.match(own, /start from a ready-made state that already holds it \(see availableStates\), or seed the reply in the staging seeds in src\/db\/migrate\.js as the stored message\./);
  const [child] = warned(declare(story('summary', 'Send the AI a page and it replies with a summary.')), false);
  assert.match(child, /^summary seems to need a live reply from a model/);
  assert.match(child, /start from a reply the copies already hold, or seed the reply in the app's own staging seed \(its IS_STAGING seed\) as the stored message\./);
  for (const steps of [['Ask Homeroom bot to propose closing request 900003'], ['DM the bot: close it'],
    ['Mention @homeroom_bot on the request'], ['Wait until the bot replies']]) {
    assert.equal(warned(declare(story('asks', 'The card has a new line.', { steps })), true).length, 1, steps[0]);
  }
  // What the bot already said is a state, not an answer to wait for.
  for (const claim of [
    'Tapping Propose to close under the bot\'s offer opens the same vote.',
    'In your chat with Homeroom bot, a plan card shows its choices.',
    'The message the bot sent shows the request\'s card.',
    'Send the AI-generated summary by email.',
  ]) {
    assert.deepEqual(warned(declare(story('said', claim)), true), [], claim);
  }
  // And every answer says the copies have no model, so a reply is seeded as stored.
  assert.match(readyStates.declarationAdvice(declare(story('a', 'A change.')), { selfApp: true }).dataNote,
    /Nothing on them answers with a model, the Homeroom bot included: they have no model key, so seed a reply as the stored message rather than asking for it\.$/);
  assert.match(readyStates.declarationAdvice(declare(story('a', 'A change.')), { selfApp: false }).dataNote,
    /Nothing on them answers with a model: they have no model key, so seed a reply as the stored message rather than asking for it\.$/);
});

// The same advice, wherever an author reads how to declare: a state new in
// the proposal is seeded in it, a seed holds fixture accounts' and fake
// people's rows (never a signal the code reads), a reply is seeded as
// stored, and only a change to a state that already existed needs its seed
// merged first. AGENTS.md said to report a missing fixture as a blocker,
// and the declare tool said to report missing data; the other surfaces are
// pinned in their own suites (homeroom-bot-build-design, app-conventions,
// external-agent-tasks).
test('AGENTS.md and the declare tool say to seed a new state in the same proposal', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const agents = read('AGENTS.md');
  const start = agents.indexOf('## Declare visible changes');
  const section = agents.slice(start, agents.indexOf('\n## ', start + 1)).replace(/\s+/g, ' ');
  assert.match(section, /If a fresh staging copy lacks the state a change shows, seed it in the same proposal \(`src\/db\/migrate\.js`, idempotent, obviously fake\): it reaches the after copy, the side a new state needs\./);
  assert.match(section, /Seed rows for the shots' fixture accounts \(`usernode-capture` is the member\) and fake people, never a signal the code reads to decide something, and a bot's reply as the stored message, never asked for\./);
  assert.match(section, /A change to a state that already existed needs it on both sides: its seed merges first, in its own proposal\./);
  assert.match(section, /If a required state can be neither reached nor seeded, report that blocker instead of declaring `none`\./);
  assert.doesNotMatch(section, /If a required fixture or state is missing/);

  const tool = read('worker/visible-changes-mcp.js');
  assert.match(tool, /When a fresh staging copy lacks the state, seed it in this same change/);
  assert.match(tool, /a staging seed, in this same change for a state new in it/);
  assert.doesNotMatch(tool, /Report missing data or an unreachable state instead of guessing/);
});
