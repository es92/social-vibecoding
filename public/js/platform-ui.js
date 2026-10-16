// PlatformUI — the platform frontend's single seam over the hosted
// usernode-native kit (window.unNative, loaded in index.html <head>).
//
// All platform code calls PlatformUI.*, never unNative directly, so a
// future kit /v2/ migration (or a CDN hiccup) is one file's problem.
// Every method degrades gracefully when the kit failed to load:
//   toast   → console.log (non-blocking, nothing to click through)
//   alert   → window.alert
//   confirm → window.confirm
//   prompt  → window.prompt
//   actionSheet / sheet / panel / modal → null (callers keep their legacy
//   DOM path and must branch on the return / isTouch()).
//
// Adaptive rule (spec decision): touch platforms get action sheets and
// bottom sheets; desktop gets anchored popovers — now also kit-owned
// (unNative.popover / unNative.menu, #741). New menu call sites should
// use PlatformUI.menu() and let the kit pick the idiom; isTouch()
// remains for surfaces the kit doesn't cover yet.

(function () {
  'use strict';

  function kit() {
    const un = window.unNative;
    return un && typeof un.toast === 'function' ? un : null;
  }

  // How far the scrollers between a touch's target and `root` are from
  // their own tops, together: 0 when every one of them is at its top (or
  // there are none), which is the only time a pull on `root` is a pull.
  // See pullToRefresh (#3517, #3514).
  function nestedOffset(from, root) {
    if (!from || !root || typeof root.contains !== 'function' || !root.contains(from)) return 0;
    let sum = 0;
    for (let el = from; el && el !== root; el = el.parentElement) sum += fromTop(el);
    return sum;
  }

  // How far one element can still scroll towards the top of its content.
  //
  // Not always `scrollTop`. A scroller laid out `flex-direction:
  // column-reverse` (the usual way to keep a chat on its newest line) sits
  // at 0 at its BOTTOM and goes negative towards its top, so what is left
  // to go up there is `scrollTop` plus its whole range. Neither chat on the
  // Discussion tab is built that way today (#gc-messages and the embedded
  // #general's .messages-thread-scroll both count up from 0), and the guard
  // should not quietly stop working the day one is. 0 is ambiguous, the top
  // of one and the bottom of the other, so only then is the style asked, and
  // only of an element with something to scroll.
  function fromTop(el) {
    const top = Number(el.scrollTop) || 0;
    if (top > 0) return top;
    const range = (Number(el.scrollHeight) || 0) - (Number(el.clientHeight) || 0);
    if (range <= 0) return 0;
    if (top < 0) return Math.max(0, top + range);
    let cs = null;
    try {
      cs = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null;
    } catch (_) { cs = null; }
    return cs && /auto|scroll/.test(cs.overflowY) && cs.flexDirection === 'column-reverse' ? range : 0;
  }

  function presentFrosted(un, method, opts) {
    const original = opts || {};
    const decorate = window.UsernodeReact && window.UsernodeReact.decorateOverlay;
    if (!decorate) return un[method](original);
    let cleanup;
    const handle = un[method]({ ...original, onDismiss() {
      if (cleanup) cleanup();
      if (original.onDismiss) original.onDismiss();
    } });
    if (handle) cleanup = decorate(handle.el);
    return handle;
  }

  const PlatformUI = {
    /** True when the kit is present and reports a touch platform
        (un-ios / un-android). Desktop and kit-missing both → false,
        so legacy anchored-popover paths stay the fallback. */
    isTouch() {
      const un = kit();
      return !!un && un.platform !== 'desktop';
    },

    /** Whether the kit loaded at all (sheet/modal/actionSheet work). */
    hasKit() {
      return !!kit();
    },

    /** Transient, non-blocking feedback ("Copied", "Failed to save").
        Fire-and-forget; returns the kit handle or null.

        QA 2026-09-24 Q28: the toast rests ABOVE the bottom chrome. The kit
        reads `--un-toast-inset-bottom` for that; app.css gives it the tab
        bar's height, and this adds a composer when one is on screen, which
        only a measurement can know. */
    toast(message, opts) {
      const un = kit();
      if (!un) {
        console.log('[toast]', message);
        return null;
      }
      const handle = un.toast(String(message), opts || {});
      try {
        const clear = PlatformUI.toastClearance();
        if (handle && handle.el && clear > 0) {
          handle.el.style.setProperty('--un-toast-inset-bottom', `${clear}px`);
        } else if (handle && handle.el) {
          handle.el.style.removeProperty('--un-toast-inset-bottom');
        }
      } catch (err) { /* a toast never fails over its placement */ }
      return handle;
    },

    /** How much of the viewport's foot is bottom chrome a toast must clear:
        the tab bar and any composer block (`.platform-safe-bar`, which every
        composer wears) that is pinned to the bottom edge. A tall panel that
        merely ends at the edge (its top in the upper half) is content, not
        a bar, and is ignored, as is anything hidden or off-screen. 0 when
        nothing qualifies. */
    toastClearance() {
      const root = document.documentElement;
      const vh = window.innerHeight || (root && root.clientHeight) || 0;
      if (!vh || typeof document.querySelectorAll !== 'function') return 0;
      let clear = 0;
      for (const el of document.querySelectorAll('#platform-tabs, .platform-safe-bar')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.bottom < vh - 2 || r.top < vh / 2 || r.top >= vh) continue;
        clear = Math.max(clear, vh - r.top);
      }
      return Math.round(clear);
    },

    /** Copy text to the clipboard. Resolves true on success, false on
        failure — NEVER throws, so callers can `await` it and branch on
        the boolean rather than wrapping every call site in try/catch.

        Deliberately NOT a kit seam: usernode-native exposes no clipboard
        primitive, so this is plain DOM. It lives here anyway because
        PlatformUI loads first (see index.html) and every screen already
        has it, which is what makes one shared implementation of the
        fallback possible. That fallback — an off-screen textarea driven
        by the deprecated document.execCommand('copy') — covers contexts
        where navigator.clipboard is missing or rejects (an insecure
        http: origin, a permission-blocked webview); see the same
        rationale at the share dialog's copy handler, which is
        frontend/src/features/dialogs/share.tsx as of #1078 chunk I. */
    async copyText(text) {
      const value = text == null ? '' : String(text);
      if (!value) return false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch {}
      // Fallback: a hidden textarea + execCommand. Off-screen rather
      // than display:none — a non-rendered element can't be selected.
      let ta = null;
      try {
        ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, value.length);
        return document.execCommand('copy');
      } catch {
        return false;
      } finally {
        if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
      }
    },

    /** Blocking informational dialog. Resolves when dismissed. */
    alert(opts) {
      const o = typeof opts === 'string' ? { title: opts } : (opts || {});
      const un = kit();
      if (!un || typeof un.alert !== 'function') {
        try { window.alert([o.title, o.message].filter(Boolean).join('\n\n')); } catch {}
        return Promise.resolve({ button: null });
      }
      return un.alert({
        title: o.title || '',
        message: o.message || undefined,
        buttons: o.buttons || [{ label: o.okLabel || PlatformI18n.t('core:common.ok'), style: 'default' }],
      });
    },

    /** Native-style confirm card. Resolves boolean. */
    confirm(opts) {
      const o = typeof opts === 'string' ? { title: opts } : (opts || {});
      const un = kit();
      if (!un || typeof un.alert !== 'function') {
        let ok = false;
        try { ok = window.confirm([o.title, o.message].filter(Boolean).join('\n\n')); } catch {}
        return Promise.resolve(ok);
      }
      return un
        .alert({
          title: o.title || PlatformI18n.t('shell:confirm.title'),
          message: o.message || undefined,
          buttons: [
            { label: o.cancelLabel || PlatformI18n.t('core:common.cancel'), style: 'cancel' },
            { label: o.confirmLabel || PlatformI18n.t('core:common.ok'), style: o.danger ? 'destructive' : 'default' },
          ],
        })
        .then((res) => !!(res && res.button && res.button.style !== 'cancel'));
    },

    /** Single-field prompt (replaces window.prompt — the kit alert's
        inset text field). Resolves the string, or null on cancel. Enter
        in the field confirms, as it does in any one-field form, and an
        optional `maxLength` caps it. */
    prompt(opts) {
      const o = typeof opts === 'string' ? { title: opts } : (opts || {});
      const un = kit();
      if (!un || typeof un.alert !== 'function') {
        let v = null;
        try { v = window.prompt([o.title, o.message].filter(Boolean).join('\n\n'), o.value || ''); } catch {}
        return Promise.resolve(v);
      }
      return un
        .alert({
          title: o.title || '',
          message: o.message || undefined,
          field: {
            placeholder: o.placeholder || '',
            value: o.value || '',
            submitOnEnter: true,
            ...(o.maxLength > 0 ? { maxLength: o.maxLength } : {}),
          },
          buttons: [
            { label: o.cancelLabel || PlatformI18n.t('core:common.cancel'), style: 'cancel' },
            { label: o.confirmLabel || PlatformI18n.t('core:common.ok'), style: 'default' },
          ],
        })
        .then((res) => {
          if (!res || !res.button || res.button.style === 'cancel') return null;
          return res.value != null ? String(res.value) : '';
        });
    },

    /** iOS-style action sheet. Resolves the chosen action or null.
        Returns Promise.resolve(null) when the kit is missing — callers
        should only route here when isTouch() (or hasKit()) is true. */
    actionSheet(opts) {
      const un = kit();
      if (!un || typeof un.actionSheet !== 'function') return Promise.resolve(null);
      return un.actionSheet(opts || {});
    },

    /** Anchored popover / dropdown (the desktop menu idiom). Items mode
        resolves the chosen item or null (with .dismiss() attached);
        content mode returns the kit handle { dismiss, el }. Returns
        null when the kit is missing. */
    popover(opts) {
      const un = kit();
      if (!un || typeof un.popover !== 'function') return null;
      return un.popover(opts || {});
    },

    /** Adaptive menu: bottom action sheet on touch, anchored popover on
        desktop, from one actionSheet-shaped call. Resolves the chosen
        item or null — including when the kit is missing (same silent
        degradation as actionSheet). */
    menu(opts) {
      const un = kit();
      if (!un || typeof un.menu !== 'function') return Promise.resolve(null);
      return un.menu(opts || {});
    },

    /** Bottom sheet. Returns the kit handle { dismiss, el } or null
        when unavailable (caller keeps its legacy panel). */
    sheet(opts) {
      const un = kit();
      if (!un || typeof un.presentSheet !== 'function') return null;
      return presentFrosted(un, 'presentSheet', opts);
    },

    /** Side drawer / panel sliding in from an edge ({ side, contentEl,
        width?, onDismiss }). Returns the kit handle { dismiss, el } or
        null when unavailable (caller keeps its legacy panel). */
    panel(opts) {
      const un = kit();
      if (!un || typeof un.presentPanel !== 'function') return null;
      return presentFrosted(un, 'presentPanel', opts);
    },

    /** Centered modal card. Returns the kit handle or null. */
    modal(opts) {
      const un = kit();
      if (!un || typeof un.presentModal !== 'function') return null;
      return presentFrosted(un, 'presentModal', opts);
    },

    /** Swipe-to-act row actions (kit ride-along tray). No-op stub on
        desktop / kit-missing so callers can attach unconditionally on
        their touch path. */
    swipeActions(rowEl, opts) {
      const un = kit();
      if (!un || typeof un.attachSwipeActions !== 'function' || !rowEl) {
        return { close() {}, detach() {} };
      }
      return un.attachSwipeActions(rowEl, opts || {});
    },

    /** Resolve the document scroller on mobile web, or the native shell's
        original element. The bridge also settles a just-rendered route. */
    scrollElement(el) {
      return window.UsernodeBrowserScroll?.scrollElement(el) || el;
    },

    /** Keep the gesture/content local to its screen, but read the actual
        page offset so pulling down mid-page never claims a refresh.

        #3517: AND THE OFFSET OF ANY SCROLLER THE FINGER LANDED IN. The kit
        reads one scroller's offset, the screen's or the page's, so a
        downward drag inside a nested scroller that was not at its own top
        was a pull as far as the kit could tell, whenever the screen around
        it was at 0. The Workshop's Needs you feed is exactly that: a snap
        scroller inside #dev-forum-scroll, fitted to the window so the
        outer offset never leaves 0. Swiping down to go back a card dragged
        the whole Workshop down under the refresh puck and, past the
        threshold, reloaded it; where the kit's preventDefault got in first
        (it claims at a 10px lock, before most browsers start a scroll)
        the card did not move at all. The Discussion tab is the same shape
        (#3514): its chat (#gc-messages, or #general's embedded
        .messages-thread-scroll) opens on its newest line, far from its
        top, and dragging down to read back slid the page away from the
        header under the puck instead of scrolling the chat.

        A native scroll view gives the drag to the innermost scroller that
        can still move, and so does this now: from touchstart to touchend
        the offset the kit reads is the page's PLUS every scrolled element
        between the finger and `scrollEl` (`nestedOffset`). Captured, so it
        is known before the kit's own touchstart asks. Between touches it
        is the page's alone, so the blocking listener the kit keeps bound
        at the top is there before the next finger lands, as it always was.
        v1 of the kit is frozen (additive only), which is why this is the
        platform's seam and not a change to attachPullToRefresh.

        `opts` reach the kit as given, beside the reader above. A page whose
        chrome sits INSIDE its scroller passes the kit's additive
        `pullProperty` and a `topEl` function, so that chrome holds still and
        only the content under it slides: the project page's tab band
        (app-view.js; pull-to-refresh under the tabs, evan, 2026-10-01). */
    pullToRefresh(scrollEl, onRefresh, opts) {
      const un = kit();
      if (!un || typeof un.attachPullToRefresh !== 'function' || !scrollEl) {
        return { detach() {} };
      }
      let from = null;
      const listen = typeof scrollEl.addEventListener === 'function';
      const onStart = (e) => { from = e.touches && e.touches.length === 1 ? e.target : null; };
      const onEnd = (e) => { if (!e.touches || !e.touches.length) from = null; };
      const cap = { capture: true, passive: true };
      if (listen) {
        scrollEl.addEventListener('touchstart', onStart, cap);
        scrollEl.addEventListener('touchend', onEnd, cap);
        scrollEl.addEventListener('touchcancel', onEnd, cap);
      }
      const handle = un.attachPullToRefresh(scrollEl, onRefresh, {
        ...opts,
        getScrollTop: () => PlatformUI.scrollElement(scrollEl).scrollTop + nestedOffset(from, scrollEl),
      }) || { detach() {} };
      return {
        ...handle,
        detach() {
          if (listen) {
            scrollEl.removeEventListener('touchstart', onStart, cap);
            scrollEl.removeEventListener('touchend', onEnd, cap);
            scrollEl.removeEventListener('touchcancel', onEnd, cap);
          }
          from = null;
          if (typeof handle.detach === 'function') handle.detach();
        },
      };
    },

    /** App-side gestures join the kit's intent lock through here. */
    gestures() {
      const un = kit();
      return un && un.gestures ? un.gestures : null;
    },

    /** Per-screen scroll polish: nav-bar hairline-on-scroll treatment
        plus fixed-shell keyboard avoidance on the screen's content
        scroller. Keyed so re-renders (these screens rebuild their
        innerHTML) detach stale handles before re-attaching. Call
        detachScreenFx(key) from the screen's close path. */
    _screenFx: Object.create(null),
    attachScreenFx(key, scrollEl, topEl, opts) {
      PlatformUI.detachScreenFx(key);
      const un = kit();
      if (!un || !scrollEl) return;
      const navBar = !opts || opts.navBar !== false;
      const handles = [];
      if (topEl && navBar && typeof un.attachNavBar === 'function') {
        topEl.classList.add('platform-chat-header');
        handles.push(un.attachNavBar(topEl, { scrollEl }));
      }
      if (typeof un.attachKeyboardAvoidance === 'function') {
        // The composer column around the scroller (`.platform-kb-column`):
        // its message box is focused without iOS's pan too.
        const column = typeof scrollEl.closest === 'function' ? scrollEl.closest('.platform-kb-column') : null;
        handles.push(un.attachKeyboardAvoidance(scrollEl, { topEl: topEl || undefined, column: column || undefined }));
      }
      PlatformUI._screenFx[key] = handles;
    },
    detachScreenFx(key) {
      const handles = PlatformUI._screenFx[key];
      if (!handles) return;
      delete PlatformUI._screenFx[key];
      for (const h of handles) {
        try { if (h && typeof h.detach === 'function') h.detach(); } catch {}
      }
    },

    /** Screen transition wrapper. type: 'push' | 'pop' | 'none' |
        'zoom-in' | 'zoom-out' (zoom opts — el, fromEl/fromRect, after,
        fallback, outEl — forward to the kit untouched). Falls back to running
        the mutation directly — both halves, since zoom callers split it
        into fn (reveal) + after (conceal) — when the kit is absent.

        EVERY VISIBLE MUTATION OF THE NAVIGATION GOES INSIDE `fn`. For
        push/pop the kit wraps it in a View Transition, and a View
        Transition captures the OUTGOING page at the next rendering
        opportunity — NOT at this call — so anything mutated
        synchronously after calling this (hiding the screen being left,
        retitling the header, mounting the incoming screen) is baked into
        the "previous page" snapshot the animation slides out. That is
        what made the Settings animation show the incoming page behind
        itself (#979).

        AND A DUPLICATE DISPATCH THAT RE-APPLIES THE SAME NAVIGATION MUST BE
        SKIPPED BY THE CALLER, NOT ABSORBED BY THE KIT (#1102). One history
        traversal fires popstate AND hashchange, so an in-screen router can
        be called twice in one tick; the second call resolves the same
        target, asks for 'none', and the kit runs 'none' SYNCHRONOUSLY —
        inside the first call's still-uncaptured snapshot window. Only the
        caller knows "already showing this", so the caller early-outs (see
        Settings.route / AdminConsole.route / Browse.route). The kit only
        guarantees it will not ANIMATE a corrupted snapshot: it skips the
        pending transition instead, so the worst case is no animation. */
    transition(fn, opts) {
      const un = kit();
      if (!un || typeof un.transition !== 'function') {
        fn();
        if (opts && typeof opts.after === 'function') opts.after();
        return;
      }
      un.transition(fn, PlatformUI.underTour(PlatformUI.phoneMotion(PlatformUI.markZoom(opts || { type: 'none' }))));
    },

    /** A SCREEN THAT IS ZOOMING SAYS SO: `data-zooming` on it, from the call
        until `after`, which the kit runs exactly once on every path (the
        settle, an instant finish, and the push/pop/none it falls back to).
        The kit pins the zooming screen as a fixed card at z-index 9960 over
        its whole box, and #app-view's box runs under the desktop rail (the
        rail's room is padding inside it), so an app opening beside the rail
        covered the rail for the length of the zoom and it snapped back at
        the end. app.css lifts the docked rail over the card while this is
        set ("THE RAIL STAYS OVER AN APP THAT IS ZOOMING"). */
    markZoom(opts) {
      const el = opts && (opts.type === 'zoom-in' || opts.type === 'zoom-out') ? opts.el : null;
      if (!el || typeof el.setAttribute !== 'function') return opts;
      el.setAttribute('data-zooming', '');
      const after = opts.after;
      return {
        ...opts,
        after: () => {
          el.removeAttribute('data-zooming');
          if (typeof after === 'function') after();
        },
      };
    },

    /** UNDER THE FIRST-SESSION TOUR A PAGE SWAPS IN PLACE (onboarding run
        two, 12 Oct 2026, iPhone 17 Safari). A View Transition draws its two
        pictures of the page over everything, the tour's dim and card
        included: tapping ✕ on its fifth card showed the app undimmed for a
        frame, then the app's words through the next card while the two
        faded. While the tour is up (its flag, first-session/tour-running.ts)
        a push, pop or fade runs as 'none'. So does the zoom out of an app
        (onboarding run three): it pins the app's view over everything to
        shrink it into its tile, and ✕ on the fifth card showed that view
        undimmed for a frame. The zoom into an app keeps its motion: that is
        the tile the tour asks them to tap, opening. */
    underTour(opts) {
      const o = opts || { type: 'none' };
      const flag = globalThis.__usernodeFirstSessionTourRunning;
      if (!flag || !flag.running) return o;
      if (o.type === 'none' || o.type === 'zoom-in') return o;
      return Object.assign({}, o, { type: 'none' });
    },

    /** NO PAGE SLIDES ON THE PHONE (#2896, #2775). The kit's push and pop
        slide the whole page sideways, and on the phone which way a change
        slid was never consistent: the same tab slid in from the right one
        time and from the left the next, depending on which caller asked
        and what it guessed about depth. They are gone rather than fixed —
        on the phone a page change swaps in place, the way the desktop rail
        has swapped since #2843/#2900. So every push or pop asked for below
        the 768px layout breakpoint (the one app.css turns the bar into a
        rail at) runs as 'none', and so does a zoom's push/pop FALLBACK (a
        zoom with no tile to grow from). The zooms themselves stay: opening
        an app from its tile is not a page sliding anywhere. The tab bar's
        sliding marker (#2849) is the bar's own and is not a page motion.

        One place, so no caller can bring a slide back by asking for one;
        App._entryTransition applies the same rule first only so that the
        `data-entered` it stamps names what actually runs. */
    phoneMotion(opts) {
      if (!opts || !PlatformUI.isPhoneLayout()) return opts;
      const slide = (t) => t === 'push' || t === 'pop';
      if (slide(opts.type)) return { ...opts, type: 'none' };
      if (opts.type === 'zoom-in' || opts.type === 'zoom-out') {
        if (!opts.fallback || slide(opts.fallback)) return { ...opts, fallback: 'none' };
      }
      return opts;
    },

    /** Below the 768px breakpoint. Unreadable answers false — the desktop's
        motion, which is what ran before this existed. */
    isPhoneLayout() {
      try {
        return !!(window.matchMedia && !window.matchMedia('(min-width: 768px)').matches);
      } catch (_) {
        return false;
      }
    },
  };

  // ── Static-modal adoption: RETIRED (#1078 chunk I) ───────────────
  //
  // What was here: an `adoptStaticModal(root)` that put a MutationObserver on
  // each of nine hard-coded modal roots (`STATIC_MODAL_IDS`) and, when
  // `hidden` came off, lifted the card out of the root into a kit
  // `presentModal`. It existed so the kit could present dialogs whose
  // open/close paths lived in app.js and app-view.js, without rewriting them.
  //
  // Its cost was that it made those dialogs permanently markup-only: two
  // owners wrote to the same nodes, and the one React did not control moved
  // React's DOM out from under it. The lift is frontend/src/lib/static-modal.ts
  // now, driven by React state from the dialog islands, so there is exactly
  // one owner and all nine dialogs are stateful. Nothing in public/js/**
  // called `adoptStaticModal` or read `STATIC_MODAL_IDS` — the whole seam was
  // self-contained here, which is why it could go in one piece.
  //
  // `PlatformUI.modal()` above is untouched: that is the kit entry point the
  // hook calls, and the rest of the shell (confirm dialogs, sheets, the
  // compare overlay) still uses it directly.

  window.PlatformUI = PlatformUI;
})();
