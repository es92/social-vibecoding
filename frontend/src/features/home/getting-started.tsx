/**
 * `#home-getting-started` — the Getting started card on top of Home
 * (communities, stage 5), which since evan's "one list" decision
 * (2026-10-01) IS the season's First challenges.
 *
 * Home used to open on two first-run lists: this card (the tour, then say
 * hi, vote and explore in one community, paying nothing) and the Challenges
 * block's First challenges (paying points, and hiding the rest of the season
 * until they were done). They overlapped and disagreed on "done". Now there
 * is one list, here:
 *
 *   1. Take the 1-minute tour   the welcome tour (./tour), finished or
 *                               skipped on any device (#3240); pays nothing
 *   2.. the season's First challenges, in the admin's order, with their own
 *       titles, tasks and rewards (Join a community, Try an app, Vote on an
 *       app, Send feedback, as evan sets them up). NOTHING HERE
 *       NAMES THEM: the server sends whatever the season holds
 *       (GET /api/me/getting-started, src/services/onboarding.js).
 *
 * Each step ticks from what the person DID, the moment its credit is
 * written. Its button only takes them to where the action is, and never
 * ticks it; the one exception is the Vote step's "Look", below.
 *
 * ── Every step not done has a button (evan, 2026-10-01) ────────────────
 *
 * A row is not pressable; its button is, at the row's trailing edge, and a
 * done row has none. What the button does is the step's `action`, which the
 * server reads off the scoring rule's measure (onboarding.js stepAction):
 *
 *   tour      ▶ Start        the tour, asked for the way Settings' Replay
 *                            asks (./tour/tour-request.ts)
 *   join      Join ›         Discover, where communities are joined
 *   try       Try ›          the default app, opened
 *   vote      Vote ›         a Needs you tab: the default app's when something
 *                            waits there, else the first project joined that
 *                            has something
 *             Look ›         nothing waiting anywhere: the default app's
 *                            Workshop, and opening it from here ticks the
 *                            step (POST …/workshop-visit; the server checks
 *                            that nothing waits)
 *   suggest   Suggest ›      the "Ask for a change" dialog, for the default
 *                            app (opened first, since the dialog's "This app"
 *                            is the app that is open)
 *   other     <its CTA> ›    the challenge's own call-to-action
 *
 * The DEFAULT APP is the app of the first community the person joined, not
 * Homeroom and not one they made (onboarding.js defaultApp). The row's line
 * names it ("Spend 10 seconds in City garden."); the button is a verb and an
 * arrow, nothing else, and its accessible name is the whole sentence ("Try
 * City garden"). `stepView` keeps that long label beside the short one, so a
 * full-width button under the step text (the prototype's other layout, which
 * evan has not ruled out) is a change to the row alone.
 *
 * ONE GATE (first-session test, 2026-10-03). Until the Join step is ticked,
 * Try, Vote and Suggest say "Join a community first." and carry no button:
 * the server's `needs_join`, which is that step's own done state, and
 * nothing else. It used to be "no default app", which disagreed with the
 * tick both ways. Keeping Homeroom, or making a project only you can see,
 * does not tick Join (onboarding.js COMMUNITY_JOINED, by design), so the Join
 * row says so while it is to do. Once Join is ticked nothing is locked: with
 * no default app the server sends the first app Discover leads with
 * (onboarding.js fallbackApp), and with none at all the three go to
 * Discover.
 *
 * ── What it says ───────────────────────────────────────────────────────
 *
 *   * "Getting started", "1 of 5 done · 500 pts earned" (the points the
 *     challenges have paid; nothing is said about zero), one segment per
 *     step, then the rows.
 *   * A row: a round mark (empty; ringed in the accent for the NEXT step;
 *     a filled check once done, its title struck through), the title over
 *     its line (15 over 13), and under them what it pays ("Earns 500 pts",
 *     in the reward amber the challenge cards use) or, once done, what it
 *     paid ("+500 pts earned", in their earned green); the tour's line says
 *     it pays nothing and how it ticks. The first step not done is the next
 *     one: it sits on the lit tint (`--lit-tint`, where you are) and its
 *     button is the filled one; every other button is outlined.
 *   * The foot: what finishing unlocks, "Finish all 5 to unlock 6 more
 *     challenges", or "Two more steps unlock…" near the end. Nothing when the
 *     season hides nothing.
 *   * Done: "You’re all set" with the points earned in the earned green, the
 *     full bar, one line saying how many challenges just unlocked ("7
 *     challenges unlocked", an open lock beside it), "See challenges ›", and
 *     the close button (evan, 2026-10-01, version D: no list of names; Home's
 *     Challenges section right under the card lists them). Closing ends the card for good, on every device. Before then
 *     there is no close button, and the server refuses one: the season waits
 *     on this list, and a card closed half-way would leave it locked behind
 *     a list nobody can see.
 *
 * Home's Challenges block does not repeat the list while it is locked: it
 * draws one locked card in its place (./panels/challenges.tsx). When this
 * card turns done it asks that block to read again, so the season appears
 * under it at once rather than at the block's next refresh.
 *
 * ── The island rules ───────────────────────────────────────────────────
 *
 *   * THE FIRST RENDER IS THE PRERENDERED MARKUP: an empty section, hidden.
 *     Whether to show anything is `App.user.showGettingStarted`, a
 *     classic-script global that only exists after the session is read, so
 *     it is read in an effect and the card arrives one fetch later.
 *   * VISIBILITY RIDES A REF (`useHiddenClass`); the section's className is
 *     a constant.
 *   * Nothing in `public/js/**` writes into this subtree, so it may hold
 *     state (AGENTS.md).
 *
 * `?shot=getting-started` draws a fixture card with no fetch, the way
 * ../auth/username-first-run.js's `?shot=choose-username` does, so the
 * declared check can see it: a newcomer who has just joined City garden
 * (1 of 5), the tour next. `?shot=getting-started-halfway` is three steps in,
 * Vote next with a change waiting; `?shot=getting-started-look` the same with
 * nothing up for a vote anywhere; `?shot=getting-started-join` a newcomer who
 * kept only Homeroom (0 of 5), Join to do and the three after it locked;
 * `?shot=getting-started-done` the all-set state. A fixture's buttons post
 * nothing. Every other `?shot=`, `?demo=` and `?token=` route draws nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { CheckIcon, ChevronRightIcon, LockIcon, LockOpenIcon, PlayIcon, XIcon } from '@/components/ui/icons';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useVisibility } from '../../lib/visibility-store';
import { TOUR_DONE_EVENT } from './tour/tour-done';
import { requestTour } from './tour/tour-request';

/** What a step's button does (onboarding.js stepAction). */
export type StepAction = 'tour' | 'join' | 'try' | 'vote' | 'suggest' | 'other';

/** An app a button opens and its row names. */
export interface GettingStartedApp {
  slug: string;
  name: string;
}

/**
 * Where the Vote step goes: a Needs you tab (`needs`, with `count` waiting in
 * `app`), or, with nothing waiting anywhere, the default app's Workshop.
 */
export interface VoteTarget {
  kind: 'needs' | 'workshop';
  app: GettingStartedApp;
  count: number;
}

export interface GettingStartedStep {
  /** 'tour', or `challenge-<id>`: unique in the list, and the row's key. */
  id: string;
  kind: 'tour' | 'challenge';
  action: StepAction;
  title: string;
  /** The challenge's own task: the row's line once done, and for steps not about an app. */
  detail: string;
  done: boolean;
  /** A hash route, for `join` and `other`. */
  href: string | null;
  /** `other`: the challenge's call-to-action label, when it has one. */
  cta?: string | null;
  /** What the challenge pays, in the admin's words ("500 pts"); null for the tour. */
  reward: string | null;
  /** What it has paid this person. */
  earned_points: number;
  challenge_id?: number;
  event_id?: number;
}

export interface GettingStartedModel {
  show: boolean;
  /** The tour and every First challenge done: the "You’re all set" state. */
  complete: boolean;
  steps: GettingStartedStep[];
  done: number;
  total: number;
  earned_points: number;
  /** The season's other open challenges, which finishing lets the person see. */
  unlocks: { count: number; names: string[] };
  /**
   * The one gate on Try, Vote and Suggest: the Join step is not done yet.
   * False when it is, or when the season has no Join step.
   */
  needs_join: boolean;
  /**
   * The app Try, Vote and Suggest are about: the default app, or once Join
   * is ticked without one, the first app Discover leads with. Null when
   * there is neither.
   */
  app: GettingStartedApp | null;
  /** Where Vote goes. Null without an app. */
  vote: VoteTarget | null;
  /** The seconds "Try an app" counts from (the scorer's floor). */
  try_seconds: number;
}

const SHOTS = [
  'getting-started', 'getting-started-halfway', 'getting-started-look', 'getting-started-join', 'getting-started-done',
] as const;
type Shot = typeof SHOTS[number];

const CITY_GARDEN: GettingStartedApp = { slug: 'city-garden', name: 'City garden' };

// The fixtures' steps, in the order and words evan set the season up with.
// Rewards are the admin's prose, as the server would send them.
const FIXTURE_STEPS: Array<Omit<GettingStartedStep, 'done' | 'earned_points'>> = [
  { id: 'tour', kind: 'tour', action: 'tour', title: 'Take the 1-minute tour', detail: 'See how Homeroom works.', href: null, reward: null },
  {
    id: 'challenge-41', kind: 'challenge', action: 'join', challenge_id: 41, event_id: 7,
    title: 'Join a community', detail: 'Find people to build with.', href: '#apps', reward: '500 pts',
  },
  {
    id: 'challenge-42', kind: 'challenge', action: 'try', challenge_id: 42, event_id: 7,
    title: 'Try an app', detail: 'Open an app and try it.', href: null, reward: '500 pts',
  },
  {
    id: 'challenge-43', kind: 'challenge', action: 'vote', challenge_id: 43, event_id: 7,
    title: 'Vote on an app', detail: 'Help decide what goes live next.', href: null, reward: '250 pts',
  },
  {
    id: 'challenge-44', kind: 'challenge', action: 'suggest', challenge_id: 44, event_id: 7,
    title: 'Send feedback', detail: 'Tell a community what would make it better.',
    href: null, reward: '250 pts',
  },
];

// Five, the number the staging demo's locked Challenges block counts
// (`?demo=1&challenges=locked`, src/routes/home-panels.js), so the card and
// the block under it agree when a shot draws both.
const FIXTURE_UNLOCKS = {
  count: 5,
  names: ['Make your first change', 'Get a change live', 'Invite a friend', 'Start a community'],
};

function fixture(doneIds: string[], vote: VoteTarget['kind'] = 'needs'): GettingStartedModel {
  const steps = FIXTURE_STEPS.map((s) => {
    const done = doneIds.includes(s.id);
    const pts = Number(String(s.reward || '').replace(/[^\d]/g, '')) || 0;
    return { ...s, done, earned_points: done ? pts : 0 };
  });
  const done = steps.filter((s) => s.done).length;
  // Join not ticked: the newcomer kept only Homeroom, which is no default
  // app, so the server sends none and nothing for Vote either.
  const joined = steps.some((s) => s.action === 'join' && s.done);
  return {
    show: true,
    complete: done === steps.length,
    steps,
    done,
    total: steps.length,
    earned_points: steps.reduce((sum, s) => sum + s.earned_points, 0),
    unlocks: FIXTURE_UNLOCKS,
    needs_join: !joined,
    app: joined ? CITY_GARDEN : null,
    vote: joined ? { kind: vote, app: CITY_GARDEN, count: vote === 'needs' ? 1 : 0 } : null,
    try_seconds: 10,
  };
}

/**
 * The fixture states. `getting-started` is a newcomer who has just come
 * through the join screen, into City garden: "Join a community" counted the
 * moment they joined, and the tour is next. The declared check reads it.
 * `getting-started-join` is one who kept only Homeroom ticked: nothing done,
 * the Join row saying what does not count, and Try, Vote and Suggest locked.
 */
export const SHOT_MODELS: Record<Shot, GettingStartedModel> = {
  'getting-started': fixture(['challenge-41']),
  'getting-started-halfway': fixture(['tour', 'challenge-41', 'challenge-42']),
  'getting-started-look': fixture(['tour', 'challenge-41', 'challenge-42'], 'workshop'),
  'getting-started-join': fixture([]),
  'getting-started-done': fixture(FIXTURE_STEPS.map((s) => s.id)),
};
export const SHOT_MODEL = SHOT_MODELS['getting-started'];

function pts(n: number): string {
  return `${Math.round(n).toLocaleString('en-US')} pts`;
}

/** "1 of 5 done · 500 pts earned"; no points clause while nothing has paid. */
export function counterText(model: Pick<GettingStartedModel, 'done' | 'total' | 'earned_points'>): string {
  const earned = Number(model.earned_points) || 0;
  return `${model.done} of ${model.total} done${earned > 0 ? ` · ${pts(earned)} earned` : ''}`;
}

/**
 * The foot's line: what finishing unlocks. Null when nothing is locked (a
 * season with no other challenges, or the list is done).
 */
export function unlockText(model: Pick<GettingStartedModel, 'done' | 'total' | 'unlocks' | 'complete'>): string | null {
  const n = Math.floor(Number(model.unlocks && model.unlocks.count) || 0);
  if (model.complete || n < 1) return null;
  const what = n === 1 ? '1 more challenge' : `${n} more challenges`;
  const left = model.total - model.done;
  if (left === 1) return `One more step unlocks ${what}`;
  if (left === 2) return `Two more steps unlock ${what}`;
  return `Finish all ${model.total} to unlock ${what}`;
}

/** The done state's one line: "6 challenges unlocked". */
export function unlockedLabel(count: number): string | null {
  const n = Math.floor(Number(count) || 0);
  if (n < 1) return null;
  return n === 1 ? '1 challenge unlocked' : `${n} challenges unlocked`;
}

/** The first step not done: the one the card points at. */
export function nextStepId(model: Pick<GettingStartedModel, 'steps'>): string | null {
  const next = model.steps.find((s) => !s.done);
  return next ? next.id : null;
}

/**
 * The line under a step's words: what it pays ("Earns 500 pts", the reward
 * amber), what it paid once done ("+500 pts earned", the earned green), or
 * for the tour, that it pays nothing and how it ticks. A reward that is a
 * number of points ("500", "500 pts") reads "Earns …"; prose the admin typed
 * instead is drawn as written (HomePanels.formatReward's rule for the bare
 * number, so a reward reads the same here as on its card).
 */
export function rewardText(step: Pick<GettingStartedStep, 'kind' | 'done' | 'reward' | 'earned_points'>):
  { text: string; tone: 'reward' | 'earned' | 'quiet' } | null {
  if (step.kind === 'tour') return { text: 'No points · ticks when you finish or skip it', tone: 'quiet' };
  const earned = Number(step.earned_points) || 0;
  if (step.done) return earned > 0 ? { text: `+${pts(earned)} earned`, tone: 'earned' } : null;
  const s = String(step.reward == null ? '' : step.reward).trim();
  if (!s) return null;
  if (/^[\d][\d.,]*$/.test(s)) return { text: `Earns ${s} pts`, tone: 'reward' };
  if (/^[\d][\d.,]*\s*(pts?|points?)$/i.test(s)) return { text: `Earns ${s}`, tone: 'reward' };
  return { text: s, tone: 'reward' };
}

/** Where a step's button goes. */
export type StepGo =
  | { to: 'tour' }
  | { to: 'hash'; href: string }
  | { to: 'app'; slug: string }
  | { to: 'needs'; slug: string }
  | { to: 'workshop'; slug: string }
  | { to: 'feedback'; slug: string };

export interface StepButtonView {
  /** The compact label beside the step: a verb. */
  short: string;
  /** The whole sentence: the button's accessible name, and a full-width button's label. */
  long: string;
  /** The accessible name, when it is not `long` (the tour's). */
  aria: string;
  /** The app it opens, if it opens one. */
  app: GettingStartedApp | null;
  /** The trailing arrow: every button but the tour's play. */
  arrow: boolean;
  go: StepGo;
}

const plural = (n: number) => (n === 1 ? '1 change is' : `${n} changes are`);

/**
 * What does not tick Join, said on its row while it is to do: the
 * platform's own project every account starts in, and a project only you
 * can see ("Just me" when it was made). Neither is a community you found
 * (onboarding.js COMMUNITY_JOINED). After the challenge's own task, which is
 * the admin's words.
 */
export const JOIN_NOTE = 'Homeroom and projects only you can see don’t count.';

/** The Join row's line while it is to do: its task, then what does not count. */
export function joinDetail(detail: string): string {
  const own = String(detail || '').trim();
  return own ? `${own} ${JOIN_NOTE}` : JOIN_NOTE;
}

// Joined, and still no app to be about (no app on the platform they did not
// make is open to everyone): the three go to Discover, never a lock.
const DISCOVER_GO: StepGo = { to: 'hash', href: '#apps' };
const DISCOVER_BUTTON: StepButtonView = {
  short: 'Discover', long: 'Find an app on Discover', aria: 'Find an app on Discover', app: null, arrow: true,
  go: DISCOVER_GO,
};

/**
 * What a row says under its title and what its button is, given the
 * person's default app and where Vote goes. A done row says its own task and
 * has no button. Try, Vote and Suggest are locked while `needs_join`, and
 * only then.
 */
export function stepView(
  step: GettingStartedStep,
  model: Pick<GettingStartedModel, 'needs_join' | 'app' | 'vote' | 'try_seconds'>,
): { detail: string; button: StepButtonView | null } {
  if (step.done) return { detail: step.detail, button: null };
  const app = model.app;
  const secs = Number(model.try_seconds) || 10;
  switch (step.action) {
    case 'tour':
      return {
        detail: step.detail,
        button: { short: 'Start', long: 'Take the tour', aria: 'Start the tour', app: null, arrow: false, go: { to: 'tour' } },
      };
    case 'join':
      return {
        detail: joinDetail(step.detail),
        button: {
          short: 'Join', long: 'Find a community', aria: 'Find a community', app: null, arrow: true,
          go: { to: 'hash', href: step.href || '#apps' },
        },
      };
    case 'try':
    case 'vote':
    case 'suggest':
      if (model.needs_join === true) return { detail: 'Join a community first.', button: null };
      if (!app) {
        const detail = step.action === 'try'
          ? `Find an app on Discover and spend ${secs} seconds in it.`
          : step.action === 'vote'
            ? 'Find an app on Discover and see what people are building.'
            : 'Find an app on Discover and tell its builders what would make it better.';
        return { detail, button: DISCOVER_BUTTON };
      }
      break;
    default: {
      const label = String(step.cta || '').trim() || 'Open';
      return {
        detail: step.detail,
        button: step.href
          ? { short: label, long: label, aria: label, app: null, arrow: true, go: { to: 'hash', href: step.href } }
          : null,
      };
    }
  }
  if (step.action === 'try') {
    const long = `Try ${app.name}`;
    return {
      detail: `Spend ${secs} seconds in ${app.name}.`,
      button: { short: 'Try', long, aria: long, app, arrow: true, go: { to: 'app', slug: app.slug } },
    };
  }
  if (step.action === 'suggest') {
    const long = `Suggest a change to ${app.name}`;
    return {
      detail: `Tell ${app.name}’s builders what would make it better.`,
      button: { short: 'Suggest', long, aria: long, app, arrow: true, go: { to: 'feedback', slug: app.slug } },
    };
  }
  const vote = model.vote || { kind: 'workshop' as const, app, count: 0 };
  if (vote.kind === 'needs') {
    const long = `Vote in ${vote.app.name}`;
    return {
      detail: vote.app.slug === app.slug
        ? `${plural(vote.count)} waiting in ${app.name}.`
        : `Nothing in ${app.name} yet; ${plural(vote.count)} waiting in ${vote.app.name}.`,
      button: { short: 'Vote', long, aria: long, app: vote.app, arrow: true, go: { to: 'needs', slug: vote.app.slug } },
    };
  }
  const long = `See what ${vote.app.name} is building`;
  return {
    detail: 'Nothing is waiting for approval yet. See what people are building.',
    button: { short: 'Look', long, aria: long, app: vote.app, arrow: true, go: { to: 'workshop', slug: vote.app.slug } },
  };
}

function shot(): Shot | 'skip' | null {
  try {
    const params = new URLSearchParams(location.search);
    const asked = params.get('shot');
    if ((SHOTS as readonly string[]).includes(asked || '')) return asked as Shot;
    if (asked || params.get('demo') || params.get('token')) return 'skip';
  } catch { /* ignore */ }
  return null;
}

function isShot(mode: ReturnType<typeof shot>): mode is Shot {
  return mode != null && mode !== 'skip';
}

function viewerWantsCard(): boolean {
  const app = (window as unknown as { App?: { user?: { showGettingStarted?: boolean } | null } }).App;
  return app?.user?.showGettingStarted === true;
}

async function post(path: string, body?: unknown): Promise<void> {
  try {
    await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
  } catch (err) {
    console.warn('[getting-started] post failed', err);
  }
}

type ShellWindow = {
  App?: {
    currentApp?: string | null;
    openAppTab?: (slug: string, tab?: string, opts?: unknown) => unknown;
    openFeedbackModal?: (opts?: { target?: 'app' }) => void;
  };
  AppView?: { _landOnTab?: (slug: string, tab: string) => void };
};

/**
 * Follow a step's button. Each door is one the shell already has: the
 * router's "this app, this tab" entry point (App.openAppTab), and for a
 * project page's tab the door the hub's own links use (AppView._landOnTab,
 * then the page). Suggest opens the app first, because the dialog's "This
 * app" is the app that is open, then asks the dialog to open on it. Look
 * tells the server the Workshop opened, once it has; a fixture never posts.
 */
export async function followStep(go: StepGo, { fixture = false }: { fixture?: boolean } = {}): Promise<void> {
  const win = window as unknown as ShellWindow;
  switch (go.to) {
    case 'tour':
      requestTour();
      return;
    case 'hash':
      location.hash = go.href;
      return;
    case 'app':
      await win.App?.openAppTab?.(go.slug, 'app');
      return;
    case 'needs':
      win.AppView?._landOnTab?.(go.slug, 'needs');
      await win.App?.openAppTab?.(go.slug, 'dev');
      return;
    case 'workshop':
      win.AppView?._landOnTab?.(go.slug, 'workshop');
      await win.App?.openAppTab?.(go.slug, 'dev');
      if (!fixture && win.App?.currentApp === go.slug) void post('/api/me/getting-started/workshop-visit');
      return;
    case 'feedback':
      await win.App?.openAppTab?.(go.slug, 'app');
      if (win.App?.currentApp === go.slug) win.App?.openFeedbackModal?.({ target: 'app' });
      return;
    default:
      break;
  }
}

// The mark: a filled accent check once done, an accent ring on the next
// step, an empty ring otherwise.
function Mark({ done, next }: { done: boolean; next: boolean }) {
  if (done) {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white" aria-hidden="true">
        <CheckIcon className="h-4 w-4" />
      </span>
    );
  }
  return next ? (
    <span className="h-7 w-7 shrink-0 rounded-full border-2 border-violet-600 dark:border-violet-400" aria-hidden="true" />
  ) : (
    <span className="h-7 w-7 shrink-0 rounded-full border-2 border-zinc-300 dark:border-zinc-600" aria-hidden="true" />
  );
}

// The step's button: filled for the next step, outlined for the rest
// (button.tsx `step` / `stepOutline`), 36px, a verb and an arrow.
function StepButton({ step, view, next, onGo }: {
  step: GettingStartedStep;
  view: StepButtonView;
  next: boolean;
  onGo: (go: StepGo) => void;
}) {
  return (
    <Button
      type="button"
      layout="step"
      variant={next ? 'step' : 'stepOutline'}
      size="step"
      ink={next ? 'solid' : 'accent'}
      aria-label={view.aria}
      title={view.long}
      data-getting-started-action={step.action}
      data-getting-started-button={next ? 'solid' : 'outline'}
      {...(view.app ? { 'data-getting-started-app': view.app.slug } : {})}
      {...(view.go.to === 'needs' || view.go.to === 'workshop' ? { 'data-getting-started-vote': view.go.to } : {})}
      {...(step.action === 'tour' ? { 'data-getting-started-tour-start': '' } : {})}
      onClick={() => onGo(view.go)}
    >
      {step.action === 'tour' ? <PlayIcon className="h-3.5 w-3.5 fill-current" aria-hidden="true" /> : null}
      {view.short}
      {view.arrow ? <ChevronRightIcon className="-mr-1 h-[15px] w-[15px]" strokeWidth="2.8" aria-hidden="true" /> : null}
    </Button>
  );
}

// The reward amber and the earned green of the challenge cards
// (features/leaderboard/challenge-card.tsx META_REWARD / META_EARNED), and
// the row's own muted ink for the tour's line.
function RewardLine({ step }: { step: GettingStartedStep }) {
  const r = rewardText(step);
  if (!r) return null;
  const tone = r.tone === 'earned'
    ? 'mt-1 block text-[0.8125rem] font-semibold leading-[1.125rem] text-emerald-700 dark:text-emerald-400'
    : r.tone === 'reward'
      ? 'mt-1 block text-[0.8125rem] font-semibold leading-[1.125rem] text-amber-800 dark:text-amber-300'
      : 'mt-1 block text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400';
  return (
    <span className={tone} data-getting-started-points={r.tone}>
      {r.text}
    </span>
  );
}

// One segment per step, filled from the left, one for each step done: how
// far through the list, the way the season progress counts (the rows say
// which). Steps can be done in any order, so a segment is not a row.
function Segments({ model }: { model: GettingStartedModel }) {
  return (
    <div className="mx-4 mb-1 flex gap-1" aria-hidden="true">
      {model.steps.map((s, i) => (
        <span
          key={s.id}
          className={i < model.done ? 'h-1.5 flex-1 rounded-full bg-violet-600' : 'h-1.5 flex-1 rounded-full bg-zinc-200 dark:bg-zinc-800'}
        />
      ))}
    </div>
  );
}

function Header({ title, model, onClose, celebrate = false }: {
  title: string; model: GettingStartedModel; onClose: (() => void) | null; celebrate?: boolean;
}) {
  const earned = Number(model.earned_points) || 0;
  return (
    <div className="flex items-start gap-3 px-4 pb-3 pt-4">
      <div className="min-w-0 flex-1">
        <div className="text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{title}</div>
        <div className="mt-0.5 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-getting-started-count="">
          {/* Done, the points read as won: "+1,500 pts" in the earned green. */}
          {celebrate && earned > 0 ? (
            <>
              {`${model.done} of ${model.total} done · `}
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">{`+${pts(earned)}`}</span>
              {' earned'}
            </>
          ) : counterText(model)}
        </div>
      </div>
      {onClose ? (
        <button
          type="button"
          className="-mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-500/10 dark:text-zinc-400"
          aria-label="Close Getting started"
          title="Close"
          data-getting-started-close=""
          onClick={onClose}
        >
          <XIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

// A row is the list's row, a little tighter than a conversation's (the
// button sets its height), with its words free to wrap beside the button.
const ROW = 'min-h-[3.75rem] gap-3 py-2.5';
const NEXT_ROW = 'bg-[var(--lit-tint)]';

function StepRow({ step, next, model, onGo }: {
  step: GettingStartedStep;
  next: boolean;
  model: GettingStartedModel;
  onGo: (go: StepGo) => void;
}): ReactNode {
  const view = stepView(step, model);
  return (
    <ListRow
      inset="none"
      chevron={false}
      leading={<Mark done={step.done} next={next} />}
      title={step.title}
      titleClassName={step.done
        ? 'whitespace-normal text-zinc-500 line-through decoration-zinc-400 dark:text-zinc-400'
        : 'whitespace-normal'}
      subtitle={(
        <>
          {view.detail}
          <RewardLine step={step} />
        </>
      )}
      subtitleClassName="whitespace-normal"
      className={next ? `${ROW} ${NEXT_ROW}` : ROW}
      trailing={view.button ? <StepButton step={step} view={view.button} next={next} onGo={onGo} /> : null}
      data-getting-started-step={step.kind}
      data-done={String(step.done)}
      {...(next ? { 'data-next': '' } : {})}
      {...(step.challenge_id != null ? { 'data-challenge-id': String(step.challenge_id) } : {})}
    />
  );
}

function Progress({ model, onGo }: { model: GettingStartedModel; onGo: (go: StepGo) => void }) {
  const next = nextStepId(model);
  const foot = unlockText(model);
  return (
    <>
      <Header title="Getting started" model={model} onClose={null} />
      <Segments model={model} />
      <div className="divide-y divide-[color:var(--app-sheet-line)] pt-1">
        {model.steps.map((step) => (
          <StepRow key={step.id} step={step} next={step.id === next} model={model} onGo={onGo} />
        ))}
      </div>
      {foot ? (
        <div
          className="flex items-center gap-2 border-t border-[color:var(--app-sheet-line)] px-4 py-3 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400"
          data-getting-started-unlocks={String(model.unlocks.count)}
        >
          <LockIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{foot}</span>
        </div>
      ) : null}
    </>
  );
}

function Done({ model, onClose }: { model: GettingStartedModel; onClose: () => void }) {
  // Just the count (version D): the challenges themselves are listed in
  // Home's Challenges section right under the card, and on the Challenges tab.
  const label = unlockedLabel(model.unlocks.count);
  return (
    <>
      <Header title="You’re all set" model={model} onClose={onClose} celebrate />
      <Segments model={model} />
      {label ? (
        <div
          className="flex items-center gap-2.5 px-4 pb-0.5 pt-3.5 text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100"
          data-getting-started-unlocked={String(model.unlocks.count)}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-600/10 text-violet-600 dark:bg-violet-400/15 dark:text-violet-400" aria-hidden="true">
            <LockOpenIcon className="h-4 w-4" />
          </span>
          {label}
        </div>
      ) : null}
      <div className="px-4 pb-4 pt-3">
        <Button
          type="button"
          layout="step"
          variant="step"
          size="step"
          ink="solid"
          data-getting-started-see=""
          onClick={() => { location.hash = '#leaderboard/challenges'; }}
        >
          See challenges
          <ChevronRightIcon className="-mr-1 h-[15px] w-[15px]" strokeWidth="2.8" aria-hidden="true" />
        </Button>
      </div>
    </>
  );
}

export function GettingStarted() {
  const rootRef = useRef<HTMLElement | null>(null);
  const [model, setModel] = useState<GettingStartedModel | null>(null);
  const homeVisible = useVisibility('home-screen', true);
  const wasComplete = useRef<boolean | null>(null);

  const load = useCallback(async () => {
    const mode = shot();
    if (isShot(mode)) { setModel(SHOT_MODELS[mode]); return; }
    if (mode === 'skip' || !viewerWantsCard()) { setModel(null); return; }
    try {
      const res = await fetch('/api/me/getting-started', { credentials: 'same-origin' });
      if (!res.ok) return;
      const body = (await res.json()) as GettingStartedModel;
      const next = body && body.show && Array.isArray(body.steps) ? body : null;
      setModel(next);
      // The list just finished in this session: the season it was holding
      // back is unlocked now, so Home's Challenges block reads again rather
      // than keeping its locked card until its own refresh.
      const complete = !!(next && next.complete);
      if (complete && wasComplete.current === false) {
        (window as unknown as { HomePanels?: { ensureLoaded?: (o: { force: boolean }) => unknown } })
          .HomePanels?.ensureLoaded?.({ force: true });
      }
      if (next) wasComplete.current = complete;
    } catch (err) {
      console.warn('[getting-started] load skipped', err);
    }
  }, []);

  // After the session is read, after the join screen is answered, and each
  // time Home comes back on screen: a person who went to vote comes back to
  // a card with that step ticked.
  useEffect(() => {
    void load();
    const onChange = () => { void load(); };
    document.addEventListener('sv:authed', onChange);
    // A boot from the session snapshot confirms the session later
    // (app.js _reconcileSession), with the server's showGettingStarted.
    document.addEventListener('sv:session', onChange);
    document.addEventListener('sv:communities-joined', onChange);
    // The tour's "done" has reached the account: its row ticks.
    document.addEventListener(TOUR_DONE_EVENT, onChange);
    return () => {
      document.removeEventListener('sv:authed', onChange);
      document.removeEventListener('sv:session', onChange);
      document.removeEventListener('sv:communities-joined', onChange);
      document.removeEventListener(TOUR_DONE_EVENT, onChange);
    };
  }, [load]);
  const wasVisible = useRef(homeVisible);
  useEffect(() => {
    if (homeVisible && !wasVisible.current) void load();
    wasVisible.current = homeVisible;
  }, [homeVisible, load]);

  useHiddenClass(rootRef, !model);

  const close = () => {
    setModel(null);
    const app = (window as unknown as { App?: { user?: { showGettingStarted?: boolean } | null } }).App;
    if (app?.user) app.user.showGettingStarted = false;
    if (!isShot(shot())) void post('/api/me/getting-started/close');
  };

  const go = (target: StepGo) => { void followStep(target, { fixture: isShot(shot()) }); };

  return (
    <section ref={rootRef} id="home-getting-started" className="hidden px-3 pb-2 pt-3" aria-label="Getting started">
      {model ? (
        <GroupedList
          tone="plane"
          className="mx-0"
          data-getting-started={`${model.done}/${model.total}`}
          data-getting-started-state={model.complete ? 'done' : 'progress'}
        >
          {model.complete
            ? <Done model={model} onClose={close} />
            : <Progress model={model} onGo={go} />}
        </GroupedList>
      ) : null}
    </section>
  );
}
