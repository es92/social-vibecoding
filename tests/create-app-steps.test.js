// The create dialog is steps that UNFOLD in one card (#1911), not one page of
// every choice. Since the rework (drawn and agreed as a clickable mock first)
// it asks six questions, each a step of its own. "What are you making?" (App,
// with Document and Video dimmed) went when the dialog became the make
// screen's More options (tests/create-front-door.test.js), which asks it:
//
//   who      Just me, A private community, A public community
//   invite   a private community only: one row per person, a @username or an email
//   start    from scratch, from a template (its four starters open under its
//            row, #3521), or from a GitHub repo, whose check also reads its
//            dapp.json; collapses to the chosen row once the card moves on
//   details  the name, and for a project made here "What should it do?",
//            required of everyone and filed as the project's first request
//   about    a project made here only: the one-line "What is it?", required,
//            suggested from what it should do on arrival
//   approve  LAST, a private or a public community only: who approves changes
//
// Nothing is chosen for the person: every answer starts empty, pressing a
// row selects it, and Next (beside Cancel on every step) stays dimmed until
// the step is answered. `data-step` is the furthest step reached; every
// section ships on every step and app.css folds and unfolds them off
// #create-card[data-step] and [data-final]. This pins the component's
// wiring, the wire body, the repo notice, the CSS, the shot links and the
// checks at source level, and renders the dialog to prove the prerendered
// document starts on the first step with every id.
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

const mod = () => loadTsx('frontend/src/features/dialogs/create-app.tsx');

test('the steps a set of answers walks: five for Just me, six for a public community, seven for a private one, one fewer for an import', () => {
  const { stepsFor } = mod();
  assert.deepEqual([...stepsFor(null)], ['who', 'start', 'details', 'about'], 'unanswered counts as Just me, made here');
  assert.deepEqual([...stepsFor('solo')], ['who', 'start', 'details', 'about']);
  assert.deepEqual([...stepsFor('solo', 'new')], ['who', 'start', 'details', 'about']);
  assert.deepEqual([...stepsFor('solo', 'template')], ['who', 'start', 'details', 'about']);
  assert.deepEqual([...stepsFor('open')], ['who', 'start', 'details', 'about', 'approve']);
  assert.deepEqual([...stepsFor('invited')], ['who', 'invite', 'start', 'details', 'about', 'approve']);
  // An import is named and nothing more: its repo describes it.
  assert.deepEqual([...stepsFor('solo', 'import')], ['who', 'start', 'details']);
  assert.deepEqual([...stepsFor('open', 'import')], ['who', 'start', 'details', 'approve']);
  assert.deepEqual([...stepsFor('invited', 'import')], ['who', 'invite', 'start', 'details', 'approve']);
  assert.match(SRC, /const steps = stepsFor\(audience, mode\);/, 'the indicator and the footer read the mode too');
  // Every answer starts empty, and the step is the first.
  for (const [what, re] of [
    ['audience', /useState<Audience \| null>\(null\)/],
    ['start', /useState<Mode \| null>\(null\)/],
    ['approvers', /useState<Approvers \| null>\(null\)/],
    ['approvals', /useState<Approvals \| null>\(null\)/],
    ['people', /useState<Invitee\[\]>\(\[\]\)/],
    ['step', /useState<Step>\('who'\)/],
  ]) assert.match(SRC, re, what);
  // Every answer rides on the root AND the card: the kit lifts the card out
  // of the root while presented. Each is "" until answered.
  assert.match(SRC, /id="create-modal"\s+ref=\{dialog\.rootRef\}\s+\{\.\.\.answers\}/);
  assert.match(SRC, /id="create-card"\s+\{\.\.\.answers\}/);
  for (const attr of ['data-mode', 'data-import-state', 'data-step', 'data-audience', 'data-approvers',
    'data-approvals', 'data-final', 'data-repo-sets']) {
    assert.match(SRC, new RegExp(`'${attr}': `), attr);
  }
  assert.match(SRC, /'data-audience': audience \?\? ''/);
  assert.match(SRC, /'data-mode': mode \?\? ''/);
  // Close puts every answer back to empty.
  assert.match(SRC, /formRef\.current\?\.reset\(\);[\s\S]*?applyMode\(null\);\s*setAudience\(null\);\s*setPeople\(\[\]\);[\s\S]*?setStep\('who'\);\s*setApprovers\(null\);\s*setApprovals\(null\);/);
});

test('a row selects, and Next beside Cancel moves on once the step is answered', () => {
  const answered = SRC.slice(SRC.indexOf('function answered(which: Step)'), SRC.indexOf('const stepAnswered'));
  assert.match(answered, /case 'who': return audience != null;/);
  assert.match(answered, /case 'invite': return people\.length > 0;/);
  assert.doesNotMatch(SRC, /'kind'|setKind|chooseKind|data-kind/, 'no "What are you making?" step: the make screen asks it');
  // #3521: from a template is answered once a starter is picked.
  assert.match(answered, /case 'start': return mode != null && \(mode !== 'import' \|\| importState === 'ok'\) && \(mode !== 'template' \|\| template != null\);/);
  // The name, and what it should do (BRIEF_MIN or more) unless importing.
  assert.match(answered, /case 'details': return name\.trim\(\)\.length > 0 && \(importing \|\| brief\.trim\(\)\.length >= BRIEF_MIN\);/);
  assert.match(answered, /case 'about': return describe\.trim\(\)\.length > 0;/);
  // An import whose repo sets the rule is told so, not asked.
  assert.match(answered, /case 'approve': return repoGov != null \|\| \(approvers != null && \(approvers !== 'invited' \|\| approvals != null\)\);/);
  // On its own step a row only selects; a collapsed row reopens its step.
  assert.match(SRC, /function chooseAudience\(next: Audience\) \{\s*setError\(''\);\s*if \(step !== 'who'\) \{ setStep\('who'\); return; \}\s*setAudience\(next\);\s*\}/);
  // How to start collapses too, so its rows (and a picked starter) reopen it.
  assert.match(SRC, /function chooseStart\(next: Mode\) \{\s*setError\(''\);\s*if \(step !== 'start'\) \{ setStep\('start'\); return; \}/);
  assert.match(SRC, /function chooseTemplate\(next: TemplateId\) \{\s*setError\(''\);\s*if \(step !== 'start'\) \{ setStep\('start'\); return; \}\s*setTemplate\(next\);\s*\}/);
  // Next walks the list, and only when answered.
  const next = SRC.slice(SRC.indexOf('function next() {'), SRC.indexOf('/** One entry point'));
  assert.match(next, /if \(!stepAnswered\) \{/);
  assert.match(next, /const to = steps\[steps\.indexOf\(step\) \+ 1\];/);
  assert.match(next, /Give your project a name\./);
  assert.match(next, /Say what it should do, in a sentence or two\./);
  // Arriving at the one-line step suggests it.
  assert.match(next, /if \(to === 'about'\) void suggestDescription\(false\);/);
  // Both footer buttons wait for the answer.
  const footer = SRC.slice(SRC.indexOf('id="create-cancel"'));
  assert.ok(footer.indexOf('id="create-next"') > 0 && footer.indexOf('id="create-next"') < footer.indexOf('id="create-submit"'),
    'Cancel, then Next, then Create');
  assert.match(footer, /id="create-next"[\s\S]{0,200}disabled=\{quotaBlocksCreation \|\| !stepAnswered\}/);
  assert.match(footer, /id="create-submit"[\s\S]{0,220}disabled=\{quotaBlocksCreation \|\| submitting \|\| !stepAnswered\}/);
  // Enter before the last step advances; only the last step creates.
  assert.match(SRC, /if \(!isLast\) \{\s*next\(\);\s*return;\s*\}/);
  assert.doesNotMatch(SRC, /id="create-back"/, 'no Back: the earlier steps stay on screen');
});

test('the wire body: who it is for, the people and addresses, and what an import leaves to its repo', () => {
  const { createBody } = mod();
  const base = { name: 'Book club', mode: 'new', approvers: 'anyone', approvals: null };
  const ada = { kind: 'user', username: 'ada' };
  const sam = { kind: 'email', email: 'sam@example.com' };
  assert.deepEqual(createBody({ ...base, audience: 'solo', invitees: [ada] }),
    { name: 'Book club', audience: 'solo' }, 'Just me sends no invitees, whatever the rows hold');
  assert.deepEqual(createBody({ ...base, audience: 'invited', invitees: [ada, sam] }),
    { name: 'Book club', audience: 'invited', invitees: ['ada'], inviteEmails: ['sam@example.com'] });
  assert.deepEqual(createBody({ ...base, audience: 'open', approvers: 'invited', approvals: 'majority' }).governance,
    { approvers: 'invited', approvals: 'default' });
  assert.deepEqual(createBody({ ...base, audience: 'open', approvers: 'invited', approvals: 'atLeast', approvalsN: 3 }).governance,
    { approvers: 'invited', approvals: { atLeast: 3 } });
  assert.equal(createBody({ ...base, audience: 'open' }).governance, undefined, 'members vote sends nothing');
  assert.equal(createBody({ ...base, audience: 'open', description: '  Swap seeds \n and plan  ' }).description, 'Swap seeds and plan');
  assert.equal(createBody({ ...base, audience: 'open', description: '   ' }).description, undefined, 'blank sends nothing');
  // An import sends the line and the rule only where its dapp.json has none.
  const imp = { ...base, mode: 'import', repoUrl: 'https://github.com/o/r', audience: 'open', approvers: 'invited', approvals: 'majority', description: 'Ours' };
  assert.deepEqual(createBody({ ...imp, repo: {} }),
    { name: 'Book club', audience: 'open', repoUrl: 'https://github.com/o/r', description: 'Ours', governance: { approvers: 'invited', approvals: 'default' } });
  assert.deepEqual(createBody({ ...imp, repo: { description: 'Theirs', governance: { approvers: 'anyone', approvals: null } } }),
    { name: 'Book club', audience: 'open', repoUrl: 'https://github.com/o/r' });
  // #3521: a template is sent only from "Start from a template"; from
  // scratch sends none (the server's default is the empty starter), and a
  // starter left picked when the person switched to another way is dropped.
  assert.deepEqual(createBody({ ...base, mode: 'template', audience: 'solo', template: 'game-2d' }),
    { name: 'Book club', audience: 'solo', template: 'game-2d' });
  assert.equal(createBody({ ...base, audience: 'solo', template: 'game-2d' }).template, undefined);
  assert.equal(createBody({ ...imp, repo: {}, template: 'game-2d' }).template, undefined);
  assert.equal(createBody({ ...base, mode: 'template', audience: 'solo', template: null }).template, undefined);
  const submit = SRC.slice(SRC.indexOf('async function submit(event: FormEvent) {'), SRC.indexOf('  const stepIndex'));
  // Spread with the door it came through (routes/apps.js MAKE_ORIGINS:
  // the Create button's) and the device's time zone, so its idea is
  // sketched for the made screen it lands on, as Make it's is.
  assert.match(submit, /const timeZone = deviceTimeZone\(\);\s*const body = \{\s*\.\.\.createBody\(\{/);
  assert.match(submit, /from: 'create',\s*\.\.\.\(timeZone \? \{ timeZone \} : \{\}\),\s*\};/);
  // What it should do goes from everyone now, and an import, which never
  // showed the one-line step, sends no line from the dialog.
  assert.match(submit, /name: trimmed,\s*brief,\s*description,/);
  assert.doesNotMatch(SRC, /brief: botBuild \?/);
  assert.match(submit, /const description = importing \? '' : \(describeRef\.current\?\.value \|\| ''\);/);
  assert.match(submit, /if \(brief\.trim\(\)\.length < BRIEF_MIN\) return setError\('Say what it should do, in a sentence or two\.'\);/);
  assert.match(submit, /if \(!description\.trim\(\)\) return setError\('Say what it is in one line\.'\);/);
  assert.match(submit, /invitees: people,/);
  assert.match(submit, /repo,\s*template,\s*\}\),/);
  assert.match(submit, /await postCreateApp\(body\)/);
  // The request itself is shared with the make screen (post-create-app.ts).
  assert.match(read('frontend/src/features/dialogs/post-create-app.ts'), /body: JSON\.stringify\(body\)/);
});

test('an import names each answer its repo’s dapp.json replaces, and only answers given', () => {
  const { repoOverrides, repoRule } = mod();
  const answers = { name: 'Book club', description: 'Read together', audience: 'invited', approvers: 'anyone', approvals: null };
  const repo = {
    name: 'Book Club',
    description: 'Pick a book, read it together, talk about it.',
    visibility: { build: 'private', view: 'public' },
    governance: { approvers: 'invited', approvals: 2 },
  };
  const all = repoOverrides(repo, answers);
  assert.deepEqual(all.map((o) => o.key), ['name', 'desc', 'vis', 'gov']);
  assert.deepEqual(all.find((o) => o.key === 'gov'),
    { key: 'gov', label: 'Who approves changes', repo: 'People I pick, at least 2 yes', yours: 'Members vote' });
  assert.equal(all.find((o) => o.key === 'name').yours, 'Book club');
  assert.equal(all.find((o) => o.key === 'vis').repo,
    'Anyone can see it; only people invited can build. Code stays public on GitHub.');
  // Every repository is public on GitHub, so a line that keeps people out
  // says the code is not kept with it; a public one has nothing to add.
  assert.equal(repoOverrides({ visibility: { build: 'private', view: 'private' } }, { ...answers, audience: 'open' })[0].repo,
    'Private to the people invited. Code stays public on GitHub.');
  assert.equal(repoOverrides({ visibility: { build: 'public', view: 'public' } }, answers)[0].repo,
    'Anyone can find it, join and build');
  // The check comes before the name and the approval steps now: a blank
  // name, a blank line or a rule not chosen yet is nothing to replace.
  assert.deepEqual(repoOverrides(repo, { ...answers, name: '', description: '', approvers: null }).map((o) => o.key), ['vis']);
  // Only real differences.
  assert.deepEqual(repoOverrides({}, answers), [], 'a repo that sets nothing replaces nothing');
  assert.deepEqual(repoOverrides(null, answers), []);
  assert.deepEqual(repoOverrides({ visibility: { build: 'private', view: 'private' } }, answers), [],
    'a private repo does not clash with a private community');
  assert.equal(repoOverrides({ visibility: { build: 'private', view: 'private' } }, { ...answers, audience: 'open' }).length, 1);
  assert.deepEqual(repoOverrides({ name: 'Book club' }, answers), [], 'the same name is not a change');
  assert.deepEqual(repoOverrides({ governance: { approvers: 'invited', approvals: 2 } }, { ...answers, audience: 'solo' }), [],
    'Just me was never asked who approves');
  // The approval step says what the repo's rule is, in place of asking.
  assert.equal(repoRule(repo, 'open'), 'People I pick, at least 2 yes');
  assert.equal(repoRule(repo, 'solo'), null, 'Just me has no approval step');
  assert.equal(repoRule({}, 'open'), null);
  assert.equal(repoRule(null, 'open'), null);
  assert.match(SRC, /const repoGov = checked \? repoRule\(repo, audience\) : null;/);
  assert.match(SRC, /\{repoGov \? \(\s*<p className=\{CAPTION\} data-repo-rule="">\{`This repo’s dapp\.json already sets it: \$\{repoGov\}\.`\}<\/p>/);
  // The check fills the name step with the repo's own name, unless one was typed.
  const check = SRC.slice(SRC.indexOf('async function check() {'), SRC.indexOf('async function submit('));
  assert.match(check, /if \(repoName && !\(nameRef\.current\?\.value \|\| ''\)\.trim\(\)\) \{\s*if \(nameRef\.current\) nameRef\.current\.value = repoName;\s*setName\(repoName\);/);
  // The notice, and what the card says for app.css.
  assert.match(SRC, /This repo already sets some of this/);
  assert.match(SRC, /You chose: \$\{o\.yours\}/);
  assert.match(SRC, /Nothing in this repo’s dapp\.json changes your answers\. They’re written into it when it’s imported\./);
  assert.match(SRC, /Couldn’t read this repo’s dapp\.json\./);
  assert.match(SRC, /'data-repo-sets': repoSets\.join\(' '\)/);
  assert.match(SRC, /const repoSets = \[\.\.\.overrides\.map\(\(o\) => o\.key\), \.\.\.\(repoGov && !overrides\.some\(\(o\) => o\.key === 'gov'\) \? \['gov'\] : \[\]\)\];/);
  assert.match(SRC, /setRepo\(manifest && typeof manifest === 'object' \? manifest : \{\}\);\s*setRepoUnread\(manifest === null\);/);
});

test('who it is for says who can open it, and that its code is public on GitHub either way', () => {
  // createRepo (services/github.js) makes every repository public, and an
  // import must be public already, so "Only you can see it" was never true
  // of the code. The audience decides who can OPEN the project.
  const html = shellMarkup();
  const card = html.slice(html.indexOf('id="create-card"'), html.indexOf('id="rename-modal"'));
  const who = card.slice(card.indexOf('data-create-step="who"'), card.indexOf('data-create-step="invite"'));
  assert.match(who, />Just me<[\s\S]*?>Only you can open it\. Its code is public on GitHub\. Invite people or open it up later\.</);
  assert.match(who, />A private community<[\s\S]*?>Only you and the people you invite can open it\. Its code is public on GitHub\.</);
  assert.match(who, />A public community<[\s\S]*?>Anyone can find it, join and build\.</);
  assert.doesNotMatch(who, /Only you can see it|Private to you/, 'no caption says the project is hidden whole');
});

test('what it should do is asked of everyone, grows with its text, and says who builds from it', () => {
  const { briefCaption } = mod();
  assert.equal(briefCaption(true), 'Homeroom bot builds the first version from this.');
  assert.equal(briefCaption(false), 'This becomes the project’s first request.');
  const details = SRC.slice(SRC.indexOf('data-create-step="details"'), SRC.indexOf('data-create-step="about"'));
  assert.doesNotMatch(details, /\{botBuild \? \(/, 'not only for somebody the bot builds for');
  assert.match(details, /<label htmlFor="app-brief" className=\{LABEL\}>\s*What should it do\?\s*<\/label>/, 'a label that fits one line on a phone');
  assert.match(details, /id="app-brief"\s+ref=\{briefRef\}\s+name="brief"\s+rows=\{3\}\s+maxLength=\{BRIEF_MAX\}/);
  assert.match(details, /className=\{BRIEF_FIELD\}/);
  assert.match(SRC, /const BRIEF_FIELD = 'resize-none overflow-y-auto max-h-60 leading-\[22px\]';/, 'grows to a ceiling, then scrolls');
  assert.match(details, /\{briefCaption\(botBuild\)\}/, 'one caption under the field');
  // Measured only while its step shows: a folded field measures 0.
  assert.match(SRC, /const el = briefRef\.current;\s*if \(!el \|\| step !== 'details'\) return;\s*el\.style\.height = 'auto';\s*if \(el\.scrollHeight > 0\) el\.style\.height = `\$\{el\.scrollHeight\}px`;\s*\}, \[brief, step\]\);/);
});

test('the one-line description is a step of its own, suggested on arrival, and only re-suggested when it is still ours to change', () => {
  const { firstSentence, DESCRIPTION_MAX } = mod();
  const server = require('../src/services/homeroom-bot-dm');
  for (const text of [
    'A chore wheel for the house. It is fair.',
    'Who does the dishes this week! Fairly.',
    `A ${'very '.repeat(30)}long sentence with no stop`,
    '  spaced   out\n\nlines  ',
  ]) {
    assert.equal(firstSentence(text, DESCRIPTION_MAX), server.firstSentence(text, DESCRIPTION_MAX), 'the client falls back the way the server does');
  }
  const about = SRC.slice(SRC.indexOf('data-create-step="about"'), SRC.indexOf('data-create-step="approve"'));
  assert.match(about, /\$\{numberOf\('about'\)\}\. Short description/);
  assert.match(about, /id="app-description"/);
  assert.match(about, /What is it\?/);
  assert.doesNotMatch(about, /\(optional\)/, 'required now');
  assert.match(about, /\{suggesting \? 'Suggesting…' : \(suggestNote \|\| 'One line people see on its page and in Discover\.'\)\}/);
  assert.match(about, /onClick=\{\(\) => \{ void suggestDescription\(true\); \}\}[\s\S]{0,40}Suggest again/);
  assert.match(about, /suggestion\.current\.edited = value\.trim\(\) !== '';/, 'a line the person writes is theirs');
  const fn = SRC.slice(SRC.indexOf('async function suggestDescription(force: boolean) {'), SRC.indexOf('  const stepIndex'));
  assert.match(fn, /if \(!force && \(mine\.edited \|\| mine\.from === text\)\) return;/, 'only when it changed and is not theirs');
  assert.match(fn, /fetch\('\/api\/apps\/suggest-description', \{/);
  assert.match(fn, /line = \(line \|\| firstSentence\(text, DESCRIPTION_MAX\)\)\.slice\(0, DESCRIPTION_MAX\);/, 'the first sentence when no suggestion comes back');
  assert.match(fn, /if \(suggestion\.current\.seq !== seq\) return;/, 'a late answer is dropped');
  assert.match(fn, /if \(suggestion\.current\.edited\) return;/, 'a line typed while it was on its way wins');
});

test('the invite step: one row per person, suggestions from the user search, an email marked Will invite', () => {
  const rows = SRC.slice(SRC.indexOf('function InviteRows('), SRC.indexOf('/* ── The repo notice'));
  assert.match(SRC, /fetch\(`\/api\/users\/search\?scope=messages&q=\$\{encodeURIComponent\(q\)\}`/,
    'friends first, without you or anyone blocked');
  assert.match(rows, /id="create-invite-block"/);
  assert.match(rows, /id="create-invitees"/);
  assert.match(rows, /placeholder="@username or email"/);
  assert.match(rows, /Will invite/);
  assert.match(rows, /Add another person/);
  assert.match(rows, /No one on Homeroom is called @\$\{name\}\. Check the spelling, or invite them by email\./);
  assert.match(rows, /That email is already on the list\./);
  assert.match(rows, /onMouseDown=\{\(e\) => \{ e\.preventDefault\(\); add\(/, 'a pick lands before the blur folds the list');
  assert.match(rows, /disabled=\{full\}/, `no more than the server takes`);
  assert.match(SRC, /export const MAX_INVITEES = 20;/);
  // No focus is moved onto "Add another person" after adding somebody: that
  // drew a stray focus ring in the mock.
  assert.doesNotMatch(rows, /add[\s\S]{0,80}\.focus\(\)[\s\S]{0,40}create-invitee-add/);
  const { EMAIL_RE } = mod();
  assert.ok(EMAIL_RE.test('sam@example.com'));
  assert.ok(!EMAIL_RE.test('sam@example'));
  assert.ok(!EMAIL_RE.test('@sam'));
});

test('how to start: rows, straight after who it is for', () => {
  // No "What are you making?" step any more (App, with Document and Video
  // dimmed, saying Soon): the make screen asked it before More options.
  assert.doesNotMatch(SRC, /data-create-step="kind"|data-kind-pill|create-soon-row|What are you making\?`/);
  // How to start comes straight after who it is for, before the name.
  const order = ['who', 'invite', 'start', 'details', 'about', 'approve']
    .map((step) => SRC.indexOf(`data-create-step="${step}"`));
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'the sections in the order the steps unfold');
  const start = SRC.slice(SRC.indexOf('data-create-step="start"'), SRC.indexOf('data-create-step="details"'));
  assert.ok(start.indexOf('data-mode-pill="new"') < start.indexOf('data-mode-pill="template"')
    && start.indexOf('data-mode-pill="template"') < start.indexOf('data-mode-pill="import"')
    && start.indexOf('data-mode-pill="import"') < start.indexOf('id="create-import-block"'),
    'scratch, template, repo, then the repo check under them');
  assert.match(start, /Start from scratch/);
  assert.match(start, /Start from a template/);
  assert.match(start, /Import a GitHub repo/);
  // #3521: the template row is a choice now, not a dimmed Soon, and its
  // starters render under it only once it is chosen, so nothing about them
  // is in the prerendered document.
  assert.match(start, /data-mode-pill="template"\s+aria-pressed=\{mode === 'template'\}\s+className=\{CHOICE\}\s+onClick=\{\(\) => chooseStart\('template'\)\}/);
  assert.doesNotMatch(start, /data-mode-pill="template" aria-disabled/);
  assert.ok(start.indexOf('data-mode-pill="template"') < start.indexOf('id="create-template-block"')
    && start.indexOf('id="create-template-block"') < start.indexOf('data-mode-pill="import"'),
    'the starters open directly under their row');
  assert.match(start, /\{mode === 'template' \? \(\s*<div id="create-template-block"/);
  assert.match(start, /data-template-pill=\{choice\.key\}\s+aria-pressed=\{template === choice\.key\}/);
  // Each way to start says "Change" once the step has collapsed to it.
  assert.equal((start.match(/<span className=\{CHOICE_CHANGE\}>Change<\/span>/g) || []).length, 3);
  assert.match(SRC, /const \[template, setTemplate\] = useState<TemplateId \| null>\(null\);/, 'nothing picked on arrival');
  assert.match(SRC, /\{`\$\{numberOf\('start'\)\}\. How do you want to start\?`\}/);
  assert.match(SRC, />\s*A majority\s*</, '"Most of them" reads "A majority"');
  assert.doesNotMatch(SRC, /Most of them/);
});

test('app.css unfolds the steps in place, keeps each step to the answers it belongs to, and shapes the footer', () => {
  const rule = (sel) => new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  for (const sel of [
    '#create-card[data-step="who"]     :is([data-create-step="invite"], [data-create-step="start"], [data-create-step="details"], [data-create-step="about"], [data-create-step="approve"])',
    '#create-card[data-step="invite"]  :is([data-create-step="start"], [data-create-step="details"], [data-create-step="about"], [data-create-step="approve"])',
    '#create-card[data-step="start"]   :is([data-create-step="details"], [data-create-step="about"], [data-create-step="approve"])',
    '#create-card[data-step="details"] :is([data-create-step="about"], [data-create-step="approve"])',
    '#create-card[data-step="about"]   [data-create-step="approve"]',
    '#create-card:not([data-audience="invited"]) [data-create-step="invite"]',
    '#create-card:is([data-audience="solo"], [data-audience=""]) [data-create-step="approve"]',
    // An import is named and nothing more.
    '#create-card[data-mode="import"] :is([data-create-step="about"], .create-brief-row)',
    '#create-card[data-final="false"] #create-submit',
    '#create-card[data-final="true"]  #create-next',
    '#create-card:not([data-mode="import"]) .create-import-block { display: none; }',
  ]) assert.match(CSS, rule(sel), sel);
  assert.doesNotMatch(CSS, /\[data-step="start"\]\) #create-next \{\s*display: none/, 'Next is never hidden on a question step now');
  // A question step collapses to its chosen row once the card moves past it.
  assert.match(CSS, rule('#create-card:not([data-step="who"])[data-audience="invited"] .create-who-pill:not([data-audience-pill="invited"])'));
  assert.doesNotMatch(CSS, /data-step="kind"|data-create-step="kind"|create-kind-|create-soon-row/, 'no rule left for the step that went');
  assert.match(CSS, rule('#create-card:not([data-step="who"]) [data-create-step="who"] :is(.create-choice-marker, .create-choice-caption)'));
  // How to start does too, keeping a picked starter and the repo's check.
  assert.match(CSS, rule('#create-card:is([data-step="details"], [data-step="about"], [data-step="approve"])[data-mode="import"]   .create-mode-pill:not([data-mode-pill="import"])'));
  assert.match(CSS, rule('#create-card:is([data-step="details"], [data-step="about"], [data-step="approve"]) [data-create-step="start"] :is(.create-choice-caption, .create-template-pill:not([aria-pressed="true"]), .create-import-hint)'));
  assert.match(CSS, rule('#create-card:is([data-step="who"], [data-step="invite"], [data-step="start"]) [data-create-step="start"] .create-choice-change'));
  // What an import's dapp.json decides is dimmed and tagged. The name comes
  // after the check and opens on the repo's own, so it is only ever tagged.
  assert.match(CSS, rule('#create-card[data-mode="import"][data-repo-sets~="gov"]  #create-approve-block'));
  assert.match(CSS, rule('#create-card[data-mode="import"][data-repo-sets~="vis"]  [data-repo-tag="vis"]'));
  assert.match(CSS, rule('#create-card[data-mode="import"][data-repo-sets~="name"] [data-repo-tag="details"]'));
  assert.doesNotMatch(CSS, /\[data-repo-sets~="name"\] \.create-name-row/, 'a name typed over the repo\'s is never made unclickable');
});

test('#24 (D8): a question\'s rows end in a selection marker, not a chevron, because pressing one only selects it', () => {
  // The behaviour is select-then-Next, unchanged: the handlers above only
  // set the answer. What changed is the mark at each row's edge.
  const who = SRC.slice(SRC.indexOf('data-create-step="who"'), SRC.indexOf('data-create-step="invite"'));
  assert.match(who, /<ChoiceMarker chosen=\{audience === choice\.key\} \/>\s*<span className=\{CHOICE_CHANGE\}>Change<\/span>/);
  assert.doesNotMatch(SRC, /ChevronRightIcon|create-choice-chevron/, 'no chevron left on a row that only selects');
  // The marker is a ring, and the chosen row's carries the shell's own check
  // (an existing glyph, not one drawn here).
  assert.match(SRC, /import \{[^}]*\bCheckIcon\b[^}]*\} from '@\/components\/ui\/icons';/);
  const marker = SRC.slice(SRC.indexOf('function ChoiceMarker('), SRC.indexOf('/* The small numbered heading'));
  assert.match(marker, /<span className=\{CHOICE_MARKER\} aria-hidden="true">\s*\{chosen \? <CheckIcon className="h-3\.5 w-3\.5" strokeWidth="3" \/> : null\}/);
  assert.doesNotMatch(marker, /<svg|<path/, 'no hand-drawn glyph');
  assert.match(SRC, /const CHOICE_MARKER = 'create-choice-marker [^']*rounded-full ring-\[1\.5px\] ring-inset ring-current[^']*';/);
  // The chosen ring fills with the row's ink and its check takes the accent.
  assert.match(CSS, /#create-card \.create-who-pill\[aria-pressed="true"\] > \.create-choice-marker \{\s*background-color: currentColor;\s*opacity: 1;\s*\}/);
  assert.match(CSS, /#create-card \.create-who-pill\[aria-pressed="true"\] > \.create-choice-marker > svg \{\s*color: #0a6ee0;/);
  // And in the prerendered document: three rows with a marker (the three
  // audiences), none chosen yet, and no chevron among them.
  const html = shellMarkup();
  const card = html.slice(html.indexOf('id="create-card"'), html.indexOf('id="rename-modal"'));
  const rows = card.slice(card.indexOf('data-create-step="who"'), card.indexOf('data-create-step="start"'));
  assert.equal((rows.match(/class="create-choice-marker /g) || []).length, 3, 'every who row has the marker');
  assert.ok(!rows.includes('d="M9 5l7 7-7 7"'), 'and none draws the chevron');
  assert.ok(!rows.includes('d="M5 13l4 4L19 7"'), 'nothing is chosen on arrival, so no check yet');
});

test('every selected choice wears the Create button\'s accent, the moment it is pressed', () => {
  const fill = CSS.slice(CSS.indexOf('#create-card[data-audience="solo"]      .create-who-pill[data-audience-pill="solo"],'));
  const block = fill.slice(0, fill.indexOf('}') + 1);
  for (const sel of ['.create-who-pill[data-audience-pill="open"]',
    '.create-mode-pill[data-mode-pill="import"]', '.create-approver-pill[data-approver-pill="invited"]',
    '.create-approvals-pill[data-approvals-pill="atLeast"]']) {
    assert.ok(block.includes(sel), sel);
  }
  assert.match(block, /background: #0a6ee0;/);
  assert.doesNotMatch(block, /:not\(\[data-step="who"\]\)/, 'a row fills on its own step now');
});

test('the shot links land on the state they name, and each has a check', () => {
  assert.match(SRC, /if \(shot === 'create-group'\) return \{ \.\.\.open, step: 'invite', audience: 'invited' \};/);
  assert.match(SRC, /if \(shot === 'create-start'\) return \{ \.\.\.open, step: 'start', audience: 'open' \};/);
  assert.match(SRC, /if \(shot === 'create-template'\) return \{ \.\.\.open, step: 'start', audience: 'solo', mode: 'template' \};/);
  assert.match(SRC, /if \(shot === 'create-import'\) return \{ \.\.\.open, step: 'start', audience: 'solo', mode: 'import' \};/);
  assert.match(SRC, /if \(shot === 'create-details'\) return \{ \.\.\.open, step: 'details', audience: 'solo', mode: 'new' \};/);
  assert.match(SRC, /if \(shot === 'create-about'\) return \{ \.\.\.described, step: 'about', audience: 'solo' \};/);
  assert.match(SRC, /if \(shot === 'create-approve' \|\| shot === 'create-access'\) return \{ \.\.\.described, step: 'approve', audience: 'open' \};/);
  const byPath = new Map(DAPP.tests.map((t) => [t.path, t]));
  // The dialog is the make screen's More options now, and #create/options
  // is its address (#create opens the make screen).
  const first = DAPP.tests.find((t) => t.path === '/#create/options' && /Step 1 of 4/.test(t.expectText || ''));
  assert.ok(first, 'a check reads the step count on a cold open');
  // Nothing chosen to start from either (#748's first-step check, folded in
  // when #create became the make screen's address).
  assert.match(first.expectSelector, /\[data-step="who"\]\[data-audience=""\]\[data-mode=""\]:has\(#create-cancel \+ #create-next:disabled\)/);
  const details = byPath.get('/?shot=create-details#create/options');
  assert.match(details.expectSelector, /\[data-step="details"\]\[data-mode="new"\]:has\(#create-next:disabled\) #create-name-block/);
  assert.match(details.expectSelector, /\.create-brief-row #app-brief$/);
  assert.equal(details.expectText, 'What should it do?');
  const approve = byPath.get('/?shot=create-approve#create/options');
  assert.match(approve.expectSelector, /\[data-step="approve"\]\[data-audience="open"\]\[data-final="true"\] #create-approve-block/, 'the last step for a public community');
  assert.equal(approve.expectText, 'Who approves changes?');
  const group = byPath.get('/?shot=create-group#create/options');
  assert.match(group.expectSelector, /\[data-step="invite"\] \[data-create-step="invite"\] #create-invite-block #create-invitees/);
  assert.equal(group.expectText, 'Who do you want to invite?');
  const imp = byPath.get('/?shot=create-import#create/options');
  assert.match(imp.expectSelector, /\[data-mode-pill="new"\] \+ \[data-mode-pill="template"\] \+ \[data-mode-pill="import"\] \+ #create-import-block/);
  assert.equal(byPath.get('/?shot=create-access#create/options'), undefined, 'the retired step has no check left');
  const tpl = byPath.get('/?shot=create-template#create/options');
  assert.match(tpl.expectSelector, /\[data-mode="template"\]:has\(#create-next:disabled\) \[data-mode-pill="template"\]\[aria-pressed="true"\] \+ #create-template-block/,
    'how to start is not the last step any more: Next waits for a starter');
  assert.equal(tpl.expectText, 'Multimedia social');
  for (const t of [first, details, approve, group, imp, tpl]) {
    assert.ok(t.expectSelector.length <= 256, `the platform reads at most 256 characters of a selector: ${t.name}`);
  }
});

test('the prerendered document starts on the first step, nothing chosen, with every id in place', () => {
  const html = shellMarkup();
  const card = html.slice(html.indexOf('id="create-card"'), html.indexOf('id="rename-modal"'));
  assert.match(card, /data-step="who"/);
  assert.match(card, /data-audience=""/);
  assert.match(card, /data-mode=""/);
  assert.match(card, /data-final="false"/);
  const order = ['who', 'invite', 'start', 'details', 'about', 'approve'];
  for (const step of order) {
    assert.match(card, new RegExp(`data-create-step="${step}"`), step);
  }
  const at = order.map((step) => card.indexOf(`data-create-step="${step}"`));
  assert.deepEqual([...at].sort((x, y) => x - y), at, 'in the order they unfold');
  assert.match(card, /Step 1 of 4/);
  for (const id of ['create-step-indicator', 'create-invite-block', 'create-invitees', 'create-import-block',
    'create-name-block', 'create-approve-block', 'create-approvals-n', 'create-cancel', 'create-next',
    'create-submit', 'import-url', 'app-name', 'app-brief', 'app-description']) {
    assert.match(card, new RegExp(`id="${id}"`), id);
  }
  assert.match(card, /<button[^>]*id="create-next"[^>]*disabled=""/, 'Next is dimmed until the first answer');
  assert.match(card, />New project</);
  // "What should it do?" ships for everyone, empty, with the caption for
  // somebody the bot does not build for (the open decides the other).
  assert.match(card, /<textarea id="app-brief" name="brief" rows="3"[^>]*><\/textarea>/);
  assert.match(card, />This becomes the project’s first request\.</);
  assert.doesNotMatch(card, /<textarea[^>]*style=/, 'its height is measured after mount, never prerendered');
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
  assert.ok(guard < submit.indexOf('await postCreateApp(body)'), 'claimed before the request');
  assert.match(submit, /if \(submittingRef\.current\) return;\s*submittingRef\.current = true;\s*setSubmitting\(true\);\s*try \{/);
  assert.match(submit, /\} finally \{\s*submittingRef\.current = false;\s*setSubmitting\(false\);\s*\}/);
  assert.equal((submit.match(/postCreateApp\(/g) || []).length, 1);
  // The one request is post-create-app.ts's, shared with the make screen;
  // neither screen fetches the route itself.
  assert.equal((SRC.match(/fetch\('\/api\/apps'/g) || []).length, 0);
  assert.equal((read('frontend/src/features/dialogs/post-create-app.ts').match(/fetch\('\/api\/apps'/g) || []).length, 1);
  const button = SRC.slice(SRC.indexOf('id="create-submit"'), SRC.indexOf('</Button>', SRC.indexOf('id="create-submit"')));
  assert.match(button, /aria-busy=\{submitting \|\| undefined\}/, 'no aria-busy in the prerender');
  assert.match(button, /\{submitting \? <SpinnerArcIcon /);
  assert.match(button, /\(importing \? 'Importing…' : 'Creating…'\)/);
  assert.match(SRC, /const \[submitting, setSubmitting\] = useState\(false\);/, 'starts idle, as prerendered');
});

test('the prerendered Create button is idle', () => {
  const html = shellMarkup();
  const submit = html.match(/<button[^>]*id="create-submit"[^>]*>[\s\S]*?<\/button>/)[0];
  assert.doesNotMatch(submit, /aria-busy/);
  assert.doesNotMatch(submit, /<svg/);
  assert.match(submit, />Create<\/button>$/);
});

// A failed create says which failure it was. An error page in front of the
// server (a deploy, a proxy) is not JSON; before, the throw from res.json()
// landed in the catch meant for a dropped connection and read "Network error".
test('a failed create tells a network error from a server error page', async () => {
  const { postCreateApp } = mod();
  const real = globalThis.fetch;
  const reply = (status, text, type = 'application/json') =>
    async () => new Response(text, { status, headers: { 'Content-Type': type } });
  try {
    globalThis.fetch = reply(502, '<html><body>Bad Gateway</body></html>', 'text/html');
    assert.deepEqual(await postCreateApp({ name: 'x' }),
      { ok: false, error: 'Homeroom couldn’t create the project (502). Try again in a moment.' });

    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    assert.deepEqual(await postCreateApp({ name: 'x' }), { ok: false, error: 'Network error. Try again.' });

    globalThis.fetch = reply(409, JSON.stringify({ error: 'You already have a project called x.' }));
    assert.deepEqual(await postCreateApp({ name: 'x' }), { ok: false, error: 'You already have a project called x.' });

    globalThis.fetch = reply(500, JSON.stringify({}));
    assert.match((await postCreateApp({ name: 'x' })).error, /couldn’t create the project \(500\)/, 'JSON with no error text names the status');

    let sent;
    globalThis.fetch = async (url, init) => {
      sent = { url, method: init.method, body: init.body };
      return new Response(JSON.stringify({ app: { slug: 'x-1', name: 'x' } }), { status: 201 });
    };
    assert.deepEqual(await postCreateApp({ name: 'x' }), { ok: true, data: { app: { slug: 'x-1', name: 'x' } } });
    assert.deepEqual(sent, { url: '/api/apps', method: 'POST', body: '{"name":"x"}' });
  } finally {
    globalThis.fetch = real;
  }
  const submit = SRC.slice(SRC.indexOf('async function submit(event: FormEvent) {'), SRC.indexOf('  const stepIndex'));
  assert.match(submit, /if \(!reply\.ok\) return setError\(reply\.error\);/);
  assert.doesNotMatch(submit, /Network error/, 'only postCreateApp decides it was the network');
});
