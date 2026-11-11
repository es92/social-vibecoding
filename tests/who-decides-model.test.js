'use strict';

// #4666, WHO SAYS YES, on screen: the presets and rules as the sheet, the
// Make it step and the Workshop's rule line say them
// (frontend/src/features/who-decides/model.ts, make-rule.tsx, parts.tsx
// PlaysOut, dev-board/workshop/community-card.tsx presetSentence), held to
// the server's own table (src/services/governance-rules.js).
//
// Run with: node --test tests/who-decides-model.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createElement, loadTsx, renderToHtml } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');
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
  const creator = { isCreator: true, creator: 'evan' };
  const member = { isCreator: false, creator: 'evan' };
  assert.equal(model.presetName('you_or_the_group', creator), 'You or the group');
  assert.equal(model.presetName('you_or_the_group', member), 'evan or the group');
  assert.equal(model.presetName('two_yeses', member), 'Two yeses');
  assert.equal(model.playsOut('you_or_the_group', creator).you, 'Your yes is enough. Live once its checks pass.');
  assert.equal(model.playsOut('you_or_the_group', creator).other, 'Live when you say yes, or when most of the group does.');
  assert.equal(model.playsOut('you_or_the_group', member).other, 'Live when evan says yes, or when most of the group does.');
  assert.equal(model.playsOut(null, creator).anyone, 'Live when any one of its rules passes. Their own yes counts toward the rules they’re in.');
});

test('#4894: a rule that treats every change alike says how it plays out once, for anyone', () => {
  const model = loadTsx(MODEL);
  const creator = { isCreator: true, creator: 'evan' };
  const member = { isCreator: false, creator: 'evan' };
  const own = 'Live when any one of its rules passes. Their own yes counts toward the rules they’re in.';
  const anyone = {
    two_yeses: 'Live once two people say yes. Its maker’s yes can be one of them.',
    open_floor: 'Their own yes is enough. Live once its checks pass.',
    group_vote: 'Live when most active members say yes, or after a wait if nobody objects.',
  };
  // A project's own rules (Make your own, or an old setting no preset is:
  // `null`) go live the same way whoever made the change, so they say it
  // once too.
  const once = [...Object.entries(anyone), [null, own]];
  for (const [key, line] of once) {
    assert.deepEqual({ ...model.playsOut(key, creator) }, { anyone: line }, String(key));
    assert.deepEqual({ ...model.playsOut(key, member) }, { anyone: line }, `${key}, read by someone who did not make the project`);
  }
  // You or the group keeps both: the creator's own change and anyone
  // else's really do differ.
  assert.deepEqual(Object.keys(model.playsOut('you_or_the_group', creator)), ['you', 'other']);
  assert.deepEqual(Object.keys(model.playsOut('you_or_the_group', member)), ['you', 'other']);

  // On screen: one row titled "Anyone makes a change" beside the group's
  // tile, or, for You or the group, the reader's row and "Anyone else makes
  // a change" beside the same tile, never a member picked by name.
  const { PlaysOut } = loadTsx('frontend/src/features/who-decides/parts.tsx');
  const draw = (preset, viewer = creator) => renderToHtml(createElement(PlaysOut, { preset, viewer }));
  const svgs = (html) => html.match(/<svg[\s\S]*?<\/svg>/g) || [];
  const faces = (html) => (html.match(/rounded-full text-\[11px\] font-bold/g) || []).length;
  const [groupTile] = svgs(draw('group_vote'));
  assert.ok(groupTile, 'the Anyone makes a change row has a tile');
  for (const [key, line] of once) {
    const html = draw(key);
    assert.equal(html.match(/makes? a change</g)?.length, 1, `${key}: one row`);
    assert.match(html, />Anyone makes a change</, String(key));
    assert.ok(html.includes(`>${line}<`), String(key));
    assert.deepEqual(svgs(html), [groupTile], `${key}: the group's tile`);
    assert.equal(faces(html), 0, `${key}: no face`);
  }
  for (const viewer of [creator, member]) {
    const two = draw('you_or_the_group', viewer);
    const lines = model.playsOut('you_or_the_group', viewer);
    const you = two.indexOf('>You make a change<');
    const others = two.indexOf('>Anyone else makes a change<');
    assert.ok(you >= 0 && others > you, 'the reader’s row, then anyone else’s');
    assert.ok(two.indexOf(`>${lines.you}<`) > you && two.indexOf(`>${lines.you}<`) < others);
    assert.ok(two.lastIndexOf(`>${lines.other}<`) > others);
    assert.deepEqual(svgs(two), [groupTile], 'anyone else is the group’s tile');
    assert.ok(two.indexOf(groupTile) > you && two.indexOf(groupTile) < others);
    assert.equal(faces(two), 1, 'one face, the reader’s');
    assert.doesNotMatch(two, /Anyone makes a change|evan makes a change/);
  }
  assert.match(draw('you_or_the_group', creator), />Anyone else makes a change<[\s\S]*>Live when you say yes, or when most of the group does\.</);
  assert.match(draw('you_or_the_group', member), />Anyone else makes a change<[\s\S]*>Live when evan says yes, or when most of the group does\.</);

  // The retired lines are gone from the English catalog.
  const dialogs = JSON.parse(read('frontend/locales/en/dialogs.json'));
  for (const key of ['two_yeses', 'open_floor', 'group_vote']) {
    assert.equal(dialogs[`whoDecides.plays.${key}.anyone`].text, anyone[key]);
    assert.equal(dialogs[`whoDecides.plays.${key}.you`], undefined, `${key}.you retired`);
    assert.equal(dialogs[`whoDecides.plays.${key}.other`], undefined, `${key}.other retired`);
  }
  assert.equal(dialogs['whoDecides.plays.own.anyone'].text, own);
  assert.equal(dialogs['whoDecides.plays.anyoneTitle'].text, 'Anyone makes a change');
  assert.equal(dialogs['whoDecides.plays.anyoneElseTitle'].text, 'Anyone else makes a change');
  for (const id of ['whoDecides.plays.own.you', 'whoDecides.plays.own.other', 'whoDecides.plays.otherTitle', 'whoDecides.someone']) {
    assert.equal(dialogs[id], undefined, `${id} retired`);
  }
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

test('a minimum on a majority or a share, in words, sent and read back as the server does', () => {
  const model = loadTsx(MODEL);
  assert.equal(model.MIN_MINIMUM, serverRules.MIN_MINIMUM);
  const ctx = { groups: [], creator: 'evan', memberCount: 4, adminCount: 0 };
  const majority = { group: 'members', kind: 'majority', n: null, min: 10 };
  assert.equal(model.rulePhrase(majority, ctx), 'Most active people in All members say yes, over time, and at least 10 of them');
  assert.equal(model.rulePhrase({ group: 'members', kind: 'percentOfEveryone', n: 50, min: 3 }, ctx),
    '50% of everyone in All members says yes, and at least 3 of them');
  // Today: never more than the group has.
  assert.equal(model.ruleToday(majority, ctx), 'Group vote’s math, or a quiet wait if nobody objects, and never fewer than 4 yeses.');
  assert.equal(model.ruleToday({ group: 'members', kind: 'percentOfEveryone', n: 50, min: 3 }, ctx), 'Needs 3 of 4 today, active or not.');
  // An "at least" rule never carries one.
  assert.equal(model.minOf({ group: 'members', kind: 'atLeast', n: 2, min: 5 }), null);
  const value = { preset: null, groups: [], rules: [{ group: 'creator', kind: 'atLeast', n: 1 }, majority] };
  const block = model.blockFor(value);
  assert.deepEqual(block, serverRules.blockFor(value));
  assert.deepEqual(block.rules[1], { group: 'members', majority: true, minimum: 10 });
  assert.deepEqual(serverRules.parseRulesBlock(block).rules, value.rules);
  assert.equal(model.matchPreset(value.rules), null, 'You or the group with a minimum is no longer the preset');
  assert.equal(model.sameValue(value, model.presetValue('you_or_the_group')), false);
  const back = model.currentValue({
    policy: 'anyone', approvals_required: null, electorate: 4, required: 4, mode: 'rules', preset: null,
    rules: [{ group: 'creator', kind: 'atLeast', n: 1, size: 1, need: 1 }, { ...majority, size: 4, need: 4 }], groups: [],
  });
  assert.deepEqual(back.rules, value.rules);
  assert.equal(model.valueProblem({ preset: null, groups: [], rules: [{ group: 'members', kind: 'majority', n: null }, majority] }), null,
    'the same rule with and without a minimum are two rules');
});

test('a creator whose account is gone is said as gone, not as no creator (#6281)', () => {
  const model = loadTsx(MODEL);
  const dialogs = JSON.parse(read('frontend/locales/en/dialogs.json'));
  assert.equal(model.creatorGroupLine('evan', false), 'evan');
  assert.equal(model.creatorGroupLine('evan', true), 'evan', 'a live creator still shows their username');
  assert.equal(model.creatorGroupLine(null, true), message('dialogs:whoDecides.group.creatorGone'));
  assert.equal(model.creatorGroupLine(null, false), message('dialogs:whoDecides.group.creatorNobody'));
  assert.equal(dialogs['whoDecides.group.creatorGone'].text, 'The account that made this project no longer exists');
  assert.notEqual(dialogs['whoDecides.group.creatorGone'].text, dialogs['whoDecides.group.creatorNobody'].text,
    'a deleted account is not the same as a project with no creator by design');
  assert.match(dialogs['whoDecides.group.creatorGone'].description, /deleted their account/);
  assert.match(dialogs['whoDecides.group.creatorNobody'].description, /by design/);
  const sheet = read('frontend/src/features/dialogs/who-decides.tsx');
  assert.match(sheet, /approval\?\.creator_gone === true/);
  assert.match(sheet, /creatorGroupLine\(creator, creatorGone\)/);
});

test('Creator is not offered when adding a rule to a project that has no creator (#6281)', () => {
  const model = loadTsx(MODEL);
  const groups = [{ name: 'Lifeguards', people: ['evan'] }];
  assert.deepEqual(model.ruleGroupChoices(groups, {}), ['creator', 'members', 'admins', 'lifeguards']);
  assert.deepEqual(model.ruleGroupChoices(groups, { creatorGone: false }), ['creator', 'members', 'admins', 'lifeguards']);
  assert.deepEqual(model.ruleGroupChoices(groups, { creatorGone: true }), ['members', 'admins', 'lifeguards'],
    'a rule that only the creator can pass would never pass');
  assert.deepEqual(model.ruleGroupChoices(groups, { creatorGone: true, current: 'creator' }),
    ['creator', 'members', 'admins', 'lifeguards'], 'a saved Creator rule still shows its chip');
  const sheet = read('frontend/src/features/dialogs/who-decides.tsx');
  assert.match(sheet, /ruleGroupChoices\(draft\.groups, \{ creatorGone, current: ruleDraft\.group \}\)/);
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

  // #5266: the ⓘ sits right after the words and before Change, closed on the
  // first render, and its tip covers nothing until someone asks for it.
  assert.match(html, /data-make-rule-info="" aria-expanded="false" aria-controls="make-rule-tip" aria-label="What happens next"/);
  const info = html.indexOf('data-make-rule-info');
  assert.ok(html.indexOf('You or the group') < info && info < html.indexOf('data-make-rule-change'), 'after the words, before Change');
  assert.doesNotMatch(html, /data-make-rule-tip/);
  const rule = read('frontend/src/features/who-decides/make-rule.tsx');
  // Hover only where there is a mouse; a tap or click opens it anywhere.
  assert.match(rule, /function hasHover\(\): boolean \{\s+try \{ return !!window\.matchMedia\?\.\('\(hover: hover\) and \(pointer: fine\)'\)\.matches; \} catch \{ return false; \}/);
  // #5266 review (20 Oct 2026): the ⓘ's own hover opens it, not the whole
  // rule line's — the words are not a question, and the tip covers nothing
  // until someone asks for it. A click-opened tip survives the pointer leaving.
  assert.match(rule, /<span\s+className="inline-flex shrink-0"\s+onMouseEnter=\{\(\) => \{ if \(hasHover\(\)\) \{ hoverOpened\.current = true; setTipOpen\(true\); \}/);
  assert.doesNotMatch(rule, /ref=\{wrapperRef\}[\s\S]{0,60}onMouseEnter/, 'the line itself does not open the tip');
  assert.match(rule, /onMouseLeave=\{\(\) => \{ if \(hasHover\(\) && hoverOpened\.current\)/);
  assert.match(rule, /onClick=\{\(\) => \{ hoverOpened\.current = false; setTipOpen\(\(was\) => !was\); \}\}/);
  assert.match(rule, /if \(e\.key === 'Escape'\) setTipOpen\(false\);/);
  assert.match(rule, /document\.addEventListener\('pointerdown', onDown\);/);
  // Opening the presets sheet closes it, as a press elsewhere does.
  assert.match(rule, /setTipOpen\(false\); setOpen\(true\);/);

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

test('#4960: competing access changes are allowed, with a warning in the summary', () => {
  const sheet = read('frontend/src/features/dialogs/who-decides.tsx');
  // No top note and no separate waiting branch: the warning lives in the
  // propose branch, where the person is looking.
  assert.doesNotMatch(sheet, /data-who-waiting=""/);
  assert.doesNotMatch(sheet, /waiting && changes\.length/);
  assert.doesNotMatch(sheet, /!!waiting/);
  // The propose branch warns when a change is waiting, and Propose stays
  // enabled: greyed only on `busy`.
  const propose = sheet.indexOf('data-who-propose=""');
  const branch = sheet.slice(sheet.lastIndexOf('changes.length ? (', propose), sheet.indexOf('</>', propose));
  for (const needle of [
    "waiting ? t('dialogs:whoDecides.waitingTitle')",
    'dialogs:whoDecides.waitingSub',
    'data-who-waiting-warning=""',
    'changeHref(slug, waiting.session_id)',
    'disabled={busy}',
  ]) {
    assert.ok(branch.includes(needle), `${needle} inside the propose branch`);
  }
  // The words are in the English catalog, as the sheet asks for them.
  const { message } = require('./lib/platform-i18n');
  assert.equal(message('dialogs:whoDecides.waitingTitle'), 'Another change is up for a vote too');
  assert.equal(message('dialogs:whoDecides.waitingSub'),
    'A change to who can see and change it is already up for a vote. If both pass, the later one may overwrite the earlier.');
  // The sheet still reads the open change off the community record.
  const routes = read('src/routes/apps.js');
  assert.match(routes, /who_decides_change/, 'the community read still returns the waiting change');
  // And this route no longer refuses a second one while it is up for a
  // vote. (visibility-pr and the others keep their own in-flight guards,
  // so the refusal is checked inside this route alone.)
  const route = routes.slice(routes.indexOf("'/api/apps/:slug/who-decides-pr'"), routes.indexOf("'/api/apps/:slug/admins'"));
  assert.doesNotMatch(route, /already waiting for approval/);
});

test('every way in opens the one sheet', () => {
  const card = read(CARD);
  assert.match(card, /data-ws-rules-edit=""[\s\S]{0,200}onClick=\{\(\) => window\.UsernodeReact\?\.dialogs\?\.whoDecides\?\.open\(\{ slug \}\)\}/);
  // Both rows hand off through closeThen: opening in the same task as the
  // close let the queued traversal close the sheet (#5801).
  assert.match(read('frontend/src/features/dialogs/members.tsx'), /data-members-who-decides=""[\s\S]{0,600}dialog\.closeThen\(\(\) => window\.UsernodeReact\?\.dialogs\?\.whoDecides\?\.open\(\{ slug \}\)/);
  assert.match(read('frontend/src/features/dialogs/app-settings.tsx'), /id="app-access-open"[\s\S]{0,600}dialog\.closeThen\(\(\) => window\.UsernodeReact\?\.dialogs\?\.whoDecides\?\.open\(\{ slug: target \}\)/);
  assert.match(read('frontend/src/features/dev-board/workshop/workshop.tsx'), /onWhoDecides=\{community\?\.can_manage/);
  // The platform's own project keeps its approvals in Members; every other
  // project's Members points at the sheet.
  const controller = read('frontend/src/features/dialogs/members-controller.js');
  assert.match(controller, /const ownRule = !!appData\.can_manage && !appData\.self_hosted;/);
  assert.match(controller, /const showGov = !!appData\.can_manage && !!appData\.self_hosted;/);
});
