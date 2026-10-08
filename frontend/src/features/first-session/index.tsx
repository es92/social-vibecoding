/**
 * The first session after an invite: "You're in", then a short tour on the
 * real screens.
 *
 *   welcome  "You're in" (#4052): on the landing's wallpaper, under the
 *            Homeroom logo bar, then "Welcome to <name>",
 *            then what the community makes together, its app's thumbnail
 *            (./sketch-card.tsx, with no build line), then everyone in it,
 *            one row each, the inviter first and you marked "You", and
 *            "Go to <name>" fixed at the foot (owner, 7 October: it should
 *            read as a community, the people and the thing they build). The
 *            story was told once, on the invite page, and the tour teaches
 *            the rest: no "How it works" (Evan, onboarding test, 6 October
 *            2026).
 *            Go to starts the tour, told whether its first version is still
 *            being built (read here from GET /api/apps/:slug, now that they
 *            may).
 *   tour     ./tour-steps.ts, over the live shell. Each screen is shown whole
 *            first, then the control that leads on is cut out of the dim and
 *            the reader presses it, or the card's blue hint, which presses
 *            the same control: the product's own handler navigates, and
 *            the tour only watches the press. Back re-opens the screen the
 *            previous step was on; Skip ends on the last step's screen.
 *            The make screen opens it too: the maker's path after the made
 *            screen, and "Look around first"'s own four cards on Home.
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
 * "What do you want to make?" through `create()`, with `entry` 'create'
 * (`create({ import: true })`, from #create/import, opens it on importing a
 * GitHub repo). From there it ends on the project's hub rather than on the
 * first session's tour, and it answers nothing the first session asks
 * (noteAnswered).
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
import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { Wordmark } from '@/components/ui/wordmark';

import { pushDismissible, type Release } from '../../lib/back-stack';
import { AppContext } from '../app-context/app-context-controller.js';
import { invalidateAppAllowance } from '../dialogs/app-allowance-store.js';
import { swatchFor } from '../messages/format';
import { cardPosition } from './card-placement';
import { type Made, type MakeEntry, MakeScreen } from './make';
import { FeaturedCard } from './sketch-card';
import { MadeScreen, madeAppOf, madeAppUrl } from './made';
import { APP_MENU, BOTTOM_BARS, type FirstVersionStage, invitedSteps, lookAroundSteps, makerSteps, privateSteps, type TourScreen, type TourStep } from './tour-steps';
import { setTourRunning } from './tour-running';

export type FirstSessionInfo = {
  slug: string;
  /** Homeroom bot's chat with the viewer, when it builds this project for them. */
  conversationId?: number | null;
  name: string;
  iconEmoji?: string | null;
  iconUrl?: string | null;
  /** The username of whoever sent the link, whose row "You're in" lists first. */
  inviter?: string | null;
  inviterName?: string | null;
  inviterMadeIt?: boolean;
  /** Its first version is still on its way: "<maker> is making it" (community-invites.js firstVersionPending). */
  building?: boolean;
  /**
   * The account was made by the sign-up the link opened (or is a test
   * account on its first sign-in: services/test-accounts.js onFirstRun).
   */
  newAccount?: boolean;
  /**
   * Who is in the community, how many in all, and what its app is, for
   * "You're in"'s list and card. Only a screenshot state carries them;
   * "You're in" reads them itself otherwise (GET /api/apps/:slug/community).
   */
  people?: Member[] | null;
  memberCount?: number | null;
  description?: string | null;
  /** A screenshot state's made-up welcome (youreInShot): Go to closes it. */
  shot?: boolean;
  picture?: unknown;
  /**
   * Where its first version stands, as "You're in" read it. The tour's cards
   * no longer say it (./tour-steps.ts): the app screen behind them does.
   */
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
      waitlistIdea?: string | null;
    } | null;
    _privateHomeVisited?: () => boolean;
    _notePrivateHome?: () => void;
    saveSessionSnapshot?: (user: unknown) => void;
    navigateHome?: (opts?: unknown) => void;
    navigateToApp?: (slug: string, tab: string) => unknown;
    _isScreenVisible?: (id: string) => boolean;
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
  // ../auth/username-first-run.js: set while it asks a provisional handle for a username.
  UsernameFirstRun?: { _publicAsk?: Promise<boolean> | null };
  Secrets?: { open?: (slug: string) => void };
  UsernodeReact?: Record<string, unknown>;
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

/** The longest the held frame waits on a private member's app (appDrawn). */
export const APP_DRAWN_MAX_MS = 10_000;

/**
 * Resolves once the app a private member is sent to (`going`, what
 * App.navigateToApp returned) is the screen, or that navigation has ended
 * somewhere else, or it has stopped to ask for a username: whichever comes
 * first, and within APP_DRAWN_MAX_MS. "You're in"'s held frame stays up
 * until then (#4215). For a provisional handle (a private group's phone
 * Join) the navigation reads the app's audience before it reveals anything
 * (App._navigateAfterUsername); by the time it does, Home has drawn the
 * project's tile under the frame, and the app grows out of it (the
 * navigation's zoom) with Home still up until the zoom ends. Taking the
 * frame down at the hand-off showed Home for that whole time.
 */
export function appDrawn(going: unknown, host: Legacy = legacy(), now: () => number = Date.now): Promise<void> {
  const app = host.App;
  const appUp = () => !!app?._isScreenVisible?.('app-view');
  const drawn = () => (appUp() && !app?._isScreenVisible?.('home-screen')) || !!host.UsernameFirstRun?._publicAsk;
  const pending = going as Promise<unknown> | null | undefined;
  if (drawn() || !pending || typeof pending.then !== 'function') return Promise.resolve();
  const until = now() + APP_DRAWN_MAX_MS;
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { settled = true; };
    pending.then(done, done);
    const check = () => {
      // Settled with no app up: it went somewhere else ("Not now", refused).
      if (drawn() || (settled && !appUp()) || now() > until) resolve();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
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

/** How far below the coach card the newest row of a transcript begins. */
const ROW_INSET = 8;

/**
 * Pure: how far a transcript scrolls so a row whose top is at `rowTop`
 * begins ROW_INSET below the coach card's foot (`cardBottom`): positive on,
 * negative back, 0 when it does already. The browser stops it at either end
 * of the transcript.
 */
export function scrollToBelow(cardBottom: number, rowTop: number, inset: number = ROW_INSET): number {
  return Math.round(rowTop - (cardBottom + inset));
}

type ScrollerLike = { scrollTop: number; getBoundingClientRect(): { top: number; height: number }; querySelectorAll(rows: string): ArrayLike<{ getBoundingClientRect(): { top: number; height: number } }> };

/**
 * A step's transcript (TourStep.newestBelowCard): its newest row begins just
 * under the coach card, which sits under the chat's header. The plan's title
 * and first lines show first, then as much of the rest as the screen holds,
 * its Build it on a phone of ordinary height. Shown down to its foot, the
 * plan had its title and first bullet under the card; at the foot of the
 * screen, the card covered its Build it (the owner, 6 and 7 October 2026).
 * Run every frame while the step is up, so it holds when the rows arrive
 * after the step lands and when the card or a row grows; the step covers its
 * cut-out, so the reader is never scrolled against their own hand. Answers
 * whether it scrolled.
 */
export function showNewestBelow(
  spec: { scroller: string; rows: string },
  cardBottom: number,
  root: { querySelectorAll(selectors: string): ArrayLike<unknown> } = document,
): boolean {
  const scroller = (Array.from(root.querySelectorAll(spec.scroller)) as ScrollerLike[])
    .find((el) => el.getBoundingClientRect().height > 0);
  if (!scroller) return false;
  const rows = scroller.querySelectorAll(spec.rows);
  const newest = rows.length ? rows[rows.length - 1] : null;
  if (!newest) return false;
  const by = scrollToBelow(cardBottom, newest.getBoundingClientRect().top);
  if (!by) return false;
  const before = scroller.scrollTop;
  scroller.scrollTop += by;
  return scroller.scrollTop !== before;
}

/** The coach card on screen, for a step that places a transcript under it. */
const CARD_SELECTOR = '[role="dialog"][aria-labelledby="first-session-tour-title"]';

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
 * itself, or within it the step's `press` (✕ in the app screen). `instead`
 * is whether what a step's card says instead is on screen (TourStep.instead:
 * the plan in the chat), read with the box, so the card's words change in
 * the frame the plan arrives.
 */
export type Measured = { step: number; box: Box | null; press?: Box | null; instead?: boolean };

export function boxForStep(measured: Measured, step: number): Box | null {
  return measured.step === step ? measured.box : null;
}

export function pressForStep(measured: Measured, step: number): Box | null {
  return measured.step === step ? (measured.press ?? null) : null;
}

/** A step's cut-out and the control it rings, measured now, for step `at`. */
export function measure(at: number, step: TourStep): Measured {
  const box = stepBox(step);
  const measured: Measured = { step: at, box, press: box && step.press ? targetBox(step.press) : box };
  if (step.instead) measured.instead = document.querySelectorAll(step.instead.when).length > 0;
  return measured;
}

/** The card's words for a step: what it says instead while that is on screen. */
export function wordsFor(step: TourStep, measured: Measured, at: number): { title: string; text: string } {
  const shown = step.instead && measured.step === at && measured.instead ? step.instead : step;
  return { title: shown.title, text: shown.text };
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

/**
 * Pure: does a target lie outside the band a step can show it in, between
 * the top bar's foot (`top`) and the foot bars' top (`bottom`)? Then it is
 * scrolled into view before it is ringed (the owner, 6 October 2026: "each
 * step scrolls its target into view"). A cut-out of a whole screen (taller
 * than the band) is a screen, not something to scroll to.
 */
export function outOfBand(box: Box, band: { top: number; bottom: number }): boolean {
  if (box.height > band.bottom - band.top) return false;
  return box.top < band.top || box.top + box.height > band.bottom;
}

/**
 * Bring a step's target into view, at once (a smooth scroll moves it under a
 * ring still following it): the first one drawn, centred, unless it is on
 * the tab bar or the top bar, which are always in view. Before that, a
 * target the screen holds back is drawn by pressing the step's `revealWith`.
 * Answers whether it is done: the target is there and in view.
 */
export function bringIntoView(step: Pick<TourStep, 'target' | 'revealWith'>, viewport: { width: number; height: number }): boolean {
  const el = (Array.from(document.querySelectorAll(step.target)) as HTMLElement[])
    .find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!el) {
    if (step.revealWith) pressTarget(step.revealWith);
    return false;
  }
  if (el.closest(`#platform-tabs, #platform-header, #platform-parked, ${APP_MENU}`)) return true;
  const header = document.getElementById('platform-header')?.getBoundingClientRect();
  const band = { top: header && header.height ? header.bottom : 0, bottom: footTop(visibleBoxes(BOTTOM_BARS), viewport) };
  const r = el.getBoundingClientRect();
  if (outOfBand({ left: r.left, top: r.top, width: r.width, height: r.height }, band)) {
    try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch { el.scrollIntoView(); }
  }
  return true;
}

/**
 * Pure: where the foot of the screen begins, the top of the bars lying along
 * it: the phone's tab bar and the Resume strip on it, each at least half the
 * screen wide and starting in its lower half. The rail beside the screen from
 * 768px up is neither, and a screen with no bar (the app, full screen) runs
 * to its own edge: the screen's height.
 */
export function footTop(bars: Box[], viewport: { width: number; height: number }): number {
  const H = viewport.height;
  const foot = bars.filter((b) => b.width >= viewport.width / 2 && b.top > H / 2 && b.top < H);
  return foot.length ? Math.min(...foot.map((b) => b.top)) : H;
}

/**
 * The coach card's position for a target box, as inline style
 * (./card-placement.ts does the arithmetic, over what this measures). It
 * never covers the tab bar, and it is always whole on the screen, on a
 * laptop beside its rail as on a phone (#4182).
 */
export function cardPlacement(
  box: Box | null,
  step: TourStep,
  viewport: { width: number; height: number },
  foot: number = footTop(visibleBoxes(BOTTOM_BARS), viewport),
): React.CSSProperties {
  const place = step.place;
  const above = place && typeof place === 'object' && 'above' in place ? document.querySelector(place.above) : null;
  const [below] = place && typeof place === 'object' && 'below' in place ? visibleBoxes(place.below) : [];
  return cardPosition(box, place, viewport, {
    foot,
    aboveTop: above ? above.getBoundingClientRect().top : null,
    belowBottom: below ? below.top + below.height : null,
    pad: PAD,
  });
}

/** The tour over the live shell (see the header); exported so a test can draw its card. */
export function Tour({ info, steps, onEnd, start = 0 }: { info: FirstSessionInfo; steps: TourStep[]; onEnd: () => void; start?: number }) {
  // A screenshot state may open it part-way (tourShot, below), on its own
  // screen; the tour itself always starts at its first card.
  const [index, setIndex] = useState(() => Math.max(0, Math.min(start, steps.length - 1)));
  const [measured, setMeasured] = useState<Measured>({ step: -1, box: null });
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const step = steps[index];
  const stepRef = useRef(step);
  stepRef.current = step;
  const indexRef = useRef(index);
  indexRef.current = index;
  const box = boxForStep(measured, index);
  const pressBox = pressForStep(measured, index);

  // While it is up, the hub's first-version card and the App tab hold back
  // their "Review the plan" (./tour-running.ts): only the last card speaks of
  // the plan.
  useEffect(() => {
    setTourRunning(true);
    return () => setTourRunning(false);
  }, []);

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
    // The step whose target was brought into view, and how many frames it
    // has had to appear (a press of `revealWith` is tried once).
    let shown = -1;
    let tries = 0;
    let lastAt = -1;
    const tick = () => {
      try {
        const at = indexRef.current;
        if (at !== lastAt) { lastAt = at; tries = 0; }
        // Into view first, once per step, so it is ringed where it shows.
        if (shown !== at && tries < 240) {
          // `revealWith` is pressed once, half a second in: a screen still
          // drawing its target gets that long first.
          const step = stepRef.current;
          const asked = tries === 30 ? step : { target: step.target };
          if (bringIntoView(asked, { width: window.innerWidth, height: window.innerHeight })) shown = at;
          tries += 1;
        }
        // Before measuring, so the cut-out is drawn round what it shows.
        const reveal = stepRef.current.newestBelowCard;
        const card = reveal ? document.querySelector(CARD_SELECTOR)?.getBoundingClientRect() : null;
        if (reveal && card && card.height) showNewestBelow(reveal, card.bottom);
        const m = measure(at, stepRef.current);
        // The words too: the plan coming into the chat moves no box.
        const key = `${at}:${boxKey(m.box)}:${boxKey(m.press)}:${m.instead ? 1 : 0}`;
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

  // Opened part-way: the step's own screen, as Back would open it. Once,
  // for where it was opened; every later step opens its own in go().
  useEffect(() => {
    if (index > 0) enterScreen(steps[index].screen, info.slug, info.conversationId);
  }, []);

  // A step inside the Homeroom menu (TourStep.inMenu) has it open: the tap
  // before it opened it, and Back to it, or a tour opened part-way on it,
  // opens it here. Moving on from it closes it, Back and Skip included, so
  // the steps after it are on the app with nothing over it.
  const inMenu = !!step.inMenu;
  useEffect(() => {
    if (!inMenu) return undefined;
    if (!AppContext.isOpen()) AppContext.open();
    return () => { if (AppContext.isOpen()) void AppContext.close(); };
  }, [inMenu, index]);

  // A step whose target never shows (a screen that did not open) opens its
  // screen itself after a moment; a step in the menu, the menu.
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (targetBox(step.target)) return;
      if (step.inMenu && !AppContext.isOpen()) AppContext.open();
      else enterScreen(step.screen, info.slug, info.conversationId);
    }, 2500);
    return () => window.clearTimeout(t);
  }, [index, step, info.slug]);

  const go = useCallback((to: number) => {
    if (to < 0) return;
    if (to >= steps.length) { onEnd(); return; }
    // Back to a step in the menu stays on its screen: the menu opens over it
    // (inMenu, above), and re-entering the app could close it again.
    if (steps[to].screen !== steps[index].screen || (to < index && !steps[to].inMenu)) enterScreen(steps[to].screen, info.slug, info.conversationId);
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
  // So does a step that only points at a control (`ringed`). Any other
  // cut-out runs to the screen's edges.
  const pointed = !!(step.tap || step.ringed);
  const hole = box && holeFor(box, viewport, pointed && !step.press ? RING : 0);
  const ring = hole && pointed && pressBox ? holeFor(pressBox, viewport) : null;
  // Presses reach only a tap step's control: a step that only shows its
  // screen, or points at a control, covers all of its cut-out, and a tap
  // step all of it but the ring.
  const covers = hole ? (ring && step.tap ? aroundBox(hole, ring) : [hole]) : [];
  const card = cardPlacement(box, step, viewport);
  const words = wordsFor(step, measured, index);

  return (
    // The layer itself lets presses through: only the shades, the card and
    // the covers over the cut-out take them, so the control the step asks
    // for is pressable.
    // A step in the menu is drawn over it: on touch the menu is a kit sheet
    // (z-index 9991), and under it the card's Next was under its backdrop.
    <div data-first-session-tour={index + 1} className={step.inMenu ? 'pointer-events-none fixed inset-0 z-[9995]' : 'pointer-events-none fixed inset-0 z-[9000]'}>
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
        data-tour-says-where-it-opens={step.saysWhereItOpens ? '' : undefined}
        className="pointer-events-auto fixed left-4 right-4 mx-auto max-w-md rounded-[20px] bg-white p-4 text-zinc-900 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.6)] dark:bg-zinc-800 dark:text-zinc-100"
        style={card}
      >
        <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{`${index + 1} of ${steps.length}`}</p>
        <p id="first-session-tour-title" className="mt-0.5 text-[17px] font-semibold leading-snug">{words.title}</p>
        <p className="mt-1 text-[15px] leading-snug text-zinc-600 dark:text-zinc-300">{words.text}</p>
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
 * "You're in"'s ground: the landing's wallpaper, full screen, under the
 * Homeroom logo bar every first-run screen wears (owner, 7 October). Held
 * empty (WelcomeHeld) while the invite's standing is read.
 */
function WelcomeFrame({ children, foot = null, held = false }: { children: React.ReactNode; foot?: React.ReactNode; held?: boolean }) {
  return (
    <div
      role="dialog"
      aria-labelledby={held ? undefined : 'first-session-title'}
      aria-label={held ? 'Opening your invite' : undefined}
      data-first-session-welcome={held ? 'held' : ''}
      className="fixed inset-0 z-[9000] flex flex-col text-zinc-900 dark:text-zinc-100"
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      <div className="flex h-[52px] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)]">
        <Wordmark className="h-6 w-auto text-zinc-950 dark:text-white" />
      </div>
      {/* The page scrolls under a foot that stays: a long list of people
          never pushes the one button off the screen. */}
      <div data-first-session-scroll="" className="min-h-0 flex-1 overflow-y-auto">
        <div className={`mx-auto flex min-h-full w-full max-w-sm flex-col px-6 text-center ${foot ? 'pb-4' : 'pb-[max(40px,env(safe-area-inset-bottom))]'}`}>
          {children}
        </div>
      </div>
      {foot ? (
        <div data-first-session-foot="" className="mx-auto w-full max-w-sm shrink-0 px-6 pb-[max(24px,env(safe-area-inset-bottom))] pt-3">
          {foot}
        </div>
      ) : null}
    </div>
  );
}

/** The frame while the invite's standing is read: where its words will be. */
export function WelcomeHeld() {
  return (
    <WelcomeFrame held>
      <SkeletonGroup label="Opening your invite" className="my-auto flex flex-col items-center pb-10">
        <span className="flex">
          <Skeleton shape="block" className="h-10 w-10 rounded-full" />
          <Skeleton shape="block" className="-ml-2.5 h-10 w-10 rounded-full" />
        </span>
        <Skeleton className="mt-5 w-32" />
        <Skeleton shape="block" className="mt-3 h-9 w-64" />
      </SkeletonGroup>
    </WelcomeFrame>
  );
}

export type YoureInShot = 'youre-in' | 'youre-in-many';

/** "You're in"'s screenshot state named by `?shot=`, or null. */
export function youreInShot(): YoureInShot | null {
  if (typeof location === 'undefined') return null;
  let shot: string | null = null;
  try { shot = new URLSearchParams(location.search || '').get('shot'); } catch { /* ignore */ }
  return shot === 'youre-in' || shot === 'youre-in-many' ? shot : null;
}

/**
 * The made-up welcome a screenshot state draws, for the before/after shots,
 * which cannot follow a link as one person and join as another: Sunday Run
 * Club, made by Maya, with the viewer just in it. `youre-in-many` has eight
 * people, more than a phone shows above the button, so the list scrolls.
 */
export function shotWelcome(shot: YoureInShot, viewer: string): FirstSessionInfo {
  const others = shot === 'youre-in-many'
    ? [['sam', 'Sam'], ['jordan', 'Jordan'], ['ada', 'Ada'], ['noor', 'Noor'], ['tom', 'Tom'], ['lena', 'Lena']]
    : [];
  const you = (typeof window !== 'undefined' && legacy().App?.user?.displayName) || null;
  const people = [['maya', 'Maya'], [viewer, you], ...others]
    .filter(([username]) => !!username)
    .map(([username, name]) => ({ username: username as string, name }));
  return {
    slug: 'sunday-run-club',
    name: 'Sunday Run Club',
    iconEmoji: '🏃',
    inviter: 'maya',
    inviterName: 'Maya',
    inviterMadeIt: true,
    building: true,
    newAccount: true,
    people,
    memberCount: people.length,
    description: "Track your club's weekly miles and see who keeps up",
    shot: true,
  };
}

/** One person in the community, as "You're in" lists them. */
export type Member = { username: string; name?: string | null };

/** The members a community read carries, cleaned: every one, in its order. */
export function membersOf(value: unknown): Member[] {
  if (!Array.isArray(value)) return [];
  const out: Member[] = [];
  for (const m of value) {
    if (!m || typeof m !== 'object') continue;
    const row = m as { username?: unknown; display_name?: unknown; name?: unknown };
    const username = String(row.username || '').trim();
    if (!username || out.some((o) => o.username === username)) continue;
    const name = String(row.name || row.display_name || '').trim();
    out.push({ username, name: name || null });
  }
  return out;
}

/**
 * Which member sent the link: by username when the welcome carries it, else
 * by the name it was shown under. Null when they are not in the list.
 */
export function inviterOf(members: Member[], inviter?: string | null, inviterName?: string | null): string | null {
  const found = members.find((m) => (inviter
    ? m.username === inviter
    : !!inviterName && (m.name === inviterName || m.username === inviterName)));
  return found ? found.username : null;
}

/**
 * The list's order: whoever sent the link first, then everyone else in the
 * order the community read gives (who started it, then the newest).
 */
export function rosterOrder(members: Member[], inviter: string | null): Member[] {
  const first = inviter ? members.findIndex((m) => m.username === inviter) : -1;
  return first > 0 ? [members[first], ...members.slice(0, first), ...members.slice(first + 1)] : members;
}

/** How many people, in words: "1 person", "8 people". */
export function peopleCount(n: number): string {
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

/**
 * One person's row: their face (their initial on the colour they wear across
 * the shell, ../messages/format.tsx), their name, and under it who they are
 * to you: "You", "Invited you", else their @username. 44px, the size of a
 * row's tile, so the hairline lines up as it does in every list.
 */
function MemberRow({ member, you, inviter }: { member: Member; you: boolean; inviter: boolean }) {
  const name = member.name || member.username;
  return (
    <ListRow
      data-first-session-member={member.username}
      chevron={false}
      leading={(
        <span
          aria-hidden="true"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[17px] font-bold text-white"
          style={{ background: swatchFor(member.username) }}
        >
          {name.charAt(0).toUpperCase()}
        </span>
      )}
      title={name}
      subtitle={you ? 'You' : inviter ? 'Invited you' : `@${member.username}`}
    />
  );
}

export function YoureIn({ info, onGo }: { info: FirstSessionInfo; onGo: (firstVersion: FirstVersionStage) => void }) {
  const user = legacy().App?.user;
  const [members, setMembers] = useState<Member[] | null>(() => (info.people ? membersOf(info.people) : null));
  const [count, setCount] = useState<number | null>(info.memberCount ?? null);
  const [description, setDescription] = useState<string | null>(info.description ?? null);
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => { go.current?.focus(); }, []);
  // Whether its first version is still being built, for the tour's App
  // step: the record as the App tab reads it, past the service worker's
  // cache. A read that fails leaves the step as it was. A screenshot state
  // has no record to read.
  const stage = useRef<FirstVersionStage>(info.firstVersion ?? (info.building ? 'building' : null));
  useEffect(() => {
    if (info.shot) return undefined;
    let live = true;
    fetch(madeAppUrl(info.slug), { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (live && body) stage.current = firstVersionStage(body); })
      .catch(() => {});
    return () => { live = false; };
  }, [info.slug, info.shot]);
  // Who is in it, every one of them, and what its app is: the hub's own
  // read. A read that fails leaves the card with its name and no list.
  useEffect(() => {
    if (info.shot || info.people) return undefined;
    let live = true;
    fetch(`/api/apps/${encodeURIComponent(info.slug)}/community?members=all`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!live) return;
        setMembers(body ? membersOf(body.members) : []);
        if (body) {
          setCount(Number(body.member_count) || null);
          setDescription(typeof body.description === 'string' ? body.description : null);
        }
      })
      .catch(() => { if (live) setMembers([]); });
    return () => { live = false; };
  }, [info.slug, info.shot, info.people]);
  const sender = members ? inviterOf(members, info.inviter, info.inviterName) : null;
  const roster = members ? rosterOrder(members, sender) : null;
  const total = Math.max(count || 0, roster ? roster.length : 0);
  return (
    <WelcomeFrame
      foot={(
        <Button
          ref={go}
          type="button"
          onClick={() => onGo(stage.current)}
          layout="full"
          variant="pillAccent"
          size="pillLg"
          ink="solidLate"
          className="flex items-center justify-center"
        >
          {`Go to ${info.name}`}
        </Button>
      )}
    >
      <h1 id="first-session-title" className="mt-6 text-balance text-[32px] font-extrabold leading-9 tracking-[-0.01em]">
        {`Welcome to ${info.name}`}
      </h1>
      {/* What the community makes together, above the people who make it. */}
      <div data-first-session-app="" className="mt-6">
        <FeaturedCard
          name={info.name}
          colorKey={info.name}
          emoji={info.iconEmoji || null}
          card={null}
          description={description}
          sketching={false}
        />
      </div>
      <div data-first-session-people="" className="text-left">
        {roster === null ? (
          <SkeletonGroup label="Loading who is in it" className="pt-6">
            <Skeleton className="mb-3 w-20" />
            <Skeleton shape="block" className="h-[146px] w-full rounded-[20px]" />
          </SkeletonGroup>
        ) : roster.length ? (
          <>
            <SectionHeader>{peopleCount(total)}</SectionHeader>
            <GroupedList className="mx-0">
              {roster.map((m) => (
                <MemberRow
                  key={m.username}
                  member={m}
                  you={!!user?.username && m.username === user.username}
                  inviter={m.username === sender}
                />
              ))}
            </GroupedList>
          </>
        ) : null}
      </div>
    </WelcomeFrame>
  );
}

export type Mode =
  | { kind: 'none' }
  // `app`: handed to a private member's app (welcome), and down once it is drawn.
  | { kind: 'held'; app?: string }
  | { kind: 'welcome'; info: FirstSessionInfo }
  // `entry` 'create' is the Create button's (see the header); none is the first session's.
  | { kind: 'make'; shot?: MakeShot; entry?: MakeEntry; startImport?: boolean }
  | { kind: 'made'; made: Made; entry?: MakeEntry }
  | { kind: 'tour'; info: FirstSessionInfo; path: TourPath; start?: number };

export type TourPath = 'invited' | 'maker' | 'look' | 'private';

/**
 * "Look around first"'s tour is about Home and the tab bar, not a project:
 * it carries no project, and every step is on Home.
 */
const LOOK_AROUND_INFO: FirstSessionInfo = { slug: '', name: '' };

/**
 * The tours' screenshot states. Only a brand-new account's first session
 * reaches a tour, so the before/after shots open one on demand (the owner's
 * ruling for first-run screens, 6 October 2026, as app-view.js draws
 * `?shot=first-version`): `?shot=tour-make`, `?shot=tour-join`,
 * `?shot=tour-look` and `?shot=tour-private`, and `&step=N` to open it at
 * its Nth card. Making, joining and a private member's tour are walked over
 * the first project on the viewer's Home, and making ends in their chat
 * with Homeroom bot when they have one. Nothing is
 * written: no answer to the question, no "seen" mark.
 */
const TOUR_SHOTS: Record<string, TourPath> = { 'tour-make': 'maker', 'tour-join': 'invited', 'tour-look': 'look', 'tour-private': 'private' };

export function tourShot(search: string): { path: TourPath; start: number } | null {
  let params: URLSearchParams;
  try { params = new URLSearchParams(search); } catch { return null; }
  const path = TOUR_SHOTS[params.get('shot') || ''];
  if (!path) return null;
  const n = Number(params.get('step'));
  return { path, start: Number.isInteger(n) && n > 1 ? n - 1 : 0 };
}

/** The first project on Home, as its card names it, once Home has drawn it. */
async function firstHomeProject(): Promise<{ slug: string; name: string } | null> {
  for (let i = 0; i < 40; i += 1) {
    const card = document.querySelector('#app-list .app-card[data-slug]');
    const slug = card?.getAttribute('data-slug');
    if (card && slug) {
      const title = card.querySelector('.app-card-title');
      return { slug, name: title?.getAttribute('title') || title?.textContent?.trim() || slug };
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250));
  }
  return null;
}

/** The viewer's chat with Homeroom bot, if they have one. */
async function botConversationId(): Promise<number | null> {
  try {
    const r = await fetch('/api/conversations', { credentials: 'same-origin' });
    if (!r.ok) return null;
    const body = await r.json() as { conversations?: Array<{ id?: unknown; kind?: unknown; homeroomBot?: unknown }> };
    const bot = (body.conversations || []).find((c) => c.kind === 'direct' && c.homeroomBot === true);
    return Number(bot?.id) || null;
  } catch {
    return null;
  }
}

async function openTourShot(shot: { path: TourPath; start: number }, setMode: Dispatch<SetStateAction<Mode>>): Promise<void> {
  const open = (info: FirstSessionInfo) => setMode((prev) => (
    prev.kind === 'none' ? { kind: 'tour', info, path: shot.path, start: shot.start } : prev
  ));
  legacy().App?.navigateHome?.();
  if (shot.path === 'look') { open(LOOK_AROUND_INFO); return; }
  const project = await firstHomeProject();
  if (!project) return;
  const conversationId = shot.path === 'maker' ? await botConversationId() : null;
  rememberCommunity(project.slug);
  open({ ...project, conversationId });
}

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
 * The make screen's screenshot states. Only a brand-new account's first run
 * reaches it, and staging's accounts are not new, so the before/after shots
 * open it by address instead (owner, 6 Oct 2026; app-view.js's
 * `?shot=first-version` is the same idea): `?shot=make` as it opens, and
 * `?shot=make-waitlist` with an answer from the waitlist in its first field.
 * Opened once the shell is signed in, as the real one is, and it writes
 * nothing: "Make it" makes nothing, "Look around first" only closes it.
 * Every first-run step before it skips itself on a `?shot=` address.
 */
export type MakeShot = { idea: string | null };
export const MAKE_SHOTS: Readonly<Record<string, string | null>> = Object.freeze({
  make: null,
  'make-waitlist': 'A tracker for my run club, so we can see who keeps up with their weekly miles',
});

/** The make screen's screenshot state a query string asks for, or null. */
export function makeShot(search: string): MakeShot | null {
  let shot: string | null = null;
  try { shot = new URLSearchParams(search).get('shot'); } catch { return null; }
  if (!shot || !Object.prototype.hasOwnProperty.call(MAKE_SHOTS, shot)) return null;
  return { idea: MAKE_SHOTS[shot] };
}

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
 * "What do you want to make?" from the Create button, over nothing else, or
 * open on importing a GitHub repo (`startImport`, #create/import). Answers
 * whether it opened: something already holding the screen keeps it.
 */
export function openCreate(setMode: Dispatch<SetStateAction<Mode>>, startImport = false): boolean {
  let opened = false;
  flushSync(() => setMode((prev) => {
    if (prev.kind !== 'none') return prev;
    opened = true;
    return startImport ? { kind: 'make', entry: 'create', startImport: true } : { kind: 'make', entry: 'create' };
  }));
  if (opened) void invalidateAppAllowance();
  return opened;
}

/**
 * Whether the platform header is on screen, for the Create door's screens
 * to sit below it (#4195). Not inside an app, where the header gives way to
 * the chromeless pill, nor in the side panel: there they take the whole
 * screen as before, rather than leave a band where no header is.
 */
export function platformHeaderShown(doc: Pick<Document, 'getElementById'> | null = typeof document === 'undefined' ? null : document): boolean {
  const header = doc?.getElementById('platform-header');
  return !!header && header.getClientRects().length > 0;
}

/**
 * Whether a press in the page leaves the Create door: a control in the
 * platform header (back, the bell, the workshop chip, the sidebar, the
 * mark's menu), now that the header shows above the door's screens.
 */
export function leavesDoor(target: EventTarget | null): boolean {
  const el = target as { closest?: (sel: string) => Element | null } | null;
  if (!el || typeof el.closest !== 'function') return false;
  const control = el.closest('a, button, [role="button"]');
  return !!control && !!control.closest('#platform-header');
}

export function FirstSession() {
  const [mode, setMode] = useState<Mode>({ kind: 'none' });

  // An account the story's sheet just made is asked what to make, once,
  // as soon as the shell has signed it in with access (`sv:authed` fires
  // only then; somebody still waiting is in the waiting room instead).
  useEffect(() => {
    const check = (now: boolean) => {
      const shot = makeShot(window.location.search);
      if (shot) {
        const open = () => setMode((prev) => (prev.kind === 'none' ? { kind: 'make', shot } : prev));
        if (now) flushSync(open);
        else open();
        return;
      }
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

  // `?shot=youre-in` and `?shot=youre-in-many`: "You're in" from made-up
  // data (shotWelcome), for the before/after shots, once the shell has a
  // signed-in viewer. Not once per project, and Go to only closes it.
  useEffect(() => {
    const shot = youreInShot();
    if (!shot) return undefined;
    const open = () => {
      if (!legacy().App?.user) return;
      setMode((prev) => (prev.kind === 'none' || prev.kind === 'held'
        ? { kind: 'welcome', info: shotWelcome(shot, legacy().App?.user?.username || viewerName()) } : prev));
    };
    open();
    document.addEventListener('sv:authed', open);
    return () => document.removeEventListener('sv:authed', open);
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
        // then. A frame held for the welcome goes once the app is on
        // screen, not before (appDrawn): never Home in between.
        if (legacy().App?.user?.privateMember) {
          // The follow's own ending (endHold) leaves a frame handed on.
          const { slug } = info;
          setMode((prev) => (prev.kind === 'held' ? { kind: 'held', app: slug } : prev));
          const going = legacy().App?.navigateToApp?.(slug, 'app');
          void appDrawn(going).then(() => setMode((prev) => (prev.kind === 'held' && prev.app === slug ? { kind: 'none' } : prev)));
          return true;
        }
        setMode({ kind: 'welcome', info });
        return true;
      },
      // The mark menu's "Go to Homeroom" for a private member (features/
      // app-context): Home, and the first time, the nine-step tour of the
      // app they were in (#4398). The visit is noted before the tour starts,
      // so the app has its ✕ again (App._privateHomeVisited, public/js/
      // app.js) and the tour's ✕ step has its control: keep that order.
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
      // frame goes, and only the frame. A frame welcome() handed to the app
      // stays until the app is drawn.
      endHold(): void {
        setMode((prev) => (prev.kind === 'held' && !prev.app ? { kind: 'none' } : prev));
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
      // new project, for every signed-in viewer; `import` opens it on
      // importing a GitHub repo.
      create(opts?: { import?: boolean }): boolean {
        return openCreate(setMode, !!opts?.import);
      },
    };
    w.UsernodeReact.firstSession = api;
    return () => { if (w.UsernodeReact?.firstSession === api) delete w.UsernodeReact.firstSession; };
  }, []);

  // A tour's screenshot state (tourShot): once, as soon as the shell is
  // signed in.
  useEffect(() => {
    const shot = tourShot(window.location.search);
    if (!shot) return undefined;
    let opened = false;
    const open = () => {
      if (opened || !legacy().App?.user) return;
      opened = true;
      void openTourShot(shot, setMode);
    };
    open();
    document.addEventListener('sv:authed', open);
    return () => document.removeEventListener('sv:authed', open);
  }, []);

  const end = useCallback(() => setMode({ kind: 'none' }), []);

  // The Create door's screens own the device's back press, as the New
  // project dialog they replaced did (lib/back-stack.ts): back closes them,
  // from the make screen or the made one (the claim is kept across Make it).
  // Left any other way, the claim is handed back first (leaveDoor): as a
  // navigating one when the way out goes somewhere (the hub, the chat, a
  // dialog that claims its own), so its queued traversal cannot undo that.
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
  // From Create the door's screens sit below the platform header when it
  // shows (#4195), read once as the door opens and kept from make to made.
  const underHeader = useMemo(() => createDoor && platformHeaderShown(), [createDoor]);
  // Going somewhere else leaves the door, as its own ways out do: a route
  // change (the hash), and any press on the header's controls, whose sheets
  // and menus open below the door's screens otherwise. The press goes on to
  // its control; the door only gets out of the way.
  useEffect(() => {
    if (!createDoor) return undefined;
    const onRoute = () => leaveDoor(true);
    const onPress = (e: Event) => { if (leavesDoor(e.target)) leaveDoor(true); };
    window.addEventListener('hashchange', onRoute);
    document.addEventListener('click', onPress, true);
    return () => {
      window.removeEventListener('hashchange', onRoute);
      document.removeEventListener('click', onPress, true);
    };
  }, [createDoor, leaveDoor]);
  const steps = useMemo(() => {
    if (mode.kind !== 'tour') return [];
    if (mode.path === 'look') return lookAroundSteps();
    const project = { slug: mode.info.slug, name: mode.info.name, conversationId: mode.info.conversationId };
    if (mode.path === 'private') return privateSteps(project);
    return mode.path === 'maker' ? makerSteps(project) : invitedSteps(project);
  }, [mode]);

  if (mode.kind === 'make' && mode.entry === 'create') {
    return (
      <MakeScreen
        who={viewerName()}
        entry="create"
        startImport={!!mode.startImport}
        underHeader={underHeader}
        // Nothing is answered: the tile behind is refreshed, so the new
        // project is in the grid when the made screen goes, and the
        // allowance is read again.
        onMade={(made) => {
          legacy().Home?.load?.();
          void invalidateAppAllowance();
          setMode({ kind: 'made', made, entry: 'create' });
        }}
        onClose={() => leaveDoor(false)}
      />
    );
  }
  if (mode.kind === 'make') {
    const { shot } = mode;
    return (
      <MakeScreen
        who={viewerName()}
        // What they said on the waitlist, if anything: known now, from the
        // signed-in user (or the screenshot state), so the box opens filled.
        idea={shot ? shot.idea : legacy().App?.user?.waitlistIdea ?? null}
        // POST /api/apps answered the question as it made the project.
        onMade={(made) => { noteAnswered(); setMode({ kind: 'made', made }); }}
        // Home, and its own short tour of where things are (decision E).
        onLookAround={() => {
          if (shot) { setMode({ kind: 'none' }); return; }
          noteAnswered();
          void recordLookAround();
          legacy().App?.navigateHome?.();
          setMode({ kind: 'tour', info: LOOK_AROUND_INFO, path: 'look' });
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
        underHeader={fromCreate && underHeader}
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
          if (mode.info.shot) { setMode({ kind: 'none' }); return; }
          rememberCommunity(mode.info.slug);
          enterScreen('home', mode.info.slug);
          setMode({ kind: 'tour', info: { ...mode.info, firstVersion }, path: 'invited' });
        }}
      />
    );
  }
  if (mode.kind === 'held') return <WelcomeHeld />;
  if (mode.kind === 'tour') return <Tour info={mode.info} steps={steps} onEnd={end} start={mode.start} />;
  return null;
}
