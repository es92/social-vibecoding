// 13 Oct 2026, newcomer test run four (Club Votes): the first version was
// ready to try at 22:54, needed its maker's own yes, and the App tab said
// "Waiting for your approval." with no way to give it. It waited all night.
// The product owner's two decisions, as the merge gate reads them:
//
//   D1  a project's FIRST version goes live without a vote once it passes
//       its review and its checks, for every audience
//       (src/workflow/rules/governance-gate.ts applyFirstVersion, read by
//       services/governance.js governedGate and every serializer through
//       services/first-version-rule.js);
//   D2  every LATER change Homeroom bot makes needs a person's yes: the
//       bot proposing it is nobody's yes, on every rule. Since 11 Nov 2026
//       nobody's proposing is (src/workflow/rules/governance-rules.ts,
//       "PROPOSING IS NOT A YES"), so a person's change asks the same tap.
//
// tests/governance-rules-postgres.test.js runs both against the real schema.
//
// Run with: node --test tests/first-version-gate.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/services/governance-rules');
const governance = require('../src/services/governance');
const firstVersionRule = require('../src/services/first-version-rule');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 9);
const OPENED = new Date(NOW - 60 * 1000).toISOString();

// ada (1) made it; sam (2) and kim (3) are members; the bot is 99.
const ADA = 1;
const SAM = 2;
const KIM = 3;
const BOT = 99;

function facts(over = {}) {
  return {
    creatorId: ADA, memberCount: 3, membersActive: 3, adminIds: [], groups: new Map(), activeIds: null, ...over,
  };
}

const COLUMNS = { approverPolicy: 'anyone', approvalsRequired: null, rules: null };
const preset = (key) => ({ approverPolicy: 'anyone', approvalsRequired: null, rules: rules.parseRulesBlock({ preset: key }) });

function gate(gov, {
  yes = [], no = [], author = BOT, f = facts(), firstVersion, explicitApproval = false, reason,
  openedAt = OPENED,
} = {}) {
  return governance.computeGate(gov, f.membersActive, yes.length, no.length, openedAt, NOW, {
    voters: { yes: new Set(yes), no: new Set(no) },
    rulesFacts: f,
    authorId: author,
    memberCount: f.memberCount,
    explicitApproval,
    ...(reason !== undefined ? { explicitReason: reason } : {}),
    ...(firstVersion !== undefined ? { firstVersion } : {}),
  });
}

// ── D1: the first version goes live without a vote ───────────────────

test('D1: a first version is approved with no votes, in every regime the gate knows', () => {
  const regimes = {
    'group vote (the columns)': COLUMNS,
    'at least 2': { approverPolicy: 'anyone', approvalsRequired: 2, rules: null },
    'invited approvers': { approverPolicy: 'invited', approvalsRequired: null, rules: null },
    you_or_the_group: preset('you_or_the_group'),
    two_yeses: preset('two_yeses'),
    open_floor: preset('open_floor'),
    group_vote: preset('group_vote'),
  };
  for (const [name, gov] of Object.entries(regimes)) {
    const before = gov.rules
      ? gate(gov, {})
      : governance.computeGate(gov, 3, 0, 0, OPENED, NOW, {});
    assert.equal(before.mergeable, false, `${name}: a change nobody said yes to waits`);
    const g = gov.rules
      ? gate(gov, { firstVersion: true })
      : governance.computeGate(gov, 3, 0, 0, OPENED, NOW, { firstVersion: true });
    assert.equal(g.mergeable, true, `${name}: the first version needs no vote`);
    assert.equal(g.firstVersion, true, name);
    assert.equal(g.required, 0, `${name}: no yes is missing`);
    assert.equal(g.thresholdMet, true, name);
    assert.equal(g.windowEndsAt, null, `${name}: no clock`);
    assert.equal(g.lazyArmed, false, name);
    assert.equal(g.rejectionArmed, false, `${name}: nothing takes it down`);
    assert.equal(g.rejectable, false, name);
  }
});

test('D1: votes against a first version do not hold it or take it down', () => {
  const g = governance.computeGate(COLUMNS, 3, 0, 3, new Date(NOW - 30 * DAY).toISOString(), NOW, { firstVersion: true });
  assert.equal(g.mergeable, true);
  assert.equal(g.contested, false);
  assert.equal(g.rejectable, false);
  // The counts are still what they are, for whoever reads them.
  assert.equal(g.qualifiedNo, 3);
});

test('D1: a first version that changes protected settings still goes by that rule', () => {
  // Explicit approval (who decides, its keys) is a gate of its own, not the vote.
  const g = gate(preset('you_or_the_group'), { firstVersion: true, explicitApproval: true, reason: 'visibility' });
  assert.equal(g.mergeable, false);
  assert.equal('firstVersion' in g, false);
  assert.equal(gate(preset('you_or_the_group'), {
    firstVersion: true, explicitApproval: true, reason: 'visibility', yes: [ADA],
  }).mergeable, true, 'the creator\'s yes, as for any change to who decides');
  const columns = governance.computeGate(COLUMNS, 3, 0, 0, OPENED, NOW, { firstVersion: true, explicitApproval: true, memberCount: 3, otherYes: 0 });
  assert.equal(columns.mergeable, false);
});

test('D1: any other change is the gate it always was, with no firstVersion on it', () => {
  const g = governance.computeGate(COLUMNS, 3, 1, 0, OPENED, NOW, {});
  assert.equal('firstVersion' in g, false);
  assert.deepEqual(governance.computeGate(COLUMNS, 3, 1, 0, OPENED, NOW, { firstVersion: false }), g);
});

test('D1: applyFirstVersion is the gate\'s, exported by governance.js for the readers', () => {
  const base = governance.computeGate(COLUMNS, 3, 0, 0, OPENED, NOW, {});
  const waived = governance.applyFirstVersion(base);
  assert.equal(waived.mergeable, true);
  assert.equal(waived.firstVersion, true);
  assert.equal(governance.applyFirstVersion(base, { explicitApproval: true }), base);
});

// ── D2: Homeroom bot's later changes need a person's yes ─────────────

test('D2: Open floor, the bot proposing is nobody\'s yes; one member\'s yes lets it in', () => {
  const g = gate(preset('open_floor'), {});
  assert.equal(g.mergeable, false, 'it used to go live on the bot\'s own say-so');
  assert.equal(g.qualifiedYes, 0);
  assert.equal(g.rules[0].yes, 0);
  for (const who of [ADA, SAM, KIM]) {
    assert.equal(gate(preset('open_floor'), { yes: [who] }).mergeable, true, `@${who}'s yes`);
  }
  // Nor is a person's own change, until they tap it (11 Nov 2026).
  assert.equal(gate(preset('open_floor'), { author: SAM }).mergeable, false);
  assert.equal(gate(preset('open_floor'), { author: SAM, yes: [SAM] }).mergeable, true);
});

test('D2: Two yeses from the bot means two yeses from people', () => {
  assert.equal(gate(preset('two_yeses'), { yes: [SAM] }).mergeable, false, 'the bot is not one of the two');
  const g = gate(preset('two_yeses'), { yes: [SAM, KIM] });
  assert.equal(g.mergeable, true);
  assert.equal(g.qualifiedYes, 2);
  // A person's change: two taps as well, theirs among them if they want.
  assert.equal(gate(preset('two_yeses'), { author: SAM, yes: [KIM] }).mergeable, false);
  assert.equal(gate(preset('two_yeses'), { author: SAM, yes: [SAM, KIM] }).mergeable, true);
});

test('D2: You or the group, the creator\'s yes or the group\'s, never the bot\'s', () => {
  const g = gate(preset('you_or_the_group'), {});
  assert.equal(g.mergeable, false);
  assert.equal(g.creatorYes, false);
  const yes = gate(preset('you_or_the_group'), { yes: [ADA] });
  assert.equal(yes.mergeable, true);
  assert.equal(yes.creatorYes, true);
  assert.equal(yes.passedBy.group, 'creator');
});

test('D2: a bot that is somehow the creator, an admin or in a group still says no yes', () => {
  const f = facts({ creatorId: BOT, adminIds: [BOT], groups: new Map([['crew', [BOT, SAM]]]) });
  const own = {
    preset: null,
    groups: [{ name: 'Crew', key: 'crew', people: [], ids: [BOT, SAM] }],
    rules: [
      { group: 'creator', kind: 'atLeast', n: 1 },
      { group: 'admins', kind: 'atLeast', n: 1 },
      { group: 'crew', kind: 'atLeast', n: 1 },
      { group: 'members', kind: 'percentOfEveryone', n: 30 },
    ],
  };
  const g = gate({ approverPolicy: 'anyone', approvalsRequired: null, rules: own }, { f });
  assert.equal(g.mergeable, false);
  assert.equal(g.creatorYes, false);
  assert.ok(g.rules.every((r) => r.yes === 0));
  assert.equal(gate({ approverPolicy: 'anyone', approvalsRequired: null, rules: own }, { f, yes: [SAM] }).mergeable, true);
});

test('D2: Group vote and the columns count votes as cast, so the bot changes nothing there', () => {
  const bot = gate(preset('group_vote'), { openedAt: new Date(NOW - 30 * DAY).toISOString() });
  assert.equal(bot.mergeable, false);
  assert.equal(bot.lazyArmed, false, 'no yes, so no quiet wait either');
  const person = gate(preset('group_vote'), { author: SAM, openedAt: new Date(NOW - 30 * DAY).toISOString() });
  assert.equal(person.mergeable, false, 'a person\'s change needs a vote there too');
});

test('D2: only the first version skips it', () => {
  assert.equal(gate(preset('open_floor'), { firstVersion: true }).mergeable, true);
  assert.equal(gate(preset('open_floor'), { firstVersion: false }).mergeable, false);
});

// ── The reads behind the rule ────────────────────────────────────────

test('nothing reads whether the author is the bot: nobody\'s proposing is a yes', () => {
  const ctx = { facts: facts(), voters: new Map() };
  assert.equal('authorIsBot' in governance.rulesGateOpts(ctx, 7, BOT, null), false);
  assert.equal(typeof governance.botAuthoredBatch, 'undefined');
  assert.equal(typeof governance.authorIsBot, 'undefined');
});

test('firstVersionSql: the run that built it, its request the description\'s, nothing for it live yet', () => {
  const sql = firstVersionRule.firstVersionSql('cs');
  assert.match(sql, /FROM homeroom_bot_first_versions fvf\s+JOIN homeroom_bot_runs fvr\s+ON fvr\.app_id = fvf\.app_id AND fvr\.issue_number = fvf\.issue_number\s+WHERE fvf\.app_id = cs\.app_id/);
  assert.match(sql, /\(fvr\.proposal_session_id = cs\.id OR fvr\.build_session_id = cs\.id\)/,
    'its build session from the promote on, its proposal once recorded');
  assert.match(sql, /fvs\.status = 'merged' AND fvs\.id <> cs\.id/, 'a change for the request already live ends it');
  assert.match(firstVersionRule.firstVersionSql('x'), /fvf\.app_id = x\.app_id/);
  assert.throws(() => firstVersionRule.firstVersionSql('cs; DROP TABLE apps'), /Invalid SQL alias/);
  // One definition: governance.js hands out the same function.
  assert.equal(governance.firstVersionSql, firstVersionRule.firstVersionSql);
});

test('isFirstVersion: one read, and a failed one sends the change to the vote', async () => {
  const seen = [];
  const yes = { async query(sql, params) { seen.push({ sql, params }); return { rows: [{ first_version: true }] }; } };
  assert.equal(await firstVersionRule.isFirstVersion(yes, 41), true);
  assert.match(seen[0].sql, /AS first_version FROM chat_sessions cs WHERE cs\.id = \$1/);
  assert.deepEqual(seen[0].params, [41]);
  assert.equal(await firstVersionRule.isFirstVersion({ async query() { return { rows: [{ first_version: false }] }; } }, 41), false);
  assert.equal(await firstVersionRule.isFirstVersion({ async query() { return {}; } }, 41), false);
  assert.equal(await firstVersionRule.isFirstVersion({ async query() { throw new Error('down'); } }, 41), false);
  assert.equal(await firstVersionRule.isFirstVersion(yes, 'x'), false);
  assert.equal(seen.length, 1, 'no id, no read');
});

// governedGate, the path checkAndMerge and the ready card take: it reads
// whether the change is a first version and, on a rules project, who voted
// and who its author is (for the member floor). It never asks whether the
// author is a person or used a coding agent: proposing is nobody's yes
// (tests/agent-submission-yes.test.js).
function scripted({ rulesRow, votes = [], author = BOT, first = false } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push(sql);
      if (/SELECT approver_policy, approvals_required FROM apps/.test(sql)) return { rows: [{ approver_policy: 'anyone', approvals_required: null }] };
      if (/SELECT governance_rules FROM apps/.test(sql)) return { rows: [{ governance_rules: rulesRow }] };
      if (/FROM apps a WHERE a.id = \$1/.test(sql) && /member_count/.test(sql)) {
        return { rows: [{ created_by: ADA, self_hosted: false, collab_visibility: 'private', member_count: 3, admin_ids: [] }] };
      }
      if (/AS first_version FROM chat_sessions cs/.test(sql)) return { rows: [{ first_version: first }] };
      if (/FROM pr_votes/.test(sql) && /SELECT user_id, vote/.test(sql)) return { rows: votes };
      if (/SELECT user_id AS author_id FROM chat_sessions/.test(sql)) return { rows: [{ author_id: author }] };
      if (/COUNT\(DISTINCT a.user_id\)/.test(sql)) return { rows: [{ cnt: 3, invited_floor: 2 }] };
      if (/SELECT self_hosted, collab_visibility FROM apps/.test(sql)) return { rows: [{ self_hosted: false, collab_visibility: 'private' }] };
      if (/SELECT COUNT\(\*\) as cnt FROM pr_votes/.test(sql)) return { rows: [{ cnt: 0 }] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

const OPEN_FLOOR_ROW = { preset: 'open_floor', groups: [], rules: [{ group: 'members', kind: 'atLeast', n: 1 }] };

test('governedGate: on Open floor every change waits for a person\'s tap, the bot\'s or a person\'s', async () => {
  governance.invalidateGovernance(951);
  const bot = scripted({ rulesRow: OPEN_FLOOR_ROW });
  const g = await governance.governedGate(bot, 951, { kind: 'pr', id: 70, openedAt: OPENED, now: NOW });
  assert.equal(g.mode, 'rules');
  assert.equal(g.mergeable, false);
  assert.ok(!bot.seen.some((sql) => /is_synthetic|external_agent/.test(sql)), 'it asks nothing about who proposed it');

  governance.invalidateGovernance(952);
  const voted = scripted({ rulesRow: OPEN_FLOOR_ROW, votes: [{ user_id: SAM, vote: 'yes' }] });
  assert.equal((await governance.governedGate(voted, 952, { kind: 'pr', id: 71, openedAt: OPENED, now: NOW })).mergeable, true);

  governance.invalidateGovernance(953);
  const person = scripted({ rulesRow: OPEN_FLOOR_ROW, author: SAM });
  assert.equal((await governance.governedGate(person, 953, { kind: 'pr', id: 72, openedAt: OPENED, now: NOW })).mergeable, false);

  governance.invalidateGovernance(958);
  const tapped = scripted({ rulesRow: OPEN_FLOOR_ROW, author: SAM, votes: [{ user_id: SAM, vote: 'yes' }] });
  assert.equal((await governance.governedGate(tapped, 958, { kind: 'pr', id: 75, openedAt: OPENED, now: NOW })).mergeable, true);
});

test('governedGate: a first version goes live with no votes, read off the change unless the caller says', async () => {
  governance.invalidateGovernance(954);
  const pool = scripted({ rulesRow: OPEN_FLOOR_ROW, first: true });
  const g = await governance.governedGate(pool, 954, { kind: 'pr', id: 73, openedAt: OPENED, now: NOW });
  assert.equal(g.mergeable, true);
  assert.equal(g.firstVersion, true);
  assert.ok(pool.seen.some((sql) => /AS first_version FROM chat_sessions/.test(sql)));

  governance.invalidateGovernance(955);
  const told = scripted({ rulesRow: OPEN_FLOOR_ROW, first: true });
  const no = await governance.governedGate(told, 955, { kind: 'pr', id: 74, openedAt: OPENED, now: NOW, firstVersion: false });
  assert.equal(no.mergeable, false);
  assert.ok(!told.seen.some((sql) => /AS first_version/.test(sql)), 'a caller that knows is not read for');

  // The columns' gate too: no project is left out.
  governance.invalidateGovernance(956);
  const columns = scripted({ rulesRow: null, first: true });
  const c = await governance.governedGate(columns, 956, { kind: 'pr', id: 75, openedAt: OPENED, now: NOW });
  assert.equal(c.mode, 'default');
  assert.equal(c.mergeable, true);
  assert.equal(c.firstVersion, true);

  // An issue is never a first version, and nothing is read to say so.
  governance.invalidateGovernance(957);
  const issue = scripted({ rulesRow: null, first: true });
  issue.query = ((orig) => async (sql, params) => {
    if (/SELECT COUNT\(\*\) as cnt FROM issue_votes/.test(sql)) return { rows: [{ cnt: 0 }] };
    return orig(sql, params);
  })(issue.query.bind(issue));
  const i = await governance.governedGate(issue, 957, { kind: 'issue', id: 9, openedAt: OPENED, now: NOW });
  assert.equal(i.mergeable, false);
  assert.ok(!issue.seen.some((sql) => /AS first_version/.test(sql)));
});
