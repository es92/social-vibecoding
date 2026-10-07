/**
 * The first session after an invite: "You're in", then a short tour on the
 * real screens.
 *
 *   welcome  A full-screen card on the landing's wallpaper: you joined this
 *            group, and — for an account the invite's own sign-up made — what
 *            Homeroom is, in three lines. Under that, the project as its
 *            invite showed it (./joined-picture.tsx). "Go to <name>" starts
 *            the tour, told whether its first version is still being built
 *            (read here from GET /api/apps/:slug, now that they may).
 *   tour     ./tour-steps.ts, over the live shell. Each screen is shown whole
 *            first, then the control that leads on is cut out of the dim and
 *            the reader presses it, or the card's blue hint, which presses
 *            the same control: the product's own handler navigates, and
 *            the tour only watches the press. Back re-opens the screen the
 *            previous step was on; Skip ends on the last step's screen.
 *
 * App.\_followInvite (public/js/app.js) opens it through
 * `window.UsernodeReact.firstSession.welcome(info)`, once per account and
 * project (localStorage), when the invite link it is following has just
 * joined the viewer; so does an invite by username, accepted from the
 * notifications (Notifications.\_acceptInvite, with the accept's `welcome`).
 * It answers false when it will not show, and the caller lands them where
 * it always did.
 *
 * The same island is the platform's one front door for a new project: the
 * Create button (App.showCreateModal, public/js/app.js) opens
 * "What do you want to make?" through `create()`, with `entry` 'create', and
 * the New project dialog (../dialogs/create-app.tsx), now its More options,
 * hands a project made from a description back through `made()`. From
 * there it ends on the project's hub rather than on the first session's
 * tour, and it answers nothing the first session asks (noteAnswered).
 *
 * A sign-in from the invite's own page (Join, then the sheet) is followed in
 * the tick the signed-in shell starts, and the link's standing, which says
 * whether to welcome them, is a request away: Home showed for that long
 * before "You're in" (Evan, 5 October 2026). So the follow asks for the
 * welcome's frame first, `holdWelcome()`, drawn at once (flushSync) on the
 * same wallpaper, before the shell draws Home; welcome() fills it, and
 * `endHold()` takes it down for any other ending. The make screen's own
 * hand-off (#3894) works the same way.
 *
 * ── The island rules ──────────────────────────────────────────────────
 *
 * It renders NOTHING until it is opened, so the prerendered shell is
 * unchanged, and only a press opens it, so the first client render matches.
 * Nothing in `public/js/**` writes into it; the legacy shell is only CALLED
 * (App.navigateHome, App.navigateToApp, App.openDiscussionInHub). The
 * spotlight's geometry is measured each frame from the target the step names
 * and kept in state only when it moves.
 */

import { type Dispatch, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { Button } from '@/components/ui/button';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { Wordmark } from '@/components/ui/wordmark';

import { pushDismissible, type Release } from '../../lib/back-stack';
import { invalidateAppAllowance } from '../dialogs/app-allowance-store.js';
import { joinPicture, JoinedPicture } from './joined-picture';
import { type Made, type MakeDraft, type MakeEntry, MakeScreen } from './make';
import { MadeScreen, madeAppOf, madeAppUrl } from './made';
import { type FirstVersionStage, invitedSteps, makerSteps, privateSteps, type TourScreen, type TourStep } from './tour-steps';

export type FirstSessionInfo = {
  slug: string;
  /** Homeroom bot's chat with the viewer, when it builds this project for them. */
  conversationId?: number | null;
  name: string;
  iconEmoji?: string | null;
  iconUrl?: string | null;
  inviterName?: string | null;
  inviterMadeIt?: boolean;
  /** Its first version is still on its way: "<maker> is making it" (community-invites.js firstVersionPending). */
  building?: boolean;
  /**
   * The account was made by the sign-up the link opened (or is a test
   * account on its first sign-in: services/test-accounts.js onFirstRun).
   */
  newAccount?: boolean;
  /** The project's one line, and the picture its invite showed (./joined-picture.tsx). */
  description?: string | null;
  picture?: unknown;
  /** Where its first version stands, for the tour's second step (./tour-steps.ts). */
  firstVersion?: FirstVersionStage;
};

/**
 * Where a project's first version stands, from GET /api/apps/:slug's
 * `first_version` (madeAppOf): being built, built and up for approval, or
 * null once there is none (the app is what there is).
 */
export function firstVersionStage(body: unknown): FirstVersionStage {
  const fv = madeAppOf(body)?.firstVersion;
  if (!fv) return null;
  return fv.ready ? 'ready' : 'building';
}

type Legacy = {
  App?: {
    user?: {
      id?: number; username?: string; displayName?: string | null; needsCommunitiesChoice?: boolean; privateMember?: boolean;
      homeroomBotDm?: boolean;
    } | null;
    _privateHomeVisited?: () => boolean;
    _notePrivateHome?: () => void;
    saveSessionSnapshot?: (user: unknown) => void;
    navigateHome?: (opts?: unknown) => void;
    navigateToApp?: (slug: string, tab: string) => unknown;
    openDiscussionInHub?: (slug: string) => void;
    _WORKSHOP_VIEW_KEY?: string;
    _workshopViewPath?: (url: string) => string | null;
    _publishCommunityScope?: (slug: string | null) => void;
  };
  AppView?: {
    _landOnHub?: (slug: string) => void;
  };
  // ../auth/phone-first-run.tsx: on a phone, its step comes before this one.
  PhoneFirstRun?: {
    comesFirst?: (user: unknown) => boolean;
    settled: () => Promise<void>;
  };
  Home?: { load?: () => void };
  Secrets?: { open?: (slug: string) => void };
  UsernodeReact?: Record<string, unknown> & {
    dialogs?: { create?: { open?: (draft?: MakeDraft) => void } };
  };
};
const legacy = (): Legacy => window as unknown as Legacy;

const SEEN_PREFIX = 'usernode:first-session:';
function seenKey(slug: string): string {
  return `${SEEN_PREFIX}${legacy().App?.user?.id ?? 'anon'}:${slug}`;
}
function seen(slug: string): boolean {
  try { return !!localStorage.getItem(seenKey(slug)); } catch { return false; }
}
function markSeen(slug: string): void {
  try { localStorage.setItem(seenKey(slug), String(Date.now())); } catch { /* private mode */ }
}

/** Open the screen a step is on, through the shell's own navigation. */
export function enterScreen(screen: TourScreen, slug: string, conversationId?: number | null): void {
  const { App, AppView } = legacy();
  if (!App) return;
  if (screen === 'home') App.navigateHome?.();
  else if (screen === 'app') App.navigateToApp?.(slug, 'app');
  else if (screen === 'hub') { AppView?._landOnHub?.(slug); App.navigateToApp?.(slug, 'dev'); }
  else if (screen === 'discussion') App.openDiscussionInHub?.(slug);
  else if (screen === 'bot' && conversationId) window.location.hash = `#messages/${conversationId}`;
}

/**
 * Make the Communities tab open on this project's hub: the page the tab
 * reopens is the one App._noteWorkshopView remembers (public/js/app.js), and
 * a viewer who has only used the app has none yet, so the tab would list
 * every community instead of the one they just joined.
 */
export function rememberCommunity(slug: string): void {
  const { App, AppView } = legacy();
  const key = App?._WORKSHOP_VIEW_KEY;
  const path = App?._workshopViewPath?.(`/app/${encodeURIComponent(slug)}/workshop`);
  if (!key || !path) return;
  try { localStorage.setItem(key, JSON.stringify({ slug, path })); } catch { return; }
  App?._publishCommunityScope?.(slug);
  // And on its Hub tab, whatever tab the page was last left on.
  AppView?._landOnHub?.(slug);
}

type Box = { left: number; top: number; width: number; height: number };

/** The boxes of the visible elements a selector list names. */
function visibleBoxes(selectors: string): Box[] {
  return Array.from(document.querySelectorAll(selectors))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
}

/** Pure: boxes drawn as one, the smallest box around all of them, or null. */
export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((b) => b.left));
  const top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.left + b.width));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  return { left, top, width: right - left, height: bottom - top };
}

/** The visible elements a selector list names, drawn as one box, or null. */
export function targetBox(selectors: string): Box | null {
  return unionBox(visibleBoxes(selectors));
}

/** How far below a transcript's top edge a row it shows from its top begins. */
const ROW_INSET = 8;

/**
 * Pure: how far a transcript scrolls back so a row whose top is at `rowTop`
 * begins ROW_INSET below the transcript's own top (`scrollerTop`), both on
 * screen: 0 when it does already. Never forward: a row lower down is in view.
 */
export function scrollBackFor(scrollerTop: number, rowTop: number, inset: number = ROW_INSET): number {
  const by = scrollerTop + inset - rowTop;
  return by > 0 ? Math.ceil(by) : 0;
}

type ScrollerLike = { scrollTop: number; getBoundingClientRect(): { top: number; height: number }; querySelectorAll(rows: string): ArrayLike<{ getBoundingClientRect(): { top: number } }> };

/**
 * A step's transcript (TourStep.newestFromTop): its newest row is shown from
 * its top edge. Pinned to its newest line, the bot's chat put a plan card
 * taller than the space above the coach card part-way down, its first line
 * ("Here's my plan for …") above the cut-out. Run every frame while the step
 * is up, so it holds when the rows arrive after the step lands and when the
 * chat follows a card that grew; the step covers its cut-out, so the reader
 * is never scrolled against their own hand. Answers whether it scrolled.
 */
export function showNewestFromTop(
  spec: { scroller: string; rows: string },
  root: { querySelectorAll(selectors: string): ArrayLike<unknown> } = document,
): boolean {
  const scroller = (Array.from(root.querySelectorAll(spec.scroller)) as ScrollerLike[])
    .find((el) => el.getBoundingClientRect().height > 0);
  if (!scroller) return false;
  const rows = scroller.querySelectorAll(spec.rows);
  const newest = rows.length ? rows[rows.length - 1] : null;
  if (!newest) return false;
  const by = scrollBackFor(scroller.getBoundingClientRect().top, newest.getBoundingClientRect().top);
  if (!by) return false;
  scroller.scrollTop = Math.max(0, scroller.scrollTop - by);
  return true;
}

const PAD = 6;
/** The ring's width (`ring-[3px]` below), kept on screen around a hole. */
const RING = 3;
const SHADE = 'pointer-events-auto fixed bg-[rgba(9,9,12,0.6)] transition-all duration-200';

/**
 * Pure: a cut-out with its foot taken off by the bars lying across it
 * (TourStep.endsAbove). A bar counts when it is at least half the cut-out's
 * width and begins inside it: the phone's tab bar, and the Resume strip on
 * it. The rail from 768px up runs down the side and takes nothing off. It
 * ends `pad` above the highest such bar, so the padded hole (holeFor) meets
 * the bar's edge rather than covering it.
 */
export function endAbove(box: Box, bars: Box[], pad: number = PAD): Box {
  const bottom = box.top + box.height;
  const across = bars.filter((b) => b.width >= box.width / 2 && b.top > box.top && b.top < bottom);
  if (!across.length) return box;
  const end = Math.min(...across.map((b) => b.top)) - pad;
  return { ...box, height: Math.max(0, Math.min(bottom, end) - box.top) };
}

/**
 * The cut-out a step draws, before padding: its target (null until that is
 * on screen), with what it is drawn `alongside` (the top bar), and its foot
 * taken off where it `endsAbove` a bar.
 */
export function stepBox(step: Pick<TourStep, 'target' | 'alongside' | 'endsAbove'>): Box | null {
  const target = targetBox(step.target);
  if (!target) return null;
  const box = step.alongside ? unionBox([target, ...visibleBoxes(step.alongside)]) || target : target;
  return step.endsAbove ? endAbove(box, visibleBoxes(step.endsAbove)) : box;
}

/** The control a tap step leads on by: its `press`, or its target. */
export function pressOf(step: Pick<TourStep, 'target' | 'press'>): string {
  return step.press || step.target;
}

type PressRoot = { querySelectorAll(selectors: string): ArrayLike<unknown> };
type Pressable = { getBoundingClientRect(): { width: number; height: number }; click(): void };

/**
 * A tap step's hint, pressed (TourStep.tap: "Tap it to open it", "Tap ✕"):
 * it presses the step's own control, the first one on screen, as a finger on
 * it does. So it goes the one way a press on the control goes: the product's
 * own handler navigates, and the tour's watcher (Tour, below) sees the press
 * and moves on. Nothing here moves the tour. Answers whether there was a
 * control to press.
 */
export function pressTarget(selectors: string, root: PressRoot = document): boolean {
  const control = (Array.from(root.querySelectorAll(selectors)) as Pressable[])
    .find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!control) return false;
  control.click();
  return true;
}

/**
 * A target measured, and the step it was measured FOR.
 *
 * The box used to be state of its own, refreshed by the next animation frame,
 * so the render that showed a new step's card still drew the previous step's
 * cut-out. On 4 of 7 that was the ring round ✕, at the top-left of the
 * app's header, drawn over Home's Homeroom logo beside "Tap Communities"
 * (production, 375x812 browser, 4 Oct 2026), and it stayed there for as long
 * as no frame came to replace it. A box now counts only for its own step:
 * until the new target has been measured the screen dims whole, with no
 * ring anywhere.
 *
 * `press` is the control a tap step rings, measured with it: the cut-out
 * itself, or within it the step's `press` (✕ in the app screen).
 */
export type Measured = { step: number; box: Box | null; press?: Box | null };

export function boxForStep(measured: Measured, step: number): Box | null {
  return measured.step === step ? measured.box : null;
}

export function pressForStep(measured: Measured, step: number): Box | null {
  return measured.step === step ? (measured.press ?? null) : null;
}

/** A step's cut-out and the control it rings, measured now, for step `at`. */
export function measure(at: number, step: TourStep): Measured {
  const box = stepBox(step);
  return { step: at, box, press: box && step.press ? targetBox(step.press) : box };
}

/**
 * The cut-out around a target: padded, and kept inside the screen so its
 * whole ring shows. A tab on the phone's bar sits on the screen's bottom
 * edge, and its padded ring ran off it. A cut-out with no ring of its own
 * (`margin` 0) runs to the screen's edges: the whole screen, as a screen,
 * with no line of dim round it.
 */
export function holeFor(box: Box, viewport: { width: number; height: number }, margin: number = RING): Box {
  const left = Math.max(margin, box.left - PAD);
  const top = Math.max(margin, box.top - PAD);
  const right = Math.min(viewport.width - margin, box.left + box.width + PAD);
  const bottom = Math.min(viewport.height - margin, box.top + box.height + PAD);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Pure: the parts of `outer` that are not `inner`, as up to four boxes. What
 * covers a cut-out round its one pressable control, so a press anywhere else
 * in it goes nowhere. An `inner` outside it leaves all of it covered.
 */
export function aroundBox(outer: Box, inner: Box): Box[] {
  const right = outer.left + outer.width;
  const bottom = outer.top + outer.height;
  const l = Math.max(outer.left, inner.left);
  const t = Math.max(outer.top, inner.top);
  const r = Math.min(right, inner.left + inner.width);
  const b = Math.min(bottom, inner.top + inner.height);
  if (r <= l || b <= t) return [outer];
  return [
    { left: outer.left, top: outer.top, width: outer.width, height: t - outer.top },
    { left: outer.left, top: b, width: outer.width, height: bottom - b },
    { left: outer.left, top: t, width: l - outer.left, height: b - t },
    { left: r, top: t, width: right - r, height: b - t },
  ].filter((part) => part.width > 0 && part.height > 0);
}

function boxKey(b: Box | null | undefined): string {
  return b ? `${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)},${Math.round(b.height)}` : '';
}

/** The coach card's position for a target box, as inline style. */
export function cardPlacement(box: Box | null, step: TourStep, viewport: { width: number; height: number }): React.CSSProperties {
  const H = viewport.height;
  const tabs = document.getElementById('platform-tabs');
  const tabsTop = tabs && tabs.getBoundingClientRect().height ? tabs.getBoundingClientRect().top : H;
  if (!box) return { bottom: H - tabsTop + 16 };
  if (step.place && typeof step.place === 'object') {
    const above = document.querySelector(step.place.above);
    if (above) return { bottom: H - above.getBoundingClientRect().top + 12 };
  }
  if (step.place === 'bottom') return { bottom: H - tabsTop + 16 };
  if (box.height > H * 0.45) return { bottom: Math.max(16, H - (box.top + box.height) + 20) };
  if (box.top + box.height / 2 > H / 2) return { bottom: H - box.top + PAD + 12 };
  return { top: box.top + box.height + PAD + 12 };
}

/** The tour over the live shell (see the header); exported so a test can draw its card. */
export function Tour({ info, steps, onEnd }: { info: FirstSessionInfo; steps: TourStep[]; onEnd: () => void }) {
  const [index, setIndex] = useState(0);
  const [measured, setMeasured] = useState<Measured>({ step: -1, box: null });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const step = steps[index];
  const stepRef = useRef(step);
  stepRef.current = step;
  const indexRef = useRef(index);
  indexRef.current = index;
  const box = boxForStep(measured, index);
  const pressBox = pressForStep(measured, index);

  // A new step measures its own target before it is painted, so its card
  // never shows beside the last step's cut-out (see Measured).
  useLayoutEffect(() => {
    setMeasured(measure(index, step));
  }, [index, step]);

  // Then follow the target every frame; keep it only when it moved. A frame
  // that throws (a selector the document cannot parse) must not end the
  // loop, or the ring would stay wherever it was last drawn.
  useEffect(() => {
    let raf = 0;
    let last = '';
    const tick = () => {
      try {
        const at = indexRef.current;
        // Before measuring, so the cut-out is drawn round what it shows.
        const reveal = stepRef.current.newestFromTop;
        if (reveal) showNewestFromTop(reveal);
        const m = measure(at, stepRef.current);
        const key = `${at}:${boxKey(m.box)}:${boxKey(m.press)}`;
        if (key !== last) { last = key; setMeasured(m); }
        if (window.innerWidth !== viewport.width || window.innerHeight !== viewport.height) {
          setViewport({ width: window.innerWidth, height: window.innerHeight });
        }
      } catch { /* measured again next frame */ }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [viewport.width, viewport.height]);

  // A step whose target never shows (a screen that did not open) opens its
  // screen itself after a moment.
  useEffect(() => {
    const t = window.setTimeout(() => { if (!targetBox(step.target)) enterScreen(step.screen, info.slug, info.conversationId); }, 2500);
    return () => window.clearTimeout(t);
  }, [index, step, info.slug]);

  const go = useCallback((to: number) => {
    if (to < 0) return;
    if (to >= steps.length) { onEnd(); return; }
    if (steps[to].screen !== steps[index].screen || to < index) enterScreen(steps[to].screen, info.slug, info.conversationId);
    setIndex(to);
  }, [index, steps, info.slug, onEnd]);

  // A tap step advances when its control is pressed, by a finger or by the
  // card's hint (pressTarget). The press is not intercepted: it is the
  // product's own handler that navigates.
  useEffect(() => {
    if (!step.tap) return undefined;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      const hit = Array.from(document.querySelectorAll(pressOf(step))).some((el) => el.contains(t));
      if (!hit) return;
      window.setTimeout(() => setIndex((i) => (i === index ? i + 1 : i)), 0);
      const next = steps[index + 1];
      if (step.opensNext && next) window.setTimeout(() => enterScreen(next.screen, info.slug, info.conversationId), 250);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [step, index, steps, info.slug, info.conversationId]);

  const skip = useCallback(() => {
    enterScreen(steps[steps.length - 1].screen, info.slug, info.conversationId);
    onEnd();
  }, [steps, info.slug, onEnd]);

  // A tap step rings the control that leads on: the whole cut-out, kept a
  // ring's width inside the screen, or its `press` within a wider cut-out.
  // Any other cut-out runs to the screen's edges.
  const hole = box && holeFor(box, viewport, step.tap && !step.press ? RING : 0);
  const ring = hole && step.tap && pressBox ? holeFor(pressBox, viewport) : null;
  // Presses reach only that control: a step that only shows its screen
  // covers all of its cut-out, and a tap step all of it but the ring.
  const covers = hole ? (ring ? aroundBox(hole, ring) : [hole]) : [];
  const card = cardPlacement(box, step, viewport);

  return (
    // The layer itself lets presses through: only the shades, the card and
    // the covers over the cut-out take them, so the control the step asks
    // for is pressable.
    <div data-first-session-tour={index + 1} className="pointer-events-none fixed inset-0 z-[9000]">
      {hole ? (
        <>
          <div className={SHADE} style={{ left: 0, top: 0, right: 0, height: Math.max(0, hole.top) }} />
          <div className={SHADE} style={{ left: 0, top: hole.top + hole.height, right: 0, bottom: 0 }} />
          <div className={SHADE} style={{ left: 0, top: hole.top, width: Math.max(0, hole.left), height: hole.height }} />
          <div className={SHADE} style={{ left: hole.left + hole.width, top: hole.top, right: 0, height: hole.height }} />
          {ring ? (
            <div
              aria-hidden="true"
              className="pointer-events-none fixed rounded-2xl ring-[3px] ring-[rgba(90,169,255,0.9)] motion-safe:animate-pulse"
              style={ring}
            />
          ) : null}
          {covers.map((cover, i) => <div key={i} className="pointer-events-auto fixed" style={cover} />)}
        </>
      ) : (
        <div className={`${SHADE} inset-0`} />
      )}
      <div
        role="dialog"
        aria-labelledby="first-session-tour-title"
        className="pointer-events-auto fixed left-4 right-4 mx-auto max-w-md rounded-[20px] bg-white p-4 text-zinc-900 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.6)] dark:bg-zinc-800 dark:text-zinc-100"
        style={card}
      >
        <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{`${index + 1} of ${steps.length}`}</p>
        <p id="first-session-tour-title" className="mt-0.5 text-[17px] font-semibold leading-snug">{step.title}</p>
        <p className="mt-1 text-[15px] leading-snug text-zinc-600 dark:text-zinc-300">{step.text}</p>
        <div className="mt-3 flex items-center justify-between gap-3">
          {step.last ? <span /> : (
            <button type="button" onClick={skip} className="py-1.5 text-[15px] font-semibold text-zinc-500 dark:text-zinc-400">Skip</button>
          )}
          <div className="flex items-center gap-2.5">
            {index > 0 ? (
              <button type="button" onClick={() => go(index - 1)} className="rounded-full bg-zinc-100 px-3.5 py-1.5 text-[15px] font-semibold text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100">Back</button>
            ) : null}
            {step.tap && !step.last ? (
              // The hint presses the control it names (pressTarget), so it
              // does what a finger on the control does. Still the blue words
              // it was: no fill, no edge, no underline, only a pressed state.
              <button
                type="button"
                data-first-session-tap=""
                onClick={() => { pressTarget(pressOf(step)); }}
                className="py-1.5 text-[13px] font-semibold text-violet-700 transition-opacity active:opacity-60 dark:text-violet-400"
              >
                {step.tap}
              </button>
            ) : (
              <Button type="button" onClick={() => go(index + 1)} variant="pillAccent" size="sm" ink="solid" className="text-[15px] font-semibold">
                {step.last ? 'Got it' : 'Next'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * "You're in"'s ground: the landing's wallpaper under the wordmark, full
 * screen. Held empty (WelcomeHeld) while the invite's standing is read.
 */
function WelcomeFrame({ children, held = false }: { children: React.ReactNode; held?: boolean }) {
  return (
    <div
      role="dialog"
      aria-labelledby={held ? undefined : 'first-session-title'}
      aria-label={held ? 'Opening your invite' : undefined}
      data-first-session-welcome={held ? 'held' : ''}
      className="fixed inset-0 z-[9000] flex flex-col overflow-y-auto text-zinc-900 dark:text-zinc-100"
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      <div className="flex h-[52px] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)]">
        <Wordmark className="h-6 w-auto text-[color:var(--brand-ink)]" />
      </div>
      <div className="mx-auto flex w-full max-w-sm grow flex-col px-4 pb-[max(34px,env(safe-area-inset-bottom))] text-center">
        {children}
      </div>
    </div>
  );
}

/** The frame while the invite's standing is read: where its words will be. */
export function WelcomeHeld() {
  return (
    <WelcomeFrame held>
      <SkeletonGroup label="Opening your invite" className="flex flex-col items-center">
        <Skeleton shape="block" className="mt-4 h-12 w-56 rounded-full" />
        <Skeleton className="mt-5 w-28" />
        <Skeleton shape="block" className="mt-4 h-8 w-64" />
        <Skeleton shape="muted" className="mt-4 w-56" />
      </SkeletonGroup>
    </WelcomeFrame>
  );
}

export function YoureIn({ info, onGo }: { info: FirstSessionInfo; onGo: (firstVersion: FirstVersionStage) => void }) {
  const user = legacy().App?.user;
  const who = user?.displayName || user?.username || '';
  const existing = !info.newAccount;
  const maker = info.inviterMadeIt && info.inviterName ? info.inviterName : null;
  // Nothing is made yet while its first version is on its way.
  const made = info.building ? 'is making' : 'made';
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => { go.current?.focus(); }, []);
  // Whether its first version is still being built, for the tour's App
  // step: the record as the App tab reads it, past the service worker's
  // cache. A read that fails leaves the step as it was.
  const stage = useRef<FirstVersionStage>(info.firstVersion ?? (info.building ? 'building' : null));
  useEffect(() => {
    let live = true;
    fetch(madeAppUrl(info.slug), { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (live && body) stage.current = firstVersionStage(body); })
      .catch(() => {});
    return () => { live = false; };
  }, [info.slug]);
  const tile = info.iconUrl ? <img src={info.iconUrl} alt="" className="h-full w-full object-cover" /> : (info.iconEmoji || info.name.slice(0, 1));
  return (
    <WelcomeFrame>
      <div className="mx-auto mt-4 inline-flex items-center gap-2 rounded-full bg-white py-1.5 pl-1.5 pr-4 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
        <span className="app-icon-tile flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] text-xl" aria-hidden="true">
          {tile}
        </span>
        <span className="text-[14px] font-semibold">{`You joined ${info.name}`}</span>
      </div>
      <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">
        {who ? `You're in, ${who}!` : 'You\'re in!'}
      </p>
      <h1 id="first-session-title" className="mt-2.5 text-balance text-[30px] font-extrabold leading-[34px]">
        {existing ? `Welcome to ${info.name}.` : 'On Homeroom, communities make apps together.'}
      </h1>
      <p className="mt-2.5 text-pretty text-[16px] leading-[22px] text-zinc-500 dark:text-zinc-400">
        {existing
          ? `${maker ? `${maker} ${made} it for the group.` : 'It is the group\'s own app.'} Have a look, then say hi.`
          : 'Anyone using an app can change it. The group decides what goes in.'}
      </p>
      {existing ? null : (
        <div className="mt-6 rounded-2xl bg-white p-4 text-left shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
          <p className="text-[13px] font-semibold uppercase tracking-[0.8px] text-zinc-500 dark:text-zinc-400">How it works</p>
          <ol className="mt-3 grid gap-2.5">
            {[
              maker ? `Someone makes an app for their group. ${maker} ${made} this one.` : 'Someone makes an app for their group.',
              'Anyone in the group can suggest an improvement. Homeroom bot builds it.',
              'The group decides what goes in.',
            ].map((line, i) => (
              <li key={line} className="flex items-start gap-2.5 text-[15px] leading-snug text-zinc-700 dark:text-zinc-200">
                <span className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-violet-600 text-[12px] font-bold text-white">{i + 1}</span>
                <span>{line}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <JoinedPicture slug={info.slug} name={info.name} picture={joinPicture(info.picture)} description={info.description} tile={tile} building={!!info.building} compact={!existing} />
      <div className="grow" />
      <Button
        ref={go}
        type="button"
        onClick={() => onGo(stage.current)}
        layout="full"
        variant="pillAccent"
        size="pillLg"
        ink="solidLate"
        className="mt-8 flex items-center justify-center"
      >
        {`Go to ${info.name}`}
      </Button>
    </WelcomeFrame>
  );
}

export type Mode =
  | { kind: 'none' }
  | { kind: 'held' }
  | { kind: 'welcome'; info: FirstSessionInfo }
  // `entry` 'create' is the Create button's (see the header); none is the first session's.
  | { kind: 'make'; entry?: MakeEntry }
  | { kind: 'made'; made: Made; entry?: MakeEntry }
  | { kind: 'tour'; info: FirstSessionInfo; path: 'invited' | 'maker' | 'private' };

// Set by the signed-out story's sheet for an account it just made
// (../auth/landing.tsx): ask it what to make once the shell has signed in.
// An account that signed in any other way (a password, a code, a provider)
// is asked through make() below instead, by the join screen it would
// otherwise have seen (../auth/communities-first-run.js). So is every later
// boot of an account that has not answered yet: the question is the
// account's to answer, not this tab's, and the flag only gets the first
// showing there a tick sooner.
const MAKE_FLAG = 'usernode:first-session:make';

export const LOOK_AROUND_PATH = '/api/me/first-session/look-around';

/**
 * The question was answered in this document: Make it made a project, or
 * "Look around first". It is not opened here again, whatever asks: the
 * verified session read can land after the answer and before the server has
 * it (a reload's snapshot boot, ../auth/communities-first-run.js).
 */
let answeredHere = false;

/**
 * Answered: the shell's copy of the account says so, and so does this
 * device's session snapshot, so the next boot does not draw the make screen
 * from it before the session is confirmed. The server's own record is Make
 * it's POST /api/apps, or recordLookAround below.
 */
export function noteAnswered(): void {
  answeredHere = true;
  const app = legacy().App;
  if (!app?.user) return;
  app.user.needsCommunitiesChoice = false;
  try { app.saveSessionSnapshot?.(app.user); } catch { /* the next boot reads the server */ }
}

/**
 * "Look around first", told to the server so the question is not asked
 * again (src/routes/onboarding.js). Fire and forget: a request that fails
 * leaves it owed, and the next boot asks it again, which is the honest
 * outcome when the answer never arrived. Never a console.error.
 */
export async function recordLookAround(): Promise<void> {
  try {
    await fetch(LOOK_AROUND_PATH, { method: 'POST', credentials: 'same-origin' });
  } catch { /* asked again on the next boot */ }
}

/**
 * Open "What do you want to make?", unless something else is already up.
 * `now` draws it before returning: asked from the signed-in shell's own
 * start (`sv:authed`, or the join step in that same tick), that is before the
 * browser paints the Home the shell has just shown, so the make screen is
 * the first thing seen after the sign-in sheet leaves. Never from a render
 * or an effect, where React cannot draw synchronously.
 */
export function openMake(setMode: Dispatch<SetStateAction<Mode>>, now: boolean): void {
  if (answeredHere) return;
  const open = () => setMode((prev) => (prev.kind === 'none' ? { kind: 'make' } : prev));
  if (now) flushSync(open);
  else open();
}

function viewerName(): string {
  const user = legacy().App?.user;
  return user?.displayName || user?.username || '';
}

/**
 * Whether Homeroom bot builds this viewer's first version (make.tsx
 * makeLine). Only a `homeroomBotDm` the server said false turns it off: a
 * session snapshot from before the field still reads as the bot, which is
 * what the make screen always said.
 */
export function viewerBotBuilds(user: { homeroomBotDm?: boolean } | null | undefined): boolean {
  return user?.homeroomBotDm !== false;
}

/**
 * "What do you want to make?" from the Create button, over nothing else.
 * Answers whether it opened, so App.showCreateModal can fall back to the
 * New project dialog when something already holds the screen.
 */
export function openCreate(setMode: Dispatch<SetStateAction<Mode>>): boolean {
  let opened = false;
  flushSync(() => setMode((prev) => {
    if (prev.kind !== 'none') return prev;
    opened = true;
    return { kind: 'make', entry: 'create' };
  }));
  if (opened) void invalidateAppAllowance();
  return opened;
}

export function FirstSession() {
  const [mode, setMode] = useState<Mode>({ kind: 'none' });

  // An account the story's sheet just made is asked what to make, once,
  // as soon as the shell has signed it in with access (`sv:authed` fires
  // only then; somebody still waiting is in the waiting room instead).
  useEffect(() => {
    const check = (now: boolean) => {
      let flagged = false;
      try { flagged = sessionStorage.getItem(MAKE_FLAG) === '1'; } catch { /* no make screen */ }
      if (!flagged) return;
      // On a phone, the verified-identity rule's phone step comes first
      // (../auth/phone-first-run.tsx): the make screen opens once it is done.
      const phone = legacy().PhoneFirstRun;
      if (now && phone?.comesFirst?.(legacy().App?.user)) {
        void phone.settled().then(() => check(false));
        return;
      }
      try { sessionStorage.removeItem(MAKE_FLAG); } catch { /* shown once anyway */ }
      openMake(setMode, now);
    };
    if (legacy().App?.user) check(false);
    const onAuthed = () => check(true);
    document.addEventListener('sv:authed', onAuthed);
    return () => document.removeEventListener('sv:authed', onAuthed);
  }, []);

  // The bridge App._followInvite calls. welcome() answers whether it will
  // show, so the caller can land the viewer the old way when it will not.
  useEffect(() => {
    const w = legacy();
    w.UsernodeReact = w.UsernodeReact || {};
    const api = {
      welcome(info: FirstSessionInfo): boolean {
        if (!info || !info.slug || seen(info.slug)) return false;
        markSeen(info.slug);
        // A PRIVATE MEMBER lands inside the app the link was for, full
        // screen, instead of "You're in" and the hub: Homeroom is what the
        // mark menu's "Go to Homeroom" opens, and its tour (goHome) runs
        // then. A frame held for the welcome goes.
        if (legacy().App?.user?.privateMember) {
          setMode((prev) => (prev.kind === 'held' ? { kind: 'none' } : prev));
          enterScreen('app', info.slug);
          return true;
        }
        setMode({ kind: 'welcome', info });
        return true;
      },
      // The mark menu's "Go to Homeroom" for a private member (features/
      // app-context): Home, and the first time, the four-step tour of it
      // from the app they were in. From then on the app has its ✕ again
      // (App._privateHomeVisited, public/js/app.js).
      goHome(info: { slug?: string | null; name?: string | null }): void {
        const app = legacy().App;
        const first = !app?._privateHomeVisited?.();
        app?._notePrivateHome?.();
        app?.navigateHome?.();
        if (!first || !info?.slug) return;
        rememberCommunity(info.slug);
        setMode((prev) => (prev.kind === 'none'
          ? { kind: 'tour', info: { slug: info.slug as string, name: info.name || (info.slug as string) }, path: 'private' }
          : prev));
      },
      // "You're in"'s frame, drawn before this returns (see the header):
      // App._followInvite asks for it in the tick the signed-in shell starts,
      // before the shell draws Home. Only over nothing: a screen already up
      // stays.
      holdWelcome(): boolean {
        let held = false;
        flushSync(() => setMode((prev) => {
          if (prev.kind !== 'none' && prev.kind !== 'held') return prev;
          held = true;
          return { kind: 'held' };
        }));
        return held;
      },
      // The follow ended some other way (the hub, a confirm, a toast): the
      // frame goes, and only the frame.
      endHold(): void {
        setMode((prev) => (prev.kind === 'held' ? { kind: 'none' } : prev));
      },
      // "What do you want to make?" for an account that is due the join
      // screen and did not come through the story's sheet, and for any
      // account still due it on a later boot. Nothing else is open by the
      // time the join screen's turn comes, and if the story's own flag got
      // there first this leaves its screen as it is.
      make(): boolean {
        try { sessionStorage.removeItem(MAKE_FLAG); } catch { /* shown once anyway */ }
        openMake(setMode, true);
        return true;
      },
      // A make screen drawn from the session snapshot, for an account the
      // confirmed session says is no longer due it (answered on another
      // device, say). Only that screen: once Make it has made something,
      // what follows it stays.
      dismissMake(): void {
        setMode((prev) => (prev.kind === 'make' && prev.entry !== 'create' ? { kind: 'none' } : prev));
      },
      // The Create button (App.showCreateModal): the one front door for a
      // new project, for every signed-in viewer.
      create(): boolean {
        return openCreate(setMode);
      },
      // The New project dialog, after it made a project from a description
      // (its More options path): the same made screen Make it ends on.
      made(made: Made): boolean {
        if (!made || !made.slug) return false;
        setMode({ kind: 'made', made, entry: 'create' });
        return true;
      },
    };
    w.UsernodeReact.firstSession = api;
    return () => { if (w.UsernodeReact?.firstSession === api) delete w.UsernodeReact.firstSession; };
  }, []);

  const end = useCallback(() => setMode({ kind: 'none' }), []);

  // The Create door's screens own the device's back press, as the New
  // project dialog they stand in for did (lib/back-stack.ts): back closes
  // them, from the make screen or the made one (the claim is kept across
  // Make it). Left any other way, the claim is handed back first (leaveDoor):
  // as a navigating one when the way out goes somewhere (the hub, the chat,
  // a dialog that claims its own), so its queued traversal cannot undo that.
  const createDoor = (mode.kind === 'make' || mode.kind === 'made') && mode.entry === 'create';
  const doorBack = useRef<Release | null>(null);
  useEffect(() => {
    if (!createDoor) return undefined;
    const release = pushDismissible(() => {
      doorBack.current = null;
      setMode((prev) => ((prev.kind === 'make' || prev.kind === 'made') && prev.entry === 'create' ? { kind: 'none' } : prev));
      return true;
    });
    doorBack.current = release;
    return () => {
      if (doorBack.current !== release) return;
      doorBack.current = null;
      release();
    };
  }, [createDoor]);
  const leaveDoor = useCallback((navigating: boolean) => {
    const release = doorBack.current;
    doorBack.current = null;
    release?.(navigating ? { navigating: true } : undefined);
    setMode({ kind: 'none' });
  }, []);
  const steps = useMemo(() => {
    if (mode.kind !== 'tour') return [];
    const project = {
      slug: mode.info.slug, name: mode.info.name, conversationId: mode.info.conversationId, firstVersion: mode.info.firstVersion,
    };
    if (mode.path === 'private') return privateSteps(project);
    return mode.path === 'maker' ? makerSteps(project) : invitedSteps(project);
  }, [mode]);

  if (mode.kind === 'make' && mode.entry === 'create') {
    return (
      <MakeScreen
        who={viewerName()}
        entry="create"
        botBuilds={viewerBotBuilds(legacy().App?.user)}
        // Nothing is answered: the tile behind is refreshed, so the new
        // project is in the grid when the made screen goes, and the
        // allowance is read again.
        onMade={(made) => {
          legacy().Home?.load?.();
          void invalidateAppAllowance();
          setMode({ kind: 'made', made, entry: 'create' });
        }}
        onClose={() => leaveDoor(false)}
        // The New project dialog, with what has been typed so far. It claims
        // the back press itself, so this one goes as a navigating release.
        onMoreOptions={(draft) => {
          leaveDoor(true);
          legacy().UsernodeReact?.dialogs?.create?.open?.(draft);
        }}
      />
    );
  }
  if (mode.kind === 'make') {
    return (
      <MakeScreen
        who={viewerName()}
        botBuilds={viewerBotBuilds(legacy().App?.user)}
        // POST /api/apps answered the question as it made the project.
        onMade={(made) => { noteAnswered(); setMode({ kind: 'made', made }); }}
        onLookAround={() => {
          noteAnswered();
          void recordLookAround();
          setMode({ kind: 'none' });
          legacy().App?.navigateHome?.();
        }}
      />
    );
  }
  if (mode.kind === 'made') {
    const { made } = mode;
    const fromCreate = mode.entry === 'create';
    return (
      <MadeScreen
        made={made}
        me={viewerName()}
        entry={mode.entry}
        onContinue={() => {
          const info = { slug: made.slug, name: made.name, iconEmoji: made.emoji, conversationId: made.conversationId };
          markSeen(made.slug);
          rememberCommunity(made.slug);
          // From Create: the project's own hub, where its first change is
          // started, as the New project dialog's Open project went. The
          // tour is the first session's.
          if (fromCreate) {
            leaveDoor(true);
            enterScreen('hub', made.slug);
            return;
          }
          enterScreen('home', made.slug);
          setMode({ kind: 'tour', info, path: 'maker' });
        }}
        // The plan is answered in the chat with Homeroom bot: the first
        // session ends there, with no tour over it.
        onOpenChat={(conversationId) => {
          markSeen(made.slug);
          rememberCommunity(made.slug);
          setMode({ kind: 'none' });
          if (fromCreate) leaveDoor(true);
          enterScreen('bot', made.slug, conversationId);
        }}
        // A setup waiting on its secrets: the project's secrets dialog,
        // with this screen out of its way.
        onSetSecrets={() => {
          leaveDoor(true);
          legacy().Secrets?.open?.(made.slug);
        }}
      />
    );
  }

  if (mode.kind === 'welcome') {
    return (
      <YoureIn
        info={mode.info}
        onGo={(firstVersion) => {
          rememberCommunity(mode.info.slug);
          enterScreen('home', mode.info.slug);
          setMode({ kind: 'tour', info: { ...mode.info, firstVersion }, path: 'invited' });
        }}
      />
    );
  }
  if (mode.kind === 'held') return <WelcomeHeld />;
  if (mode.kind === 'tour') return <Tour info={mode.info} steps={steps} onEnd={end} />;
  return null;
}
