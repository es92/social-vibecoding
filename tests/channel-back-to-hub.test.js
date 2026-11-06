'use strict';

// #3407: A CHANNEL LEADS WITH ITS WAY BACK TO ITS HUB.
//
// The hub's own pages (Needs you, the Workshop, All items) open with a round
// chevron back to the hub; the project's channel, whose door is the hub's
// Channel card, had only the platform header's arrow. Pinned here:
//
//   1. ONE DISC: `PageBackButton` in dev-board/workshop/page-back.tsx is the
//      chevron the Workshop's `PageBack` draws and the channel panes draw, so
//      the two cannot drift apart.
//   2. BOTH CHANNELS CARRY IT, first in their header row: a project's channel
//      (`AppDiscussionThread`) and #general (`ThreadHeader`, channel only —
//      a conversation's way back is the header's, to the list).
//   3. IT IS A DOOR TO THE HUB: AppView._landOnHub, then the hub's address,
//      so it lands on the hub rather than the tab the page was last left on.
//   4. #GENERAL'S HUB IS FOUND LATE: on a cold load the platform's slug is
//      not known when the header first draws, so the header subscribes to
//      PlatformTarget.onSlug (fired wherever the slug lands: the lookup, the
//      about read, the version poll) and draws label and press from one
//      value (executed below against the real modules, not grepped).
//
// Run with: node --test tests/channel-back-to-hub.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCREEN = read('frontend/src/features/messages/index.tsx');
const BACK = read('frontend/src/features/dev-board/workshop/page-back.tsx');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const HUB_SRC = read('frontend/src/features/messages/channel-hub.ts');
const APP_JS = read('public/js/app.js');

function fn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = src.indexOf('\n}\n', start);
  return src.slice(start, end);
}

test('one disc: the Workshop\'s page head and the channels draw the same button', () => {
  const button = fn(BACK, 'PageBackButton');
  assert.match(button, /className="dev-ws-page-back un-touch-target"/);
  assert.match(button, /const name = t\('project:pageBack\.backTo', \{ place: label \}\);/);
  assert.match(button, /aria-label=\{name\}/);
  assert.equal(message('project:pageBack.backTo', { place: 'Homeroom' }), 'Back to Homeroom');
  assert.match(button, /<ChevronLeftIcon className="dev-ws-page-back-glyph" aria-hidden="true" \/>/);
  assert.match(fn(BACK, 'PageBack'), /<PageBackButton label=\{label\} onBack=\{onBack\} data-ws-page-back="" \/>/);
  assert.match(WORKSHOP, /import \{ PageBack \} from '\.\/page-back';/);
  assert.doesNotMatch(WORKSHOP, /function PageBack\(/, 'defined once, in page-back.tsx');
  assert.match(SCREEN, /import \{ PageBackButton \} from '\.\.\/dev-board\/workshop\/page-back';/);
});

test('a project\'s channel leads its header with the way back to its hub', () => {
  const pane = fn(SCREEN, 'AppDiscussionThread');
  assert.match(pane,
    /<header className="messages-thread-header">\s*<PageBackButton label=\{name\} onBack=\{\(\) => openChannelHub\(slug\)\} data-channel-back="" \/>\s*<AppIconLink/);
});

test('#general leads with the way back to the Homeroom hub; a conversation does not', () => {
  const header = fn(SCREEN, 'ThreadHeader');
  // A hook, so before the header's early return; subscribed, not read once.
  const hook = header.indexOf("const hubBack = generalHubBack(usePlatformSlug(active?.kind === 'channel'));");
  assert.ok(hook > 0 && hook < header.indexOf('if (!active) return null;'), 'the hook runs before the early return');
  // The label and the press come from the one value.
  assert.match(header,
    /\{channel \? <PageBackButton label=\{hubBack\.label\} onBack=\{hubBack\.onBack\} data-channel-back="" \/> : null\}/);
  assert.equal((header.match(/<PageBackButton /g) || []).length, 1, 'only behind `channel`');
  assert.match(SCREEN, /import \{ generalHubBack, openChannelHub, usePlatformSlug \} from '\.\/channel-hub';/);
  assert.match(HUB_SRC, /useSyncExternalStore\(subscribePlatformSlug, platformSlug, \(\) => null\)/);
});

test('the version poll tells PlatformTarget when it may know the slug', () => {
  assert.match(APP_JS,
    /App\._lastVersionInfo = info;\n(?:\s*\/\/[^\n]*\n)*\s*try \{\n\s*const target = typeof PlatformTarget !== 'undefined' \? PlatformTarget : null;\n\s*if \(target && target\.notifySlug\) target\.notifySlug\(\);\n\s*\} catch \{\}/);
});

// EXECUTED: the real PlatformTarget and channel-hub.ts, against a stubbed
// window and fetch, the way a cold `#messages/<general-id>` load finds them.
async function withEnv({ fetchImpl }, run) {
  const hadWin = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prevWin = globalThis.window;
  const prevFetch = globalThis.fetch;
  const landed = [];
  const win = {
    location: { hash: '#messages/7', search: '' },
    AppView: { _landOnHub: (s) => landed.push(s) },
    App: {},
  };
  globalThis.window = win;
  globalThis.fetch = fetchImpl;
  try {
    const { PlatformTarget } = loadTsx('frontend/src/features/app-context/platform-target.js');
    assert.equal(win.PlatformTarget, PlatformTarget, 'published on window');
    const HUB = loadTsx('frontend/src/features/messages/channel-hub.ts');
    return await run({ win, landed, PlatformTarget, HUB });
  } finally {
    if (hadWin) globalThis.window = prevWin; else delete globalThis.window;
    globalThis.fetch = prevFetch;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

test('the slug lands while resolve() still waits on the app row: heard at once, label and press agree', async () => {
  let releaseRow;
  const row = new Promise((r) => { releaseRow = r; });
  const fetchImpl = (url) => {
    if (url.startsWith('/api/platform/about')) return Promise.resolve(json({ stats: {}, served: true, selfAppSlug: 'homeroom' }));
    if (url.startsWith('/api/apps/homeroom')) return row;
    throw new Error(`unexpected fetch ${url}`);
  };
  await withEnv({ fetchImpl }, async ({ win, landed, PlatformTarget, HUB }) => {
    assert.equal(HUB.platformSlug(), null, 'nothing knows the slug at first draw');
    assert.deepEqual(HUB.generalHubBack(HUB.platformSlug()).label, 'Home');
    let heard = 0;
    const off = HUB.subscribePlatformSlug(() => { heard += 1; });
    const pending = PlatformTarget.resolve();
    await tick(); await tick();
    assert.ok(PlatformTarget._pending, 'resolve() is still waiting on the app row');
    assert.ok(heard >= 1, 'the header hears the slug before resolve() settles');
    // What the header draws on that re-render: one value, both ends.
    const back = HUB.generalHubBack(HUB.platformSlug());
    assert.equal(back.label, 'Homeroom');
    back.onBack();
    assert.deepEqual(landed, ['homeroom']);
    assert.equal(win.location.hash, '#app/homeroom/dev/hub');
    releaseRow(json({}, false));
    await pending;
    off();
  });
});

test('after a failed, throttled resolve, the version poll that knows the slug is heard', async () => {
  const fetchImpl = () => Promise.resolve(json(null, false));
  await withEnv({ fetchImpl }, async ({ win, PlatformTarget, HUB }) => {
    const heard = [];
    const off = HUB.subscribePlatformSlug(() => heard.push(HUB.platformSlug()));
    await PlatformTarget.resolve();
    assert.ok(PlatformTarget._failedAt > 0, 'the lookup failed');
    await PlatformTarget.resolve(); // throttled: returns at once, learns nothing
    assert.deepEqual(heard, []);
    assert.equal(HUB.generalHubBack(HUB.platformSlug()).label, 'Home');
    // What App.loadVersion does when /api/version answers.
    win.App._lastVersionInfo = { sha: 'abc', selfAppSlug: 'homeroom' };
    PlatformTarget.notifySlug();
    PlatformTarget.notifySlug(); // unchanged: not told twice
    assert.deepEqual(heard, ['homeroom']);
    assert.equal(HUB.generalHubBack(HUB.platformSlug()).label, 'Homeroom');
    off();
    win.App._lastVersionInfo = { sha: 'abd', selfAppSlug: 'other' };
    PlatformTarget.notifySlug();
    assert.deepEqual(heard, ['homeroom'], 'an unsubscribed header is not told');
  });
});

test('a press before anything knows the slug goes Home, where the communities are, without a hub landing (One Home, #6361)', async () => {
  await withEnv({ fetchImpl: () => Promise.resolve(json(null, false)) }, ({ win, landed, HUB }) => {
    const home = [];
    win.App.navigateHome = () => home.push('home');
    HUB.generalHubBack(HUB.platformSlug()).onBack();
    assert.deepEqual(landed, []);
    assert.deepEqual(home, ['home']);
    assert.equal(win.location.hash, '#messages/7', 'and no address of its own');
  });
});

test('a project\'s channel: _landOnHub first, then the hub\'s address', async () => {
  await withEnv({ fetchImpl: () => Promise.resolve(json(null, false)) }, ({ win, landed, HUB }) => {
    HUB.openChannelHub('whiteboard');
    assert.deepEqual(landed, ['whiteboard']);
    assert.equal(win.location.hash, '#app/whiteboard/dev/hub');
  });
});

// THE HEADER'S ARROW AND THE PANE'S DISC NAME ONE HUB. The header's arrow is
// syncChrome's (store.ts channelHub); on a cold #general it was set to
// Communities and nothing re-ran it when the slug landed. EXECUTED against the
// real store and PlatformTarget: open #general slugless, then publish the slug
// the way App.loadVersion does.
test('a cold #general: the header arrow follows the slug to the hub, with the disc', async () => {
  const GENERAL = 5;
  const backIcons = [];
  const landed = [];
  const prev = { window: globalThis.window, fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  globalThis.window = {
    location: { hash: `#messages/${GENERAL}`, search: '' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    innerWidth: 1280,
    AppView: { _landOnHub: (s) => landed.push(s) },
    App: {
      user: { id: 1, username: 'me' },
      setBackIcon: (kind, href) => backIcons.push([kind, href]),
      setHeaderTitle() {},
    },
    Notifications: { markConversationRead() {}, markConversationThreadRead() {} },
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const general = { id: GENERAL, kind: 'channel', title: 'general', channelKey: 'general', membershipStatus: 'member', memberCount: 3, members: [] };
  globalThis.fetch = async (url) => {
    const address = String(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (address === `/api/conversations/${GENERAL}`) return json({ conversation: general });
    if (address.startsWith(`/api/conversations/${GENERAL}/messages?`)) return json({ messages: [], next_before: null });
    if (address.startsWith('/api/conversations')) return json({ conversations: [general] });
    if (address.startsWith('/api/platform/about') || address.startsWith('/api/version')) return json(null, 500);
    return json({ discussions: [] });
  };
  try {
    const { PlatformTarget } = loadTsx('frontend/src/features/app-context/platform-target.js');
    const store = loadTsx('frontend/src/features/messages/store.ts');
    const HUB = loadTsx('frontend/src/features/messages/channel-hub.ts');
    const unfollow = store.followPlatformSlug();
    store.route(GENERAL, null, null, {});
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 5));
    store.syncChrome();
    assert.deepEqual(backIcons.at(-1), ['arrow', '/'], 'slugless: the arrow goes Home');
    assert.equal(HUB.generalHubBack(HUB.platformSlug()).label, 'Home', '…and so does the disc');

    window.App._lastVersionInfo = { sha: 'abc', selfAppSlug: 'homeroom' };
    PlatformTarget.notifySlug();
    assert.deepEqual(backIcons.at(-1), ['arrow', '#app/homeroom/dev/hub'], 'the arrow hears the slug, to the Hub\'s own address');
    const disc = HUB.generalHubBack(HUB.platformSlug());
    assert.equal(disc.label, 'Homeroom');
    disc.onBack();
    assert.equal(window.location.hash, backIcons.at(-1)[1], 'the disc goes where the arrow goes');
    assert.deepEqual(landed, ['homeroom']);

    unfollow();
    const before = backIcons.length;
    window.App._lastVersionInfo = { sha: 'abd', selfAppSlug: 'other' };
    PlatformTarget.notifySlug();
    assert.equal(backIcons.length, before, 'an unmounted screen is not re-synced');
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
});

test('the Messages screen follows the slug for as long as it is mounted', () => {
  assert.match(SCREEN, /useEffect\(\(\) => followPlatformSlug\(\), \[\]\);/);
  // #3653: once the slug is known, a channel on this screen goes to that
  // hub's Discussion tab (channelToHub); anything else re-syncs its chrome.
  assert.match(read('frontend/src/features/messages/store.ts'),
    /export function followPlatformSlug\(\): \(\) => void \{[^}]*return subscribePlatformSlug\(\(\) => \{ if \(state\.route\.open && !channelToHub\(\)\) syncChrome\(\); \}\);/);
});
