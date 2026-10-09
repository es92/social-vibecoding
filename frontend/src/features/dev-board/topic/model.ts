/**
 * The topic head's BODY — everything under the card — as a view model.
 *
 * `_renderTopicHead` used to innerHTML `#gc-thread-head` with the card's
 * markup plus a body built from eight string renderers. The card converted
 * with the rest of the card family (../card/); this is the other half, and
 * it decomposes where the card family could not: each block is a separate
 * region with its own data, so they share one shape rather than one
 * builder.
 *
 * ── One note box, four callers ────────────────────────────────────────
 *
 * `_mergeConflictDetailHtml`, `_platformEnvDetailHtml`,
 * `_consoleCheckDetailHtml` and three of `_checksDetailHtml`'s five states
 * all drew THE SAME THING: a bordered, tinted box with a heading, some
 * rows and sometimes a button. They are `NoteBox` now, and the tone is a
 * name rather than four hand-written class strings — which is what makes
 * them stay one box as the palette moves.
 *
 * The checks VERDICT box keeps its own shape: its rows nest (a failure
 * carries its reason and its console errors) and its passing rows fold away
 * behind a `<details>`, neither of which the shared box has any business
 * knowing about.
 */

import type { ActionSpec, StatusPillState } from '../card/model';
import type { RequestSpecCard } from './request-model';


/** The four tints a note box comes in. Resolved to classes by the component. */
export type NoteTone = 'neutral' | 'ok' | 'warn' | 'error';

/**
 * A run of prose, with the emphasised spans called out.
 *
 * Several of these sentences name a person or a tool mid-sentence in
 * `font-medium` — "…imported by **maya**…", "Changed on both sides:
 * **7 files**…" — and a plain string could not carry that. `{ b }` is the
 * emphasised run; a bare string is ordinary text.
 */
export type TextRun = string | {
  b: string;
  /**
   * A row's STATE, as its first word — "Failing.", "Syncing.", "Approved" —
   * drawn bold in the ledger tone named here, so a reader scanning the
   * ledger finds the one word they are looking for. Absent, the run is the
   * plain `font-medium` emphasis the note boxes use for a name.
   */
  tone?: 'bad' | 'warn' | 'ok' | 'vote' | 'mute';
};

export interface NoteItem {
  /** A `<code>` run — a variable name, a file path. */
  code?: string;
  text?: string;
  /** Sets the whole row in mono at 0.7rem, for a path or a log line. */
  mono?: boolean;
  /** The console-error rows' `[kind] message (source)` shape. */
  kind?: string;
  source?: string;
}

/**
 * One row under a note box's heading — a line of prose, or a bulleted list.
 *
 * ORDERED, and tagged rather than split into a `lines` field and a `list`
 * field, because the two boxes that have a list put it in different places:
 * the conflict box introduces its files ("Conflicting files:") and then
 * lists them, with two more lines after; the platform-variables box lists
 * the missing keys directly under the heading and explains itself below.
 * A lines-then-list shape renders both, in the wrong order, silently.
 */
export type NoteRow =
  | {
    t: 'line';
    parts: TextRun[];
    /** `mt-0.5 opacity-90` (the lede) vs `mt-1 opacity-80` (the footnote). */
    weight?: 'lede' | 'foot';
  }
  | { t: 'list'; items: NoteItem[]; cls?: string };

export interface NoteBox {
  key: string;
  tone: NoteTone;
  heading: string;
  /** An in-flight arc before the heading. */
  spinner?: boolean;
  rows: NoteRow[];
  action?: ActionSpec | null;
}

/** One row of the checks verdict: a check, and why it failed. */
export interface CheckRow {
  key: string;
  pass: boolean;
  advisory: boolean;
  name: string;
  path?: string | null;
  /**
   * Percent of this check's recorded runs that failed, or null when it has
   * never failed, has too little history to judge, or is reliable enough
   * that the chip would be noise. A graduated check keeps blocking when it
   * starts failing intermittently — that is deliberate, there is no
   * demotion — so this chip is the only thing that says it is doing so.
   */
  flaky?: number | null;
  /**
   * True when this row is GREEN only because a retry passed. The reason
   * line is kept for it, which the renderer otherwise drops for a pass:
   * the failure happened, it just did not reproduce.
   */
  keepReason?: boolean;
  reason?: string | null;
  /**
   * The repo unit suite row's per-test excerpts (request #3978): the file,
   * the test name and the captured error text — assertion message,
   * expected/actual, the first stack lines. Empty on every other row; a
   * declared check's reason is its diagnosis.
   */
  details?: { file: string | null; test: string; excerpt: string }[];
  errors?: { kind: string; message: string; source?: string | null }[];
  /**
   * The repo unit suite only (#3978): per failing test, its file, its name
   * and a bounded, redacted excerpt of the error the runner printed.
   */
  details?: { file?: string | null; test: string; excerpt: string }[];
}

export interface ChecksVerdict {
  failing: boolean;
  heading: string;
  summary: string;
  failures: CheckRow[];
  passes: CheckRow[];
  /**
   * How many passed. More than `passes.length` while the row counts its
   * passes rather than listing them (a Workshop list row, or the item's own
   * row until its fold is opened).
   */
  passCount: number;
  /**
   * The session whose passing checks are counted but not yet named: opening
   * the fold reads them (AppView._loadCheckNames). Null once they are listed.
   */
  passesFor?: number | null;
  /** Passes fold behind a `<details>` above this many. */
  foldPasses: boolean;
  advisoryNote: string | null;
  checkedNote: string | null;
  /** #1442: "these ran against a main that has since moved on". */
  baseNote: string | null;
  fixNote: string | null;
  action: ActionSpec | null;
}

/** One entry in the detail block's ordered list of boxes. */
export type DetailBlock =
  | { t: 'note'; box: NoteBox }
  | { t: 'checks'; v: ChecksVerdict };

/** The proposal's detail block: the meta line, its notes, and the boxes. */
/**
 * One row of the "Where it stands" ledger — the topic page's one place
 * where state is EXPLAINED (the card's bar is where it is summarised).
 *
 * A row is a dot in the bar's tone, a label with an optional count under
 * it, a sentence, and at most a couple of controls. It replaces four
 * things that used to stack under the card in four box styles: the "Why
 * this can't merge yet" reasons, the checks panel, the roster line and the
 * amber provenance notes — the last of which #2588 dropped again, because a
 * fact about where the change came from is not a step, and the hero line
 * above the card already says it. `key` is the row's `data-note`, which is
 * what the declared checks address a row by (`mergeability`, `checks`,
 * `env`, …).
 */
/** The repo unit suite (`npm test`), run alongside the browser checks. */
export interface LedgerUnitProgress {
  /** cloning | installing | running | done */
  phase: string;
  ran: number;
  passed: number;
  failed: number;
  skipped?: number;
  /** Last completed run's `# tests`, when known; null while it is not. */
  expected: number | null;
  done?: boolean;
}

/** One phase inside the image build (a buildpack lifecycle phase). */
export interface LedgerBuildPhase {
  name: string;
  ms: number | null;
  state: 'done' | 'now' | 'todo';
}

/** One step of the preview build: fetch, image, database, start, prepare checks. */
export interface LedgerBuildStep {
  key: string;
  label: string;
  /** Wall clock of a finished step; null while it is running or ahead. */
  ms: number | null;
  state: 'done' | 'now' | 'todo';
  /** The image step's phases, live or finished. */
  phases?: LedgerBuildPhase[] | null;
  /** The running phase's last log line. */
  detail?: string | null;
}

/** A run in flight: what the capture container has reported so far. */
export interface LedgerProgress {
  ran: number;
  passed: number;
  failed: number;
  /** Declared check count, when known; null while it is not. */
  expected: number | null;
  done?: boolean;
  unit?: LedgerUnitProgress | null;
  build?: LedgerBuildStep[] | null;
}

export interface LedgerRow {
  key: string;
  tone: 'bad' | 'warn' | 'ok' | 'vote' | 'mute' | 'progress';
  spinner?: boolean;
  /**
   * Its position in the path a blocked proposal takes, drawn in the dot in
   * place of the tone glyph. Set only when there is a sync step to order
   * the others against (`_topicLedgerPath`); a row with no step keeps its
   * glyph.
   */
  step?: number | null;
  /**
   * True once this step is CLEARED — its checkbox draws a tick instead of
   * its number. Only checks and votes can reach it; the sync step is on the
   * path only while it is outstanding.
   */
  stepDone?: boolean;
  label: string;
  /**
   * The small line under the label. Two jobs: a count ("1 of 463 failing" —
   * followed, while the row still carries what the run cost, by "built in
   * 20s · checked in 9m 40s", #2170), or, on a numbered step, who acts and
   * when — "snait, now", "automatic, after 1".
   */
  sub?: string | null;
  /** The sentence, in the primary ink. */
  text: TextRun[];
  /**
   * Follow-on material under the sentence, muted and IN ORDER: a text run
   * array is a line, `{ list }` is a bulleted mono list. One ordered array
   * for the same reason `NoteRow` above is one — a lines-then-list shape
   * renders both in the wrong order, silently, which is exactly what the
   * ledger did to the conflicting-file list until it carried lists here.
   */
  foot?: (TextRun[] | { list: NoteItem[] })[];
  /** Follow-on lines in the attention tone — the admins-list and locked-app rules. */
  warnFoot?: TextRun[][];
  /** The checks row's failing tests, listed; and its passing ones, folded. */
  fails?: CheckRow[] | null;
  passes?: CheckRow[] | null;
  /** How many passed: `passes` can be shorter (ChecksVerdict.passCount). */
  passCount?: number | null;
  /** ChecksVerdict.passesFor: whose passing checks the fold still has to read. */
  passesFor?: number | null;
  /** The votes row's roster. */
  roster?: RosterView | null;
  /** The checks row's live progress while the run is pending. */
  progress?: LedgerProgress | null;
  actions?: ActionSpec[];
  /** Extra attributes on the row — `data-checks-base="superseded"` for one check. */
  attrs?: Record<string, string>;
  /**
   * The Review row: draw "How voting works" at the right end of its line.
   * It used to be a caption under the whole ledger; it explains this row.
   */
  help?: boolean;
}

export interface ProposalDetails {
  /** "View PR on GitHub · proposed by maya · 2h ago", already split. The head draws the GitHub link on the card's meta line instead. */
  meta: { href?: string | null; parts: TextRun[] }[];
  /** The ledger the head draws; the fields below are the material it is built from. */
  ledger: LedgerRow[];
  /**
   * How many of the ledger's rows are numbered steps of the merge path, or
   * null when there is no path to draw. Numbering says the steps are
   * ORDERED; the caption this feeds says they are a GATE — every one of
   * them has to clear before the proposal merges.
   */
  pathSteps?: number | null;
  /** How many of those steps are still outstanding, for the same caption. */
  pathLeft?: number | null;
  /** The circular "?" beside the meta line. */
  help: boolean;
  /** A prose note under the meta line. */
  notes: { key: string; parts: TextRun[]; tone: 'muted' | 'warn' }[];
  linked: { n: number; href: string }[];
  /**
   * The note boxes and the checks verdict, IN ORDER — conflict, checks,
   * platform variables. A tagged list rather than three fields because the
   * order is the whole contract: a reader scanning a blocked proposal reads
   * them top to bottom, and the verdict sits between the other two.
   */
  blocks: DetailBlock[];
  /** The vote roster, filled by `_loadVoteRoster` once it answers. */
  roster: RosterView | null;
  helpHint: boolean;
  explicitNote: string | null;
  lockedNote: string | null;
}

export interface RosterView {
  /** 'loading' until the fetch answers; 'hidden' when it fails. */
  phase: 'loading' | 'ready' | 'hidden';
  /**
   * Whether the vote has what it needs (`_topicLedgerRows` reads the same
   * counts the pill does). Approved, the line reads "Approved by @maya ✓";
   * not yet, it reads the tally.
   */
  approved?: boolean;
  yes?: { label: string; names: string };
  no?: { label: string; names: string };
  needs?: string;
  /** #1688: the line each counted vote carries, one entry per voter who left one. */
  reasons?: { who: string; vote: 'yes' | 'no'; text: string }[];
  /** #1688: "Earlier version: @alice, @bob …" — votes on a previous version, or null. */
  earlier?: string | null;
}

/** The shared-chat section: a disclosure whose BODY is another module's. */
export interface TranscriptSection {
  id: number;
  label: string;
  expanded: boolean;
}

/** A compact issue reference used by the change detail and its issue picker. */
export interface IssueLink {
  n: number;
  title: string;
  href: string;
}

/**
 * #2431 — the change addressing an issue, on the ISSUE's page: the mirror of
 * `IssueLink` above.
 *
 * `heading` is already worded ("Closed by", "In review", "Work underway") by
 * `_issueProposalRefView`, because the choice needs the issue's own state as
 * well as the change's; `state` rides along only so the chip can pick its
 * tone. Absent when nothing links the issue — there is no "not known yet"
 * row, which would be a claim nobody made.
 */
export interface IssueProposalRef {
  heading: string;
  state: 'merged' | 'review' | 'underway';
  sessionId: number;
  /** `#<pr number>`, or "Change" before the change has a pull request. */
  label: string;
  title: string;
  href: string;
}

/**
 * #4244 — a CLOSED request's one status band, at the top of its card
 * (`_issueClosedBandView`). `merged` when a merged change closed it (`ref` is
 * that change, drawn as the band's pill); `settled` when a close vote or an
 * admin did (`how` says which, when the server knows).
 */
export interface IssueClosedBand {
  tone: 'merged' | 'settled';
  /** Short stamp: "Oct 5", or "3d ago" inside a week. */
  when: string | null;
  whenTitle: string | null;
  /** "by vote" / "by an admin"; null on a merged close (the pill says it). */
  how: string | null;
  ref: IssueProposalRef | null;
}

/**
 * The change page's hero (topic-head.tsx `ChangeHero`): the words of the
 * Workshop's Needs-you item, for one change. The card's meta line carried
 * the same facts as one ellipsising row — "PR#2473 · snait · 5h ago · In
 * review" — and this splits them into the eyebrow (what the page is, the
 * pull request, where it stands), the age at the eyebrow's right and the
 * by-line (who, and when). The tags, the actions and the summary are read
 * off the card model and the body directly; nothing here is copied from
 * them.
 */
export interface HeroView {
  /** The eyebrow's first word, "Change" (B10b). */
  kind: string;
  /** "PR#2473", linking to GitHub when the change has a pull request. Rides the hero's by-line and is drawn in Details (B10b). */
  ref: { s: string; href: string | null } | null;
  /** "Waiting for approval", "Merged", "Not shared yet", "Visible to the group". */
  status: string;
  /** "5h ago", with the full stamp as its title. */
  age: { s: string; title?: string } | null;
  author: string | null;
  /** The by-line's verb — "proposed", "imported", "started". */
  verb: string;
  /** The provenance words the meta line carried: imported from GitHub, built with an agent. */
  provenance: string | null;
  /** The item's soft gradient, alternating by change so two pages read as two. */
  tint: 'a' | 'b';
}

/** A step's mark: the merge gate's own states (services/merge-requirements.js). */
export type StepState = 'done' | 'active' | 'waiting' | 'blocked' | 'pending';

/**
 * One row of the steps sheet — the card's merge-requirements strip
 * (card/dev-card.tsx `RequirementsRow`) expanded to say, under each gate,
 * what the ledger row for that gate said: the vote's tally and roster, the
 * checks' sentence, last run and failing rows, the sync's remedy.
 *
 * `key` is the row's `data-note` — the LEDGER row's key where one backs
 * the step (`votes`, `checks`, `mergeability`), so the declared checks that
 * address a fact by it still find it; `gate` is the merge gate's key, as
 * `data-req-gate`, where the step is one. A row with a gate and no ledger
 * row says the gate's own note; a ledger row with no gate — a failed
 * preview, console errors, and every row of a change still under way —
 * draws in the same shape with its tone as its mark.
 */
export interface StepRow {
  key: string;
  gate?: string | null;
  state: StepState;
  label: string;
  /** Who clears it, already worded — "the group", "an admin", "automatic". */
  actor: string | null;
  /** The gate's one-line why, drawn when no ledger row says more. */
  note?: string | null;
  /** The gate's one control — an admin's "Resume merges". */
  action?: ActionSpec | null;
  /** The ledger row's material: the sentence, the roster, the checks, the ops. */
  row?: LedgerRow | null;
  /** The vote step's bar and tally: the same counts the card's pill reads. */
  vote?: {
    yes: number; no: number; majority: number; pill: StatusPillState | null;
    /** #3234: "Needs N, was M when voting opened", or null when it has not moved. */
    was?: string | null;
  } | null;
  // ── A merge gate's step (app-view.js `_gateStepsView`) ──
  /** The step's one short line, state first (`_stepLine`); null says nothing. */
  line?: string | null;
  /** The controls for the person who can clear the step, and nobody else. */
  actions?: ActionSpec[];
  /** The Votes step: who voted (the count is the status pill's). */
  votes?: string | null;
  /** #3234 on the Votes step: "Needs N, was M when voting opened". */
  was?: string | null;
  /** The Votes step's "?" — How voting works. */
  help?: boolean;
  /** The Checks step: what it shows when it opens. */
  run?: StepRun | null;
  /** Extra hooks on the row (the superseded-base marker on Checks). */
  attrs?: Record<string, string>;
}

/**
 * What the Checks step shows when it opens (app-view.js `_checksRunView`):
 * the build as its steps, then the app's declared checks and the unit suite
 * as bars, the failures by name, and one line of context.
 */
export interface StepRun {
  /** A run is going right now. */
  live: boolean;
  /** The run's stage: building, testing, deferred (app-view.js CHECKS_PHASE_COPY). */
  phase?: string | null;
  /** Open by itself: while a run is going, and when it failed. */
  open: boolean;
  /** The build's steps, and what to say at the bar's end. */
  build: { steps: LedgerBuildStep[]; value: string } | null;
  /** The declared checks' counts; null before the first has run. */
  checks: { ran: number; passed: number; failed: number; expected: number | null; done: boolean } | null;
  unit: LedgerUnitProgress | null;
  fails: CheckRow[];
  note: string | null;
}

/** The steps sheet: the strip's own headline over its rows, expanded. */
export interface StepsView {
  headline: string;
  detail: string | null;
  done: number | null;
  total: number | null;
  rows: StepRow[];
  /** One short step per merge gate (`_gateStepsView`), rather than ledger rows. */
  simple?: boolean;
}

/** Everything under the card, by topic kind. */
/** #4453: what a request's page says about the request itself. */
export interface RequestView {
  number: number;
  /** The category's name, as plain words under "Request #N"; null when unset. */
  category: string | null;
  /** The ⋯ disc's rows, registered with AppView's card-menu registry. '' for none. */
  menuKey: string;
  asker: string;
  /** When it was asked: the formatted stamp, its unelided title and the instant. */
  askedAt: string | null;
  askedTime: string;
  askedTitle: string;
  title: string;
  /** The author's inline title editor, open (`AppView._editingIssueTitle`). */
  titleEditing: { issue: number; initial: string } | null;
  /** The request's words, rendered, without the leading "**Source:**" line. */
  bodyHtml: string;
  /**
   * The author's editor for the words. `source` is the "**Source:**" line
   * the page leaves out, put back in front of what they save.
   */
  editor: { issue: number; markdown: string; source: string | null; canEdit: boolean };
  status: RequestStatusView;
}

/** The card under the request: where it stands, and the one next step. */
export interface RequestStatusView {
  /** How far the issue row alone says it got; the stream can add Spec. */
  stage: 'asked' | 'built' | 'voted';
  /** Who is on it, as the sentence's first half ("You're working on this."). */
  lead: string;
  /** Said instead of the spec half when the row knows more ("A change is waiting for approval."). */
  note: string | null;
  /** The claim's lapse, in small words. */
  fine: string | null;
  /** The one action for this viewer, or null. */
  action: { label: string; title?: string; disabled?: boolean; act?: { fn: string; args?: unknown[] }; href?: string } | null;
  /** A closed request: the words that say so, and no stepper. */
  closed: string | null;
}

/** #4455: one part of a Votes or Testing card's bar. */
export interface ChangeBarPart {
  /** Its share of the bar's length (a yes each, or how long that part usually takes). */
  weight: number;
  /** How full it is, 0–100. */
  pct: number;
  /** `moving` is drawn in the lit ink, `done` green on a finished card, `bad` red. */
  state: 'moving' | 'done' | 'bad' | 'idle';
}

/** #4455: the Votes card or the Testing card under a change's summary. */
export interface ChangeGateView {
  name: string;
  /** The figure at the right of the name: "Needs 1 more yes", "about 6 min left". */
  figure: string;
  /** `ask` is in the accent (the viewer can give it), `done` green, `bad` red. */
  tone: 'ask' | 'muted' | 'done' | 'bad' | 'warn';
  /** Finished: full and green, with a green check. */
  done: boolean;
  segments: ChangeBarPart[];
  /** The bar's words for a screen reader. */
  label: string;
  /** The one line under the card, as its sentences. */
  note: string[];
  /** Why this status is shown, disclosed beside the note when available. */
  noteDetail?: string;
  /** Testing only: its re-run, or a retry of the preview. */
  actions?: ActionSpec[];
  /** Testing only: a "See what failed" door into Details. */
  details?: boolean;
  /**
   * Votes only, on a merge of Homeroom itself that is not live yet: the
   * server's `release` block, which the card words after the note and keeps
   * counting down ("Merged; goes live in the next release (about 8
   * minutes)", frontend/src/lib/release-eta.ts).
   */
  release?: unknown;
}

/** #4455: what a change's page says about the change itself, as the thread's root post. */
export interface ChangeThreadView {
  /** The pull request's number, for "Change #N"; null before it has one. */
  number: number | null;
  category: string | null;
  author: string;
  at: string | null;
  time: string;
  timeTitle: string;
  /** "via Claude Code": what built it, when something outside Homeroom did. */
  via: string | null;
  votes: ChangeGateView;
  testing: ChangeGateView;
  /** The Before and after card, or null when there is nothing to show. */
  shots: { state: string; html: string; line: string | null; waiting?: boolean } | null;
  /** Whether the Addresses row carries "👏 Thank <author>". */
  thanks: boolean;
}

export interface TopicBody {
  changeId?: number;
  issues?: IssueLink[];
  /** #2431 — on an ISSUE's page, the change on it (an open issue's). */
  addressedBy?: IssueProposalRef | null;
  /** #4244 — on a CLOSED issue's page, the band that says so, and by what. */
  closedBand?: IssueClosedBand | null;
  /**
   * On a CHANGE's page, the change it went live inside: an open change a
   * merged one was built on is marked merged as included in it
   * (services/included-changes.js, `AppView._includedInView`).
   */
  includedIn?: IssueProposalRef | null;
  /** Open issues already loaded for this app; the picker filters them locally. */
  issueOptions?: IssueLink[];
  /** The proposal owner/full platform admin may change issue associations. */
  canEditIssues?: boolean;
  testing?: { html: string | null; path: string | null };
  workspace?: number | null;
  discussion?: string | null;
  /**
   * The Build door: the pill on the card ("Continue building", "Open
   * build", "Read the build"). It NAVIGATES (#2605), to the change's own
   * dev session page — the owner's live workspace, or, for a reader, the
   * read-only chat its owner published. There is no sheet on this page any
   * more. Null for a private change somebody else is reading, and for an
   * imported one, which has no session behind it.
   */
  build?: { kind: 'owner' | 'published'; label: string } | null;
  /**
   * The before & after shots, as "What changes for you" reads it: the claims as
   * bullets and the run's state as one strip. A verified run keeps the
   * before/after card in `actions.visuals` instead, which leads with the
   * claims itself.
   */
  shots?: {
    state: string;
    verified: boolean;
    /**
     * #2601/#2558: a 'planned' run whose timestamp has gone past the idle
     * threshold — minted at submission and never picked up. It does not
     * spin, and it keeps the panel so its reason and retry control show.
     */
    notStarted: boolean;
    /**
     * A restart interrupted the run and the recovery sweep starts it again
     * by itself (`automaticRetryPending` in the shots view): shown as under
     * way, not as a failure.
     */
    retrying?: boolean;
    label: string;
    sentence: string;
    claims: string[];
  } | null;
  /**
   * The detail actions. The PILLS are merged onto the card's own action band
   * by `_renderTopicHead` (one action line, as on the board); the head draws
   * only `visuals` from here, as the About sheet's before/after row. `reasons`
   * stays for the builders that read it — the ledger is what says it now.
   */
  actions: {
    pills: ActionSpec[];
    reasons: { heading: string; items: { key: string; label: string; detail: string; soft: boolean }[] } | null;
    visuals: { sessionId: number; open: boolean; tilesHtml: string } | null;
  } | null;
  /** The About sheet's heading — "About this change", "About this issue". */
  aboutTitle?: string | null;
  /** An issue's markdown body, already rendered and sanitised. */
  issueBodyHtml?: string | null;
  /** #2427 — raw Markdown and author-only edit permission for the issue body. */
  issueBodyEditor?: {
    issue: number;
    markdown: string;
    canEdit: boolean;
  } | null;
  /**
   * #4453: a request's page, drawn as a Messages reply thread
   * (./request-head.tsx). Set on an issue's page only; its GitHub comments
   * are in the thread's stream now (`AppView._requestThreadRows`).
   */
  request?: RequestView | null;
  /** #4455: a change's page, drawn as a Messages reply thread (./change-head.tsx). */
  thread?: ChangeThreadView | null;
  /** A proposal's plain-language summary, already rendered. */
  summaryHtml?: string | null;
  /**
   * #4490: the diagram its author sent (services/diagram.js), which leads
   * the change's page. Untyped here; lib/diagram reads it defensively.
   */
  diagram?: unknown;
  /**
   * #4479: the plan a change was built from, as the card a request's page
   * hangs under the request (`AppView._changePlanCard`), or null.
   */
  plan?: RequestSpecCard | null;
  /** The previous summary was retained for provenance but no longer describes this revision. */
  summaryStale?: boolean;
  /**
   * The rest of the summary, folded under `summaryHtml` as "How it’s built":
   * on a change Homeroom bot built, everything from its spec's Design
   * heading on (`AppView._summaryParts`). Null when the summary is shown
   * whole. The open flag lives in app-view.js (`_summaryMoreOpen`), as
   * `proposalBody`'s does, so a repaint does not shut it.
   */
  summaryMore?: { id: number | null; open: boolean; html: string } | null;
  /**
   * #1370's "Full proposal details" disclosure — the complete GitHub PR
   * description, deliberately quieter than the generated summary above it.
   *
   * The open flag lives in app-view.js (`_proposalBodyOpen`), not in
   * component state: the head repaints on every checks poll and WS event,
   * and the same rule the before/after visuals and the transcript section
   * follow keeps the disclosure from collapsing under the reader.
   */
  proposalBody?: { id: number | null; open: boolean; html: string } | null;
  details?: ProposalDetails | null;
  /** A change page's hero, and its steps (drawn in Details, B10b). Set with `changeId`. */
  hero?: HeroView | null;
  steps?: StepsView | null;
  /** The one-line explainer under a session or governance card. */
  note?: string | null;
  /**
   * #2603: a GOVERNANCE proposal's vote roster — who voted which way and the
   * line each vote carries, the same `RosterView` a change's Review row
   * renders. A change's roster rides on `details.ledger` instead; a
   * governance topic has no ledger, so it hangs here.
   */
  roster?: RosterView | null;
  transcript?: TranscriptSection | null;
}
