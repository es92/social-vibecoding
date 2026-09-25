const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'header',
    'wallet-sheet.js'),
  'utf8'
);

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

// ONE bundle per process: a second `loadTsx` entry would hand this file a
// different `walletSheetStore` from the one the components subscribe to.
let api = null;
const mod = () => (api || (api = loadTsx('tests/fixtures/wallet-sheet-api.ts')));

/**
 * The sheet body as the browser draws it, from the store the module published.
 *
 * `_renderStakingCard` used to RETURN a detached element and these tests
 * walked its children. The card is part of a component now, so the same
 * assertions run against real markup — reached the way the app reaches it,
 * through the module's own publish rather than by calling a renderer directly.
 */
function bodyHtml() {
  return renderToHtml(createElement(mod().WalletSheetBody, {}));
}

/** Publish `staking` through the module and return the rendered body. */
function stakingHtml(wallet, staking, { pending = false } = {}) {
  wallet._stakingSupported = true;
  wallet._stakingPending = pending;
  wallet._state = Object.assign({}, wallet._state || {}, { staking });
  wallet._publish();
  return bodyHtml();
}

/** Text content only, so a class string cannot satisfy a copy assertion. */
function textOf(html) {
  return html.replace(/<[^>]*>/g, '\n')
    .replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

function loadWallet({ bridgeInfo, walletState = null, isNative = true } = {}) {
  let stateReads = 0;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date,
    Number,
    Promise,
    setInterval() { return 1; },
    clearInterval() {},
    addEventListener() {},
    NativeChrome: {
      async getInfo() {
        return bridgeInfo || { version: 5, capabilities: [
          'getWalletState', 'submitTransaction', 'manageStaking',
        ] };
      },
      lastReadError() { return null; },
    },
    usernode: {
      isNative,
      async getWalletState() {
        stateReads += 1;
        return walletState;
      },
      async getTransactionReceipts() { return { items: [] }; },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // Bind the REAL store and stub the two portal helpers (the kit hand-off
  // needs a browser), then drop the import lines so the module body evaluates
  // as a script exactly as it did — tests/challenge-template-prefill.test.js
  // uses the same technique.
  mod().walletSheetStore.set({ ...mod().WALLET_EMPTY });
  sandbox.walletSheetStore = mod().walletSheetStore;
  sandbox.WALLET_EMPTY = mod().WALLET_EMPTY;
  sandbox.mountWalletSheet = () => {};
  sandbox.unmountWalletSheet = () => {};
  vm.createContext(sandbox);
  vm.runInContext(source.replace(/^import[^\n]*\n/gm, ''), sandbox);
  return {
    sandbox,
    wallet: sandbox.WalletSheet,
    get rowHtml() { return renderToHtml(createElement(mod().WalletRow, {})); },
    get bodyHtml() { return bodyHtml(); },
    get stateReads() { return stateReads; },
  };
}

function textTree(node) {
  return [node.textContent, ...node.children.flatMap(textTree)]
    .filter(Boolean).join('\n');
}

function findText(node, text) {
  if (node.textContent === text) return node;
  for (const child of node.children) {
    const match = findText(child, text);
    if (match) return match;
  }
  return null;
}

function findClass(node, className) {
  if (typeof node.className === 'string' &&
      node.className.split(/\s+/).includes(className)) {
    return node;
  }
  for (const child of node.children) {
    const match = findClass(child, className);
    if (match) return match;
  }
  return null;
}

test('delegate alone determines active delegation', () => {
  const { wallet } = loadWallet();

  assert.equal(wallet._isDelegated({
    delegate: null,
    delegated_since: '2026-08-11T10:30:00Z',
  }), false, 'a timestamp must not turn delegation on');
  assert.equal(wallet._isDelegated({
    delegate: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG',
    delegated_since: null,
  }), true, 'an address turns delegation on without a timestamp');
});

test('delegation card renders off, active and setup states with disclosure', () => {
  const { wallet } = loadWallet();
  const disclosure = 'When delegated, you receive half the points you would ' +
    'earn by producing blocks directly from your phone.';
  const selfHosted = 'Want to run a node on your own laptop or server and ' +
    'monitor it from your phone? Start the node there using the same ' +
    'account you use on this phone.';

  const offHtml = stakingHtml(wallet, {
    delegate: null,
    delegated_since: '2026-08-11T10:30:00Z',
  });
  const off = textOf(offHtml);
  assert.match(off, /Producing blocks on this phone/);
  assert.match(off, /earns full points/);
  assert.ok(off.includes(disclosure));
  assert.ok(off.includes(selfHosted));
  assert.doesNotMatch(off, /Delegated since/,
    'delegated_since is not active-state evidence');
  assert.doesNotMatch(
    stakingHtml(wallet, { delegate: null, delegated_since: null }),
    /bg-violet-500\/10/,
    'the delegated highlight only appears while delegated');

  const activeValue = '2026-08-11T10:30:00Z';
  const activeHtml = stakingHtml(wallet, {
    delegate: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG',
    delegated_since: activeValue,
  });
  const active = textOf(activeHtml);
  assert.match(active, /Delegated/);
  assert.match(active, /B62qiTKp…b3nvBG/);
  assert.match(active, /Block production on this phone is disabled/);
  assert.ok(active.includes('Delegated since ' +
    new Date(activeValue).toLocaleString()),
  'the timestamp follows the runtime user locale');
  assert.ok(active.includes(disclosure));
  assert.ok(active.includes(selfHosted));

  // The status line, the address and the disclosure live INSIDE the status
  // card, which is a plain card now: no violet highlight.
  const card = activeHtml.match(
    /<div data-block-production-card="status" class="([^"]*)">([\s\S]*?)<\/div><div data-block-production-card="self-hosted"/);
  assert.ok(card, 'the delegated state sits in the status card');
  assert.match(card[1], /border-zinc-200/);
  assert.match(card[2], /Delegated/);
  assert.match(card[2], /B62qiTKp…b3nvBG/);
  assert.ok(textOf(card[2]).includes(disclosure));
  assert.doesNotMatch(activeHtml, /bg-violet-500\/10/);

  const setup = textOf(stakingHtml(wallet, null));
  assert.match(setup, /Wallet setup is still in progress/);
  assert.match(setup, /Retry/);

  const pending = stakingHtml(wallet, {
    delegate: null,
    delegated_since: null,
  }, { pending: true });
  assert.match(textOf(pending), /Opening…/);
  // Disabled for the lifetime of the native promise.
  assert.match(pending, /<button[^>]*disabled=""[^>]*>Opening…<\/button>/);
});

test('background service note shows on Android only, active only while producing (#3059)', () => {
  const { wallet, sandbox } = loadWallet();
  const activeCopy = /A background service keeps running so this phone can keep producing blocks/;
  const inactiveCopy = /The background service is not active\./;
  const local = { delegate: null, delegated_since: null };
  const delegated = {
    delegate: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG',
    delegated_since: null,
  };

  // iOS / no kit: never drawn.
  assert.doesNotMatch(stakingHtml(wallet, local), /data-background-service/);
  sandbox.unNative = { platform: 'ios' };
  assert.doesNotMatch(stakingHtml(wallet, delegated), /data-background-service/);

  sandbox.unNative = { platform: 'android' };
  const producing = textOf(stakingHtml(wallet, local));
  assert.match(producing, activeCopy);
  assert.match(producing, /A notification stays visible while it is active\./);
  assert.doesNotMatch(producing, inactiveCopy);

  const off = textOf(stakingHtml(wallet, delegated));
  assert.match(off, inactiveCopy);
  assert.doesNotMatch(off, activeCopy);

  assert.match(textOf(stakingHtml(wallet, null)), inactiveCopy,
    'unfinished setup is not producing either');

  for (const html of [stakingHtml(wallet, local), stakingHtml(wallet, delegated)]) {
    assert.doesNotMatch(html, /FOREGROUND_SERVICE|permission/i,
      'no Android permission wording reaches the user');
  }
  for (const copy of [mod().BACKGROUND_SERVICE_ACTIVE, mod().BACKGROUND_SERVICE_INACTIVE]) {
    assert.ok(copy && !copy.includes('\u2014'), 'no em dashes in user copy');
  }
});

test('Block production: status card, laptop card, background warning, then the button', () => {
  const { wallet, sandbox } = loadWallet();
  sandbox.unNative = { platform: 'android' };
  const states = {
    local: { delegate: null, delegated_since: null },
    delegated: {
      delegate: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyBQL9TDb3nvBG',
      delegated_since: null,
    },
    setup: null,
  };
  for (const [name, staking] of Object.entries(states)) {
    const html = stakingHtml(wallet, staking);
    const at = (needle) => html.indexOf(needle);
    const status = at('data-block-production-card="status"');
    const selfHosted = at('data-block-production-card="self-hosted"');
    const note = at('data-background-service=');
    const button = html.indexOf('<button', note);
    assert.ok(status > -1 && status < selfHosted && selfHosted < note && note < button,
      `${name}: status, then laptop card, then the note, then the button`);
    // The disclosure is inside the status card, before the laptop card.
    const disclosure = at('When delegated, you receive half the points');
    assert.ok(disclosure > status && disclosure < selfHosted,
      `${name}: the disclosure completes the status card`);
    // The note is the soft warning; the cards are plain.
    assert.match(html, /class="[^"]*border-amber-500\/40 bg-amber-500\/10[^"]*" data-background-service=|data-background-service="[a-z]+" class="[^"]*border-amber-500\/40 bg-amber-500\/10/);
    assert.match(html, /data-block-production-card="status" class="[^"]*border-zinc-200/);
    assert.match(html, /data-block-production-card="self-hosted" class="[^"]*border-zinc-200/);
    for (const tint of [/bg-violet-500\/10/, /bg-sky-500\/10/, /bg-amber-500\/10 px-3/]) {
      assert.doesNotMatch(html, tint, `${name}: no tinted chips remain`);
    }
  }
});

test('manage action sends no values, applies native result, then refreshes',
  async () => {
    const { wallet, sandbox } = loadWallet();
    const oldState = {
      address: 'ut1-wallet',
      staking: { delegate: null, delegated_since: null },
    };
    const returned = {
      delegate: 'B62qdelegate',
      delegated_since: '2026-08-11T10:30:00Z',
    };
    wallet._state = oldState;
    wallet._stakingSupported = true;
    wallet._renderSheetBody = () => {};
    wallet._renderChip = () => {};
    let argumentCount = -1;
    let refreshed = 0;
    sandbox.usernode.manageStaking = async function () {
      argumentCount = arguments.length;
      return returned;
    };
    wallet._refreshState = async () => {
      refreshed += 1;
      assert.equal(wallet._state.staking.delegate, 'B62qdelegate',
        'native result is visible before the full snapshot refresh');
    };

    await wallet._manageStaking();

    assert.equal(argumentCount, 0);
    assert.equal(refreshed, 1);
    assert.equal(wallet._stakingPending, false);
    assert.equal(wallet._state.address, 'ut1-wallet');
  });

test('manage failure retains last state and reports a non-blocking error',
  async () => {
    const { wallet, sandbox } = loadWallet();
    const lastKnown = {
      staking: { delegate: null, delegated_since: null },
    };
    wallet._state = lastKnown;
    wallet._stakingSupported = true;
    wallet._renderSheetBody = () => {};
    wallet._renderChip = () => {};
    sandbox.usernode.manageStaking = async () => {
      throw new Error('native screen unavailable');
    };

    await wallet._manageStaking();

    assert.equal(wallet._state, lastKnown);
    assert.equal(wallet._stateError, 'native screen unavailable');
    assert.equal(wallet._stakingPending, false);
  });

test('wallet read failure retains the last snapshot and records an error',
  async () => {
    const loaded = loadWallet();
    const lastKnown = {
      address: 'ut1-wallet',
      staking: { delegate: null, delegated_since: null },
    };
    loaded.wallet._state = lastKnown;
    loaded.sandbox.usernode.getWalletState = async () => null;
    loaded.sandbox.NativeChrome.lastReadError = () => ({
      message: 'wallet provider is reconciling',
    });

    await loaded.wallet._refreshState();

    assert.equal(loaded.wallet._state, lastKnown);
    assert.equal(loaded.wallet._stateError, 'wallet provider is reconciling');
  });

test('unsupported native bridge keeps Wallet navigation but hides delegation',
  async () => {
    const loaded = loadWallet({
      bridgeInfo: { version: 3, capabilities: [] },
      walletState: null,
    });

    await loaded.wallet.init();

    // The row is present for every native top frame — capabilities affect its
    // CONTENTS, never whether Wallet is reachable. Read off the rendered row
    // rather than a stub node's classList.
    assert.doesNotMatch(loaded.rowHtml, /class="hidden /);
    assert.match(loaded.rowHtml, /id="account-row-wallet"/);
    assert.equal(loaded.wallet._stakingSupported, false);
    assert.equal(loaded.wallet._submissionSupported, false);
    assert.equal(loaded.stateReads, 0);
    // And no delegation card at all on an unsupported bridge.
    assert.doesNotMatch(loaded.bodyHtml, /Block production/);
  });

test('wallet renders Social-owned submitted and confirmed receipts', () => {
  const { wallet } = loadWallet();
  wallet._state = { tokenSymbol: 'UT' };
  wallet._submissionSupported = true;
  wallet._records = [
    {
      txId: 'tx-confirmed',
      destinationPubkey: 'ut1-confirmed-destination',
      amount: 4,
      memo: '',
      submittedAt: Date.parse('2026-08-26T10:00:00Z'),
      status: 'confirmed',
      confirmedAt: Date.parse('2026-08-26T10:00:03Z'),
      blockHeight: 42,
    },
    {
      txId: 'tx-pending',
      destinationPubkey: 'ut1-pending-destination',
      amount: 2,
      memo: '',
      submittedAt: Date.parse('2026-08-26T10:01:00Z'),
      status: 'submitted',
    },
  ];

  wallet._publish();
  const text = textOf(bodyHtml());
  assert.match(text, /Sent 4 UT to ut1-conf…nation/);
  assert.match(text, /confirmed · block 42/);
  assert.match(text, /Sent 2 UT to ut1-pend…nation/);
  assert.match(text, /pending/);
});

test('wallet implementation has no raw channel or delegation HTTP path', () => {
  assert.doesNotMatch(source, /Usernode\.postMessage/);
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /delegate(?:\/|-)undelegate|\/staking/i);
});
