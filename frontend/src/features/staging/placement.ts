/**
 * WHERE THE CHANGE PREVIEW STANDS (Nov 2026).
 *
 * The preview used to fill whichever document opened it: the whole window,
 * or, on a wide screen, the side panel's framed copy of Homeroom, where it
 * stacked its own black bar under the panel's header. Now the TOP window
 * draws it (a Preview press in the panel's document is handed up to it,
 * AppView.ensureStaging) and places it by three rules, tried in order:
 *
 *   column   beside the thread, in the detail column (../ai/detail.ts kind
 *            `preview`), when that column gives it at least MIN_COLUMN px:
 *            the Homeroom bot tab (list | thread | preview from 1500px,
 *            thread | preview in halves below), a request's page, the
 *            Workshop.
 *   panel    the side panel's place: beside a running app, or when a column
 *            would be narrower than MIN_COLUMN. The running app beside it is
 *            marked Live.
 *   full     the whole window: a phone, a page with no column, or a change
 *            whose declared screenshots are all desktop sizes (the preview
 *            answer's `wide`), where a column would show the wrong layout.
 *
 * Full window (the header's button) covers the window from a column or a
 * panel and docks back to it; the spot stays reserved underneath.
 *
 * ── The frame never moves ──────────────────────────────────────────────
 *
 * `#staging-iframe` is one element whose identity is pinned (a reparented or
 * re-created iframe reloads, and a reload throws away what the person did in
 * the preview). So the preview is never put INTO the column or the panel: the
 * overlay that holds the frame is positioned OVER the spot. The column draws
 * an empty placeholder (`[data-preview-slot]`, ../detail/detail-pane.tsx) for
 * the layout to make room around; this module measures it, and the panel,
 * and follows them as the window or a divider moves.
 */

import { closeDetail, detailEntry, openDetail, subscribeDetail } from '../ai/detail';
import { isBesideAi } from '../side-panel/controller';
import { sidePanelStore } from '../side-panel/store.js';
import { stagingHandlers, stagingStore } from './staging-store.js';

/** The narrowest column a preview stands in; below it, it takes the panel instead. */
export const MIN_COLUMN = 400;

/** A phone: the preview always takes the whole screen. Matches the detail column's own. */
export const PHONE_QUERY = '(max-width: 767px)';

export type Placement = 'full' | 'column' | 'panel';

export interface PlacementFacts {
  /** A phone-width window. */
  phone: boolean;
  /** The change declared desktop-size screenshots only. */
  wide: boolean;
  /** The side panel is open beside a running app (not beside the bot tab's page). */
  besideApp: boolean;
  /** The side panel is open at all. */
  panelOpen: boolean;
  /** The width the detail column gave the preview, or null when the page has none. */
  columnWidth: number | null;
}

/** Pure: the rules above, in order. */
export function choosePlacement(f: PlacementFacts): Placement {
  if (f.phone || f.wide) return 'full';
  if (f.besideApp) return f.panelOpen ? 'panel' : 'full';
  if (f.columnWidth != null && f.columnWidth >= MIN_COLUMN) return 'column';
  if (f.panelOpen) return 'panel';
  return 'full';
}

export interface Rect { left: number; top: number; width: number; height: number }

function rectOf(el: Element | null): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0) || !(r.height > 0)) return null;
  return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => {
      if (left <= 0) { resolve(); return; }
      requestAnimationFrame(() => step(left - 1));
    };
    step(n);
  });
}

function slotEl(): Element | null {
  return document.querySelector('[data-preview-slot]');
}

function panelEl(): Element | null {
  return document.getElementById('platform-side-panel');
}

function panelOpen(): boolean {
  const s = sidePanelStore.get() as { open?: boolean; frameSrc?: string | null };
  return !!(s.open && s.frameSrc && rectOf(panelEl()));
}

// The current placement's watchers, undone by unplacePreview.
let cleanup: Array<() => void> = [];
// Bumped by every place/unplace, so a placement still measuring when another
// begins (a second Preview press) drops its result.
let generation = 0;
// Set while this module closes the column itself, so its own close does not
// read as the person closing it.
let closingColumn = false;

function watch(target: () => Element | null, kind: Placement): void {
  const update = () => {
    const rect = rectOf(target());
    if (rect) stagingStore.set(stagingStore.get().beside ? { rect, liveSpot: liveSpot() } : { rect });
  };
  if (typeof ResizeObserver === 'function') {
    const el = target();
    if (el) {
      const ro = new ResizeObserver(update);
      ro.observe(el);
      cleanup.push(() => ro.disconnect());
    }
  }
  window.addEventListener('resize', update);
  cleanup.push(() => window.removeEventListener('resize', update));

  if (kind === 'column') {
    // The column went away (its ×, Escape, another detail opened in its
    // place, the list's tab): the preview goes with it.
    cleanup.push(subscribeDetail(() => {
      if (closingColumn) return;
      const entry = detailEntry();
      if (!entry || entry.kind !== 'preview') stagingHandlers.onBack?.();
      else requestAnimationFrame(update);
    }));
  } else if (kind === 'panel') {
    // The panel closed or went with its app: so does the preview.
    cleanup.push(sidePanelStore.subscribe(() => {
      if (!panelOpen()) stagingHandlers.onBack?.();
      else requestAnimationFrame(update);
    }));
  }
}

export interface PlaceInput {
  /** The change's session id, for the column's own entry. */
  sessionId?: number | null;
  /**
   * The project and whether the preview is read only (20 Nov 2026), kept
   * with the column's entry so the thread it stands beside can ask for it
   * again when the person comes back to it (../ai/detail.ts reopenDetail).
   */
  slug?: string | null;
  readOnly?: boolean;
  /** The preview answer's `wide`. */
  wide?: boolean;
  /**
   * Reopened from its address (a reload, a pasted link): the page under it
   * may not have drawn its column yet, so it waits up to SETTLE_MS for one
   * before it keeps the whole window.
   */
  settle?: boolean;
}

/** How long a preview reopened from its address waits for the page's column. */
export const SETTLE_MS = 4000;

/**
 * Place the preview that is opening. Returns the placement chosen. The store
 * starts at `full`, so the overlay is on screen (with its loader) at once and
 * moves to its spot within a frame or two.
 */
export async function placePreview(input: PlaceInput = {}): Promise<Placement> {
  unplacePreview();
  const mine = ++generation;
  const wide = !!input.wide;
  const phone = typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
  const open = panelOpen();
  const besideApp = open && !isBesideAi();

  let columnWidth: number | null = null;
  if (!phone && !wide && !besideApp) {
    openDetail({
      kind: 'preview',
      ref: { sessionId: Number(input.sessionId) || undefined },
      version: null,
      payload: { staging: { slug: input.slug || null, readOnly: input.readOnly !== false } },
    });
    await frames(2);
    if (mine !== generation) return 'full';
    const rect = rectOf(slotEl());
    columnWidth = rect ? rect.width : null;
  }

  const placement = choosePlacement({ phone, wide, besideApp, panelOpen: open, columnWidth });
  // Reopened from its address with no column drawn yet: it stands where the
  // rules put it meanwhile (the panel's place, or the whole window) and
  // moves into the column once the page draws it.
  const waitForColumn = !!input.settle && columnWidth == null
    && !phone && !wide && !besideApp && detailEntry()?.kind === 'preview';
  if (placement !== 'column' && !waitForColumn && detailEntry()?.kind === 'preview') closeColumn();

  const target = placement === 'column' ? slotEl : placement === 'panel' ? panelEl : null;
  const rect = target ? rectOf(target()) : null;
  const beside = placement === 'panel' && besideApp ? 'app' : null;
  stagingStore.set({
    placement: rect ? placement : 'full',
    rect,
    wide: wide && !phone,
    beside,
    liveSpot: beside ? liveSpot() : null,
    expanded: false,
  });
  if (target && rect) watch(target, placement);
  if (waitForColumn) settleIntoColumn(mine);
  return rect ? placement : 'full';
}

/**
 * The preview stands in the whole window while the page that will give it a
 * column is still being drawn (a cold load): it moves into the column once
 * the column is there and wide enough, and keeps the whole window if none
 * comes within SETTLE_MS, or the column's entry is closed meanwhile.
 */
function settleIntoColumn(mine: number): void {
  const deadline = Date.now() + SETTLE_MS;
  const tick = () => {
    if (mine !== generation) return;
    if (detailEntry()?.kind !== 'preview') return;
    const rect = rectOf(slotEl());
    if (rect && rect.width >= MIN_COLUMN) {
      // Stop following the spot it stood in meanwhile (the panel's place).
      for (const undo of cleanup.splice(0)) {
        try { undo(); } catch { /* a watcher that is already gone */ }
      }
      stagingStore.set({ placement: 'column', rect, beside: null, liveSpot: null, expanded: false });
      watch(slotEl, 'column');
      return;
    }
    if (rect || Date.now() >= deadline) {
      closeColumn();
      return;
    }
    setTimeout(tick, 150);
  };
  setTimeout(tick, 150);
}

/** After the app's name in the shell's header, where the Live mark goes. */
function liveSpot(): { left: number; top: number } | null {
  const name = rectOf(document.getElementById('header-title-name'));
  return name ? { left: name.left + name.width + 10, top: Math.round(name.top + name.height / 2 - 11) } : null;
}

function closeColumn(): void {
  closingColumn = true;
  try { closeDetail(); } finally { closingColumn = false; }
}

/** The preview closed: stop following its spot and give the column back. */
export function unplacePreview(): void {
  generation += 1;
  for (const undo of cleanup.splice(0)) {
    try { undo(); } catch { /* a watcher that is already gone */ }
  }
  if (detailEntry()?.kind === 'preview') closeColumn();
}

/** Full window, or back to the column or the panel it came from. */
export function togglePreviewSize(): boolean {
  const s = stagingStore.get();
  if (s.placement === 'full') return false;
  stagingStore.set({ expanded: !s.expanded });
  return !s.expanded;
}
