'use strict';

// Exercise the actual router, directory lifecycle, and header click handler
// together. Testing Browse.handleBack alone misses a hidden directory claiming
// the Home button after its detail page has launched an app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function harness() {
  const nodes = new Map();
  function element(id) {
    if (nodes.has(id)) return nodes.get(id);
    const classes = new Set(id === 'home-screen' ? [] : ['hidden']);
    const attrs = new Map();
    const listeners = new Map();
    const el = {
      id, innerHTML: '', listeners,
      classList: {
        add: value => classes.add(value), remove: value => classes.delete(value),
        contains: value => classes.has(value),
        toggle(value, on) { if (on) classes.add(value); else classes.delete(value); },
      },
      setAttribute: (name, value) => attrs.set(name, value),
      getAttribute: name => attrs.get(name),
      addEventListener: (name, fn) => listeners.set(name, fn),
    };
    nodes.set(id, el);
    return el;
  }
  const location = new URL('https://homeroom.test/');
  const history = {
    pushState(_state, _title, url) { location.href = new URL(url, location).href; },
    replaceState(_state, _title, url) { location.href = new URL(url, location).href; },
  };
  let releaseOpen;
  let frameMounted = false;
  let closes = 0;
  let tabRenders = 0;
  const AppView = {
    appData: null,
    beginLaunch() { frameMounted = true; },
    open() { return new Promise(resolve => { releaseOpen = resolve; }); },
    close() { closes++; AppView.appData = null; },
    _teardownDevRoots() {},
    _unmountAppFrame() { frameMounted = false; },
    // #2902: Home retires the frame (kept loaded, hidden) — off screen either way.
    _retireAppFrame() { frameMounted = false; },
  };
  const context = vm.createContext({
    location, history, URL, URLSearchParams, console,
    document: { title: '', getElementById: element, querySelector: () => null, addEventListener() {} },
    addEventListener() {}, localStorage: { getItem: () => null },
    PlatformUI: { transition(fn, opts) { fn(); opts?.after?.(); } },
    Home: { load() {}, publishImproveTarget() {}, _apps: [] },
    AppView,
    PlatformI18n: englishPlatformI18n(),
  });
  context.window = context;
  vm.runInContext(read('public/js/app.js'), context);
  const { App } = context;
  // Only rendering/network infrastructure is replaced. Visibility publications
  // are applied synchronously, as the React screen hook does in the browser.
  App.Visibility._store().listeners.add(() => {
    for (const [id, visible] of Object.entries(App.Visibility._store().visible)) {
      element(id).classList.toggle('hidden', !visible);
    }
  });
  App.ImproveStatus = { setAppOpen() {} };
  App._wirePullToRefresh = () => {};
  App.switchTab = () => { tabRenders++; };
  App.bindEvents();
  return {
    App, location, context,
    visible: id => !element(id).classList.contains('hidden'),
    get frameMounted() { return frameMounted; },
    get closes() { return closes; },
    get tabRenders() { return tabRenders; },
    clickBack() {
      const el = element('back-btn');
      el.listeners.get('click')({ currentTarget: el, preventDefault() {} });
    },
    finishOpen(appData = { slug: 'coffee', name: 'Pourover Coffee' }) {
      AppView.appData = appData;
      releaseOpen();
    },
  };
}

// THE ✕ RETURNS TO THE PAGE THE APP WAS OPENED FROM (App.closeApp). One
// Home (#6361) retired the directory (#apps), so Home is that page here; the
// ✕ leaves the app the way every exit does, and Home's zoom-out drops the
// frame, as it always has.
test('the ✕ closes an app opened from Home back to Home', async () => {
  const h = harness();
  const opening = h.App.navigateToApp('coffee');
  h.finishOpen();
  await opening;
  assert.equal(h.visible('app-view'), true);
  h.clickBack();
  assert.equal(h.location.pathname + h.location.hash, '/');
  assert.equal(h.visible('home-screen'), true);
  assert.equal(h.visible('app-view'), false);
  assert.equal(h.frameMounted, false);
  assert.equal(h.App.currentApp, null);
});

test('the ✕ during a pending app load cannot be intercepted or undone by its completion', async () => {
  const h = harness();
  const opening = h.App.navigateToApp('coffee');
  h.clickBack();
  h.finishOpen();
  await opening;
  assert.equal(h.location.pathname + h.location.hash, '/', 'back on Home, where the app was opened from');
  assert.equal(h.visible('home-screen'), true);
  assert.equal(h.visible('app-view'), false);
  assert.equal(h.App.currentApp, null);
  assert.equal(h.tabRenders, 0, 'the old async router tail must not reopen the app');
});

test('app navigation retires the previous report target before loading, including when loading fails', async t => {
  const {loadTsx, renderToHtml, createElement} = require('./lib/render-tsx');
  const ui = loadTsx('tests/fixtures/app-report-actions-api.ts');
  const h = harness();
  const previousWindow = global.window;
  global.window = h.context;
  h.context.Improve = ui.Improve;
  h.App.ImproveStatus = ui.ImproveStatus;
  ui.Improve._prefetched = true;
  t.after(() => { global.window = previousWindow; });
  ui.Improve.setTarget({kind:'platform',slug:'homeroom',name:'Homeroom',canReport:true});
  const menu = () => renderToHtml(createElement(ui.AppsSwitcherSheet));
  assert.match(menu(), /improve-row-report/);
  const opening = h.App.navigateToApp('missing');
  assert.equal(ui.improveStore.get().slug, null, 'the pending route cannot report the old app');
  assert.doesNotMatch(menu(), /improve-row-report/);
  h.finishOpen(null);
  await opening;
  assert.doesNotMatch(menu(), /improve-row-report/, 'a failed load cannot restore the old target');
  assert.match(h.context.document.title, /App not available/);
  const retry = h.App.navigateToApp('coffee');
  h.finishOpen({slug:'coffee',name:'Pourover Coffee',can_report:true});
  await retry;
  assert.equal(ui.improveStore.get().slug, 'coffee');
  assert.match(menu(), /improve-row-report/, 'an available app gets its own report action');
});
