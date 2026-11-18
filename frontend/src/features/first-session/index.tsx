/**
 * The first session's screens: "What do you want to make?", the made screen,
 * then the newcomer's first visit to their app and to Home.
 *
 *   make     ./make.tsx, "What do you want to make?". Make it makes the
 *            project; "Look around first" goes Home, to its own four cards.
 *   made     ./made.tsx, the project made, its first invite, and the way on:
 *            "Invite people later", or "Go to app" once an invite is out.
 *            A project that runs (ready-made, or a first version that is
 *            live) opens full screen; one Homeroom bot is still building
 *            goes to Home, the newcomer's first visit to Homeroom, and the
 *            walk runs there.
 *   tip      ./app-tip.tsx: the first time they open the app after the
 *            hand-off, one tip under the Homeroom mark (./first-visit.ts
 *            says when it is due).
 *   tour     ./tour-steps.ts over the live shell: the walk on Home ("1, 2,
 *            3"), the first time Home shows after that first visit to the
 *            app, and "Look around first"'s four cards. Each card rings one
 *            place with the rest dimmed, and leads on with Next; Skip ends
 *            it where it is.
 *
 * An invite brings people in the same way (Evan, 15 Oct 2026: "You're in"
 * is gone). App._followInvite (public/js/app.js) and an invite accepted from
 * the notifications (Notifications._acceptInvite) call
 * `window.UsernodeReact.firstSession.welcome(info)`, once per account and
 * project (localStorage), when the link has just let the viewer in: it opens
 * the app itself, full screen, with the tip ("<inviter> invited you"), and
 * somebody new to Homeroom (a private member, or an account the link's
 * sign-up made) gets the walk on their first Home after it. Somebody who had
 * an account before gets the tip alone. It answers false when it will not
 * show, and the caller lands them where it always did.
 *
 * The same island is the platform's one front door for a new project: the
 * Create button (App.showCreateModal, public/js/app.js) opens
 * "What do you want to make?" through `create()`, with `entry` 'create'
 * (`create({ import: true })`, from #create/import, opens it on importing a
 * GitHub repo). From there it ends on the project's hub rather than on the
 * first session's tip and walk, and it answers nothing the first session
 * asks (noteAnswered).
 *
 * A sign-in from the invite's own page (Join, then the sheet) is followed in
 * the tick the signed-in shell starts, and the link's standing, which says
 * whether to welcome them, is a request away: Home showed for that long
 * before the welcome (Evan, 5 October 2026). So the follow asks for a held
 * frame first, `holdWelcome()`, drawn at once (flushSync) on the landing's
 * wallpaper, before the shell draws Home; welcome() hands it to the app,
 * and it goes once the app is on screen (appDrawn). `endHold()` takes it
 * down for any other ending. The make screen's own hand-off (#3894) works
 * the same way.
 *
 * ── The island rules ──────────────────────────────────────────────────
 *
 * It renders NOTHING until it is opened, so the prerendered shell is
 * unchanged, and only a press opens it, so the first client render matches.
 * Nothing in `public/js/**` writes into it; the legacy shell is only CALLED
 * (App.navigateHome, App.navigateToApp). The spotlight's geometry is
 * measured each frame from the target the step names and kept in state only
 * when it moves.
 */

import { type CSSProperties, type Dispatch, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { Button } from '@/components/ui/button';
import { SpinnerRingIcon } from '@/components/ui/icons';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import { Wordmark } from '@/components/ui/wordmark';

import { pushDismissible, type Release } from '../../lib/back-stack';
import { useMessages } from '../../lib/i18n/react';
import { usePageLock } from '../../lib/page-lock';
import { AppContext } from '../app-context/app-context-controller.js';
import { invalidateAppAllowance } from '../dialogs/app-allowance-store.js';
import { openFirstVersion } from '../ai/where';
import { AppTip } from './app-tip';
import { cardPosition } from './card-placement';
import {
  anyOwed, armWalk, claimWalk, clearLook, FIRST_VISIT_CHECK_MS, lookOwed, noteTipShown, noteWalkRun, oweLook, oweTip,
  owedTip, owedWalk, oweWalk, readScreen, type TipRecord, type TipWho, tipDue, walkArms, walkDue, type WalkRecord,
} from './first-visit';
// S01: the made screen kept across a reload (./first-visit.ts oweMade).
import { clearMade, oweMade, owedMade } from './first-visit';
import { type CreateAudience, type IdeaSource, type Made, type MakeEntry, MakeScreen, forgetKeptDraft } from './make';
import { MadeScreen, madeAppOf, madeAppUrl } from './made';
import { noteMoment } from './made-moments';
import { APP_MENU, BOTTOM_BARS, homeWalkSteps, lookAroundSteps, type TourScreen, type TourStep } from './tour-steps';
import { noteFirstSessionVisit, setTourRunning } from './tour-running';
import { appReady, tileSettled, TOUR_WAIT_MAX_MS, WAIT_CHECK_MS, WAIT_GRACE_MS, WAIT_POLL_MS } from './tour-wait';

export type FirstSessionInfo = {
  slug: string;
  /** Homeroom bot's chat with the viewer, when it builds this project for them. */
  conversationId?: number | null;
  name: string;
  iconEmoji?: string | null;
  iconUrl?: string | null;
  /** The username of whoever sent the link. */
  inviter?: string | null;
  /** The name they go by, which the tip says ("Maya invited you."). */
  inviterName?: string | null;
  inviterMadeIt?: boolean;
  /** Its first version is still on its way (community-invites.js firstVersionPending). */
  building?: boolean;
  /**
   * The account was made by the sign-up the link opened (or is a test
   * account on its first sign-in: services/test-accounts.js onFirstRun):
   * somebody new to Homeroom, whose first Home gets the walk.
   */
  newAccount?: boolean;
  /**
   * The walk's example of a change to ask Homeroom bot for in this project
   * (walkExample: GET /api/apps/:slug `exampleChange`, from its ready-made
   * starter). Not yet asked while undefined; null for a project with none.
   */
  example?: string | null;
};

type Legacy = {
  App?: {
    user?: {
      id?: number; username?: string; displayName?: string | null; needsCommunitiesChoice?: boolean; privateMember?: boolean;
      homeroomBotDm?: boolean;
      /** false while the account is still on the waitlist: the shell shows the waiting room. */
      hasPlatformAccess?: boolean;
      waitlistIdea?: string | null;
    } | null;
    _notePrivateHome?: () => void;
    /** The walk owed, or Homeroom reached, kept by the account too (public/js/app.js). */
    _noteHomeWalk?: (state: 'owed' | 'reached') => void;
    /** The page under the app, made Home (public/js/app.js). */
    _homeUnderApp?: () => void;
    saveSessionSnapshot?: (user: unknown) => void;
    navigateHome?: (opts?: unknown) => void;
    navigateToApp?: (slug: string, tab: string) => unknown;
    _isScreenVisible?: (id: string) => boolean;
    openDiscussionInHub?: (slug: string) => void;
    _WORKSHOP_VIEW_KEY?: string;
    _workshopViewPath?: (url: string) => string | null;
    _publishCommunityScope?: (slug: string | null) => void;
    resumeWorkshopView?: () => boolean;
  };
  AppView?: {
    _landOnHub?: (slug: string) => void;
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
  // 14 Nov 2026: the project's first-version thread on the Homeroom bot tab
  // (../ai/where.ts asks the server which it is), or the tab's own page when
  // it has none yet. It was Main Chat, which is gone.
  else if (screen === 'bot' && conversationId) void openFirstVersion(slug);
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

/**
 * #5528 FOR THE MAKER'S WALK TOO (newcomer run, 20 Oct 2026): the Home tour
 * ends on Communities, and the walk ended where it started, on Home. Done on
 * its last card, the Communities tab's ("{{app}}'s hub is here"), now opens
 * that tab on the project's hub, as a press on the tab it rings does once
 * the tab remembers the project (rememberCommunity, App.resumeWorkshopView);
 * straight to the hub when the tab cannot resume it. Skip stays on Home.
 */
export function walkDoneLanding(slug: string): void {
  rememberCommunity(slug);
  if (legacy().App?.resumeWorkshopView?.()) return;
  enterScreen('hub', slug);
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

const PAD = 6;
/** The ring's width (`ring-[3px]` below), kept on screen around a hole. */
const RING = 3;
/*
 * ONE SHADE, ONE SHAPE (onboarding run two, 12 Oct 2026, iPhone 17 Safari).
 * The dim was four strips round the cut-out, each easing on its own: as the
 * ring went from the mark to "Suggest an improvement", light rectangles
 * flashed across the page for about 150ms, and the cut-out's square corners
 * stood out round the rounded ring on every step. Now the dim is one box the
 * size of the cut-out whose shadow is the dim (DIM, `dimStyle`), rounded as
 * the ring is, moving as one. The four strips stay, clear, to take the
 * presses outside the cut-out (SHADE); with no cut-out the whole screen is
 * one dim that takes them (SHADE_ALL).
 */
const SHADE = 'pointer-events-auto fixed';
const SHADE_ALL = 'pointer-events-auto fixed inset-0 bg-[rgba(9,9,12,0.6)]';
/*
 * IT GLIDES FROM STEP TO STEP, AND ONLY THEN (onboarding run three, 12 Oct
 * 2026): eased all the time, the cut-out chased whatever its target did
 * within a step. Leaving the menu it followed "Suggest an improvement" down
 * with the sheet, a light bar sliding across the page; on Home it glided
 * down 40pt and back over 250ms. Now it eases for the move a step makes
 * (`gliding`, GLIDE_MS) and follows its target at once otherwise.
 */
const DIM = 'pointer-events-none fixed';
const DIM_GLIDE = 'pointer-events-none fixed motion-safe:transition-[left,top,width,height] motion-safe:duration-200 motion-safe:ease-out';
const GLIDE_MS = 260;
/** The cut-out's corners: the ring's (`rounded-2xl`) round a control, square for a screen. */
export const HOLE_RADIUS = 16;

/** The dim drawn round a cut-out: its shadow, spread past any screen. */
export function dimStyle(hole: Box, rounded: boolean): CSSProperties {
  return {
    left: hole.left,
    top: hole.top,
    width: hole.width,
    height: hole.height,
    borderRadius: rounded ? HOLE_RADIUS : 0,
    boxShadow: '0 0 0 200vmax rgba(9,9,12,0.6)',
  };
}

/*
 * INTO THE MENU, THE RING WAITS FOR THE MENU (Evan, 10 Oct 2026, iPhone).
 * The step after the Homeroom mark points inside the menu that tap opens,
 * and on touch that menu is a kit sheet springing up from below (native.js
 * presentSheet, about 0.45s, with no event when it stops). Measured every
 * frame, the ring left the mark, then rode up with the sheet from the
 * screen's foot, and the card hopped from place to place with it. Now, into
 * a step in the menu from the step before it, the mark's ring stays where it
 * is and the card is hidden until the target has held still, wholly on
 * screen, for SETTLE_FRAMES frames (or SETTLE_CAP_MS has passed); then the
 * ring moves there once, over MOVE's 200ms, the shades with it, and the card
 * shows. The home tour waits for its sheet the same way
 * (../home/tour/index.tsx SETTLE_FRAMES).
 */
const SETTLE_FRAMES = 2;
const SETTLE_CAP_MS = 700;
const MOVE = 'motion-safe:transition-[left,top,width,height] motion-safe:duration-200 motion-safe:ease-out';

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
 * itself, or within it the step's `press` (✕ in the app screen, Open app on
 * the hub).
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
 * The surface a `{ clear }` step keeps its card off (./card-placement.ts
 * clearOf), as the reader sees it: the first element it names that is on
 * the page, or, on touch, the kit's sheet that presents it (native.js
 * presentSheet lifts the menu into `.un-sheet`, whose grabber and rounded
 * top sit above the menu's own box; ../home/tour/spotlight.ts panelBox
 * measures the same surface). Null when none is drawn.
 */
export function surfaceBox(selectors: string, root: Pick<Document, 'querySelectorAll'> = document): Box | null {
  for (const el of Array.from(root.querySelectorAll(selectors))) {
    const surface = (typeof el.closest === 'function' ? el.closest('.un-sheet') : null) || el;
    const r = surface.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  return null;
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
  const clear = place && typeof place === 'object' && 'clear' in place ? surfaceBox(place.clear) : null;
  return cardPosition(box, place, viewport, {
    foot,
    aboveTop: above ? above.getBoundingClientRect().top : null,
    belowBottom: below ? below.top + below.height : null,
    clear,
    pad: PAD,
  });
}

/**
 * The walk's step indicator, in place of the "1 of 3" counter: one small
 * numbered circle per card, this card's filled in the ink that marks where
 * you are (--lit-ink), the rest outlined.
 */
export function StepDots({ at, total }: { at: number; total: number }) {
  const t = useMessages('onboarding');
  return (
    <ol data-first-session-steps="" aria-label={t('onboarding:firstSession.walk.steps', { step: at + 1, total })} className="mb-1.5 flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <li
          key={i}
          aria-current={i === at ? 'step' : undefined}
          className={i === at
            ? 'flex h-5 w-5 items-center justify-center rounded-full bg-[color:var(--lit-ink)] text-[11px] font-bold leading-none text-white dark:text-zinc-950'
            : 'flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold leading-none text-zinc-500 shadow-[inset_0_0_0_1.5px_rgba(161,161,170,0.6)] dark:text-zinc-400'}
        >
          {i + 1}
        </li>
      ))}
    </ol>
  );
}

/**
 * The tour over the live shell (see the header); exported so a test can draw
 * its card. `moments`: the maker's walk after the made screen, whose start,
 * cards and end are told to the server as they happen (./made-moments.ts).
 * `numbered`: the walk's cards, with StepDots for the counter, no Back, and
 * Done on the last.
 */
export function Tour({ info, steps, onEnd: endTour, start = 0, moments = false, numbered = false }: {
  info: FirstSessionInfo; steps: TourStep[]; onEnd: (how: 'done' | 'skipped') => void; start?: number; moments?: boolean; numbered?: boolean;
}) {
  const t = useMessages('onboarding');
  // A screenshot state may open it part-way (tourShot, below), on its own
  // screen; the tour itself always starts at its first card.
  const [index, setIndex] = useState(() => Math.max(0, Math.min(start, steps.length - 1)));
  const [measured, setMeasured] = useState<Measured>({ step: -1, box: null });
  const measuredRef = useRef(measured);
  measuredRef.current = measured;
  // Into a step in the menu: waiting for the menu (`settling`, the card
  // hidden), then the one move there (`moving`). INTO THE MENU, above.
  const settleRef = useRef<{ at: number; since: number; key: string; still: number } | null>(null);
  const [settling, setSettling] = useState(false);
  const [moving, setMoving] = useState(false);
  // A step change's move of the cut-out, eased (IT GLIDES FROM STEP TO STEP).
  const [gliding, setGliding] = useState(false);
  const firstStepRef = useRef(true);
  useLayoutEffect(() => {
    if (firstStepRef.current) { firstStepRef.current = false; return undefined; }
    setGliding(true);
    const t = window.setTimeout(() => setGliding(false), GLIDE_MS);
    return () => window.clearTimeout(t);
  }, [index]);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const step = steps[index];
  const stepRef = useRef(step);
  stepRef.current = step;
  const indexRef = useRef(index);
  indexRef.current = index;
  const box = boxForStep(measured, index);
  const pressBox = pressForStep(measured, index);

  // Newcomer run five (13 Oct 2026): the maker's tour, card by card, for the
  // run report. Its end says on which card, and whether it was skipped.
  const momentsRef = useRef(moments);
  useEffect(() => {
    if (momentsRef.current) noteMoment(info.slug, 'tour_started', { steps: steps.length });
  }, []);
  useEffect(() => {
    if (momentsRef.current) noteMoment(info.slug, 'tour_step_shown', { step: index + 1, steps: steps.length });
  }, [index]);
  const ended = useRef(false);
  const finish = useCallback((how: 'done' | 'skipped') => {
    if (momentsRef.current && !ended.current) {
      ended.current = true;
      noteMoment(info.slug, 'tour_ended', { step: indexRef.current + 1, steps: steps.length, how });
    }
    endTour(how);
  }, [info.slug, steps.length, endTour]);
  const onEnd = useCallback(() => finish('done'), [finish]);

  // While it is up, the hub's first-version card and the App tab hold back
  // their "Review the plan" (./tour-running.ts): the tour asks for nothing
  // but its own cards, and the app the maker opens last offers it after.
  useEffect(() => {
    setTourRunning(true);
    return () => setTourRunning(false);
  }, []);

  // A new step measures its own target before it is painted, so its card
  // never shows beside the last step's cut-out (see Measured). Into a step
  // in the menu from the one before it, that step's ring is kept instead,
  // for this step, with the card hidden until the menu has settled (INTO
  // THE MENU, above).
  useLayoutEffect(() => {
    const before = measuredRef.current;
    if (step.inMenu && before.step === index - 1 && before.box) {
      settleRef.current = { at: index, since: performance.now(), key: '', still: 0 };
      setSettling(true);
      setMeasured({ ...before, step: index });
      return;
    }
    settleRef.current = null;
    setSettling(false);
    setMeasured(measure(index, step));
  }, [index, step]);

  // A step that points at the app waits for it (TourStep.waitsFor,
  // ./tour-wait.ts), decided before the step is painted, so its card never
  // stands over a tile that cannot be opened yet or the app's "Opening..."
  // cover. `held`: no card for a moment (WAIT_GRACE_MS), as an app that
  // opens as usual is there by then; `shown`: the card says it is getting
  // ready, with Skip and Back. Nothing in the cut-out takes a press
  // meanwhile, so a tap on a tile still being set up cannot move the tour on.
  const [wait, setWait] = useState<'held' | 'shown' | null>(null);
  const waiting = wait !== null;
  useLayoutEffect(() => {
    setWait(step.waitsFor && !appReady(step.waitsFor, info.slug) ? 'held' : null);
  }, [index, step, info.slug]);
  // Then look every WAIT_CHECK_MS until it is ready, and at most
  // TOUR_WAIT_MAX_MS. Waiting on a tile, ask the server too, and read Home
  // again once it says the setup is over: Home may have missed the news.
  useEffect(() => {
    const kind = step.waitsFor;
    if (!waiting || !kind) return undefined;
    const { slug } = info;
    let live = true;
    const check = window.setInterval(() => {
      try { if (appReady(kind, slug)) setWait(null); } catch { /* looked at again */ }
    }, WAIT_CHECK_MS);
    const say = window.setTimeout(() => setWait((w) => (w === 'held' ? 'shown' : w)), WAIT_GRACE_MS);
    const cap = window.setTimeout(() => setWait(null), TOUR_WAIT_MAX_MS);
    const ask = kind === 'running' ? window.setInterval(() => {
      fetch(madeAppUrl(slug), { credentials: 'same-origin', cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((body) => {
          if (live && tileSettled(madeAppOf(body)?.status) && !appReady('running', slug)) legacy().Home?.load?.();
        })
        .catch(() => {});
    }, WAIT_POLL_MS) : 0;
    return () => {
      live = false;
      window.clearInterval(check);
      window.clearTimeout(say);
      window.clearTimeout(cap);
      window.clearInterval(ask);
    };
  }, [waiting, index, step, info.slug]);
  // The move lasts its 200ms; following after it is frame by frame again.
  useEffect(() => {
    if (!moving) return undefined;
    const t = window.setTimeout(() => setMoving(false), 260);
    return () => window.clearTimeout(t);
  }, [moving]);

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
        const m = measure(at, stepRef.current);
        const key = `${at}:${boxKey(m.box)}:${boxKey(m.press)}`;
        const settle = settleRef.current;
        if (settle && settle.at === at) {
          // Into the menu: kept until its target holds still, on screen.
          const onScreen = !!m.box && m.box.top >= 0 && m.box.top + m.box.height <= window.innerHeight;
          settle.still = onScreen && key === settle.key ? settle.still + 1 : 0;
          settle.key = key;
          if (settle.still >= SETTLE_FRAMES || performance.now() - settle.since > SETTLE_CAP_MS) {
            settleRef.current = null;
            last = key;
            setMoving(true);
            setSettling(false);
            setMeasured(m);
          }
        } else if (key !== last) { last = key; setMeasured(m); }
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

  // OUT OF THE MENU, THE MENU GOES FIRST (onboarding run two, 12 Oct 2026,
  // iPhone 17 Safari): Next on the step in the menu moved on at once, the
  // tour's layer dropped under the kit's sheet as it slid away, and the
  // sheet's top edge, grabber and all, stayed in sight over the next step.
  // Now the step in the menu stays, card hidden and layer over the sheet,
  // until the menu has closed (AppContext.close resolves once it is gone).
  const [leavingMenu, setLeavingMenu] = useState(false);
  const go = useCallback((to: number) => {
    if (to < 0 || leavingMenu) return;
    if (to >= steps.length) { onEnd(); return; }
    const move = () => {
      // Back to a step in the menu stays on its screen: the menu opens over it
      // (inMenu, above), and re-entering the app could close it again.
      if (steps[to].screen !== steps[index].screen || (to < index && !steps[to].inMenu)) enterScreen(steps[to].screen, info.slug, info.conversationId);
      setIndex(to);
    };
    if (steps[index].inMenu && !steps[to].inMenu && AppContext.isOpen()) {
      setLeavingMenu(true);
      void Promise.resolve(AppContext.close()).catch(() => {}).then(() => {
        setLeavingMenu(false);
        move();
      });
      return;
    }
    move();
  }, [index, steps, info.slug, onEnd, leavingMenu]);

  // A tap step advances when its control is pressed, by a finger or by the
  // card's hint (pressTarget). The press is not intercepted: it is the
  // product's own handler that navigates.
  useEffect(() => {
    if (!step.tap || waiting) return undefined;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      const hit = Array.from(document.querySelectorAll(pressOf(step))).some((el) => el.contains(t));
      if (!hit) return;
      // The last card's control ends the tour, and the press goes on to it:
      // the maker's Open app opens the app.
      if (step.last) { window.setTimeout(onEnd, 0); return; }
      window.setTimeout(() => setIndex((i) => (i === index ? i + 1 : i)), 0);
      const next = steps[index + 1];
      if (step.opensNext && next) window.setTimeout(() => enterScreen(next.screen, info.slug, info.conversationId), 250);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [step, index, steps, info.slug, info.conversationId, onEnd, waiting]);

  const skip = useCallback(() => {
    enterScreen(steps[steps.length - 1].screen, info.slug, info.conversationId);
    finish('skipped');
  }, [steps, info.slug, finish]);

  // A tap step rings the control that leads on: the whole cut-out, kept a
  // ring's width inside the screen, or its `press` within a wider cut-out.
  // So does a step that only points at a control (`ringed`). Any other
  // cut-out runs to the screen's edges.
  const pointed = !!(step.tap || step.ringed);
  // Waiting for the hub, nothing of the page under it is shown: it is a
  // blank page, then skeleton rows, until the hub is drawn whole.
  // Nor while it leaves the menu: its target slides away with the sheet
  // (OUT OF THE MENU, THE MENU GOES FIRST).
  const dimAll = (waiting && step.waitsFor === 'hub') || leavingMenu;
  const hole = box && !dimAll && holeFor(box, viewport, pointed && !step.press ? RING : 0);
  // While a step waits for the app (`waiting`) nothing is ringed, and all of
  // its cut-out is covered.
  const ring = hole && pointed && pressBox && !waiting ? holeFor(pressBox, viewport) : null;
  // Presses reach only a tap step's control: a step that only shows its
  // screen, or points at a control, covers all of its cut-out, and a tap
  // step all of it but the ring.
  const covers = hole ? (ring && step.tap ? aroundBox(hole, ring) : [hole]) : [];
  // A card that says the app is getting ready stands at the foot.
  const card = cardPlacement(waiting ? null : box, step, viewport);
  // Where the card is in its tour: the walk's numbered circles, else "2 of 4".
  const counter = numbered
    ? <StepDots at={index} total={steps.length} />
    : <p className="text-[12px] font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.tour.counter', { step: index + 1, total: steps.length })}</p>;

  return (
    // The layer itself lets presses through: only the shades, the card and
    // the covers over the cut-out take them, so the control the step asks
    // for is pressable.
    // A step in the menu is drawn over it: on touch the menu is a kit sheet
    // (z-index 9991), and under it the card's Next was under its backdrop.
    <div data-first-session-tour={index + 1} className={step.inMenu ? 'pointer-events-none fixed inset-0 z-[9995]' : 'pointer-events-none fixed inset-0 z-[9000]'}>
      {hole ? (
        <>
          <div aria-hidden="true" data-first-session-dim="" className={gliding || moving ? DIM_GLIDE : DIM} style={dimStyle(hole, pointed)} />
          <div className={SHADE} style={{ left: 0, top: 0, right: 0, height: Math.max(0, hole.top) }} />
          <div className={SHADE} style={{ left: 0, top: hole.top + hole.height, right: 0, bottom: 0 }} />
          <div className={SHADE} style={{ left: 0, top: hole.top, width: Math.max(0, hole.left), height: hole.height }} />
          <div className={SHADE} style={{ left: hole.left + hole.width, top: hole.top, right: 0, height: hole.height }} />
          {ring ? (
            <div
              aria-hidden="true"
              className={moving
                ? `pointer-events-none fixed rounded-2xl ring-[3px] ring-[rgba(90,169,255,0.9)] motion-safe:animate-pulse ${MOVE}`
                : 'pointer-events-none fixed rounded-2xl ring-[3px] ring-[rgba(90,169,255,0.9)] motion-safe:animate-pulse'}
              style={ring}
            />
          ) : null}
          {covers.map((cover, i) => <div key={i} className="pointer-events-auto fixed" style={cover} />)}
        </>
      ) : (
        <div className={SHADE_ALL} />
      )}
      <div
        role="dialog"
        aria-labelledby="first-session-tour-title"
        data-tour-says-where-it-opens={step.saysWhereItOpens ? '' : undefined}
        data-first-session-tour-wait={wait || undefined}
        className={settling || wait === 'held' || leavingMenu
          ? 'pointer-events-none fixed start-4 end-4 mx-auto max-w-md rounded-[20px] bg-white p-4 text-zinc-900 opacity-0 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.6)] dark:bg-zinc-800 dark:text-zinc-100'
          : 'pointer-events-auto fixed start-4 end-4 mx-auto max-w-md rounded-[20px] bg-white p-4 text-zinc-900 shadow-[0_18px_40px_-16px_rgba(0,0,0,0.6)] transition-opacity duration-150 dark:bg-zinc-800 dark:text-zinc-100'}
        style={card}
      >
        {waiting ? (
          // The step waits for the app (`wait`): that it is getting ready,
          // and the ways out, Skip and Back, never a press that leads on.
          <>
            {counter}
            <p id="first-session-tour-title" role="status" className="mt-0.5 flex items-center gap-2 text-[17px] font-semibold leading-snug">
              <SpinnerRingIcon className="h-4 w-4 shrink-0 animate-spin text-zinc-500 motion-reduce:animate-none dark:text-zinc-400" aria-hidden="true" />
              <span className="min-w-0">{t('onboarding:firstSession.tour.wait.title', { app: info.name })}</span>
            </p>
            <p className="mt-1 text-[15px] leading-snug text-zinc-600 dark:text-zinc-300">{t('onboarding:firstSession.tour.wait.text')}</p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <button type="button" onClick={skip} className="py-1.5 text-[15px] font-semibold text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.tour.skip')}</button>
              {index > 0 ? (
                <button type="button" onClick={() => go(index - 1)} className="rounded-full bg-zinc-100 px-3.5 py-1.5 text-[15px] font-semibold text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100">{t('core:common.back')}</button>
              ) : null}
            </div>
          </>
        ) : (
          <>
            {counter}
            <p id="first-session-tour-title" className="mt-0.5 text-[17px] font-semibold leading-snug">{step.title}</p>
            <p className="mt-1 text-[15px] leading-snug text-zinc-600 dark:text-zinc-300">{step.text}</p>
            <div className="mt-3 flex items-center justify-between gap-3">
              {step.last ? <span /> : (
                <button type="button" onClick={skip} className="py-1.5 text-[15px] font-semibold text-zinc-500 dark:text-zinc-400">{t('onboarding:firstSession.tour.skip')}</button>
              )}
              <div className="flex items-center gap-2.5">
                {index > 0 && !numbered ? (
                  <button type="button" onClick={() => go(index - 1)} className="rounded-full bg-zinc-100 px-3.5 py-1.5 text-[15px] font-semibold text-zinc-900 dark:bg-zinc-700 dark:text-zinc-100">{t('core:common.back')}</button>
                ) : null}
                {step.tap ? (
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
                  // The walk's last card says where it goes: it ends on the
                  // project's hub under the Communities tab (`end`,
                  // walkDoneLanding), an invited private member's as well
                  // as a maker's (Evan, 20 Oct 2026).
                  <Button type="button" onClick={() => go(index + 1)} variant="pillAccent" size="sm" ink="solid" className="text-[15px] font-semibold">
                    {step.last ? (numbered ? t('onboarding:firstSession.walk.goToCommunity') : t('onboarding:firstSession.tour.gotIt')) : t('onboarding:firstSession.tour.next')}
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The frame held while an invite's standing is read (holdWelcome, see the
 * header): the landing's wallpaper, full screen, under the Homeroom logo bar
 * every first-run screen wears (owner, 7 October), with skeleton faces and
 * lines where the invite's words were. It stays until the app the link
 * opens is on screen (appDrawn), so Home never shows in between. The page
 * under it holds still and takes no tap or focus, as under the make screen
 * (../../lib/page-lock.ts).
 */
export function WelcomeHeld() {
  const t = useMessages('onboarding');
  const rootRef = useRef<HTMLDivElement>(null);
  usePageLock(rootRef);
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={t('onboarding:firstSession.welcome.opening')}
      data-first-session-welcome="held"
      className="fixed inset-0 z-[9000] flex flex-col text-zinc-900 dark:text-zinc-100"
      style={{ background: 'var(--home-wallpaper, #f4f2e4)' }}
    >
      <div className="flex h-[52px] shrink-0 items-center justify-center pt-[env(safe-area-inset-top)]">
        <Wordmark className="h-6 w-auto text-zinc-950 dark:text-white" />
      </div>
      <div data-first-session-scroll="" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-sm flex-col px-6 pb-[max(40px,env(safe-area-inset-bottom))] text-center">
          <SkeletonGroup label={t('onboarding:firstSession.welcome.opening')} className="my-auto flex flex-col items-center pb-10">
            <span className="flex">
              <Skeleton shape="block" className="h-10 w-10 rounded-full" />
              <Skeleton shape="block" className="-ms-2.5 h-10 w-10 rounded-full" />
            </span>
            <Skeleton className="mt-5 w-32" />
            <Skeleton shape="block" className="mt-3 h-9 w-64" />
          </SkeletonGroup>
        </div>
      </div>
    </div>
  );
}

export type Mode =
  | { kind: 'none' }
  // `app`: handed to the app an invite opened (welcome), and down once it is drawn.
  | { kind: 'held'; app?: string }
  // `entry` 'create' is the Create button's (see the header); none is the first session's.
  | { kind: 'make'; shot?: MakeShot; entry?: MakeEntry; startImport?: boolean; idea?: string | null; name?: string | null; ideaSource?: IdeaSource; audience?: CreateAudience; threadRootId?: number | null }
  | { kind: 'made'; made: Made; entry?: MakeEntry }
  | { kind: 'tour'; info: FirstSessionInfo; path: TourPath; start?: number; moments?: boolean };

/** The walk on Home after the first visit to the app, or "Look around first" (./tour-steps.ts). */
export type TourPath = 'walk' | 'look';

/**
 * "Look around first"'s tour is about Home and the tab bar, not a project:
 * it carries no project, and every step is on Home.
 */
const LOOK_AROUND_INFO: FirstSessionInfo = { slug: '', name: '' };

/**
 * The tours' and the tip's screenshot states. Only a brand-new account's
 * first session reaches them, so the before/after shots open one on demand
 * (the owner's ruling for first-run screens, 6 October 2026, as app-view.js
 * draws `?shot=first-version`): `?shot=tour-home` (the walk's three cards),
 * `?shot=tour-look`, and
 * `&step=N` to open one at its Nth card; `?shot=app-tip` and
 * `?shot=app-tip-invited`, the tip over the app. The walk and the tip are
 * shown over the first project on the viewer's Home, the walk with its name
 * and, when its starter has one, its example change (asked before the walk
 * opens, so a shot from its second card shows it at once). Nothing is
 * written: no answer to the question, no "seen" or "done" mark.
 */
const TOUR_SHOTS: Readonly<Record<string, { path: TourPath }>> = Object.freeze({
  'tour-home': { path: 'walk' },
  'tour-look': { path: 'look' },
});

export type TourShot = { path: TourPath; start: number };

export function tourShot(search: string): TourShot | null {
  let params: URLSearchParams;
  try { params = new URLSearchParams(search); } catch { return null; }
  const shot = params.get('shot') || '';
  const found = Object.prototype.hasOwnProperty.call(TOUR_SHOTS, shot) ? TOUR_SHOTS[shot] : null;
  if (!found) return null;
  const n = Number(params.get('step'));
  const start = Number.isInteger(n) && n > 1 ? n - 1 : 0;
  return { path: found.path, start };
}

/** The tip's screenshot states: whose tip it draws, or null. */
export function tipShot(search: string): TipWho | null {
  let shot: string | null = null;
  try { shot = new URLSearchParams(search).get('shot'); } catch { return null; }
  return shot === 'app-tip' ? 'maker' : shot === 'app-tip-invited' ? 'invited' : null;
}

/** Who sent the invite, in the invited tip's screenshot state. */
export const SHOT_INVITER = 'Maya';

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

/**
 * The project's example change, from GET /api/apps/:slug (`exampleChange`,
 * services/app-templates.js), or null: a project with none, or an answer
 * that is not one.
 */
export function walkExampleOf(body: unknown): string | null {
  const app = body && typeof body === 'object' ? (body as { app?: unknown }).app : null;
  const example = app && typeof app === 'object' ? (app as { exampleChange?: unknown }).exampleChange : null;
  return typeof example === 'string' && example.trim() ? example.trim() : null;
}

/**
 * Ask for it, by the same read as the made screen's (madeAppUrl: no-store,
 * past the service worker's boot cache). Never throws: a read that fails is
 * a walk that says it without an example.
 */
export async function walkExample(slug: string): Promise<string | null> {
  try {
    const res = await fetch(madeAppUrl(slug), { credentials: 'same-origin', cache: 'no-store' });
    return res.ok ? walkExampleOf(await res.json()) : null;
  } catch {
    return null;
  }
}

async function openTourShot(shot: TourShot, setMode: Dispatch<SetStateAction<Mode>>): Promise<void> {
  const open = (info: FirstSessionInfo) => setMode((prev) => (
    prev.kind === 'none' ? { kind: 'tour', info, path: shot.path, start: shot.start } : prev
  ));
  legacy().App?.navigateHome?.();
  if (shot.path === 'look') { open(LOOK_AROUND_INFO); return; }
  const project = await firstHomeProject();
  if (!project) return;
  const example = await walkExample(project.slug);
  open({ ...project, example });
}

/** The tip's screenshot state: the first project on Home, opened, and its tip, written nowhere. */
async function openTipShot(who: TipWho, setTip: Dispatch<SetStateAction<TipRecord | null>>): Promise<void> {
  legacy().App?.navigateHome?.();
  const project = await firstHomeProject();
  if (!project) return;
  await appDrawn(legacy().App?.navigateToApp?.(project.slug, 'app'));
  setTip({ ...project, who, inviter: who === 'invited' ? SHOT_INVITER : null, shot: true });
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
 *
 * The door's own make screen is the one exception: going from #create to
 * #create/import (or back) by the address turns it to the asked-for form,
 * as a cold load of that address would open it. A made screen stays.
 */
export function openCreate(
  setMode: Dispatch<SetStateAction<Mode>>,
  startImport = false,
  start: { idea?: string | null; name?: string | null; ideaSource?: IdeaSource; audience?: CreateAudience; threadRootId?: number | null } = {},
): boolean {
  // #6781: a name handed in is a new start, as a brief is: the form left
  // from Create does not come back under it (make.tsx forgetKeptDraft).
  if (!startImport && start.name) forgetKeptDraft();
  let opened = false;
  flushSync(() => setMode((prev) => {
    const turning = prev.kind === 'make' && prev.entry === 'create' && !!prev.startImport !== startImport;
    if (prev.kind !== 'none' && !turning) return prev;
    opened = true;
    if (startImport) return { kind: 'make', entry: 'create', startImport: true };
    // #6019 follow-up: a private thread's New project starts from its words,
    // for the audience the person chose. #6781: with the name the bot
    // suggested, when it named one.
    return start.idea || start.name || start.audience || start.threadRootId
      ? { kind: 'make', entry: 'create', idea: start.idea || null, name: start.name || null, ideaSource: start.ideaSource, audience: start.audience, ...(start.threadRootId ? { threadRootId: start.threadRootId } : {}) }
      : { kind: 'make', entry: 'create' };
  }));
  if (opened) void invalidateAppAllowance();
  return opened;
}

/**
 * Whether an address is one of the Create door's own (#create,
 * #create/import). Reaching one is the router opening or turning the door,
 * never a way out of it.
 */
export function isDoorRoute(hash: string): boolean {
  return /^#create(?:\/|$)/.test(String(hash || ''));
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
  // The tour's steps are built in the language on screen, and again when it changes.
  const t = useMessages('onboarding');
  const [mode, setMode] = useState<Mode>({ kind: 'none' });
  // The mode as it stands, for the listeners that outlive a render.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // The tip over the app, while it is up (./app-tip.tsx).
  const [tip, setTip] = useState<TipRecord | null>(null);
  // Bumped when a tip or a walk is owed, so the watcher below looks again.
  const [owing, setOwing] = useState(0);
  // A visit that shows the first session's own screens is a first visit to
  // its end (./tour-running.ts A FIRST VISIT STAYS ONE). Create's are not.
  useEffect(() => {
    if (mode.kind === 'none' && !tip) return;
    if ((mode.kind === 'make' || mode.kind === 'made') && mode.entry === 'create') return;
    noteFirstSessionVisit();
  }, [mode, tip]);

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
      try { sessionStorage.removeItem(MAKE_FLAG); } catch { /* shown once anyway */ }
      openMake(setMode, now);
    };
    // A `?shot=` address opens on its own, before the session read lands and
    // even if it never does: it is the before/after capture's own link and it
    // writes nothing, so it must not fall back to the signed-out landing
    // (#5266 review, 20 Oct 2026).
    if (makeShot(window.location.search)) check(false);
    if (legacy().App?.user) check(false);
    const onAuthed = () => check(true);
    document.addEventListener('sv:authed', onAuthed);
    return () => document.removeEventListener('sv:authed', onAuthed);
  }, []);

  // "Look around first" pressed on the waitlist (#5678): the four cards open
  // on the first Home after the account is let in, never on the waiting
  // room. `sv:authed` fires only past the access gate, so the waiting room's
  // in-place release reaches it, and so does every later boot here.
  useEffect(() => {
    const check = () => {
      const app = legacy().App;
      const user = app?.user;
      const uid = user?.id;
      if (uid == null || user?.hasPlatformAccess === false) return;
      if (!lookOwed(uid)) return;
      // Another screen of the first session is up: the record waits for a
      // later `sv:authed` rather than opening under it.
      if (modeRef.current.kind !== 'none') return;
      clearLook(uid);
      app?.navigateHome?.();
      setMode({ kind: 'tour', info: LOOK_AROUND_INFO, path: 'look' });
    };
    if (legacy().App?.user) check();
    document.addEventListener('sv:authed', check);
    return () => document.removeEventListener('sv:authed', check);
  }, []);

  // S01 (audit 2 Nov 2026): the first session's made screen, left by a
  // reload or a cold start of the app before any of its ways on was taken,
  // opens again (./first-visit.ts oweMade), never Home in its place. Only
  // over nothing, and never on a screenshot address.
  useEffect(() => {
    const check = () => {
      const user = legacy().App?.user;
      const uid = user?.id;
      if (uid == null || user?.hasPlatformAccess === false) return;
      let shot = false;
      try { shot = !!new URLSearchParams(window.location.search).get('shot'); } catch { /* no shot */ }
      if (shot || modeRef.current.kind !== 'none') return;
      const made = owedMade<Made>(uid);
      if (!made) return;
      setMode((prev) => (prev.kind === 'none' ? { kind: 'made', made } : prev));
    };
    if (legacy().App?.user) check();
    document.addEventListener('sv:authed', check);
    return () => document.removeEventListener('sv:authed', check);
  }, []);

  // S01: while the first session's made screen is up it is kept on this
  // browser (oweMade); once it goes, by any of its ways on, it is let go
  // (clearMade). A reload or a cold start never runs this, so the record
  // stays and the check above reopens it. Create's own made screen closes
  // like a dialog and is never kept.
  const madeUp = mode.kind === 'made' && mode.entry !== 'create' ? mode.made : null;
  const madeKept = useRef(false);
  useEffect(() => {
    const uid = legacy().App?.user?.id;
    if (uid == null) return;
    if (madeUp) {
      madeKept.current = true;
      oweMade(uid, madeUp);
      return;
    }
    if (!madeKept.current) return;
    madeKept.current = false;
    clearMade(uid);
  }, [madeUp]);

  // The bridge App._followInvite calls. welcome() answers whether it will
  // show, so the caller can land the viewer the old way when it will not.
  useEffect(() => {
    const w = legacy();
    w.UsernodeReact = w.UsernodeReact || {};
    const api = {
      welcome(info: FirstSessionInfo): boolean {
        if (!info || !info.slug || seen(info.slug)) return false;
        markSeen(info.slug);
        // Straight into the app the link was for, full screen, with the tip
        // under the mark (./first-visit.ts). Somebody new to Homeroom (a
        // private member, or an account the link's sign-up made) is owed the
        // walk on their first Home after it; an account that was here
        // before the invite gets the tip alone.
        const app = legacy().App;
        const { slug } = info;
        const name = info.name || slug;
        const privateMember = !!app?.user?.privateMember;
        const uid = app?.user?.id;
        let walkOwed = false;
        if (uid != null) {
          oweTip(uid, { slug, name, who: 'invited', inviter: info.inviterName || null });
          walkOwed = (privateMember || !!info.newAccount) && oweWalk(uid, { slug, name, privateMember });
          if (walkOwed) app?._noteHomeWalk?.('owed');
          setOwing((n) => n + 1);
        }
        rememberCommunity(slug);
        // Home under the app, where the walk runs: Back and the ✕ go there.
        // A public community's link is joined on its hub, and leaving the
        // app went back to the hub, with the walk not started.
        if (walkOwed) app?._homeUnderApp?.();
        // A frame held for the welcome goes once the app is on screen, not
        // before (appDrawn): never Home in between. The follow's own ending
        // (endHold) leaves a frame handed on.
        setMode((prev) => (prev.kind === 'held' ? { kind: 'held', app: slug } : prev));
        const going = app?.navigateToApp?.(slug, 'app');
        void appDrawn(going).then(() => setMode((prev) => (prev.kind === 'held' && prev.app === slug ? { kind: 'none' } : prev)));
        return true;
      },
      // The mark menu's "Go to Homeroom" for a private member (features/
      // app-context): Home, noted first so the app has its ✕ from now on
      // (App._privateHomeVisited, public/js/app.js). The app was their first
      // visit, so the walk, if it is still owed, runs on this Home.
      goHome(_info?: { slug?: string | null; name?: string | null }): void {
        const app = legacy().App;
        app?._notePrivateHome?.();
        app?.navigateHome?.();
        const uid = app?.user?.id;
        if (uid != null) { armWalk(uid); setOwing((n) => n + 1); }
      },
      // The held frame, drawn before this returns (see the header):
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
      create(opts?: { import?: boolean; idea?: string | null; name?: string | null; ideaSource?: IdeaSource; audience?: CreateAudience }): boolean {
        const audience = opts?.audience === 'solo' || opts?.audience === 'invited' || opts?.audience === 'open'
          ? opts.audience : undefined;
        const idea = typeof opts?.idea === 'string' ? opts.idea.slice(0, 4000) : null;
        // #6784: the private thread the idea came from, so the project is
        // made from the plan agreed there, not from a line of it. Only with
        // an idea, and only a real message id. It rides beside the door's
        // own answers (the caller passes it on the same object).
        const asked = Number((opts as { threadRootId?: unknown } | undefined)?.threadRootId);
        const threadRootId = idea && Number.isSafeInteger(asked) && asked > 0 ? asked : null;
        // #6781: the name Homeroom bot suggested with its offer, editable.
        const name = typeof opts?.name === 'string' ? opts.name.trim().slice(0, 60) || null : null;
        // Create's door hands in a Discover search (#5928) or a private
        // thread's words (#6019), never a waitlist answer: only the first
        // session's own make screen says "from your waitlist answer".
        const ideaSource: IdeaSource = opts?.ideaSource === 'search' ? 'search' : 'thread';
        if (threadRootId) return openCreate(setMode, !!opts?.import, { idea, name, ideaSource, audience, threadRootId });
        return openCreate(setMode, !!opts?.import, { idea, name, ideaSource, audience });
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

  // The tip's screenshot state (tipShot), the same way.
  useEffect(() => {
    const who = tipShot(window.location.search);
    if (!who) return undefined;
    let opened = false;
    const open = () => {
      if (opened || !legacy().App?.user) return;
      opened = true;
      void openTipShot(who, setTip);
    };
    open();
    document.addEventListener('sv:authed', open);
    return () => document.removeEventListener('sv:authed', open);
  }, []);

  // THE FIRST VISIT (./first-visit.ts): while a tip or a walk is owed to the
  // person signed in, and nothing else of the island's is up, look at the
  // screen every FIRST_VISIT_CHECK_MS. The app opened past its loading
  // screens shows the tip, once; the app on screen arms the walk, and Home
  // after it runs the walk, once. Nothing owed on this device (read as the
  // island mounts, and again whenever something is owed): no looking at all.
  const startWalk = useCallback((walk: WalkRecord) => {
    setMode((prev) => (prev.kind === 'none'
      ? { kind: 'tour', info: { slug: walk.slug, name: walk.name }, path: 'walk', moments: !!walk.maker }
      : prev));
  }, []);
  useEffect(() => {
    if (mode.kind !== 'none' || tip || !anyOwed()) return undefined;
    let timer = 0;
    const tick = () => {
      const uid = legacy().App?.user?.id;
      if (uid == null) return;
      const owed = { tip: owedTip(uid), walk: owedWalk(uid) };
      if (!owed.tip && !owed.walk) { window.clearInterval(timer); return; }
      let screen;
      try { screen = readScreen(); } catch { return; }
      // Armed first: the tip that shows on this same visit stops the
      // looking until it closes, and the walk is due on the Home after it.
      if (owed.walk && walkArms(owed.walk, screen)) armWalk(uid);
      else if (owed.walk && walkDue(owed.walk, screen)) {
        noteWalkRun(uid);
        // On Home: they have reached Homeroom, on every device.
        legacy().App?._noteHomeWalk?.('reached');
        startWalk(owed.walk);
        return;
      }
      if (owed.tip && tipDue(owed.tip, screen)) {
        noteTipShown(uid);
        setTip(owed.tip);
      }
    };
    timer = window.setInterval(tick, FIRST_VISIT_CHECK_MS);
    tick();
    return () => window.clearInterval(timer);
  }, [mode.kind, tip, owing, startWalk]);
  const closeTip = useCallback(() => setTip(null), []);

  // A tour's end. The walk, done (not skipped), goes on to its project's
  // hub (walkDoneLanding), a maker's and an invited person's alike; every
  // other tour stays where it ended.
  const end = useCallback((how: 'done' | 'skipped') => {
    const hub = how === 'done' && mode.kind === 'tour' && mode.path === 'walk' ? mode.info.slug : null;
    setMode({ kind: 'none' });
    if (hub) walkDoneLanding(hub);
  }, [mode]);

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
  //
  // Not a route to the door itself. Typing #create, or going Back or
  // Forward to it, opens the door from the router's popstate, and the
  // hashchange of that same navigation is dispatched after it, by which
  // time this listener is in place: it took the address the door had just
  // been opened by for a way out and closed the door in the frame it opened,
  // so #create worked only as the first address of a page. The door's own
  // addresses are the router's to answer (it opens or turns the door,
  // openCreate); every other route change still leaves.
  useEffect(() => {
    if (!createDoor) return undefined;
    const onRoute = () => { if (!isDoorRoute(window.location.hash)) leaveDoor(true); };
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
    const { slug, name, example } = mode.info;
    return homeWalkSteps({ slug, name, example });
  }, [mode, t]);
  // The walk's Homeroom bot card names a change this project could ask for
  // (walkExample), asked once as the walk opens. Its first card needs none,
  // so the answer is in before the second card shows; until then, and for a
  // project with none, that card says where the bot is without one.
  const walkSlug = mode.kind === 'tour' && mode.path === 'walk' && mode.info.example === undefined ? mode.info.slug : null;
  useEffect(() => {
    if (!walkSlug) return undefined;
    let live = true;
    void walkExample(walkSlug).then((example) => {
      if (!live) return;
      setMode((prev) => (prev.kind === 'tour' && prev.path === 'walk' && prev.info.slug === walkSlug && prev.info.example === undefined
        ? { ...prev, info: { ...prev.info, example } }
        : prev));
    });
    return () => { live = false; };
  }, [walkSlug]);

  if (mode.kind === 'make' && mode.entry === 'create') {
    return (
      <MakeScreen
        // Turned by the address (openCreate), the screen opens afresh on the
        // asked-for form, as a cold load of that address does.
        key={mode.startImport ? 'import' : 'make'}
        who={viewerName()}
        entry="create"
        startImport={!!mode.startImport}
        idea={mode.idea ?? null}
        name={mode.name ?? null}
        ideaSource={mode.ideaSource ?? 'thread'}
        audience={mode.audience}
        underHeader={underHeader}
        threadRootId={mode.threadRootId ?? null}
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
          // Still waiting: the waiting room is what the shell shows, and
          // none of the tour's four places is there. The answer still
          // counts; the cards open on the first Home after they are let in.
          if (legacy().App?.user?.hasPlatformAccess === false) {
            const uid = legacy().App?.user?.id;
            if (uid != null) oweLook(uid);
            setMode({ kind: 'none' });
            return;
          }
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
        // #6801: from Create, the ✕ stays while the project builds: leaving
        // cancels nothing (Home read it in onMade), and the first session's
        // made screen keeps no ✕ (it passes none).
        onClose={fromCreate ? () => leaveDoor(false) : undefined}
        onContinue={(skipped, firstVersion) => {
          // Run five: Invite people later, or the way on once the link is out (./made-moments.ts).
          noteMoment(made.slug, skipped ? 'invite_later_tapped' : 'continue_tapped');
          markSeen(made.slug);
          rememberCommunity(made.slug);
          // From Create: the project's own hub, where its first change is
          // started, as the New project dialog's Open project went. The
          // tip and the walk are the first session's.
          if (fromCreate) {
            leaveDoor(true);
            enterScreen('hub', made.slug);
            return;
          }
          const uid = legacy().App?.user?.id;
          const { slug, name } = made;
          // Not live yet (Homeroom bot still building it, or built and up
          // for approval): nothing to open. This is their first visit to
          // Homeroom, so Home and its walk now, and the tip the first time
          // they open the app once it is live.
          if (firstVersion !== null) {
            if (uid != null) oweTip(uid, { slug, name, who: 'maker', live: true });
            setOwing((n) => n + 1);
            enterScreen('home', slug);
            if (uid != null && !claimWalk(uid)) { setMode({ kind: 'none' }); return; }
            legacy().App?._noteHomeWalk?.('reached');
            setMode({ kind: 'tour', info: { slug, name }, path: 'walk', moments: true });
            return;
          }
          // It runs: the app itself, full screen, with the tip, and the walk
          // on the first Home after it.
          if (uid != null) {
            oweTip(uid, { slug, name, who: 'maker' });
            if (oweWalk(uid, { slug, name, maker: true })) legacy().App?._noteHomeWalk?.('owed');
          }
          setOwing((n) => n + 1);
          setMode({ kind: 'none' });
          enterScreen('app', slug);
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

  if (mode.kind === 'held') return <WelcomeHeld />;
  if (mode.kind === 'tour') return <Tour info={mode.info} steps={steps} onEnd={end} start={mode.start} moments={!!mode.moments} numbered={mode.path === 'walk'} />;
  if (tip) return <AppTip tip={tip} onClose={closeTip} />;
  return null;
}
