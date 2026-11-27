'use strict';

// #4938, #5974: Settings › Linked devices.
//
// What this pins about the pane (frontend/src/features/settings/sections/
// linked-phones.tsx), the registry row that offers it and its routes:
//
//   - it is a part of the Account group, at #settings/phones (the key and
//     the ids stay from when it was Linked phones), named Linked devices,
//     with its own keywords, and its wrapper ships hidden like every part;
//   - the prerendered markup carries both groups' headings and no device:
//     the lists are read in an effect, so hydration matches whatever the
//     account holds;
//   - it reads GET /api/me/phones and GET /api/me/browser-sessions and draws
//     each answer's `devices`: one row per device, never one per sign-in
//     (#7159), a row with several saying how many it holds;
//   - it unlinks with DELETE /api/me/phones/device/:key and signs out with
//     DELETE /api/me/browser-sessions/device/:key, same-origin browser routes
//     that end every sign-in of that device and answer 404 for a device the
//     signed-in account does not have; the per-row routes stay for any
//     other caller;
//   - Unlink and Sign out ask once more on the row before they act, saying
//     how many sign-ins will end when there are several, and the Settings
//     menu's count is the rows of both groups together;
//   - a device not used for more than 30 days says "Not used since".
//
// The services are pinned by tests/linked-phones-postgres.test.js and
// tests/linked-browsers-postgres.test.js.
//
// Run with: node --test tests/settings-linked-phones-pane.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const escape = (text) => text.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const PANE_PATH = 'frontend/src/features/settings/sections/linked-phones.tsx';
const PANE = read(PANE_PATH);
const SECTIONS = read('frontend/src/features/settings/sections/index.tsx');
const SETTINGS = read('frontend/src/features/settings/settings.js');
const AUTH = read('src/routes/auth.js');

test('Linked devices is a part of the Account group with its own address and keywords', () => {
  assert.match(
    SETTINGS,
    /\{ key: 'phones', label: 'settings:nav\.part\.phones', group: 'settings:nav\.group\.account' \}/
  );
  assert.match(SETTINGS, /phones: 'settings:nav\.keywords\.phones'/);
  assert.match(SECTIONS, /<PrivacySection \/>[\s\S]*<LinkedPhonesSection \/>[\s\S]*<WalletSection \/>/);
  assert.equal(message('settings:nav.part.phones'), 'Linked devices');
  assert.equal(message('settings:phones.title'), 'Linked devices');
  assert.match(message('settings:nav.subtitle.phones'), /\bbrowsers\b/i);
  assert.match(message('settings:nav.keywords.phones'), /\bdevices?\b.*\bunlink\b/);
  assert.match(message('settings:nav.keywords.phones'), /\bbrowsers?\b/);
  assert.match(message('settings:nav.keywords.phones'), /\b(laptop|computer)\b/);
});

test('the prerendered pane is hidden, names both groups and lists no device', () => {
  const { LinkedPhonesSection } = loadTsx(PANE_PATH);
  const html = renderToHtml(createElement(LinkedPhonesSection, {}));
  assert.match(html, /^<div data-settings-section="phones" class="hidden">/);
  assert.match(html, /id="settings-phones-section"/);
  // Each group is the shared grouped list (its rows are ListRows), empty
  // until the devices are read.
  assert.match(html, /<div class="ui-glist [^"]*" id="settings-phones-list"><\/div>/);
  assert.match(html, /<div class="ui-glist [^"]*" id="settings-browsers-list"><\/div>/);
  assert.ok(html.includes(escape(message('settings:phones.title'))));
  assert.ok(html.includes(escape(message('settings:phones.intro'))));
  // The two groups, phones first, each with its explaining line.
  const phones = html.indexOf(`>${escape(message('settings:phones.group.phones'))}</h4>`);
  const browsers = html.indexOf(`>${escape(message('settings:phones.group.browsers'))}</h4>`);
  assert.ok(phones > 0 && browsers > phones, 'Phones, then Browsers');
  assert.ok(html.includes(escape(message('settings:phones.phonesNote'))), 'why one phone can be two rows');
  assert.ok(html.includes(escape(message('settings:phones.browsers.note'))));
  assert.doesNotMatch(html, /data-linked-phone=/);
  assert.doesNotMatch(html, /data-linked-browser=/);
});

test('the pane reads and acts through the account\'s own routes', () => {
  assert.match(PANE, /const ENDPOINT = '\/api\/me\/phones';/);
  assert.match(PANE, /const BROWSERS_ENDPOINT = '\/api\/me\/browser-sessions';/);
  assert.match(PANE, /method: 'DELETE'/);
  assert.match(PANE, /useEffect\(\(\) => \{ void load\(\); \}, \[load\]\);/, 'read in an effect, never during render');
  assert.match(PANE, /if \(asking\) void unlink\(phone\); else setConfirming\(id\);/, 'the first press only asks');
  assert.match(PANE, /if \(asking\) void signOut\(browser\); else setConfirming\(id\);/, 'the same for a browser');
  // #7159: the page draws devices and ends a whole device.
  assert.match(PANE, /fetch\(`\$\{ENDPOINT\}\/device\/\$\{encodeURIComponent\(phone\.key\)\}`/);
  assert.match(PANE, /fetch\(`\$\{BROWSERS_ENDPOINT\}\/device\/\$\{encodeURIComponent\(browser\.key\)\}`/);
  assert.match(AUTH, /res\.json\(\{ phones, devices: linkedPhones\.groupLinkedPhones\(phones\) \}\)/, 'the per-install list stays for the mobile app');
  assert.match(AUTH, /res\.json\(\{ browsers, devices: linkedBrowsers\.groupLinkedBrowsers\(browsers\) \}\)/);
  assert.match(AUTH, /router\.delete\('\/api\/me\/phones\/device\/:key', sameOriginBrowserOnly/);
  assert.match(AUTH, /linkedPhones\.unlinkPhoneDevice\(client, req\.user\.id, key, \{ currentCredential \}\)/, 'scoped to the signed-in account');
  assert.match(AUTH, /router\.delete\('\/api\/me\/browser-sessions\/device\/:key', sameOriginBrowserOnly/);
  assert.match(AUTH, /linkedBrowsers\.signOutBrowserDevice\(pool, req\.user\.id, key, \{ currentToken \}\)/, 'scoped to the signed-in account');
  assert.equal(AUTH.match(/if \(current\) \{\s+clearSessionCookies\(res\);/g).length, 2, 'either way of signing this browser out drops its cookies');
  assert.match(AUTH, /router\.get\('\/api\/me\/phones'/);
  assert.match(AUTH, /router\.delete\('\/api\/me\/phones\/:id', sameOriginBrowserOnly/);
  assert.match(AUTH, /linkedPhones\.unlinkPhone\(client, req\.user\.id, phoneId\)/, 'scoped to the signed-in account');
  assert.match(AUTH, /if \(!unlinked\) return res\.status\(404\)/);
  assert.match(AUTH, /router\.get\('\/api\/me\/browser-sessions'/);
  assert.match(AUTH, /router\.delete\('\/api\/me\/browser-sessions\/:id', sameOriginBrowserOnly/);
  assert.match(AUTH, /linkedBrowsers\.signOutBrowser\(pool, req\.user\.id, sessionId, \{ currentToken \}\)/, 'scoped to the signed-in account');
  assert.match(AUTH, /if \(!signedOut\) return res\.status\(404\)/);
  // Signing this browser out drops its cookies as logout does, so the
  // reload lands signed out rather than on a cookie that names nothing.
  assert.match(AUTH, /if \(current\) \{\s+clearSessionCookies\(res\);/);
  // The session's id is a digest prefix, never the token, and the phone
  // route is untouched for the mobile app.
  assert.doesNotMatch(AUTH, /res\.json\(\{ (phones|browsers)[^}]*token/);
});

test('every device row and confirmation is catalog text', () => {
  for (const id of [
    'settings:phones.group.phones', 'settings:phones.group.browsers', 'settings:phones.phonesNote',
    'settings:phones.platform.android', 'settings:phones.platform.ios', 'settings:phones.platform.unknown',
    'settings:phones.thisPhone', 'settings:phones.unlink', 'settings:phones.cancel',
    'settings:phones.confirm', 'settings:phones.confirmThisPhone', 'settings:phones.empty',
    'settings:phones.confirmGrouped', 'settings:phones.confirmThisPhoneGrouped',
    'settings:phones.detailGrouped', 'settings:phones.detailGroupedStale',
    'settings:phones.browsers.confirmGrouped', 'settings:phones.browsers.confirmThisBrowserGrouped',
    'settings:phones.browsers.detailGrouped', 'settings:phones.browsers.detailGroupedStale',
    'settings:phones.loadFailed', 'settings:phones.unlinkFailed',
    'settings:phones.browsers.note', 'settings:phones.browsers.empty', 'settings:phones.browsers.name',
    'settings:phones.browsers.nameSystemOnly', 'settings:phones.browsers.unknown',
    'settings:phones.browsers.thisBrowser', 'settings:phones.browsers.signOut',
    'settings:phones.browsers.confirm', 'settings:phones.browsers.confirmThisBrowser',
    'settings:phones.browsers.loadFailed', 'settings:phones.browsers.signOutFailed',
  ]) {
    assert.ok(PANE.includes(`'${id}'`), `${id} is asked for by the pane`);
    assert.ok(message(id, { count: 2 }), `${id} has English text`);
  }
  for (const [word, ids] of Object.entries({
    browser: ['chrome', 'safari', 'firefox', 'edge', 'opera', 'samsung'],
    os: ['mac', 'windows', 'linux', 'android', 'ios', 'ipad', 'chromeos'],
  })) {
    for (const key of ids) {
      const id = `settings:phones.browsers.${word}.${key}`;
      assert.ok(PANE.includes(`'${id}'`), `${id} is asked for by the pane`);
      assert.ok(message(id), `${id} has English text`);
    }
  }
  assert.equal(
    message('settings:phones.detail', { lastUsed: 'Oct 1, 2026', linked: 'Sep 2, 2026' }),
    'Last used Oct 1, 2026 · Linked Sep 2, 2026'
  );
  assert.equal(
    message('settings:phones.detailStale', { lastUsed: 'Oct 1, 2026', linked: 'Sep 2, 2026' }),
    'Not used since Oct 1, 2026 · Linked Sep 2, 2026'
  );
  assert.equal(
    message('settings:phones.browsers.detail', { lastUsed: 'Oct 1, 2026', signedIn: 'Sep 2, 2026' }),
    'Last used Oct 1, 2026 · Signed in Sep 2, 2026'
  );
  assert.equal(
    message('settings:phones.browsers.detailStale', { lastUsed: 'Oct 1, 2026', signedIn: 'Sep 2, 2026' }),
    'Not used since Oct 1, 2026 · Signed in Sep 2, 2026'
  );
  assert.equal(message('settings:phones.browsers.name', { browser: 'Chrome', os: 'Mac' }), 'Chrome on Mac');
  // #7159: a row is a device, and says how many sign-ins it holds.
  assert.match(message('settings:phones.phonesNote'), /one kind of phone/i);
  assert.match(message('settings:phones.browsers.note'), /one browser on one system/i);
  assert.equal(
    message('settings:phones.detailGrouped', { count: 13, lastUsed: 'Nov 6, 2026', linked: 'Nov 6, 2026' }),
    '13 sign-ins · Last used Nov 6, 2026 · Linked Nov 6, 2026'
  );
  assert.equal(
    message('settings:phones.browsers.detailGroupedStale', { count: 3, lastUsed: 'Oct 1, 2026', signedIn: 'Sep 2, 2026' }),
    '3 sign-ins · Not used since Oct 1, 2026 · Signed in Sep 2, 2026'
  );
  assert.equal(message('settings:phones.confirmGrouped', { count: 13 }), 'Press Unlink again to end all 13 sign-ins of this phone.');
  assert.equal(
    message('settings:phones.browsers.confirmThisBrowserGrouped', { count: 3 }),
    'This is the browser you are using. Press Sign out again to end all 3 sign-ins and sign out here.'
  );
});

// ── The pane runs, effects and all, on a React stepped by hand ───────────
// (the harness of tests/settings-privacy-pane.test.js)
function createSteppedReact() {
  const slots = [];
  let cursor = 0;
  let component = null;
  let dirty = false;
  let queued = [];
  const h = { tree: null };
  const changed = (prev, next) => !prev || prev.some((value, i) => !Object.is(value, next[i]));
  const slot = (init) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = init();
    return slots[i];
  };
  h.React = {
    // The shared row (@/components/ui/grouped-list) is made with forwardRef
    // when the pane loads. Nothing here renders it: the pane's own DeviceRow
    // elements are what these tests read.
    forwardRef: (render) => render,
    useRef: (current) => slot(() => ({ current })),
    useState(initial) {
      const s = slot(() => {
        const state = { value: initial };
        state.set = (next) => {
          const value = typeof next === 'function' ? next(state.value) : next;
          if (!Object.is(value, state.value)) { state.value = value; dirty = true; }
        };
        return state;
      });
      return [s.value, s.set];
    },
    useCallback(fn, deps) {
      const s = slot(() => ({ fn, deps }));
      if (changed(s.deps, deps)) { s.fn = fn; s.deps = deps; }
      return s.fn;
    },
    useEffect(effect, deps) {
      const s = slot(() => ({ effect: true, deps: null, cleanup: null }));
      if (!changed(s.deps, deps)) return;
      s.deps = deps;
      queued.push(() => {
        if (s.cleanup) s.cleanup();
        s.cleanup = effect();
      });
    },
  };
  const paint = () => {
    cursor = 0;
    dirty = false;
    queued = [];
    h.tree = component({});
    for (const run of queued) run();
  };
  h.mount = (fn) => { component = fn; paint(); };
  h.settle = async () => {
    for (let i = 0; i < 8; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (dirty) paint();
    }
  };
  return h;
}

function findAll(node, wanted, out = []) {
  if (Array.isArray(node)) { for (const item of node) findAll(item, wanted, out); return out; }
  if (!node || typeof node !== 'object' || !node.props) return out;
  if (wanted(node)) out.push(node);
  findAll(node.props.children, wanted, out);
  return out;
}

const DAY = 86400e3;
const HERE = 'chrome-mac';
const AWAY = 'safari-ios';
const NAMELESS = 'other-other';

// What the two routes answer: `phones` and `browsers` are one row per
// sign-in (four phones, six browsers), `devices` one row per device, which
// is all the pane draws.
function fakeAccount() {
  const now = Date.now();
  const iso = (daysAgo) => new Date(now - daysAgo * DAY).toISOString();
  return {
    phones: {
      phones: [
        { id: `nsi_${'A'.repeat(43)}`, platform: 'android', linkedAt: iso(100), lastUsedAt: iso(45), current: false },
        { id: `nsi_${'B'.repeat(43)}`, platform: null, linkedAt: iso(20), lastUsedAt: iso(2), current: false },
        { id: `nsi_${'C'.repeat(43)}`, platform: null, linkedAt: iso(60), lastUsedAt: iso(50), current: false },
        { id: `nsi_${'D'.repeat(43)}`, platform: null, linkedAt: iso(70), lastUsedAt: iso(65), current: false },
      ],
      devices: [
        { key: 'phone', platform: null, count: 3, linkedAt: iso(20), lastUsedAt: iso(2), current: false },
        { key: 'android', platform: 'android', count: 1, linkedAt: iso(100), lastUsedAt: iso(45), current: false },
      ],
    },
    browsers: {
      browsers: [
        { id: '0123456789abcdef', browser: 'chrome', os: 'mac', signedInAt: iso(3), lastUsedAt: iso(0), current: true },
        { id: '1123456789abcdef', browser: 'chrome', os: 'mac', signedInAt: iso(9), lastUsedAt: iso(8), current: false },
        { id: 'fedcba9876543210', browser: 'safari', os: 'ios', signedInAt: iso(90), lastUsedAt: iso(40), current: false },
        { id: 'eedcba9876543210', browser: 'safari', os: 'ios', signedInAt: iso(95), lastUsedAt: iso(80), current: false },
        { id: 'dedcba9876543210', browser: 'safari', os: 'ios', signedInAt: iso(99), lastUsedAt: iso(85), current: false },
        { id: '00000000deadbeef', browser: null, os: null, signedInAt: iso(1), lastUsedAt: iso(1), current: false },
      ],
      devices: [
        { key: HERE, browser: 'chrome', os: 'mac', count: 2, signedInAt: iso(3), lastUsedAt: iso(0), current: true },
        { key: NAMELESS, browser: null, os: null, count: 1, signedInAt: iso(1), lastUsedAt: iso(1), current: false },
        { key: AWAY, browser: 'safari', os: 'ios', count: 3, signedInAt: iso(90), lastUsedAt: iso(40), current: false },
      ],
    },
  };
}

function mountPane(t, account) {
  const realFetch = globalThis.fetch;
  const realWindow = globalThis.window;
  t.after(() => { globalThis.fetch = realFetch; globalThis.window = realWindow; });
  const calls = [];
  const counts = [];
  let reloads = 0;
  const windowEvents = {};
  globalThis.window = {
    location: { reload() { reloads += 1; } },
    Settings: { _setNavStatus(key, count) { counts.push([key, count]); } },
  };
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push(`${method} ${url}`);
    if (method === 'DELETE') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url === '/api/me/phones') return { ok: true, status: 200, json: async () => account.phones };
    if (url === '/api/me/browser-sessions') return { ok: true, status: 200, json: async () => account.browsers };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const h = createSteppedReact();
  // The message id, and the count it was asked with when there is one.
  const tr = (id, params) => (params && params.count !== undefined ? `${id}#${params.count}` : id);
  const mod = loadTsx(PANE_PATH, {
    stubs: {
      react: h.React,
      '../../../lib/i18n/react': { useMessages: () => tr },
      '../../../lib/legacy-dom': { useWindowEvent: (name, fn) => { windowEvents[name] = fn; } },
      '@/components/ui/field': { SectionHeading: () => null },
    },
  });
  h.mount(mod.LinkedPhonesSection);
  const row = (attr, id) => findAll(h.tree, (el) => el.props.attrs && el.props.attrs[attr] === id)[0];
  const rows = (attr) => findAll(h.tree, (el) => el.props.attrs && attr in el.props.attrs).map((el) => el.props.attrs[attr]);
  const fire = (name, detail) => windowEvents[name]({ type: name, detail });
  return { h, calls, counts, reloads: () => reloads, row, rows, fire };
}

test('both groups load one row per device, the menu counts the rows, and a forgotten device says so', async (t) => {
  const { h, calls, counts, row, rows } = mountPane(t, fakeAccount());
  await h.settle();
  assert.deepEqual(calls, ['GET /api/me/phones', 'GET /api/me/browser-sessions'], 'both lists, read together');
  // #7159: four phone sign-ins and six browser sign-ins are five devices.
  assert.deepEqual(rows('data-linked-phone'), ['phone', 'android']);
  assert.deepEqual(rows('data-linked-browser'), [HERE, NAMELESS, AWAY]);
  assert.deepEqual(counts.at(-1), ['phones', 5], 'two phones and three browsers, never their ten sign-ins');

  const here = row('data-linked-browser', HERE);
  assert.equal(here.props.name, 'settings:phones.browsers.name', 'Chrome on Mac');
  assert.equal(here.props.here, 'settings:phones.browsers.thisBrowser', 'the browser in hand stays marked');
  assert.equal(here.props.detail, 'settings:phones.browsers.detailGrouped#2', 'two sign-ins, said on its line');
  assert.equal(here.props.actionLabel, 'settings:phones.browsers.signOut');

  const away = row('data-linked-browser', AWAY);
  assert.equal(away.props.here, null);
  assert.equal(away.props.detail, 'settings:phones.browsers.detailGroupedStale#3', 'even its newest was 40 days ago');

  const nameless = row('data-linked-browser', NAMELESS);
  assert.equal(nameless.props.name, 'settings:phones.browsers.unknown', 'sessions from before the class was kept');
  assert.equal(nameless.props.detail, 'settings:phones.browsers.detail', 'one sign-in reads as it always did');

  const phone = row('data-linked-phone', 'android');
  assert.equal(phone.props.detail, 'settings:phones.detailStale', 'a phone not used for 45 days');
  assert.equal(phone.props.actionLabel, 'settings:phones.unlink');
  const unknown = row('data-linked-phone', 'phone');
  assert.equal(unknown.props.name, 'settings:phones.platform.unknown');
  assert.equal(unknown.props.detail, 'settings:phones.detailGrouped#3', 'its newest sign-in was used two days ago');

  // Older folds a device only when even its newest sign-in is stale.
  const older = findAll(h.tree, (el) => el.type === 'details');
  assert.equal(older.length, 2, 'one fold in each group');
  const folded = older.map((el) => findAll(el, (inner) => inner.props.attrs).map((inner) => Object.values(inner.props.attrs)[0]));
  assert.deepEqual(folded, [['android'], [AWAY]]);
});

test('Sign out asks once more, says how many sign-ins end, and ends the whole device on the second press', async (t) => {
  const { h, calls, counts, reloads, row } = mountPane(t, fakeAccount());
  await h.settle();
  calls.length = 0;

  row('data-linked-browser', AWAY).props.onAction();
  await h.settle();
  assert.equal(row('data-linked-browser', AWAY).props.asking, true);
  assert.equal(row('data-linked-browser', AWAY).props.detail, 'settings:phones.browsers.confirmGrouped#3');
  assert.deepEqual(calls, [], 'the first press only asks');

  row('data-linked-browser', AWAY).props.onCancel();
  await h.settle();
  assert.equal(row('data-linked-browser', AWAY).props.asking, false);
  assert.equal(row('data-linked-browser', AWAY).props.detail, 'settings:phones.browsers.detailGroupedStale#3');

  // A device with one sign-in asks in the words it always had.
  row('data-linked-browser', NAMELESS).props.onAction();
  await h.settle();
  assert.equal(row('data-linked-browser', NAMELESS).props.detail, 'settings:phones.browsers.confirm');
  assert.equal(row('data-linked-browser', AWAY).props.asking, false, 'one row asks at a time');

  row('data-linked-browser', AWAY).props.onAction();
  await h.settle();
  row('data-linked-browser', AWAY).props.onAction();
  await h.settle();
  assert.deepEqual(calls, [`DELETE /api/me/browser-sessions/device/${AWAY}`], 'one call ends all three');
  assert.equal(row('data-linked-browser', AWAY), undefined, 'the row is gone');
  assert.equal(reloads(), 0, 'another browser: this page stays');
  assert.deepEqual(counts.at(-1), ['phones', 4], 'the menu counts one device fewer');
});

test('signing this browser out warns on the row and then starts the page again signed out', async (t) => {
  const { h, calls, reloads, row } = mountPane(t, fakeAccount());
  await h.settle();
  calls.length = 0;

  row('data-linked-browser', HERE).props.onAction();
  await h.settle();
  assert.equal(row('data-linked-browser', HERE).props.detail, 'settings:phones.browsers.confirmThisBrowserGrouped#2');
  assert.equal(reloads(), 0);

  row('data-linked-browser', HERE).props.onAction();
  await h.settle();
  assert.deepEqual(calls, [`DELETE /api/me/browser-sessions/device/${HERE}`]);
  assert.equal(reloads(), 1, 'signed out here: the shell reloads signed out');
});

test('Unlink on a phone that holds several sign-ins says so and ends them all', async (t) => {
  const { h, calls, counts, reloads, row } = mountPane(t, fakeAccount());
  await h.settle();
  calls.length = 0;

  row('data-linked-phone', 'phone').props.onAction();
  await h.settle();
  assert.equal(row('data-linked-phone', 'phone').props.detail, 'settings:phones.confirmGrouped#3');
  assert.equal(row('data-linked-browser', HERE).props.asking, false, 'a phone and a browser never share a confirm');
  assert.deepEqual(calls, []);

  row('data-linked-phone', 'phone').props.onAction();
  await h.settle();
  assert.deepEqual(calls, ['DELETE /api/me/phones/device/phone']);
  assert.equal(row('data-linked-phone', 'phone'), undefined);
  assert.equal(reloads(), 0);
  assert.deepEqual(counts.at(-1), ['phones', 4]);

  row('data-linked-phone', 'android').props.onAction();
  await h.settle();
  assert.equal(row('data-linked-phone', 'android').props.detail, 'settings:phones.confirm', 'one sign-in: the old words');
});

test('opening another page of Settings reads nothing; opening this one reads again (#6591)', async (t) => {
  const { h, calls, fire } = mountPane(t, fakeAccount());
  await h.settle();
  calls.length = 0;

  fire('usernode:settings-section', { section: 'accessibility' });
  await h.settle();
  assert.deepEqual(calls, [], 'a hidden pane does not re-read on every switch');

  fire('usernode:settings-section', { section: 'phones' });
  await h.settle();
  assert.deepEqual(calls, ['GET /api/me/phones', 'GET /api/me/browser-sessions'], 'its own page reads both lists again');
});
