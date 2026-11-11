/**
 * The home screen's two fixed sections — Discover and Challenges — as view
 * models. (Create app was a third until it became the launcher grid's trailing
 * tile; that tile's view model rides the grid store, ./grid-store.ts, because
 * it is placed by the same paint as the app tiles.)
 *
 * ── The split ─────────────────────────────────────────────────────────
 *
 * `home-panels.js` keeps everything that is not markup: the `/api/home-panels`
 * fetch and its TTL, the hidden/removable rules, the
 * ⋮ menu's rows and both destinations. What it used to do on top of that —
 * build ~800 lines of HTML string per paint and re-attach eight families of
 * listener afterwards — is now this: compute plain objects and push them.
 * `panels/sections.tsx` renders them.
 *
 * Every derivation the renderers did inline is resolved HERE, where the data
 * lives: which challenges to show, and what the block is called. A component
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
  /**
   * Is the viewer a member of this community? Together with `added` it picks
   * the corner pill's one of three states: a real join, the quiet "Joined"
   * that taps through to the leave confirm, or a plain pin to My apps.
   */
  joined: boolean;
  icon: IconView;
  /**
   * The featured illustration: its image, how it is framed inside the art
   * block, and — when its author chose one — the card colour it sits on: a
   * tone name, or one of the legacy tint numbers saved before the tones
   * existed. An absent `tint` means the slug's own hash, which is what every
   * card without an illustration wears.
   */
  illustration?: { url: string; darkUrl?: string | null; zoom: number; x: number; y: number; tint?: string | number | null; preview?: { url: string; type?: string } | null } | null;
  /**
   * The app's own one-line description, from its manifest — null when it
   * declares none, which is most apps. The card draws nothing in its place.
   */
  blurb: string | null;
  /**
   * The fallback facts line — "12 users · Updated 3d ago" — drawn when the
   * app declares no description, so a card with no blurb still says more
   * than "N contributors". Null whenever a blurb exists.
   */
  meta: string | null;
  /** How many people built it. 0 hides the line rather than printing "0". */
  contributors: number;
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
  /** "Not started", "Started", "Done", "1/3 joined", or "2/3 apps tried this week". */
  stateLabel: string;
  fill: number | null;
  /** A target above one: the rail draws its count and bar from zero. */
  counted: boolean;
  /** "Earned N pts" on a finished challenge the viewer scored on. */
  earned: string | null;
}

/**
 * What the block holds, which names its heading (HomePanels.challengesView):
 * the First challenges, the Next ones, or one line because nothing is open,
 * either because this week's are all done or because none are running.
 */
export type ChallengesMode = 'first' | 'next' | 'done' | 'none';

export interface ChallengesView {
  key: string;
  title: string;
  mode: ChallengesMode;
  /** "First challenges", "Next challenges", or "Challenges" over the one line. */
  heading: string;
  /** Whether the heading carries "See all": every mode but `none`. */
  seeAll: boolean;
  /** The cards, in the order drawn; empty under a one-line note. */
  rows: ChallengeRowView[];
  /** The one line drawn when nothing is open, as a title and a sentence. */
  note: { title: string; text: string } | null;
}

export interface HomePanelsState {
  painted: boolean;
  challenges: ChallengesView | null;
}

export const INITIAL_PANELS: HomePanelsState = {
  painted: false,
  challenges: null,
};

export const panelsStore = createStore<HomePanelsState>(INITIAL_PANELS);

if (typeof window !== 'undefined') {
  (window as unknown as { HomePanelsStore?: unknown }).HomePanelsStore = panelsStore;
}
