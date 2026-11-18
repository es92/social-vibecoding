/**
 * The presentation half every platform SHEET shares.
 *
 * Three surfaces present the same way — the app-context sheet behind the
 * header's title tab, Notifications and Messages behind their header glyphs —
 * and they were going to be three copies of the same forty lines. This is
 * that shape, extracted at the third caller: open/close/toggle, the kit sheet
 * adoption on touch with a CSS-slide fallback on desktop, the
 * dismiss-completion promise, and dismissal before a navigation.
 *
 * ── The publish-then-present order is load-bearing ─────────────────────
 *
 * `open()` publishes `open: true` and only THEN hands the element to the kit,
 * because the kit sheet measures the content's height ONCE at present time to
 * seed its slide-up spring. Every caller therefore has to install
 * `store.setFlush(flushSync)` in its mount module, or the publish is still
 * queued when the measurement happens and the sheet springs from nothing.
 *
 * ── One surface at a time ──────────────────────────────────────────────
 *
 * Every controller built here registers itself, and opening one closes the
 * hamburger drawer, the Improve panel and every OTHER registered sheet. The
 * app-context sheet used to do the first two by hand and knew nothing about
 * sheets that did not exist yet; a registry means the third and fourth
 * surface get the courtesy for free, and cannot forget to pay it.
 *
 * ── What it deliberately does NOT own ──────────────────────────────────
 *
 * Routing. A sheet is not a screen: it presents OVER whatever is on screen
 * and dismisses back to it, which is the whole reason Messages and
 * Notifications stopped being screen roots — a full screen needs a back
 * button, and a back button needs to know where it came from. Callers that
 * still answer a deep link (`#notifications`, `#messages/<id>`) resolve it to
 * a real screen first and then open the sheet over it.
 *
 * ── The back button closes it (QA 2026-09-24 Q16) ─────────────────────
 *
 * The dialogs already answered Back by closing (features/dialogs/use-dialog.ts
 * through lib/back-stack.ts); the sheets did not, so Back walked the history
 * UNDER an open sheet: the bell's sheet stayed up while Discover turned into
 * Home, and the Homeroom menu closed and took the page with it. A sheet claims
 * the next press the same way a dialog does, for as long as it is open.
 *
 * Every close hands the claim back as a NAVIGATING release, because most
 * closes here are the first half of a navigation (a row, a link, "All
 * messages"), written in the same task. lib/back-stack.ts explains why the
 * record then waits a task before it is spent.
 */

import { pushDismissible } from './back-stack';
import { adoptKitSurface } from './kit-surface';

const REGISTRY = new Set();

/**
 * The input types that are NOT text entry — a sheet opened from another
 * sheet must keep whatever control had focus, and a menu, a button or a
 * checkbox is not holding a keyboard up.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'file', 'color',
  'image', 'hidden',
]);

/** Is `el` a field a keyboard is (or would be) open for? */
function isTextField(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable === true) return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const type = typeof el.getAttribute === 'function' ? el.getAttribute('type') : null;
  return !NON_TEXT_INPUT_TYPES.has(String(type || 'text').toLowerCase());
}

/**
 * Put away the keyboard of a field BEHIND the sheet that is opening (#6813).
 *
 * iOS does not take focus from a text field when a button is tapped, so
 * opening the bell while typing left the keyboard up; the kit rides the
 * sheet on the keyboard, so the sheet opened lifted above the screen with
 * only its last row visible. A field INSIDE the sheet keeps its focus: that
 * is the sheet's own search box, and the sheet now fits above the keys.
 *
 * Every read is guarded for the sandboxed tests' minimal `document`.
 */
function blurFocusedFieldOutside(panel) {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (!isTextField(active)) return;
  if (panel && typeof panel.contains === 'function' && panel.contains(active)) return;
  if (typeof active.blur === 'function') active.blur();
}

/**
 * Dismiss every sheet built here, sparing `except`.
 *
 * Exported because the Improve panel needs it and is not built here: it has
 * its own controller (features/improve/improve-controller.js), so the
 * courtesy the registry pays automatically between sheets has to be asked
 * for by name in one direction.
 *
 * That asymmetry used to cost nothing, because the backdrop covered the
 * header: with a panel open there was no way to press another header control
 * in the first place, so nothing could stack. The backdrop starts below the
 * bar now, which makes the bar live and turns "Improve does not close the
 * others" from unreachable into one click away.
 */
export function dismissRegisteredSheets(except) {
  for (const other of REGISTRY) {
    if (other !== except) other.dismissForNav();
  }
}

/**
 * @param {object} opts
 * @param {string} opts.elementId      The sheet root's id, as the kit adopts it.
 * @param {object} opts.store          A plain-store with an `open` boolean.
 * @param {() => boolean} [opts.canOpen]  Refuse to present when this is false.
 * @param {() => void} [opts.onOpen]      Fired after a successful present.
 * @param {number} [opts.legacyCloseMs]   Must match the CSS transition.
 */
export function createSheetController({
  elementId,
  store,
  canOpen,
  onOpen,
  legacyCloseMs = 200,
  dismissSafetyMs = 500,
}) {
  const controller = {
    _sheet: null,
    _dismissWaiters: [],
    // The release for this sheet's claim on the back button, while it is open,
    // and the address it was claimed at.
    _releaseBack: null,
    _openedAt: null,

    /** Matches the root's transition duration in app.css. */
    LEGACY_CLOSE_MS: legacyCloseMs,
    /** Hard cap on the completion promise — a kit teardown that never fires
        cannot hang a chained presentation forever. */
    DISMISS_SAFETY_MS: dismissSafetyMs,

    isOpen() {
      return !!store.get().open;
    },

    toggle() {
      if (controller.isOpen()) controller.close();
      else controller.open();
    },

    open() {
      if (typeof canOpen === 'function' && !canOpen()) return;
      const panel = document.getElementById(elementId);
      if (!panel) return;
      controller._closeSiblings();
      blurFocusedFieldOutside(panel);

      if (!controller._sheet) {
        // Publish BEFORE presenting — see the header note.
        store.set({ open: true });
        const sheet = adoptSheet(panel, () => {
          controller._sheet = null;
          // A swipe or a tap on the kit's backdrop lands here without passing
          // through close(); the claim goes back the same way.
          controller._releaseBackClaim();
          store.set({ open: false, adopted: false });
          controller._resolveDismissWaiters();
        });
        if (sheet) {
          controller._sheet = sheet;
          // Adopted: the kit's own backdrop dims the scene, and it fades with
          // the sheet's spring — so the web overlay stays down. Left up, it
          // held the dim at full strength through the whole exit and only
          // faded after the teardown, which read as the background snapping
          // (and while open the two 40% backdrops stacked into an over-dim).
          // Published AFTER the present on purpose: the store flush is
          // synchronous, so the overlay's `data-open` never reaches a paint.
          // The hamburger's kit path has always skipped its overlay this way.
          store.set({ adopted: true });
          controller._claimBack();
          if (onOpen) onOpen();
          return;
        }
        // Kit refused (desktop, or no kit): the CSS slide presents instead.
      }
      store.set({ open: true });
      controller._claimBack();
      if (onOpen) onOpen();
    },

    close() {
      controller._releaseBackClaim();
      if (controller._sheet) {
        const done = controller._afterDismiss();
        controller._sheet.dismiss();
        return done;
      }
      if (!controller.isOpen()) return Promise.resolve();
      store.set({ open: false });
      const done = controller._afterDismiss();
      setTimeout(() => controller._resolveDismissWaiters(), controller.LEGACY_CLOSE_MS);
      return done;
    },

    /** Close before something else takes the screen underneath. */
    dismissForNav() {
      if (controller.isOpen()) return controller.close();
      return Promise.resolve();
    },

    // Claim the next back press for as long as this sheet is up. Back closes
    // it and nothing else: the press is spent on the sheet's own record, so
    // the page underneath stays where it is.
    _claimBack() {
      if (controller._releaseBack) return;
      controller._openedAt = currentHref();
      controller._releaseBack = pushDismissible(() => {
        controller._releaseBack = null;
        controller.close();
        return true;
      });
    },

    _releaseBackClaim() {
      const release = controller._releaseBack;
      controller._releaseBack = null;
      if (release) release({ navigating: true });
    },

    _closeSiblings() {
      // ONE SWEEP, and it covers everything now. The Improve panel predated
      // the registry and was not built here, so this used to call
      // `window.Improve?.dismissForNav?.()` first, by name. The panel retired
      // (#2718 review) and `Improve.dismissForNav` forwards to the app-context
      // sheet — which IS in the registry — so the named call became either a
      // no-op or, when the app-context sheet is the one opening, an instruction
      // to close it. `except` already spares the opener; nothing else needs
      // naming.
      dismissRegisteredSheets(controller);
    },

    _afterDismiss() {
      return new Promise((resolve) => {
        controller._dismissWaiters.push(resolve);
        setTimeout(resolve, controller.DISMISS_SAFETY_MS);
      });
    },

    _resolveDismissWaiters() {
      const waiters = controller._dismissWaiters;
      controller._dismissWaiters = [];
      for (const resolve of waiters) resolve();
    },
  };

  REGISTRY.add(controller);
  return controller;
}

function currentHref() {
  try { return window.location.href; } catch (_) { return null; }
}

// ANY OTHER NAVIGATION CLOSES AN OPEN SHEET, too. The header stays live beside
// a sheet (its backdrop starts below the bar), and code can write an address
// with one up; left open, its back record would end up under the new page,
// and the next Back would close it there instead of going back. Only a
// move AWAY from the address the sheet opened at counts: the deep link that
// opened it (#notifications, rewritten to the screen underneath before the
// sheet presents) can still be delivering its own hashchange.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const closeOnNavigation = () => {
    const here = currentHref();
    for (const sheet of REGISTRY) {
      if (sheet.isOpen() && sheet._openedAt && sheet._openedAt !== here) sheet.dismissForNav();
    }
  };
  window.addEventListener('hashchange', closeOnNavigation);
  window.addEventListener('popstate', closeOnNavigation);
}

/**
 * The kit hand-off, in one place so the three sheets present identically.
 * `adoptKitSurface` is already safe to evaluate in the SSG prerender pass —
 * it gates on the kit being present — which is why it can be a plain import
 * here, exactly as ../features/app-context/app-context-controller.js had it.
 */
function adoptSheet(contentEl, onDismiss) {
  return adoptKitSurface({
    kind: 'sheet',
    contentEl,
    home: 'body',
    gate: 'touch',
    onDismiss,
  });
}
