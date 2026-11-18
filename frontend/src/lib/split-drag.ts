/**
 * A drag on the line between two columns (18 Nov 2026): the Workshop's list
 * and its panel (features/dev-board/workshop/side-panel.tsx), and a thread's
 * card and its "How it got here" rail (features/group-chat/thread-shell.tsx).
 *
 * The handle reports how far the pointer has moved along the reading
 * direction, from the width the column had when the press began, and the
 * caller turns that into its own CSS variable. While held, the document wears
 * `side-panel-resizing`, the class the side panel's own divider already uses
 * (app.css): frames stand aside and nothing selects. Pure DOM; no React.
 */

import { dirSign } from './i18n/direction';

export interface SplitDrag {
  /** The width the drag starts from, read off the screen. */
  start: () => number;
  /** Show the column at this width. */
  apply: (px: number) => void;
  /** The drag is over: keep what the screen shows. */
  done: () => void;
  /** The column is on the far side of the line, so moving towards it widens it. */
  trailing?: boolean;
}

export function startSplitDrag(event: PointerEvent | { button: number; clientX: number; pointerId: number; currentTarget: EventTarget | null; preventDefault: () => void }, drag: SplitDrag): void {
  if (event.button !== 0) return;
  const el = event.currentTarget as HTMLElement | null;
  if (!el) return;
  event.preventDefault();
  const startX = event.clientX;
  const startW = drag.start();
  const sign = dirSign() * (drag.trailing ? -1 : 1);
  try { el.setPointerCapture?.(event.pointerId); } catch { /* a pointer that already went */ }
  document.documentElement.classList.add('side-panel-resizing');
  const move = (ev: PointerEvent) => drag.apply(startW + (ev.clientX - startX) * sign);
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    document.documentElement.classList.remove('side-panel-resizing');
    drag.done();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

/** Arrow keys move the line by `step`; returns whether the key was one of them. */
export function splitKey(key: string, step: number, drag: SplitDrag): boolean {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return false;
  const grow = (key === 'ArrowRight' ? 1 : -1) * dirSign() * (drag.trailing ? -1 : 1);
  drag.apply(drag.start() + grow * step);
  drag.done();
  return true;
}

/** A stored width, or null when there is none (or storage is refused). */
export function readSplitWidth(key: string, min: number): number | null {
  try {
    const n = Number(window.localStorage.getItem(key));
    return Number.isFinite(n) && n >= min ? n : null;
  } catch {
    return null;
  }
}

export function writeSplitWidth(key: string, px: number | null): void {
  try {
    if (px == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(Math.round(px)));
  } catch { /* a width that is not kept only resets next time */ }
}
