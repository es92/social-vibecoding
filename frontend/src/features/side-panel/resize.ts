/**
 * The side panel's WIDTH (#2886) — the divider between a running app and the
 * panel beside it can be dragged, and the width it is left at is this
 * device's from then on.
 *
 * ── One knob, the one the layout already has ─────────────────────────
 *
 * public/css/app.css sizes both halves off `--side-panel-w`: the panel is that
 * wide, and `html[data-side-panel] #app-view` takes it as a right margin. So a
 * chosen width is that property, written inline on <html> — which is not
 * React-owned (main.tsx hydrates <body>), the same reason mount.ts writes
 * `data-side-panel` there directly. With nothing chosen the property is
 * absent and the stylesheet's `clamp(360px, 36vw, 560px)` answers, exactly as
 * before this existed.
 *
 * ── Neither half can be dragged unusably small ────────────────────────
 *
 * The panel keeps MIN_PANEL_W: its document takes its phone layout, and below
 * a phone's width that layout stops fitting. The app keeps MIN_APP_W — the
 * figure app.css already floors `#app-view` at while the panel is up — so the
 * widest the panel can go is the window, less whatever sits left of the app
 * (the rail), less that. The bound is re-read on every use, so a window that
 * narrows gives a remembered width back instead of letting it squeeze the app.
 *
 * ── Per device, and never trusted blindly ─────────────────────────────
 *
 * localStorage, one number. Every read and write is wrapped: storage can be
 * absent, full, or throw on access (a private window, blocked site data), and
 * any of those is simply "the default width". A stored value is clamped to
 * the current window before it is applied; it is never rewritten by a clamp,
 * so a window that grows back gets the chosen width back too.
 */

/** localStorage key for the chosen width, in CSS pixels. */
export const WIDTH_KEY = 'usernode_side_panel_w_v1';

/** The narrowest the panel may be dragged. */
export const MIN_PANEL_W = 320;

/** The narrowest the app beside it may be left (app.css's `min-width: 480px`). */
export const MIN_APP_W = 480;

/** One arrow-key press; Shift moves four times as far. */
export const KEY_STEP = 16;

export interface WidthBounds {
  min: number;
  max: number;
}

/** What `bounds` reads, so it can be driven without a browser. */
export interface LayoutProbe {
  innerWidth: number;
  /** Where the app view begins from the window's left edge (the rail's width). */
  appLeft: number;
}

/** The range the panel's width may take in this window. */
export function bounds(probe: LayoutProbe): WidthBounds {
  const room = Math.floor(probe.innerWidth - Math.max(0, probe.appLeft) - MIN_APP_W);
  return { min: MIN_PANEL_W, max: Math.max(MIN_PANEL_W, room) };
}

/** `width`, held inside `b` and rounded to a whole pixel. */
export function clampWidth(width: number, b: WidthBounds): number {
  return Math.round(Math.min(b.max, Math.max(b.min, width)));
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The width this device chose, or null for the default. */
export function readStoredWidth(store: StorageLike | null = storage()): number | null {
  try {
    const raw = store ? store.getItem(WIDTH_KEY) : null;
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeStoredWidth(width: number, store: StorageLike | null = storage()): void {
  try {
    if (store) store.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    /* a width that does not survive a reload is the default next time */
  }
}

export function clearStoredWidth(store: StorageLike | null = storage()): void {
  try {
    if (store) store.removeItem(WIDTH_KEY);
  } catch {
    /* nothing stored, or nowhere to store it: the default either way */
  }
}

/**
 * Apply `width` to the layout, or null to hand it back to the stylesheet.
 * `--side-panel-chosen-w` is the same width, set only while one is chosen:
 * the Homeroom bot page's Main takes the room its list does not need when
 * nothing is chosen (app.css `--ai-main-auto`), and the stylesheet's
 * `--side-panel-w` cannot say whether it is a choice.
 */
export function applyWidth(width: number | null, root: HTMLElement = document.documentElement): void {
  if (width == null) {
    root.style.removeProperty('--side-panel-w');
    root.style.removeProperty('--side-panel-chosen-w');
  } else {
    root.style.setProperty('--side-panel-w', `${Math.round(width)}px`);
    root.style.setProperty('--side-panel-chosen-w', `${Math.round(width)}px`);
  }
}

/**
 * The live layout's probe. Beside the AI tab's page (no app on screen, so
 * #app-view has no box) what is left of the panel's neighbour is the rail,
 * docked: a folded or peeking one takes no width.
 */
export function probeLayout(win: Window = window): LayoutProbe {
  let appLeft = 0;
  try {
    const app = win.document.getElementById('app-view');
    const box = app ? app.getBoundingClientRect() : null;
    if (box && box.width > 0) appLeft = box.left;
    else {
      const rail = win.document.getElementById('platform-tabs');
      if (rail && !rail.classList.contains('platform-tabs-peek')) appLeft = Math.max(0, rail.getBoundingClientRect().right);
    }
  } catch {
    appLeft = 0;
  }
  return { innerWidth: win.innerWidth, appLeft };
}
