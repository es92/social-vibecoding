'use strict';

// A first version's EARLY first look (services/first-version-early-look.js):
// its main screen drawn from the plan at Make it in a short call of its own,
// pictured as the spec's first look is, shown on the App tab and the tour's
// last card until the spec saves its own, and handed to that spec as the
// main screen to start from.
//
// Newcomer run six (14 October 2026): the first look came only when the
// spec ended, 2.5 to 3 minutes after Submit, after the 76-second tour was
// over. tests/first-version-early-look-postgres.test.js runs it against the
// real schema.
//
// Run with: node --test tests/first-version-early-look.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const early = require('../src/services/first-version-early-look');
const fvs = require('../src/services/first-version-screens');
const fvPlan = require('../src/services/first-version-plan');
const live = require('../src/services/homeroom-bot-live');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SCREEN = '<template data-screen data-size="phone" data-height="900"><style>.poll{color:rgb(var(--fg))}</style>'
  + '<div data-side="after" data-change="1"><h1>Club Votes</h1><ul class="list"><li class="list-row poll">Pizza night?</li></ul></div></template>';
const PLAN = {
  bullets: ['Make a poll in a few taps', 'Everyone votes once', 'See who won'],
  questions: [{ question: 'When does a vote end?', answers: ['When you close it', 'After 24 hours'] }],
  buildNote: 'One screen: the open polls. Its primary action is New poll.',
  assumptions: [],
};
const APP = { id: 3, slug: 'club-votes', name: 'Club Votes' };
const USER = { id: 7 };
const BOT = { id: 99, username: 'homeroom_bot' };

function fakePool(answers = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      for (const [re, rows] of answers) if (re.test(String(sql))) return { rows: typeof rows === 'function' ? rows(params) : rows };
      return { rows: [] };
    },
  };
}

const marker = (png) => `noise\n${fvs.MARKER} ${JSON.stringify({ ok: true, png: png.toString('base64') })}\n`;

/** Deps for a whole early look that works: the model draws SCREEN, the worker pictures it. */
function workingDeps(overrides = {}) {
  const seen = { llm: [], worker: [], timeline: [], spent: [], sessions: [] };
  const deps = {
    env: {},
    llm: {
      isEnabled: () => true,
      estimateCostCents: () => 4.2,
      async generateFirstLook(args) { seen.llm.push(args); return { text: `Here it is:\n${SCREEN}`, usage: { input_tokens: 5000, output_tokens: 3000 }, model: 'claude-sonnet-5-5' }; },
    },
    limits: { async recordSpend(_pool, userId, cents) { seen.spent.push([userId, cents]); } },
    bot: {
      starterOfApp: async () => null,
      parseRepo: (url) => ({ owner: 'o', repo: String(url).split('/').pop() }),
      async ensureBotSession(_pool, _config, bot, app) { seen.sessions.push([bot.id, app.id]); return { id: 41, branch_name: 'main' }; },
    },
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(sessionId, opts) { seen.worker.push(['ensure', sessionId, opts]); return 'w-41'; },
      async runBenchCapture(containerName, opts) { seen.worker.push(['draw', containerName, opts]); return marker(PNG); },
    },
    timeline: { async record(_pool, entry) { seen.timeline.push(entry); return true; } },
    repoPollMs: 1,
    ...overrides,
  };
  return { deps, seen };
}

// What its work (the app-creation machine's app.earlyLook) reads first: the
// first version's row, its plan written.
const FIRST_VERSION_ROW = [/FROM homeroom_bot_first_versions f JOIN apps a/, [{
  user_id: USER.id, brief: 'Polls for the club', early_plan: PLAN, early_plan_status: 'ready', id: APP.id, name: APP.name, slug: APP.slug,
}]];
const look = (pool, deps, bot = BOT) => early.runEarlyLook(pool, { appId: APP.id, config: {} }, { ...deps, botUser: bot });

const lookPool = (extra = []) => fakePool([
  FIRST_VERSION_ROW,
  [/INSERT INTO first_version_early_looks/, [{ app_id: APP.id }]],
  [/FROM apps WHERE id = \$1/, [{ id: APP.id, slug: APP.slug, name: APP.name, repo_url: 'https://github.com/o/club-votes', self_hosted: false, status: 'running' }]],
  [/SET status = 'ready'/, [{ saved_at: new Date() }]],
  ...extra,
]);

// ── It saves the first look ──────────────────────────────────────────────

test('it draws the screen with Sonnet at low effort, pictures it in the bot session\'s worker and saves it as the first look, from: early', async () => {
  const { deps, seen } = workingDeps();
  const pool = lookPool();
  const done = await look(pool, deps);
  assert.deepEqual(done, { ok: true, error: null });

  // The call: its own helper wrapper, the model and effort chosen, and the plan's suggested answer.
  assert.equal(seen.llm.length, 1);
  assert.equal(seen.llm[0].model, early.LOOK_MODEL);
  assert.equal(early.LOOK_MODEL, 'claude-sonnet-5-5');
  assert.equal(seen.llm[0].effort, 'low');
  assert.equal(seen.llm[0].timeoutMs, early.MODEL_WAIT_MS);
  assert.deepEqual(seen.llm[0].telemetryContext, { pool, appId: APP.id });
  assert.match(seen.llm[0].user, /When does a vote end\? Suggested: When you close it\. The others: After 24 hours\./);
  assert.match(seen.llm[0].system, /Draw ONE screen: the main screen of the finished first version/);
  assert.match(seen.llm[0].system, /No "Sample data"\s+label/);
  assert.deepEqual(seen.spent, [[USER.id, 4.2]], 'paid for by its maker, as the plan is');

  // The worker: the app's bot session's, on scratch storage; the drawing is the first look's.
  assert.deepEqual(seen.sessions, [[BOT.id, APP.id]]);
  const ensure = seen.worker.find(([k]) => k === 'ensure');
  assert.equal(ensure[1], 41);
  assert.equal(ensure[2].temporary, true);
  assert.equal(ensure[2].branchName, 'main');
  const draw = seen.worker.find(([k]) => k === 'draw');
  assert.equal(draw[1], 'w-41');
  assert.equal(draw[2].scriptPath, fvs.SCRIPT_PATH);
  assert.match(draw[2].source, /const FIRST_LOOK = /);
  assert.match(draw[2].source, /Pizza night\?/);

  // Kept: claimed, the screen, then the picture.
  const sql = pool.calls.map((c) => c.sql);
  assert.ok(sql.findIndex((s) => /INSERT INTO first_version_early_looks/.test(s))
    < sql.findIndex((s) => /SET status = 'drawn'/.test(s)));
  const drawn = pool.calls.find((c) => /SET status = 'drawn'/.test(c.sql));
  assert.deepEqual(drawn.params, [APP.id, SCREEN, 'claude-sonnet-5-5']);
  const ready = pool.calls.find((c) => /SET status = 'ready'/.test(c.sql));
  assert.ok(Buffer.isBuffer(ready.params[1]) && ready.params[1].equals(PNG));
  assert.deepEqual(ready.params.slice(2), [1, 1, PNG.length]);

  // Its timeline: first_look_saved, from the early look, before there is a run.
  assert.equal(seen.timeline.length, 1);
  assert.equal(seen.timeline[0].appId, APP.id);
  assert.equal(seen.timeline[0].stage, 'first_look_saved');
  assert.equal(seen.timeline[0].detail.from, 'early');
  assert.ok(Number.isFinite(seen.timeline[0].detail.drawMs) && Number.isFinite(seen.timeline[0].detail.ms));
  assert.ok(require('../src/services/first-version-timeline').STAGES.includes('first_look_saved'));

  // Once per project: a second start claims nothing.
  const again = fakePool([FIRST_VERSION_ROW]);
  assert.deepEqual(await look(again, deps), { skipped: 'claimed' });
  assert.equal(again.calls.length, 2, 'its row read, its claim refused');
});

test('its picture waits for the project\'s repository, and is drawn the one way a first look is', async () => {
  let reads = 0;
  const { deps } = workingDeps();
  const pool = fakePool([
    [/FROM apps WHERE id = \$1/, () => {
      reads += 1;
      return [{ id: APP.id, slug: APP.slug, name: APP.name, repo_url: reads >= 3 ? 'https://github.com/o/club-votes' : null, status: 'creating' }];
    }],
  ]);
  const name = await early.prepareWorker(pool, { app: APP, config: {}, bot: BOT, deadline: Date.now() + 5000 }, deps);
  assert.equal(name, 'w-41');
  assert.equal(reads, 3, 'polled until the first commit was pushed');
  await assert.rejects(early.prepareWorker(fakePool([[/FROM apps WHERE id = \$1/, [{ id: 3, repo_url: null, status: 'error' }]]]),
    { app: APP, config: {}, bot: BOT, deadline: Date.now() + 5000 }, deps), { code: 'no_repo' });
  // drawScreenPng is renderFirstLook's own drawing, shared.
  const src = read('src/services/first-version-screens.js');
  assert.match(src, /async function renderFirstLook\([\s\S]*?const png = await drawScreenPng\(\{ worker, containerName, specHtml, timeoutMs \}\);/);
});

// ── Newcomer run eight: the app's name, never the label ──────────────────
//
// Told it "uses APP NAME exactly", Club Votes' early first look printed the
// words APP NAME above its title "Open decisions".

test('run eight: the drawing is told the app\'s name itself, never pointed at a label', () => {
  const system = early.lookSystem().replace(/\s+/g, ' ');
  assert.match(system, /it uses the app's name, given in the user message, exactly: never invent a name for the club/);
  assert.doesNotMatch(system, /uses APP NAME exactly/);
  assert.doesNotMatch(system, /APP NAME/, 'no label it could copy');
  const user = early.lookUserPrompt({ name: 'Club \n Votes ', brief: 'Decisions for our club', plan: PLAN });
  assert.match(user, /^THE APP'S NAME:\nClub Votes\nWherever the screen names the app, its group or its place, write "Club Votes": never the heading above, and never a name you invent\.\n\n/);
  assert.doesNotMatch(user, /APP NAME/);
});

test('run eight: a text that is only the words APP NAME is drawn as the app\'s name, escaped, and nothing else changes', async () => {
  assert.equal(early.namedScreen('<p class="eyebrow">APP NAME</p><h1>Open decisions</h1>', 'Club Votes'),
    '<p class="eyebrow">Club Votes</p><h1>Open decisions</h1>');
  assert.equal(early.namedScreen('<span>\n  app name </span><b>App  Name</b>', 'Club Votes'),
    '<span>\n  Club Votes </span><b>Club Votes</b>', 'any case, trimmed');
  assert.equal(early.namedScreen('<h1>APP NAME</h1>', 'Tom & Jo\'s <Club> "$&"'),
    '<h1>Tom &amp; Jo&#39;s &lt;Club&gt; &quot;$&amp;&quot;</h1>');
  const untouched = '<template data-screen><style>.x::before{content:"APP NAME"}</style>'
    + '<div data-side="after" data-change="1" title="APP NAME"><p>APP NAME: Club Votes</p><p>The app name</p><p>Club Votes</p></div></template>';
  assert.equal(early.namedScreen(untouched, 'Club Votes'), untouched, 'only a text that is the label and nothing else');
  assert.equal(early.namedScreen('<p>APP NAME</p>', ''), '<p>APP NAME</p>');
  assert.equal(early.namedScreen(null, 'Club Votes'), null);

  // On its way through: the screen kept for the spec and the picture carry the name.
  const labelled = SCREEN.replace('<h1>Club Votes</h1>', '<p>APP NAME</p><h1>Open decisions</h1>');
  const { deps, seen } = workingDeps();
  deps.llm.generateFirstLook = async (args) => { seen.llm.push(args); return { text: labelled, usage: null, model: 'claude-sonnet-5-5' }; };
  const pool = lookPool();
  assert.deepEqual(await look(pool, deps), { ok: true, error: null });
  assert.match(seen.llm[0].user, /write "Club Votes"/);
  const drawn = pool.calls.find((c) => /SET status = 'drawn'/.test(c.sql));
  assert.equal(drawn.params[1], labelled.replace('<p>APP NAME</p>', '<p>Club Votes</p>'));
  const draw = seen.worker.find(([k]) => k === 'draw');
  assert.match(draw[2].source, /<p>Club Votes<\/p><h1>Open decisions<\/h1>/);
  assert.doesNotMatch(draw[2].source, /APP NAME/);
});

// ── The kill switch ──────────────────────────────────────────────────────

test('HOMEROOM_BOT_EARLY_FIRST_LOOK=0 turns it off: nothing drawn, shown or handed to a spec', async () => {
  assert.equal(early.enabled({}), true, 'on by default');
  assert.equal(early.enabled({ HOMEROOM_BOT_EARLY_FIRST_LOOK: '1' }), true);
  assert.equal(early.enabled({ HOMEROOM_BOT_EARLY_FIRST_LOOK: ' 0 ' }), false);
  const { deps, seen } = workingDeps({ env: { HOMEROOM_BOT_EARLY_FIRST_LOOK: '0' } });
  const pool = lookPool();
  assert.deepEqual(await look(pool, deps), { skipped: 'off' });
  assert.equal(pool.calls.length, 0);
  assert.equal(seen.llm.length, 0);

  const ready = fakePool([[/FROM first_version_early_looks l/, [{
    status: 'ready', saved_at: new Date(), has_png: true, png: PNG, screen: SCREEN, created_at: new Date(), plan_note: PLAN.buildNote,
  }]]]);
  const prev = process.env.HOMEROOM_BOT_EARLY_FIRST_LOOK;
  try {
    process.env.HOMEROOM_BOT_EARLY_FIRST_LOOK = '0';
    assert.equal(await early.shownFor(ready, APP.id, null), null);
    assert.equal(await early.pictureFor(ready, APP.id, null), null);
    assert.equal(await early.forSpec(ready, { appId: APP.id, buildNote: PLAN.buildNote }), null);
    delete process.env.HOMEROOM_BOT_EARLY_FIRST_LOOK;
    assert.ok(await early.shownFor(ready, APP.id, null));
    assert.equal(await early.forSpec(ready, { appId: APP.id, buildNote: PLAN.buildNote }), SCREEN);
  } finally {
    if (prev === undefined) delete process.env.HOMEROOM_BOT_EARLY_FIRST_LOOK; else process.env.HOMEROOM_BOT_EARLY_FIRST_LOOK = prev;
  }
  // Another Claude model can be named; anything else is the default.
  assert.equal(early.lookModel({ HOMEROOM_BOT_EARLY_FIRST_LOOK_MODEL: 'claude-opus-5-5' }), 'claude-opus-5-5');
  assert.equal(early.lookModel({ HOMEROOM_BOT_EARLY_FIRST_LOOK_MODEL: 'gpt; rm -rf' }), early.LOOK_MODEL);
});

// ── A failure is harmless ────────────────────────────────────────────────

test('a failure never throws, records why, and leaves the first look to the spec', async () => {
  const cases = [
    ['the model errors', { llm: { isEnabled: () => true, estimateCostCents: () => 0, async generateFirstLook() { throw new Error('529 overloaded'); } } }, 'failed'],
    ['the reply is no screen', { llm: { isEnabled: () => true, estimateCostCents: () => 0, async generateFirstLook() { return { text: 'I cannot draw that.', usage: null }; } } }, 'unusable_reply'],
    ['the reply is cut off', { llm: { isEnabled: () => true, estimateCostCents: () => 0, async generateFirstLook() { return { text: '<template data-screen><div>', usage: null, stopReason: 'max_tokens' }; } } }, 'cut_off'],
    ['the model is slow', { modelWaitMs: 5, llm: { isEnabled: () => true, estimateCostCents: () => 0, generateFirstLook: () => new Promise((r) => setTimeout(() => r({ text: SCREEN }), 60)) } }, 'timeout'],
    ['the worker will not start', { worker: { async ensureWorkerImage() {}, async ensureWorker() { throw new Error('quota'); }, async runBenchCapture() { return ''; } } }, 'worker'],
    ['the picture does not come', { worker: { async ensureWorkerImage() {}, async ensureWorker() { return 'w'; }, async runBenchCapture() { return `${fvs.MARKER} {"ok":false}`; } } }, 'no_picture'],
    ['the picture throws', { worker: { async ensureWorkerImage() {}, async ensureWorker() { return 'w'; }, async runBenchCapture() { throw new Error('exec'); } } }, 'no_picture'],
  ];
  for (const [what, overrides, error] of cases) {
    const { deps, seen } = workingDeps(overrides);
    const pool = lookPool();
    // eslint-disable-next-line no-await-in-loop
    const done = await look(pool, deps);
    assert.deepEqual(done, { ok: false, error }, what);
    const failed = pool.calls.find((c) => /SET status = 'failed'/.test(c.sql));
    assert.ok(failed, `${what}: recorded`);
    assert.equal(failed.params[1], error, what);
    assert.equal(pool.calls.some((c) => /SET status = 'ready'/.test(c.sql)), false, what);
    assert.equal(seen.timeline.length, 0, `${what}: no first_look_saved`);
  }
  // Nothing to draw from, or no bot to draw in: not started at all.
  const { deps } = workingDeps();
  const row = FIRST_VERSION_ROW[1][0];
  for (const [rows, bot, why] of [[[{ ...row, early_plan_status: 'failed', early_plan: null }], BOT, 'no_plan'], [[], BOT, 'no_plan'], [[row], {}, 'no_bot']]) {
    const pool = fakePool([[FIRST_VERSION_ROW[0], rows]]);
    // eslint-disable-next-line no-await-in-loop
    assert.deepEqual(await look(pool, deps, bot), { skipped: why });
    assert.equal(pool.calls.some((c) => /INSERT INTO first_version_early_looks/.test(c.sql)), false, why);
  }
  // A database that is down: thrown, so its work tries again.
  await assert.rejects(look({ query: async () => { throw new Error('down'); } }, deps), /down/);
  assert.equal(await early.forSpec({ query: async () => { throw new Error('down'); } }, { appId: 1, buildNote: 'x' }), null);
});

// ── The readers: shown until the spec saves its own ──────────────────────

test('the App tab shows it as the first look until the run has its own, and only for the plan it was drawn from', async () => {
  const at = new Date('2026-10-14T10:01:05Z');
  const lookRow = [/FROM first_version_early_looks l/, [{ status: 'ready', saved_at: at, has_png: true, png: PNG, plan_note: PLAN.buildNote }]];
  // No run yet: the early look alone.
  let showcase = await fvs.showcaseOf(fakePool([lookRow]), APP.id);
  assert.deepEqual(showcase, { runId: null, caption: null, screens: { first_look: { count: 1, at: at.toISOString() } } });
  assert.deepEqual(fvs.firstVersionShowcase(showcase, 'building').screens,
    { kind: 'first_look', count: 1, at: at.toISOString(), v: String(at.getTime()) });
  // The run built from this plan (Build it adds what its creator approved): still the early look.
  const run = { id: 12, build_caption: null, build_note: `${PLAN.buildNote}\n\nWhat its creator approved: When you close it` };
  const runRow = [/FROM homeroom_bot_first_versions f/, [run]];
  showcase = await fvs.showcaseOf(fakePool([runRow, lookRow]), APP.id);
  assert.equal(showcase.runId, 12);
  assert.deepEqual(showcase.screens.first_look, { count: 1, at: at.toISOString() });
  const picture = await fvs.readScreen(fakePool([runRow, lookRow]), APP.id, 'first_look', 0);
  assert.deepEqual(picture, { content_type: 'image/png', data: PNG });
  assert.equal(await fvs.readScreen(fakePool([runRow, lookRow]), APP.id, 'first_look', 1), null, 'one picture');
  assert.equal(await fvs.readScreen(fakePool([runRow, lookRow]), APP.id, 'real', 0), null, 'never a real screen');
  // The spec saved its own: that one, and the early look is not read.
  const spec = { count: 1, at: '2026-10-14T10:04:00.000Z' };
  const own = fakePool([runRow, [/GROUP BY kind/, [{ kind: 'first_look', count: 1, at: spec.at }]], lookRow]);
  showcase = await fvs.showcaseOf(own, APP.id);
  assert.deepEqual(showcase.screens.first_look, spec);
  assert.equal(own.calls.some((c) => /first_version_early_looks/.test(c.sql)), false);
  const ownPicture = await fvs.readScreen(fakePool([runRow, [/FROM first_version_screens\s+WHERE bot_run_id/, [{ content_type: 'image/png', data: Buffer.from('spec') }]], lookRow]), APP.id, 'first_look', 0);
  assert.equal(String(ownPicture.data), 'spec');
  // A plan its creator asked to change is planned again: its run does not show the old picture.
  const replanned = [/FROM homeroom_bot_first_versions f/, [{ id: 13, build_caption: null, build_note: 'Two screens: a calendar of votes.' }]];
  showcase = await fvs.showcaseOf(fakePool([replanned, lookRow]), APP.id);
  assert.deepEqual(showcase.screens, {});
  assert.equal(await fvs.readScreen(fakePool([replanned, lookRow]), APP.id, 'first_look', 0), null);
  // Not ready yet, or none: nothing, as before.
  assert.equal(await fvs.showcaseOf(fakePool([[/FROM first_version_early_looks l/, [{ status: 'drawn', has_png: false, plan_note: PLAN.buildNote }]]]), APP.id), null);
  assert.equal(await fvs.showcaseOf(fakePool(), APP.id), null);
  // A failed read of it is no early look, never a failed page.
  const flaky = { async query(sql) { if (/first_version_early_looks/.test(sql)) throw new Error('down'); return { rows: [] }; } };
  assert.equal(await fvs.showcaseOf(flaky, APP.id), null);
  assert.equal(await fvs.readScreen(flaky, APP.id, 'first_look', 0), null);
  assert.equal(early.forRun(null, null), true);
  assert.equal(early.forRun({ build_note: 'x' }, null), false);
});

// ── The spec starts from it ──────────────────────────────────────────────

test('the spec receives the early first look: read for its plan, waited for while drawn, and put in its prompt', async () => {
  // The screen of a look drawn from the plan the build goes ahead with.
  const drawnRow = [/FROM first_version_early_looks l/, [{ status: 'drawn', screen: SCREEN, created_at: new Date(), plan_note: PLAN.buildNote }]];
  assert.equal(await early.forSpec(fakePool([drawnRow]), { appId: APP.id, buildNote: `${PLAN.buildNote}\n\nApproved: x` }), SCREEN);
  assert.equal(await early.forSpec(fakePool([drawnRow]), { appId: APP.id, buildNote: 'Another plan' }), null, 'a plan made again');
  assert.equal(await early.forSpec(fakePool([[/FROM first_version_early_looks l/, [{ status: 'failed', screen: SCREEN, created_at: new Date(), plan_note: PLAN.buildNote }]]]),
    { appId: APP.id, buildNote: PLAN.buildNote }), null, 'one never pictured is no promise');
  // Still being drawn: waited for, a little.
  let reads = 0;
  const coming = fakePool([[/FROM first_version_early_looks l/, () => {
    reads += 1;
    return [{ status: reads < 3 ? 'pending' : 'drawn', screen: reads < 3 ? null : SCREEN, created_at: new Date(), plan_note: PLAN.buildNote }];
  }]]);
  assert.equal(await early.forSpec(coming, { appId: APP.id, buildNote: PLAN.buildNote, pollMs: 1 }), SCREEN);
  assert.equal(reads, 3);
  const never = fakePool([[/FROM first_version_early_looks l/, [{ status: 'pending', screen: null, created_at: new Date(), plan_note: PLAN.buildNote }]]]);
  const t0 = Date.now();
  assert.equal(await early.forSpec(never, { appId: APP.id, buildNote: PLAN.buildNote, waitMs: 30, pollMs: 5 }), null);
  assert.ok(Date.now() - t0 < 1000, 'waited at most its while');
  const stale = fakePool([[/FROM first_version_early_looks l/, [{ status: 'pending', screen: null, created_at: new Date(Date.now() - 10 * 60 * 1000), plan_note: PLAN.buildNote }]]]);
  assert.equal(await early.forSpec(stale, { appId: APP.id, buildNote: PLAN.buildNote, pollMs: 1 }), null, 'one a stopped process left');

  // The prompt: a first version's HTML spec starts its main screen from it.
  const base = { seed: 'Build issue #1', buildNote: PLAN.buildNote, firstVersion: true, html: true, platformStyles: false };
  const without = live.specPrompt(base);
  const withLook = live.specPrompt({ ...base, earlyLook: SCREEN });
  assert.doesNotMatch(without, /START FROM THE FIRST LOOK/);
  assert.match(withLook, /START FROM THE FIRST LOOK ITS PEOPLE HAVE SEEN\./);
  assert.ok(withLook.includes(SCREEN), 'the drawing, exactly as drawn');
  assert.match(withLook, /keep its layout, its colours, its signature element, its icons and its words/);
  assert.match(withLook, /Save it\s+with `usernode-screen 1` as above: it replaces the drawing they see\./);
  assert.ok(withLook.indexOf('START FROM THE FIRST LOOK') > withLook.indexOf('DRAW THE MAIN SCREEN FIRST'));
  assert.ok(withLook.indexOf('START FROM THE FIRST LOOK') < withLook.indexOf('The spec must be:'));
  // Never a later change's spec, a markdown spec's, or a drawing too long to hand over.
  assert.doesNotMatch(live.specPrompt({ ...base, firstVersion: false, earlyLook: SCREEN }), /START FROM THE FIRST LOOK/);
  assert.doesNotMatch(live.specPrompt({ ...base, html: false, earlyLook: SCREEN }), /START FROM THE FIRST LOOK/);
  assert.deepEqual(live.earlyLookLines('x'.repeat(live.EARLY_LOOK_MAX_CHARS + 1)), []);
  assert.doesNotMatch(live.earlyLookLines(SCREEN).join('\n'), /—/);

  // Wired: buildLive hands the build a reader of it for the plan it builds,
  // and the build reads it before the spec turn starts, into draftSpec.
  const bot = read('src/services/homeroom-bot.js');
  const at = bot.indexOf('async function buildLive(');
  const body = bot.slice(at, bot.indexOf('\n}\n', at));
  assert.match(body, /\.\.\.\(firstVersion \? \{\s*earlyLook: \(\) => firstVersionEarlyLook\(\)\.forSpec\(pool, \{ appId: app\.id, buildNote: parsed\.buildNote \}\),\s*\} : \{\}\),/);
  const src = read('src/services/homeroom-bot-live.js');
  const bap = src.slice(src.indexOf('async function buildAndPropose('));
  const wait = bap.indexOf('const startingLook = !presetSpec && firstVersion && typeof earlyLook === \'function\'');
  assert.ok(wait > 0 && wait < bap.indexOf('await step(\'spec_turn\')'), 'read before the spec turn starts');
  // A durable build resumed after its plan was kept does not wait for it
  // again, and a stop does not wait for it at all.
  assert.match(bap, /typeof earlyLook === 'function' && !steps\.has\('spec'\)\s*\? await steps\.race\(/);
  assert.match(bap, /locale, onScreen, tweaks: buildTweaks, earlyLook: typeof startingLook === 'string' \? startingLook : null,/);
  assert.match(src, /seed, buildNote, firstVersion, guidance, starter, locale, tweaks, earlyLook: firstVersion \? earlyLook : null,/);
});

// ── The plan's answers ───────────────────────────────────────────────────

test('run six: the plan at Make it is told every answer to a question must build something different', () => {
  assert.match(fvPlan.PLAN_SYSTEM, /Every answer to a question makes the app do something different from each other answer to it/);
  assert.match(fvPlan.PLAN_SYSTEM, /Never two answers that say the same thing in other words, or that would be\s+built the same way\./);
  assert.match(fvPlan.PLAN_SYSTEM, /a\s+question left with fewer than 2 real answers is no choice \(leave it out\)/);
  assert.doesNotMatch(fvPlan.PLAN_SYSTEM, /—/);
});

// ── The table and the run report ─────────────────────────────────────────

test('the table keeps it by project, privately, and the run report says how far it got, never what it drew', () => {
  const schema = read('src/db/schema.sql');
  const at = schema.indexOf('CREATE TABLE IF NOT EXISTS first_version_early_looks');
  assert.ok(at > 0);
  const table = schema.slice(at, schema.indexOf(');', at));
  assert.match(table, /app_id\s+INTEGER PRIMARY KEY REFERENCES apps\(id\) ON DELETE CASCADE/);
  assert.match(table, /status\s+VARCHAR\(16\) NOT NULL CHECK \(status IN \('pending', 'drawn', 'ready', 'failed'\)\)/);
  assert.match(schema, /COMMENT ON TABLE first_version_early_looks IS 'staging:private';/);
  const runReport = require('../src/services/run-report');
  const src = read('src/services/run-report.js');
  assert.match(src, /LEFT JOIN first_version_early_looks el ON el\.app_id = a\.id/);
  assert.doesNotMatch(src, /el\.screen AS|el\.png/, 'lengths only');
  assert.ok(runReport);
});
