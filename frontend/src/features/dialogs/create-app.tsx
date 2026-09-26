/**
 * Create-project dialog (#create-modal).
 *
 * ── Four questions, in the order a person answers them (stage 3) ──────
 *
 * Communities, stage 3: the dialog asks who a project is FOR before anything
 * else, because that answer decides the rest.
 *
 *   who      Just me (preselected), A group, or A community — the audiences
 *            services/communities.js derives (`solo`, `invited`, `open`), in
 *            the words the Workshop tab heads its sections with. A group
 *            names its people here, in #create-invitees, and they are invited
 *            when it is created. A community is open to see and to build;
 *            "public to use, invite-only building" is not asked for, and stays
 *            in the project's settings for later.
 *   start    what you are making (an App; Document and Video say "Soon"),
 *            then how to begin: from scratch, or from a GitHub repo.
 *   details  the name, and for an import the repo URL and its check first.
 *   approve  who approves changes: members vote, or people you pick (starting
 *            with you), with "at least N yes votes" as a follow-up under the
 *            second. Asked only of a group or a community, and not of an
 *            import, whose own dapp.json decides.
 *
 * `POST /api/apps` takes `audience`, `invitees` and `governance`
 * (services/create-options.js); the rule is written to the new repository's
 * dapp.json, so it is votable later like any other line of it.
 *
 * `data-mode` controls "new" vs "import"; `data-import-state` the import
 * sub-states (idle / checking / ok / error); `data-audience`, `data-step`,
 * `data-approvers` and `data-approvals` the rest. CSS in app.css keys off
 * all of them to show and hide sections, so this component only flips
 * attributes and never juggles per-element classes.
 *
 * Markup extracted verbatim from Shell.tsx by #1078 chunk A; #1078 chunk I
 * moved the behaviour in and made it stateful. #1910 restyled it in the
 * pane language (the recipe is spelled out above the class constants
 * below). The INITIAL render still carries every id, every `hidden` and
 * every data-* attribute the shell shipped — `public/js/**` looks those up
 * and the declared dapp.json checks select on them — and
 * tests/baselines/shell-markup.json is the proof; only the class strings
 * are new.
 *
 * ── The second view, and why it costs the baseline nothing ────────────
 *
 * `POST /api/apps` returns 201 with the row still in `'creating'`; the build
 * runs async server-side. This dialog no longer closes on that 201 — it
 * swaps its card to ./create-progress.tsx and reports the four phases
 * `services/app-creator.js` broadcasts, resolving into live /
 * awaiting-secrets / failed.
 *
 * That second view is gated on `created`, which starts null. The prerender
 * pass has no user to submit the form, so it renders the form and nothing
 * else — the progress subtree contributes no ids to public/index.html and
 * therefore nothing to the shell-markup baseline, the id inventory, or the
 * 338 declared dapp.json selectors. A separate tenth shell dialog would have
 * needed an entry in all three; this needs none, which is the whole reason
 * the progress view lives inside this card rather than beside it.
 *
 * ── What moved, and from where ────────────────────────────────────────
 *
 * `App.showCreateModal`, `.hideCreateModal`, `._createVis`,
 * `.setCreateVisibility`, `.setCreateMode`, `._setImportState`,
 * `.handleImportCheck` and `.handleCreateApp` were public/js/app.js:3775-3985;
 * the cancel, backdrop, submit, mode-pill, visibility-pill, Check-button and
 * import-url listeners were its `bindEvents`. Seven functions that read each
 * other's state out of the document are four `useState` calls here.
 *
 * `App.showCreateModal()` survives in app.js as a one-line forward: the home
 * screen's empty-state and "+" buttons (frontend/src/features/home/home.js)
 * and the deep-link handler both call it by name.
 *
 * ── The first render is the prerendered one ──────────────────────────
 *
 * Every choice starts at a constant — Just me, from scratch, idle, the first
 * step, members vote, majority — and renders that, so the first client render
 * matches public/index.html exactly (a mismatch `console.error`s, which fails
 * proposal checks). What a choice changes is written as data attributes on
 * the card and the root, which app.css reads; `.active`-style classes are not
 * rendered from state at all.
 *
 * The three text inputs stay UNCONTROLLED (refs, not `value`) for the
 * matching reason: a controlled input renders a `value` attribute in the
 * prerender pass.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import {
  ChevronRightIcon, LockIcon, SpinnerArcIcon, UserGroupIcon, UserIcon,
} from '@/components/ui/icons';
import { Input } from '@/components/ui/input';

import { useHiddenClass, useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { AppAllowance, useAppAllowance } from './app-allowance';
import { invalidateAppAllowance } from './app-allowance-store.js';
import { CreateProgress } from './create-progress';
import {
  creationProgressStore,
  fetchCreationProgress,
  outcomeOf,
  publishAppStatus,
  stopWatchingCreation,
  watchCreation,
} from './creation-progress-store.js';
import { normalizeRepositoryUrl } from './repository-url';
import { useDialog } from './use-dialog';

type Mode = 'new' | 'import';
type ImportState = 'idle' | 'checking' | 'ok' | 'error';
/** Who it is for: services/communities.js's audiences, by their internal names. */
type Audience = 'solo' | 'invited' | 'open';
type Approvers = 'anyone' | 'invited';
type Approvals = 'majority' | 'atLeast';
/**
 * The steps UNFOLD in one card (#1911), rather than one page of every
 * choice. `step` is the FURTHEST step reached; everything up to it is
 * showing. Every section stays in the document on every step (the declared
 * checks and public/js select on the same ids); app.css folds and unfolds
 * them off `#create-card[data-step]`.
 *
 *   who      Just me / A group / A community; a group's invitees
 *   start    what you are making, and how to begin
 *   details  the name (and, for an import, the repo and its check)
 *   approve  who approves changes, for a group or a community made new
 */
type Step = 'who' | 'start' | 'details' | 'approve';

/**
 * The steps a given pair of answers walks. Just me has nobody else to
 * approve anything, and an import's own dapp.json decides who approves, so
 * both end on the details step. Exported and pure: the indicator's "of N"
 * and the footer's Next-or-Create both read it.
 */
export function stepsFor(audience: Audience, mode: Mode): readonly Step[] {
  return audience !== 'solo' && mode === 'new'
    ? ['who', 'start', 'details', 'approve']
    : ['who', 'start', 'details'];
}

/**
 * The `POST /api/apps` body for a set of answers. Exported and pure so the
 * wire shape is pinned without a browser (tests/create-app-steps.test.js).
 * `invitees` is the raw text of #create-invitees: usernames separated by
 * commas or spaces, with or without an @.
 */
export function createBody(answers: {
  name: string;
  /** "What is it?": one optional line, for a project made new. */
  description?: string;
  mode: Mode;
  repoUrl?: string;
  audience: Audience;
  invitees?: string;
  approvers: Approvers | null;
  approvals: Approvals | null;
  approvalsN?: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { name: answers.name, audience: answers.audience };
  if (answers.mode === 'import' && answers.repoUrl) body.repoUrl = answers.repoUrl;
  // An import's own dapp.json describes it, so only a new project sends one.
  const description = (answers.description || '').replace(/\s+/g, ' ').trim();
  if (answers.mode === 'new' && description) body.description = description;
  if (answers.audience === 'invited') {
    const people = (answers.invitees || '')
      .split(/[\s,]+/)
      .map((u) => u.trim().replace(/^@/, ''))
      .filter(Boolean);
    if (people.length) body.invitees = people;
  }
  if (answers.audience !== 'solo' && answers.mode === 'new' && answers.approvers === 'invited') {
    const n = Math.round(Number(answers.approvalsN));
    body.governance = {
      approvers: 'invited',
      approvals: answers.approvals === 'atLeast' && n >= 1 && n <= 50 ? { atLeast: n } : 'default',
    };
  }
  return body;
}

/** The inline row under the repo URL: spinner, green tick, or red error. */
interface ImportStatus {
  tone: 'none' | 'ok' | 'err';
  text: string;
  spinner?: boolean;
}

const IDLE_STATUS: ImportStatus = { tone: 'none', text: '' };

/**
 * The state a `?shot=` link opens on, so a URL can reach each step for the
 * declared checks and for screenshots. Display only, read once on open, and
 * never on the prerender pass (no `location` there).
 *
 *   create-import   the details step, importing
 *   create-details  the details step, from scratch
 *   create-group    A group chosen, its invite field showing
 *   create-approve  A community, on the approval step
 *
 * `create-access`, the old last step's link, lands on `create-approve`.
 */
function shotState(): { mode: Mode; step: Step; audience: Audience } {
  const open = { mode: 'new' as Mode, step: 'who' as Step, audience: 'solo' as Audience };
  try {
    const shot = new URLSearchParams(location.search).get('shot');
    if (shot === 'create-import') return { ...open, mode: 'import', step: 'details' };
    if (shot === 'create-details') return { ...open, step: 'details' };
    if (shot === 'create-group') return { ...open, step: 'start', audience: 'invited' };
    if (shot === 'create-approve' || shot === 'create-access') return { ...open, step: 'approve', audience: 'open' };
    return open;
  } catch {
    return open;
  }
}

/**
 * How often the progress view re-asks the server while a creation is
 * still pending. The WS broadcasts do the real work; this only has to be
 * often enough that a dropped socket is noticed, and rare enough that a
 * dialog left open costs the API almost nothing.
 */
const POLL_INTERVAL_MS = 4000;

function statusClass(status: ImportStatus): string {
  if (status.tone === 'ok') return 'px-1 text-sm mt-2 import-status--ok';
  if (status.tone === 'err') return 'px-1 text-sm mt-2 import-status--err';
  return 'px-1 text-sm mt-2';
}

/*
 * ── The pane recipe (#1910) ───────────────────────────────────────────
 *
 * The dialog is drawn in the widget language the shell's panes wear: a grey
 * pane ground, white cards floating on it with no border, and one
 * high-contrast state for "selected" — the accent, the fill the dialog's own
 * Create button wears (#2566). The selection colours live in app.css, keyed
 * off the card's data attributes.
 *
 *   PANE     the card's own ground (`--dc-strip`); inside the kit's modal
 *            shell the same ground comes from the shell instead.
 *   CARD/ROW the auth screens' field card: rounded-2xl, white, one row.
 *   FIELD    the borderless input that sits in such a row.
 *   RAIL/SEGMENT  a segmented control: a raised white track and
 *            full-width segments.
 *   PILL_SECONDARY  the white pill for a secondary action; the primary is
 *            <Button variant="pillAccent">.
 */
const PANE = 'bg-[color:var(--dc-strip)] dark:bg-[color:var(--dc-strip)] rounded-3xl';
const CARD = 'rounded-2xl bg-white dark:bg-zinc-800 overflow-hidden';
const ROW = 'px-4 pt-3 pb-2';
const LABEL = 'block text-[13px] text-zinc-500 dark:text-zinc-400';
const CAPTION = 'px-1 text-xs text-zinc-500 dark:text-zinc-400';
const FIELD = { box: 'card', hint: 'dim', ring: 'bare' } as const;
const RAIL = 'flex items-center gap-0.5 rounded-full bg-white dark:bg-zinc-800 p-0.5 text-sm font-semibold';
const SEGMENT = 'flex-1 min-h-8 rounded-full px-3 py-1 leading-tight transition-colors';
const PILL_SECONDARY = 'flex-1 h-11 rounded-full bg-white text-[15px] font-semibold text-zinc-900 shadow-sm '
  + 'hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 transition-colors';
/*
 * A choice row: one white card each, full width, a title and a one-line
 * caption, and a chevron at the trailing edge. The selection colours stay in
 * app.css, keyed off the card's data attribute for that question.
 */
const CHOICE_BASE = 'w-full text-left ' + CARD + ' px-4 py-3 flex items-center gap-3 transition-colors';
const CHOICE = 'create-mode-pill ' + CHOICE_BASE;
const WHO_CHOICE = 'create-who-pill ' + CHOICE_BASE;
const APPROVER_CHOICE = 'create-approver-pill ' + CHOICE_BASE;
const CHOICE_TITLE = 'block text-[15px] font-semibold';
const CHOICE_CAPTION = 'create-choice-caption block text-xs mt-0.5';
// Shown in place of the chevron once the step has collapsed to the chosen
// row: pressing the row then reopens the choice.
const CHOICE_CHANGE = 'create-choice-change text-xs font-medium shrink-0';
/* The small numbered heading each unfolded step opens with. */
const STEP_HEADING = 'text-[13px] font-semibold text-zinc-700 dark:text-zinc-300 mb-2';
/* The "What are you making?" chips: App, then the two that are coming. */
const KIND = 'create-kind-pill inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold';

/** The three audiences, in the order and the words the screen uses. */
const WHO: ReadonlyArray<{ key: Audience; title: string; caption: string }> = [
  { key: 'solo', title: 'Just me', caption: 'Only you can see it. Invite people or open it up later, from its page.' },
  { key: 'invited', title: 'A group', caption: 'Private to you and the people you invite.' },
  { key: 'open', title: 'A community', caption: 'Anyone can find it, join and build.' },
];

function WhoGlyph({ audience }: { audience: Audience }) {
  const cls = 'w-5 h-5 shrink-0 opacity-80';
  if (audience === 'solo') return <UserIcon className={cls} aria-hidden="true" />;
  if (audience === 'invited') return <LockIcon className={cls} aria-hidden="true" />;
  return <UserGroupIcon className={cls} aria-hidden="true" />;
}

export function CreateAppDialog() {
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const describeRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const inviteesRef = useRef<HTMLInputElement>(null);
  const approvalsNRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const lastStepRef = useRef<HTMLDivElement>(null);

  const [audience, setAudience] = useState<Audience>('solo');
  const [mode, setMode] = useState<Mode>('new');
  const [step, setStep] = useState<Step>('who');
  // Unanswered until pressed, like the first two steps (request #3160 and
  // its follow-up): nothing in this dialog is chosen for the person. Create
  // waits for an answer on the approval step (`approvalMissing` below).
  const [approvers, setApprovers] = useState<Approvers | null>(null);
  const [approvals, setApprovals] = useState<Approvals | null>(null);
  const [importState, setImportState] = useState<ImportState>('idle');
  const [status, setStatus] = useState<ImportStatus>(IDLE_STATUS);
  const [error, setError] = useState('');
  // QA 2026-09-24 Q5: a double-click on Create sent two POSTs and made two
  // apps, each taking a slot. `submitting` drives the button's disabled and
  // busy look; the ref is the handler's own guard, because a second click can
  // be dispatched before React has re-rendered the button as disabled (and
  // Enter in the name field never goes through the button at all).
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const { blocked: quotaBlocksCreation } = useAppAllowance();
  // The app this dialog is now reporting on. Null until a POST succeeds,
  // which is what keeps the FIRST render byte-identical to the
  // prerendered shell — the progress subtree exists only after a user
  // action, so it never reaches public/index.html.
  const [created, setCreated] = useState<{ slug: string; name: string } | null>(null);
  const progress = useStoreState(creationProgressStore);

  const steps = stepsFor(audience, mode);
  const last = steps[steps.length - 1];
  const isLast = step === last;
  // The approval step is answered once "Members vote" is pressed, or "People
  // I pick" and then how many of them must say yes. Until then Create is
  // dimmed. Only ever true ON that step, so the prerendered button (step
  // "who") is exactly what it was.
  const approvalMissing = step === 'approve' && isLast
    && (approvers == null || (approvers === 'invited' && approvals == null));

  const dialog = useDialog('create', {
    onOpen: () => {
      // A real open starts on the first step; the shot links land on the
      // state they name. Focus follows: nothing on the first step wants the
      // keyboard, the details step's first field does.
      const initial = shotState();
      applyMode(initial.mode);
      setAudience(initial.audience);
      setStep(initial.step);
      void invalidateAppAllowance();
      if (initial.step === 'details') setTimeout(() => focusDetails(initial.mode), 0);
    },
    // Reset the form, clear the error, and put every answer back to its
    // default so the next open never inherits the last one's half-finished
    // import or group.
    onClose: () => {
      formRef.current?.reset();
      setError('');
      applyMode('new');
      setAudience('solo');
      setStep('who');
      setApprovers(null);
      setApprovals(null);
      // Drop the progress view too, so the next open lands on the form.
      // The build carries on server-side either way — closing this is
      // dismissing a report, not cancelling anything.
      setCreated(null);
      stopWatchingCreation();
    },
  });

  useHiddenClass(errorRef, !error);
  // The name field is required only in "new" mode. In "import" the
  // server-side pre-flight gates submission — the field is not even visible
  // until the check passes.
  useIsomorphicLayoutEffect(() => {
    if (nameRef.current) nameRef.current.required = mode === 'new';
  }, [mode]);

  // Progress arrives on the WS `app_status` channel, which public/js/app.js
  // forwards into the store. That is the fast path and it is not the only
  // one it can be: a socket that drops right before the terminal event
  // would leave a step spinning forever. So while the outcome is still
  // pending, also ASK — GET /api/apps/:slug serves the same phase from the
  // server-side store, plus the status, so one poll recovers everything a
  // missed broadcast would have carried.
  const creatingSlug = created && outcomeOf(progress.status) === 'pending' ? created.slug : null;
  useEffect(() => {
    if (!creatingSlug) return undefined;
    let stopped = false;
    const poll = () => {
      if (stopped) return;
      void fetchCreationProgress(creatingSlug, (url) => fetch(url));
    };
    // Immediately, not only on the interval: the first phase broadcast
    // may already have been sent before this dialog started listening,
    // and four seconds of four idle steps reads as nothing happening.
    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [creatingSlug]);

  /** The field the details step opens on, for the mode it is in. */
  function focusDetails(forMode: Mode) {
    (forMode === 'import' ? urlRef.current : nameRef.current)?.focus();
  }

  /** Bring the step that just unfolded into view, with the footer under it. */
  function reveal() {
    setTimeout(() => lastStepRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0);
  }

  /**
   * The first question. A choice collapses the step to the chosen row and
   * unfolds the next; once collapsed, pressing that row reopens the choice
   * (what was typed below stays for when the later steps unfold again).
   * A group's invite field shows under the collapsed row.
   */
  function chooseAudience(next: Audience) {
    if (step !== 'who') {
      setError('');
      setStep('who');
      return;
    }
    setAudience(next);
    setError('');
    setStep('start');
    if (next === 'invited') setTimeout(() => inviteesRef.current?.focus(), 0);
  }

  /**
   * The start step's choice — set the mode and unfold the details. Once the
   * step has collapsed to the chosen row, pressing that row folds the later
   * steps back up so the choice can be changed.
   */
  function choose(next: Mode) {
    if (step !== 'start') {
      setError('');
      setStep('start');
      return;
    }
    applyMode(next);
    setStep('details');
    setTimeout(() => focusDetails(next), 0);
  }

  /**
   * Continue with the selected answer, or leave the details step. The
   * details step runs the guards submit would, one step earlier, so a later
   * step is never reached with nothing to create; the error line names what
   * is missing.
   */
  function next() {
    if (step === 'who') {
      chooseAudience(audience);
      return;
    }
    if (step === 'start') {
      choose(mode);
      return;
    }
    if (step !== 'details') return;
    const name = (nameRef.current?.value || '').trim();
    if (mode === 'import') {
      if (!normalizeRepositoryUrlInput()) return setError('Paste a GitHub repo URL first.');
      if (importState !== 'ok') return setError('Click "Check" to verify bot access first.');
    }
    if (!name) {
      setError('Give your project a name.');
      nameRef.current?.focus();
      return;
    }
    setError('');
    if (!isLast) {
      setStep('approve');
      reveal();
    }
  }

  /** One entry point keeps every mirror of the mode in sync. */
  function applyMode(next: Mode) {
    setMode(next);
    setError('');
    // Switching back to "new" shouldn't leave a stale check banner around;
    // switching into "import" lands on idle either way.
    setImportState('idle');
    setStatus(IDLE_STATUS);
  }

  // The import check.
  //
  //   idle ─┬─ Check click ─→ checking ─┬─ ok    (name field reveals,
  //         │                           │        prefilled, Next enables)
  //         │                           └─ error (inline message, retry)
  //         └─ user edits URL after a successful check → back to idle
  //
  // Why explicit Check and not a debounced auto-check? Two reasons: (1) "I
  // just invited the bot, click here" is a clear action that pairs with the
  // inline error text from the server, vs. a debounced surprise; (2)
  // verifyBotAccess can mutate state by accepting a pending invitation, and we
  // don't want that firing on every keystroke.
  function normalizeRepositoryUrlInput(): string {
    const input = urlRef.current;
    const normalized = normalizeRepositoryUrl(input?.value || '');
    if (input) input.value = normalized;
    return normalized;
  }

  async function check() {
    const url = normalizeRepositoryUrlInput();
    const fail = (text: string) => {
      setImportState('error');
      setStatus({ tone: 'err', text });
    };
    if (!url) return fail('Paste a GitHub repo URL first.');

    setImportState('checking');
    setStatus({ tone: 'none', text: 'Checking bot access…', spinner: true });

    let res: Response;
    try {
      res = await fetch(`/api/github/verify-access?url=${encodeURIComponent(url)}`);
    } catch {
      return fail('Network error. Try again.');
    }

    let data: Record<string, string> = {};
    try {
      data = await res.json();
    } catch {
      /* a non-JSON body is reported through the HTTP status below */
    }
    if (!res.ok) return fail(data.error || `Check failed (HTTP ${res.status}).`);

    setImportState('ok');
    const fullName = data.fullName || `${data.owner}/${data.repo}`;
    setStatus({ tone: 'ok', text: `✓ usernode-bot has Write access to ${fullName}.` });

    // Prefill the name field — repo name + optional description, capped so we
    // don't blow past the input's visible width. Only fill if the user hasn't
    // already typed something, so re-checks don't clobber a manual edit.
    const nameEl = nameRef.current;
    if (nameEl && !nameEl.value.trim() && data.name) {
      nameEl.value = data.description
        ? `${data.name}: ${data.description}`.slice(0, 80)
        : data.name;
    }
    nameEl?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    // Enter before the last step advances; only the last step creates.
    if (!isLast) {
      next();
      return;
    }
    const name = (nameRef.current?.value || '').trim();
    const repoUrl = mode === 'import' ? normalizeRepositoryUrlInput() : '';
    setError('');
    if (!name) {
      setError('Give your project a name.');
      return;
    }
    // Enter in a field can reach here with Create dimmed.
    if (approvalMissing) {
      setError(approvers == null ? 'Choose who approves changes.' : 'Choose how many of them must say yes.');
      return;
    }

    // Guard: in import mode, submit is gated behind a successful check. The
    // server runs the pre-flight again on POST anyway.
    if (mode === 'import') {
      if (!repoUrl) return;
      if (importState !== 'ok') return setError('Click "Check" to verify bot access first.');
    }

    const body = createBody({
      name,
      description: describeRef.current?.value || '',
      mode,
      repoUrl,
      audience,
      invitees: inviteesRef.current?.value || '',
      approvers,
      approvals,
      approvalsN: Number(approvalsNRef.current?.value || 0),
    });

    // One request at a time (QA 2026-09-24 Q5). Claimed synchronously, before
    // the first await, so a second click in the same frame finds it taken.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      void invalidateAppAllowance();
      if (!res.ok) return setError(data.error || 'Failed to create app');
      // The POST returns 201 with the row still in 'creating' — the build
      // runs async server-side. The dialog STAYS OPEN and reports the phases
      // app-creator broadcasts.
      const slug = data.app?.slug;
      if (!slug) {
        // A 201 we cannot follow. Nothing to report progress on, so fall
        // back to closing with a toast rather than an empty progress view.
        dialog.close();
        window.PlatformUI?.toast?.(
          mode === 'import'
            ? 'Your app is being imported. It will appear in your list of apps when it’s ready.'
            : 'Your app is being created. It will appear in your list of apps when it’s ready.',
        );
        (window.Home?.load as (() => void) | undefined)?.();
        return;
      }
      watchCreation(slug);
      setCreated({ slug, name: data.app?.name || name });
      // Refresh the grid behind the dialog so the new tile is already
      // there when the user closes it.
      (window.Home?.load as (() => void) | undefined)?.();
    } catch {
      setError('Network error');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  const stepIndex = Math.max(0, steps.indexOf(step)) + 1;
  // The card and the root carry every answer, like data-mode always has:
  // the kit lifts the card out of the root while presented, so CSS keyed on
  // the root alone would stop matching.
  const answers = {
    'data-mode': mode,
    'data-import-state': importState,
    'data-step': step,
    'data-audience': audience,
    // Empty until answered, so no approval row wears the fill on arrival.
    'data-approvers': approvers ?? '',
    'data-approvals': approvals ?? '',
    'data-final': isLast ? 'true' : 'false',
  };

  return (
    <DialogRoot
      id="create-modal"
      ref={dialog.rootRef}
      {...answers}
      {...dialog.backdropProps}
    >
      <DialogCard
        size="sm"
        id="create-card"
        {...answers}
        className={PANE}
      >
        {created ? (
          <CreateProgress
            appName={created.name}
            mode={mode}
            surface="pane"
            progress={progress}
            openLabel="Open project"
            onOpenApp={() => {
              // Stage 3: the new project's own page (its Workshop, which
              // opens on who it is for), not the running app. That is where
              // the first change is started.
              const slug = created.slug;
              dialog.close();
              (window.App?.navigateToApp as ((s: string, v: string) => void) | undefined)?.(slug, 'dev');
            }}
            onSetSecrets={() => {
              const slug = created.slug;
              dialog.close();
              // Published by features/app-secrets — a bare global read is
              // what broke the last cross-surface jump, so guard it and
              // leave the tile's own "fix secrets" path as the fallback.
              (window.Secrets?.open as ((s: string) => void) | undefined)?.(slug);
            }}
            onRetry={() => {
              const slug = created.slug;
              // Put the view back into its pending state immediately —
              // the retry re-enters createApp server-side and will start
              // broadcasting phases again.
              watchCreation(slug);
              void fetch(`/api/apps/${encodeURIComponent(slug)}/retry`, { method: 'POST' })
                .then(() => (window.Home?.load as (() => void) | undefined)?.())
                .catch(() => {
                  publishAppStatus({
                    slug,
                    status: 'error',
                    errorReason: 'Couldn’t reach the server to retry. Try again from the app’s tile.',
                  });
                });
            }}
            onClose={() => dialog.close()}
          />
        ) : (
        <>
        <h2 id="create-title" className="text-[17px] font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
          {mode === 'import' && (step === 'details' || step === 'approve') ? 'Import a project' : 'New project'}
        </h2>
        {/*
            How far the flow has unfolded, and how far it goes for the
            answers so far: Just me and an import take three steps, a group
            or a community made new takes four. The index is also on the
            attribute for the declared checks.
        */}
        <p
          id="create-step-indicator"
          data-step-index={String(stepIndex)}
          className="text-xs text-zinc-500 dark:text-zinc-400 mb-3"
        >
          {`Step ${stepIndex} of ${steps.length}`}
        </p>
        <AppAllowance id="create-app-quota" surface="pane" />
        <form id="create-form" ref={formRef} className="space-y-4" onSubmit={submit}>
          {/*
              STEP 1: who it is for. The rows are the Workshop's three
              sections, in its words; a choice advances. A group names its
              people right under its row, once the row has collapsed to it.
          */}
          <div data-create-step="who" className="space-y-2">
            <p className={STEP_HEADING}>1. Who is it for?</p>
            {WHO.map((choice) => (
              <button
                key={choice.key}
                type="button"
                data-audience-pill={choice.key}
                className={WHO_CHOICE}
                onClick={() => chooseAudience(choice.key)}
              >
                <WhoGlyph audience={choice.key} />
                <span className="min-w-0 flex-1">
                  <span className={CHOICE_TITLE}>{choice.title}</span>
                  <span className={CHOICE_CAPTION}>{choice.caption}</span>
                </span>
                <ChevronRightIcon className="create-choice-chevron w-5 h-5 shrink-0 opacity-60" aria-hidden="true" />
                <span className={CHOICE_CHANGE}>Change</span>
              </button>
            ))}
            <div id="create-invite-block" className="create-invite-block">
              <div className={CARD}>
                <div className={ROW}>
                  <label htmlFor="create-invitees" className={LABEL}>
                    Invite people
                  </label>
                  <Input
                    id="create-invitees"
                    ref={inviteesRef}
                    name="invitees"
                    type="text"
                    autoComplete="off"
                    spellCheck="false"
                    {...FIELD}
                    placeholder="@ada, @grace"
                  />
                </div>
              </div>
              <p className={CAPTION + ' mt-1.5'}>
                Usernames, separated by commas. They get an invite when it’s created, and you can add more from its page.
              </p>
            </div>
          </div>
          {/*
              STEP 2: what it is, and how to begin. An App is the one kind
              there is today; the other two say so rather than being left
              out, because the question is the one the screen will keep
              asking. The two rows are the old mode pills — same class, same
              data-mode-pill, same #create-card[data-mode] colours.
          */}
          <div data-create-step="start" className="space-y-2">
            <p className={STEP_HEADING}>2. What are you making?</p>
            <div className="create-kinds flex flex-wrap gap-2 pb-1">
              <span className={KIND + ' create-kind-on'} data-kind-pill="app">App</span>
              <span className={KIND + ' create-kind-soon'} data-kind-pill="doc" aria-disabled="true">
                Document <span className="text-[11px] font-medium opacity-70">Soon</span>
              </span>
              <span className={KIND + ' create-kind-soon'} data-kind-pill="video" aria-disabled="true">
                Video <span className="text-[11px] font-medium opacity-70">Soon</span>
              </span>
            </div>
            <p className={LABEL + ' create-start-label pt-1'}>How do you want to start?</p>
            <button
              type="button"
              data-mode-pill="new"
              className={CHOICE}
              onClick={() => choose('new')}
            >
              <span className="min-w-0 flex-1">
                <span className={CHOICE_TITLE}>Start from scratch</span>
                <span className={CHOICE_CAPTION}>Name it, then describe what you want and build it with the group.</span>
              </span>
              <ChevronRightIcon className="create-choice-chevron w-5 h-5 shrink-0 opacity-60" aria-hidden="true" />
              <span className={CHOICE_CHANGE}>Change</span>
            </button>
            <button
              type="button"
              data-mode-pill="import"
              className={CHOICE}
              onClick={() => choose('import')}
            >
              <span className="min-w-0 flex-1">
                <span className={CHOICE_TITLE}>Import a GitHub repo</span>
                <span className={CHOICE_CAPTION}>Bring an app that already exists. You will invite the bot to it first.</span>
              </span>
              <ChevronRightIcon className="create-choice-chevron w-5 h-5 shrink-0 opacity-60" aria-hidden="true" />
              <span className={CHOICE_CHANGE}>Change</span>
            </button>
          </div>
          {/*
              STEP 3: the details. Import-only: GitHub repo URL + Check
              button. The Check button runs the bot-access pre-flight; on
              success the #app-name field below appears, prefilled with the
              repo name. CSS hides the URL block in "new" mode.
          */}
          <div data-create-step="details" className="space-y-4" ref={step === 'details' ? lastStepRef : undefined}>
          <p className={STEP_HEADING}>{mode === 'import' ? '3. Which repo, and what to call it' : '3. What to call it'}</p>
          <div id="create-import-block" className="create-import-block">
            <div className={CARD}>
              <div className={ROW}>
                <label htmlFor="import-url" className={LABEL}>
                  GitHub repo URL
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="import-url"
                    ref={urlRef}
                    name="repoUrl"
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    spellCheck="false"
                    width="flex"
                    {...FIELD}
                    className="font-mono text-[15px]"
                    placeholder="github.com/owner/repo"
                    onBlur={() => {
                      normalizeRepositoryUrlInput();
                    }}
                    onInput={() => {
                      // Any edit invalidates the previous check; the user must
                      // click again. Without this they could verify repo A, edit
                      // the URL to point at repo B, then submit — the route's own
                      // pre-flight catches it, but the UI shouldn't claim
                      // "verified" for a URL that hasn't been verified.
                      setImportState('idle');
                      setStatus(IDLE_STATUS);
                    }}
                  />
                  <Button
                    type="button"
                    id="import-check"
                    variant="pillNeutral"
                    size="sm"
                    ink="neutral"
                    layout="shrink"
                    disabledStyle="block"
                    // The pill sits INSIDE a white card, so its neutral fill
                    // has to be one step off the card in both themes.
                    className="whitespace-nowrap dark:bg-zinc-700 dark:hover:bg-zinc-600"
                    disabled={importState === 'checking'}
                    onClick={check}
                  >
                    {importState === 'ok' ? 'Re-check' : 'Check'}
                  </Button>
                </div>
              </div>
            </div>
            {/*
                ONE text node on each side of the <code>. `Invite{' '}` is two
                adjacent text children, and renderToStaticMarkup emits no
                separator comment between them, so the browser sees one node
                where hydration expects two and React reports #418 — a
                console error, which fails proposal checks.
            */}
            <p className={CAPTION + ' mt-1.5'}>
              {'Invite '}
              <code className="font-mono text-xs">
                usernode-bot
              </code>
              {' as a collaborator (Write access on an organization repo).'}
            </p>
            {/*
                Inline status row: spinner while checking, green check on
                ok, red error text on failure. Hidden in idle.
            */}
            <div id="import-status" className={statusClass(status)}>
              {status.spinner ? <span className="import-spinner"></span> : null}
              {status.text}
            </div>
            {/* A group or a community imported: no approval step, and this
                says why (app.css shows it only then). */}
            <p className={CAPTION + ' mt-1.5 create-import-rule-note'}>
              The repo’s own dapp.json decides who approves changes. You can change it later from Members &amp; approvals.
            </p>
          </div>
          {/*
              Name field. Always visible in "new" mode; gated behind a
              successful access check in "import" mode (CSS hides it
              until #create-card[data-import-state="ok"]).
          */}
          <div id="create-name-block" className={CARD}>
            <div className={ROW}>
              <label htmlFor="app-name" className={LABEL}>
                Project name
              </label>
              <Input
                id="app-name"
                ref={nameRef}
                name="name"
                type="text"
                autoComplete="off"
                {...FIELD}
                placeholder="my cool app"
              />
            </div>
            {/* What it is: optional, and only for a project made new (an
                import's own dapp.json describes it; app.css hides the row).
                Written into the new repository's dapp.json, where people
                read it on the join screen, in Discover and on its page. */}
            <div className={ROW + ' create-describe-row shadow-[inset_0_1px_0_var(--app-sheet-line)]'}>
              <label htmlFor="app-description" className={LABEL}>
                What is it? (optional)
              </label>
              <Input
                id="app-description"
                ref={describeRef}
                name="description"
                type="text"
                autoComplete="off"
                maxLength={100}
                {...FIELD}
                placeholder="Shared shopping list"
              />
            </div>
          </div>
          </div>
          {/*
              STEP 4: who approves changes — a group or a community made
              new. Members vote is the platform's default rule; People I
              pick starts with just the creator as approver, and under it
              "at least N yes votes" is the follow-up. Written into the new
              repository's dapp.json, so it can be voted on later like any
              other rule there. Nothing is picked on arrival, and neither is
              the follow-up once it shows: Create waits for the answers.
          */}
          <div data-create-step="approve" className="space-y-2" ref={step === 'approve' ? lastStepRef : undefined}>
            <p className={STEP_HEADING}>4. Who approves changes?</p>
            <div id="create-approve-block" className="space-y-2">
              <button
                type="button"
                data-approver-pill="anyone"
                className={APPROVER_CHOICE}
                onClick={() => setApprovers('anyone')}
              >
                <span className="min-w-0 flex-1">
                  <span className={CHOICE_TITLE}>Members vote</span>
                  <span className={CHOICE_CAPTION}>A change merges when most active members say yes, or when nobody objects after a wait.</span>
                </span>
              </button>
              <button
                type="button"
                data-approver-pill="invited"
                className={APPROVER_CHOICE}
                onClick={() => setApprovers('invited')}
              >
                <span className="min-w-0 flex-1">
                  <span className={CHOICE_TITLE}>People I pick</span>
                  <span className={CHOICE_CAPTION}>Starts with just you. Add approvers later from Members &amp; approvals.</span>
                </span>
              </button>
              <div className="create-approvals-block space-y-2 pt-1">
                <p className={LABEL}>How many of them must say yes?</p>
                <div className={RAIL}>
                  <button
                    type="button"
                    data-approvals-pill="majority"
                    className={'create-approvals-pill ' + SEGMENT}
                    onClick={() => setApprovals('majority')}
                  >
                    Most of them
                  </button>
                  <button
                    type="button"
                    data-approvals-pill="atLeast"
                    className={'create-approvals-pill ' + SEGMENT}
                    onClick={() => {
                      setApprovals('atLeast');
                      setTimeout(() => approvalsNRef.current?.focus(), 0);
                    }}
                  >
                    At least a number
                  </button>
                </div>
                <div className={CARD + ' create-approvals-n-block'}>
                  <div className={ROW + ' flex items-center gap-3'}>
                    <label htmlFor="create-approvals-n" className={LABEL + ' flex-1'}>
                      Yes votes needed
                    </label>
                    <Input
                      id="create-approvals-n"
                      ref={approvalsNRef}
                      name="approvalsN"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={50}
                      defaultValue="1"
                      {...FIELD}
                      className="w-16 text-right"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div id="create-error" ref={errorRef} className="px-1 text-red-700 dark:text-red-400 text-sm hidden">
            {error}
          </div>
          {/*
              The footer follows how far the card has unfolded, through CSS
              on #create-card[data-final] rather than by mounting and
              unmounting (every id ships on every step). Cancel is always
              there; Next until the last step for these answers, then Create
              / Import. No Back: the earlier steps are still on screen, and
              each collapsed row's "Change" reopens its choice. And no Next
              on the two question steps (request #3160): a row there is the
              answer and moves on by itself, and nothing is filled until it
              has been pressed (app.css, "Nothing is chosen while a step is
              being asked"). On the approval step Create is dimmed until it
              is answered (`approvalMissing`).
          */}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              id="create-cancel"
              className={PILL_SECONDARY}
              onClick={() => dialog.close()}
            >
              Cancel
            </button>
            <Button
              type="button"
              id="create-next"
              variant="pillAccent"
              size="pill"
              layout="flex"
              disabledStyle="block"
              disabled={quotaBlocksCreation}
              onClick={next}
            >
              Next
            </Button>
            {/*
                QA 2026-09-24 Q5: disabled with a spinner while the POST is
                in flight. `submitting` starts false, so the first render is
                still the prerendered button: no aria-busy, no spinner.
            */}
            <Button
              type="submit"
              id="create-submit"
              variant="pillAccent"
              size="pill"
              layout="flex"
              disabledStyle="block"
              disabled={quotaBlocksCreation || submitting || approvalMissing}
              aria-busy={submitting || undefined}
            >
              {submitting ? <SpinnerArcIcon className="inline-block h-4 w-4 mr-2 -mt-0.5 align-middle animate-spin" aria-hidden="true" /> : null}
              {submitting
                ? (mode === 'import' ? 'Importing…' : 'Creating…')
                : (mode === 'import' ? 'Import' : 'Create')}
            </Button>
          </div>
        </form>
        </>
        )}
      </DialogCard>
    </DialogRoot>
  );
}
