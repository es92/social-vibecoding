// The App tab's five placeholder states: what `renderAppTab` publishes when
// there is no running app to frame, and what draws it.
//
// tests/app-frame-identity.test.js already pins WHICH branch each app status
// lands in — that harness holds the real store and reads the view back. This
// file is the other half: the view's CONTENT (the dot, the detail line, who
// gets a button) and the markup
// frontend/src/features/app-frame/app-status.tsx renders from it. Between
// them the branch and its output are both covered; before the conversion
// neither was.
//
// Run with: node --test tests/app-status-placeholder.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/app-status-api.ts')));

function makeAppView({ fetchImpl, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const opened = [];
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentApp: null, currentTab: null },
    Secrets: { open: (slug) => opened.push(['secrets', slug]) },
    BuildLog: { open: (slug) => opened.push(['buildLog', slug]) },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: (...args) => (fetchImpl
      ? fetchImpl(...args)
      : Promise.resolve({ ok: true, json: async () => ({}) })),
    setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return { AppView: sandbox.__AppView, opened, sandbox };
}

const view = (AppView, appData) => JSON.parse(JSON.stringify(AppView._appStatusView(appData)));

function html(v) {
  const m = mod();
  m.appStatusStore.set({ view: v });
  return renderToHtml(createElement(m.AppStatus));
}

test('spinning up: the amber dot and nothing to act on', () => {
  const { AppView } = makeAppView();
  const v = view(AppView, { status: 'creating', slug: 'recipebot' });
  assert.deepEqual(v, { dot: 'creating', message: 'App is spinning up...', detail: null, action: null });
  const out = html(v);
  assert.match(out, /class="status-dot creating"/);
  assert.match(out, /App is spinning up\.\.\./);
  assert.doesNotMatch(out, /<button/);
});

test('a persisted Preview sample explains its content without a failed runtime or retry spinner', () => {
  const { AppView } = makeAppView();
  const v = view(AppView, { status: 'running', url: null, staging_sample: true });
  assert.equal(v.dot, null);
  assert.equal(v.detail, null);
  assert.match(html(v), /Preview sample app/);
  assert.match(html(v), /No live app is deployed here/);
  assert.doesNotMatch(html(v), /App not available|spinner|status-dot/);
});

test('#1883: HTTP reconciliation clears a stale creating placeholder without a WebSocket event', async () => {
  const running = {
    slug: 'recipebot', name: 'Recipebot', status: 'running',
    url: 'https://recipebot.example.test',
  };
  const { AppView, sandbox } = makeAppView({
    fetchImpl: async () => ({ ok: true, json: async () => ({ app: running }) }),
  });
  const creating = { slug: 'recipebot', name: 'Recipebot', status: 'creating', url: null };
  sandbox.App.currentApp = creating.slug;
  sandbox.App.currentTab = 'app';
  AppView.appData = creating;

  const tokens = [];
  let renders = 0;
  AppView.refreshToken = async (slug) => { tokens.push(slug); };
  AppView.renderAppTab = () => { renders += 1; };

  await AppView.pollStatus(creating);

  assert.equal(AppView.appData.status, 'running');
  assert.equal(AppView.appData.url, running.url);
  assert.deepEqual(tokens, ['recipebot'], 'the running frame gets a fresh app-scoped token first');
  assert.equal(renders, 1, 'the terminal state replaces the placeholder immediately');
  assert.equal(AppView._statusPollTimer, null, 'no poll survives a terminal record');
});

test('#1883: HTTP reconciliation bypasses the app-detail boot cache', async () => {
  const calls = [];
  const running = {
    slug: 'recipebot', name: 'Recipebot', status: 'running',
    url: 'https://recipebot.example.test',
  };
  const { AppView, sandbox } = makeAppView({
    fetchImpl: async (...args) => {
      calls.push(args);
      return { ok: true, json: async () => ({ app: running }) };
    },
  });
  const creating = { slug: 'recipebot', name: 'Recipebot', status: 'creating', url: null };
  sandbox.App.currentApp = creating.slug;
  sandbox.App.currentTab = 'app';
  AppView.appData = creating;
  AppView.refreshToken = async () => {};
  AppView.renderAppTab = () => {};

  await AppView.pollStatus(creating);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/apps/recipebot?status_recheck=1');
  assert.equal(calls[0][1].cache, 'no-store');
});

test('#1883: repeated paints keep exactly one status recheck scheduled', () => {
  let seq = 0;
  const active = new Set();
  const { AppView, sandbox } = makeAppView({
    setTimeoutImpl: () => { const id = ++seq; active.add(id); return id; },
    clearTimeoutImpl: (id) => active.delete(id),
  });
  const creating = { slug: 'recipebot', status: 'creating' };
  sandbox.App.currentApp = creating.slug;
  sandbox.App.currentTab = 'app';
  AppView.appData = creating;

  AppView._watchCreatingStatus(creating);
  const first = AppView._statusPollTimer;
  AppView._watchCreatingStatus(creating);
  AppView._watchCreatingStatus(creating);

  assert.equal(AppView._statusPollTimer, first);
  assert.equal(active.size, 1, 're-renders do not create parallel polling loops');
  AppView._stopStatusPolling();
  assert.equal(active.size, 0);
});

test('#1883: a transient status-read failure re-arms the same placeholder', async () => {
  let seq = 0;
  const active = new Set();
  const { AppView, sandbox } = makeAppView({
    fetchImpl: async () => { throw new Error('temporary network failure'); },
    setTimeoutImpl: () => { const id = ++seq; active.add(id); return id; },
    clearTimeoutImpl: (id) => active.delete(id),
  });
  const creating = { slug: 'recipebot', status: 'creating' };
  sandbox.App.currentApp = creating.slug;
  sandbox.App.currentTab = 'app';
  AppView.appData = creating;

  await AppView.pollStatus(creating);

  assert.equal(AppView.appData, creating, 'a failed read does not change the visible state');
  assert.equal(active.size, 1, 'recovery continues after a transient failure');
  AppView._stopStatusPolling();
});

test('#1883: a late status response cannot overwrite a later navigation', async () => {
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const { AppView, sandbox } = makeAppView({ fetchImpl: () => response });
  const creating = { slug: 'recipebot', status: 'creating' };
  sandbox.App.currentApp = creating.slug;
  sandbox.App.currentTab = 'app';
  AppView.appData = creating;
  let renders = 0;
  AppView.renderAppTab = () => { renders += 1; };

  const polling = AppView.pollStatus(creating);
  const later = { slug: 'notes', status: 'running', url: 'https://notes.example.test' };
  sandbox.App.currentApp = later.slug;
  AppView.appData = later;
  release({
    ok: true,
    json: async () => ({
      app: { slug: 'recipebot', status: 'running', url: 'https://recipebot.example.test' },
    }),
  });
  await polling;

  assert.equal(AppView.appData, later, 'the newer app remains authoritative');
  assert.equal(renders, 0);
});

test('awaiting secrets: the missing names, and a way to set them', () => {
  const { AppView } = makeAppView();
  const v = view(AppView, {
    status: 'awaiting_secrets', slug: 'recipebot',
    missingSecrets: ['STRIPE_KEY', 'MAIL_TOKEN'],
  });
  assert.equal(v.detail, 'STRIPE_KEY, MAIL_TOKEN');
  assert.deepEqual(v.action, { key: 'secrets', label: 'Configure secrets', slug: 'recipebot' });
  const out = html(v);
  assert.match(out, /Deploy is blocked/);
  assert.match(out, /font-mono text-red-700[^>]*>STRIPE_KEY, MAIL_TOKEN/);
  assert.match(out, /id="awaiting-open-secrets"/);
});

test('awaiting secrets with none listed still offers the panel', () => {
  const { AppView } = makeAppView();
  const v = view(AppView, { status: 'awaiting_secrets', slug: 'recipebot' });
  assert.equal(v.detail, null);
  assert.ok(v.action, 'the button is what makes this state actionable');
  assert.doesNotMatch(html(v), /font-mono/);
});

test('failed to start: the reason line, clipped, and the log button for involved users', () => {
  const { AppView } = makeAppView();
  const long = 'x'.repeat(400);
  const v = view(AppView, {
    status: 'error', slug: 'recipebot',
    lastFailure: { reason: long },
  });
  assert.equal(v.dot, 'error');
  assert.equal(v.detail.length, 280, 'the reason is clipped before it reaches the card');
  assert.deepEqual(v.action, { key: 'buildLog', label: 'View build log', slug: 'recipebot' });
  const out = html(v);
  assert.match(out, /class="status-dot error"/);
  assert.match(out, /App failed to start/);
  assert.match(out, /id="app-error-build-log"/);
});

test('#416: an outsider gets the bare failure, with no build log to open', () => {
  const { AppView } = makeAppView();
  const v = view(AppView, { status: 'error', slug: 'recipebot', errorReason: 'exit 1' });
  assert.equal(v.detail, 'exit 1', 'the live WS reason still shows');
  assert.equal(v.action, null, 'but the log is collaborator-gated');
  assert.doesNotMatch(html(v), /<button/);
});

test('anything else is "App not available", with no dot at all', () => {
  const { AppView } = makeAppView();
  for (const appData of [null, undefined, { status: 'stopped' }, {}]) {
    const v = view(AppView, appData);
    assert.deepEqual(v, { dot: null, message: 'App not available', detail: null, action: null });
  }
  assert.doesNotMatch(html(view(makeAppView().AppView, null)), /status-dot/);
});

test('the two buttons dispatch by name into the openers', () => {
  const { AppView, opened } = makeAppView();
  AppView.openAwaitingSecrets('recipebot');
  AppView.openAppBuildLog('recipebot');
  assert.deepEqual(opened, [['secrets', 'recipebot'], ['buildLog', 'recipebot']]);
  // A slug-less call is a no-op rather than an `open(undefined)`.
  AppView.openAwaitingSecrets(null);
  AppView.openAppBuildLog('');
  assert.equal(opened.length, 2);
});

test('the placeholder is the primary button, not a hand-written violet fill', () => {
  const SRC_TSX = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'app-frame', 'app-status.tsx'), 'utf8'
  );
  assert.doesNotMatch(SRC_TSX, /bg-violet-600/, 'routed through <Button>');
  const { AppView } = makeAppView();
  const out = html(view(AppView, { status: 'awaiting_secrets', slug: 'x' }));
  assert.match(out, /bg-violet-600 hover:bg-violet-500/, 'and still renders the same fill');
});

test('an empty view renders nothing, so a swept host stays empty', () => {
  assert.equal(html(null), '');
});

// ── #15: the first version, being built from the description (D9) ──

const FIRST = { building: true, mine: true, step: 3, of: 7, stepName: 'Write a plan', creator: 'ada', ready: false, question: false, conversationId: 42 };

function firstVersionApp(over = {}, fv = {}) {
  return { slug: 'plant-pal', name: 'Plant Pal', status: 'running', url: 'https://plant-pal.example.test', ...over, first_version: { ...FIRST, ...fv } };
}

test('#15: the creator sees whose description it is, the step, and the way into their chat', () => {
  const { AppView } = makeAppView();
  const v = view(AppView, firstVersionApp());
  assert.deepEqual(v, {
    dot: 'creating',
    message: 'Plant Pal is being built from your description',
    detail: null,
    lines: ['Step 3 of 7: Write a plan', 'We’ll message you when it’s ready.'],
    action: { key: 'botChat', label: 'Open my chat with Homeroom bot', slug: 'plant-pal', conversationId: 42 },
    secondary: { key: 'starter', label: 'Show the starter for now', slug: 'plant-pal' },
  });
  const out = html(v);
  assert.match(out, /class="status-dot creating"/);
  assert.match(out, /<p class="max-w-sm text-base font-semibold[^"]*">Plant Pal is being built from your description<\/p>/);
  assert.match(out, />Step 3 of 7: Write a plan</);
  assert.match(out, />We’ll message you when it’s ready\.</);
  assert.match(out, /<button id="app-first-version-chat"[^>]*>Open my chat with Homeroom bot<\/button>/);
  assert.match(out, /<button id="app-first-version-starter"[^>]*>Show the starter for now<\/button>/);
  assert.doesNotMatch(out, /Start a new change/);
});

test('B6: while its plan waits, the creator gets the plan card in place of the chat button', () => {
  const { AppView } = makeAppView();
  const plan = {
    bullets: ['A list of your plants'], questions: [{ question: 'How should it remind you?', answers: ['In the app', 'Phone alert'] }],
    actionId: 7, messageId: 70, conversationId: 42,
  };
  const v = view(AppView, firstVersionApp({}, { plan }));
  assert.deepEqual(v.lines, ['Step 3 of 7: Write a plan']);
  assert.equal(v.action, null);
  assert.deepEqual(v.plan, { appName: 'Plant Pal', slug: 'plant-pal', ...plan });
  const out = html(v);
  assert.match(out, /data-bot-plan="open"/);
  assert.match(out, /Here’s my plan for Plant Pal:/);
  assert.match(out, /data-bot-plan-build="">Build it<\/button>/);
  assert.match(out, /data-bot-plan-change="">Change something<\/button>/);
  assert.doesNotMatch(out, /app-first-version-chat/);
  assert.match(out, /<button id="app-first-version-starter"/, 'the starter is still there');
  // Only the creator's, and only a plan it can build.
  assert.equal(view(AppView, firstVersionApp({}, { plan, mine: false, conversationId: null })).plan, undefined);
  assert.equal(view(AppView, firstVersionApp({}, { plan: { ...plan, actionId: null } })).plan, undefined);
});

test('#15: anyone else is told whose description it is, and gets no chat of somebody else\'s', () => {
  const { AppView } = makeAppView();
  const v = view(AppView, firstVersionApp({}, { mine: false, conversationId: null, question: false }));
  assert.equal(v.message, 'Plant Pal is being built from @ada’s description');
  assert.deepEqual(v.lines, ['Step 3 of 7: Write a plan', 'It opens here once it’s ready.']);
  assert.equal(v.action, null);
  assert.deepEqual(v.secondary, { key: 'starter', label: 'Show the starter for now', slug: 'plant-pal' }, 'the escape is for everyone');
  assert.doesNotMatch(html(v), /app-first-version-chat/);
});

test('#15: a question waiting on the creator, and a first version up for its vote, each say so', () => {
  const { AppView } = makeAppView();
  const asked = view(AppView, firstVersionApp({}, { step: 2, stepName: 'Read the description', question: true }));
  assert.deepEqual(asked.lines, ['Step 2 of 7: Read the description', 'Homeroom bot has a question for you.']);
  assert.equal(asked.action.key, 'botChat', 'the chat is where it is answered');
  const ready = view(AppView, firstVersionApp({}, { step: 6, stepName: 'Group vote', ready: true }));
  assert.deepEqual(ready.lines, ['Step 6 of 7: Group vote', 'Its first version is ready. Try it and vote on it from your chat.']);
  const theirs = view(AppView, firstVersionApp({}, { mine: false, step: 6, stepName: 'Group vote', ready: true }));
  assert.equal(theirs.lines[1], 'Its first version is up for a vote.');
});

test('#15: while the project is still being set up there is no starter to offer', () => {
  const { AppView } = makeAppView();
  const v = view(AppView, firstVersionApp({ status: 'creating', url: null }, { step: 1, stepName: 'Set up the project' }));
  assert.equal(v.message, 'Plant Pal is being built from your description');
  assert.deepEqual(v.lines, ['Step 1 of 7: Set up the project', 'We’ll message you when it’s ready.']);
  assert.equal(v.secondary, null);
  // Not building any more (or never was): the ordinary states, unchanged.
  assert.deepEqual(view(AppView, { status: 'creating', slug: 'plant-pal', first_version: null }),
    { dot: 'creating', message: 'App is spinning up...', detail: null, action: null });
  const failed = view(AppView, { status: 'error', slug: 'plant-pal', first_version: { ...FIRST } });
  assert.equal(failed.message, 'App failed to start', 'a failed project is the failure, whatever the bot was doing');
});

test('#15: the chat button opens the DM by its id, and the starter shows for the rest of the visit', () => {
  const { AppView, sandbox } = makeAppView();
  const opened = [];
  sandbox.UsernodeReact = { messages: { open: (id) => opened.push(id) } };
  AppView.openBotChat('plant-pal', 42);
  AppView.openBotChat('plant-pal', null);
  assert.deepEqual(opened, [42, null], 'no id opens Messages, where the bot DM is');
  sandbox.UsernodeReact = null;
  sandbox.location = { hash: '' };
  AppView.openBotChat('plant-pal', 7);
  assert.equal(sandbox.location.hash, '#messages/7', 'without the bundle, the address does it');

  const app = firstVersionApp();
  sandbox.App.currentApp = 'plant-pal';
  sandbox.App.currentTab = 'app';
  AppView.appData = app;
  let renders = 0;
  AppView.renderAppTab = () => { renders += 1; };
  assert.equal(AppView._firstVersionPending(app), true);
  AppView.showStarter('plant-pal');
  assert.equal(AppView._firstVersionPending(app), false, 'the frame may mount now');
  assert.equal(renders, 1, 'and the tab re-renders to mount it');
  assert.notEqual(view(AppView, app).message, 'Plant Pal is being built from your description');
});

test('#15: the screen re-asks the server while it is up, past the service worker\'s cache', async () => {
  const calls = [];
  let answer = firstVersionApp({}, { step: 4, stepName: 'Build it' });
  const { AppView, sandbox } = makeAppView({
    fetchImpl: async (...args) => { calls.push(args); return { ok: true, json: async () => ({ app: answer }) }; },
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
  });
  const app = firstVersionApp();
  sandbox.App.currentApp = 'plant-pal';
  sandbox.App.currentTab = 'app';
  AppView.appData = app;
  let renders = 0;
  const tokens = [];
  AppView.renderAppTab = () => { renders += 1; };
  AppView.refreshToken = async (slug) => { tokens.push(slug); };

  AppView._watchFirstVersion(app);
  assert.equal(AppView._firstVersionTimer, 1, 'one recheck armed');
  AppView._watchFirstVersion(app);
  assert.equal(AppView._firstVersionRecord, app, 'repeated paints keep the one timer');

  await AppView._recheckFirstVersion(app);
  assert.equal(calls[0][0], '/api/apps/plant-pal?status_recheck=1&manifest=summary');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(AppView.appData, answer, 'the newer record replaces the old one');
  assert.equal(renders, 1, 'a new step is painted');
  assert.deepEqual(tokens, [], 'still building: no frame, so no token yet');

  // Built: the frame mounts, with a fresh token first.
  answer = { ...firstVersionApp(), first_version: null };
  const building = AppView.appData;
  await AppView._recheckFirstVersion(building);
  assert.deepEqual(tokens, ['plant-pal']);
  assert.equal(renders, 2);

  // Gone from the page: nothing is fetched, nothing is painted.
  const before = calls.length;
  const again = firstVersionApp();
  AppView.appData = again;
  sandbox.App.currentTab = 'dev';
  await AppView._recheckFirstVersion(again);
  assert.equal(calls.length, before);
  AppView._stopFirstVersionWatch();
  assert.equal(AppView._firstVersionTimer, null);
});
