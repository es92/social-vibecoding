/**
 * The card's ⋯ overflow menu, as a view model.
 *
 * ── The host is the module's, the rows are React's ────────────────────
 *
 * `public/js/app-view.js` creates the floating element, appends it to
 * `document.body`, places it against the trigger, owns the dismissers, and —
 * the interesting part — RE-ANCHORS it after a board repaint. Every repaint
 * replaces `#dev-body`, and the board repaints on its own schedule (the
 * session poll, the headless poll, every websocket push), so the menu survives
 * by finding its successor trigger by key and re-filling its rows in place.
 * That is why the rows are a publish and not a re-mount: the click listener is
 * bound ONCE on the host, and it has to keep working across every refresh.
 *
 * ── Descriptors were already the design ───────────────────────────────
 *
 * A card registers `{ label, title, icon, disabled, danger, act }` under a
 * stable key and emits a trigger carrying it; one delegated handler looks the
 * list up and presents it. That existed so the same list could render as an
 * anchored dropdown on a pointer device and as a native action sheet on touch.
 * This adds a third consumer of the same descriptors and takes nothing away:
 * `act` never crosses into React — the row publishes its INDEX and the module
 * calls the handler, which is what keeps the "read the CURRENT descriptor
 * list, not the one captured when the menu opened" rule intact.
 */

import { createStore } from '../../lib/plain-store.js';

export interface CardMenuRowView {
  /** The row text, and the button's whole accessible name. */
  label: string;
  /** Tooltip, or the reason a disabled row is disabled. */
  title: string | null;
  /**
   * The row's icon, a key of AppView.MENU_ICONS drawn by ./menu-icons.tsx —
   * decorative, `aria-hidden`, never part of the name.
   */
  icon: string;
  /**
   * The descriptor's icon KEY, which doubles as a stable hook for the row's
   * meaning: `?shot=card-menu&row=assignee` aims at it and a dapp.json test
   * asserts on it, neither of which should have to match wording that changes
   * with the card's state.
   */
  row: string | null;
  disabled: boolean;
  /** Archive, Withdraw, Undo — a red row. */
  danger: boolean;
}

export interface CardMenuState {
  rows: CardMenuRowView[];
}

export const EMPTY_CARD_MENU: CardMenuState = { rows: [] };

export const cardMenuStore = createStore<CardMenuState>(EMPTY_CARD_MENU);
