/**
 * A project card's animated preview: a short, silent loop of the real app
 * that plays over the card's picture (the featured-illustration record's
 * `preview`, public directory `preview_url`).
 *
 * WHEN it plays is ../../lib/card-previews.ts: on a device with a mouse
 * after a moment of pointing at the card (or keyboard focus on it), looping
 * until the pointer or focus leaves; on a phone, the one card most in view,
 * once, when scrolling settles; one at a time; never under reduced motion,
 * Data Saver or with "Play previews" off.
 *
 * HOW it stays quiet:
 *  - The first render is an empty, inert layer: no <video> in the prerender
 *    or in a card at rest, so nothing hydrates differently and nothing is
 *    fetched. The video mounts only on intent, `preload="none"`, muted and
 *    inline, and its own play() fetches it.
 *  - It sits over the picture at opacity 0 and fades in on `playing`, so a
 *    slow network shows the picture, never a black box. Stopping unmounts it,
 *    which resets it: the next play starts from the first frame, which is
 *    the picture.
 *  - A loop that fails (a missing file, a codec the browser lacks) leaves the
 *    picture showing, says nothing on the console, and is not asked for again
 *    on this page.
 */

import { useEffect, useId, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

import {
  HOVER_DELAY_MS, LEFT_VIEW, PHONE_MAX_SECONDS, activePreview, canHover, claimPreview, markPreviewFailed,
  onActivePreview, onPreviewsPref, previewFailed, previewsAllowed, releasePreview, reportInView,
} from '../../lib/card-previews';

const THRESHOLDS = [0, LEFT_VIEW, 0.5, 0.6, 0.75, 0.9, 1];

export function CardPreview({ src }: { src: string }) {
  const layer = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const id = useId();
  // Mounted: this card's preview is the one playing. Shown: it has started.
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  // A phone's play is once and short; a pointer's loops until it leaves.
  const [once, setOnce] = useState(false);

  // Which card plays is decided in one place for the whole page.
  useEffect(() => onActivePreview(() => {
    const mine = activePreview() === id;
    setMounted(mine);
    if (!mine) setShown(false);
  }), [id]);

  // A setting turned off mid-play stops it.
  useEffect(() => onPreviewsPref(() => { if (!previewsAllowed()) releasePreview(id); }), [id]);

  useEffect(() => {
    const el = layer.current;
    const card = el?.closest('article') || el?.parentElement || null;
    if (!el || !card) return undefined;
    const start = (loop: boolean) => {
      if (!previewsAllowed() || previewFailed(src)) return;
      setOnce(!loop);
      claimPreview(id);
    };
    if (canHover()) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const intend = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; start(true); }, HOVER_DELAY_MS);
      };
      const stop = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        releasePreview(id);
      };
      const blur = (e: FocusEvent) => { if (!card.contains(e.relatedTarget as Node | null)) stop(); };
      card.addEventListener('pointerenter', intend);
      card.addEventListener('pointerleave', stop);
      card.addEventListener('focusin', intend);
      card.addEventListener('focusout', blur);
      return () => {
        card.removeEventListener('pointerenter', intend);
        card.removeEventListener('pointerleave', stop);
        card.removeEventListener('focusin', intend);
        card.removeEventListener('focusout', blur);
        stop();
      };
    }
    if (typeof IntersectionObserver === 'undefined') return undefined;
    let unregister: (() => void) | null = null;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
        unregister = reportInView(id, ratio, () => start(false));
        if (ratio < LEFT_VIEW) releasePreview(id);
      }
    }, { threshold: THRESHOLDS });
    observer.observe(card);
    return () => {
      observer.disconnect();
      if (unregister) unregister();
      releasePreview(id);
    };
  }, [id, src]);

  // Mounted: play it. The promise is answered either way, so a play the
  // browser refuses or a stop mid-load is never an uncaught error.
  useEffect(() => {
    const v = video.current;
    if (!mounted || !v) return;
    v.muted = true;
    try {
      const played = v.play();
      if (played && typeof played.catch === 'function') played.catch(() => releasePreview(id));
    } catch { releasePreview(id); }
  }, [mounted, id]);

  return (
    <span ref={layer} data-card-preview="" aria-hidden="true" className="pointer-events-none absolute inset-0">
      {mounted ? (
        <video
          ref={video}
          src={src}
          muted
          playsInline
          preload="none"
          loop={!once}
          tabIndex={-1}
          disablePictureInPicture
          data-card-preview-video=""
          className={cn(
            'absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ease-out motion-reduce:transition-none',
            shown ? 'opacity-100' : 'opacity-0',
          )}
          onPlaying={() => setShown(true)}
          onEnded={() => releasePreview(id)}
          onTimeUpdate={(e) => { if (once && e.currentTarget.currentTime >= PHONE_MAX_SECONDS) releasePreview(id); }}
          onError={() => { markPreviewFailed(src); releasePreview(id); }}
        />
      ) : null}
    </span>
  );
}
