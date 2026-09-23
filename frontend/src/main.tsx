// The React shell's browser entry point.
//
// Emitted (unhashed, single chunk) as /shell/assets/shell.js and referenced
// from the LAST line of <head> in the image-generated public/index.html.
//
// ── Why the entry is a <head> module, and why hydration is flushSync'd ──
//
// The load order this file has to preserve, exactly as it was before the
// React chassis existed:
//
//   1. the head's blocking classic scripts  (theme.js, usernode-bridge.js,
//      the .in-native-webview inline script, the three vendored libs, the
//      native kit) — they must still run before anything paints;
//   2. the 47 classic <script src="/js/…"> tags at the end of <body>, in
//      order, each defining its global — app.js LAST, so App.init()
//      registers its DOMContentLoaded handler after every other module's;
//   3. DOMContentLoaded — every module's init() runs and starts writing
//      into the DOM (innerHTML, class toggling, appendChild).
//
// A `type="module"` script is deferred, so placing this at the end of <head>
// puts it after (2) and before (3): the legacy globals all exist and the
// document is fully parsed when hydration begins, and hydration is finished
// before the first init() touches anything. That is the same window the old
// shell had between "last script tag ran" and "DOMContentLoaded fired", i.e.
// no timing change at all.
//
// flushSync is what makes that guarantee hold. hydrateRoot on its own
// hydrates in a concurrent lane that can yield to the scheduler and resume
// in a LATER task — potentially after DOMContentLoaded, i.e. while
// App.init() and friends are rewriting the very subtrees React is still
// adopting. Every such collision is a hydration mismatch, every mismatch is
// a console.error, and a console.error on any route fails the platform's
// proposal checks (see the cascade probe in the head for the same
// reasoning). Wrapping the initial hydration in flushSync forces it to
// complete synchronously inside this task, so that interleaving cannot
// happen.
//
// The second guard is in Shell.tsx: the tree is static except for explicitly
// converted ISLANDS, and a region only becomes an island once its entire
// subtree is React-owned — so React still never reconciles over DOM another
// module writes into. Both guards are load-bearing. Read the header comment
// there before making any further part of the shell tree stateful.
//
// ── What runs here BEFORE hydration, and why ───────────────────────────
//
// Two things that /js/offline.js used to do at classic-script time, and that
// moved into this bundle when #1078 retired that module:
//
//   * service-worker registration — nothing on this load depends on it;
//   * the connectivity engine, which installs `window.Offline`.
//
// The second is ordered deliberately: it runs at module scope, before
// hydration, because App.init() calls `Offline.forceOffline()` for the
// `?shot=offline` deep links and home.js / auth-screens.js read
// `Offline.isOffline()` while painting their first frame. All of that happens
// on DOMContentLoaded — after this module executes — so the API is in place
// in time, exactly as it was when a <body> script defined it.

import { flushSync } from 'react-dom';
import { hydrateRoot } from 'react-dom/client';

import { Shell } from './Shell';
import './lib/overlay-scrim-bridge';
import { bootStep } from './lib/boot-guard';
import { initOffline } from './lib/offline';
import { registerServiceWorker } from './lib/service-worker';
import { applyShellSnapshot } from './lib/shell-snapshot-apply';
// Publishes window.UsernodeReact.devBoard at module scope. Imported for the
// side effect, and imported HERE (rather than reached from a Shell island)
// because the Dev surfaces are runtime-injected into an empty #app-content and
// so have no island to hang off — see that file's header and
// ./lib/legacy-portals.tsx. app-view.js can reach the API from the moment
// DOMContentLoaded fires, which is the earliest App.switchTab() can run.
import './features/dev-board/mount';

// The group chat transcript's mount (#1191). Same shape and same reason as the
// Dev board's above: public/js/group-chat.js is a classic script that cannot
// import from this bundle, and #gc-messages is created at runtime by
// AppView.renderDevChatTab — so the API has to exist before anything can reach
// the chat tab, which means at module-evaluation time rather than from an
// island's effect.
import './features/group-chat/mount';
// #1085 chunk H: publishes window.UsernodeReact.staging and .visualCompare at
// module scope, for the same reason — app-view.js is a classic script that
// cannot import from this bundle, and it opens the staging overlay from a user
// gesture that reads the resulting DOM on its next statement. Imported here so
// the bridge exists before hydration rather than at first render of the island.
import './features/staging/mount';
// #1085 chunk H, step 2: publishes window.UsernodeReact.appFrame. This one is
// the most timing-sensitive of the three — AppView.beginLaunch runs inside
// PlatformUI.transition's reveal callback (so the frame exists before the zoom's
// first frame paints) and reads back the frame element on its next line to
// assign `src`. A bridge that only appeared at first render of the island would
// miss that window and the eager launch would silently fall back.
import './features/app-frame/mount';
// Streamlined Concept groundwork: publishes window.UsernodeReact.headerTitle.
// App.setHeaderTitle() forwards every title set through this bridge, so it
// must exist before DOMContentLoaded (the earliest App.init() can navigate) —
// module scope here, not first render of the header island.
import './features/header/mount';
// The platform tab bar's bridge: publishes window.UsernodeReact.nav. Same
// window as the header's — App._syncPlatformTabs() runs inside
// PlatformUI.transition's reveal callback on every screen swap, the earliest
// of which is App.init()'s first restoreFromHash on DOMContentLoaded.
import './features/nav/mount';

// The wallpaper's star follows the visible screen's scroll offset (the
// washes stay put). A side effect on a custom property, not an island:
// every wallpaper root is a scroller the legacy router and the React
// screens share, so it hangs off the document and the visibility store.
import './lib/browser-scroll';
import './lib/wallpaper-scroll';
// …and where the on-screen keyboard has panned the screen to, so a centred
// dialog stays inside what is visible above the keys (#2765).
import './lib/visual-viewport';
// …and the same wallpaper is copied under a screen's view transition, so the
// pinned, translucent header and rail keep their ground mid-fade (#2758).
import './lib/transition-ground';
// #1084 chunk G: the retired public/js/dev-chat.js, moved into the bundle
// verbatim. Imported HERE rather than from a Shell island for the same reason
// as the dev board above — #dc-view is written into an empty #app-content at
// runtime, so there is no island to hang it off — and importing it at the
// browser entry (never from Shell.tsx) keeps its 8,800 lines out of the
// prerender graph entirely. Its `window.DevChat` publication and its
// visibility/focus/pagehide listeners are guarded anyway.
import './features/dev-chat/mount';
import './features/dev-chat/dev-chat.js';

// #2563: the first-run "Choose your username" gate. Imported at the BROWSER
// entry rather than from a Shell island for two reasons — it renders nothing
// into the prerendered document (it lifts a kit modal, like the terms gate
// it is sequenced with), and it must be listening for `sv:authed` on every
// route, not only on one screen's first reveal. Its listener is guarded, so
// an anonymous document costs it nothing.
import './features/auth/username-first-run.js';

// ── Every step below is wrapped, and hydration is the one that matters ──
//
// A throw anywhere in this file used to abort the entry module, and an entry
// module that aborts before `hydrateRoot` leaves React never having adopted
// the document: every island stays the empty markup the prerender shipped,
// and the screen the boot reveals is blank. That is exactly how the iOS
// native app's blank screen worked (#1670) — one TypeError inside a precache
// nicety took the whole application down.
//
// ./lib/boot-guard.ts records the failure and lets the boot continue, so a
// step that fails costs its own feature and nothing else. Read its header for
// why it records rather than console.error-ing.
bootStep('registerServiceWorker', registerServiceWorker);
bootStep('initOffline', initOffline);

// document.body is the hydration container, not a wrapper <div>, because the
// body element itself is the flex column the layout depends on
// (`class="… flex flex-col" style="height:100dvh"` with `flex-1` <main>
// children). Interposing a wrapper would break every screen's height.
// Wrapped like the rest, though a throw HERE is the one failure this file
// cannot paper over — there is no shell without it. It is guarded anyway so
// the reason lands in the boot record for the head's watchdog to print,
// rather than being an uncaught error nobody on a phone can read.
bootStep('hydrate', () => {
  flushSync(() => {
    hydrateRoot(document.body, <Shell />);
  });
});

// ── The bar catches up here, and not one line earlier ──────────────────
//
// The document that just hydrated is almost always the CACHED prerender
// (public/sw.js races every navigation against it on a 200ms deadline), and
// the prerender is state-free: every island rendered from its store's INITIAL
// in Node. So the chip says "dApps" and the Improve button is missing, and
// both stay that way until App.init() has run, /api/auth/me has answered and
// the route has resolved — a network round trip after a paint that came from
// cache in milliseconds.
//
// Applying the last-known values AFTER hydrateRoot returns is what closes
// that without breaking the thing the prerender exists for. Before hydration
// — as a store INITIAL, or from an inline <head> script — the first client
// render would disagree with the prerendered markup, and that mismatch is a
// console.error, and a console error on any route fails proposal checks. Here,
// hydration has already matched byte for byte and this is an ordinary update
// in the same task.
//
// Everything real still overwrites it moments later; this only decides what is
// on screen in between. See ./lib/shell-snapshot.ts for the storage contract
// and why it is display-only.
bootStep('applyShellSnapshot', applyShellSnapshot);
