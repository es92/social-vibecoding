'use strict';

// A first version's plan, written at Make it (services/first-version-plan.js),
// and its questions asked on the made screen (frontend/src/features/
// first-session/made.tsx).
//
// Newcomer run four (12-13 October 2026, Club Votes): Make it, the project
// set up at 43 seconds, request #1 filed at 44, a triage turn of 33 seconds
// to write the plan, and the plan reached its maker as a card in their chat
// with Homeroom bot, whose Build it they found 4.5 minutes after Make it,
// only after the tour dead-ended and a reload. Now one model call writes the
// plan from the description the moment Make it is pressed, the made screen
// asks its questions with the suggested answers chosen and a Submit button,
// and the bot builds from that plan with no triage turn
// (tests/first-version-early-plan-postgres.test.js runs that against the
// real schema and routes).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MADE = 'frontend/src/features/first-session/made.tsx';

const fvPlan = require('../src/services/first-version-plan');

const REPLY = {
  plan: ['- Make a poll in a few taps', 'Everyone votes once', 'See who won — live'],
  choices: [
    { question: 'Who can make a poll?', answers: ['Anyone in the club', 'Only you'] },
    { question: 'When do results show?', answers: ['As votes come in', 'After everyone votes', 'When you close it'] },
    { question: 'A third one', answers: ['a', 'b'] },
  ],
  build_note: 'One screen: the open polls, newest first. Its primary action is New poll.',
  assumptions: ['Votes are anonymous'],
};

test('the reply is read as a triage verdict\'s plan is: bullets, at most two questions, a build note with its assumptions', () => {
  const plan = fvPlan.parsePlanReply(`Here you go\n${JSON.stringify(REPLY)}`);
  // No em dashes in what people read (em-dashes.js), whatever the model wrote.
  assert.deepEqual(plan.bullets, ['Make a poll in a few taps', 'Everyone votes once', 'See who won: live']);
  assert.equal(plan.questions.length, 2, 'at most two questions');
  assert.deepEqual(plan.questions[0], { question: 'Who can make a poll?', answers: ['Anyone in the club', 'Only you'] });
  assert.match(plan.buildNote, /^One screen: the open polls, newest first\. Its primary action is New poll\.\n\nAssumptions:\n- Votes are anonymous$/);
  assert.deepEqual(plan.assumptions, ['Votes are anonymous']);
  // No plan line, or no build note: no plan, and the triage plans it.
  assert.equal(fvPlan.parsePlanReply(JSON.stringify({ ...REPLY, plan: [] })), null);
  assert.equal(fvPlan.parsePlanReply(JSON.stringify({ ...REPLY, build_note: ' ' })), null);
  assert.equal(fvPlan.parsePlanReply('no json here'), null);
  assert.equal(fvPlan.parsePlanReply('{not json}'), null);
  // A question with one answer is no question; none at all is a plan that asks nothing.
  const none = fvPlan.parsePlanReply(JSON.stringify({ ...REPLY, choices: [{ question: 'Q?', answers: ['only'] }] }));
  assert.deepEqual(none.questions, []);
});

test('run five: the shapes a model sends for "a few lines" are forgiven; a missing field is not', () => {
  // The plan as one string: a bullet a line, numbered or not.
  for (const plan of ['- Make a poll\n- Everyone votes once\n\n- See who won', '1. Make a poll\r\n2) Everyone votes once\n3. See who won']) {
    assert.deepEqual(fvPlan.parsePlanReply(JSON.stringify({ ...REPLY, plan })).bullets,
      ['Make a poll', 'Everyone votes once', 'See who won'], plan);
  }
  // The build note as a list of lines, the ones that are not text left out.
  const lines = fvPlan.parsePlanReply(JSON.stringify({ ...REPLY, build_note: ['One screen: the open polls.', 7, 'Its primary action is New poll.'] }));
  assert.match(lines.buildNote, /^One screen: the open polls\.\nIts primary action is New poll\.\n\nAssumptions:\n- Votes are anonymous$/);
  for (const field of ['plan', 'build_note']) {
    assert.equal(fvPlan.parsePlanReply(JSON.stringify({ ...REPLY, [field]: undefined })), null, `no ${field}`);
    assert.equal(fvPlan.usableAnswer({ ...REPLY, [field]: undefined }), false, `no ${field}`);
  }
  assert.equal(fvPlan.usableAnswer(REPLY), true);
  assert.equal(fvPlan.usableAnswer({ ...REPLY, plan: 'Make a poll' }), true, 'one line is a plan of one');
  // GLM is asked for three lines and a real note; Haiku's structured output
  // is sent the schema without the bounds (tests/helper-model.test.js).
  assert.equal(fvPlan.PLAN_SCHEMA.properties.plan.minItems, 3);
  assert.equal(fvPlan.PLAN_SCHEMA.properties.build_note.minLength, 40);
  // What a refused reply looked like, never what it said (the whole shape:
  // tests/first-version-plan-shape.test.js).
  const refused = fvPlan.replyShape(JSON.stringify({ plan: 'Polls for the club', build_note: [] }));
  assert.deepEqual([refused.why, refused.keys], ['no_note', [
    { key: 'plan', type: 'string', length: 18 }, { key: 'build_note', type: 'array', length: 0, items: [] }]]);
  assert.deepEqual([fvPlan.replyShape('sorry').why, fvPlan.replyShape('sorry').chars], ['no_json', 5]);
});

test('the prompt: the description, its creator, its real people, a game starter and the language, with the triage\'s rules', () => {
  const prompt = fvPlan.planUserPrompt({
    name: 'Club Votes', brief: 'Polls for our running club', maker: { username: 'evan' }, locale: 'es',
    members: { people: [{ username: 'evan', creator: true }, { username: 'maya', name: 'Maya Lin', invited: true }] },
  });
  assert.match(prompt, /APP NAME:\nClub Votes/);
  assert.match(prompt, /THE CREATOR:\n@evan/);
  assert.match(prompt, /==== WHO IS IN THIS PROJECT ====[\s\S]*- @evan, who made the project\n- Maya Lin \(@maya\), invited and not joined yet/);
  assert.match(prompt, /locale `es`/);
  assert.match(prompt, /WHAT IT SHOULD DO \(the creator's words\):\nPolls for our running club$/);
  assert.doesNotMatch(prompt, /STARTER:/);
  const game = fvPlan.planUserPrompt({ name: 'Ladders', brief: 'A board game', starter: 'game-board' });
  assert.match(game, /STARTER:\nIt is made from Homeroom's .*: a working turn-based board game/);
  assert.match(game, /never by starting over/);
  // The note's rules, for a call that reads the description only.
  for (const rule of [/3 to 5 short lines/, /at most 2 decisions/, /never the look or the theme/, /ONE signature element/,
    /light and a dark look/, /Sample names, dates and numbers are placeholders/, /no em dashes/]) {
    assert.match(fvPlan.PLAN_SYSTEM, rule);
  }
  // App bench run 196 (Club Votes): a plan narrower than the description's
  // own examples, kept by the spec, failed 8 of 15 blind-graded builds.
  const flatPlan = fvPlan.PLAN_SYSTEM.replace(/\s+/g, ' ');
  assert.match(flatPlan, /Kept to its core, never narrower than its words: it can do each example the description gives\. Where people choose or decide something \("which day", "which film"\), plan the options they pick between, written by whoever asks; plain yes or no only where the description asks for that\./);
  assert.deepEqual(fvPlan.PLAN_SCHEMA.required, ['plan', 'choices', 'build_note', 'assumptions']);
});

test('the plan is asked of the configuration\'s triage model through the helper path, and paid for by its maker', async () => {
  const calls = [];
  const spent = [];
  const deps = {
    llm: {
      isEnabled: () => true,
      estimateCostCents: () => 0.4,
      async generateFirstVersionPlan(args) { calls.push(args); return { text: JSON.stringify(REPLY), usage: { input_tokens: 10 }, model: 'z-ai/glm-5.3-flash' }; },
    },
    limits: { async recordSpend(_pool, userId, cents) { spent.push([userId, cents]); } },
    bot: { projectMembers: async () => null, starterOfApp: async () => null },
    botConfigs: { async currentVersion() { return { recipe: { models: { triage: 'z-ai/glm-5.3-flash' } } }; } },
  };
  const pool = { async query() { return { rows: [{ username: 'evan', locale: null }] }; } };
  const made = await fvPlan.makePlan(pool, { app: { id: 3, name: 'Club Votes' }, user: { id: 7 }, brief: 'Polls', deps });
  assert.equal(made.error, null);
  assert.equal(made.model, 'z-ai/glm-5.3-flash');
  assert.equal(made.plan.questions.length, 2);
  assert.equal(calls[0].model, fvPlan.PLAN_MODEL);
  assert.equal(calls[0].schema, fvPlan.PLAN_SCHEMA);
  assert.equal(calls[0].validate, fvPlan.usableAnswer, 'a GLM answer the parse refuses goes to Haiku');
  assert.deepEqual(spent, [[7, 0.4]]);
  // Too slow: no plan, and the triage plans it.
  const slow = await fvPlan.makePlan(pool, {
    app: { id: 3, name: 'Club Votes' }, user: { id: 7 }, brief: 'Polls',
    deps: { ...deps, waitMs: 5, llm: { ...deps.llm, generateFirstVersionPlan: () => new Promise((r) => setTimeout(() => r({ text: '{}' }), 50)) } },
  });
  assert.deepEqual([slow.plan, slow.error], [null, 'timeout']);
  const unusable = await fvPlan.makePlan(pool, {
    app: { id: 3, name: 'Club Votes' }, user: { id: 7 }, brief: 'Polls',
    deps: { ...deps, llm: { ...deps.llm, async generateFirstVersionPlan() { return { text: 'sorry', usage: null }; } } },
  });
  assert.deepEqual([unusable.plan, unusable.error], [null, 'unusable_reply']);
  assert.deepEqual([unusable.shape.why, unusable.shape.chars], ['no_json', 5], 'its shape, kept for the row and the log');
  // A configuration whose triage is not a helper model still asks the helper model.
  assert.equal(await fvPlan.planModel(pool, { botConfigs: { async currentVersion() { return { recipe: { models: { triage: 'anthropic/claude-opus-5.5' } } }; } } }), fvPlan.PLAN_MODEL);
  // The helper is registered as the sketch's is (llm.js helperMessage; tests/helper-model.test.js).
  const llm = require('../src/services/llm');
  assert.equal(typeof llm.generateFirstVersionPlan, 'function');
  assert.ok(llm.HELPER_TIME_LIMIT_MS.first_version_plan > llm.HELPER_TIME_LIMIT_MS.app_sketch);
  assert.equal(fvPlan.PLAN_MODEL, llm.HELPER_MODEL);
});

test('started once, only for a first version the bot builds, and never without a model', async () => {
  const sql = [];
  let claim = [{ app_id: 3 }];
  const pool = { async query(text, params) { sql.push({ text, params }); return { rows: /SET early_plan_status = 'pending'/.test(text) ? claim : [] }; } };
  const deps = {
    llm: { isEnabled: () => true, estimateCostCents: () => 0, async generateFirstVersionPlan() { return { text: JSON.stringify(REPLY) }; } },
    limits: { async recordSpend() {} },
    bot: { projectMembers: async () => null, starterOfApp: async () => null },
    botConfigs: { async currentVersion() { return null; } },
  };
  assert.equal(await fvPlan.startEarlyPlan(pool, { app: { id: 3, name: 'Club Votes' }, user: { id: 7 }, brief: 'Polls' }, deps), true);
  assert.match(sql[0].text, /WHERE app_id = \$1 AND user_id = \$2 AND bot_builds = TRUE AND early_plan_status IS NULL/);
  await fvPlan._pendingForTests.get(3);
  const saved = sql.find((q) => /SET early_plan_status = \$2, early_plan = \$3::jsonb/.test(q.text));
  assert.equal(saved.params[1], 'ready');
  assert.deepEqual(JSON.parse(saved.params[2]).bullets.length, 3);
  claim = [];
  assert.equal(await fvPlan.startEarlyPlan(pool, { app: { id: 3 }, user: { id: 7 }, brief: 'Polls' }, deps), false, 'claimed already');
  assert.equal(await fvPlan.startEarlyPlan(pool, { app: { id: 3 }, user: { id: 7 }, brief: 'Polls' }, { ...deps, llm: { isEnabled: () => false } }), false, 'no model');
  // From the made screen's doors only (routes/apps.js MAKE_ORIGINS).
  const route = read('src/routes/apps.js');
  assert.match(route, /homeroomBotDm\.startFirstVersion\(pool, config, \{\s+app: appRow, user: req\.user, brief: req\.body\.brief,[\s\S]*?earlyPlan: MAKE_ORIGINS\.has\(req\.body\.from\),/);
  assert.match(read('src/services/homeroom-bot-dm.js'),
    // And, since newcomer run six, the server's config and the bot, for the
    // early first look drawn from the plan (tests/first-version-early-look.test.js).
    /if \(bot && earlyPlan\) await require\('\.\/first-version-plan'\)\.startEarlyPlan\(pool, \{ app, user, brief: text, config, bot \}\);/);
});

test('a plan\'s state: pending until written (a stopped process\'s reads failed), decided once answered or when it asks nothing', () => {
  const now = Date.parse('2026-10-13T10:00:00Z');
  const row = (over) => ({ created_at: '2026-10-13T09:59:30Z', early_plan_status: 'ready', early_plan: { bullets: ['a'], questions: [], buildNote: 'n' }, answered_at: null, ...over });
  assert.equal(fvPlan.planStatus(null), 'none');
  assert.equal(fvPlan.planStatus(row({ early_plan_status: null })), 'none');
  assert.equal(fvPlan.planStatus(row({ early_plan_status: 'pending' }), now), 'pending');
  assert.equal(fvPlan.planStatus(row({ early_plan_status: 'pending', created_at: '2026-10-13T09:50:00Z' }), now), 'failed');
  assert.equal(fvPlan.planStatus(row({ early_plan: null }), now), 'failed', 'ready with nothing to read');
  assert.equal(fvPlan.decided(row()), true, 'asks nothing');
  const asks = { bullets: ['a'], questions: [{ question: 'Q?', answers: ['x', 'y'] }], buildNote: 'n' };
  assert.equal(fvPlan.decided(row({ early_plan: asks })), false);
  assert.equal(fvPlan.decided(row({ early_plan: asks, answered_at: '2026-10-13T10:00:00Z' })), true);
  assert.equal(fvPlan.decided(row({ early_plan_status: 'failed', early_plan: null })), false);
  // Answers: one each, an offered one or null for the suggested one.
  assert.deepEqual(fvPlan.cleanAnswers(asks.questions, ['y']), ['y']);
  assert.deepEqual(fvPlan.cleanAnswers(asks.questions, ['made up']), [null]);
  assert.deepEqual(fvPlan.cleanAnswers(asks.questions, []), [null]);
  assert.deepEqual(fvPlan.answersOf({ answered_at: 'x', answers: ['y', 3] }), ['y', null]);
  assert.equal(fvPlan.answersOf({ answered_at: null, answers: ['y'] }), null);
});

test('schema: the plan, its answers and when, on the first version\'s row, idempotently', () => {
  const schema = read('src/db/schema.sql');
  for (const col of ['early_plan JSONB', 'early_plan_status TEXT', 'early_plan_at TIMESTAMPTZ', 'early_plan_error TEXT', 'answers JSONB', 'answered_at TIMESTAMPTZ']) {
    assert.ok(schema.includes(`ALTER TABLE homeroom_bot_first_versions ADD COLUMN IF NOT EXISTS ${col};`), col);
  }
  assert.match(schema, /DROP CONSTRAINT IF EXISTS homeroom_bot_first_versions_early_plan_check;\s+ALTER TABLE homeroom_bot_first_versions ADD CONSTRAINT homeroom_bot_first_versions_early_plan_check\s+CHECK \(early_plan_status IS NULL OR early_plan_status IN \('pending', 'ready', 'failed'\)\);/);
});

test('the bot builds from the plan at Make it with no triage turn, and goes ahead at once when it is decided', () => {
  const src = read('src/services/homeroom-bot.js');
  // Only a first version, after its card is started, and before any turn.
  const call = src.indexOf('const early = await planFromEarly(pool, config, {');
  assert.ok(call > src.indexOf('await retireWaitingPlans(pool, { appId: app.id, issueNumber, why: \'the request was read again\''));
  assert.ok(call < src.indexOf('session = await ensureBotSession(pool, config, bot, app);'));
  assert.match(src, /if \(requester\?\.firstVersion\) \{\s+const early = await planFromEarly/);
  // A plan someone asked to change, a restart's read, or a request already planned is the triage's.
  assert.match(src, /if \(item\.reason === 'plan_change' \|\| item\.reason === RESTART_REASON \|\| item\.reason === READ_AGAIN_REASON\) return null;/);
  // The run: a ready verdict with the plan's lines and choices and its build note.
  assert.match(src, /plan: \{ bullets: plan\.bullets, questions: plan\.questions \}, complicated: false, platform: false,/);
  // Decided: a quiet card, and Build it done for them.
  assert.match(src, /\.\.\.\(decidedNow \? \{ quietPlan: true \} : \{\}\),/);
  assert.match(src, /return sendRunPlan\(pool, \{ runId, app, issueNumber, plan, bot, deps, quiet: parsed\?\.quietPlan === true \}\);/);
  assert.match(src, /if \(acted === PLAN_ACTED\.waiting \|\| acted === PLAN_ACTED\.unsent\) \{\s+const went = await goAheadIfDecided/);
  const dm = read('src/services/homeroom-bot-dm.js');
  assert.match(dm, /\.\.\.\(quiet \? \{ moment: null \} : \{\}\),/);
  // Through its card when it has one: the same decision Build it makes,
  // but with the plan's bullets never shown to its maker (run seven).
  assert.match(dm, /if \(action\) return decidePlanTap\(pool, \{ user: \{ id: userId \}, action, choice: 'build', answers: picks, deps, planShown: false \}\);/);
  // And Build it in the chat notes the plan decided, for the steps.
  assert.match(dm, /await require\('\.\/first-version-plan'\)\.noteDecided\(pool, \{\s+appId: went\.appId, issueNumber: went\.issueNumber, answers: went\.chosen\.map\(\(c\) => c\.answer\),/);
});

test('Submit: a maker-only, member-gated route that keeps the answers once', () => {
  const route = read('src/routes/apps.js');
  assert.match(route, /router\.post\('\/api\/apps\/:slug\/first-version\/answers', sameOriginBrowserOnly, communities\.requireAppMembership\(pool\), async/);
  const dm = read('src/services/homeroom-bot-dm.js');
  assert.match(dm, /if \(Number\(row\.user_id\) !== Number\(user\?\.id\)\) return \{ ok: false, status: 403, error: 'not_the_maker' \};/);
  assert.match(read('src/services/first-version-plan.js'), /WHERE app_id = \$1 AND user_id = \$2 AND bot_builds = TRUE AND answered_at IS NULL/);
  // GET /api/apps/:slug tells its maker alone.
  assert.match(route, /\.\.\.\(mine && state\.early \? \{ early: state\.early \} : \{\}\),/);
});

// ── The made screen ──

const QS = [
  { question: 'Who can make a poll?', answers: ['Anyone in the club', 'Only you'] },
  { question: 'When do results show?', answers: ['As votes come in', 'After everyone votes'] },
];

test('the made screen asks the plan\'s questions: the waiting card\'s, else the plan from Make it while unanswered', () => {
  const { askedQuestions } = loadTsx(MADE);
  assert.equal(askedQuestions(null), null);
  assert.equal(askedQuestions({ early: { status: 'pending' } }), null, 'still being written: the screen is as it was');
  assert.deepEqual(askedQuestions({ early: { status: 'ready', bullets: ['a'], questions: QS, answered: false } }), QS);
  assert.equal(askedQuestions({ early: { status: 'ready', bullets: ['a'], questions: QS, answered: true } }), null);
  assert.equal(askedQuestions({ early: { status: 'ready', bullets: ['a'], questions: [], answered: false } }), null, 'asks nothing');
  assert.equal(askedQuestions({ ready: true, early: { status: 'ready', questions: QS } }), null);
  const waiting = { bullets: ['a'], questions: [QS[1]], actionId: 4 };
  assert.deepEqual(askedQuestions({ plan: waiting, early: { status: 'ready', questions: QS } }), [QS[1]], 'the card waiting for Build it wins');
  assert.equal(askedQuestions({ plan: { ...waiting, questions: [] } }), null, 'a waiting plan with nothing to ask is the chat\'s, as before');
});

test('the questions: the heading, the line, each question with its suggested answer chosen, and Submit', () => {
  const { QuickQuestions, questionsTitle, answersUrl } = loadTsx(MADE);
  assert.equal(questionsTitle(1), 'One quick question');
  assert.equal(questionsTitle(2), 'Two quick questions');
  assert.equal(message('onboarding:firstSession.made.questions.line', { project: 'Club Votes' }), 'Homeroom bot builds Club Votes from your answers.');
  assert.equal(answersUrl('club votes'), '/api/apps/club%20votes/first-version/answers');
  const html = renderToHtml(createElement(QuickQuestions, { name: 'Club Votes', questions: QS, onSubmit() {} }));
  assert.match(html, /data-first-session-questions="2"/);
  assert.match(html, /<h2 [^>]*>Two quick questions<\/h2>/);
  assert.match(html, />Homeroom bot builds Club Votes from your answers\.<\/p>/);
  // The suggested answers chosen: the first of each, as the plan card does it.
  assert.equal((html.match(/checked=""/g) || []).length, 2);
  assert.match(html, /checked="" value="Anyone in the club"/);
  assert.match(html, /checked="" value="As votes come in"/);
  assert.match(html, /<button type="button" data-first-session-questions-submit=""[^>]*>Submit<\/button>/);
  assert.match(html, /rounded-\[20px\] bg-white/);
  assert.doesNotMatch(html, /—/);
  // The plan card's own choices, shared (PlanChoices).
  const view = read('frontend/src/features/messages/bot-plan-view.tsx');
  assert.match(view, /\{open \? <PlanChoices questions=\{plan\.questions\} picked=\{picked\} onPick=\{choose\} idBase=\{uid\} \/> : null\}/);
});

test('the made screen: the questions in place of the invite line until answered, then today\'s screen with the bot building', () => {
  const src = read(MADE);
  const ask = src.indexOf('{asked && !stalled ? (');
  assert.ok(ask > src.indexOf('<SketchCard made='), 'under the project');
  assert.ok(ask < src.indexOf('data-first-session-hint='), 'in place of the invite line and its buttons');
  assert.match(src, /const asked = answered \? null : askedQuestions\(fv\);/);
  assert.match(src, /const res = await fetch\(answersUrl\(made\.slug\), \{\s+method: 'POST',/);
  assert.match(src, /const line: BuildLineState \| null = answered && \(served === 'planning' \|\| served === 'plan'\) \? 'building'\s+: asked && served === 'plan' \? 'planning' : served;/);
  // Read as often as the setup while the plan is still being written.
  assert.match(src, /const t = window\.setInterval\(read, settingUp \|\| planComing \? READY_POLL_MS : lookWaits \? FIRST_LOOK_POLL_MS : 10000\);/);
  const { MadeScreen } = loadTsx(MADE);
  const html = renderToHtml(createElement(MadeScreen, {
    made: { slug: 'club-votes', name: 'Club Votes', emoji: '🗳️', description: null, example: null, conversationId: 12 },
    me: 'evan', onContinue() {}, onOpenChat() {},
  }));
  assert.doesNotMatch(html, /data-first-session-questions/, 'nothing asked before a plan is read');
  // Run five: before the first read, no invite buttons to skip the questions
  // with. Run six: one spinner over the line, and nothing else under way.
  assert.match(html, /<div role="status" data-first-session-checking=""[^>]*><svg[^>]*animate-spin[^>]*>[\s\S]*?<\/svg><p>Checking whether Homeroom bot needs to ask you anything first\.<\/p><\/div>/);
  assert.doesNotMatch(html, />Share invite<\/button>/);
  assert.doesNotMatch(html, /Invite people later/);
});

// ── Newcomer run five (13 Oct 2026, Club Votes) ──

test('run five, 1b: no invite buttons while the plan may still ask something, for at most a minute', () => {
  const { checksForQuestions, PLAN_CHECK_MS, CHECKING_LINE, MadeScreen } = loadTsx(MADE);
  assert.equal(PLAN_CHECK_MS, 60000);
  assert.equal(message(CHECKING_LINE), 'Checking whether Homeroom bot needs to ask you anything first.', 'the approved canvas\'s words');
  const bot = { makesPlan: true, read: true, waited: false };
  assert.equal(checksForQuestions(null, { ...bot, read: false }), true, 'before the first read');
  assert.equal(checksForQuestions({ early: { status: 'pending' } }, bot), true, 'its plan is being written');
  assert.equal(checksForQuestions({ early: { status: 'ready', questions: QS, answered: false } }, bot), false, 'the questions take the place');
  assert.equal(checksForQuestions({ early: { status: 'ready', questions: [], answered: false } }, bot), false, 'asks nothing: the invite buttons');
  assert.equal(checksForQuestions({ step: 1, of: 7 }, bot), false, 'failed (no plan said): the invite buttons');
  assert.equal(checksForQuestions(null, bot), false, 'read, and nothing to build: the invite buttons');
  assert.equal(checksForQuestions({ early: { status: 'pending' } }, { ...bot, waited: true }), false, 'still pending after a minute: the invite buttons');
  assert.equal(checksForQuestions(null, { ...bot, read: false, waited: true }), false);
  assert.equal(checksForQuestions(null, { ...bot, makesPlan: false, read: false }), false, 'an import, a ready-made app, or nothing for the bot to build');
  // A project the bot does not build opens on its invite buttons, as before.
  const html = renderToHtml(createElement(MadeScreen, {
    made: { slug: 'club-votes', name: 'Club Votes', emoji: null, description: null, example: null, conversationId: null },
    me: 'evan', onContinue() {}, onOpenChat() {},
  }));
  assert.match(html, />Share invite<\/button>/);
  assert.doesNotMatch(html, /data-first-session-checking/);
  const imported = renderToHtml(createElement(MadeScreen, {
    made: { slug: 'club-votes', name: 'Club Votes', emoji: null, description: null, example: null, conversationId: 12, imported: true },
    me: 'evan', onContinue() {}, onOpenChat() {},
  }));
  assert.match(imported, />Share invite<\/button>/);
  // Wired: questions first, then the line, then the buttons.
  const src = read(MADE);
  const questions = src.indexOf('{asked && !stalled ? (');
  const checking = src.indexOf(') : checking ? (');
  assert.ok(questions > 0 && checking > questions && checking < src.indexOf('data-first-session-hint='));
  assert.match(src, /const checking = !asked && !stalled && checksForQuestions\(fv, \{ makesPlan: botBuilds && !imported && !readyMade, read: readOnce, waited: planWaited \}\);/);
  assert.match(src, /const t = window\.setTimeout\(\(\) => setPlanWaited\(true\), PLAN_CHECK_MS\);/);
});

test('run five, 2: while the questions are asked here, the line says the bot is planning it, not that the plan is ready to review', () => {
  const src = read(MADE);
  // The chat's card asks the same questions: the line does not send them there.
  assert.match(src, /: asked && served === 'plan' \? 'planning' : served;/);
  assert.match(src, /const plainLine = named\.words \|\| \(line === 'planning' && served === 'plan' \? translate\(BUILD_LINE_WORDS\.planning\)/);
  assert.equal(message('onboarding:buildLine.planning'), 'Homeroom bot is planning it');
  // Its card for the chat is not drawn over the questions either.
  assert.match(src, /\{plan && !stalled && fromCreate && !asked \? <PlanWaitsCard/);
});

test('run five, 3: the lines over the questions hold their height whatever they say, so Submit stays under the finger', () => {
  const { SetupProgress, SETUP_ROW, SETUP_NOTE } = loadTsx(MADE);
  // The setup card: one height in every state, its title one line, its note at most two.
  assert.match(SETUP_ROW, /(^| )h-\[84px\]( |$)/);
  assert.match(SETUP_NOTE, /line-clamp-2/);
  const heights = [
    { step: 0, slow: false, waitedOut: false },
    { step: 2, slow: false, waitedOut: false },
    { step: 4, slow: true, waitedOut: true },
    { step: 4, slow: false, waitedOut: false, done: { line: 'Homeroom bot is planning it', busy: true } },
    { step: 4, slow: false, waitedOut: false, done: { line: 'A much longer line that would wrap onto a second line on a phone', busy: false } },
  ].map((props) => {
    const html = renderToHtml(createElement(SetupProgress, props));
    assert.match(html, /<p class="truncate text-\[15px\] font-\[650\] leading-5">/, 'the title on one line');
    assert.match(html, /<p class="line-clamp-2 text-\[13px\] leading-\[18px\]/, 'the note on at most two');
    return html.match(/<div class="([^"]*rounded-\[20px\][^"]*)"/)[1];
  });
  assert.equal(new Set(heights).size, 1, 'the same box whatever it says');
  // The plain card's build line: one line, a fixed height.
  const src = read(MADE);
  assert.match(src, /data-first-session-build-row="" className="mt-4 flex h-5 [^"]*"/);
  assert.match(src, /<span data-first-session-build="" className="min-w-0 truncate">\{plainLine\}<\/span>/);
  // Over a sketch, the build line is one line of a fixed least height (BuildLine).
  const line = read('frontend/src/features/first-session/build-line.tsx');
  assert.match(line, /className=\{`flex min-h-\[24px\] min-w-0 items-center gap-2 text-\[15px\] leading-5 /);
  assert.match(line, /<span className="truncate">/);
});

test('the server says the bot builds it once its plan is decided, not that it plans it', async () => {
  const dm = require('../src/services/homeroom-bot-dm');
  const progress = require('../src/services/homeroom-bot-progress');
  const ROW = {
    app_id: 5, user_id: 7, status: 'waiting', issue_number: null, merged: false, created_at: new Date().toISOString(),
    slug: 'club-votes', name: 'Club Votes', app_status: 'creating', username: 'evan', conversation_id: 12,
    early_plan_status: 'ready', early_plan: { bullets: ['a'], questions: QS, buildNote: 'n' }, answers: null, answered_at: null,
  };
  const state = async (row, viewerId = 7) => dm.firstVersionState({ async query() { return { rows: [row] }; } }, 5, { viewerId, progress });
  const asking = await state(ROW);
  assert.equal(asking.line, 'planning');
  assert.deepEqual(asking.early, { status: 'ready', bullets: ['a'], questions: QS, answered: false });
  assert.equal((await state(ROW, 99)).early, undefined, 'its maker\'s alone');
  const answered = await state({ ...ROW, answered_at: '2026-10-13T10:00:30Z', answers: [null, null] });
  assert.equal(answered.line, 'building', 'Submit: the bot is building it');
  assert.equal(answered.early.answered, true);
  const asksNothing = await state({ ...ROW, early_plan: { bullets: ['a'], questions: [], buildNote: 'n' } });
  assert.equal(asksNothing.line, 'building', 'a plan with nothing to ask is decided');
  assert.deepEqual((await state({ ...ROW, early_plan_status: 'pending', early_plan: null })).early, { status: 'pending' });
  // N4: the steps from the start: the plan the one under way.
  assert.deepEqual(asking.steps.map((s) => [s.key, s.state]), [['plan', 'now'], ['screens', 'next'], ['build', 'next'], ['check', 'next'], ['test', 'next'], ['live', 'next']]);
  // Answered while the project is still set up: the plan is done, the screens next in hand.
  assert.deepEqual(answered.steps.slice(0, 3).map((s) => [s.key, s.state]), [['plan', 'done'], ['screens', 'now'], ['build', 'next']]);
  // Run five: and the build is starting, named so on every screen; nothing drawn yet.
  assert.deepEqual(answered.phase, { key: 'starting', since: '2026-10-13T10:00:30.000Z' });
  assert.equal(asksNothing.phase.key, 'starting');
  assert.equal(asking.phase, undefined, 'not while its questions wait');
});
