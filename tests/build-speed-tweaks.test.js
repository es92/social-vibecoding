'use strict';

// Build speed (13 Oct 2026): the GLM build was 33 of run five's 52 minutes
// from Make it to live. Each change that makes a first version's build do
// less work is a recipe's TWEAK (services/bot-configs.js TWEAKS), benched as
// a configuration of its own before it is anyone's default:
//
//   one_look        the build's check is one look, then it stops; the
//                   reviewer does the sweep (homeroom-bot-live.js
//                   oneLookLines, clockLines, firstVersionDesignLines);
//   starter_inline  the checkout as the build starts is in its prompt
//                   (worker.js readRepoSnapshot, homeroom-bot-live.js
//                   starterLines);
//   lean_turns      the declared checks are left to the gate, and stale
//                   browser and shell output is cut from each model call
//                   (claude-openrouter-request.js pruneStaleToolOutput);
//   lean_plan       the spec plans a focused first version, shorter, with
//                   one drawn screen and "Not in this version" in place of
//                   nice-to-haves, which the build leaves out
//                   (homeroom-bot-live.js LEAN_PLAN_SCOPE_LINES).
//
// Today's recipes, and every build that names no tweak, are pinned to be
// exactly as they were.
//
// Run with: node --test tests/build-speed-tweaks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const configs = require('../src/services/bot-configs');
const live = require('../src/services/homeroom-bot-live');
const botReview = require('../src/services/bot-review');
const adapter = require('../worker/claude-openrouter-request');
const worker = require('../src/services/worker');
const llmTelemetry = require('../src/services/llm-telemetry');
const { IN_LOOP_BROWSER_GUIDANCE } = require('../src/services/in-loop-browser');

const GLM = 'z-ai/glm-5.3-flash';
const OPUS = 'anthropic/claude-opus-5.5';
const REVIEWED = { models: { triage: GLM, spec: OPUS, build: GLM }, reviewer: { model: OPUS, maxRounds: 2, budgetMinutes: 20 }, pack: null };

// ── Recipes ──────────────────────────────────────────────────────────────

test('a recipe without tweaks is stored exactly as before tweaks existed', () => {
  const v = configs.validateRecipe(REVIEWED);
  assert.equal(v.ok, true);
  assert.deepEqual(Object.keys(v.recipe), ['models', 'reviewer', 'pack']);
  assert.equal(JSON.stringify(configs.validateRecipe({ ...REVIEWED, tweaks: [] }).recipe), JSON.stringify(v.recipe));
  assert.deepEqual(configs.tweaksOf(REVIEWED), []);
  assert.equal(configs.recipeLine(REVIEWED).includes('tweaks'), false);
  // Every seed still validates to itself, so upgradeSeedConfigs' jsonb match holds.
  for (const seed of [...configs.SEED, ...configs.SEED_LATER]) {
    assert.equal(JSON.stringify(configs.validateRecipe(seed.recipe).recipe), JSON.stringify(seed.recipe), seed.key);
  }
});

test('tweaks are named, kept in one order, each once, and one_look needs a reviewer', () => {
  const v = configs.validateRecipe({ ...REVIEWED, tweaks: ['lean_turns', ' one_look', 'lean_turns', 'starter_inline'] });
  assert.equal(v.ok, true, v.error);
  assert.deepEqual(v.recipe.tweaks, ['one_look', 'starter_inline', 'lean_turns']);
  assert.match(configs.recipeLine(v.recipe), /tweaks one_look, starter_inline, lean_turns$/);
  assert.deepEqual(configs.tweaksOf(v.recipe), ['one_look', 'starter_inline', 'lean_turns']);

  const unknown = configs.validateRecipe({ ...REVIEWED, tweaks: ['one_look', 'faster'] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown tweaks: faster/);
  assert.equal(configs.validateRecipe({ ...REVIEWED, tweaks: 'one_look' }).ok, false);
  assert.equal(configs.validateRecipe({ ...REVIEWED, tweaks: [1] }).ok, false);
  const noReviewer = configs.validateRecipe({ ...REVIEWED, reviewer: null, tweaks: ['one_look'] });
  assert.equal(noReviewer.ok, false);
  assert.match(noReviewer.error, /needs a reviewer/);
  const noRounds = configs.validateRecipe({ ...REVIEWED, reviewer: { ...REVIEWED.reviewer, maxRounds: 0 }, tweaks: ['one_look'] });
  assert.equal(noRounds.ok, false, 'a capture-only reviewer sweeps nothing');
  assert.equal(configs.validateRecipe({ ...REVIEWED, reviewer: null, tweaks: ['lean_turns'] }).ok, true);
  // App bench run 191's compactions: roomy_context, after lean_plan in the list's order.
  const roomy = configs.validateRecipe({ ...REVIEWED, tweaks: ['roomy_context', 'lean_plan'] });
  assert.equal(roomy.ok, true, roomy.error);
  assert.deepEqual(roomy.recipe.tweaks, ['lean_plan', 'roomy_context']);
  assert.equal(configs.validateRecipe({ ...REVIEWED, reviewer: null, tweaks: ['roomy_context'] }).ok, true, 'no reviewer needed');
});

test('roomy_context changes no prompt: the spec and the build read exactly as without it', () => {
  for (const html of [true, false]) {
    const args = { ...SPEC_ARGS, html };
    assert.equal(live.specPrompt({ ...args, tweaks: ['roomy_context'] }), live.specPrompt(args));
  }
  assert.equal(live.buildPrompt({ ...BASE, tweaks: ['roomy_context'] }), live.buildPrompt(BASE));
  assert.equal(live.buildPrompt({ ...BASE, tweaks: ['lean_plan', 'roomy_context'] }), live.buildPrompt({ ...BASE, tweaks: ['lean_plan'] }));
});

test('a side recipe that differs by its tweaks is built, never taken from the live round-0 snapshot', () => {
  const noReview = { ...REVIEWED, reviewer: null };
  assert.equal(configs.derivableFrom(REVIEWED, noReview), true, 'as before');
  assert.equal(configs.derivableFrom(REVIEWED, { ...noReview, tweaks: ['lean_turns'] }), false);
  assert.equal(configs.derivableFrom({ ...REVIEWED, tweaks: ['lean_turns'] }, { ...noReview, tweaks: ['lean_turns'] }), true);
});

test('a later-changes recipe takes no tweaks', async () => {
  const r = await configs.saveVersion({}, {
    label: 'Lean later', recipe: { ...REVIEWED, reviewer: null, tweaks: ['lean_turns'] }, role: 'retired', scope: 'later',
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /no tweaks/);
});

test('a studio arm built by a configuration carries its tweaks', async () => {
  const lanes = require('../src/services/bench/lane');
  const pool = { async query() { return { rows: [] }; } };
  const settings = { models: { triage: 'stage/triage', spec: 'stage/spec', build: 'stage/build' } };
  const real = configs.versionById;
  configs.versionById = async (_p, id) => ({
    11: { id: 11, recipe: { ...REVIEWED, tweaks: ['one_look', 'lean_turns'] } },
    12: { id: 12, recipe: REVIEWED },
  })[id] || null;
  try {
    const arm = await lanes.studioContext(pool, {}, { model: 'config:11', context_pack_id: null, bot_config_version_id: null }, settings);
    assert.deepEqual(arm.tweaks, ['one_look', 'lean_turns']);
    const plain = await lanes.studioContext(pool, {}, { model: 'config:12', context_pack_id: null, bot_config_version_id: null }, settings);
    assert.equal('tweaks' in plain, false, 'none named, none carried');
  } finally {
    configs.versionById = real;
  }
});

// ── The build prompt ─────────────────────────────────────────────────────

const STARTED = Date.parse('2026-10-13T09:00:00Z');
const BASE = {
  seed: 'Build issue #1: Club Votes', buildNote: 'The plan.', spec: '# Club Votes\n\nThe spec.', firstVersion: true,
  readsImages: true, reviewed: true, appChecks: true, clock: { startedAt: STARTED, budgetMs: 40 * 60 * 1000 },
};
const flat = (s) => s.replace(/\s+/g, ' ');

test('a build with no tweaks, or a later change given some, reads exactly as before', () => {
  const before = live.buildPrompt(BASE);
  assert.equal(live.buildPrompt({ ...BASE, tweaks: [] }), before);
  const later = { ...BASE, firstVersion: false, reviewed: false };
  assert.equal(live.buildPrompt({ ...later, tweaks: ['one_look', 'starter_inline', 'lean_turns'], starterSnapshot: { files: [] } }),
    live.buildPrompt(later));
  assert.equal(live.inLoopGuidance(), IN_LOOP_BROWSER_GUIDANCE);
  assert.ok(before.includes(IN_LOOP_BROWSER_GUIDANCE), 'the in-loop guidance as the dev chat has it');
});

test('one_look: one look at one width, fix only what is broken, then stop; no polish rounds anywhere', () => {
  const before = flat(live.buildPrompt(BASE));
  const prompt = flat(live.buildPrompt({ ...BASE, tweaks: ['one_look'] }));
  assert.match(prompt, /the check is ONE LOOK/);
  assert.match(prompt, /at 390x844 in the light look only, take one screenshot \(`browser_take_screenshot`\) of each main screen the spec names/);
  assert.match(prompt, /Fix only what that look shows is BROKEN/);
  assert.match(prompt, /takes the place of the design guidance's "Checking your work"/);
  assert.match(prompt, /There is no step 4/);
  assert.ok(!/4\. Only then/.test(prompt), 'no polish step on the clock');
  assert.ok(!/look-and-fix rounds, compare/.test(prompt), 'the design lines ask for no rounds');
  assert.match(prompt, /there are no look-and-fix rounds, and the reviewer compares the finished screens with the drawn ones/);
  assert.ok(/4\. Only then/.test(before) && /look-and-fix rounds, compare/.test(before), 'both are said without it');
  // A text-only model walks the snapshot instead.
  assert.match(flat(live.buildPrompt({ ...BASE, readsImages: false, tweaks: ['one_look'] })), /once through its accessibility snapshot/);
  // Without a reviewer there is no one look: the build checks for itself.
  assert.equal(live.buildPrompt({ ...BASE, reviewed: false, tweaks: ['one_look'] }), live.buildPrompt({ ...BASE, reviewed: false }));
  // A game starter's wording is swapped on top of it.
  const game = flat(live.firstVersionDesignLines('game-blocks', { oneLook: true }).join('\n'));
  assert.match(game, /there are no look-and-fix rounds/);
  assert.match(game, /game starter's screens work/);
});

test('lean_turns: the declared checks are left to the gate, in the build and in a review\'s fix', () => {
  const prompt = live.buildPrompt({ ...BASE, tweaks: ['lean_turns'] });
  assert.ok(!prompt.includes('RUN THE DECLARED CHECKS IN-LOOP'), 'no hand-run checks in the in-loop guidance');
  assert.match(flat(prompt), /THE DECLARED CHECKS run by themselves/);
  assert.match(flat(prompt), /Do not run them yourself along the way: when you try to finish, the platform runs every declared check/);
  assert.ok(!/Before you finish, run `sh /.test(prompt));
  assert.ok(prompt.includes('PROPOSAL CHECKS'), 'it still adds the checks a new screen needs');
  // No gate (the platform's own repository), nothing to leave them to.
  assert.equal(live.buildPrompt({ ...BASE, appChecks: false, tweaks: ['lean_turns'] }), live.buildPrompt({ ...BASE, appChecks: false }));

  const issues = [{ id: 'a', severity: 'major', screen: 'Home', problem: 'p', fix: 'f' }];
  const fix = botReview.fixPrompt({ spec: 'S', issues, appChecks: true, tweaks: ['lean_turns'] });
  assert.ok(!fix.includes('RUN THE DECLARED CHECKS IN-LOOP'));
  assert.match(flat(fix), /Do not run them yourself along the way/);
  assert.equal(botReview.fixPrompt({ spec: 'S', issues, appChecks: true, tweaks: [] }), botReview.fixPrompt({ spec: 'S', issues, appChecks: true }));
  assert.ok(botReview.fixPrompt({ spec: 'S', issues, appChecks: true }).includes(IN_LOOP_BROWSER_GUIDANCE));
});

const SNAPSHOT = {
  files: [
    { path: '.claude/README.md', bytes: 50, lines: 3, text: 'plumbing' },
    { path: '.claude/settings.json', bytes: 20, lines: 1, text: '{}' },
    { path: '.claude/skills/frontend-design/LICENSE.txt', bytes: 30, lines: 1, text: 'Apache' },
    { path: '.claude/skills/frontend-design/SKILL.md', bytes: 40, lines: 2, text: '# Skill\nDesign well.' },
    { path: 'CLAUDE.md', bytes: 20, lines: 2, text: '# App\nRules.' },
    { path: 'Dockerfile', bytes: 20, lines: 1, text: 'FROM node' },
    { path: 'dapp.json', bytes: 16, lines: 1, text: '{"secrets": []}' },
    { path: 'package-lock.json', bytes: 73000, lines: 2073 },
    { path: 'public/index.html', bytes: 30, lines: 2, text: '<!doctype html>\n<body></body>' },
    { path: 'public/vendor/three.js', bytes: 742000, lines: 1 },
    { path: 'server.js', bytes: 20, lines: 1, text: 'const app = 1;\n\n' },
  ],
  more: 0,
};

test('starter_inline: the build is handed the files it reads, in full, and told not to read them again', () => {
  const prompt = live.buildPrompt({ ...BASE, tweaks: ['starter_inline'], starterSnapshot: SNAPSHOT });
  assert.match(prompt, /==== THE REPOSITORY AS THIS BUILD STARTS/);
  assert.match(prompt, /- package-lock\.json \(2073 lines\)\n/, 'every tracked file is listed');
  assert.match(prompt, /- server\.js \(1 lines\) \(in full below\)/);
  assert.match(prompt, /- CLAUDE\.md \(2 lines\) \(your project instructions, already loaded\)/);
  assert.match(prompt, /---- server\.js ----\nconst app = 1;\n---- end of server\.js ----/);
  assert.match(prompt, /---- \.claude\/skills\/frontend-design\/SKILL\.md ----/);
  assert.match(prompt, /The frontend-design skill the guidance asks you to read is one of them/);
  assert.match(prompt, /Do not read them again: start building from here/);
  for (const out of ['Dockerfile', '.claude/settings.json', '.claude/README.md', 'LICENSE.txt', 'CLAUDE.md']) {
    assert.ok(!prompt.includes(`---- ${out}`) && !prompt.includes(`frontend-design/${out} ----`), `${out} is not shown`);
  }
  // Before the first version's design lines, after the spec.
  assert.ok(prompt.indexOf('==== END SPEC ====') < prompt.indexOf('THE REPOSITORY AS'));
  assert.ok(prompt.indexOf('THE REPOSITORY AS') < prompt.indexOf('This is the app\'s FIRST VERSION'));
  // A CLI that does not load CLAUDE.md itself is shown it.
  assert.match(live.buildPrompt({ ...BASE, tweaks: ['starter_inline'], starterSnapshot: SNAPSHOT, claudeMdLoaded: false }), /---- CLAUDE\.md ----/);
  // No snapshot (it could not be read), or no tweak: the build as before.
  assert.equal(live.buildPrompt({ ...BASE, tweaks: ['starter_inline'] }), live.buildPrompt(BASE));
  assert.equal(live.buildPrompt({ ...BASE, starterSnapshot: SNAPSHOT }), live.buildPrompt(BASE));
});

test('one_go: the whole first version written before anything is booted, from the repository it is handed', () => {
  const prompt = live.buildPrompt({ ...BASE, tweaks: ['one_go'], starterSnapshot: SNAPSHOT });
  assert.match(prompt, /WRITE IT IN ONE GO/);
  assert.match(flat(prompt), /Read nothing first/);
  assert.match(flat(prompt), /several WHOLE files at once, one Write call per file/);
  assert.match(prompt, /==== THE REPOSITORY AS THIS BUILD STARTS/, 'the repository comes with it');
  assert.ok(prompt.indexOf('WRITE IT IN ONE GO') > prompt.indexOf('Build in the order the spec\'s "Build order" gives'));
  assert.ok(!live.buildPrompt(BASE).includes('WRITE IT IN ONE GO'));
  assert.equal(live.buildPrompt({ ...BASE, firstVersion: false, reviewed: false, tweaks: ['one_go'] }),
    live.buildPrompt({ ...BASE, firstVersion: false, reviewed: false }));
  for (const line of live.ONE_GO_LINES) assert.ok(!/—/.test(line), line);
});

test('starter_inline: the files shown stay under the cap, the skill first, the smallest next', () => {
  const big = (n) => 'x'.repeat(n);
  const files = [
    { path: '.claude/skills/frontend-design/SKILL.md', lines: 1, text: big(12000) },
    { path: 'a.js', lines: 1, text: big(30000) },
    { path: 'b.js', lines: 1, text: big(31000) },
    { path: 'c.js', lines: 1, text: big(20000) },
    { path: 'huge.js', lines: 1, text: big(40000) },
  ];
  const { shown } = live.starterInlineFiles({ files });
  const total = shown.reduce((n, f) => n + f.text.length, 0);
  assert.ok(total <= live.STARTER_INLINE_MAX_CHARS, String(total));
  assert.deepEqual(shown.map((f) => f.path), ['.claude/skills/frontend-design/SKILL.md', 'a.js', 'c.js']);
});

test('the worker reads its checkout in one go: paths, sizes and lines of every tracked file, the text of the small ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-snapshot-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'public', 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.js'), 'const a = 1;\nconst b = 2;\n');
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'public', 'vendor', 'lib.js'), 'x\n');
  fs.writeFileSync(path.join(dir, 'icon.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  fs.writeFileSync(path.join(dir, 'big.js'), 'y'.repeat(60 * 1024));
  fs.writeFileSync(path.join(dir, 'untracked.js'), 'never listed\n');
  git('add', 'server.js', 'package-lock.json', 'public/vendor/lib.js', 'icon.png', 'big.js');
  const script = path.join(dir, '..', `${path.basename(dir)}-snapshot.js`);
  fs.writeFileSync(script, worker.repoSnapshotScript());
  const out = JSON.parse(execFileSync('node', [script], { cwd: dir }).toString());
  const byPath = Object.fromEntries(out.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['big.js', 'icon.png', 'package-lock.json', 'public/vendor/lib.js', 'server.js']);
  assert.deepEqual(byPath['server.js'], { path: 'server.js', bytes: 26, lines: 3, text: 'const a = 1;\nconst b = 2;\n' });
  for (const p of ['package-lock.json', 'public/vendor/lib.js', 'icon.png', 'big.js']) assert.equal('text' in byPath[p], false, p);
  assert.equal(out.more, 0);
});

// ── The request adapter ──────────────────────────────────────────────────

function conversation(n, { tool = 'mcp__playwright__browser_snapshot', size = 5000 } = {}) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Build it.' }] }];
  for (let i = 1; i <= n; i += 1) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: tool, input: {} }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: `${i}:${'s'.repeat(size)}` }] }] });
  }
  return messages;
}
const resultText = (m) => m.content[0].content[0].text;

test('lean_turns: only the latest few large browser and shell results go whole; the cut moves in steps', () => {
  const keep = adapter.KEEP_LATEST_OUTPUTS;
  const step = adapter.PRUNE_STEP_OUTPUTS;
  const short = conversation(keep + step - 1);
  assert.equal(adapter.pruneStaleToolOutput(short), short, 'below the first cut nothing changes');

  const counts = {};
  const long = conversation(keep + step);
  const pruned = adapter.pruneStaleToolOutput(long, { counts });
  const results = pruned.filter((m) => m.role === 'user' && m.content[0].type === 'tool_result');
  const cutOnes = results.slice(0, step);
  for (const m of cutOnes) {
    assert.ok(resultText(m).length < 600, 'shortened');
    assert.match(resultText(m), /more characters of this earlier mcp__playwright__browser_snapshot output were left out/);
  }
  for (const m of results.slice(step)) assert.ok(resultText(m).length > 5000, 'the latest go whole');
  assert.equal(counts.pruned, step);
  assert.ok(counts.chars > step * 4000);
  assert.equal(long[2].content[0].content[0].text.length > 5000, true, 'the conversation it was given is not changed');

  // Between cuts the prefix is byte for byte the same.
  const next = adapter.pruneStaleToolOutput(conversation(keep + step + 1));
  assert.equal(JSON.stringify(next.slice(0, pruned.length)), JSON.stringify(pruned));
});

test('lean_turns: a file read, an error, a small result and an image are never cut', () => {
  const reads = conversation(12, { tool: 'Read' });
  assert.equal(adapter.pruneStaleToolOutput(reads), reads);
  const cats = conversation(12, { tool: 'Bash' });
  cats.forEach((m, i) => {
    if (m.role === 'assistant') m.content[0].input = { command: i % 4 === 1 ? 'cat server.js' : 'cd /home/node/workspace && sed -n 1,80p public/app.js' };
  });
  assert.equal(adapter.pruneStaleToolOutput(cats), cats, 'a shell command that prints a file is a read');
  const small = conversation(12, { size: 500 });
  assert.equal(adapter.pruneStaleToolOutput(small), small);
  const errors = conversation(12);
  for (const m of errors) if (m.role === 'user' && m.content[0].type === 'tool_result') m.content[0].is_error = true;
  assert.equal(adapter.pruneStaleToolOutput(errors), errors);
  const shots = conversation(12, { tool: 'Bash' });
  shots[2].content[0].content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  const pruned = adapter.pruneStaleToolOutput(shots);
  assert.equal(pruned[2].content[0].content.at(-1).type, 'image', 'the image cut has the images');
  assert.match(pruned[2].content[0].content[0].text, /earlier Bash output/);
});

test('lean_turns: the policy cuts only when asked, and says what it cut', () => {
  const body = () => ({ model: 'x', messages: conversation(12), max_tokens: 1000 });
  const off = adapter.applyTurnPolicy(body(), { model: GLM, countTokens: true });
  assert.ok(off.messages.every((m) => m.role !== 'user' || m.content[0].type !== 'tool_result' || resultText(m).length > 5000));
  const outputCounts = { pruned: 0, chars: 0 };
  const on = adapter.applyTurnPolicy(body(), { model: GLM, countTokens: true, pruneToolOutput: true, outputCounts });
  assert.equal(outputCounts.pruned, 8);
  assert.ok(on.messages.some((m) => m.role === 'user' && m.content[0].type === 'tool_result' && resultText(m).length < 600));
});

test('lean_turns: what a turn cut, and what its tool definitions weigh, reach its metrics', () => {
  const state = worker.newWatchState();
  state.agentBackend = 'codex_openrouter';
  state.agentHarness = 'claude';
  state.telemetryDiagnosticsEnabled = true;
  const provider = (event) => worker.parseLine(`__USERNODE_CODING_PROVIDER__ ${JSON.stringify(event)}`, () => {}, state);
  provider({ kind: 'provider_request_start', requestOrdinal: 1, atMs: 1000, payloadBytes: 90_000, inputBytes: 60_000,
    instructionBytes: 300, toolBytes: 29_000, inputItems: 9, previousResponseLinked: false, maxOutputTokens: 64000 });
  provider({ kind: 'provider_request_result', requestOrdinal: 1, httpStatus: 200, outcome: 'ok',
    images: { sent: 0, moved: 0, omitted: 0, pruned: 0 }, toolOutput: { pruned: 4, chars: 18_000 } });
  provider({ kind: 'provider_request_result', requestOrdinal: 2, httpStatus: 200, outcome: 'ok',
    images: { sent: 0, moved: 0, omitted: 0, pruned: 0 }, toolOutput: { pruned: 4, chars: 18_000 } });
  const metrics = llmTelemetry.normalizeDiagnostics(state);
  assert.equal(metrics.tool_output_pruned_count, 8);
  assert.equal(metrics.tool_output_pruned_chars, 36_000);
  assert.equal(metrics.first_request_tool_bytes, 29_000);
  // A turn without the tweak reports nothing new.
  const plain = worker.newWatchState();
  assert.equal(llmTelemetry.normalizeDiagnostics(plain).tool_output_pruned_count ?? null, null);
});

// ── lean_plan: the plan, and what the build makes of it ─────────────────

const SPEC_ARGS = { seed: 'Build issue #1: Club Votes', buildNote: 'The plan.', firstVersion: true, html: true, platformStyles: false };

test('lean_plan: a recipe may name it, and a spec or build that does not reads exactly as before', () => {
  const v = configs.validateRecipe({ ...REVIEWED, tweaks: ['lean_plan', 'one_look'] });
  assert.equal(v.ok, true, v.error);
  assert.deepEqual(v.recipe.tweaks, ['one_look', 'lean_plan']);
  assert.equal(configs.validateRecipe({ ...REVIEWED, reviewer: null, tweaks: ['lean_plan'] }).ok, true, 'no reviewer needed');
  for (const html of [true, false]) {
    const args = { ...SPEC_ARGS, html };
    const before = live.specPrompt(args);
    assert.equal(live.specPrompt({ ...args, tweaks: [] }), before);
    assert.equal(live.specPrompt({ ...args, tweaks: ['one_look', 'starter_inline', 'lean_turns', 'one_go'] }), before,
      'the build tweaks leave the spec alone');
    const later = { ...args, firstVersion: false };
    assert.equal(live.specPrompt({ ...later, tweaks: ['lean_plan'] }), live.specPrompt(later), 'a later change is as small as asked already');
  }
  assert.equal(live.buildPrompt({ ...BASE, tweaks: ['lean_plan'], firstVersion: false, reviewed: false }),
    live.buildPrompt({ ...BASE, firstVersion: false, reviewed: false }));
});

test('lean_plan: the spec plans the request done well, the platform\'s minimums, and nothing else, in a third of the length', () => {
  const before = flat(live.specPrompt(SPEC_ARGS));
  const prompt = flat(live.specPrompt({ ...SPEC_ARGS, tweaks: ['lean_plan'] }));
  assert.match(prompt, /A focused first version: what the request asks for, done well, and nothing it does not name\./);
  assert.match(prompt, /It never means more features/);
  // The platform's own minimums, named, so leaving out the rest cuts none of them.
  for (const minimum of [/populated `\?demo=1`/, /shutdown handler/, /a way to report a post wherever people post/,
    /`staging:private`/, /a guard on any server fetch of an address a person typed/]) assert.match(prompt, minimum);
  // Run 191: three builds wrote their checks under `checks`, which the platform never reads.
  assert.match(prompt, /two or three checks in dapp\.json's `tests` array \(the platform reads no other key\)/);
  // Run 189's plans invented these.
  assert.match(prompt, /No product policy or lifecycle that the request's words and what its creator approved do not need: no moderation thresholds or automatic hiding, no archiving or expiry, no bulk actions/);
  // Run 191's lean plans cut what the request's own words needed, and a way to remove what a person added.
  assert.match(prompt, /What the request names includes what its own words and examples need\. Where it says people choose or decide something, they have the choices to pick from and a way to settle on one; where its result promises a list \(the steps, the items, the amounts\), every entry is there\./);
  assert.match(prompt, /a person can remove what they added: that is part of adding it, not an extra\./);
  assert.ok(!/no undo/.test(prompt) && !/closing, archiving or deciding/.test(prompt));
  // And five of six drew two filled buttons on the empty screen.
  assert.match(prompt, /one clear primary action on each screen, a filled button \(small on a screen for reading\)\. On an empty screen that action is the empty state's own button, and nothing else there is filled, the header's add button and a pinned or floating one included; on an error screen nothing but Retry is filled\./);
  assert.match(prompt, /about 15,000 characters in all, the drawn screens included/);
  assert.match(prompt, /no SQL, no catalogue of error messages, no unit-test suite/);
  assert.match(prompt, /At most five assumptions\./);
  assert.match(prompt, /keep it unless it has a defect you can name/);
  // Run 196 (Club Votes): a plan that could not do the request's own
  // examples was kept, and what they needed went under Not in this version.
  assert.match(prompt, /A plan that cannot do one of the request's own examples has such a defect: widen it to fit\./);
  assert.match(prompt, /Tap targets at least 44px tall, and icons as inline SVG, never emoji, the favicon included/);
  assert.match(prompt, /"Not in this version": each idea you left out, one line each, and never what the request's own words or examples need\. The build does not implement them, and the user-facing half does not describe them\./);
  assert.ok(!/Nice-to-haves/.test(prompt) && /Nice-to-haves/.test(before), 'no nice-to-haves list');
  assert.ok(!/including the small touches that make it feel finished/.test(prompt) && /including the small touches/.test(before));
  // One drawn screen, shorter, a few rows; the Design subsection does not describe it again.
  assert.match(prompt, /draws ONE screen of the finished first version, in full, as a faithful mock \(a second only when the app has a second layout that matters\)/);
  assert.match(prompt, /never the main screen again in another state/);
  assert.match(prompt, /at most 1400/);
  assert.match(prompt, /stays within about 10,000 characters/);
  assert.match(prompt, /Draw three or four repeated rows/);
  assert.match(prompt, /What the drawing shows \(the layout, the rows, the controls\) is not described again\./);
  assert.ok(!/UP TO TWO screens/.test(prompt) && /UP TO TWO screens/.test(before));
  // The rest of a first version's spec is as it was.
  for (const kept of ['DRAW THE MAIN SCREEN FIRST', 'HTML SPEC FORMAT', 'DESIGN BRIEF (FIRST VERSION)', 'Before you finish, read the two halves against each other']) {
    assert.ok(prompt.includes(kept) && before.includes(kept), kept);
  }
  // The markdown spec, which draws no screen, gets the scope and not the screen lines.
  const md = flat(live.specPrompt({ ...SPEC_ARGS, html: false, tweaks: ['lean_plan'] }));
  assert.match(md, /A focused first version/);
  assert.ok(!/With the screen drawn/.test(md));
  for (const line of [...live.LEAN_PLAN_SCOPE_LINES, ...live.LEAN_PLAN_ORDER_LINES, live.LEAN_PLAN_DESIGN_LINE]) assert.ok(!/—/.test(line), line);
  // A game starter keeps its own lines.
  assert.match(flat(live.specScopeLines(true, 'game-blocks', { leanPlan: true }).join('\n')), /Built ON the repository's .* A focused first version/);
});

test('lean_plan: the build does the must-haves and nothing under "Not in this version", and writes no unit-test suite it was not asked for', () => {
  const prompt = flat(live.buildPrompt({ ...BASE, tweaks: ['lean_plan'] }));
  assert.match(prompt, /Build the must-haves in the order the spec's "Build order" gives, and nothing it lists under "Not in this version", even with time left/);
  assert.match(prompt, /Write no unit-test suite unless the spec's technical half asks for one: a first version's checks are its dapp\.json `tests`\./);
  assert.ok(!/then the nice-to-haves/.test(prompt));
  assert.match(flat(live.buildPrompt(BASE)), /then the nice-to-haves, most valuable first, only while time is left/, 'as before without it');
});

test('lean_plan: a first version\'s build hands it to its spec turn', async () => {
  const run = async (tweaks) => {
    const prompts = [];
    const pool = { async query(sql) { return /INSERT INTO chat_sessions/.test(sql) ? { rows: [{ id: 5001, app_id: 1, user_id: 2 }] } : { rows: [] }; } };
    const deps = {
      worker: {
        async ensureWorkerImage() {},
        async ensureWorker() { return 'w-5001'; },
        async execInWorker(_id, opts) {
          prompts.push(opts);
          return opts.mode === 'scout' ? { lastResultText: '' } : { pushOk: true, ahead: 0 };
        },
        stopTurn() { return Promise.resolve(); },
        async runLiveScript() { return ''; },
      },
      sessions: {
        async runCodexAttemptLoop(args) { return { result: await args.dispatchOnce({}), error: null, estimatedCostUsd: null }; },
        async persistScoutPublication() { return { specVersion: 1 }; },
      },
      agentTurn: { async resolveCodexRuntimeContext() { return {}; } },
      sessionLifecycle: { async ensureSessionBranch({ sessionId }) { return { branchName: `b${sessionId}` }; } },
      activeWorkers: new Set(),
    };
    await live.buildAndPropose({
      pool, deps, config: {}, bot: { id: 2, username: 'bot' }, app: { id: 1, slug: 'club-votes' }, repo: { owner: 'o', repo: 'r' },
      issueNumber: 1, issue: { title: 'Club Votes' }, seed: 'seed', buildNote: 'note', turnBudgetMs: 600000, model: GLM,
      firstVersion: true, propose: false, tweaks,
    });
    return prompts;
  };
  const lean = await run(['lean_plan']);
  assert.equal(lean[0].mode, 'scout');
  assert.match(lean[0].prompt, /A focused first version/);
  assert.match(flat(lean[1].prompt), /nothing it lists under "Not in this version"/);
  const plain = await run([]);
  assert.ok(!/A focused first version/.test(plain[0].prompt));
});
