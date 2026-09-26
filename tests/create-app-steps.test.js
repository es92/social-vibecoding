// The create dialog is steps that UNFOLD in one card (#1911), not one page of
// every choice. Since communities, stage 3, it asks who a project is FOR
// before anything else:
//
//   who      Just me (preselected), A group, A community; a group's invitees
//   start    what you are making (an App; Document and Video "Soon"), then
//            from scratch or from a GitHub repo (the old mode pills, as rows)
//   details  the name; for an import, the repo URL and its check first
//   approve  who approves changes — a group or a community made new only
//
// `data-step` is the furthest step reached; every section ships on every
// step and app.css folds and unfolds them off #create-card[data-step] and
// [data-final]. This pins the component's wiring, the wire body, the CSS,
// the shot links and the checks at source level, and renders the dialog to
// prove the prerendered document starts on the first step with every id.
//
// Run with: node --test tests/create-app-steps.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const SRC = read('frontend/src/features/dialogs/create-app.tsx');
const CSS = read('public/css/app.css');
const DAPP = JSON.parse(read('dapp.json'));
const { shellMarkup } = require('./lib/shell-markup');
const { loadTsx } = require('./lib/render-tsx');

test('the steps a set of answers walks: three for Just me or an import, four otherwise', () => {
  const { stepsFor } = loadTsx('frontend/src/features/dialogs/create-app.tsx');
  assert.deepEqual([...stepsFor('solo', 'new')], ['who', 'start', 'details']);
  assert.deepEqual([...stepsFor('invited', 'new')], ['who', 'start', 'details', 'approve']);
  assert.deepEqual([...stepsFor('open', 'new')], ['who', 'start', 'details', 'approve']);
  assert.deepEqual([...stepsFor('open', 'import')], ['who', 'start', 'details'],
    'an imported repo\'s own dapp.json decides who approves');
  assert.match(SRC, /useState<Audience>\('solo'\)/, 'Just me is preselected');
  assert.match(SRC, /useState<Step>\('who'\)/, 'the initial state is the prerendered one');
  // Every answer rides on the root AND the card: the kit lifts the card out
  // of the root while presented.
  assert.match(SRC, /id="create-modal"\s+ref=\{dialog\.rootRef\}\s+\{\.\.\.answers\}/);
  assert.match(SRC, /id="create-card"\s+\{\.\.\.answers\}/);
  for (const attr of ['data-mode', 'data-import-state', 'data-step', 'data-audience', 'data-approvers', 'data-approvals', 'data-final']) {
    assert.match(SRC, new RegExp(`'${attr}': `), attr);
  }
  // Close puts every answer back.
  assert.match(SRC, /formRef\.current\?\.reset\(\);[\s\S]*?setAudience\('solo'\);\s*setStep\('who'\);\s*setApprovers\(null\);\s*setApprovals\(null\);/);
});

test('the wire body says who it is for, whom to invite and who approves', () => {
  const { createBody } = loadTsx('frontend/src/features/dialogs/create-app.tsx');
  const base = { name: 'Book club', mode: 'new', approvers: 'anyone', approvals: 'majority' };
  assert.deepEqual(createBody({ ...base, audience: 'solo', invitees: '@ada' }),
    { name: 'Book club', audience: 'solo' }, 'Just me sends no invitees, whatever the hidden field holds');
  assert.deepEqual(createBody({ ...base, audience: 'invited', invitees: ' @ada, grace  @lin,' }),
    { name: 'Book club', audience: 'invited', invitees: ['ada', 'grace', 'lin'] });
  assert.deepEqual(createBody({ ...base, audience: 'open', approvers: 'invited' }),
    { name: 'Book club', audience: 'open', governance: { approvers: 'invited', approvals: 'default' } });
  assert.deepEqual(createBody({ ...base, audience: 'open', approvers: 'invited', approvals: 'atLeast', approvalsN: 3 }).governance,
    { approvers: 'invited', approvals: { atLeast: 3 } }, 'at least N is a follow-up under People I pick');
  assert.equal(createBody({ ...base, audience: 'open', approvals: 'atLeast', approvalsN: 3 }).governance, undefined,
    'members vote is the default rule, which sends nothing');
  assert.equal(createBody({ ...base, audience: 'solo', approvers: 'invited' }).governance, undefined,
    'Just me has no approval step');
  assert.deepEqual(createBody({ ...base, mode: 'import', repoUrl: 'https://github.com/o/r', audience: 'open', approvers: 'invited' }),
    { name: 'Book club', audience: 'open', repoUrl: 'https://github.com/o/r' }, 'an import sends no rule');
  assert.equal(createBody({ ...base, audience: 'open', approvers: 'invited', approvals: 'atLeast', approvalsN: 99 }).governance.approvals,
    'default', 'an out-of-range number falls back rather than being refused by the server');
  assert.equal(createBody({ ...base, audience: 'open', description: '  Swap seeds \n and plan  ' }).description,
    'Swap seeds and plan', 'What is it? is one tidied line');
  assert.equal(createBody({ ...base, audience: 'open', description: '   ' }).description, undefined, 'blank sends nothing');
  assert.equal(createBody({ ...base, mode: 'import', repoUrl: 'https://github.com/o/r', audience: 'open', description: 'Ours' }).description,
    undefined, 'an import\'s own dapp.json describes it');
  const submit = SRC.slice(SRC.indexOf('async function submit(event: FormEvent) {'), SRC.indexOf('  const stepIndex'));
  assert.match(submit, /const body = createBody\(\{/);
  assert.match(submit, /body: JSON\.stringify\(body\)/);
});

test('the first step is who it is for, in the Workshop\'s words, and a choice advances', () => {
  const who = SRC.slice(SRC.indexOf('data-create-step="who"'), SRC.indexOf('data-create-step="start"'));
  assert.match(who, /1\. Who is it for\?/);
  assert.match(SRC, /\{ key: 'solo', title: 'Just me',/);
  assert.match(SRC, /\{ key: 'invited', title: 'A group',/);
  assert.match(SRC, /\{ key: 'open', title: 'A community',/);
  assert.match(who, /data-audience-pill=\{choice\.key\}/);
  assert.match(who, /onClick=\{\(\) => chooseAudience\(choice\.key\)\}/);
  assert.match(SRC, /function chooseAudience\(next: Audience\) \{\s*if \(step !== 'who'\) \{\s*setError\(''\);\s*setStep\('who'\);\s*return;\s*\}\s*setAudience\(next\);\s*setError\(''\);\s*setStep\('start'\);/);
  // A group names its people under its collapsed row.
  assert.match(who, /id="create-invite-block"/);
  assert.match(who, /id="create-invitees"/);
  assert.match(who, /Invite people/);
});

test('the second step is what you are making, then how to begin', () => {
  const start = SRC.slice(SRC.indexOf('data-create-step="start"'), SRC.indexOf('data-create-step="details"'));
  assert.match(start, /2\. What are you making\?/);
  assert.match(start, /data-kind-pill="app"/);
  assert.match(start, /data-kind-pill="doc" aria-disabled="true"/);
  assert.match(start, /data-kind-pill="video" aria-disabled="true"/);
  assert.equal((start.match(/>Soon</g) || []).length, 2, 'the two coming kinds say so');
  assert.match(start, /data-mode-pill="new"/);
  assert.match(start, /data-mode-pill="import"/);
  assert.equal((start.match(/className=\{CHOICE\}/g) || []).length, 2);
  assert.match(SRC, /const CHOICE = 'create-mode-pill ' \+ CHOICE_BASE;/, 'the same class the mode pills carried');
  assert.match(SRC, /function choose\(next: Mode\) \{[\s\S]*?applyMode\(next\);\s*setStep\('details'\);/);
  assert.match(start, /Start from scratch/);
  assert.match(start, /Import a GitHub repo/);
});

test('Next on a choice step advances the selected answer without validating hidden details', () => {
  const source = SRC.slice(SRC.indexOf('function next() {'), SRC.indexOf('/** One entry point keeps every mirror of the mode in sync. */'));
  const hiddenName = { get current() { throw new Error('The name field is still hidden'); } };
  for (const [stepName, arg] of [['who', 'open'], ['start', 'import']]) {
    const calls = [];
    const next = new Function('step', 'audience', 'mode', 'chooseAudience', 'choose', 'nameRef', `${source}; return next;`)(
      stepName, 'open', 'import', (a) => calls.push(['who', a]), (m) => calls.push(['start', m]), hiddenName,
    );
    next();
    assert.deepEqual(calls, [[stepName, arg]], 'Next uses the same transition as the selected choice');
  }
});

test('the details step keeps the import block and the name card, and runs the guards one step early', () => {
  const details = SRC.slice(SRC.indexOf('data-create-step="details"'), SRC.indexOf('data-create-step="approve"'));
  assert.ok(details.indexOf('id="create-import-block"') < details.indexOf('id="create-name-block"'));
  assert.match(details, /id="import-url"/);
  assert.match(details, /id="import-check"/);
  assert.match(details, /id="app-name"/);
  assert.match(details, /Project name/);
  assert.ok(details.indexOf('id="app-name"') < details.indexOf('id="app-description"'),
    'What is it? sits under the name, in the same card');
  assert.match(details, /What is it\? \(optional\)/);
  assert.match(details, /maxLength=\{100\}/);
  assert.match(details, /create-describe-row/);
  assert.match(CSS, /#create-card\[data-mode="import"\] \.create-describe-row \{ display: none; \}/,
    'an import has no What is it? row');
  assert.match(details, /create-import-rule-note/, 'an import says why there is no approval step');
  const next = SRC.slice(SRC.indexOf('function next() {'), SRC.indexOf('/** One entry point'));
  assert.match(next, /Paste a GitHub repo URL first\./);
  assert.match(next, /Click "Check" to verify bot access first\./);
  assert.match(next, /Give your project a name\./);
  assert.match(next, /if \(!isLast\) \{\s*setStep\('approve'\);\s*reveal\(\);\s*\}/);
  assert.match(SRC, /if \(!isLast\) \{\s*next\(\);\s*return;\s*\}/, 'submit before the last step never POSTs');
  assert.doesNotMatch(SRC, /id="create-back"/, 'no Back: the earlier steps stay on screen');
});

test('the last step for a group or a community is who approves, with at least N under People I pick', () => {
  const approve = SRC.slice(SRC.indexOf('data-create-step="approve"'), SRC.indexOf('id="create-error"'));
  assert.match(approve, /4\. Who approves changes\?/);
  assert.match(approve, /id="create-approve-block"/);
  assert.ok(approve.indexOf('data-approver-pill="anyone"') < approve.indexOf('data-approver-pill="invited"'));
  assert.match(approve, /Members vote/);
  assert.match(approve, /People I pick/);
  assert.match(approve, /Starts with just you\./);
  assert.match(approve, /data-approvals-pill="majority"/);
  assert.match(approve, /data-approvals-pill="atLeast"/);
  assert.match(approve, /id="create-approvals-n"[\s\S]*?min=\{1\}[\s\S]*?max=\{50\}[\s\S]*?defaultValue="1"/);
  for (const id of ['create-cancel', 'create-next', 'create-submit']) {
    assert.match(SRC, new RegExp(`id="${id}"`), `${id} ships`);
  }
});

test('app.css unfolds the steps in place, keeps the approval step to a group or a community, and shapes the footer', () => {
  const folds = [
    '#create-card[data-step="who"]     [data-create-step="start"]',
    '#create-card[data-step="who"]     [data-create-step="details"]',
    '#create-card[data-step="who"]     [data-create-step="approve"]',
    '#create-card[data-step="start"]   [data-create-step="details"]',
    '#create-card[data-step="start"]   [data-create-step="approve"]',
    '#create-card[data-step="details"] [data-create-step="approve"]',
    '#create-card[data-audience="solo"] [data-create-step="approve"]',
    '#create-card[data-mode="import"]   [data-create-step="approve"]',
  ];
  const at = CSS.indexOf(folds[0]);
  assert.ok(at > 0);
  const block = CSS.slice(at, CSS.indexOf('}', at));
  for (const f of folds) assert.ok(block.includes(f), f);
  assert.match(block, /display: none;/);
  assert.doesNotMatch(CSS, /#create-card \[data-create-step\] \{ display: none; \}/, 'no step is hidden by default');
  // QA 2026-09-24 Q6: never two accent buttons at once.
  assert.match(CSS, /#create-card\[data-final="false"\] #create-submit,\n#create-card\[data-final="true"\]  #create-next \{\n  display: none;\n\}/);
  assert.match(SRC, /'data-final': isLast \? 'true' : 'false'/);
  assert.doesNotMatch(CSS, /#create-cancel \{ display: none; \}/, 'Cancel is always there');
  // The invite field is a group's alone; the number is a follow-up.
  assert.match(CSS, /#create-card\[data-audience="invited"\]:not\(\[data-step="who"\]\) \.create-invite-block \{ display: block; \}/);
  assert.match(CSS, /#create-card\[data-approvers="invited"\] \.create-approvals-block \{ display: block; \}/);
  assert.match(CSS, /#create-card\[data-approvers="invited"\]\[data-approvals="atLeast"\] \.create-approvals-n-block \{ display: block; \}/);
  // The name card's import gating stays.
  assert.match(CSS, /#create-card\[data-mode="import"\]\[data-import-state="ok"\] #create-name-block \{ display: block; \}/);
});

// #2566, and the design pass: the selected choice wears the accent the
// dialog's own Create button carries — Tailwind's violet-600, which
// tailwind.config.js compiles to the platform blue #0a6ee0. It was the
// literal #7c3aed, the pre-reskin violet: a purple row beside a blue button.
test('every selected choice wears the Create button\'s accent', () => {
  const tw = read('tailwind.config.js');
  assert.match(tw, /600:'#0a6ee0'/, 'violet-600 is the platform blue');
  const at = CSS.indexOf('#create-card:not([data-step="who"])[data-audience="solo"]    .create-who-pill[data-audience-pill="solo"],');
  assert.ok(at > 0);
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  for (const sel of ['data-audience-pill="invited"', 'data-mode-pill="new"', 'data-mode-pill="import"',
    'data-approver-pill="anyone"', 'data-approver-pill="invited"', 'data-approvals-pill="majority"', 'data-approvals-pill="atLeast"']) {
    assert.ok(rule.includes(sel), sel);
  }
  assert.match(rule, /background: #0a6ee0; \/\* violet-600, as tailwind\.config\.js compiles it \*\/\n  color: #ffffff;/);
  const createBlock = CSS.slice(CSS.indexOf("/* ── The create dialog's choices"), CSS.indexOf('.members-vis-pill {'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(createBlock, /#7c3aed/, 'the pre-reskin violet is gone from the dialog');
  assert.doesNotMatch(createBlock, /background: var\(--text-primary\);\n  color: var\(--bg-primary\);/,
    'no selected state in the create dialog is the solid inversion');
});

// Request #3160: a question step starts with nothing chosen, and pressing a
// row moves on without a Next. "Just me" and "Start from scratch" were filled
// on arrival with a Next under them, which read as a choice already made and
// a button still to press.
test('a question step shows no choice until one is pressed, and has no Next', () => {
  const at = CSS.indexOf('#create-card:not([data-step="who"])[data-audience="solo"]    .create-who-pill[data-audience-pill="solo"],');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  // The fill on the first two steps' rows waits for the step to move on.
  for (const aud of ['solo', 'invited', 'open']) {
    assert.ok(rule.includes(`#create-card:not([data-step="who"])[data-audience="${aud}"]`), aud);
  }
  for (const mode of ['new', 'import']) {
    assert.match(rule, new RegExp(`#create-card:is\\(\\[data-step="details"\\], \\[data-step="approve"\\]\\)\\[data-mode="${mode}"\\]\\s+\\.create-mode-pill\\[data-mode-pill="${mode}"\\]`), mode);
  }
  assert.doesNotMatch(rule, /\n#create-card\[data-audience="(solo|invited|open)"\]\s+\.create-who-pill/,
    'no audience row is filled while its step is being asked');
  assert.doesNotMatch(rule, /\n#create-card\[data-mode="(new|import)"\]\s+\.create-mode-pill/,
    'no start row is filled while its step is being asked');
  // The approval step starts unanswered too. Its fill is keyed on the
  // answer, and the answer is empty until a row is pressed.
  assert.ok(rule.includes('#create-card[data-approvers="anyone"]   .create-approver-pill[data-approver-pill="anyone"]'));
  assert.match(SRC, /useState<Approvers \| null>\(null\)/);
  assert.match(SRC, /useState<Approvals \| null>\(null\)/);
  assert.match(SRC, /'data-approvers': approvers \?\? '',/);
  assert.match(SRC, /'data-approvals': approvals \?\? '',/);
  // Create waits for the answer, and only ever on that step, so the
  // prerendered button is unchanged.
  assert.match(SRC, /const approvalMissing = step === 'approve' && isLast\s*\n\s*&& \(approvers == null \|\| \(approvers === 'invited' && approvals == null\)\);/);
  assert.match(SRC, /disabled=\{quotaBlocksCreation \|\| submitting \|\| approvalMissing\}/);
  assert.match(SRC, /if \(approvalMissing\) \{\s*\n\s*setError\(approvers == null \? 'Choose who approves changes\.' : 'Choose how many of them must say yes\.'\);/);
  // No Next on either question step; Cancel stays.
  assert.match(CSS, /#create-card:is\(\[data-step="who"\], \[data-step="start"\]\) #create-next \{\n  display: none;\n\}/);
  // A press on a row is the answer: it sets it and unfolds the next step.
  assert.match(SRC, /setAudience\(next\);\s*\n\s*setError\(''\);\s*\n\s*setStep\('start'\);/);
  assert.match(SRC, /applyMode\(next\);\s*\n\s*setStep\('details'\);/);
});

test('the shot links land on the state they name, and each has a check', () => {
  assert.match(SRC, /if \(shot === 'create-import'\) return \{ \.\.\.open, mode: 'import', step: 'details' \};/);
  assert.match(SRC, /if \(shot === 'create-details'\) return \{ \.\.\.open, step: 'details' \};/);
  assert.match(SRC, /if \(shot === 'create-group'\) return \{ \.\.\.open, step: 'start', audience: 'invited' \};/);
  assert.match(SRC, /if \(shot === 'create-approve' \|\| shot === 'create-access'\) return \{ \.\.\.open, step: 'approve', audience: 'open' \};/);
  const byPath = new Map(DAPP.tests.map((t) => [t.path, t]));
  const first = DAPP.tests.find((t) => t.path === '/#create' && /Step 1 of 3/.test(t.expectText || ''));
  assert.ok(first, 'a check reads the step count on a cold open');
  assert.match(first.expectSelector, /\[data-step="who"\]\[data-audience="solo"\]/);
  const details = byPath.get('/?shot=create-details#create');
  assert.match(details.expectSelector, /\[data-step="details"\] #create-name-block/);
  assert.equal(details.expectText, 'Project name');
  const approve = byPath.get('/?shot=create-approve#create');
  assert.ok(approve, 'the approval step has its own check');
  assert.match(approve.expectSelector, /\[data-step="approve"\]\[data-audience="open"\]\[data-final="true"\] #create-approve-block/);
  assert.equal(approve.expectText, 'Who approves changes?');
  const group = byPath.get('/?shot=create-group#create');
  assert.ok(group && /#create-invite-block #create-invitees/.test(group.expectSelector), 'the invite field has a check');
  const imp = byPath.get('/?shot=create-import#create');
  assert.ok(imp && /data-mode="import"/.test(imp.expectSelector), 'the import shot still lands on the import view');
  assert.equal(byPath.get('/?shot=create-access#create'), undefined, 'the retired step has no check left');
  for (const t of DAPP.tests.filter((t) => t.path === '/#create')) {
    assert.doesNotMatch(t.expectText || '', /Who approves|Project name|Invite people/, t.name);
  }
});

test('the prerendered document starts on the first step with every id in place', () => {
  const html = shellMarkup();
  const card = html.slice(html.indexOf('id="create-card"'), html.indexOf('id="rename-modal"'));
  assert.match(card, /data-step="who"/);
  assert.match(card, /data-audience="solo"/);
  assert.match(card, /data-final="false"/);
  for (const step of ['who', 'start', 'details', 'approve']) {
    assert.match(card, new RegExp(`data-create-step="${step}"`), step);
  }
  assert.match(card, /Step 1 of 3/);
  for (const id of ['create-step-indicator', 'create-invite-block', 'create-invitees', 'create-import-block',
    'create-name-block', 'create-approve-block', 'create-approvals-n', 'create-cancel', 'create-next',
    'create-submit', 'import-url', 'app-name']) {
    assert.match(card, new RegExp(`id="${id}"`), id);
  }
  assert.doesNotMatch(card, /id="create-visibility-block"|id="create-vis-hint"/, 'the visibility rails are retired');
  assert.match(card, />New project</);
});

// QA 2026-09-24 Q5: a double-click on Create sent two POSTs and made two apps,
// each taking a slot. The handler claims a ref BEFORE its first await, so a
// second click (or an Enter) in the same frame returns without a request; the
// button is disabled and busy while the request is in flight; and both are
// released in a `finally`, so a failed request can be retried.
test('Create sends one request at a time and shows it is busy', () => {
  const submit = SRC.slice(SRC.indexOf('async function submit(event: FormEvent) {'), SRC.indexOf('  return (\n    <DialogRoot'));
  const guard = submit.indexOf('if (submittingRef.current) return;');
  assert.ok(guard > 0, 'the handler has its own in-flight guard');
  assert.ok(guard < submit.indexOf("await fetch('/api/apps'"), 'claimed before the request');
  assert.match(submit, /if \(submittingRef\.current\) return;\s*submittingRef\.current = true;\s*setSubmitting\(true\);\s*try \{/);
  assert.match(submit, /\} finally \{\s*submittingRef\.current = false;\s*setSubmitting\(false\);\s*\}/);
  assert.equal((submit.match(/fetch\('\/api\/apps'/g) || []).length, 1);
  const button = SRC.slice(SRC.indexOf('id="create-submit"'), SRC.indexOf('</Button>', SRC.indexOf('id="create-submit"')));
  // (and, on the approval step, until it is answered)
  assert.match(button, /disabled=\{quotaBlocksCreation \|\| submitting \|\| approvalMissing\}/);
  assert.match(button, /aria-busy=\{submitting \|\| undefined\}/, 'no aria-busy in the prerender');
  assert.match(button, /\{submitting \? <SpinnerArcIcon /);
  assert.match(button, /\(mode === 'import' \? 'Importing…' : 'Creating…'\)/);
  assert.match(SRC, /const \[submitting, setSubmitting\] = useState\(false\);/, 'starts idle, as prerendered');
});

test('the prerendered Create button is idle', () => {
  const html = shellMarkup();
  const submit = html.match(/<button[^>]*id="create-submit"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.doesNotMatch(submit, /aria-busy/);
  assert.doesNotMatch(submit, /<svg/);
  assert.match(submit, />Create<\/button>$/);
});
