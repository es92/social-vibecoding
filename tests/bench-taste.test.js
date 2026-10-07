'use strict';

// #3737: the benchmark's taste eval for first versions. The two task kinds
// (a first version built from a brief on today's starter, and an app
// captured at a commit), the seeded `taste-v1` suite, the screenshot step's
// plan and its checks, the tells lint, the taste rubric, and the trial
// stages themselves on stubbed workers, with nothing leaving the benchmark.
// tests/bench-taste-postgres.test.js covers the suite, launch and grading
// items against the full schema; tests/bench-capture-run.test.js runs the
// screenshot step for real.

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const taste = require('../src/services/bench/taste');
const capture = require('../src/services/bench/capture');
const step = require('../worker/usernode-bench-capture');
const runner = require('../src/services/bench/runner');
const scaffold = require('../src/services/bench/scaffold');
const grading = require('../src/services/bench/grading');
const graders = require('../src/services/bench/graders');
const report = require('../src/services/bench/report');
const lane = require('../src/services/bench/lane');
const catalog = require('../src/services/bench/catalog');
const suites = require('../src/services/bench/suites');
const worker = require('../src/services/worker');
const bot = require('../src/services/homeroom-bot');
const live = require('../src/services/homeroom-bot-live');
const dm = require('../src/services/homeroom-bot-dm');
const githubModule = require('../src/services/github');
const { getTemplateFiles } = require('../src/services/template');

const EAR_TRAINER = 'An app to learn relative notes / chords, and then basic chord progressions. Chord progressions to learn should be taken from popular songs, and hymns. Learning progressions should take more different notes / chords / chord progressions first, and then add in the ones that sound closer until you are being quizzed on the full set. You should be able to select how big the set is from a list of lessons that get progressively harder for each lesson type.';

// ── The task kinds ──────────────────────────────────────────────────────

test('the two task kinds are stages of their own, made from a brief or a commit and never from a run', async () => {
  assert.deepEqual(suites.TASTE_STAGES, ['first_version', 'capture']);
  for (const stage of suites.TASTE_STAGES) {
    assert.ok(suites.TASK_STAGES.includes(stage));
    assert.equal(suites.SNAPSHOT_STAGE[stage], 'build', 'its inputs are recorded as a build snapshot');
    assert.ok(runner.STAGE_RUNNERS[stage], `${stage} has a runner`);
    assert.ok(lane.HEAVY_STAGES.includes(stage), `${stage} is a container of many minutes`);
  }
  const fromRun = await suites.addTaskFromRun({ query: async () => assert.fail('nothing is read') }, { suiteId: 1, runId: 1, stage: 'first_version' });
  assert.equal(fromRun.status, 400);
  const sampled = await suites.proposeSample({ query: async () => assert.fail('nothing is read') }, { stage: 'capture' });
  assert.equal(sampled.status, 400);
  assert.ok(lane.SINGLE_ATTEMPT_STAGES.includes('capture'), 'a capture runs once: another attempt would take the same screenshots');
  assert.ok(!lane.SINGLE_ATTEMPT_STAGES.includes('first_version'), 'a first version is built `repeats` times');
});

test('a first version needs a name, a brief the make screen would take and a known starter; a capture needs its commit', () => {
  const ok = taste.validateInput('first_version', { appName: '  Ear   Trainer ', brief: EAR_TRAINER });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.input, { appName: 'Ear Trainer', brief: EAR_TRAINER, template: 'empty' }, 'the Empty starter by default');
  assert.equal(taste.validateInput('first_version', { appName: 'X', brief: 'short' }).status, 400);
  assert.equal(taste.validateInput('first_version', { appName: '', brief: EAR_TRAINER }).status, 400);
  assert.match(taste.validateInput('first_version', { appName: 'X', brief: EAR_TRAINER, template: 'nope' }).error, /Unknown starter/);
  // The four starters were deleted (tests/app-templates.test.js): Empty is the one there is.
  assert.equal(taste.validateInput('first_version', { appName: 'X', brief: EAR_TRAINER, template: 'empty' }).input.template, 'empty');
  assert.match(taste.validateInput('first_version', { appName: 'X', brief: EAR_TRAINER, template: 'game-2d' }).error, /Unknown starter/);
  assert.match(taste.validateInput('capture', { appName: 'X', brief: EAR_TRAINER, sha: 'abc' }).error, /40-character commit/);
  const cap = taste.validateInput('capture', { appName: 'X', brief: EAR_TRAINER, sha: 'A'.repeat(40) });
  assert.equal(cap.input.sha, 'a'.repeat(40));
  assert.equal(taste.validateInput('build', { appName: 'X', brief: EAR_TRAINER }).status, 400);
});

test('a task\'s inputs are its snapshot\'s: the brief as text, the rest as small facts', () => {
  const input = taste.inputOf({ texts: { brief: EAR_TRAINER }, extra: { taste: 'first_version', appName: 'Ear Trainer', template: 'empty' } });
  assert.deepEqual(input, {
    kind: 'first_version', appName: 'Ear Trainer', brief: EAR_TRAINER, template: 'empty', description: null, sha: null, placeholder: false,
  });
  assert.equal(taste.inputOf({ texts: { brief: 'x' }, extra: { taste: 'capture' }, baseSha: 'b'.repeat(40) }).sha, 'b'.repeat(40));
});

test('a placeholder brief is never run: its trials are not applicable until an admin replaces it', () => {
  assert.equal(taste.isPlaceholder('placeholder: replace with the original brief.'), true);
  assert.equal(taste.isPlaceholder('  Placeholder : soon'), true);
  assert.equal(taste.isPlaceholder(EAR_TRAINER), false);
  assert.match(taste.notRunnableReason({ stage: 'first_version', tags: { brief_placeholder: true } }), /placeholder/);
  assert.equal(taste.notRunnableReason({ stage: 'first_version', tags: { brief_placeholder: false } }), null);
  assert.equal(taste.notRunnableReason({ stage: 'triage', tags: { brief_placeholder: true } }), null, 'only a taste task has a brief');
});

test('a first version is filed and read exactly as a new project\'s request is, on today\'s starter for its name', () => {
  const input = { appName: 'Ear Trainer', brief: EAR_TRAINER, template: 'empty' };
  const request = taste.firstVersionRequest(input);
  // The very text fileFirstVersion files for a project the bot builds.
  assert.deepEqual(request, dm.firstVersionIssue({ name: 'Ear Trainer', username: taste.REQUESTER, brief: EAR_TRAINER, botBuilds: true }));
  assert.equal(request.title, 'First version of Ear Trainer');
  assert.ok(request.body.includes(EAR_TRAINER));
  const seed = taste.seedFor(input, 'usernode-bot');
  assert.ok(seed.startsWith(`Please work on GitHub issue #${taste.ISSUE_NUMBER}: "First version of Ear Trainer".`));
  assert.ok(seed.includes(EAR_TRAINER));
  // Today's Empty starter, for the name, and nothing pointing at the real
  // app's repository and its later history.
  const files = taste.scaffoldFiles(input);
  assert.deepEqual(files.map((f) => f.path).sort(), getTemplateFiles('Ear Trainer', 'ear-trainer', '', null, {}).map((f) => f.path).sort());
  assert.ok(!files.some((f) => f.path === '.claude/homeroom-canonical-repo'));
  assert.match(files.find((f) => f.path === 'public/index.html').content, /<title>Ear Trainer<\/title>/);
  assert.equal(taste.slugOf('Bread Bot!'), 'bread-bot');
  assert.equal(taste.slugOf('???'), 'first-version');
});

// ── The seeded suite ────────────────────────────────────────────────────

test('taste-v1 seeds four first versions on the Empty starter, Ear Trainer\'s brief verbatim and the others marked placeholders', () => {
  const def = taste.loadDefinition();
  const v = taste.validateDefinition(def);
  assert.deepEqual(v.errors, []);
  assert.equal(def.key, 'taste-v1');
  assert.deepEqual(def.tasks.map((t) => t.ref), ['bread-bot', 'rss-reader', 'ear-trainer', 'block-game']);
  assert.deepEqual(def.tasks.map((t) => t.app_slug), ['bread-bot-3e3f5c', 'rss-reader-4113da', 'ear-trainer-9aee0d', 'block-game-54d305']);
  for (const t of def.tasks) {
    assert.equal(t.kind, 'first_version');
    assert.equal(t.template, 'empty');
  }
  const ear = def.tasks.find((t) => t.ref === 'ear-trainer');
  assert.equal(ear.brief, EAR_TRAINER, 'the requester\'s own words');
  assert.equal(taste.isPlaceholder(ear.brief), false);
  for (const ref of ['bread-bot', 'rss-reader', 'block-game']) {
    const t = def.tasks.find((x) => x.ref === ref);
    assert.match(t.brief, /^placeholder: replace with the original brief/, `${ref} says it is a stand-in`);
  }
  // The definition is checked, not trusted.
  assert.match(taste.validateDefinition({ ...def, tasks: [...def.tasks, def.tasks[0]] }).errors.join(), /duplicate ref/);
  assert.match(taste.validateDefinition({ ...def, tasks: [{ ref: 'x', kind: 'capture', app_slug: 'a' }] }).errors.join(), /needs its sha/);
});

// ── The screenshot step ─────────────────────────────────────────────────

test('the capture plan: two viewports by two looks by four states, the result state on three screens, the empty state last', () => {
  const plan = step.capturePlan();
  assert.equal(plan.length, 19);
  assert.deepEqual([...new Set(plan.map((s) => `${s.width}x${s.height}`))], ['390x844', '1280x800']);
  assert.deepEqual([...new Set(plan.map((s) => s.look))], ['light', 'dark']);
  assert.deepEqual([...new Set(plan.map((s) => s.state))], ['populated', 'error', 'loading', 'result', 'empty']);
  assert.ok(plan.slice(-4).every((s) => s.state === 'empty'), 'the empty state empties the database the others read');
  // The result state, most telling screen first, just before the empty
  // state: a tap may write to the database the earlier states read.
  assert.deepEqual(plan.slice(-7, -4).map((s) => s.id), ['phone-light-result', 'phone-dark-result', 'desktop-light-result']);
  assert.deepEqual(step.RESULT_SCREENS, capture.RESULT_SCREENS);
  assert.equal(new Set(plan.map((s) => s.id)).size, 19);
  // The platform's half plans the same nineteen.
  assert.deepEqual(capture.plannedShots().map((s) => s.id).sort(), plan.map((s) => s.id).sort());
  assert.deepEqual([...capture.STATES].sort(), [...step.STATES].sort());
  assert.equal(step.LOADING_DELAY_MS, 2000);
  assert.equal(step.LOADING_SHOT_MS, 300);
  assert.equal(step.OVERFLOW_WIDTH, 360);
  assert.equal(step.MIN_TAP_PX, 44);
});

test('each screenshot opens the app\'s root signed in, in its look, with the staging demo data when populated', () => {
  const base = 'http://localhost:3190';
  assert.equal(step.shotUrl(base, { look: 'dark', state: 'populated' }, 'tok'), `${base}/?token=tok&un-theme=dark&demo=1`);
  assert.equal(step.shotUrl(`${base}/`, { look: 'light', state: 'empty' }, 'tok'), `${base}/?token=tok&un-theme=light`);
  assert.equal(step.shotUrl(base, { look: 'light', state: 'result' }, 'tok'), `${base}/?token=tok&un-theme=light&demo=1`, 'the result starts from the populated screen');
  // A tap may navigate within the app, never away from it.
  assert.equal(step.sameOrigin(base, `${base}/recipes/3?x=1`), true);
  assert.equal(step.sameOrigin(base, 'http://localhost:3191/'), false);
  assert.equal(step.sameOrigin(base, 'https://example.com/'), false);
  assert.equal(step.sameOrigin(base, 'not a url'), false);
  // Error and loading hold the app's own API, and nothing else.
  assert.equal(step.interceptsApi(base, 'GET', `${base}/api/loaves?x=1`), true);
  assert.equal(step.interceptsApi(base, 'POST', `${base}/api/loaves`), false);
  assert.equal(step.interceptsApi(base, 'GET', `${base}/usernode-bridge/v1/bridge.js`), false);
  assert.equal(step.interceptsApi(base, 'GET', 'https://feeds.example/api/rss'), false);
});

// The result state's choice of control, from the descriptors the page
// gives (actionCandidates): every flag false unless a case sets it.
function control(over) {
  return {
    index: 0, label: 'Calculate', visible: true, disabled: false, region: 'main',
    marked: false, kitPrimary: false, formSubmit: false, accent: false, offOrigin: false, area: 358 * 44, ...over,
  };
}

test('the result state taps the control the page marks, else the single most prominent primary button in the main content', () => {
  // The explicit marker wins over a larger kit button, wherever it is.
  const marked = step.chooseAction([
    control({ index: 0, label: 'Save', kitPrimary: true, area: 90000 }),
    control({ index: 1, label: 'Show the recipe', marked: true, region: 'chrome', area: 2000 }),
  ]);
  assert.deepEqual(marked, { index: 1, label: 'Show the recipe', rule: 'marked', why: `the control marked ${step.ACTION_MARKER}, the only one` });
  // A single .btn-primary in the main content; the header's is passed over,
  // and so is a submit button, which only counts when there is no kit button.
  const kit = step.chooseAction([
    control({ index: 0, label: 'Upgrade', kitPrimary: true, region: 'chrome', area: 99999 }),
    control({ index: 1, label: 'Reset', formSubmit: true, area: 99999 }),
    control({ index: 2, label: '  Calculate\n ', kitPrimary: true, formSubmit: true }),
  ]);
  assert.equal(kit.index, 2);
  assert.equal(kit.label, 'Calculate');
  assert.equal(kit.rule, 'kit-primary');
  assert.match(kit.why, /primary button \(\.btn-primary\), the only one in the main content/);
  // Then a form's submit button, then the button filled with the accent.
  assert.equal(step.chooseAction([control({ index: 4, formSubmit: true })]).rule, 'form-submit');
  assert.equal(step.chooseAction([control({ index: 5, accent: true })]).rule, 'accent');
  // Of several, the one clearly the largest; a hidden one does not count.
  const big = step.chooseAction([
    control({ index: 0, label: 'Add', kitPrimary: true, area: 44 * 44 }),
    control({ index: 1, label: 'Calculate', kitPrimary: true, area: 358 * 44 }),
    control({ index: 2, label: 'Hidden', kitPrimary: true, area: 900 * 400, visible: false }),
  ]);
  assert.equal(big.index, 1);
  assert.match(big.why, /^the largest of 2 design kit primary buttons/);
  // The header's button only when the main content has no candidate at all.
  assert.match(step.chooseAction([control({ label: 'New loaf', kitPrimary: true, region: 'chrome' })]).why, /header or navigation/);
});

test('the result state taps nothing when no control is clearly the primary action, or the one that is is disabled or leaves the app', () => {
  const skip = (list) => step.chooseAction(list).skipped;
  assert.match(skip([]), /^no clear primary action: no marked control/);
  assert.match(skip([control({ visible: false, kitPrimary: true })]), /^no clear primary action/);
  // Two of a kind, equally prominent: which is "the" action is a guess.
  const two = skip([
    control({ index: 0, label: 'Save', kitPrimary: true, area: 160 * 44 }),
    control({ index: 1, label: 'Share', kitPrimary: true, area: 150 * 44 }),
    control({ index: 2, label: 'Go', formSubmit: true, area: 999 * 44 }),
  ]);
  assert.equal(two, 'no clear primary action: 2 equally prominent design kit primary buttons (.btn-primary) in the main content ("Save", "Share")');
  assert.match(skip([control({ marked: true }), control({ index: 1, marked: true })]), /2 equally prominent controls marked data-capture-action/);
  assert.equal(skip([control({ label: 'Open the shop', kitPrimary: true, offOrigin: true })]), 'the primary action "Open the shop" leads to another site');
  assert.equal(skip([control({ kitPrimary: true, disabled: true })]), 'the primary action "Calculate" is disabled');
  // A disabled primary button is a skip, not a reason to tap a lesser one.
  assert.ok(skip([control({ kitPrimary: true, disabled: true }), control({ index: 1, label: 'Reset', formSubmit: true })]));
  assert.equal(skip([control({ label: '', accent: true, disabled: true })]), 'the primary action an unlabelled control is disabled');
  // Labels as captions quote them.
  assert.equal(step.actionLabel('  Say "hi"\n now '), 'Say \'hi\' now');
  assert.equal(step.actionLabel('x'.repeat(60)).length, 40);
});

test('the capture keeps, per result screen, the control tapped and why, or why none was', () => {
  const rec = step.primaryActionRecord([
    { id: 'phone-light-populated', state: 'populated' },
    { id: 'phone-light-result', state: 'result', action: { used: { label: 'Calculate', rule: 'kit-primary', why: 'the only one' }, settled: 'network idle', changes: 2, revealed: true, dialogs: 0, blocked: 0, ms: 1200 } },
    { id: 'phone-dark-result', state: 'result', skipped: 'no clear primary action: x', sameAs: 'phone-light-result' },
    { id: 'desktop-light-result', state: 'result', failed: 'the primary action failed: boom', action: { failed: 'boom', ms: 8000 } },
  ]);
  assert.deepEqual(rec.map((r) => r.id), ['phone-light-result', 'phone-dark-result', 'desktop-light-result']);
  assert.equal(rec[0].used.label, 'Calculate');
  assert.deepEqual(rec[1], { id: 'phone-dark-result', skipped: 'no clear primary action: x', sameAs: 'phone-light-result' });
  assert.equal(rec[2].failed, 'boom');
  // Tapped, but the screenshot after it failed: both are said.
  const after = step.primaryActionRecord([{ id: 'phone-light-result', state: 'result', failed: 'Target closed', action: { used: { label: 'Go' } } }]);
  assert.equal(after[0].used.label, 'Go');
  assert.equal(after[0].failed, 'Target closed');
  // The platform keeps it next to the checks, cleaned: planned ids only,
  // a known rule, a quoted label, no stray fields.
  const summary = capture.summarize({
    booted: true,
    primaryAction: [...rec, { id: '../../etc/passwd', skipped: 'x' }, { id: 'phone-light-result', skipped: 'a second entry' }],
    checks: { a: 1 },
  });
  assert.deepEqual(summary.primaryAction.map((a) => a.id), ['phone-light-result', 'phone-dark-result', 'desktop-light-result']);
  assert.deepEqual(summary.primaryAction[0], {
    id: 'phone-light-result', used: { label: 'Calculate', rule: 'kit-primary', why: 'the only one' },
    settled: 'network idle', changes: 2, revealed: true, dialogs: 0, blocked: 0, ms: 1200,
  });
  assert.deepEqual(summary.primaryAction[1], { id: 'phone-dark-result', skipped: 'no clear primary action: x', sameAs: 'phone-light-result', ms: null });
  assert.equal(capture.summarize({ booted: true }).primaryAction, null, 'a capture from before the result state has none');
  assert.equal(capture.summarize({ booted: true, primaryAction: [{ id: 'phone-light-result', used: { label: 'x', rule: 'bogus' } }] }).primaryAction[0].used.rule, null);
  // In words, for the judge's signals and the studio's trial view.
  assert.deepEqual(capture.describeActions(summary), [
    'Phone 390×844, light look: tapped "Calculate", the only one',
    'Phone 390×844, dark look: nothing tapped, no clear primary action: x',
    'Desktop 1280×800, light look: not shown, the tap failed: boom',
  ]);
  assert.deepEqual(grading.tasteSignals(summary).primaryAction, capture.describeActions(summary));
  assert.equal(grading.tasteSignals({ booted: true, checks: {} }).primaryAction, null);
});

test('the app signs its viewer in with a throwaway key the step made: the token verifies as the starter verifies it', () => {
  const id = step.throwawayIdentity(42);
  const claims = jwt.verify(id.token, id.publicKeyPem, { algorithms: ['RS256'], issuer: 'usernode', audience: 'usernode:app:42' });
  assert.equal(claims.pur, 'iframe');
  assert.equal(claims.username, 'staging-demo-viewer');
  assert.ok(claims.exp > claims.iat);
  assert.throws(() => jwt.verify(id.token, step.throwawayIdentity(42).publicKeyPem, { algorithms: ['RS256'] }), 'another capture\'s key does not verify it');
  assert.equal(step.redact(`log ${id.token} end`, [id.token]), 'log [redacted] end');
});

test('contrast is WCAG 2.x arithmetic on computed colours, layered backgrounds blended', () => {
  const m = step.colorMath();
  const ratio = (fg, bg) => Math.round(m.ratio(m.parse(fg), m.parse(bg)) * 100) / 100;
  assert.equal(ratio('rgb(0, 0, 0)', 'rgb(255, 255, 255)'), 21);
  assert.equal(ratio('rgb(255, 255, 255)', 'rgb(255, 255, 255)'), 1);
  assert.equal(ratio('rgb(118, 118, 118)', 'rgb(255, 255, 255)'), 4.54, '#767676 is the lightest grey that passes on white');
  assert.ok(ratio('rgb(196, 181, 253)', 'rgb(255, 255, 255)') < 2, 'violet-300 on white, the Ear Trainer case');
  // Half-transparent black over white is mid grey.
  const over = m.over(m.parse('rgba(0, 0, 0, 0.5)'), m.parse('rgb(255, 255, 255)'));
  assert.equal(Math.round(over.r), 128);
  assert.deepEqual(m.parse('rgb(1 2 3 / 50%)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.equal(m.parse('transparent'), null);
  // Large text needs 3:1, the rest 4.5:1.
  assert.equal(m.required(16, '400'), 4.5);
  assert.equal(m.required(24, '400'), 3);
  assert.equal(m.required(19, '700'), 3);
  assert.equal(m.required(18, '700'), 4.5);
});

test('the checks sum the screenshots as numbers; the error and loading states\' own console errors do not count', () => {
  const metrics = (low, small, nested = 0) => ({
    overflowPx: 0, tap: { checked: 6, small, samples: [{ tag: 'button', text: 'x', width: 30, height: 30 }] },
    contrast: { checked: 10, low, worst: low ? 2.1 : 7, samples: low ? [{ text: 'faint', ratio: 2.1, need: 4.5 }] : [] },
    nestedCards: nested,
  });
  const shots = [
    { id: 'phone-light-populated', viewport: 'phone', look: 'light', state: 'populated', consoleErrors: 1, errorSamples: ['boom'], metrics: metrics(0, 2) },
    { id: 'phone-dark-populated', viewport: 'phone', look: 'dark', state: 'populated', consoleErrors: 0, metrics: metrics(3, 4, 1) },
    { id: 'phone-light-error', viewport: 'phone', look: 'light', state: 'error', consoleErrors: 5, errorSamples: ['500'] },
    { id: 'phone-light-empty', viewport: 'phone', look: 'light', state: 'empty', consoleErrors: 1, errorSamples: ['boom'], metrics: metrics(1, 1) },
  ];
  const c = step.summarizeChecks(shots, [{ look: 'light', overflowPx: 0 }, { look: 'dark', overflowPx: 37 }]);
  assert.deepEqual(c.consoleErrors, { count: 2, screens: 3, samples: ['boom'] });
  assert.deepEqual({ light: c.overflow360.light, dark: c.overflow360.dark, worst: c.overflow360.worst }, { light: 0, dark: 37, worst: 37 });
  assert.equal(c.smallTapTargets.small, 2, 'tap targets: the populated phone screen in the light look');
  assert.equal(c.smallTapTargets.checked, 6);
  assert.deepEqual({ low: c.lowContrast.light.low, checked: c.lowContrast.light.checked, worst: c.lowContrast.light.worst }, { low: 1, checked: 20, worst: 2.1 });
  assert.equal(c.lowContrast.dark.low, 3);
  assert.equal(c.nestedCards.worst, 1);
});

test('the tells lint counts emoji icons, uppercase tracked eyebrows, text-[Npx] and hex colours in client source, not comments', () => {
  const out = step.lintTells([
    {
      path: 'public/index.html',
      text: '<!-- see #1581 🍞 -->\n<p class="text-xs uppercase tracking-wide text-zinc-500">Today</p>\n<span>🍞</span><b class="text-[15px]">x</b><i class="text-[17px] bg-[#1a2b3c]"></i>',
    },
    { path: 'public/app.js', text: "// #fff in a comment\nconst c = '#FFF'; el.className = 'tracking-widest uppercase'; const u = 'https://x.y/#abc';" },
    { path: 'public/style.css', text: '/* ⭐ */ .a { color: #333; border: 1px solid #333333; } .b { color: #ff000080 }' },
    { path: 'server.js', text: "res.send('<body style=\"background:#09090b\">🚀</body>')" },
    { path: 'node_modules/x/index.js', text: '🍞 #123456' },
    { path: 'tests/a.test.js', text: '🍞' },
    { path: 'public/vendor.min.js', text: '🍞' },
  ]);
  assert.equal(out.files, 3, 'the server, dependencies, tests and minified files are not the app\'s screens');
  assert.equal(out.emojiIcons.count, 1);
  assert.equal(out.uppercaseEyebrows.count, 2);
  assert.deepEqual({ count: out.arbitraryTextSizes.count, values: out.arbitraryTextSizes.values }, { count: 2, values: ['15px', '17px'] });
  assert.deepEqual(out.hexColours.values, ['#1a2b3c', '#333', '#333333', '#ff000080', '#fff']);
  assert.equal(out.hexColours.count, 5, 'distinct values, case folded; an issue number in a comment is not a colour');
  assert.equal(step.lintable('src/components/Button.tsx'), true);
  assert.equal(step.lintable('api/routes.js'), false);
});

test('the app starts the way production starts it, and the empty state keeps the tables it made', () => {
  assert.deepEqual(step.startCommand({ scripts: { start: 'node server.js' } }), ['npm', 'start']);
  assert.deepEqual(step.startCommand({ main: 'app/main.js' }, () => true), ['node', 'app/main.js']);
  assert.deepEqual(step.startCommand({ main: 'gone.js' }, () => false), ['node', 'server.js']);
  assert.deepEqual(step.startCommand({}), ['node', 'server.js']);
  const sql = step.emptyDatabaseSql();
  assert.match(sql, /TRUNCATE TABLE %I\.%I RESTART IDENTITY CASCADE/);
  assert.match(sql, /tablename !~\* 'migrat'/, 'a migration ledger is kept, or the app would migrate again');
  assert.doesNotMatch(sql, /DROP/);
});

test('the platform runs the step in the worker with non-secret settings only, quoted', () => {
  const cmd = worker.buildBenchCaptureCommand({ INLOOP_PORT: 3190, BENCH_APP_ID: 7, INLOOP_DATABASE_URL: "postgres://x/'inloop" });
  assert.equal(cmd[0], 'sh');
  assert.match(cmd[2], /^cd \/home\/node\/workspace && exec env 'INLOOP_PORT=3190' 'BENCH_APP_ID=7' /);
  assert.ok(cmd[2].includes(`'INLOOP_DATABASE_URL=postgres://x/'"'"'inloop'`), 'a quote cannot end the argument');
  assert.ok(cmd[2].endsWith(`node ${worker.BENCH_CAPTURE_SCRIPT_PATH}`));
  assert.throws(() => worker.buildBenchCaptureCommand({ 'X;rm -rf /': 1 }), /invalid env key/);
  assert.notEqual(capture.CAPTURE_PORT, require('../src/services/in-loop-browser').INLOOP_PORT, 'not the port a build turn\'s own launch may still hold');
});

// ── The platform's half of the step ─────────────────────────────────────

function png(width, height, fill = 0) {
  return require('../src/services/bench/demo').demoPng(width, height, [fill, fill, fill]);
}

test('the step\'s output is read from its marker line; only planned, real, small enough PNGs are kept', () => {
  const good = png(390, 844).toString('base64');
  const out = capture.parseOutput(`npm noise\n${capture.MARKER} ${JSON.stringify({ booted: true, shots: [] })}\n`);
  assert.deepEqual(out, { booted: true, shots: [] });
  assert.equal(capture.parseOutput('no marker here'), null);
  assert.equal(capture.parseOutput(`${capture.MARKER} {broken`), null);
  const { kept, dropped } = capture.acceptShots([
    { id: 'phone-light-populated', png: good, status: 200, consoleErrors: 2, lowContrast: 3, smallTapTargets: 1, overflowPx: 0, nestedCards: 0 },
    { id: 'phone-light-populated', png: good },
    { id: 'phone-dark-error', png: Buffer.from('<html>not a picture</html>').toString('base64') },
    { id: 'phone-dark-loading', failed: 'net::ERR_ABORTED' },
    { id: '../../etc/passwd', png: good },
    // The result state: one tapped, one with nothing to tap, one whose tap failed.
    { id: 'phone-light-result', png: good, status: 200, action: { used: { label: 'Calculate "now"', rule: 'kit-primary', why: 'the only one' }, settled: 'network idle' } },
    { id: 'phone-dark-result', skipped: 'no clear primary action: x', sameAs: 'phone-light-result' },
    { id: 'desktop-light-result', failed: 'the primary action failed: Timeout 2000ms exceeded', action: { failed: 'Timeout 2000ms exceeded' } },
  ]);
  assert.deepEqual(kept.map((s) => s.id), ['phone-light-populated', 'phone-light-result']);
  assert.equal(kept[0].width, 390);
  assert.equal(kept[0].height, 844);
  assert.equal(kept[0].sha256.length, 64);
  assert.equal(kept[0].lowContrast, 3);
  assert.deepEqual(kept[1].action, { label: 'Calculate \'now\'', rule: 'kit-primary' });
  assert.equal(kept[1].lowContrast, undefined, 'the checks are measured on the populated and empty screens');
  assert.deepEqual(dropped, [
    { id: 'phone-dark-error', reason: 'not a PNG' }, { id: 'phone-dark-loading', reason: 'net::ERR_ABORTED' },
    { id: 'desktop-light-result', reason: 'the primary action failed: Timeout 2000ms exceeded' },
  ], 'a result screen with nothing to tap is not a lost screenshot');
  const summary = capture.summarize({ booted: true, checks: { a: 1 }, tells: { b: 2 }, steps: { install: { ran: true, ok: true, ms: 5 } } }, kept, dropped, { 'phone-light-populated': 'f'.repeat(32) });
  assert.equal(summary.shots[0].artifactId, 'f'.repeat(32));
  assert.equal(summary.shots[0].data, undefined, 'no image bytes in the trial\'s row');
  assert.equal(summary.shots[0].action, undefined);
  assert.deepEqual(summary.shots[1].action, { label: 'Calculate \'now\'', rule: 'kit-primary' });
  assert.deepEqual(summary.checks, { a: 1 });
});

test('grading shows the eight most telling screenshots, captioned by size, look and state, and names the identical ones', () => {
  // A capture with no result screen (taken before the state existed).
  const shots = capture.plannedShots().filter((s) => s.state !== 'result').map((s, i) => ({
    ...s, artifactId: String(i).padStart(32, '0'),
    // Every error and loading screen looks exactly like its populated one.
    sha256: (s.state === 'error' || s.state === 'loading' ? `${s.viewport}-${s.look}-populated` : s.id),
  }));
  const picked = capture.pickShots({ shots });
  assert.equal(picked.chosen.length, 8);
  assert.deepEqual(picked.chosen.slice(0, 6).map((s) => s.id), [
    'phone-light-populated', 'phone-dark-populated', 'desktop-light-populated', 'phone-light-empty', 'phone-dark-empty', 'desktop-dark-populated',
  ]);
  assert.ok(picked.chosen.every((s) => s.state === 'populated' || s.state === 'empty'), 'a screen identical to one already shown is skipped');
  assert.ok(picked.identical.some((x) => x.caption === capture.caption({ viewport: 'phone', look: 'light', state: 'error' })
    && x.sameAs === capture.caption({ viewport: 'phone', look: 'light', state: 'populated' })));
  assert.equal(capture.caption({ viewport: 'phone', look: 'dark', state: 'empty' }), 'Phone 390×844, dark look, empty (no data yet)');
  assert.equal(capture.caption({ viewport: 'desktop', look: 'light', state: 'loading' }), 'Desktop 1280×800, light look, loading (the app\'s API held, taken at about 300 ms)');
  assert.equal(capture.pickShots({ shots: [] }).chosen.length, 0);
  // Every screen different, no result: the same eight as before the result
  // state, the desktop's dark look last of them.
  const distinct = capture.plannedShots().filter((s) => s.state !== 'result').map((s, i) => ({ ...s, artifactId: String(i).padStart(32, '0'), sha256: s.id }));
  assert.deepEqual(capture.pickShots({ shots: distinct }).chosen.map((s) => s.id), [
    'phone-light-populated', 'phone-dark-populated', 'desktop-light-populated', 'phone-light-empty', 'phone-dark-empty',
    'phone-light-error', 'phone-light-loading', 'desktop-dark-populated',
  ]);
});

test('a result screen that differs from the populated one comes right after the populated pair; one that does not is named identical', () => {
  const shots = (resultHash) => capture.plannedShots().map((s, i) => ({
    ...s, artifactId: String(i).padStart(32, '0'),
    sha256: s.state === 'result' ? resultHash(s) : s.id,
    ...(s.state === 'result' ? { action: { label: 'Calculate', rule: 'kit-primary' } } : {}),
  }));
  // Every screen different: the phone's result is third, and it pushes the
  // desktop's dark look out of the eight, not a state.
  const differs = capture.pickShots({ shots: shots((s) => s.id) });
  assert.deepEqual(differs.chosen.map((s) => s.id), [
    'phone-light-populated', 'phone-dark-populated', 'phone-light-result', 'desktop-light-populated',
    'phone-light-empty', 'phone-dark-empty', 'phone-light-error', 'phone-light-loading',
  ]);
  assert.equal(differs.chosen[2].caption, 'Phone 390×844, light look, after tapping "Calculate" (the screen\'s primary action)');
  assert.equal(differs.total, 19);
  // An app with no data at all, a calculator whose empty, error and loading
  // screens all look like its populated one, shows its result in both looks
  // and on the desktop instead.
  const calculator = capture.pickShots({
    shots: shots((s) => s.id).map((s) => (['empty', 'error', 'loading'].includes(s.state) ? { ...s, sha256: `${s.viewport}-${s.look}-populated` } : s)),
  });
  assert.deepEqual(calculator.chosen.map((s) => s.id), [
    'phone-light-populated', 'phone-dark-populated', 'phone-light-result', 'desktop-light-populated',
    'desktop-dark-populated', 'phone-dark-result', 'desktop-light-result',
  ]);
  assert.equal(calculator.identical.length, 12);
  assert.equal(calculator.chosen[6].caption, 'Desktop 1280×800, light look, after clicking "Calculate" (the screen\'s primary action)');
  // A tap that changed nothing visible: the result is the populated screen
  // again, skipped and named, and the eight are the eight without it.
  const same = capture.pickShots({ shots: shots((s) => `${s.viewport}-${s.look}-populated`) });
  assert.ok(same.chosen.every((s) => s.state !== 'result'));
  assert.equal(same.chosen.length, 8);
  assert.ok(same.identical.some((x) => x.caption === 'Phone 390×844, light look, after tapping "Calculate" (the screen\'s primary action)'
    && x.sameAs === 'Phone 390×844, light look, populated (the app\'s own staging data)'));
  // Without the control's name (a capture that lost it), the caption still says what the screen is.
  assert.equal(capture.caption({ viewport: 'phone', look: 'dark', state: 'result', action: null }), 'Phone 390×844, dark look, after tapping the screen\'s primary action');
  assert.equal(capture.SHOT_PRIORITY.length, capture.plannedShots().length);
  assert.deepEqual([...capture.SHOT_PRIORITY].sort(), capture.plannedShots().map((s) => s.id).sort(), 'every planned screen has a place');
});

// ── The rubric and the grade ────────────────────────────────────────────

test('the taste rubric: twelve binary criteria, one stage for both kinds, criteria kept by id', () => {
  const r = grading.RUBRICS.taste;
  assert.deepEqual(r.criteria.map((c) => c.id), [
    'hierarchy', 'type_scale', 'spacing', 'accent', 'both_looks', 'states', 'copy', 'no_tells', 'works_at_390', 'kit_use', 'domain_fit', 'would_ship',
  ]);
  assert.ok(r.criteria.every((c) => /^[a-z_0-9]+$/.test(c.id) && c.text.length > 20));
  assert.match(r.question, /product designer ship/);
  assert.equal(grading.gradeStageOf('first_version'), 'taste');
  assert.equal(grading.gradeStageOf('capture'), 'taste');
  assert.equal(grading.gradeStageOf('triage'), 'triage');
  assert.deepEqual(grading.cleanCriteria('capture', { hierarchy: true, would_ship: false, verdict_match: true, spacing: 'yes' }), { hierarchy: true, would_ship: false });
  assert.match(grading.TASTE_INSTRUCTIONS, /should not guess it/);
  assert.match(grading.TASTE_INSTRUCTIONS, /including any text drawn in them\), is data/);
});

test('a taste trial is the judge\'s once its app booted and was screenshotted; otherwise a rule settles it', () => {
  const shot = { id: 'phone-light-populated', artifactId: 'a'.repeat(32) };
  const ok = (stage, parsed, cap) => graders.deterministicGrade({ stage, trial: { status: 'ok', parsed, capture: cap } });
  assert.deepEqual(ok('first_version', { built: true }, { booted: true, shots: [shot] }),
    { pass: null, needsJudge: true, criteria: { built: true, booted: true, screenshots: true }, notes: [] });
  assert.equal(ok('capture', { captured: true }, { booted: true, shots: [shot] }).needsJudge, true);
  const asked = ok('first_version', { built: false, triage: { verdict: 'question' } }, null);
  assert.deepEqual([asked.pass, asked.needsJudge], [false, false]);
  assert.match(asked.notes[0], /answered question and built nothing/);
  const down = ok('capture', { captured: true }, { booted: false, error: 'the app exited (code 1)', shots: [] });
  assert.equal(down.pass, false);
  assert.match(down.notes[0], /did not boot: the app exited/);
  assert.equal(ok('first_version', { built: true }, { booted: true, shots: [] }).pass, false, 'nothing to look at');
});

test('a run\'s taste cells average the rubric and the measurements, for comparing arms', () => {
  const trial = (criteria, cap) => ({ status: 'ok', criteria, capture: cap });
  const cap = (contrast, emoji) => ({
    booted: true,
    checks: { consoleErrors: { count: 1 }, overflow360: { worst: 0 }, smallTapTargets: { small: 2 }, lowContrast: { light: { low: contrast }, dark: { low: 0 } }, nestedCards: { worst: 0 } },
    tells: { emojiIcons: { count: emoji }, uppercaseEyebrows: { count: 0 }, arbitraryTextSizes: { count: 1 }, hexColours: { count: 3 } },
  });
  const agg = report.tasteAggregates([
    trial({ hierarchy: true, would_ship: false }, cap(4, 2)),
    trial({ hierarchy: false, would_ship: false }, cap(0, 0)),
    trial(null, { booted: false }),
    { status: 'infra_fail', capture: cap(9, 9) },
  ]);
  assert.equal(agg.trials, 3);
  assert.deepEqual(agg.criteria, { hierarchy: { rate: 0.5, n: 2 }, would_ship: { rate: 0, n: 2 } });
  assert.equal(agg.bootedRate, 2 / 3);
  assert.equal(agg.checks.lowContrastLight, 2);
  assert.equal(agg.tells.emojiIcons, 1);
  assert.equal(agg.checks.consoleErrors, 1);
});

test('the catalog prices a first version as a triage and a first build, and a capture as nothing', () => {
  const glm = { id: 'z-ai/glm-5.3-flash', inputPerMillion: 0.1, outputPerMillion: 0.4, stages: null, contextTokens: 200_000 };
  assert.equal(catalog.estimateTrialCost(glm, 'capture'), 0);
  assert.equal(catalog.estimateTrialCost({ id: 'x' }, 'capture'), 0);
  const first = catalog.estimateTrialCost(glm, 'first_version');
  assert.ok(first > catalog.estimateTrialCost(glm, 'build'), 'more than a build: a triage and a longer clock too');
  assert.equal(catalog.estimateTrialCost({ id: 'x' }, 'first_version'), 3);
  assert.match(catalog.notApplicableReason({ label: 'Kimi', stages: ['build', 'spec'] }, 'first_version', 100), /build and spec only/,
    'a first version runs a triage, which a build-only model is not entered for');
});

// ── The stages, on stubbed workers ──────────────────────────────────────

function spySideEffects(t) {
  const calls = [];
  const targets = [
    [live, ['post', 'postOnProposal', 'promoteAsBot', 'postSpecOnProposal', 'shareSpecVersion', 'applyMentionAsks', 'advanceSeen']],
    [dm, ['sendDm', 'relayIssuePost', 'noteProposalMerged', 'noteOverAllowance', 'recordRequester']],
    [githubModule, ['createIssueComment', 'createPR', 'mergePR', 'createIssue', 'closeIssue', 'updatePR', 'createBranch', 'pushFiles']],
  ];
  for (const [mod, names] of targets) {
    for (const name of names) {
      const real = mod[name];
      mod[name] = () => { calls.push(name); return Promise.resolve(null); };
      t.after(() => { mod[name] = real; });
    }
  }
  return calls;
}

const SCAFFOLD = 'a'.repeat(40);
const CARD = { kind: 'card', emoji: '🎵', tagline: 'Learn chords and progressions by ear', points: ['Lessons that get harder', 'Progressions from songs and hymns'], source: 'fallback' };
const APP = { id: 9, slug: 'ear-trainer-9aee0d', name: 'Ear Trainer', repo_url: 'https://github.com/o/ear', self_hosted: false };
const REPO = { owner: 'o', repo: 'ear' };
const USER = { id: 501, username: 'homeroom_bench' };
const TRIAL = { id: 44, run_id: 3, attempt: 1 };

function harness({ verdict = 'ready', pushed = true, captureOut = null, takesImages = undefined } = {}) {
  const calls = { prompts: [], modes: [], ensured: [], scaffold: [], pinned: [], deleted: [], capture: [] };
  let nextSession = 7000;
  const pool = {
    async query(sql, params) {
      if (/INSERT INTO chat_sessions/.test(String(sql))) {
        nextSession += 1;
        return { rows: [{ id: nextSession, branch_name: params[2] ?? null, agent_model: params[4] }] };
      }
      // The run's shared first commit (services/bench/scaffold.js): this
      // trial is the first to need it, so it makes it.
      if (/INSERT INTO bench_scaffolds/.test(String(sql))) return { rows: [{ id: 12 }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const gh = {
    isEnabled: () => true,
    async getBotUsername() { return 'usernode-bot'; },
    async createRootCommit(owner, repo, files, { message }) { calls.scaffold.push({ owner, repo, files, message }); return SCAFFOLD; },
    async ensureBranchAtSha(owner, repo, branch, sha) { calls.pinned.push({ branch, sha }); },
    async deleteBenchBranch(owner, repo, branch) { calls.deleted.push(branch); return true; },
    async getBranchSha() { return 'f'.repeat(40); },
    async compareFiles() { return { files: [{ filename: 'public/index.html', status: 'modified' }], diff: 'diff --git a/public/index.html', complete: true, truncated: false }; },
  };
  const triageText = `\`\`\`json\n${JSON.stringify(verdict === 'ready'
    ? { verdict: 'ready', determined: true, build_note: 'Lessons list, a keyboard, both looks.', reason: 'clear', assumptions: ['one look per theme'] }
    : { verdict: 'question', question: 'Which songs?', default: 'Hymns', blocker: 'user_facing', why_default_fails: 'taste', answers: ['Hymns', 'Pop'] })}\n\`\`\``;
  const deps = {
    github: runner.guardedGithub(gh),
    worker: {
      async ensureWorkerImage() {},
      async ensureWorker(id, opts) { calls.ensured.push({ id, ...opts }); return `w-${id}`; },
      async execInWorker(id, opts) {
        calls.prompts.push(opts.prompt);
        calls.modes.push(opts.mode);
        if (opts.mode === 'build') return pushed ? { pushOk: true, ahead: 3, sha: 'c'.repeat(40) } : { pushOk: true, ahead: 0 };
        if (String(opts.prompt).includes('now answer the triage request') || String(opts.prompt).includes('Now answer the triage request')) return { lastResultText: triageText };
        return { lastResultText: '# Ear Trainer\n\nThe first version.' };
      },
      async stopTurn() {},
      clearPendingStop() {},
    },
    sessions: {
      async runCodexAttemptLoop(args) {
        await args.resolveRuntime();
        const r = await args.dispatchOnce({});
        return { result: r, error: null, estimatedCostUsd: 0.25 };
      },
      async persistScoutPublication() { return { specVersion: 1 }; },
    },
    agentTurn: {
      async resolveCodexRuntimeContext({ session }) {
        // What OpenRouter's catalog says the model takes in, when a test says.
        return {
          agentModel: session.agent_model,
          ...(typeof takesImages === 'boolean' ? { agentModelMetadata: { supportsImages: takesImages } } : {}),
        };
      },
    },
    activeWorkers: new Set(),
    // The first session's card, as creation would make it.
    makeSketch: async () => ({ design: CARD, model: 'fallback', readyAt: '2026-10-06T00:00:00.000Z' }),
    captureStep: async (args) => {
      calls.capture.push(args);
      return captureOut || { ok: true, capture: { booted: true, shots: [{ id: 'phone-light-populated', artifactId: 'b'.repeat(32) }], checks: {}, tells: {} } };
    },
  };
  return { pool, deps, calls };
}

function ctx(h, stage, snapshot, over = {}) {
  return {
    pool: h.pool, config: {}, stage, task: { id: 1, stage, reference: {}, tags: {} }, snapshot,
    model: 'z-ai/glm-5.3-flash', user: USER, app: APP, repo: REPO, trial: TRIAL, deps: h.deps,
    budgets: { turnMs: 60_000, buildMs: 60_000, specMs: 60_000, firstVersion: { turnMs: 60_000, buildMs: 120_000, specMs: 120_000 } },
    title: 'Homeroom benchmark: run 3, trial 44', ...over,
  };
}

const FIRST = { id: 5, stage: 'build', issueNumber: 1, baseSha: null, texts: { brief: EAR_TRAINER }, extra: { taste: 'first_version', appName: 'Ear Trainer', template: 'empty' } };

test('a first-version trial: today\'s new project as a history-less first commit, the bot\'s first-version triage, the plan as Build it leaves it, spec and build, then the screenshots', async (t) => {
  const side = spySideEffects(t);
  const realBuild = live.buildAndPropose;
  let args = null;
  live.buildAndPropose = async (a) => { args = a; return realBuild(a); };
  t.after(() => { live.buildAndPropose = realBuild; });
  const h = harness();
  const out = await runner.runStage(ctx(h, 'first_version', FIRST));
  assert.equal(out.status, 'ok', out.error);
  // The new project's first commit: the starter rendered for the app's name
  // with its card of the idea, made once for the run (bench/r<run>-s<id>).
  assert.equal(h.calls.scaffold.length, 1);
  const sketch = { design: CARD, model: 'fallback', readyAt: '2026-10-06T00:00:00.000Z' };
  assert.deepEqual(h.calls.scaffold[0].files.map((f) => f.path).sort(),
    scaffold.filesFor({ input: { appName: 'Ear Trainer', template: 'empty' }, sketch }).map((f) => f.path).sort());
  assert.ok(h.calls.scaffold[0].files.some((f) => f.path === 'design/sketch.json'), 'the card is in the first commit, as creation puts it');
  assert.deepEqual(h.calls.deleted, ['bench/r3-s12', 'bench/r3-t44'], 'the first commit\'s branch, then an earlier attempt\'s branch of the same trial');
  assert.deepEqual(h.calls.pinned.slice(0, 2), [{ branch: 'bench/r3-s12', sha: SCAFFOLD }, { branch: 'bench/r3-t44', sha: SCAFFOLD }]);
  assert.ok(h.calls.pinned.slice(2).every((p) => p.branch === 'bench/r3-t44' && p.sha === SCAFFOLD), 'the build confirms the trial\'s branch at the same commit');
  assert.equal(out.base_sha, SCAFFOLD);
  assert.deepEqual(out.parsed.scaffold, { sha: SCAFFOLD, branch: 'bench/r3-s12' });
  assert.equal(out.parsed.sketch.tagline, CARD.tagline);
  // The bot's own first-version triage, on the request the bot would read:
  // the brief, quoting the card as a project's first request does.
  assert.deepEqual(h.calls.modes, ['scout', 'scout', 'build'], 'triage, spec, build');
  const triagePrompt = h.calls.prompts[0];
  assert.ok(triagePrompt.includes('THIS REQUEST IS A NEW PROJECT\'S FIRST VERSION'));
  assert.ok(triagePrompt.includes(EAR_TRAINER));
  assert.ok(triagePrompt.includes('**Featured card:**'));
  assert.ok(triagePrompt.includes(CARD.tagline));
  const card = { emoji: CARD.emoji, tagline: CARD.tagline, points: CARD.points, committed: true };
  assert.ok(triagePrompt.startsWith(taste.seedFor({ appName: 'Ear Trainer', brief: EAR_TRAINER }, 'usernode-bot', card)));
  assert.ok(!triagePrompt.includes('ADDITIONAL GUIDANCE'), 'no pack, no guidance');
  // Then the bot's real build, as a first version, never proposed.
  assert.equal(args.firstVersion, true);
  assert.equal(args.propose, false);
  assert.ok(args.buildNote.startsWith('Lessons list, a keyboard, both looks.'), 'the triage\'s plan, as the bot hands it on');
  assert.equal(args.specModel, undefined, 'one model for every turn');
  assert.equal(args.turnBudgetMs, 120_000, 'a first version\'s longer clock');
  assert.equal(args.issue.title, 'First version of Ear Trainer');
  assert.ok(h.calls.prompts[2].includes('Lessons list, a keyboard, both looks.'));
  // The screenshots, on the build's own worker, sealed at the first commit.
  assert.equal(h.calls.capture.length, 1);
  assert.equal(h.calls.capture[0].trialId, 44);
  assert.equal(h.calls.capture[0].containerName, `w-${out.session_id}`);
  assert.equal(h.calls.ensured.at(-1).pinnedBase, SCAFFOLD, 'the sealed worker');
  assert.equal(out.capture.booted, true);
  assert.equal(out.parsed.built, true);
  assert.equal(out.parsed.triage.verdict, 'ready');
  assert.deepEqual(out.parsed.plan.chosen, [], 'a plan with no questions: nothing chosen');
  assert.equal(out.session_ids.length, 2, 'the triage\'s session and the build\'s are both the trial\'s cost');
  assert.equal(out.build_commits, 3);
  assert.deepEqual(side, [], 'nothing posted, commented, DMed, pushed or proposed');
});

test('a first version whose screenshot step the platform could not run is a fault, not the build\'s fail', async (t) => {
  spySideEffects(t);
  const h = harness({ captureOut: { ok: false, error: 'the screenshot step did not run: exec died' } });
  const out = await runner.runStage(ctx(h, 'first_version', FIRST));
  assert.equal(out.status, 'infra_fail');
  assert.match(out.error, /did not run/);
  assert.equal(out.build_commits, 3, 'what the build did is still recorded');
  assert.equal(out.session_ids.length, 2, 'and what it cost');
});

test('a first version the triage would not build builds nothing, and says what the triage answered', async (t) => {
  spySideEffects(t);
  const h = harness({ verdict: 'question' });
  const out = await runner.runStage(ctx(h, 'first_version', FIRST));
  assert.equal(out.status, 'ok');
  assert.equal(out.parsed.built, false);
  assert.equal(out.parsed.triage.verdict, 'question');
  assert.deepEqual(h.calls.modes, ['scout']);
  assert.equal(h.calls.capture.length, 0);
  assert.equal(graders.deterministicGrade({ stage: 'first_version', trial: { ...out, status: 'ok' } }).pass, false);
});

// ── A first version after a restart ─────────────────────────────────────
//
// A restart hands a first version back to the lane with what it finished
// kept on the trial (services/bench/lane.js "After a restart"), and its next
// claim goes on from there: each kept sub-step is taken as it is, never run
// again. tests/bench-restart-recovery.test.js covers the hand-back itself.

/** A first version run start to end, with every part of its checkpoint it kept. */
async function keptRun(t) {
  spySideEffects(t);
  const h = harness();
  const parts = [];
  const out = await runner.runStage(ctx(h, 'first_version', FIRST, { onCheckpoint: async (p) => { parts.push(p); } }));
  assert.equal(out.status, 'ok', out.error);
  return { out, parts, kept: Object.assign({}, ...parts) };
}

// An earlier claim's triage session, apart from the sessions a fresh harness opens.
const KEPT_TRIAGE = 6100;
const keptTriageOf = (kept) => ({ triageSessionId: KEPT_TRIAGE, triage: { ...kept.triage, session_id: KEPT_TRIAGE } });

test('a first version keeps each sub-step as it finishes: the triage\'s session before its turn, then its answer, the spec and the build that landed', async (t) => {
  const { out, parts, kept } = await keptRun(t);
  const order = parts.flatMap((p) => Object.keys(p).filter((k) => k !== 'sessions'));
  assert.deepEqual(order, ['triageSessionId', 'triage', 'sight', 'spec', 'sight', 'build'],
    'in the order they finish, with what the build could see before each of its turns');
  const [triageSession, buildSession] = out.session_ids;
  assert.equal(kept.triageSessionId, triageSession, 'recovery tells the triage\'s turn from the spec\'s by it');
  assert.deepEqual(kept.sessions, [triageSession, buildSession], 'every session the trial opened');
  assert.equal(kept.triage.status, 'ok');
  assert.equal(kept.triage.session_id, triageSession);
  assert.equal(kept.triage.parsed.verdict, 'ready');
  assert.equal(kept.triage.session, undefined, 'never the live session object');
  assert.deepEqual(kept.spec, { sessionId: buildSession, specMd: '# Ear Trainer\n\nThe first version.' });
  assert.equal(kept.build.ok, true);
  assert.equal(kept.build.sha, 'c'.repeat(40));
  assert.equal(kept.build.commits, 3);
  assert.equal(kept.build.sessionId, buildSession);
  assert.equal(out.parsed.resumedAfterRestart, undefined, 'a trial no restart touched says nothing about one');
});

test('a first version going on after a restart is never triaged again: the kept answer leads to the spec and the build', async (t) => {
  const { kept } = await keptRun(t);
  const h = harness();
  const checkpoint = { ...keptTriageOf(kept), sessions: [KEPT_TRIAGE], handBacks: 1 };
  const out = await runner.runStage(ctx(h, 'first_version', FIRST, { checkpoint }));
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, ['scout', 'build'], 'the spec and the build, no triage');
  assert.ok(!/now answer the triage request/i.test(h.calls.prompts[0]), 'the first turn is the spec');
  assert.ok(h.calls.prompts[1].includes('Lessons list, a keyboard, both looks.'), 'built from the kept triage\'s plan');
  assert.equal(out.parsed.triage.verdict, 'ready');
  assert.deepEqual(h.calls.deleted, ['bench/r3-s12', 'bench/r3-t44'], 'the branch starts again at the first commit');
  assert.equal(out.session_ids[0], KEPT_TRIAGE, 'the kept triage\'s session is still the trial\'s cost');
  assert.equal(out.session_ids.length, 2);
  assert.equal(out.parsed.resumedAfterRestart, 1);
  assert.equal(h.calls.capture.length, 1);
});

test('a kept spec is built from as it is: one build turn, the spec\'s session counted', async (t) => {
  const { kept } = await keptRun(t);
  const realBuild = live.buildAndPropose;
  let args = null;
  live.buildAndPropose = async (a) => { args = a; return realBuild(a); };
  t.after(() => { live.buildAndPropose = realBuild; });
  const h = harness();
  const spec = { sessionId: 6001, specMd: '# Ear Trainer\n\nThe kept spec.' };
  const out = await runner.runStage(ctx(h, 'first_version', FIRST, {
    checkpoint: { ...keptTriageOf(kept), sessions: [KEPT_TRIAGE, 6001], spec },
  }));
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, ['build']);
  assert.equal(args.presetSpec, spec.specMd);
  assert.ok(h.calls.prompts[0].includes('The kept spec.'));
  assert.equal(out.parsed.spec, spec.specMd);
  assert.ok(out.session_ids.includes(6001), 'the session that wrote the spec is the trial\'s cost');
  assert.equal(out.session_ids.length, 3);
});

test('a build that landed before a restart keeps its branch at its commit: no turn, the screenshots on a fresh worker', async (t) => {
  const { kept } = await keptRun(t);
  const h = harness();
  const sha = 'd'.repeat(40);
  const build = { ...kept.build, sessionId: 6002, sha, commits: 2 };
  const out = await runner.runStage(ctx(h, 'first_version', FIRST, {
    checkpoint: { ...keptTriageOf(kept), sessions: [KEPT_TRIAGE, 6002], spec: { sessionId: 6002, specMd: kept.spec.specMd }, build },
  }));
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(h.calls.modes, [], 'no model turn');
  assert.ok(!h.calls.deleted.includes('bench/r3-t44'), 'its branch is kept');
  assert.ok(h.calls.pinned.some((p) => p.branch === 'bench/r3-t44' && p.sha === sha), 'and confirmed at the build\'s commit');
  assert.equal(out.build_sha, sha);
  assert.equal(out.build_commits, 2);
  assert.match(out.diff, /public\/index\.html/, 'its diff read from the first commit');
  assert.equal(out.parsed.built, true);
  assert.equal(out.parsed.spec, kept.spec.specMd);
  assert.equal(h.calls.capture.length, 1);
  const shotSession = out.session_ids.at(-1);
  assert.notEqual(shotSession, 6002);
  assert.equal(h.calls.capture[0].containerName, `w-${shotSession}`, 'a fresh worker');
  assert.equal(h.calls.ensured.at(-1).pinnedBase, SCAFFOLD, 'sealed at the first commit, as a live build\'s is');
  assert.deepEqual(out.session_ids, [KEPT_TRIAGE, 6002, shotSession], 'the kept triage\'s and build\'s sessions, then the screenshots\'');
  assert.equal(out.capture.booted, true);
});

test('a kept failure is the trial\'s outcome, recorded as the live stage would record it', async (t) => {
  const { kept } = await keptRun(t);
  const timedOut = harness();
  const triage = { status: 'timeout', error: 'the turn ran past its time limit', session_id: 6003, cost_usd: null, raw_output: '', parsed: null };
  const a = await runner.runStage(ctx(timedOut, 'first_version', FIRST, { checkpoint: { triageSessionId: 6003, sessions: [6003], triage } }));
  assert.equal(a.status, 'timeout');
  assert.deepEqual(timedOut.calls.modes, []);
  assert.equal(a.parsed.built, false);

  const failed = harness();
  const build = { ok: false, sessionId: 6004, sha: null, commits: null, specMd: null, specNote: null, error: 'the build ran past its time limit (finished after a restart)' };
  const b = await runner.runStage(ctx(failed, 'first_version', FIRST, { checkpoint: { ...keptTriageOf(kept), build } }));
  assert.equal(b.status, 'timeout');
  assert.deepEqual(failed.calls.modes, []);
  assert.equal(failed.calls.capture.length, 0);

  const blocked = harness();
  const spec = { sessionId: 6005, blocked: 'needs a microphone the frame cannot have', error: 'blocked: needs a microphone the frame cannot have' };
  const c = await runner.runStage(ctx(blocked, 'first_version', FIRST, { checkpoint: { ...keptTriageOf(kept), spec } }));
  assert.equal(c.status, 'ok');
  assert.equal(c.parsed.blocked, spec.blocked);
  assert.deepEqual(blocked.calls.modes, []);

  // A build said to have landed with no commit on record is built again.
  const noSha = harness();
  const d = await runner.runStage(ctx(noSha, 'first_version', FIRST, {
    checkpoint: { ...keptTriageOf(kept), build: { ok: true, sessionId: 6006, sha: null, commits: 1 } },
  }));
  assert.equal(d.status, 'ok');
  assert.deepEqual(noSha.calls.modes, ['scout', 'build']);
});

test('restart recovery follows every turn of a first version and reads what it produced as the live stage would', () => {
  const scout = { mode: 'scout' };
  const build = { mode: 'build' };
  assert.equal(runner.resumableTurn('first_version', scout), true);
  assert.equal(runner.resumableTurn('first_version', build), true);
  assert.equal(runner.resumableTurn('first_version', { mode: 'shots' }), false);
  assert.equal(runner.resumableTurn('first_version', scout, { reference: true }), false, 'a reference build has no turn');
  assert.equal(runner.resumableTurn('first_version', null), false);

  assert.equal(runner.firstVersionTurnOf({ triageSessionId: 5 }, 5, scout), 'triage');
  assert.equal(runner.firstVersionTurnOf({ triageSessionId: 5 }, 6, scout), 'spec');
  assert.equal(runner.firstVersionTurnOf({}, 6, scout), 'triage', 'nothing kept yet: the triage');
  assert.equal(runner.firstVersionTurnOf({ triage: { status: 'ok' } }, 6, scout), 'spec');
  assert.equal(runner.firstVersionTurnOf(null, 6, build), 'build');

  const session = { id: 6, spec_md: '' };
  const verdict = `\`\`\`json\n${JSON.stringify({ verdict: 'ready', determined: true, build_note: 'Lessons list.', reason: 'clear' })}\n\`\`\``;
  const tri = runner.recoverFirstVersionTurn({ checkpoint: { triageSessionId: 6 }, session, activeTurn: scout, result: { lastResultText: verdict } });
  assert.equal(tri.step, 'triage');
  assert.equal(tri.keep.triage.status, 'ok');
  assert.equal(tri.keep.triage.session_id, 6);
  assert.equal(tri.keep.triage.parsed.buildNote, 'Lessons list.');
  const lateTriage = runner.recoverFirstVersionTurn({ checkpoint: { triageSessionId: 6 }, session, activeTurn: scout, result: {}, timedOut: true });
  assert.equal(lateTriage.keep.triage.status, 'timeout', 'a triage\'s failure is its outcome');

  const cp = { triageSessionId: 5, triage: { status: 'ok' } };
  const spec = runner.recoverFirstVersionTurn({ checkpoint: cp, session, activeTurn: scout, result: { lastResultText: '# Ear Trainer\n\nThe first version.' } });
  assert.deepEqual(spec, { step: 'spec', keep: { spec: { sessionId: 6, specMd: '# Ear Trainer\n\nThe first version.' } } });
  const blocked = runner.recoverFirstVersionTurn({ checkpoint: cp, session, activeTurn: scout, result: { lastResultText: 'BLOCKED: needs a microphone' } });
  assert.equal(blocked.keep.spec.blocked, 'needs a microphone');
  assert.equal(runner.recoverFirstVersionTurn({ checkpoint: cp, session, activeTurn: scout, result: {}, timedOut: true }), null,
    'a spec that ran out of time is written again');
  assert.equal(runner.recoverFirstVersionTurn({ checkpoint: cp, session, activeTurn: scout, result: { lastResultText: '' } }), null);

  const withSpec = { ...cp, spec: { sessionId: 6, specMd: '# Kept' } };
  const landed = runner.recoverFirstVersionTurn({ checkpoint: withSpec, session, activeTurn: build, result: { pushOk: true, ahead: 2, sha: 'd'.repeat(40) } });
  assert.equal(landed.step, 'build');
  assert.deepEqual(landed.keep.build, { ok: true, sessionId: 6, sha: 'd'.repeat(40), commits: 2, specMd: '# Kept', specNote: null, error: null });
  const late = runner.recoverFirstVersionTurn({ checkpoint: withSpec, session, activeTurn: build, result: {}, timedOut: true });
  assert.equal(late.keep.build.ok, false);
  assert.match(late.keep.build.error, /ran past its time limit \(finished after a restart\)/);
  assert.equal(runner.recoverFirstVersionTurn({ checkpoint: cp, session, activeTurn: { mode: 'shots' } }), null);
});

test('a build records whether it could see its own screens: what its prompt told it, and what its model was handed', async (t) => {
  spySideEffects(t);
  const realSees = live.buildSeesImages;
  t.after(() => { live.buildSeesImages = realSees; });
  const buildPromptOf = (h) => h.calls.prompts[h.calls.modes.lastIndexOf('build')];

  live.buildSeesImages = async () => true;
  const seeing = harness({ takesImages: true });
  const a = await runner.runStage(ctx(seeing, 'first_version', FIRST));
  assert.equal(a.status, 'ok', a.error);
  assert.deepEqual(a.parsed.sight, { told: true, passed: true });
  assert.ok(buildPromptOf(seeing).includes('take screenshots (`browser_take_screenshot`)'), 'the prompt asks for screenshots');

  live.buildSeesImages = async () => false;
  const blind = harness({ takesImages: false });
  const b = await runner.runStage(ctx(blind, 'first_version', FIRST));
  assert.deepEqual(b.parsed.sight, { told: false, passed: false });
  assert.ok(buildPromptOf(blind).includes('you read text, not images'), 'the prompt asks for the text snapshot');

  // Told it reads text while its model is handed images: the mismatch shows.
  const mixed = harness({ takesImages: true });
  const c = await runner.runStage(ctx(mixed, 'first_version', FIRST));
  assert.deepEqual(c.parsed.sight, { told: false, passed: true });

  // A build kept through a restart keeps what it could see.
  const parts = [];
  live.buildSeesImages = async () => true;
  const kept = harness({ takesImages: true });
  await runner.runStage(ctx(kept, 'first_version', FIRST, { onCheckpoint: async (p) => { parts.push(p); } }));
  const checkpoint = Object.assign({}, ...parts);
  assert.deepEqual(checkpoint.build.sight, { told: true, passed: true });
  const resumed = harness();
  const d = await runner.runStage(ctx(resumed, 'first_version', FIRST, { checkpoint: { ...checkpoint, build: { ...checkpoint.build, sessionId: 6007 } } }));
  assert.deepEqual(resumed.calls.modes, [], 'no turn');
  assert.deepEqual(d.parsed.sight, { told: true, passed: true });
});

test('what a build could see is kept before its build turn runs, so a build restart recovery finished keeps it too', async (t) => {
  spySideEffects(t);
  const realSees = live.buildSeesImages;
  t.after(() => { live.buildSeesImages = realSees; });
  live.buildSeesImages = async () => true;
  const h = harness({ takesImages: false });
  const parts = [];
  const realExec = h.deps.worker.execInWorker;
  let atBuildTurn = null;
  h.deps.worker.execInWorker = async (id, opts) => {
    if (opts.mode === 'build') atBuildTurn = Object.assign({}, ...parts);
    return realExec(id, opts);
  };
  const out = await runner.runStage(ctx(h, 'first_version', FIRST, { onCheckpoint: async (p) => { parts.push(p); } }));
  assert.equal(out.status, 'ok', out.error);
  assert.deepEqual(atBuildTurn.sight, { told: true, passed: false }, 'on the checkpoint before the build turn started');
  assert.equal(atBuildTurn.build, undefined, 'long before the build is kept');

  // The build turn was finished by restart recovery, which reads only how it
  // ended: its kept build says nothing of what it could see.
  const checkpoint = Object.assign({}, ...parts.filter((p) => !p.build));
  const recovered = runner.recoverFirstVersionTurn({
    checkpoint, session: { id: checkpoint.spec.sessionId, spec_md: '' }, activeTurn: { mode: 'build' },
    result: { pushOk: true, ahead: 2, sha: 'd'.repeat(40) },
  });
  assert.equal(recovered.keep.build.ok, true);
  assert.equal(recovered.keep.build.sight, undefined);
  const resumed = harness();
  const next = await runner.runStage(ctx(resumed, 'first_version', FIRST, { checkpoint: { ...checkpoint, ...recovered.keep } }));
  assert.equal(next.status, 'ok', next.error);
  assert.deepEqual(resumed.calls.modes, [], 'no turn');
  assert.deepEqual(next.parsed.sight, { told: true, passed: false }, 'the next claim reads it from the checkpoint');
});

test('a turn followed after a restart adds its replayed looks to the counts its step began with, never twice', () => {
  const cp = {
    stepLooks: { step: 'build', screenshots: 0, snapshots: 1, navigations: 1 },
    // Kept while it ran, until a few seconds before the restart.
    looks: { screenshots: 2, snapshots: 1, navigations: 2 },
  };
  const lines = ['Using browser_navigate', 'Using browser_take_screenshot', 'Using browser_take_screenshot',
    'Using browser_take_screenshot', 'Using browser_navigate', 'Using browser_take_screenshot', '[done]'];
  const looks = lane.recoveredLooks(cp, 'build', lines);
  assert.deepEqual(looks, { screenshots: 4, snapshots: 1, navigations: 3 }, 'the step\'s counts plus the whole turn\'s');
  assert.deepEqual(lane.recoveredLooks({ ...cp, looks }, 'build', lines), looks, 'followed again: the same, not more');
  assert.equal(lane.recoveredLooks(cp, 'spec', lines), null, 'a turn of another step: the checkpoint\'s stay');
  assert.equal(lane.recoveredLooks({ looks: cp.looks }, 'build', lines), null, 'no step on record: the checkpoint\'s stay');
  assert.equal(lane.recoveredLooks(cp, 'build', []), null, 'no lines replayed: the checkpoint\'s stay');
  assert.deepEqual(lane.recoveredLooks({ ...cp, looks: { screenshots: 9, snapshots: 0, navigations: 0 } }, 'build', lines),
    { screenshots: 9, snapshots: 1, navigations: 3 }, 'never below what the checkpoint holds');
});

test('a capture trial checks the app out at its commit in a sealed worker and only takes the screenshots: no model turn', async (t) => {
  const side = spySideEffects(t);
  const h = harness();
  const sha = 'e'.repeat(40);
  const snap = { id: 6, stage: 'build', issueNumber: 1, baseSha: sha, texts: { brief: EAR_TRAINER }, extra: { taste: 'capture', appName: 'Ear Trainer', sha } };
  const out = await runner.runStage(ctx(h, 'capture', snap));
  assert.equal(out.status, 'ok');
  assert.deepEqual(h.calls.pinned, [{ branch: 'bench/r3-t44', sha }]);
  assert.deepEqual(h.calls.modes, [], 'no agent turn');
  assert.equal(out.cost_usd, 0);
  assert.equal(h.calls.capture.length, 1);
  assert.equal(h.calls.ensured[0].pinnedBase, sha);
  assert.equal(out.capture.booted, true);
  assert.equal(h.calls.scaffold.length, 0);
  assert.deepEqual(side, []);
  // The platform failing to run the step is a fault, not the app's.
  const broken = harness({ captureOut: { ok: false, error: 'the screenshot step did not run: exec died' } });
  const failed = await runner.runStage(ctx(broken, 'capture', snap));
  assert.equal(failed.status, 'infra_fail');
  assert.match(failed.error, /did not run/);
});

test('the only GitHub write a taste trial has is its own bench branch', async () => {
  const gh = runner.guardedGithub({ createRootCommit: async () => 'x', deleteBenchBranch: async () => true, ensureBranchAtSha: async () => ({}) });
  await assert.rejects(() => gh.createBenchScaffold('o', 'r', 'main', [], 'm'), /benchmark trials may not/);
  await assert.rejects(async () => gh.createRootCommit('o', 'r', [], {}), /benchmark trials may not/, 'never a bare commit outside the scaffold');
  assert.equal(await gh.createBenchScaffold('o', 'r', 'bench/r1-t2', [], 'm'), 'x');
});
