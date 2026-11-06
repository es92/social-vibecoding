'use strict';

// QA 2026-09-24 Q1: Back from Messages or the Workshop to "/" left two
// screens stacked.
//
// The `!hash` branch of App.restoreFromHash decides between two things: go
// home (navigateHome, which swaps the screen), or STAY on home (reveal it and
// retitle, with no swap). It decided with a chain of `_inX` flags, and the
// chain did not know about Messages or the Workshop. So Back from either took
// the staying branch: home was revealed over a screen nobody hid, the two
// `flex-1` roots split the page between them, the Messages or Workshop tab
// stayed lit, and on a phone the bottom bar ended up floating mid-page. Back
// from Discover or Profile worked, because those two were in the chain.
//
// These drive the real router in a vm, the way tests/app-close-origin.test.js
// does: enter a tab root, press Back, and check what is on screen and which
// tab is lit.
//
// Run with: node --test tests/back-to-home-from-tab-roots.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public/js/app.js'), 'utf8');
const ORIGIN = 'https://homeroom.test';

function fakeElement() {
  const classes = new Set();
  const attrs = new Map();
  return {
    classList: {
      add: (...n) => n.forEach((c) => classes.add(c)),
      remove: (...n) => n.forEach((c) => classes.delete(c)),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : !!force;
        if (on) classes.add(c); else classes.delete(c);
        return on;
      },
      contains: (c) => classes.has(c),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    style: {}, innerHTML: '', textContent: '',
    querySelector: () => null, querySelectorAll: () => [],
    appendChild() {},
    addEventListener() {},
  };
}

function router() {
  const location = new URL('/', ORIGIN);
  const entries = [location.href];
  let at = 0;
  let App = null;
  const history = {
    state: null,
    get length() { return entries.length; },
    pushState(_s, _t, url) {
      entries.splice(at + 1);
      entries.push(new URL(url, location.href).href);
      at = entries.length - 1;
      location.href = entries[at];
    },
    replaceState(_s, _t, url) {
      entries[at] = new URL(url, location.href).href;
      location.href = entries[at];
    },
    back() {
      if (at === 0) return;
      at -= 1;
      location.href = entries[at];
      App._routeFromHash();
    },
  };
  const tabs = [];
  const noop = () => undefined;
  const elements = new Map();
  const context = vm.createContext({
    PlatformI18n: require('./lib/platform-i18n').englishPlatformI18n(),
    location, history, URL, URLSearchParams, console, setTimeout, clearTimeout,
    document: {
      title: '',
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, fakeElement());
        return elements.get(id);
      },
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, dispatchEvent() {},
    },
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    PlatformUI: new Proxy({
      transition(fn, o) { fn(); o?.after?.(); },
    }, { get: (t, k) => (k in t ? t[k] : noop) }),
  });
  context.window = context;
  vm.runInContext(APP_JS, context);
  App = context.App;
  let messagesOpen = false;
  let workshopOpen = false;
  context.UsernodeReact = {
    nav: { setScreen: (screen) => tabs.push(screen), setViewer() {}, park() {} },
    backButton: { set() {} },
    sidePanel: { appPresence() {} },
    messages: {
      route() { messagesOpen = true; }, isOpen: () => messagesOpen,
      close() { messagesOpen = false; }, syncChrome() {},
    },
    workshop: { open() { workshopOpen = true; }, close() { workshopOpen = false; } },
  };
  context.AppView = new Proxy({ close() {} }, { get: (t, k) => (k in t ? t[k] : noop) });
  context.Home = new Proxy({}, { get: () => noop });
  const visible = (id) => App._isScreenVisible(id);
  return {
    App,
    tabs,
    // A tab press: the address moves, then the router follows it.
    go(address) {
      history.pushState(null, '', address);
      App._routeFromHash();
    },
    back: () => history.back(),
    route: () => `${location.pathname}${location.search}${location.hash}`,
    // A main-realm array, so deepEqual compares contents rather than realms.
    onScreen: () => Array.from(App.SCREEN_IDS.filter(visible)),
    workshopOpen: () => workshopOpen,
  };
}

for (const [label, address, screen, flag] of [
  ['Messages', '#messages', 'messages-screen', '_inMessages'],
  // One Home (#6361): the Communities screen (#workshop) is Needs you now.
  ['Needs you', '#needs', 'workshop-screen', '_inWorkshop'],
]) {
  test(`QA Q1: Back from ${label} to "/" leaves exactly Home on screen, Home lit`, () => {
    const r = router();
    r.App.restoreFromHash();
    r.go(address);
    assert.deepEqual(r.onScreen(), [screen], `${label} is up`);
    assert.equal(r.App[flag], true);

    r.back();

    assert.equal(r.route(), '/');
    assert.deepEqual(r.onScreen(), ['home-screen'],
      `only Home: ${label} must be hidden, not left under it`);
    assert.equal(r.App._revealedScreen, 'home-screen');
    assert.equal(r.tabs.at(-1), 'home-screen', 'and the Home tab is the lit one');
    assert.equal(r.App[flag], false, `the ${label} visit is over`);
  });
}

test('QA Q1: the Needs you island is told it closed', () => {
  const r = router();
  r.App.restoreFromHash();
  r.go('#needs');
  assert.equal(r.workshopOpen(), true);
  r.back();
  assert.equal(r.workshopOpen(), false);
});

test('QA Q1: #create over Messages goes home first, too', () => {
  // The #create branch asked the same question with its own copy of the
  // chain, and had lost the same two screens.
  const r = router();
  r.App.restoreFromHash();
  r.go('#messages');
  r.go('#create');
  assert.deepEqual(r.onScreen(), ['home-screen']);
});

test('QA Q1: every screen that sets an _inX flag is sent home by both "/" branches', () => {
  // A screen added later has to be added to both lists, or Back to "/" from
  // it stacks two screens again. The flags are read from app.js itself.
  const flags = [...new Set(APP_JS.match(/App\._in[A-Z][A-Za-z]*(?= = true)/g) || [])];
  assert.ok(flags.length >= 8, `found the flags (${flags.join(', ')})`);
  const bare = APP_JS.slice(APP_JS.indexOf('      if (!hash) {'),
    APP_JS.indexOf('      const parts = hash.split(\'/\');'));
  const create = APP_JS.slice(APP_JS.indexOf("if (parts[0] === 'create') {"),
    APP_JS.indexOf("if (parts[0] === 'leaderboard') {"));
  for (const flag of flags) {
    assert.ok(bare.includes(`else if (${flag}) App.navigateHome();`),
      `the bare root sends ${flag} home`);
    assert.ok(create.includes(flag), `#create sends ${flag} home`);
  }
});
