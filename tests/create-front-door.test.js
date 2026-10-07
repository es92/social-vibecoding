'use strict';

// One front door for a new project. The Create button used to open the New
// project dialog, seven steps ending on a progress view, while the first
// session asked "What do you want to make?"
// (frontend/src/features/first-session/make.tsx) and ended on the made
// screen (./made.tsx): two journeys to the same POST /api/apps. Now Create
// opens the make screen for everyone, and the dialog is retired. Its last
// job, importing a GitHub repo, is a small "Import from a GitHub repo" on
// the make screen that swaps the two questions for the repo and the name
// (./import-repo.tsx, #create/import), and every new project, imports
// included, lands on the made screen with Share invite. Pins the doors, the
// import form, what each door answers, and the server's sketch for both.

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

/** App.showCreateModal, as public/js/app.js defines it. */
function createMethod(window) {
  const src = read('public/js/app.js');
  const start = src.indexOf('  showCreateModal(opts) {');
  assert.ok(start > 0, 'App.showCreateModal is on App');
  const end = src.indexOf('\n  },\n', start) + '\n  },\n'.length;
  const ctx = { window };
  vm.runInNewContext(`App = ({\n${src.slice(start, end)}\n});`, ctx);
  return ctx.App;
}

test('Create opens the make screen, on importing when asked; there is no dialog to fall back to', () => {
  const calls = [];
  const window = { UsernodeReact: { firstSession: { create: (opts) => { calls.push(opts); return true; } } } };
  const App = createMethod(window);
  assert.equal(App.showCreateModal(), true);
  assert.equal(App.showCreateModal({ import: true }), true);
  assert.deepEqual(calls, [undefined, { import: true }]);
  // Another of the island's screens holds the view, or it is not mounted yet: nothing opens.
  window.UsernodeReact.firstSession.create = () => false;
  assert.equal(App.showCreateModal(), false);
  delete window.UsernodeReact.firstSession;
  assert.equal(App.showCreateModal(), false);
  const app = read('public/js/app.js');
  assert.doesNotMatch(app, /showCreateOptions|dialogs\?\.create/);
  assert.equal(fs.existsSync(path.join(ROOT, 'frontend/src/features/dialogs/create-app.tsx')), false, 'the dialog is retired');
});

test('#create opens the make screen and #create/import its import form; each has a check', () => {
  const route = read('public/js/app.js');
  assert.match(route, /App\.showCreateModal\(\{ import: parts\[1\] === 'import' \}\);/);
  const dapp = JSON.parse(read('dapp.json'));
  assert.equal(dapp.tests.filter((t) => /#create-card|#create\/options/.test(`${t.expectSelector} ${t.path}`)).length, 0,
    'the dialog\'s checks went with it');
  const front = dapp.tests.find((t) => t.path === '/#create');
  assert.match(front.expectSelector, /\[data-first-session-make\]\[data-make-entry="create"\]/);
  assert.match(front.expectSelector, /\[data-make-close\]/);
  assert.match(front.expectSelector, /\[data-make-import-link\]$/);
  assert.equal(front.expectText, 'What do you want to make?');
  const imp = dapp.tests.find((t) => t.path === '/#create/import');
  assert.match(imp.expectSelector, /\[data-make-import\]:has\(#make-import-url\):has\(\[data-make-import-check\]\):has\(#make-import-name\) \[data-make-describe\]$/);
  assert.equal(imp.expectText, 'Import a GitHub repo');
  const quota = dapp.tests.find((t) => t.path === '/?shot=create-quota#create');
  assert.match(quota.expectSelector, /#make-app-quota\[data-quota-state="available"\]/);
  for (const t of [front, imp, quota]) assert.ok(t.expectSelector.length <= 256, `the platform reads at most 256 characters: ${t.name}`);
});

test('the island opens the Create door over nothing else, on importing when asked, and reads the allowance again', async () => {
  const island = loadTsx(ISLAND);
  const fetches = [];
  await withGlobals({
    window: { App: { user: { id: 3, username: 'sam' } }, addEventListener() {} },
    fetch: async (url) => { fetches.push(url); return { ok: true, json: async () => ({}) }; },
  }, async () => {
    let state = { kind: 'none' };
    const setMode = (fn) => { state = typeof fn === 'function' ? fn(state) : fn; };
    assert.equal(island.openCreate(setMode), true);
    assert.deepEqual(state, { kind: 'make', entry: 'create' });
    assert.ok(fetches.length >= 1, 'the allowance is read again');
    state = { kind: 'none' };
    assert.equal(island.openCreate(setMode, true), true);
    assert.deepEqual(state, { kind: 'make', entry: 'create', startImport: true });
    // Something already up stays.
    state = { kind: 'tour', info: { slug: 'x', name: 'X' }, path: 'maker' };
    assert.equal(island.openCreate(setMode), false);
    assert.equal(state.kind, 'tour');
  });
  const src = read(ISLAND);
  assert.match(src, /create\(opts\?: \{ import\?: boolean \}\): boolean \{\s+return openCreate\(setMode, !!opts\?\.import\);\s+\},/);
  assert.doesNotMatch(src, /made\(made: Made\): boolean|onMoreOptions|dialogs\?\.create/, 'no hand-off from a dialog, and no way to one');
});

test('from Create: nothing is answered, the grid is refreshed, and it ends on the hub', () => {
  const src = read(ISLAND);
  const door = src.slice(src.indexOf("if (mode.kind === 'make' && mode.entry === 'create') {"), src.indexOf("if (mode.kind === 'make') {"));
  assert.match(door, /entry="create"\s+startImport=\{!!mode\.startImport\}/);
  assert.match(door, /legacy\(\)\.Home\?\.load\?\.\(\);\s+void invalidateAppAllowance\(\);\s+setMode\(\{ kind: 'made', made, entry: 'create' \}\);/);
  assert.doesNotMatch(door, /noteAnswered|recordLookAround|onLookAround/);
  assert.match(door, /onClose=\{\(\) => leaveDoor\(false\)\}/);
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

test('the make screen from Create: New project, a close, a small "Import from a GitHub repo", no More options and no "Look around first"', () => {
  const create = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', entry: 'create', onMade() {}, onClose() {} });
  assert.match(create, /data-make-entry="create"/);
  assert.match(create, />New project</);
  assert.doesNotMatch(create, /Hi Jordan!/);
  assert.match(create, /<button type="button" data-make-close="" aria-label="Close"/);
  assert.match(create, /<button type="button" data-make-import-link="" class="text-\[13px\] [^"]*">Import from a GitHub repo<\/button>/, 'small, under Make it');
  assert.ok(create.indexOf('data-make-import-link') > create.indexOf('>Make it</button>'));
  assert.doesNotMatch(create, /More options|data-make-more-options|Look around first/);
  for (const words of ['What do you want to make?', 'What should it do?', 'What should we call it?', '>Make it</button>']) {
    assert.ok(create.includes(words), words);
  }
  assert.match(create, /data-first-session-example="run"/);

  const first = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', onMade() {}, onLookAround() {} });
  assert.match(first, /data-make-entry="first-session"/);
  assert.match(first, />Hi Jordan!</);
  assert.match(first, /Look around first/);
  assert.doesNotMatch(first, /data-make-close|data-make-import-link|Import from a GitHub repo/, 'the first session does not offer an import');

  const make = loadTsx(`${DIR}/make.tsx`);
  assert.equal(make.makeEyebrow('create', 'Jordan'), 'New project');
  assert.equal(make.makeEyebrow('first-session', ''), 'You\'re in!');
  assert.match(make.makeLine(true), /Homeroom bot builds the first version while you invite your people\.$/);
  assert.match(make.makeLine(false), /It becomes the project’s first request while you invite your people\.$/);
  for (const line of [make.makeLine(true), make.makeLine(false), make.IMPORT_TITLE, make.IMPORT_LINE]) assert.doesNotMatch(line, /—/);
  const { viewerBotBuilds } = loadTsx(ISLAND);
  assert.equal(viewerBotBuilds({ homeroomBotDm: false }), false);
  assert.equal(viewerBotBuilds({ homeroomBotDm: true }), true);
  assert.equal(viewerBotBuilds({}), true, 'a snapshot from before the field reads as it always did');

  const src = read(`${DIR}/make.tsx`);
  assert.match(src, /onClick=\{\(\) => setMode\('import'\)\}/);
  assert.match(src, /useState<'make' \| 'import'>\(fromCreate && startImport \? 'import' : 'make'\)/, 'only Create imports');
  assert.match(src, /if \(e\.key === 'Escape'\) onClose\(\);/);
  // One request at a time, as the dialog's Create (QA 2026-09-24 Q5).
  assert.match(src, /if \(busy \|\| makingRef\.current\) return;/);
  assert.match(src, /makingRef\.current = true;\s+setBusy\(true\);/);
  assert.match(src, /\} finally \{\s+makingRef\.current = false;\s+setBusy\(false\);\s+\}/);
});

test('the import form: the repo and Check, then the name, Import it, and a way back', () => {
  const html = renderComponent(`${DIR}/make.tsx`, 'MakeScreen', { who: 'Jordan', entry: 'create', startImport: true, onMade() {}, onClose() {} });
  assert.match(html, /<form data-make-import="" class="mx-auto flex w-full max-w-sm grow flex-col px-4 /, 'in the make form\'s own frame');
  assert.match(html, /<h1 id="first-session-make-title"[^>]*>Import a GitHub repo<\/h1>/);
  assert.match(html, /Bring an app that already exists\. Your group builds on it from here\./);
  assert.match(html, /<input[^>]*id="make-import-url"[^>]*>/);
  assert.match(html, /data-make-import-check=""[^>]*>Check<\/button>/);
  assert.match(html, /Invite usernode-bot to the repo first \(Write access on an organization repo\)\./);
  assert.match(html, /<input[^>]*id="make-import-name"[^>]*>/);
  assert.match(html, />Import it<\/button>/);
  assert.match(html, /data-make-describe=""[^>]*>Describe a new project instead<\/button>/);
  assert.doesNotMatch(html, /What should it do\?|data-first-session-example/, 'the two questions are swapped out, not added to');

  const mod = loadTsx(`${DIR}/import-repo.tsx`);
  assert.equal(mod.importMissing(false, 'Notes'), 'repo', 'a repo not checked is asked for first');
  assert.equal(mod.importMissing(true, '  '), 'name');
  assert.equal(mod.importMissing(true, 'Notes'), null);
  assert.equal(mod.repoNote({}, false), null, 'nothing to say about a repo that changes nothing');
  assert.equal(mod.repoNote({ visibility: { build: 'private', view: 'private' } }, false), null, 'private is what it is anyway');
  assert.match(mod.repoNote({ visibility: { build: 'public', view: 'public' } }, false),
    /^Its dapp\.json says anyone can find it, join and build, so it starts that way rather than as a private community\.$/);
  assert.match(mod.repoNote(null, true), /^Couldn’t read this repo’s dapp\.json\./);

  const src = read(`${DIR}/make.tsx`);
  const imp = src.slice(src.indexOf('const importRepo = useCallback('), src.indexOf('const formClass ='));
  assert.match(imp, /postCreateApp\(\{ name: repoName, audience: 'invited', repoUrl, from: entry \}\)/, 'a private community, through the same request');
  assert.match(imp, /imported: true,/);
  // Any edit to the address puts the check back: a verified repo A is never imported as repo B.
  const form = read(`${DIR}/import-repo.tsx`);
  assert.match(form, /setState\('idle'\); setStatus\(''\); setManifest\(null\); setUnread\(false\);/);
});

test('the import check reads GET /api/github/verify-access, and says what failed', async () => {
  const { checkRepo } = loadTsx(`${DIR}/import-repo.tsx`);
  const answer = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
  assert.deepEqual(await checkRepo(''), { ok: false, error: 'Paste a GitHub repo URL first.' });
  const seen = [];
  const ok = await checkRepo('https://github.com/o/r', async (url, init) => {
    seen.push([url, init.credentials]);
    return answer(200, { fullName: 'o/r', manifest: { name: 'R' } })();
  });
  assert.deepEqual(seen, [['/api/github/verify-access?url=https%3A%2F%2Fgithub.com%2Fo%2Fr', 'same-origin']]);
  assert.deepEqual(ok, { ok: true, fullName: 'o/r', manifest: { name: 'R' }, unread: false });
  assert.deepEqual(await checkRepo('x', answer(200, { owner: 'o', repo: 'r', manifest: null })), { ok: true, fullName: 'o/r', manifest: {}, unread: true });
  assert.deepEqual(await checkRepo('x', answer(403, { error: 'Invite usernode-bot first.' })), { ok: false, error: 'Invite usernode-bot first.' });
  assert.deepEqual(await checkRepo('x', async () => { throw new TypeError('offline'); }), { ok: false, error: 'Network error. Try again.' });
});

test('the made screen from Create goes to the project; an import lands there too, with Share invite', () => {
  const made = loadTsx(`${DIR}/made.tsx`);
  assert.equal(made.continueLabel('create', false, 'Page Turners'), 'Invite people later');
  assert.equal(made.continueLabel('create', true, 'Page Turners'), 'Go to Page Turners');
  // An import's own lines: no first version, so it is coming over, then it runs.
  assert.equal(made.buildLine(null, 'creating', false, true), 'Importing it from GitHub…');
  assert.equal(made.buildLine(null, 'running', false, true), 'Imported. It’s running.');
  assert.equal(made.buildLine(null, 'error', false, true), 'Setting it up didn’t finish.', 'a stopped import says so first');
  assert.equal(made.buildNote(false, false, null, true), 'Its repo says what it does. You and anyone you invite build on it from here.');
  const html = renderToHtml(createElement(made.MadeScreen, {
    made: { slug: 'notes-1', name: 'Notes', emoji: null, description: 'Notes for the group', example: null, conversationId: null, imported: true },
    me: 'sam', entry: 'create', onContinue() {}, onOpenChat() {},
  }));
  assert.match(html, />Importing it from GitHub…</);
  assert.match(html, />Share invite<\/button>/, 'every new project ends on Share invite');
  assert.match(html, />Invite people to Notes</);
  assert.doesNotMatch(html, /data-first-session-sketch/, 'an import is never sketched');
  const src = read(`${DIR}/made.tsx`);
  assert.doesNotMatch(src, /\bsolo\b|made\.audience/, 'nothing is made for Just me from here any more');
  assert.match(src, /const card = !imported && showsCard\(sketch\.state\);/);
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

// Found on the flow's own screenshots (local run, 7 October 2026): a setup
// that stopped drew "Ready to try" on the card over "Setting it up didn't
// finish", and a Just me project's sketch said it was "Shared with the
// people you invite".
test('a stopped setup is not "Ready to try", and a Just me sketch is shared with nobody', () => {
  // (Just me is no longer chosen at creation; the server still keeps the
  // shared point off a solo project's sketch for any other caller.)
  const src = read(`${DIR}/made.tsx`);
  assert.match(src, /const stalled = stalledOf\(appStatus\);[\s\S]{0,500}const making = imported \? appStatus !== 'running' : \(!!stalled \|\| !\(building && !fv\)\);/);
  // Not the bot's "Being made" either: nothing is being made while it is stopped.
  assert.match(src, /botBuilds=\{botBuilds && !stalled\} built=\{!making \|\| !!\(fv && fv\.ready\)\}/);
  const { pillLabel } = loadTsx(`${DIR}/sketch-card.tsx`);
  assert.equal(pillLabel('idea'), 'Not built yet');

  const sketch = require('../src/services/app-sketch');
  const brief = 'A tracker for our weekly miles, so we can see who is keeping up';
  assert.ok(sketch.fallbackCard({ name: 'Run Club', brief }).points.includes(sketch.SHARED_POINT), 'a group\'s project still says so');
  assert.ok(!sketch.fallbackCard({ name: 'Run Club', brief, solo: true }).points.includes(sketch.SHARED_POINT));
  assert.deepEqual(sketch.fallbackCard({ name: 'Run Club', brief: '', solo: true }).points, [], 'not padded with it either');
  const route = read('src/routes/apps.js');
  assert.match(route, /solo: options\.audience === 'solo',\s+\}\)\.catch\(\(err\) => log\.warn\('apps', 'Sketch not started'/);
  const service = read('src/services/app-sketch.js');
  assert.match(service, /if \(points\.length < 2 && !solo\) points = distinctPoints\(\[\.\.\.points, SHARED_POINT\], tagline\);/);
  assert.match(service, /card = parseCardReply\(reply\.text, \{ name, brief, today, solo \}\);/);
  assert.match(service, /const work = generate\(pool, \{ app, user, brief, audience, solo, timeZone, deps \}\)/);
});
