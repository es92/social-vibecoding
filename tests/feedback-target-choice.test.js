// Frontend tests for issue #5992: when Send Feedback has more than one
// destination to offer, it opens on the app the person is in — the place the
// improvement came from — and Homeroom stays one tap away.
//
// #2707 had deliberately left the question unanswered, on the theory that a
// preselected destination miscategorises a report. #5992 asks for the
// opposite: the open app is the default, because that is where the person
// was when they suggested the improvement, and pressing Post request with
// the default sends it there with no extra tap. An explicit earlier pick
// (a restored draft, a caller's own `target`) still wins.
//
// #2888's refusal (nothing is sent, the row turns red) stays in the code as
// a safety net, but with a destination always preselected it can no longer
// be reached in normal use.
//
// The asymmetric half matters just as much and is easy to lose in a later
// refactor: when only ONE destination is reachable there is nothing to
// disambiguate, so it stays selected and Submit is live on open. A tap with
// exactly one possible answer teaches people to tap past the question.
//
// Two halves, the arrangement tests/feedback-required-description.test.js
// established:
//
//  - STATIC assertions against the shipped document and the declared
//    dapp.json checks. public/index.html is a generated artifact here, not
//    a committed fixture — tests/README and the shell-build test own that
//    lifecycle.
//
//  - BEHAVIOURAL assertions driven through the REAL controller in a vm
//    context, with `AppView.appData` posed to produce each case.
//
// Run with: node --test tests/feedback-target-choice.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const CONTROLLER_PATH = path.join(
  ROOT, 'frontend', 'src', 'features', 'dialogs', 'feedback-controller.js'
);
const CONTROLLER_TEXT = fs.readFileSync(CONTROLLER_PATH, 'utf8');

// The exact copy, asserted as a literal on both sides: the declared
// dapp.json check matches on this text, so a reword that touched only one
// of the two would go green here and fail the merge gate.
// UI overhaul: the row's label asks the question ("Where should this go?"),
// so this line is only the refusal after a submit with nothing chosen. It
// was "Choose where this feedback goes." and also the grey prompt (#2707).
const HINT = 'Choose where this goes.';
const LABEL = 'Where should this go?';

// ── Half one: the shipped document ───────────────────────────────────

test('neither destination is pre-checked in the shipped markup', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  for (const id of ['feedback-target-app', 'feedback-target-platform']) {
    const button = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(button, `#${id} is in the document`);
    assert.match(
      button[0],
      /aria-checked="false"/,
      `#${id} ships unchecked — the controller decides on open, and a`
      + ' prerendered choice would be a claim about an app it cannot see'
    );
  }
});

test('the picker draws no caret: the filled option says which is chosen (audit D10)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="feedback-caret-(app|platform)"/);
});

test('the hint ships empty, hidden and adjacent to the row it is about', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const node = html.match(/<p[^>]*id="feedback-target-hint"[^>]*>(.*?)<\/p>/s);
  assert.ok(node, '#feedback-target-hint is in the document');
  assert.match(node[0], /class="[^"]*\bhidden\b/, 'it starts hidden');
  assert.equal(node[1].trim(), '', 'it renders EMPTY — the controller owns the text');
  assert.ok(
    !html.includes(HINT),
    'the copy is not prerendered: the one-destination case never shows it,'
    + ' and a message on the initial render would mismatch on hydration'
  );
  // The declared check reaches it as `#feedback-target + #feedback-target-hint`.
  assert.match(
    html,
    /id="feedback-target"[\s\S]*?<\/div><\/div><p[^>]*id="feedback-target-hint"/,
    'it is the radiogroup\'s immediate next sibling'
  );
});

test('the copy lives in exactly one place', () => {
  assert.equal(
    CONTROLLER_TEXT.split("t('dialogs:feedback.target.choose')").length - 1,
    1,
    `"${HINT}" is read once, as chooseTargetHint`
  );
});

test('?shot=feedback-choose is a recognised deep link', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const start = app.indexOf('_applyFeedbackShot() {');
  assert.ok(start > 0, 'the shot handler is still named that');
  const shot = app.slice(start, app.indexOf('renderAdminButton()', start));
  assert.match(shot, /'feedback-choose'/, 'the shot name is accepted');
  assert.match(shot, /feedback-target-app-name/, 'and it waits for the app option, live and named');
  assert.match(
    shot,
    /getAttribute\('aria-checked'\) === 'true'/,
    'and for the app option to be the preselected one (#5992)'
  );
  assert.match(
    shot,
    /App\._simulateFeedbackTargetChoice/,
    'through the controller hook, like the two shots beside it'
  );
  assert.match(
    CONTROLLER_TEXT,
    /App\._simulateFeedbackTargetChoice = \(name\) => applyTargetAvailability\(true, \{ name \}\)/,
    'and that hook runs the SHIPPED branch rather than posing the row by hand'
  );
});

test('?shot=feedback-choose-missed is gone with the state it posed', () => {
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const start = app.indexOf('_applyFeedbackShot() {');
  const shot = app.slice(start, app.indexOf('renderAdminButton()', start));
  assert.doesNotMatch(shot, /'feedback-choose-missed'/, 'the shot name is no longer accepted');
  assert.doesNotMatch(shot, /App\._simulateFeedbackTargetMissed/, 'nor is the hook called');
  assert.doesNotMatch(CONTROLLER_TEXT, /App\._simulateFeedbackTargetMissed/, 'and the hook is gone');
  assert.doesNotMatch(
    fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'),
    /feedback\.destination-missed|feedback-choose-missed/,
    'nothing declares the unreachable state'
  );
});

test('the three declared checks exist and match the shipped ids and copy', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'dapp.json'), 'utf8'));
  const declared = manifest.tests || [];

  const choice = declared.find((t) => t.id === 'feedback.destination-choice');
  assert.ok(choice, 'the two-destination state is covered');
  assert.equal(choice.path, '/?shot=feedback-choose');
  assert.equal(choice.visual, true, 'and it is the representative visual flow');
  assert.equal(choice.expectText, LABEL, 'the row keeps its label');
  assert.match(choice.expectSelector, /#feedback-target-label \+ #feedback-target\b/);
  assert.match(
    choice.expectSelector,
    /#feedback-target-app\[aria-checked="true"\]/,
    'the open app is preselected (#5992)'
  );
  assert.match(
    choice.expectSelector,
    /#feedback-target-platform\[aria-checked="false"\]/,
    'while Homeroom stays tappable and unchosen'
  );
  assert.match(choice.expectSelector, /#feedback-target-hint\.hidden/, 'and says nothing under the row');
  assert.match(
    choice.expectSelector,
    /#feedback-submit:not\(:disabled\)/,
    'Post request is live with the default destination'
  );
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, new RegExp(`<p[^>]*id="feedback-target-label"[^>]*>${LABEL.replace('?', '\\?')}</p>`));
  assert.match(html, /id="feedback-target"[^>]*aria-labelledby="feedback-target-label"/);

  // The unchosen row's Submit check folded into the choice above, and the
  // missed-destination state is gone with the default that made it
  // unreachable (#5992).
  assert.ok(
    !declared.some((t) => t.path === '/?shot=feedback-choose-missed'
      || t.id === 'feedback.destination-missed'),
    'the unreachable missed-destination state is retired'
  );
  assert.ok(
    !declared.some((t) => t.path === '/?shot=feedback-choose'
      && /#feedback-submit:disabled/.test(t.expectSelector)),
    'no check still asserts the retired disabled Submit'
  );

  const single = declared.find((t) => t.path === '/?shot=feedback'
    && /#feedback-target-hint\.hidden/.test(t.expectSelector || ''));
  assert.ok(single, 'the ONE-destination case is covered too');
  assert.equal(single.path, '/?shot=feedback', 'on the route where no app is open');
  assert.match(
    single.expectSelector,
    /#feedback-submit:not\(:disabled\)/,
    'and it asserts Submit is live there — no pointless extra tap'
  );

  // Every selector reaches the card through `body:has(...)`, never as a
  // DESCENDANT of #feedback-modal: useStaticModal lifts the card out of that
  // root into the kit's own shell when the dialog opens, so a descendant
  // selector matches nothing precisely when the dialog IS open.
  for (const t of [choice, single]) {
    assert.match(
      t.expectSelector,
      /^body:has\(#feedback-modal:not\(\.hidden\)\)/,
      `${t.name}: the card is selected via body:has(), not through the lifted root`
    );
  }
});

// ── Half two: the controller, run for real ───────────────────────────

const FEEDBACK_SRC = CONTROLLER_TEXT
  .replace(/^import .*$/gm, '')
  .replace(/^export /gm, '')
  + '\n;globalThis.Feedback = Feedback;\n';

function makeEl(id) {
  const listeners = {};
  const classes = new Set();
  const attrs = {};
  const children = new Map();
  return {
    id,
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    className: '',
    innerHTML: '',
    placeholder: '',
    disabled: false,
    checked: false,
    focused: 0,
    listeners,
    classes,
    attrs,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const next = on === undefined ? !classes.has(c) : !!on;
        if (next) classes.add(c); else classes.delete(c);
        return next;
      },
    },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    fire(ev, arg) { for (const fn of (listeners[ev] || [])) fn(arg); },
    setAttribute: (k, v) => { attrs[k] = String(v); },
    removeAttribute: (k) => { delete attrs[k]; },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k) => k in attrs,
    querySelector(sel) {
      if (!children.has(sel)) children.set(sel, makeEl(`${id}${sel}`));
      return children.get(sel);
    },
    querySelectorAll: () => [],
    focus() { this.focused += 1; },
    click() { this.fire('click', { target: this, currentTarget: this }); },
  };
}

// `appData` poses the context the dialog opens in. null is home/leaderboard
// (no app open); a repo_url with no self_hosted flag is an ordinary app on
// its App or Dev tab, which is the two-destination case.
function makeHarness({ appData = null, sessionDraft = null } = {}) {
  const els = new Map();
  const fetchCalls = [];
  let timerId = 0;
  const timers = new Map();

  const AppView = {
    appData,
    issueStateAvailable: () => false,
    collectIssueState: async () => null,
    createPrForIssue: async () => {},
    close: () => {},
  };

  const sandbox = {
    // The binding the controller's i18n import gives it (the import line is stripped above).
    t: englishPlatformI18n().t,
    // And its repo-link import: the shared repository-address rule (#6016).
    isRepoAddress: require('./lib/repo-link').repoLink.isRepoAddress,
    // The controller's KUDOS_PARKED import, stripped above too: these suites
    // drive the bounty row with the switch off (#5249). The parked state is
    // pinned in tests/feedback-bounty-ui.test.js.
    KUDOS_PARKED: false,
    console: { ...console, warn: () => {}, debug: () => {} },
    URLSearchParams,
    location: { search: '', hash: '', pathname: '/' },
    document: {
      getElementById: (id) => {
        if (!els.has(id)) els.set(id, makeEl(id));
        return els.get(id);
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      createElement: (tag) => makeEl(tag),
      body: { appendChild: () => {} },
    },
    fetch: async (url, opts = {}) => {
      fetchCalls.push({ url, opts });
      if (url === '/api/feedback/title') {
        return { ok: true, json: async () => ({ title: 'Generated Title' }) };
      }
      return { ok: true, json: async () => ({ issueUrl: 'https://example.invalid/1' }) };
    },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: {
      getItem: () => (sessionDraft ? JSON.stringify(sessionDraft) : null),
      setItem: () => {},
      removeItem: () => {},
    },
    AppView,
    PlatformUI: { pullToRefresh: () => {}, toast: () => {} },
    App: new Proxy({}, {
      get: (t, p) => t[p],
      set: (t, p, v) => { t[p] = v; return true; },
    }),
    alert: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(FEEDBACK_SRC, sandbox);
  sandbox.init();

  // What the shell's own open path establishes before Feedback._open runs.
  sandbox.App.currentApp = appData ? 'example-app' : null;
  sandbox.App.currentTab = appData ? 'app' : 'home';
  sandbox.App.user = { id: 7 };

  const el = (id) => sandbox.document.getElementById(id);
  el('feedback-text-error').classList.add('hidden');
  el('feedback-modal').classList.add('hidden');

  return {
    sandbox,
    el,
    fetchCalls,
    open(opts = {}) { sandbox.Feedback._open(opts); },
    filed: () => fetchCalls.filter((c) => c.url === '/api/feedback'),
    hintShown: () => !el('feedback-target-hint').classList.contains('hidden'),
    checked: (which) => el(`feedback-target-${which}`).getAttribute('aria-checked'),
    async submit() {
      el('feedback-submit').fire('click');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    type(text) {
      el('feedback-text').value = text;
      el('feedback-text').fire('input');
    },
  };
}

const OPEN_APP = { name: 'Example App', repo_url: 'https://github.com/acme/example-app' };

test('with two destinations, the dialog opens on the open app', () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();

  assert.equal(h.checked('app'), 'true', 'the open app is preselected (#5992)');
  assert.equal(h.checked('platform'), 'false', 'Homeroom is not');
  assert.equal(h.el('feedback-target-app').disabled, false, 'both options are tappable');
  assert.equal(h.el('feedback-target-platform').disabled, false);
  assert.equal(h.el('feedback-submit').disabled, false, 'Post request is live at once');
  assert.equal(h.el('feedback-target').getAttribute('aria-invalid'), null, 'nothing is red');
  assert.equal(h.el('feedback-target-hint').getAttribute('role'), null, 'nor announced');
  assert.equal(h.hintShown(), false, 'no line under the row');
  assert.equal(h.el('feedback-target-hint').textContent, '');
  assert.equal(h.el('feedback-target').getAttribute('aria-describedby'), null);
});

test('tapping Homeroom moves the destination to the platform', () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();
  h.el('feedback-target-platform').fire('click');

  assert.equal(h.checked('platform'), 'true');
  assert.equal(h.checked('app'), 'false');
  assert.equal(h.el('feedback-target').getAttribute('aria-invalid'), null);
  assert.equal(h.hintShown(), false);
  assert.equal(h.el('feedback-submit').disabled, false, 'Submit is live');
});

test('a submit with the default destination files to the open app', async () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();
  h.type('Dragging a card scrolls the board back to the top.');

  await h.submit();

  const [call] = h.filed();
  assert.ok(call, 'it was sent');
  const body = JSON.parse(call.opts.body);
  assert.equal(body.target, 'app', 'no extra tap was needed (#5992)');
  assert.equal(body.appSlug, 'example-app');
});

test('tapping Homeroom then submitting files to the platform', async () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();
  h.type('Dragging a card scrolls the board back to the top.');
  h.el('feedback-target-platform').fire('click');

  await h.submit();

  const [call] = h.filed();
  assert.ok(call, 'it was sent');
  const body = JSON.parse(call.opts.body);
  assert.equal(body.target, 'platform');
  assert.equal(body.appSlug, undefined);
});

test('an empty description is refused alone, and the destination row stays calm', async () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();

  await h.submit();

  assert.equal(h.filed().length, 0, 'nothing was sent');
  assert.equal(h.el('feedback-text-error').classes.has('hidden'), false, 'the description error shows');
  assert.equal(h.el('feedback-target').getAttribute('aria-invalid'), null, 'the row has a destination');
  assert.equal(h.hintShown(), false, 'and nothing is asked of it');
});

// #21: asking for a change from inside an app (Improve.giveFeedback, the
// Workshop "+" menu's row) passes `target: 'app'`. That press was the
// choice, and #5992 makes the open app the default anyway, so `fromDev`
// alone now opens on the app too.
test('#21: opened from inside an app, "This app" is chosen and Submit is live', () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open({ fromDev: true, target: 'app' });

  assert.equal(h.checked('app'), 'true', 'the app the change is for');
  assert.equal(h.checked('platform'), 'false');
  assert.equal(h.hintShown(), false, 'nothing left to ask');
  assert.equal(h.el('feedback-submit').disabled, false);

  const asked = makeHarness({ appData: OPEN_APP });
  asked.open({ fromDev: true });
  assert.equal(asked.checked('app'), 'true', 'fromDev alone opens on the app now (#5992)');
  assert.equal(asked.checked('platform'), 'false');
  assert.equal(asked.el('feedback-submit').disabled, false);
});

test('#21: target app is ignored where "This app" cannot be chosen', () => {
  const selfHosted = makeHarness({ appData: { ...OPEN_APP, self_hosted: true } });
  selfHosted.open({ fromDev: true, target: 'app' });
  assert.equal(selfHosted.checked('platform'), 'true', 'the self-hosted app files to the platform');
  assert.equal(selfHosted.checked('app'), 'false');

  const noRepo = makeHarness({ appData: { name: 'Example App', repo_url: '' } });
  noRepo.open({ fromDev: true, target: 'app' });
  assert.equal(noRepo.checked('platform'), 'true', 'and so does an app with no repository yet');
});

test('with ONE destination it stays selected and Submit is live on open', () => {
  // No app open: "This app" is grayed out, so there is nothing to
  // disambiguate and an extra tap would buy nobody anything.
  const h = makeHarness({ appData: null });
  h.open();

  assert.equal(h.el('feedback-target-app').disabled, true, '"This app" is not selectable');
  assert.equal(h.checked('platform'), 'true', 'the only destination is chosen');
  assert.equal(h.hintShown(), false, 'and nothing asks for a choice that does not exist');
  assert.equal(h.el('feedback-submit').disabled, false, 'Submit is live immediately');
});

test('a self-hosted app is the one-destination case too', () => {
  const h = makeHarness({
    appData: { ...OPEN_APP, self_hosted: true },
  });
  h.open();

  assert.equal(h.el('feedback-target-app').disabled, true);
  assert.equal(h.checked('platform'), 'true');
  assert.equal(h.hintShown(), false);
  assert.equal(h.el('feedback-submit').disabled, false);
});

test('an app with no repo yet keeps its name on the grayed option', () => {
  const h = makeHarness({ appData: { name: 'Example App', repo_url: '' } });
  h.open();

  // The option leads with the app's name, "This app" under it (UI overhaul).
  assert.equal(h.el('feedback-target-app-name').textContent, 'Example App');
  assert.equal(h.el('feedback-target-app-sub').classList.contains('hidden'), false);
  assert.equal(h.el('feedback-target-app').disabled, true);
  assert.equal(h.checked('platform'), 'true');
});

test('a rescued draft hands back the destination its author chose', () => {
  // The stored target is the person's own earlier pick, not a default —
  // re-asking would quietly lose a decision they already made.
  const h = makeHarness({
    appData: OPEN_APP,
    sessionDraft: {
      description: 'The board scrolls back to the top when I drag a card.',
      title: '', titleDirty: false, target: 'platform', savedAt: Date.now(),
    },
  });
  h.open();

  assert.equal(h.checked('platform'), 'true', 'their choice came back with their words');
  assert.equal(h.hintShown(), false);
  assert.equal(h.el('feedback-submit').disabled, false);
});

test('reopening after choosing Homeroom opens on the app again', () => {
  const h = makeHarness({ appData: OPEN_APP });
  h.open();
  h.el('feedback-target-platform').fire('click');
  assert.equal(h.checked('platform'), 'true');

  h.sandbox.Feedback._reset();
  h.open();

  assert.equal(h.checked('app'), 'true', 'the open app is the default again (#5992)');
  assert.equal(h.checked('platform'), 'false', 'an earlier tap is not a remembered choice');
  assert.equal(h.hintShown(), false);
  assert.equal(h.el('feedback-submit').disabled, false);
});

test('a two-destination open does not leak into the next, no-app open', () => {
  // Both destinations picked their own option; the one-destination case
  // that follows still falls back to Homeroom, selected and live.
  const h = makeHarness({ appData: OPEN_APP });
  h.open();
  assert.equal(h.checked('app'), 'true');

  h.sandbox.Feedback._reset();
  h.sandbox.AppView.appData = null;
  h.sandbox.App.currentApp = null;
  h.sandbox.App.currentTab = 'home';
  h.open();

  assert.equal(h.el('feedback-target-app').disabled, true, '"This app" is not selectable');
  assert.equal(h.checked('platform'), 'true', 'the single destination is chosen');
  assert.equal(h.el('feedback-submit').disabled, false, 'Submit is live for the single option');
  assert.equal(h.hintShown(), false);
});

// ── QA 2026-09-24: what the dialog calls itself, and what a failure says ──

test('the dialog is headed Suggest an improvement from every way in', () => {
  // QA 2026-09-24 renamed it per way in ("Suggest an improvement" from the hub's
  // ⋯, "Send feedback" otherwise). Since the UI overhaul it is "Ask for a
  // change" everywhere, so the heading is the markup's own and the
  // controller no longer writes it.
  const tsx = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/dialogs/feedback.tsx'), 'utf8');
  assert.match(tsx, /<h2 className="text-lg font-bold">\s*\{t\('dialogs:feedback\.heading'\)\}\s*<\/h2>\s*<p[^>]*>\s*\{t\('dialogs:feedback\.intro'\)\}\s*<\/p>/);
  assert.equal(message('dialogs:feedback.heading'), 'Suggest an improvement');
  assert.equal(message('dialogs:feedback.intro'), 'Members can see it, vote on it and pick it up.');
  assert.doesNotMatch(CONTROLLER_TEXT, /heading\.textContent|'Send feedback'/);
  const h = makeHarness({ appData: OPEN_APP });
  assert.doesNotThrow(() => h.sandbox.Feedback._open({ fromDev: true, intent: 'issue' }),
    'the hub ⋯ still passes intent, which changes nothing');
});

function failingSubmit(status, error) {
  const h = makeHarness({ appData: OPEN_APP });
  const warns = [];
  h.sandbox.console.warn = (...args) => warns.push(args.join(' '));
  const inner = h.sandbox.fetch;
  h.sandbox.fetch = async (url, opts = {}) => {
    if (url !== '/api/feedback') return inner(url, opts);
    h.fetchCalls.push({ url, opts });
    return { ok: false, status, json: async () => ({ error }) };
  };
  h.open();
  h.el('feedback-target-platform').fire('click');
  h.type('The Workshop list does not remember my scroll position.');
  return { h, warns };
}

test('a server-side refusal reads as plain words; the reason goes to the console', async () => {
  const { h, warns } = failingSubmit(503, 'GitHub token not configured');
  await h.submit();
  assert.equal(h.filed().length, 1, 'the submit did go out');
  const status = h.el('feedback-status');
  assert.equal(status.textContent, "Couldn't file this right now. Please try again later.");
  assert.doesNotMatch(status.textContent, /GitHub token/, 'no server configuration on screen');
  assert.ok(warns.some((w) => /GitHub token not configured/.test(w)), 'the technical reason is kept for whoever debugs it');
});

test('a refusal about what was sent keeps the server\'s own words', async () => {
  const { h } = failingSubmit(409, 'This app has no repository yet. Try platform feedback instead');
  await h.submit();
  assert.equal(h.el('feedback-status').textContent, 'This app has no repository yet. Try platform feedback instead');
});

test('the title hint fits a phone-width field, and the resting heading is sentence case', () => {
  // "Title, generated as you type; edit as you like" was 312px of text in a
  // 300px field at 390px wide, so it read "... edit as you lik". The hint
  // only has to say the title is written for you; that it can be changed is
  // what a text field already says.
  const tsx = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/dialogs/feedback.tsx'), 'utf8');
  const hintId = /id="feedback-title"[\s\S]{0,120}?placeholder=\{t\('([^']*)'\)\}/.exec(tsx);
  assert.ok(hintId, 'the title field carries a hint');
  const hint = [hintId[0], message(hintId[1])];
  assert.equal(hint[1], 'Suggested as you type');
  assert.ok(hint[1].length <= 24, 'short enough for the narrowest supported phone');
  assert.match(tsx, /<h2 className="text-lg font-bold">\s*\{t\('dialogs:feedback\.heading'\)\}\s*<\/h2>/);
  assert.equal(message('dialogs:feedback.heading'), 'Suggest an improvement', 'the heading is sentence case');
});
