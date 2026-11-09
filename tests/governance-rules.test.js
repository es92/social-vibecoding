// #4666, WHO SAYS YES: the approval presets, a project's own groups and
// rules, and the rule every change to who decides goes by
// (src/services/governance-rules.js, wired into src/services/governance.js
// computeGate / governedGate).
//
// Run with: node --test tests/governance-rules.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/services/governance-rules');
const governance = require('../src/services/governance');
const createOptions = require('../src/services/create-options');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 11, 12);
const OPENED = new Date(NOW - 60 * 1000).toISOString();

// evan (1) made it; maya (2), snait (3) and ana (4) are members.
const EVAN = 1;
const MAYA = 2;
const SNAIT = 3;
const ANA = 4;

function facts(over = {}) {
  return {
    creatorId: EVAN,
    memberCount: 4,
    membersActive: 4,
    adminIds: [],
    groups: new Map(),
    activeIds: null,
    ...over,
  };
}

function govFor(value) {
  return { approverPolicy: 'anyone', approvalsRequired: null, rules: value };
}

function preset(key) {
  return govFor(rules.parseRulesBlock({ preset: key }));
}

function gate(gov, { yes = [], no = [], author = MAYA, f = facts(), explicitApproval = false, reason, openedAt = OPENED, now = NOW, authorWithdrew = false } = {}) {
  return governance.computeGate(gov, f.membersActive, yes.length, no.length, openedAt, now, {
    voters: { yes: new Set(yes), no: new Set(no) },
    rulesFacts: f,
    authorId: author,
    memberCount: f.memberCount,
    explicitApproval,
    authorWithdrew,
    ...(reason !== undefined ? { explicitReason: reason } : {}),
  });
}

// ── Reading the block ─────────────────────────────────────────────────

test('a preset reads as the rules it stands for', () => {
  const v = rules.parseRulesBlock({ preset: 'you_or_the_group' });
  assert.equal(v.preset, 'you_or_the_group');
  assert.deepEqual(v.rules, [
    { group: 'creator', kind: 'atLeast', n: 1 },
    { group: 'members', kind: 'majority', n: null },
  ]);
  assert.equal(rules.parseRulesBlock({ preset: 'two_yeses' }).rules[0].n, 2);
});

test('a block with neither preset nor rules is an old-style block', () => {
  assert.equal(rules.parseRulesBlock(null), null);
  assert.equal(rules.parseRulesBlock({ approvers: 'invited', approvals: { atLeast: 1 } }), null);
});

test('groups and rules of a project’s own, with every measure', () => {
  const v = rules.parseRulesBlock({
    groups: [{ name: 'Lifeguards', people: ['evan', '@maya', 'Maya', ' '] }],
    rules: [
      { group: 'creator', atLeast: 1 },
      { group: 'lifeguards', atLeast: 2 },
      { group: 'members', percentOfActive: 50 },
      { group: 'members', percentOfEveryone: 60 },
      { group: 'Members', majority: true },
    ],
  });
  assert.equal(v.preset, null);
  assert.deepEqual(v.groups, [{ name: 'Lifeguards', people: ['evan', 'maya'] }]);
  assert.deepEqual(v.rules.map((r) => [r.group, r.kind, r.n]), [
    ['creator', 'atLeast', 1],
    ['lifeguards', 'atLeast', 2],
    ['members', 'percentOfActive', 50],
    ['members', 'percentOfEveryone', 60],
    ['members', 'majority', null],
  ]);
});

test('the strict reader refuses what it cannot read, with the limits', () => {
  const bad = [
    { preset: 'captain' },
    { preset: 'open_floor', rules: [{ group: 'members', atLeast: 1 }] },
    { rules: [] },
    { rules: [{ group: 'friends', atLeast: 1 }] },
    { rules: [{ group: 'members', atLeast: 0 }] },
    { rules: [{ group: 'members', percentOfActive: 101 }] },
    { rules: [{ group: 'members', majority: false }] },
    { rules: [{ group: 'members', atLeast: 1, majority: true }] },
    { rules: [{ group: 'members', atLeast: 1 }, { group: 'members', atLeast: 1 }] },
    { groups: [{ name: 'Members', people: [] }], rules: [{ group: 'members', atLeast: 1 }] },
    { groups: [{ name: 'A' }, { name: 'a' }], rules: [{ group: 'a', atLeast: 1 }] },
    { rules: Array.from({ length: rules.MAX_RULES + 1 }, (_, i) => ({ group: 'members', atLeast: i + 1 })) },
    {
      groups: Array.from({ length: rules.MAX_GROUPS + 1 }, (_, i) => ({ name: `G${i}` })),
      rules: [{ group: 'g0', atLeast: 1 }],
    },
  ];
  for (const b of bad) assert.throws(() => rules.parseRulesBlock(b), rules.RulesError, JSON.stringify(b));
  // The deploy reader never throws: it reports and keeps what the project had.
  const lenient = rules.readRulesBlock({ preset: 'captain' });
  assert.equal(lenient.value, null);
  assert.match(lenient.error, /preset/);
});

test('a rule list that is a preset says so, in any order, and is written as it', () => {
  assert.equal(rules.matchPreset([
    { group: 'members', kind: 'majority', n: null },
    { group: 'creator', kind: 'atLeast', n: 1 },
  ]), 'you_or_the_group');
  assert.equal(rules.matchPreset([{ group: 'members', kind: 'atLeast', n: 3 }]), null);
  assert.deepEqual(rules.blockFor({ rules: [{ group: 'members', kind: 'atLeast', n: 1 }] }), { preset: 'open_floor' });
  assert.deepEqual(rules.blockFor({
    groups: [{ name: 'Lifeguards', people: ['evan'] }],
    rules: [{ group: 'lifeguards', kind: 'atLeast', n: 2 }, { group: 'members', kind: 'majority', n: null }],
  }), {
    groups: [{ name: 'Lifeguards', people: ['evan'] }],
    rules: [{ group: 'Lifeguards', atLeast: 2 }, { group: 'members', majority: true }],
  });
  // What it writes, it reads back as the same rules.
  const back = rules.parseRulesBlock(rules.blockFor({
    groups: [{ name: 'Lifeguards', people: ['evan'] }],
    rules: [{ group: 'lifeguards', kind: 'percentOfEveryone', n: 60 }],
  }));
  assert.deepEqual(back.rules, [{ group: 'lifeguards', kind: 'percentOfEveryone', n: 60 }]);
});

test('new projects start on You or the group', () => {
  assert.equal(rules.DEFAULT_PRESET, 'you_or_the_group');
});

// ── You or the group ──────────────────────────────────────────────────

test('You or the group: the creator’s own change goes live on proposing it', () => {
  const g = gate(preset('you_or_the_group'), { author: EVAN });
  assert.equal(g.mode, 'rules');
  assert.equal(g.preset, 'you_or_the_group');
  assert.equal(g.mergeable, true);
  assert.equal(g.creatorYes, true);
  assert.deepEqual(g.passedBy, { group: 'creator', kind: 'atLeast', n: 1 });
  assert.equal(g.rejectable, false);
});

test('You or the group: a member’s change goes live on the creator’s yes', () => {
  assert.equal(gate(preset('you_or_the_group'), { author: MAYA }).mergeable, false);
  const g = gate(preset('you_or_the_group'), { author: MAYA, yes: [EVAN] });
  assert.equal(g.mergeable, true);
  assert.equal(g.creatorYes, true);
});

test('You or the group: or when most of the group says yes, as Group vote would', () => {
  // Four active members: the eased bar is 2 (active-users.js requiredVotes).
  const g = gate(preset('you_or_the_group'), { author: MAYA, yes: [MAYA, SNAIT, ANA] });
  assert.equal(g.mergeable, true);
  assert.deepEqual(g.passedBy, { group: 'members', kind: 'majority', n: null });
  assert.equal(g.creatorYes, false);
});

test('You or the group: when the group\'s vote passes too, the threshold stays the group\'s (audit, 2 Nov 2026)', () => {
  // Book Club: three members, the bot's change for a member's request. It
  // read "0 of 2 yes votes", then "1/2" on the first yes; the creator's yes
  // made it two of the three, which passes BOTH rules. The first rule that
  // passed was reported (the creator's, need 1), so the merge snapshotted
  // votes_required = 1 under two yes votes: "2 of 1 yes vote".
  const f = facts({ memberCount: 3, membersActive: 3 });
  const BOT = 99;
  const first = gate(preset('you_or_the_group'), { author: BOT, yes: [SNAIT], f });
  assert.equal(first.mergeable, false);
  assert.equal(first.required, 2, 'open: two of the three members');
  const both = gate(preset('you_or_the_group'), { author: BOT, yes: [SNAIT, EVAN], f });
  assert.equal(both.mergeable, true);
  assert.deepEqual(both.passedBy, { group: 'members', kind: 'majority', n: null },
    'the group\'s own rule passed, so it is the one reported');
  assert.equal(both.required, 2, 'the threshold the vote was shown against');
  assert.equal(both.qualifiedYes, 2);
  assert.equal(both.creatorYes, true, 'the creator\'s yes is still said');
  // The creator's yes alone, the group short: it went in by the creator's
  // rule, said in that rule's terms, as before.
  const creatorOnly = gate(preset('you_or_the_group'), { author: BOT, yes: [EVAN], f: facts() });
  assert.equal(creatorOnly.mergeable, true);
  assert.equal(creatorOnly.passedBy.group, 'creator');
  assert.equal(creatorOnly.required, 1);
});

test('You or the group: the creator saying No is not a veto', () => {
  const g = gate(preset('you_or_the_group'), { author: MAYA, yes: [MAYA, SNAIT, ANA], no: [EVAN] });
  assert.equal(g.mergeable, true);
});

test('You or the group: a creator who voted No on their own change does not ship it', () => {
  const g = gate(preset('you_or_the_group'), { author: EVAN, no: [EVAN] });
  assert.equal(g.mergeable, false);
  assert.equal(g.creatorYes, false);
});

test('a project with no creator (the platform’s own) never passes a creator rule', () => {
  const g = gate(preset('you_or_the_group'), { author: EVAN, f: facts({ creatorId: null }) });
  assert.equal(g.mergeable, false);
  assert.equal(g.rules[0].empty, true);
});

// ── Two yeses ─────────────────────────────────────────────────────────

test('Two yeses: whoever makes it, plus one more', () => {
  assert.equal(gate(preset('two_yeses'), { author: MAYA }).mergeable, false);
  const g = gate(preset('two_yeses'), { author: MAYA, yes: [SNAIT] });
  assert.equal(g.mergeable, true);
  assert.equal(g.qualifiedYes, 2);
  assert.equal(g.required, 2);
});

test('Two yeses: the author’s own vote does not count twice', () => {
  assert.equal(gate(preset('two_yeses'), { author: MAYA, yes: [MAYA] }).mergeable, false);
});

test('Two yeses: alone in the project, your yes is enough', () => {
  const g = gate(preset('two_yeses'), { author: EVAN, f: facts({ memberCount: 1, membersActive: 1 }) });
  assert.equal(g.mergeable, true);
  assert.equal(g.required, 1);
});

// ── #6477: an author who took their vote back ─────────────────────────

function evalCtx(over = {}) {
  return {
    facts: facts(), voters: { yes: new Set(), no: new Set() }, counts: { yes: 0, no: 0 },
    authorId: MAYA, openedAt: OPENED, now: NOW, noTimers: false, memberFloor: null,
    mergeGate: governance.mergeGate, applyNoTimerMerge: governance.applyNoTimerMerge,
    atLeastGate: governance.atLeastGate, ...over,
  };
}

test('#6477: an author who took their vote back has no yes for proposing', () => {
  const rule = { group: 'members', kind: 'atLeast', n: 2 };
  const proposing = rules.evaluateRule(rule, evalCtx());
  assert.equal(proposing.yes, 1, 'proposing counts as their yes');
  assert.equal(proposing.authorYes, true);
  const withdrew = rules.evaluateRule(rule, evalCtx({ authorWithdrew: true }));
  assert.equal(withdrew.yes, 0);
  assert.equal(withdrew.authorYes, false, 'and the card stops saying it counts as their yes');
  // Their own cast yes still counts, as it does for anyone.
  assert.equal(rules.evaluateRule(rule, evalCtx({ voters: { yes: new Set([MAYA]), no: new Set() }, authorWithdrew: true })).yes, 1);
});

test('#6477: a share of the group gives no yes for proposing after a withdrawal', () => {
  const rule = { group: 'members', kind: 'percentOfEveryone', n: 50 };
  assert.equal(rules.evaluateRule(rule, evalCtx()).yes, 1);
  assert.equal(rules.evaluateRule(rule, evalCtx({ authorWithdrew: true })).yes, 0);
});

test('#6477: the gate’s figure and the creator’s yes follow the withdrawal', () => {
  const g = gate(preset('two_yeses'), { author: MAYA, authorWithdrew: true });
  assert.equal(g.qualifiedYes, 0);
  assert.equal(g.mergeable, false);
  const own = gate(preset('you_or_the_group'), { author: EVAN, authorWithdrew: true });
  assert.equal(own.creatorYes, false);
  assert.equal(own.qualifiedYes, 0, 'and nothing else has been cast on it');
});

// ── Open floor and Group vote ─────────────────────────────────────────

test('Open floor: any member’s change goes live on proposing it', () => {
  assert.equal(gate(preset('open_floor'), { author: SNAIT }).mergeable, true);
});

test('Group vote counts votes as cast: proposing alone is not a yes', () => {
  const g = gate(preset('group_vote'), { author: MAYA });
  assert.equal(g.mergeable, false);
  assert.equal(g.qualifiedYes, 0);
  assert.equal(g.lazyArmed, false);
});

test('Group vote is the default mode’s gate, clocks and all', () => {
  const { mergeGate } = require('../src/services/active-users');
  const g = gate(preset('group_vote'), { author: MAYA, yes: [MAYA] });
  const want = mergeGate(4, 1, 0, OPENED, NOW);
  for (const k of ['required', 'windowEndsAt', 'lazyArmed', 'lazyWindowMs', 'mergeable', 'rejectionArmed']) {
    assert.deepEqual(g[k], want[k], k);
  }
});

// ── A project’s own groups and rules ──────────────────────────────────

test('a named group counts only its people, and never more than it has', () => {
  const value = rules.parseRulesBlock({
    groups: [{ name: 'Lifeguards', people: ['evan', 'maya'] }],
    rules: [{ group: 'Lifeguards', atLeast: 5 }],
  });
  value.groups = [{ name: 'Lifeguards', key: 'lifeguards', ids: [EVAN, MAYA] }];
  const f = facts({ groups: new Map([['lifeguards', [EVAN, MAYA]]]) });
  // Capped at the group's two people; snait's yes is not theirs.
  assert.equal(gate(govFor(value), { author: SNAIT, yes: [SNAIT, EVAN], f }).mergeable, false);
  const g = gate(govFor(value), { author: SNAIT, yes: [EVAN, MAYA], f });
  assert.equal(g.mergeable, true);
  assert.equal(g.rules[0].need, 2);
});

test('a group with nobody in it never passes', () => {
  const value = { preset: null, groups: [], rules: [{ group: 'admins', kind: 'atLeast', n: 1 }] };
  const g = gate(govFor(value), { author: EVAN, yes: [EVAN] });
  assert.equal(g.mergeable, false);
  assert.equal(g.rules[0].empty, true);
});

test('shares of everyone and of the active, rounded up and at least one', () => {
  const everyone = { preset: null, groups: [], rules: [{ group: 'members', kind: 'percentOfEveryone', n: 60 }] };
  // 60% of 4 members is 2.4: three yeses, the author's among them.
  assert.equal(gate(govFor(everyone), { author: MAYA, yes: [SNAIT] }).mergeable, false);
  assert.equal(gate(govFor(everyone), { author: MAYA, yes: [SNAIT, ANA] }).mergeable, true);
  const active = { preset: null, groups: [], rules: [{ group: 'members', kind: 'percentOfActive', n: 50 }] };
  const f = facts({ membersActive: 2 });
  assert.equal(gate(govFor(active), { author: MAYA, f }).mergeable, true);
});

test('any one rule passing is enough', () => {
  const value = {
    preset: null,
    groups: [],
    rules: [{ group: 'admins', kind: 'atLeast', n: 1 }, { group: 'members', kind: 'atLeast', n: 3 }],
  };
  const f = facts({ adminIds: [ANA] });
  assert.equal(gate(govFor(value), { author: MAYA, yes: [SNAIT], f }).mergeable, false);
  assert.equal(gate(govFor(value), { author: MAYA, yes: [ANA], f }).passedBy.group, 'admins');
  assert.equal(gate(govFor(value), { author: MAYA, yes: [SNAIT, EVAN], f }).passedBy.group, 'members');
});

// ── A minimum on a majority or a share ────────────────────────────────

const ids = (n, from = 1) => Array.from({ length: n }, (_, i) => from + i);

function withMinimum(rule) {
  return govFor(rules.parseRulesBlock({ rules: [rule] }));
}

test('a majority or a share can carry a minimum, written and read back as one', () => {
  const v = rules.parseRulesBlock({
    rules: [
      { group: 'creator', atLeast: 1 },
      { group: 'members', majority: true, minimum: 10 },
      { group: 'members', percentOfActive: 50, minimum: 3 },
    ],
  });
  assert.deepEqual(v.rules, [
    { group: 'creator', kind: 'atLeast', n: 1 },
    { group: 'members', kind: 'majority', n: null, min: 10 },
    { group: 'members', kind: 'percentOfActive', n: 50, min: 3 },
  ]);
  const block = rules.blockFor(v);
  assert.deepEqual(block.rules[1], { group: 'members', majority: true, minimum: 10 });
  assert.deepEqual(rules.parseRulesBlock(block).rules, v.rules);
  // Stored and read back by the gate with it.
  const stored = rules.storedForm(v);
  assert.deepEqual(stored.rules[1], { group: 'members', kind: 'majority', n: null, min: 10 });
  assert.deepEqual(governance.rulesFromColumn(stored).rules, v.rules);
});

test('a minimum makes a rule list no preset, so it is never written as one', () => {
  const v = rules.parseRulesBlock({ rules: [{ group: 'creator', atLeast: 1 }, { group: 'members', majority: true, minimum: 10 }] });
  assert.equal(rules.matchPreset(v.rules), null);
  assert.equal('preset' in rules.blockFor(v), false);
  assert.equal(rules.describeRules(v), "the creator's yes, or a vote of All members");
  // The same rule with and without a minimum are two rules.
  assert.doesNotThrow(() => rules.parseRulesBlock({ rules: [
    { group: 'members', majority: true }, { group: 'members', majority: true, minimum: 10 },
  ] }));
});

test('the strict reader refuses a minimum it cannot take', () => {
  const bad = [
    { group: 'members', atLeast: 2, minimum: 5 },
    { group: 'members', majority: true, minimum: 1 },
    { group: 'members', majority: true, minimum: rules.MAX_AT_LEAST + 1 },
    { group: 'members', percentOfEveryone: 50, minimum: 2.5 },
    { group: 'members', majority: true, minimum: '10' },
  ];
  for (const r of bad) assert.throws(() => rules.parseRulesBlock({ rules: [r] }), rules.RulesError, JSON.stringify(r));
});

test('a minimum in a small group is everyone in it, and never more', () => {
  // Four members: a minimum of 10 asks for all four yeses.
  const gov = withMinimum({ group: 'members', majority: true, minimum: 10 });
  const short = gate(gov, { author: MAYA, yes: [MAYA, SNAIT, EVAN] });
  assert.equal(short.mergeable, false);
  assert.equal(short.required, 4);
  assert.equal(short.rules[0].need, 4);
  assert.equal(short.rules[0].min, 10);
  // Group vote alone would have taken three.
  assert.equal(gate(preset('group_vote'), { author: MAYA, yes: [MAYA, SNAIT, EVAN] }).mergeable, true);
  assert.equal(gate(gov, { author: MAYA, yes: [MAYA, SNAIT, EVAN, ANA] }).mergeable, true);
});

test('a minimum above the eased bar is the bar; below it, it changes nothing', () => {
  // Thirty active members, nobody opposed: Group vote's eased bar is 9.
  const f = facts({ memberCount: 30, membersActive: 30 });
  assert.equal(gate(preset('group_vote'), { author: 1, yes: ids(9), f }).required, 9);
  const ten = withMinimum({ group: 'members', majority: true, minimum: 10 });
  const nine = gate(ten, { author: 1, yes: ids(9), f });
  assert.equal(nine.required, 10);
  assert.equal(nine.thresholdMet, false);
  assert.equal(nine.mergeable, false);
  const reached = gate(ten, { author: 1, yes: ids(10), f });
  assert.equal(reached.thresholdMet, true);
  const five = withMinimum({ group: 'members', majority: true, minimum: 5 });
  const plain = gate(preset('group_vote'), { author: 1, yes: ids(9), f });
  const eased = gate(five, { author: 1, yes: ids(9), f });
  for (const k of ['required', 'thresholdMet', 'windowEndsAt', 'mergeable']) assert.deepEqual(eased[k], plain[k], k);
});

test('a minimum holds on the quiet wait: silence alone never ships it', () => {
  const weekAgo = new Date(NOW - 8 * DAY).toISOString();
  const lone = { author: MAYA, yes: [MAYA], openedAt: weekAgo };
  // One unopposed yes, a week on: Group vote ships it.
  assert.equal(gate(preset('group_vote'), lone).mergeable, true);
  const g = gate(withMinimum({ group: 'members', majority: true, minimum: 10 }), lone);
  assert.equal(g.mergeable, false);
  assert.equal(g.lazyArmed, false);
  assert.equal(g.windowEndsAt, null, 'no clock counts down to a merge that cannot happen');
});

test('a change the group votes down under a minimum still closes on schedule', () => {
  const weekAgo = new Date(NOW - 8 * DAY).toISOString();
  const down = { author: MAYA, no: [SNAIT, ANA, EVAN], openedAt: weekAgo };
  const plain = gate(preset('group_vote'), down);
  const g = gate(withMinimum({ group: 'members', majority: true, minimum: 10 }), down);
  assert.equal(plain.rejectable, true);
  for (const k of ['rejectionArmed', 'rejectionEndsAt', 'rejectable']) assert.deepEqual(g[k], plain[k], k);
});

test('a share with a minimum counts the author’s yes toward both', () => {
  // Half of four members is two; the minimum of three is the bar.
  const gov = withMinimum({ group: 'members', percentOfEveryone: 50, minimum: 3 });
  assert.equal(gate(gov, { author: MAYA, yes: [SNAIT] }).mergeable, false);
  const g = gate(gov, { author: MAYA, yes: [SNAIT, ANA] });
  assert.equal(g.mergeable, true);
  assert.equal(g.rules[0].need, 3);
});

test('the creator’s yes still ships a change beside a members rule with a minimum', () => {
  const gov = govFor(rules.parseRulesBlock({ rules: [
    { group: 'creator', atLeast: 1 }, { group: 'members', majority: true, minimum: 10 },
  ] }));
  assert.equal(gate(gov, { author: MAYA, yes: [EVAN] }).mergeable, true);
  assert.equal(gate(gov, { author: MAYA, yes: [MAYA, SNAIT] }).mergeable, false);
});

// ── Changes to who decides ────────────────────────────────────────────

test('who decides goes by You or the group whatever the project picked', () => {
  // Open floor would ship maya's change on her own say-so; making the
  // project public is not hers alone to decide.
  const g = gate(preset('open_floor'), { author: MAYA, explicitApproval: true, reason: 'visibility' });
  assert.equal(g.whoDecides, true);
  assert.equal(g.mergeable, false);
  assert.equal(gate(preset('open_floor'), { author: MAYA, yes: [EVAN], explicitApproval: true, reason: 'visibility' }).mergeable, true);
});

test('who decides: the creator changes the rule alone', () => {
  const g = gate(preset('group_vote'), { author: EVAN, explicitApproval: true, reason: 'governance' });
  assert.equal(g.mergeable, true);
  assert.equal(g.passedBy.group, 'creator');
});

test('who decides: the group’s real yes votes outvote the creator, with no quiet wait', () => {
  // One yes from someone besides the author arms the quiet wait in a normal
  // vote; here it does nothing until the threshold is met by votes cast.
  const waiting = gate(preset('you_or_the_group'), {
    author: MAYA, yes: [SNAIT], explicitApproval: true, reason: 'admins',
    openedAt: new Date(NOW - 30 * DAY).toISOString(),
  });
  assert.equal(waiting.mergeable, false);
  assert.equal(waiting.lazyArmed, false);
  const outvoted = gate(preset('you_or_the_group'), {
    author: MAYA, yes: [MAYA, SNAIT, ANA], no: [EVAN], explicitApproval: true, reason: 'admins',
  });
  assert.equal(outvoted.mergeable, true);
  assert.equal(outvoted.passedBy.group, 'members');
});

test('who decides: the group’s side needs a yes from someone besides the author', () => {
  // One active member makes the eased bar a single yes: the author's own.
  const f = facts({ membersActive: 1 });
  const g = gate(preset('you_or_the_group'), { author: MAYA, yes: [MAYA], f, explicitApproval: true, reason: 'governance' });
  assert.equal(g.mergeable, false);
  assert.equal(g.memberFloor.applies, true);
  assert.equal(g.memberFloor.met, false);
});

test('a change to the keys follows the project’s own rule, clocks off', () => {
  const g = gate(preset('two_yeses'), { author: MAYA, yes: [SNAIT], explicitApproval: true, reason: 'secrets' });
  assert.equal(g.whoDecides, false);
  assert.equal(g.mergeable, true);
  const vote = gate(preset('group_vote'), {
    author: MAYA, yes: [SNAIT], explicitApproval: true, reason: 'secrets',
    openedAt: new Date(NOW - 30 * DAY).toISOString(),
  });
  assert.equal(vote.lazyArmed, false);
  assert.equal(vote.mergeable, false);
});

test('a flag with no reason is read as who decides', () => {
  assert.equal(gate(preset('open_floor'), { author: MAYA, explicitApproval: true, reason: null }).mergeable, false);
});

// ── Callers with counts only ──────────────────────────────────────────

test('a caller with counts only answers the members rules and says it is partial', () => {
  const gov = preset('you_or_the_group');
  const g = governance.computeGate(gov, 4, 3, 0, OPENED, NOW, {});
  assert.equal(g.mergeable, true);
  const creatorOnly = governance.computeGate(gov, 4, 0, 0, OPENED, NOW, {});
  assert.equal(creatorOnly.mergeable, false);
  assert.equal(creatorOnly.partial, true);
});

test('projects without rules are untouched', () => {
  const g = governance.computeGate({ approverPolicy: 'anyone', approvalsRequired: null }, 4, 1, 0, OPENED, NOW, {});
  assert.equal(g.mode, 'default');
  assert.equal(governance.computeGate({ approverPolicy: 'anyone', approvalsRequired: 2, rules: null }, 4, 2, 0, OPENED, NOW).mode, 'at_least');
});

// ── governedGate reads what a rule needs ──────────────────────────────

function fakePool({ rulesRow, votes = [], author = MAYA, reason = null } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push(sql);
      if (/SELECT approver_policy, approvals_required FROM apps/.test(sql)) {
        return { rows: [{ approver_policy: 'anyone', approvals_required: null }] };
      }
      if (/SELECT governance_rules FROM apps/.test(sql)) return { rows: [{ governance_rules: rulesRow }] };
      if (/FROM apps a WHERE a.id = \$1/.test(sql) && /member_count/.test(sql)) {
        return { rows: [{ created_by: EVAN, self_hosted: false, collab_visibility: 'private', member_count: 4, admin_ids: [] }] };
      }
      if (/FROM pr_votes/.test(sql) && /SELECT user_id, vote/.test(sql)) return { rows: votes };
      if (/SELECT user_id AS author_id FROM chat_sessions/.test(sql)) return { rows: [{ author_id: author }] };
      // D2: whether the author is a person (tests/first-version-gate.test.js).
      if (/SELECT is_synthetic FROM users/.test(sql)) return { rows: [{ is_synthetic: false }] };
      // D1: whether it is the project's first version.
      if (/AS first_version FROM chat_sessions cs/.test(sql)) return { rows: [{ first_version: false }] };
      if (/explicit_approval_reason FROM chat_sessions/.test(sql)) return { rows: [{ explicit_approval_reason: reason }] };
      if (/COUNT\(DISTINCT a.user_id\)/.test(sql)) return { rows: [{ cnt: 4, invited_floor: 2 }] };
      if (/SELECT self_hosted, collab_visibility FROM apps/.test(sql)) return { rows: [{ self_hosted: false, collab_visibility: 'private' }] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

test('governedGate reads the voters, the author and the app for a rules project', async () => {
  governance.invalidateGovernance(901);
  const pool = fakePool({ rulesRow: { preset: 'you_or_the_group', groups: [], rules: rules.PRESETS.you_or_the_group }, votes: [{ user_id: EVAN, vote: 'yes' }] });
  const g = await governance.governedGate(pool, 901, { kind: 'pr', id: 77, openedAt: OPENED, now: NOW });
  assert.equal(g.mode, 'rules');
  assert.equal(g.mergeable, true);
  assert.equal(g.creatorYes, true);
});

test('governedGate reads the stored reason of a flagged PR when not told', async () => {
  governance.invalidateGovernance(902);
  const pool = fakePool({
    rulesRow: { preset: 'open_floor', groups: [], rules: rules.PRESETS.open_floor },
    reason: 'visibility',
  });
  const g = await governance.governedGate(pool, 902, { kind: 'pr', id: 78, openedAt: OPENED, now: NOW, explicitApproval: true });
  assert.equal(g.whoDecides, true);
  assert.equal(g.mergeable, false);
});

test('a project without rules issues the same queries it always did, plus the one rules read', async () => {
  governance.invalidateGovernance(903);
  const pool = fakePool({ rulesRow: null });
  pool.query = ((orig) => async (sql, params) => {
    if (/SELECT COUNT\(\*\) as cnt FROM pr_votes/.test(sql)) return { rows: [{ cnt: 0 }] };
    return orig(sql, params);
  })(pool.query.bind(pool));
  const g = await governance.governedGate(pool, 903, { kind: 'pr', id: 79, openedAt: OPENED, now: NOW });
  assert.equal(g.mode, 'default');
});

test('a failed rules read falls back to the columns', async () => {
  governance.invalidateGovernance(904);
  const pool = {
    async query(sql) {
      if (/SELECT approver_policy, approvals_required FROM apps/.test(sql)) return { rows: [{ approver_policy: 'anyone', approvals_required: 2 }] };
      throw new Error('column "governance_rules" does not exist');
    },
  };
  const gov = await governance.getGovernance(pool, 904);
  assert.equal(gov.rules, null);
  assert.equal(gov.approvalsRequired, 2);
});

// ── New projects ──────────────────────────────────────────────────────

test('a new project is created on You or the group unless it asks otherwise', () => {
  const opts = createOptions.parseCreateOptions({ audience: 'solo' });
  assert.equal(opts.governance.preset, 'you_or_the_group');
  assert.deepEqual(createOptions.governanceBlock(opts.governance), { preset: 'you_or_the_group' });
  const chosen = createOptions.parseCreateOptions({ audience: 'solo', governance: { preset: 'two_yeses' } });
  assert.deepEqual(createOptions.governanceBlock(chosen.governance), { preset: 'two_yeses' });
  const old = createOptions.parseCreateOptions({ audience: 'solo', governance: { approvers: 'invited' } });
  assert.deepEqual(createOptions.governanceBlock(old.governance), { approvers: 'invited', approvals: 'default' });
});

// ── Saying the rules in words ─────────────────────────────────────────
// #6038: a change's title and description are built from the rules it sets,
// not "its own rules (3 rules)".

test('each measure has its sentence and its short form', () => {
  const crews = [{ name: 'Lifeguards', people: ['evan', 'maya'] }];
  const lifeguards = 'lifeguards';
  assert.equal(rules.ruleSentence({ group: 'creator', kind: 'atLeast', n: 1 }, []), 'The creator says yes');
  assert.equal(rules.ruleShort({ group: 'creator', kind: 'atLeast', n: 1 }, []), "the creator's yes");
  assert.equal(rules.ruleSentence({ group: lifeguards, kind: 'atLeast', n: 1 }, crews),
    'At least 1 person in Lifeguards says yes');
  assert.equal(rules.ruleShort({ group: lifeguards, kind: 'atLeast', n: 1 }, crews), '1 yes from Lifeguards');
  assert.equal(rules.ruleSentence({ group: lifeguards, kind: 'atLeast', n: 2 }, crews),
    'At least 2 people in Lifeguards say yes');
  assert.equal(rules.ruleShort({ group: lifeguards, kind: 'atLeast', n: 2 }, crews), '2 yeses from Lifeguards');
  assert.equal(rules.ruleSentence({ group: lifeguards, kind: 'percentOfActive', n: 50 }, crews),
    '50% of the active people in Lifeguards say yes');
  assert.equal(rules.ruleShort({ group: lifeguards, kind: 'percentOfActive', n: 50 }, crews), '50% of active Lifeguards');
  assert.equal(rules.ruleSentence({ group: 'members', kind: 'percentOfEveryone', n: 60 }, []),
    '60% of everyone in All members says yes');
  assert.equal(rules.ruleShort({ group: 'members', kind: 'percentOfEveryone', n: 60 }, []), '60% of All members');
  assert.equal(rules.ruleSentence({ group: 'members', kind: 'majority', n: null }, []),
    'Most active people in All members say yes, over time');
  assert.equal(rules.ruleShort({ group: 'members', kind: 'majority', n: null }, []), 'a vote of All members');
  // A minimum stays in the description, never in the short form.
  assert.equal(rules.ruleSentence({ group: 'members', kind: 'majority', n: null, min: 10 }, []),
    'Most active people in All members say yes, over time, and at least 10 of them');
  assert.equal(rules.ruleShort({ group: 'members', kind: 'majority', n: null, min: 10 }, []), 'a vote of All members');
});

test('built-in and named groups are said the way the sheet says them', () => {
  const crews = [{ name: 'Lifeguards', people: [] }];
  assert.equal(rules.groupLabel('creator', []), 'the creator');
  assert.equal(rules.groupLabel('members', []), 'All members');
  assert.equal(rules.groupLabel('admins', []), 'App admins');
  assert.equal(rules.groupLabel('lifeguards', crews), 'Lifeguards');
  assert.equal(rules.groupLabel('gone', []), 'gone');
});

test('a project\'s own rules describe as those rules, not "its own rules"', () => {
  const v = rules.parseRulesBlock({
    groups: [{ name: 'Lifeguards', people: ['evan', 'maya'] }],
    rules: [
      { group: 'creator', atLeast: 1 },
      { group: 'Lifeguards', atLeast: 2 },
      { group: 'members', majority: true, minimum: 10 },
    ],
  });
  assert.equal(rules.describeRules(v), "the creator's yes, 2 yeses from Lifeguards, or a vote of All members");
  // A preset keeps its name.
  assert.equal(rules.describeRules(rules.parseRulesBlock({ preset: 'two_yeses' })), 'Two yeses');
  assert.equal(rules.describeRules(null), 'the default time-&-majority vote');
});

test('a list too long for a title names its first two rules and how many more', () => {
  const group = { name: 'Lifeguards of the North Shore', people: ['evan', 'maya'] };
  const v = rules.parseRulesBlock({
    groups: [group],
    rules: [
      { group: group.name, atLeast: 1 },
      { group: group.name, atLeast: 2 },
      { group: group.name, atLeast: 3 },
      { group: group.name, atLeast: 4 },
    ],
  });
  assert.equal(rules.describeRules(v), '1 yes from Lifeguards of the North Shore, 2 yeses from Lifeguards of the North Shore, or 2 more rules');
});

test('describeRulesInFull expands a preset and lists every named group', () => {
  const preset = rules.describeRulesInFull(rules.parseRulesBlock({ preset: 'you_or_the_group' }));
  assert.deepEqual(preset.sentences, [
    'The creator says yes.',
    'Most active people in All members say yes, over time.',
  ]);
  assert.deepEqual(preset.groups, []);
  const own = rules.describeRulesInFull(rules.parseRulesBlock({
    groups: [{ name: 'Lifeguards', people: ['evan'] }, { name: 'Crew', people: [] }],
    rules: [{ group: 'Lifeguards', atLeast: 2 }],
  }));
  assert.deepEqual(own.sentences, ['At least 2 people in Lifeguards say yes.']);
  assert.deepEqual(own.groups.map((g) => g.name), ['Lifeguards', 'Crew']);
});

test('diffRules says what was added, removed, and who joined a group', () => {
  const was = {
    preset: null,
    groups: [{ name: 'Lifeguards', key: 'lifeguards', people: ['evan'], ids: [] }],
    rules: [
      { group: 'creator', kind: 'atLeast', n: 1 },
      { group: 'lifeguards', kind: 'percentOfEveryone', n: 60 },
    ],
  };
  const now = rules.parseRulesBlock({
    groups: [{ name: 'Lifeguards', people: ['evan', 'maya'] }, { name: 'Crew', people: ['ana'] }],
    rules: [
      { group: 'creator', atLeast: 1 },
      { group: 'Lifeguards', atLeast: 2 },
      { group: 'members', majority: true, minimum: 10 },
    ],
  });
  const diff = rules.diffRules(was, now);
  assert.deepEqual(diff.added.map((r) => rules.ruleShort(r, now.groups)), ['2 yeses from Lifeguards', 'a vote of All members']);
  assert.deepEqual(diff.removed.map((r) => rules.ruleShort(r, was.groups)), ['60% of Lifeguards']);
  assert.deepEqual(diff.groupsAdded.map((g) => g.name), ['Crew']);
  assert.deepEqual(diff.groupsRemoved, []);
  assert.deepEqual(diff.peopleChanged, [{ name: 'Lifeguards', added: ['maya'], removed: [] }]);
  // People compare case-insensitively, and a group that goes is removed.
  const samePeople = rules.diffRules(
    { preset: null, groups: [{ name: 'Lifeguards', people: ['Evan'] }], rules: [{ group: 'lifeguards', kind: 'atLeast', n: 1 }] },
    rules.parseRulesBlock({ groups: [{ name: 'Lifeguards', people: ['evan'] }], rules: [{ group: 'Lifeguards', atLeast: 1 }] }),
  );
  assert.deepEqual(samePeople.peopleChanged, []);
  const gone = rules.diffRules(was, rules.parseRulesBlock({ rules: [{ group: 'creator', atLeast: 1 }] }));
  assert.deepEqual(gone.groupsRemoved.map((g) => g.name), ['Lifeguards']);
  // No today to compare with.
  assert.equal(rules.diffRules(null, now), null);
});

test('a preset on either side is expanded before the rules are compared', () => {
  const diff = rules.diffRules(
    { preset: 'two_yeses', groups: [], rules: [{ group: 'members', kind: 'atLeast', n: 2 }] },
    rules.parseRulesBlock({ preset: 'you_or_the_group' }),
  );
  assert.deepEqual(diff.added.map((r) => `${r.group}:${r.kind}`), ['creator:atLeast', 'members:majority']);
  assert.deepEqual(diff.removed.map((r) => `${r.group}:${r.kind}`), ['members:atLeast']);
});
