const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  // #1079 chunk B: same module, now inside the React bundle.
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'header', 'node-pill.js'),
  'utf8'
);

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

// ONE bundle per process: a second `loadTsx` entry would hand this file a
// different `nodePillStore` from the one the components subscribe to.
let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/node-pill-api.ts')));

/**
 * The row as the browser draws it, from the store the module just published.
 *
 * These were DOM stubs whose `className` and `textContent` the module wrote
 * directly. It publishes now and the component renders, so the same
 * assertions read REAL markup — which also means a component that dropped an
 * id, or emitted a computed class Tailwind never compiled, would fail them.
 */
function rowParts() {
  const html = renderToHtml(createElement(mod().NodePillRow, {}));
  const cls = (id) => (html.match(new RegExp(`id="${id}"[^>]*class="([^"]*)"`)) || [, ''])[1];
  const text = (id) => (html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`)) || [, ''])[1];
  const has = (id, name) => cls(id).split(/\s+/).includes(name);
  return {
    html,
    row: { className: cls('account-row-node'), classList: { contains: (n) => has('account-row-node', n) } },
    dot: { className: cls('account-node-dot'), classList: { contains: (n) => has('account-node-dot', n) } },
    status: { className: cls('account-node-status'), textContent: text('account-node-status') },
  };
}

/** The detail sheet's body, likewise — it reads the same store. */
function sheetHtml() {
  return renderToHtml(createElement(mod().NodeSheetBody, {}));
}

function loadNodePill({ hasNodeStatus, snapshot = null, isNative = true, reader = null }) {
  const windowListeners = {};
  const documentListeners = {};
  const intervals = new Map();
  let nextInterval = 1;
  let statusReads = 0;
  const doc = {
    visibilityState: 'visible',
    addEventListener(type, listener) { documentListeners[type] = listener; },
  };
  const sandbox = {
    document: doc,
    setInterval(fn) { const id = nextInterval++; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    console: { log() {}, warn() {}, error() {} },
    NativeChrome: {
      has() { return hasNodeStatus; },
    },
    usernode: {
      isNative,
      async getNodeStatus() {
        statusReads += 1;
        return reader ? reader(statusReads) : snapshot;
      },
    },
    addEventListener(type, listener) { windowListeners[type] = listener; },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // The module is an ordinary bundle module and pulls its store and its two
  // portal helpers in by name. Bind the REAL store, stub the portal helpers
  // (the sheet's kit hand-off needs a browser), and drop the import lines so
  // the body evaluates as a script exactly as it did — same technique as
  // tests/challenge-template-prefill.test.js.
  mod().nodePillStore.set({ ...mod().NODE_PILL_EMPTY });
  sandbox.nodePillStore = mod().nodePillStore;
  sandbox.NODE_PILL_EMPTY = mod().NODE_PILL_EMPTY;
  sandbox.mountNodeSheet = () => {};
  sandbox.unmountNodeSheet = () => {};
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import[^\n]*\n/gm, ''), sandbox);
  // The module used to end with `NodePill.init()`. It is initialised from the
  // island's layout effect now (so the `hidden` it lifts off #account-row-node
  // lands after hydration), which makes the call this harness's job.
  sandbox.window.NodePill.init();
  return {
    get row() { return rowParts().row; },
    get dot() { return rowParts().dot; },
    get status() { return rowParts().status; },
    get sheetHtml() { return sheetHtml(); },
    get statusReads() { return statusReads; },
    get timers() { return intervals.size; },
    tick() { for (const fn of [...intervals.values()]) fn(); },
    setVisibility(state) {
      doc.visibilityState = state;
      if (documentListeners.visibilitychange) documentListeners.visibilitychange();
    },
    setLiveRefresh(reason, on) { sandbox.window.NodePill.setLiveRefresh(reason, on); },
    refresh() { return sandbox.window.NodePill.refresh(); },
    // #1402's four derivations. They are DECISIONS, so the merge kept them in
    // the module rather than moving them into the component — which also
    // keeps upstream's tests for them pointed at their original subject.
    networkHeightFor(detail) {
      return sandbox.window.NodePill._networkHeightFor(detail);
    },
    readyPeersFor(detail) {
      return sandbox.window.NodePill._readyPeersFor(detail);
    },
    tipAgeFor(detail, nowMs) {
      return sandbox.window.NodePill._tipAgeFor(detail, nowMs);
    },
    warningMessagesFor(detail) {
      return Array.from(sandbox.window.NodePill._warningMessagesFor(detail));
    },
    dispatchNodeStatus(detail) {
      if (windowListeners['usernode:node-status']) {
        windowListeners['usernode:node-status']({ detail });
      }
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('successful capability probe reveals and populates the Node row',
  async () => {
    const loaded = loadNodePill({
      hasNodeStatus: Promise.resolve(true),
      snapshot: { status: 'synced' },
    });

    await settle();

    assert.equal(loaded.row.classList.contains('hidden'), false);
    assert.equal(loaded.status.textContent, 'Synced');
    assert.equal(loaded.statusReads, 1);
    // The row's click was an addEventListener on the element; it is the
    // component's onClick now, dispatching into a named module function.
    const rowSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src',
      'features', 'header', 'node-pill-row.tsx'), 'utf8');
    assert.match(rowSrc, /onClick=\{\(\) => controller\(\)\?\.openFromRow\?\.\(\)\}/);
    assert.match(source, /\n    openFromRow\(\) \{/);
  });

test('native status event reveals the row while the first probe is inconclusive',
  async () => {
    const probe = deferred();
    const loaded = loadNodePill({ hasNodeStatus: probe.promise });

    loaded.dispatchNodeStatus({ status: 'syncing' });

    assert.equal(loaded.row.classList.contains('hidden'), false);
    assert.equal(loaded.status.textContent, 'Syncing');
    assert.equal(loaded.statusReads, 0);

    probe.resolve(false);
    await settle();
    assert.equal(loaded.row.classList.contains('hidden'), false,
      'a degraded probe must not undo native event evidence');
  });

test('unsupported native builds keep the Node row present',
  async () => {
    const loaded = loadNodePill({
      hasNodeStatus: Promise.resolve(false),
    });

    await settle();

    assert.equal(loaded.row.classList.contains('hidden'), false);
    assert.equal(loaded.statusReads, 0);
    assert.equal(loaded.status.textContent, 'Unavailable');

    loaded.dispatchNodeStatus(null);
    loaded.dispatchNodeStatus({});
    assert.equal(loaded.row.classList.contains('hidden'), false,
      'temporary or malformed state must not rewrite native navigation');
  });

test('desktop keeps the native-only Node row hidden', async () => {
  const loaded = loadNodePill({
    hasNodeStatus: Promise.resolve(false),
    isNative: false,
  });

  await settle();

  assert.equal(loaded.row.classList.contains('hidden'), true);
  assert.equal(loaded.statusReads, 0);
  });

// #1079: the detail sheet's body was six nodes built imperatively and blanked
// with `body.textContent = ''` on every status event. It reads the same store
// the row does now, which is the point — the two surfaces cannot disagree.
test('the detail sheet renders from the same status the row does', () => {
  const loaded = loadNodePill({
    hasNodeStatus: true,
    snapshot: {
      status: 'syncing',
      localBestHeight: 1234,
      networkBestHeight: 5678,
      connectedPeers: 8,
      totalPeers: 42,
    },
  });
  loaded.dispatchNodeStatus({
    status: 'syncing',
    localBestHeight: 1234,
    networkBestHeight: 5678,
    connectedPeers: 8,
    totalPeers: 42,
  });
  const html = loaded.sheetHtml;
  assert.match(html, /Syncing/);
  assert.match(html, /Your block height/);
  assert.match(html, /1,234/);
  assert.match(html, /Network block height/);
  assert.match(html, /5,678/);
  assert.match(html, /8 ready \/ 42 known/);
  // The row agrees, from the same publish.
  assert.equal(loaded.status.textContent, 'Syncing');
});

test('unknown numbers render an em dash, never a zero', () => {
  const loaded = loadNodePill({ hasNodeStatus: true, snapshot: null });
  loaded.dispatchNodeStatus({ status: 'offline' });
  const html = loaded.sheetHtml;
  // An unknown height and a height of zero are different facts.
  assert.doesNotMatch(html, />0</);
  // Four now, not three: #1402 added the chain, and an unknown chain is a
  // fact worth showing rather than a blank row.
  assert.equal((html.match(/—/g) || []).length, 4, 'four unknown figures');
  assert.match(html, /Offline/);
});

// ── #1402, merged from upstream/main ────────────────────────────────────
//
// The four derivations below are unchanged from the commit that added them —
// they are decisions and they stayed in the module. The sheet test is not: it
// walked `sheetBody.children[n].children[m].textContent` through a DOM stub,
// and there is no such stub any more. It asserts the same six facts against
// the markup the component actually renders.

test('Network block height follows the node sync state', async () => {
  const loaded = loadNodePill({ hasNodeStatus: Promise.resolve(false) });
  await settle();

  assert.equal(loaded.networkHeightFor({
    status: 'synced',
    localBestHeight: 120,
    networkBestHeight: 130,
  }), 120, 'a synced node uses its own best tip');
  assert.equal(loaded.networkHeightFor({
    status: 'syncing',
    localBestHeight: 120,
    networkBestHeight: 130,
  }), 130, 'a syncing node uses its target best tip');
});

test('ready peers use the explicit field with legacy fallback', async () => {
  const loaded = loadNodePill({ hasNodeStatus: Promise.resolve(false) });
  await settle();

  assert.equal(loaded.readyPeersFor({
    readyPeers: 4,
    connectedPeers: 3,
  }), 4);
  assert.equal(loaded.readyPeersFor({ connectedPeers: 3 }), 3);
});

test('best-tip age is corrected for node clock drift', async () => {
  const loaded = loadNodePill({ hasNodeStatus: Promise.resolve(false) });
  await settle();

  assert.equal(loaded.tipAgeFor({
    localBestTimestampMs: 100000,
    clockDriftMs: 2000,
  }, 120000), '18 seconds ago');
  assert.equal(loaded.tipAgeFor({
    localBestTimestampMs: 100000,
  }, 220000), '2 minutes ago');
});

test('node warnings are conditional and ordered', async () => {
  const loaded = loadNodePill({ hasNodeStatus: Promise.resolve(false) });
  await settle();

  assert.deepEqual(loaded.warningMessagesFor({
    readyPeers: 0,
    syncStalled: true,
    clockDriftMs: -6000,
    walletDataHydrating: true,
  }), [
    'No connected peers.',
    'Sync appears stalled.',
    'Node clock is out of sync.',
    'Wallet-data hydration is still running.',
  ]);
  assert.deepEqual(loaded.warningMessagesFor({
    readyPeers: 2,
    syncStalled: false,
    clockDriftMs: 5000,
    walletDataHydrating: false,
  }), []);
});

test('Node sheet puts chain first and labels ready peers', async () => {
  const loaded = loadNodePill({ hasNodeStatus: Promise.resolve(false) });
  await settle();

  loaded.dispatchNodeStatus({
    status: 'syncing',
    chain: 'testnet',
    localBestHeight: 120,
    networkBestHeight: 130,
    readyPeers: 4,
    totalPeers: 7,
    syncStalled: true,
  });

  const html = loaded.sheetHtml;
  assert.ok(html.indexOf('Chain') < html.indexOf('Your block height'),
    'the chain row comes first');
  assert.match(html, /Chain<\/span><span[^>]*>testnet</);
  assert.match(html, /Your block height<\/span><span[^>]*>120</);
  assert.match(html, /Network block height<\/span><span[^>]*>130</,
    'a syncing node shows its target tip, not its own');
  assert.match(html, /4 ready \/ 7 known/);
  assert.match(html, /role="status"/);
  assert.match(html, /Sync appears stalled\./);
});

test('a healthy node draws no warning box at all', async () => {
  const loaded = loadNodePill({ hasNodeStatus: Promise.resolve(false) });
  await settle();

  loaded.dispatchNodeStatus({
    status: 'synced',
    chain: 'testnet',
    localBestHeight: 130,
    readyPeers: 4,
    totalPeers: 7,
  });

  const html = loaded.sheetHtml;
  assert.doesNotMatch(html, /role="status"/,
    'an empty warning list renders nothing, not an empty box');
  // A synced node's own tip IS the network height — the same number twice.
  assert.match(html, /Network block height<\/span><span[^>]*>130</);
});

test('a known tip age rides along with the height, in one row', async () => {
  const loaded = loadNodePill({ hasNodeStatus: Promise.resolve(false) });
  await settle();

  loaded.dispatchNodeStatus({
    status: 'synced',
    localBestHeight: 12480,
    localBestTimestampMs: Date.now() - 4 * 60 * 1000,
  });

  assert.match(loaded.sheetHtml, /12,480 · 4 minutes ago/);
});

test('Settings keeps the Node row current without a tap', async () => {
  const loaded = loadNodePill({
    hasNodeStatus: Promise.resolve(true),
    reader: (n) => ({ status: n === 1 ? 'syncing' : 'synced' }),
  });
  await settle();
  assert.equal(loaded.status.textContent, 'Syncing');
  assert.equal(loaded.statusReads, 1);
  assert.equal(loaded.timers, 0, 'nothing polls until something is on screen');

  loaded.setLiveRefresh('settings', true);
  await settle();
  assert.equal(loaded.statusReads, 2, 'reveal pulls at once');
  assert.equal(loaded.status.textContent, 'Synced');
  assert.match(loaded.row.className, /flex/);
  assert.equal(loaded.timers, 1);

  loaded.tick();
  await settle();
  assert.equal(loaded.statusReads, 3, 'and on every interval after');

  loaded.setLiveRefresh('settings', false);
  assert.equal(loaded.timers, 0, 'leaving Settings stops the pull');
  loaded.tick();
  await settle();
  assert.equal(loaded.statusReads, 3);
});

test('live refresh pauses in the background and pulls on return', async () => {
  const loaded = loadNodePill({
    hasNodeStatus: Promise.resolve(true),
    snapshot: { status: 'synced' },
  });
  await settle();
  loaded.setLiveRefresh('settings', true);
  await settle();
  const before = loaded.statusReads;

  loaded.setVisibility('hidden');
  assert.equal(loaded.timers, 0, 'no pulls while the app is hidden');
  await settle();
  assert.equal(loaded.statusReads, before);

  loaded.setVisibility('visible');
  await settle();
  assert.equal(loaded.statusReads, before + 1, 'returning pulls at once');
  assert.equal(loaded.timers, 1);
});

test('live refresh is single-flight and needs the capability', async () => {
  let release;
  const loaded = loadNodePill({
    hasNodeStatus: Promise.resolve(true),
    reader: (n) => (n === 1 ? { status: 'syncing' }
      : new Promise((resolve) => { release = () => resolve({ status: 'synced' }); })),
  });
  await settle();
  loaded.setLiveRefresh('settings', true);
  loaded.refresh();
  loaded.tick();
  await settle();
  assert.equal(loaded.statusReads, 2, 'a read in flight is not doubled');
  release();
  await settle();
  assert.equal(loaded.status.textContent, 'Synced');

  const unsupported = loadNodePill({ hasNodeStatus: Promise.resolve(false) });
  await settle();
  unsupported.setLiveRefresh('settings', true);
  unsupported.tick();
  await settle();
  assert.equal(unsupported.statusReads, 0, 'no reads without getNodeStatus');
});

test('the Node sheet pulls while open and a status event still wins between pulls', async () => {
  const loaded = loadNodePill({
    hasNodeStatus: Promise.resolve(true),
    snapshot: { status: 'syncing' },
  });
  await settle();
  loaded.dispatchNodeStatus({ status: 'offline' });
  assert.equal(loaded.status.textContent, 'Offline');
  assert.match(source, /NodePill\.setLiveRefresh\('sheet', true\)/);
  assert.match(source, /onDismiss: \(\) => \{\n\s*NodePill\.setLiveRefresh\('sheet', false\)/);
  const rowSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src',
    'features', 'header', 'node-pill-row.tsx'), 'utf8');
  assert.match(rowSrc, /data-node-status=\{s\.status\}/);
  const settingsSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src',
    'features', 'settings', 'account-rows.tsx'), 'utf8');
  assert.match(settingsSrc, /setLiveRefresh\?\.\('settings', liveNode\)/);
});
