/**
 * #platform-parked — the app you left, one tap above the tab bar.
 *
 * ./parked-store.js carries the argument for why it exists and why it is not
 * the recency list. What lives here is the things the strip has to get right
 * as a CONTROL.
 *
 * ── It is one target, and the ✕ is another ───────────────────────────
 *
 * The whole strip resumes the app — tile, name and pill alike — because a
 * shortcut whose tappable area is a 60px pill inside a full-width bar is a
 * shortcut you miss. The pill is a label INSIDE that target rather than a
 * button beside it: a nested button inside an anchor is invalid, browsers
 * split the markup on it, and it would give two targets where the design has
 * one plus a dismiss.
 *
 * The ✕ is that dismiss, and it means FORGET rather than hide: a strip that
 * comes back on the next screen swap is a strip you cannot get rid of, and
 * the handle's whole promise is that it is there until you are done with it.
 * Being done with it closes the app too: its frame, still loaded behind the
 * strip, is let go, so the next open starts it fresh (on whatever build is
 * live by then) instead of resuming the copy you dismissed.
 *
 * ── Resume goes BACK INTO the app, from wherever you are (#2762) ──────
 *
 * Since #2761 the mark's menu has no App segment, and this strip is the way
 * back into an app you stepped out of — including out to that same app's own
 * Workshop, discussion or change, which are platform screens with the bar up
 * and so show the strip. From there the app is still the one the router has
 * open, and re-opening it from scratch would reload a frame that is already
 * mounted. `App.openAppTab` is the router's own "this app, this tab" entry
 * point: it switches tabs for the open app and navigates for any other, and
 * it is what the chromeless pill uses for the same reason.
 *
 * ── It rides on the bar, and only where the bar is ─────────────────────
 *
 * The strip is a band on top of the platform's bar (a footer on the desktop
 * rail), so it is drawn exactly where that bar is: never over a running app,
 * never over the signed-out shell, never in chromeless. Before #2762 no app
 * was ever actually parked, so nothing asked; now one is kept in storage
 * across reloads, a reload can land on the signed-out shell, and the landing
 * screen must not offer the app. The bar's visibility is the store the bar
 * itself reads, and it is only ever applied as the `hidden` class below —
 * never rendered — so a value published before hydration cannot make the
 * first render disagree.
 *
 * On a FOLDED desktop rail the strip goes with the rail (app.css), and when
 * that rail peeks back over the page the strip rides on top of it. The
 * pointer crossing from the peeked rail onto the strip leaves the rail's
 * element, so the strip re-asserts the peek on its way in and hands back the
 * same grace period on its way out (./rail-peek.ts) — otherwise the rail and
 * the strip would fade away under the pointer that is about to press Resume.
 * Only while a peek is up: pointing at the strip never STARTS one.
 *
 * ── The initial render is the prerender ──────────────────────────────
 *
 * The root ships in the document with `hidden` and nothing inside it, which
 * is what the store's empty INITIAL renders. The app arrives from storage in
 * an effect, so the prerendered document and the first client render agree —
 * and the root has an id in the shell's frozen inventory either way, which a
 * conditionally rendered element could not.
 *
 * `hidden` lands through useHiddenClass rather than a rendered className, the
 * same seam the tab bar below it uses: the class string is a constant, and
 * the CSS that reserves this strip's band reads that class
 * (`body:has(#platform-parked:not(.hidden))`), so React must never be the one
 * rewriting the attribute.
 *
 * ── It arrives and leaves by the bar (#3376) ─────────────────────────
 *
 * On the phone the strip slides up out of the tab bar when an app is parked
 * and sinks back into it when the app is forgotten. Two phase classes carry
 * it (`platform-parked-enter` / `-leave`), toggled like `hidden` and never
 * rendered. While it leaves, the app it was drawing is kept in `leaving` so
 * the content stays put until `hidden` lands — on the leave keyframe's end,
 * or a timer, since `display: none` (keyboard up) runs no animation at all.
 *
 * Only a park or a forget while the bar stays up moves. The bar going away
 * (you entered the app, signed out) hides the strip at once — it must never
 * slide on its own over the app you are opening — and a stored app restored
 * on load is simply there, like the rest of the page. Reduced motion and the
 * desktop rail skip the leave entirely: hiding is instant, as it was.
 *
 * The root's clip is what animates, never a transform on it: a transform
 * would make the root the containing block for its fixed fake-glass layer,
 * which would then draw at strip size and snap back when the motion ended.
 * The children carry the slide (app.css).
 *
 * ── The app goes into it, and comes back out of it (#3618) ──────────
 *
 * Closing an app shrinks it into this strip, and Resume grows it back out:
 * the press notes the strip as the zoom's origin before the router opens the
 * app (./resume-motion.ts has the argument and the fallbacks). The pill is
 * the accent's, because Resume is an action.
 */

import { useEffect, useRef, useState } from 'react';

import { XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useClassToggle, useHiddenClass, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { useNamedApp } from './app-names';
import { navStore } from './nav-store.js';
import { parkedStore, readParked, setParked } from './parked-store.js';
import { enterPeekByMouse, leavePeekByMouse } from './rail-peek';
import { noteResumeOrigin } from './resume-motion';

type ParkedApp = { slug: string; name: string; iconUrl: string | null; iconEmoji: string | null };

/** Keyframe lengths in app.css, plus slack, for when no animationend comes. */
const ENTER_MS = 220;
const LEAVE_MS = 160;
const SLACK_MS = 80;

/**
 * The ✕: forget the strip AND close the app it offered. Its frame is kept
 * loaded so Resume is instant, and a forgotten app has nothing to resume
 * into, so it is let go (AppView keeps an app on screen, which this never
 * is: the strip only shows while the bar is up). A strip on its way out
 * (`app` null) has already been forgotten.
 */
export function forgetParked(app: ParkedApp | null): void {
  setParked(null);
  if (app) window.AppView?.evictKeptApp?.(app.slug);
}

/** Whether a leave would actually be drawn: the phone, with motion allowed. */
function leaveAnimates(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return window.matchMedia('(max-width: 767px)').matches;
}

export function ParkedStrip() {
  const t = useMessages();
  const ref = useRef<HTMLDivElement | null>(null);
  const { app } = useStoreState(parkedStore);
  // The bar's own answer, read the way the bar reads it. `true` is the
  // prerender, and it only ever reaches the DOM as a class.
  const barUp = useVisibility('platform-tabs', true);
  const { peek } = useStoreState(navStore);
  // The app on its way out, drawn until the leave finishes; null otherwise.
  const [leaving, setLeaving] = useState<ParkedApp | null>(null);
  const [entering, setEntering] = useState(false);
  const shown: ParkedApp | null = app || leaving;
  useHiddenClass(ref, !shown || !barUp);
  useClassToggle(ref, 'platform-parked-enter', entering && !!app && barUp);
  useClassToggle(ref, 'platform-parked-leave', !app && !!leaving && barUp);

  // What was on screen at the last change, null before the first; and
  // whether the next change is the stored app arriving on load.
  const prev = useRef<{ app: ParkedApp | null; visible: boolean } | null>(null);
  const quiet = useRef(false);

  useIsomorphicLayoutEffect(() => {
    const visible = !!app && barUp;
    const was = prev.current;
    const restoring = quiet.current;
    prev.current = { app, visible };
    quiet.current = false;
    if (!was) return;
    if (!barUp) {
      // The bar went away with it: gone now, never a slide over the app.
      setLeaving(null);
      setEntering(false);
    } else if (visible && !was.visible) {
      setLeaving(null);
      setEntering(!restoring);
    } else if (!app && was.visible && was.app) {
      setEntering(false);
      if (leaveAnimates()) setLeaving(was.app);
    }
  }, [app, barUp]);

  // Each phase ends on its own keyframe's end, or on a timer when none runs.
  useEffect(() => {
    if (!entering && !leaving) return undefined;
    const el = ref.current;
    const name = leaving ? 'platform-parked-conceal' : 'platform-parked-reveal';
    const finish = () => {
      if (leaving) setLeaving(null);
      else setEntering(false);
    };
    const onEnd = (event: AnimationEvent) => {
      if (event.target === el && event.animationName === name) finish();
    };
    el?.addEventListener('animationend', onEnd);
    const timer = window.setTimeout(finish, (leaving ? LEAVE_MS : ENTER_MS) + SLACK_MS);
    return () => {
      el?.removeEventListener('animationend', onEnd);
      window.clearTimeout(timer);
    };
  }, [entering, leaving]);

  // A strip on its way out takes no taps and is out of the reading order.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const out = !app && !!leaving;
    el.toggleAttribute('inert', out);
    if (out) el.setAttribute('aria-hidden', 'true');
    else el.removeAttribute('aria-hidden');
  }, [app, leaving]);

  // POST-MOUNT, and that is the whole of why it is an effect: a localStorage
  // read during the first render is a hydration mismatch. Once only — every
  // later change comes through the bridge, from the router.
  useEffect(() => {
    if (parkedStore.get().app) return;
    const stored = readParked();
    if (stored) {
      quiet.current = true;
      parkedStore.set({ app: stored });
    }
  }, []);

  // Drawn by its name, never its slug, while this device remembers the name
  // (./app-names.ts): an app parked offline, with no record to name it by,
  // was stored as its slug.
  const named = useNamedApp(shown);
  const record = named
    ? { icon_url: named.iconUrl, icon_emoji: named.iconEmoji, name: named.name }
    : null;

  return (
    <div
      ref={ref}
      id="platform-parked"
      className="platform-parked hidden"
      onPointerEnter={peek ? enterPeekByMouse : undefined}
      onPointerLeave={peek ? leavePeekByMouse : undefined}
    >
      {shown && record ? (
        <>
          <a
            id="platform-parked-resume"
            className="platform-parked-open"
            // A REAL PATH, so a modified click opens the app in a tab —
            // which is a thing people do with this exact handle, to get the
            // app back without losing the conversation they are reading.
            href={`/app/${encodeURIComponent(shown.slug)}`}
            onClick={(event) => {
              const nav = (window as unknown as {
                NavLink?: { isNativeClick?: (e: unknown) => boolean };
              }).NavLink;
              if (nav?.isNativeClick?.(event)) return;
              event.preventDefault();
              // A leaving strip is inert; there is no app to resume.
              if (!app) return;
              noteResumeOrigin(app.slug, ref.current);
              window.App?.openAppTab?.(app.slug, 'app');
            }}
          >
            <span
              data-icon={appIconKind(record)}
              className="app-icon-tile platform-parked-tile"
            >
              <AppIconContent app={record} />
            </span>
            <span className="platform-parked-name">{record.name}</span>
            <span className="platform-parked-pill">{t('core:parked.resume')}</span>
          </a>
          <button
            id="platform-parked-forget"
            type="button"
            className="platform-parked-x"
            aria-label={t('core:parked.forget', { app: record.name })}
            onClick={() => forgetParked(app)}
          >
            <XIcon className="w-4 h-4" />
          </button>
        </>
      ) : null}
    </div>
  );
}
