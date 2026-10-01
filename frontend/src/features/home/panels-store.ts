/**
 * The home screen's two fixed sections — Discover and Challenges — as view
 * models. (Create app was a third until it became the launcher grid's trailing
 * tile; that tile's view model rides the grid store, ./grid-store.ts, because
 * it is placed by the same paint as the app tiles.)
 *
 * ── The split ─────────────────────────────────────────────────────────
 *
 * `home-panels.js` keeps everything that is not markup: the `/api/home-panels`
 * fetch and its TTL, the per-key expand flags, the hidden/removable rules, the
 * ⋮ menu's rows and both destinations. What it used to do on top of that —
 * build ~800 lines of HTML string per paint and re-attach eight families of
 * listener afterwards — is now this: compute plain objects and push them.
 * `panels/sections.tsx` renders them.
 *
 * Every derivation the renderers did inline is resolved HERE, where the data
 * lives: which rows fit, whether the list reserves a meter lane. A component
 * reads facts.
 *
 * ── `painted` ─────────────────────────────────────────────────────────
 *
 * The hosts ship WITHOUT `hidden` and empty, because that is what the
 * hand-written shell shipped and hydration has to agree. A section with
 * nothing to show is `hidden` — but only once a render has decided so.
 * `painted: false` is the difference between "not yet" and "nothing", and it
 * is why the flag exists rather than being inferred from the nulls.
 */

import { createStore } from '../../lib/plain-store.js';

import type { IconView } from './grid-store';
import type { SeasonProgressView } from '../leaderboard/season-progress';

/** `data-*` attributes the block stamps on its own article AND on its host. */
export interface PanelStamps {
  /** Discover's two lane counts, mirrored so one selector can ask for both. */
  featured?: number;
  popular?: number;
  /** The Challenges block's composition: how many challenge rows it drew. */
  rows?: number;
}

// ── Discover ──────────────────────────────────────────────────────────

export interface DiscoverTileView {
  slug: string;
  name: string;
  status: string;
  demo: boolean;
  /** Is this app already in "Your apps"? Drives the badge's whole treatment. */
  added: boolean;
  icon: IconView;
  /**
   * The featured illustration: its image, how it is framed inside the art
   * block, and — when its author chose one — the card colour it sits on: a
   * tone name, or one of the legacy tint numbers saved before the tones
   * existed. An absent `tint` means the slug's own hash, which is what every
   * card without an illustration wears.
   */
  illustration?: { url: string; darkUrl?: string | null; zoom: number; x: number; y: number; tint?: string | number | null } | null;
  /**
   * The app's own one-line description, from its manifest — null when it
   * declares none, which is most apps. The card draws nothing in its place.
   */
  blurb: string | null;
  /** How many people built it. 0 hides the line rather than printing "0". */
  contributors: number;
}

export interface DiscoverView {
  key: string;
  title: string;
  featured: DiscoverTileView[];
  popular: DiscoverTileView[];
}

// ── Challenges ────────────────────────────────────────────────────────

export interface ChallengeMeterView {
  current: number;
  target: number;
  /** " Apps tested" — the metric's name, for the bar's announcement only. */
  label: string;
  pct: number;
  /**
   * A yes-or-no challenge, drawn as a two-state track (0 of 1, or 1 of 1).
   * It prints no count: the ✓ and the full track already say it, and "1/1"
   * on a challenge that was never counted reads as a measurement.
   */
  binary: boolean;
}

export interface ChallengeRowView {
  id: string;
  /** The challenge's event, for the card's deep link to its page; null without one. */
  eventId: number | null;
  /** The group header the card sits under: 'setup', 'week', 'always' or 'other'. */
  group: string;
  /** The challenge kind's icon, drawn in the tile; null when the kind has none. */
  icon: string | null;
  /**
   * The challenge template's illustration slug (shape-checked). The tile draws
   * it in place of the icon when lib/challenge-illustrations.ts resolves it.
   */
  illustration: string | null;
  /** An uploaded illustration's tone (shape-checked); null for a built-in. */
  illustrationTone: string | null;
  goal: string;
  done: boolean;
  reward: string | null;
  /** The shared rail (features/leaderboard/challenge-card.tsx). */
  state: 'new' | 'progress' | 'done';
  stateLabel: string;
  fill: number | null;
  /** A target above one: the rail draws its count and bar from zero. */
  counted: boolean;
  /**
   * "5d left" on the meta line under the title, beside the reward — the
   * challenge's own end, else its event's, else the season's; null on a
   * finished or not-open challenge, or with no end in the future. Also null
   * under a This week, Always open or Season challenges header, which owns
   * the clock; only the First challenges cards keep their own.
   */
  deadline: string | null;
  /** "Earned N pts" on a finished challenge the viewer scored on. */
  earned: string | null;
}

/**
 * One group of the block's cards under the board's group header. Every group
 * is headed, a block of one group included, so `heading` ("First challenges", "This
 * week", "Always open", "Season challenges") is null only on the renderer's
 * fallback for a view built before groups existed. `meta` is the header's
 * clock ("3d left", "no deadline") or null; never a count.
 */
export interface ChallengeGroupView {
  key: string;
  heading: string | null;
  meta: string | null;
  rows: ChallengeRowView[];
}

/** How far through the season you are — see features/leaderboard/season-progress.tsx. */
export type SeasonView = SeasonProgressView;

export interface ChallengesView {
  key: string;
  title: string;
  /**
   * "1 of 6 · 3,900 pts left", or null between seasons. The block's one-line
   * summary — no longer rendered in the section heading, where it pushed the
   * area's own label into an ellipsis on a phone. `season` draws it now.
   */
  summary: string | null;
  /**
   * "Finish Getting started to unlock the rest of the season." while the
   * gate is closed and the block has no locked card to say it (nothing
   * hidden to count); null once unlocked or with no gate.
   */
  onboardingNote?: string | null;
  /**
   * How many challenges Getting started still hides (the server's
   * `onboarding.hidden_count`), 0 once unlocked or when the payload has no
   * count. Above 0 the block is `locked`.
   */
  lockedCount?: number;
  /** The first few of their names (`onboarding.hidden_names`), for the locked card's second line. */
  lockedNames?: string[];
  /**
   * A new account's season, still behind its Getting started list
   * (2026-10-01): the block draws ONE dashed locked card and nothing else,
   * because the card on top of Home already lists the First challenges.
   */
  locked?: boolean;
  /** Null between seasons, and on the empty block. */
  season: SeasonView | null;
  /** How many challenges are OPEN — what "See all N challenges" counts. */
  total: number;
  /**
   * How many rows an expansion would draw: the open ones plus the season's
   * finished and out-of-window ones. `total` cannot tell a full-but-short
   * list from a short list with finished challenges behind it.
   */
  allTotal?: number;
  /**
   * Whether the footer draws its expand toggle at all — false when the rows
   * on screen already ARE every challenge there is, which is the "See all 3
   * challenges" under three challenges of #1824. Always true once expanded:
   * that is the way back to "Show less".
   */
  expandable?: boolean;
  expanded: boolean;
  rows: ChallengeRowView[];
  /**
   * The same row objects as `rows`, under their group headers: contiguous, in
   * the Challenges tab's group order. Absent on a view built before groups
   * existed.
   */
  groups?: ChallengeGroupView[];
}

export interface HomePanelsState {
  painted: boolean;
  discover: DiscoverView | null;
  challenges: ChallengesView | null;
}

export const INITIAL_PANELS: HomePanelsState = {
  painted: false,
  discover: null,
  challenges: null,
};

export const panelsStore = createStore<HomePanelsState>(INITIAL_PANELS);

if (typeof window !== 'undefined') {
  (window as unknown as { HomePanelsStore?: unknown }).HomePanelsStore = panelsStore;
}
