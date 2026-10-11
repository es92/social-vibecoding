'use strict';

// B6: a plan card before first versions; up to two questions on unclear
// changes.
//
// A new project's first version is not built the moment Homeroom bot has
// read its description. Its creator is sent the plan first (3 to 5 plain
// bullets, up to two choices with the suggested answer marked) with Build it
// and Change something, and its run waits (`awaiting_go_at`) until Build it,
// which is decided once, from the chat or the App tab. Change something is a
// reply to the card, kept private and read by the next look. A newer plan,
// a new look at the request and a week with no tap each close the card. A
// request the read has two questions about asks both at once. Build it moves
// the request's activity card under the plan, so the build's progress shows
// where it was tapped.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-plan.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const bot = require('../src/services/homeroom-bot');
const dm = require('../src/services/homeroom-bot-dm');
const live = require('../src/services/homeroom-bot-live');

const fence = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

// ── What the read returns ──

test('B6: a ready read returns a plan of plain bullets and up to two choices, the suggested answer first', () => {
  const parsed = bot.parseVerdict(fence({
    verdict: 'ready', build_note: 'Build the plant list.', assumptions: ['Uses the template'],
    plan: ['- A list of your plants', 'A Today view', '', 42, 'x'.repeat(200), 'Five', 'Six', 'Seven'],
    choices: [
      { question: 'How should it remind you?', answers: ['In the app', 'Phone alert'] },
      { question: 'Who can see your plants?', answers: ['Just me', 'People I invite'] },
      { question: 'A third?', answers: ['a', 'b'] },
      { question: 'One answer only', answers: ['a'] },
    ],
  }));
  assert.equal(parsed.verdict, 'ready');
  assert.equal(parsed.plan.bullets.length, 5, 'at most five');
  assert.equal(parsed.plan.bullets[0], 'A list of your plants', 'a bullet the model marked is not marked twice');
  assert.ok(parsed.plan.bullets[2].length <= 120 && parsed.plan.bullets[2].endsWith('…'));
  assert.deepEqual(parsed.plan.questions.map((q) => q.question), ['How should it remind you?', 'Who can see your plants?']);
  assert.equal(bot.parseVerdict(fence({ verdict: 'ready', build_note: 'x' })).plan, null, 'no plan: none');
});

test('B6: a question read can ask a second blocker with the first, and only a real one', () => {
  const both = bot.parseVerdict(fence({
    verdict: 'question', question: 'What time on Sunday?', default: '9 AM', answers: ['9 AM', '8 AM'],
    blocker: 'user_facing', why_default_fails: 'A wrong time is a wrong reminder.',
    second_question: { question: 'How should it remind you?', answers: ['In the app', 'Phone alert'] },
  }));
  assert.deepEqual(both.plan, {
    bullets: [],
    questions: [
      { question: 'What time on Sunday?', answers: ['9 AM', '8 AM'] },
      { question: 'How should it remind you?', answers: ['In the app', 'Phone alert'] },
    ],
  });
  const one = bot.parseVerdict(fence({
    verdict: 'question', question: 'What time?', default: '9 AM', answers: ['9 AM', '8 AM'],
    blocker: 'user_facing', why_default_fails: 'x', second_question: { question: 'What time?', answers: ['a', 'b'] },
  }));
  assert.equal(one.plan, null, 'the same question twice is one');
});

test('B6: the prompt asks a first version for its plan, and any request for a second question only when it is a blocker', () => {
  const prompt = bot.triagePromptFor({ seed: 'SEED', issueNumber: 1, firstVersion: true });
  assert.match(prompt, /Its creator sees your plan before anything is built, and taps Build it or asks for changes/);
  assert.match(prompt, /give `plan`: 3 to 5 short lines of a few words each, at most 40 characters/, '#4046: a light card');
  assert.match(prompt, /`choices`: at most 2 decisions/);
  assert.ok(!/Its creator sees your plan/.test(bot.triagePromptFor({ seed: 'SEED', issueNumber: 1 })), 'only a first version');
  const md = read('src/prompts/homeroom-bot-triage.md');
  assert.match(md, /ask it in the same turn as `second_question`/);
  assert.match(md, /"plan": \[/);
  assert.match(md, /"choices": \[/);
});

test('B6: the changes a creator asked for are read again with the plan they saw, in their words', () => {
  assert.equal(bot.planChangeNote(null), null);
  const note = bot.planChangeNote({ requester: 'maya', bullets: ['A list'], changes: ['Make it work for my partner too'] });
  assert.match(note, /^==== THE CREATOR'S CHANGES TO YOUR PLAN ====/);
  assert.match(note, /@maya was shown your plan/);
  assert.match(note, /The plan they were shown:\n- A list\n/);
  assert.match(note, /What they asked:\n- "Make it work for my partner too"$/);
  const prompt = bot.triagePromptFor({ seed: 'SEED', issueNumber: 1, firstVersion: true, planChange: { changes: ['x y'] } });
  assert.match(prompt, /What they asked:\n- "x y"/);
});

// 2026-10-04: the sketch a first version is drawn from shows sample people
// and dates, and a plan that could not see the project's real people asked
// "The sketch rotates chores between Maya, Jasper and Sophie. Should you be
// in the rotation too?" of a project of two. The plan is told the sketch's
// samples are placeholders, and who is really in the project.

const PEOPLE = {
  people: [
    { username: 'jordan_t1004', name: 'Jordan', creator: true, invited: false },
    { username: 'sam_t1004', name: null, creator: false, invited: true },
  ],
  more: 0,
  emailInvites: 0,
};

test('a first version\'s plan treats sample names, dates and numbers as placeholders, and the card as a summary', () => {
  const flat = (text) => text.replace(/\s+/g, ' ');
  const first = flat(bot.triagePromptFor({ seed: 'SEED', issueNumber: 1, firstVersion: true }));
  // 5 October 2026: the first session's sketch is a featured card of the
  // idea, not a screen, so it is never a design target (services/app-sketch.js).
  assert.doesNotMatch(first, /design target|design\/sketch\.html|plan the first version as it/);
  assert.match(first, /When the request quotes the featured card its creator was shown \(`design\/sketch\.json`: an emoji, a tagline and a few points\), read it as a short summary of the description, not a design: it shows no screen, so it sets no layout, words or colours, and where the two differ the description wins\./);
  assert.match(first, /Sample names, dates and numbers are placeholders, never facts about the group, and never a `plan` bullet or a `choices` question\./);
  assert.match(first, /When the app involves the people in its group \(whose turn it is, who did what, who sees what\), plan around the project's real members, listed under WHO IS IN THIS PROJECT when known, and around new members joining later; never around people made up for an example\./);
  assert.ok(first.indexOf('Sample names, dates and numbers') > first.indexOf('When the request quotes the featured card'),
    'right after the card rule');
  assert.doesNotMatch(flat(bot.triagePromptFor({ seed: 'SEED', issueNumber: 1 })), /featured card|Sample names/, 'only a first version');
  const note = first.slice(first.indexOf('When the request quotes the featured card'), first.indexOf('never around people made up for an example.'));
  assert.doesNotMatch(note, /—/, 'no em dash');
});

test('a first version\'s plan is told who is in its project: members, invites not yet joined, and invites by email', () => {
  assert.equal(bot.membersNote(null), null);
  assert.equal(bot.membersNote({ people: [] }), null);
  assert.equal(bot.membersNote({ people: [{ name: 'No handle' }] }), null);
  assert.equal(bot.membersNote(PEOPLE), [
    '==== WHO IS IN THIS PROJECT ====',
    '',
    'Its real people right now. Plan anything about who uses it around them, and around more people joining later:',
    '- Jordan (@jordan_t1004), who made the project',
    '- @sam_t1004, invited and not joined yet',
  ].join('\n'));
  const big = bot.membersNote({
    people: [{ username: 'ann', name: 'ANN', creator: true }, { username: 'bo', name: 'Bo\n\nBo' }],
    more: 3, emailInvites: 2,
  });
  assert.match(big, /\n- @ann, who made the project\n- Bo Bo \(@bo\)\n- and 3 more\n- and 2 invited by email, not on Homeroom yet$/,
    'a display name that is the username is said once, and every name is one line');

  // In the prompt: only a first version's, after its rules and before the reference.
  const prompt = bot.triagePromptFor({ seed: 'SEED', issueNumber: 1, firstVersion: true, members: PEOPLE });
  const at = prompt.indexOf('==== WHO IS IN THIS PROJECT ====');
  assert.ok(at > prompt.indexOf('Its creator sees your plan'), 'after the first-version rules');
  assert.ok(at < prompt.indexOf('PLATFORM REFERENCE'), 'before the reference');
  assert.doesNotMatch(bot.triagePromptFor({ seed: 'SEED', issueNumber: 1, members: PEOPLE }), /WHO IS IN THIS PROJECT/, 'only a first version');
  assert.equal(bot.triagePromptFor({ seed: 'SEED', issueNumber: 1, firstVersion: true, members: null }),
    bot.triagePromptFor({ seed: 'SEED', issueNumber: 1, firstVersion: true }), 'unchanged without it, as the benchmark replays');
});

test('a project\'s people are read from its members, then its pending invites, and its invites by email', async () => {
  const calls = [];
  const pool = (rows) => ({ async query(sql, params) { calls.push({ sql, params }); return { rows }; } });
  assert.equal(await bot.projectMembers(pool([]), { id: 5 }), null, 'nobody');
  assert.equal(await bot.projectMembers(pool([]), null), null);
  const out = await bot.projectMembers(pool([
    { username: 'jordan_t1004', display_name: 'Jordan', creator: true, invited: false, total: 14, by_email: 1 },
    { username: 'sam_t1004', display_name: null, creator: false, invited: true, total: 14, by_email: 1 },
  ]), { id: 5 });
  assert.deepEqual(out, {
    people: [
      { username: 'jordan_t1004', name: 'Jordan', creator: true, invited: false },
      { username: 'sam_t1004', name: null, creator: false, invited: true },
    ],
    more: 12,
    emailInvites: 1,
  });
  const { sql, params } = calls.at(-1);
  assert.deepEqual(params, [5, 12], 'at most twelve by name');
  assert.match(sql, /JOIN community_members m ON m\.community_id = a\.community_id/, 'members');
  assert.match(sql, /c\.status = 'invited'/, 'invited, not joined yet');
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM community_members m\s+WHERE m\.community_id = a\.community_id AND m\.user_id = c\.user_id\)/, 'never twice');
  assert.match(sql, /FROM app_email_invites e\s+WHERE e\.app_id = \$1 AND e\.claimed_at IS NULL/, 'invites by email still waiting');
  assert.equal((sql.match(/u\.is_synthetic = FALSE/g) || []).length, 2, 'no bots');
  assert.match(sql, /ORDER BY invited, creator DESC, since, username/, 'members first, the creator first among them');
});

test('the look reads a live first version\'s people into its prompt and its snapshot, and the benchmark replays them', () => {
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /const members = liveMode && requester\?\.firstVersion\s+\? await projectMembers\(pool, app\)\.catch\(/);
  assert.match(src, /seed, issueNumber, firstVersion: !!requester\?\.firstVersion, decider,\s+\.\.\.\(members \? \{ members \} : \{\}\),/);
  assert.match(src, /\.\.\.\(deciderNote\(decider\) \? \{ decider \} : \{\}\),[\s\S]{0,120}\.\.\.\(members \? \{ members \} : \{\}\),\s+(?:\.\.\.\(starter \? \{ starter \} : \{\}\),\s+)?\},/,
    'kept in the snapshot');
  assert.match(read('src/services/bench/runner.js'), /members: snapshot\.extra\?\.members \|\| null,/);
});

// Evan, 8 Oct 2026: a project made from a game starter (services/
// app-templates.js `bot`) is planned, specced and built ON that working game.
// The look reads its starter off the app's row, keeps it in the snapshot,
// and the benchmark replays it, as it does the project's people.
test('a first version made from a game starter is planned on it, and the benchmark replays the starter', () => {
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /const starter = liveMode && requester\?\.firstVersion\s+\? await starterOfApp\(pool, app\.id\)\.catch\(/);
  assert.match(src, /seed, issueNumber, firstVersion: !!requester\?\.firstVersion, decider,\s+\.\.\.\(members \? \{ members \} : \{\}\),\s+\.\.\.\(starter \? \{ starter \} : \{\}\),/,
    'in the prompt');
  assert.match(src, /\.\.\.\(members \? \{ members \} : \{\}\),\s+\.\.\.\(starter \? \{ starter \} : \{\}\),\s+\},\n  \};/, 'kept in the snapshot');
  const runner = read('src/services/bench/runner.js');
  assert.match(runner, /members: snapshot\.extra\?\.members \|\| null,\n[^\n]*\n    starter: snapshot\.extra\?\.starter \|\| null,/, 'the replayed triage');
  assert.match(runner, /firstVersion: !!snapshot\.extra\?\.firstVersion,\n    starter: snapshot\.extra\?\.starter \|\| null,/, 'the replayed build');
  assert.match(runner, /botStarter\(input\.template\) \? \{ starter: input\.template \} : \{\}/, 'a taste task from a starter');

  const bot = require('../src/services/homeroom-bot');
  const plain = bot.firstVersionNote(null);
  for (const notStarter of ['empty', 'grocery-list', 'tier-list-hikes', 'nope']) assert.equal(bot.firstVersionNote(notStarter), plain, notStarter);
  for (const id of ['game-board', 'game-space', 'game-blocks', 'game-trivia']) {
    const note = bot.firstVersionNote(id);
    assert.doesNotMatch(note, /still the platform's starter template|the starter's screen is placeholder/, `${id}: no empty-scaffold wording`);
    assert.match(note, /built ON that starter by changing it, never by starting\nover\./);
    assert.match(note, /^STARTER: /m);
    assert.ok(note.includes(require('../src/services/app-templates').get(id).title), `${id}: names its starter`);
    assert.ok(bot.triagePromptFor({ seed: 'x', issueNumber: 1, firstVersion: true, starter: id }).includes(note));
  }
  assert.ok(!bot.triagePromptFor({ seed: 'x', issueNumber: 1, firstVersion: false, starter: 'game-board' }).includes('STARTER:'), 'a later change has no first-version note');
});

test('B6: what a plan falls back to, and the answer each choice goes with', () => {
  assert.deepEqual(bot.planFor({ plan: { bullets: ['a'], questions: [] } }), { bullets: ['a'], questions: [] });
  assert.deepEqual(bot.planFor({ assumptions: ['Uses a list'] }).bullets, ['Uses a list']);
  assert.equal(bot.planFor({}).bullets.length, 1, 'never an empty plan');
  const qs = [{ question: 'How?', answers: ['In the app', 'Phone alert'] }, { question: 'Who?', answers: ['Just me', 'Invited'] }];
  assert.deepEqual(bot.choicesFrom(qs, ['Phone alert', null]), [
    { question: 'How?', answer: 'Phone alert', suggested: false },
    { question: 'Who?', answer: 'Just me', suggested: true },
  ]);
  assert.equal(bot.choicesFrom(qs, ['Something typed']).at(0).answer, 'In the app', 'only an answer it offered');
});

// ── What it says ──

test('B6: the words of a plan, two questions and the setup message', () => {
  const text = dm.planCardText({ appName: 'Plant Pal', plan: { bullets: ['A list', 'A Today view'], questions: [{ question: 'How?', answers: ['a', 'b'] }] } });
  assert.equal(text, "Here's my plan for **Plant Pal**:\n\n- A list\n- A Today view\n\nOne choice for you, or I'll go with what I suggest.\n\nTap Build it when it looks right, or Change something.");
  const two = dm.dmText('question', {
    question: 'What time?', questions: [{ question: 'What time?', answers: ['9', '8'] }, { question: 'How?', answers: ['a', 'b'] }],
  }, { appName: 'Plant Pal', issueNumber: 2, issueTitle: 'Reminder' });
  assert.equal(two, '**Plant Pal** · request #2: Reminder\n\nI have two questions before I build this:\n\n1. What time?\n2. How?');
  const start = read('src/services/homeroom-bot-dm.js');
  assert.match(start, /Once it's ready I'll send you my plan here first, `\s*\+ `then build its first version for you to try\./);
  assert.ok(!/I'll build its first version from your/.test(start));
  for (const s of [text, two]) assert.ok(!/—/.test(s));
  assert.equal(dm.MOMENTS.plan, 'question', 'a plan needs their answer, and rings once');
});

// ── The client ──

test('B6: the plan card, drawn in every state', () => {
  const { PlanCardView } = loadTsx('frontend/src/features/messages/bot-plan-view.tsx');
  const plan = { bullets: ['A list of your plants', 'A Today view'], questions: [{ question: 'How should it remind you?', answers: ['In the app', 'Phone alert'] }] };
  const draw = (props) => renderToHtml(createElement(PlanCardView, { appName: 'Plant Pal', plan, state: 'open', ...props }));
  const open = draw();
  assert.match(open, /data-bot-plan="open"/);
  assert.match(open, />My plan for Plant Pal<\/div>/, '#4046: its title, not a sentence ending in a colon');
  // Owner, 7 October: each line a row of its own, as PR 5's plan page draws
  // them: 15px over 22px, 12px above and below, a hairline between, no dot.
  assert.match(open, /<ul class="mt-1 flex flex-col" data-bot-plan-lines=""><li class="py-3 text-\[0\.9375rem\] leading-\[22px\] text-zinc-900 dark:text-zinc-100">A list of your plants<\/li><li class="py-3 text-\[0\.9375rem\] leading-\[22px\] text-zinc-900 shadow-\[inset_0_1px_0_var\(--app-sheet-line\)\] dark:text-zinc-100">A Today view<\/li><\/ul>/);
  assert.doesNotMatch(open, /rounded-full bg-zinc-400/, 'no dot before a line in the chat');
  assert.match(draw({ surface: 'app' }), /<li class="flex items-start gap-2\.5"><span aria-hidden="true" class="[^"]*rounded-full[^"]*"><\/span><span>A list of your plants<\/span><\/li>/,
    'the App tab\'s card keeps its dots');
  assert.match(open, /How should it remind you\?/);
  // #4046: one quiet single choice, the suggested answer already picked, and
  // no "suggested" chip beside it.
  assert.match(open, /role="radiogroup" aria-labelledby="[^"]+" class="mt-1 flex flex-col">/, 'no box behind the answers (owner, 7 October)');
  assert.match(open, /<label class="flex min-h-\[44px\] cursor-pointer items-center gap-2\.5 py-2 [^"]*" data-bot-answer="default">/, '44px rows with no side padding');
  assert.match(open, /data-bot-answer="default"><input type="radio" class="sr-only" name="[^"]+" checked="" value="In the app"\/>/);
  assert.match(open, /data-bot-answer="other"><input type="radio" class="sr-only" name="[^"]+" value="Phone alert"\/>/);
  assert.match(open, /<span class="font-semibold">In the app<\/span>/);
  assert.doesNotMatch(open, /suggested|aria-pressed/);
  // Build it is the one strong action, the width of the card; Change
  // something is a quiet link under it.
  assert.match(open, /<button type="button" class="mt-3 h-\[50px\] w-full rounded-full bg-\[color:var\(--accent\)\][^"]*" data-bot-plan-build="">Build it<\/button>/);
  assert.match(open, /<button type="button" class="[^"]*text-violet-700[^"]*" data-bot-plan-change="">Change something<\/button>/);
  assert.doesNotMatch(open, /messages-bot-primary|messages-bot-secondary|data-bot-plan-progress/, 'no step without its host\'s progress');
  // #4046: in the chat, the one place a step count shows: in words, under the
  // title, with no bar (owner, 7 October: a calmer hierarchy).
  const waiting = draw({ progress: { line: 'Step 3 of 7', step: 3, of: 7 } });
  assert.match(waiting, /My plan for Plant Pal<\/div><div class="mt-0\.5 flex min-w-0" data-bot-plan-progress=""><span class="[^"]*\btext-zinc-500\b[^"]*" role="status" data-bot-plan-progress-line="">Step 3 of 7<\/span><\/div>/,
    'the title first, the step line just under it');
  assert.doesNotMatch(waiting, /role="progressbar"/, 'no bar');
  const built = draw({ state: 'built', choices: ['Phone alert'] });
  assert.ok(!/Build it<\/button>/.test(built));
  // #4197: each question a small label, the answer gone with as a filled chip
  // (not a button, and not the other options), then a check and "Building it".
  assert.match(built, /<dt class="messages-bot-choice-label">How should it remind you\?<\/dt><dd><span class="messages-bot-chosen">Phone alert<\/span><\/dd>/);
  assert.ok(!/In the app/.test(built), 'only the answer chosen');
  assert.match(built, /<p class="messages-bot-answered messages-bot-done" role="status"><svg[^>]*>[\s\S]*?<\/svg><span>Building it<\/span><\/p>/);
  const building = draw({ state: 'built', choices: ['Phone alert'], progress: { line: 'Step 4 of 7 · Build it · 10 to 25 min', step: 4, of: 7 } });
  assert.match(building, /<span class="[^"]*\btruncate\b[^"]*" role="status" data-bot-plan-progress-line="">Step 4 of 7 · Build it · 10 to 25 min<\/span>/,
    'the step line stays on one line, an ellipsis as the last resort');
  assert.match(building, /<\/div><div class="mt-0\.5[^"]*" data-bot-plan-progress="">.*<\/div><dl class="messages-bot-choices/, 'title, step line, then the answers');
  assert.doesNotMatch(building, /Building it<\/span><\/p>/, 'the step says it: nothing said twice');
  // Build it pressed here, before the update brings `choices`: the picks
  // (the suggested answer for one left alone) stay, never blank.
  const twoQs = { ...plan, questions: [...plan.questions, { question: 'Who can see it?', answers: ['Just me', 'Invited'] }] };
  const pressed = renderToHtml(createElement(PlanCardView, { appName: 'Plant Pal', plan: twoQs, state: 'open', busy: true }));
  assert.match(pressed, /data-bot-plan="built"/);
  assert.match(pressed, /How should it remind you\?<\/dt><dd><span class="messages-bot-chosen">In the app<\/span>/);
  assert.match(pressed, /Who can see it\?<\/dt><dd><span class="messages-bot-chosen">Just me<\/span>/);
  assert.ok(!/messages-bot-chosen/.test(draw({ state: 'built' })), 'built elsewhere with no answers: no chips to guess');
  const view = read('frontend/src/features/messages/bot-plan-view.tsx');
  assert.match(view, /const went = choices\.length \? choices\s*: builtHere \|\| busy \? plan\.questions\.map\(\(q, i\) => picked\[i\] \|\| q\.answers\[0\] \|\| ''\) : \[\];/);
  const replaced = draw({ state: 'replaced' });
  assert.match(replaced, /Replaced by a newer plan/);
  assert.ok(!/<li/.test(replaced), 'a replaced plan folds its bullets away');
  const stopped = draw({ state: 'stopped' });
  assert.match(stopped, />A list of your plants<\/li>/, 'a stopped plan keeps its lines');
  assert.match(stopped, /I stopped waiting on this plan\. Reply to pick it up again\./);
  assert.match(draw({ state: 'changing' }), /You asked for changes\. A new plan is on its way\./);
  assert.match(draw({ state: 'closed' }), /No longer needed\./);
  assert.match(draw({ surface: 'app' }), /rounded-\[20px\] bg-\[color:var\(--dc-sheet-solid\)\]/, 'the App tab draws it as a card');
});

test('B6: which bot messages draw a plan or two questions, and what state a plan is in', () => {
  const { isPlanMessage, isTwoQuestions, planState } = loadTsx('frontend/src/features/messages/bot-plan.tsx');
  const msg = (meta, extra = {}) => ({ id: 1, sender: { id: 9, username: 'homeroom_bot', bot: true }, content: 'x', metadata: { homeroomBot: meta }, ...extra });
  const plan = { bullets: ['a'], questions: [] };
  assert.equal(isPlanMessage(msg({ kind: 'plan', plan })), true);
  assert.equal(isPlanMessage(msg({ kind: 'plan' })), false, 'no plan to draw: its words');
  assert.equal(isPlanMessage(msg({ kind: 'plan', plan }, { sender: { id: 2, username: 'ada' } })), false);
  const q = { question: 'q', answers: ['a', 'b'] };
  assert.equal(isTwoQuestions(msg({ kind: 'question', questions: [q, { ...q, question: 'r' }] })), true);
  assert.equal(isTwoQuestions(msg({ kind: 'question', question: 'q' })), false, 'one question keeps its one tap');
  assert.equal(planState({ kind: 'plan', status: 'open', actionId: 4 }), 'open');
  assert.equal(planState({ kind: 'plan', status: 'open', actionId: 4 }, true), 'built');
  assert.equal(planState({ kind: 'plan', status: 'answered' }), 'built');
  assert.equal(planState({ kind: 'plan', status: 'closed', replaced: true }), 'replaced');
  assert.equal(planState({ kind: 'plan', status: 'closed', stopped: true }), 'stopped');
  assert.equal(planState({ kind: 'plan', status: 'closed', changing: true }), 'changing');
  assert.equal(planState({ kind: 'plan', status: 'open' }), 'closed', 'nothing to decide without its action');
  // #4197: two questions answered read back as label and chip, a typed answer as written.
  const { answeredPairs } = loadTsx('frontend/src/features/messages/bot-plan.tsx');
  const qs = [{ question: 'How?' }, { question: 'Who?' }];
  assert.deepEqual(answeredPairs(qs, 'How? Phone alert\nWho? Just me'), [{ question: 'How?', answer: 'Phone alert' }, { question: 'Who?', answer: 'Just me' }]);
  assert.equal(answeredPairs(qs, 'Something of my own'), null);
  assert.equal(answeredPairs(qs, 'How? Phone alert\nWhen? Now'), null);
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /isPlanMessage\(message\) \? \([\s\S]{0,200}<BotPlanCard /);
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /body: JSON\.stringify\(answers \? \{ choice, answers \} : \{ choice \}\)/);
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-bot-answers button\[aria-pressed="true"\] \{ color: var\(--accent-ink\); background: var\(--accent\); \}/);
  assert.match(css, /\.messages-bot-chosen \{[^}]*color: var\(--accent-ink\);\s*background: var\(--accent\);/, '#4197: an answered chip wears the tapped answer\'s fill');
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(composer, /\{t\('messages:composer\.planReplyNote'\)\}/);
  assert.equal(message('messages:composer.planReplyNote'), 'Say what to change, and Homeroom bot sends a new plan. Only you see this.');
});

test('B6: the plan is answered in the chat; #4043: the App tab no longer draws it', () => {
  // #4043: the being-built App tab drew the whole plan, with its questions
  // and Build it, under the tour card. The plan is answered in the creator's
  // chat with Homeroom bot; the App tab shows the thumbnail and its line.
  const view = read('public/js/app-view.js');
  assert.doesNotMatch(view, /buildFirstVersion|changeFirstVersionPlan|homeroom-bot\/actions/);
  const status = read('frontend/src/features/app-frame/app-status.tsx');
  assert.doesNotMatch(status, /FirstVersionPlanCard|PlanCardView|buildFirstVersion/);
  // The made screen still reads that one waits (its Needs you card).
  assert.match(read('src/routes/apps.js'), /\.\.\.\(mine && state\.plan \? \{ plan: state\.plan \} : \{\}\),/);
  const route = read('src/routes/conversations.js');
  assert.match(route, /const answers = Array\.isArray\(req\.body\?\.answers\)/);
  assert.match(read('frontend/src/features/messages/store.ts'), /quoteBotMessage: \(conversationId\?: number \| null, messageId\?: number \| null\) =>/);
});

test('B6: no approval talk on the request while it builds, and no default nothing applies', () => {
  assert.ok(!/nobody needs to approve|not for approval|If nobody answers/.test(read('src/services/homeroom-bot-live.js')));
  assert.ok(!/nobody needs to approve/.test(read('src/routes/issues.js')));
});

// ── Against the full schema ──

test('B6: a first version\'s plan, end to end, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_plan_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 4 });
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(read('src/db/schema.sql'));
  const mayor = require('../src/services/homeroom-bot-mayor');
  const progress = require('../src/services/homeroom-bot-progress');
  const conversations = require('../src/services/conversations');
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess"`,
    [username, synthetic],
  )).rows[0];
  const homeroomBot = await user('homeroom_bot', true);
  const maya = await user('maya');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Plant Pal', 'plant-pal', 'running', $1, 'private', 'private') RETURNING id`,
    [maya.id],
  );
  const app = (await pool.query('SELECT id, slug, name, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, maya.id]);
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  // The bot works for everyone with platform access, on every app but a
  // paused one.
  await set('homeroom_bot_mode', 'live');
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds, status, issue_number)
     VALUES ($1, $2, 'A plant watering app', TRUE, 'filed', 1)`,
    [app.id, maya.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version, asked_text)
     VALUES ($1, 1, $2, 'First version of Plant Pal', TRUE, 'A plant watering app')`,
    [app.id, maya.id],
  );
  const PLAN = {
    bullets: ['A list of your plants', 'A Today view'],
    questions: [
      { question: 'How should it remind you?', answers: ['In the app', 'Phone alert'] },
      { question: 'Who can see your plants?', answers: ['Just me', 'People I invite'] },
    ],
  };
  const readyRun = async () => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, created_at)
     VALUES ($1, 1, 'live', 'ready', 'Build the plant list.', NOW()) RETURNING id`,
    [app.id],
  )).rows[0].id;
  const runRow = async (id) => (await pool.query('SELECT * FROM homeroom_bot_runs WHERE id = $1', [id])).rows[0];
  const planMessage = async (runId) => (await pool.query(
    `SELECT m.id, m.conversation_id, m.content, m.metadata->'homeroomBot' AS meta
       FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
      WHERE d.run_id = $1 AND d.kind = 'plan'`,
    [runId],
  )).rows[0];

  let first;
  await t.test('a ready first version waits under its plan, which rings as needing an answer', async () => {
    first = await readyRun();
    assert.equal(await bot.awaitGo(pool, { runId: first, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot }), 'waiting');
    const run = await runRow(first);
    assert.ok(run.awaiting_go_at, 'it waits');
    assert.equal(run.live_build_waiting_at, null, 'nothing is built yet');
    assert.deepEqual(run.plan, PLAN);
    const card = await planMessage(first);
    assert.equal(card.meta.kind, 'plan');
    assert.equal(card.meta.status, 'open');
    assert.deepEqual(card.meta.plan, PLAN);
    assert.match(card.content, /^Here's my plan for \*\*Plant Pal\*\*:/);
    const { rows: [action] } = await pool.query('SELECT * FROM homeroom_bot_dm_actions WHERE id = $1', [card.meta.actionId]);
    assert.deepEqual([action.kind, action.status, Number(action.message_id)], ['build_plan', 'open', Number(card.id)]);
    const { rows: [rang] } = await pool.query('SELECT detail FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [maya.id]);
    assert.equal(rang.detail, 'hrbot:question:Plant Pal');
  });

  await t.test('its progress waits on her, and the App tab carries the plan to build from', async () => {
    const states = await progress.requestStates(pool, { userId: maya.id });
    const state = states.find((s) => Number(s.row.issue_number) === 1).state;
    assert.deepEqual([state.stage, state.waitingOn], ['plan', 'them']);
    assert.equal(progress.stepNumber('plan', true), 3, 'Step 3 of 7, the plan\'s step');
    // #4053: its build line, for whoever reads it (buildLineOf).
    const fv = await dm.firstVersionState(pool, app.id);
    assert.equal(fv.line, 'plan-member');
    assert.equal((await dm.firstVersionState(pool, app.id, { viewerId: maya.id })).line, 'plan');
    assert.deepEqual(fv.plan.bullets, PLAN.bullets);
    assert.equal(fv.plan.actionId, (await planMessage(first)).meta.actionId);
    assert.equal((await progress.botWorkByIssue(pool, app.id)).get(1).what, 'queued', 'nobody else starts it');
  });

  await t.test('Build it, from any device, builds once, with the choices tapped and the rest suggested', async () => {
    const card = await planMessage(first);
    const tapped = await mayor.decideOfferTap(pool, {}, { user: maya, actionId: card.meta.actionId, choice: 'build', answers: ['Phone alert', ''] });
    assert.deepEqual(tapped, { ok: true, choice: 'build', label: 'Build it' });
    const run = await runRow(first);
    assert.equal(run.awaiting_go_at, null);
    assert.ok(run.live_build_waiting_at, 'its build waits its turn, as a ready verdict\'s does');
    assert.match(run.build_note, /The creator chose, from the plan they were shown:\n- How should it remind you\? Phone alert\n- Who can see your plants\? Just me$/);
    // And the plan they approved, which the spec reads as binding
    // (homeroom-bot-live.js splitApprovedPlan): until 7 Oct 2026 its
    // bullets reached neither the spec nor the build.
    assert.match(run.build_note, /\n\nApproved by the creator, who tapped Build it under this plan:\n- A list of your plants\n- A Today view\nThe creator chose/);
    assert.deepEqual(live.splitApprovedPlan(run.build_note).approved.split('\n').slice(1, 3), ['- A list of your plants', '- A Today view']);
    const after = await planMessage(first);
    assert.deepEqual([after.meta.status, after.meta.chosen, after.meta.choices], ['answered', 'build', ['Phone alert', 'Just me']]);
    const again = await mayor.decideOfferTap(pool, {}, { user: maya, actionId: card.meta.actionId, choice: 'build' });
    assert.deepEqual([again.ok, again.status, again.error], [false, 409, 'already_decided']);
    assert.equal((await mayor.decideOfferTap(pool, {}, { user: maya, actionId: card.meta.actionId, choice: 'maybe' })).status, 400);
    await pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = $2 WHERE id = $1', [first, 'test: done']);
  });

  let second;
  await t.test('Change something: a reply to the plan is kept private and read again first, and the card waits for the new one', async () => {
    second = await readyRun();
    await bot.awaitGo(pool, { runId: second, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot });
    const card = await planMessage(second);
    const sent = await conversations.sendMessage(pool, maya, card.conversation_id, {
      content: 'Make it work for my partner too', reply_to_id: card.id,
    });
    const reply = (await pool.query('SELECT id, content, reply_to_id FROM conversation_messages WHERE id = $1', [sent.messageId])).rows[0];
    const out = await dm.noteUserMessage(pool, {}, {
      user: maya, conversationId: card.conversation_id,
      message: { id: reply.id, content: reply.content, reply: { id: card.id } }, deps: { bot: homeroomBot },
    });
    assert.ok(out?.messageId, 'the bot says it heard');
    const said = (await pool.query('SELECT content FROM conversation_messages WHERE id = $1', [out.messageId])).rows[0];
    assert.equal(said.content, "Thanks. I'll work that into a new plan for Plant Pal and send it here.");
    const run = await runRow(second);
    assert.deepEqual([run.plan_change, run.awaiting_go_at, run.build_ok], ['Make it work for my partner too', null, false]);
    const { rows: [q] } = await pool.query('SELECT priority, reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 1', [app.id]);
    assert.deepEqual(q, { priority: 0, reason: 'plan_change' });
    const { rows: posted } = await pool.query(`SELECT 1 FROM chat_messages WHERE app_id = $1 AND content LIKE '%partner%'`, [app.id]);
    assert.equal(posted.length, 0, 'never posted on the request');
    const closed = await planMessage(second);
    assert.deepEqual([closed.meta.status, closed.meta.changing], ['closed', true]);
    // Redoing the plan is not reading the description for the first time:
    // the App tab and the made screen keep it on the plan's step.
    const fv = await dm.firstVersionState(pool, app.id);
    assert.deepEqual([fv.step, fv.of, fv.line], [3, 7, 'planning']);
    assert.equal(fv.plan, undefined, 'no plan waits while the new one is written');
    const changes = await bot.planChangesFor(pool, app.id, 1);
    assert.deepEqual(changes, { bullets: PLAN.bullets, changes: ['Make it work for my partner too'] });
  });

  await t.test('the new plan replaces the old card; a new look at the request closes a waiting one', async () => {
    const third = await readyRun();
    await bot.awaitGo(pool, { runId: third, app, issueNumber: 1, parsed: { plan: { bullets: ['A shared list'], questions: [] } }, bot: homeroomBot });
    assert.equal((await planMessage(second)).meta.replaced, true, 'Replaced by a newer plan');
    assert.notEqual((await planMessage(first)).meta.replaced, true, 'a plan that was built stays as it was');
    assert.deepEqual(await bot.retireWaitingPlans(pool, { appId: app.id, issueNumber: 1, why: 'the request was read again' }), [third]);
    const run = await runRow(third);
    assert.deepEqual([run.awaiting_go_at, run.build_ok, run.build_error], [null, false, 'skipped: the request was read again']);
    const card = await planMessage(third);
    assert.equal(card.meta.status, 'closed');
    const { rows: [action] } = await pool.query('SELECT status FROM homeroom_bot_dm_actions WHERE id = $1', [card.meta.actionId]);
    assert.equal(action.status, 'declined');
    const late = await mayor.decideOfferTap(pool, {}, { user: maya, actionId: card.meta.actionId, choice: 'build' });
    assert.equal(late.status, 409, 'a closed plan builds nothing');
  });

  await t.test('a week with no tap stops it; "build it" written under a plan is its button; "yes" typed is never an offer\'s', async () => {
    const stale = await readyRun();
    await bot.awaitGo(pool, { runId: stale, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot });
    await pool.query(`UPDATE homeroom_bot_runs SET awaiting_go_at = NOW() - INTERVAL '8 days' WHERE id = $1`, [stale]);
    const typed = await conversations.sendMessage(pool, maya, (await planMessage(stale)).conversation_id, { content: 'yes' });
    assert.equal(await mayor.decideTyped(pool, {}, {
      bot: homeroomBot, user: maya, settings: await bot.readSettings(pool), conversationId: (await planMessage(stale)).conversation_id,
      message: { id: typed.messageId, content: 'yes' }, deps: {},
    }), null, 'a plan is never decided by a "yes" meant for an offer');
    assert.equal(await bot.settleStalePlans(pool), 1);
    const run = await runRow(stale);
    assert.deepEqual([run.awaiting_go_at, run.build_ok, run.build_error], [null, false, 'skipped: nobody tapped Build it within a week']);
    const card = await planMessage(stale);
    assert.deepEqual([card.meta.status, card.meta.stopped], ['closed', true]);
    // Said once, under the card, without ringing: the card changing a week
    // up the conversation was the only sign it had gone quiet.
    const stoppedNotes = async () => (await pool.query(
      `SELECT m.id, m.content, m.metadata->'homeroomBot' AS meta
         FROM conversation_messages m
        WHERE m.conversation_id = $1 AND m.metadata->'homeroomBot'->>'kind' = 'plan_stopped'`,
      [card.conversation_id],
    )).rows;
    const [note] = await stoppedNotes();
    assert.equal(note.content, dm.planStoppedText(app.name));
    assert.match(note.content, /^Nobody tapped Build it on the plan for .+ for a week, so I put it away and built nothing\. Reply to the plan above to pick it up again\.$/);
    assert.ok(Number(note.id) > Number(card.id), 'after the plan it is about');
    assert.equal(note.meta.issueNumber, 1);
    await dm.closePlanCards(pool, [stale], { stopped: true });
    assert.equal((await stoppedNotes()).length, 1, 'once');

    const go = await readyRun();
    await bot.awaitGo(pool, { runId: go, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot });
    const goCard = await planMessage(go);
    const sent = await conversations.sendMessage(pool, maya, goCard.conversation_id, { content: 'Build it!', reply_to_id: goCard.id });
    const out = await dm.noteUserMessage(pool, {}, {
      user: maya, conversationId: goCard.conversation_id,
      message: { id: sent.messageId, content: 'Build it!', reply: { id: goCard.id } }, deps: { bot: homeroomBot },
    });
    const said = (await pool.query(
      `SELECT content, metadata->'homeroomBot' AS meta FROM conversation_messages WHERE id = $1`, [out.messageId],
    )).rows[0];
    // #4392: typed, the answer is the same thanks Build it sends, with its card, and said once.
    assert.equal(said.content, 'Thanks for answering about the plan. I\'ll let you know when Plant Pal is ready to try.');
    assert.deepEqual([said.meta.kind, said.meta.thanks], ['activity', true]);
    const { rows: [{ n: after }] } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1 AND id > $2 AND sender_id = $3',
      [goCard.conversation_id, sent.messageId, homeroomBot.id],
    );
    assert.equal(after, 1, 'one message from the bot after the typed Build it: the thanks');
    assert.ok((await runRow(go)).live_build_waiting_at);
    assert.match((await runRow(go)).build_note, /How should it remind you\? In the app/);
  });

  // #4175: a first version is never built without its creator's Build it.
  // Until 8 October 2026 a plan that could not be sent was built at once.
  const queued = async (id) => (await runRow(id)).live_build_waiting_at;
  const failing = (how) => ({
    ...dm,
    sendPlanCard: async () => { if (how === 'throw') throw new Error('dm down'); return null; },
  });
  const sinceLastTry = (id, minutes) => pool.query(
    `UPDATE homeroom_bot_runs SET plan_unsent_at = NOW() - make_interval(mins => $2) WHERE id = $1`, [id, minutes],
  );
  const finish = (id) => pool.query(
    'UPDATE homeroom_bot_runs SET awaiting_go_at = NULL, build_ok = FALSE, build_error = $2 WHERE id = $1 AND build_ok IS NULL',
    [id, 'test: done'],
  );

  await t.test('#4175: a plan that could not be sent keeps its run waiting, with nothing built', async () => {
    const run = await readyRun();
    assert.equal(await bot.awaitGo(pool, { runId: run, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot, deps: { dm: failing() } }), 'unsent');
    let row = await runRow(run);
    assert.ok(row.awaiting_go_at, 'it still waits for Build it');
    assert.ok(row.plan_unsent_at, 'to be sent again');
    assert.deepEqual([row.plan_send_attempts, row.build_ok, await queued(run)], [1, null, null], 'nothing is built');
    assert.equal(await planMessage(run), undefined, 'and nobody was sent a card');
    // A send that throws is the same: it waits.
    const thrown = await readyRun();
    assert.equal(await bot.awaitGo(pool, { runId: thrown, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot, deps: { dm: failing('throw') } }), 'unsent');
    row = await runRow(thrown);
    assert.deepEqual([!!row.awaiting_go_at, row.plan_send_attempts, await queued(thrown)], [true, 1, null]);
    await finish(run); await finish(thrown);
  });

  await t.test('#4175: a later wake sends it again once its wait is up, and then it waits for Build it under the plan', async () => {
    const run = await readyRun();
    await bot.awaitGo(pool, { runId: run, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot, deps: { dm: failing() } });
    assert.deepEqual(await bot.retryUnsentPlans(pool, homeroomBot), { sent: 0, unsent: 0, stopped: 0 }, 'not before its wait is up');
    await sinceLastTry(run, bot.PLAN_SEND_RETRY_MINUTES[0] + 1);
    assert.deepEqual(await bot.retryUnsentPlans(pool, homeroomBot), { sent: 1, unsent: 0, stopped: 0 });
    const row = await runRow(run);
    assert.ok(row.awaiting_go_at, 'it waits for Build it');
    assert.deepEqual([row.plan_unsent_at, row.plan_send_attempts, row.build_ok, await queued(run)], [null, 2, null, null]);
    const card = await planMessage(run);
    assert.deepEqual([card.meta.kind, card.meta.status], ['plan', 'open'], 'its creator has the plan');
    assert.deepEqual(card.meta.plan, PLAN);
    assert.deepEqual(await bot.retryUnsentPlans(pool, homeroomBot), { sent: 0, unsent: 0, stopped: 0 }, 'sent once');
    await bot.retireWaitingPlans(pool, { appId: app.id, issueNumber: 1, why: 'test: done' });
  });

  await t.test('#4175: a plan that still cannot be sent after about an hour stops, recorded as not built', async () => {
    const run = await readyRun();
    await bot.awaitGo(pool, { runId: run, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot, deps: { dm: failing() } });
    const minutes = bot.PLAN_SEND_RETRY_MINUTES;
    assert.ok(minutes.reduce((a, b) => a + b, 0) >= 50 && minutes.reduce((a, b) => a + b, 0) <= 90, 'about an hour');
    for (let i = 0; i < minutes.length; i += 1) {
      assert.ok((await runRow(run)).awaiting_go_at, `still waiting before retry ${i + 1}`);
      await sinceLastTry(run, minutes[i] + 1);
      const out = await bot.retryUnsentPlans(pool, homeroomBot, { dm: failing() });
      assert.deepEqual(out, i < minutes.length - 1 ? { sent: 0, unsent: 1, stopped: 0 } : { sent: 0, unsent: 0, stopped: 1 });
    }
    const row = await runRow(run);
    assert.deepEqual(
      [row.awaiting_go_at, row.plan_unsent_at, row.build_ok, row.build_error, row.plan_send_attempts, await queued(run)],
      [null, null, false, 'skipped: the plan could not be sent to its creator', bot.PLAN_SEND_ATTEMPTS, null],
    );
    await sinceLastTry(run, 120);
    assert.deepEqual(await bot.retryUnsentPlans(pool, homeroomBot, { dm: failing() }), { sent: 0, unsent: 0, stopped: 0 }, 'tried no more');
  });

  await t.test('#4175: a first version for someone the bot no longer works for stops at once, and is never built', async () => {
    // Maya no longer has platform access, so the bot no longer works for her.
    await pool.query('UPDATE users SET has_platform_access = FALSE WHERE id = $1', [maya.id]);
    const lone = await readyRun();
    assert.equal(await bot.awaitGo(pool, { runId: lone, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot }), 'stopped');
    const row = await runRow(lone);
    assert.deepEqual(
      [row.awaiting_go_at, row.plan_unsent_at, row.build_ok, row.build_error, await queued(lone)],
      [null, null, false, 'skipped: nobody to send the plan to: its creator no longer has Homeroom bot', null],
    );
    await pool.query('UPDATE users SET has_platform_access = TRUE WHERE id = $1', [maya.id]);
    // And one whose requester cannot be found.
    const orphan = await readyRun();
    await pool.query('UPDATE homeroom_bot_runs SET issue_number = 99 WHERE id = $1', [orphan]);
    assert.equal(await bot.awaitGo(pool, { runId: orphan, app, issueNumber: 99, parsed: { plan: PLAN }, bot: homeroomBot }), 'stopped');
    const gone = await runRow(orphan);
    assert.deepEqual([gone.build_ok, gone.build_error, await queued(orphan)],
      [false, 'skipped: nobody to send the plan to: its creator could not be found', null]);
  });

  await t.test('#4175: a run that already has a build state is not asked again, and is never queued twice', async () => {
    const run = await readyRun();
    await bot.queueLiveBuild(pool, { runId: run, appId: app.id });
    const first = await queued(run);
    assert.ok(first);
    assert.equal(await bot.awaitGo(pool, { runId: run, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot }), 'already');
    assert.equal((await runRow(run)).awaiting_go_at, null);
    await bot.queueLiveBuild(pool, { runId: run, appId: app.id });
    assert.equal((await queued(run)).toISOString(), first.toISOString(), 'a second queue keeps its place');
    await pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_ok = FALSE WHERE id = $1', [run]);
    await bot.queueLiveBuild(pool, { runId: run, appId: app.id });
    assert.equal(await queued(run), null, 'and one already built is left alone');
  });

  // First session, 4 October: Build it collapsed the plan and nothing
  // appeared under it; the build's progress was in a card above the plans.
  await t.test('Build it moves the request\'s card under the plan, silently, and the card above stops being the request\'s', async () => {
    const activity = require('../src/services/homeroom-bot-activity');
    const requester = await dm.requesterOf(pool, app.id, 1);
    // Its card, from when it was queued (or the one an earlier Build it moved).
    await activity.startCard(pool, { inDm: true, app, issueNumber: 1, requester, bot: homeroomBot, jobKey: 'plan-under', queued: true });
    const run = await readyRun();
    assert.equal(await bot.awaitGo(pool, { runId: run, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot }), 'waiting');
    const plan = await planMessage(run);
    const above = await activity.requestCard(pool, { userId: maya.id, appId: app.id, issueNumber: 1 });
    assert.ok(above && above.messageId < Number(plan.id), 'the request\'s card sits above its plan');

    const tapped = await mayor.decideOfferTap(pool, {}, { user: maya, actionId: plan.meta.actionId, choice: 'build' });
    assert.equal(tapped.ok, true);
    const under = await activity.requestCard(pool, { userId: maya.id, appId: app.id, issueNumber: 1 });
    assert.ok(under.messageId > Number(plan.id), 'it follows the build from under the plan');
    const message = async (id) => (await pool.query(
      `SELECT content, metadata->'homeroomBot' AS meta FROM conversation_messages WHERE id = $1`, [id],
    )).rows[0];
    const card = await message(under.messageId);
    assert.equal(card.meta.kind, 'activity');
    assert.equal(card.meta.lookAt, (await runRow(run)).created_at.toISOString(), 'read from the run the plan came from');
    assert.equal(card.meta.startedAt, undefined, 'its time counts from the tap');
    assert.equal(card.content, 'Thanks for answering about the plan. I\'ll let you know when Plant Pal is ready to try.',
      '#4392: the bot\'s thanks, drawn over the app\'s card');
    assert.equal(card.meta.thanks, true);
    const { rows: rang } = await pool.query('SELECT 1 FROM notifications WHERE conversation_message_id = $1', [under.messageId]);
    assert.equal(rang.length, 0, 'a progress card rings nothing');
    assert.equal(Number((await message(above.messageId)).meta.movedTo), under.messageId, 'the card above says where it went');
    const { rows: record } = await pool.query('SELECT 1 FROM homeroom_bot_dm_messages WHERE message_id = $1', [above.messageId]);
    assert.equal(record.length, 0, 'and is not the request\'s card any more');
    // Her project, as creating it makes her (cards are read for projects she can view).
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())
       ON CONFLICT (app_id, user_id) DO NOTHING`,
      [app.id, maya.id],
    );
    const { cards } = await activity.cardsFor(pool, {
      user: { id: maya.id, username: maya.username, isAdmin: false }, settings: await bot.readSettings(pool),
    });
    assert.equal(cards.find((c) => c.messageId === under.messageId)?.state, 'working', 'its build, waiting its turn');
    assert.ok(!cards.some((c) => c.messageId === above.messageId), 'and the card above is not read as one');

    const again = await mayor.decideOfferTap(pool, {}, { user: maya, actionId: plan.meta.actionId, choice: 'build' });
    assert.equal(again.status, 409);
    assert.equal((await activity.requestCard(pool, { userId: maya.id, appId: app.id, issueNumber: 1 })).messageId, under.messageId,
      'a second tap moves nothing');
  });
});

test('B6: where the waiting state is read, and where it ends', () => {
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /\} else if \(firstVersion\) \{\s*acted = PLAN_ACTED\[await awaitGo\(pool, \{ runId, app, issueNumber, parsed, bot, deps \}\)\];/);
  // #4175: a plan that could not be sent is sent again on the sweep's cadence.
  assert.match(src, /const resent = await retryUnsentPlans\(pool, bot, \{ dm: deps\.dm, ws: deps\.ws \|\| null \}\);/);
  assert.match(src, /await retireWaitingPlans\(pool, \{ appId: app\.id, issueNumber, why: 'the request was read again', deps: \{ dm: deps\.dm \} \}\);/);
  assert.match(src, /const stalePlans = await settleStalePlans\(pool, \{ dm: deps\.dm \}\);/);
  assert.match(src, /out\.skipped \+= \(await retireWaitingPlans\(pool, \{ appId, issues, why: why\.replace/);
  assert.match(src, /\.\.\.\(planChange \? \{ planChange: \{ \.\.\.planChange, requester: requester\.username \} \} : \{\}\),/);
  const progressSrc = read('src/services/homeroom-bot-progress.js');
  assert.match(progressSrc, /run\.awaiting_go_at AS plan_waiting_at/);
  assert.match(read('src/services/homeroom-bot-mayor.js'), /AND a\.kind <> 'build_plan'/);
  const schema = read('src/db/schema.sql');
  for (const column of ['plan JSONB', 'awaiting_go_at TIMESTAMPTZ', 'plan_change TEXT',
    'plan_send_attempts INTEGER NOT NULL DEFAULT 0', 'plan_unsent_at TIMESTAMPTZ']) {
    assert.ok(schema.includes(`ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS ${column};`), column);
  }
  assert.equal(live.questionText({ question: 'Q?' }).includes('If nobody answers'), false);
});

test('a first version made from a game starter is specced and built on it; without one, nothing changes', () => {
  const live = require('../src/services/homeroom-bot-live');
  const prompts = require('../src/services/prompts');
  const appTemplates = require('../src/services/app-templates');
  // Without a starter (or with one that is not a game's), every line is as it was.
  for (const none of [null, 'empty', 'grocery-list']) {
    assert.deepEqual(live.specScopeLines(true, none), live.specScopeLines(true), String(none));
    assert.equal(live.specDesignBrief(true, none), prompts.FIRST_VERSION_SPEC_DESIGN_BRIEF ?? live.specDesignBrief(true), String(none));
    assert.deepEqual(live.firstVersionDesignLines(none), live.firstVersionDesignLines(), String(none));
  }
  assert.deepEqual(live.specScopeLines(false, 'game-board'), live.specScopeLines(false), 'a later change is as small as asked');
  for (const id of ['game-board', 'game-space', 'game-blocks', 'game-trivia']) {
    const s = appTemplates.get(id);
    const scope = live.specScopeLines(true, id).join('\n');
    assert.ok(scope.includes(`Built ON the repository's ${s.title}`), `${id}: the spec builds on it`);
    assert.ok(scope.includes(s.bot.build));
    assert.match(scope, /never plan to start over/);
    const brief = live.specDesignBrief(true, id);
    assert.doesNotMatch(brief, /the starter template's is placeholder/);
    assert.match(brief, /the game starter's screens \(a title screen, then the game filling the screen\) work and wear the example game's scene/);
    const lines = live.firstVersionDesignLines(id).join('\n');
    assert.ok(lines.includes(`This repository starts as Homeroom's ${s.title}`), `${id}: the build is told`);
    assert.match(lines, /never by deleting it to start over/);
    assert.doesNotMatch(lines, /the starter's screen and default colours are placeholder/);
    assert.match(lines, /keeps its look in `public\/scene\.css`/, `${id}: the scene is restyled, not replaced`);
    const spec = live.specPrompt({ seed: 'seed', buildNote: 'plan', firstVersion: true, starter: id });
    assert.ok(spec.includes(scope) && spec.includes(brief));
    const html = live.specPrompt({ seed: 'seed', buildNote: 'plan', firstVersion: true, starter: id, html: true });
    assert.ok(html.includes(scope) && html.includes(brief), `${id}: the HTML spec too`);
    assert.ok(live.buildPrompt({ seed: 'seed', buildNote: 'plan', firstVersion: true, starter: id }).includes(lines));
  }
  // The starter reaches both turns of a build.
  const src = read('src/services/homeroom-bot-live.js');
  assert.match(src, /firstVersion, starter, guidance: specGuidance, onProgress,/);
  assert.match(src, /platformRepo, readsImages, firstVersion, starter, guidance: buildGuidance,/);
  assert.match(src, /seed, buildNote, firstVersion, guidance, starter,/);
  const bot = read('src/services/homeroom-bot.js');
  assert.equal((bot.match(/const starter = firstVersion \? await starterOfApp\(pool, app\.id\)\.catch\(\(\) => null\) : null;/g) || []).length, 2,
    'the live build and the shadow build');
  assert.match(bot, /firstVersion, platformRepo: isPlatformRepo\(app, config\), model, specModel, starter,\n  \}\);/);
});
