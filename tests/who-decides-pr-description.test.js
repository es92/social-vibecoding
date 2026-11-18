'use strict';

// #6038: a change to how changes are approved is titled and described from
// the rules it sets, not "its own rules (3 rules)". The title names each
// rule in its short form; the description spells each one out, names the
// people in each group, and says what is different from today.
// (src/services/who-decides-pr.js, on src/workflow/rules/governance-rules.ts)
//
// Run with: node --test tests/who-decides-pr-description.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const whoDecides = require('../src/services/who-decides-pr');
const rules = require('../src/services/governance-rules');
const renamePr = require('../src/services/rename-pr');

const APP = { id: 1, slug: 'patch', name: 'Patch', repo_url: 'https://github.com/acme/patch' };
const ACTOR = { id: 5, username: 'evan' };

// The screenshot's change: the creator's yes, 2 yeses from Lifeguards, or
// the group's usual vote with a minimum of 10.
function screenshotRules() {
  return rules.parseRulesBlock({
    groups: [{ name: 'Lifeguards', people: ['evan', 'maya'] }],
    rules: [
      { group: 'creator', atLeast: 1 },
      { group: 'Lifeguards', atLeast: 2 },
      { group: 'members', majority: true, minimum: 10 },
    ],
  });
}

async function bodyFor(t, change) {
  let opts = null;
  t.mock.method(renamePr, 'createManifestPR', async (_config, _pool, _app, _actor, o) => {
    opts = o;
    return { sessionId: 1, prNumber: 41, prUrl: 'https://github.test/pr/41', branch: 'who-decides/1' };
  });
  const result = await whoDecides.createWhoDecidesPR({}, {}, APP, change, ACTOR);
  return { body: opts.prBody, title: result.title, opts };
}

test('the title names the rules it sets', () => {
  const change = { visibility: null, governance: screenshotRules() };
  assert.equal(whoDecides.describeChange(change),
    "Approve changes by the creator's yes, 2 yeses from Lifeguards, or a vote of All members");
  // A preset keeps its name, and a visibility change says the same as before.
  assert.equal(whoDecides.describeChange({ visibility: null, governance: rules.parseRulesBlock({ preset: 'two_yeses' }) }),
    'Approve changes by Two yeses');
  assert.equal(whoDecides.describeChange({
    visibility: 'public', governance: rules.parseRulesBlock({ preset: 'you_or_the_group' }),
  }), 'Make this a public community, approved by You or the group');
});

test('the description spells out each rule and names each group', async (t) => {
  const change = { visibility: null, governance: screenshotRules() };
  const { body, title } = await bodyFor(t, change);
  assert.equal(title, "Approve changes by the creator's yes, 2 yeses from Lifeguards, or a vote of All members");
  assert.match(body, /proposed a change to how changes to "Patch" are approved\./);
  assert.ok(body.includes('A change goes live when any one of these rules passes:'));
  assert.ok(body.includes('- The creator says yes.'));
  assert.ok(body.includes('- At least 2 people in Lifeguards say yes.'));
  assert.ok(body.includes('- Most active people in All members say yes, over time, and at least 10 of them.'));
  assert.ok(body.includes('Lifeguards: @evan, @maya.'));
  // No "today" to compare with, because this operation was not given one.
  assert.ok(!body.includes('Compared with today:'));
  assert.ok(!body.includes('Until now:'));
  // The generated text is read by the group, so it has no em dash.
  assert.doesNotMatch(body, /—/);
});

test('the description says what changed against today\'s rules', async (t) => {
  const was = {
    rules: {
      preset: null,
      groups: [{ name: 'Lifeguards', key: 'lifeguards', people: ['evan'], ids: [] }],
      rules: [
        { group: 'creator', kind: 'atLeast', n: 1 },
        { group: 'lifeguards', kind: 'percentOfEveryone', n: 60 },
      ],
    },
    approverPolicy: 'anyone',
    approvalsRequired: null,
  };
  const now = rules.parseRulesBlock({
    groups: [{ name: 'Lifeguards', people: ['evan', 'maya'] }, { name: 'Crew', people: ['ana'] }],
    rules: [
      { group: 'creator', atLeast: 1 },
      { group: 'Lifeguards', atLeast: 2 },
      { group: 'members', majority: true, minimum: 10 },
    ],
  });
  const { body } = await bodyFor(t, { visibility: null, governance: now, was });
  assert.ok(body.includes('Compared with today:'));
  assert.ok(body.includes('- Added: At least 2 people in Lifeguards say yes.'));
  assert.ok(body.includes('- Added: Most active people in All members say yes, over time, and at least 10 of them.'));
  assert.ok(body.includes('- Removed: 60% of everyone in Lifeguards says yes.'));
  assert.ok(body.includes('- New group: Crew (@ana).'));
  assert.ok(body.includes('- Lifeguards: adds @maya.'));
  // The list of the new rules is still there above the comparison.
  assert.ok(body.includes('Crew: @ana.'));
});

test('a group the app keeps is described as kept by the app (#6669)', async (t) => {
  const now = rules.parseRulesBlock({
    groups: [{ name: 'App users', keptByApp: true }],
    rules: [{ group: 'App users', majority: true }],
  });
  const { body } = await bodyFor(t, { visibility: null, governance: now });
  assert.ok(body.includes('- Most active people in App users say yes, over time.'));
  assert.ok(body.includes('App users: kept by the app.'));
  // A kept group adds no "adds @…" line, and needs no username lookup.
  assert.ok(!body.includes('App users: nobody yet.'));
});

test('a project on the old two columns gets one "Until now" line instead', async (t) => {
  const was = { rules: null, approverPolicy: 'anyone', approvalsRequired: null };
  const { body } = await bodyFor(t, { visibility: null, governance: screenshotRules(), was });
  assert.ok(body.includes('Until now: approvals by any user, requiring the default time-&-majority vote.'));
  assert.ok(!body.includes('Compared with today:'));
});

test('a change to who can see it too keeps the wording it had', async (t) => {
  const { body } = await bodyFor(t, { visibility: 'public', governance: screenshotRules() });
  assert.match(body, /proposed a change to who can see and change "Patch": it makes it a public community/);
  assert.ok(!body.includes('how changes to "Patch" are approved'));
  assert.ok(body.includes('A change goes live when any one of these rules passes:'));
});

test('#6811: a kept group the app has sent says its size to the voters', () => {
  const now = rules.parseRulesBlock({
    groups: [{ name: 'Finishers', keptByApp: true }],
    rules: [{ group: 'Finishers', atLeast: 2 }],
  });
  const sizes = new Map([[rules.groupKey('Finishers'), { size: 12 }]]);
  const text = whoDecides.describeRulesChange({ visibility: null, governance: now }, sizes);
  assert.ok(text.includes('Finishers: kept by the app, 12 people today.'));
  // Unreported or unknown keeps today's line.
  const none = whoDecides.describeRulesChange({ visibility: null, governance: now }, new Map());
  assert.ok(none.includes('Finishers: kept by the app.'));
  assert.ok(!none.includes('people today'));
  // The new group's own line carries it too.
  const was = { rules: rules.parseRulesBlock({ preset: 'two_yeses' }) };
  const diffed = whoDecides.describeRulesChange({ visibility: null, governance: now, was }, sizes);
  assert.ok(diffed.includes('- New group: Finishers (kept by the app, 12 people today).'));
  const one = whoDecides.describeRulesChange(
    { visibility: null, governance: now },
    new Map([[rules.groupKey('Finishers'), { size: 1 }]]),
  );
  assert.ok(one.includes('1 person today'));
});
