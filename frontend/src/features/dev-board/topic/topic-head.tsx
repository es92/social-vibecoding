/**
 * `#gc-thread-head` — the opened topic's card and everything under it.
 *
 * `_renderTopicHead` used to build this whole region as one `innerHTML`
 * string and then bind four handlers into it per paint. It publishes a
 * `{ card, body }` view model now (../card/model.ts and ./model.ts) and
 * mounts this once per paint; the handlers are closures.
 *
 * ── What stays another owner's ────────────────────────────────────────
 *
 * Three sinks, each rendered by React with `dangerouslySetInnerHTML` from a
 * string the MODEL carries, because the markup is another renderer's and is
 * already sanitised where it is built:
 *
 * - an issue's body and a proposal's summary — `DevChat.renderMarkdown`,
 *   the same pipeline the dev chat and the group chat's transcript use.
 * - the before/after tiles — `AppView.visualsTilesHtml`, which four other
 *   surfaces still call (the admin gallery, the dev chat's "Changes ready"
 *   card, and its own tests), so it stays a string builder.
 *
 * And two genuine controller hosts, rendered once, empty, with a constant
 * className: `#dev-issue-comments` (features/dev-board/issue-comments.tsx
 * mounts into it) and `[data-transcript-body]`, which
 * public/js/session-transcript.js fills on expand.
 */

import { Fragment, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';

import { useStoreState } from '../../../lib/use-store-state';
import { Button } from '@/components/ui/button';
import { PencilSquareIcon, PlusIcon, SearchIcon, XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { DevCard, ActionButton } from '../card/dev-card';
import { topicHeadStore } from './topic-store';
import { ChangeConversation } from './conversation';
import type {
  ChecksVerdict,
  CheckRow,
  NoteBox,
  NoteTone,
  ProposalDetails,
  RosterView,
  IssueLink,
  TextRun,
  TopicBody,
  TranscriptSection,
  LedgerProgress,
  LedgerBuildStep,
} from './model';

function call(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

/**
 * The four tints, as complete literals — Tailwind's extractor is a regex
 * over source text, so a class assembled from a hue would compile to
 * nothing.
 */
const TONE: Record<NoteTone, string> = {
  neutral: 'border-zinc-300/40 dark:border-zinc-700/60 bg-zinc-500/5 text-zinc-600 dark:text-zinc-400',
  ok: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-500',
  warn: 'border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-500',
  error: 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400',
};

/** A prose run, with its `font-medium` spans. See ./model.ts's `TextRun`. */
function Runs({ parts }: { parts: TextRun[] }): ReactNode {
  return (
    <>
      {parts.map((r, i) => (typeof r === 'string'
        ? <Fragment key={i}>{r}</Fragment>
        : <span key={i} className="font-medium">{r.b}</span>))}
    </>
  );
}

function Spinner(): ReactNode {
  return <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>;
}

/** The shared bordered note — see ./model.ts's header for what it replaced. */
export function NoteBoxView({ box }: { box: NoteBox }): ReactNode {
  return (
    <div className={`mt-2 rounded border px-2 py-1.5 ${TONE[box.tone]}`} data-note={box.key}>
      <div className="font-medium">{box.spinner ? <Spinner /> : null}{box.heading}</div>
      {box.rows.map((r, i) => (r.t === 'list'
        ? (
          <ul key={i} className={r.cls || 'mt-1 ml-4 list-disc space-y-0.5'}>
            {r.items.map((it, j) => (
              <li key={j} className={(it.kind || it.mono) ? 'font-mono text-[0.7rem] break-all' : undefined}>
                {it.kind ? <span className="opacity-70">{`[${it.kind}] `}</span> : null}
                {it.code ? <code className="font-mono">{it.code}</code> : null}
                {it.text ? (it.code ? `: ${it.text}` : it.text) : null}
                {it.source ? <span className="opacity-60">{` (${it.source})`}</span> : null}
              </li>
            ))}
          </ul>
        )
        : (
          <div key={i} className={r.weight === 'foot' ? 'mt-1 opacity-80' : 'mt-0.5 opacity-90'}>
            <Runs parts={r.parts} />
          </div>
        )))}
      {box.action ? <div className="mt-1"><ActionButton a={box.action} /></div> : null}
    </div>
  );
}

function CheckRowView({ r }: { r: CheckRow }): ReactNode {
  return (
    <>
      <li className={r.advisory ? 'opacity-70' : undefined}>
        <span className={`${r.pass ? 'text-emerald-700 dark:text-emerald-400' : (r.advisory ? 'text-zinc-500 dark:text-zinc-400' : 'text-red-700 dark:text-red-400')} font-medium`}>
          {r.pass ? '✓' : '✗'}
        </span>
        {` ${r.name} `}
        {r.path ? <span className="opacity-60 font-mono">{r.path}</span> : null}
        {r.advisory ? <span className="rounded bg-zinc-500/10 px-1 text-[0.65rem] opacity-70">advisory</span> : null}
        {r.flaky ? (
          <span className="dev-check-flaky" title={`Failed about ${r.flaky}% of its recorded runs`}>
            {`flaky · ${r.flaky}%`}
          </span>
        ) : null}
      </li>
      {/* A row that passed only after a retry is GREEN and still carries its
          reason: the failure happened, it just did not reproduce, and the
          person who owns that check is the one who needs to know. */}
      {!r.pass || r.keepReason ? (
        <>
          <div className="ml-4 opacity-90">{r.reason || 'failed'}</div>
          {r.errors && r.errors.length ? (
            <ul className="ml-6 list-disc space-y-0.5">
              {r.errors.map((e, i) => (
                <li key={i} className="font-mono text-[0.7rem] break-all opacity-90">
                  <span className="opacity-70">{`[${e.kind}] `}</span>
                  {e.message}
                  {e.source ? <span className="opacity-60">{` (${e.source})`}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** The checks verdict: its rows nest, and its passes fold away. */
export function ChecksVerdictView({ v }: { v: ChecksVerdict }): ReactNode {
  const passList = v.passes.length ? (
    <ul className="mt-1 ml-1 space-y-0.5">
      {v.passes.map((r) => <CheckRowView key={r.key} r={r} />)}
    </ul>
  ) : null;
  return (
    <div className={`mt-2 rounded border px-2 py-1.5 ${v.failing ? TONE.warn : TONE.ok}`}>
      <div className="font-medium">{v.heading}</div>
      <div className="mt-0.5 opacity-80">{v.summary}</div>
      {v.failures.length ? (
        <ul className="mt-1 ml-1 space-y-0.5">
          {v.failures.map((r) => <CheckRowView key={r.key} r={r} />)}
        </ul>
      ) : null}
      {v.foldPasses ? (
        <details className="mt-1">
          <summary className="cursor-pointer opacity-80">{`Show ${v.passes.length} passing checks`}</summary>
          {passList}
        </details>
      ) : passList}
      {v.advisoryNote ? <div className="mt-1 opacity-80">{v.advisoryNote}</div> : null}
      {v.checkedNote ? <div className="mt-1 opacity-80">{v.checkedNote}</div> : null}
      {v.baseNote ? <div className="mt-1 opacity-80" data-checks-base="superseded">{v.baseNote}</div> : null}
      {v.fixNote ? <div className="mt-1 opacity-80">{v.fixNote}</div> : null}
      {v.action ? <ActionButton a={v.action} /> : null}
    </div>
  );
}

/**
 * The checks row's bar while a run is in flight. Three segments over one
 * track — passed, failed, remaining — sized against the declared count when
 * it is known and against `ran` when it is not. The numbers are also in the
 * row's `sub`, so the bar carries no information a screen reader cannot get
 * from the text; it is marked decorative for that reason.
 */
function Bar({ ran, passed, failed, expected, attr, value, indeterminate }: {
  ran: number; passed: number; failed: number; expected: number | null;
  attr: string; value: string; indeterminate?: boolean;
}): ReactNode {
  const total = expected && expected > 0 ? expected : Math.max(ran, 1);
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
  const cls = `dev-ledger-progress${indeterminate ? ' dev-ledger-progress-busy' : ''}`;
  return (
    <span className={cls} aria-hidden="true" {...{ [attr]: value }}>
      <span className="dev-ledger-progress-pass" style={{ width: pct(passed) }} />
      <span className="dev-ledger-progress-fail" style={{ width: pct(failed) }} />
    </span>
  );
}

function BuildSteps({ steps }: { steps: LedgerBuildStep[] }): ReactNode {
  const now = steps.find((s) => s.state === 'now');
  const fmt = (ms: number) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  };
  const withPhases = steps.find((s) => s.phases && s.phases.length);
  const nowPhase = withPhases ? withPhases.phases!.find((p) => p.state === 'now') : null;
  const doneCount = steps.filter((s) => s.state === 'done').length;
  return (
    <span className="dev-ledger-progress-build" data-build-step={now ? now.key : 'done'}>
      {/*
          The pipeline as a bar: one segment per step, EQUAL width. It is a
          position indicator, not a time prediction — the four steps are
          nothing like equal (the image build is minutes, the others
          seconds), so sizing the segments by duration would show a bar that
          sat at 4% and then jumped. Where the time is going is the job of
          the labels' own numbers and, inside the image step, of its bar.
      */}
      <span
        className="dev-ledger-build-bar"
        aria-hidden="true"
        data-build-progress={`${doneCount}/${steps.length}`}
      >
        {steps.map((s) => (
          <span key={s.key} className={`dev-ledger-build-seg is-${s.state}`} data-step={s.key} />
        ))}
      </span>
      {/*
          The separator is a real text node, not a flex gap. Gap is a
          painting instruction: it separates these labels on screen and
          nowhere else, so a copy, a screen reader, or a render that got
          the markup before the stylesheet reads them as one word —
          "fetchbranchbuildimageclonedatabase". The middle dot is the
          same separator the checks sub line already uses.
      */}
      {steps.map((s, i) => (
        <Fragment key={s.key}>
          {i > 0 ? <span className="dev-ledger-build-sep"> · </span> : null}
          <span className={`dev-ledger-build-step is-${s.state}`} data-step={s.key}>
            {s.label}
            {s.ms != null ? <small>{fmt(s.ms)}</small> : null}
          </span>
        </Fragment>
      ))}
      {withPhases ? (
        <span className="dev-ledger-build-phases" data-image-phase={nowPhase ? nowPhase.name : 'done'}>
          {withPhases.phases!.map((p, i) => (
            <Fragment key={p.name}>
              {i > 0 ? <span className="dev-ledger-build-sep"> · </span> : null}
              <span className={`dev-ledger-build-phase is-${p.state}`} data-phase={p.name}>
                {p.name}
                {p.ms != null ? <small>{fmt(p.ms)}</small> : null}
              </span>
            </Fragment>
          ))}
          {withPhases.detail ? <span className="dev-ledger-build-detail">{withPhases.detail}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

function Progress({ p }: { p: LedgerProgress }): ReactNode {
  const hasChecks = p.ran > 0 || (p.expected != null && p.expected > 0);
  const u = p.unit || null;
  return (
    <>
      {p.build && p.build.length ? <BuildSteps steps={p.build} /> : null}
      {hasChecks ? (
        <Bar ran={p.ran} passed={p.passed} failed={p.failed} expected={p.expected}
          attr="data-checks-progress" value={`${p.ran}/${p.expected ?? '?'}`} />
      ) : null}
      {u ? (
        <span className="dev-ledger-progress-unit" data-unit-phase={u.phase}>
          {/* Before the first TAP line there is nothing to size: the track
              pulses instead of sitting empty. Without a last-run total the
              bar sizes against `ran`, so it reads as "full so far". */}
          <Bar ran={u.ran} passed={u.passed} failed={u.failed} expected={u.expected}
            attr="data-unit-progress" value={`${u.ran}/${u.expected ?? '?'}`}
            indeterminate={!u.done && u.ran === 0} />
          <small className="dev-ledger-progress-unit-k">npm test</small>
        </span>
      ) : null}
    </>
  );
}

function Roster({ r }: { r: RosterView }): ReactNode {
  if (r.phase === 'hidden') return null;
  return (
    <span className="dev-ledger-roster">
      {r.phase === 'loading' ? 'Loading votes…' : (
        <>
          <span className="dev-ledger-yes">{`${r.yes!.label}:`}</span>
          {` ${r.yes!.names} `}
          <span className="dev-ledger-no">{`${r.no!.label}:`}</span>
          {` ${r.no!.names}`}
          <span className="dev-ledger-needs">{r.needs}</span>
        </>
      )}
    </span>
  );
}

/**
 * The "Where it stands" sheet: one row per fact, in the bar's tones. Built
 * by app-view.js (`_topicLedgerRows`) from the same reason, checks, roster
 * and note builders the four boxes used to draw from — this only draws.
 */
export function LedgerView({ d }: { d: ProposalDetails }): ReactNode {
  if (!d.ledger || !d.ledger.length) return null;
  return (
    <section className="dev-topic-sheet dev-topic-ledger" data-topic-sheet="ledger">
      <h4 className="dev-topic-h">Where it stands</h4>
      {d.pathSteps && d.pathSteps > 1 ? (
        <p className="dev-ledger-path-note">
          {`${NUMBER_WORD[d.pathSteps] || d.pathSteps} steps to a merge. `}
          {d.pathLeft === d.pathSteps
            ? 'All of them have to clear.'
            : `${NUMBER_WORD[d.pathLeft || 0] || d.pathLeft} still to clear.`}
        </p>
      ) : null}
      <div className="dev-ledger">
        {d.ledger.map((r) => (
          <div
            key={r.key}
            className={`dev-ledger-row dev-ledger-${r.tone}`}
            data-note={r.key}
            {...(r.step ? { 'data-step': String(r.step) } : {})}
            {...(r.stepDone ? { 'data-step-done': '' } : {})}
            {...(r.attrs || {})}
          >
            <span className="dev-ledger-dot" aria-hidden="true">
              {r.spinner ? <Spinner />
                : (r.step ? (r.stepDone ? '✓' : String(r.step)) : LEDGER_GLYPH[r.tone])}
            </span>
            <span className="dev-ledger-k">
              {r.label}
              {r.sub ? <small>{r.sub}</small> : null}
            </span>
            <span className="dev-ledger-v">
              {r.text.length ? <span className="dev-ledger-text"><Runs parts={r.text} /></span> : null}
              {r.progress ? <Progress p={r.progress} /> : null}
              {r.roster ? <Roster r={r.roster} /> : null}
              {/* One ordered sequence: a line, or the list its previous line
                  introduced. Rendering every list after every line put the
                  conflicting files three sentences below "Changed on both
                  sides:" — see LedgerRow.foot in model.ts. */}
              {(r.foot || []).map((f, i) => (Array.isArray(f) ? (
                <span key={i} className="dev-ledger-foot"><Runs parts={f} /></span>
              ) : (
                <ul key={i} className="dev-ledger-list">
                  {f.list.map((it, j) => (
                    <li key={j} className={(it.kind || it.mono) ? 'font-mono' : undefined}>
                      {it.kind ? <span className="opacity-70">{`[${it.kind}] `}</span> : null}
                      {it.code ? <code className="font-mono">{it.code}</code> : null}
                      {it.text ? (it.code ? `: ${it.text}` : it.text) : null}
                      {it.source ? <span className="opacity-60">{` (${it.source})`}</span> : null}
                    </li>
                  ))}
                </ul>
              )))}
              {(r.warnFoot || []).map((f, i) => (
                <span key={`w${i}`} className="dev-ledger-foot dev-ledger-foot-warn text-amber-800 dark:text-amber-400"><Runs parts={f} /></span>
              ))}
              {r.fails && r.fails.length ? (
                <ul className="dev-ledger-fails">
                  {r.fails.map((c) => <CheckRowView key={c.key} r={c} />)}
                </ul>
              ) : null}
              {(r.actions && r.actions.length) || (r.passes && r.passes.length) ? (
                <span className="dev-ledger-ops">
                  {(r.actions || []).map((a) => <ActionButton key={a.key} a={a} />)}
                  {r.passes && r.passes.length ? (
                    <details className="dev-ledger-passes">
                      <summary className="gc-vote-btn dev-ledger-passes-btn">{`${r.passes.length} passing`}</summary>
                      <ul className="dev-ledger-fails">
                        {r.passes.map((c) => <CheckRowView key={c.key} r={c} />)}
                      </ul>
                    </details>
                  ) : null}
                </span>
              ) : null}
            </span>
          </div>
        ))}
      </div>
      {d.helpHint ? (
        <div className="dev-ledger-help voting-help-hint">
          {'Merges are decided by votes over time · '}
          <button type="button" className="voting-help-link" data-voting-help="">How voting works</button>
          {d.help ? (
            <button
              type="button"
              className="voting-help-btn"
              data-voting-help=""
              aria-label="How voting and merges work"
              title="How voting and merges work"
            >?</button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Small counts read better as words in a sentence. */
const NUMBER_WORD: Record<number, string> = { 1: 'One', 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five' };

const LEDGER_GLYPH: Record<string, string> = {
  bad: '✕', warn: '!', ok: '✓', vote: '✓', mute: '·', progress: '◐',
};

export function ProposalBody({ b }: { b: NonNullable<TopicBody['proposalBody']> }): ReactNode {
  return (
    <details
      className="dev-topic-details"
      open={b.open}
      onToggle={(e) => {
        if (b.id != null) call('_setProposalBodyOpen', b.id, e.currentTarget.open);
      }}
    >
      <summary className="dev-topic-details-summary">
        Technical details
      </summary>
      {/* DevChat.renderMarkdown's output — sanitised where it is built, and
          the same pipeline the issue body above uses. */}
      <div
        className="dev-issue-body dev-topic-details-body"
        dangerouslySetInnerHTML={{ __html: b.html }}
      />
    </details>
  );
}

function Transcript({ t }: { t: TranscriptSection }): ReactNode {
  // "Fork this chat" is painted INSIDE the body, after its fetch, by
  // `_transcriptActionsHtml` — so it cannot be a child's onClick. The
  // section delegates, which is what `_renderTopicHead` bound here per
  // paint before.
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest?.('[data-fork-chat]') as HTMLButtonElement | null;
    if (!btn || btn.disabled) return;
    e.preventDefault();
    call('forkSharedChat', parseInt(btn.dataset.forkChat || '', 10), btn);
  };
  return (
    <div className="st-section" data-transcript-section={t.id} onClick={onClick}>
      <button
        type="button"
        className="st-section-head"
        data-transcript-toggle={t.id}
        aria-expanded={t.expanded}
        onClick={() => call('toggleTranscript', t.id)}
      >
        <span className="st-caret" aria-hidden="true"></span>
        <span data-transcript-label="">{t.label}</span>
        <span className="st-readonly-tag">read-only</span>
      </button>
      {/* The BODY is public/js/session-transcript.js's — a controller host,
          rendered once with a constant className and never looked inside. */}
      <div className="st-body" data-transcript-body={t.id} hidden={!t.expanded}></div>
    </div>
  );
}

export function TopicHead({ conversation = false }: { conversation?: boolean }): ReactNode {
  const { card, body, item } = useStoreState(topicHeadStore);
  if (!card || !body) return null;
  return <ChangeDetail key={item?.id || 'topic'} card={card} body={body} item={item} conversation={conversation} />;
}

/** Refresh from the endpoint that owns this lifecycle's metadata. */
export async function readChangeDetail(item: any, owner: boolean, signal: AbortSignal) {
  const id = item.id;
  const av = (window as any).AppView;
  const review = ['promoted', 'merging', 'merged'].includes(item.status) && av?.appData?.slug;
  const url = review ? `/api/apps/${av.appData.slug}/proposals/${id}` : `/api/sessions/${id}/details`;
  const response = await fetch(`${url}${av?._demoQS?.() || ''}`, { signal });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Could not refresh this change.');
  const session = review ? payload.proposal : payload.session;
  if (review && !signal.aborted) {
    if (owner) av._invalidateVoteRoster(id);
    await av._loadVoteRoster(id);
  }
  return session;
}

const MAX_LINKED_ISSUES = 50;
const MAX_ISSUE_SUGGESTIONS = 6;

/** Normalize the persisted issue list before comparing or editing it. */
export function normalizeLinkedIssues(values: number[]): number[] {
  return [...new Set(values.map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0 && n <= 2147483647))]
    .sort((a, b) => a - b);
}

/** An exact number remains addable when the open-issue catalog cannot name it. */
export function parseExactIssueNumber(value: string): { issue: number | null; error: string } {
  const token = value.trim();
  if (!/^#?[1-9]\d*$/.test(token)) return { issue: null, error: '' };
  const issue = Number(token.replace(/^#/, ''));
  if (!Number.isSafeInteger(issue) || issue > 2147483647) {
    return { issue: null, error: `“${token}” is too large to be an issue number.` };
  }
  return { issue, error: '' };
}

/** Rank local matches predictably: exact number, number prefix, title prefix, title body. */
export function filterIssueOptions(query: string, options: IssueLink[], selected: number[]): IssueLink[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const numberNeedle = needle.replace(/^#/, '');
  const selectedSet = new Set(normalizeLinkedIssues(selected));
  const seen = new Set<number>();
  return options
    .filter((issue) => {
      if (!Number.isSafeInteger(issue.n) || issue.n <= 0
          || selectedSet.has(issue.n) || seen.has(issue.n)) return false;
      seen.add(issue.n);
      return true;
    })
    .map((issue) => {
      const number = String(issue.n);
      const title = String(issue.title || '').toLocaleLowerCase();
      const score = number === numberNeedle ? 0
        : number.startsWith(numberNeedle) ? 1
          : title.startsWith(needle) ? 2
            : title.includes(needle) ? 3 : 4;
      return { issue, score };
    })
    .filter((match) => match.score < 4)
    .sort((a, b) => a.score - b.score || a.issue.n - b.issue.n)
    .slice(0, MAX_ISSUE_SUGGESTIONS)
    .map((match) => match.issue);
}

/** Build the server's delta without replacing links another caller may have added. */
export function linkedIssueDelta(before: number[], after: number[]): {
  addIssues: number[]; removeIssues: number[];
} {
  const previous = normalizeLinkedIssues(before);
  const next = normalizeLinkedIssues(after);
  return {
    addIssues: next.filter((n) => !previous.includes(n)),
    removeIssues: previous.filter((n) => !next.includes(n)),
  };
}

function IssueIdentity({ issue }: { issue: IssueLink }): ReactNode {
  return (
    <>
      <span className="shrink-0 rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
        {`#${issue.n}`}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-zinc-800 dark:text-zinc-200">{issue.title}</span>
    </>
  );
}

function IssueAssociations({
  proposalId,
  issues,
  issueOptions,
  linkedIssues,
  editable,
  onSaved,
}: {
  proposalId: number;
  issues: IssueLink[];
  issueOptions: IssueLink[];
  linkedIssues: number[];
  editable: boolean;
  onSaved: (issues: number[]) => void;
}): ReactNode {
  const normalized = normalizeLinkedIssues(linkedIssues);
  const signature = normalized.join(', ');
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState(normalized);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!editing) setSelected(normalized);
  }, [signature, editing]);

  const selectedSignature = normalizeLinkedIssues(selected).join(', ');
  const changed = selectedSignature !== signature;
  const optionsByNumber = new Map([...issueOptions, ...issues].map((issue) => [issue.n, issue]));
  const selectedIssues = selected.map((n) => optionsByNumber.get(n) || {
    n, title: `Issue #${n}`, href: `#${n}`,
  });
  const suggestions = filterIssueOptions(query, issueOptions, selected);
  const exact = parseExactIssueNumber(query);
  const exactOption = exact.issue && !selected.includes(exact.issue)
    && !suggestions.some((issue) => issue.n === exact.issue)
    ? { n: exact.issue, title: 'Add by issue number', href: `#${exact.issue}` } : null;

  const openEditor = () => {
    setSelected(normalized);
    setQuery('');
    setError('');
    setNotice('');
    setEditing(true);
  };
  const cancelEditor = () => {
    setSelected(normalized);
    setQuery('');
    setError('');
    setEditing(false);
  };
  const addIssue = (issue: number) => {
    if (selected.includes(issue)) return;
    if (selected.length >= MAX_LINKED_ISSUES) {
      setError(`A proposal can link at most ${MAX_LINKED_ISSUES} issues.`);
      return;
    }
    setSelected((current) => normalizeLinkedIssues([...current, issue]));
    setQuery('');
    setError('');
  };
  const removeIssue = (issue: number) => {
    setSelected((current) => current.filter((n) => n !== issue));
    setError('');
  };
  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEditor();
      return;
    }
    if (event.key !== 'Enter' || !query.trim()) return;
    event.preventDefault();
    if (suggestions[0]) addIssue(suggestions[0].n);
    else if (exactOption) addIssue(exactOption.n);
    else if (exact.error) setError(exact.error);
    else setError('Choose a matching issue or enter its issue number.');
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !changed) return;
    const { addIssues, removeIssues } = linkedIssueDelta(normalized, selected);
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await fetch(`/api/sessions/${proposalId}/linked-issues`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addIssues, removeIssues }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || body.error || 'Could not update issues.');
      const saved = Array.isArray(body.linkedIssues) ? body.linkedIssues.map(Number) : selected;
      onSaved(saved);
      setSelected(normalizeLinkedIssues(saved));
      setQuery('');
      setEditing(false);
      setNotice(body.prBodyStatus === 'github_unavailable'
        ? 'Issues saved. The pull request could not be updated yet; saving again will retry it.'
        : 'Issues saved.');
    } catch (err) {
      setError(err instanceof TypeError ? 'Network error. Try again.' : (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="dev-change-issues" aria-label="Issues this change addresses">
      <div className="flex items-center justify-between gap-3">
        <h4 className="dev-topic-h">Addresses</h4>
        {editable && !editing ? <Button
          type="button"
          variant="unstyled"
          size="inline"
          ink="none"
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 font-medium text-violet-700 hover:bg-violet-500/10 dark:text-violet-300"
          aria-expanded="false"
          onClick={openEditor}
        >
          {issues.length ? <PencilSquareIcon className="h-4 w-4" aria-hidden="true" />
            : <PlusIcon className="h-4 w-4" aria-hidden="true" />}
          {issues.length ? 'Edit issues' : 'Add issue'}
        </Button> : null}
      </div>
      {!editing ? (issues.length ? <div className="mt-2 space-y-1.5">{issues.map((issue) => (
        <a
          key={issue.n}
          href={issue.href}
          className="flex min-h-10 items-center gap-3 rounded-xl bg-zinc-100/80 px-3 py-2 transition-colors hover:bg-zinc-200/80 dark:bg-zinc-800/80 dark:hover:bg-zinc-700/80"
          onClick={(event) => {
            if (!issue.href.startsWith('#') && !issue.href.startsWith('/app/')) return;
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); call('openTopic', 'issue', issue.n);
          }}
        ><IssueIdentity issue={issue} /></a>
      ))}</div> : <p className="dev-topic-note">No issues linked yet.</p>) : null}
      {editing ? <form className="mt-3 space-y-3" data-linked-issues-editor="" onSubmit={save}>
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-zinc-600 dark:text-zinc-400">
            <span>{`Selected (${selected.length})`}</span>
            <span>{`${MAX_LINKED_ISSUES - selected.length} remaining`}</span>
          </div>
          {selectedIssues.length ? <div className="space-y-1.5">{selectedIssues.map((issue) => (
            <div key={issue.n} className="flex min-h-10 items-center gap-3 rounded-xl bg-zinc-100/80 px-3 py-2 dark:bg-zinc-800/80" data-selected-issue={issue.n}>
              <IssueIdentity issue={issue} />
              <button
                type="button"
                className="-mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-red-500/10 hover:text-red-700 dark:text-zinc-400 dark:hover:text-red-400"
                aria-label={`Remove #${issue.n}: ${issue.title}`}
                onClick={() => removeIssue(issue.n)}
              ><XIcon className="h-4 w-4" aria-hidden="true" /></button>
            </div>
          ))}</div> : <p className="rounded-xl bg-zinc-100/80 px-3 py-2 text-sm text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400">No issues selected.</p>}
        </div>
        <div>
          <label htmlFor={`linked-issues-${proposalId}`} className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Add another issue
          </label>
          <div className="relative mt-1.5">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
            <Input
              id={`linked-issues-${proposalId}`}
              className="pl-10"
              value={query}
              onChange={(event) => { setQuery(event.target.value); setError(''); }}
              onKeyDown={handleSearchKey}
              placeholder="Search by number or title"
              autoComplete="off"
              autoFocus
            />
          </div>
          {query.trim() ? <div className="mt-2 overflow-hidden rounded-xl bg-zinc-100 dark:bg-zinc-800" aria-label="Matching issues">
            {suggestions.map((issue) => (
              <button
                key={issue.n}
                type="button"
                className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-200 dark:hover:bg-zinc-700"
                aria-label={`Add #${issue.n}: ${issue.title}`}
                onClick={() => addIssue(issue.n)}
              ><IssueIdentity issue={issue} /><PlusIcon className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" /></button>
            ))}
            {exactOption ? <button
              type="button"
              className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-200 dark:hover:bg-zinc-700"
              aria-label={`Add issue #${exactOption.n}`}
              onClick={() => addIssue(exactOption.n)}
            ><IssueIdentity issue={exactOption} /><PlusIcon className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" /></button> : null}
            {!suggestions.length && !exactOption ? <p className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">No matching open issues. Enter an exact issue number to add it.</p> : null}
          </div> : null}
          <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">Searches open issues in this app. Exact issue numbers can always be added.</p>
        </div>
        {error ? <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="pillNeutral" size="xsText" ink="neutral" onClick={cancelEditor} disabled={saving}>Cancel</Button>
          <Button type="submit" variant="pillAccent" size="xsText" disabledStyle="dim" disabled={saving || !changed}>{saving ? 'Saving…' : 'Save issues'}</Button>
        </div>
      </form> : null}
      {!editing && notice ? <p role="status" className="dev-topic-note">{notice}</p> : null}
    </aside>
  );
}

/** The same card on the owner session and public review/discussion page.
 * Full public metadata is fetched separately from the lightweight board.
 * This endpoint cannot return private agent messages or credentials.
 */
export function ChangeDetail({ card: initialCard, body: initialBody, item, owner = false, active = true, conversation = false }: {
  card: any; body: TopicBody; item?: any; owner?: boolean; active?: boolean; conversation?: boolean;
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<any>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const id = item?.id;
  useEffect(() => {
    if (!id || !active) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = (event: Event) => {
      if ((event as CustomEvent).detail === Number(id)) setRevision((n) => n + 1);
    };
    window.addEventListener('change-detail-refresh', refresh);
    async function load() {
      try {
        // These portals can remain mounted while another screen is open.
        if (!root.current?.getClientRects().length || document.visibilityState === 'hidden') return;
        const session = await readChangeDetail(item, owner, abort.signal);
        if (!abort.signal.aborted) { setLoaded(session); setError(''); }
      } catch (err) {
        if (!abort.signal.aborted) setError((err as Error).message);
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(load, 10000);
      }
    }
    void load();
    return () => { abort.abort(); clearTimeout(timer); window.removeEventListener('change-detail-refresh', refresh); };
  }, [id, revision, owner, active, item?.status]);
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  const session = item && loaded?.id === id ? { ...item, ...loaded } : item;
  const built = session && av ? av._topicViewFor(['active', 'paused'].includes(session.status) ? 'session' : 'proposal', session) : null;
  const card = built?.card || initialCard;
  const body: TopicBody = built?.body || initialBody;
  const applyLinkedIssues = (linkedIssues: number[]) => {
    setLoaded((current: any) => ({ ...(current || session || {}), id, linked_issues: linkedIssues }));
    if (av?.appData?.slug && typeof av._loadDevData === 'function') {
      Promise.resolve(av._loadDevData()).catch(() => {});
    }
    window.dispatchEvent(new CustomEvent('change-detail-refresh', { detail: Number(id) }));
  };
  return (
    <div ref={root} className="dev-topic">
      {error ? <p role="alert" className="dev-topic-note">{error} <button className="gc-vote-btn" onClick={() => setRevision((n) => n + 1)}>Retry</button></p> : null}
      <div className="dev-topic-sheet dev-topic-card" data-topic-sheet="card">
        {(body.issues?.length || body.canEditIssues) && id ? <IssueAssociations
          proposalId={Number(id)}
          issues={body.issues || []}
          issueOptions={body.issueOptions || []}
          linkedIssues={Array.isArray(session?.linked_issues) ? session.linked_issues : []}
          editable={body.canEditIssues === true}
          onSaved={applyLinkedIssues}
        /> : null}
        <DevCard model={card} />
      </div>
      <TopicBodySections body={conversation ? { ...body, transcript: null, activity: [] } : owner ? { ...body, transcript: null } : body} />
      {conversation && body.changeId ? <ChangeConversation key={body.changeId} item={session} body={body} /> : null}
    </div>
  );
}

/**
 * Everything the topic screen draws BELOW its card: the ledger, the About
 * sheet, the transcript, and the host the GitHub thread mounts into.
 *
 * Split out of `TopicHead` so the Workshop can render the same sections
 * under a row it has unfolded (#1787 round four) — same components, same
 * order, same view model, from `AppView._workshopCardBody`. It takes the
 * body as a PROP rather than reading `topicHeadStore`, because that store
 * holds the one topic the screen is on and an inline expansion is not
 * navigation: two readers of one store would fight over it.
 *
 * The Workshop passes `comments: false`, so the singleton
 * `#dev-issue-comments` host below is emitted on the topic screen only.
 */
export function TopicBodySections({ body }: { body: TopicBody }): ReactNode {
  const a = body.actions;
  // The About sheet: the words, the before/after tiles — open, they are the
  // most useful thing on the page for a voter — the PR body as a disclosure
  // line, and a session's note.
  //
  // The words are TWO different things wearing one slot. A proposal's
  // `summaryHtml` is the user-facing half and gets a label, because the
  // technical half below it has one too and an unlabelled block above a
  // labelled one reads as a preamble rather than as the other section. An
  // issue body is just the issue and keeps rendering bare — labelling it
  // "what changes for you" would be a claim nobody made. Kept as two
  // variables rather than one so the label can never end up over an issue.
  const summaryHtml = body.summaryHtml || null;
  const issueHtml = summaryHtml ? null : (body.issueBodyHtml || null);
  const tiles = a && a.visuals ? a.visuals : null;
  const hasAbout = !!(summaryHtml || issueHtml || tiles || body.proposalBody || body.note);
  return (
    <>
      {body.details ? <LedgerView d={body.details} /> : null}
      {hasAbout ? (
        <section className="dev-topic-sheet dev-topic-about" data-topic-sheet="about">
          <h4 className="dev-topic-h">{body.aboutTitle || 'About'}</h4>
          {/* DevChat.renderMarkdown's output — sanitised where it is built. */}
          {summaryHtml ? (
            <>
              <h5 className="dev-topic-sub">What changes for you</h5>
              <div className="dev-topic-about-body" dangerouslySetInnerHTML={{ __html: summaryHtml }} />
            </>
          ) : null}
          {issueHtml ? <div className="dev-topic-about-body" dangerouslySetInnerHTML={{ __html: issueHtml }} /> : null}
          {tiles ? (
            <div className="dev-topic-visuals" data-visuals-scope="1">
              {/* AppView.visualsTilesHtml's markup — four other surfaces
                  still call it, so it stays a string builder. */}
              <div className="usn-visuals-body" dangerouslySetInnerHTML={{ __html: tiles.tilesHtml }} />
            </div>
          ) : null}
          {body.proposalBody ? <ProposalBody b={body.proposalBody} /> : null}
          {body.testing ? <details className="dev-topic-details">
            <summary className="dev-topic-details-summary">Testing instructions</summary>
            {body.testing.html ? <div className="dev-issue-body dev-topic-details-body" dangerouslySetInnerHTML={{ __html: body.testing.html }} />
              : <p className="dev-topic-note">{body.testing.path ? `Testing instructions are recorded in ${body.testing.path}.` : 'No testing instructions have been added yet.'}</p>}
          </details> : null}
          {body.changeId && !tiles ? <details className="dev-topic-details"><summary className="dev-topic-details-summary">Screenshots</summary><p className="dev-topic-note">No screenshots have been captured yet.</p></details> : null}
          {body.note ? <div className="dev-topic-note">{body.note}</div> : null}
        </section>
      ) : null}
      {body.transcript ? (
        <section className="dev-topic-sheet dev-topic-transcript" data-topic-sheet="transcript">
          <Transcript t={body.transcript} />
        </section>
      ) : null}
      {body.activity?.length ? <section className="dev-topic-sheet"><details className="dev-topic-details">
        <summary className="dev-topic-details-summary">Activity</summary>
        {body.activity.map((event) => <p key={event.label} className="dev-topic-note">{event.label} · <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time></p>)}
      </details></section> : null}
      {/* The GitHub thread's host (issue-comments.tsx mounts into it), last
          so app.css can run it into the Discussion sheet below the head. */}
      {body.comments ? <div id="dev-issue-comments" className="dev-topic-sheet dev-topic-comments"></div> : null}
    </>
  );
}
