'use strict';

// The shell's half of navigation telemetry (#3369): App._syncPlatformTabs,
// the one place that settles which screen is showing, reports each step to
// UITelemetry.navigate, and never a Home drawn under a first-run sheet.
// The telemetry client's own half is pinned in tests/ui-telemetry.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const appSource = read('public/js/app.js');
const serverTelemetry = require('../src/services/ui-telemetry');

function harness({ gate = 'open' } = {}) {
  const calls = [];
  let releaseGate = () => {};
  const settled = gate === 'open'
    ? Promise.resolve()
    : new Promise((resolve) => { releaseGate = resolve; });
  const context = vm.createContext({
    location: new URL('https://homeroom.test/'),
    history: { pushState() {}, replaceState() {} },
    URL, URLSearchParams, console, Promise,
    document: {
      title: '',
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
      body: { classList: { toggle() {}, contains: () => false, add() {}, remove() {} } },
    },
    addEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
  });
  context.window = context;
  vm.runInContext(appSource, context);
  const { App } = context;
  context.UsernodeReact = { nav: { setScreen() {} } };
  context.UITelemetry = {
    navigate: (code, ctx) => calls.push(['navigate', code, ctx?.appSlug || null]),
    markNextVia: (via) => calls.push(['via', via]),
  };
  context.CommunitiesFirstRun = { settled: () => settled };
  return { App, calls, releaseGate };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('every screen root maps to a navigation code the server accepts', () => {
  const { App } = harness();
  const codes = new Set(Object.values(App._NAV_CODE_FOR_SCREEN));
  codes.add('app');
  codes.add('project');
  // The first-run sheets and the tour report themselves; the rest are the
  // screen roots this hook names.
  const overlays = ['username_sheet', 'terms_sheet', 'join_sheet', 'tour'];
  // `assistant` was Global Chat's screen. Nothing reports it since Global
  // Chat was removed; the collector keeps the code so the visits already
  // recorded still read (src/services/ui-telemetry.js).
  const retired = ['assistant'];
  assert.deepEqual([...codes, ...overlays, ...retired].sort(), [...serverTelemetry.NAV_SCREENS].sort(),
    'the shell and the collector name the same screens');
  for (const code of retired) assert.ok(!codes.has(code), `${code} is no screen's any more`);
  for (const id of App.SCREEN_IDS) {
    if (id === 'app-view' || id === 'admin-screen') continue;
    assert.ok(App._NAV_CODE_FOR_SCREEN[id], `${id} is reported`);
  }
  assert.equal(App._NAV_CODE_FOR_SCREEN['admin-screen'], undefined, 'the admin console is never reported');
});

test('each screen swap reports one step; an app is split into the running app and its project', async () => {
  const { App, calls } = harness();
  App.currentApp = 'run-club';
  App._syncPlatformTabs('home-screen');
  await tick();
  App.currentTab = 'app';
  App._syncPlatformTabs('app-view');
  App.currentTab = 'dev';
  App._syncPlatformTabs('app-view');
  App._syncPlatformTabs('messages-screen');
  App._syncPlatformTabs('admin-screen');
  assert.deepEqual(calls, [
    ['navigate', 'home', null],
    ['navigate', 'app', 'run-club'],
    ['navigate', 'project', 'run-club'],
    ['navigate', 'messages', null],
  ]);
});

test('nothing is reported under a first-run sheet; the screen showing when it closes is', async () => {
  const { App, calls, releaseGate } = harness({ gate: 'pending' });
  App._syncPlatformTabs('home-screen');
  App._syncPlatformTabs('browse-screen');
  await tick();
  assert.deepEqual(calls, [], 'Home under the username, terms or join sheet was never seen');
  releaseGate();
  await tick();
  assert.deepEqual(calls, [['navigate', 'discover', null]], 'only the latest screen, once');
  App._syncPlatformTabs('workshop-screen');
  assert.deepEqual(calls.at(-1), ['navigate', 'communities', null], 'later steps go straight through');
});

test('the signed-out shell and the side panel report nothing', async () => {
  const { App, calls } = harness();
  App._reportNavigation(null, false);
  App.embeddedPanel = true;
  App._reportNavigation('home-screen', false);
  await tick();
  assert.deepEqual(calls, []);
});

test('notification taps, invite links and arriving addresses say how the person got there', () => {
  assert.match(read('frontend/src/features/notifications/notifications.js'),
    /_onItemClick\(id\) \{[\s\S]{0,400}markNextVia\?\.\('nudged'\)/,
    'every notification tap, in-app or push, marks the next step as nudged');
  assert.match(appSource, /async _followInvite\(token\) \{\s*App\._markNavigationVia\?\.\('handed'\);/);
  assert.match(appSource, /if \(rawHash \|\| pathRoute\) App\._markNavigationVia\?\.\('address'\);/);
  assert.match(read('public/js/ui-telemetry.js'), /navigationType === 'traverse'\) markNextVia\('back'\)/);
});
