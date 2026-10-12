// A first session runs on the live build, not on yesterday's cached one.
//
// ── What happened ──────────────────────────────────────────────────────
//
// Production run-through, 5 Oct 2026, the Homeroom iOS app in the simulator.
// The app had last been opened twelve hours and several deploys earlier. Its
// cold launch lost public/sw.js's 200ms navigation race (by design: one deploy
// behind for one load is the accepted cost) and ran the cached build. A
// brand-new account then signed in on that device and got every old screen:
// the sign-in page without its terms line, the old blocking terms dialog, the
// old Home with its Challenges block, and no "What do you want to make?".
// A force quit later, the same account got the new flow.
//
// #1669's boot-time switch (loadVersion → _reloadPrefetchedShellIfSafe) was
// meant to catch exactly this launch and could not: /api/version is an
// ordinary API read, so on a cold launch slower than the worker's 1s API
// deadline it was answered from the worker's cache, with the previous
// visit's sha. That is the OLD sha, which matches the old document, so the
// first answer said "current" and nothing moved. And nothing looked again
// before the new account's first-run screens were drawn by the old code.
//
// ── The contract this file pins ────────────────────────────────────────
//
//  1. The check that decides asks the server past every cache
//     (`cache: 'no-store'`, which sw.js hands straight to the network).
//  2. SIGNED OUT, on the landing (also an invite's page before Join, and the
//     home of the sign-in sheet) or the sign-in page: a document behind the
//     live build pulls the build into the shell cache and reloads onto it,
//     unless somebody has typed on it or a sign-in has begun on it.
//  3. RIGHT AFTER A SIGN-IN or sign-up (finishLogin, or the waiting room
//     letting somebody in): the same move, before the signed-in shell
//     starts, so no first-run screen is drawn by the old build.
//  4. Never twice for one build in one tab: #1669's sessionStorage latch,
//     shared, so the two switches cannot take turns.
//  5. Somebody signed in and mid-use is untouched: the drawer's row and the
//     pull-to-refresh upgrade stay the only ways forward for them.
//
// The page half runs in a vm against stubs (the same slicing as
// tests/shell-update-prefetch.test.js); the wiring is source-pinned.
//
// Run with: node --test tests/fresh-shell-first-session.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const appJs = read('public/js/app.js');
const authScreensJs = read('public/js/auth-screens.js');
const swJs = read('public/sw.js');
const sharedTs = read('frontend/src/features/auth/shared.ts');
const landingTsx = read('frontend/src/features/auth/landing.tsx');
const waitingTsx = read('frontend/src/features/auth/waiting.tsx');

// One method out of app.js's object literal, by its signature line; it ends
// at the first close at its own indent.
function sliceMethod(src, signature, indent = '  ') {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `${signature} is defined in the source`);
  const close = `\n${indent}}`;
  const end = src.indexOf(close, start);
  assert.ok(end > start, `${signature} terminates at its own indent`);
  return src.slice(start, end + close.length);
}

const METHODS = `({
${sliceMethod(appJs, '_hasUnsavedShellInput() {')},
${sliceMethod(appJs, '_reloadPrefetchedShellIfSafe(sha, { force = false } = {}) {')},
${sliceMethod(appJs, '_ensureShellPrefetch(sha) {')},
${sliceMethod(appJs, 'async loadVersion() {')},
${sliceMethod(appJs, 'renderPlatformVersionPill(info) {')},
${sliceMethod(appJs, 'noteSignInBegun() {')},
${sliceMethod(appJs, 'freshShellVerdict(input) {')},
${sliceMethod(appJs, 'async _askLiveBuild() {')},
${sliceMethod(appJs, '_freshShellInputs(moment, live) {')},
${sliceMethod(appJs, 'async _moveToLiveShell(moment, live) {')},
${sliceMethod(appJs, '_reloadOntoLiveShell(sha) {')}
})`;

const BOOTED = '0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LIVE = '1111111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * A document booted from the worker's cache at BOOTED, while the server runs
 * `live`. `cachedSha` is what the worker's API cache would answer for a plain
 * GET /api/version (the previous visit's answer); a `no-store` request is
 * the only one that reaches the server.
 */
function harness({
  live = LIVE, cachedSha = BOOTED, deploying = false, controller = true,
  route = 'landing', controls = [], sessionThrows = false, search = '',
} = {}) {
  const timers = [];
  const posted = [];
  const requests = [];
  const reloads = [];
  const session = new Map();
  let port = null;
  const slot = { innerHTML: '' };

  const ctx = {
    console,
    Date,
    Promise,
    URLSearchParams,
    AbortController,
    fetch: async (url, init) => {
      assert.equal(url, '/api/version');
      requests.push({ url, init: init || null });
      const fresh = init && init.cache === 'no-store';
      return {
        ok: true,
        json: async () => ({
          sha: fresh ? live : cachedSha,
          deployProgress: fresh && deploying ? { deploying: true, sha: 'next' } : null,
        }),
      };
    },
    location: { search, reload: () => { reloads.push(Date.now()); } },
    sessionStorage: {
      getItem: (key) => { if (sessionThrows) throw new Error('blocked'); return session.get(key) || null; },
      setItem: (key, value) => { if (sessionThrows) throw new Error('blocked'); session.set(key, String(value)); },
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    document: {
      getElementById: (id) => (id === 'platform-version-pill-slot' ? slot : null),
      querySelectorAll: () => controls,
    },
    navigator: {
      serviceWorker: controller ? {
        controller: {
          postMessage: (msg, transfer) => {
            posted.push(msg);
            if (transfer && transfer[0]) port = transfer[0];
          },
        },
      } : {},
    },
    MessageChannel: class {
      constructor() {
        const p1 = { onmessage: null };
        this.port1 = p1;
        this.port2 = { postMessage: (data) => p1.onmessage && p1.onmessage({ data }) };
      }
    },
  };
  ctx.window = { AuthScreens: { _current: route } };
  ctx.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(ctx);

  const App = Object.assign({
    user: null,
    embeddedPanel: false,
    loadedPlatformSha: BOOTED,
    shellUpdate: null,
    _shellAutoReloadSha: null,
    _shellReloadStarted: null,
    _shellPrefetchSettled: null,
    _lastVersionInfo: null,
    _platformUpdateShot: false,
    _signInBegun: false,
    SHELL_PREFETCH_TIMEOUT_MS: 30_000,
    SHELL_AUTO_RELOAD_KEY: 'usernode-shell-auto-reload',
    FRESH_SHELL_CHECK_TIMEOUT_MS: 5000,
    FRESH_SHELL_WAIT_MS: 10_000,
    ImproveStatus: { refreshDeployDot() {} },
  }, vm.runInContext(METHODS, ctx));
  ctx.App = App;

  return {
    App,
    ctx,
    posted,
    requests,
    reloads,
    session,
    timers,
    /** The worker's answer to the prefetch, down the port the page handed it. */
    reply: (data) => port.postMessage(data),
    /** Fire every pending timer: the move's wait, the prefetch's bail-out. */
    fireTimeouts: () => { const t = timers.splice(0); t.forEach(({ fn }) => fn()); },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 'pending' when `promise` has not settled after the queue drains. */
async function settled(promise) {
  const marker = {};
  const value = await Promise.race([promise, flush().then(() => marker)]);
  return value === marker ? 'pending' : value;
}

// ─── 1. The question goes to the server ────────────────────────────────

test('the check asks the server past the worker cache and the HTTP cache', async () => {
  const h = harness();
  const answer = await h.App._askLiveBuild();
  assert.equal(answer.sha, LIVE);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].init.cache, 'no-store',
    'a plain read is answered from the worker cache with the previous visit\'s sha');
  assert.equal(h.requests[0].init.credentials, 'same-origin');
});

test('sw.js hands a no-store request straight to the network', () => {
  // The whole check rests on this bypass. If it goes, the move reads the
  // cached sha again and goes quiet on exactly the launch it exists for.
  assert.match(swJs, /if \(req\.cache === 'no-store'\) return;/);
  const at = swJs.indexOf("if (req.cache === 'no-store') return;");
  assert.ok(at < swJs.indexOf('event.respondWith(networkFirstApi(event))'),
    'before any strategy can answer it from a cache');
});

test('a document that cannot be behind asks nothing at all', async () => {
  for (const setup of [
    (h) => { h.ctx.navigator.serviceWorker = {}; },
    (h) => { h.App.loadedPlatformSha = null; },
    (h) => { h.App.embeddedPanel = true; },
  ]) {
    const h = harness();
    setup(h);
    assert.equal(await h.App._askLiveBuild(), null);
    assert.equal(h.requests.length, 0);
  }
});

// ─── 2. Signed out: move before anybody starts signing in ──────────────

test('a signed-out landing on a stale cached build moves to the live build', async () => {
  const h = harness();
  const moving = h.App._moveToLiveShell('signed-out');
  await flush();
  assert.equal(h.posted.length, 1, 'the build is pulled into the shell cache first');
  assert.equal(h.posted[0].type, 'prefetch-shell');
  assert.equal(h.posted[0].sha, LIVE);
  assert.equal(h.reloads.length, 0, 'no reload before the cache holds the live build');

  h.reply({ ok: true, sha: LIVE });
  await flush();
  assert.equal(h.reloads.length, 1, 'then one reload onto it');
  assert.equal(h.session.get(h.App.SHELL_AUTO_RELOAD_KEY), LIVE, 'latched across the reload');
  assert.equal(await settled(moving), 'pending', 'and the move never resolves once it reloads');
});

test('it catches the launch #1669 missed: the cached /api/version said "current"', async () => {
  // The worker answers loadVersion's plain read from its cache (BOOTED), so
  // the boot-time switch is never armed. The move's own check is not fooled.
  const h = harness({ cachedSha: BOOTED, live: LIVE });
  await h.App.loadVersion();
  assert.equal(h.App._shellAutoReloadSha, null, 'the cached answer looks current');
  assert.equal(h.posted.length, 0);

  h.App._moveToLiveShell('signed-out');
  await flush();
  h.reply({ ok: true, sha: LIVE });
  await flush();
  assert.equal(h.reloads.length, 1);
});

test('on the sign-in page, the invite page and the landing alike', async () => {
  for (const route of ['landing', 'login', 'signup']) {
    const h = harness({ route });
    h.App._moveToLiveShell('signed-out');
    await flush();
    h.reply({ ok: true, sha: LIVE });
    await flush();
    assert.equal(h.reloads.length, 1, `#${route} has nothing to lose`);
  }
});

test('typed text on a signed-out screen holds the move', async () => {
  // Like #1669's switch, which never discards a draft: an address or a
  // password half typed into the sign-in sheet is not wiped by a reload
  // nobody asked for. The sign-in they are typing toward moves them anyway
  // ('signed-in'), before any first-run screen is drawn.
  const email = () => ({
    tagName: 'INPUT', type: 'email', value: 'ada@example.com',
    defaultValue: '', disabled: false, isContentEditable: false,
  });
  const before = harness({ controls: [email()] });
  assert.equal(before.App._hasUnsavedShellInput(), true);
  assert.equal(await before.App._moveToLiveShell('signed-out'), false);
  assert.equal(before.posted.length, 0, 'nothing is even downloaded for it');

  // …and typing that starts while the build is coming down.
  const controls = [];
  const during = harness({ controls });
  const moving = during.App._moveToLiveShell('signed-out');
  await flush();
  controls.push(email());
  during.reply({ ok: true, sha: LIVE });
  await flush();
  assert.equal(during.reloads.length, 0, 'the address stays where they typed it');
  assert.equal(await moving, false);
  assert.equal(during.session.get(during.App.SHELL_AUTO_RELOAD_KEY), undefined,
    'and the latch is left for the move after the sign-in');

  // The sign-in itself still moves, fields full or not.
  const after = harness({ controls: [email()] });
  const signingIn = after.App._moveToLiveShell('signed-in');
  await flush();
  after.reply({ ok: true, sha: LIVE });
  await flush();
  assert.equal(after.reloads.length, 1);
  assert.equal(await settled(signingIn), 'pending');
});

test('a sign-in that has begun is never cut off', async () => {
  const before = harness();
  before.App.noteSignInBegun();
  assert.equal(await before.App._moveToLiveShell('signed-out'), false);
  assert.equal(before.posted.length, 0, 'nothing is even downloaded for it');

  // …and one that begins while the build is coming down.
  const during = harness();
  const moving = during.App._moveToLiveShell('signed-out');
  await flush();
  during.App.noteSignInBegun();
  during.reply({ ok: true, sha: LIVE });
  await flush();
  assert.equal(during.reloads.length, 0, 'the request in flight is left to finish');
  assert.equal(await moving, false);
  assert.equal(during.session.get(during.App.SHELL_AUTO_RELOAD_KEY), undefined,
    'and the latch is left for the move after the sign-in');
});

test('screens that hold answers or a token mid-way are left alone', async () => {
  for (const route of ['waitlist', 'more', 'register', 'reset-password', 'waiting', null]) {
    const h = harness({ route });
    assert.equal(await h.App._moveToLiveShell('signed-out'), false, `#${route}`);
    assert.equal(h.posted.length, 0);
    assert.equal(h.reloads.length, 0);
  }
});

test('a current build stays put and downloads nothing', async () => {
  const h = harness({ live: BOOTED });
  assert.equal(await h.App._moveToLiveShell('signed-out'), false);
  assert.equal(h.posted.length, 0);
  assert.equal(h.reloads.length, 0);
});

test('a rollout in progress is not a build to move to', async () => {
  const h = harness({ deploying: true });
  assert.equal(await h.App._moveToLiveShell('signed-out'), false);
  assert.equal(h.posted.length, 0);
});

test('a download that does not arrive in time stays rather than reloading late', async () => {
  const h = harness();
  const moving = h.App._moveToLiveShell('signed-out');
  await flush();
  const wait = h.timers.find((t) => t.ms === h.App.FRESH_SHELL_WAIT_MS);
  assert.ok(wait, 'the move waits a bounded time');
  wait.fn();
  assert.equal(await moving, false);
  assert.equal(h.reloads.length, 0);
});

test('a failed download does not reload onto the old build', async () => {
  const h = harness();
  const moving = h.App._moveToLiveShell('signed-out');
  await flush();
  h.reply({ ok: false, sha: LIVE });
  assert.equal(await moving, false);
  assert.equal(h.reloads.length, 0);
});

test('screenshot states are never moved', async () => {
  const h = harness({ search: '?shot=anon' });
  assert.equal(await h.App._moveToLiveShell('signed-out'), false);
  assert.equal(h.requests.length, 0);
});

// ─── 3. Right after a sign-in: before the signed-in shell starts ───────

test('a sign-in on a stale build moves before the signed-in shell starts', async () => {
  const h = harness({ route: null });
  h.App.user = { id: 7 };
  h.App.noteSignInBegun();
  const moving = h.App._moveToLiveShell('signed-in');
  await flush();
  assert.equal(h.posted.length, 1);
  h.reply({ ok: true, sha: LIVE });
  await flush();
  assert.equal(h.reloads.length, 1);
  assert.equal(await settled(moving), 'pending',
    'finishLogin never reaches enterAuthed on the old build');
});

test('it reuses a check started alongside the session read', async () => {
  const h = harness({ route: null });
  const live = h.App._askLiveBuild();
  h.App._moveToLiveShell('signed-in', live);
  await flush();
  assert.equal(h.requests.length, 1, 'one question, asked once');
  h.reply({ ok: true, sha: LIVE });
  await flush();
  assert.equal(h.reloads.length, 1);
});

test('a download that failed earlier in the document is asked for once more', async () => {
  const h = harness({ route: null });
  h.App.shellUpdate = { sha: LIVE, state: 'failed' };
  h.App._moveToLiveShell('signed-in');
  await flush();
  assert.equal(h.posted.length, 1, 'a sign-in is a moment of its own');
  h.reply({ ok: true, sha: LIVE });
  await flush();
  assert.equal(h.reloads.length, 1);
});

test('a current build signs straight in', async () => {
  const h = harness({ live: BOOTED, route: null });
  assert.equal(await h.App._moveToLiveShell('signed-in'), false);
  assert.equal(h.posted.length, 0);
  assert.equal(h.reloads.length, 0);
});

// ─── 4. Never a loop ───────────────────────────────────────────────────

test('one forced reload per build per tab', async () => {
  // The reload already happened once for LIVE and the page is somehow still
  // the old build: it stays, and the drawer's row is the way forward.
  for (const moment of ['signed-out', 'signed-in']) {
    const h = harness();
    h.session.set(h.App.SHELL_AUTO_RELOAD_KEY, LIVE);
    assert.equal(await h.App._moveToLiveShell(moment), false, moment);
    assert.equal(h.posted.length, 0);
    assert.equal(h.reloads.length, 0);
  }
});

test('a newer deploy is a new build, with its own one reload', async () => {
  const h = harness({ live: '2222222ccccccccccccccccccccccccccccccccc' });
  h.session.set(h.App.SHELL_AUTO_RELOAD_KEY, LIVE);
  h.App._moveToLiveShell('signed-out');
  await flush();
  h.reply({ ok: true, sha: '2222222ccccccccccccccccccccccccccccccccc' });
  await flush();
  assert.equal(h.reloads.length, 1);
});

test('without sessionStorage nothing proves it will not loop, so it stays', async () => {
  const h = harness({ sessionThrows: true });
  const moving = h.App._moveToLiveShell('signed-out');
  await flush();
  h.reply({ ok: true, sha: LIVE });
  assert.equal(await moving, false);
  assert.equal(h.reloads.length, 0);
});

test('#1669\'s switch and this move share one download and one reload', async () => {
  // An honest first answer arms the boot-time switch too. Both wait on the
  // same prefetch; whichever goes first, the page reloads once.
  const h = harness({ cachedSha: LIVE });
  await h.App.loadVersion();
  assert.equal(h.App._shellAutoReloadSha, LIVE);
  const moving = h.App._moveToLiveShell('signed-out');
  await flush();
  assert.equal(h.posted.length, 1, 'one download, joined');
  h.reply({ ok: true, sha: LIVE });
  await flush();
  assert.equal(h.reloads.length, 1);
  assert.equal(await settled(moving), 'pending');
  assert.equal(await settled(h.App._moveToLiveShell('signed-in')), 'pending',
    'a later caller waits for the page to go, rather than drawing on it');
  assert.equal(h.reloads.length, 1);
});

// ─── 5. The rule as one table ──────────────────────────────────────────

test('the verdict, case by case', () => {
  const { App } = harness();
  const base = {
    moment: 'signed-out', documentSha: BOOTED, live: { sha: LIVE, deploying: false },
    controlled: true, embedded: false, signedIn: false, signInBegun: false, typed: false,
    route: 'landing', latched: null,
  };
  const verdict = (patch) => App.freshShellVerdict({ ...base, ...patch });
  assert.equal(verdict({}), 'upgrade', 'stale and signed out');
  assert.equal(verdict({ live: { sha: BOOTED } }), 'current', 'fresh');
  assert.equal(verdict({ signedIn: true }), 'signed-in', 'signed in mid-use');
  assert.equal(verdict({ signInBegun: true }), 'sign-in-begun');
  assert.equal(verdict({ typed: true }), 'typed', 'a half-typed address or password');
  assert.equal(verdict({ route: 'waitlist' }), 'route');
  assert.equal(verdict({ latched: LIVE }), 'latched', 'the loop guard');
  assert.equal(verdict({ latched: BOOTED }), 'upgrade', 'a latch for another build');
  assert.equal(verdict({ live: { sha: LIVE, deploying: true } }), 'deploying');
  assert.equal(verdict({ live: null }), 'unknown');
  assert.equal(verdict({ live: { sha: 'dev' } }), 'unknown');
  assert.equal(verdict({ controlled: false }), 'uncontrolled');
  assert.equal(verdict({ documentSha: null }), 'unstamped');
  assert.equal(verdict({ embedded: true }), 'side-panel');
  assert.equal(verdict({
    moment: 'signed-in', signedIn: true, signInBegun: true, typed: true, route: null,
  }), 'upgrade', 'right after a sign-in');
  assert.equal(verdict({ moment: 'signed-in', latched: LIVE }), 'latched');
  assert.equal(verdict({ moment: 'mid-use' }), 'moment', 'no other moment moves anybody');
});

// ─── 6. Wiring ─────────────────────────────────────────────────────────

/** A method's body by its signature, for the source pins below. */
function body(src, signature) {
  return sliceMethod(src, signature);
}

test('the signed-out move starts with the anonymous boot, after the screens are up', () => {
  const anon = body(appJs, 'async enterAnonymous() {');
  const enter = anon.indexOf('AuthScreens.enter()');
  const move = anon.indexOf("App._moveToLiveShell('signed-out');");
  assert.ok(enter > 0 && move > enter, 'the landing paints first; the move is not awaited');
  assert.doesNotMatch(anon, /await App\._moveToLiveShell/);
});

test('nobody signed in and mid-use is ever moved by it', () => {
  // The move has exactly three doors: the anonymous boot, finishLogin and the
  // waiting room's release. The signed-in shell, its poll, its pushed
  // version and its pill keep #1669's switch and the button, unchanged.
  for (const signature of [
    'enterAuthed(user) {', 'async loadVersion() {', 'handlePlatformVersion(data) {',
    'renderPlatformVersionPill(info) {', '_refreshOrReload(refresh) {',
    'async _reconcileSession(',
  ]) {
    assert.doesNotMatch(body(appJs, signature), /_moveToLiveShell|_reloadOntoLiveShell/, signature);
  }
  const callers = appJs.match(/App\._moveToLiveShell\(/g) || [];
  assert.equal(callers.length, 1, 'app.js calls it from enterAnonymous only');
});

test('finishLogin asks alongside the session read and moves before enterAuthed', () => {
  const finish = authScreensJs.slice(authScreensJs.indexOf('async finishLogin(opts) {'));
  const ask = finish.indexOf('App._askLiveBuild()');
  const me = finish.indexOf("fetch('/api/auth/me'");
  const replace = finish.indexOf("history.replaceState(null, '', AuthScreens.deepLinkUrl(target));");
  const move = finish.indexOf("await App._moveToLiveShell('signed-in', liveShell);");
  const enter = finish.indexOf('App.enterAuthed(user);\n        }, \'pop\');');
  assert.ok(ask > 0 && ask < me, 'the check goes out with the session read, not after it');
  assert.ok(replace > 0 && move > replace, 'the reload lands on the restored deep link');
  assert.ok(enter > move, 'and the signed-in shell starts only if it stays');
});

// finishLogin, executed: the same harness shape as
// tests/login-session-confirmation.test.js, with an App that records the move.
function loginHarness({ moveResult = false, search = '', user = { id: 7, hasPlatformAccess: true } } = {}) {
  const order = [];
  const location = { search, hash: '#login', pathname: '/', origin: 'https://homeroom.example', href: '/#login' };
  const element = { classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, style: {} };
  const liveShell = Promise.resolve({ sha: LIVE, deploying: false });
  const sandbox = {
    URL, URLSearchParams, AbortController, console, location,
    setTimeout() { return 1; }, clearTimeout() {},
    history: { replaceState(_s, _t, url) { location.href = url; order.push(`url:${url}`); } },
    document: {
      addEventListener() {}, getElementById: () => element, querySelector: () => element,
      querySelectorAll: () => [], body: element, documentElement: element,
    },
    addEventListener() {}, localStorage: { getItem() { return null; } },
    App: {
      clearSessionSnapshot() {},
      enterAuthed(u) { order.push(`enter:${u.id}`); },
      _askLiveBuild() { order.push('ask'); return liveShell; },
      _moveToLiveShell(moment, live) {
        order.push(`move:${moment}:${live === liveShell}`);
        return moveResult === 'reload' ? new Promise(() => {}) : Promise.resolve(moveResult);
      },
    },
    fetch(url) {
      order.push(`fetch:${url}`);
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ user }) });
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(authScreensJs, sandbox);
  return { auth: sandbox.AuthScreens, order, location };
}

test('finishLogin: a stale page reloads instead of starting the signed-in shell', async () => {
  const h = loginHarness({ moveResult: 'reload' });
  h.auth._pendingHash = '/invite/YigKXxtTzBB_TFZVTkjEtg';
  const finishing = h.auth.finishLogin();
  assert.equal(await settled(finishing), 'pending', 'the sign-in stays busy until the page goes');
  assert.deepEqual(h.order, [
    'ask',
    'fetch:/api/auth/me',
    'url:/invite/YigKXxtTzBB_TFZVTkjEtg',
    'move:signed-in:true',
  ], 'the invite link is the address the reload lands on');
  assert.ok(!h.order.some((step) => step.startsWith('enter:')),
    'no first-run screen is drawn by the old build');
});

test('finishLogin: a current page signs straight in, as before', async () => {
  const h = loginHarness({ moveResult: false });
  h.auth._pendingHash = '#app/example';
  assert.equal(await h.auth.finishLogin(), null);
  assert.deepEqual(h.order.slice(-2), ['move:signed-in:true', 'enter:7']);
  assert.equal(h.location.href, '/#app/example');
  assert.equal(h.auth._pendingHash, '');
});

test('finishLogin: a sign-in that returns to another document asks nothing', async () => {
  const h = loginHarness({ search: '?return_to=%2Fcli%2Fauthorize' });
  await h.auth.finishLogin();
  assert.equal(h.location.href, '/cli/authorize');
  assert.ok(!h.order.includes('ask'));
  assert.ok(!h.order.some((step) => step.startsWith('move:')));
});

test('finishLogin: an account still waiting goes to the waiting room, which moves on release', async () => {
  const h = loginHarness({ user: { id: 7, hasPlatformAccess: false } });
  await h.auth.finishLogin();
  assert.ok(!h.order.some((step) => step.startsWith('move:')));
  assert.ok(h.order.includes('enter:7'));
  const release = waitingTsx.slice(waitingTsx.indexOf('if (user.hasPlatformAccess) {'));
  const replace = release.indexOf("history.replaceState(null, '', targetUrl);");
  const move = release.indexOf("await w.App?._moveToLiveShell?.('signed-in');");
  const enter = release.indexOf('w.App?.enterAuthed?.(user);');
  assert.ok(replace > 0 && move > replace && enter > move,
    'the waiting room restores the deep link, moves, and only then starts the shell');
});

// ─── 7. Where a sign-in is heard to begin ──────────────────────────────

function loadAuthShared(window, fetchImpl) {
  const compiled = ts.transpileModule(sharedTs, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    window,
    fetch: fetchImpl,
    console: { warn() {} },
    require(specifier) {
      if (specifier === '../../lib/legacy-dom') return { useIsomorphicLayoutEffect() {} };
      if (specifier === '../../lib/i18n/runtime') return englishPlatformI18n();
      throw new Error(`unexpected auth shared import: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(compiled, sandbox);
  return module.exports;
}

test('every credential exchange tells the shell before it sends', async () => {
  let heard = 0;
  const window = { App: { user: null, noteSignInBegun() { heard += 1; } }, Offline: { isOffline: () => false } };
  const shared = loadAuthShared(window, async () => ({ ok: true, status: 200, json: async () => ({}) }));

  assert.equal(shared.blockedOffline(), false);
  assert.equal(heard, 1, 'the guard every exchange runs first');

  await shared.fetchSessionMint('/api/auth/login', { method: 'POST', body: '{}' });
  assert.equal(heard, 2, 'and every session mint, whichever screen sent it');

  window.Offline.isOffline = () => true;
  window.Offline.nudge = () => {};
  assert.equal(shared.blockedOffline(), true);
  assert.equal(heard, 2, 'an exchange refused offline never began');
});

test('a provider\'s trip back counts as a sign-in already under way', () => {
  const effect = landingTsx.slice(landingTsx.indexOf('const result = takeProviderResult();'));
  const note = effect.indexOf('noteSignInBegun();');
  assert.ok(note > 0 && note < effect.indexOf('setResume(result);'),
    'the result is read once, so a reload would lose where the sign-in had got to');
});
