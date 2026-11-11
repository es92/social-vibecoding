// The Challenges pane's subtree — #1191 slice 6, conversion 7, and the last
// of the Leaderboard screen's three innerHTML hosts to go.
//
// ── What this renders ──────────────────────────────────────────────────
//
// Everything `TopochainChallenges._renderShell()` used to innerHTML into
// #challenges-root: the grid host, and the challenge detail page that takes
// its place. The descriptors come from ./topochain-challenges-store.js,
// which that module fills; nothing here decides anything. The groups and
// their headings' words, the summary tally, the deep-link resolution, the
// scheme guard on the CTA — all of it stays in the .js, which is both the island rule's
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
// ── The detail page is not an overlay ──────────────────────────────────
//
// It is a level of the screen, in flow (see PAGE below). The Semi design
// (2026-10-16) also retired the participants list and the profile overlay
// it opened, so nothing on this tab covers the viewport any more.
//
// ── Whitespace ─────────────────────────────────────────────────────────
//
// Where the old strings put a bare space between two interpolations, the
// space is baked into a neighbouring string instead — the card rail's label
// is composed in ./topochain-challenges.js for exactly that reason. `{' '}` is not available
// here (tests/shell-build.test.js rejects it: adjacent text children are
// React #418 in a hydrating tree).

import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { SectionHeading } from '@/components/ui/field';
import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import { resolveIllustration } from '../../lib/challenge-illustrations';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { CreditList, type CreditView } from './challenge-credits';
import { CHALLENGE_CARD_FACE, ChallengeCard, ChallengeMeta, ProgressRail } from './challenge-card';
import { LockedChallengesCard } from './locked-challenges-card';
import { SeasonProgress, type SeasonProgressView } from './season-progress';
import type { ChallengeState } from './challenge-card';
import { topochainChallengesStore } from './topochain-challenges-store.js';
import { YourStanding } from './your-standing';
import { isFrameSkin, useLiveSkin } from '../../lib/skin';
import { ChallengesFrame } from './frame/challenges-frame';
import { useLeaderboardSection } from './section-store';
import { MyStanding, myStandingStore, standingView } from './my-standing.js';

// The controller, by name. It is published on `window` for its legacy callers
// (./leaderboard.js's lazy mount, app.js's pull-to-refresh and its #982
// deep-link branch) and read back the same way here, so this component adds
// no second import edge to a file that must stay loadable as a classic
// script.
const controller = () => (window as {
  TopochainChallenges?: {
    _openIdx(idx: number): void;
    _toOnboarding(eventId: number): void;
    requestBlockProduction(): void;
    retryBpState(): void;
    retryInvites(): void;
    openWallet(): void;
    closeChallengeDetail(): void;
    _backFromDetail(): void;
    handleBack(): boolean;
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
  // and "500 pts" on a finished challenge the viewer scored on.
  state: ChallengeState;
  stateLabel: string;
  fill: number | null;
  counted: boolean;
  earned: string | null;
};

// One of TopochainChallenges.gridView's groups: First challenges, Next
// challenges or Done, each under its heading.
type GroupView = {
  key: string;
  heading: string | null;
  cards: CardView[];
};

type GridView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | {
    kind: 'cards';
    progress: SeasonProgressView;
    notice?: string;
    onboardingEventId?: number | null;
    // While Getting started gates the event: how many challenges it hides
    // (0 = none to show, and on an older server without the count), and the
    // first few of their names.
    lockedCount?: number;
    lockedNames?: string[];
    groups: GroupView[];
  };

// `route` is one of the shell's own hash routes (#2893): it navigates in
// place, never in a new tab — see TopochainChallenges.ctaView.
type CtaView =
  | { kind: 'link'; href: string; label: string }
  | { kind: 'route'; href: string; label: string }
  | { kind: 'text'; label: string };

// The block-production challenge's step for THIS viewer (#2493), shaped by
// TopochainChallenges.blockProductionStep. Null on every other challenge,
// which keep the organiser's CTA.
type BlockProductionView =
  | { step: 'checking' }
  | { step: 'locked' | 'pending'; title: string; text: string }
  | { step: 'request'; title: string; text: string; action: { label: string; pending: boolean } }
  | { step: 'error'; title: string; text: string; action: { label: string } }
  | {
    step: 'account';
    title: string;
    delegation: { title: string; text: string };
    onDevice: { title: string; text: string; warning: string } | null;
    onDeviceNote: string | null;
    action: { label: string } | null;
    appNote: string | null;
  };

type DetailView = {
  key: string;
  goal: string;
  // The organiser's what-to-do line (#6592), under the rail: what to do to
  // start and finish. Null when the challenge has none, so no line is drawn.
  task?: string | null;
  // The points under the title: earned (emerald), so far, or on offer.
  amount: { text: string; earned: boolean } | null;
  // #3253/#3248: under the points, what the scoring rule counts (a proposal
  // once it is put to the vote; nothing past a counted measure's target).
  countNote?: string | null;
  // The template's illustration slug and an upload's tone, for the artwork
  // well (see DetailPage).
  illustration: string | null;
  illustrationTone: string | null;
  state: ChallengeState;
  stateLabel: string;
  fill: number | null;
  counted: boolean;
  cta: CtaView | null;
  // #3247: the viewer's credits behind the count, and whether it is this
  // week's count (the heading says so).
  credits?: CreditView[];
  creditsWeekly?: boolean;
  // #3186: the Me screen's "Your feedback", on the feedback challenge only.
  feedbackLink?: boolean;
  // #4036: on the feedback challenge, what makes a report count, under the
  // rail the way the invite challenge's note is.
  feedbackNote?: string | null;
  // #3650: the invite challenge's plain-language line under the rail, and
  // the per-person list of who the viewer invited and why each counts.
  invitesNote?: string | null;
  invites?: {
    state: 'loading' | 'error' | 'ready';
    people?: { key: string; name: string; word: string; reason: string }[];
  } | null;
  blockProduction?: BlockProductionView | null;
  // The organiser's requirements, under "What counts".
  requirements: string | null;
};

// ── Class strings ───────────────────────────────────────────────────────
//
// The grid is carried over verbatim from the retired templates. The card itself is ./challenge-card.tsx's `ChallengeCard`, the
// same one Home's Challenges block draws; this file only gives it the
// `tc-se-card` root class and the featured ring. That ring is also the only
// source of the `ring-violet-500/40` sentinel tests/tailwind-build.test.js
// compiles for.

// Columns by the CONTAINER, not the viewport. The screen caps content at
// max-w-5xl, so the old `sm:grid-cols-2 lg:grid-cols-3` left a 204px card body
// at three columns and 180px at two on a 640px window — narrow enough that
// the title, its points and the rail label all truncate.
// A column is never narrower than 21rem
// while there are two or more; below that the grid is one full-width column.
const GRID = 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(21rem,100%),1fr))]';
const CARD_FEATURED = ' ring-1 ring-violet-500/40';
// A group's heading is the shell's label over a card group (AGENTS.md, "Type
// and colour"): grouped-list's SectionHeader, 12px small caps, set flush with
// the grid's edge rather than the inset-list gutter it is drawn for.
// The first heading sits right under the summary's own `mb-4`; each later one
// stands 24px clear of the grid above it.
const GROUP_HEADING_FIRST = 'px-1 pt-0 pb-2';
const GROUP_HEADING = 'px-1 pt-6 pb-2';
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
const PAGE_TITLE = 'text-[1.625rem] font-semibold leading-tight tracking-tight text-balance text-zinc-900 dark:text-zinc-100';
const PROSE = 'text-sm text-zinc-600 dark:text-zinc-400';
const NOTE = 'text-[0.8125rem] text-zinc-500 dark:text-zinc-400';
// The artwork well: the registry's tone class sets `--tint-art` for both
// themes, so the one background reads it in either.
const WELL = 'flex h-56 w-full items-center justify-center rounded-2xl bg-[var(--tint-art)]';
// The detail page's own section label is @/components/ui/field's
// SectionHeading — the platform's heading for "a label tight above the block
// it names", which is what "What counts" is. Not grouped-list's
// SectionHeader (the grid's group labels): that one is the label over a card
// group, and this page has no cards — its section sits flush on the screen's
// own surface.
const CTA_LINK = 'flex h-12 w-full items-center justify-center rounded-[0.875rem] bg-violet-600 px-4 '
  + 'text-[0.9375rem] font-semibold text-white transition-colors hover:bg-violet-500';
// #3186: the quieter link under the action, in the "See all" ink Me uses.
const FEEDBACK_LINK = 'self-center inline-flex min-h-[44px] items-center px-3 text-sm font-medium '
  + 'text-violet-700 hover:underline dark:text-violet-400';

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

/**
 * The grid's loading state, at the CARD's own geometry.
 *
 * Challenges is the DEFAULT section of this screen (#2374), so this is the
 * first thing the screen shows — and it was one small grey line, "Loading
 * challenges…", at the top of an otherwise empty pane. That is the same
 * "reads as blank space" the two sibling panes were fixed for
 * (./topochain-standings.tsx, ./kudos-pane.tsx, and tests/screen-skeletons.test.js
 * for the argument); this pane is the third, and the last.
 *
 * The wrapper is GRID — the constant the real groups draw with, so the cards
 * arrive into columns that are already the right width — and each placeholder
 * is CHALLENGE_CARD_FACE, the shared card's own face, exported from
 * ./challenge-card.tsx so this cannot drift from the thing it stands in for.
 * Inside it are that card's three parts at their own sizes: the 5rem artwork
 * tile (IconTile `xl`), the title with its points at the right, and the rail
 * at the card's 36px height and 11px corners.
 *
 * The summary leads, because it leads the loaded grid: its one line over its
 * one bar, at the same `mb-4`. Without it the whole grid jumps
 * up by that block's height the moment the payload lands, which is the shift
 * a skeleton exists to hold open.
 *
 * Four cards, not the six the standings table draws: a challenge card is
 * about 104px, so six would run a phone well past the fold, and four is two
 * full rows at the two columns this pane usually has.
 */
function GridSkeleton(): ReactNode {
  const t = useMessages('leaderboard');
  return (
    <SkeletonGroup label={t('leaderboard:challenges.loading')}>
      <div className="flex flex-col gap-2 mb-4">
        <Skeleton className="w-40" />
        <Skeleton shape="muted" className="h-[5px] w-full rounded-full" />
      </div>
      <div className={GRID}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={CHALLENGE_CARD_FACE}>
            <Skeleton shape="block" className="h-20 w-20 rounded-2xl" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <Skeleton className={i % 2 ? 'w-32' : 'w-40'} />
                <Skeleton shape="muted" className="w-12" />
              </div>
              <Skeleton shape="block" className="h-9 w-full rounded-[0.6875rem]" />
            </div>
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}

function Grid({ view }: { view: GridView | null }): ReactNode {
  const t = useMessages('leaderboard');
  // Before the first load there is nothing to say — the pane opens, the fetch
  // starts and the placeholders arrive on the very next render.
  if (!view) return null;
  if (view.kind === 'loading') return <GridSkeleton />;
  if (view.kind === 'error') return <div className={GRID_ERROR}>{view.message}</div>;
  if (view.kind === 'empty') {
    // W07 (overnight audit, 1 Nov 2026): the same state Home's Challenges
    // section draws, a card with a title and a hint, and on the tabs' left
    // edge. It was one grey line centred across the page, under a control
    // pinned left, so the two did not share an edge at any width.
    return (
      <GroupedList className="mx-0 mt-4" data-challenges-empty="">
        <ListRow
          chevron={false}
          title={t('leaderboard:challenges.empty')}
          subtitle={t('leaderboard:challenges.emptyHint')}
        />
      </GroupedList>
    );
  }
  // The card's own threshold, so a count it would not draw never hides the note.
  const locked = Math.floor(Number(view.lockedCount) || 0) >= 1;
  return (
    <>
      {/*
          One line, "3,500 pts · 4 of 11 done", over one bar. The id rides
          its text line, where the declared dapp.json check anchors.
      */}
      <SeasonProgress id="tc-se-challenge-summary" view={view.progress} className="mb-4" />
      {view.onboardingEventId != null ? (
        <button
          className="mb-3 text-sm font-medium text-violet-700 dark:text-violet-400 hover:underline"
          onClick={() => controller()?._toOnboarding(view.onboardingEventId!)}
        >
          {t('leaderboard:challenges.toFirst')}
        </button>
      ) : null}
      {/*
          First challenges, Next challenges, then Done, each a heading over
          its own grid. Fragment, not a wrapping <div>: the headings and grids
          are siblings in the pane's one column.
      */}
      {view.groups.map((g, n) => (
        <Fragment key={g.key}>
          {g.heading ? (
            <SectionHeader className={n ? GROUP_HEADING : GROUP_HEADING_FIRST}>{g.heading}</SectionHeader>
          ) : null}
          <div id={`tc-se-group-${g.key}`} className={GRID}>
            {g.cards.map((c) => <Card key={c.key} view={c} />)}
          </div>
        </Fragment>
      ))}
      {/*
          After the challenges, what Getting started still hides and what
          opens it: the locked placeholder, whose first line IS the unlock
          note, so the note paragraph draws only when there is no placeholder (a locked
          event on a server without the count; unlocked, there is no note). Both
          sit under the last card at the grid's own 12px gap. The placeholder's
          wrapper is a GRID too, so on a wide pane it takes one column like a
          card instead of stretching into a banner across all of them.
      */}
      {locked ? (
        <div className={`mt-3 ${GRID}`}>
          <LockedChallengesCard count={view.lockedCount!} names={view.lockedNames} />
        </div>
      ) : null}
      {view.notice && !locked ? (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400" role="status">{view.notice}</p>
      ) : null}
    </>
  );
}

// ── Detail page ─────────────────────────────────────────────────────────

function Cta({ view }: { view: CtaView }): ReactNode {
  if (view.kind === 'text') {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        <RichMessage
          id="leaderboard:challenges.detail.linkUnavailable"
          values={{ label: view.label }}
          components={[<span className="italic" />]}
        />
      </p>
    );
  }
  // `href` reached here only by passing TopochainChallenges.safeHref — an
  // http(s)-only scheme check — or, for `route`, its in-app route shape, which
  // is a bare fragment. There is deliberately no fallback branch: a link that
  // failed both is a different descriptor kind, handled above.
  //
  // A route stays in this document (#2893). In the Homeroom app a
  // target="_blank" tap goes to the system browser, which has no native
  // bridge and therefore no Settings › Homeroom app to land on.
  const external = view.kind === 'link';
  return (
    <a
      href={view.href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener' : undefined}
      className={CTA_LINK}
    >
      {view.label}
    </a>
  );
}

// The block-production step's boxes: the plain card the wallet sheet's
// block-production section draws, and its title/body type.
const BP_CARD = 'rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm';
const BP_TITLE = 'text-base font-semibold text-zinc-900 dark:text-zinc-100';
const BP_TEXT = 'mt-1 text-sm text-zinc-500 dark:text-zinc-400';
const BP_BUTTON = `${CTA_LINK} disabled:cursor-wait`;

function BlockProductionStep({ view }: { view: BlockProductionView }): ReactNode {
  const t = useMessages('leaderboard');
  if (view.step === 'checking') {
    return (
      <p data-bp-step="checking" className={PROSE}>{t('leaderboard:bp.checking')}</p>
    );
  }
  if (view.step === 'account') {
    return (
      <section data-bp-step="account" className="flex flex-col gap-3">
        <SectionHeading className="mb-0" title={view.title} />
        <div data-bp-option="delegate" className={BP_CARD}>
          <div className={BP_TITLE}>{view.delegation.title}</div>
          <div className={BP_TEXT}>{view.delegation.text}</div>
        </div>
        {view.onDevice ? (
          <div data-bp-option="on-device" className={BP_CARD}>
            <div className={BP_TITLE}>{view.onDevice.title}</div>
            <div className={BP_TEXT}>{view.onDevice.text}</div>
            <Alert variant="notice" density="compact" className="mt-2" data-bp-warning="on-device">
              {view.onDevice.warning}
            </Alert>
          </div>
        ) : null}
        {view.onDeviceNote ? <p className={PROSE}>{view.onDeviceNote}</p> : null}
        {view.action ? (
          <button
            type="button" id="tc-bp-manage" className={BP_BUTTON}
            onClick={() => controller()?.openWallet()}
          >{view.action.label}</button>
        ) : null}
        {view.appNote ? <p className={PROSE}>{view.appNote}</p> : null}
      </section>
    );
  }
  return (
    <section data-bp-step={view.step} className="flex flex-col gap-3">
      <div className={BP_CARD}>
        <div className={BP_TITLE}>{view.title}</div>
        <div className={BP_TEXT}>{view.text}</div>
      </div>
      {view.step === 'request' ? (
        <button
          type="button" id="tc-bp-request" className={BP_BUTTON}
          disabled={view.action.pending}
          onClick={() => controller()?.requestBlockProduction()}
        >{view.action.label}</button>
      ) : null}
      {view.step === 'error' ? (
        <button
          type="button" id="tc-bp-retry" className={BP_BUTTON}
          onClick={() => controller()?.retryBpState()}
        >{view.action.label}</button>
      ) : null}
    </section>
  );
}

function PageSection({ heading, children }: { heading: string; children: string }): ReactNode {
  return (
    // No `gap-1` any more: SectionHeading's own `mb-1` is that gap, and the two
    // together would double it.
    <section className="flex flex-col">
      <SectionHeading title={heading} />
      <p className={PROSE}>{children}</p>
    </section>
  );
}

// #3650: the invite challenge's per-person list. A row is the person, the
// grey line under their name is why they do or do not count yet (it can run
// to two lines, so it is not truncated), and the word on the trailing edge
// is the status — Counted in the accent a finished thing earns, everything
// else quiet, because the action is on the people still waiting, not on the
// word.
const INVITE_COUNTED = 'text-sm font-medium text-emerald-700 dark:text-emerald-400';
const INVITE_MUTED = 'text-sm font-medium text-zinc-500 dark:text-zinc-400';

function InviteList({ view }: { view: NonNullable<DetailView['invites']> }): ReactNode {
  const t = useMessages('leaderboard');
  const heading = t('leaderboard:challenges.invites.heading');
  if (view.state === 'loading') {
    return (
      <section data-tc-invites className="flex flex-col">
        <SectionHeading title={heading} />
        <SkeletonGroup label={heading}>
          <GroupedList className="mx-0">
            {Array.from({ length: 3 }, (_, i) => (
              <ListRow
                key={i}
                chevron={false}
                title={<Skeleton shape="block" className="h-4 w-28" />}
                subtitle={<Skeleton shape="block" className="mt-1 h-3 w-full" />}
              />
            ))}
          </GroupedList>
        </SkeletonGroup>
      </section>
    );
  }
  if (view.state === 'error' || !view.people?.length) {
    return (
      <section data-tc-invites className="flex flex-col">
        <SectionHeading title={heading} />
        <p className={PROSE}>
          {view.state === 'error'
            ? t('leaderboard:challenges.invites.error')
            : t('leaderboard:challenges.invites.empty')}
        </p>
        {view.state === 'error' ? (
          <button
            type="button" id="tc-se-invites-retry" className={`${BP_BUTTON} self-start`}
            onClick={() => controller()?.retryInvites()}
          >{t('leaderboard:bp.error.retry')}</button>
        ) : null}
      </section>
    );
  }
  return (
    <section data-tc-invites className="flex flex-col">
      <SectionHeading title={heading} />
      <GroupedList className="mx-0">
        {view.people.map((p) => (
          <ListRow
            key={p.key}
            chevron={false}
            title={p.name}
            subtitle={p.reason}
            subtitleClassName="whitespace-normal"
            trailing={(
              <span className={p.word === 'counted' ? INVITE_COUNTED : INVITE_MUTED}>
                {t(`leaderboard:challenges.invites.status.${p.word}`)}
              </span>
            )}
          />
        ))}
      </GroupedList>
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

// The page, below the platform header that carries the way back: the title,
// its points ("500 pts", "320 pts so far", emerald once earned) and what the
// rule counts, then a line on what points are for whenever points show, the
// artwork well, the clean rail, the organiser's task line, the action, then
// "What counts". The Semi design (2026-10-16) left out the category eyebrow,
// the deadline and the time of the next count, the description, Scoring and
// the participants list (with the profile overlay it opened); the task line it
// left out too is back (#6592), because it is what tells people how to start
// and finish. The card's title says what the challenge is and "What counts"
// says how it is counted. The board's "Next: …" hint under the action is
// deliberately absent (owner decision).
export function DetailPage({ view }: { view: DetailView }): ReactNode {
  const t = useMessages('leaderboard');
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <h2 id="tc-se-detail-title" tabIndex={-1} className={PAGE_TITLE}>{view.goal}</h2>
        <ChallengeMeta
          size="lg"
          text={view.amount ? view.amount.text : null}
          earned={!!view.amount?.earned}
        />
        {view.countNote ? <p className={NOTE}>{view.countNote}</p> : null}
        {view.amount ? <p className={NOTE}>{t('leaderboard:challenges.detail.pointsNote')}</p> : null}
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
      {/* #6592: the organiser's one-line task — what to do to start and
          finish — right under the rail. It is their own words, so no heading
          and no label: the same plain prose the notes below it use. */}
      {view.task ? <p className={PROSE} data-challenge-task>{view.task}</p> : null}
      {/* #3650: what makes an invite count, in plain words, right under the
          rail that shows the count. */}
      {view.invitesNote ? <p className={PROSE}>{view.invitesNote}</p> : null}
      {/* #4036: the same for a feedback report, whose own project and
          scheduled, graded count are what a stuck rail is usually about. */}
      {view.feedbackNote ? <p className={PROSE}>{view.feedbackNote}</p> : null}
      {view.blockProduction ? <BlockProductionStep view={view.blockProduction} /> : null}
      {view.cta ? <Cta view={view.cta} /> : null}
      {/* #3186: the feedback challenge's count is the viewer's own reports;
          this is where each one is listed with whether it counted, by the
          address Profile.open() honours. A constant, so it needs no guard. */}
      {view.feedbackLink ? (
        <a id="tc-se-feedback-mine" href="#profile?feedback" className={FEEDBACK_LINK}>
          {t('leaderboard:challenges.detail.seeFeedback')}
        </a>
      ) : null}
      {/* #3650: who the viewer invited, and why each person does or does not
          count yet — before "What counts", the same way the feedback link is
          the viewer's own records beside the count. */}
      {view.invites ? <InviteList view={view.invites} /> : null}
      <CreditList credits={view.credits} weekly={view.creditsWeekly} />
      {view.requirements ? <PageSection heading={t('leaderboard:challenges.detail.requirements')}>{view.requirements}</PageSection> : null}
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

/**
 * The grid under one of the frame's looks: the kit's page
 * (./frame/challenges-frame.tsx) from this pane's own view and the
 * viewer's standing (./my-standing.js), which the standard look draws as a
 * card of its own over the grid.
 */
function ChallengesInFrame({ grid, up }: { grid: Extract<GridView, { kind: 'cards' }> | null; up: boolean }): ReactNode {
  const t = useMessages('leaderboard');
  // The pane stays mounted behind Standings and Kudos: it is the page on
  // show only while its own section is.
  const { section } = useLeaderboardSection();
  const standing = standingView(useStoreState(myStandingStore)) as {
    rank: number | null; people: number; pending: string | null;
    token: { gated: true } | { gated: false; empty: boolean; amount: string; revealed: boolean };
  } | null;
  useEffect(() => { void MyStanding.load(); }, []);
  const plain = (text: string) => text.replace(/<\/?\d+>/g, '');
  const ranked = standing && standing.rank != null
    ? (standing.people > 0
      ? t('leaderboard:standing.rankOf', { rank: standing.rank, count: standing.people, number: standing.people.toLocaleString('en-US') })
      : t('leaderboard:standing.rank', { rank: standing.rank }))
    : null;
  // While the cards load (grid null) the page is still the kit's: the
  // standing it knows, no groups, and a loading note.
  const points = grid && grid.progress.points != null ? Math.round(grid.progress.points).toLocaleString('en-US') : null;
  const progress = !grid ? null : points
    ? t('leaderboard:progress.summary', { points: t('leaderboard:frame.pts', { points }), done: grid.progress.done, count: grid.progress.total })
    : t('leaderboard:progress.plainLabel', { done: grid.progress.done, count: grid.progress.total });
  const said = [ranked ? plain(ranked) : null, standing?.pending || null, progress ? plain(progress) : null].filter((part): part is string => !!part);
  // "#16" and " of 151 ranked": the figure the catalog marks, then its words.
  const figure = ranked ? /<0>(.*?)<\/0>(.*)/.exec(ranked) : null;
  const token = !standing ? null
    : standing.token.gated ? { gated: true as const, onReview: () => MyStanding.reviewTerms() }
      : standing.token.empty ? null
        : { gated: false as const, amount: standing.token.amount, revealed: standing.token.revealed, onReveal: () => MyStanding.revealTokens() };
  return (
    <ChallengesFrame
      up={up && section === 'challenges'}
      tabs={[{ key: 'challenges', label: t('leaderboard:tabs.challenges') }, { key: 'topochain', label: t('leaderboard:tabs.standings') }]}
      onTab={(key) => { if (key !== 'challenges') (window as any).Leaderboard?._setSection?.(key); }}
      purpose={said.length ? said.reduce((first, second) => t('leaderboard:frame.pair', { first, second })) : null}
      groups={grid ? grid.groups : []}
      notice={grid ? grid.notice : t('leaderboard:challenges.loading')}
      onOpen={(idx) => controller()?._openIdx(idx)}
      season={figure ? { rank: figure[1], of: figure[2].trim() || null, points, pointsLabel: t('leaderboard:frame.points') } : null}
      note={standing ? t('leaderboard:standing.updateNote') : null}
      token={token}
    />
  );
}

export function ChallengesPane(): ReactNode {
  // Under one of the frame's looks the grid is the kit's page, drawn ahead
  // of this pane's own parts, which app.css puts away while it is up.
  const frame = isFrameSkin(useLiveSkin());
  const state = useStoreState(topochainChallengesStore) as {
    mounted: boolean;
    grid: GridView | null;
    detail: DetailView | null;
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
  // reader starts at the top of the new level, and Escape goes back up.
  const detailKey = state.detail ? state.detail.key : null;
  useEffect(() => {
    if (detailKey == null) return undefined;
    document.getElementById('tc-se-detail-title')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') controller()?.handleBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [detailKey]);

  // The prerender state, and the state before the pane's first open.
  if (!state.mounted) return null;

  return (
    <>
      <div id="tc-se-grid" className={state.detail ? 'hidden' : undefined}>
        {/*
            The viewer's own standing leads the tab, as the prototype's
            Challenges page does — the rank, the people it is among and the
            token allocation the Me screen used to carry (./your-standing.tsx).
            It is inside the grid so a challenge's page hides it too.
        */}
        {frame && (!state.grid || state.grid.kind === 'loading' || state.grid.kind === 'cards') ? (
          <ChallengesInFrame grid={state.grid && state.grid.kind === 'cards' ? state.grid : null} up={!state.detail} />
        ) : null}
        <YourStanding />
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
    </>
  );
}
