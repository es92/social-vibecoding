'use strict';
// #5995: "Linked accounts", "Linked phones" and "Connectors & CLI" did not say
// whether anything was set up behind them, and Experimental did not say its
// features are still being tried. The Settings menu now says how many are
// linked or connected, in muted words at the row's end ("2 linked"), and
// nothing at all when there are none; Experimental carries a small grey
// "Beta" label. The counts come from the lists the pages already load.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SETTINGS_SOURCE = read('frontend/src/features/settings/settings.js');
const NAV = 'frontend/src/features/settings/settings-nav.tsx';

function node(id) {
  const classes = new Set();
  return {
    id, value: '', textContent: '', disabled: false, children: [],
    classList: {
      add: (...n) => n.forEach((c) => classes.add(c)),
      remove: (...n) => n.forEach((c) => classes.delete(c)),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    appendChild(child) { this.children.push(child); },
    append(...kids) { this.children.push(...kids); },
    addEventListener() {},
  };
}

// The real settings.js in a vm, with `fetch` answering from `routes`.
function harness(routes) {
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); };
  const context = vm.createContext({
    window: { location: { search: '', origin: 'https://example.test' } },
    document: {
      addEventListener() {},
      getElementById: get,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => node(`created:${tag}`),
    },
    fetch: async (url) => {
      const key = Object.keys(routes).find((prefix) => String(url).startsWith(prefix));
      const answer = key ? routes[key] : { status: 404 };
      return {
        ok: (answer.status || 200) < 400,
        status: answer.status || 200,
        json: async () => answer.body,
      };
    },
    setTimeout, clearTimeout, setInterval, clearInterval, console,
    PlatformI18n: englishPlatformI18n(),
  });
  context.window.window = context.window;
  context.window.document = context.document;
  vm.runInContext(SETTINGS_SOURCE, context);
  const Settings = context.window.Settings;
  // Only the counting is under test here, not the panels' own paint.
  Settings._renderConnectors = () => {};
  Settings._renderGithubLink = () => {};
  Settings._renderCliTokens = () => {};
  Settings._publishConnectors = () => {};
  Settings._publishSocialIdentity = () => {};
  Settings._publishCliTokens = () => {};
  Settings._cliAuthAvailable = async () => true;
  let paints = 0;
  Settings._renderNav = () => { paints += 1; };
  return { Settings, paints: () => paints };
}

test('the catalog says it in words, singular and plural', () => {
  const t = englishPlatformI18n().t;
  assert.equal(t('settings:nav.status.linked', { count: 1 }), '1 linked');
  assert.equal(t('settings:nav.status.linked', { count: 2 }), '2 linked');
  assert.equal(t('settings:nav.status.connected', { count: 3 }), '3 connected');
  assert.equal(message('settings:nav.tag.beta'), 'Beta');
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a row counts what its page loaded, and a zero or a failure says nothing', async () => {
  const { Settings, paints } = harness({
    '/api/me/connectors': { body: { connectors: [{ id: 'a' }, { id: 'b' }], hint: null } },
    // CLI credential history: revoked and expired rows come back too, and the
    // list is paged, so the menu does not count it at all.
    '/api/me/cli-tokens': { body: { tokens: [
      { id: 't1', status: 'valid' }, { id: 't2', status: 'revoked' }, { id: 't3', status: 'expired' },
    ], next_cursor: 'more' } },
    '/api/me/social-identities': { body: {
      providers: { github: { provider: 'github', linked: true }, x: { provider: 'x', linked: false } },
      entitlement: {},
    } },
  });
  Settings._open = true;
  // Before anything has loaded, no row says anything.
  for (const key of ['linked-accounts', 'phones', 'connectors']) {
    assert.equal(Settings._navStatusText(key), '', `${key} is silent before its load`);
  }
  await Settings._loadConnectors();
  assert.equal(Settings._navStatusText('connectors'), '2 connected');
  await Settings._loadCliTokens(true);
  assert.equal(Settings._navStatusText('connectors'), '2 connected', 'CLI credentials are not added in');
  await Settings._loadGithubLink();
  assert.equal(Settings._navStatusText('linked-accounts'), '1 linked');
  // The phones section reports through the same seam.
  Settings._setNavStatus('phones', 0);
  assert.equal(Settings._navStatusText('phones'), '', 'zero says nothing, never "0 linked"');
  Settings._setNavStatus('phones', 2);
  assert.equal(Settings._navStatusText('phones'), '2 linked');
  await tick();
  // A change repaints the menu, but never inline: the phones pane reports
  // from a React effect, and an inline flushSync there is a console error.
  const before = paints();
  Settings._setNavStatus('phones', 2);
  await tick();
  assert.equal(paints(), before, 'the same count again does not repaint');
  Settings._setNavStatus('phones', 1);
  Settings._setNavStatus('linked-accounts-x', 3);
  assert.equal(paints(), before, 'no repaint during the call');
  await tick();
  assert.equal(paints(), before + 1, 'one repaint after it, for both reports');
  // Closed Settings stores the count and paints nothing.
  Settings._open = false;
  Settings._setNavStatus('phones', 4);
  await tick();
  assert.equal(paints(), before + 1);
  assert.equal(Settings._navStatusText('phones'), '4 linked');
  // Pages with nothing to count say nothing.
  assert.equal(Settings._navStatusText('account'), '');
});

test('a failed load reports nothing', async () => {
  const { Settings } = harness({
    '/api/me/connectors': { status: 404 },
    '/api/me/social-identities': { status: 500 },
  });
  await Settings._loadConnectors();
  await Settings._loadGithubLink();
  assert.equal(Settings._navStatusText('connectors'), '');
  assert.equal(Settings._navStatusText('linked-accounts'), '');
});

test('Experimental carries a Beta tag and nothing else; the tag wins the row edge', () => {
  const { Settings } = harness({});
  assert.deepEqual({ ...Settings._navExtras('experimental') }, { tag: 'Beta', status: '' });
  Settings._setNavStatus('phones', 1);
  assert.deepEqual({ ...Settings._navExtras('phones') }, { tag: '', status: '1 linked' });
  assert.deepEqual({ ...Settings._navExtras('account') }, { tag: '', status: '' });
  // Every keyed row is a page the menu lists.
  const pages = new Set(Settings.SECTIONS.map((s) => s.page || s.key));
  for (const key of [...Object.keys(Settings.TAGS), ...Object.keys(Settings.STATUS)]) {
    assert.ok(pages.has(key), `${key} is a page`);
  }
});

test('the devices section reports its lists to the menu, and clears it on a failed load', () => {
  // #5974: the page lists phones and browsers, and the menu's "3 linked"
  // counts both; a load that fails on both sides clears the count.
  const src = read('frontend/src/features/settings/sections/linked-phones.tsx');
  assert.match(src, /_setNavStatus\?\.\('phones', count\)/);
  assert.match(src, /if \(phones \|\| browsers\) reportPhones\(\(phones\?\.length \|\| 0\) \+ \(browsers\?\.length \|\| 0\)\)/);
  const load = src.slice(src.indexOf('const load = useCallback('), src.indexOf("useEffect(() => { void load(); }"));
  assert.match(load, /if \(!nextPhones && !nextBrowsers\) reportPhones\(null\)/, 'a failed reload clears the count');
});

test('a load that succeeds and then fails leaves the row saying nothing', async () => {
  const routes = {
    '/api/me/connectors': { body: { connectors: [{ id: 'a' }], hint: null } },
    '/api/me/social-identities': { body: {
      providers: { github: { provider: 'github', linked: true } }, entitlement: {},
    } },
  };
  const { Settings } = harness(routes);
  await Settings._loadConnectors();
  await Settings._loadGithubLink();
  assert.equal(Settings._navStatusText('connectors'), '1 connected');
  assert.equal(Settings._navStatusText('linked-accounts'), '1 linked');
  // Disconnected meanwhile, and the reload answers 503: no stale count.
  routes['/api/me/connectors'] = { status: 503 };
  routes['/api/me/social-identities'] = { status: 503 };
  await Settings._loadConnectors();
  await Settings._loadGithubLink();
  assert.equal(Settings._navStatusText('connectors'), '');
  assert.equal(Settings._navStatusText('linked-accounts'), '');
  // A good load after that counts again; a 404 clears it too.
  routes['/api/me/connectors'] = { body: { connectors: [{ id: 'a' }, { id: 'b' }], hint: null } };
  await Settings._loadConnectors();
  assert.equal(Settings._navStatusText('connectors'), '2 connected');
  routes['/api/me/connectors'] = { status: 404 };
  await Settings._loadConnectors();
  assert.equal(Settings._navStatusText('connectors'), '');
});

function renderNav(descriptor, which) {
  const real = require(require.resolve('react', { paths: [path.join(ROOT, 'frontend')] }));
  const React = {
    ...real,
    useState: () => ['', () => {}],
    useEffect() {},
    useSyncExternalStore: (subscribe, get) => get(),
  };
  const nav = loadTsx(NAV, {
    stubs: {
      react: React,
      './settings-nav-store.js': { settingsNavStore: { get: () => descriptor, subscribe: () => () => {} } },
      '../../lib/i18n/react': { useMessages: () => englishPlatformI18n().t },
    },
  });
  return nav[which]();
}

function rows(tree) {
  const found = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.props && n.props['data-settings-nav'] !== undefined) found.push(n);
    if (n.props) walk(n.props.children);
  })(tree);
  return found;
}

const row = (key, label, extras) => ({ key, label, terms: label.toLowerCase(), parts: [], subtitle: '', status: '', tag: '', ...extras });

test('the phone menu draws the count under the name, the tag before the chevron, and nothing on the rest', () => {
  // Phone review #62 (23 Nov 2026): the count moved from the trailing edge,
  // where with the chevron and the bookmark it cut the name, to the line
  // under the name.
  const items = [
    row('phones', 'Linked phones', { status: '2 linked' }),
    row('experimental', 'Experimental', { tag: 'Beta' }),
    row('account', 'Account'),
  ];
  const found = rows(renderNav({ desktop: null, mobile: [{ name: 'G', items }], visit: 1 }, 'SettingsMobileMenu'));
  const by = Object.fromEntries(found.map((n) => [n.props['data-settings-nav'], n.props]));
  assert.equal(by.account.trailing, undefined, 'a row with nothing to say has no trailing slot');
  assert.equal(by.account.subtitle, undefined, 'and no second line');
  assert.equal(by.phones.trailing, undefined, 'the count is not on the trailing edge');
  const text = (n) => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(text).join('')
    : n && n.props ? text(n.props.children) : '');
  assert.equal(text(by.phones.subtitle), '2 linked', 'it is the line under the name');
  const tag = by.experimental.trailing;
  const tagEl = tag.type({ ...tag.props });
  assert.equal(tagEl.props.children, 'Beta');
  assert.match(tagEl.props.className, /rounded-full bg-zinc-100/, 'a grey pill, no accent');
  assert.doesNotMatch(tagEl.props.className, /violet|emerald|green/);
});

test('the sidebar row keeps one button and adds the words after the label', () => {
  const items = [
    { ...row('connectors', 'Connectors & CLI', { status: '3 connected' }), active: false, className: 'c' },
    { ...row('account', 'Account'), active: true, className: 'c' },
  ];
  const tree = renderNav({ desktop: [{ name: 'G', first: true, items }], mobile: null, visit: 1 }, 'SettingsNavDesktop');
  const navRows = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.props && n.props.item) navRows.push(n);
    if (n.props) walk(n.props.children);
  })(tree);
  // The sidebar row is the shared ListRow, as a button: its name is the
  // row's title and the words are its trailing content, after the name.
  const [connectors, account] = navRows.map((n) => n.type(n.props));
  assert.equal(connectors.props.as, 'button');
  assert.equal(connectors.props['data-settings-nav'], 'connectors');
  assert.equal(connectors.props.title, 'Connectors & CLI');
  const trailing = connectors.props.trailing;
  assert.equal(trailing.type(trailing.props).props.children, '3 connected');
  assert.equal(account.props['aria-current'], 'page');
  assert.equal(account.props.title, 'Account', 'a plain row is its name alone');
  assert.equal(account.props.trailing.type(account.props.trailing.props), null, 'with nothing after it');
});
