// Dev-chat completion alerts (#138).
//
// Two delivery channels layered on top of the existing #161 completion
// pipeline (session_done / auto_solve_done) — no new server-side trigger:
//
//   document.visibilityState === 'visible'  → play a synthesized Web Audio
//                                              chime ("you're in the app").
//   document.visibilityState === 'hidden'   → fire a system notification
//                                              ("app is backgrounded").
//
// The split keys off visibilityState, NOT DevChat._userIsAway(): a merely
// blurred-but-visible window still counts as "in the app" and should chime.
//
// Everything is gated on the single "Dev-chat sound & alerts" preference
// (localStorage, default ON). The AudioContext and the browser Notification
// permission are both unlocked LAZILY on a user gesture (first dev-chat
// send, or the Settings toggle / test button) — never at page load — to
// satisfy browser autoplay + permission-prompt policies.
//
// There is intentionally no service worker / web-push here (none exists in
// this repo): browser notifications fire from the live page and so only
// reach a backgrounded-but-alive tab. Closed mobile-app delivery uses the
// server's Firebase outbox; the notify bridge is a legacy live-page fallback.

(function () {
  'use strict';

  // Default ON: only the explicit string '0' disables. An absent key (the
  // common case) and any legacy value both read as enabled.
  const PREF_KEY = 'devchat_alerts_enabled';

  // Suppress a second tone within this window so the _finishStreaming()
  // chime and an incoming notification_new chime for the SAME turn can't
  // double up (see Notifications.handleIncoming + DevChat._finishStreaming).
  const TONE_DEDUP_MS = 1000;

  const DevAlerts = {
    _audioCtx: null,
    _lastToneAt: 0,
    _remoteDeliveryActive: false,

    setRemoteDeliveryActive(active) {
      DevAlerts._remoteDeliveryActive = active === true;
    },

    enabled() {
      try {
        return localStorage.getItem(PREF_KEY) !== '0';
      } catch {
        return true;
      }
    },

    setEnabled(on) {
      try {
        localStorage.setItem(PREF_KEY, on ? '1' : '0');
      } catch { /* storage may be unavailable; non-fatal */ }
    },

    _isNative() {
      return !!(window.usernode && window.usernode.isNative);
    },

    // Lazily create/resume the shared AudioContext. MUST first be called
    // from inside a user-gesture handler — browsers start the context
    // 'suspended' and only a gesture-scoped resume() unlocks it. Safe to
    // call repeatedly (idempotent).
    _unlockAudio() {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!DevAlerts._audioCtx) DevAlerts._audioCtx = new Ctx();
        if (DevAlerts._audioCtx.state === 'suspended') {
          DevAlerts._audioCtx.resume().catch(() => {});
        }
      } catch { /* no audio support; non-fatal */ }
    },

    // Soft, bell-like "ding" via OscillatorNodes — a single struck-bell
    // strike, no bundled audio asset. A fundamental sine plus two quieter
    // inharmonic partials, each with a fast attack and a long exponential
    // decay (the ring-out that makes it read as a bell rather than a beep).
    // No-op when the pref is off, audio is unsupported / still locked, or
    // another tone played within TONE_DEDUP_MS.
    playDoneTone() {
      if (!DevAlerts.enabled()) return;
      const ctx = DevAlerts._audioCtx;
      if (!ctx || ctx.state !== 'running') return;
      const now = Date.now();
      if (now - DevAlerts._lastToneAt < TONE_DEDUP_MS) return;
      DevAlerts._lastToneAt = now;
      try {
        const t0 = ctx.currentTime;
        const fundamental = 740; // ~F#5 — gentle, mid-bright
        // ratio = inharmonic partial multiplier; peak = its peak gain;
        // decay = seconds to ring out. Higher partials are quieter and
        // decay faster, which is what gives a metallic bell timbre.
        const partials = [
          { ratio: 1.0, peak: 0.12, decay: 1.1 },
          { ratio: 2.0, peak: 0.05, decay: 0.7 },
          { ratio: 3.01, peak: 0.03, decay: 0.5 },
        ];
        const attack = 0.005;
        for (const p of partials) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = fundamental * p.ratio;
          gain.gain.setValueAtTime(0.0001, t0);
          gain.gain.exponentialRampToValueAtTime(p.peak, t0 + attack);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + p.decay);
          osc.connect(gain).connect(ctx.destination);
          osc.start(t0);
          osc.stop(t0 + p.decay + 0.02);
        }
      } catch { /* best-effort */ }
    },

    // Lazily ask for OS-notification permission. Browser only — the native
    // host owns its own permission model. Never called at page load; the
    // call sites are user gestures (first send / Settings toggle / test).
    requestNotifyPermission() {
      if (DevAlerts._isNative()) return;
      try {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission === 'default') {
          Notification.requestPermission().catch(() => {});
        }
      } catch { /* non-fatal */ }
    },

    // In-app deep-link hash for a completion, mirroring the routing in
    // Notifications._onItemClick.
    _routeFor(info) {
      if (info?.kind === 'test_alert') return '#settings/alerts';
      if (!info || !info.appSlug) return null;
      if (info.kind === 'auto_solve_done') {
        return info.headlessIssueNumber
          ? `#app/${info.appSlug}/dev/issues/${info.headlessIssueNumber}`
          : `#app/${info.appSlug}/dev/issues`;
      }
      return info.sessionId
        ? `#app/${info.appSlug}/dev/sessions/${info.sessionId}`
        : null;
    },

    // Navigate the SPA to the completion's target (browser-Notification
    // click handler). Prefers App.openAppTab (always re-renders) and falls
    // back to a hash assignment, exactly like the bell-menu click path.
    _navigate(info) {
      try { window.focus(); } catch {}
      if (info && info.appSlug && typeof App !== 'undefined' && App.openAppTab) {
        if (info.kind === 'auto_solve_done') {
          App.openAppTab(info.appSlug, 'dev', {
            subTab: 'issues',
            ref: info.headlessIssueNumber || null,
          });
          return;
        }
        if (info.sessionId) {
          App.openAppTab(info.appSlug, 'dev', { subTab: 'sessions', sessionId: info.sessionId });
          return;
        }
      }
      const route = DevAlerts._routeFor(info);
      if (route) window.location.hash = route;
    },

    // Fire an OS notification.
    //  - Native: a fire-and-forget `notify` bridge post. Older app builds
    //    log-and-drop unknown methods (same tolerance as the existing
    //    'titleChanged' message), so this is safe to ship ahead of the
    //    Flutter-side handler.
    //  - Browser: a Web Notification, only when permission is granted.
    systemNotify(info) {
      if (!DevAlerts.enabled() || !info) return;
      const title = info.title || 'Dev chat';
      const body = info.body || '';
      if (DevAlerts._isNative()) {
        // The canonical notification already has an FCM delivery. Avoid a
        // second legacy local notification from the live WebView; foreground
        // chimes remain unchanged.
        if (DevAlerts._remoteDeliveryActive) return;
        try {
          if (window.Usernode && typeof window.Usernode.postMessage === 'function') {
            window.Usernode.postMessage(JSON.stringify({
              method: 'notify',
              title,
              body,
              route: DevAlerts._routeFor(info) || '',
            }));
          }
        } catch { /* unknown method dropped by older builds; non-fatal */ }
        return;
      }
      try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const tag = info.sessionId
          ? `devchat-${info.kind}-${info.sessionId}`
          : `devchat-${info.kind}`;
        const n = new Notification(title, { body, tag });
        n.onclick = () => {
          DevAlerts._navigate(info);
          try { n.close(); } catch {}
        };
      } catch { /* best-effort */ }
    },

    // Single entry the notifications module calls when a completion
    // notification arrives: chime when the app is visible, OS notification
    // when it's hidden. The decision is made once, synchronously, here.
    onCompletion(info) {
      if (!DevAlerts.enabled()) return;
      if (document.visibilityState === 'hidden') {
        DevAlerts.systemNotify(info);
      } else {
        DevAlerts.playDoneTone();
      }
    },

    // Queue remote delivery before starting the optional live-page preview.
    // Permission/audio unlocking stays synchronous within the click gesture.
    TEST_DELAY_MS: 10000,
    async testAlert() {
      DevAlerts._unlockAudio();
      DevAlerts.requestNotifyPermission();
      const response = await fetch('/api/me/test-alert', {
        method: 'POST',
        credentials: 'same-origin',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not queue the test push. Please try again.');
      const info = {
        kind: 'test_alert',
        title: 'Homeroom test alert',
        body: 'This is a test of your dev-chat sound & alerts.',
      };
      setTimeout(() => {
        // A native background test is delivered by the server, even when
        // this WebView is suspended. Never send a duplicate local banner.
        if (document.visibilityState === 'hidden' && DevAlerts._isNative()) return;
        DevAlerts.onCompletion(info);
      }, result.delayMs);
      return result;
    },
  };

  window.DevAlerts = DevAlerts;
})();
