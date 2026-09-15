// The Challenges pane's subtree — #1191 slice 6, conversion 7, and the last
// of the Leaderboard screen's three innerHTML hosts to go.
//
// ── What this renders ──────────────────────────────────────────────────
//
// Everything `TopochainChallenges._renderShell()` used to innerHTML into
// #challenges-root: the grid host, and the challenge detail page and profile
// overlay that sit on top of it. The descriptors come from ./topochain-challenges-store.js,
// which that module fills; nothing here decides anything. The completed
// split, the summary tally, the deep-link resolution, the scheme guard on the
// CTA — all of it stays in the .js, which is both the island rule's
// "converted markup is like-for-like" and what keeps
// tests/challenge-deep-link.test.js able to run the real controller in a vm.
//
// ── Initial render ─────────────────────────────────────────────────────
//
// `mounted` is false until the pane is first opened, and this returns null
// until it flips. That is not an optimisation: the shipped
// #challenges-root is EMPTY, the SSG prerender pass evaluates this module,
// and anything rendered here on the first pass would land in
// public/index.html and change the structural baseline. The store's header
// says the same thing from the other end.
//
// ── Two things that are NOT portals ────────────────────────────────────
//
// The profile overlay is a `fixed inset-0 z-50` child of #challenges-root,
// which is where the markup put it and where it still is. They cover the viewport by position,
// not by parentage, so there is nothing for a portal to solve — and a portal
// would put React-managed nodes outside the island, which is the one thing
// the island rule is about.
//
// The profile overlay's backdrop dismiss keeps its original test verbatim:
// `e.target.id === <the overlay root>`, not `e.target === e.currentTarget`.
// The detail page is not an overlay at all: it is a level of the screen, in
// flow (see PAGE below).
//
// ── Whitespace ─────────────────────────────────────────────────────────
//
// Where the old strings put a bare space between two interpolations, the
// space is baked into a neighbouring string instead — the participant row's
// points-and-rate and the card rail's label are composed in
// ./topochain-challenges.js for exactly that reason. `{' '}` is not available
// here (tests/shell-build.test.js rejects it: adjacent text children are
// React #418 in a hydrating tree).

import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { resolveIllustration } from '../../lib/challenge-illustrations';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { ChallengeCard, ChallengeMeta, ProgressRail } from './challenge-card';
import { SeasonProgress, type SeasonProgressView } from './season-progress';
import type { ChallengeState } from './challenge-card';
import { topochainChallengesStore } from './topochain-challenges-store.js';

// The controller, by name. It is published on `window` for its legacy callers
// (./leaderboard.js's lazy mount, app.js's pull-to-refresh and its #982
// deep-link branch) and read back the same way here, so this component adds
// no second import edge to a file that must stay loadable as a classic
// script.
const controller = () => (window as {
  TopochainChallenges?: {
    _openIdx(idx: number): void;
    _toOnboarding(eventId: number): void;
    _moreBreakdown(): void;
    closeChallengeDetail(): void;
    _backFromDetail(): void;
    handleBack(): boolean;
    closeUserProfile(): void;
    openUserProfile(userId: number): void;
  };
}).TopochainChallenges;

// ── Descriptor shapes (see the builders in ./topochain-challenges.js) ────

type CardView = {
  key: string;
  idx: number;
  featured: boolean;
  done: boolean;
  label: string;
  goal: string;
  reward: string | null;
  icon?: string | null;
  // The template's illustration slug, shape-checked by the controller; the
  // card's tile resolves it against the registry.
  illustration: string | null;
  // An uploaded illustration's tone, shape-checked the same way; the registry
  // honours it only when it is one of its TONES.
  illustrationTone: string | null;
  // From TopochainChallenges._stateOf: the rail's state, its one short line,
  // its fill (null = indeterminate), whether it is counted (a bar, from zero),
  // and "Earned N pts" on a finished challenge the viewer scored on.
  state: ChallengeState;
  stateLabel: string;
  fill: number | null;
  counted: boolean;
  earned: string | null;
  // "5d left" (TopochainChallenges._deadlineOf); null when done.
  deadline: string | null;
};

type GroupView = { key: string; heading: string | null; cards: CardView[] };

type GridView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'cards'; progress: SeasonProgressView; notice?: string; onboardingEventId?: number | null; groups: GroupView[] };

type EntryRow = { key: string; userId: number; name: string; nonPodium: boolean; points: string };

type EntriesView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'list'; hasMore: boolean; rows: EntryRow[] };

type CtaView = { kind: 'link'; href: string; label: string } | { kind: 'text'; label: string };

type DetailView = {
  key: string;
  eyebrow: string | null;
  goal: string;
  task: string | null;
  // The template's illustration slug and an upload's tone, for the artwork
  // well (see DetailPage).
  illustration: string | null;
  illustrationTone: string | null;
  deadline: string | null;
  amount: { text: string; earned: boolean } | null;
  state: ChallengeState;
  stateLabel: string;
  fill: number | null;
  counted: boolean;
  cta: CtaView | null;
  description: string | null;
  requirements: string | null;
  scoring: string | null;
  participants: string;
  pointsTotal: string | null;
  moreLabel: string;
  entries: EntriesView;
};

type ProfileView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
    kind: 'profile';
    name: string;
    stats: { label: string; value: string }[];
    activities: { key: string; text: string; points: string }[] | null;
  };

// ── Class strings ───────────────────────────────────────────────────────
//
// The grid, overlays and rows are carried over verbatim from the retired
// templates. The card itself is ./challenge-card.tsx's `ChallengeCard`, the
// same one Home's Challenges block draws; this file only gives it the
// `tc-se-card` root class and the featured ring. That ring is also the only
// source of the `ring-violet-500/40` sentinel tests/tailwind-build.test.js
// compiles for.

// Columns by the CONTAINER, not the viewport. The screen caps content at
// max-w-5xl, so the old `sm:grid-cols-2 lg:grid-cols-3` left a 204px card body
// at three columns and 180px at two on a 640px window — narrow enough that
// the title, the "5d left · 500 pts" line and the rail label all truncate.
// A column is never narrower than 21rem
// while there are two or more; below that the grid is one full-width column.
const GRID = 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(21rem,100%),1fr))]';
const CARD_FEATURED = ' ring-1 ring-violet-500/40';
const GROUP_HEADING = 'text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2';
const GRID_ERROR = 'rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 '
  + 'dark:border-red-900 text-red-700 dark:text-red-300 px-4 py-3 text-sm';

// The challenge detail PAGE (ITERATION 03's challenge detail screen) is a
// LEVEL of the Leaderboard screen, the way a Settings section and an app's
// detail in Browse are. It takes the screen's place below the platform
// header, and that header becomes its nav bar — the chevron up to the grid
// and the challenge's name (TopochainChallenges._syncChrome / handleBack) —
// while the screen's own title, tabs and event bar (./index.tsx) and the grid
// step aside. So it scrolls with the screen and keeps the shell's safe areas,
// offline strip and pull-to-refresh, and nothing sits hidden behind it.
//
// The root and the panel keep #tc-se-detail-overlay and #tc-se-detail-panel,
// which the declared screenshot check selects on.
const PAGE = 'mx-auto w-full max-w-lg';
const PAGE_BODY = 'flex flex-col gap-3.5 pb-8';
const EYEBROW = 'min-w-0 truncate text-[0.8125rem] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400';
const PAGE_TITLE = 'text-[1.625rem] font-semibold leading-tight tracking-tight text-balance text-zinc-900 dark:text-zinc-100';
const PROSE = 'text-sm text-zinc-600 dark:text-zinc-400';
// The artwork well: the registry's tone class sets `--tint-art` for both
// themes, so the one background reads it in either.
const WELL = 'flex h-56 w-full items-center justify-center rounded-2xl bg-[var(--tint-art)]';
const SECTION_HEADING = 'text-[0.9375rem] font-semibold text-zinc-900 dark:text-zinc-100';
const CTA_LINK = 'flex h-12 w-full items-center justify-center rounded-[0.875rem] bg-violet-600 px-4 '
  + 'text-[0.9375rem] font-semibold text-white transition-colors hover:bg-violet-500';

const OVERLAY = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4';
// Split either side of the max-width, so the profile panel still renders its
// class attribute in the order the markup shipped rather than with the width
// tacked on the end.
const PANEL_HEAD = 'bg-white dark:bg-zinc-900 rounded-xl p-6 w-full';
const PANEL_TAIL = 'max-h-[85vh] overflow-y-auto shadow-xl border border-zinc-200 '
  + 'dark:border-zinc-800';
const CLOSE_X = 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 text-xl leading-none dark:text-zinc-400';
// A row is a button: the name and points are one control that opens the
// participant's profile, reachable by keyboard as well as by touch.
const ENTRY_ROW = 'tc-se-entry -mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-lg px-2 '
  + 'text-left text-sm font-medium cursor-pointer hover:bg-zinc-200/60 disabled:cursor-default dark:hover:bg-zinc-800';
// × as a character, not `&times;` — the entity was HTML source; this is text.
const TIMES = '×';

// ── Grid ────────────────────────────────────────────────────────────────

function Card({ view }: { view: CardView }): ReactNode {
  return (
    <ChallengeCard
      view={view}
      className={'tc-se-card' + (view.featured ? CARD_FEATURED : '')}
      onClick={() => controller()?._openIdx(view.idx)}
    />
  );
}

function Grid({ view }: { view: GridView | null }): ReactNode {
  // Before the first load there is nothing to say — the pane opens, the fetch
  // starts and the loading line arrives on the very next render.
  if (!view) return null;
  if (view.kind === 'loading') {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading challenges…</p>;
  }
  if (view.kind === 'error') return <div className={GRID_ERROR}>{view.message}</div>;
  if (view.kind === 'empty') {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400 py-8 text-center">No challenges for this event yet.</p>;
  }
  return (
    <>
      {/*
          The progress Home's block shares ("3/9 done in Season 2" over one
          segment per challenge). The id rides its text line, where the
          declared dapp.json check anchors.
      */}
      <SeasonProgress id="tc-se-challenge-summary" view={view.progress} className="mb-4" />
      {view.notice ? (
        <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400" role="status">{view.notice}</p>
      ) : null}
      {view.onboardingEventId != null ? (
        <button
          className="mb-3 text-sm font-medium text-violet-700 dark:text-violet-400 hover:underline"
          onClick={() => controller()?._toOnboarding(view.onboardingEventId!)}
        >
          Go to onboarding challenges
        </button>
      ) : null}
      {/*
          Fragment, not a wrapping <div>: the two grids and the subheading
          between them were siblings in the string this replaces, and a
          container here would take the heading's `mt-6` out of the same
          margin context.
      */}
      {view.groups.map((g) => (
        <Fragment key={g.key}>
          {g.heading ? <div className={GROUP_HEADING}>{g.heading}</div> : null}
          <div className={GRID}>
            {g.cards.map((c) => <Card key={c.key} view={c} />)}
          </div>
        </Fragment>
      ))}
    </>
  );
}

// ── Detail page ─────────────────────────────────────────────────────────

function Cta({ view }: { view: CtaView }): ReactNode {
  if (view.kind === 'text') {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        {view.label} <span className="italic">(link unavailable)</span>
      </p>
    );
  }
  // `href` reached here only by passing TopochainChallenges.safeHref — an
  // http(s)-only scheme check. There is deliberately no fallback branch: a
  // link that failed it is a different descriptor kind, handled above.
  return (
    <a href={view.href} target="_blank" rel="noopener" className={CTA_LINK}>
      {view.label}
    </a>
  );
}

function Entries({ view, moreLabel }: { view: EntriesView; moreLabel: string }): ReactNode {
  if (view.kind === 'loading') {
    return <p className={PROSE}>Loading participants…</p>;
  }
  if (view.kind === 'error') return <p className={PROSE}>{view.message}</p>;
  if (view.kind === 'empty') return <p className={PROSE}>No participants yet.</p>;
  return (
    <>
      <ul className="flex flex-col">
        {view.rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              className={ENTRY_ROW}
              disabled={!Number.isInteger(row.userId)}
              onClick={() => {
                if (Number.isInteger(row.userId)) controller()?.openUserProfile(row.userId);
              }}
            >
              <span className="min-w-0 truncate text-zinc-900 dark:text-zinc-100">
                {row.name}
                {/* The leading space lived between the two spans in the old
                    string; it is inside this one now, for the reason the header
                    gives. */}
                {row.nonPodium ? <span className="font-normal text-zinc-500 dark:text-zinc-400"> (non-podium)</span> : null}
              </span>
              <span className="shrink-0 tabular-nums text-zinc-700 dark:text-zinc-300">{row.points}</span>
            </button>
          </li>
        ))}
      </ul>
      {view.hasMore ? (
        <button
          id="tc-se-breakdown-more"
          className="self-start text-[0.8125rem] font-medium text-violet-700 hover:underline dark:text-violet-400"
          onClick={() => controller()?._moreBreakdown()}
        >
          {moreLabel}
        </button>
      ) : null}
    </>
  );
}

function PageSection({ heading, children }: { heading: string; children: string }): ReactNode {
  return (
    <section className="flex flex-col gap-1">
      <h3 className={SECTION_HEADING}>{heading}</h3>
      <p className={PROSE}>{children}</p>
    </section>
  );
}

// The artwork well, drawn ONLY for a slug the registry resolves
// (../../lib/challenge-illustrations.ts): the same artwork as the card's
// tile, larger, on the same pale tone, which for an upload is the payload's
// `tone` (gray when it is not one the registry knows). Anything else is no
// well at all rather than an empty one — a 224px block with nothing in it
// would be the tallest thing on the page — and so is artwork that fails to
// load, which is the offline case: the service worker leaves both image paths
// to the network. Dropping it is state, not a write to the node, because the
// page is React's. The image is `object-contain` so a non-square upload fits
// the 192px box instead of stretching.
function ArtworkWell({ slug, tone }: { slug: string | null; tone: string | null }): ReactNode {
  const art = resolveIllustration(slug, tone);
  const [failed, setFailed] = useState<string | null>(null);
  if (!art || failed === art.src) return null;
  return (
    <div className={`${art.toneClass} ${WELL}`}>
      <img src={art.src} alt="" draggable={false} className="h-48 w-48 object-contain" onError={() => setFailed(art.src)} />
    </div>
  );
}

// The board's order, below the platform header that carries the way back and
// the name: the category, the title with the card's meta line ("3d left · 720
// pts so far") and the task, the artwork well, the clean rail,
// the action, then the reading — description,
// Requirements, Scoring — and Participants under a rule. The board's
// "Next: …" hint under the action is deliberately absent (owner decision).
export function DetailPage({ view }: { view: DetailView }): ReactNode {
  return (
    <>
      <div className="flex flex-col gap-1.5">
        {view.eyebrow ? <div className={EYEBROW}>{view.eyebrow}</div> : null}
        <h2 id="tc-se-detail-title" tabIndex={-1} className={PAGE_TITLE}>{view.goal}</h2>
        <ChallengeMeta
          size="lg"
          deadline={view.deadline}
          text={view.amount ? view.amount.text : null}
          earned={!!view.amount?.earned}
        />
        {view.task ? <p className={PROSE}>{view.task}</p> : null}
      </div>
      <ArtworkWell slug={view.illustration} tone={view.illustrationTone} />
      <ProgressRail
        size="lg"
        state={view.state}
        label={view.stateLabel}
        fill={view.fill}
        name={view.goal}
        counted={view.counted}
      />
      {view.cta ? <Cta view={view.cta} /> : null}
      {view.description ? <p className={PROSE}>{view.description}</p> : null}
      {view.requirements ? <PageSection heading="Requirements">{view.requirements}</PageSection> : null}
      {view.scoring ? <PageSection heading="Scoring">{view.scoring}</PageSection> : null}
      <section className="flex flex-col gap-2 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className={`shrink-0 ${SECTION_HEADING}`}>{view.participants}</h3>
          {view.pointsTotal ? (
            <span className="min-w-0 truncate text-[0.8125rem] text-zinc-500 dark:text-zinc-400">{view.pointsTotal}</span>
          ) : null}
        </div>
        <Entries view={view.entries} moreLabel={view.moreLabel} />
      </section>
    </>
  );
}

// ── Profile overlay ─────────────────────────────────────────────────────

function ProfileBody({ view }: { view: ProfileView }): ReactNode {
  if (view.kind === 'loading') return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  if (view.kind === 'error') return <p className="text-sm text-zinc-500 dark:text-zinc-400">{view.message}</p>;
  return (
    <>
      <h2 className="text-lg font-bold text-zinc-900 dark:text-zinc-100 mb-3">{view.name}</h2>
      <div className="grid grid-cols-2 gap-2 text-xs mb-4">
        {view.stats.map((s) => (
          <div key={s.label}>
            <span className="text-zinc-500 dark:text-zinc-400">{s.label}</span>
            <div className="font-mono">{s.value}</div>
          </div>
        ))}
      </div>
      <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1">Activities</div>
      {view.activities ? (
        <ul className="space-y-1">
          {view.activities.map((a) => (
            <li key={a.key} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-zinc-600 dark:text-zinc-300">{a.text}</span>
              <span className="font-mono text-zinc-500 dark:text-zinc-400">{a.points}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">No activities recorded.</p>
      )}
    </>
  );
}

// ── The pane ────────────────────────────────────────────────────────────

// The Leaderboard screen's scroller — the screen itself, or the document in
// browser-scroller mode; PlatformUI resolves which, exactly as Settings asks
// it. Read and scrolled, never written into: the screen is not this island's.
function screenScroller(): HTMLElement | null {
  const screen = document.getElementById('leaderboard-screen');
  const ui = (window as { PlatformUI?: { scrollElement?(el: HTMLElement | null): HTMLElement | null } }).PlatformUI;
  return ui?.scrollElement?.(screen) || screen;
}

// Where a scroller's scroll events arrive: the window for the document's own.
function scrollTarget(el: HTMLElement): HTMLElement | Window {
  return el === document.scrollingElement || el === document.documentElement || el === document.body
    ? window : el;
}

export function ChallengesPane(): ReactNode {
  const state = useStoreState(topochainChallengesStore) as {
    mounted: boolean;
    grid: GridView | null;
    detail: DetailView | null;
    profile: ProfileView | null;
  };

  // A page is a level of the screen, so the screen's scroller is the page's:
  // it opens at its top, and going back up returns the grid to where it was
  // left, as a Settings section's menu does. The grid's offset is TRACKED while
  // the grid shows rather than read at open, because by the time the page has
  // rendered the grid is gone and the screen's scroll has already clamped.
  //
  // Two layout effects, in this order on purpose: the restore runs first, then
  // the tracker's setup reads the restored value. Layout effects, so the
  // tracker is removed within the same commit that hides the grid, before a
  // clamp's scroll event could reach it; and so both land inside the level
  // transition, whose store write flushes synchronously.
  const gridScroll = useRef(0);
  const wasOpen = useRef(false);
  const openKey = state.detail ? state.detail.key : null;
  useIsomorphicLayoutEffect(() => {
    const el = screenScroller();
    if (el) {
      if (openKey != null) el.scrollTop = 0;
      else if (wasOpen.current) el.scrollTop = gridScroll.current;
    }
    wasOpen.current = openKey != null;
  }, [openKey]);
  useIsomorphicLayoutEffect(() => {
    if (!state.mounted || openKey != null) return undefined;
    const el = screenScroller();
    if (!el) return undefined;
    const target = scrollTarget(el);
    const track = () => { gridScroll.current = el.scrollTop; };
    track();
    target.addEventListener('scroll', track, { passive: true });
    return () => target.removeEventListener('scroll', track);
  }, [state.mounted, openKey]);

  // A page moves focus to its title when it opens, so a keyboard or a screen
  // reader starts at the top of the new level, and Escape goes back up. With
  // the profile overlay stacked on the page, Escape closes that first.
  const detailKey = state.detail ? state.detail.key : null;
  const profileOpen = !!state.profile;
  useEffect(() => {
    if (detailKey == null) return undefined;
    if (!profileOpen) document.getElementById('tc-se-detail-title')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (profileOpen) controller()?.closeUserProfile();
      else controller()?.handleBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [detailKey, profileOpen]);

  // The prerender state, and the state before the pane's first open.
  if (!state.mounted) return null;

  return (
    <>
      <div id="tc-se-grid" className={state.detail ? 'hidden' : undefined}>
        <Grid view={state.grid} />
      </div>
      {/* Challenge detail page */}
      <div
        id="tc-se-detail-overlay"
        className={state.detail ? PAGE : `hidden ${PAGE}`}
        role="region"
        aria-labelledby={state.detail ? 'tc-se-detail-title' : undefined}
      >
        <div id="tc-se-detail-panel" className={PAGE_BODY}>
          {state.detail ? <DetailPage key={state.detail.key} view={state.detail} /> : null}
        </div>
      </div>
      {/* User profile overlay */}
      <div
        id="tc-se-profile-overlay"
        className={state.profile ? OVERLAY : `hidden ${OVERLAY}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).id === 'tc-se-profile-overlay') {
            controller()?.closeUserProfile();
          }
        }}
      >
        <div id="tc-se-profile-panel" className={`${PANEL_HEAD} max-w-md ${PANEL_TAIL}`}>
          {state.profile ? (
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <ProfileBody view={state.profile} />
              </div>
              <button
                id="tc-se-profile-close"
                className={`${CLOSE_X} shrink-0`}
                aria-label="Close"
                onClick={() => controller()?.closeUserProfile()}
              >
                {TIMES}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
