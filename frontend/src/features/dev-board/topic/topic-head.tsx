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
 * already sanitised where it is built. Each goes through ../../../lib/html's
 * `Html`, which keeps the `{ __html }` object while the string is unchanged:
 * this head is republished by the checks poll and by websocket events, and
 * an inline wrapper rewrote every block's innerHTML each time, decoding the
 * before/after tiles' images again.
 *
 * - an issue's body and a proposal's summary — `DevChat.renderMarkdown`,
 *   the same pipeline the dev chat and the group chat's transcript use.
 * - the before/after tiles — `AppView.visualsTilesHtml`, which four other
 *   surfaces still call (the admin gallery, the dev chat's "Changes ready"
 *   card, and its own tests), so it stays a string builder.
 *
 * And a genuine controller host, rendered once, empty, with a constant
 * className: `[data-transcript-body]`, which public/js/session-transcript.js
 * fills on expand.
 *
 * A request's page is ./request-head.tsx (#4453): the request as a Messages
 * thread's root post, its GitHub comments in the thread's own stream.
 */

import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FormEvent, KeyboardEvent, ReactNode, SyntheticEvent } from 'react';

import { Html } from '../../../lib/html';
import { FRESH, watch } from '../../../lib/live-reads';
import { useStoreState } from '../../../lib/use-store-state';
import { Button } from '@/components/ui/button';
import { CheckIcon, ChevronRightIcon, PencilSquareIcon, PlusIcon, SearchIcon, XIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ActionButton, DevCard, StatusPill } from '../card/dev-card';
import { useInlineImageViewer } from '../../image-viewer/image-viewer';
import { topicHeadStore } from './topic-store';
import { TopicBack } from './topic-back';
import { RequestHead } from './request-head';
import { ChangeThreadHead } from './change-head';
import { DescriptionEditor } from './description-editor';
import { ISSUE_BODY_MAX } from '../../../lib/issue-body-limit';
import type {
  ChecksVerdict,
  CheckRow,
  NoteBox,
  NoteTone,
  RosterView,
  IssueLink,
  IssueClosedBand,
  IssueProposalRef,
  TextRun,
  TopicBody,
  TranscriptSection,
  LedgerProgress,
  LedgerBuildStep,
  LedgerRow,
  HeroView,
  StepRow,
  StepRun,
  StepsView,
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
        : (
          // A run with a tone is a row's STATE — "Failing.", "Syncing." —
          // bold in the ledger tone, the one word a scan is looking for.
          <span key={i} className={r.tone ? `dev-ledger-lead dev-ledger-lead-${r.tone}` : 'font-medium'}>{r.b}</span>
        )))}
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

/**
 * One check, on one line: the glyph, the name (ending in an ellipsis rather
 * than wrapping — a check's name can run to a paragraph), the path for a
 * pass, and the tags. A check that FAILED, or passed only after a retry,
 * opens its reason from the line's right end ("Why it failed"), where the
 * selector string, the unit suite's per-test excerpts and the console
 * errors sit until somebody asks: that detail is for whoever fixes the
 * check, not for a voter reading the row.
 */
function CheckRowView({ r }: { r: CheckRow }): ReactNode {
  const glyphCls = `dev-ledger-check-glyph ${r.pass ? 'text-emerald-700 dark:text-emerald-400' : (r.advisory ? 'text-zinc-500 dark:text-zinc-400' : 'text-red-700 dark:text-red-400')} font-medium`;
  const tags = (
    <>
      {r.advisory ? <span className="rounded bg-zinc-500/10 px-1 text-[0.65rem] opacity-70">advisory</span> : null}
      {r.flaky ? (
        <span className="dev-check-flaky" title={`Failed about ${r.flaky}% of its recorded runs`}>
          {`flaky · ${r.flaky}%`}
        </span>
      ) : null}
    </>
  );
  // A row that passed only after a retry is GREEN and still carries its
  // reason: the failure happened, it just did not reproduce, and the person
  // who owns that check is the one who needs to know.
  if (r.pass && !r.keepReason) {
    return (
      <li className={`dev-ledger-check${r.advisory ? ' opacity-70' : ''}`}>
        <span className={glyphCls} aria-hidden="true">✓</span>
        <span className="dev-ledger-check-name" title={r.name}>{r.name}</span>
        {r.path ? <span className="dev-ledger-check-path font-mono">{r.path}</span> : null}
        {tags}
      </li>
    );
  }
  return (
    <li className={`dev-ledger-check dev-ledger-check-why${r.advisory ? ' opacity-70' : ''}`}>
      <details className="dev-ledger-why">
        <summary className="dev-ledger-check-line">
          <span className={glyphCls} aria-hidden="true">{r.pass ? '✓' : '✗'}</span>
          <span className="dev-ledger-check-name" title={r.name}>{r.name}</span>
          {tags}
          <span className="dev-ledger-check-open">{r.pass ? 'Passed on retry' : 'Why it failed'}</span>
        </summary>
        <div className="dev-ledger-why-body">
          {r.reason || 'failed'}
          {r.path ? <span className="dev-ledger-why-path">{` · on ${r.path}`}</span> : null}
          {/* #3978: the unit-suite row's failing tests, each with the
              assertion text the run captured. The fold is the collapse —
              these open with "Why it failed" like the console errors below. */}
          {r.details && r.details.length ? (
            <ul className="dev-ledger-why-details">
              {r.details.map((d, i) => (
                <li key={i}>
                  <span className="dev-ledger-why-test">{d.test}</span>
                  {d.file ? <span className="dev-ledger-why-file">{` · in ${d.file}`}</span> : null}
                  {d.excerpt ? <span className="dev-ledger-why-excerpt">{d.excerpt}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {r.errors && r.errors.length ? (
            <ul className="dev-ledger-why-errors">
              {r.errors.map((e, i) => (
                <li key={i}>
                  <span className="opacity-70">{`[${e.kind}] `}</span>
                  {e.message}
                  {e.source ? <span className="opacity-60">{` (${e.source})`}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {r.details && r.details.length ? (
            <ul className="dev-ledger-why-details mt-1 space-y-1">
              {r.details.map((d, i) => (
                <li key={i}>
                  <div className="font-medium">{d.file ? `${d.file} · ${d.test}` : d.test}</div>
                  <pre className="dev-ledger-why-excerpt mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-500/10 p-2 font-mono text-[0.7rem]">{d.excerpt}</pre>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/**
 * Passing checks that are counted but not yet named (`passesFor`): opening
 * their fold reads them (AppView._loadCheckNames), and the verdict re-renders
 * with the names once they land. Until then the fold says so.
 */
function usePassNames(passesFor: number | null | undefined) {
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const onToggle = (e: SyntheticEvent<HTMLDetailsElement>) => {
    const av = typeof window === 'undefined' ? null : (window as any).AppView;
    if (!e.currentTarget.open || !passesFor || state === 'loading' || !av?._loadCheckNames) return;
    setState('loading');
    Promise.resolve(av._loadCheckNames(passesFor)).then(
      (ok: boolean) => setState(ok ? 'idle' : 'failed'),
      () => setState('failed'),
    );
  };
  return { state, onToggle };
}

function PassNamesPending({ state }: { state: 'idle' | 'loading' | 'failed' }): ReactNode {
  return (
    <li className="dev-passes-pending opacity-70">
      {state === 'failed' ? 'Could not load the passing checks. Close this and open it again to retry.' : 'Loading passing checks…'}
    </li>
  );
}

/** The checks verdict: its rows nest, and its passes fold away. */
export function ChecksVerdictView({ v }: { v: ChecksVerdict }): ReactNode {
  const names = usePassNames(v.passesFor);
  const passList = v.passes.length || v.passesFor ? (
    <ul className="mt-1 ml-1 space-y-0.5">
      {v.passes.map((r) => <CheckRowView key={r.key} r={r} />)}
      {v.passesFor ? <PassNamesPending state={names.state} /> : null}
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
        <details className="mt-1" onToggle={names.onToggle}>
          <summary className="cursor-pointer opacity-80">{`Show ${v.passCount ?? v.passes.length} passing checks`}</summary>
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

/**
 * The Review row's line. Approved, it says who: "Approved by @maya ✓" (the
 * tick marks an invited approver, as the roster always drew it). Not yet,
 * it is the tally. The count against the threshold is the row's sub line,
 * and the policy's wording is the "How voting works" popover's — neither is
 * repeated here.
 */
function Roster({ r }: { r: RosterView }): ReactNode {
  if (r.phase === 'hidden') return null;
  if (r.phase === 'loading') return <span className="dev-ledger-roster">Loading votes…</span>;
  // QA 2026-09-24: a side nobody has taken is left out, rather than drawn as
  // "No (0): —". The loaders send an empty string for it; the bare dash is
  // what they sent before, and is still read as empty.
  const names = (side?: { names: string }) => (side && side.names && side.names !== '—' ? side.names : '');
  const yesNames = names(r.yes);
  const noNames = names(r.no);
  return (
    <span className="dev-ledger-roster" data-approved={r.approved ? '1' : undefined}>
      {r.approved ? (
        <>
          <span className="dev-ledger-lead dev-ledger-lead-ok">Approved</span>
          {yesNames ? ` by ${yesNames}` : null}
          {noNames ? <span className="dev-ledger-needs">{` · No: ${noNames}`}</span> : null}
        </>
      ) : (
        <>
          {/* The space rides inside the lead: a bare whitespace expression
              between two text runs is the hydration mismatch
              tests/shell-build.test.js guards against. With nobody on
              either side the lead is the whole line: the tally beside it
              already says the count. */}
          <span className="dev-ledger-lead dev-ledger-lead-vote">{yesNames || noNames ? 'Waiting for votes. ' : 'Waiting for votes.'}</span>
          {yesNames ? <span className="dev-ledger-yes">{`${r.yes!.label}:`}</span> : null}
          {yesNames ? ` ${yesNames}${noNames ? ' · ' : ''}` : null}
          {noNames ? <span className="dev-ledger-no">{`${r.no!.label}:`}</span> : null}
          {noNames ? ` ${noNames}` : null}
        </>
      )}
      {/* #1688: each voter's line under the names, in their own words. */}
      {(r.reasons || []).map((q) => (
        <span key={q.who} className="dev-ledger-reason" data-vote={q.vote}>
          {`${q.who}: “${q.text}”`}
        </span>
      ))}
      {r.earlier ? <span className="dev-ledger-earlier">{r.earlier}</span> : null}
    </span>
  );
}

/** "How voting works", and the circular "?" — both open the same popover. */
function HelpLinks({ question }: { question: boolean }): ReactNode {
  return (
    <span className="dev-ledger-help voting-help-hint">
      <button type="button" className="voting-help-link un-touch-target" data-voting-help="">How voting works</button>
      {question ? (
        <button
          type="button"
          className="voting-help-btn un-touch-target"
          data-voting-help=""
          aria-label="How voting and merges work"
          title="How voting and merges work"
        >?</button>
      ) : null}
    </span>
  );
}

/**
 * What a ledger row SAYS, under the step it belongs to (StepRowView): the
 * sentence, then — in this order — the live progress, the Review line (who
 * approved, and "How voting works" at its right end, on the one row it
 * explains), the follow-on lines and lists, the attention-tone lines, the
 * failing checks, and the controls with the folded passes. Built by
 * app-view.js (`_topicLedgerRows`) from the same reason, checks, roster and
 * note builders the "Where it stands" ledger drew from — this only draws.
 */
/** How many checks passed on a ledger row — counted, even while `passes` is not yet listed. */
function passingCount(r: LedgerRow): number {
  return r.passCount ?? (r.passes ? r.passes.length : 0);
}

function LedgerRowBody({ r, help }: { r: LedgerRow; help: boolean }): ReactNode {
  const names = usePassNames(r.passesFor);
  return (
    <>
      {r.text.length ? (
        <span className="dev-ledger-text">
          <Runs parts={r.text} />
          {/* When the run happened, at the sentence's end. The vote row's
              count rides in its tally instead. */}
          {r.sub && r.key !== 'votes' ? <span className="dev-step-when">{` ${r.sub}`}</span> : null}
        </span>
      ) : null}
      {r.progress ? <Progress p={r.progress} /> : null}
      {/* The Review line: who approved, and at its right end the "How
          voting works" affordances — this is the row they explain. */}
      {r.roster || r.help ? (
        <span className="dev-ledger-review-line">
          {r.roster ? <Roster r={r.roster} /> : null}
          {r.help ? <HelpLinks question={help} /> : null}
        </span>
      ) : null}
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
      {(r.actions && r.actions.length) || passingCount(r) ? (
        <span className="dev-ledger-ops">
          {(r.actions || []).map((a) => <ActionButton key={a.key} a={a} />)}
          {passingCount(r) ? (
            <details className="dev-ledger-passes" onToggle={names.onToggle}>
              <summary className="gc-vote-btn dev-ledger-passes-btn">{`${passingCount(r)} passing`}</summary>
              <ul className="dev-ledger-fails">
                {(r.passes || []).map((c) => <CheckRowView key={c.key} r={c} />)}
                {r.passesFor ? <PassNamesPending state={names.state} /> : null}
              </ul>
            </details>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

export function ProposalBody({ b, label = 'Technical details', part }: {
  b: NonNullable<TopicBody['proposalBody']>;
  /** The disclosure's name: a change page with no summary calls it "Description". */
  label?: string;
  /** `data-topic-part`, when the disclosure stands in for a part of the page. */
  part?: string;
}): ReactNode {
  return (
    <details
      className={part ? 'dev-topic-details dev-topic-hero-more' : 'dev-topic-details'}
      data-topic-part={part}
      open={b.open}
      onToggle={(e) => {
        if (b.id != null) call('_setProposalBodyOpen', b.id, e.currentTarget.open);
      }}
    >
      <summary className="dev-topic-details-summary">
        {label}
      </summary>
      {/* DevChat.renderMarkdown's output — sanitised where it is built, and
          the same pipeline the issue body above uses. */}
      <Html className="dev-issue-body dev-topic-details-body" html={b.html} />
    </details>
  );
}

/**
 * The rest of a change's summary, one tap down under its lead
 * (`AppView._summaryParts`): on a change Homeroom bot built, its spec's
 * Design brief, which was written for the build, not for the people
 * deciding on it. The open flag is AppView's, like ProposalBody's, so a
 * repaint does not shut it.
 */
export function SummaryMore({ m }: { m: NonNullable<TopicBody['summaryMore']> }): ReactNode {
  return (
    <details
      className="dev-topic-details dev-topic-hero-more"
      data-topic-part="summary-more"
      open={m.open}
      onToggle={(e) => {
        if (m.id != null) call('_setSummaryMoreOpen', m.id, e.currentTarget.open);
      }}
    >
      <summary className="dev-topic-details-summary">How it’s built</summary>
      {/* DevChat.renderMarkdown's output — sanitised where it is built. */}
      <Html className="dev-issue-body dev-topic-details-body" html={m.html} />
    </details>
  );
}

function Transcript({ t }: { t: TranscriptSection }): ReactNode {
  return (
    <div className="st-section" data-transcript-section={t.id}>
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

export function TopicHead(): ReactNode {
  const { card, body, item } = useStoreState(topicHeadStore);
  if (!card || !body) return null;
  // #4453: a request's page is a Messages reply thread with the request as
  // its root post, not the card and its sheets.
  if (body.request) return <RequestHead key={`request:${body.request.number}`} r={body.request} />;
  // `back`: this IS the topic page, whose one back control is the chip at the
  // top of the pane (#2916, ./topic-back.tsx). Every kind of topic comes
  // through here, a change page and an issue/governance thread head alike.
  return <ChangeDetail key={item?.id || 'topic'} card={card} body={body} item={item} back />;
}

/** Refresh from the endpoint that owns this lifecycle's metadata. */
/** A copy of `row` with the viewer's in-flight vote applied (AppView's overlay). */
function withPendingVote(av: any, row: any) {
  if (av && typeof av._overlayPendingVote === 'function') av._overlayPendingVote(row);
  return row;
}

/** The path a change page reads its row from, review or not. */
export function changeDetailPath(item: any): string {
  const av = (window as any).AppView;
  const review = ['promoted', 'merging', 'merged'].includes(item.status) && av?.appData?.slug;
  return review ? `/api/apps/${av.appData.slug}/proposals/${item.id}` : `/api/sessions/${item.id}/details`;
}

/**
 * `fresh` is a re-read after a gap (#4177, lib/live-reads.ts): it skips the
 * service worker's saved copy, and re-reads the vote roster for every viewer,
 * because whatever moved the row while this page was not hearing about it
 * may have moved the votes too.
 */
export async function readChangeDetail(item: any, owner: boolean, signal: AbortSignal, { fresh = false } = {}) {
  const id = item.id;
  const av = (window as any).AppView;
  const review = ['promoted', 'merging', 'merged'].includes(item.status) && av?.appData?.slug;
  const url = changeDetailPath(item);
  // The short form: passing checks are counted, and their fold reads the
  // names when opened (AppView._loadCheckNames, _readTopicRow).
  const demo = av?._demoQS?.() ? '&demo=1' : '';
  const response = await fetch(`${url}?results=failing${demo}`, fresh ? { ...FRESH, signal } : { signal });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Could not refresh this change.');
  const session = review ? payload.proposal : payload.session;
  if (review && !signal.aborted) {
    if (owner || fresh) av._invalidateVoteRoster(id);
    await av._loadVoteRoster(id, { fresh });
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

/**
 * One reference row — an issue this change addresses, or the change on an
 * issue's page — in the Discussion's event-box language (app.css
 * `.gc-event-box`, the frosted sheet fill and hairline): the number chip
 * where the glyph goes, one truncating line of title, and a chevron for the
 * door. The same box a proposal event wears in the chat, so a reference
 * reads as one thing everywhere it is drawn.
 */
const REF_ROW = 'gc-event-box dev-issue-ref';

function RefChevron(): ReactNode {
  return <ChevronRightIcon className="w-4 h-4 text-zinc-500 dark:text-zinc-500 shrink-0" aria-hidden="true" />;
}

function IssueIdentity({ label, title }: { label: string; title: string }): ReactNode {
  return (
    <>
      <span className="shrink-0 rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-zinc-800 dark:text-zinc-200">{title}</span>
    </>
  );
}

/**
 * #2431 — the change addressing THIS issue, on the issue's page.
 *
 * The same box, row and chip as `IssueAssociations` below, because this IS
 * that section read from the other end: a closed issue names the change that
 * closed it, an open one under work names the change on it. Reusing
 * `.dev-change-issues` rather than inventing a second way to draw one
 * reference is the whole point — there is no new styling here.
 *
 * The heading arrives already worded (`_issueProposalRefView`), and the href
 * is always the in-app proposal page: the server resolves the reference FROM
 * proposal rows, so a reference with no page is a reference that was never
 * returned.
 */
function AddressedBy({ r }: { r: IssueProposalRef }): ReactNode {
  return (
    <aside className="dev-change-issues" aria-label="The change addressing this issue">
      <h4 className="dev-topic-h">{r.heading}</h4>
      <div className="mt-2">
        <a
          href={r.href}
          className={REF_ROW}
          data-addressed-by={r.sessionId}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); call('openTopic', 'proposal', r.sessionId);
          }}
        ><IssueIdentity label={r.label} title={r.title} /><RefChevron /></a>
      </div>
    </aside>
  );
}

/**
 * #4244 — a closed request's ONE status band, at the top of its card:
 * "✓ Closed · Oct 5 · by #10 <title> ›". It replaced a separate "Closed by"
 * box above the card plus a grey "Closed" badge on it, which said the same
 * thing twice in two places. Emerald when a merged change closed it, zinc
 * when a close vote or an admin did. The change is an inline pill drawn like
 * the change page's "Addresses" line (`.dev-topic-issue`), and it keeps
 * `data-addressed-by`, the hook the old box's row carried.
 */
function ClosedBand({ b }: { b: IssueClosedBand }): ReactNode {
  const r = b.ref;
  return (
    <div className="dev-issue-closed-band" data-tone={b.tone} data-topic-part="closed-band">
      <CheckIcon className="dev-issue-closed-band-glyph" aria-hidden="true" />
      <span className="dev-issue-closed-band-k">Closed</span>
      {b.when ? <>
        <span className="dev-issue-closed-band-dot" aria-hidden="true">·</span>
        <span title={b.whenTitle || undefined}>{b.when}</span>
      </> : null}
      {r ? <>
        <span className="dev-issue-closed-band-dot" aria-hidden="true">·</span>
        <span>by</span>
        <a
          href={r.href}
          className="dev-ws-chip dev-ws-chip-info dev-topic-issue"
          data-addressed-by={r.sessionId}
          aria-label={`Closed by ${r.label}: ${r.title}`}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); call('openTopic', 'proposal', r.sessionId);
          }}
        ><b>{r.label}</b><span>{r.title}</span><ChevronRightIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /></a>
      </> : b.how ? <>
        <span className="dev-issue-closed-band-dot" aria-hidden="true">·</span>
        <span>{b.how}</span>
      </> : null}
    </div>
  );
}

/**
 * On a change's page: the change it went live inside
 * (services/included-changes.js). The same box, row and chip as
 * `AddressedBy`, read from the other end again: that names the change that
 * closed an issue, this the change that carried this one live.
 */
export function IncludedIn({ r }: { r: IssueProposalRef }): ReactNode {
  return (
    <aside className="dev-change-issues" aria-label="The change this one went live in" data-topic-part="included-in">
      <h4 className="dev-topic-h">{r.heading}</h4>
      <div className="mt-2">
        <a
          href={r.href}
          className={REF_ROW}
          data-included-in={r.sessionId}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); call('openTopic', 'proposal', r.sessionId);
          }}
        ><IssueIdentity label={r.label} title={r.title} /><RefChevron /></a>
      </div>
    </aside>
  );
}

export function IssueAssociations({
  proposalId,
  issues,
  issueOptions,
  linkedIssues,
  editable,
  onSaved,
  thread,
}: {
  proposalId: number;
  issues: IssueLink[];
  issueOptions: IssueLink[];
  linkedIssues: number[];
  editable: boolean;
  onSaved: (issues: number[]) => void;
  /**
   * #4455: a change's page draws the line as one row under the summary:
   * "Addresses", the first request, "+N more" (which opens the rest, one to a
   * line), then the thanks. Editing is ⋯ "Edit requests", which asks for the
   * editor by event, as "Edit description" does.
   */
  thread: { thanks: ReactNode };
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
  const [more, setMore] = useState(false);

  const selectedSignature = normalizeLinkedIssues(selected).join(', ');
  const changed = selectedSignature !== signature;
  const optionsByNumber = new Map([...issueOptions, ...issues].map((issue) => [issue.n, issue]));
  const selectedIssues = selected.map((n) => optionsByNumber.get(n) || {
    n, title: `Request #${n}`, href: `#${n}`,
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
  useEffect(() => {
    if (!editable) return undefined;
    const open = (event: Event) => {
      if (Number((event as CustomEvent).detail) === proposalId) openEditor();
    };
    window.addEventListener('change-issues-edit', open);
    return () => window.removeEventListener('change-issues-edit', open);
  }, [editable, proposalId, signature]);
  const addIssue = (issue: number) => {
    if (selected.includes(issue)) return;
    if (selected.length >= MAX_LINKED_ISSUES) {
      setError(`A change can link at most ${MAX_LINKED_ISSUES} requests.`);
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
      if (!response.ok) throw new Error(body.message || body.error || 'Couldn\'t update the requests.');
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

  const editorForm = () => (
    <form className="mt-3 space-y-3" data-linked-issues-editor="" onSubmit={save}>
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-zinc-600 dark:text-zinc-400">
            <span>{`Selected (${selected.length})`}</span>
            <span>{`${MAX_LINKED_ISSUES - selected.length} remaining`}</span>
          </div>
          {selectedIssues.length ? <div className="space-y-1.5">{selectedIssues.map((issue) => (
            <div key={issue.n} className="flex min-h-10 items-center gap-3 rounded-xl bg-zinc-100/80 px-3 py-2 dark:bg-zinc-800/80" data-selected-issue={issue.n}>
              <IssueIdentity label={`#${issue.n}`} title={issue.title} />
              <button
                type="button"
                className="-mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-red-500/10 hover:text-red-700 dark:text-zinc-400 dark:hover:text-red-400"
                aria-label={`Remove #${issue.n}: ${issue.title}`}
                onClick={() => removeIssue(issue.n)}
              ><XIcon className="h-4 w-4" aria-hidden="true" /></button>
            </div>
          ))}</div> : <p className="rounded-xl bg-zinc-100/80 px-3 py-2 text-sm text-zinc-500 dark:bg-zinc-800/80 dark:text-zinc-400">No requests selected.</p>}
        </div>
        <div>
          <label htmlFor={`linked-issues-${proposalId}`} className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Add another request
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
          {query.trim() ? <div className="mt-2 overflow-hidden rounded-xl bg-zinc-100 dark:bg-zinc-800" aria-label="Matching requests">
            {suggestions.map((issue) => (
              <button
                key={issue.n}
                type="button"
                className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-200 dark:hover:bg-zinc-700"
                aria-label={`Add #${issue.n}: ${issue.title}`}
                onClick={() => addIssue(issue.n)}
              ><IssueIdentity label={`#${issue.n}`} title={issue.title} /><PlusIcon className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" /></button>
            ))}
            {exactOption ? <button
              type="button"
              className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-zinc-200 dark:hover:bg-zinc-700"
              aria-label={`Add request #${exactOption.n}`}
              onClick={() => addIssue(exactOption.n)}
            ><IssueIdentity label={`#${exactOption.n}`} title={exactOption.title} /><PlusIcon className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" /></button> : null}
            {!suggestions.length && !exactOption ? <p className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">No matching open requests. Enter a request number to add it.</p> : null}
          </div> : null}
          <p className="mt-1.5 text-xs text-zinc-500 dark:text-zinc-400">Searches open requests in this project. You can always add one by its number.</p>
        </div>
        {error ? <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="pillNeutral" size="xsText" ink="neutral" onClick={cancelEditor} disabled={saving}>Cancel</Button>
          <Button type="submit" variant="pillAccent" size="xsText" disabledStyle="dim" disabled={saving || !changed}>{saving ? 'Saving…' : 'Save requests'}</Button>
        </div>
      </form>
  );
  const chip = (issue: IssueLink) => (
    <a
      key={issue.n}
      href={issue.href}
      className="dev-ws-chip dev-ws-chip-info dev-topic-issue"
      data-issue-ref={issue.n}
      onClick={(event) => {
        if (!issue.href.startsWith('#') && !issue.href.startsWith('/app/')) return;
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); call('openTopic', 'issue', issue.n);
      }}
    ><b>{`#${issue.n}`}</b><span>{issue.title}</span></a>
  );
  const [first, ...rest] = issues;
  return (
    <aside className="dev-change-addresses" aria-label="Requests this change addresses">
      {!editing && (first || thread.thanks) ? (
        <div className="dev-change-chips" data-open={more ? 'true' : 'false'}>
          {first ? <span className="dev-change-chips-lead">Addresses</span> : null}
          {first ? (
            <span className="dev-change-chips-first">
              {chip(first)}
              {rest.length ? (
                <button
                  type="button"
                  className="dev-ws-chip dev-change-reqs-more"
                  aria-expanded={more}
                  onClick={() => setMore((v) => !v)}
                >{more ? 'Show less' : `+${rest.length} more`}</button>
              ) : null}
            </span>
          ) : null}
          {thread.thanks}
          {more && rest.length ? <span className="dev-change-chips-rest">{rest.map(chip)}</span> : null}
        </div>
      ) : null}
      {editing ? editorForm() : null}
      {!editing && notice ? <p role="status" className="dev-topic-note">{notice}</p> : null}
    </aside>
  );
}

/** A step's mark — the strip's own glyphs (card/dev-card.tsx REQ_MARK). */
const STEP_MARK: Record<string, string> = {
  done: '✓', waiting: '!', blocked: '✕', pending: '·',
};

/** The vote step's line: the bar to the threshold, the card's pill, the counts. */
function VoteTally({ v }: { v: NonNullable<StepRow['vote']> }): ReactNode {
  const majority = Math.max(1, v.majority || 1);
  const pct = Math.max(0, Math.min(100, Math.round((v.yes / majority) * 100)));
  return (
    <div className="dev-step-vote">
      <span className="dev-step-vote-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
      {v.pill ? <StatusPill s={v.pill} inline /> : null}
      <span className="dev-step-vote-tally">{`Yes ${v.yes} · No ${v.no}`}</span>
      {v.was ? <span className="dev-step-vote-was">{v.was}</span> : null}
    </div>
  );
}

/** One step: the mark, the label, who acts at the right; under them, what the row says. */
function StepRowView({ r, help }: { r: StepRow; help: boolean }): ReactNode {
  const row = r.row || null;
  const gateAttrs = r.gate ? { 'data-req-gate': r.gate, 'data-req-state': r.state } : {};
  return (
    <li className={`dev-step dev-step-${r.state}`} data-note={r.key} {...gateAttrs} {...(row && row.attrs ? row.attrs : {})}>
      <span className={`dev-step-mark dev-step-mark-${r.state}`} aria-hidden="true">
        {r.state === 'active' ? <Spinner /> : (STEP_MARK[r.state] || '·')}
      </span>
      <span className="dev-step-label">{r.label}</span>
      {r.actor ? <span className="dev-step-actor">{r.actor}</span> : null}
      {r.vote || row || r.note || r.action ? (
        <div className="dev-step-body">
          {r.vote ? <VoteTally v={r.vote} /> : null}
          {row ? <LedgerRowBody r={row} help={help} /> : (r.note ? <span className="dev-step-note">{r.note}</span> : null)}
          {r.action ? <span className="dev-ledger-ops"><ActionButton a={r.action} /></span> : null}
        </div>
      ) : null}
    </li>
  );
}

/** "?" — How voting works, on the Votes step's line. */
function HelpQuestion(): ReactNode {
  return (
    <span className="dev-ledger-help voting-help-hint">
      <button
        type="button"
        className="voting-help-btn un-touch-target"
        data-voting-help=""
        aria-label="How voting and merges work"
        title="How voting and merges work"
      >?</button>
    </span>
  );
}

/** 13214 → "13,214": a count, grouped the one way the page writes numbers. */
function fmtCount(n: number): string {
  return String(Math.trunc(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** One bar: passed from the left, failed after it, the rest the track. */
function RunTrack({ c, busy }: {
  c: { ran: number; passed: number; failed: number; expected: number | null } | null; busy?: boolean;
}): ReactNode {
  const total = c ? (c.expected && c.expected > 0 ? c.expected : Math.max(c.ran, 1)) : 1;
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
  return (
    <span className={`dev-step-run-track${busy ? ' is-busy' : ''}`} aria-hidden="true">
      {c ? <i className="is-pass" style={{ width: pct(c.passed) }} /> : null}
      {c && c.failed ? <i className="is-fail" style={{ left: pct(c.passed), width: pct(c.failed) }} /> : null}
    </span>
  );
}

/**
 * The Checks step, open: the build as its steps (equal segments — where the
 * build is, not how long is left; see BuildSteps), then the app's declared
 * checks and the unit suite as bars, the failures by name with their "Why it
 * failed" doors, and one line of context — what the run is doing and who
 * started it, or why it could not run. The build row keeps BuildSteps' hooks
 * (`data-build-step`, `data-build-progress`, `data-step`) for the checks.
 */
function RunPanel({ run, id }: { run: StepRun; id: string }): ReactNode {
  const b = run.build;
  const now = b ? b.steps.find((st) => st.state === 'now') : null;
  const built = b ? b.steps.filter((st) => st.state === 'done').length : 0;
  const c = run.checks;
  const checksValue = c && c.ran
    ? (c.done
      ? `${fmtCount(c.passed)} passed${c.failed ? ` · ${c.failed} failed` : ''}`
      : `${fmtCount(c.ran)} / ${c.expected ? fmtCount(c.expected) : '?'}${c.failed ? ` · ${c.failed} failed` : ''}`)
    : (run.live
      ? (run.phase === 'testing' ? 'Starting' : run.phase === 'queued' ? 'Waiting for a slot' : 'After the build')
      : 'Did not run');
  const u = run.unit;
  const unitPhase = u && !u.done && (u.phase === 'cloning' || u.phase === 'installing') ? u.phase : null;
  const unitValue = !u ? '' : unitPhase ? `${unitPhase.charAt(0).toUpperCase()}${unitPhase.slice(1)}`
    : u.done ? `${fmtCount(u.passed)} passed${u.failed ? ` · ${u.failed} failed` : ''}`
      : `${fmtCount(u.ran)} / ${u.expected ? `~${fmtCount(u.expected)}` : '?'}${u.failed ? ` · ${u.failed} failed` : ''}`;
  return (
    <div className="dev-step-run" id={id}>
      {b ? (
        <div className="dev-step-run-row dev-ledger-progress-build" data-build-step={now ? now.key : 'done'}>
          <span className="dev-step-run-k">Build</span>
          <span className="dev-ledger-build-bar" aria-hidden="true" data-build-progress={`${built}/${b.steps.length}`}>
            {b.steps.map((st) => <span key={st.key} className={`dev-ledger-build-seg is-${st.state}`} data-step={st.key} />)}
          </span>
          <span className="dev-step-run-v">{b.value}</span>
        </div>
      ) : null}
      <div className="dev-step-run-row" data-checks-progress={c ? `${c.ran}/${c.expected ?? '?'}` : undefined}>
        <span className="dev-step-run-k">App checks</span>
        <RunTrack c={c} />
        <span className={`dev-step-run-v${c && c.failed ? ' is-bad' : ''}`}>{checksValue}</span>
      </div>
      {u ? (
        <div className="dev-step-run-row" data-unit-phase={u.phase}>
          <span className="dev-step-run-k">Unit tests</span>
          <RunTrack c={unitPhase ? null : u} busy={!!unitPhase || (!u.done && u.ran === 0)} />
          <span className={`dev-step-run-v${u.failed ? ' is-bad' : ''}`}>{unitValue}</span>
        </div>
      ) : null}
      {run.fails.length ? (
        <ul className="dev-ledger-fails">
          {run.fails.map((f) => <CheckRowView key={f.key} r={f} />)}
        </ul>
      ) : null}
      {run.note ? <p className="dev-step-run-note">{run.note}</p> : null}
    </div>
  );
}

/**
 * One merge gate's step: the mark, the label and one short line (app-view.js
 * `_stepLine`, the same words the card's strip uses), then a button only for
 * the person who can clear it. The Checks step is a disclosure: it opens
 * onto its run (RunPanel) by itself while a run is going and when it failed,
 * and a reader's own open or close sticks after that.
 */
function GateStepView({ r }: { r: StepRow }): ReactNode {
  const run = r.run || null;
  const seed = !!(run && run.open);
  const [open, setOpen] = useState(seed);
  // Re-seed on the flip INTO a run: a step that mounted idle and then
  // started one opens itself, as the card's checklist re-seeds (dev-card.tsx
  // RequirementsRow). A repaint that still says the same keeps the reader's.
  const seedRef = useRef(seed);
  useEffect(() => {
    if (seed && !seedRef.current) setOpen(true);
    seedRef.current = seed;
  }, [seed]);
  const panelId = `dev-step-run-${r.gate || r.key}`;
  const main = (
    <>
      <span className="dev-step-label">{r.label}</span>
      {r.line ? <span className="dev-step-line">{r.line}</span> : null}
    </>
  );
  const actions = r.actions || [];
  return (
    <li
      className={`dev-step dev-step-${r.state}`}
      data-note={r.key}
      data-req-gate={r.gate || undefined}
      data-req-state={r.state}
      {...(r.attrs || {})}
    >
      <span className={`dev-step-mark dev-step-mark-${r.state}`} aria-hidden="true">
        {r.state === 'active' ? <Spinner /> : (STEP_MARK[r.state] || '·')}
      </span>
      {run ? (
        <button
          type="button"
          className="dev-step-main dev-step-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
        >
          {main}
          <ChevronRightIcon className="dev-step-chev" aria-hidden="true" />
        </button>
      ) : (
        <span className="dev-step-main">
          {main}
          {r.votes || r.help ? (
            <span className="dev-ledger-review-line">
              {r.votes ? <span className="dev-ledger-roster dev-step-line">{r.votes}</span> : null}
              {r.help ? <HelpQuestion /> : null}
            </span>
          ) : null}
          {r.was ? <span className="dev-step-line dev-step-vote-was">{r.was}</span> : null}
        </span>
      )}
      {(run && open) || actions.length ? (
        <div className="dev-step-body">
          {run && open ? <RunPanel run={run} id={panelId} /> : null}
          {actions.length ? (
            <span className="dev-ledger-ops">{actions.map((a) => <ActionButton key={a.key} a={a} />)}</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The steps: the card's merge-requirements strip (card/dev-card.tsx
 * RequirementsRow) as a sheet — the same headline, detail and count across
 * its top, then every gate as a row, expanded to say what its ledger row
 * said. Built by app-view.js (`_topicStepsView`); this only draws.
 */
function StepsSheet({ s, help }: { s: StepsView; help: boolean }): ReactNode {
  if (!s.rows.length) return null;
  return (
    <section className="dev-topic-sheet dev-topic-steps" data-topic-sheet="steps">
      <div className="dev-steps rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
        <div className="dev-steps-head">
          <span className="dev-steps-headline">{s.headline}</span>
          {/* A gate sheet has no detail: the current step's own line says it. */}
          {s.detail && !s.simple ? <span className="dev-steps-detail">{`· ${s.detail}`}</span> : null}
          {s.total != null ? <span className="dev-steps-count">{`${s.done}/${s.total}`}</span> : null}
        </div>
        <ol className="dev-steps-list border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          {/* Keyed by the GATE where there is one. A step's `key` names the
              ledger row it wears, and that changes as the row gains or loses
              detail (_topicStepsView's `useRow`), which remounted the step
              and redrew it from nothing mid-read. */}
          {s.rows.map((r) => (s.simple
            ? <GateStepView key={r.gate || r.key} r={r} />
            : <StepRowView key={r.gate || r.key} r={r} help={help} />))}
        </ol>
      </div>
    </section>
  );
}

/**
 * B10b: what a builder reviews, one tap down from the page: the pull request
 * and its GitHub link, the steps with their checks (the sheet that sat under
 * the hero, whole: every id, data-note and control is as it was), and the
 * description, or the spec a change under way is built from.
 */
export function DetailsBody({ prRef, steps, help, html }: {
  prRef: HeroView['ref'];
  steps: StepsView | null | undefined;
  help: boolean;
  html: string;
}): ReactNode {
  return (
    <>
      {prRef ? (
        <p className="dev-details-pr" data-details-part="pr">
          <span>{prRef.s}</span>
          {prRef.href ? <a href={prRef.href} target="_blank" rel="noopener">Open on GitHub</a> : null}
        </p>
      ) : null}
      {steps ? <StepsSheet s={steps} help={help} /> : null}
      {html ? (
        <section className="dev-details-part" data-details-part="description">
          <h5 className="dev-details-sub">Description</h5>
          {/* DevChat.renderMarkdown's output — sanitised where it is built. */}
          <Html className="dev-issue-body dev-topic-details-body" html={html} />
        </section>
      ) : null}
    </>
  );
}

// B10b: `?details=1` opens the first change page's Details as it loads, so a
// declared check can read what moved there. Once: a later page opens shut.
let detailsFromUrl = typeof window !== 'undefined'
  && /(?:^|[?&])details=1(?:&|$)/.test(String(window.location?.search || ''));

/**
 * Details as a sheet over the page, opened from the ⋯ menu's row or the
 * Tested line (`AppView.openTechnicalDetails`, with the part to open at).
 * Portalled to the body like the vote picker: a `position: fixed` box inside
 * a frosted sheet would be contained by it. It stays mounted, hidden while
 * shut, so the steps it carries are on the page for whoever reads them by
 * selector.
 */
function DetailsSheet({ id, prRef, steps, help, html, shotsHtml = '' }: {
  id: number;
  prRef: HeroView['ref'];
  steps: StepsView | null | undefined;
  help: boolean;
  html: string;
  /** #4455: Shot details, what the change page's Before and after card leaves out. */
  shotsHtml?: string;
}): ReactNode {
  const [open, setOpen] = useState(() => {
    if (!detailsFromUrl) return false;
    detailsFromUrl = false;
    return true;
  });
  const [part, setPart] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const target = detail && typeof detail === 'object' ? Number(detail.id) : Number(detail);
      if (target !== id) return;
      setPart(detail && typeof detail === 'object' && detail.part ? String(detail.part) : null);
      setOpen(true);
    };
    window.addEventListener('change-details-open', onOpen);
    return () => window.removeEventListener('change-details-open', onOpen);
  }, [id]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: Event) => { if ((event as { key?: string }).key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => {
    if (!open || !card.current) return;
    if (!part) { card.current.scrollTop = 0; return; }
    const at = card.current.querySelector(`[data-note="${part}"]`) as HTMLElement | null;
    if (at && typeof at.scrollIntoView === 'function') at.scrollIntoView({ block: 'start' });
  }, [open, part]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="dev-details-scrim" hidden={!open} data-change-details={id} onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div ref={card} className="dev-details-card" role="dialog" aria-modal="true" aria-label="Details">
        <div className="dev-details-head">
          <h4 className="dev-topic-h">Details</h4>
          <button type="button" className="dev-details-close" aria-label="Close" onClick={() => setOpen(false)}>
            <XIcon className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <DetailsBody prRef={prRef} steps={steps} help={help} html={html} />
        {shotsHtml ? (
          <section className="dev-details-part" data-details-part="shots" data-note="shots">
            <h5 className="dev-details-sub">Shot details</h5>
            {/* AppView.shotsHtml's `details` reading, escaped where it is built. */}
            <Html className="dev-shot-details" html={shotsHtml} />
          </section>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/** The same card on the owner session and public review/discussion page.
 * Full public metadata is fetched separately from the lightweight board.
 * This endpoint cannot return private agent messages or credentials.
 *
 * A CHANGE (a session or a proposal, `body.changeId`) is a Messages reply
 * thread's root post (#4455, ./change-head.tsx): the change, where it
 * stands as its Votes and Testing cards, its before and after; its replies
 * are the thread's stream. The technical half is a sheet the ⋯ menu opens
 * (DetailsSheet). An issue or a governance vote keeps the card and
 * `TopicBodySections`.
 *
 * `back` puts the topic page's "‹ Workshop" chip (./topic-back.tsx) first in
 * `.dev-topic`, above the hero or the card (#2916). Only `TopicHead` passes
 * it: the chip is the page's back control, not part of the card.
 */
export function ChangeDetail({ card: initialCard, body: initialBody, item, owner = false, active = true, back = false }: {
  card: any; body: TopicBody; item?: any; owner?: boolean; active?: boolean; back?: boolean;
}): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<any>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  // The next read is a live re-read (#4177): fresh, roster included. Held
  // until a read actually runs, because a hidden page defers it.
  const freshNext = useRef(false);
  const id = item?.id;
  // THE PAGE RE-READS ITS ROW WHEN SOMETHING HAPPENS TO IT, not on a timer.
  // It polled every ten seconds for as long as it was open, because the
  // checks verdict never reached it over the socket (the server's envelope
  // bug) — and every poll that answered redrew the page, which is where the
  // 36 px and 129 px jumps under a reader came from. What moves it now:
  //   - `change-detail-refresh` with this id: re-read (App._liveRefresh,
  //     for a vote, a session change, a verdict, the before/after tiles);
  //   - with `{ id, row }`: adopt a row the Workshop just read for this page;
  //   - with `{ id, patch }`: merge a live patch (a checks tick), which would
  //     otherwise be painted over by this page's older read;
  //   - a live re-read (#4177, lib/live-reads.ts): the socket reconnected, the
  //     tab came back after a while, or the service worker corrected this
  //     page's own read, which it may have answered from an older copy;
  //   - the page coming back into view after a read was skipped for it.
  useEffect(() => {
    if (!id || !active) return;
    const abort = new AbortController();
    let skipped = false;
    // A fresh read still on the wire when this effect is torn down (a
    // revision bump aborts it): the next effect's read inherits `fresh`.
    let freshInFlight = false;
    async function load() {
      // These portals can remain mounted while another screen is open, and a
      // hidden tab reads nothing; either reads when it is seen again.
      if (!root.current?.getClientRects().length || document.visibilityState === 'hidden') {
        skipped = true;
        return;
      }
      skipped = false;
      const fresh = freshNext.current;
      freshNext.current = false;
      freshInFlight = fresh;
      try {
        const session = await readChangeDetail(item, owner, abort.signal, { fresh });
        if (!abort.signal.aborted) { setLoaded(session); setError(''); }
      } catch (err) {
        if (!abort.signal.aborted) setError((err as Error).message);
      } finally {
        if (!abort.signal.aborted) freshInFlight = false;
      }
    }
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail && typeof detail === 'object') {
        if (Number(detail.id) !== Number(id)) return;
        if (detail.row) { setLoaded(detail.row); setError(''); return; }
        if (detail.patch) {
          setLoaded((current: any) => (current && Number(current.id) === Number(id) ? { ...current, ...detail.patch } : current));
        }
        return;
      }
      if (Number(detail) === Number(id)) setRevision((n) => n + 1);
    };
    const seen = () => { if (skipped && document.visibilityState !== 'hidden') void load(); };
    // Its own read and the roster it reads with it (readChangeDetail).
    const paths = new Set([changeDetailPath(item), `/api/sessions/${id}/votes`]);
    const unwatch = watch(() => {
      freshNext.current = true;
      setRevision((n) => n + 1);
    }, { reads: (url) => paths.has(url.pathname) });
    window.addEventListener('change-detail-refresh', refresh);
    document.addEventListener('visibilitychange', seen);
    const shown = typeof ResizeObserver === 'function' && root.current ? new ResizeObserver(seen) : null;
    if (shown && root.current) shown.observe(root.current);
    void load();
    return () => {
      abort.abort();
      if (freshInFlight) freshNext.current = true;
      unwatch();
      window.removeEventListener('change-detail-refresh', refresh);
      document.removeEventListener('visibilitychange', seen);
      shown?.disconnect();
    };
  }, [id, revision, owner, active, item?.status]);
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  // This page's read wins over the lighter cached row, except for a vote
  // still on its way to the server: the voter's Yes stays on the button
  // from the click, not from whichever read lands after it.
  const session = item && loaded?.id === id ? withPendingVote(av, { ...item, ...loaded }) : item;
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
  const changePage = !!body.changeId;
  const linkedIssues = Array.isArray(session?.linked_issues) ? session.linked_issues : [];
  return (
    <div ref={root} className={changePage ? 'dev-change-head' : 'dev-topic'}>
      {/* A change's back chip is portalled above its sheet (change-head.tsx). */}
      {back && !changePage ? <TopicBack /> : null}
      {error ? <p role="alert" className="dev-topic-note">{error} <button className="gc-vote-btn" onClick={() => setRevision((n) => n + 1)}>Retry</button></p> : null}
      {changePage ? (
        <>
          {/* #4455: the change as a Messages thread's root post, where it
              stands, its shots; its replies are the thread's stream. #2605:
              no build surface here: the ⋯'s Build door leaves for it. */}
          {body.thread ? (
            <ChangeThreadHead id={id ? Number(id) : null} card={card} body={body} v={body.thread} linkedIssues={linkedIssues} onIssuesSaved={applyLinkedIssues} />
          ) : null}
          {id ? (
            <DetailsSheet
              id={Number(id)}
              prRef={body.hero?.ref || null}
              steps={body.steps}
              help={!!(body.details && body.details.help)}
              html={body.proposalBody?.html || ''}
              shotsHtml={av && session?.shots ? av.shotsHtml(session.shots, { sessionId: Number(id), details: true }) : ''}
            />
          ) : null}
          {id && active && av?._canEditDescription(session) ? <DescriptionEditor key={id} id={Number(id)} onSaved={(data) => {
            const patch = { pr_summary_md: data.description, pr_summary_input_version: data.version,
              pr_summary_source: 'author', pr_summary_stale: data.stale, pr_body: data.prBody ?? session?.pr_body };
            setLoaded((current: any) => ({ ...(current || session || {}), ...patch, id }));
            av._cacheDescription(Number(id), data);
          }} /> : null}
        </>
      ) : (
        <>
          <div className="dev-topic-sheet dev-topic-card" data-topic-sheet="card">
            {/* #2431: an ISSUE's page names the change on it. A CHANGE's page
                names its issues under the summary (change-head.tsx). #4244: a
                CLOSED issue says so once, in the band at the card's top. */}
            {body.closedBand ? <ClosedBand b={body.closedBand} /> : null}
            {body.addressedBy ? <AddressedBy r={body.addressedBy} /> : null}
            <DevCard model={card} />
          </div>
          <TopicBodySections body={owner ? { ...body, transcript: null } : body} />
        </>
      )}
    </div>
  );
}

/**
 * Save a request's words: the author's PATCH, then every issue cache the page
 * may have resolved through, returning the body as stored and rendered.
 * Shared by the Workshop's About sheet (`IssueBody`) and a request's root
 * post (./request-head.tsx).
 */
export async function saveIssueBody(slug: string, issue: number, draft: string): Promise<{ body: string; html: string }> {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  const response = await fetch(`/api/apps/${slug}/github-issues/${issue}/body`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: draft }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Couldn’t save the request.');
  const body = typeof result.body === 'string' ? result.body : draft;
  const html = typeof av?._cacheIssueBody === 'function' ? av._cacheIssueBody(issue, body) : '';
  return { body, html };
}

function IssueBody(
{ html: initialHtml, editor }: {
  html: string;
  editor: NonNullable<TopicBody['issueBodyEditor']>;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(editor.markdown);
  const [html, setHtml] = useState(initialHtml);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // A live issue refresh may replace the rendered Markdown. Adopt it while
  // reading, but never overwrite a draft the author is actively typing.
  useEffect(() => {
    if (editing) return;
    setDraft(editor.markdown);
    setHtml(initialHtml);
  }, [editor.issue, editor.markdown, initialHtml, editing]);

  const cancel = () => {
    setDraft(editor.markdown);
    setError('');
    setEditing(false);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const av = typeof window !== 'undefined' ? (window as any).AppView : null;
    const slug = av?.appData?.slug;
    if (!slug) {
      setError('This request is not available right now.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const saved = await saveIssueBody(slug, editor.issue, draft);
      setDraft(saved.body);
      setHtml(saved.html);
      setEditing(false);
      if (typeof av?._renderTopicHead === 'function') av._renderTopicHead();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the request.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h4 id="dev-issue-body-heading" className="dev-topic-h">About this request</h4>
        {editor.canEdit && !editing ? (
          <button
            type="button"
            className="shrink-0 text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors dark:text-zinc-400"
            title="Edit this request (you asked for it)"
            aria-label="Edit request"
            data-issue-body-edit={editor.issue}
            onClick={() => { setError(''); setEditing(true); }}
          >
            <PencilSquareIcon className="w-4 h-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {editing ? (
        <form className="mt-2 space-y-3" data-issue-body-editor={editor.issue} onSubmit={save}>
          <Textarea
            id="dev-issue-body-input"
            aria-labelledby="dev-issue-body-heading"
            rows={10}
            maxLength={ISSUE_BODY_MAX}
            width="full"
            box="default"
            className="resize-y"
            value={draft}
            autoFocus
            disabled={saving}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          {error ? <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="pillNeutral" size="xsText" ink="neutral" onClick={cancel} disabled={saving}>Cancel</Button>
            <Button type="submit" variant="pillAccent" size="xsText" disabledStyle="dim" disabled={saving}>{saving ? 'Saving…' : 'Save body'}</Button>
          </div>
        </form>
      ) : html ? (
        <Html className="dev-topic-about-body" html={html} />
      ) : editor.canEdit ? (
        <p className="dev-topic-note">No description yet.</p>
      ) : null}
    </>
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
 * A request's own page draws none of this: it is a thread
 * (./request-head.tsx), and only the Workshop's inline expansion still draws
 * a request through these sections.
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
  const issueEditor = summaryHtml ? null : (body.issueBodyEditor || null);
  const tiles = a && a.visuals ? a.visuals : null;
  // #2603: a governance proposal's roster, under the words. `hidden` (the
  // fetch failed, or nobody has voted) must not be what keeps the About
  // sheet open, so it is resolved to null before the test below.
  const roster = body.roster && body.roster.phase !== 'hidden' ? body.roster : null;
  const hasAbout = !!(summaryHtml || issueHtml || issueEditor?.canEdit || tiles || body.proposalBody || body.note || roster);
  // #3908: a screenshot in the request's words opens in the app's viewer,
  // over this page, instead of following its file link out of it. The
  // pictures are inside sanitised markdown, so the sheet takes the tap.
  const images = useInlineImageViewer();
  return (
    <>
      {images.viewer}
      {hasAbout ? (
        <section className="dev-topic-sheet dev-topic-about" data-topic-sheet="about" {...images.scope}>
          {!issueEditor ? <h4 className="dev-topic-h">{body.aboutTitle || 'About'}</h4> : null}
          {/* DevChat.renderMarkdown's output — sanitised where it is built. */}
          {summaryHtml ? (
            <>
              <h5 className="dev-topic-sub">What changes for you</h5>
              <Html className="dev-topic-about-body" html={summaryHtml} />
            </>
          ) : null}
          {issueEditor ? <IssueBody key={issueEditor.issue} html={issueHtml || ''} editor={issueEditor} />
            : issueHtml ? <Html className="dev-topic-about-body" html={issueHtml} /> : null}
          {tiles ? (
            <div className="dev-topic-visuals" data-visuals-scope="1">
              {/* AppView.visualsTilesHtml's markup — four other surfaces
                  still call it, so it stays a string builder. */}
              <Html className="usn-visuals-body" html={tiles.tilesHtml} />
            </div>
          ) : null}
          {body.proposalBody ? <ProposalBody b={body.proposalBody} /> : null}
          {body.testing ? <details className="dev-topic-details">
            <summary className="dev-topic-details-summary">Testing instructions</summary>
            {body.testing.html ? <Html className="dev-issue-body dev-topic-details-body" html={body.testing.html} />
              : <p className="dev-topic-note">{body.testing.path ? `Testing instructions are recorded in ${body.testing.path}.` : 'No testing instructions have been added yet.'}</p>}
          </details> : null}
          {body.note ? <div className="dev-topic-note">{body.note}</div> : null}
          {/* #2603: the votes, in the voters' own words — the same roster
              a change's Review row draws, wearing the review line's box so
              the reasons under it lay out as they do there. */}
          {roster ? (
            <div className="dev-ledger-review-line dev-topic-roster">
              <Roster r={roster} />
            </div>
          ) : null}
        </section>
      ) : null}
      {body.transcript ? (
        <section className="dev-topic-sheet dev-topic-transcript" data-topic-sheet="transcript">
          <Transcript t={body.transcript} />
        </section>
      ) : null}
    </>
  );
}
