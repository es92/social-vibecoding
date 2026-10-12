const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'social-push.js'),
  'utf8'
);
// #1808: notifications.js has one bundle import now (`agoStamp` from
// lib/timestamp.ts, which gave the rows a stamp with a floor). This harness
// evaluates the shipped source raw in a vm, so it stands in for the bundler:
// the import statement is dropped and the REAL helper is put in the sandbox
// under the same name, so a row's stamp is the one that ships.
const { agoStamp } = require('./lib/render-tsx').loadTsx('frontend/src/lib/timestamp.ts');
const notificationsSource = fs.readFileSync(
  // #1079 chunk B: same module, now inside the React bundle.
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8'
).replace(/^import \{ agoStamp \}.*$/m, '');

// Evaluate that source with the helper in scope, standing in for the bundle's
// module graph.
function runNotifications(sandbox) {
  sandbox.agoStamp = agoStamp;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(notificationsSource, sandbox);
}
const settingsSource = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'settings', 'settings.js'),
  'utf8'
);

const capabilities = [
  'getSocialPushState',
  'setSocialPushEnabled',
  'claimPendingSocialNotification',
  'ackPendingSocialNotification',
];

function loadCoordinator({
  claims = [],
  openResult = true,
  openImpl,
  ackImpl,
  getStateImpl,
  isSessionAdmittedImpl,
  caps = capabilities,
  bridgeReadyImpl,
  getInfoImpl,
  badgeImpl,
  includeBadgeMethod = true,
  refreshImpl,
  invalidationRefreshVersion = 1,
  foregroundStorage = new Map(),
  foregroundStorageImpl,
  includeBridgeReadyMethod = true,
  timeoutScale = 1,
} = {}) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const calls = [];
  const state = {
    enabled: true,
    permissionStatus: 'authorized',
    registrationStatus: 'registered',
    deliveryActive: true,
  };
  const sandbox = {
    console: { warn() {} },
    Promise,
    localStorage: foregroundStorageImpl || {
      getItem(key) {
        return foregroundStorage.has(key) ? foregroundStorage.get(key) : null;
      },
      setItem(key, value) { foregroundStorage.set(key, String(value)); },
      removeItem(key) { foregroundStorage.delete(key); },
    },
    setTimeout(fn, delay) { return setTimeout(fn, delay * timeoutScale); },
    clearTimeout,
    CustomEvent: class CustomEvent {
      constructor(type, init) { this.type = type; this.detail = init && init.detail; }
    },
    App: { user: { id: 7 } },
    NativeChrome: {
      async getInfo() {
        return getInfoImpl
          ? getInfoImpl()
          : { version: 4, capabilities: caps };
      },
      isSessionAdmitted() {
        return isSessionAdmittedImpl ? isSessionAdmittedImpl() : true;
      },
    },
    Notifications: {
      ...(invalidationRefreshVersion == null
        ? {}
        : { nativeInvalidationRefreshVersion: invalidationRefreshVersion }),
      async openById(id) {
        calls.push(['open', id]);
        return openImpl ? openImpl(id) : openResult;
      },
      async refreshAfterInvalidation() {
        calls.push(['refresh']);
        return refreshImpl ? refreshImpl() : true;
      },
    },
    DevAlerts: {
      setRemoteDeliveryActive(active) { calls.push(['remote', active]); },
    },
    usernode: {
      isNative: true,
      async getSocialPushState() {
        calls.push(['state']);
        return getStateImpl ? getStateImpl() : state;
      },
      async setSocialPushEnabled(enabled) {
        calls.push(['enable', enabled]);
        return { ...state, enabled };
      },
      async claimPendingSocialNotification() {
        calls.push(['claim']);
        return claims.length ? claims.shift() : null;
      },
      async ackPendingSocialNotification(id) {
        calls.push(['ack', id]);
        return ackImpl ? ackImpl(id) : true;
      },
      ...(includeBadgeMethod ? {
        async setSocialBadgeCount(count) {
          calls.push(['badge', count]);
          return badgeImpl ? badgeImpl(count) : true;
        },
      } : {}),
    },
    addEventListener(type, listener) {
      const list = windowListeners.get(type) || [];
      list.push(listener);
      windowListeners.set(type, list);
    },
    dispatchEvent(event) {
      for (const listener of windowListeners.get(event.type) || []) listener(event);
    },
    document: {
      addEventListener(type, listener) {
        const list = documentListeners.get(type) || [];
        list.push(listener);
        documentListeners.set(type, list);
      },
    },
  };
  if (includeBridgeReadyMethod) {
    sandbox.usernode.markPrivilegedBridgeReady = async () => {
      calls.push(['bridge-ready']);
      return bridgeReadyImpl ? bridgeReadyImpl() : { ready: true };
    };
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return {
    sandbox,
    calls,
    fire(type, detail) {
      for (const listener of windowListeners.get(type) || []) {
        listener({ type, detail });
      }
    },
    fireDocument(type) {
      for (const listener of documentListeners.get(type) || []) {
        listener({ type });
      }
    },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

// Poll until `check` holds, failing with `what` after `timeoutMs`: for a
// test that waits on timers, whose ticks a loaded checks pod can delay past
// any fixed sleep.
async function until(check, what, { timeoutMs = 10000, everyMs = 2 } = {}) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

test('realm readiness waits for deferred shell listeners', async () => {
  const loaded = loadCoordinator();

  assert.equal(loaded.sandbox.__usernodeExplicitReadinessClient, true);

  await settle();
  assert.equal(
    loaded.calls.some(([name]) => name === 'bridge-ready'),
    false,
    'the parser-time script must not request replay before React hydrates'
  );

  loaded.fireDocument('DOMContentLoaded');
  await settle();
  assert.equal(
    loaded.calls.filter(([name]) => name === 'bridge-ready').length,
    1
  );
});

test('current coordinator does not claim readiness with an older bridge',
  async () => {
    const loaded = loadCoordinator({ includeBridgeReadyMethod: false });

    assert.equal(loaded.sandbox.__usernodeExplicitReadinessClient, false);
    loaded.fireDocument('DOMContentLoaded');
    await settle();
    assert.equal(
      loaded.calls.some(([name]) => name === 'bridge-ready'),
      false
    );
  });

// Zero-scaled backoff timers still need wall-clock milliseconds to fire,
// which setImmediate alone does not spend.
async function drainRetries(ticks = 24) {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// The backoff table used to clamp its index, so a device whose privileged
// handshake was refused reissued markPrivilegedBridgeReady every 30 s for
// the life of the document — forever, silently, and never once winning.
test('a refused readiness handshake stops after the backoff table is spent',
  async () => {
    const loaded = loadCoordinator({
      timeoutScale: 0,
      bridgeReadyImpl() {
        const err = new Error('Privileged bridge is unavailable for this main frame');
        err.usernodeCode = 'privileged_frame_unauthorized';
        throw err;
      },
    });

    loaded.fireDocument('DOMContentLoaded');
    await drainRetries();

    const attempts = loaded.calls.filter(([n]) => n === 'bridge-ready').length;
    assert.equal(attempts, 6, 'the whole table is the budget, and it is finite');

    const state = loaded.sandbox.SocialPush.readinessState();
    assert.equal(state.ready, false);
    assert.equal(state.exhausted, true);
    assert.equal(state.pending, false);
    assert.match(state.lastError, /main frame/i);

    // And it stays stopped without a real signal.
    await drainRetries();
    assert.equal(
      loaded.calls.filter(([n]) => n === 'bridge-ready').length, 6
    );
  });

test('the user can spend a fresh readiness budget from Settings', async () => {
  let failing = true;
  const loaded = loadCoordinator({
    timeoutScale: 0,
    bridgeReadyImpl() {
      if (failing) throw new Error('refused');
      return { ready: true };
    },
  });

  loaded.fireDocument('DOMContentLoaded');
  await drainRetries();
  assert.equal(loaded.sandbox.SocialPush.readinessState().exhausted, true);

  failing = false;
  const state = loaded.sandbox.SocialPush.retryBridgeReadiness();
  assert.equal(state.exhausted, false);
  await settle();
  assert.equal(loaded.sandbox.SocialPush.readinessState().ready, true);
  assert.equal(loaded.calls.filter(([n]) => n === 'bridge-ready').length, 7);
});

test('a native auth-status of ready re-arms a spent readiness budget',
  async () => {
    let failing = true;
    const loaded = loadCoordinator({
      timeoutScale: 0,
      bridgeReadyImpl() {
        if (failing) throw new Error('refused');
        return { ready: true };
      },
    });

    loaded.fireDocument('DOMContentLoaded');
    await drainRetries();
    assert.equal(loaded.sandbox.SocialPush.readinessState().exhausted, true);

    // A non-ready phase is not the signal; only "ready" is.
    loaded.fire('usernode:auth-status', { phase: 'transitioning' });
    await settle();
    assert.equal(loaded.calls.filter(([n]) => n === 'bridge-ready').length, 6);

    failing = false;
    loaded.fire('usernode:auth-status', { phase: 'ready' });
    await settle();
    assert.equal(loaded.sandbox.SocialPush.readinessState().ready, true);
  });

test('a successful readiness handshake reports a clean state', async () => {
  const loaded = loadCoordinator();

  loaded.fireDocument('DOMContentLoaded');
  await settle();

  const state = loaded.sandbox.SocialPush.readinessState();
  assert.deepEqual(
    { ready: state.ready, attempts: state.attempts, exhausted: state.exhausted },
    { ready: true, attempts: 0, exhausted: false }
  );
  assert.equal(state.lastError, null);
});

test('transient support probes retry instead of disabling Social push',
  async () => {
    let probes = 0;
    const loaded = loadCoordinator({
      getInfoImpl() {
        probes += 1;
        return probes === 1
          ? { version: 0, capabilities: [], degraded: true }
          : { version: 4, capabilities };
      },
    });

    assert.equal(await loaded.sandbox.SocialPush.isSupported(), false);
    await settle();
    assert.equal(await loaded.sandbox.SocialPush.isSupported(), true);
    assert.equal(probes, 2);
  });

test('BFCache restore rebinds readiness without duplicate in-flight calls',
  async () => {
    let resolveFirst;
    const firstReady = new Promise((resolve) => { resolveFirst = resolve; });
    let attempts = 0;
    const loaded = loadCoordinator({
      bridgeReadyImpl() {
        attempts += 1;
        return attempts === 1 ? firstReady : { ready: true };
      },
    });

    loaded.fireDocument('DOMContentLoaded');
    loaded.fire('pageshow');
    await settle();
    assert.equal(attempts, 1, 'pageshow must share the active handshake');
    resolveFirst({ ready: true });
    await settle();

    loaded.fire('pagehide');
    loaded.fire('pageshow');
    await settle();
    assert.equal(attempts, 2, 'the restored realm must rebind native readiness');
  });

test('pending id is opened through Notifications before native acknowledgement', async () => {
  const loaded = loadCoordinator({ claims: [{ notificationId: 42 }] });

  await loaded.sandbox.SocialPush.init();

  assert.deepEqual(
    loaded.calls.filter(([name]) => ['claim', 'open', 'ack'].includes(name)),
    [['claim'], ['open', 42], ['ack', 42]]
  );
  assert.ok(loaded.calls.some(([name, active]) =>
    name === 'remote' && active === true));
});

test('failed or malformed notification opens are never acknowledged', async () => {
  const failed = loadCoordinator({
    claims: [{ notificationId: 43 }],
    openResult: false,
  });
  await failed.sandbox.SocialPush.init();
  assert.equal(failed.calls.some(([name]) => name === 'ack'), false);

  const malformed = loadCoordinator({ claims: [{ notificationId: '43' }] });
  await malformed.sandbox.SocialPush.init();
  assert.equal(malformed.calls.some(([name]) => name === 'open'), false);
  assert.equal(malformed.calls.some(([name]) => name === 'ack'), false);
});

test('a retained tap retries when connectivity returns', async () => {
  let openAttempts = 0;
  const loaded = loadCoordinator({
    claims: [{ notificationId: 43 }, { notificationId: 43 }],
    openImpl() {
      openAttempts += 1;
      return openAttempts > 1;
    },
  });

  await loaded.sandbox.SocialPush.init();
  loaded.fire('online');
  await settle();

  assert.deepEqual(
    loaded.calls.filter(([name]) => ['claim', 'open', 'ack'].includes(name)),
    [
      ['claim'], ['open', 43],
      ['claim'], ['open', 43], ['ack', 43],
    ]
  );
});

test('foreground event refreshes authenticated notifications without content', async () => {
  const loaded = loadCoordinator();
  await loaded.sandbox.SocialPush.init();
  loaded.calls.length = 0;

  loaded.fire('usernode:social-push-foreground');
  await settle();

  assert.deepEqual(loaded.calls, [['refresh']]);
});

test('failed foreground refresh remains dirty and retries online', async () => {
  let attempts = 0;
  const loaded = loadCoordinator({
    refreshImpl() {
      attempts += 1;
      return attempts > 1;
    },
  });
  await loaded.sandbox.SocialPush.init();
  loaded.calls.length = 0;

  loaded.fire('usernode:social-push-foreground');
  await settle();
  assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, true);

  loaded.fire('online');
  await settle();
  assert.equal(attempts, 2);
  assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, false);
  assert.equal(
    loaded.calls.filter(([name]) => name === 'refresh').length,
    2
  );
});

test('a foreground invalidation arriving during refresh gets a trailing fetch',
  async () => {
    let releaseFirst;
    const first = new Promise((resolve) => { releaseFirst = resolve; });
    let attempts = 0;
    const loaded = loadCoordinator({
      refreshImpl() {
        attempts += 1;
        return attempts === 1 ? first : true;
      },
    });
    await loaded.sandbox.SocialPush.init();
    loaded.calls.length = 0;

    loaded.fire('usernode:social-push-foreground');
    await settle();
    loaded.fire('usernode:social-push-foreground');
    releaseFirst(true);
    await settle();

    assert.ok(attempts >= 2);
    assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, false);
  });

test('failed foreground refresh retries while the page stays active',
  async () => {
    let attempts = 0;
    const loaded = loadCoordinator({
      timeoutScale: 0.001,
      refreshImpl() {
        attempts += 1;
        return attempts > 1;
      },
    });
    await loaded.sandbox.SocialPush.init();

    loaded.fire('usernode:social-push-foreground');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await settle();

    assert.equal(attempts, 2);
    assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, false);
  });

test('foreground invalidation does not depend on a native capability probe',
  async () => {
    let probes = 0;
    const loaded = loadCoordinator({
      getInfoImpl() {
        probes += 1;
        return { version: 0, capabilities: [], degraded: true };
      },
    });

    loaded.fire('usernode:social-push-foreground');
    await settle();

    assert.equal(probes, 0);
    assert.equal(
      loaded.calls.filter(([name]) => name === 'refresh').length,
      1
    );
    assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, false);
  });

test('an older cached Notifications bundle cannot consume an invalidation',
  async () => {
    const storage = new Map();
    const loaded = loadCoordinator({
      invalidationRefreshVersion: null,
      foregroundStorage: storage,
    });

    loaded.fire('usernode:social-push-foreground');
    await settle();

    assert.equal(
      loaded.calls.some(([name]) => name === 'refresh'),
      false,
      'the previous unconditional-success method must not be called'
    );
    assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, true);
    const retainedToken = storage.get(
      'social_push_foreground_invalidation_v1'
    );
    assert.ok(retainedToken);
    assert.equal(
      loaded.sandbox.SocialPush._foregroundRetryTimer,
      null,
      'an already-evaluated old bundle cannot recover through timer polling'
    );
    loaded.fire('pagehide');

    const recovered = loadCoordinator({ foregroundStorage: storage });
    recovered.fireDocument('DOMContentLoaded');
    await settle();

    assert.equal(
      recovered.calls.filter(([name]) => name === 'refresh').length,
      1,
      'the current bundle must replay the retained invalidation at startup'
    );
    assert.equal(recovered.sandbox.SocialPush._foregroundInvalidationDirty, false);
    assert.equal(storage.has('social_push_foreground_invalidation_v1'), false);
  });

test('a pagehidden refresh cannot clear replacement-realm recovery',
  async () => {
    const storage = new Map();
    let releaseRefresh;
    const pendingRefresh = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    const oldRealm = loadCoordinator({
      foregroundStorage: storage,
      refreshImpl: () => pendingRefresh,
    });

    oldRealm.fire('usernode:social-push-foreground');
    await settle();
    oldRealm.fire('pagehide');
    releaseRefresh(true);
    await settle();

    assert.equal(oldRealm.sandbox.SocialPush._foregroundInvalidationDirty, true);
    assert.equal(
      storage.get('social_push_foreground_invalidation_v1'),
      oldRealm.sandbox.SocialPush._foregroundInvalidationToken,
      'an inactive realm must leave recovery ownership for its replacement'
    );

    const replacement = loadCoordinator({ foregroundStorage: storage });
    replacement.fireDocument('DOMContentLoaded');
    await settle();

    assert.equal(
      replacement.calls.filter(([name]) => name === 'refresh').length,
      1
    );
    assert.equal(storage.has('social_push_foreground_invalidation_v1'), false);
  });

test('an older restored realm cannot clear a newer realm invalidation',
  async () => {
    const storage = new Map();
    let releaseOldRefresh;
    const oldRefresh = new Promise((resolve) => {
      releaseOldRefresh = resolve;
    });
    let realmAAttempts = 0;
    const realmA = loadCoordinator({
      foregroundStorage: storage,
      refreshImpl() {
        realmAAttempts += 1;
        return realmAAttempts === 1 ? oldRefresh : true;
      },
    });

    realmA.fire('usernode:social-push-foreground');
    await settle();
    const tokenA = storage.get('social_push_foreground_invalidation_v1');
    realmA.fire('pagehide');

    const realmB = loadCoordinator({
      foregroundStorage: storage,
      invalidationRefreshVersion: null,
    });
    realmB.fire('usernode:social-push-foreground');
    await settle();
    const tokenB = storage.get('social_push_foreground_invalidation_v1');
    assert.ok(tokenA);
    assert.ok(tokenB);
    assert.notEqual(tokenA, tokenB);

    realmA.fire('pageshow');
    releaseOldRefresh(true);
    await settle();

    assert.equal(realmAAttempts, 2,
      'realm A must refresh in its current lifecycle before consuming token B');
    assert.equal(
      storage.has('social_push_foreground_invalidation_v1'),
      false,
      'the current-epoch refresh may consume the adopted token'
    );
    assert.equal(realmA.sandbox.SocialPush._foregroundInvalidationDirty, false);
    realmA.fire('pagehide');
    realmB.fire('pagehide');
  });

test('a pre-hide refresh cannot settle after another realm consumed its token',
  async () => {
    const storage = new Map();
    let releaseOldRefresh;
    const oldRefresh = new Promise((resolve) => {
      releaseOldRefresh = resolve;
    });
    let realmAAttempts = 0;
    const realmA = loadCoordinator({
      foregroundStorage: storage,
      refreshImpl() {
        realmAAttempts += 1;
        return realmAAttempts === 1 ? oldRefresh : true;
      },
    });

    realmA.fire('usernode:social-push-foreground');
    await settle();
    realmA.fire('pagehide');

    const realmB = loadCoordinator({ foregroundStorage: storage });
    realmB.fire('usernode:social-push-foreground');
    await settle();
    assert.equal(
      storage.has('social_push_foreground_invalidation_v1'),
      false,
      'realm B consumes its own newer token after a fresh read'
    );

    realmA.fire('pageshow');
    const recoveryToken = storage.get(
      'social_push_foreground_invalidation_v1'
    );
    assert.ok(recoveryToken, 'restored realm A reacquires recovery ownership');
    releaseOldRefresh(true);
    await settle();

    assert.equal(realmAAttempts, 2,
      'the pre-hide result must be followed by a current-epoch refresh');
    assert.equal(realmA.sandbox.SocialPush._foregroundInvalidationDirty, false);
    assert.equal(storage.has('social_push_foreground_invalidation_v1'), false);
  });

test('a clean BFCache realm adopts a pending invalidation on restore',
  async () => {
    const storage = new Map();
    const realmA = loadCoordinator({ foregroundStorage: storage });
    realmA.fire('pagehide');

    const realmB = loadCoordinator({
      foregroundStorage: storage,
      invalidationRefreshVersion: null,
    });
    realmB.fire('usernode:social-push-foreground');
    await settle();
    assert.ok(storage.get('social_push_foreground_invalidation_v1'));

    realmA.fire('pageshow');
    await settle();

    assert.equal(
      realmA.calls.filter(([name]) => name === 'refresh').length,
      1,
      'restored realm A must reconcile the pending realm B invalidation'
    );
    assert.equal(realmA.sandbox.SocialPush._foregroundInvalidationDirty, false);
    assert.equal(storage.has('social_push_foreground_invalidation_v1'), false);
    realmA.fire('pagehide');
    realmB.fire('pagehide');
  });

test('a clean BFCache realm refreshes after another realm consumed the token',
  async () => {
    const storage = new Map();
    const realmA = loadCoordinator({ foregroundStorage: storage });
    realmA.fire('pagehide');

    const realmB = loadCoordinator({ foregroundStorage: storage });
    realmB.fire('usernode:social-push-foreground');
    await settle();
    assert.equal(
      storage.has('social_push_foreground_invalidation_v1'),
      false,
      'realm B already consumed the shared invalidation token'
    );

    realmA.fire('pageshow');
    await settle();

    assert.equal(
      realmA.calls.filter(([name]) => name === 'refresh').length,
      1,
      'restored realm A still needs its own current-realm network refresh'
    );
    assert.equal(realmA.sandbox.SocialPush._foregroundInvalidationDirty, false);
    assert.equal(storage.has('social_push_foreground_invalidation_v1'), false);
    realmA.fire('pagehide');
    realmB.fire('pagehide');
  });

test('blocked invalidation storage settles through the in-memory path',
  async () => {
    const loaded = loadCoordinator({
      foregroundStorageImpl: {
        getItem() { throw new Error('storage blocked'); },
        setItem() { throw new Error('storage blocked'); },
        removeItem() { throw new Error('storage blocked'); },
      },
    });

    loaded.fire('usernode:social-push-foreground');
    await settle();

    assert.equal(
      loaded.calls.filter(([name]) => name === 'refresh').length,
      1,
      'a successful refresh must not spin when storage throws'
    );
    assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, false);
    assert.equal(loaded.sandbox.SocialPush._foregroundRefreshPromise, null);
    assert.equal(loaded.sandbox.SocialPush._foregroundRetryTimer, null);
  });

test('non-persisting invalidation storage also settles in memory', async () => {
  const loaded = loadCoordinator({
    foregroundStorageImpl: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
  });

  loaded.fire('usernode:social-push-foreground');
  await settle();

  assert.equal(
    loaded.calls.filter(([name]) => name === 'refresh').length,
    1,
    'a no-op storage shim must not trigger immediate trailing fetches'
  );
  assert.equal(loaded.sandbox.SocialPush._foregroundInvalidationDirty, false);
  assert.equal(loaded.sandbox.SocialPush._foregroundRefreshPromise, null);
  assert.equal(loaded.sandbox.SocialPush._foregroundRetryTimer, null);
});

test('native state change refreshes delivery status through the admitted bridge', async () => {
  let deliveryActive = true;
  const loaded = loadCoordinator({
    getStateImpl() {
      return {
        enabled: true,
        permissionStatus: 'authorized',
        registrationStatus: 'registered',
        deliveryActive,
      };
    },
  });
  await loaded.sandbox.SocialPush.init();
  loaded.calls.length = 0;

  deliveryActive = false;
  loaded.fire('usernode:social-push-native-state-changed');
  await settle();

  assert.deepEqual(loaded.calls, [['state'], ['remote', false]]);
  assert.equal(loaded.sandbox.SocialPush._state.deliveryActive, false);
});

test('native state invalidation queues a trailing read after an old in-flight snapshot', async () => {
  let releaseState;
  const pendingState = new Promise((resolve) => { releaseState = resolve; });
  let reads = 0;
  const loaded = loadCoordinator({
    getStateImpl() {
      reads += 1;
      if (reads === 1) return pendingState;
      return {
        enabled: true,
        permissionStatus: 'authorized',
        registrationStatus: 'registered',
        deliveryActive: false,
      };
    },
  });

  const reading = loaded.sandbox.SocialPush.getState();
  await settle();
  loaded.fire('usernode:social-push-native-state-changed');
  await settle();

  releaseState({
    enabled: true,
    permissionStatus: 'authorized',
    registrationStatus: 'registered',
    deliveryActive: true,
  });
  await reading;
  await settle();

  assert.equal(
    loaded.calls.filter(([name]) => name === 'state').length,
    2
  );
  assert.equal(loaded.sandbox.SocialPush._state.deliveryActive, false);
});

test('state and pending work retry only after native session admission', async () => {
  let admitted = false;
  const loaded = loadCoordinator({
    claims: [{ notificationId: 44 }],
    isSessionAdmittedImpl: () => admitted,
    getStateImpl() {
      if (!admitted) throw new Error('session handoff is in progress');
      return {
        enabled: true,
        permissionStatus: 'authorized',
        registrationStatus: 'registered',
        deliveryActive: true,
      };
    },
  });

  await loaded.sandbox.SocialPush.init();
  assert.deepEqual(loaded.calls, [['remote', false]],
    'a closed session clears stale delivery state without calling native');

  admitted = true;
  loaded.fire('usernode:native-session-admission', { admitted: true });
  await settle();

  assert.ok(loaded.calls.some(([name, active]) =>
    name === 'remote' && active === true));
  assert.deepEqual(
    loaded.calls.filter(([name]) => ['open', 'ack'].includes(name)),
    [['open', 44], ['ack', 44]]
  );
});

test('closing native session admission clears prior delivery state', async () => {
  const loaded = loadCoordinator();
  await loaded.sandbox.SocialPush.init();
  loaded.calls.length = 0;

  loaded.fire('usernode:native-session-admission', { admitted: false });

  assert.deepEqual(loaded.calls, [['remote', false]]);
  assert.equal(loaded.sandbox.SocialPush._state, null);
});

test('closed admission never exposes cached state or calls the setter',
  async () => {
    let admitted = true;
    const loaded = loadCoordinator({
      isSessionAdmittedImpl: () => admitted,
    });
    await loaded.sandbox.SocialPush.init();
    assert.ok(loaded.sandbox.SocialPush._state);
    loaded.calls.length = 0;

    admitted = false;
    assert.equal(await loaded.sandbox.SocialPush.getState(), null);
    await assert.rejects(
      loaded.sandbox.SocialPush.setEnabled(true),
      /secure app sign-in is still finishing/i
    );

    assert.equal(loaded.sandbox.SocialPush._state, null);
    assert.equal(loaded.calls.some(([name]) => name === 'enable'), false);
  });

test('a state read resolving after admission closes cannot restore old state', async () => {
  let releaseState;
  const pendingState = new Promise((resolve) => { releaseState = resolve; });
  const loaded = loadCoordinator({ getStateImpl: () => pendingState });

  const reading = loaded.sandbox.SocialPush.getState();
  await settle();
  loaded.fire('usernode:native-session-admission', { admitted: false });
  releaseState({
    enabled: true,
    permissionStatus: 'authorized',
    registrationStatus: 'registered',
    deliveryActive: true,
  });
  await reading;

  assert.equal(loaded.sandbox.SocialPush._state, null);
  assert.deepEqual(
    loaded.calls.filter(([name]) => name === 'remote'),
    [['remote', false]]
  );
});

test('a second tap received during a drain is claimed after the first', async () => {
  let releaseFirstOpen;
  const firstOpen = new Promise((resolve) => { releaseFirstOpen = resolve; });
  const loaded = loadCoordinator({
    claims: [{ notificationId: 45 }, { notificationId: 46 }],
    openImpl(id) { return id === 45 ? firstOpen : true; },
    ackImpl(id) { return id !== 45; },
  });

  const draining = loaded.sandbox.SocialPush.drainPending();
  await settle();
  loaded.fire('usernode:social-push-pending');
  releaseFirstOpen(true);
  await draining;

  assert.deepEqual(
    loaded.calls.filter(([name]) => ['claim', 'open', 'ack'].includes(name)),
    [
      ['claim'], ['open', 45], ['ack', 45],
      ['claim'], ['open', 46], ['ack', 46],
    ]
  );
});

test('a failed first tap still drains a second tap requested in flight', async () => {
  let rejectFirstOpen;
  const firstOpen = new Promise((_, reject) => { rejectFirstOpen = reject; });
  const loaded = loadCoordinator({
    claims: [{ notificationId: 47 }, { notificationId: 48 }],
    openImpl(id) { return id === 47 ? firstOpen : true; },
  });

  const draining = loaded.sandbox.SocialPush.drainPending();
  await settle();
  loaded.fire('usernode:social-push-pending');
  rejectFirstOpen(new Error('lookup failed'));
  await draining;

  assert.deepEqual(
    loaded.calls.filter(([name]) => ['claim', 'open', 'ack'].includes(name)),
    [
      ['claim'], ['open', 47],
      ['claim'], ['open', 48], ['ack', 48],
    ]
  );
});

test('missing native capabilities make the coordinator a no-op', async () => {
  const loaded = loadCoordinator({ caps: [] });

  await loaded.sandbox.SocialPush.init();

  assert.deepEqual(loaded.calls, []);
});

test('a tap received before web sign-in drains when authenticated boot finishes', async () => {
  const loaded = loadCoordinator({ claims: [{ notificationId: 42 }] });
  loaded.sandbox.App.user = null;
  loaded.fire('usernode:social-push-pending');
  await settle();
  assert.equal(loaded.calls.some(([name]) => name === 'claim'), false);
  loaded.sandbox.App.user = { id: 7 };
  loaded.fireDocument('sv:authed');
  await settle();
  assert.ok(loaded.calls.some(([name, id]) => name === 'ack' && id === 42));
});

test('a restored page drains a retained tap without another native event', async () => {
  const loaded = loadCoordinator({ claims: [{ notificationId: 42 }] });
  loaded.fire('pagehide');
  loaded.fire('usernode:social-push-pending');
  await settle();
  assert.equal(loaded.calls.some(([name]) => name === 'claim'), false);
  loaded.fire('pageshow');
  await settle();
  assert.ok(loaded.calls.some(([name, id]) => name === 'ack' && id === 42));
});

test('a transient open failure retries the retained tap without an online event', async () => {
  let attempts = 0;
  const loaded = loadCoordinator({
    claims: [{ notificationId: 42 }, { notificationId: 42 }],
    openImpl() { return ++attempts > 1; },
    timeoutScale: 0.001,
  });
  await loaded.sandbox.SocialPush.drainPending();
  assert.equal(loaded.calls.some(([name]) => name === 'ack'), false);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(attempts, 2);
  assert.deepEqual(loaded.calls.filter(([name]) => name === 'ack'), [['ack', 42]]);
});

test('tap retries are bounded and pagehide cancels a scheduled retry', async () => {
  const loaded = loadCoordinator({
    claims: Array.from({ length: 10 }, () => ({ notificationId: 42 })),
    openResult: false,
    timeoutScale: 0.0001,
  });
  await loaded.sandbox.SocialPush.drainPending();
  // The first open and five scaled retries. They run on timers, which a
  // loaded checks pod delays: a fixed 30 ms saw 5 of the 6 (12 Oct 2026).
  const opens = () => loaded.calls.filter(([name]) => name === 'open').length;
  await until(() => opens() >= 6 && loaded.sandbox.SocialPush._tapRetryTimer === null, 'the retries run out');
  assert.equal(opens(), 6);
  assert.equal(loaded.sandbox.SocialPush._tapRetryTimer, null);
  await loaded.sandbox.SocialPush.drainPending();
  loaded.fire('pagehide');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(loaded.calls.filter(([name]) => name === 'open').length, 7);
});

test('an admission change during navigation cannot acknowledge the old tap', async () => {
  let finish;
  const loaded = loadCoordinator({
    claims: [{ notificationId: 42 }],
    openImpl() { return new Promise(resolve => { finish = resolve; }); },
  });
  const draining = loaded.sandbox.SocialPush.drainPending();
  await settle();
  loaded.fire('usernode:native-session-admission', { admitted: false });
  finish(true);
  await draining;
  assert.equal(loaded.calls.some(([name]) => name === 'ack'), false);
  loaded.fire('pagehide');
});

test('native exact opens await the real item router and preserve failed navigation', async () => {
  const loaded = loadCoordinator();
  loaded.sandbox.location = { search: '', hash: '' };
  loaded.sandbox.URLSearchParams = URLSearchParams;
  runNotifications(loaded.sandbox);
  const notifications = loaded.sandbox.Notifications;
  notifications._markOneRead = () => {};
  notifications._dismissSheetForNav = () => {};
  const items = [
    { id: 41, kind: 'mention', appSlug: 'notes', threadType: 'issue', threadRef: 1804 },
    { id: 42, kind: 'pr_proposed', appSlug: 'notes', sessionId: 3952 },
    { id: 43, kind: 'session_done', appSlug: 'notes', sessionId: 3955 },
  ];
  notifications.items = items;
  for (const item of items) {
    let finish;
    let completed = false;
    loaded.sandbox.App.openAppTab = () => new Promise(resolve => { finish = resolve; });
    const opened = notifications.openById(item.id).then(result => {
      completed = true;
      return result;
    });
    await settle();
    assert.equal(completed, false, item.kind);
    finish();
    assert.equal(await opened, true);
  }
  loaded.sandbox.App.openAppTab = async () => { throw new Error('offline'); };
  assert.equal(await notifications.openById(42), false);
  loaded.sandbox.App.openAppTab = async () => false;
  assert.equal(await notifications.openById(42), false);
});

test('settings consumes live native push state', () => {
  assert.match(
    settingsSource,
    /addEventListener\('usernode:social-push-state', onState\)/
  );
  // #1079: the listener publishes a model slice instead of calling a local
  // render closure over its own host — which is what retires the
  // `box.isConnected` guard it used to need on every event.
  assert.match(settingsSource,
    /this\._socialPushState = \(event && event\.detail\) \|\| null;/);
  assert.match(settingsSource, /this\._publishUsernode\(\);/);
});

test('opaque id lookup reuses the existing notification click router', async () => {
  const requests = [];
  const routes = [];
  const sandbox = {
    console: { warn() {} },
    Date,
    Promise,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    location: { search: '', hash: '' },
    localStorage: { getItem() { return null; }, setItem() {} },
    document: {
      title: 'Social',
      addEventListener() {},
      getElementById() { return null; },
    },
    App: {
      user: { id: 7 },
      openAppTab(slug, tab, options) { routes.push({ slug, tab, options }); },
    },
    async fetch(url, options) {
      requests.push({ url, options: options || {} });
      if (url === '/api/notifications/42') {
        return {
          ok: true,
          async json() {
            return {
              notification: {
                id: 42,
                kind: 'session_done',
                readAt: null,
                appSlug: 'example',
                sessionId: 9,
              },
            };
          },
        };
      }
      return { ok: true, async json() { return { unread: 0 }; } };
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  runNotifications(sandbox);
  sandbox.Notifications.unread = 1;

  const opened = await sandbox.Notifications.openById(42);
  await settle();

  assert.equal(opened, true);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].slug, 'example');
  assert.equal(routes[0].tab, 'dev');
  assert.equal(routes[0].options.subTab, 'topic');
  assert.equal(routes[0].options.ref.kind, 'proposal');
  assert.equal(routes[0].options.ref.id, 9);
  assert.equal(requests[0].url, '/api/notifications/42');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(requests[1].url, '/api/notifications/read');
});

test('native invalidation refresh bypasses the service-worker API cache',
  async () => {
    const requests = [];
    const sandbox = {
      console: { warn() {} },
      Date,
      Promise,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      location: { search: '', hash: '' },
      localStorage: { getItem() { return null; }, setItem() {} },
      document: {
        title: 'Social',
        addEventListener() {},
        getElementById() { return null; },
      },
      App: { user: { id: 7 } },
      async fetch(url, options) {
        requests.push({ url, options });
        return {
          ok: true,
          async json() {
            return { notifications: [], pendingInvites: [], unread: 0 };
          },
        };
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    runNotifications(sandbox);

    assert.equal(sandbox.Notifications.nativeInvalidationRefreshVersion, 1);
    assert.equal(await sandbox.Notifications.refreshAfterInvalidation(), true);
    assert.equal(await sandbox.Notifications.refreshAfterInvalidation(), true);
    assert.equal(requests.length, 2);
    const first = new URL(requests[0].url, 'https://social.example');
    const second = new URL(requests[1].url, 'https://social.example');
    assert.equal(first.pathname, '/api/notifications');
    assert.equal(first.searchParams.get('limit'), '100');
    assert.equal(first.searchParams.get('native_invalidation'), '1');
    assert.ok(first.searchParams.get('native_invalidation_nonce'));
    assert.equal(second.searchParams.get('native_invalidation'), '1');
    assert.ok(second.searchParams.get('native_invalidation_nonce'));
    assert.notEqual(
      first.searchParams.get('native_invalidation_nonce'),
      second.searchParams.get('native_invalidation_nonce'),
      'an older service worker must not match a previous cached response'
    );
    assert.equal(requests[0].options.cache, 'no-store');
    assert.equal(requests[0].options.credentials, 'same-origin');
  });

test('an older ordinary refresh cannot overwrite a newer invalidation result',
  async () => {
    const responses = [];
    const sandbox = {
      console: { warn() {} },
      Date,
      Promise,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      location: { search: '', hash: '' },
      localStorage: { getItem() { return null; }, setItem() {} },
      document: {
        title: 'Social',
        addEventListener() {},
        getElementById() { return null; },
      },
      App: { user: { id: 7 } },
      fetch() {
        return new Promise((resolve) => responses.push(resolve));
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    runNotifications(sandbox);

    const ordinary = sandbox.Notifications.refresh();
    const invalidation = sandbox.Notifications.refreshAfterInvalidation();
    responses[1]({
      ok: true,
      async json() {
        return { notifications: [{ id: 2 }], unread: 1 };
      },
    });
    assert.equal(await invalidation, true);
    responses[0]({
      ok: true,
      async json() {
        return { notifications: [{ id: 1 }], unread: 0 };
      },
    });
    assert.equal(await ordinary, false);
    assert.equal(sandbox.Notifications.items[0].id, 2);
    assert.equal(sandbox.Notifications.unread, 1);
  });

test('later ordinary refreshes cannot fall below a native freshness floor',
  async () => {
    const requests = [];
    const sandbox = {
      console: { warn() {} },
      Date,
      Promise,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      location: { search: '', hash: '' },
      localStorage: { getItem() { return null; }, setItem() {} },
      document: {
        title: 'Social',
        addEventListener() {},
        getElementById() { return null; },
      },
      App: { user: { id: 7 } },
      async fetch(url, options) {
        requests.push({ url, options });
        const id = requests.length + 1;
        return {
          ok: true,
          async json() {
            return { notifications: [{ id }], unread: 1 };
          },
        };
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    runNotifications(sandbox);

    assert.equal(await sandbox.Notifications.refreshAfterInvalidation(), true);
    assert.equal(sandbox.Notifications.items[0].id, 2);
    assert.equal(await sandbox.Notifications.refresh(), true);

    assert.equal(requests.length, 2);
    for (const request of requests) {
      const url = new URL(request.url, 'https://social.example');
      assert.equal(url.searchParams.get('native_invalidation'), '1');
      assert.ok(url.searchParams.get('native_invalidation_nonce'));
      assert.equal(request.options.cache, 'no-store');
      assert.equal(request.options.credentials, 'same-origin');
    }
    assert.notEqual(requests[0].url, requests[1].url,
      'the later refresh must also bypass an older worker cache entry');
    assert.equal(sandbox.Notifications.items[0].id, 3);
  });

test('an overlapping ordinary refresh inherits the native freshness floor',
  async () => {
    const requests = [];
    const responses = [];
    const sandbox = {
      console: { warn() {} },
      Date,
      Promise,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      location: { search: '', hash: '' },
      localStorage: { getItem() { return null; }, setItem() {} },
      document: {
        title: 'Social',
        addEventListener() {},
        getElementById() { return null; },
      },
      App: { user: { id: 7 } },
      fetch(url, options) {
        requests.push({ url, options });
        return new Promise((resolve) => responses.push(resolve));
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    runNotifications(sandbox);

    const invalidation = sandbox.Notifications.refreshAfterInvalidation();
    const ordinary = sandbox.Notifications.refresh();
    assert.equal(requests.length, 2);
    for (const request of requests) {
      const url = new URL(request.url, 'https://social.example');
      assert.equal(url.searchParams.get('native_invalidation'), '1');
      assert.ok(url.searchParams.get('native_invalidation_nonce'));
      assert.equal(request.options.cache, 'no-store');
      assert.equal(request.options.credentials, 'same-origin');
    }
    assert.notEqual(requests[0].url, requests[1].url);

    responses[0]({
      ok: true,
      async json() {
        return { notifications: [{ id: 2 }], unread: 1 };
      },
    });
    assert.equal(await invalidation, false,
      'the newer overlapping request owns the authoritative generation');
    responses[1]({
      ok: true,
      async json() {
        return { notifications: [{ id: 3 }], unread: 1 };
      },
    });
    assert.equal(await ordinary, true);
    assert.equal(sandbox.Notifications.items[0].id, 3);
    assert.equal(sandbox.Notifications._networkFreshnessFloor, true);
  });

test('a hung native invalidation fetch aborts so a later retry can run',
  async () => {
    const timers = [];
    const requests = [];
    class FakeAbortController {
      constructor() {
        this.signal = {
          aborted: false,
          listeners: [],
          addEventListener(_type, listener) { this.listeners.push(listener); },
        };
      }
      abort() {
        this.signal.aborted = true;
        for (const listener of this.signal.listeners) listener();
      }
    }
    const sandbox = {
      console: { warn() {} },
      Date,
      Promise,
      URLSearchParams,
      AbortController: FakeAbortController,
      setTimeout(fn) { timers.push(fn); return timers.length; },
      clearTimeout() {},
      location: { search: '', hash: '' },
      localStorage: { getItem() { return null; }, setItem() {} },
      document: {
        title: 'Social',
        addEventListener() {},
        getElementById() { return null; },
      },
      App: { user: { id: 7 } },
      fetch(_url, options) {
        requests.push(options);
        if (requests.length > 1) {
          return Promise.resolve({
            ok: true,
            async json() {
              return { notifications: [{ id: 2 }], unread: 1 };
            },
          });
        }
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    runNotifications(sandbox);

    const first = sandbox.Notifications.refreshAfterInvalidation();
    timers.shift()();
    assert.equal(await first, false);
    assert.equal(await sandbox.Notifications.refreshAfterInvalidation(), true);
    assert.equal(requests.length, 2);
    assert.equal(sandbox.Notifications.items[0].id, 2);
  });

test('a stalled invalidation response body is covered by the same deadline',
  async () => {
    const timers = [];
    let calls = 0;
    class FakeAbortController {
      constructor() {
        this.signal = {
          aborted: false,
          listeners: [],
          addEventListener(_type, listener) {
            if (this.aborted) listener();
            else this.listeners.push(listener);
          },
        };
      }
      abort() {
        this.signal.aborted = true;
        for (const listener of this.signal.listeners) listener();
      }
    }
    const sandbox = {
      console: { warn() {} },
      Date,
      Promise,
      URLSearchParams,
      AbortController: FakeAbortController,
      setTimeout(fn) { timers.push(fn); return timers.length; },
      clearTimeout() {},
      location: { search: '', hash: '' },
      localStorage: { getItem() { return null; }, setItem() {} },
      document: {
        title: 'Social',
        addEventListener() {},
        getElementById() { return null; },
      },
      App: { user: { id: 7 } },
      async fetch(_url, options) {
        calls += 1;
        if (calls > 1) {
          return {
            ok: true,
            async json() { return { notifications: [{ id: 3 }], unread: 1 }; },
          };
        }
        return {
          ok: true,
          json() {
            return new Promise((resolve, reject) => {
              options.signal.addEventListener('abort', () => {
                const error = new Error('aborted body');
                error.name = 'AbortError';
                reject(error);
              });
            });
          },
        };
      },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    runNotifications(sandbox);

    const first = sandbox.Notifications.refreshAfterInvalidation();
    await Promise.resolve();
    timers.shift()();
    assert.equal(await first, false);
    assert.equal(await sandbox.Notifications.refreshAfterInvalidation(), true);
    assert.equal(sandbox.Notifications.items[0].id, 3);
  });

// ── Homescreen icon badge (#1445) ──────────────────────────────────────

const BADGE_CAPS = [...capabilities, 'setSocialBadgeCount'];

test('publishBadgeCount forwards the unread total to a capable build once', async () => {
  const loaded = loadCoordinator({ caps: BADGE_CAPS });

  assert.equal(await loaded.sandbox.SocialPush.publishBadgeCount(3), true);
  // Re-publishing the confirmed value is a no-op, not a second native call.
  assert.equal(await loaded.sandbox.SocialPush.publishBadgeCount(3), true);
  assert.deepEqual(
    loaded.calls.filter(([name]) => name === 'badge'),
    [['badge', 3]]
  );

  // A changed total goes out again.
  await loaded.sandbox.SocialPush.publishBadgeCount(0);
  assert.deepEqual(
    loaded.calls.filter(([name]) => name === 'badge'),
    [['badge', 3], ['badge', 0]]
  );
});

test('publishBadgeCount rejects unusable counts without touching the bridge', async () => {
  const loaded = loadCoordinator({ caps: BADGE_CAPS });

  assert.equal(await loaded.sandbox.SocialPush.publishBadgeCount(-1), false);
  assert.equal(await loaded.sandbox.SocialPush.publishBadgeCount(1.5), false);
  assert.equal(await loaded.sandbox.SocialPush.publishBadgeCount('7'), false);
  assert.equal(loaded.calls.some(([name]) => name === 'badge'), false);
});

test('concurrent publishes coalesce to the latest value', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const loaded = loadCoordinator({
    caps: BADGE_CAPS,
    badgeImpl: () => gate,
  });

  const first = loaded.sandbox.SocialPush.publishBadgeCount(1);
  await settle();
  // A newer total arrives while the first send is in flight.
  const second = loaded.sandbox.SocialPush.publishBadgeCount(5);
  release(true);
  await first;
  await second;
  assert.deepEqual(
    loaded.calls.filter(([name]) => name === 'badge'),
    [['badge', 1], ['badge', 5]],
    'the in-flight value settles, then the coalesced latest goes out'
  );
});

test('the badge capability is NOT required for push support', async () => {
  // An app build without setSocialBadgeCount keeps full push support:
  // isSupported stays true (state reads work) and the badge publish is a
  // quiet no-op rather than an error.
  const loaded = loadCoordinator();

  assert.equal(await loaded.sandbox.SocialPush.isSupported(), true);
  assert.equal(await loaded.sandbox.SocialPush.publishBadgeCount(4), false);
  assert.equal(loaded.calls.some(([name]) => name === 'badge'), false);

  // Same for a mixed cache generation whose bridge predates the wrapper.
  const older = loadCoordinator({ caps: BADGE_CAPS, includeBadgeMethod: false });
  assert.equal(await older.sandbox.SocialPush.publishBadgeCount(4), false);
  assert.equal(older.calls.some(([name]) => name === 'badge'), false);
});

test('a degraded capability probe is retried, never latched as unsupported', async () => {
  let degraded = true;
  const loaded = loadCoordinator({
    caps: BADGE_CAPS,
    getInfoImpl: () => (degraded
      ? { version: 0, capabilities: [], degraded: true }
      : { version: 4, capabilities: BADGE_CAPS }),
  });

  assert.equal(await loaded.sandbox.SocialPush.publishBadgeCount(2), false);
  assert.equal(loaded.calls.some(([name]) => name === 'badge'), false);

  degraded = false;
  assert.equal(await loaded.sandbox.SocialPush.publishBadgeCount(2), true);
  assert.deepEqual(
    loaded.calls.filter(([name]) => name === 'badge'),
    [['badge', 2]]
  );
});

test('publishes wait for session admission and replay when it arrives', async () => {
  let admitted = false;
  const loaded = loadCoordinator({
    caps: BADGE_CAPS,
    isSessionAdmittedImpl: () => admitted,
  });

  assert.equal(await loaded.sandbox.SocialPush.publishBadgeCount(6), false);
  assert.equal(loaded.calls.some(([name]) => name === 'badge'), false);

  admitted = true;
  loaded.fire('usernode:native-session-admission', { admitted: true });
  await settle();
  assert.deepEqual(
    loaded.calls.filter(([name]) => name === 'badge'),
    [['badge', 6]],
    'the remembered count goes out once the session is admitted'
  );
});

test('a new admission republishes the remembered count over replayed state', async () => {
  const loaded = loadCoordinator({ caps: BADGE_CAPS });

  await loaded.sandbox.SocialPush.publishBadgeCount(9);
  loaded.fire('usernode:native-session-admission', { admitted: true });
  await settle();
  assert.deepEqual(
    loaded.calls.filter(([name]) => name === 'badge'),
    [['badge', 9], ['badge', 9]],
    'the confirmation is forgotten, so the same count is re-applied'
  );
});

test('a badge send failure warns and leaves the count retryable', async () => {
  let fail = true;
  const loaded = loadCoordinator({
    caps: BADGE_CAPS,
    badgeImpl: () => {
      if (fail) throw new Error('bridge hiccup');
      return true;
    },
  });

  assert.equal(await loaded.sandbox.SocialPush.publishBadgeCount(8), false);
  fail = false;
  assert.equal(await loaded.sandbox.SocialPush.publishBadgeCount(8), true);
  assert.deepEqual(
    loaded.calls.filter(([name]) => name === 'badge'),
    [['badge', 8], ['badge', 8]],
    'a failed send is not remembered as applied'
  );
});

// ── #2904: the icon badge is reconciled when the app returns ────────────
//
// While the WebView was suspended, alert pushes moved the iOS icon via their
// own `aps.badge`. The realm's remembered confirmation then no longer
// describes the icon, so coming back must resend even an unchanged total.

test('foregrounding re-reads the feed and resends an unchanged count', async () => {
  const loaded = loadCoordinator({
    caps: BADGE_CAPS,
    // The refreshed feed says zero — as the bell does — and publishes it.
    refreshImpl: () => loaded.sandbox.SocialPush.publishBadgeCount(0).then(() => true),
  });

  await loaded.sandbox.SocialPush.publishBadgeCount(0);
  assert.deepEqual(loaded.calls.filter(([name]) => name === 'badge'), [['badge', 0]]);

  // Two pushes arrive in the background (the icon now reads 2), the user
  // reads them elsewhere, and reopens the app.
  loaded.fireDocument('visibilitychange');
  await settle();
  await settle();
  assert.ok(loaded.calls.some(([name]) => name === 'refresh'),
    'the foreground reads a fresh count from the network');
  assert.deepEqual(
    loaded.calls.filter(([name]) => name === 'badge'),
    [['badge', 0], ['badge', 0]],
    'the unchanged zero is sent again so it overwrites the pushed badge'
  );
});

test('a failed foreground refresh still resends the remembered count', async () => {
  const loaded = loadCoordinator({ caps: BADGE_CAPS, refreshImpl: () => false });

  await loaded.sandbox.SocialPush.publishBadgeCount(1);
  loaded.fireDocument('visibilitychange');
  await settle();
  await settle();
  assert.deepEqual(
    loaded.calls.filter(([name]) => name === 'badge'),
    [['badge', 1], ['badge', 1]]
  );
});

test('a hidden transition and a non-native page leave the badge alone', async () => {
  const loaded = loadCoordinator({ caps: BADGE_CAPS });
  await loaded.sandbox.SocialPush.publishBadgeCount(2);

  loaded.sandbox.document.visibilityState = 'hidden';
  loaded.fireDocument('visibilitychange');
  await settle();
  loaded.sandbox.document.visibilityState = 'visible';
  loaded.sandbox.usernode.isNative = false;
  loaded.fireDocument('visibilitychange');
  await settle();
  assert.equal(loaded.calls.some(([name]) => name === 'refresh'), false);
  assert.deepEqual(loaded.calls.filter(([name]) => name === 'badge'), [['badge', 2]]);
});
