/**
 * The static-modal adoption seam, brought inside React (#1078 chunk I).
 *
 * ── What this replaces ────────────────────────────────────────────────
 *
 * Until this chunk, `PlatformUI.adoptStaticModal` (public/js/platform-ui.js)
 * owned every one of the nine shell dialogs. It kept a hard-coded
 * `STATIC_MODAL_IDS` list, put a MutationObserver on each root's class list,
 * and when `hidden` came off it LIFTED THE CARD OUT of the root — swapping in
 * a comment placeholder — into the kit's `presentModal` shell.
 *
 * That is why every dialog had to stay markup-only: two owners wrote to the
 * same nodes, and the one React did not control moved React's DOM out from
 * under it. The lift now lives here, driven by React state, so there is
 * exactly one owner. `useStaticModal` is the whole seam; the dialog islands
 * hold the `open` state and this hook makes the DOM agree with it.
 *
 * ── Why a hook and not a kit-backed <Dialog> primitive ────────────────
 *
 * There IS a `Dialog` primitive now — `@/components/ui/dialog` — but it is a
 * chassis for the backdrop root and the card, not a presentation seam, and
 * it renders in place. That is the distinction this note is about: a
 * kit-backed primitive would have to render the card through a portal into a
 * container the kit owns. Two things in this repo rule that out:
 *
 *   1. The prerendered public/index.html must contain each card in its
 *      original place, inside `[data-modal-backdrop]`, with the same ids and
 *      class strings — `tests/baselines/shell-markup.json` and the 335
 *      dapp.json selector chains are written against exactly that tree.
 *      `renderToStaticMarkup` does not emit portal content, so a portal-based
 *      primitive would ship an empty backdrop.
 *   2. `presentModal` takes a `contentEl` it physically moves. Whatever React
 *      renders has to survive being relocated, which a portal container does
 *      not make any easier than the real card does.
 *
 * So the card stays where the shell put it and this hook performs the same
 * lift the legacy adopter did. That is safe for React for one specific
 * reason, and it is the reason every dialog renders its full structure
 * unconditionally: React only ever touches a node's PARENT when it inserts,
 * removes or reorders that node. The card is always mounted and never keyed
 * differently, so after hydration React never touches the backdrop's child
 * list again — every update lands inside the card, which the kit moves whole.
 *
 * ── Why not route on PlatformUI.isTouch() ─────────────────────────────
 *
 * `isTouch()` is the platform's usual sheet-vs-popover discriminator, but the
 * legacy adopter never consulted it: `adoptAll` gated on `kit()` alone, so
 * desktop browsers with the kit loaded got the presented modal too. Routing
 * on `isTouch()` here would change desktop presentation for all nine dialogs,
 * which this chunk is explicitly not allowed to do. The gate is kit presence,
 * exactly as before; `hasKit()` is the predicate.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';

import { adoptKitSurface, type KitAdoption } from './kit-surface';
import { useIsomorphicLayoutEffect } from './legacy-dom';

/**
 * The gesture guard `AppView.revealModal` used to stamp.
 *
 * A tap that opens a dialog on touch produces a trailing ghost click ~300ms
 * later, which lands on the freshly-revealed backdrop and closes it again.
 * Every backdrop handler ignores dismissals that arrive within this window of
 * the open, by reading `dataset.openedAt`. The stamp moves here so it happens
 * on the same tick as the reveal for every dialog, rather than only the ones
 * whose open path remembered to call `revealModal`.
 */
export const MODAL_GESTURE_GUARD_MS = 450;

/** True while `root` is still inside its opening gesture's ghost-click window. */
export function isDismissGuarded(root: HTMLElement | null | undefined): boolean {
  const at = root?.dataset ? Number(root.dataset.openedAt) : 0;
  return at > 0 && Date.now() - at < MODAL_GESTURE_GUARD_MS;
}

/**
 * Present a dialog root's card inside the kit modal shell.
 *
 * The lift itself is `adoptKitSurface` — the same adopt / roll back / restore
 * the dev console, the hamburger drawer and the work drawer go through. What
 * is specific to the dialogs, and therefore still here, is which node the kit
 * takes (the CARD, not the root), where the class goes (the root, which is
 * what `app.css` keys the legacy scrim off), that the card must return to its
 * exact position rather than to `<body>`, and that the gate is kit presence
 * rather than touch.
 *
 * `stillOwns` is the guard against a LATE dismissal from a presentation that
 * has already been replaced. `presentModal().dismiss()` finishes its exit
 * animation before it calls back — `transitionend`, or a 300ms fallback timer
 * — so a dialog that closes and reopens inside that window has two live
 * presentations for a moment, and the older one's `onDismiss` would otherwise
 * tear down the newer one's adoption (and run its island's onClose). The
 * feedback dialog does exactly that on every mobile screenshot attempt that
 * fails fast: suspend, capture, resume (#1284). The hamburger drawer got the
 * same guard in #977; this is the dialogs' copy of it.
 */
function present(
  root: HTMLElement,
  onDismiss: () => void,
  stillOwns: () => boolean,
): KitAdoption | null {
  const backdrop = root.querySelector('[data-modal-backdrop]');
  const card = ((backdrop && backdrop.firstElementChild) || root.firstElementChild) as
    | HTMLElement
    | null;
  if (!card) return null;

  return adoptKitSurface({
    kind: 'modal',
    contentEl: card,
    adoptedOn: root,
    home: 'placeholder',
    gate: 'kit',
    hugDesignWidth: true,
    stillOwns,
    // THE ROOT GOES HIDDEN BEFORE THE CARD COMES HOME (#2223).
    //
    // On a KIT-initiated dismissal — a backdrop tap, Escape, the kit's own
    // control — React does not know the dialog is closing. Its close branch,
    // which is what writes `hidden` here, has not run: `open` is still true.
    // The kit finishes its exit, calls onDismiss, and adoptKitSurface's
    // `undo()` re-homes the card into a root that is still VISIBLE. The card
    // lands back in place at full opacity and paints, until React catches up
    // a frame or two later and hides it.
    //
    // Measured in Chromium against the real kit, tracking the card's painted
    // visibility through a backdrop-tap close of the feedback dialog:
    //
    //   t=  5ms  visible   in the kit shell, root not hidden
    //   t=154ms  gone      the kit's fade has finished
    //   t=195ms  VISIBLE   undo() re-homed it into the un-hidden root
    //   t=212ms  gone      React's state finally caught up
    //
    // Seventeen milliseconds of the whole dialog, at full opacity, AFTER the
    // animation has played — which is the reported flash. Closing through
    // `controller.close()` never shows it, because that path hides the root
    // on the way in; only the kit's own dismissal does, and that is the one
    // a person actually uses.
    //
    // adoptKitSurface calls this immediately before `undo()`, so hiding here
    // means the restore lands in an already-hidden root and paints nothing.
    // On the React-initiated path the root is hidden already and this is a
    // no-op. The class write is also what `onExternalToggle` watches, so it
    // pulls React's own state to closed a beat sooner rather than fighting
    // it — the two converge on the same end state.
    onDismissStart: () => {
      if (!root.classList.contains('hidden')) root.classList.add('hidden');
    },
    onDismiss,
  });
}

/**
 * Give the kit's modal shell an accessible name (QA 2026-09-24 Q20).
 *
 * The shell is what carries `role="dialog"` and `aria-modal` — the kit makes
 * it, not the dialog — so the dialog's own heading was never its name, and a
 * screen reader announced an unnamed dialog. The name is the card's first
 * heading: by reference when it has an id, so a title that changes while the
 * dialog is up (Create's "Create a new app" / "Import existing app") is read
 * as it is now; by its text otherwise. The shell is a node the kit created and
 * owns, never one React rendered, so this write has nothing to reconcile with.
 */
function nameKitShell(adoption: KitAdoption | null): void {
  const shell = adoption?.handle?.el as HTMLElement | null | undefined;
  const card = adoption?.contentEl;
  if (!shell || !card || typeof shell.setAttribute !== 'function') return;
  if (shell.hasAttribute?.('aria-labelledby') || shell.hasAttribute?.('aria-label')) return;
  const heading = typeof card.querySelector === 'function'
    ? card.querySelector('h1, h2, h3') as HTMLElement | null
    : null;
  if (!heading) return;
  if (heading.id) shell.setAttribute('aria-labelledby', heading.id);
  else {
    const text = (heading.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) shell.setAttribute('aria-label', text);
  }
}

/** How long the sheet's slide-up runs (app.css's `[data-dialog-sheet]` rule). */
export const SHEET_TRANSITION_MS = 200;

/**
 * The keyboard handling's own phone test (lib/keyboard-open.ts `PHONE_QUERY`),
 * inlined rather than imported: importing that module would run its keyboard
 * tracker on load, and a dialog presenting has no business starting it (a
 * second set of listeners in the app, and the dialogs' own tests mount with a
 * bare document).
 */
const PHONE_QUERY = '(max-width: 767px) and (pointer: coarse)';

/** Whether this screen presents sheets: the keyboard's own phone test. */
function isPhoneViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try { return !!window.matchMedia(PHONE_QUERY).matches; } catch { return false; }
}

/**
 * The card of a dialog root: the first element inside `[data-modal-backdrop]`,
 * or the root's own first element for a `centered` layout.
 *
 * Exported for `use-dialog.ts`, whose backdrop rule grows this box by a
 * finger's width so a near-edge tap counts as a tap on the dialog (#6475).
 * Until the kit lifts the card out, this is the same node `present()` hands
 * it; a sheet-mode or no-kit presentation leaves it right here.
 */
export function dialogCard(root: HTMLElement | null | undefined): HTMLElement | null {
  if (!root) return null;
  const backdrop = root.querySelector('[data-modal-backdrop]');
  return ((backdrop && backdrop.firstElementChild) || root.firstElementChild) as HTMLElement | null;
}

/**
 * Present the card as a bottom sheet: the attributes app.css keys on, the
 * accessible name the kit shell would have carried (nameKitShell's rule), and
 * the slide-up a frame after the reveal. No kit is involved, so nothing is
 * lifted and nothing has to be restored — the card never leaves its root.
 */
function presentSheet(root: HTMLElement, stillOwns: () => boolean): void {
  const card = dialogCard(root);
  if (!card) return;
  root.dataset.dialogSheet = '';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  const heading = typeof card.querySelector === 'function'
    ? card.querySelector('h1, h2, h3') as HTMLElement | null
    : null;
  if (heading?.id) card.setAttribute('aria-labelledby', heading.id);
  else {
    const text = (heading?.textContent || '').replace(/\s+/g, ' ').trim();
    if (text) card.setAttribute('aria-label', text);
  }
  const raf = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (fn: () => void) => setTimeout(fn, 16);
  raf(() => { if (stillOwns()) root.dataset.dialogSheetShown = ''; });
}

/** Take the sheet presentation off again: the card goes back to bare markup. */
function unnameSheet(root: HTMLElement): void {
  const card = dialogCard(root);
  if (!card) return;
  card.removeAttribute('role');
  card.removeAttribute('aria-modal');
  card.removeAttribute('aria-labelledby');
  card.removeAttribute('aria-label');
}

export interface StaticModalOptions {
  /**
   * Called when the KIT dismissed the modal on its own — backdrop tap or
   * Escape. The island turns this into `setOpen(false)` so React state stays
   * the source of truth; the hook has already restored the DOM by then.
   *
   * The legacy adopter had to synthesize a click on `[data-modal-backdrop]`
   * here, because the per-modal cleanup only existed inside those handlers.
   * Now that the dialogs own their own state, the close path is just the
   * state update, so the synthetic click is gone.
   */
  onKitDismiss?: () => void;
  /**
   * Called once the surface is fully gone: after the kit's exit animation has
   * finished and the card is home, or synchronously on a close with no kit
   * presentation to animate.
   *
   * This is where teardown that CHANGES WHAT THE CARD SHOWS belongs — clearing
   * fields, resetting status lines. Now that the card stays visible through
   * the exit (see the close branch below), doing that on the close tick would
   * blank the dialog's contents in front of the viewer mid-animation, which is
   * the same flicker moved rather than fixed.
   */
  onExited?: () => void;
  /**
   * Called when something OUTSIDE React toggled `hidden` on the root.
   *
   * This is the legacy-compatibility bridge, and it is deliberately narrow:
   * it does not present anything itself, it only reports the class write so
   * the island can reconcile its state. Any `public/js/**` straggler that
   * still does `getElementById('…-modal').classList.remove('hidden')` — an
   * error path, a deep link, a module this chunk did not convert — therefore
   * still opens the dialog, through React, with the kit lift applied.
   */
  onExternalToggle?: (open: boolean) => void;
  /**
   * On a phone, present the card as a bottom sheet instead of lifting it
   * into the kit's centred modal (`app.css`'s `[data-dialog-sheet]` rules).
   *
   * The kit's own sheet is not usable for a form: `.un-sheet` takes every
   * vertical drag as a drag of the sheet, so the card could not scroll its
   * fields (profile-edit-sheet.tsx explains it). So the sheet here is the
   * card itself, left in its root, bottom-anchored by CSS, and slid up by
   * two runtime attributes written a frame apart. `app.css` sizes it against
   * the keyboard's band (`.platform-kb-sheet`'s arithmetic), and
   * `useKeyboardSurface` on the card does the rest of the keyboard work.
   *
   * Only the feedback dialog sets it. Escaped on any screen where
   * `PHONE_QUERY` does not match, so a narrow desktop window keeps the
   * centred modal it has always had.
   */
  phoneSheet?: boolean;
}

/**
 * Make a dialog root's presentation follow React state.
 *
 * `open` drives three things, in this order, all in a layout effect so the
 * class is right before the browser paints (a deferred toggle flashes the
 * dialog at its hidden state first):
 *
 *   1. the `openedAt` gesture stamp,
 *   2. `hidden` on the root, mutated through `classList` — never a rendered
 *      `className`, because the kit writes `platform-modal-adopted` to this
 *      same node and React would blow it away on the next re-render,
 *   3. the kit lift.
 */
export function useStaticModal(
  rootRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: StaticModalOptions = {},
): void {
  const adoptionRef = useRef<KitAdoption | null>(null);
  // Whether the presentation on screen is the phone sheet rather than the
  // kit lift — decided at open, kept for the close, so a matchMedia flip
  // mid-dialog cannot change how it leaves.
  const sheetRef = useRef(false);
  // Bumped on EVERY open/close transition, so each presentation can recognise
  // its own teardown and ignore one that arrived after it was replaced — see
  // `present`'s note on `stillOwns`.
  const generationRef = useRef(0);
  const opts = useRef(options);
  opts.current = options;

  // An adoption whose kit shell is mid-exit: dismissed, animating, and not yet
  // re-homed. See the close branch below for why the restore waits.
  const pendingExitRef = useRef<KitAdoption | null>(null);
  // Whether this surface has ever actually been presented.
  //
  // THE MOUNT PASS IS NOT AN EXIT. `open` starts false, so the layout effect
  // below runs its close branch once on mount for a dialog that has never been
  // on screen — and firing `onExited` there ran the dialogs' teardown against
  // a controller module whose init() has not run yet, which threw on every
  // route in the shell. (The old arrangement was immune by accident: the
  // teardown lived behind use-dialog's own mount guard. Moving it onto the
  // exit moved it out from behind that guard.)
  const everOpenRef = useRef(false);

  const dismissFromKit = useCallback(() => {
    const adoption = adoptionRef.current || pendingExitRef.current;
    adoptionRef.current = null;
    pendingExitRef.current = null;
    // `adoptKitSurface` has already restored the DOM by the time it calls us;
    // this is the idempotent second call that covers the paths that have not.
    if (adoption) adoption.restore();
    opts.current.onExited?.();
    opts.current.onKitDismiss?.();
  }, []);

  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    if (open) {
      root.dataset.openedAt = String(Date.now());
      // Reopened while the last exit was still animating. Finish that exit NOW
      // rather than presenting on top of it: the card is currently a child of
      // the outgoing kit shell, and lifting it again from there would strand
      // the first presentation's placeholder comment in this root forever.
      const pending = pendingExitRef.current;
      if (pending) {
        pendingExitRef.current = null;
        pending.restore();
      }
      everOpenRef.current = true;
      if (root.classList.contains('hidden')) root.classList.remove('hidden');
      if (!adoptionRef.current) {
        // Bumping here also retires any generation still owned by that
        // outgoing presentation, so its late callback lands as a no-op.
        const generation = (generationRef.current += 1);
        const stillOwns = () => generationRef.current === generation;
        if (opts.current.phoneSheet && isPhoneViewport()) {
          sheetRef.current = true;
          presentSheet(root, stillOwns);
        }
        if (!sheetRef.current) {
          adoptionRef.current = present(root, dismissFromKit, stillOwns);
          nameKitShell(adoptionRef.current);
        }
      }
    } else {
      if (sheetRef.current) {
        // THE PHONE SHEET SLIDES OUT. The card never left this root, so the
        // hide waits for the slide-down app.css plays once `-shown` goes
        // (cut short under reduced motion) — then teardown runs. A reopen
        // inside the wait retires it through the generation bump in the open
        // branch above, exactly as a kit exit is retired. Its own branch,
        // rather than a flag through the kit path below: the no-kit exit
        // there is gated on everOpenRef alone (tests/dialog-behaviour.test.js
        // pins that gate), and a sheet must never take it — its exit is the
        // slide-down, not the close tick.
        sheetRef.current = false;
        const generation = (generationRef.current += 1);
        const stillOwns = () => generationRef.current === generation;
        delete root.dataset.dialogSheetShown;
        const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        setTimeout(() => {
          if (!stillOwns()) return;
          root.classList.add('hidden');
          delete root.dataset.dialogSheet;
          unnameSheet(root);
          opts.current.onExited?.();
        }, reduced ? 0 : SHEET_TRANSITION_MS);
      } else {
        const adoption = adoptionRef.current;
        adoptionRef.current = null;
        if (adoption) {
          // THE CARD RIDES THE EXIT, and the order here is the whole reason it
          // does. This used to restore() before dismiss(), on the reasoning
          // recorded on KitAdoption.restore — that a caller closing the surface
          // wants its node back before the kit animates an empty shell. The
          // visible result was the trade in reverse: the dialog's contents
          // vanished on the spot, and what played the 260ms exit was the kit's
          // shell collapsed to its own padding — a small blank rounded box
          // fading out where the dialog had been. That is the close flicker.
          //
          // So only dismiss() here. The kit removes the card at the END of its
          // animation and calls onDismiss, which is what runs undo() and puts
          // the node home (see adoptKitSurface). Holding the adoption in
          // pendingExitRef keeps that callback's `stillOwns` generation valid
          // until it lands — which is why the generation bump moved into the
          // open branch above, where a reopen is what should retire it.
          pendingExitRef.current = adoption;
          adoption.dismiss();
        } else if (everOpenRef.current) {
          // No kit: nothing animates, so the surface is already gone. Gated on
          // having been open, or the mount pass would report an exit for a
          // dialog that has never been presented — see everOpenRef above.
          opts.current.onExited?.();
        }
        // Safe to hide immediately either way: the card is not in this root
        // while it is adopted, it is in the kit's shell.
        if (!root.classList.contains('hidden')) root.classList.add('hidden');
      }
    }
  }, [rootRef, open, dismissFromKit]);

  // Legacy-compatibility bridge — see StaticModalOptions.onExternalToggle.
  // Watching `class` is what the retired adopter did too, but this observer
  // has no side effect of its own: it reports, React decides.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const observer = new MutationObserver(() => {
      const nowOpen = !root.classList.contains('hidden');
      if (nowOpen !== open) opts.current.onExternalToggle?.(nowOpen);
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [rootRef, open]);

  // A dialog that unmounts while presented would otherwise leave the kit
  // shell on screen with a detached card in it.
  //
  // Unlike an ordinary close, this one restores EAGERLY and retires the
  // generation on the spot: there is no longer a component to animate an exit
  // for, and the node has to be back under its placeholder before React
  // removes the subtree around it. A pending exit is finished the same way,
  // for the same reason.
  useEffect(
    () => () => {
      const adoption = adoptionRef.current || pendingExitRef.current;
      adoptionRef.current = null;
      pendingExitRef.current = null;
      if (adoption) {
        adoption.restore();
        adoption.dismiss();
      }
      generationRef.current += 1;
    },
    [],
  );
}
