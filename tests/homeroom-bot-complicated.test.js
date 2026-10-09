'use strict';

// #4488: a complicated change is checked with its requester first, and its
// screens are reviewed once it is built.
//
// The triage of a request on a project that already exists can label a
// `ready` verdict `complicated` (a new screen or kind of thing, a change to
// how people get around or what it stores, two quite different ways to do
// it, or large). Such a change is not built at once: its build slot drafts
// the spec first, with its before and after screens, and it is shown to its
// requester with Build it and Change something, on the request (shared with
// the group, and on GitHub) and as the plan card in their DM with the bot.
// It never builds without an answer. Build it builds exactly that spec, with
// the choices in its build note; Change something posts their words on the
// request and plans it again. Once built, its screens go through the check
// round a first version gets. Small changes still go straight to a proposal,
// and first versions are exactly as they were.
//
// Run with: TEST_DATABASE_URL=postgres://… node --test tests/homeroom-bot-complicated.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const bot = require('../src/services/homeroom-bot');
const dm = require('../src/services/homeroom-bot-dm');
const live = require('../src/services/homeroom-bot-live');
const configs = require('../src/services/bot-configs');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const fence = (obj) => `Done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

const PLAN = {
  bullets: ['A weekly leaderboard tab', 'Points for each chore done'],
  questions: [{ question: 'Who shows on the leaderboard?', answers: ['Everyone in the flat', 'Only people who opt in'] }],
};
const REVIEWER = { model: 'anthropic/claude-opus-5.5', maxRounds: 3, budgetMinutes: 25 };
const CURRENT = {
  id: 11, key: 'fv', label: 'First versions', version: 1, role: 'current',
  recipe: { models: { triage: 'z/glm', spec: 'a/opus', build: 'z/glm' }, reviewer: REVIEWER, pack: null },
};

// ── The triage ──

test('the triage labels a ready change complicated only when it says so, and only a ready one', () => {
  const ready = (extra) => bot.parseVerdict(fence({ verdict: 'ready', build_note: 'Add a leaderboard tab.', ...extra }));
  const yes = ready({ complicated: true, plan: PLAN.bullets, choices: PLAN.questions });
  assert.equal(yes.verdict, 'ready');
  assert.equal(yes.complicated, true);
  assert.deepEqual(yes.plan, PLAN, 'its plan and choices, as a first version\'s are read');
  assert.equal(ready({}).complicated, false, 'no label: built straight away');
  assert.equal(ready({ complicated: 'yes' }).complicated, false, 'only a real true');
  const question = bot.parseVerdict(fence({
    verdict: 'question', question: 'Which tab?', default: 'A', answers: ['A', 'B'],
    blocker: 'user_facing', why_default_fails: 'x', complicated: true,
  }));
  assert.equal(question.complicated, false, 'a question is never complicated');
  assert.equal(bot.parseVerdict(fence({ verdict: 'person', reason: 'x', complicated: true })).complicated, false);
});

test('the triage prompt says what counts as complicated, leaning towards building straight away', () => {
  const md = read('src/prompts/homeroom-bot-triage.md');
  const flat = md.replace(/\s+/g, ' ');
  assert.match(flat, /Then set `complicated`, leaning towards false: a `ready` change becomes a proposal with before and after screenshots, which is its check\. True ONLY when, on an existing app, it:/);
  assert.match(md, /- adds a new screen or a new kind of thing to the app \(a leaderboard, sign-up, a new tab\);/);
  assert.match(md, /- changes how people get around the app, or what it stores;/);
  assert.match(md, /- could reasonably be done two quite different ways, so a quick look first saves a wasted build;/);
  assert.match(md, /- is large: several screens at once, or more than about a day's work for a person\./);
  assert.match(flat, /Copy changes, fixes, small tweaks and requests that spell out exactly what to do are never complicated\./);
  assert.match(md, /"complicated": true \(verdict ready, by the test above; never a first version\),/);
  const triage = read('src/services/homeroom-bot.js');
  assert.match(triage, /if \(parsed\.complicated && requester\?\.firstVersion\) parsed = \{ \.\.\.parsed, complicated: false \};/,
    'a first version drops the label');
  assert.match(triage, /plan: parsed\.plan, aboutPlatform: !!parsed\.platform, complicated: !!parsed\.complicated,/, 'recorded on the run');
  assert.match(read('src/db/schema.sql'), /ALTER TABLE homeroom_bot_runs ADD COLUMN IF NOT EXISTS complicated BOOLEAN;/);
});

test('a complicated plan counts against the daily questions and notes; a small change does not', async () => {
  const seen = [];
  const counting = (n) => ({ async query(sql, params) { seen.push([String(sql), params]); return { rows: [{ cnt: n }] }; } });
  assert.equal(await bot.planTripwire(counting(10), 2), 'question_tripwire');
  assert.equal(await bot.planTripwire(counting(9), 2), null);
  assert.ok(seen.some(([sql]) => /verdict = ANY\(\$2::text\[\]\) OR complicated IS TRUE/.test(sql)), 'plans asked count as questions do');
  const src = read('src/services/homeroom-bot.js');
  assert.match(src, /const capSuppressed = await simulateCaps\(pool, bot, app\.id, parsed\.verdict, settings\)\n\s+\|\| \(parsed\.complicated \? await planTripwire\(pool, app\.id\) : null\);/,
    'only a complicated change: a small one is not asked about');
  assert.match(live.heldText({ cap: 'question_tripwire', verdict: 'plan', limit: 10 }),
    /^Homeroom bot has a plan for this request, but it has already posted 10 questions and notes on this app in the last day\./);
});

// ── What it says ──

test('the plan is posted on the request and GitHub to read and answer; the build that follows does not post it again', () => {
  const text = live.planCommentText({ spec: '# Leaderboard\n\nA weekly leaderboard.', questions: PLAN.questions });
  assert.match(text, /^Homeroom bot wrote a plan for this request, with its before and after screens, and will build it once the person who asked for it says Build it\. On Homeroom they can reply "build it" on this request when it looks right, or say what to change and it will plan it again\./);
  assert.match(text, /One choice for them, or it goes with what it suggests:\n- Who shows on the leaderboard\? \(suggested: Everyone in the flat\)/);
  assert.match(text, /<details><summary>The plan<\/summary>\n\n# Leaderboard/);
  assert.doesNotMatch(text, /@/, 'nobody is @mentioned on GitHub');
  const card = live.specCard({ sessionId: 5, version: 1, spec: '# Leaderboard\n\nx', bot: { id: 1, username: 'homeroom_bot' }, asking: true });
  assert.equal(card.msgType, 'spec_share');
  assert.equal(card.metadata.specShare.sessionId, 5, 'its card opens the spec, with its screens');
  assert.match(card.content, /^📋 Homeroom bot's plan for this request: "Leaderboard", with its before and after screens\. It builds nothing until the person who asked says so: reply "build it" here/);
  assert.match(live.specCard({ sessionId: 5, version: 1, spec: '# Leaderboard', bot: { id: 1 }, approved: true }).content,
    /^📋 Homeroom bot is building the plan that was approved: "Leaderboard"\.$/);
  assert.doesNotMatch(live.specCommentText('# Leaderboard', { approved: true }), /<details>/, 'not the spec a second time');
  assert.match(live.specCommentText('# Leaderboard'), /<details><summary>The plan<\/summary>/, 'every other build as before');
  assert.ok(live.tagsPoster('plan'), 'its requester is tagged on the request, unless their DM reached them');
});

test('the DM card names the request, and its words say its screens are there', () => {
  const words = dm.planCardText({ appName: 'Chores', plan: { ...PLAN, complicated: true }, issueNumber: 12 });
  assert.match(words, /^Before I build \*\*Chores\*\* request #12, here's my plan:\n\n- A weekly leaderboard tab\n- Points for each chore done\n\nOne choice for you, or I'll go with what I suggest\.\n\nIts before and after screens are on the request\. Tap Build it when it looks right, or Change something\.$/);
  assert.match(dm.planCardText({ appName: 'Chores', plan: PLAN }), /^Here's my plan for \*\*Chores\*\*:/, 'a first version\'s, as it was');
  assert.equal(dm.isPlanGoWord('Build it!'), true);
  assert.equal(dm.isPlanGoWord('  yes please. '), true);
  assert.equal(dm.isPlanGoWord('build it but make it blue'), false);
});

test('the plan card for an existing project says where its screens are and where changes go', () => {
  const { PlanCardView, COMPLICATED_PLAN_NOTE } = loadTsx('frontend/src/features/messages/bot-plan-view.tsx');
  const draw = (plan, props = {}) => renderToHtml(createElement(PlanCardView, { appName: 'Chores', plan, state: 'open', ...props }));
  const open = draw({ ...PLAN, complicated: true, spec: { sessionId: 5, version: 1 } });
  assert.match(open, /<p class="messages-bot-note mt-2\.5" data-bot-plan-note=""><svg[^>]*>[\s\S]*?<\/svg><span>Its before and after screens are on the request below\. What you ask to change is posted there, where the group can see it\.<\/span><\/p>/);
  assert.equal(COMPLICATED_PLAN_NOTE, 'Its before and after screens are on the request below. What you ask to change is posted there, where the group can see it.');
  assert.match(open, /data-bot-plan-build="">Build it<\/button>/);
  assert.match(open, /data-bot-plan-change="">Change something<\/button>/);
  assert.doesNotMatch(draw(PLAN), /data-bot-plan-note/, 'a first version\'s card is unchanged');
  assert.doesNotMatch(draw({ ...PLAN, complicated: true }, { state: 'built' }), /data-bot-plan-note/, 'only while it waits');
});

test('Build it writes the plan and choices into the build note as the requester\'s, kept whole in the build prompt', () => {
  const chosen = [{ question: 'Who shows on the leaderboard?', answer: 'Only people who opt in' }];
  const note = bot.creatorChoiceNote(chosen, { bullets: PLAN.bullets, requester: true });
  assert.equal(note, [
    '',
    '',
    'Approved by the person who asked for it, who said Build it under this plan and its spec:',
    '- A weekly leaderboard tab',
    '- Points for each chore done',
    'The person who asked for it chose (where this differs from the spec\'s suggested answer, this wins):',
    '- Who shows on the leaderboard? Only people who opt in',
  ].join('\n'));
  assert.match(bot.creatorChoiceNote(chosen, { bullets: PLAN.bullets }), /Approved by the creator/, 'a first version\'s heads as they were');
  const long = `${'x'.repeat(5000)}${note}`;
  const split = live.splitApprovedPlan(long);
  assert.match(split.approved, /^Approved by the person who asked for it/);
  const prompt = live.planNoteText(long, false);
  assert.match(prompt, /- Who shows on the leaderboard\? Only people who opt in$/, 'never clipped off the end of a long note');
  assert.equal(live.planNoteText('short note', false), 'short note', 'a note nobody approved reads as it did');
  assert.match(bot.planChoicesNote(PLAN.questions), /shown to the person who asked for it BEFORE anything is built[\s\S]*- Who shows on the leaderboard\? Everyone in the flat \/ Only people who opt in$/);
});

test('its description says it was checked with its requester first', () => {
  assert.equal(live.checkedDescription('Adds a leaderboard.\n\nAsked for by @maya', 'maya'),
    'Adds a leaderboard.\n\nAsked for by @maya\n\nChecked with @maya first: they saw this plan and its screens and said Build it.');
  const once = live.checkedDescription('x', 'maya');
  assert.equal(live.checkedDescription(once, 'maya'), once, 'said once');
  assert.match(live.checkedDescription('x'), /Checked with the person who asked for it first/);
  const src = read('src/services/homeroom-bot-live.js');
  assert.match(src, /const description = credited && checkedFirst \? checkedDescription\(credited, askedBy\) : credited;/);
});

// ── What the verdict does ──

function fakePool(over = () => null) {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push([String(sql), params]);
      const answered = over(String(sql), params);
      if (answered) return answered;
      if (/RETURNING id/.test(String(sql)) && /homeroom_bot_run_snapshots/.test(String(sql))) return { rows: [{ id: 321 }] };
      return { rows: [], rowCount: 1 };
    },
  };
}

function verdictArgs(over = {}) {
  const pool = over.pool || fakePool();
  return {
    pool, config: {}, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'chores', name: 'Chores' },
    repo: { owner: 'o', repo: 'r' }, issueNumber: 12, issue: { title: 'Leaderboard' },
    parsed: { verdict: 'ready', buildNote: 'Add a leaderboard tab.', complicated: true, plan: PLAN }, capSuppressed: null, runId: 900,
    seed: 's', seedReadAt: '2026-10-09T10:00:00Z', postedAt: [], turnBudgetMs: 1000, model: 'stage/build', specModel: 'stage/spec',
    deps: {
      github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
      ws: {}, threadContext: { async loadIssueThread() { return { messages: [] }; } },
      limits: { async recordSpend() {}, async checkBudget() { return {}; } },
      managedOpenRouter: { async usesIncludedKey() { return false; } }, domain: 'x',
    },
    ...over,
  };
}

function stubLive(t) {
  const real = { buildAndPropose: live.buildAndPropose, post: live.post };
  const seen = { built: [], posts: [] };
  live.post = async (a) => { seen.posts.push(a); return {}; };
  live.buildAndPropose = async (a) => { seen.built.push(a); return { ok: false, error: 'stop here', costUsd: 0 }; };
  t.after(() => Object.assign(live, real));
  return seen;
}

function stubConfigs(t, current = CURRENT) {
  const real = { currentVersion: configs.currentVersion, laterVersion: configs.laterVersion, finishLive: configs.finishLive };
  configs.currentVersion = async () => current;
  configs.laterVersion = async () => null;
  configs.finishLive = async () => true;
  t.after(() => Object.assign(configs, real));
}

test('a complicated ready verdict queues its plan, and builds nothing; a small one is queued to build as before', async (t) => {
  const seen = stubLive(t);
  const args = verdictArgs();
  assert.equal(await bot.actOnVerdict(args), 'plan_queued');
  assert.ok(args.pool.queries.some(([sql, p]) => /SET live_build_waiting_at = COALESCE\(live_build_waiting_at, NOW\(\)\)/.test(sql) && p[0] === 900),
    'it waits for the build slot, where its spec is drafted');
  assert.equal(seen.built.length, 0, 'nothing is built in the triage\'s turn');
  const small = verdictArgs({ parsed: { verdict: 'ready', buildNote: 'Fix the typo.', complicated: false } });
  assert.equal(await bot.actOnVerdict(small), 'build_queued');
});

test('a first version is planned with its creator exactly as before, whatever the label', async (t) => {
  stubLive(t);
  const sent = [];
  const args = verdictArgs({ firstVersion: true });
  args.deps.dm = { async sendPlanCard(_pool, a) { sent.push(a); return { messageId: 3 }; } };
  assert.equal(await bot.actOnVerdict(args), 'awaiting_go');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].plan.complicated, undefined, 'its card is a first version\'s');
  assert.ok(args.pool.queries.some(([sql]) => /SET awaiting_go_at = NOW\(\), plan = \$2/.test(sql)), 'awaitGo, as it was');
});

test('its build slot drafts the spec only, then asks: DM card, request card and GitHub comment, and waits', async (t) => {
  const seen = stubLive(t);
  stubConfigs(t);
  live.buildAndPropose = async (a) => {
    seen.built.push(a);
    return { ok: false, planned: true, sessionId: 55, specMd: '# Leaderboard\n\nA weekly board.', specVersion: 1, specHtml: '<ol data-changes></ol>', costUsd: 0.4 };
  };
  const pool = fakePool();
  const cards = [];
  const args = verdictArgs({ pool, complicated: true, plan: PLAN, parsed: { verdict: 'ready', buildNote: 'Add a leaderboard tab.' } });
  args.deps.dm = {
    async sendPlanCard(_pool, a) { cards.push(a); return { messageId: 31, conversationId: 4 }; },
    async requesterOf() { return { userId: 2, username: 'maya' }; },
  };
  assert.equal(await bot.buildLive(args), 'awaiting_go');
  assert.equal(seen.built.length, 1);
  assert.equal(seen.built[0].planOnly, true, 'the spec turn alone');
  assert.match(seen.built[0].buildNote, /^Add a leaderboard tab\.\n\nThis spec is shown to the person who asked for it BEFORE anything is built/);
  assert.equal(seen.built[0].review, undefined, 'nothing to review yet');
  const waited = pool.queries.find(([sql]) => /SET live_build_waiting_at = NULL, awaiting_go_at = NOW\(\), plan = \$2::jsonb/.test(sql));
  assert.ok(waited, 'it waits for Build it');
  assert.deepEqual(JSON.parse(waited[1][1]), { ...PLAN, complicated: true, spec: { sessionId: 55, version: 1 } });
  assert.equal(waited[1][2], '# Leaderboard\n\nA weekly board.', 'the spec Build it builds from');
  assert.ok(pool.queries.some(([sql, p]) => /SET shared_to_group_at = NOW\(\)/.test(sql) && p[0] === 55), 'readable by the group');
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].plan.spec, { sessionId: 55, version: 1 });
  assert.equal(cards[0].plan.complicated, true);
  const post = seen.posts.find((p) => p.kind === 'plan');
  assert.ok(post, 'posted on the request and GitHub');
  assert.match(post.text, /will build it once the person who asked for it says Build it/);
  assert.equal(post.threadMessage.metadata.specShare.sessionId, 55);
  assert.equal(post.untag, 'maya', 'their DM reached them: the request does not ring them twice');
  assert.equal(post.dm, undefined);
  assert.ok(!pool.queries.some(([sql]) => /SET awaiting_go_at = NULL, live_build_waiting_at = NOW\(\)/.test(sql)), 'never builds without an answer');
});

test('a plan that could not be written is said on the request, and nothing waits or builds', async (t) => {
  const seen = stubLive(t);
  stubConfigs(t);
  live.buildAndPropose = async (a) => { seen.built.push(a); return { ok: false, planned: false, error: 'no plan could be written (timeout)', costUsd: 0.1 }; };
  const pool = fakePool();
  const args = verdictArgs({ pool, complicated: true, plan: PLAN });
  args.deps.dm = { async sendPlanCard() { throw new Error('not reached'); }, async requesterOf() { return null; } };
  assert.equal(await bot.buildLive(args), 'build_failed');
  assert.ok(seen.posts.some((p) => p.kind === 'build_failed'));
  assert.ok(!pool.queries.some(([sql]) => /awaiting_go_at = NOW\(\)/.test(sql)));
});

test('a run already waiting for Build it under one plan is never asked about a second (turnly #6)', async (t) => {
  const seen = stubLive(t);
  stubConfigs(t);
  live.buildAndPropose = async (a) => {
    seen.built.push(a);
    return { ok: false, planned: true, sessionId: 56, specMd: '# Another leaderboard', specVersion: 1, costUsd: 0.4 };
  };
  // Another drafting of the same run put its plan to the requester first.
  const pool = fakePool((sql) => (/SET live_build_waiting_at = NULL, awaiting_go_at = NOW\(\)/.test(sql) ? { rows: [], rowCount: 0 } : null));
  const args = verdictArgs({ pool, complicated: true, plan: PLAN, parsed: { verdict: 'ready', buildNote: 'Add a leaderboard tab.' } });
  const cards = [];
  args.deps.dm = { async sendPlanCard(_pool, a) { cards.push(a); return { messageId: 32 }; }, async requesterOf() { return null; } };
  assert.equal(await bot.buildLive(args), 'already_built');
  const waited = pool.queries.find(([sql]) => /SET live_build_waiting_at = NULL, awaiting_go_at = NOW\(\)/.test(sql));
  assert.match(waited[0], /AND awaiting_go_at IS NULL/, 'only a run no plan waits on yet');
  assert.deepEqual(cards, [], 'no second DM card');
  assert.ok(!seen.posts.some((p) => p.kind === 'plan'), 'and no second plan on the request');
});

test('Build it builds exactly the approved spec, with its screens, reviewed as a first version is, and says it was checked', async (t) => {
  const seen = stubLive(t);
  stubConfigs(t);
  const args = verdictArgs({
    complicated: true, plan: { ...PLAN, complicated: true }, presetSpec: '# Leaderboard', presetSpecHtml: '<ol data-changes></ol>',
    parsed: { verdict: 'ready', buildNote: 'Add a leaderboard tab.' },
  });
  await bot.buildLive(args);
  const built = seen.built[0];
  assert.equal(built.planOnly, undefined, 'a real build');
  assert.equal(built.presetSpec, '# Leaderboard', 'the spec is not drawn again');
  assert.equal(built.presetSpecHtml, '<ol data-changes></ol>');
  assert.equal(built.checkedFirst, true);
  assert.deepEqual(built.review.reviewer, REVIEWER, 'the first-version configuration\'s reviewer and budget');
  assert.deepEqual(built.review.owner, { botRunId: 900 });
  assert.equal(await built.review.budgetCheck(), null, 'the bot\'s allowance, as a first version\'s');

  // The same build, small: no review, nothing checked.
  const small = stubLive(t);
  await bot.buildLive(verdictArgs({ parsed: { verdict: 'ready', buildNote: 'Fix the typo.' } }));
  assert.equal(small.built[0].review, undefined, 'a small change gets no check round');
  assert.equal(small.built[0].checkedFirst, undefined);
  assert.equal(small.built[0].planOnly, undefined);

  // With no reviewer in the configuration, it is built and proposed as it is (fails open).
  const none = stubLive(t);
  stubConfigs(t, { ...CURRENT, recipe: { ...CURRENT.recipe, reviewer: null } });
  await bot.buildLive(args);
  assert.equal(none.built[0].review, null);
  assert.equal(await bot.complicatedReview({}, { runId: 1, bot: { id: 1 } }), null);
});

test('a first version labelled complicated is built exactly as a first version', async (t) => {
  const seen = stubLive(t);
  stubConfigs(t);
  const real = configs.spawnSideBuilds;
  configs.spawnSideBuilds = async () => ({ derived: 0, trials: 0, skipped: 0 });
  t.after(() => { configs.spawnSideBuilds = real; });
  await bot.buildLive(verdictArgs({ firstVersion: true, complicated: true, plan: PLAN }));
  assert.equal(seen.built[0].planOnly, undefined);
  assert.equal(seen.built[0].checkedFirst, undefined);
  assert.equal(seen.built[0].presetSpecHtml, undefined);
  assert.deepEqual(seen.built[0].review.reviewer, REVIEWER, 'its own review, from its own configuration');
});

test('buildAndPropose\'s plan-only mode stops after the spec, and a preset spec keeps its screens', () => {
  const src = read('src/services/homeroom-bot-live.js');
  const body = src.slice(src.indexOf('async function buildAndPropose('), src.indexOf('async function reviewLanded('));
  const planOnly = body.indexOf('if (planOnly) {');
  assert.ok(planOnly > body.indexOf('const skippedEarly = await skipNow();'), 'after the spec, its block and its skip check');
  assert.ok(planOnly < body.indexOf('await onSpec('), 'before the spec is posted as being built');
  assert.ok(planOnly < body.indexOf('const runBuildTurn = buildTurnRunner('), 'and before any build turn');
  assert.match(body, /specHtml: presetSpecHtml \? String\(presetSpecHtml\) : null, model: specModel \|\| model,/);
});

// ── Against the full schema ──

test('a complicated change, end to end, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `hrbot_complicated_${crypto.randomBytes(6).toString('hex')}`;
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
  const conversations = require('../src/services/conversations');
  const user = async (username, synthetic = false) => (await pool.query(
    `INSERT INTO users (username, password, has_platform_access, is_synthetic) VALUES ($1, 'x', TRUE, $2)
     RETURNING id, username, is_synthetic AS "isSynthetic", has_platform_access AS "hasPlatformAccess"`,
    [username, synthetic],
  )).rows[0];
  const homeroomBot = await user('homeroom_bot', true);
  const maya = await user('maya');
  const sam = await user('sam');
  const { rows: [inserted] } = await pool.query(
    `INSERT INTO apps (name, slug, status, created_by, view_visibility, collab_visibility)
     VALUES ('Chores', 'chores', 'running', $1, 'private', 'private') RETURNING id`,
    [maya.id],
  );
  const app = (await pool.query('SELECT id, slug, name, community_id FROM apps WHERE id = $1', [inserted.id])).rows[0];
  await pool.query('INSERT INTO community_members (community_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [app.community_id, maya.id]);
  const set = (key, value) => pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
  await set('homeroom_bot_mode', 'live');
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version, asked_text)
     VALUES ($1, 12, $2, 'Add a leaderboard', FALSE, 'A weekly leaderboard')`,
    [app.id, maya.id],
  );
  // The spec the plan stage drafted, on its own (put away) session.
  const { rows: [specSession] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, status, session_title) VALUES ($1, $2, 'archived', 'plan') RETURNING id`,
    [app.id, homeroomBot.id],
  );
  await pool.query(
    `INSERT INTO chat_session_specs (session_id, version, content, content_html) VALUES ($1, 1, '# Leaderboard', '<ol data-changes></ol>')`,
    [specSession.id],
  );
  const SHOWN = { ...PLAN, complicated: true, spec: { sessionId: specSession.id, version: 1 } };
  const waitingRun = async () => (await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, complicated, plan, awaiting_go_at, build_spec_md)
     VALUES ($1, 12, 'live', 'ready', 'Add a leaderboard tab.', TRUE, $2::jsonb, NOW() - INTERVAL '1 minute', '# Leaderboard') RETURNING id`,
    [app.id, JSON.stringify(SHOWN)],
  )).rows[0].id;
  const runRow = async (id) => (await pool.query('SELECT * FROM homeroom_bot_runs WHERE id = $1', [id])).rows[0];
  const planMessage = async (runId) => (await pool.query(
    `SELECT m.id, m.conversation_id, m.content, m.metadata->'homeroomBot' AS meta, m.id AS message_id
       FROM homeroom_bot_dm_messages d JOIN conversation_messages m ON m.id = d.message_id
      WHERE d.run_id = $1 AND d.kind = 'plan'`,
    [runId],
  )).rows[0];
  // Their words on the request, as the discussion's own route posts them.
  const ws = {
    pushConversationEvent() {},
    async handleMessage(_pool, { user: who, appId }, { content, thread }) {
      await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, $3, $4, $5)`,
        [appId, who.id, content, thread.type, thread.ref],
      );
      return { ok: true };
    },
  };

  let first;
  await t.test('its requester gets the plan card in their DM: not a first version, the request under it', async () => {
    first = await waitingRun();
    const sent = await dm.sendPlanCard(pool, { app, issueNumber: 12, runId: first, plan: SHOWN, bot: homeroomBot });
    assert.ok(sent?.messageId);
    const card = await planMessage(first);
    assert.equal(card.meta.kind, 'plan');
    assert.equal(card.meta.firstVersion, false);
    assert.deepEqual(card.meta.plan, SHOWN);
    assert.match(card.content, /^Before I build \*\*Chores\*\* request #12, here's my plan:/);
    // The request's card goes under it (validated against GitHub, so not here).
    assert.match(read('src/services/homeroom-bot-dm.js'), /\.\.\.\(complicated \? \{ objects: cardsFor\(PLAN_KIND, \{\}, app, issueNumber\) \} : \{\}\),/);
  });

  await t.test('nothing builds without an answer, and "build it" from somebody else on the request is no answer', async () => {
    assert.equal((await runRow(first)).live_build_waiting_at, null);
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'build it', 'issue', 12)`,
      [app.id, sam.id],
    );
    assert.equal(await bot.buildItOnRequest(pool, { appId: app.id, issueNumber: 12, requester: { userId: maya.id } }), false);
    assert.equal((await runRow(first)).live_build_waiting_at, null);
    await pool.query('DELETE FROM chat_messages WHERE app_id = $1', [app.id]);
  });

  await t.test('Build it from the DM builds exactly that plan: the spec it showed, its screens, the choices in the note', async () => {
    const card = await planMessage(first);
    const tapped = await mayor.decideOfferTap(pool, {}, {
      user: maya, actionId: card.meta.actionId, choice: 'build', answers: ['Only people who opt in'],
    });
    assert.deepEqual(tapped, { ok: true, choice: 'build', label: 'Build it' });
    const run = await runRow(first);
    assert.equal(run.awaiting_go_at, null);
    assert.ok(run.live_build_waiting_at, 'its build waits its turn');
    assert.equal(run.build_spec_md, '# Leaderboard', 'built from the spec they saw (presetSpec)');
    assert.match(run.build_note, /\n\nApproved by the person who asked for it, who said Build it under this plan and its spec:\n- A weekly leaderboard tab\n- Points for each chore done\nThe person who asked for it chose \(where this differs from the spec's suggested answer, this wins\):\n- Who shows on the leaderboard\? Only people who opt in$/);
    assert.equal(await bot.approvedSpecHtml(pool, run.plan), '<ol data-changes></ol>', 'and its screens');
    await pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = $2 WHERE id = $1', [first, 'test: done']);
  });

  await t.test('"build it" from its requester on the request is Build it, and their card says so', async () => {
    const run = await waitingRun();
    await dm.sendPlanCard(pool, { app, issueNumber: 12, runId: run, plan: SHOWN, bot: homeroomBot });
    await pool.query(
      `INSERT INTO chat_messages (app_id, user_id, content, thread_type, thread_ref) VALUES ($1, $2, 'Build it!', 'issue', 12)`,
      [app.id, maya.id],
    );
    assert.equal(await bot.buildItOnRequest(pool, { appId: app.id, issueNumber: 12, requester: { userId: maya.id } }), true);
    const after = await runRow(run);
    assert.ok(after.live_build_waiting_at);
    assert.match(after.build_note, /Who shows on the leaderboard\? Everyone in the flat$/, 'the suggested answer');
    const card = await planMessage(run);
    assert.deepEqual([card.meta.status, card.meta.chosen], ['answered', 'build']);
    await pool.query('UPDATE homeroom_bot_runs SET live_build_waiting_at = NULL, build_ok = FALSE, build_error = $2 WHERE id = $1', [run, 'test: done']);
    await pool.query('DELETE FROM chat_messages WHERE app_id = $1', [app.id]);
  });

  await t.test('Change something posts their words on the request, ends the wait, and the next look plans with them again', async () => {
    const run = await waitingRun();
    await dm.sendPlanCard(pool, { app, issueNumber: 12, runId: run, plan: SHOWN, bot: homeroomBot });
    const card = await planMessage(run);
    const sent = await conversations.sendMessage(pool, maya, card.conversation_id, {
      content: 'Make it monthly, not weekly', reply_to_id: card.id,
    });
    const out = await dm.noteUserMessage(pool, {}, {
      user: maya, conversationId: card.conversation_id,
      message: { id: sent.messageId, content: 'Make it monthly, not weekly', reply: { id: card.id } },
      deps: { bot: homeroomBot, ws },
    });
    const said = (await pool.query('SELECT content FROM conversation_messages WHERE id = $1', [out.messageId])).rows[0];
    assert.equal(said.content, "Thanks. I posted that on Chores request #12's public discussion, and I'll plan it again with it and send the new plan here.");
    const { rows: posted } = await pool.query(
      `SELECT user_id, content FROM chat_messages WHERE app_id = $1 AND thread_type = 'issue' AND thread_ref = 12`, [app.id],
    );
    assert.equal(posted.length, 1, 'on the request, shared with the group');
    assert.equal(Number(posted[0].user_id), maya.id, 'as their own words');
    assert.match(posted[0].content, /^Make it monthly, not weekly\n\n\(Sent in a chat with Homeroom bot\.\)$/);
    const after = await runRow(run);
    assert.deepEqual([after.awaiting_go_at, after.build_ok, after.build_error, after.plan_change],
      [null, false, 'skipped: its requester asked to change the plan', null], 'nothing kept private');
    const closed = await planMessage(run);
    assert.deepEqual([closed.meta.status, closed.meta.changing], ['closed', true]);
    const { rows: [q] } = await pool.query('SELECT priority, reason FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 12', [app.id]);
    assert.deepEqual(q, { priority: 0, reason: 'plan_change' }, 'read again next');
    assert.equal(await bot.plannedWithRequester(pool, { appId: app.id, issueNumber: 12 }), true, 'and planned with them again');
  });

  await t.test('a small change, or a complicated one already proposed, is not planned again', async () => {
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note) VALUES ($1, 13, 'live', 'ready', 'x')`,
      [app.id],
    );
    assert.equal(await bot.plannedWithRequester(pool, { appId: app.id, issueNumber: 13 }), false);
    const { rows: [proposal] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status) VALUES ($1, $2, 'promoted') RETURNING id`, [app.id, homeroomBot.id],
    );
    await pool.query(
      `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_note, complicated, proposal_session_id)
       VALUES ($1, 14, 'live', 'ready', 'x', TRUE, $2)`,
      [app.id, proposal.id],
    );
    assert.equal(await bot.plannedWithRequester(pool, { appId: app.id, issueNumber: 14 }), false);
  });
});
