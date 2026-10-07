'use strict';

// A staging preview shown as of a chosen moment (src/services/preview-clock.js).
//
// On 5 October 2026 a group was asked to approve a Thursday-evening bins
// reminder that nobody could see: Try it opened the preview on a Monday, and
// the shots agent reported the banner "can't be made to appear". A change may
// now declare the moment it should be seen at, in its testing guidance:
//
//   <!-- usernode:preview-at 2026-10-08T19:00 Europe/London -->
//
// and the preview opens there with `?un-now=<instant>` on its address. These
// tests run the real pieces: the declaration parser, the TESTING block parser
// that carries it, the bridge's clock block in a vm, the scaffold's `req.now`
// middleware, AppView.swapToStaging over the real staging bridge and store,
// and the overlay island's render.
//
// Run with: node --test tests/preview-clock.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const clock = require('../src/services/preview-clock');
const testingNotes = require('../src/services/testing-notes');

const DECLARED = '<!-- usernode:preview-at 2026-10-08T19:00 Europe/London -->';

// ── The declaration ──────────────────────────────────────────────────────

test('a declared local time and zone becomes the instant and the plain words', () => {
  assert.deepEqual(clock.declaredMoment(`Open the rota.\n${DECLARED}\n`), {
    at: '2026-10-08T18:00:00.000Z', // British Summer Time is UTC+1
    zone: 'Europe/London',
    local: '2026-10-08T19:00',
    label: 'Thursday 8 Oct, 7 pm',
  });
  // Winter in London is UTC, and minutes show only when there are some.
  assert.deepEqual(clock.parseMoment('2026-12-10T19:30', 'Europe/London'), {
    at: '2026-12-10T19:30:00.000Z', zone: 'Europe/London', local: '2026-12-10T19:30',
    label: 'Thursday 10 Dec, 7:30 pm',
  });
  assert.equal(clock.parseMoment('2026-12-25T00:00', 'America/New_York').at, '2026-12-25T05:00:00.000Z');
  assert.equal(clock.parseMoment('2026-12-25T00:00', 'America/New_York').label, 'Friday 25 Dec, 12 am');
  assert.equal(clock.parseMoment('2026-12-25T12:00', 'America/New_York').label, 'Friday 25 Dec, 12 pm');
});

test('no zone means UTC, and UTC says so; an offset may stand in for the zone', () => {
  assert.deepEqual(clock.parseMoment('2026-10-08T18:00'), {
    at: '2026-10-08T18:00:00.000Z', zone: 'UTC', local: '2026-10-08T18:00',
    label: 'Thursday 8 Oct, 6 pm UTC',
  });
  assert.equal(clock.parseMoment('2026-10-08T18:00Z').at, '2026-10-08T18:00:00.000Z');
  const offset = clock.parseMoment('2026-10-08T19:00+01:00', 'Europe/London');
  assert.equal(offset.at, '2026-10-08T18:00:00.000Z');
  assert.equal(offset.label, 'Thursday 8 Oct, 7 pm', 'written in the zone it names');
  assert.equal(clock.parseMoment('2026-10-08T19:00:30+01:00').label, 'Thursday 8 Oct, 6 pm UTC');
});

test('a time skipped by the clocks going forward lands an hour on, as a clock shows', () => {
  // 01:30 on 29 March 2026 does not exist in London.
  const m = clock.parseMoment('2026-03-29T01:30', 'Europe/London');
  assert.equal(m.at, '2026-03-29T01:30:00.000Z');
  assert.equal(m.label, 'Sunday 29 Mar, 2:30 am');
});

test('anything that is not a real moment is ignored, never an error', () => {
  for (const [time, zone] of [
    ['2026-02-31T10:00', 'UTC'], // no such date
    ['2026-10-08T24:00', 'UTC'],
    ['2026-10-08T19:60', 'UTC'],
    ['2026-10-08 19:00', 'UTC'], // not ISO
    ['Thursday', 'UTC'],
    ['2026-10-08', 'UTC'], // a date is not a moment
    ['1999-10-08T19:00', 'UTC'], // out of range
    ['2026-10-08T19:00+15:00', null],
    ['2026-10-08T19:00', 'Mars/Olympus_Mons'], // no such zone
  ]) {
    assert.equal(clock.parseMoment(time, zone), null, `${time} ${zone}`);
  }
  assert.equal(clock.declaredMoment(''), null);
  assert.equal(clock.declaredMoment(null), null);
  assert.equal(clock.declaredMoment('usernode:preview-at 2026-10-08T19:00 (not a comment)'), null);
});

test('the first valid declaration wins, and the marker tolerates spacing and case', () => {
  const text = [
    '<!-- usernode:preview-at 2026-02-31T19:00 UTC -->', // invalid, skipped
    '<!--usernode:preview-at   2026-10-09T08:00   Europe/London-->',
    '<!-- USERNODE:PREVIEW-AT 2026-10-10T08:00 -->',
  ].join('\n');
  assert.equal(clock.declaredMoment(text).label, 'Friday 9 Oct, 8 am');
});

test('a session answers with its moment, or with nothing at all', () => {
  assert.deepEqual(clock.previewAnswer({ testing_md: `1. Open the rota.\n${DECLARED}` }), {
    previewAt: { at: '2026-10-08T18:00:00.000Z', label: 'Thursday 8 Oct, 7 pm', zone: 'Europe/London' },
  });
  assert.deepEqual(clock.previewAnswer({ testing_md: '1. Open the rota.' }), {});
  assert.deepEqual(clock.previewAnswer(null), {});
  assert.equal(clock.PREVIEW_NOW_PARAM, 'un-now', 'namespaced like token and un-theme');
  assert.equal(clock.PREVIEW_NOW_HEADER, 'x-usernode-now');
});

test('the TESTING block keeps the declaration and its paths, in either order', () => {
  for (const block of [
    `==== TESTING ====\n${DECLARED}\npath: /rota\n1. Open the rota.\n==== END TESTING ====`,
    `==== TESTING ====\npath: /rota\n${DECLARED}\n1. Open the rota.\n==== END TESTING ====`,
  ]) {
    const out = testingNotes.extract(`Built it.\n\n${block}`);
    assert.equal(out.cleanedText, 'Built it.');
    assert.deepEqual(out.testingPaths, [{ path: '/rota', viewport: 'desktop' }],
      'a declaration before the paths does not swallow them into the steps');
    assert.equal(out.testingMd, `${DECLARED}\n1. Open the rota.`);
    assert.equal(clock.declaredMoment(out.testingMd).label, 'Thursday 8 Oct, 7 pm');
  }
  // In the steps it is simply part of them, and still found.
  const late = testingNotes.extract(`==== TESTING ====\npath: /rota\n1. Open it.\n${DECLARED}\n==== END TESTING ====`);
  assert.equal(late.testingMd, `1. Open it.\n${DECLARED}`);
  // Without one, nothing changes.
  const plain = testingNotes.extract('==== TESTING ====\npath: /rota\n1. Open it.\n==== END TESTING ====');
  assert.equal(plain.testingMd, '1. Open it.');
});

test('the declaration reaches the pull request body inside "How to test", where it shows to nobody', () => {
  const { buildTestingBlock } = require('../src/services/pr-metadata');
  const body = buildTestingBlock(`${DECLARED}\n1. Open the rota.`, '/rota');
  assert.ok(body.includes(DECLARED), 'carried verbatim, as an HTML comment');
});

// ── The bridge ───────────────────────────────────────────────────────────

const BRIDGE = read('public/usernode-bridge/v1/bridge.js');
const CLOCK_BLOCK = BRIDGE.slice(
  BRIDGE.indexOf('/* __USERNODE_CLOCK_BEGIN__ */'),
  BRIDGE.indexOf('/* __USERNODE_CLOCK_END__ */'),
);

function runClock(href, { now = Date.parse('2026-10-05T09:00:00.000Z') } = {}) {
  const url = new URL(href);
  let current = now;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [current])); }
    static now() { return current; }
  }
  const win = {
    location: { protocol: url.protocol, hostname: url.hostname, search: url.search },
    usernode: {},
  };
  vm.runInNewContext(CLOCK_BLOCK, { window: win, URLSearchParams, Date: FakeDate, isFinite, String });
  return { usernode: win.usernode, advance(ms) { current += ms; } };
}

const AT = '2026-10-08T18:00:00.000Z';

test('the bridge block is delimited, and both bridge copies carry it', () => {
  assert.ok(CLOCK_BLOCK.length > 200);
  assert.equal(read('public/usernode-bridge.js'), BRIDGE, 'the unversioned mirror matches');
  assert.ok(!/document\./.test(CLOCK_BLOCK), 'it reports a time and never touches the page');
});

test('a staging preview reads ?un-now= into usernode.now(), and the clock keeps ticking', () => {
  const b = runClock(`https://bins-1a2b3c--s6295.onhomeroom.com/?token=t&un-theme=dark&un-now=${encodeURIComponent(AT)}`);
  assert.equal(b.usernode.previewNow, AT);
  assert.equal(b.usernode.now().toISOString(), AT);
  b.advance(90_000);
  assert.equal(b.usernode.now().toISOString(), '2026-10-08T18:01:30.000Z', 'time passes from the moment');
});

test('production ignores it entirely: a production app address never reads un-now', () => {
  const real = '2026-10-05T09:00:00.000Z';
  for (const href of [
    `https://bins-1a2b3c.onhomeroom.com/?un-now=${AT}`,
    `https://bins-1a2b3c.apps.example.org/feed?token=t&un-now=${AT}`,
  ]) {
    const b = runClock(href);
    assert.equal(b.usernode.previewNow, null, href);
    assert.equal(b.usernode.now().toISOString(), real, `${href}: the real time`);
  }
});

test('the before & after copies and local runs honour it; junk never does', () => {
  for (const href of [
    `http://usernode-shots-12-head.social-apps.svc:3000/?un-now=${AT}`, // the shots copies
    `http://127.0.0.1:4100/?un-now=${AT}`, // the in-loop browser
    `http://localhost:3000/?un-now=${AT}`,
    `https://bins.localhost/?un-now=${AT}`,
  ]) {
    assert.equal(runClock(href).usernode.previewNow, AT, href);
  }
  for (const value of ['2026-10-08T18:00', 'Thursday', '2026-10-08', 'nonsense']) {
    const b = runClock(`https://bins-1a2b3c--s6295.onhomeroom.com/?un-now=${encodeURIComponent(value)}`);
    assert.equal(b.usernode.previewNow, null, `${value}: only a full instant with a zone`);
    assert.equal(b.usernode.now().toISOString(), '2026-10-05T09:00:00.000Z');
  }
  const none = runClock('https://bins-1a2b3c--s6295.onhomeroom.com/');
  assert.equal(none.usernode.previewNow, null);
  assert.equal(typeof none.usernode.now, 'function', 'usernode.now() exists everywhere, production included');
});

// ── The scaffold's server: req.now ───────────────────────────────────────

function scaffoldNow(env) {
  const { getTemplateFiles } = require('../src/services/template');
  const server = getTemplateFiles('Bins', 'bins-1a2b3c', 'postgres://x').find((f) => f.path === 'server.js').content;
  const from = server.indexOf('const IS_STAGING');
  const to = server.indexOf('\n}\n', server.indexOf('function requestNow(req)', from)) + 3;
  assert.ok(from > 0 && to > from, 'server.js carries the requestNow helper');
  // The sign-in middleware, every request's first stop, sets req.now from it.
  assert.match(server, /app\.use\(\(req, res, next\) => \{\n {2}req\.now = requestNow\(req\);/);
  const ctx = { process: { env }, Date };
  vm.runInNewContext(`${server.slice(from, to)}\nthis.requestNow = requestNow;`, ctx);
  return (headers = {}, query = {}) => ctx.requestNow({ headers, query });
}

test('production ignores it entirely: a production server never reads the header or the query', () => {
  for (const env of [{ USERNODE_ENV: 'production' }, {}]) {
    const now = scaffoldNow(env);
    const before = Date.now();
    const got = now({ 'x-usernode-now': AT }, { 'un-now': AT });
    assert.ok(got instanceof Date);
    assert.ok(got.getTime() >= before && got.getTime() <= Date.now(), `${env.USERNODE_ENV || 'unset'}: the real time`);
  }
});

test('a staging server reads the page\'s header, or the address on a page load', () => {
  const now = scaffoldNow({ USERNODE_ENV: 'staging' });
  assert.equal(now({ 'x-usernode-now': AT }).toISOString(), AT);
  assert.equal(now({}, { 'un-now': AT }).toISOString(), AT);
  assert.equal(now({ 'x-usernode-now': '2026-10-08T19:00:00+01:00' }).toISOString(), AT);
  const before = Date.now();
  for (const junk of ['Thursday', '2026-10-08T18:00', ['a', 'b']]) {
    const got = now({ 'x-usernode-now': junk }).getTime();
    assert.ok(got >= before, `${junk}: falls back to the real time`);
  }
});

test('every starter\'s api() helper sends the page\'s time on a preview opened at a moment', () => {
  // The four starters were deleted with the create dialog
  // (tests/app-templates.test.js); one that comes back keeps the rule.
  const dir = require('node:path').join(__dirname, '..', 'app-templates');
  const names = require('node:fs').existsSync(dir) ? require('node:fs').readdirSync(dir) : [];
  for (const name of names) {
    const src = read(`app-templates/${name}/public/app.js`);
    assert.match(src,
      /if \(window\.usernode && window\.usernode\.previewNow\) headers\['x-usernode-now'\] = window\.usernode\.now\(\)\.toISOString\(\);/,
      name);
  }
});

// ── Try it: the preview opens at the moment, and says so ────────────────

function makeIframe() {
  const el = {
    id: 'staging-iframe', loads: 0, _src: '', contentWindow: { n: 0 }, onload: null, onerror: null,
    style: {}, classList: { add() {}, remove() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {},
  };
  Object.defineProperty(el, 'src', {
    get() { return el._src; },
    set(v) { el._src = v; if (v) { el.loads += 1; el.contentWindow = { n: el.loads }; } },
  });
  return el;
}

async function makeShell({ react = true, fetch = async () => ({ ok: true, json: async () => ({}) }) } = {}) {
  const storeMod = await import(new URL('../frontend/src/features/staging/staging-store.js', `file://${__filename}`).href);
  const bridgeMod = await import(new URL('../frontend/src/features/staging/staging-bridge.js', `file://${__filename}`).href);
  storeMod.stagingStore.set({ open: false, clockLabel: '', clockAsNow: false });
  for (const key of Object.keys(storeMod.stagingHandlers)) storeMod.stagingHandlers[key] = null;
  const iframe = makeIframe();
  storeMod.stagingRefs.iframe = iframe;
  const byId = { 'staging-iframe': iframe };
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, debug() {} },
    App: { user: { id: 1 }, currentTab: 'dev' },
    document: {
      getElementById: (id) => byId[id] || null,
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      documentElement: { classList: { contains: () => false } },
      body: { appendChild() {} },
    },
    fetch,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout,
    URL,
    resolveDevHost: (u) => u,
    location: { origin: 'https://platform.example', hostname: 'platform.example' },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  if (react) sandbox.UsernodeReact = { staging: bridgeMod.stagingBridge };
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'bins-1a2b3c', self_hosted: false };
  AppView._tokenFresh = { slug: 'bins-1a2b3c', token: 'tok-1', at: Date.now() };
  AppView.iframeToken = 'tok-1';
  AppView.iframeTokenSlug = 'bins-1a2b3c';
  return { AppView, iframe, store: storeMod.stagingStore, handlers: storeMod.stagingHandlers };
}

const PREVIEW = 'https://bins-1a2b3c--s6295.onhomeroom.com';
const PREVIEW_AT = { at: AT, label: 'Thursday 8 Oct, 7 pm', zone: 'Europe/London' };

test('a declared moment rides the preview URL and words the bar', async () => {
  const { AppView, iframe, store } = await makeShell();
  await AppView.swapToStaging(PREVIEW, null, { verified: true, previewAt: PREVIEW_AT });
  const src = new URL(iframe.src);
  assert.equal(src.origin, PREVIEW);
  assert.equal(src.searchParams.get('un-now'), AT);
  assert.equal(src.searchParams.get('token'), 'tok-1', 'beside the token');
  assert.equal(store.get().clockLabel, 'Thursday 8 Oct, 7 pm');
  assert.equal(store.get().clockAsNow, false);
});

test('"See it as now" reloads the same address without the moment, and back again', async () => {
  const { AppView, iframe, store, handlers } = await makeShell();
  await AppView.swapToStaging(PREVIEW, { md: '1. Open the rota.', path: '/rota?week=41' },
    { verified: true, jump: true, previewAt: PREVIEW_AT });
  assert.equal(new URL(iframe.src).pathname, '/rota');
  assert.equal(iframe.loads, 1);

  handlers.onClockToggle();
  const asNow = new URL(iframe.src);
  assert.equal(asNow.searchParams.has('un-now'), false, 'now is the real time');
  assert.equal(asNow.pathname, '/rota', 'the deep link it was opened at survives');
  assert.equal(asNow.searchParams.get('week'), '41', 'and so does the app\'s own query');
  assert.equal(iframe.loads, 2, 'a real reload');
  assert.equal(store.get().clockAsNow, true);

  handlers.onClockToggle();
  assert.equal(new URL(iframe.src).searchParams.get('un-now'), AT, 'and back to the moment');
  assert.equal(iframe.loads, 3);
  assert.equal(store.get().clockAsNow, false);

  AppView.closeStagingOverlay();
  assert.equal(store.get().clockLabel, '', 'closing the preview clears the line');
});

test('no moment, a malformed one, or no island to explain it: the preview opens as now', async () => {
  for (const previewAt of [undefined, null, { at: 'Thursday', label: 'Thursday' },
    { at: AT, label: '' }, { at: '2026-10-08T18:00', label: 'x' }, { at: AT, label: 'x'.repeat(65) }]) {
    const { AppView, iframe, store, handlers } = await makeShell();
    await AppView.swapToStaging(PREVIEW, null, { verified: true, previewAt });
    assert.equal(new URL(iframe.src).searchParams.has('un-now'), false, JSON.stringify(previewAt));
    assert.equal(store.get().clockLabel, '');
    assert.equal(handlers.onClockToggle, null);
  }
  // The DOM fallback (no React bundle) cannot draw the line, so it does not
  // open the preview at an unexplained moment either.
  const bare = await makeShell({ react: false });
  await bare.AppView.swapToStaging(PREVIEW, null, { verified: true, previewAt: PREVIEW_AT });
  assert.equal(new URL(bare.iframe.src).origin, PREVIEW, 'the DOM fallback still opened the preview');
  assert.equal(new URL(bare.iframe.src).searchParams.has('un-now'), false);
});

test('ensureStaging hands the answer\'s moment to the preview it opens', async () => {
  const { AppView } = await makeShell({
    fetch: async () => ({
      ok: true,
      json: async () => ({ status: 'ready', url: PREVIEW, verified: true, previewAt: PREVIEW_AT }),
    }),
  });
  let opened = null;
  AppView.swapToStaging = async (url, testing, opts) => { opened = { url, opts }; };
  await AppView.ensureStaging(6295, PREVIEW, null, {});
  assert.equal(opened.url, PREVIEW);
  assert.deepEqual(JSON.parse(JSON.stringify(opened.opts.previewAt)), PREVIEW_AT);
});

test('production ignores it entirely: the app frame never carries un-now', async () => {
  const { AppView } = await makeShell();
  await AppView.swapToStaging(PREVIEW, null, { verified: true, previewAt: PREVIEW_AT });
  AppView.appData = { slug: 'bins-1a2b3c', url: 'https://bins-1a2b3c.onhomeroom.com' };
  AppView.pendingInnerPath = '/rota';
  AppView.tokenForSlug = () => 'tok-1';
  const src = new URL(AppView.buildAppIframeSrc());
  assert.equal(src.origin, 'https://bins-1a2b3c.onhomeroom.com');
  assert.equal(src.searchParams.has('un-now'), false, 'a preview open beside it changes nothing');
});

// ── The bar's words ──────────────────────────────────────────────────────

test('the bar says which moment it shows, in plain words, with the way back to now', () => {
  const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
  const storeMod = loadTsx('frontend/src/features/staging/staging-store.js');
  const overlay = loadTsx('frontend/src/features/staging/staging-overlay.tsx', {
    stubs: { './staging-store.js': storeMod },
  });
  const label = 'Thursday 8 Oct, 7 pm';
  assert.equal(overlay.previewClockText(label, false), 'Showing it as on Thursday 8 Oct, 7 pm.');
  assert.equal(overlay.previewClockToggleText(label, false), 'See it as now');
  assert.equal(overlay.previewClockText(label, true), 'Showing it as it is now.');
  assert.equal(overlay.previewClockToggleText(label, true), 'See it as on Thursday 8 Oct, 7 pm');
  for (const text of [overlay.previewClockText(label, false), overlay.previewClockText(label, true),
    overlay.previewClockToggleText(label, false), overlay.previewClockToggleText(label, true)]) {
    assert.doesNotMatch(text, /[\u2014\u2013]/, 'no em or en dashes');
  }

  const render = () => renderToHtml(createElement(overlay.StagingOverlay, {}));
  storeMod.stagingStore.set({ clockLabel: '', clockAsNow: false });
  const closed = render();
  assert.ok(!closed.includes('Showing it as'), 'no moment, no line: the prerendered page is unchanged');
  storeMod.stagingStore.set({ clockLabel: label, clockAsNow: false });
  const at = render();
  assert.ok(at.includes('Showing it as on Thursday 8 Oct, 7 pm.'));
  assert.ok(at.includes('See it as now'));
  storeMod.stagingStore.set({ clockLabel: label, clockAsNow: true });
  const now = render();
  assert.ok(now.includes('Showing it as it is now.'));
  assert.ok(now.includes('See it as on Thursday 8 Oct, 7 pm'));
  storeMod.stagingStore.set({ clockLabel: '', clockAsNow: false });
});
