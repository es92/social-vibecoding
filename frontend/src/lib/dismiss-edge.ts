/**
 * How far outside a surface a tap still counts as ON it (#6475).
 *
 * Touch hit-testing is not pixel-exact: a tap on the card's padding near its
 * edge can be retargeted to the backdrop behind it, and a finger lands a few
 * pixels wider than the point a mouse reports. Either one used to read as
 * "the viewer pressed the backdrop" and closed the popup with their typing
 * still in it. Growing the surface's box by this much makes a near-edge tap
 * count as inside, so only a press clearly away from the popup dismisses.
 *
 * The native kit keeps its own copy (`DISMISS_EDGE_PX` in
 * public/usernode-native/v1/native.js) because it cannot import TypeScript;
 * tests/native-kit.test.js keeps the two equal.
 */
export const DISMISS_EDGE_TOLERANCE_PX = 8;

/** The part of a DOMRect this module reads. */
export interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Whether (x, y) falls inside `rect` grown by `tol` on every side.
 *
 * (0, 0) is what a synthetic `click` carries when it has no real point —
 * `element.click()` and an assistive-technology activation both do. Treating
 * that as a position would put every such click in the top-left corner of the
 * page, so a synthetic click reports "no point" and skips the geometry test;
 * callers then keep their existing decision for it.
 */
export function nearRect(
  x: number,
  y: number,
  rect: RectLike | null | undefined,
  tol: number = DISMISS_EDGE_TOLERANCE_PX,
): boolean {
  if (!rect) return false;
  if (x === 0 && y === 0) return false;
  return (
    x >= rect.left - tol &&
    x <= rect.right + tol &&
    y >= rect.top - tol &&
    y <= rect.bottom + tol
  );
}

/** Whether (x, y) falls inside any of `elements`, each grown by `tol`. */
export function nearAny(
  x: number,
  y: number,
  elements: ReadonlyArray<Element | null | undefined>,
  tol: number = DISMISS_EDGE_TOLERANCE_PX,
): boolean {
  for (const el of elements) {
    if (!el || typeof el.getBoundingClientRect !== 'function') continue;
    if (nearRect(x, y, el.getBoundingClientRect(), tol)) return true;
  }
  return false;
}
