const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bridgeSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'usernode-bridge.js'),
  'utf8'
);
const CALL_NATIVE_HOOK_MARKER =
  '  // ── Iframe-relay client: discover parent + receive responses';

const SETTINGS_SNAPSHOT = {
  buildInfo: { appVersion: '1.4.2', buildNumber: '87' },
  nodeSleepEnabled: true,
  debugMode: false,
  authStatus: 'authenticated',
  permissions: { platform: 'android', exactAlarmGranted: true },
};
const ESTABLISH_ATTEMPT = `nsa_${'A'.repeat(43)}`;

function establishResult(participantId = '41') {
  return {
    protocol: 2,
    attemptId: ESTABLISH_ATTEMPT,
    nativeRevision: '7',
    identity: {
      participantId,
      accountId: 'account-1',
      address: 'ut1-wallet',
    },
    runtimeStatus: { state: 'running' },
    receiptStatus: 'committedReady',
    realmSessionClaim: `realm-${participantId}`,
  };
}

async function establishRealm(loaded) {
  return loaded.sandbox.usernode.establishNativeSession({
    attemptId: ESTABLISH_ATTEMPT,
    desiredRuntime: 'running',
  });
}

// `silentMethods` / `errorMethods` are returned to the caller so a test can
// change how native behaves PART WAY THROUGH a run — the only way to
// exercise "the probe timed out once, then started answering", which is the
// difference between a degraded probe and a build that genuinely lacks a
// capability.
function loadBridge({
  capabilities = [],
  responseMethods = {},
  appUser = null,
  fetchImpl = async () => ({ ok: false }),
  silentMethods = [],
  errorMethods = {},
  // Per-method 4th argument for __usernodeResolve — the machine-readable
  // refusal envelope newer app builds send alongside the English message.
  errorInfoMethods = {},
  timeoutScale = 1,
  exposeCallNative = false,
  delayedMethods = {},
  sharedStorage = null,
} = {}) {
  const nativePosts = [];
  const messageListeners = [];
  const windowListeners = {};
  const storage = sharedStorage || new Map();
  const responses = {
    getBridgeInfo: {
      version: 5,
      capabilities,
      ...(capabilities.includes('establishNativeSession')
        ? { sessionLifecycleProtocol: 2 } : {}),
      appVersion: '0.4.0',
      buildNumber: '1223',
    },
    getPrivilegedBridgeCapability: 'navigation-capability',
    getNodeAddress: 'ut1-sender',
    submitTransaction: { txId: 'tx-authoritative' },
    establishNativeSession: establishResult(
      appUser && appUser.id != null ? String(appUser.id) : '41'
    ),
    getWalletState: { address: 'ut1-wallet' },
    manageStaking: {
      delegate: 'B62qdelegate',
      delegated_since: '2026-08-11T10:30:00Z',
    },
    getSettingsState: SETTINGS_SNAPSHOT,
    getSocialPushState: {
      enabled: true,
      permissionStatus: 'authorized',
      registrationStatus: 'registered',
      deliveryActive: true,
    },
    claimPendingSocialNotification: { notificationId: 42 },
    captureScreenshot: {
      contentType: 'image/jpeg',
      base64: '/9j/2Q==',
    },
    markPrivilegedBridgeReady: { ready: true },
    ...responseMethods,
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date,
    Math,
    Promise,
    URL,
    URLSearchParams,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init.detail; }
    },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    setTimeout(fn, delay) { return setTimeout(fn, delay * timeoutScale); },
    clearTimeout,
    location: {
      href: 'https://social.example/',
      host: 'social.example',
      protocol: 'https:',
      search: '',
    },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    document: {
      currentScript: { src: 'https://social.example/usernode-bridge.js' },
      readyState: 'complete',
      head: { appendChild() {} },
      body: { appendChild() {} },
      getElementById() { return null; },
      addEventListener() {},
      createElement() {
        return {
          appendChild() {},
          setAttribute() {},
          addEventListener() {},
          style: {},
        };
      },
    },
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.push(listener);
      if (!windowListeners[type]) windowListeners[type] = [];
      windowListeners[type].push(listener);
    },
    dispatchEvent(event) {
      for (const listener of windowListeners[event.type] || []) listener(event);
    },
    fetch: fetchImpl,
  };
  if (appUser) sandbox.App = { user: appUser };
  sandbox.window = sandbox;
  sandbox.parent = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.Usernode = {
    postMessage(raw) {
      const request = JSON.parse(raw);
      nativePosts.push(request);
      if (silentMethods.includes(request.method)) return;
      if (Object.prototype.hasOwnProperty.call(errorMethods, request.method)) {
        if (Object.prototype.hasOwnProperty.call(
          errorInfoMethods, request.method
        )) {
          sandbox.__usernodeResolve(
            request.id, null, errorMethods[request.method],
            errorInfoMethods[request.method]
          );
          return;
        }
        // Deliberately three arguments: every installed app build calls it
        // this way and must keep behaving exactly as it does today.
        sandbox.__usernodeResolve(
          request.id, null, errorMethods[request.method]
        );
        return;
      }
      const value = Object.prototype.hasOwnProperty.call(
        responses, request.method
      ) ? responses[request.method] : true;
      if (Object.prototype.hasOwnProperty.call(delayedMethods, request.method)) {
        setTimeout(() => {
          sandbox.__usernodeResolve(request.id, value, null);
        }, delayedMethods[request.method] * timeoutScale);
        return;
      }
      sandbox.__usernodeResolve(request.id, value, null);
    },
  };
  vm.createContext(sandbox);
  const source = exposeCallNative
    ? bridgeSource.replace(
      CALL_NATIVE_HOOK_MARKER,
      '  window.__callNativeForBoundaryTest = callNative;\n\n' +
      CALL_NATIVE_HOOK_MARKER
    )
    : bridgeSource;
  if (exposeCallNative) {
    assert.notEqual(source, bridgeSource,
      'the test-only callNative hook marker must match the production bridge');
  }
  vm.runInContext(source, sandbox);

  return {
    sandbox,
    nativePosts,
    silentMethods,
    errorMethods,
    // Let a method that was dropped start answering (a native side that was
    // merely busy, not a build that lacks the method).
    unsilence(method) {
      const at = silentMethods.indexOf(method);
      if (at !== -1) silentMethods.splice(at, 1);
    },
    dispatchMessage(event) {
      for (const listener of messageListeners) listener(event);
    },
    dispatchWindow(type, event = {}) {
      for (const listener of windowListeners[type] || []) listener(event);
    },
  };
}

test('exact-session calls carry both closure-only root and realm claims', async () => {
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability',
      'establishNativeSession',
      'logout',
      'getWalletState',
    ],
  });

  const status = await establishRealm(loaded);
  await loaded.sandbox.usernode.logout();
  await loaded.sandbox.usernode.getWalletState();

  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    [
      'getBridgeInfo',
      'getPrivilegedBridgeCapability',
      'establishNativeSession',
      'logout',
      'getWalletState',
    ]
  );
  assert.equal(
    loaded.nativePosts[2].privilegedCapability,
    'navigation-capability'
  );
  assert.equal(
    loaded.nativePosts[3].privilegedCapability,
    'navigation-capability'
  );
  assert.equal('privilegedCapability' in loaded.nativePosts[0], false);
  assert.equal('privilegedCapability' in loaded.nativePosts[1], false);
  assert.equal(
    loaded.nativePosts[4].privilegedCapability,
    'navigation-capability'
  );
  assert.equal(loaded.nativePosts[4].realmSessionClaim, 'realm-41');
  assert.equal('realmSessionClaim' in loaded.nativePosts[2], false,
    'establishment cannot borrow a not-yet-created realm claim');
  assert.equal(loaded.sandbox.usernode.realmSessionClaim, undefined,
    'the realm claim is not exposed on the public bridge object');
  assert.equal(loaded.sandbox.usernode.privilegedCapability, undefined,
    'the capability is not exposed on the public bridge object');
  assert.deepEqual(JSON.parse(JSON.stringify(status)), {
    protocol: 2,
    attemptId: ESTABLISH_ATTEMPT,
    nativeRevision: '7',
    identity: {
      participantId: '41', accountId: 'account-1', address: 'ut1-wallet',
    },
    runtimeStatus: { state: 'running' },
    receiptStatus: 'committedReady',
  });
  assert.equal(Object.isFrozen(status), true);
  assert.equal(Object.isFrozen(status.identity), true);
  assert.equal(Object.isFrozen(status.runtimeStatus), true);
});

test('identity-only establishment is admitted without wallet authority', async () => {
  const response = establishResult();
  response.identity.accountId = null;
  response.identity.address = null;
  response.runtimeStatus = { state: 'notStarted' };
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability',
      'establishNativeSession',
    ],
    responseMethods: { establishNativeSession: response },
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(await establishRealm(loaded))),
    {
      protocol: 2,
      attemptId: ESTABLISH_ATTEMPT,
      nativeRevision: '7',
      identity: { participantId: '41', accountId: null, address: null },
      runtimeStatus: { state: 'notStarted' },
      receiptStatus: 'committedReady',
    },
  );
});

test('settings state is bound to the exact established native session', async () => {
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability',
      'establishNativeSession',
      'getSettingsState',
    ],
  });

  assert.equal(await loaded.sandbox.usernode.getSettingsState(), null);
  assert.equal(loaded.nativePosts.length, 0,
    'settings must fail locally rather than cross native without a session');

  await establishRealm(loaded);
  assert.deepEqual(
    await loaded.sandbox.usernode.getSettingsState(),
    SETTINGS_SNAPSHOT,
  );

  const settingsPost = loaded.nativePosts.at(-1);
  assert.equal(settingsPost.method, 'getSettingsState');
  assert.equal(settingsPost.privilegedCapability, 'navigation-capability');
  assert.equal(settingsPost.realmSessionClaim, 'realm-41');
});

test('login preparation is root-privileged without borrowing session authority',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'prepareForLogin'],
    });

    assert.equal(await loaded.sandbox.usernode.prepareForLogin(), true);
    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      ['getBridgeInfo', 'getPrivilegedBridgeCapability', 'prepareForLogin'],
    );
    assert.equal(
      loaded.nativePosts[2].privilegedCapability,
      'navigation-capability',
    );
    assert.equal('realmSessionClaim' in loaded.nativePosts[2], false,
      'a recovered native session may predate the current web realm');
  });

test('native establishment rejects widened or non-canonical receipts', async () => {
  const widenedIdentity = establishResult();
  widenedIdentity.identity.credential = 'must-not-cross';
  const invalidRuntime = establishResult();
  invalidRuntime.runtimeStatus = {
    state: 'startFailed', validatedCode: 'NOT_CANONICAL',
  };
  const partialWallet = establishResult();
  partialWallet.identity.accountId = null;
  const walletlessRunning = establishResult();
  walletlessRunning.identity.accountId = null;
  walletlessRunning.identity.address = null;
  const walletNotStarted = establishResult();
  walletNotStarted.runtimeStatus = { state: 'notStarted' };
  const cases = [
    { ...establishResult(), nativeRevision: '01' },
    widenedIdentity,
    invalidRuntime,
    partialWallet,
    walletlessRunning,
    walletNotStarted,
    { ...establishResult(), realmSessionClaim: ' realm-41' },
  ];

  for (const response of cases) {
    const loaded = loadBridge({
      capabilities: [
        'privilegedBridgeCapability', 'establishNativeSession',
      ],
      responseMethods: { establishNativeSession: response },
    });
    await assert.rejects(establishRealm(loaded));
    assert.equal(await loaded.sandbox.usernode.getWalletState(), null,
      'a malformed receipt must leave the realm closed');
  }
});

test('page readiness is an explicit top-frame privileged handshake', async () => {
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability',
      'privilegedBridgeReady',
      'markPrivilegedBridgeReady',
    ],
  });

  assert.deepEqual(
    await loaded.sandbox.usernode.markPrivilegedBridgeReady(),
    { ready: true }
  );
  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    [
      'getBridgeInfo',
      'getBridgeInfo',
      'getPrivilegedBridgeCapability',
      'markPrivilegedBridgeReady',
    ]
  );
  assert.equal(
    loaded.nativePosts[3].privilegedCapability,
    'navigation-capability'
  );
});

test('delayed valid readiness does not time out at the short probe budget',
  async () => {
    const loaded = loadBridge({
      capabilities: [
        'privilegedBridgeCapability',
        'privilegedBridgeReady',
        'markPrivilegedBridgeReady',
      ],
      timeoutScale: 0.001,
      delayedMethods: { markPrivilegedBridgeReady: 6000 },
    });

    assert.deepEqual(
      await loaded.sandbox.usernode.markPrivilegedBridgeReady(),
      { ready: true }
    );
    assert.equal(
      loaded.nativePosts.filter(
        (post) => post.method === 'markPrivilegedBridgeReady'
      ).length,
      1
    );
  });

test('inconclusive readiness probes retry but old builds remain conclusive',
  async () => {
    const transient = loadBridge({
      capabilities: [
        'privilegedBridgeCapability',
        'privilegedBridgeReady',
        'markPrivilegedBridgeReady',
      ],
      silentMethods: ['getBridgeInfo'],
      timeoutScale: 0.01,
    });

    await assert.rejects(
      transient.sandbox.usernode.markPrivilegedBridgeReady(),
      (error) => error && error.usernodeKind === 'probe-inconclusive'
    );
    transient.unsilence('getBridgeInfo');
    assert.deepEqual(
      await transient.sandbox.usernode.markPrivilegedBridgeReady(),
      { ready: true }
    );
    assert.deepEqual(
      transient.nativePosts.map((post) => post.method),
      [
        'getBridgeInfo',
        'getBridgeInfo',
        'getBridgeInfo',
        'getPrivilegedBridgeCapability',
        'markPrivilegedBridgeReady',
      ]
    );

    const oldBuild = loadBridge({ capabilities: [] });
    assert.equal(
      (await oldBuild.sandbox.usernode.markPrivilegedBridgeReady()).ready,
      false
    );
    assert.deepEqual(
      oldBuild.nativePosts.map((post) => post.method),
      ['getBridgeInfo']
    );
  });

test('pagehide rejects a dropped direct-native response before BFCache restore',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'logout'],
      silentMethods: ['logout'],
    });

    const request = loaded.sandbox.usernode.logout();
    await new Promise((resolve) => setImmediate(resolve));
    loaded.dispatchWindow('pagehide');
    await assert.rejects(request, /page changed/);
    assert.equal(
      Object.keys(loaded.sandbox.__usernodeBridge.pending).length,
      0,
      'the bridge must retire the abandoned native request'
    );
  });

test('pagehide also rejects an in-flight privileged capability bootstrap',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'logout'],
      silentMethods: ['getPrivilegedBridgeCapability'],
    });

    const request = loaded.sandbox.usernode.logout();
    await new Promise((resolve) => setImmediate(resolve));
    loaded.dispatchWindow('pagehide');
    await assert.rejects(request, /page changed/);
    assert.equal(
      Object.keys(loaded.sandbox.__usernodeBridge.pending).length,
      0
    );
  });

test('pagehide retires every in-flight session-bound read',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'establishNativeSession'],
      silentMethods: ['getWalletState'],
    });

    await establishRealm(loaded);
    const request = loaded.sandbox.usernode.getWalletState();
    await new Promise((resolve) => setImmediate(resolve));
    loaded.dispatchWindow('pagehide');
    assert.equal(await request, null,
      'chrome reads preserve their documented null fallback');
    assert.equal(Object.keys(loaded.sandbox.__usernodeBridge.pending).length, 0);
  });

test('old native builds retain the legacy privileged request shape', async () => {
  const loaded = loadBridge({ capabilities: ['logout'] });

  await loaded.sandbox.usernode.logout();
  // A build that ANSWERS the probe without advertising the handshake is a
  // conclusive negative: keep latching it, so these builds pay for exactly
  // one probe and keep the original wire shape for the whole document.
  await loaded.sandbox.usernode.logout();

  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    ['getBridgeInfo', 'logout', 'logout']
  );
  assert.equal('privilegedCapability' in loaded.nativePosts[1], false);
  assert.equal('privilegedCapability' in loaded.nativePosts[2], false);
});

test('manageStaking is a no-argument top-frame privileged action', async () => {
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability',
      'establishNativeSession',
      'manageStaking',
    ],
  });

  await establishRealm(loaded);
  const staking = await loaded.sandbox.usernode.manageStaking();

  assert.equal(staking.delegate, 'B62qdelegate');
  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    [
      'getBridgeInfo',
      'getPrivilegedBridgeCapability',
      'establishNativeSession',
      'manageStaking',
    ]
  );
  assert.equal(
    loaded.nativePosts[3].privilegedCapability,
    'navigation-capability'
  );
  assert.equal(loaded.nativePosts[3].realmSessionClaim, 'realm-41');
  assert.deepEqual(loaded.nativePosts[3].args, {},
    'Homeroom must not send a target or desired state');
});

test('Social push state and tap methods stay behind the top-frame capability',
  async () => {
    const loaded = loadBridge({
      capabilities: [
        'privilegedBridgeCapability',
        'establishNativeSession',
        'getSocialPushState',
        'setSocialPushEnabled',
        'claimPendingSocialNotification',
        'ackPendingSocialNotification',
      ],
    });

    await establishRealm(loaded);
    const state = await loaded.sandbox.usernode.getSocialPushState();
    await loaded.sandbox.usernode.setSocialPushEnabled(true);
    const claim = await loaded.sandbox.usernode.claimPendingSocialNotification();
    await loaded.sandbox.usernode.ackPendingSocialNotification(42);

    assert.equal(state.deliveryActive, true);
    assert.equal(claim.notificationId, 42);
    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      [
        'getBridgeInfo',
        'getPrivilegedBridgeCapability',
        'establishNativeSession',
        'getSocialPushState',
        'setSocialPushEnabled',
        'claimPendingSocialNotification',
        'ackPendingSocialNotification',
      ]
    );
    for (const post of loaded.nativePosts.slice(2)) {
      assert.equal(post.privilegedCapability, 'navigation-capability');
    }
    for (const post of loaded.nativePosts.slice(3)) {
      assert.equal(post.realmSessionClaim, 'realm-41');
    }
    assert.deepEqual(loaded.nativePosts[4].args, { enabled: true });
    assert.deepEqual(loaded.nativePosts[6].args, { notificationId: 42 });
  });

test('the homescreen badge count requires the exact native session realm', async () => {
  // #1445: setSocialBadgeCount carries the unread total the OS icon badge
  // shows. Same per-realm capability as the other social-push methods.
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability',
      'establishNativeSession',
      'setSocialBadgeCount',
    ],
  });

  await assert.rejects(
    loaded.sandbox.usernode.setSocialBadgeCount(7),
    (error) => error.usernodeKind === 'native-session-closed'
  );
  await establishRealm(loaded);
  await loaded.sandbox.usernode.setSocialBadgeCount(7);

  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    [
      'getBridgeInfo',
      'getPrivilegedBridgeCapability',
      'establishNativeSession',
      'setSocialBadgeCount',
    ]
  );
  assert.equal(
    loaded.nativePosts[3].privilegedCapability,
    'navigation-capability'
  );
  assert.equal(loaded.nativePosts[3].realmSessionClaim, 'realm-41');
  assert.deepEqual(loaded.nativePosts[3].args, { count: 7 });
});

test('notification permission actions require the top-frame capability',
  async () => {
    const methods = [
      'requestNotificationPermission',
      'requestAlarmPermissions',
      'openNotificationSettings',
    ];
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', ...methods],
      exposeCallNative: true,
    });

    for (const method of methods) {
      await loaded.sandbox.__callNativeForBoundaryTest(method, {});
    }

    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      [
        'getBridgeInfo',
        'getPrivilegedBridgeCapability',
        ...methods,
      ]
    );
    for (const post of loaded.nativePosts.slice(2)) {
      assert.equal(post.privilegedCapability, 'navigation-capability');
    }

    const relayed = loadBridge();
    const childReplies = [];
    const child = {
      postMessage(value, origin) { childReplies.push({ value, origin }); },
    };
    for (const method of methods) {
      relayed.dispatchMessage({
        source: child,
        origin: 'https://child.example',
        data: {
          __usernode_relay: 'request',
          id: method,
          method,
          args: {},
        },
      });
    }

    assert.equal(relayed.nativePosts.length, 0,
      'an iframe cannot forward notification permission actions to native');
    assert.equal(childReplies.length, methods.length);
    for (const reply of childReplies) {
      assert.match(reply.value.error, /top-level page/);
    }
  });

test('native screenshot capture is a top-frame privileged action', async () => {
  const loaded = loadBridge({
    capabilities: ['privilegedBridgeCapability', 'captureScreenshot'],
  });

  const payload = await loaded.sandbox.usernode.captureScreenshot();
  assert.equal(payload.contentType, 'image/jpeg');
  assert.equal(payload.base64, '/9j/2Q==');
  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    ['getBridgeInfo', 'getPrivilegedBridgeCapability', 'captureScreenshot']
  );
  assert.equal(
    loaded.nativePosts[2].privilegedCapability,
    'navigation-capability'
  );
});

test('legacy shortcut management gets a full request budget after probing',
  async () => {
    // A probe that never answers is INCONCLUSIVE, not "this build has no
    // capabilities" — so this first attempt fails closed rather than
    // guessing the unsigned wire shape (issue #978). Nothing is latched, so
    // the retry re-probes; once the probe answers, the shortcut call gets
    // its own full budget on top of the probe's.
    const loaded = loadBridge({
      silentMethods: ['getBridgeInfo'],
      timeoutScale: 0.01,
    });

    assert.equal(await loaded.sandbox.usernode.getHomeScreenShortcuts(), null,
      'the inconclusive attempt falls back rather than sending unsigned');
    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      ['getBridgeInfo']
    );

    loaded.unsilence('getBridgeInfo');
    const result = await loaded.sandbox.usernode.getHomeScreenShortcuts();

    assert.equal(result, true);
    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      ['getBridgeInfo', 'getBridgeInfo', 'getHomeScreenShortcuts']
    );
  });

test('a degraded capability probe fails closed and never latches a negative',
  async () => {
    const errorMethods = { getSettingsState: 'transient settings failure' };
    const loaded = loadBridge({
      capabilities: [
        'privilegedBridgeCapability',
        'establishNativeSession',
        'getSettingsState',
      ],
      errorMethods,
      timeoutScale: 0.01,
    });

    await establishRealm(loaded);
    assert.equal(await loaded.sandbox.usernode.getSettingsState(), null);
    delete errorMethods.getSettingsState;
    loaded.nativePosts.length = 0;
    loaded.silentMethods.push('getBridgeInfo');

    assert.equal(await loaded.sandbox.usernode.getSettingsState(), null,
      'a read whose handshake could not be negotiated resolves its fallback');
    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      ['getBridgeInfo'],
      'the privileged call is never sent unsigned on an inconclusive probe'
    );
    assert.equal(
      loaded.sandbox.usernode.getLastNativeReadError('getSettingsState').kind,
      'probe-inconclusive',
      'the reason is recorded so the Settings screen can name it'
    );

    // A transient native rejection cleared the cached root capability above.
    // The following inconclusive re-probe must not become a sticky
    // "unsupported" answer for this still-admitted session.
    loaded.unsilence('getBridgeInfo');
    assert.deepEqual(
      await loaded.sandbox.usernode.getSettingsState(),
      SETTINGS_SNAPSHOT
    );
    assert.deepEqual(
      loaded.nativePosts.map((post) => post.method),
      [
        'getBridgeInfo',
        'getBridgeInfo',
        'getPrivilegedBridgeCapability',
        'getSettingsState',
      ]
    );
    assert.equal(
      loaded.nativePosts[3].privilegedCapability, 'navigation-capability'
    );
    assert.equal(
      loaded.sandbox.usernode.getLastNativeReadError('getSettingsState'), null,
      'a successful read clears the record'
    );
  });

test('chrome reads record WHY they came back empty', async () => {
  // Reads must keep resolving a fallback (every caller awaits and renders
  // "unavailable"), so the reason has to travel out of band or the UI can
  // only ever say "something went wrong".
  const timedOut = loadBridge({
    capabilities: [
      'privilegedBridgeCapability',
      'establishNativeSession',
      'getSettingsState',
    ],
    silentMethods: ['getSettingsState'],
    timeoutScale: 0.01,
  });

  await establishRealm(timedOut);

  assert.equal(await timedOut.sandbox.usernode.getSettingsState(), null);
  const timeout = timedOut.sandbox.usernode
    .getLastNativeReadError('getSettingsState');
  assert.equal(timeout.kind, 'timeout');
  assert.equal(timeout.method, 'getSettingsState');
  assert.match(timeout.message, /did not respond within/);
  assert.equal(typeof timeout.at, 'number');
  assert.equal(
    timedOut.sandbox.usernode.getLastNativeReadError('getWalletState'), null,
    'only the method that actually failed carries a record'
  );

  const rejected = loadBridge({
    capabilities: [
      'privilegedBridgeCapability',
      'establishNativeSession',
      'getSettingsState',
    ],
    errorMethods: { getSettingsState: 'terms provider unavailable' },
    timeoutScale: 0.01,
  });

  await establishRealm(rejected);

  assert.equal(await rejected.sandbox.usernode.getSettingsState(), null);
  const nativeError = rejected.sandbox.usernode
    .getLastNativeReadError('getSettingsState');
  assert.equal(nativeError.kind, 'rejected');
  assert.equal(nativeError.message, 'terms provider unavailable',
    'the app’s own message reaches the screen verbatim');

  // The record never carries the privileged capability, which is the one
  // string in this closure that must not leak into a rendered message.
  for (const record of [timeout, nativeError]) {
    assert.doesNotMatch(String(record.message), /navigation-capability/);
  }
});

test('outside the app, getSettingsState reports that it cannot reach it',
  async () => {
    const loaded = loadBridge({ capabilities: ['getSettingsState'] });
    loaded.sandbox.usernode.isNative = false;

    assert.equal(await loaded.sandbox.usernode.getSettingsState(), null);
    assert.equal(
      loaded.sandbox.usernode.getLastNativeReadError('getSettingsState').kind,
      'not-native'
    );
    assert.equal(loaded.nativePosts.length, 0);
  });

test('a failed bridge probe is marked degraded, a real one is not', async () => {
  // Field-wise rather than deepEqual: these objects are built inside the
  // sandbox realm, so their prototypes differ from the test realm's.
  const answered = loadBridge({ capabilities: ['getSettingsState'] });
  const info = await answered.sandbox.usernode.getBridgeInfo();
  assert.equal(info.version, 5);
  assert.equal(info.appVersion, '0.4.0');
  assert.equal(info.buildNumber, '1223');
  assert.equal(info.degraded, undefined,
    'a conclusive probe must not look degraded, or callers would re-probe forever');

  const silent = loadBridge({
    silentMethods: ['getBridgeInfo'],
    timeoutScale: 0.01,
  });
  const degraded = await silent.sandbox.usernode.getBridgeInfo();
  assert.equal(degraded.version, 0);
  assert.equal(degraded.capabilities.length, 0);
  assert.equal(degraded.degraded, true);

  // Outside the app there is nothing to be inconclusive about.
  const web = loadBridge();
  web.sandbox.usernode.isNative = false;
  const empty = await web.sandbox.usernode.getBridgeInfo();
  assert.equal(empty.version, 0);
  assert.equal(empty.capabilities.length, 0);
  assert.equal(empty.degraded, undefined);
});

test('parent relay denies root methods and injects both claims for realm calls',
  async () => {
  const loaded = loadBridge({ capabilities: [
    'privilegedBridgeCapability', 'establishNativeSession',
  ] });
  const childReplies = [];
  const child = {
    postMessage(value, origin) { childReplies.push({ value, origin }); },
  };
  const dispatch = (method, id) => loaded.dispatchMessage({
    source: child,
    origin: 'https://child.example',
    data: {
      __usernode_relay: 'request',
      id,
      method,
      args: {},
    },
  });

  dispatch('getPrivilegedBridgeCapability', 'bootstrap');
  dispatch('logout', 'logout');
  dispatch('manageStaking', 'manage-staking');
  dispatch('getWalletState', 'closed-wallet');

  assert.deepEqual(loaded.nativePosts.map((post) => post.method), []);
  assert.equal(childReplies.length, 4);
  assert.match(childReplies[0].value.error, /top-level page/);
  assert.match(childReplies[1].value.error, /top-level page/);
  assert.match(childReplies[2].value.error, /top-level page/,
    'embedded apps cannot open native delegation management');
  assert.match(childReplies[3].value.error, /not established/);

  await establishRealm(loaded);
  dispatch('getWalletState', 'open-wallet');
  assert.equal(childReplies[4].value.error, null);
  assert.deepEqual(childReplies[4].value.value, { address: 'ut1-wallet' });
  const relayed = loaded.nativePosts.at(-1);
  assert.equal(relayed.method, 'getWalletState');
  assert.equal(relayed.privilegedCapability, 'navigation-capability');
  assert.equal(relayed.realmSessionClaim, 'realm-41');
});

test('native realm gate rejects top-frame and iframe wallet calls until establish',
  async () => {
  const loaded = loadBridge({ capabilities: [
    'privilegedBridgeCapability', 'establishNativeSession',
    'submitTransaction',
  ] });
  const childReplies = [];
  const child = {
    postMessage(value, origin) { childReplies.push({ value, origin }); },
  };
  const relayWalletRead = (id) => loaded.dispatchMessage({
    source: child,
    origin: 'https://child.example',
    data: {
      __usernode_relay: 'request',
      id,
      method: 'getWalletState',
      args: {},
    },
  });

  assert.equal(await loaded.sandbox.usernode.getWalletState(), null,
    'top-frame reads fail closed through their existing null fallback');
  await assert.rejects(
    loaded.sandbox.sendTransaction('ut1-recipient', 3, '', {
      waitForInclusion: false,
    }),
    /not established/i
  );
  await assert.rejects(
    loaded.sandbox.signMessage('session-scoped message'),
    /not established/i
  );
  relayWalletRead('blocked-wallet');

  assert.equal(loaded.nativePosts.length, 0);
  assert.match(childReplies[0].value.error, /not established/i);

  await establishRealm(loaded);
  relayWalletRead('admitted-wallet');
  const submission = await loaded.sandbox.sendTransaction(
    'ut1-recipient', 3, '', { waitForInclusion: false }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(submission)), {
    txId: 'tx-authoritative',
  });
  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    [
      'getBridgeInfo', 'getPrivilegedBridgeCapability',
      'establishNativeSession', 'getWalletState', 'getBridgeInfo',
      'getNodeAddress', 'submitTransaction',
    ]
  );
  assert.equal(childReplies[1].value.error, null);
  for (const post of loaded.nativePosts.slice(3)) {
    if (post.method !== 'getBridgeInfo') {
      assert.equal(post.privilegedCapability, 'navigation-capability');
      assert.equal(post.realmSessionClaim, 'realm-41');
    }
  }
});

test('native transaction submission uses the exact admitted contract', async () => {
  const loaded = loadBridge({ capabilities: [
    'privilegedBridgeCapability', 'establishNativeSession',
    'submitTransaction',
  ] });
  await establishRealm(loaded);

  const result = await loaded.sandbox.sendTransaction(
    ' ut1-recipient ', 7, '', {
      waitForInclusion: false,
      confirmTitle: 'Send tokens',
      confirmSubtitle: 'Review this transfer',
    }
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    txId: 'tx-authoritative',
  });
  const submission = loaded.nativePosts.find(
    (post) => post.method === 'submitTransaction'
  );
  assert.ok(submission);
  assert.deepEqual(JSON.parse(JSON.stringify(submission.args)), {
    destinationPubkey: 'ut1-recipient',
    amount: 7,
    memo: '',
    confirmation: {
      title: 'Send tokens',
      subtitle: 'Review this transfer',
    },
  });
});

test('native transaction submission rejects result aliases and extra fields', async () => {
  const alias = loadBridge({
    capabilities: [
      'privilegedBridgeCapability', 'establishNativeSession',
      'submitTransaction',
    ],
    responseMethods: { submitTransaction: { tx_id: 'legacy-id' } },
  });
  await establishRealm(alias);
  await assert.rejects(
    alias.sandbox.sendTransaction('ut1-recipient', 1, '', {
      waitForInclusion: false,
    }),
    /contain only txId/
  );

  const extra = loadBridge({
    capabilities: [
      'privilegedBridgeCapability', 'establishNativeSession',
      'submitTransaction',
    ],
    responseMethods: {
      submitTransaction: { txId: 'tx-authoritative', queued: true },
    },
  });
  await establishRealm(extra);
  await assert.rejects(
    extra.sandbox.sendTransaction('ut1-recipient', 1, '', {
      waitForInclusion: false,
    }),
    /contain only txId/
  );

  const nonCanonical = loadBridge({
    capabilities: [
      'privilegedBridgeCapability', 'establishNativeSession',
      'submitTransaction',
    ],
    responseMethods: { submitTransaction: { txId: ' tx-authoritative ' } },
  });
  await establishRealm(nonCanonical);
  await assert.rejects(
    nonCanonical.sandbox.sendTransaction('ut1-recipient', 1, '', {
      waitForInclusion: false,
    }),
    /canonical non-empty string/
  );
});

test('native transaction submission rejects invalid requests before dispatch', async () => {
  const loaded = loadBridge();
  await assert.rejects(
    loaded.sandbox.sendTransaction('ut1-recipient', 1.5, '', {
      waitForInclusion: false,
    }),
    /positive safe integer/
  );
  assert.equal(loaded.nativePosts.length, 0);
});

test('Social persists and confirms receipts under the authenticated user', async () => {
  const explorerRequests = [];
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability', 'establishNativeSession',
      'submitTransaction',
    ],
    appUser: { id: 17 },
    fetchImpl: async (url, options = {}) => {
      const value = String(url);
      if (value === '/__mock/enabled') return { ok: false };
      if (value === '/explorer-api/active_chain') {
        return {
          ok: true,
          json: async () => ({ chain_id: 'test-chain' }),
        };
      }
      if (value === '/explorer-api/test-chain/transactions') {
        explorerRequests.push(JSON.parse(options.body));
        return {
          ok: true,
          json: async () => ({
            items: [{
              tx_id: 'tx-authoritative',
              status: 'confirmed',
              block_height: 42,
              timestamp_ms: 123456,
            }],
          }),
        };
      }
      throw new Error(`unexpected fetch ${value}`);
    },
  });
  await establishRealm(loaded);

  await loaded.sandbox.sendTransaction('ut1-recipient', 9, 'memo', {
    waitForInclusion: false,
  });

  let receipts;
  for (let i = 0; i < 20; i += 1) {
    receipts = await loaded.sandbox.usernode.getTransactionReceipts();
    if (receipts.items[0] && receipts.items[0].status === 'confirmed') break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(receipts.items.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(receipts.items[0])), {
    txId: 'tx-authoritative',
    destinationPubkey: 'ut1-recipient',
    fromPubkey: 'ut1-sender',
    amount: 9,
    memo: 'memo',
    submittedAt: receipts.items[0].submittedAt,
    status: 'confirmed',
    confirmedAt: receipts.items[0].confirmedAt,
    blockHeight: 42,
    blockTimestampMs: 123456,
  });
  assert.equal(explorerRequests.length, 1);
  assert.deepEqual(explorerRequests[0], {
    limit: 1,
    tx_id: 'tx-authoritative',
  });

  loaded.sandbox.App.user = { id: 18 };
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await loaded.sandbox.usernode.getTransactionReceipts()
    )),
    { items: [] },
    'a new Social user cannot read the previous user receipt namespace'
  );
});

test('missing submission capability fails closed before wallet dispatch', async () => {
  const loaded = loadBridge({ capabilities: [
    'privilegedBridgeCapability', 'establishNativeSession',
  ] });
  await establishRealm(loaded);
  await assert.rejects(
    loaded.sandbox.sendTransaction('ut1-recipient', 1, '', {
      waitForInclusion: false,
    }),
    /not supported by this app build/
  );
  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    [
      'getBridgeInfo', 'getPrivilegedBridgeCapability',
      'establishNativeSession', 'getBridgeInfo',
    ]
  );
});

test('Social confirms only the authoritative txId, never a fuzzy field match',
  async () => {
    const loaded = loadBridge({
      capabilities: [
        'privilegedBridgeCapability', 'establishNativeSession',
        'submitTransaction',
      ],
      appUser: { id: 19 },
      fetchImpl: async (url) => {
        const value = String(url);
        if (value === '/__mock/enabled') return { ok: false };
        if (value === '/explorer-api/active_chain') {
          return { ok: true, json: async () => ({ chain_id: 'test-chain' }) };
        }
        if (value === '/explorer-api/test-chain/transactions') {
          return {
            ok: true,
            json: async () => ({
              items: [{
                tx_id: 'different-tx',
                source: 'ut1-sender',
                destination: 'ut1-recipient',
                memo: 'same fields',
                amount: 3,
              }],
            }),
          };
        }
        throw new Error(`unexpected fetch ${value}`);
      },
    });
    await establishRealm(loaded);

    await loaded.sandbox.sendTransaction(
      'ut1-recipient', 3, 'same fields', {
        waitForInclusion: false,
        timeoutMs: 5,
        pollIntervalMs: 1,
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const receipts = await loaded.sandbox.usernode.getTransactionReceipts();
    assert.equal(receipts.items[0].status, 'submitted');
  });

test('a submission result cannot cross into a replacement Social identity', async () => {
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability', 'establishNativeSession',
      'submitTransaction',
    ],
    appUser: { id: 17 },
    delayedMethods: { submitTransaction: 15 },
  });
  await establishRealm(loaded);
  const pending = loaded.sandbox.sendTransaction(
    'ut1-recipient', 2, '', { waitForInclusion: false }
  );
  for (let i = 0; i < 20 &&
      !loaded.nativePosts.some((post) => post.method === 'submitTransaction');
      i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  loaded.dispatchWindow('sv:native-realm-close');
  loaded.sandbox.App.user = { id: 18 };
  await assert.rejects(pending, /session changed/i);

  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await loaded.sandbox.usernode.getTransactionReceipts()
    )),
    { items: [] }
  );
  loaded.sandbox.App.user = { id: 17 };
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      await loaded.sandbox.usernode.getTransactionReceipts()
    )),
    { items: [] },
    'a result delivered after admission closed is not persisted for either user'
  );
});

test('trusted top frame records a dual-claim relayed child-app submission', async () => {
  const childReplies = [];
  const explorerRequests = [];
  const loaded = loadBridge({
    capabilities: ['privilegedBridgeCapability', 'establishNativeSession'],
    appUser: { id: 23 },
    fetchImpl: async (url) => {
      if (String(url) === '/explorer-api/active_chain') {
        return { ok: true, json: async () => ({ chain_id: 'test-chain' }) };
      }
      if (String(url) === '/explorer-api/test-chain/transactions') {
        explorerRequests.push(1);
        return {
          ok: true,
          json: async () => ({
            items: [{ tx_id: 'tx-authoritative', block_height: 84 }],
          }),
        };
      }
      return { ok: false };
    },
  });
  await establishRealm(loaded);
  const child = {
    postMessage(value, origin) { childReplies.push({ value, origin }); },
  };

  loaded.dispatchMessage({
    source: child,
    origin: 'https://child.example',
    data: {
      __usernode_relay: 'request',
      id: 'child-submit',
      method: 'submitTransaction',
      args: {
        destinationPubkey: 'ut1-child-recipient',
        amount: 11,
        memo: 'from child',
      },
    },
  });

  for (let i = 0; i < 20 && childReplies.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(childReplies[0].value)), {
    __usernode_relay: 'response',
    id: 'child-submit',
    value: { txId: 'tx-authoritative' },
    error: null,
  });
  assert.deepEqual(
    loaded.nativePosts.map((post) => post.method),
    [
      'getBridgeInfo', 'getPrivilegedBridgeCapability',
      'establishNativeSession', 'submitTransaction',
    ]
  );
  const relayed = loaded.nativePosts.at(-1);
  assert.equal(relayed.privilegedCapability, 'navigation-capability');
  assert.equal(relayed.realmSessionClaim, 'realm-23');
  for (let i = 0; i < 20 && explorerRequests.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(explorerRequests.length, 1,
    'the trusted top frame starts one Social observer for a relayed tx');
  const receipts = await loaded.sandbox.usernode.getTransactionReceipts();
  assert.equal(receipts.items.length, 1);
  assert.equal(receipts.items[0].destinationPubkey, 'ut1-child-recipient');
});

test('explorer outage leaves one bounded pending receipt and reads do not retry',
  async () => {
    let explorerRequests = 0;
    const loaded = loadBridge({
      capabilities: [
        'privilegedBridgeCapability', 'establishNativeSession',
        'submitTransaction',
      ],
      appUser: { id: 31 },
      fetchImpl: async (url) => {
        const value = String(url);
        if (value === '/__mock/enabled') return { ok: false };
        if (value === '/explorer-api/active_chain') {
          return { ok: true, json: async () => ({ chain_id: 'test-chain' }) };
        }
        if (value === '/explorer-api/test-chain/transactions') {
          explorerRequests += 1;
          return { ok: false, status: 503 };
        }
        throw new Error(`unexpected fetch ${value}`);
      },
    });
    await establishRealm(loaded);

    await loaded.sandbox.sendTransaction('ut1-recipient', 5, '', {
      waitForInclusion: false,
      timeoutMs: 8,
      pollIntervalMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const requestsAfterBound = explorerRequests;
    assert.ok(requestsAfterBound > 0);

    const firstRead = await loaded.sandbox.usernode.getTransactionReceipts();
    const secondRead = await loaded.sandbox.usernode.getTransactionReceipts();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(firstRead.items[0].status, 'submitted');
    assert.equal(secondRead.items[0].status, 'submitted');
    assert.equal(explorerRequests, requestsAfterBound,
      'product reads never create a detached observation retry');
  });

test('closing and reopening admission makes same-account observers inert',
  async () => {
    let explorerRequests = 0;
    const loaded = loadBridge({
      capabilities: [
        'privilegedBridgeCapability', 'establishNativeSession',
        'submitTransaction',
      ],
      appUser: { id: 41 },
      fetchImpl: async (url) => {
        const value = String(url);
        if (value === '/__mock/enabled') return { ok: false };
        if (value === '/explorer-api/active_chain') {
          return { ok: true, json: async () => ({ chain_id: 'test-chain' }) };
        }
        if (value === '/explorer-api/test-chain/transactions') {
          explorerRequests += 1;
          return { ok: true, json: async () => ({ items: [] }) };
        }
        throw new Error(`unexpected fetch ${value}`);
      },
    });
    await establishRealm(loaded);

    await loaded.sandbox.sendTransaction('ut1-recipient', 6, '', {
      waitForInclusion: false,
      timeoutMs: 1000,
      pollIntervalMs: 15,
    });
    for (let i = 0; i < 20 && explorerRequests === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(explorerRequests, 1);

    loaded.dispatchWindow('sv:native-realm-close');
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(explorerRequests, 1,
      'the old generation cannot resume after the same account is readmitted');
    await establishRealm(loaded);
    const receipts = await loaded.sandbox.usernode.getTransactionReceipts();
    assert.equal(receipts.items[0].status, 'submitted');
  });

test('an explicit product read resumes one pending receipt after reload',
  async () => {
    const sharedStorage = new Map();
    const first = loadBridge({
      capabilities: [
        'privilegedBridgeCapability', 'establishNativeSession',
        'submitTransaction',
      ],
      appUser: { id: 51 },
      sharedStorage,
      fetchImpl: async (url) => {
        const value = String(url);
        if (value === '/__mock/enabled') return { ok: false };
        if (value === '/explorer-api/active_chain') {
          return { ok: true, json: async () => ({ chain_id: 'test-chain' }) };
        }
        if (value === '/explorer-api/test-chain/transactions') {
          return { ok: false, status: 503 };
        }
        throw new Error(`unexpected fetch ${value}`);
      },
    });
    await establishRealm(first);
    await first.sandbox.sendTransaction('ut1-recipient', 8, 'reload', {
      waitForInclusion: false,
      timeoutMs: 5,
      pollIntervalMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    let explorerRequests = 0;
    const reloaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'establishNativeSession'],
      appUser: { id: 51 },
      sharedStorage,
      fetchImpl: async (url) => {
        const value = String(url);
        if (value === '/explorer-api/active_chain') {
          return { ok: true, json: async () => ({ chain_id: 'test-chain' }) };
        }
        if (value === '/explorer-api/test-chain/transactions') {
          explorerRequests += 1;
          return {
            ok: true,
            json: async () => ({
              items: [{ tx_id: 'tx-authoritative', block_height: 99 }],
            }),
          };
        }
        return { ok: false };
      },
    });
    await establishRealm(reloaded);

    const initial = await reloaded.sandbox.usernode.getTransactionReceipts({
      observePending: true,
    });
    assert.equal(initial.items[0].status, 'submitted');
    let confirmed;
    for (let i = 0; i < 20; i += 1) {
      confirmed = await reloaded.sandbox.usernode.getTransactionReceipts();
      if (confirmed.items[0].status === 'confirmed') break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(confirmed.items[0].status, 'confirmed');
    assert.equal(confirmed.items[0].blockHeight, 99);
    assert.equal(explorerRequests, 1);
  });

// ── Refusal codes (bridge contract v4) ──────────────────────────────────
//
// Native may now send a 4th argument to __usernodeResolve carrying a
// machine-readable { code }. The transport has to be additive in BOTH
// directions: an old app calling it with three arguments must behave
// byte-for-byte as it does today, and a new app's extra argument must
// never turn the human message into "[object Object]".

test('a three-argument resolve keeps exactly today’s behaviour', async () => {
  const loaded = loadBridge({
    capabilities: ['privilegedBridgeCapability', 'logout'],
    errorMethods: { logout: 'latch is busy' },
  });

  const err = await loaded.sandbox.usernode.logout()
    .then(() => null, (e) => e);

  assert.equal(err.message, 'latch is busy');
  assert.equal('usernodeCode' in err, false,
    'no code is invented when native did not send one');
});

test('a refusal code rides alongside the human message, never replacing it',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'logout'],
      errorMethods: {
        logout:
          'Privileged bridge is unavailable for this main frame',
      },
      errorInfoMethods: {
        logout: { code: 'privileged_frame_unauthorized' },
      },
    });

    const err = await loaded.sandbox.usernode.logout()
      .then(() => null, (e) => e);

    assert.equal(err.message,
      'Privileged bridge is unavailable for this main frame');
    assert.equal(err.usernodeCode, 'privileged_frame_unauthorized');
    assert.equal(err.usernodeKind, 'privileged-unavailable');
    assert.equal(err.usernodePrivileged, true);
  });

test('a junk or empty errorInfo is ignored rather than trusted', async () => {
  for (const info of [null, {}, { code: '' }, { code: '  ' }, { code: 7 }, 'x']) {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'logout'],
      errorMethods: { logout: 'nope' },
      errorInfoMethods: { logout: info },
    });
    const err = await loaded.sandbox.usernode.logout()
      .then(() => null, (e) => e);
    assert.equal(err.message, 'nope');
    assert.equal(err.usernodeCode, undefined,
      `errorInfo ${JSON.stringify(info)} must not produce a code`);
  }
});

test('each refusal code classifies to its own diagnosable state', async () => {
  const cases = [
    ['privileged_frame_unauthorized', 'blocked-frame'],
    ['privileged_unsupported_version', 'unsupported'],
    ['privileged_bootstrap_timeout', 'unattached'],
  ];
  for (const [code, state] of cases) {
      const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'logout'],
      errorMethods: { logout: 'refused' },
      errorInfoMethods: { logout: { code } },
    });
    await loaded.sandbox.usernode.logout().catch(() => {});
    const diag = loaded.sandbox.usernode.getBridgeDiagnostics();
    assert.equal(diag.privileged.state, state, `${code} → ${state}`);
    assert.equal(diag.privileged.code, code);
  }
});

test('an unknown code still classifies rather than falling through',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'logout'],
      errorMethods: { logout: 'refused for reasons' },
      errorInfoMethods: {
        logout: { code: 'privileged_something_new' },
      },
    });

    await loaded.sandbox.usernode.logout().catch(() => {});
    const diag = loaded.sandbox.usernode.getBridgeDiagnostics();
    assert.equal(diag.privileged.state, 'blocked-frame');
    assert.equal(diag.privileged.code, 'privileged_something_new');
  });

test('with no code at all the English prose still classifies', async () => {
  const loaded = loadBridge({
    capabilities: ['privilegedBridgeCapability', 'logout'],
    errorMethods: {
      logout:
        'Privileged bridge is unavailable for this main frame',
    },
  });

  await loaded.sandbox.usernode.logout().catch(() => {});
  const diag = loaded.sandbox.usernode.getBridgeDiagnostics();
  assert.equal(diag.privileged.state, 'blocked-frame');
  assert.equal(diag.privileged.code, null);
});

test('an ordinary method rejection is not mistaken for a refused bridge',
  async () => {
    const loaded = loadBridge({
      capabilities: ['privilegedBridgeCapability', 'logout'],
      errorMethods: { logout: 'the wallet is already unlocked' },
    });

    const err = await loaded.sandbox.usernode.logout()
      .then(() => null, (e) => e);
    assert.equal(err.usernodePrivileged, undefined);

    const diag = loaded.sandbox.usernode.getBridgeDiagnostics();
    assert.equal(diag.privileged.state, 'ready',
      'the handshake itself succeeded; only the method failed');
  });

test('a build without the privileged bootstrap classifies as unsupported',
  async () => {
    const loaded = loadBridge({ capabilities: ['logout'] });

    await loaded.sandbox.usernode.logout().catch(() => {});
    const diag = loaded.sandbox.usernode.getBridgeDiagnostics();
    assert.equal(diag.privileged.state, 'unsupported');
    assert.equal(diag.privileged.code, null);
  });

test('web recovery is root-privileged and does not need an established realm session', async () => {
  const restored = { status: 'restored', protocol: 2, userId: '41', attemptId: ESTABLISH_ATTEMPT };
  const loaded = loadBridge({ capabilities: ['privilegedBridgeCapability', 'restoreWebSession'],
    responseMethods: { restoreWebSession: restored } });
  assert.equal(JSON.stringify(await loaded.sandbox.usernode.restoreWebSession()), JSON.stringify(restored));
  const post = loaded.nativePosts.at(-1);
  assert.equal(post.method, 'restoreWebSession');
  assert.equal(post.privilegedCapability, 'navigation-capability');
  assert.equal('realmSessionClaim' in post, false);
  assert.equal('sessionToken' in post, false);
});
