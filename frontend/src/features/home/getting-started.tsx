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
 *       titles, tasks and rewards (Join a community, Try an app, Vote on a
 *       change, Suggest an improvement, as evan sets them up). NOTHING HERE
 *       NAMES THEM: the server sends whatever the season holds
 *       (GET /api/me/getting-started, src/services/onboarding.js).
 *
 * Each step ticks from what the person DID, the moment its credit is
 * written; pressing a row only takes them to where the action is (the
 * server chooses where, from the scoring rule's measure), and never ticks it.
 *
 * ── What it says ───────────────────────────────────────────────────────
 *
 *   * "Getting started", "1 of 5 done · 500 pts earned" (the points the
 *     challenges have paid; nothing is said about zero), one segment per
 *     step, then the rows.
 *   * A row: a round mark (empty; ringed in the accent for the NEXT step;
 *     a filled check once done, its title struck through), the title over
 *     its task (15 over 13), and on the right what it pays ("500 pts", in
 *     the reward amber the challenge cards use) or, once done, what it paid
 *     ("+500 pts", in their earned green). The first step not done is the
 *     next one, and sits on the lit tint (`--lit-tint`, where you are).
 *   * The foot: what finishing unlocks, "Finish all 5 to unlock 6 more
 *     challenges", or "Two more steps unlock…" near the end. Nothing when the
 *     season hides nothing.
 *   * Done: "You’re all set", the full bar, the challenges that just
 *     unlocked under a small-caps label, "See challenges", and the close
 *     button. Closing ends the card for good, on every device. Before then
 *     there is no close button, and the server refuses one: the season waits
 *     on this list, and a card closed half-way would leave it locked behind
 *     a list nobody can see.
 *
 * Home's Challenges block does not repeat the list while it is locked: it
 * draws one locked card in its place (./panels/challenges.tsx). When this
 * card turns done it asks that block to read again, so the season appears
 * under it at once rather than at the block's next refresh.
 *
 * ── The tour is a row, with its own button ─────────────────────────────
 *
 * The tour used to start by itself right after the join screen, which said
 * the same things a moment before (#3240). It is the card's first row now,
 * and the only way a newcomer meets it, so until it is done the row carries
 * a filled Start button rather than a reward: the one filled control on
 * Home, because nothing else will offer the tour again. The row itself is
 * not a button (a button cannot hold one). Once the tour is done the row is
 * an ordinary ticked row, and pressing it replays the tour. Either press asks
 * for the tour the way Settings' Replay does (./tour/tour-request.ts), and
 * the tour's own "done" landing on the account (`sv:tour-done`) reloads the
 * card, which ticks the row.
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
 * declared check can see it: a newcomer who has just joined a community
 * (1 of 5). `?shot=getting-started-halfway` is three steps in, and
 * `?shot=getting-started-done` the all-set state. Every other `?shot=`,
 * `?demo=` and `?token=` route draws nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { CheckIcon, LockIcon, PlayIcon, XIcon } from '@/components/ui/icons';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useVisibility } from '../../lib/visibility-store';
import { TOUR_DONE_EVENT } from './tour/tour-done';
import { requestTour } from './tour/tour-request';

export interface GettingStartedStep {
  /** 'tour', or `challenge-<id>`: unique in the list, and the row's key. */
  id: string;
  kind: 'tour' | 'challenge';
  title: string;
  detail: string;
  done: boolean;
  /** A hash route to go to, or null when `slug` or `action` says where (or it is the tour). */
  href: string | null;
  /** An app to open. */
  slug?: string;
  /** `feedback`: the "Ask for a change" dialog. */
  action?: 'feedback';
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
}

const SHOT = 'getting-started';
const SHOTS = ['getting-started', 'getting-started-halfway', 'getting-started-done'] as const;
type Shot = typeof SHOTS[number];

// The fixtures' steps, in the order and words evan set the season up with.
// Rewards are the admin's prose, as the server would send them.
const FIXTURE_STEPS: Array<Omit<GettingStartedStep, 'done' | 'earned_points'>> = [
  { id: 'tour', kind: 'tour', title: 'Take the 1-minute tour', detail: 'See how Homeroom works.', href: null, reward: null },
  {
    id: 'challenge-41', kind: 'challenge', challenge_id: 41, event_id: 7,
    title: 'Join a community', detail: 'Find people to build with.', href: '#apps', reward: '500 pts',
  },
  {
    id: 'challenge-42', kind: 'challenge', challenge_id: 42, event_id: 7,
    title: 'Try an app', detail: 'Open an app and try it.', href: null, slug: 'city-garden', reward: '500 pts',
  },
  {
    id: 'challenge-43', kind: 'challenge', challenge_id: 43, event_id: 7,
    title: 'Vote on a change', detail: 'Help decide what ships next.', href: '#communities', reward: '250 pts',
  },
  {
    id: 'challenge-44', kind: 'challenge', challenge_id: 44, event_id: 7,
    title: 'Suggest an improvement', detail: 'Tell a community what would make it better.',
    href: null, action: 'feedback', reward: '250 pts',
  },
];

// Five, the number the staging demo's locked Challenges block counts
// (`?demo=1&challenges=locked`, src/routes/home-panels.js), so the card and
// the block under it agree when a shot draws both.
const FIXTURE_UNLOCKS = {
  count: 5,
  names: ['Make your first proposal', 'Get a change merged', 'Invite a friend', 'Start a community'],
};

function fixture(doneIds: string[]): GettingStartedModel {
  const steps = FIXTURE_STEPS.map((s) => {
    const done = doneIds.includes(s.id);
    const pts = Number(String(s.reward || '').replace(/[^\d]/g, '')) || 0;
    return { ...s, done, earned_points: done ? pts : 0 };
  });
  const done = steps.filter((s) => s.done).length;
  return {
    show: true,
    complete: done === steps.length,
    steps,
    done,
    total: steps.length,
    earned_points: steps.reduce((sum, s) => sum + s.earned_points, 0),
    unlocks: FIXTURE_UNLOCKS,
  };
}

/**
 * The three fixture states. `getting-started` is a newcomer who has just
 * come through the join screen: "Join a community" counted the moment they
 * joined, and the tour is next. The declared check reads it.
 */
export const SHOT_MODELS: Record<Shot, GettingStartedModel> = {
  'getting-started': fixture(['challenge-41']),
  'getting-started-halfway': fixture(['tour', 'challenge-41', 'challenge-42']),
  'getting-started-done': fixture(FIXTURE_STEPS.map((s) => s.id)),
};
export const SHOT_MODEL = SHOT_MODELS[SHOT];

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

/** The small-caps label over the done state's list: "6 challenges unlocked". */
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
 * The right side of a challenge row: what it paid once done ("+500 pts"),
 * else what it pays. A reward in the admin's prose is drawn as written; a bare
 * number gets " pts" (HomePanels.formatReward's rule, so a challenge's reward
 * reads the same here as on its card).
 */
export function rewardText(step: Pick<GettingStartedStep, 'kind' | 'done' | 'reward' | 'earned_points'>): { text: string; earned: boolean } | null {
  if (step.kind !== 'challenge') return null;
  const earned = Number(step.earned_points) || 0;
  if (step.done) return earned > 0 ? { text: `+${pts(earned)}`, earned: true } : null;
  const s = String(step.reward == null ? '' : step.reward).trim();
  if (!s) return null;
  return { text: /^[\d][\d.,]*$/.test(s) ? `${s} pts` : s, earned: false };
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

// The reward amber and the earned green of the challenge cards
// (features/leaderboard/challenge-card.tsx META_REWARD / META_EARNED).
function Reward({ step }: { step: GettingStartedStep }) {
  const r = rewardText(step);
  if (!r) return null;
  return (
    <span
      className={r.earned
        ? 'max-w-[7rem] shrink-0 truncate text-[0.8125rem] font-medium text-emerald-700 dark:text-emerald-400'
        : 'max-w-[7rem] shrink-0 truncate text-[0.8125rem] font-medium text-amber-800 dark:text-amber-300'}
      data-getting-started-points={r.earned ? 'earned' : 'reward'}
    >
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

function Header({ title, model, onClose }: { title: string; model: GettingStartedModel; onClose: (() => void) | null }) {
  return (
    <div className="flex items-start gap-3 px-4 pb-3 pt-4">
      <div className="min-w-0 flex-1">
        <div className="text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{title}</div>
        <div className="mt-0.5 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" data-getting-started-count="">
          {counterText(model)}
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

const NEXT_ROW = 'bg-[var(--lit-tint)]';

function StepRow({ step, next, onOpen }: { step: GettingStartedStep; next: boolean; onOpen: (s: GettingStartedStep) => void }): ReactNode {
  const common = {
    inset: 'none' as const,
    leading: <Mark done={step.done} next={next} />,
    title: step.title,
    subtitle: step.detail,
    titleClassName: step.done ? 'text-zinc-500 line-through decoration-zinc-400 dark:text-zinc-400' : undefined,
    className: next ? NEXT_ROW : undefined,
    'data-getting-started-step': step.kind,
    'data-done': String(step.done),
    ...(next ? { 'data-next': '' } : {}),
    ...(step.challenge_id != null ? { 'data-challenge-id': String(step.challenge_id) } : {}),
  };
  if (step.kind === 'tour' && !step.done) {
    return (
      <ListRow
        {...common}
        chevron={false}
        trailing={(
          <Button
            type="button"
            variant="pillAccent"
            size="sm"
            layout="iconRow"
            className="shrink-0"
            aria-label="Start the tour"
            data-getting-started-tour-start=""
            onClick={() => onOpen(step)}
          >
            <PlayIcon className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
            Start
          </Button>
        )}
      />
    );
  }
  return (
    <ListRow
      {...common}
      as="button"
      chevron={false}
      trailing={<Reward step={step} />}
      onClick={() => onOpen(step)}
    />
  );
}

function Progress({ model, onOpen }: { model: GettingStartedModel; onOpen: (s: GettingStartedStep) => void }) {
  const next = nextStepId(model);
  const foot = unlockText(model);
  return (
    <>
      <Header title="Getting started" model={model} onClose={null} />
      <Segments model={model} />
      <div className="pt-1">
        {model.steps.map((step) => (
          <StepRow key={step.id} step={step} next={step.id === next} onOpen={onOpen} />
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
  const label = unlockedLabel(model.unlocks.count);
  const names = model.unlocks.names.slice(0, 4);
  const more = Math.max(0, Math.floor(Number(model.unlocks.count) || 0) - names.length);
  return (
    <>
      <Header title="You’re all set" model={model} onClose={onClose} />
      <Segments model={model} />
      {label ? (
        <>
          <div className="px-4 pb-1 pt-3 text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400" data-getting-started-unlocked={String(model.unlocks.count)}>
            {label}
          </div>
          <ul className="px-4">
            {names.map((name) => (
              <li key={name} className="truncate py-1 text-[0.9375rem] leading-5 text-zinc-900 dark:text-zinc-100">{name}</li>
            ))}
          </ul>
          {more > 0 ? (
            <div className="px-4 pt-0.5 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400">
              {more === 1 ? 'and 1 more' : `and ${more} more`}
            </div>
          ) : null}
        </>
      ) : null}
      <div className="px-4 pb-4 pt-3">
        <Button
          type="button"
          variant="pillAccent"
          size="sm"
          data-getting-started-see=""
          onClick={() => { location.hash = '#leaderboard/challenges'; }}
        >
          See challenges
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

  const open = (step: GettingStartedStep) => {
    if (step.kind === 'tour') {
      requestTour();
      return;
    }
    const App = (window as unknown as {
      App?: { navigateToApp?: (slug: string) => void; openFeedbackModal?: () => void };
    }).App;
    if (step.action === 'feedback') App?.openFeedbackModal?.();
    else if (step.slug) App?.navigateToApp?.(step.slug);
    else if (step.href) location.hash = step.href;
  };

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
            : <Progress model={model} onOpen={open} />}
        </GroupedList>
      ) : null}
    </section>
  );
}
