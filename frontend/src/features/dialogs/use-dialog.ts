/**
 * Shared scaffolding for the nine shell dialogs (#1078 chunk I).
 *
 * Every one of them has the same lifecycle — open, populate, submit, dismiss —
 * and until this chunk that lifecycle was spread across three places: the
 * `hidden` toggle in `public/js/**`, the backdrop-click handler in
 * `App.bindEvents`, and the kit lift in `PlatformUI.adoptStaticModal`. This
 * hook is those three, merged, with React state as the single owner.
 *
 * ── The contract each dialog island signs ─────────────────────────────
 *
 *   * `rootRef` goes on the modal root. React renders that node's className
 *     ONCE (it is a constant string) and never again, because the kit writes
 *     `platform-modal-adopted` to it; `useStaticModal` mutates `hidden`
 *     through `classList` instead.
 *   * `open()` / `close()` are the only ways the dialog's visibility changes.
 *     They are published on `window.UsernodeReact.dialogs.<name>` so the
 *     legacy modules can still drive the dialog by name.
 *   * `backdropProps` goes on the root. It reproduces the dismiss rule every
 *     `bindEvents` handler spelled out by hand: a click on the root itself or
 *     on `[data-modal-backdrop]` closes, and a click that arrives inside the
 *     opening gesture's ghost-click window does not.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from 'react';

import { afterBackSettles, pushDismissible, type Release, type ReleaseOptions } from '../../lib/back-stack';
import { DISMISS_EDGE_TOLERANCE_PX, nearRect } from '../../lib/dismiss-edge';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { dialogCard, isDismissGuarded, useStaticModal } from '../../lib/static-modal';

export interface DialogController<T = void> {
  /** True while the dialog is presented. */
  readonly isOpen: () => boolean;
  /** Show the dialog. The payload is whatever the island's `onOpen` wants. */
  open: (payload?: T) => void;
  /** Hide the dialog and run the island's `onClose` cleanup. */
  close: () => void;
  /**
   * `close()`, for a caller that writes an address in the same task — a
   * button in the dialog that takes the viewer somewhere (#3683).
   *
   * A plain close hands its back-press claim back by spending the history
   * record it pushed, and `history.back()` is queued: the address written
   * next lands first, and the queued traversal then undoes it. That is why
   * "Open my chat with Homeroom bot" did nothing. This releases the claim
   * as a navigating one instead, so the record is spent a task later and
   * only if nothing moved (lib/back-stack.ts, QA 2026-09-24 Q16).
   *
   * A separate method rather than an option on `close`, because `close` is
   * handed to `onClick` as it is, and a click event is not an option bag.
   */
  closeForNavigation: () => void;
  /**
   * Hide the dialog WITHOUT running `onClose`, and show it again with
   * `resume()` without running `onOpen`.
   *
   * One caller: the feedback dialog's screenshot capture, which has to get
   * itself out of the photograph and then come back with the user's draft
   * intact. `close()` there would clear the very text the screenshot is being
   * attached to. Before this chunk it wrote `hidden` on the root directly and
   * `adoptStaticModal`'s observer turned that into a dismiss + re-present;
   * this is the same round trip with React in the loop.
   *
   * Resolves once the dialog is actually OFF SCREEN (#2346). Hiding is not
   * instant: the kit plays its exit animation over the card and only removes
   * it at the end, so a caller that photographs the page the moment this
   * returns photographs the dialog fading out. Resolves at once when there
   * was nothing presented to animate, and early on `resume()`, `open()` or
   * unmount — a caller never waits on an exit that is not coming. Callers
   * that only want the dialog hidden can ignore it, as before.
   */
  suspend: () => Promise<void>;
  /** Undo `suspend()`. */
  resume: () => void;
}

export interface UseDialogOptions<T> {
  /**
   * Ran in a layout effect after the root is revealed and the card has been
   * lifted into the kit shell, with whatever `open()` was passed.
   *
   * Layout, not a plain effect, for the same reason the reveal is: this is
   * where a dialog fills its fields, and doing it a frame later shows the
   * user the previous open's values first.
   */
  onOpen?: (payload: T | undefined) => void;
  /** Ran after the dialog is hidden — field resets, aborted requests. */
  onClose?: () => void;
  /**
   * Refuse to close. `import-pr` uses this while its POST is in flight: a
   * dismiss mid-request strands the user with an import they cannot see the
   * outcome of.
   */
  canClose?: () => boolean;
  /**
   * Present as a bottom sheet on a phone instead of the kit's centred modal
   * (lib/static-modal.ts `phoneSheet`). Only the feedback dialog sets it;
   * desktop and narrow desktop windows keep the modal.
   */
  phoneSheet?: boolean;
}

export interface UseDialogResult<T> {
  rootRef: React.RefObject<HTMLDivElement | null>;
  isOpen: boolean;
  open: (payload?: T) => void;
  close: () => void;
  closeForNavigation: () => void;
  /**
   * Close this dialog and open the next surface once the close's history
   * record has been spent. A plain `close()` spends it with a queued
   * `history.back()`, and opening the next surface in the same task pushes a
   * record on top of it; the traversal then lands and is read as a Back
   * press, closing what just opened (#5801, the "Who can see & change it"
   * sheet from App settings and Members). A close the dialog vetoes
   * (`canClose`) opens nothing.
   *
   * Not on the published `DialogController`: no legacy caller hands off.
   */
  closeThen: (next: () => void) => void;
  suspend: () => Promise<void>;
  resume: () => void;
  backdropProps: {
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onClick: (event: MouseEvent<HTMLElement>) => void;
  };
}

export function useDialog<T = void>(
  name: string,
  options: UseDialogOptions<T> = {},
): UseDialogResult<T> {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const payloadRef = useRef<T | undefined>(undefined);
  const opts = useRef(options);
  opts.current = options;

  // The same distinction, but held until the kit's EXIT lands rather than
  // being consumed by the next effect pass.
  //
  // `bookkeeping` is read by a layout effect on the close tick, which was
  // enough while onClose ran there too. It no longer does — the teardown waits
  // for the exit animation now — and a suspend's exit callback arrives long
  // after that pass, with the screenshot round trip still in progress. Without
  // this the feedback dialog's draft would be reset out from under the
  // screenshot it is being attached to, which is the exact bug suspend/resume
  // exists to prevent.
  const suspended = useRef(false);

  // Whoever is waiting on a suspension's exit — see DialogController.suspend.
  // Settled by the exit landing, and by every event that means it never will:
  // a resume or open that retires the outgoing presentation (its late callback
  // is then dropped by useStaticModal's generation guard), or an unmount.
  const exitWaiters = useRef<Array<() => void>>([]);
  const settleExitWaiters = useCallback(() => {
    const waiting = exitWaiters.current;
    exitWaiters.current = [];
    for (const resolve of waiting) resolve();
  }, []);

  // THE DEVICE BACK BUTTON (#1521). A dialog is React state with no history
  // entry, so a back press used to fall straight past it — on Android to the
  // native shell, which now exits at its root, which would close the whole app
  // while the viewer was only dismissing a dialog. `pushDismissible` claims
  // the next press for as long as this dialog is up; lib/back-stack.ts carries
  // the reasoning and the history bookkeeping.
  //
  // Hung off open/close rather than an effect on `isOpen`, because
  // suspend/resume move that flag WITHOUT being a lifecycle event (a
  // screenshot round trip). Those must not spend or claim a back press: the
  // dialog the viewer is looking at has not gone anywhere.
  const releaseBack = useRef<Release | null>(null);

  const open = useCallback((payload?: T) => {
    payloadRef.current = payload;
    // An ordinary open ends any suspension: whatever the round trip was, this
    // presentation is a fresh one and owns its own teardown.
    suspended.current = false;
    settleExitWaiters();
    if (!releaseBack.current) {
      releaseBack.current = pushDismissible(() => {
        // Answering false leaves the claim in place, so a dialog guarding
        // unsaved work keeps the NEXT press too rather than handing it on.
        if (opts.current.canClose && !opts.current.canClose()) return false;
        releaseBack.current = null;
        setIsOpen(false);
        return true;
      });
    }
    setIsOpen(true);
  }, [settleExitWaiters]);

  const dismiss = useCallback((options?: ReleaseOptions): boolean => {
    if (opts.current.canClose && !opts.current.canClose()) return false;
    // Dismissed by ✕, the backdrop or a caller rather than by back: hand the
    // claim back so the next press reaches whatever is underneath.
    const release = releaseBack.current;
    releaseBack.current = null;
    release?.(options);
    setIsOpen(false);
    return true;
  }, []);
  const close = useCallback(() => dismiss(), [dismiss]);
  // The caller writes an address next — see DialogController.closeForNavigation.
  const closeForNavigation = useCallback(() => dismiss({ navigating: true }), [dismiss]);
  // Close, then open the next surface once this close's record is spent.
  const closeThen = useCallback((next: () => void) => {
    if (dismiss()) afterBackSettles(next);
  }, [dismiss]);

  // A visibility change that is bookkeeping rather than a lifecycle event —
  // see DialogController.suspend. The flag is consumed by the single effect
  // pass it schedules, so an ordinary open/close either side of it still runs
  // its half.
  const bookkeeping = useRef(false);
  const suspend = useCallback(() => {
    bookkeeping.current = true;
    suspended.current = true;
    setIsOpen(false);
    // Not on screen, so there is no exit to wait for. (`openRef` is declared
    // below; this runs long after render.)
    if (!openRef.current) return Promise.resolve();
    return new Promise<void>((resolve) => {
      exitWaiters.current.push(resolve);
    });
  }, []);
  const resume = useCallback(() => {
    bookkeeping.current = true;
    suspended.current = false;
    setIsOpen(true);
    settleExitWaiters();
  }, [settleExitWaiters]);

  // The live open state, readable from a callback that fires outside React's
  // render cycle — the kit's exit lands up to 300ms after the close.
  const openRef = useRef(false);
  openRef.current = isOpen;

  // Unmounted mid-suspension: no exit will ever be reported to this hook.
  useEffect(() => settleExitWaiters, [settleExitWaiters]);

  useStaticModal(rootRef, isOpen, {
    phoneSheet: opts.current.phoneSheet,
    // A suspension's own exit landing is not the viewer dismissing anything —
    // the dialog is on its way back. Passing it to close() would release the
    // back-press claim mid-round-trip, and resume() does not take it again, so
    // the restored dialog would no longer answer the back button. Every native
    // capture now waits for this exit, so it always lands mid-round-trip.
    onKitDismiss: () => {
      if (!suspended.current) close();
    },
    // The card stays on screen for the whole exit animation now, so teardown
    // that empties it has to wait for the end of that animation rather than
    // running on the close tick — otherwise the dialog visibly blanks while it
    // is still sliding away. See StaticModalOptions.onExited.
    onExited: () => {
      // The surface is gone, whatever happens next — a suspend() caller can
      // go ahead now.
      settleExitWaiters();
      // Reopened while the exit was still playing: onOpen has already
      // repopulated the card, and this teardown belongs to the presentation it
      // replaced. Running it would wipe what the viewer is now looking at.
      if (openRef.current) return;
      // Mid-round-trip (a screenshot capture): the dialog is coming back with
      // its draft intact, so this close is bookkeeping and has no teardown.
      if (suspended.current) return;
      opts.current.onClose?.();
    },
    // A `public/js/**` straggler wrote `hidden` directly. Mirror it into
    // state so React, the kit and the DOM cannot disagree — see
    // StaticModalOptions.onExternalToggle.
    onExternalToggle: (nowOpen) => setIsOpen(nowOpen),
  });

  // Populate on the way in. Skips the mount pass: `isOpen` starts false and
  // the prerendered markup is already hidden, so there is no stale open.
  //
  // Layout, and declared after `useStaticModal` above, so the order within a
  // single pass is: reveal → lift into the kit shell → populate. A passive
  // effect would paint the previous open's values for a frame first.
  //
  // The matching `onClose` is NOT here any more: it emptied the card on the
  // close tick, which was invisible only for as long as the card was yanked
  // out of sight on that same tick. It rides the exit now, so its teardown
  // runs from `onExited` above.
  const mounted = useRef(false);
  useIsomorphicLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (bookkeeping.current) {
      bookkeeping.current = false;
      return;
    }
    if (isOpen) opts.current.onOpen?.(payloadRef.current);
  }, [isOpen]);

  // The press that may have opened the click that follows it. A click carries
  // no history of where the finger went down, so the decision below needs it
  // recorded first: a press inside the card released on the backdrop fires
  // the click on their common ancestor — the backdrop — and used to dismiss
  // the dialog mid-selection (#6475).
  const backdropProps = useMemo(() => {
    let press: { onBackdrop: boolean; x: number; y: number } | null = null;
    return {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        const target = event.target as HTMLElement;
        const isBackdrop =
          target === event.currentTarget || target.dataset?.modalBackdrop !== undefined;
        press = { onBackdrop: isBackdrop, x: event.clientX, y: event.clientY };
      },
      onClick: (event: MouseEvent<HTMLElement>) => {
        const started = press;
        press = null;
        const target = event.target as HTMLElement;
        const isBackdrop =
          target === event.currentTarget || target.dataset?.modalBackdrop !== undefined;
        if (!isBackdrop) return;
        if (isDismissGuarded(rootRef.current)) return;
        // A pointer click that did not begin on the backdrop is a release from
        // inside the card — a text selection, a small slip — and is never a
        // dismissal. A click with no pointer sequence of its own (programmatic,
        // or assistive technology) keeps the decision it had.
        if (event.detail > 0 && !(started && started.onBackdrop)) return;
        // A tap on the card, or within a finger's width of its edge, is ON the
        // card however the browser retargeted the click.
        const card = dialogCard(rootRef.current);
        if (card) {
          const rect = card.getBoundingClientRect();
          const insideCard = (x: number, y: number) =>
            nearRect(x, y, rect, DISMISS_EDGE_TOLERANCE_PX);
          if (insideCard(event.clientX, event.clientY)) return;
          if (started && insideCard(started.x, started.y)) return;
        }
        close();
      },
    };
  }, [close]);

  // Publish the controller for `public/js/**`. The legacy entry points
  // (`App.showCreateModal`, `AppView.promptRename`, …) forward here.
  const controller = useMemo<DialogController<T>>(
    () => ({
      isOpen: () => !!rootRef.current && !rootRef.current.classList.contains('hidden'),
      open,
      close,
      closeForNavigation,
      suspend,
      resume,
    }),
    [open, close, closeForNavigation, suspend, resume],
  );
  useEffect(() => {
    const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
    const bridge = (host.UsernodeReact ||= {});
    const dialogs = (bridge.dialogs ||= {}) as Record<string, unknown>;
    dialogs[name] = controller;
    return () => {
      if (dialogs[name] === controller) delete dialogs[name];
    };
  }, [name, controller]);

  return { rootRef, isOpen, open, close, closeForNavigation, closeThen, suspend, resume, backdropProps };
}
