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
   * 'early_burst' when this check's failure was one of a burst in the run's
   * first seconds whose retries all passed (src/services/check-signals.js):
   * often the environment, never proof of it. Null otherwise.
   */
  retryClass?: 'early_burst' | null;
  /**
   * An advisory about the check itself, shown in its fold: today, that a
   * check this proposal adds or changes needed a fresh load after its
   * address change. Never a verdict.
   */
  note?: string | null;
  errors?: { kind: string; message: string; source?: string | null }[];
  /**
   * The repo unit suite only (#3978): per failing test, its file, its name
   * and a bounded, redacted excerpt of the error the runner printed, with
   * the line it failed on and its error message read off that excerpt
   * (app-view.js `_excerptFacts`). Empty on every other row; a declared
   * check's reason is its diagnosis.
   */
  details?: { file?: string | null; test: string; excerpt: string; line?: number | null; said?: string | null }[];
  /** This row is the app's own test suite (`npm test`), drawn by what it is. */
  unit?: boolean;
  /** The suite's tally from its reason: how many tests failed, of how many. */
  unitTally?: { failed: number; total: number | null } | null;
}

export interface ChecksVerdict {
  failing: boolean;
  heading: string;
  summary: string;
  failures: CheckRow[];
  passes: CheckRow[];
  /** The passes with something to say, for the Checks step (see StepRun.noted). */
  noted?: CheckRow[];
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
  /**
   * Set when this run did not run the suite but reused an earlier pass of the
   * same commit (services/unit-suite-reuse.js): how long ago that pass was,
   * the start of its run id, the whole id and its time.
   */
  reused?: { when: string; run: string; runId: string | null; at: string | null };
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
  /** #6552: the change this row explains, so its "?" reads that change's votes. */
  changeId?: number | null;
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
  /** Which way it was closed; null on a merged close (the pill says it). */
  how: 'vote' | 'admin' | null;
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
  /** "PR#2473" and the change's `pr_url` (its pull request on GitHub, or its own page in Homeroom). Drawn in Details (B10b), which links out only where the address leaves Homeroom. */
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
  /** The Checks step, failed, for the change's author: Fix it, before the re-run. */
  fix?: FixChecksView | null;
  /** Extra hooks on the row (the superseded-base marker on Checks). */
  attrs?: Record<string, string>;
  /** Done because an admin's force merge skips it, not because it was cleared. */
  skipped?: boolean;
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
  /** Passing checks with something to say: a retry and its class, or a note. */
  noted?: CheckRow[];
  note: string | null;
  /** A failed run: what went wrong, in plain words, over the failures. */
  explain?: ChecksExplainView | null;
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
  /**
   * #6552: the change these steps belong to, riding on the "?" hints as
   * `data-voting-help-change`. On a request's page the page item is the
   * request, so the help popover must read this change's row instead.
   */
  changeId?: number | null;
}

/** Everything under the card, by topic kind. */
/** #4453: what a request's page says about the request itself. */
/**
 * #5999: the request a close proposal closes, as its page opens: who asked
 * and when, the title (a link to the request's own page) and the words.
 * `AppView._closesRequestView` builds it from the same single-request fetch
 * the request's own page uses.
 */
export interface ClosesRequestView {
  number: number;
  /** The small heading over it, "The request". */
  label: string;
  title: string;
  asker: string;
  /** When it was asked: the formatted stamp, its unelided title and the instant. */
  askedAt: string | null;
  askedTime: string;
  askedTitle: string;
  /** The words, already rendered and sanitised; '' when there are none. */
  bodyHtml: string;
  /** The request on its own page. */
  href: string;
}

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
  /** #6081: the same words as markdown, what Translate sends to the model. */
  bodyMarkdown: string;
  /**
   * The author's editor for the words. `source` is the "**Source:**" line
   * the page leaves out, put back in front of what they save.
   */
  editor: { issue: number; markdown: string; source: string | null; canEdit: boolean };
  status: RequestStatusView;
  /** #5987: the app's slug, which the "Open in Claude Code" link names. */
  slug?: string;
  /**
   * 16 Oct 2026: where Homeroom bot's work on it is, as the server words it
   * (services/homeroom-bot-track.js), read field by field by
   * ../../messages/api.ts normalizeBotTrack. Null when the bot has none.
   */
  track?: unknown;
  /** The page is drawn from the board's older row: the track card keeps its
      place, hidden, until the board's reload lands (polish board #12). */
  trackPending?: boolean;
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
  /**
   * #6387: the row says a change addresses this request, so the page holds
   * the change section's place while the thread is still being read.
   */
  changeExpected?: boolean;
  /**
   * The sentence already says what Homeroom bot is doing with its plan (or
   * its change), so no "Plan v1 is ready for comments." after it.
   */
  botSays?: boolean;
  /**
   * #5987: starting work on it is still open to this viewer, so the page
   * offers "Build it with your own Claude Code" under the card.
   */
  ownAgent?: boolean;
  /**
   * 1 Nov 2026: the one action is "Work on this with Homeroom bot", so the
   * page's ⋯ offers "Build it in an agent session" (what Build it now was).
   */
  agentSession?: boolean;
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

/**
 * A failed run's checks in plain words (./failed-checks.ts): the run to ask
 * GET /api/sessions/:id/checks-explanation about, and the failure's own
 * words to show until it answers and when it has nothing
 * (app-view.js `_checksExplainView`).
 */
export interface ChecksExplainView {
  /** The change's id. */
  id: number;
  /** The run: its checks_checked_at. */
  at: string;
  fallback: string | null;
  /**
   * #6288: the Testing card's lead when main is already failing these tests,
   * so the Checks step says whose they are too (it is drawn above the
   * failure's own words). Null when main is not failing them.
   */
  mainLead?: string | null;
  /** The page the first failing check opened on the preview, when it can be reopened. */
  page?: { path: string; stagingUrl: string } | null;
}

/**
 * Fix it from the change's page (./failed-checks.ts): what the dev chat's
 * own Fix it card would send (../../agent-session/fix-checks.ts), and the
 * build conversation it goes to. Only for the change's author, on a change
 * built in an agent session that is still open to more work
 * (app-view.js `_fixChecksView`).
 */
export interface FixChecksView {
  agentSessionId: number;
  changeId: number;
  prNumber: number | null;
  /** How many blocking checks failed in all. */
  total: number;
  /** The first few, each with what it reported. */
  checks: Array<{ name: string; reason: string }>;
  /** The run: its checks_checked_at. A new run is a new Fix it. */
  at: string;
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
  /**
   * #6282: the card asks for no vote while an update to the change is on its
   * way (AppView._changeVotesView): a yes cast now is cleared when it lands.
   * Votes only; the card keeps its tally and its note.
   */
  hold?: boolean;
  /**
   * #3800: Votes only, while a change is up for a vote: its lines under the
   * bar, worded (AppView._changeVoteFacts). `ask` is the viewer's vote still
   * being wanted, in the accent.
   */
  facts?: { key: 'tally' | 'ends' | 'mine'; text: string; ask?: boolean }[];
  /** Why this status is shown, disclosed beside the note when available. */
  noteDetail?: string;
  /** Testing only: its re-run, or a retry of the preview. */
  actions?: ActionSpec[];
  /** Testing only: a "See what failed" door into Details. */
  details?: boolean;
  /** Testing only, when its checks failed: what went wrong, in plain words. */
  explain?: ChecksExplainView | null;
  /**
   * #6288: while main is already failing this change's tests, the request
   * main watch filed to fix main. The one thing to read instead of asking
   * the change's author to fix a failure that is not theirs.
   */
  mainFailure?: { href: string; label: string; mixed: boolean } | null;
  /** Testing only, for the change's author: Fix it. */
  fix?: FixChecksView | null;
  /** Testing only, for everybody else: who has to fix it. */
  authorNote?: string | null;
  /**
   * #6234: Testing only, on a change Homeroom bot built whose checks failed:
   * where its own fix of them stands (services/homeroom-bot-progress.js
   * changeBotFix), carried on the card as `data-change-bot-fix`. The words
   * are in `authorNote`.
   */
  botFix?: 'fixing' | 'queued' | 'platform' | 'handed_off' | 'stopped' | null;
  /**
   * Votes only, on a merge of Homeroom itself that is not live yet: the
   * server's `release` block, which the card words after the note and keeps
   * counting down ("Merged; goes live in the next release (about 8
   * minutes)", frontend/src/lib/release-eta.ts).
   */
  release?: unknown;
}

/**
 * #6563: the merge step under Votes and Tested, while GitHub holds the merge
 * or it is under way. `wait` carries the times the card counts in the
 * viewer's own clock: when Homeroom last tried, when it tries next, and when
 * it first met this hold on this head (AppView._changeMergeView).
 */
export type ChangeMergeView = ChangeGateView & {
  wait?: { triedAt: string | null; retryAt: string | null; since: string | null } | null;
  /**
   * #6593: which hold this card is about, so the card knows whether the
   * tries are news. `github_checks` is GitHub still building and scanning
   * the release images: Homeroom's own tries say nothing a reader needs, so
   * the card leaves them out. `github_wait` (busy or refused) keeps them.
   */
  hold?: 'github_checks' | 'github_wait' | 'failing' | 'merging';
};

/** #4455: what a change's page says about the change itself, as the thread's root post. */
export interface ChangeThreadView {
  /** The pull request's number, for "Change #N"; null before it has one. */
  number: number | null;
  /**
   * The status pill the board card shows, beside "Change #N": "✓ Live",
   * "Going live…", or the vote's own words. Null while the change is being
   * built or closed (AppView._changeThreadView).
   */
  status: StatusPillState | null;
  category: string | null;
  author: string;
  at: string | null;
  time: string;
  timeTitle: string;
  /** "via Claude Code": what built it, when something outside Homeroom did. */
  via: string | null;
  votes: ChangeGateView;
  testing: ChangeGateView;
  /**
   * #6563: the merge step, under Votes and Tested, while GitHub holds the
   * merge or it is under way. Null once merged or when nothing holds it.
   */
  merge?: ChangeMergeView | null;
  /** The Before and after card, or null when there is nothing to show. */
  shots: {
    state: string; html: string; line: string | null; waiting?: boolean;
    /**
     * 1 Nov 2026 (one page per thread): a verified run's first screen,
     * before and after, for the small pair a change shows on its request's
     * page, and the id of the viewer (`html`) its Expand opens.
     */
    thumbs?: { before: string | null; after: string | null; viewer: string } | null;
  } | null;
  /** Whether the Addresses row carries "👏 Thank <author>". */
  thanks: boolean;
  /**
   * Its code did not come across when Homeroom moved off GitHub: its branch
   * is not on the git host (src/services/code-missing.js, the row's
   * `code_missing`). The page says so above Votes and Testing.
   */
  codeMissing?: boolean;
  /**
   * An import stacked on another open change's branch
   * (src/workflow/rules/pr-base.ts, `AppView._stackedView`): the change it
   * waits for, said above Votes and Testing with a door to its page.
   */
  waitsFor?: { sessionId: number; number: number | null; title: string | null; href: string };
  /**
   * An import whose pull request targets a branch that is neither main nor
   * an open change's: that branch, and the notice says what a person does.
   */
  baseNotMain?: { branch: string };
  /**
   * VERSIONS (docs/plans/versions.md): on an update, the change a version
   * was given by the project it was made from, what it brings from there and
   * what it does here (the proposal read's `upstream`, passed through by
   * AppView._changeThreadView). change-head.tsx draws its From <original>
   * card and Skip this update from it. Null or absent on every other change.
   */
  upstream?: ChangeUpstreamView | null;
}

/** An update's `upstream`, as the proposal read gives it; any field may be missing. */
export interface ChangeUpstreamView {
  from?: { slug: string; name?: string | null; emoji?: string | null } | null;
  brings?: Array<{ title: string }> | null;
  facts?: {
    tablesAdded?: string[];
    destructive?: string[];
    hostsAdded?: string[];
    secretsAdded?: string[];
    ai?: boolean;
    storage?: boolean;
  } | null;
  keeps?: { count: number; titles?: string[] } | null;
  /** The update's state: `open` while it is up, `needs_fit` when it clashes. */
  state?: string | null;
  conflicts?: string[] | null;
}

export interface TopicBody {
  changeId?: number;
  /**
   * #6440: a governance vote's page — the model its head draws
   * (./governance-model.ts). The page has no card: the head IS the page.
   */
  decision?: any;
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
    /**
     * The change this viewer may start the failed run again on, or null.
     * `_canRetakeShots` decides: its author or a project admin, on a failed
     * run with no automatic retry coming.
     */
    retake?: number | null;
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
  /**
   * #5999: on a proposal to CLOSE a request, the request itself — its title,
   * who asked and its words — drawn first in the About sheet, above the
   * reason for closing. Null until the row has loaded, and for every other
   * governance kind.
   */
  closesRequest?: ClosesRequestView | null;
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
  /**
   * A change page with no summary and no plan folds `proposalBody` under
   * the summary line as "Description", where the line says it is.
   */
  descriptionFold?: boolean;
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
