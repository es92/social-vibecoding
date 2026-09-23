/**
 * WHERE THE SCREEN IS, WHEN THE KEYBOARD HAS MOVED IT (#2765).
 *
 * The kit tells the page how TALL the strip above the on-screen keyboard is:
 * `--un-kb-inset` on <html>, the layout-viewport height the keys cover
 * (native.js keyboardInset). It does not say where that strip STARTS, and
 * its centred surfaces assume the top — `.un-modal` sits at
 * `50% - var(--un-kb-inset) / 2`, the middle of the strip only while the
 * visual viewport begins at the layout viewport's top edge.
 *
 * iOS does not keep it there. To reveal a focused field it PANS the visual
 * viewport down inside the layout viewport, and a `position: fixed` box is
 * laid out against the layout viewport, so it does not move with the pan.
 * The kit's own measurements (#1938) have an installed app at a 403px pan
 * under a 409px visual viewport on an 812px layout: what is on screen is
 * the band 403–812, and the kit's modal is centred at 204. Give feedback
 * shows it at its mildest: tap the description and iOS pans just far enough
 * to clear it, the dialog re-centres into the strip ABOVE that pan, and it
 * lands pressed against the top edge with its heading cut off. Open it with
 * the keys already up and the page panned all the way, and almost none of
 * it is on screen.
 *
 * So this module publishes the missing half, `visualViewport.offsetTop`, as
 * `--platform-vv-top` on <html>, beside the kit's inset, and app.css adds it
 * to the modal's `top`. Where nothing pans — Android measured offsetTop 0 in
 * the same table, and desktop never has a keyboard — the property stays 0px
 * and the modal sits exactly where the kit puts it.
 *
 * Pinch zoom is not a keyboard pan: a zoomed visual viewport reports an
 * offset for the zoom, and following it would drag the dialog around the
 * layout under the viewer's fingers. The kit forces its inset to 0 while
 * zoomed for the same reason, so this reads 0 there too.
 */

export const VV_TOP_PROP = '--platform-vv-top';

type ViewportLike = Pick<VisualViewport, 'offsetTop' | 'scale'>;

/** How far, in whole px, the visual viewport's top edge sits below the
 *  layout viewport's. 0 while pinch-zoomed, and for anything unreadable. */
export function visualViewportTop(vv: ViewportLike | null | undefined): number {
  if (!vv) return 0;
  const scale = Number(vv.scale);
  if (!Number.isFinite(scale) || Math.abs(scale - 1) > 0.01) return 0;
  const top = Number(vv.offsetTop);
  if (!Number.isFinite(top) || top <= 0) return 0;
  return Math.round(top);
}

type DocLike = { documentElement: { style: Pick<CSSStyleDeclaration, 'setProperty'> } };
type WinLike = Pick<Window, 'requestAnimationFrame'> & {
  visualViewport?: (ViewportLike & Pick<EventTarget, 'addEventListener'>) | null;
};

/**
 * Follow the visual viewport and keep `--platform-vv-top` current.
 *
 * On the kit's schedule: the same two events its tracker listens to, and
 * the write in an animation frame, so the offset and the inset it pairs
 * with land in the same frame rather than moving the dialog twice. Writes
 * only on a change — a scrolling page fires `scroll` here every frame.
 * Returns the apply step, for tests.
 */
export function initVisualViewportTop(doc: DocLike, win: WinLike): () => void {
  const vv = win.visualViewport;
  let last = 0; // the stylesheet's fallback: unset reads as 0px
  let queued = false;
  const apply = () => {
    queued = false;
    const top = visualViewportTop(vv);
    if (top === last) return;
    last = top;
    doc.documentElement.style.setProperty(VV_TOP_PROP, `${top}px`);
  };
  if (!vv) return apply;
  const schedule = () => {
    if (queued) return;
    queued = true;
    win.requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', schedule, { passive: true });
  vv.addEventListener('scroll', schedule, { passive: true });
  apply();
  return apply;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  initVisualViewportTop(document, window);
}
