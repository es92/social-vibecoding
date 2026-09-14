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

import type { ActionSpec } from '../card/model';


/** The four tints a note box comes in. Resolved to classes by the component. */
export type NoteTone = 'neutral' | 'ok' | 'warn' | 'error';

/**
 * A run of prose, with the emphasised spans called out.
 *
 * Several of these sentences name a person or a tool mid-sentence in
 * `font-medium` — "…imported by **maya**…", "Built with **Claude Code** by
 * **maya**…" — and a plain string could not carry that. `{ b }` is the
 * emphasised run; a bare string is ordinary text.
 */
export type TextRun = string | { b: string };

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
  errors?: { kind: string; message: string; source?: string | null }[];
}

export interface ChecksVerdict {
  failing: boolean;
  heading: string;
  summary: string;
  failures: CheckRow[];
  passes: CheckRow[];
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
 * amber provenance notes. `key` is the row's `data-note`, which is what the
 * declared checks address a row by (`mergeability`, `checks`, `env`, …).
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
   * The small line under the label. Two jobs: a count ("1 of 463 failing"),
   * or, on a numbered step, who acts and when — "snait, now",
   * "automatic, after 1".
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
  /** The votes row's roster. */
  roster?: RosterView | null;
  /** The checks row's live progress while the run is pending. */
  progress?: LedgerProgress | null;
  actions?: ActionSpec[];
  /** Extra attributes on the row — `data-checks-base="superseded"` for one check. */
  attrs?: Record<string, string>;
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
  yes?: { label: string; names: string };
  no?: { label: string; names: string };
  needs?: string;
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

/** Everything under the card, by topic kind. */
export interface TopicBody {
  changeId?: number;
  issues?: IssueLink[];
  /** Open issues already loaded for this app; the picker filters them locally. */
  issueOptions?: IssueLink[];
  /** The proposal owner/full platform admin may change issue associations. */
  canEditIssues?: boolean;
  testing?: { html: string | null; path: string | null };
  activity?: { label: string; at: string }[];
  workspace?: number | null;
  discussion?: string | null;
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
  /** Render the `#dev-issue-comments` host (features/dev-board/issue-comments.tsx). */
  comments?: boolean;
  /** A proposal's plain-language summary, already rendered. */
  summaryHtml?: string | null;
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
  /** The one-line explainer under a session or governance card. */
  note?: string | null;
  transcript?: TranscriptSection | null;
}
