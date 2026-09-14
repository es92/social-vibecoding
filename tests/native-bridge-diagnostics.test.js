// getBridgeDiagnostics() — the synchronous, copied snapshot Settings renders
// and offers as copyable text.
//
// The failure this exists for: a device whose privileged handshake is refused
// sees "Could not load Homeroom app settings." and nothing else, while every
// UNPRIVILEGED read (getBridgeInfo above all) still works perfectly. All the
// facts needed to diagnose it are already in the page; they just had no way
// out. These tests pin that they now do, and — just as important — that the
// way out never carries the capability token or leaks across frames.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const bridgeSource = fs.readFileSync(
  path.join(root, 'public', 'usernode-bridge.js'), 'utf8'
);
const ESTABLISH_ATTEMPT = `nsa_${'A'.repeat(43)}`;
const SESSION_CAPABILITIES = [
  'privilegedBridgeCapability',
  'establishNativeSession',
  'getSettingsState',
];

function establishRealm(loaded) {
  return loaded.sandbox.usernode.establishNativeSession({
    attemptId: ESTABLISH_ATTEMPT,
    desiredRuntime: 'running',
  });
}

function loadBridge({
  native = true,
  inIframe = false,
  capabilities = SESSION_CAPABILITIES,
  errorMethods = {},
  errorInfoMethods = {},
  silentMethods = [],
  timeoutScale = 1,
} = {}) {
  const nativePosts = [];
  const responses = {
    getBridgeInfo: {
      version: 5,
      capabilities,
      ...(capabilities.includes('establishNativeSession')
        ? { sessionLifecycleProtocol: 2 } : {}),
      appVersion: '0.4.0',
      buildNumber: '1223',
    },
    getPrivilegedBridgeCapability: 'realm-capability',
    establishNativeSession: {
      protocol: 2,
      attemptId: ESTABLISH_ATTEMPT,
      nativeRevision: '7',
      identity: {
        participantId: '41',
        accountId: 'account-1',
        address: 'ut1-wallet',
      },
      runtimeStatus: { state: 'running' },
      receiptStatus: 'committedReady',
      realmSessionClaim: 'realm-session-41',
    },
    getSettingsState: { authStatus: 'authenticated' },
  };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Date, Math, Promise, URL, URLSearchParams,
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
      origin: 'https://social.example',
      search: '',
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: {
      currentScript: { src: 'https://social.example/usernode-bridge.js' },
      readyState: 'complete',
      head: { appendChild() {} },
      body: { appendChild() {} },
      getElementById() { return null; },
      addEventListener() {},
      createElement() {
        return {
          appendChild() {}, setAttribute() {}, addEventListener() {}, style: {},
        };
      },
    },
    addEventListener() {},
    dispatchEvent() {},
    fetch: async () => ({ ok: false }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // The bridge decides it is embedded with `window !== window.parent`.
  sandbox.parent = inIframe ? { postMessage() {} } : sandbox;
  if (native) {
    sandbox.Usernode = {
      postMessage(raw) {
        const request = JSON.parse(raw);
        nativePosts.push(request);
        if (silentMethods.includes(request.method)) return;
        if (Object.prototype.hasOwnProperty.call(errorMethods, request.method)) {
          sandbox.__usernodeResolve(
            request.id, null, errorMethods[request.method],
            errorInfoMethods[request.method]
          );
          return;
        }
        const value = Object.prototype.hasOwnProperty.call(
          responses, request.method
        ) ? responses[request.method] : true;
        sandbox.__usernodeResolve(request.id, value, null);
      },
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(bridgeSource, sandbox);
  return { sandbox, nativePosts };
}

test('the diagnostics snapshot is synchronous and present outside the app',
  () => {
    const loaded = loadBridge({ native: false });

    const diag = loaded.sandbox.usernode.getBridgeDiagnostics();

    assert.equal(typeof diag, 'object');
    assert.equal(diag.isNative, false);
    assert.equal(diag.hasNativeChannel, false);
    assert.equal(diag.bridgeVersion, 0);
    assert.deepEqual(Array.from(diag.capabilities), []);
    assert.equal(diag.privileged.state, 'unknown');
    assert.equal(diag.privileged.attempts, 0);
    assert.equal(diag.appVersion, null);
    assert.equal(diag.buildNumber, null);
  });

test('the installed build stays readable after the handshake is refused',
  async () => {
    const loaded = loadBridge({
      errorMethods: {
        getPrivilegedBridgeCapability:
          'Privileged bridge is unavailable for this main frame',
      },
      errorInfoMethods: {
        getPrivilegedBridgeCapability: { code: 'privileged_frame_unauthorized' },
      },
    });

    await loaded.sandbox.usernode.getHomeScreenShortcuts().catch(() => {});
    const diag = loaded.sandbox.usernode.getBridgeDiagnostics();

    // getBridgeInfo is UNPRIVILEGED, which is the whole reason a refused
    // device can still be diagnosed rather than merely apologised to.
    assert.equal(diag.isNative, true);
    assert.equal(diag.bridgeVersion, 5);
    assert.equal(diag.appVersion, '0.4.0');
    assert.equal(diag.buildNumber, '1223');
    assert.ok(diag.capabilities.includes('getSettingsState'));

    assert.equal(diag.privileged.state, 'blocked-frame');
    assert.equal(diag.privileged.code, 'privileged_frame_unauthorized');
    assert.equal(diag.privileged.kind, 'privileged-unavailable');
    assert.match(diag.privileged.message, /main frame/i);
    assert.ok(diag.privileged.attempts >= 1);
    assert.ok(diag.collectedAt > 0);
  });

test('a working handshake reports ready with no attempt debt', async () => {
  const loaded = loadBridge();

  await establishRealm(loaded);
  await loaded.sandbox.usernode.getSettingsState();
  const diag = loaded.sandbox.usernode.getBridgeDiagnostics();

  assert.equal(diag.privileged.state, 'ready');
  assert.equal(diag.privileged.code, null);
  assert.equal(diag.privileged.attempts, 0);
  assert.equal(diag.isTopFrame, true);
  assert.equal(diag.inIframe, false);
  assert.equal(diag.origin, 'https://social.example');
});

test('the snapshot never carries the capability token', async () => {
  const loaded = loadBridge();

  await establishRealm(loaded);
  await loaded.sandbox.usernode.getSettingsState();
  const diag = loaded.sandbox.usernode.getBridgeDiagnostics();

  assert.equal(
    JSON.stringify(diag).includes('realm-capability'), false,
    'the per-realm token lives in a closure and must never be serialised'
  );
});

test('an embedded frame is told the truth about itself, not the top frame',
  () => {
    const loaded = loadBridge({ inIframe: true });

    const diag = loaded.sandbox.usernode.getBridgeDiagnostics();

    assert.equal(diag.inIframe, true);
    assert.equal(diag.isTopFrame, false);
    assert.equal(diag.privileged.state, 'blocked-frame');
    assert.equal(diag.privileged.kind, 'no-transport');
    assert.match(diag.privileged.message, /top-level page/i);
  });

test('failed reads are exposed as copies, not the live record', async () => {
  const loaded = loadBridge({
    errorMethods: { getSettingsState: 'no settings for you' },
  });

  await establishRealm(loaded);
  assert.equal(await loaded.sandbox.usernode.getSettingsState(), null,
    'chrome reads still resolve a fallback rather than rejecting');

  const first = loaded.sandbox.usernode.getBridgeDiagnostics();
  assert.equal(first.lastErrors.getSettingsState.kind, 'rejected');
  assert.equal(first.lastErrors.getSettingsState.message, 'no settings for you');

  first.lastErrors.getSettingsState.message = 'tampered';
  const second = loaded.sandbox.usernode.getBridgeDiagnostics();
  assert.equal(second.lastErrors.getSettingsState.message, 'no settings for you');
});

test('a refused privileged ACTION now leaves a record too', async () => {
  const loaded = loadBridge({
    capabilities: [
      'privilegedBridgeCapability', 'setDebugMode',
    ],
    errorMethods: { setDebugMode: 'refused' },
  });

  await loaded.sandbox.usernode.setDebugMode(true).catch(() => {});

  const diag = loaded.sandbox.usernode.getBridgeDiagnostics();
  assert.equal(diag.lastErrors.setDebugMode.kind, 'rejected');
  assert.equal(diag.lastErrors.setDebugMode.message, 'refused');
});

test('a successful call clears its own stale failure record', async () => {
  const errorMethods = { getSettingsState: 'transient' };
  const loaded = loadBridge({
    errorMethods,
  });

  await establishRealm(loaded);
  await loaded.sandbox.usernode.getSettingsState();
  assert.ok(loaded.sandbox.usernode.getBridgeDiagnostics()
    .lastErrors.getSettingsState);

  delete errorMethods.getSettingsState;
  await loaded.sandbox.usernode.getSettingsState();
  assert.equal(loaded.sandbox.usernode.getBridgeDiagnostics()
    .lastErrors.getSettingsState, undefined);
});

test('both hosted bridge copies expose the same diagnostics surface', () => {
  const versioned = fs.readFileSync(
    path.join(root, 'public', 'usernode-bridge', 'v1', 'bridge.js'), 'utf8'
  );
  assert.equal(versioned, bridgeSource, 'the two copies must stay identical');
  assert.match(versioned, /window\.usernode\.getBridgeDiagnostics = function/);
  assert.match(versioned, /classifyPrivilegedFailure/);
});
