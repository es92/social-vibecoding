'use strict';

// Newcomer test "run seven" (14 Oct 2026, app Club Votes). The plan written
// at Make it had the line "Vote yes, no or maybe on each one" beside the
// question "How should votes be counted?", whose kept answer was "Simple yes
// or no, most wins". Since run six the made screen shows its maker the
// questions alone, with Submit, yet the build note said the creator "tapped
// Build it under this plan", and the spec, told never to contradict what was
// approved, built a maybe that only yes and no decide. These pin:
//
//   - the plan's prompts (first-version-plan.js PLAN_SYSTEM, homeroom-bot.js
//     FIRST_VERSION_NOTE) never settle in a line what a question asks;
//   - only Build it under the plan card says its bullets were approved; the
//     made screen's Submit (homeroom-bot-dm.js buildFromAnswers) writes them
//     as the plan's own lines, in the sketch, and its answers under a head
//     that says they win (homeroom-bot.js creatorChoiceNote, goAhead), kept
//     as `planShown: false` for a run a restart sends back
//     (carryApprovedPlan);
//   - the spec and the build are told an answer wins over a plan line
//     (homeroom-bot-live.js specPlanLines, planNoteText);
//   - the early first look names the app by its name, never an invented one
//     (first-version-early-look.js), after it drew "Harbour Road Chess Club";
//   - a first version's "Sample data" label is marked with
//     `data-usernode-demo-note`, so Homeroom can hide it where it shows the
//     app with its sample data.
//
// Run with: node --test tests/homeroom-bot-run-seven.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const dm = require('../src/services/homeroom-bot-dm');
const fvPlan = require('../src/services/first-version-plan');
const early = require('../src/services/first-version-early-look');
const prompts = require('../src/services/prompts');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const flat = (text) => String(text).replace(/\s+/g, ' ');

// Run seven's plan, as the production replica holds it.
const BULLETS = [
  'Post a decision the club needs to make',
  'Vote yes, no or maybe on each one',
  'Talk it through in comments',
  'See which decisions are still open',
  'Close a vote once it\'s decided',
];
const QUESTIONS = [
  { question: 'How should votes be counted?', answers: ['Simple yes or no, most wins', 'Three options: yes, no or maybe', 'Ranked picks, first choice wins'] },
  { question: 'When does a decision close?', answers: ['The creator closes it when ready', 'After a set number of days', 'When everyone has voted'] },
];
const CHOSEN = bot.choicesFrom(QUESTIONS, [null, null]);
const NOTE = 'One screen: the open decisions. Its primary action is New decision.';

// ── The plan never settles what a question asks ──────────────────────────

test('the plan at Make it and the triage\'s first-version note never settle in a line what a question asks', () => {
  assert.match(flat(fvPlan.PLAN_SYSTEM), /- A plan line, the build_note and the assumptions never settle a point one of the choices asks: the creator's answer decides it\. Where a choice decides something, the line says what the app does without the answer \("Vote on each decision", not "Vote yes, no or maybe on each one"\), and the build_note leaves that point to the answer\./);
  for (const starter of [null, 'game-board']) {
    assert.match(flat(bot.firstVersionNote(starter)), /A `plan` line, `build_note` and `assumptions` never settle a point one of the `choices` asks: their answer decides it\. Where a choice decides something, the line says what the app does without the answer \("Vote on each decision", not "Vote yes, no or maybe on each one"\), and `build_note` leaves that point to the answer\./, String(starter));
  }
  // Still after the rule that every answer builds something different.
  assert.ok(fvPlan.PLAN_SYSTEM.indexOf('Every answer to a question') < fvPlan.PLAN_SYSTEM.indexOf('never settle a point'));
  for (const text of [fvPlan.PLAN_SYSTEM, bot.firstVersionNote(null)]) assert.doesNotMatch(text, /—/);
});

// ── Only what the creator saw is approved ────────────────────────────────

test('Build it under the card writes exactly what it always wrote: the default note is byte for byte today\'s', () => {
  const expected = [
    '',
    '',
    'Approved by the creator, who tapped Build it under this plan:',
    ...BULLETS.map((b) => `- ${b}`),
    'The creator chose, from the plan they were shown:',
    '- How should votes be counted? Simple yes or no, most wins',
    '- When does a decision close? The creator closes it when ready',
  ].join('\n');
  // The shape the bench (bench/runner.js) and the shots fixtures call it with.
  assert.equal(bot.creatorChoiceNote(CHOSEN, { bullets: BULLETS }), expected);
  assert.equal(bot.creatorChoiceNote(CHOSEN, { bullets: BULLETS, planShown: true }), expected);
  assert.equal(bot.creatorChoiceNote(CHOSEN, { bullets: [] }), expected.slice(expected.indexOf('\nThe creator chose')).replace(/^\n/, '\n\n'));
  assert.equal(bot.creatorChoiceNote([], { bullets: [] }), '');
  assert.match(read('src/services/bench/runner.js'), /bot\.creatorChoiceNote\(chosen, \{ bullets: plan\.bullets \}\)/);
  // A complicated change's requester always saw its plan: their heads, whatever is said.
  assert.equal(
    bot.creatorChoiceNote(CHOSEN, { bullets: BULLETS, requester: true, planShown: false }),
    bot.creatorChoiceNote(CHOSEN, { bullets: BULLETS, requester: true }),
  );
});

test('the made screen\'s Submit writes the bullets as the plan\'s own lines and the answers as the creator\'s, which win', () => {
  const note = bot.creatorChoiceNote(CHOSEN, { bullets: BULLETS, planShown: false });
  assert.equal(note, [
    '',
    '',
    'The plan\'s lines, not shown to its creator (a first sketch, not approved):',
    ...BULLETS.map((b) => `- ${b}`),
    '',
    'The creator chose these answers on the made screen (where a plan line differs, the answer wins):',
    '- How should votes be counted? Simple yes or no, most wins',
    '- When does a decision close? The creator closes it when ready',
  ].join('\n'));
  assert.equal(live.PLAN_LINES_HEAD, 'The plan\'s lines, not shown to its creator (a first sketch, not approved):');
  assert.equal(live.MADE_SCREEN_CHOICES_HEAD, 'The creator chose these answers on the made screen (where a plan line differs, the answer wins):');
  assert.doesNotMatch(note, /tapped Build it|from the plan they were shown/);
  // The spec reads the lines in the sketch and only the answers as binding.
  const split = live.splitApprovedPlan(`${NOTE}${note}`);
  assert.equal(split.sketch, `${NOTE}\n\n${live.PLAN_LINES_HEAD}\n${BULLETS.map((b) => `- ${b}`).join('\n')}`);
  assert.equal(split.approved, `${live.MADE_SCREEN_CHOICES_HEAD}\n- How should votes be counted? Simple yes or no, most wins\n- When does a decision close? The creator closes it when ready`);
  // A plan that asked nothing: its lines, and nothing approved.
  const lines = bot.creatorChoiceNote([], { bullets: BULLETS, planShown: false });
  assert.equal(lines, `\n\n${live.PLAN_LINES_HEAD}\n${BULLETS.map((b) => `- ${b}`).join('\n')}`);
  assert.deepEqual(live.splitApprovedPlan(`${NOTE}${lines}`), { sketch: `${NOTE}${lines}`, approved: '' });
  // Answers with no bullets: the answers alone.
  assert.equal(bot.creatorChoiceNote(CHOSEN.slice(0, 1), { planShown: false }),
    `\n\n${live.MADE_SCREEN_CHOICES_HEAD}\n- How should votes be counted? Simple yes or no, most wins`);
  assert.equal(bot.creatorChoiceNote([], { planShown: false }), '');
});

test('the spec and the build are told an answer wins over a plan line, and a long note keeps the plan\'s lines whole', () => {
  assert.equal(live.ANSWER_WINS_LINE, 'Where a plan line, even an approved one, and one of the creator\'s answers differ, the answer wins: never add an option or a behaviour an answer ruled out.');
  for (const planShown of [true, false]) {
    const note = `${NOTE}${bot.creatorChoiceNote(CHOSEN, { bullets: BULLETS, planShown })}`;
    const spec = live.specPlanLines(note, true).join('\n');
    assert.ok(spec.includes(`never contradict it.\n${live.ANSWER_WINS_LINE}\n\n`), String(planShown));
    const build = live.planNoteText(note, true);
    assert.ok(build.includes(`\n\n${live.ANSWER_WINS_LINE}\n\n`), String(planShown));
    assert.ok(build.endsWith('- When does a decision close? The creator closes it when ready'));
    // The build prompt reads it there.
    assert.ok(live.buildPrompt({ seed: 'ISSUE', buildNote: note, firstVersion: true }).includes(build));
  }
  // A later change's note, and a requester's, read as they did.
  assert.equal(live.planNoteText('short note', false), 'short note');
  assert.equal(live.planNoteText('short note', true), 'short note');
  const requester = `${NOTE}${bot.creatorChoiceNote(CHOSEN, { bullets: BULLETS, requester: true })}`;
  assert.doesNotMatch(live.planNoteText(requester, false), /even an approved one/);
  assert.doesNotMatch(live.specPlanLines('plan', false).join('\n'), /even an approved one/);
  assert.doesNotMatch(live.specPlanLines('plan', true).join('\n'), /even an approved one/, 'nothing approved, nothing said');
  // A long sketch is clipped before the plan's lines, never through them.
  const long = `${'x'.repeat(5000)}${bot.creatorChoiceNote(CHOSEN, { bullets: BULLETS, planShown: false })}`;
  for (const text of [live.specPlanLines(long, true).join('\n'), live.planNoteText(long, true)]) {
    assert.ok(text.includes(`\n\n${live.PLAN_LINES_HEAD}\n- Post a decision the club needs to make\n`));
    assert.ok(text.includes('- Close a vote once it\'s decided'));
    assert.ok(!text.includes('x'.repeat(4001)), 'the triage\'s note is still clipped');
  }
  const unanswered = `${'x'.repeat(5000)}${bot.creatorChoiceNote([], { bullets: BULLETS, planShown: false })}`;
  assert.ok(live.planNoteText(unanswered, true).endsWith('- Close a vote once it\'s decided'));
  assert.ok(live.specPlanLines(unanswered, true).join('\n').endsWith('- Close a vote once it\'s decided'));
  assert.equal(live.clipSketch(`\n\n${live.PLAN_LINES_HEAD}\n- One`), `${live.PLAN_LINES_HEAD}\n- One`);
  assert.equal(live.clipSketch('plain'), 'plain');
});

// goAhead against a pool that answers its two statements.
function goPool(plan) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/^\s*SELECT plan FROM homeroom_bot_runs/.test(String(sql))) return { rows: [{ plan }] };
      if (/UPDATE homeroom_bot_runs/.test(String(sql))) return { rows: [{ app_id: 9, issue_number: 1 }] };
      return { rows: [] };
    },
  };
}

test('goAhead writes the made screen\'s note and keeps planShown: false next to chosen; Build it\'s is as it was', async () => {
  const wsBus = require('../src/services/ws-bus');
  const realPublish = wsBus.publish;
  wsBus.publish = () => {};
  bot._resetForTests();
  try {
    const plan = { bullets: BULLETS, questions: QUESTIONS };
    const submit = goPool(plan);
    const went = await bot.goAhead(submit, { runId: 7, answers: [null, null], planShown: false });
    assert.equal(went.ok, true);
    const write = submit.calls.find((c) => /UPDATE homeroom_bot_runs/.test(c.sql));
    assert.match(write.sql, /plan = COALESCE\(plan, '\{\}'::jsonb\) \|\| jsonb_build_object\('chosen', \$3::jsonb\) \|\| \$4::jsonb/);
    assert.equal(write.params[1], bot.creatorChoiceNote(CHOSEN, { bullets: BULLETS, planShown: false }));
    assert.deepEqual(JSON.parse(write.params[3]), { planShown: false });

    const tap = goPool(plan);
    await bot.goAhead(tap, { runId: 8, answers: [] });
    const tapped = tap.calls.find((c) => /UPDATE homeroom_bot_runs/.test(c.sql));
    assert.equal(tapped.params[1], bot.creatorChoiceNote(CHOSEN, { bullets: BULLETS }));
    assert.deepEqual(JSON.parse(tapped.params[3]), {}, 'nothing added to the plan');

    // A complicated change is its requester's Build it, whatever the caller says.
    const complicated = goPool({ ...plan, complicated: true });
    await bot.goAhead(complicated, { runId: 9, planShown: false });
    const asked = complicated.calls.find((c) => /UPDATE homeroom_bot_runs/.test(c.sql));
    assert.match(asked.params[1], /Approved by the person who asked for it/);
    assert.deepEqual(JSON.parse(asked.params[3]), {});
  } finally {
    wsBus.publish = realPublish;
    bot._resetForTests();
  }
});

function carryPool(prev) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/SELECT id, plan, build_error FROM homeroom_bot_runs/.test(sql)) return { rows: [prev] };
      if (/UPDATE homeroom_bot_runs SET build_note = CONCAT/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('a run a restart sends back writes the same note its go-ahead wrote', async () => {
  const sentBack = `interrupted: the worker is gone ${bot.RESTARTED_BUILD_NOTE}`;
  const made = { bullets: BULLETS, questions: QUESTIONS, chosen: CHOSEN, planShown: false };
  const pool = carryPool({ id: 40, plan: made, build_error: sentBack });
  assert.equal(await bot.carryApprovedPlan(pool, { runId: 41, appId: 5, issueNumber: 1 }), true);
  const write = pool.calls[1];
  assert.equal(write.params[1], bot.creatorChoiceNote(CHOSEN, { bullets: BULLETS, planShown: false }));
  assert.deepEqual(JSON.parse(write.params[2]), made, 'and keeps the flag for the next one');
  const tapped = carryPool({ id: 40, plan: { ...made, planShown: undefined }, build_error: sentBack });
  await bot.carryApprovedPlan(tapped, { runId: 41, appId: 5, issueNumber: 1 });
  assert.equal(tapped.calls[1].params[1], bot.creatorChoiceNote(CHOSEN, { bullets: BULLETS }));
});

test('the made screen\'s answers go ahead with planShown: false, through the card or straight on; Build it on the card does not', async () => {
  const went = [];
  const botSvc = { async goAhead(_pool, args) { went.push(args); return { ok: true, appId: 3, issueNumber: 1, chosen: CHOSEN }; } };
  // No open card: straight on.
  const straight = {
    async query(sql) {
      if (/SELECT id FROM homeroom_bot_runs/.test(String(sql))) return { rows: [{ id: 12 }] };
      return { rows: [] };
    },
  };
  await dm.buildFromAnswers(straight, { appId: 3, issueNumber: 1, userId: 7, answers: ['Simple yes or no, most wins'], deps: { botSvc } });
  assert.deepEqual(went.pop(), { runId: 12, answers: ['Simple yes or no, most wins'], planShown: false });
  // An open card: decided as Build it is, but not as shown.
  const action = { id: 30, message_id: 31, kind: 'build_plan', status: 'open' };
  const viaCard = {
    async query(sql) {
      const s = String(sql);
      if (/SELECT id FROM homeroom_bot_runs/.test(s)) return { rows: [{ id: 12 }] };
      if (/SELECT a\.\* FROM homeroom_bot_dm_messages/.test(s)) return { rows: [action] };
      if (/SELECT run_id, conversation_id FROM homeroom_bot_dm_messages/.test(s)) return { rows: [{ run_id: 12, conversation_id: 4 }] };
      if (/UPDATE homeroom_bot_dm_actions SET status = 'done'/.test(s)) return { rows: [{ id: 30 }] };
      return { rows: [] };
    },
  };
  const noisy = { botSvc, bot: { id: 99 }, ws: null };
  await dm.buildFromAnswers(viaCard, { appId: 3, issueNumber: 1, userId: 7, answers: [null, null], deps: noisy });
  assert.deepEqual(went.pop(), { runId: 12, answers: [null, null], planShown: false });
  // Build it tapped on the card itself.
  await dm.decidePlanTap(viaCard, { user: { id: 7 }, action, choice: 'build', answers: [null, null], deps: noisy });
  assert.deepEqual(went.pop(), { runId: 12, answers: [null, null] });
  // The other taps on the card, and "build it" said under it, go ahead as shown.
  const mayor = read('src/services/homeroom-bot-mayor.js');
  // A tap's act is the person's DM machine's work (actOnTap), keyed by it.
  assert.match(mayor, /const went = await dm\.decidePlanTap\(pool, \{ user, action, choice: 'build', answers, deps, claimKey: key \}\);/);
  assert.match(read('src/services/homeroom-bot-dm.js'), /const went = await decidePlanTap\(pool, \{ user, action, choice: 'build', answers: \[\], deps \}\);/);
});

// ── The early first look uses the app's name ─────────────────────────────

test('the early first look names the app, its group and its place by the app\'s name, never an invented name', () => {
  const system = flat(early.lookSystem());
  // Run eight: the rule points at the name itself, not at a label (tests/first-version-early-look.test.js).
  assert.match(system, /- Wherever the screen names the app, its group or its place \(a header, a title, the line above a title\), it uses the app's name, given in the user message, exactly: never invent a name for the club, team, group, household or place\. Sample people, posts and numbers are still made up\./);
  assert.match(early.lookUserPrompt({ name: 'Club Votes', brief: 'Decisions for our club', plan: { bullets: ['Vote'], questions: [], buildNote: 'x' } }), /^THE APP'S NAME:\nClub Votes\n/);
  assert.doesNotMatch(system.slice(0, system.indexOf('THE DESIGN KIT')), /—/, 'its own rules, before the kit and the skill');
});

// ── The demo's label is marked ───────────────────────────────────────────

test('a first version\'s "Sample data" label is marked with data-usernode-demo-note wherever builds and specs are told about it', () => {
  const design = flat(live.FIRST_VERSION_DESIGN_LINES.join('\n'));
  assert.match(design, /labelled "Sample data" once[^.]*\. On staging and with `\?demo=1` only, and idempotent, as the platform conventions' "Staging mock data" says\. The element that carries the "Sample data" label gets the attribute `data-usernode-demo-note`/);
  // A game starter's and the one_look build keep it.
  assert.match(flat(live.firstVersionDesignLines('game-board').join('\n')), /data-usernode-demo-note/);
  assert.match(flat(live.firstVersionDesignLines(null, { oneLook: true }).join('\n')), /data-usernode-demo-note/);
  assert.match(prompts.FIRST_VERSION_SPEC_DESIGN_BRIEF, /labelled "Sample data" once, plainly and visibly, [^;]*, and the element that carries the label marked with the attribute `data-usernode-demo-note`/);
  const conventions = flat(read('src/prompts/app-conventions.md'));
  assert.match(conventions, /\*\*Labelled once, not on every row\.\*\*[^*]*The element that carries the label gets the attribute `data-usernode-demo-note`/);
  // The drawn first look is still drawn without the label at all.
  assert.match(prompts.FIRST_VERSION_SCREENS_BRIEF, /drawn WITHOUT its "Sample data" label/);
  assert.doesNotMatch(prompts.FIRST_VERSION_SCREENS_BRIEF, /data-usernode-demo-note/);
});
