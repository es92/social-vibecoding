// Native Social activity-notification coordinator.
//
// Firebase payloads are deliberately content-free. The mobile shell exposes
// one opaque notification id only after its normal bridge-v4 session
// admission; this module resolves it through the authenticated Social API and
// reuses the existing notification router.
(function () {
  'use strict';

  // Native's mixed-cache fallback probes this marker, not merely the bridge
  // method: /usernode-bridge.js and this coordinator can be restored from
  // different service-worker cache generations. Only this script promises it
  // will actually send the explicit readiness handshake below.
  window.__usernodeExplicitReadinessClient = !!(
    window.usernode &&
    typeof window.usernode.markPrivilegedBridgeReady === 'function'
  );

  const REQUIRED_CAPABILITIES = [
    'getSocialPushState',
    'setSocialPushEnabled',
    'claimPendingSocialNotification',
    'ackPendingSocialNotification',
  ];
  const NATIVE_INVALIDATION_REFRESH_VERSION = 1;
  const FOREGROUND_INVALIDATION_STORAGE_KEY =
    'social_push_foreground_invalidation_v1';

  function readPersistedForegroundInvalidation() {
    try {
      const token = window.localStorage.getItem(
        FOREGROUND_INVALIDATION_STORAGE_KEY
      );
      return {
        available: true,
        token: typeof token === 'string' && token ? token : null,
      };
    } catch {
      return { available: false, token: null };
    }
  }

  function newForegroundInvalidationToken() {
    if (typeof crypto !== 'undefined' &&
        typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `${Date.now().toString(36)}-` +
      `${Math.random().toString(36).slice(2)}-` +
      Math.random().toString(36).slice(2);
  }

  function persistForegroundInvalidation(token) {
    try {
      window.localStorage.setItem(FOREGROUND_INVALIDATION_STORAGE_KEY, token);
      const stored = readPersistedForegroundInvalidation();
      return stored.available && stored.token === token;
    } catch {
      // Storage may be unavailable. The in-memory retry path remains active.
      return false;
    }
  }

  function clearOwnedForegroundInvalidation(expectedToken, wasPersisted) {
    const current = readPersistedForegroundInvalidation();
    // A blocked or broken storage backend cannot coordinate realms. The
    // current realm's exact-generation fetch still settles its in-memory
    // invalidation; BFCache restores independently force another refresh.
    if (!current.available) {
      return { cleared: true, currentToken: null };
    }
    // A token that never persisted is owned only by this realm. Preserve a
    // different durable token if another realm managed to publish one.
    if (!wasPersisted && current.token === null) {
      return { cleared: true, currentToken: null };
    }
    if (current.token !== expectedToken) {
      return { cleared: false, currentToken: current.token };
    }
    try {
      window.localStorage.removeItem(FOREGROUND_INVALIDATION_STORAGE_KEY);
      return { cleared: true, currentToken: null };
    } catch {
      // The exact token was ours when read. Leaving a redundant durable token
      // is safer than repeatedly refetching in a tight loop.
      return { cleared: true, currentToken: null };
    }
  }
  const persistedForegroundState = readPersistedForegroundInvalidation();
  const persistedForegroundToken = persistedForegroundState.token;

  const SocialPush = {
    _supportPromise: null,
    _supported: false,
    _state: null,
    _stateReadPromise: null,
    _stateReadGeneration: -1,
    _stateRerunGeneration: -1,
    _admissionGeneration: 0,
    _drainPromise: null,
    _drainRerunRequested: false,
    _tapRetryTimer: null,
    _tapRetryAttempt: 0,
    _foregroundInvalidationDirty: persistedForegroundToken !== null,
    _foregroundInvalidationToken: persistedForegroundToken,
    _foregroundInvalidationPersisted: persistedForegroundToken !== null,
    _foregroundInvalidationGeneration:
      persistedForegroundToken !== null ? 1 : 0,
    _foregroundRefreshPromise: null,
    _foregroundRetryTimer: null,
    _foregroundRetryAttempt: 0,
    _foregroundPageActive: true,
    _foregroundLifecycleEpoch: 0,
    _foregroundRestoreRefreshRequired: false,

    _sessionAdmitted() {
      return !window.NativeChrome ||
        typeof NativeChrome.isSessionAdmitted !== 'function' ||
        NativeChrome.isSessionAdmitted();
    },

    async isSupported() {
      if (SocialPush._supportPromise) return SocialPush._supportPromise;
      let conclusive = false;
      const probe = (async () => {
        if (!window.usernode || window.usernode.isNative !== true ||
            !window.NativeChrome) {
          conclusive = true;
          return false;
        }
        const info = await NativeChrome.getInfo();
        if (info && info.degraded === true) {
          throw new Error('Native bridge capability probe was inconclusive');
        }
        const capabilities = Array.isArray(info && info.capabilities)
          ? info.capabilities
          : [];
        const supported = REQUIRED_CAPABILITIES.every((name) =>
          capabilities.includes(name) && typeof window.usernode[name] === 'function'
        );
        conclusive = true;
        SocialPush._supported = supported;
        return supported;
      })();
      const tracked = probe.catch(() => false).then((supported) => {
        // A rejection/degraded probe is inconclusive and must remain
        // retryable; conclusive supported/unsupported results stay cached.
        if (!conclusive && SocialPush._supportPromise === tracked) {
          SocialPush._supportPromise = null;
        }
        return supported;
      });
      SocialPush._supportPromise = tracked;
      return tracked;
    },

    _normalizeState(value) {
      if (!value || typeof value !== 'object' ||
          typeof value.enabled !== 'boolean' ||
          typeof value.permissionStatus !== 'string' ||
          typeof value.registrationStatus !== 'string' ||
          typeof value.deliveryActive !== 'boolean') return null;
      return {
        enabled: value.enabled,
        permissionStatus: value.permissionStatus,
        registrationStatus: value.registrationStatus,
        deliveryActive: value.deliveryActive,
      };
    },

    _applyState(value) {
      const state = SocialPush._normalizeState(value);
      if (!state) return null;
      SocialPush._state = state;
      if (window.DevAlerts &&
          typeof DevAlerts.setRemoteDeliveryActive === 'function') {
        DevAlerts.setRemoteDeliveryActive(state.deliveryActive);
      }
      window.dispatchEvent(new CustomEvent('usernode:social-push-state', {
        detail: state,
      }));
      return state;
    },

    _clearState() {
      SocialPush._state = null;
      if (window.DevAlerts &&
          typeof DevAlerts.setRemoteDeliveryActive === 'function') {
        DevAlerts.setRemoteDeliveryActive(false);
      }
    },

    getState(options) {
      const refresh = !options || options.refresh !== false;
      const generation = SocialPush._admissionGeneration;
      if (!SocialPush._sessionAdmitted()) {
        SocialPush._clearState();
        return Promise.resolve(null);
      }
      if (!refresh && SocialPush._state) return SocialPush._state;
      if (SocialPush._stateReadPromise &&
          SocialPush._stateReadGeneration === generation) {
        return SocialPush._stateReadPromise;
      }
      const read = (async () => {
        if (!await SocialPush.isSupported()) return null;
        try {
          const value = await window.usernode.getSocialPushState();
          return generation === SocialPush._admissionGeneration
            ? SocialPush._applyState(value)
            : SocialPush._state;
        } catch (err) {
          console.warn('[social-push] state read failed:',
            err && err.message ? err.message : err);
          return SocialPush._state;
        }
      })();
      const tracked = read.finally(() => {
        if (SocialPush._stateReadPromise === tracked) {
          const rerun = SocialPush._stateRerunGeneration === generation &&
            SocialPush._admissionGeneration === generation;
          SocialPush._stateReadPromise = null;
          SocialPush._stateReadGeneration = -1;
          if (SocialPush._stateRerunGeneration === generation) {
            SocialPush._stateRerunGeneration = -1;
          }
          if (rerun) SocialPush.getState();
        }
      });
      SocialPush._stateReadPromise = tracked;
      SocialPush._stateReadGeneration = generation;
      return tracked;
    },

    _refreshFromNativeInvalidation() {
      const generation = SocialPush._admissionGeneration;
      if (SocialPush._stateReadPromise &&
          SocialPush._stateReadGeneration === generation) {
        // The active read may already have captured the state that was just
        // invalidated. Coalesce repeated events, but always run once more
        // after that older snapshot settles.
        SocialPush._stateRerunGeneration = generation;
        return SocialPush._stateReadPromise;
      }
      return SocialPush.getState();
    },

    async setEnabled(enabled) {
      if (!await SocialPush.isSupported()) {
        throw new Error('Activity notifications are not supported by this app build');
      }
      if (!SocialPush._sessionAdmitted()) {
        throw new Error('Secure app sign-in is still finishing. Try again shortly');
      }
      const generation = SocialPush._admissionGeneration;
      const value = await window.usernode.setSocialPushEnabled(enabled === true);
      if (generation !== SocialPush._admissionGeneration) {
        throw new Error('The native session changed while updating notifications');
      }
      const state = SocialPush._applyState(value);
      if (!state) throw new Error('The app returned an invalid notification state');
      return state;
    },

    // ── Homescreen icon badge (#1445) ──────────────────────────────────
    //
    // Notifications._publishAppBadge hands the server's unread total here;
    // this module forwards it to the native shell's setSocialBadgeCount so
    // the OS app icon badge tracks the bell. Deliberately NOT part of
    // REQUIRED_CAPABILITIES: an app build without the capability must keep
    // full push support, so the badge has its own probe. Same probe rules
    // as isSupported — a degraded getBridgeInfo is inconclusive and must
    // stay retryable, never latched as "unsupported".
    _badgeSupportPromise: null,
    _badgeCount: null,          // latest count handed to publishBadgeCount
    _badgePublishedCount: null, // last count native confirmed applying
    _badgePublishPromise: null,
    _badgePublishRerun: false,

    async _badgeSupported() {
      if (SocialPush._badgeSupportPromise) return SocialPush._badgeSupportPromise;
      let conclusive = false;
      const probe = (async () => {
        if (!window.usernode || window.usernode.isNative !== true ||
            !window.NativeChrome ||
            typeof window.usernode.setSocialBadgeCount !== 'function') {
          conclusive = true;
          return false;
        }
        const info = await NativeChrome.getInfo();
        if (info && info.degraded === true) {
          throw new Error('Native bridge capability probe was inconclusive');
        }
        conclusive = true;
        const capabilities = Array.isArray(info && info.capabilities)
          ? info.capabilities
          : [];
        return capabilities.includes('setSocialBadgeCount');
      })();
      const tracked = probe.catch(() => false).then((supported) => {
        if (!conclusive && SocialPush._badgeSupportPromise === tracked) {
          SocialPush._badgeSupportPromise = null;
        }
        return supported;
      });
      SocialPush._badgeSupportPromise = tracked;
      return tracked;
    },

    // The one entry point: remember the latest count and (when the native
    // session is admitted and the build supports it) push it across the
    // bridge. Concurrent calls coalesce to the latest value; failures warn
    // and never throw into the caller's render path.
    publishBadgeCount(count) {
      if (!Number.isSafeInteger(count) || count < 0) return Promise.resolve(false);
      SocialPush._badgeCount = count;
      return SocialPush._runBadgePublish();
    },

    _runBadgePublish() {
      if (SocialPush._badgePublishPromise) {
        SocialPush._badgePublishRerun = true;
        return SocialPush._badgePublishPromise;
      }
      const run = (async () => {
        let applied = false;
        do {
          SocialPush._badgePublishRerun = false;
          applied = await SocialPush._badgePublishOnce();
        } while (SocialPush._badgePublishRerun);
        return applied;
      })();
      SocialPush._badgePublishPromise = run.finally(() => {
        SocialPush._badgePublishPromise = null;
        SocialPush._badgePublishRerun = false;
      });
      return SocialPush._badgePublishPromise;
    },

    async _badgePublishOnce() {
      const value = SocialPush._badgeCount;
      if (value === null) return false;
      if (!SocialPush._sessionAdmitted()) return false;
      if (!await SocialPush._badgeSupported()) return false;
      // Admission may have flipped while the probe was in flight; the
      // admission listener republishes, so skipping here loses nothing.
      if (!SocialPush._sessionAdmitted()) return false;
      if (SocialPush._badgePublishedCount === value) return true;
      try {
        await window.usernode.setSocialBadgeCount(value);
        // Remember only the value actually sent — a newer count arriving
        // mid-flight sets the rerun flag and goes out on the next lap.
        SocialPush._badgePublishedCount = value;
        return true;
      } catch (err) {
        console.warn('[social-push] badge publish failed:',
          err && err.message ? err.message : err);
        return false;
      }
    },

    // Native state can move underneath a remembered publish (a new session
    // admission replays state; a BFCache restore may resume a realm another
    // realm badged over). Forget what was confirmed and send the remembered
    // count again.
    _republishBadge() {
      SocialPush._badgePublishedCount = null;
      if (SocialPush._badgeCount === null) return Promise.resolve(false);
      return SocialPush._runBadgePublish();
    },

    _notificationId(value) {
      const id = value && value.notificationId;
      return Number.isSafeInteger(id) && id > 0 && id <= 2147483647
        ? id
        : null;
    },

    async _drainOnce() {
      const generation = SocialPush._admissionGeneration;
      const currentSession = () => generation === SocialPush._admissionGeneration &&
        SocialPush._sessionAdmitted();
      if (!window.App || !App.user || !window.Notifications ||
          !SocialPush._foregroundPageActive || !currentSession() ||
          !await SocialPush.isSupported()) return false;
      if (!currentSession()) return false;
      const claim = await window.usernode.claimPendingSocialNotification();
      if (!currentSession()) return false;
      if (claim == null) return true;
      const notificationId = SocialPush._notificationId(claim);
      if (notificationId == null) return false;
      const opened = await Notifications.openById(notificationId);
      if (!opened || !currentSession()) return false;
      return await window.usernode.ackPendingSocialNotification(
        notificationId
      ) === true;
    },

    _clearTapRetry() {
      if (SocialPush._tapRetryTimer) clearTimeout(SocialPush._tapRetryTimer);
      SocialPush._tapRetryTimer = null;
    },

    _scheduleTapRetry() {
      const delays = [500, 2000, 5000, 15000, 30000];
      if (!SocialPush._foregroundPageActive || !SocialPush._supported ||
          !SocialPush._sessionAdmitted() || SocialPush._tapRetryTimer ||
          SocialPush._tapRetryAttempt >= delays.length) return;
      const delay = delays[SocialPush._tapRetryAttempt++];
      SocialPush._tapRetryTimer = setTimeout(() => {
        SocialPush._tapRetryTimer = null;
        SocialPush.drainPending({ retry: true });
      }, delay);
    },

    drainPending({ retry = false } = {}) {
      if (!retry) {
        SocialPush._clearTapRetry();
        SocialPush._tapRetryAttempt = 0;
      }
      if (SocialPush._drainPromise) {
        SocialPush._drainRerunRequested = true;
        return SocialPush._drainPromise;
      }
      const run = (async () => {
        let result = false;
        do {
          SocialPush._drainRerunRequested = false;
          try {
            result = await SocialPush._drainOnce();
          } catch (err) {
            console.warn('[social-push] pending notification failed:',
              err && err.message ? err.message : err);
            result = false;
          }
        } while (SocialPush._drainRerunRequested);
        return result;
      })();
      SocialPush._drainPromise = run.then((result) => {
        SocialPush._drainPromise = null;
        SocialPush._drainRerunRequested = false;
        if (!result) SocialPush._scheduleTapRetry();
        return result;
      });
      return SocialPush._drainPromise;
    },

    _clearForegroundRetryTimer() {
      if (!SocialPush._foregroundRetryTimer) return;
      clearTimeout(SocialPush._foregroundRetryTimer);
      SocialPush._foregroundRetryTimer = null;
    },

    _scheduleForegroundRetry() {
      if (!SocialPush._foregroundPageActive ||
          !SocialPush._foregroundInvalidationDirty ||
          SocialPush._foregroundRetryTimer ||
          SocialPush._foregroundRefreshPromise) return;
      const delays = [500, 2000, 5000, 15000, 30000];
      const delay = delays[Math.min(
        SocialPush._foregroundRetryAttempt, delays.length - 1
      )];
      SocialPush._foregroundRetryAttempt += 1;
      SocialPush._foregroundRetryTimer = setTimeout(() => {
        SocialPush._foregroundRetryTimer = null;
        SocialPush._runForegroundRefresh();
      }, delay);
    },

    _runForegroundRefresh() {
      if (!SocialPush._foregroundInvalidationDirty) {
        return Promise.resolve(true);
      }
      if (!SocialPush._foregroundPageActive) return Promise.resolve(false);
      if (SocialPush._foregroundRefreshPromise) {
        return SocialPush._foregroundRefreshPromise;
      }
      const generation = SocialPush._foregroundInvalidationGeneration;
      const invalidationToken = SocialPush._foregroundInvalidationToken;
      const invalidationPersisted =
        SocialPush._foregroundInvalidationPersisted;
      const lifecycleEpoch = SocialPush._foregroundLifecycleEpoch;
      let attempted = false;
      const refresh = (async () => {
        if (!window.App || !App.user || !window.Notifications ||
            !SocialPush._sessionAdmitted()) return false;
        // The foreground event is itself the content-free invalidation signal.
        // Refreshing the authenticated inbox needs no native push read/action
        // capability, which also keeps mixed cached bridge versions working.
        try {
          // The React shell bundle is cached independently from this classic
          // coordinator. Its previous implementation returned true even when
          // an ordinary cacheable refresh failed. Keep the native invalidation
          // dirty until a bundle advertising the reliable contract is active.
          if (Notifications.nativeInvalidationRefreshVersion !==
              NATIVE_INVALIDATION_REFRESH_VERSION) return false;
          attempted = true;
          return await Notifications.refreshAfterInvalidation() === true;
        } catch (err) {
          console.warn('[social-push] foreground refresh failed:',
            err && err.message ? err.message : err);
          return false;
        }
      })();
      const tracked = refresh.then((refreshed) => {
        if (refreshed && SocialPush._foregroundPageActive &&
            lifecycleEpoch === SocialPush._foregroundLifecycleEpoch &&
            generation === SocialPush._foregroundInvalidationGeneration) {
          const ownership = clearOwnedForegroundInvalidation(
            invalidationToken,
            invalidationPersisted
          );
          if (ownership.cleared) {
            SocialPush._foregroundInvalidationDirty = false;
            SocialPush._foregroundInvalidationToken = null;
            SocialPush._foregroundInvalidationPersisted = false;
            SocialPush._foregroundRetryAttempt = 0;
            SocialPush._clearForegroundRetryTimer();
          } else {
            // Another realm either replaced or consumed the captured token.
            // This realm's rendered inbox is not thereby fresh. Adopt the
            // newer token, or mint recovery ownership when it was consumed,
            // and force a trailing network read in this realm.
            const recoveryToken = ownership.currentToken ||
              newForegroundInvalidationToken();
            SocialPush._foregroundInvalidationDirty = true;
            SocialPush._foregroundInvalidationToken = recoveryToken;
            SocialPush._foregroundInvalidationGeneration += 1;
            SocialPush._foregroundInvalidationPersisted =
              ownership.currentToken !== null ||
              persistForegroundInvalidation(recoveryToken);
          }
        }
        return refreshed;
      }).finally(() => {
        if (SocialPush._foregroundRefreshPromise !== tracked) return;
        SocialPush._foregroundRefreshPromise = null;
        if (!SocialPush._foregroundInvalidationDirty ||
            !SocialPush._foregroundPageActive) return;
        if (generation !== SocialPush._foregroundInvalidationGeneration ||
            lifecycleEpoch !== SocialPush._foregroundLifecycleEpoch) {
          // A newer native invalidation or a pagehide/pageshow boundary arrived
          // after this fetch began. Run a current-epoch trailing fetch so the
          // older response cannot consume newer work.
          Promise.resolve().then(() => SocialPush._runForegroundRefresh());
        } else if (attempted) {
          SocialPush._scheduleForegroundRetry();
        }
      });
      SocialPush._foregroundRefreshPromise = tracked;
      return tracked;
    },

    refreshAfterForegroundPush() {
      const token = newForegroundInvalidationToken();
      SocialPush._foregroundInvalidationDirty = true;
      SocialPush._foregroundInvalidationToken = token;
      SocialPush._foregroundInvalidationPersisted =
        persistForegroundInvalidation(token);
      SocialPush._foregroundInvalidationGeneration += 1;
      SocialPush._clearForegroundRetryTimer();
      return SocialPush._runForegroundRefresh();
    },

    retryForegroundInvalidation() {
      if (!SocialPush._foregroundInvalidationDirty) return Promise.resolve(true);
      SocialPush._clearForegroundRetryTimer();
      return SocialPush._runForegroundRefresh();
    },

    async init() {
      // A mixed cached shell cannot upgrade its already-evaluated Notifications
      // object in place. The content-free dirty bit therefore survives the
      // reload/app restart that obtains the current shell bundle, and is
      // retried before native capability discovery.
      await SocialPush.retryForegroundInvalidation();
      if (!await SocialPush.isSupported()) return;
      await SocialPush.getState();
      await SocialPush.drainPending();
    },
  };

  // Install listeners immediately so an event arriving while the remaining
  // page scripts initialize is retained by the async coordinator call.
  window.addEventListener('usernode:social-push-pending', () => {
    SocialPush.drainPending();
  });
  document.addEventListener('sv:authed', () => {
    SocialPush.drainPending();
  });
  window.addEventListener('usernode:social-push-foreground', () => {
    SocialPush.refreshAfterForegroundPush();
  });
  // A tap remains in native storage until exact Social routing succeeds.
  // Retry it when an offline launch regains connectivity.
  window.addEventListener('online', () => {
    SocialPush.drainPending();
    SocialPush.retryForegroundInvalidation();
  });
  // The native shell refreshes registration/delivery status when it resumes.
  // Treat its state event as an invalidation and read through the admitted
  // bridge instead of trusting event payloads from page JavaScript.
  window.addEventListener('usernode:social-push-native-state-changed', () => {
    SocialPush._refreshFromNativeInvalidation();
  });
  window.addEventListener('usernode:native-session-admission', (event) => {
    SocialPush._admissionGeneration += 1;
    SocialPush._stateRerunGeneration = -1;
    // Either way the admitted realm's badge confirmation is stale: a new
    // admission replays native state, and a refusal means the next admitted
    // session must not trust what this one published.
    SocialPush._badgePublishedCount = null;
    if (!event || !event.detail || event.detail.admitted !== true) {
      SocialPush._clearState();
      SocialPush._clearTapRetry();
      return;
    }
    SocialPush.getState();
    SocialPush.drainPending();
    SocialPush.retryForegroundInvalidation();
    SocialPush._republishBadge();
  });
  // Native state must not be replayed until both the classic scripts and the
  // deferred React shell have installed their listeners. DOMContentLoaded is
  // the first ordering point after both; native then binds the acknowledgement
  // to this exact realm instead of inferring readiness from WebView callbacks.
  let bridgeReady = false;
  let bridgeReadyInFlight = false;
  let bridgePageActive = true;
  let bridgeReadyTimer = null;
  let bridgeReadyAttempt = 0;
  let bridgeReadyGaveUp = false;
  let bridgeReadyLastError = null;
  const bridgeReadyRetryMs = [100, 500, 2000, 5000, 15000, 30000];
  // The backoff table is the WHOLE budget, not a floor to clamp to. It used
  // to clamp the index and retry every 30 s for the life of the document,
  // so a device whose privileged handshake was refused reissued a call it
  // could never win, forever, while telling the user nothing. Stop after
  // the table is spent, remember why, and wait for a real signal — a
  // pageshow, a native auth-status of "ready", or the user pressing Try
  // again in Settings → Homeroom app — before spending it again.
  const bridgeReadyMaxAttempts = bridgeReadyRetryMs.length;

  function resetBridgeReadyBackoff() {
    bridgeReadyAttempt = 0;
    bridgeReadyGaveUp = false;
    if (bridgeReadyTimer) clearTimeout(bridgeReadyTimer);
    bridgeReadyTimer = null;
  }

  function announceBridgeReady() {
    if (!bridgePageActive || bridgeReady || bridgeReadyInFlight ||
        bridgeReadyGaveUp || bridgeReadyTimer || !window.usernode ||
        window.usernode.isNative !== true ||
        typeof window.usernode.markPrivilegedBridgeReady !== 'function') {
      return;
    }
    bridgeReadyInFlight = true;
    window.usernode.markPrivilegedBridgeReady().then((result) => {
      if (!bridgePageActive) return;
      bridgeReadyLastError = null;
      bridgeReadyGaveUp = false;
      bridgeReadyAttempt = 0;
      if (result && result.ready === true) {
        bridgeReady = true;
        return;
      }
      // A conclusive unsupported result belongs to an older app build.
      bridgeReady = true;
    }).catch((err) => {
      if (!bridgePageActive) return;
      console.warn('[social-push] native bridge readiness failed:',
        err && err.message ? err.message : err);
      bridgeReadyLastError = (err && err.message) ? String(err.message) : null;
      if (bridgeReadyAttempt >= bridgeReadyMaxAttempts - 1) {
        bridgeReadyGaveUp = true;
        console.warn('[social-push] giving up on native bridge readiness ' +
          `after ${bridgeReadyMaxAttempts} attempts`);
        return;
      }
      const delay = bridgeReadyRetryMs[bridgeReadyAttempt];
      bridgeReadyAttempt += 1;
      bridgeReadyTimer = setTimeout(() => {
        bridgeReadyTimer = null;
        announceBridgeReady();
      }, delay);
    }).finally(() => {
      bridgeReadyInFlight = false;
      if (bridgePageActive && !bridgeReady && !bridgeReadyGaveUp &&
          !bridgeReadyTimer) {
        announceBridgeReady();
      }
    });
  }

  // What the readiness handshake is doing, for the Settings diagnostics
  // panel. Read-only: { ready, attempts, exhausted, pending, lastError }.
  SocialPush.readinessState = function readinessState() {
    return {
      ready: bridgeReady,
      attempts: bridgeReadyAttempt,
      exhausted: bridgeReadyGaveUp,
      pending: bridgeReadyInFlight || bridgeReadyTimer !== null,
      lastError: bridgeReadyLastError,
    };
  };

  // The user-driven half of the cap above: spend a fresh budget now.
  SocialPush.retryBridgeReadiness = function retryBridgeReadiness() {
    resetBridgeReadyBackoff();
    announceBridgeReady();
    return SocialPush.readinessState();
  };

  window.addEventListener('pagehide', () => {
    SocialPush._foregroundPageActive = false;
    SocialPush._clearTapRetry();
    SocialPush._foregroundLifecycleEpoch += 1;
    // If this realm is later restored from BFCache, another realm may have
    // received and already consumed a shared invalidation while this UI was
    // frozen. A current-realm network read is the only reliable reconciliation
    // even when localStorage no longer contains a token.
    SocialPush._foregroundRestoreRefreshRequired = true;
    SocialPush._clearForegroundRetryTimer();
    bridgePageActive = false;
    // A BFCache restore resumes this same realm, but native may have admitted
    // another realm while it was away. Re-announce on pageshow so readiness is
    // rebound even though the per-realm capability itself remains valid.
    bridgeReady = false;
    resetBridgeReadyBackoff();
  });
  window.addEventListener('pageshow', () => {
    SocialPush._foregroundPageActive = true;
    if (SocialPush._foregroundInvalidationDirty ||
        SocialPush._foregroundRestoreRefreshRequired) {
      const persisted = readPersistedForegroundInvalidation();
      const persistedToken = persisted.token;
      const recoveryToken = persistedToken ||
        newForegroundInvalidationToken();
      SocialPush._foregroundInvalidationDirty = true;
      if (recoveryToken !== SocialPush._foregroundInvalidationToken) {
        SocialPush._foregroundInvalidationToken = recoveryToken;
        SocialPush._foregroundInvalidationGeneration += 1;
      }
      SocialPush._foregroundInvalidationPersisted = persistedToken !== null ||
        persistForegroundInvalidation(recoveryToken);
    }
    SocialPush._foregroundRestoreRefreshRequired = false;
    bridgePageActive = true;
    resetBridgeReadyBackoff();
    SocialPush.retryForegroundInvalidation();
    SocialPush.drainPending();
    // A restored realm cannot trust its pre-freeze badge confirmation —
    // another realm may have badged over it while this one was away.
    SocialPush._republishBadge();
    announceBridgeReady();
  });
  // The app reaching "ready" is the one signal that says the thing we were
  // failing against now exists, so it re-arms the spent budget too.
  window.addEventListener('usernode:auth-status', (event) => {
    if (!event || !event.detail || event.detail.phase !== 'ready') return;
    if (bridgeReady || !bridgeReadyGaveUp) return;
    resetBridgeReadyBackoff();
    announceBridgeReady();
  });
  document.addEventListener('DOMContentLoaded', () => {
    SocialPush.init();
    announceBridgeReady();
  });

  window.SocialPush = SocialPush;
})();
