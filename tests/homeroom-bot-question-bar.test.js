// The Homeroom bot's bar for asking. A posted question is for a real
// blocker only: the answer changes what people see and the plausible
// answers are builds too different to review one into the other
// (`user_facing`), or the request may be impossible as written
// (`impossible`). Every other open point is decided by the bot and written
// down as an assumption, in the build note and then in the spec, where the
// group can see it and object in review.
//
// Three layers hold it: the triage prompt, parseVerdict (a question that
// cannot name its blocker is built with its own default instead), and the
// spec turn, whose only way out is "BLOCKED:" for impossible.
//
// Run with: node --test tests/homeroom-bot-question-bar.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const json = (obj) => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

// ── The prompt ───────────────────────────────────────────────────────────

test('the triage prompt asks only about the two blockers, and decides the rest', () => {
  const prompt = read('src/prompts/homeroom-bot-triage.md');
  assert.match(prompt, /1\. `question` — ONLY for a real blocker\./);
  assert.match(prompt, /so almost everything you are unsure about is NOT a question: you decide it yourself and list it under `assumptions`/);
  assert.match(prompt, /a wrong assumption is cheap to fix and a needless question is not/);
  assert.match(prompt, /- `user_facing`: the answer changes what people will see or do, AND the plausible answers lead to builds so different that one could not be reviewed into the other/);
  assert.match(prompt, /- `impossible`: the request may be impossible or unsafe as written/);
  for (const notAQuestion of [
    /Taste and detail: colours, sizes, wording, icons, ordering, where on a screen something goes/,
    /"Should it also…\?", "Do you want X shown too\?": build what was asked, and no more\./,
    /Anything where the default you would suggest is what the request most plausibly meant\./,
  ]) assert.match(prompt, notAQuestion);
  assert.match(prompt, /If you cannot fill both honestly, it is not a question: decide it\./);
  assert.match(prompt, /a new integration or service, a feature that spans apps, an architecture choice\. The group decides those; do not turn them into a question\./,
    'product direction is a person\'s call, not a question to the reporter');
  assert.match(prompt, /"blocker": "user_facing" \| "impossible"/);
  assert.match(prompt, /"why_default_fails"/);
  assert.match(prompt, /"assumptions": \[/);
  assert.doesNotMatch(prompt, /Never ask when a sensible default exists\. Assume the default and treat the request as clear\./,
    'folded into the list of things it decides');
});

// ── The check in code ────────────────────────────────────────────────────

test('a question that names its blocker and why the default fails is posted as a question', () => {
  for (const blocker of bot.BLOCKERS) {
    const v = bot.parseVerdict(json({
      verdict: 'question', determined: false, missing_fact: 'x', question: 'Which of the two flows?',
      default: 'Start Match', blocker, why_default_fails: 'The two flows share no code.', build_note: 'x',
    }));
    assert.equal(v.verdict, 'question', blocker);
    assert.equal(v.reason, `${blocker}: The two flows share no code.`);
    assert.equal(v.demoted, false);
  }
});

test('a question that cannot say which blocker it is is built with its own default, as an assumption', () => {
  // rss-reader #24: it asked which colour, and proposed the answer itself.
  const cases = [
    { blocker: undefined, why: undefined },
    { blocker: 'taste', why: 'Colours are subjective.' },
    { blocker: 'user_facing', why: '' },
  ];
  for (const c of cases) {
    const v = bot.parseVerdict(json({
      verdict: 'question', determined: true, missing_fact: 'none',
      question: 'What exact colour should dark mode use?', default: 'zinc-950 (#09090b)',
      blocker: c.blocker, why_default_fails: c.why,
      build_note: 'Set the dark background in style.css.',
    }));
    assert.equal(v.verdict, 'ready', JSON.stringify(c));
    assert.equal(v.demoted, true);
    assert.equal(v.question, null, 'nothing is posted as a question');
    assert.equal(v.buildNote, [
      'Set the dark background in style.css.',
      '',
      'Assumptions:',
      '- zinc-950 (#09090b) (the triage asked "What exact colour should dark mode use?", but it was not a blocker)',
    ].join('\n'), 'the default rides into the spec and the build as an assumption');
    assert.equal(v.reason, 'Asked "What exact colour should dark mode use?", but it was not a blocker: built with its default, "zinc-950 (#09090b)".',
      'the dashboard and the export say so, for rating');
  }
});

test('with no plan to build from, an unjustified question stays a question', () => {
  const noPlan = bot.parseVerdict(json({ verdict: 'question', question: 'What did you mean by "Add time jo"?', default: 'A time filter' }));
  assert.equal(noPlan.verdict, 'question');
  assert.equal(noPlan.reason, null);
  const noDefault = bot.parseVerdict(json({ verdict: 'question', question: 'Which?', build_note: 'x' }));
  assert.equal(noDefault.verdict, 'question');
});

test('a ready verdict carries its assumptions under the build note, cleaned and bounded', () => {
  const v = bot.parseVerdict(json({
    verdict: 'ready', build_note: 'Edit public/app.js.',
    assumptions: ['Uses the app\'s grey  #1f2937\nfor the ground', '', 7, null, ...Array.from({ length: 20 }, (_, i) => `a${i}`)],
  }));
  assert.equal(v.assumptions.length, 12, 'bounded');
  assert.equal(v.assumptions[0], 'Uses the app\'s grey #1f2937 for the ground', 'one line each');
  assert.match(v.buildNote, /^Edit public\/app\.js\.\n\nAssumptions:\n- Uses the app's grey #1f2937 for the ground\n- a0\n/);
  const bare = bot.parseVerdict(json({ verdict: 'ready', build_note: 'Edit a.js.' }));
  assert.equal(bare.buildNote, 'Edit a.js.', 'no assumptions, no heading');
  assert.deepEqual(bot.parseVerdict(json({ verdict: 'person', reason: 'Billing.', assumptions: ['x'] })).assumptions, []);
});

// ── The spec: assumptions written down, and the one way out ─────────────

test('the spec lists every assumption, and may stop only for impossible', () => {
  const p = live.specPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.\n\nAssumptions:\n- Uses #111' });
  assert.match(p, /End the "User-facing changes" half with a\n"### Assumptions" subsection: every assumption listed in the plan above and every choice you made/);
  assert.match(p, /If reading the code shows the request is IMPOSSIBLE as written/);
  assert.match(p, /A choice, however unsure you are about it, is an assumption, never a BLOCKED\./);
  assert.match(p, /A reported bug counts as impossible when the code does not show it: if the request reports a bug and you\ncannot find where in the code it happens, reply "BLOCKED:" and say where you looked\./);
  assert.match(p, /the build does not guess\./);
  assert.equal(live.specBlocked('BLOCKED: The app has no user accounts to rank.'), 'The app has no user accounts to rank.');
  assert.equal(live.specBlocked('  blocked:  no such screen\n\nmore'), 'no such screen');
  assert.equal(live.specBlocked('# Title\n\nBLOCKED: not on the first line'), null);
  assert.equal(live.specBlocked('# Leaderboard'), null);
});

// ── The build: the rules the first shadow builds broke ──────────────────

test('the build keeps lockfiles, proves its checks, leaves existing tests alone, and does not guess at a bug', () => {
  for (const spec of [null, '# Title\n\n## User-facing changes\n\nx\n\n## Technical implementation\n\ny']) {
    const p = live.buildPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.', spec });
    const rules = p.slice(p.indexOf('Make exactly that change, and nothing else:'));
    assert.match(rules, /- Do not change a lockfile \(package-lock\.json, yarn\.lock, pnpm-lock\.yaml and the like\) unless the change\n  adds or removes a dependency\. If installing dependencies rewrote one, restore it before you finish/);
    assert.match(rules, /- A test or check you add must fail without your change: assert what the change makes true, not only that\n  the page loads\./);
    assert.match(rules, /- Do not loosen, skip, delete or rewrite an existing test or check to make it pass\. Change one only where\n  the spec changes the behaviour it pins, and name it in your summary\./);
    assert.match(rules, /- If the request reports a bug, find where in the code it happens before changing anything\. If you cannot\n  find it, stop and say so instead of changing code: do not ship a guessed fix\./);
    assert.ok(rules.indexOf('lockfile') < rules.indexOf('Do not commit or push yourself'), 'inside the rules, before the hand-off');
  }
});

function buildHarness(specText) {
  const calls = { modes: [], promoted: [] };
  const pool = { async query(sql) { return /INSERT INTO chat_sessions/.test(String(sql)) ? { rows: [{ id: 5001 }] } : { rows: [] }; } };
  const router = express.Router();
  router.post('/api/sessions/:id/promote', (req, res) => { calls.promoted.push(req.params.id); res.json({ ok: true }); });
  const deps = {
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker() { return 'w'; },
      async execInWorker(_id, opts) { calls.modes.push(opts.mode); return opts.mode === 'scout' ? { lastResultText: specText } : { pushOk: true, ahead: 1 }; },
      stopTurn() { return Promise.resolve(); },
    },
    sessions: {
      async runCodexAttemptLoop(args) { return { result: await args.dispatchOnce({}), estimatedCostUsd: 0.01 }; },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
    sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `b${sessionId}` }; } },
    activeWorkers: new Set(),
    votesRouter: router,
  };
  return { pool, deps, calls };
}

const ARGS = {
  config: {}, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'pulse' },
  repo: { owner: 'o', repo: 'r' }, issueNumber: 13, issue: { title: 'Leaderboard' }, seed: 'ISSUE',
  buildNote: 'x', turnBudgetMs: 60_000, model: 'm',
};

// ── From the platform build review (#3441) ───────────────────────────────

test('the spec checks its two halves against each other before it finishes', () => {
  const p = live.specPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.' });
  assert.match(p, /Before you finish, read the two halves against each other\. Every assumption, and everything "User-facing\nchanges" says people will see, must be true of what "Technical implementation" builds/);
  assert.match(p, /must build nothing the user-facing half leaves out\. Where they disagree, change one so they agree/);
  assert.ok(p.indexOf('read the two halves against each other') < p.indexOf('There is one exception.'),
    'part of writing the spec, before the one way out');
});

test('the build runs the queries it writes, does not stub what it changed, and commits no reports', () => {
  for (const spec of [null, '# Title\n\n## User-facing changes\n\nx\n\n## Technical implementation\n\ny']) {
    const p = live.buildPrompt({ seed: 'ISSUE', buildNote: 'Edit a.js.', spec });
    const rules = p.slice(p.indexOf('Make exactly that change, and nothing else:'));
    assert.match(rules, /- A database query you add or change must run in a test against a real database, where the repository has\n  such tests \(for example its \*-postgres tests\)\. A test that only matches the query's text does not count\./);
    assert.match(rules, /Do not stub the code you changed in the test that checks it: stub what it calls, not what it is\./);
    assert.match(rules, /- Do not add reports, notes or other documents to the repository unless the spec asks for that file\./);
    assert.ok(rules.indexOf('real database') < rules.indexOf('Do not commit or push yourself'), 'inside the rules, before the hand-off');
  }
});

test('triage sends a request for an explanation to a person, and still builds a bug report', () => {
  const prompt = read('src/prompts/homeroom-bot-triage.md');
  const ready = prompt.slice(prompt.indexOf('3. `ready`'), prompt.indexOf('4. `person`'));
  assert.match(ready, /- It asks for a change to the app\. A request that only asks for an explanation or a write-up \("why does X happen\?", "look into Y and report back"\) names nothing to build: the answer is a reply for a person, not a commit, so it is `person`\./);
  assert.match(ready, /A bug report \("X is broken", "X shows the wrong thing"\) is not this: it asks for X to be fixed\./);
  const person = prompt.slice(prompt.indexOf('4. `person`'), prompt.indexOf('Also state, whatever the verdict:'));
  assert.match(person, /So does a request that asks only for an explanation or an investigation\./);
});

test('a BLOCKED spec builds nothing and says why; a spec that merely mentions it builds', async () => {
  const h = buildHarness('BLOCKED: Pulse has no leaderboard data to rank.');
  let posted = false;
  const out = await live.buildAndPropose({ pool: h.pool, deps: h.deps, ...ARGS, onSpec: async () => { posted = true; } });
  assert.equal(out.ok, false);
  assert.equal(out.blocked, 'Pulse has no leaderboard data to rank.');
  assert.deepEqual(h.calls.modes, ['scout'], 'no build turn');
  assert.deepEqual(h.calls.promoted, []);
  assert.equal(posted, false, 'no spec to post');
  assert.equal(out.costUsd, 0.01);

  const ok = buildHarness('# Leaderboard\n\n## User-facing changes\nIf BLOCKED: appears here it is prose.\n\n## Technical implementation\nx');
  const built = await live.buildAndPropose({ pool: ok.pool, deps: ok.deps, ...ARGS });
  assert.equal(built.ok, true);
  assert.deepEqual(ok.calls.modes, ['scout', 'build']);
});

test('live: a blocked build is said on the issue like a question, untagged', async (t) => {
  const posts = [];
  const realPost = live.post;
  const realBuild = live.buildAndPropose;
  t.after(() => { live.post = realPost; live.buildAndPropose = realBuild; });
  live.post = async (args) => { posts.push(args); return {}; };
  live.buildAndPropose = async () => ({ ok: false, sessionId: 5001, blocked: 'Pulse has no leaderboard data to rank.', error: 'blocked: …', costUsd: 0 });
  const pool = { async query() { return { rows: [] }; } };
  const acted = await bot.buildLive({
    pool, config: {}, bot: { id: 77, username: 'homeroom_bot' }, app: { id: 9, slug: 'pulse' }, repo: { owner: 'o', repo: 'r' },
    issueNumber: 13, issue: { title: 'x' }, parsed: { verdict: 'ready', buildNote: 'x' }, capSuppressed: null, runId: 900,
    seed: 's', seedReadAt: '2026-09-28T10:00:00Z', postedAt: [], turnBudgetMs: 1000, model: 'm',
    deps: {
      github: { getBotUsername: async () => 'usernode-bot', async fetchIssueComments() { return { comments: [] }; } },
      ws: {}, threadContext: { async loadIssueThread() { return { messages: [] }; } },
      limits: { async recordSpend() {} }, managedOpenRouter: { async usesIncludedKey() { return false; } }, domain: 'x',
    },
  });
  assert.equal(acted, 'blocked');
  assert.deepEqual(posts.map((p) => p.kind), ['blocked']);
  assert.match(posts[0].text, /^Homeroom bot started on this and found it cannot be built as asked:\n\nPulse has no leaderboard data to rank\.\n\nReply here/);
  // One request, one story: a build that stopped is progress, said untagged;
  // whoever asked for it hears it in their chat with the bot.
  assert.equal(live.tagsPoster('blocked'), false);
});

// ── Comparing old against new ────────────────────────────────────────────

test('re-triaging every question is gone with the shadow apps it worked on; the dashboard still shows the bar', () => {
  // It only ever queued questions on apps the bot did not act on, and every
  // app but a paused one is live now, so the button and its route went.
  assert.equal(bot.retriageQuestions, undefined);
  assert.doesNotMatch(read('src/routes/admin.js'), /retriage-questions/);
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.doesNotMatch(tsx, /id="admin-homeroom-bot-retriage"|retriage-questions/);
  assert.match(tsx, /data-question-blocker/);
  assert.match(tsx, /data-demoted-question/);
});
