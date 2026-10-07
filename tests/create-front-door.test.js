'use strict';

// One front door for a new project. The Create button used to open the New
// project dialog (frontend/src/features/dialogs/create-app.tsx), seven steps
// ending on a progress view, while the first session asked "What do you want
// to make?" (frontend/src/features/first-session/make.tsx) and ended on the
// made screen (./made.tsx): two journeys to the same POST /api/apps. Now
// Create opens the make screen too, the dialog is its More options, and every
// project made from a description lands on the made screen. Pins the doors,
// the hand-offs between the two screens, what each door answers, and the
// server's sketch for both.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderComponent, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const ISLAND = `${DIR}/index.tsx`;
const DIALOG = 'frontend/src/features/dialogs/create-app.tsx';

async function withGlobals(globals, fn) {
  const prior = {};
  for (const key of Object.keys(globals)) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value: globals[key], configurable: true, writable: true });
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(globals)) {
      if (prior[key]) Object.defineProperty(globalThis, key, prior[key]);
      else delete globalThis[key];
    }
  }
}

/** App.showCreateModal and App.showCreateOptions, as public/js/app.js defines them. */
function createMethods(window) {
  const src = read('public/js/app.js');
  const start = src.indexOf('  showCreateModal() {');
  const last = src.indexOf('  showCreateOptions(draft) {');
  assert.ok(start > 0 && last > start, 'both entry points are on App');
  const end = src.indexOf('\n  },\n', last) + '\n  },\n'.length;
  const ctx = { window };
  vm.runInNewContext(`App = ({\n${src.slice(start, end)}\n});`, ctx);
  return ctx.App;
}

test('Create opens the make screen, and the New project dialog only when that cannot open', () => {
  const calls = [];
  const window = {
    UsernodeReact: {
      firstSession: { create: () => { calls.push('make'); return true; } },
      dialogs: { create: { open: (draft) => calls.push(['dialog', draft]) } },
    },
  };
  const App = createMethods(window);
  App.showCreateModal();
  assert.deepEqual(calls, ['make'], 'the one front door');

  // Another of the island's screens holds the view: the dialog, as before.
  calls.length = 0;
  window.UsernodeReact.firstSession.create = () => { calls.push('make'); return false; };
  App.showCreateModal();
  assert.deepEqual(calls, ['make', ['dialog', undefined]]);

  // Not mounted yet: the dialog.
  calls.length = 0;
  delete window.UsernodeReact.firstSession;
  App.showCreateModal();
  assert.deepEqual(calls, [['dialog', undefined]]);

  // More options carries what was typed.
  calls.length = 0;
  App.showCreateOptions({ name: 'Page Turners', brief: 'A book club that reads one book a month' });
  assert.deepEqual(calls, [['dialog', { name: 'Page Turners', brief: 'A book club that reads one book a month' }]]);
});

test('#create opens the make screen and #create/options the dialog; the dialog\'s checks moved with it', () => {
  const route = read('public/js/app.js');
  assert.match(route, /if \(parts\[1\] === 'options'\) App\.showCreateOptions\(\);\s+else App\.showCreateModal\(\);/);
  const dapp = JSON.parse(read('dapp.json'));
  // Every check of the dialog's steps opens it at its own address.
  const dialogChecks = dapp.tests.filter((t) => /#create-card|#create-app-quota/.test(t.expectSelector || ''));
  assert.ok(dialogChecks.length >= 7);
  for (const t of dialogChecks) assert.match(t.path, /#create\/options$/, t.name);
  // And #create is checked as the make screen, from Create.
  const front = dapp.tests.find((t) => t.path === '/#create');
  assert.ok(front, 'a check opens #create');
  assert.match(front.expectSelector, /\[data-first-session-make\]\[data-make-entry="create"\]/);
  assert.match(front.expectSelector, /\[data-make-close\]/);
  assert.match(front.expectSelector, /\[data-make-more-options\]$/);
  assert.equal(front.expectText, 'What do you want to make?');
  assert.ok(front.expectSelector.length <= 256, 'the platform reads at most 256 characters of a selector');
});

test('the island opens the Create door over nothing else, and reads the allowance again', async () => {
  const island = loadTsx(ISLAND);
  const fetches = [];
  await withGlobals({
    window: { App: { user: { id: 3, username: 'sam' } } },
    fetch: async (url) => { fetches.push(url); return { ok: true, json: async () => ({}) }; },
  }, async () => {
    let state = { kind: 'none' };
    const setMode = (fn) => { state = typeof fn === 'function' ? fn(state) : fn; };
    assert.equal(island.openCreate(setMode), true);
    assert.deepEqual(state, { kind: 'make', entry: 'create' });
    assert.ok(fetches.length >= 1, 'the allowance is read again, as the dialog did on open');
    // Something already up stays; App.showCreateModal falls back to the dialog.
    state = { kind: 'tour', info: { slug: 'x', name: 'X' }, path: 'maker' };
    assert.equal(island.openCreate(setMode), false);
    assert.equal(state.kind, 'tour');
  });
  const src = read(ISLAND);
  assert.match(src, /create\(\): boolean \{\s+return openCreate\(setMode\);\s+\},/);
  // The dialog's hand-off: the made screen, from the Create door.
  assert.match(src, /made\(made: Made\): boolean \{\s+if \(!made \|\| !made\.slug\) return false;\s+setMode\(\{ kind: 'made', made, entry: 'create' \}\);\s+return true;\s+\},/);
});

test('from Create: nothing is answered, the grid is refreshed, More options carries the draft, and it ends on the hub', () => {
  const src = read(ISLAND);
  const door = src.slice(src.indexOf("if (mode.kind === 'make' && mode.entry === 'create') {"), src.indexOf("if (mode.kind === 'make') {"));
  assert.match(door, /entry="create"/);
  assert.match(door, /legacy\(\)\.Home\?\.load\?\.\(\);\s+void invalidateAppAllowance\(\);\s+setMode\(\{ kind: 'made', made, entry: 'create' \}\);/);
  assert.doesNotMatch(door, /noteAnswered|recordLookAround|onLookAround/);
  assert.match(door, /onClose=\{\(\) => leaveDoor\(false\)\}/);
  assert.match(door, /onMoreOptions=\{\(draft\) => \{\s+leaveDoor\(true\);\s+legacy\(\)\.UsernodeReact\?\.dialogs\?\.create\?\.open\?\.\(draft\);\s+\}\}/);
  // The made screen's way on: the hub from Create, the tour on the first session.
  const made = src.slice(src.indexOf("if (mode.kind === 'made') {"), src.indexOf("if (mode.kind === 'welcome') {"));
  assert.match(made, /if \(fromCreate\) \{\s+leaveDoor\(true\);\s+enterScreen\('hub', made\.slug\);\s+return;\s+\}\s+enterScreen\('home', made\.slug\);\s+setMode\(\{ kind: 'tour', info, path: 'maker' \}\);/);
  assert.match(made, /onSetSecrets=\{\(\) => \{\s+leaveDoor\(true\);\s+legacy\(\)\.Secrets\?\.open\?\.\(made\.slug\);\s+\}\}/);
  assert.match(made, /if \(fromCreate\) leaveDoor\(true\);\s+enterScreen\('bot', made\.slug, conversationId\);/);
});

test('Create\'s screens own the back press, as the dialog did, and hand it back on the way somewhere', () => {
  const src = read(ISLAND);
  assert.match(src, /import \{ pushDismissible, type Release \} from '\.\.\/\.\.\/lib\/back-stack';/);
  assert.match(src, /const createDoor = \(mode\.kind === 'make' \|\| mode\.kind === 'made'\) && mode\.entry === 'create';/);
  // Held across Make it: the effect keys on being at the door, not on which screen.
  assert.match(src, /const release = pushDismissible\(\(\) => \{\s+doorBack\.current = null;/);
  assert.match(src, /\}, \[createDoor\]\);/);
  // A way out that goes somewhere releases as navigating (QA 2026-09-24 Q16).
  assert.match(src, /release\?\.\(navigating \? \{ navigating: true \} : undefined\);\s+setMode\(\{ kind: 'none' \}\);/);
});

test('the make screen from Create: New project, a close, More options, and no "Look around first"', () => {
  const create = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', {
    who: 'Jordan', entry: 'create', onMade() {}, onClose() {}, onMoreOptions() {},
  });
  assert.match(create, /data-make-entry="create"/);
  assert.match(create, />New project</);
  assert.doesNotMatch(create, /Hi Jordan!/);
  assert.match(create, /<button type="button" data-make-close="" aria-label="Close"/);
  assert.match(create, /data-make-more-options=""[^>]*>More options<\/button>/);
  assert.match(create, /Just for you, public, a template or a GitHub repo\? /);
  assert.doesNotMatch(create, /Look around first/);
  // The same questions and examples as the first session's.
  for (const words of ['What do you want to make?', 'What should it do?', 'What should we call it?', '>Make it</button>']) {
    assert.ok(create.includes(words), words);
  }
  assert.match(create, /data-first-session-example="run"/);

  const first = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', onMade() {}, onLookAround() {} });
  assert.match(first, /data-make-entry="first-session"/);
  assert.match(first, />Hi Jordan!</);
  assert.match(first, /Look around first/);
  assert.doesNotMatch(first, /data-make-close|data-make-more-options|More options/);

  const make = loadTsx(`${DIR}/make.tsx`);
  assert.equal(make.makeEyebrow('create', 'Jordan'), 'New project');
  assert.equal(make.makeEyebrow('first-session', ''), 'You\'re in!');
  // Who builds the first version, said truly (GET /api/auth/me homeroomBotDm).
  assert.match(make.makeLine(true), /Homeroom bot builds the first version while you invite your people\.$/);
  assert.match(make.makeLine(false), /It becomes the project’s first request while you invite your people\.$/);
  for (const line of [make.makeLine(true), make.makeLine(false), make.MORE_OPTIONS_LINE]) assert.doesNotMatch(line, /—/);
  const { viewerBotBuilds } = loadTsx(ISLAND);
  assert.equal(viewerBotBuilds({ homeroomBotDm: false }), false);
  assert.equal(viewerBotBuilds({ homeroomBotDm: true }), true);
  assert.equal(viewerBotBuilds({}), true, 'a snapshot from before the field reads as it always did');

  // More options takes what was typed; Escape closes it from Create.
  const src = read(`${DIR}/make.tsx`);
  assert.match(src, /onClick=\{\(\) => onMoreOptions\?\.\(\{ name: name\.trim\(\), brief: brief\.trim\(\) \}\)\}/);
  assert.match(src, /if \(e\.key === 'Escape'\) onClose\(\);/);
  // One request at a time, as the dialog's Create (QA 2026-09-24 Q5).
  assert.match(src, /if \(busy \|\| makingRef\.current\) return;/);
  assert.match(src, /makingRef\.current = true;\s+setBusy\(true\);/);
  assert.match(src, /\} finally \{\s+makingRef\.current = false;\s+setBusy\(false\);\s+\}/);
});

test('the made screen from Create goes to the project, and Just me has nobody to invite', () => {
  const made = loadTsx(`${DIR}/made.tsx`);
  assert.equal(made.continueLabel('create', false, 'Page Turners'), 'Invite people later');
  assert.equal(made.continueLabel('create', true, 'Page Turners'), 'Go to Page Turners');
  assert.equal(made.continueLabel('create', false, 'Page Turners', true), 'Go to Page Turners');
  const src = read(`${DIR}/made.tsx`);
  assert.match(src, /const solo = made\.audience === 'solo';/);
  assert.match(src, /\{solo \? null : \(\s+<div className="mt-6">\s+<p className="text-\[17px\] font-semibold">\{`Invite people to \$\{made\.name\}`\}<\/p>/);
  assert.match(src, /data-make-entry=\{entry\}/);
});

test('a setup that stopped says so on the made screen, with Try again or Set secrets, as the progress view did', () => {
  const made = loadTsx(`${DIR}/made.tsx`);
  assert.equal(made.stalledOf('error'), 'failed');
  assert.equal(made.stalledOf('awaiting_secrets'), 'needs-secrets');
  assert.equal(made.stalledOf('creating'), null);
  assert.equal(made.stalledOf('running'), null);
  // Before any step: a first version recorded for a project that never ran is not under way.
  assert.equal(made.buildLine({ step: 2, of: 7, stepName: 'Read the description' }, 'error'), 'Setting it up didn’t finish.');
  assert.equal(made.buildLine(null, 'awaiting_secrets'), 'It needs its secrets before it can start.');
  assert.equal(made.buildNote(true, false, 'failed'), 'Trying again usually clears it. If it stops again, ask an admin.');
  assert.equal(made.buildNote(true, true, 'needs-secrets'), 'Set them, and it finishes starting.');
  assert.equal(made.buildNote(true, false), made.buildNote(true, false, null), 'unchanged while nothing stopped');

  let retried = 0;
  let secrets = 0;
  const failed = renderToHtml(createElement(made.SetupStoppedCard, {
    stalled: 'failed', busy: false, onRetry() { retried += 1; }, onSetSecrets() { secrets += 1; },
  }));
  assert.match(failed, /data-made-stalled="failed"/);
  assert.match(failed, />Needs you</);
  assert.match(failed, />Setup stopped before it was running</);
  assert.match(failed, /data-made-stalled-action=""[^>]*>Try again<\/button>/);
  const waiting = renderToHtml(createElement(made.SetupStoppedCard, {
    stalled: 'needs-secrets', busy: false, onRetry() {}, onSetSecrets() {},
  }));
  assert.match(waiting, />It needs secrets to start</);
  assert.match(waiting, />Set secrets<\/button>/);
  assert.equal(retried + secrets, 0, 'drawing presses nothing');
  for (const words of [made.buildLine(null, 'error'), made.buildNote(true, false, 'failed'), made.buildNote(true, false, 'needs-secrets')]) {
    assert.doesNotMatch(words, /—/);
  }

  const src = read(`${DIR}/made.tsx`);
  // The same retry route the progress view pressed.
  assert.match(src, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(made\.slug\)\}\/retry`, \{ method: 'POST', credentials: 'same-origin' \}\)/);
  assert.match(src, /if \(res\.ok\) setAppStatus\('creating'\);/);
  // And the plan's card is not drawn over it.
  assert.match(src, /\{plan && !stalled \? <PlanWaitsCard/);
});

test('the dialog is More options: it opens on the make screen\'s draft, and hands a project made from a description to the made screen', () => {
  const { madeHandOff } = loadTsx(DIALOG);
  const base = { slug: 'seed-swap-1', name: 'Seed swap', description: '  Swap  spare seeds ', conversationId: 4, audience: 'open' };
  assert.deepEqual(madeHandOff({ ...base, mode: 'new' }), {
    slug: 'seed-swap-1', name: 'Seed swap', emoji: null, description: 'Swap spare seeds', example: null, conversationId: 4, audience: 'open',
  });
  assert.equal(madeHandOff({ ...base, mode: 'template' }).slug, 'seed-swap-1', 'a template is made from a description too');
  assert.equal(madeHandOff({ ...base, mode: 'template', audience: 'solo' }).audience, 'solo');
  assert.equal(madeHandOff({ ...base, mode: 'import' }), null, 'an import keeps the progress view');
  assert.equal(madeHandOff({ ...base, mode: 'new', slug: null }), null, 'nothing to follow');
  assert.equal(madeHandOff({ ...base, mode: 'new', description: ' ' }).description, null);

  const src = read(DIALOG);
  // The draft fills the name and what it should do; a shot link still lands where it says.
  assert.match(src, /useDialog<\{ name\?: string; brief\?: string \}>\('create', \{\s+onOpen: \(draft\) => \{/);
  assert.match(src, /name: typeof draft\?\.name === 'string' && draft\.name\.trim\(\) \? draft\.name\.trim\(\) : shot\.name,/);
  assert.match(src, /brief: typeof draft\?\.brief === 'string' && draft\.brief\.trim\(\) \? draft\.brief\.trim\(\) : shot\.brief,/);
  // A carried-in brief has no line suggested from it yet: the one-line step suggests one on arrival.
  assert.match(src, /suggestion\.current = \{ from: initial\.description \? initial\.brief\.trim\(\) : '', edited: false, seq: suggestion\.current\.seq \+ 1 \};/);
  // The hand-off comes before the dialog's own ping ask: the made screen asks.
  const submit = src.slice(src.indexOf('async function submit(event: FormEvent) {'), src.indexOf('  async function suggestDescription('));
  const handOff = submit.indexOf('front.made(handOff)');
  assert.ok(handOff > 0);
  assert.ok(handOff < submit.indexOf('askForPingWhileBotBuilds();'), 'the made screen asks for the ping itself');
  // The made screen claims the back press, so the dialog's record is not spent under it (#3683).
  assert.match(submit, /if \(handOff && typeof front\?\.made === 'function' && front\.made\(handOff\)\) \{\s+dialog\.closeForNavigation\(\);/);
  // The made screen asks for the ping for a project the bot builds.
  assert.match(read(`${DIR}/made.tsx`), /useEffect\(\(\) => \{ if \(botBuilds\) askForPingWhileBotBuilds\(\); \}, \[botBuilds\]\);/);
});

test('the server sketches the idea for both doors, and only the first session answers the join screen and counts in the Journey', () => {
  const src = read('src/routes/apps.js');
  assert.match(src, /const MAKE_ORIGINS = new Set\(\['first-session', 'create'\]\);/);
  assert.match(src, /if \(MAKE_ORIGINS\.has\(req\.body\.from\) && !repoUrlNormalized\s+&& require\('\.\.\/services\/homeroom-bot-dm'\)\.normalizeBrief\(req\.body\.brief\)\) \{/);
  assert.match(src, /\.\.\.\(MAKE_ORIGINS\.has\(req\.body\.from\) \? \{ from: req\.body\.from \} : \{\}\),/);
  // Answering the join screen stays the first session's.
  assert.match(src, /if \(req\.body\.from === 'first-session'\) \{\s+await require\('\.\.\/services\/first-session'\)\.answerJoinScreenByMaking/);
  // The Journey counts the first session by equality, so 'create' is not counted there.
  const journey = read('src/services/journey.js');
  assert.match(journey, /e\.metadata->>'from' = 'first-session'/);
  assert.doesNotMatch(journey, /metadata->>'from' (?:IN|<>|!=)/);
});
