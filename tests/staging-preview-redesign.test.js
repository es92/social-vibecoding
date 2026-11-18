'use strict';

// The change preview's redesign (Nov 2026): where it stands, what its header
// says, how its state moves, where a comment pinned in it goes, and that the
// top window draws it when the side panel's copy of Homeroom asks.
//
//   placement   features/staging/placement.ts choosePlacement: a column beside
//               the thread when it gets MIN_COLUMN px, else the side panel's
//               place, else the whole window; always the whole window on a
//               phone or for a change declared for large screens only.
//   header      staging-overlay.tsx previewFacts / previewVoteLabel: the line
//               under the change's name, read as the chat's vote card reads
//               a vote, and the platform's Vote / See the vote.
//   bridge      staging-bridge.js: setChange is a patch, the switch shows
//               the before-and-after only when there is one, a placement is
//               normalised, close resets it all.
//   comments    comment-pin/post.ts: a comment pinned in a preview posts into
//               the change's thread (thread `session`), its pictures as the
//               chat's own attachments.
//   stacking    app.css: the preview is above the Get-the-app strip (which
//               covered its Back on a phone) and below the dialogs.
//   handoff     app-view.js: a Preview press in the side panel's document is
//               handed to the top window with the app it is of.
//   address     app-view.js: an open preview is named in the address
//               (`?preview=<slug>/<id>`), so a reload, a pasted link or Back
//               onto the entry reopens it; placement.ts waits for the page's
//               column when it does.
//   name        the header names the change at once from the row the press
//               came from, else waits with a placeholder, never the
//               project's name first.
//   not running app-view.js: a stopped preview says so and how it starts;
//               every wait and dead end offers the before and after.
//
// Run with: node --test tests/staging-preview-redesign.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const storeMod = loadTsx('frontend/src/features/staging/staging-store.js');
const bridgeMod = loadTsx('frontend/src/features/staging/staging-bridge.js', {
  stubs: { './staging-store.js': storeMod },
});
const overlay = loadTsx('frontend/src/features/staging/staging-overlay.tsx', {
  stubs: { './staging-store.js': storeMod },
});
const placement = loadTsx('frontend/src/features/staging/placement.ts', {
  stubs: {
    './staging-store.js': storeMod,
    '../ai/detail': {
      closeDetail() {}, detailEntry: () => null, openDetail() {}, subscribeDetail: () => () => {},
    },
    '../side-panel/controller': { isBesideAi: () => false },
    '../side-panel/store.js': { sidePanelStore: { get: () => ({ open: false }), subscribe: () => () => {} } },
  },
});

// ── placement ─────────────────────────────────────────────────────────────

test('placement: a column beside the thread when it gets room, else the panel, else the window', () => {
  const at = (f) => placement.choosePlacement({
    phone: false, wide: false, besideApp: false, panelOpen: false, columnWidth: null, ...f,
  });
  assert.equal(placement.MIN_COLUMN, 400);
  assert.equal(at({ columnWidth: 613 }), 'column', 'the bot tab at 1440: thread | preview in halves');
  assert.equal(at({ columnWidth: 467, panelOpen: true }), 'column', 'the bot tab at 1600: three columns');
  assert.equal(at({ columnWidth: 354, panelOpen: true }), 'panel', 'too narrow a column: it takes the panel');
  assert.equal(at({ columnWidth: 354 }), 'full', 'and with no panel, the window');
  assert.equal(at({}), 'full', 'a page with no column');
  assert.equal(at({ besideApp: true, panelOpen: true, columnWidth: 900 }), 'panel',
    'beside a running app it always takes the panel: no room for app, request and preview');
  assert.equal(at({ phone: true, columnWidth: 900, panelOpen: true }), 'full', 'a phone: the whole screen');
  assert.equal(at({ wide: true, columnWidth: 900, panelOpen: true }), 'full',
    'a change declared for large screens only: a column would show the wrong layout');
});

test('placement: Full window docks back, and only from a column or a panel', () => {
  storeMod.stagingStore.set({ placement: 'full', expanded: false });
  assert.equal(placement.togglePreviewSize(), false, 'the whole window has nowhere to dock');
  assert.equal(storeMod.stagingStore.get().expanded, false);
  storeMod.stagingStore.set({ placement: 'column', expanded: false });
  assert.equal(placement.togglePreviewSize(), true);
  assert.equal(storeMod.stagingStore.get().expanded, true);
  assert.equal(placement.togglePreviewSize(), false);
  assert.equal(storeMod.stagingStore.get().expanded, false);
  storeMod.stagingStore.set({ placement: 'full', expanded: false });
});

test('placement: the frame is never moved, only the overlay over a measured spot', () => {
  const src = read('frontend/src/features/staging/placement.ts');
  assert.doesNotMatch(src, /appendChild|insertBefore|replaceWith|\.append\(/,
    'nothing here reparents an element: a moved iframe reloads');
  assert.match(src, /\[data-preview-slot\]/, 'the column is measured through its placeholder');
  assert.match(read('frontend/src/features/detail/detail-pane.tsx'), /data-preview-slot=""/,
    'which the detail column draws for a `preview` entry');
  assert.match(read('frontend/src/features/detail/detail-slot.tsx'), /'shots', 'preview'\]/,
    'and the request page\'s and Workshop\'s column draws too');
});

// ── header ────────────────────────────────────────────────────────────────

test('header: the line under the name reads the vote as the chat\'s vote card does', () => {
  const facts = (o) => overlay.previewFacts({ appName: 'Audit Garden', number: 34, vote: null, withApp: false, ...o })
    .map((p) => (p.ask ? `[${p.text}]` : p.text)).join(' · ');
  assert.equal(facts({}), 'Change #34');
  assert.equal(facts({ withApp: true }), 'Audit Garden · Change #34', 'the project\'s name in the whole window');
  const open = { yes: 1, needed: 2, needsOtherMember: false, myVote: null, status: 'promoted' };
  assert.equal(facts({ vote: open }), 'Change #34 · [Needs 1 more yes]', 'the ask is the accent');
  assert.equal(facts({ vote: { ...open, myVote: 'yes' } }), 'Change #34 · Needs 1 more yes · You voted yes',
    'once voted it no longer asks the viewer');
  assert.equal(facts({ vote: { ...open, yes: 2, needsOtherMember: true } }), 'Change #34 · Needs another member’s yes');
  assert.equal(facts({ vote: { ...open, status: 'merged' } }), 'Change #34 · Merged');
  assert.equal(facts({ number: 0 }), '', 'a dev session\'s preview: no number, no vote');
});

test('header: the platform\'s Vote, as the chat\'s vote card says it: See the vote once decided', () => {
  const open = { yes: 1, needed: 2, needsOtherMember: false, myVote: null, status: 'promoted' };
  assert.equal(overlay.previewVoteLabel(null), '', 'not up for a vote: no button');
  assert.equal(overlay.previewVoteLabel(open), 'Vote');
  assert.equal(overlay.previewVoteLabel({ ...open, myVote: 'yes' }), 'Vote',
    'a vote can be changed until it is decided, so having voted is not a reason to stop saying Vote');
  assert.equal(overlay.previewVoteLabel({ ...open, myVote: 'no' }), 'Vote');
  assert.equal(overlay.previewVoteLabel({ ...open, status: 'merging' }), 'See the vote');
  assert.equal(overlay.previewVoteLabel({ ...open, status: 'merged' }), 'See the vote');
  assert.match(read('frontend/src/features/group-chat/vote-card.tsx'),
    /const settled = !!vote && vote\.status !== 'promoted';[\s\S]*?settled \? t\('chat:group\.voteCard\.seeVote'\) : t\('chat:group\.voteCard\.vote'\)/,
    'the same rule as the chat\'s vote card');
  const src = read('frontend/src/features/staging/staging-overlay.tsx');
  assert.match(src, /id="staging-vote-btn"[\s\S]*?onClick=\{\(\) => stagingHandlers\.onVote\?\.\(\)\}/,
    'wired to the handler app-view.js points at the Votes card');
  assert.match(read('public/js/app-view.js'), /_stagingVote\(\) \{[\s\S]*?AppView\.openChangeAtVotes\(pv\.slug, pv\.sessionId\)/,
    'which opens the change at its Votes card, as the chat\'s vote card does');
});

// ── bridge ────────────────────────────────────────────────────────────────

test('bridge: setChange is a patch, so the change\'s name arrives without clearing the tile', () => {
  const b = bridgeMod.stagingBridge;
  b.setChange({ appName: 'Audit Garden', tile: '🌱', tileImage: 'javascript:alert(1)', selfHosted: false, title: '', number: null });
  let st = storeMod.stagingStore.get();
  assert.equal(st.appTile, '🌱');
  assert.equal(st.appTileImage, '', 'only an http(s) or same-origin picture is drawn');
  b.setChange({ title: '  Remind whoever is on watering duty ', number: 34 });
  st = storeMod.stagingStore.get();
  assert.equal(st.changeTitle, 'Remind whoever is on watering duty');
  assert.equal(st.changeNumber, 34);
  assert.equal(st.appTile, '🌱', 'the tile stays');
  assert.equal(st.appName, 'Audit Garden');
  b.close();
  st = storeMod.stagingStore.get();
  assert.equal(st.changeTitle, '');
  assert.equal(st.changeNumber, 0);
  assert.equal(st.appTile, '');
});

test('bridge: the switch offers Before & after only when there are shots', () => {
  const b = bridgeMod.stagingBridge;
  b.setShots('');
  b.setView('shots');
  assert.equal(storeMod.stagingStore.get().view, 'preview', 'nothing to show on that side');
  b.setShots('<div class="shots-viewer"></div>');
  b.setView('shots');
  assert.equal(storeMod.stagingStore.get().view, 'shots');
  b.setShots('');
  assert.equal(storeMod.stagingStore.get().view, 'preview', 'shots gone: back to the preview');
  b.close();
});

test('bridge: a placement is normalised, and only the panel beside an app marks it Live', () => {
  const b = bridgeMod.stagingBridge;
  const rect = { left: 827, top: 44, width: 613, height: 856 };
  b.setPlacement({ placement: 'column', rect, beside: 'app' });
  let st = storeMod.stagingStore.get();
  assert.equal(st.placement, 'column');
  assert.deepEqual(st.rect, rect);
  assert.equal(st.beside, null, 'Live is the panel beside an app only');
  b.setPlacement({ placement: 'panel', rect, beside: 'app' });
  assert.equal(storeMod.stagingStore.get().beside, 'app');
  b.setPlacement({ placement: 'sideways', rect });
  st = storeMod.stagingStore.get();
  assert.equal(st.placement, 'full');
  assert.equal(st.rect, null, 'the whole window has no spot');
  b.close();
});

// ── comments ──────────────────────────────────────────────────────────────

test('comments: pinned in a preview, they go into the change\'s thread with their pictures', async () => {
  const calls = [];
  const fakeWindow = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (/chat-attachments/.test(url)) return { ok: true, json: async () => ({ id: 'a'.repeat(32) }) };
      return { ok: true, json: async () => ({ message: { id: 1 } }) };
    },
  };
  const post = loadTsx('frontend/src/features/comment-pin/post.ts', { cache: false });
  const saved = global.window;
  global.window = fakeWindow;
  try {
    const out = await post.postComment({
      text: 'Could the reminder say which beds need water most?',
      target: 'change',
      appSlug: 'audit-garden',
      sessionId: 9201,
      shots: [{ blob: { type: 'image/png', size: 10 }, pins: [{ x: 0.5, y: 0.2, note: 'here' }] }],
      images: [],
      change: '',
    });
    assert.equal(out.ok, true);
    assert.equal(calls.length, 2, 'one picture up, then one message');
    assert.match(calls[0].url, /^\/api\/apps\/audit-garden\/chat-attachments\?filename=/);
    assert.equal(calls[1].url, '/api/apps/audit-garden/messages');
    const body = JSON.parse(calls[1].init.body);
    assert.equal(body.thread_type, 'session');
    assert.equal(body.thread_ref, 9201);
    assert.deepEqual(body.attachment_ids, ['a'.repeat(32)]);
    assert.equal(body.content, 'Could the reminder say which beds need water most?');
    assert.ok(!calls.some((c) => /\/api\/feedback/.test(c.url)), 'no request is filed');
  } finally {
    global.window = saved;
  }
});

test('comments: the box offers the change first, and picks it, for a pin in a preview', () => {
  const src = read('frontend/src/features/comment-pin/comment-pin.tsx');
  assert.match(src, /const PREVIEW_TARGETS: readonly Target\[\] = \['change', 'app', 'platform'\];/);
  assert.match(src, /draft\.chosen \?\? \(inPreview \? 'change' :/);
});

// ── stacking ──────────────────────────────────────────────────────────────

test('stacking: above the Get-the-app strip, below the dialogs', () => {
  const css = read('public/css/app.css');
  const z = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at !== -1, `missing ${selector}`);
    return Number(/z-index:\s*(\d+)/.exec(css.slice(at, css.indexOf('}', at)))[1]);
  };
  const preview = z('#staging-overlay');
  const strip = z('#mobile-install-banner:not(.hidden)');
  assert.ok(preview > strip, `the preview (${preview}) is over the strip (${strip}), whose cover hid its Back`);
  assert.ok(preview < 50, 'and under the drawer and the dialogs (z-50)');
});

// ── handoff ───────────────────────────────────────────────────────────────

test('handoff: a Preview press in the side panel\'s document is drawn by the top window', async () => {
  const SRC = read('public/js/app-view.js');
  const forwarded = [];
  const top = { AppView: { ensureStaging: (...args) => { forwarded.push(args); return 'top'; } } };
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    console,
    App: { user: { id: 1 }, embeddedPanel: true },
    document: { getElementById: () => null, documentElement: { classList: { contains: () => false } } },
    setTimeout, clearTimeout, URL,
    location: { origin: 'https://platform.example', hostname: 'platform.example', hash: '' },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = top;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'audit-garden', name: 'Audit Garden', audience: 'invited', icon_emoji: '🌱', self_hosted: false };
  const out = await AppView.ensureStaging(9201, null, { md: 'Try it', path: null }, {});
  assert.equal(out, 'top', 'the top window took it');
  assert.equal(forwarded.length, 1);
  const [id, url, testing, opts] = forwarded[0];
  assert.equal(id, 9201);
  assert.equal(url, null);
  assert.deepEqual(JSON.parse(JSON.stringify(testing)), { md: 'Try it', path: null }, 'with its testing notes');
  assert.equal(opts.app.slug, 'audit-garden', 'and the app it is of');
  assert.equal(opts.app.name, 'Audit Garden');
  assert.equal(opts.app.icon_emoji, '🌱');

  // The top window itself draws its own.
  sandbox.App.embeddedPanel = false;
  assert.equal(AppView._stagingTop(), null);
});

// ── the preview's address ─────────────────────────────────────────────────

// app-view.js in a vm, with a location and a history that follow each
// other, and the real bridge over the real store as the island's adapter.
function appViewAt({ pathname = '/app/audit-garden/dev/issues/21', search = '', hash = '', fetchImpl, embedded = false } = {}) {
  const SRC = read('public/js/app-view.js');
  const writes = [];
  const location = { origin: 'https://platform.example', hostname: 'platform.example', pathname, search, hash };
  const history = {
    state: { kept: 1 },
    replaceState(state, _title, url) {
      writes.push(url);
      this.state = state;
      const u = new URL(url, 'https://platform.example');
      location.pathname = u.pathname;
      location.search = u.search;
      location.hash = u.hash;
    },
  };
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    console,
    App: { user: { id: 1 }, currentTab: 'dev', embeddedPanel: embedded },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {}, documentElement: { classList: { contains: () => false } },
    },
    fetch: fetchImpl || (() => new Promise(() => {})),
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout, setInterval, clearInterval, URL, URLSearchParams, AbortController,
    location, history,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    UsernodeReact: { staging: bridgeMod.stagingBridge },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  bridgeMod.stagingBridge.close();
  return { AppView: sandbox.__AppView, sandbox, location, history, writes };
}

test('address: an open preview is named in the address, in place, and the name goes when it closes', () => {
  const { AppView, location, history, writes } = appViewAt({ search: '?ws=needs', hash: '' });
  assert.equal(AppView._writePreviewAddress('audit-garden', 9201), true);
  assert.equal(location.search, '?ws=needs&preview=audit-garden/9201', 'beside every other parameter, kept as it was');
  assert.deepEqual({ ...history.state }, { kept: 1 }, 'the entry\'s own state is kept');
  assert.equal(writes.length, 1, 'written in place: replaceState, no step for Back');
  AppView._writePreviewAddress('audit-garden', 9201);
  assert.equal(writes.length, 1, 'the same name is not written twice');

  // The Workshop's side panel follows its own written address (#6110).
  AppView._panelAddress = { slug: 'audit-garden', from: '/app/audit-garden/workshop', to: AppView._hereAddress() };
  AppView._writePreviewAddress(null);
  assert.equal(location.search, '?ws=needs', 'closed: the page\'s own address comes back');
  assert.equal(AppView._panelAddress.to, AppView._hereAddress(), 'and the panel\'s bookkeeping moves with it');

  assert.deepEqual({ ...AppView._previewAddressAt('?preview=audit-garden/9201') }, { slug: 'audit-garden', sessionId: 9201 });
  assert.deepEqual({ ...AppView._previewAddressAt('?a=1&preview=audit-garden%2F12') }, { slug: 'audit-garden', sessionId: 12 });
  for (const bad of ['', '?preview=', '?preview=audit-garden', '?preview=audit-garden/0', '?preview=Audit/1',
    '?preview=../x/1', '?preview=audit-garden/1/2']) {
    assert.equal(AppView._previewAddressAt(bad), null, bad);
  }
});

test('address: never on a shot route, and never in the side panel\'s framed copy', () => {
  const shot = appViewAt({ search: '?shot=preview-loading' });
  assert.equal(shot.AppView._writePreviewAddress('audit-garden', 9201), false);
  assert.equal(shot.writes.length, 0);
  const panel = appViewAt({ embedded: true });
  assert.equal(panel.AppView._writePreviewAddress('audit-garden', 9201), false);
  assert.equal(panel.writes.length, 0, 'the top window draws the preview, and names it');
});

test('address: opening a preview names it, and closing it takes the name away', async () => {
  const { AppView, location } = appViewAt({
    hash: '#homeroom-bot/thread/70104',
    pathname: '/',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'unavailable', reason: 'demo' }) }),
  });
  await AppView.ensureStaging(9201, null, null, { app: { slug: 'audit-garden' } });
  assert.equal(location.search, '?preview=audit-garden/9201');
  assert.equal(location.hash, '#homeroom-bot/thread/70104', 'the page it stands over is untouched');
  AppView.closeStagingOverlay();
  assert.equal(location.search, '');
  assert.match(read('public/js/app.js'),
    /finally \{\s*App\._isRestoring = false;[\s\S]{0,400}?setTimeout\(\(\) => AppView\.restorePreviewFromAddress\(\), 0\)/,
    'every route reads it afterwards: a reload, a pasted link, Back onto the entry');
});

test('address: a reload or a pasted link reopens the preview, waiting for the page\'s column', () => {
  const { AppView, sandbox } = appViewAt({ search: '?preview=audit-garden/9201' });
  const opened = [];
  AppView.ensureStaging = (...args) => { opened.push(args); };
  AppView.appData = null;
  assert.equal(AppView.restorePreviewFromAddress(), true);
  const [id, url, testing, opts] = opened[0];
  assert.equal(id, 9201);
  assert.equal(url, null);
  assert.equal(testing, null);
  assert.equal(opts.app.slug, 'audit-garden', 'the app is named in the address');
  assert.equal(opts.settle, true, 'it waits for the page\'s column');
  assert.equal(opts.lookOnlyIfRefused, true, 'not that app\'s page: refused a rebuild, it is shown look-only');

  AppView.appData = { slug: 'audit-garden', name: 'Audit Garden' };
  AppView.restorePreviewFromAddress();
  assert.equal(opened[1][3].app, AppView.appData, 'on the app\'s own page, its record');
  assert.equal(opened[1][3].lookOnlyIfRefused, undefined, 'whose read-only flag says who may rebuild');

  // Already up on that change (the route ran again): nothing.
  AppView._stagingPreview = { sessionId: 9201, slug: 'audit-garden' };
  bridgeMod.stagingBridge.open();
  assert.equal(AppView.restorePreviewFromAddress(), false);
  bridgeMod.stagingBridge.close();
  AppView._stagingPreview = null;
  sandbox.App.user = null;
  assert.equal(AppView.restorePreviewFromAddress(), false, 'nobody signed in: nothing asked');
  assert.equal(opened.length, 2);
});

test('address: refused the rebuilding POST, a preview reopened from its address gets the look-only read', async () => {
  const asked = [];
  const { AppView } = appViewAt({
    search: '?preview=audit-garden/9201',
    fetchImpl: async (url, init) => {
      asked.push(`${init && init.method || 'GET'} ${url}`);
      if (String(url).endsWith('/ensure-staging')) return { ok: false, status: 403, json: async () => ({ error: 'Not allowed' }) };
      return { ok: true, status: 200, json: async () => ({ status: 'ready', url: 'https://audit-garden--s9201.example.invalid/', verified: true }) };
    },
  });
  const swaps = [];
  AppView.swapToStaging = (u) => { swaps.push(u); };
  await AppView.ensureStaging(9201, null, null, { app: { slug: 'audit-garden' }, settle: true, lookOnlyIfRefused: true });
  assert.deepEqual(asked.filter((a) => a.includes('/api/sessions/')), [
    'POST /api/sessions/9201/ensure-staging',
    'GET /api/sessions/9201/preview-status',
  ]);
  assert.deepEqual(swaps, ['https://audit-garden--s9201.example.invalid/']);
});

test('placement: reopened from its address, the preview waits for the page\'s column', async () => {
  const entry = { v: null };
  const p = loadTsx('frontend/src/features/staging/placement.ts', {
    stubs: {
      './staging-store.js': storeMod,
      '../ai/detail': {
        openDetail: (e) => { entry.v = e; },
        closeDetail: () => { entry.v = null; },
        detailEntry: () => entry.v,
        subscribeDetail: () => () => {},
      },
      '../side-panel/controller': { isBesideAi: () => false },
      '../side-panel/store.js': { sidePanelStore: { get: () => ({ open: false }), subscribe: () => () => {} } },
    },
  });
  let slot = null;
  const saved = { window: globalThis.window, document: globalThis.document, raf: globalThis.requestAnimationFrame };
  globalThis.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} };
  globalThis.document = { querySelector: () => slot, getElementById: () => null };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    assert.equal(p.SETTLE_MS, 4000);
    // The page has not drawn its column yet.
    assert.equal(await p.placePreview({ sessionId: 9201, settle: true }), 'full');
    assert.equal(storeMod.stagingStore.get().placement, 'full', 'the whole window meanwhile');
    assert.equal(entry.v && entry.v.kind, 'preview', 'the column stays asked for');
    slot = { getBoundingClientRect: () => ({ left: 820, top: 64, width: 620, height: 836 }) };
    await wait(400);
    assert.equal(storeMod.stagingStore.get().placement, 'column', 'it moves in once the column is there');
    assert.deepEqual({ ...storeMod.stagingStore.get().rect }, { left: 820, top: 64, width: 620, height: 836 });
    p.unplacePreview();
    assert.equal(entry.v, null, 'and gives it back when it closes');

    // A column too narrow for it: the whole window, and the column goes.
    slot = null;
    await p.placePreview({ sessionId: 9201, settle: true });
    slot = { getBoundingClientRect: () => ({ left: 1100, top: 64, width: 340, height: 836 }) };
    await wait(400);
    assert.equal(storeMod.stagingStore.get().placement, 'full');
    assert.equal(entry.v, null);

    // An ordinary press does not wait: no column, the whole window, at once.
    slot = null;
    await p.placePreview({ sessionId: 9201 });
    assert.equal(entry.v, null);
  } finally {
    p.unplacePreview();
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.requestAnimationFrame = saved.raf;
    bridgeMod.stagingBridge.close();
  }
});

// ── the change's name, from the start ─────────────────────────────────────

test('name: the header names the change at once from the row the Preview press came from', () => {
  const { AppView } = appViewAt();
  // A card's Preview records its change as the card is drawn (_cardPreviewSpec).
  AppView._cardPreviewSpec({ id: 9201, pr_title: 'Remind whoever is on watering duty', pr_number: 34, staging_url: 'https://x.example/' }, {});
  AppView.ensureStaging(9201, 'https://x.example/', null, { app: { slug: 'audit-garden', name: 'Audit Garden' } });
  let st = storeMod.stagingStore.get();
  assert.equal(st.changeTitle, 'Remind whoever is on watering duty', 'named before the server answers');
  assert.equal(st.changeNumber, 34);
  assert.equal(st.changePending, false);

  // The chat's vote card hands over the change it is drawn from.
  AppView.swapToStagingForSession(9301, '', { title: 'Pinned communities above pinned apps', number: 512 });
  st = storeMod.stagingStore.get();
  assert.equal(st.changeTitle, 'Pinned communities above pinned apps');
  assert.equal(st.changeNumber, 512);
  assert.match(read('frontend/src/features/group-chat/vote-card.tsx'),
    /swapToStagingForSession\?\.\(sessionId, preview, \{ title: vote\?\.title \?\? null, number: number \?\? null \}\)/);
});

test('name: a change the page holds no row of waits with a placeholder, never the project\'s name', async () => {
  let answer;
  const { AppView } = appViewAt({
    fetchImpl: (url) => (String(url).includes('/promoted')
      ? Promise.resolve({ ok: true, json: async () => ({ promoted: [] }) })
      : new Promise((resolve) => { answer = resolve; })),
  });
  const opening = AppView.ensureStaging(9401, null, null, { app: { slug: 'audit-garden', name: 'Audit Garden' } });
  let st = storeMod.stagingStore.get();
  assert.equal(st.changeTitle, '');
  assert.equal(st.changePending, true, 'its name is being looked up');
  const html = renderToHtml(createElement(overlay.StagingOverlay, {}));
  assert.match(html, /<span id="staging-url-label" class="staging-title" data-pending="">\s*<\/span>/,
    'the title is a placeholder, not "Audit Garden · Preview"');
  assert.ok(!html.includes('Audit Garden · Preview'));

  answer({ ok: true, status: 200, json: async () => ({ status: 'unavailable', reason: 'demo', change: { number: 35, title: 'A seed swap page' } }) });
  await opening;
  await new Promise((r) => setTimeout(r, 0));
  st = storeMod.stagingStore.get();
  assert.equal(st.changeTitle, 'A seed swap page', 'the server\'s word names it');
  assert.equal(st.changePending, false);
  assert.deepEqual({ ...AppView._sessionChanges[9401] }, { title: 'A seed swap page', number: 35 },
    'and is kept, so opening it again names it at once');
  bridgeMod.stagingBridge.close();
});

test('name: a dev session\'s preview, which has no change, ends its wait on the project\'s name', async () => {
  const { AppView } = appViewAt({
    fetchImpl: async (url) => (String(url).includes('/promoted')
      ? { ok: true, json: async () => ({ promoted: [] }) }
      : { ok: true, status: 200, json: async () => ({ status: 'unavailable', reason: 'demo' }) }),
  });
  await AppView.ensureStaging(9402, null, null, { app: { slug: 'audit-garden', name: 'Audit Garden' } });
  await new Promise((r) => setTimeout(r, 0));
  const st = storeMod.stagingStore.get();
  assert.equal(st.changePending, false);
  assert.equal(st.urlLabel, 'Audit Garden · Preview');
  // The loader shot route opens no change: no wait at all.
  AppView._stagingHeader(null, { slug: 'audit-garden', name: 'Audit Garden' }, null);
  assert.equal(storeMod.stagingStore.get().changePending, false);
  bridgeMod.stagingBridge.close();
});

test('bridge: a name that arrives ends the wait; the before-and-after offer is reset with each loader', () => {
  const b = bridgeMod.stagingBridge;
  b.setChange({ title: '', pending: true });
  assert.equal(storeMod.stagingStore.get().changePending, true);
  b.setChange({ number: 34 });
  assert.equal(storeMod.stagingStore.get().changePending, true, 'a number alone does not end it');
  b.setChange({ title: 'Remind whoever is on watering duty' });
  assert.equal(storeMod.stagingStore.get().changePending, false);
  b.setLoader(true, { title: 'x', offerShots: true });
  assert.equal(storeMod.stagingStore.get().loaderShots, true);
  b.setLoader(true, { title: 'Opening preview…' });
  assert.equal(storeMod.stagingStore.get().loaderShots, false, 'only a wait or a dead end offers it');
  b.setLoader(false, { offerShots: true });
  assert.equal(storeMod.stagingStore.get().loaderShots, false);
  b.close();
  assert.equal(storeMod.stagingStore.get().changePending, false);
});

// ── not running ───────────────────────────────────────────────────────────

const englishOf = (id) => englishPlatformI18n().t(id);

test('not running: it says so, with Start the preview for somebody who builds on the project', async () => {
  const { AppView } = appViewAt({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'unavailable', reason: 'missing' }) }),
  });
  await AppView.ensureStaging(9201, null, null, { app: { slug: 'audit-garden' } });
  let st = storeMod.stagingStore.get();
  assert.equal(st.loaderTitle, englishOf('changes:frame.notRunning.title'));
  assert.equal(st.loaderTitle, 'This preview isn’t running right now');
  assert.equal(st.loaderSub, 'It stops after a while unused. Starting it again takes about a minute.');
  assert.equal(st.loaderRetry, true);
  assert.equal(st.loaderRetryLabel, 'Start the preview');
  assert.equal(st.loaderShots, true, 'and the before and after is offered');

  const reader = appViewAt({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'unavailable', reason: 'missing' }) }),
  });
  await reader.AppView.ensureStaging(9201, null, null, { app: { slug: 'audit-garden' }, readOnly: true });
  st = storeMod.stagingStore.get();
  assert.equal(st.loaderTitle, 'This preview isn’t running right now');
  assert.equal(st.loaderSub, englishOf('changes:frame.unavailable.missingReader'));
  assert.equal(st.loaderRetry, false, 'a reviewer cannot start it, and is told who can');
  assert.equal(st.loaderShots, true);
  bridgeMod.stagingBridge.close();
});

test('not running: a failure has its own title, and every wait offers the before and after', async () => {
  const { AppView } = appViewAt({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'unavailable', reason: 'edge' }) }),
  });
  await AppView.ensureStaging(9201, null, null, { app: { slug: 'audit-garden' } });
  let st = storeMod.stagingStore.get();
  assert.equal(st.loaderTitle, 'This preview can’t open right now');
  assert.equal(st.loaderRetryLabel, 'Retry preview');
  assert.equal(st.loaderShots, true);

  const rebuilding = appViewAt({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'rebuilding' }) }),
  });
  const opening = rebuilding.AppView.ensureStaging(9201, null, null, { app: { slug: 'audit-garden' } });
  assert.equal(storeMod.stagingStore.get().loaderShots, false, 'not while it is only opening');
  await opening;
  assert.equal(storeMod.stagingStore.get().loaderShots, true, 'but while it is spinning back up');
  rebuilding.AppView.closeStagingOverlay();
});

test('not running: the before and after is offered over the loader only when the change has shots', () => {
  const b = bridgeMod.stagingBridge;
  b.open();
  b.setLoader(true, { title: 'This preview isn’t running right now', offerShots: true });
  b.setShots('<div class="shots">before / after</div>');
  // Rendered always, like every part of the island; a ref toggles `hidden`.
  assert.match(renderToHtml(createElement(overlay.StagingOverlay, {})),
    /<button type="button" class="hidden staging-link staging-loader-shots">See the before &amp; after instead<\/button>/);
  const src = read('frontend/src/features/staging/staging-overlay.tsx');
  assert.match(src, /useHiddenClass\(shotsLinkRef, !\(state\.loaderShots && shotsOffered\)\);/,
    'shown only for a wait or a dead end of a change with verified shots');
  assert.match(src, /className="hidden staging-link staging-loader-shots"\s+onClick=\{\(\) => stagingHandlers\.onView\?\.\('shots'\)\}/,
    'it shows the switch\'s other side');
  const css = read('public/css/app.css');
  assert.match(css, /\.staging-shots \{\s*position: absolute;\s*z-index: 1;/, 'which stands over the loader');
  b.close();
});

test('header: the facts under the name stay whole, so "Needs 1 more yes" is never cut on a phone', () => {
  const css = read('public/css/app.css');
  const facts = /\.staging-facts \{([^}]*)\}/.exec(css)[1];
  assert.match(facts, /flex-wrap: wrap/, 'a fact that does not fit moves to a second line');
  assert.doesNotMatch(facts, /text-overflow|white-space: nowrap/, 'the line as a whole is never cut short');
  assert.match(css, /\.staging-fact \{[^}]*white-space: nowrap;/, 'each fact stays whole');
  assert.match(css, /\.staging-titles \{ overflow: hidden; \}/, 'the dot before a line\'s first fact sits in the clipped gutter');
});

test('name: the change\'s row is kept when it answers after the preview began loading', async () => {
  // swapToStaging takes a load id of its own (#6077); a row that answered
  // after it was dropped, and a reload (no row in memory) lost the vote line.
  let answerRow;
  const { AppView, sandbox } = appViewAt({
    fetchImpl: (url) => (String(url).includes('/promoted')
      ? new Promise((resolve) => { answerRow = resolve; })
      : Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'ready', url: 'https://x.example/', verified: true }) })),
  });
  sandbox.GroupChat = { _voteView: (row) => ({ yes: row.yes_count, needed: row.votes_required, needsOtherMember: false, myVote: null, status: row.status }) };
  AppView.swapToStaging = () => { AppView._stagingLoadId += 1; };
  await AppView.ensureStaging(9201, null, null, { app: { slug: 'audit-garden' } });
  answerRow({ ok: true, json: async () => ({ promoted: [{ id: 9201, pr_number: 34, pr_title: 'Remind whoever is on watering duty', status: 'promoted', yes_count: 1, votes_required: 2 }] }) });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const st = storeMod.stagingStore.get();
  assert.ok(st.vote, 'the vote line is drawn');
  assert.equal(st.vote.needed, 2);
  assert.equal(st.changeTitle, 'Remind whoever is on watering duty');
  AppView.closeStagingOverlay();
  assert.equal(AppView._stagingOpenSeq, 0, 'closed: a lookup still out writes nothing');
});
