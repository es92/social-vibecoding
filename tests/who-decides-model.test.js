'use strict';

// #4666, WHO SAYS YES, on screen: the presets and rules as the sheet, the
// Make it step and the Workshop's rule line say them
// (frontend/src/features/who-decides/model.ts, make-rule.tsx,
// dev-board/workshop/community-card.tsx presetSentence), held to the server's
// own table (src/services/governance-rules.js).
//
// Run with: node --test tests/who-decides-model.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const serverRules = require('../src/services/governance-rules');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MODEL = 'frontend/src/features/who-decides/model.ts';
const CARD = 'frontend/src/features/dev-board/workshop/community-card.tsx';

test('the screens and the server agree on every preset, rule for rule', () => {
  const model = loadTsx(MODEL);
  assert.deepEqual([...model.PRESET_KEYS], [...serverRules.PRESET_KEYS]);
  assert.equal(model.DEFAULT_PRESET, serverRules.DEFAULT_PRESET);
  for (const key of serverRules.PRESET_KEYS) {
    assert.deepEqual(model.PRESETS[key].map((r) => ({ ...r })), serverRules.PRESETS[key].map((r) => ({ ...r })), key);
  }
  assert.equal(model.MAX_RULES, serverRules.MAX_RULES);
  assert.equal(model.MAX_GROUPS, serverRules.MAX_GROUPS);
});

test('what the sheet sends is what the server reads back', () => {
  const model = loadTsx(MODEL);
  const values = [
    model.presetValue('two_yeses'),
    { preset: null, groups: [], rules: [{ group: 'members', kind: 'atLeast', n: 1 }] },
    {
      preset: null,
      groups: [{ name: 'Lifeguards', people: ['evan', 'maya'] }],
      rules: [{ group: 'lifeguards', kind: 'atLeast', n: 2 }, { group: 'creator', kind: 'atLeast', n: 1 }],
    },
    { preset: null, groups: [], rules: [{ group: 'members', kind: 'percentOfEveryone', n: 60 }] },
  ];
  for (const value of values) {
    const block = model.blockFor(value);
    assert.deepEqual(block, serverRules.blockFor(value), JSON.stringify(value));
    const back = serverRules.parseRulesBlock(block);
    assert.deepEqual(back.rules, value.rules.map((r) => ({ ...r })));
  }
  assert.deepEqual(model.blockFor({ preset: null, groups: [], rules: [{ group: 'members', kind: 'atLeast', n: 1 }] }), { preset: 'open_floor' });
});

test('the rule a project has, as the sheet starts from it', () => {
  const model = loadTsx(MODEL);
  // The old default rule is Group vote; an old setting no preset is, is its own.
  assert.equal(model.presetOf(model.currentValue({ policy: 'anyone', approvals_required: null, electorate: 3, required: 2 })), 'group_vote');
  assert.equal(model.currentValue({ policy: 'invited', approvals_required: 1, electorate: 1, required: 1 }), null);
  const own = model.currentValue({
    policy: 'anyone', approvals_required: null, electorate: 3, required: 2, mode: 'rules', preset: null,
    rules: [{ group: 'lifeguards', kind: 'atLeast', n: 2, size: 2, need: 2 }],
    groups: [{ name: 'Lifeguards', key: 'lifeguards', people: ['evan', 'maya'] }],
  });
  assert.equal(model.presetOf(own), null);
  assert.deepEqual(own.rules, [{ group: 'lifeguards', kind: 'atLeast', n: 2 }]);
  assert.equal(model.presetOf(model.currentValue({
    policy: 'anyone', approvals_required: null, electorate: 3, required: 2, mode: 'rules', preset: 'you_or_the_group',
    rules: serverRules.PRESETS.you_or_the_group.map((r) => ({ ...r })), groups: [],
  })), 'you_or_the_group');
});

test('a preset is said from the reader’s side', () => {
  const model = loadTsx(MODEL);
  const creator = { isCreator: true, creator: 'evan', other: 'maya' };
  const member = { isCreator: false, creator: 'evan', other: 'snait' };
  assert.equal(model.presetName('you_or_the_group', creator), 'You or the group');
  assert.equal(model.presetName('you_or_the_group', member), 'evan or the group');
  assert.equal(model.presetName('two_yeses', member), 'Two yeses');
  assert.equal(model.playsOut('you_or_the_group', creator).you, 'Your yes is enough. Live once its checks pass.');
  assert.equal(model.playsOut('you_or_the_group', creator).other, 'Live when you say yes, or when most of the group does.');
  assert.equal(model.playsOut('you_or_the_group', member).other, 'Live when evan says yes, or when most of the group does.');
  assert.equal(model.playsOut('two_yeses', creator).other, 'Live once one more person says yes. That can be you.');
  assert.equal(model.playsOut(null, creator).you, 'Live when any one of its rules passes.');
});

test('each rule in words, and what it asks for today', () => {
  const model = loadTsx(MODEL);
  const ctx = { groups: [{ name: 'Lifeguards', people: ['evan', 'maya'] }], creator: 'evan', memberCount: 4, adminCount: 0 };
  assert.equal(model.rulePhrase({ group: 'creator', kind: 'atLeast', n: 1 }, ctx), 'evan (creator) says yes');
  assert.equal(model.rulePhrase({ group: 'lifeguards', kind: 'atLeast', n: 2 }, ctx), 'At least 2 people in Lifeguards say yes');
  assert.equal(model.rulePhrase({ group: 'lifeguards', kind: 'atLeast', n: 1 }, ctx), 'At least 1 person in Lifeguards says yes');
  assert.equal(model.rulePhrase({ group: 'members', kind: 'percentOfEveryone', n: 60 }, ctx), '60% of everyone in All members says yes');
  assert.equal(model.rulePhrase({ group: 'members', kind: 'majority', n: null }, ctx), 'Most active people in All members say yes, over time');
  // Never more than the group has.
  assert.equal(model.ruleToday({ group: 'lifeguards', kind: 'atLeast', n: 5 }, ctx), 'Needs 2 yeses today. Never more than the group has.');
  assert.equal(model.ruleToday({ group: 'members', kind: 'percentOfEveryone', n: 60 }, ctx), 'Needs 3 of 4 today, active or not.');
  assert.equal(model.ruleToday({ group: 'admins', kind: 'atLeast', n: 1 }, ctx), 'Can’t pass until App admins has someone in it.');
  assert.equal(model.ruleToday({ group: 'creator', kind: 'atLeast', n: 1 }, ctx), 'evan’s yes alone is enough.');
});

test('the sheet refuses what the server would, in words', () => {
  const model = loadTsx(MODEL);
  assert.match(model.valueProblem({ preset: null, groups: [], rules: [] }), /at least one rule/);
  assert.match(model.valueProblem({ preset: null, groups: [], rules: [{ group: 'gone', kind: 'atLeast', n: 1 }] }), /group that is gone/);
  assert.match(model.valueProblem({
    preset: null, groups: [], rules: [{ group: 'members', kind: 'atLeast', n: 1 }, { group: 'members', kind: 'atLeast', n: 1 }],
  }), /already on the list/);
  assert.equal(model.valueProblem(model.presetValue('you_or_the_group')), null);
  assert.match(model.groupNameProblem('Members', [], null), /built-in group/);
  assert.match(model.groupNameProblem('lifeguards', [{ name: 'Lifeguards', people: [] }], null), /already has that name/);
  assert.equal(model.groupNameProblem('Lifeguards', [{ name: 'Lifeguards', people: [] }], 'lifeguards'), null);
  assert.match(model.groupNameProblem('  ', [], null), /Give the group a name/);
});

test('the Workshop’s rule line says You or the group from the reader’s side', () => {
  const { presetSentence, approvalLine } = loadTsx(CARD);
  const { t } = require('./lib/platform-i18n').englishPlatformI18n();
  const approval = {
    policy: 'anyone', approvals_required: null, electorate: 2, required: 2, mode: 'rules', preset: 'you_or_the_group',
    rules: [], groups: [], creator: { id: 1, username: 'evan' },
  };
  const group = { audience: 'invited', is_member: true };
  const mine = presetSentence(approval, { ...group, is_creator: true });
  assert.equal(t(mine.short, mine.values), 'Goes live when its checks pass and you say yes, or both active members do.');
  const theirs = presetSentence(approval, { ...group, is_creator: false });
  assert.deepEqual(theirs.names, ['evan']);
  assert.equal(t(theirs.long, theirs.values).replace(/<\/?\d+>/g, ''),
    'A change goes live when its checks pass and evan says yes, or both active members do.');
  assert.equal(approvalLine(approval, { ...group, is_creator: false }),
    'A change goes live when its checks pass and evan says yes, or both active members do.');
  // More active members: the group's half counts them.
  const five = presetSentence({ ...approval, electorate: 5, required: 3 }, { ...group, is_creator: true });
  assert.equal(t(five.long, five.values), 'A change goes live when its checks pass and you say yes, or 3 of the 5 active members do.');
  // Alone, every preset is the same: your yes.
  const solo = presetSentence({ ...approval, electorate: 1, required: 1 }, { audience: 'solo', is_member: true, is_creator: true });
  assert.equal(t(solo.long, solo.values), 'A change goes live when its checks pass and you approve it.');
  // The other presets, and rules of a project's own.
  assert.equal(t(presetSentence({ ...approval, preset: 'two_yeses' }, group).long),
    'A change goes live when its checks pass and two people say yes: whoever makes it, and one more.');
  assert.equal(t(presetSentence({ ...approval, preset: 'open_floor' }, group).short),
    'Goes live when its checks pass and any member says yes.');
  assert.equal(t(presetSentence({ ...approval, preset: null }, group).long),
    'A change goes live when its checks pass and any one of its rules passes.');
  // Group vote, and a project on the old two settings, keep the members' words.
  assert.equal(presetSentence({ ...approval, preset: 'group_vote' }, group), null);
  assert.equal(presetSentence({ policy: 'anyone', approvals_required: null, electorate: 3, required: 2 }, group), null);
});

test('Make it says who can change the project, once, under the two answers', () => {
  const { MakeRuleLine } = loadTsx('frontend/src/features/who-decides/make-rule.tsx');
  const draw = (preset) => renderToHtml(createElement(MakeRuleLine, { preset, onPick() {}, who: 'evan' }));
  const html = draw('you_or_the_group');
  assert.match(html, /data-make-rule="you_or_the_group"/);
  assert.match(html, /Who can change it: <b[^>]*>You or the group<\/b>/);
  assert.match(html, /data-make-rule-change=""[^>]*>Change<\/button>/);
  assert.match(draw('two_yeses'), /Who can change it: <b[^>]*>Two yeses<\/b>/);

  const make = read('frontend/src/features/first-session/make.tsx');
  const name = make.indexOf("{missing === 'name' ? <p id=\"first-session-name-hint\"");
  const line = make.indexOf('<MakeRuleLine preset={rule} onPick={setRule} who={who} />');
  const submit = make.indexOf('type="submit"');
  assert.ok(name > 0 && name < line && line < submit, 'under the name, above Make it');
  // The default goes unsaid (the server's own default); another pick is the
  // new project's governance block, with nothing proposed.
  assert.match(make, /\.\.\.\(rule !== DEFAULT_PRESET \? \{ governance: \{ preset: rule \} \} : \{\}\)/);

  // Said once: the invite sheet after it says nothing about the rule.
  const made = read('frontend/src/features/first-session/made.tsx');
  assert.doesNotMatch(made, /who-decides|RuleLine/);
});

test('the sheet prerenders as an empty, hidden root', () => {
  const { WhoDecidesDialog } = loadTsx('frontend/src/features/dialogs/who-decides.tsx');
  const html = renderToHtml(createElement(WhoDecidesDialog));
  assert.match(html, /^<div id="who-decides-modal" class="hidden /);
  assert.doesNotMatch(html, /data-who-screen/, 'nothing inside until it is opened');
});

test('every way in opens the one sheet', () => {
  const card = read(CARD);
  assert.match(card, /data-ws-rules-edit=""[\s\S]{0,200}onClick=\{\(\) => window\.UsernodeReact\?\.dialogs\?\.whoDecides\?\.open\(\{ slug \}\)\}/);
  assert.match(read('frontend/src/features/dialogs/members.tsx'), /data-members-who-decides=""[\s\S]{0,400}whoDecides\?\.open\(\{ slug \}\)/);
  assert.match(read('frontend/src/features/dialogs/app-settings.tsx'), /id="app-access-open"[\s\S]{0,300}whoDecides\?\.open\(\{ slug: target \}\)/);
  assert.match(read('frontend/src/features/dev-board/workshop/workshop.tsx'), /onWhoDecides=\{community\?\.can_manage/);
  // The platform's own project keeps its approvals in Members; every other
  // project's Members points at the sheet.
  const controller = read('frontend/src/features/dialogs/members-controller.js');
  assert.match(controller, /const ownRule = !!appData\.can_manage && !appData\.self_hosted;/);
  assert.match(controller, /const showGov = !!appData\.can_manage && !!appData\.self_hosted;/);
});
