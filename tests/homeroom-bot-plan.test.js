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
// request the read has two questions about asks both at once.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-plan.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
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
  assert.match(prompt, /give `plan`: 3 to 5 bullets, each at most 80 characters/);
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
  assert.match(open, /Here’s my plan for Plant Pal:/);
  assert.match(open, /<li>A list of your plants<\/li>/);
  assert.match(open, /How should it remind you\?/);
  assert.match(open, /aria-pressed="false" data-bot-answer="default"><span>In the app<\/span><span class="messages-bot-default">suggested<\/span>/);
  assert.match(open, /class="messages-bot-primary" data-bot-plan-build="">Build it<\/button>/);
  assert.match(open, /class="messages-bot-secondary" data-bot-plan-change="">Change something<\/button>/);
  const built = draw({ state: 'built', choices: ['Phone alert'] });
  assert.ok(!/Build it<\/button>/.test(built));
  assert.match(built, /How should it remind you\? Phone alert/);
  assert.match(built, /You chose Build it/);
  const replaced = draw({ state: 'replaced' });
  assert.match(replaced, /Replaced by a newer plan/);
  assert.ok(!/<li>/.test(replaced), 'a replaced plan folds its bullets away');
  const stopped = draw({ state: 'stopped' });
  assert.match(stopped, /<li>A list of your plants<\/li>/, 'a stopped plan keeps its bullets');
  assert.match(stopped, /I stopped waiting on this plan\. Reply to pick it up again\./);
  assert.match(draw({ state: 'changing' }), /You asked for changes\. A new plan is on its way\./);
  assert.match(draw({ state: 'closed' }), /No longer needed\./);
  assert.match(draw({ busy: true }), /data-bot-plan="built"/, 'Build it pressed here reads as chosen at once');
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
  const row = read('frontend/src/features/messages/message-row.tsx');
  assert.match(row, /isPlanMessage\(message\) \? \([\s\S]{0,200}<BotPlanCard /);
  const api = read('frontend/src/features/messages/api.ts');
  assert.match(api, /body: JSON\.stringify\(answers \? \{ choice, answers \} : \{ choice \}\)/);
  const css = read('public/css/app.css');
  assert.match(css, /\.messages-bot-answers button\[aria-pressed="true"\] \{ color: var\(--accent-ink\); background: var\(--accent\); \}/);
  const composer = read('frontend/src/features/messages/composer.tsx');
  assert.match(composer, /Say what to change, and Homeroom bot sends a new plan\. Only you see this\./);
});

test('B6: the App tab shows the same plan, in place of the chat button, and builds through the same endpoint', () => {
  const view = read('public/js/app-view.js');
  assert.match(view, /action: mine && !plan\s*\? \{ key: 'botChat'/);
  assert.match(view, /fetch\(`\/api\/conversations\/homeroom-bot\/actions\/\$\{id\}`, \{\s*method: 'POST',/);
  assert.match(view, /body: JSON\.stringify\(\{ choice: 'build', answers:/);
  assert.match(view, /messages\.quoteBotMessage\(conversationId, messageId\)/);
  const status = read('frontend/src/features/app-frame/app-status.tsx');
  assert.match(status, /\{view\.plan \? <FirstVersionPlanCard key=\{view\.plan\.actionId\} plan=\{view\.plan\} \/> : null\}/);
  assert.match(status, /call\('buildFirstVersion', plan\.slug, plan\.actionId, answers\)/);
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
  await set('homeroom_bot_dm_users', JSON.stringify(['maya']));
  await set('homeroom_bot_mode', 'live');
  await set('homeroom_bot_live_apps', JSON.stringify(['plant-pal']));
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
    assert.equal(await bot.awaitGo(pool, { runId: first, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot }), true);
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
    assert.equal(progress.stepNumber('plan', true), 3, 'Step 3 of 7: Write a plan');
    const fv = await dm.firstVersionState(pool, app.id);
    assert.equal(fv.stepName, 'Write a plan');
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

    const go = await readyRun();
    await bot.awaitGo(pool, { runId: go, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot });
    const goCard = await planMessage(go);
    const sent = await conversations.sendMessage(pool, maya, goCard.conversation_id, { content: 'Build it!', reply_to_id: goCard.id });
    const out = await dm.noteUserMessage(pool, {}, {
      user: maya, conversationId: goCard.conversation_id,
      message: { id: sent.messageId, content: 'Build it!', reply: { id: goCard.id } }, deps: { bot: homeroomBot },
    });
    const said = (await pool.query('SELECT content FROM conversation_messages WHERE id = $1', [out.messageId])).rows[0];
    assert.match(said.content, /^Building Plant Pal now, with what I suggested\./);
    assert.ok((await runRow(go)).live_build_waiting_at);
    assert.match((await runRow(go)).build_note, /How should it remind you\? In the app/);
  });

  await t.test('a first version nobody can be shown the plan of is built at once, as before plans', async () => {
    await set('homeroom_bot_dm_users', '[]');
    const lone = await readyRun();
    assert.equal(await bot.awaitGo(pool, { runId: lone, app, issueNumber: 1, parsed: { plan: PLAN }, bot: homeroomBot }), false);
    assert.equal((await runRow(lone)).awaiting_go_at, null);
    await set('homeroom_bot_dm_users', JSON.stringify(['maya']));
  });
});

test('B6: where the waiting state is read, and where it ends', () => {
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /if \(firstVersion && await awaitGo\(pool, \{ runId, app, issueNumber, parsed, bot, deps \}\)\) \{\s*acted = 'awaiting_go';/);
  assert.match(src, /await retireWaitingPlans\(pool, \{ appId: app\.id, issueNumber, why: 'the request was read again', deps: \{ dm: deps\.dm \} \}\);/);
  assert.match(src, /const stalePlans = await settleStalePlans\(pool, \{ dm: deps\.dm \}\);/);
  assert.match(src, /out\.skipped \+= \(await retireWaitingPlans\(pool, \{ appId, issues, why: why\.replace/);
  assert.match(src, /\.\.\.\(planChange \? \{ planChange: \{ \.\.\.planChange, requester: requester\.username \} \} : \{\}\),/);
  const progressSrc = read('src/services/homeroom-bot-progress.js');
  assert.match(progressSrc, /run\.awaiting_go_at AS plan_waiting_at/);
  assert.match(read('src/services/homeroom-bot-mayor.js'), /AND a\.kind <> 'build_plan'/);
  const schema = read('src/db/schema.sql');
  for (const column of ['plan JSONB', 'awaiting_go_at TIMESTAMPTZ', 'plan_change TEXT']) {
    assert.ok(schema.includes(`ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS ${column};`), column);
  }
  assert.equal(live.questionText({ question: 'Q?' }).includes('If nobody answers'), false);
});
