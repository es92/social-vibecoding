/**
 * The Dev board card, as a plain view model.
 *
 * ── Why a model and not props per card type ───────────────────────────
 *
 * Six card renderers (issue, proposal, governance, own session, shared
 * session, merged) plus the settled close-issue row all assemble the SAME
 * four bands through one shared builder, and they have five consumers (the
 * feed, the kanban board, the In-progress strip, the Completed list and the
 * topic head). A card cannot convert before its consumers and a consumer
 * cannot convert before the cards it draws — so what converts is the shape
 * they share, and each renderer becomes a builder for it.
 *
 * ── The rule about where vocabulary lives ─────────────────────────────
 *
 * Everything here is RESOLVED data. `DEV_CARD_ICONS`, `ASSIGNEE_AVATAR_TINTS`,
 * `CATEGORY_CUSTOM_TINTS`, `_WORK_TONE_CLS`, `_priorityMeta`, `_categoryMeta`,
 * `statusPillState`, `blockReasons` — every table and every derivation stays
 * in app-view.js, and the builder puts the ANSWER in the model: the icon
 * arrives as its tint classes and its SVG path, a chip as its label and its
 * tint. Nothing in this feature re-derives a class name.
 *
 * That is not tidiness. app-view.js is a classic script this bundle cannot
 * import, and Tailwind's extractor is a regex over source text (AGENTS.md) —
 * so a palette copied over here would exist in two places, with only one of
 * them able to change colour. Resolved-data-in, markup-out keeps the tables
 * on the side that owns them and still compiles every class, because the
 * literals stay where they always were.
 *
 * ── What is deliberately still a string ───────────────────────────────
 *
 * `KudosSlot`. `Kudos.renderButton` builds the markup and `Kudos.attach`
 * binds it, `Kudos._refreshButton` writes the count into it afterwards and
 * `Kudos._renderPopover` fills the hover card — four writers in another
 * module. That is the controller-host seam AGENTS.md documents: React
 * renders the host once, empty, with a constant className and never looks
 * inside it. Nothing else on a card needs one.
 */

/** A resolved type-chip: the tint classes and the SVG path, from DEV_CARD_ICONS. */
export interface CardIconSpec {
  tint: string;
  path: string;
  /** #250 — the whole chip animates while an auto-solve run is generating. */
  pulse?: boolean;
  title?: string;
  small?: boolean;
}

/**
 * One segment of the meta line, joined with ' · '.
 *
 * Structured rather than pre-joined HTML because three of the four kinds
 * carry an interactive or tinted element (the PR/issue number link, the ★
 * bounty count, a merged card's revert link) and a card that concatenated
 * them would have to trust a caller's escaping.
 */
export type MetaPart =
  | { t: 'text'; s: string }
  | { t: 'link'; href: string; s: string; cls: string; title?: string }
  | { t: 'span'; s: string; cls: string; title?: string };

/** The composite status pill's derived state — AppView.statusPillState verbatim. */
export interface StatusPillState {
  tier: number;
  key: string;
  label: string;
  tone: string;
  fill?: boolean | 'full-yes' | 'full-no';
  yes: number;
  no: number;
  majority: number;
  advisory: number;
  lock: boolean;
  dot?: boolean;
  spinner?: boolean;
  countdown?: number;
  suffix?: string;
  reject?: boolean;
  title?: string;
  reasons?: { key: string; label: string; detail: string; soft?: boolean }[];
}

/**
 * A named call back into AppView, with its arguments.
 *
 * The cards used to carry `onclick="AppView.castVote(12, 'yes', '<sha>')"` in
 * their markup, which is what an innerHTML card had instead of a closure. A
 * React card could hold the closure — but the model has to survive being
 * published through a plain store (lib/plain-store.js), so it stays
 * serialisable and the component dispatches by name. `AppView` is the only
 * receiver, and an unknown name is a no-op rather than a throw.
 */
export interface ActionRef {
  fn: string;
  args?: (string | number | boolean | null)[];
}

/** The icon Preview affordance, in its three states. */
export type PreviewSpec =
  | { state: 'live'; sessionId: number; url: string; title: string; iconOnly: boolean }
  | { state: 'building'; title: string; iconOnly: boolean }
  | { state: 'error'; title: string; iconOnly: boolean };

/** A text pill in the action band, or a disabled one that explains itself. */
export interface ActionSpec {
  key: string;
  label: string;
  /** Rendered as text, so a label with an entity in it arrives decoded. */
  title?: string;
  cls?: string;
  disabled?: boolean;
  act?: ActionRef;
  /**
   * Append the clicked button itself to the call — the model can't hold a
   * node, and `promoteImportedSession(id, this)` disables its button for
   * the duration of the POST.
   */
  passNode?: boolean;
  /** The kudos button — a controller host, see the header. */
  kudos?: number;
  /**
   * The LABELLED Preview affordance, for the topic head's action list. The
   * card's own eye rides in `actionPreview` / the rail instead; this is the
   * same component with `iconOnly: false`, and it covers the two states
   * that are a badge rather than a button (building, unavailable).
   */
  preview?: PreviewSpec;
  /** #313/#827 — "Explore in dev chat", claimed by a delegated handler. */
  explore?: number;
}

/** Everything that can appear in the status band, as a tagged union. */
export type BadgeSpec =
  /** A plain tinted chip: work state, imported, paused, checks, console errors.
   *  `meta` rides the META LINE with the priority/assignee/category tags
   *  instead of the facts row — see metaLineNodes. The status tags set it, so
   *  the status row is left to the vote and its button alone. */
  | { t: 'chip'; key: string; cls: string; label: string; title?: string; spinner?: boolean; meta?: boolean; data?: Record<string, string> }
  /** The same chip with a click — the work-state chip that opens its target. */
  | { t: 'chipBtn'; key: string; cls: string; hover: string; label: string; title?: string; spinner?: boolean; data?: Record<string, string>; act: ActionRef }
  /** 💬 N. Always rendered, hidden at 0, so a live bump has a target. */
  | { t: 'chat'; key: string; count: number }
  /** A metadata chip (priority / assignee / category). */
  | { t: 'attr'; key: string; field: 'priority' | 'assignee' | 'category'; targetType: string; targetRef: string | number; cls: string; hover: string; title: string; count: number; readonly: boolean; label: AttrLabel }
  /** Closes #N — in-app (button) or on GitHub (anchor). */
  | { t: 'issueChip'; key: string; n: number; prefix: string; cls: string; title: string }
  | { t: 'issueLink'; key: string; n: number; href: string; verb: string; cls: string; title: string }
  /** MergeStatus.badgeHtml's descriptor, as data. */
  | { t: 'ms'; key: string; tone: string; label: string; title?: string; spinner?: boolean; glyph?: string; votes?: { yes: number; majority: number; reached: boolean } }
  /** BuildVenues.chipHtml — where this session's turns run. */
  | { t: 'venue'; key: string; label: string; title: string };

/** The three shapes an attribute chip's label takes. */
export type AttrLabel =
  | { kind: 'glyph'; glyph: string; text: string }
  | { kind: 'dot'; cls: string; text: string }
  | { kind: 'avatar'; tint: string; initial: string; text: string }
  | { kind: 'avatarEmpty'; text: string };

/** The title band: the text, plus the two things that ride beside it. */
export interface TitleSpec {
  text: string;
  /** A tinted run BEFORE the title — "↩ Revert of". */
  lead?: { s: string; cls: string };
  /** A muted run AFTER it — the close-issue row's author. */
  trail?: { s: string; cls: string };
  /** #133/#556 — the author-only inline edit pencil, topic head only. */
  edit?: { issue: number };
  /**
   * #665 — the inline title editor, replacing `beginIssueTitleEdit`'s
   * innerHTML write into the title div. While set the band renders an
   * uncontrolled input seeded with `initial`; save/cancel stay module
   * methods that read `#dev-issue-title-input` by id, exactly as before,
   * and `#dev-issue-title-error` stays a module-written node.
   */
  editing?: { issue: number; initial: string };
  /** The full text, for the clamp's own tooltip. */
  title: string;
}

/** One step of "what this still needs before it merges" (#2061). */
export interface RequirementSpec {
  key: string;
  label: string;
  /** 'auto' | 'author' | 'admin' | 'group' — who can clear it. */
  actor: string;
  /** 'done' | 'active' | 'waiting' | 'blocked' | 'pending'. */
  state: string;
  /** The one-line "why", when the gate recorded one. */
  note?: string | null;
  /**
   * The one control a gate can carry, for the viewer who can clear it. Today
   * only `main_healthy` has one: an admin's "Resume merges" while main's
   * unit suite is red. Absent for everyone else.
   */
  action?: { label: string; title?: string; act: ActionRef } | null;
}

/** An extra row under the four bands (the work note, the admin claim list). */
/** One side of a featured-illustration card's preview (#2086). */
export interface IllustrationPreviewSpec {
  url: string;
  darkUrl: string | null;
  tint: string | number | null;
}

export type ExtraSpec =
  | { t: 'note'; key: string; text: string; workState: string }
  | {
    /**
     * The proposed illustration beside the current one, on a
     * `featured_illustration` governance card. Either side null means "no
     * illustration" (the app icon shows instead); `remove` is the proposal
     * to take the current one down.
     */
    t: 'illustration';
    key: string;
    proposed: IllustrationPreviewSpec | null;
    current: IllustrationPreviewSpec | null;
    remove: boolean;
  }
  | { t: 'claims'; key: string; claims: { username: string; userId: number; issue: number }[] }
  | {
    t: 'requirements';
    key: string;
    /** The collapsed line — the whole answer for most people. */
    headline: string;
    detail?: string | null;
    done: number;
    total: number;
    /**
     * Whether to open on first paint. The card opens itself only when the
     * step it is stuck on is one THIS viewer can clear; an admin-approval
     * row put in front of a non-admin is a chore they cannot do.
     */
    open: boolean;
    gates: RequirementSpec[];
  };

/** The card's right-edge rail: ⋯ at the top, the eye at the bottom. */
export interface RailSpec {
  /** The registry key `_cardMenuTriggerHtml` registered the descriptors under. */
  menuKey?: string;
  chevron: boolean;
  preview?: PreviewSpec | null;
}

export interface DevCardModel {
  /** Stable across repaints — the React key and the store's identity. */
  key: string;
  /** The outer element's full class attribute. */
  cls: string;
  /** data-* and title on the outer element, exactly as the string card wrote them. */
  attrs: Record<string, string>;
  icon: CardIconSpec | null;
  title: TitleSpec;
  meta: MetaPart[];
  /** The composite pill. `inline` is the detail head's capsule variant. */
  pill?: { state: StatusPillState; inline: boolean } | null;
  /** Closes-#N pills — their own opt because they lead the band, outside the cap. */
  linked: BadgeSpec[];
  badges: BadgeSpec[];
  chatCount: number | null;
  actions: ActionSpec[];
  /** The eye, when it rides in the action band rather than the rail. */
  actionPreview?: PreviewSpec | null;
  rail: RailSpec;
  extra: ExtraSpec[];
  /** Board cards reserve every band; the detail head collapses empty ones. */
  dense: boolean;
  /** The detail head, which shows every chip rather than the first four. */
  uncapped: boolean;
}

// ── The two list surfaces, as view models ─────────────────────────────

/** A collapsed archived-sessions row (the toggle's list). */
export interface ArchivedRow {
  id: number;
  label: string;
  /** The muted card shell's full class attribute, from the module's constants. */
  cls: string;
  icon: CardIconSpec;
}

/** A section divider (the In-progress groups' captions). */
export interface DividerSpec {
  label: string;
  title: string;
}

/**
 * One row of a card column — the feed's pinned-sessions block and the
 * kanban In-progress column share the shape.
 */
/**
 * The app's own discussion thread for a feed row, addressed the way
 * `GroupChat.mountThread` addresses it — see ./feed-thread.tsx.
 *
 * Separate from `commentsFor`, which names an issue's GITHUB thread and is
 * read-only. A row can carry both: the GitHub conversation above, the app's
 * own (with the reply box) below.
 */
export interface FeedThreadRef {
  type: 'issue' | 'session' | 'governance';
  ref: number;
}

export type ListRow =
  | {
    t: 'card';
    key: string;
    card: DevCardModel;
    commentsFor?: number | null;
    thread?: FeedThreadRef | null;
    /** Arrived since the viewer's last Workshop visit — the "new" marker. */
    fresh?: boolean;
    /**
     * The voter-facing plain-language summary (`pr_summary_md`), on vote rows
     * only. Null when the proposal has none — a legacy one, or a summary pass
     * that failed — and the deck says so rather than leaving a gap.
     */
    summary?: string | null;
    /** The server has themes but has not placed this card into one yet. */
    placing?: boolean;
    /**
     * Which item the Needs-you deck's ask box is asking about — an ADDRESS,
     * never content. The server resolves the kind/ref pair against this
     * app's own rows (services/workshop-ask.js), so nothing the client says
     * about the card can reach the model. Null on a row with no resolvable
     * reference, and the box is then not drawn.
     */
    askAbout?: { kind: 'proposal' | 'gov' | 'issue'; ref: number } | null;
  }
  | { t: 'divider'; key: string; d: DividerSpec }
  | { t: 'note'; key: string; text: string }
  | { t: 'archived'; key: string; rows: ArchivedRow[] };

/** A kanban column's trailing affordance. */
export type FooterSpec =
  /** The Done column's age cut: "Show all N" lifts it for the session. */
  | { kind: 'showAll'; n: number }
  | { kind: 'loadMerged'; loading: boolean; n?: number | null }
  | { kind: 'github'; href: string }
  | { kind: 'moreCompleted'; n: number };

/** One lane of a Workshop theme: the theme's items at one lifecycle stage. */
export interface WorkshopLane {
  key: 'review' | 'underway' | 'open' | 'shipped';
  title: string;
  rows: ListRow[];
  /** Items past the lane's cap, reachable on the Board with the theme filter. */
  more: number;
}

/**
 * One theme on the Workshop: what a slice of the board is ABOUT, with its
 * items grouped by stage underneath. `people` is the distinct set of
 * members involved — filed, building, proposing, shipped — most involved
 * first; it is the ranking unit, as it is in Talk to the City.
 */
export interface WorkshopTheme {
  id: string;
  name: string;
  description: string;
  /** "What people are asking for" — the model's line, absent on the category grouping. */
  saying: string | null;
  /**
   * One emoji for the theme, chosen by the model (fixed per category on the
   * fallback grouping). `''` when there is none — a row written before icons
   * existed, or an answer the sanitiser rejected — and the head then draws
   * the theme's initial instead of a stand-in glyph that would mean nothing.
   */
  icon: string;
  people: string[];
  /** Epoch ms of the newest activity on any item in the theme. */
  lastActive: number;
  counts: { open: number; underway: number; review: number; shipped: number; fresh: number };
  lanes: WorkshopLane[];
  /** The trailing pseudo-theme: "Being placed" / "Not yet grouped". */
  ungrouped?: boolean;
  /** On the pseudo-theme: how many of its cards are being placed now. */
  placing?: number;
}

export interface DevWorkshopView {
  /** True until the board's first fetch lands — the skeleton stays up. */
  loading?: boolean;
  /** The open app, which the inline composer posts to. */
  slug?: string;
  /** Whether the viewer may post into a row's thread (collab-gated server-side). */
  canPost?: boolean;
  /** Who is reading, so a dismissal is per account on a shared device. */
  viewerId?: number | null;
  /** The no-items note, with its load-failure prefix. */
  emptyNote: { loadFailed: boolean; filtered?: boolean } | null;
  /** Which tab a `?ws=` deep link asked for; null for the viewer's own choice. */
  tab: 'status' | 'needs' | 'all' | null;
  /**
   * The models the ask box may talk to — the dev session's own list
   * (`DevChat.MODELS`), not a second one. Empty where DevChat is absent, and
   * the picker is then not drawn at all.
   */
  models: { list: { id: string; label: string; note: string }[]; selected: string | null };
  /**
   * The Needs-you tab's queue, in order: the proposals owed a vote, then the
   * issues nobody has claimed. One card, one question, three answers — the
   * row carries the question and what Yes and No DO, so the deck renders
   * buttons rather than deciding policy.
   */
  queue: (ListRow & {
    kind: 'vote' | 'claim';
    ask: string;
    yes: { label: string; act: { fn: string; args: unknown[] } | null } | null;
    no: { label: string; act: { fn: string; args: unknown[] } | null } | null;
    /** The caption's facts, lifted off the card's meta line. */
    who?: string | null;
    ago?: string;
    number?: number | null;
    /** An issue's body as one plain run, the claim item's sub-hero. */
    body?: string | null;
    /**
     * The item's picture: the first before/after capture pair the checks
     * shot, one still per side. Null when there is none, and the feed then
     * leaves the space under the summary empty rather than faking one.
     */
    visuals?: {
      path: string;
      mobile: boolean;
      before: string | null;
      after: string | null;
      beforeWebm: string | null;
      afterWebm: string | null;
    } | null;
  })[];
  /** Proposals awaiting THIS viewer's vote — pinned above the themes. */
  votes: {
    /** Still owed by this viewer. */
    count: number;
    /** Everything they COULD vote on, answered or not: the ring's denominator. */
    total: number;
    /** How many of `rows` the lander draws before "N more waiting on you". */
    shown: number;
    /** ALL of them: the rest are revealed in place, not on another screen. */
    rows: ListRow[];
  };

  /**
   * The viewer's OWN work in flight on this app: their dev sessions and the
   * proposals they opened. Unfiltered, like `votes` — your own work is yours
   * whatever the board is narrowed to.
   */
  mine: {
    count: number;
    shown: number;
    rows: ListRow[];
  };
  /**
   * What happened since the viewer last opened this app's Workshop, or null
   * on a first visit (the welcome takes its place). `baseline` is epoch ms.
   */
  since: {
    baseline: number;
    /** Newest activity stamp among `rows`, for Clear; 0 when nothing is new. */
    through: number;
    shipped: number;
    opened: number;
    proposed: number;
    rows: ListRow[];
    /**
     * The rest of the same list — what moved BEFORE the baseline, newest
     * first, which the reader has already seen. `Show older` walks into it
     * and Clear moves the new rows here (#2183). `rows` is capped; `total`
     * is the whole rest.
     */
    seen: { total: number; rows: ListRow[] };
  } | null;
  /** First-visit orientation: the board's shape in numbers. */
  /**
   * The app's state in numbers, every visit rather than only the first —
   * this was `welcome`, which asked a newcomer's question a returning member
   * has too. Everything here is derived from data the board already loaded;
   * nothing is written by a model.
   */
  dashboard: {
    open: number;
    themes: number;
    votesWaiting: number;
    /** Merges in the last 7 days, and in the 7 before them — a rate. */
    shippedWeek: number;
    shippedPrevWeek: number;
    /** Distinct people active on the app (the merge context's own count). */
    people: number;
    /** Open issues with no claim, no session and nobody assigned. */
    unclaimed: number;
    /** The theme with the most recent activity, by name. */
    busiest: string | null;
    /** The merged history is paged; true means the week counts are floors. */
    partial: boolean;
    /**
     * The model's three windowed lines, drawn as cards under the tiles. A
     * field is '' when that window held nothing, and its card is then not
     * drawn at all — which is why these are strings rather than optional.
     */
    cards: {
      lastWeek: string;
      thisWeek: string;
      open: string;
      /** Weeks before last week, newest first: one Monday-anchored window each. */
      older: { start: number; line: string }[];
      /** Monday of the app's first week of activity, when the server says. */
      firstWeek: number | null;
    } | null;
    /**
     * The same lines as a WALK BACKWARDS through the app's weeks, oldest
     * first — which is the order they are drawn, top to bottom. The pane
     * shows only the last entry (`open`) and reveals the rest one step at a
     * time, newest end first. Empty when no line has ever been written.
     *
     * `startMs`/`endMs` bound the window a line was written from, so the
     * pane can caption an older week with its dates; both are 0 on `open`,
     * which is not a window at all.
     */
    weeks: {
      key: string;
      title: string;
      line: string;
      startMs: number;
      endMs: number;
    }[];
    /** Monday of the app's first week of activity, when the server says. */
    firstWeek: number | null;
    /**
     * The same answer flattened to one paragraph. It is what a row last
     * written under the previous digest prompt holds, so it keeps such a
     * board saying something until its next pass re-asks for the fields.
     * Null with no model, before the first draft, or when that call failed —
     * the counts above then build the sentence instead.
     */
    summary: string | null;
  } | null;
  /** One unclaimed open issue to suggest, as a row. Null while filtering. */
  nextUp: ListRow | null;
  /**
   * #1934: the next unclaimed issues after `nextUp`, capped at
   * WORKSHOP_LANE_MAX — shown under it behind "Show N more". Empty while
   * filtering or when there is nothing past the first.
   */
  nextMore: ListRow[];
  /** The app's general discussion, as a row — see AppView._discussionCardModel. */
  discussion: ListRow | null;
  themes: WorkshopTheme[];
  meta: {
    /**
     * 'ai' from the model, 'category' from the voted category, 'demo' for
     * staging's obviously-fake grouping, null while unknown.
     */
    source: 'ai' | 'category' | 'demo' | null;
    generatedAt: string | null;
    /** When the theme definitions were last drafted; placements move between drafts. */
    discoveredAt: string | null;
    /** The grouping predates the board's current state; a refresh is behind it. */
    stale: boolean;
    /** A reconcile is running now. */
    pending: boolean;
    /** Which stage: the definitions ('discovery') or new cards into them ('placement'). */
    pendingStage: 'discovery' | 'placement' | null;
    /** Why the last stage failed, so the footnote can say so. */
    lastError: string | null;
    /** Why the model's summary paragraph is missing, when the last attempt failed. */
    digestError: string | null;
    /** How much of the board the themes hold, as the server counts it. */
    coverage: { total: number; placed: number; unplaced: number; pending: number } | null;
    /** Cards on screen the server has themes for but has not placed yet. */
    placing: number;
    /** The shared filter bar is narrowing what the themes hold. */
    filtered: boolean;
  };
  /**
   * A row to open on paint (the ?shot= deep links): the row's scope — a
   * theme id, or `mine` for "What you are working on" — and its key.
   */
  autoExpand: { theme: string; key: string } | null;
}

export interface KanbanColView {
  key: string;
  title: string;
  count: number;
  hint?: string | null;
  rows: ListRow[];
  /** The no-cards note ('Nothing here yet' / 'No matching cards'), or null. */
  empty?: string | null;
  footer: FooterSpec | null;
}

export interface DevKanbanView {
  activeTab: string;
  cols: KanbanColView[];
  /** The app, for the open card's page link ("Open page ›", #1886). */
  slug?: string;
  canPost?: boolean;
  /**
   * `?cards=open`: every card drawn unfolded — the board as it was before its
   * columns folded, and the state the declared checks that read a card's
   * anatomy run in.
   */
  unfolded?: boolean;
  /**
   * True until the board's first fetch lands. Every column draws placeholder
   * cards, and its count draws as a bar rather than `· 0` — an empty board
   * and an unloaded one look identical otherwise, which is the bug.
   */
  loading?: boolean;
}
