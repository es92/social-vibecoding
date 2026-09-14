// NavLink (#1036) — one rule for "a navigation control should behave like
// a real link".
//
// The shell is a client-routed SPA: apps use clean paths
// (/app/<slug>, /app/<slug>/board, …) while the other platform screens keep
// their established fragments (#leaderboard, #apps/<slug>, …), all of which
// App.restoreFromHash can boot into cold. But most of the navigation
// chrome was built as <button>/<div> with a click handler that assigns
// location.hash, so cmd/ctrl-click, middle-click, shift-click and
// right-click → "Open in new tab" all did nothing. The drawer rows
// (#drawer-row-profile / -leaderboard / -settings / -admin in
// index.html) were the exception — they are real anchors and have
// always cmd-clicked correctly. This module generalises that.
//
// Two mechanisms, picked by what the control can structurally be:
//
//   A. REAL ANCHOR (preferred) — NavLink.bind(). The element is an <a
//      href="#route">; the browser owns every modified activation
//      (new tab, new window, download, context menu, status bar,
//      drag-to-bookmark) and our handler only runs for a plain primary
//      click. Deliberately binds 'click' ONLY: modern browsers turn a
//      middle-click on an href anchor into a new tab natively, so
//      there is nothing for us to add there.
//
//   B. MODIFIER INTERCEPTION (fallback) — NavLink.wireModified(). For
//      controls that CANNOT be an anchor: the App/Dev switch carries
//      role="radio" inside a role="radiogroup", and the list rows
//      (home app cards, browse rows, dev session rows) contain nested
//      <button>s, which is invalid inside <a>. Those keep their tag and
//      we intercept 'click' + 'auxclick' ourselves, opening the
//      absolute URL with window.open. Shift is NOT intercepted on this
//      path — anchors get "new window" free and duplicating it through
//      window.open isn't worth the divergence.
//
// NEVER add target="_blank" to a control wired here. Inside the Homeroom
// Flutter WebView that would push a plain tap out to the system browser;
// the whole point is that native/touch hosts, which have no modifier
// keys and no middle button, keep the exact in-place behaviour they have
// today.

(function () {
  'use strict';

  const NavLink = {
    /** True when the BROWSER should be left to handle this activation
        itself — a non-primary button, any modifier, or an event some
        other handler already claimed. Callers return early on true and
        skip their own preventDefault(), which is what lets the anchor's
        native new-tab / new-window / download / context behaviour run.

        altKey is in the list purely so we never fight the browser: on a
        hash URL its download behaviour is a harmless no-op, but
        suppressing it would be us overriding a user gesture. */
    isNativeClick(e) {
      if (!e) return false;
      if (e.defaultPrevented) return true;
      // `button` is undefined on synthetic .click() calls (the ?shot=
      // screenshot hooks use those) — treat those as a plain click.
      if (typeof e.button === 'number' && e.button !== 0) return true;
      return !!(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey);
    },

    /** True when a NON-anchor control should open its destination in a
        new tab: cmd/ctrl (the platform-independent "new tab" modifier)
        or the middle button. Used only by wireModified(); anchors never
        need this because the browser answers the same question itself. */
    isNewTabClick(e) {
      if (!e) return false;
      if (typeof e.button === 'number' && e.button === 1) return true;
      return !!(e.metaKey || e.ctrlKey);
    },

    /** Resolve a route href to a full, top-level URL.

        ALWAYS resolved against the SHELL document's location.href, never
        against a mounted app iframe — an app's iframe URL is not a
        usable address for a new tab. In production this yields
        https://<platform-host>/#route; in local dev it yields whatever
        origin the shell is actually being viewed on (so a phone on the
        LAN gets its own view of the host, same spirit as
        resolveDevHost). Inside a self-app staging preview it yields the
        staging container's own Caddy-served hostname, which IS a usable
        top-level URL. */
    absolute(href) {
      try {
        return new URL(String(href == null ? '' : href), window.location.href).href;
      } catch {
        return String(href == null ? '' : href);
      }
    },

    /** The href for "home".

        Mirrors the home branch of App.updateHash(): return to the root,
        drop the fragment, and keep the query string. In staging previews the
        shell-injected ?token= lives there, and ?demo= / ?shot= should
        survive into the new tab so a demo-mode session stays in demo mode.
        `path` is route-owned by chromeless app links and must not leak home. */
    homeHref() {
      if (window.App?._rootUrl) return window.App._rootUrl();
      return '/' + window.location.search;
    },

    /** Mechanism A. Point a real anchor at `href` and wire `onActivate`
        behind the native-click guard.

        `href` may be null/'' — the anchor is then left with no href
        (inert, and not focusable as a link), which is the right
        degradation when a route can't be resolved yet: better than
        minting "#app/undefined/dev".

        Returns the element so call sites can chain. */
    bind(el, href, onActivate) {
      if (!el) return el;
      if (href) el.setAttribute('href', href);
      else el.removeAttribute('href');
      if (typeof onActivate === 'function') {
        el.addEventListener('click', (e) => {
          if (NavLink.isNativeClick(e)) return;
          e.preventDefault();
          onActivate(e);
        });
      }
      return el;
    },

    /** Mechanism B. Keep `el` as whatever tag it is and intercept
        modified/middle activations, opening the resolved URL in a new
        tab; everything else falls through to `onActivate`.

        `hrefFn(event)` is a FUNCTION, resolved at activation time — the
        App/Dev switch's target depends on App.currentApp, and a list
        row's on its own dataset, neither of which is stable at wiring
        time. Returning a falsy href means "this control is inert right
        now" (a demo tile, a non-running app): nothing opens and
        onActivate is not called, so a modified click behaves exactly
        like the plain click would.

        Returns the element so call sites can chain. */
    wireModified(el, hrefFn, onActivate) {
      if (!el || typeof hrefFn !== 'function') return el;
      const openNewTab = (e) => {
        const href = hrefFn(e);
        if (!href) return true; // inert — swallow, same as a plain click
        e.preventDefault();
        window.open(NavLink.absolute(href), '_blank', 'noopener');
        return true;
      };
      el.addEventListener('click', (e) => {
        if (NavLink.isNewTabClick(e)) { openNewTab(e); return; }
        if (typeof onActivate === 'function') onActivate(e);
      });
      // Middle-click never fires 'click' on a non-anchor — it fires
      // 'auxclick'. Without this the mouse-wheel press (the most common
      // "open in a new tab" gesture on a list row) would do nothing.
      el.addEventListener('auxclick', (e) => {
        if (!NavLink.isNewTabClick(e)) return;
        openNewTab(e);
      });
      return el;
    },
  };

  // ── External links inside the Homeroom app (#1312) ───────────────────
  //
  // The app's webview is bound to the platform's own domains (iOS
  // App-Bound Domains — NATIVE-BRIDGE.md): it cannot navigate to
  // github.com or claude.ai itself, so a target="_blank" anchor that works
  // in every browser does NOTHING there, and neither does window.open. The
  // bridge's openExternal is the one road out — it hands the URL to the
  // system browser. This one delegated listener routes every external
  // target="_blank" anchor through it, so screens keep writing plain
  // anchors and stay correct everywhere: in a browser the bridge reports
  // non-native and the listener never engages.
  //
  // Only target="_blank" PLUS a different http(s) origin is intercepted:
  // same-origin hash routes are the SPA's own navigation, and a control
  // wired by bind()/wireModified() never carries target="_blank" (see the
  // note at the top), so the two mechanisms cannot collide. Capture phase
  // on purpose — transcript anchors stop propagation so their row handlers
  // don't fire (e.g. the session list's PR link), which would starve a
  // bubble listener; preventDefault in capture still cancels the
  // navigation while letting those inner handlers run unchanged.
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      if (NavLink.isNativeClick(e)) return; // modified: the browser's business
      const bridge = window.usernode;
      if (!bridge || !bridge.isNative || typeof bridge.openExternal !== 'function') return;
      const anchor = e.target && e.target.closest
        ? e.target.closest('a[target="_blank"]')
        : null;
      if (!anchor) return;
      let url;
      try { url = new URL(anchor.href, window.location.href); } catch { return; }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      if (url.origin === window.location.origin) return;
      e.preventDefault();
      bridge.openExternal(url.href).catch(() => {
        // An app build without the handler: retry the popup path rather
        // than stranding the tap — at worst it does what the anchor would
        // have done on its own.
        if (window.open) window.open(url.href, '_blank', 'noopener');
      });
    }, true);
  }

  window.NavLink = NavLink;
})();
