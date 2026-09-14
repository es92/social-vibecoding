/**
 * `#dc-messages`' children — the dev chat's transcript.
 * See ./transcript-store.ts for the two stores and why the live bubble has
 * one of its own.
 *
 * ── What this component does NOT bind ─────────────────────────────────
 *
 * `initScrollTracking` binds click, keydown and scroll on `#dc-messages`
 * ITSELF, once per `renderChatView`, and that element stays dev-chat.js's. So
 * the spec-preview card, the Q/A chips and their two action buttons keep their
 * `data-*` hooks and no onClick — exactly like the quick-reply pills, and for
 * the same reason: the host outlives every repaint of its contents, so the
 * listener belongs there.
 *
 * What DID need handlers are the six buttons that carried an inline
 * `onclick="DevChat.previewStaging('…', true)"` — the two preview buttons,
 * Propose to group, the issue draft's confirm and dismiss, and #937's Force
 * stop. Those are onClick now, holding the closure instead of a global name.
 */

import { useCallback, type ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import {
  nowStore,
  streamStore,
  transcriptStore,
  type DetailsSpec,
  type ElapsedSpec,
  type TranscriptRow,
} from './transcript-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).DevChat : null) || null;
}

/**
 * The three ticker formatters — `formatElapsed`, `formatCountdown` and
 * `runCohortHint` — live in public/js/cc-progress-summary.js, a classic
 * script this bundle cannot import. Read off `globalThis` rather than
 * `window`: in the browser they are the same object, and off it (the SSG
 * prerender, and the tests that render these rows in Node) `globalThis` is
 * the realm the helpers can actually be put on. Every caller below already
 * copes with them being absent, because at first paint they may not have run.
 */
function fmt(): any {
  return (typeof globalThis !== 'undefined' ? (globalThis as any) : {}) as any;
}

const STAMP_STYLE = { fontSize: '9px', opacity: 0.4, marginLeft: 'auto' } as const;

/** `<span style="font-size:9px;opacity:0.4;margin-left:auto">id ts</span>`. */
function Stamp({ text }: { text: string }): ReactNode {
  return <span style={STAMP_STYLE}>{text}</span>;
}

function StatusIcon({ kind }: { kind: 'spinner' | 'check' | 'key' | 'flag' }): ReactNode {
  if (kind === 'spinner') {
    return <span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>;
  }
  if (kind === 'key') return <span className="dc-status-icon" aria-hidden="true">{'🔑'}</span>;
  const glyph = kind === 'flag' ? '⚑' : '✓';
  return <span className="dc-status-icon dc-status-check" aria-hidden="true">{glyph}</span>;
}

/**
 * A failed turn. See the `failure` row in ./transcript-store.ts for why this
 * exists at all and why it carries no heading and no retry button.
 *
 * A CARD rather than a status row, and that is the whole point: the ladder of
 * `✓` rows above it is a pipeline reading itself out, and a failure is not a
 * step in that pipeline — it is the end of it. Given a row it inherited the
 * ladder's shape and, until now, the ladder's green tick.
 *
 * Three tones share it, because all three are "the pipeline did not finish"
 * and only one of them is a problem the user did not choose. `blocked` and
 * `stopping` are red; `stopped` is the neutral surface with the landing in
 * chips beside it. See the `failure` row's `tone` for why a stop that the
 * user asked for must not be painted as an error — that is the green tick's
 * mistake run in reverse.
 */
function Failure({ r }: { r: Extract<TranscriptRow, { t: 'failure' }> }): ReactNode {
  const tone = r.tone || 'blocked';
  return (
    <div className={`dc-failure dc-failure-${tone}`} role="status">
      <span className="dc-failure-icon" aria-hidden="true">
        {tone === 'stopped' ? '\u25A0' : '\u2297'}
      </span>
      <span className="dc-failure-body">
        {r.html !== undefined
          ? <span className="dc-failure-text" dangerouslySetInnerHTML={{ __html: r.html }} />
          : <span className="dc-failure-text">{r.text}</span>}
        {r.chips && r.chips.length ? (
          <span className="dc-failure-chips">
            {r.chips.map((c, i) => <span key={`${i}-${c}`}>{c}</span>)}
          </span>
        ) : null}
      </span>
      <Elapsed e={r.elapsed ?? null} />
      {r.forceStop ? (
        <button
          className="dc-force-stop-btn"
          onClick={(e) => controller()?._forceStopTurn?.(e.currentTarget)}
        >Force stop</button>
      ) : null}
      <Stamp text={r.stamp} />
    </div>
  );
}

/**
 * The elapsed suffix. A live row re-derives its label from `nowStore` on the
 * 1s heartbeat; `data-elapsed-since` stays in the markup because
 * `_syncElapsedTicker` reads it to decide whether the heartbeat runs at all.
 */
function Elapsed({ e }: { e: ElapsedSpec }): ReactNode {
  const { now } = useStoreState(nowStore);
  if (!e) return null;
  if (e.kind === 'fixed') return <span className="dc-status-elapsed">{e.label}</span>;
  const f = fmt().formatElapsed;
  const label = now > 0 && typeof f === 'function' ? `(${f(Math.max(0, now - e.since))})` : '';
  return <span className="dc-status-elapsed" data-elapsed-since={e.since}>{label}</span>;
}

function StatusLine({ r }: { r: Extract<TranscriptRow, { t: 'status' }> }): ReactNode {
  return (
    <div className="dc-status-line" style={r.dim ? { opacity: 0.8 } : undefined}>
      <StatusIcon kind={r.icon} />
      {r.html !== undefined
        ? <span dangerouslySetInnerHTML={{ __html: ` ${r.html} ` }} />
        : ` ${r.text} `}
      <Elapsed e={r.elapsed} />
      {r.forceStop ? (
        <button
          className="dc-force-stop-btn"
          onClick={(e) => controller()?._forceStopTurn?.(e.currentTarget)}
        >Force stop</button>
      ) : null}
      <Stamp text={r.stamp} />
    </div>
  );
}

/**
 * A `<details>` whose open state persists.
 *
 * `_applyDetailsPersistence` used to walk `#dc-messages` after every render,
 * set `.open` from the stored map and bind a `toggle` listener. Both halves
 * are here: the initial state is the model's `defaultOpen` corrected by the
 * store, and the toggle writes back.
 *
 * Both `data-*` attributes are now markup nobody queries — the persist id
 * reaches `_readDetailsState` through the model, and the default comes from
 * the model too. They stay because the ids ARE the storage keys and reading
 * them off the page is how a disclosure gets debugged, and they stay exactly
 * where the templates put them: `data-persist-id` on every disclosure,
 * `data-default-open` on the `dc-cc-attached` family ALONE, which is the only
 * family `_ccOpenAttrs` wrote it to. Adding it to the four that never carried
 * it would be markup this conversion is not entitled to change.
 */
function useDetails(d: DetailsSpec) {
  const open = controller()?._detailsOpen?.(d.persistId, d.defaultOpen) ?? d.defaultOpen;
  const onToggle = useCallback((ev: any) => {
    controller()?._detailsToggled?.(d.persistId, d.defaultOpen, !!ev.currentTarget.open);
  }, [d.persistId, d.defaultOpen]);
  return { open, onToggle };
}

function CcLog({ r }: { r: Extract<TranscriptRow, { t: 'ccLog' }> }): ReactNode {
  const { open, onToggle } = useDetails(r.details);
  return (
    <details
      className="dc-cc-log" data-persist-id={r.details.persistId}
      open={open} onToggle={onToggle}
    >
      <summary className="dc-cc-log-toggle">{`${r.label} log`}</summary>
      <pre className="dc-cc-log-content">{r.log}</pre>
    </details>
  );
}

/**
 * The run's FACTS, as chips.
 *
 * They were four inline spans joined by `· ` inside the summary, on the same
 * line as "Claude Code is running" — a run-on that truncated the two things
 * a reader actually wants (which file, how long) and pushed the rest onto a
 * second and third line. On a phone it was worse: the 640px block below
 * `display: none`d `.dc-cc-current` outright, so the answer to "what is it
 * doing" simply vanished at the width where you most want it.
 *
 * Chips wrap instead of truncating, so the narrow case loses a line of
 * height rather than a fact. Each span keeps its class — two declared checks
 * select `.dc-cc-attached-summary .dc-cc-cohort`, and the elapsed/countdown/
 * cohort spans still carry the `data-*` the 1s heartbeat finds by
 * `querySelector` on `#dc-messages`, which nesting does not disturb.
 *
 * An empty chip renders as an empty span rather than nothing, and app.css
 * hides it with `:empty`. That is deliberate: the spans are addressed by
 * class from tests and checks, and a chip that disappears from the DOM
 * whenever its value is blank is a selector that fails for a reason nobody
 * can see.
 */
function ProgressChips(
  { p, elapsed }: {
    p: NonNullable<Extract<TranscriptRow, { t: 'attached' }>['progress']>;
    elapsed: ElapsedSpec;
  },
): ReactNode {
  return (
    <>
      <span className="dc-cc-current">{p.current}</span>
      <span className="dc-cc-steps">{p.steps ? `${p.steps} steps` : ''}</span>
      <span className="dc-cc-phase">{p.phase}</span>
      <Elapsed e={elapsed} />
    </>
  );
}

/**
 * …and the run's two SENTENCES, on their own row under the chips.
 *
 * The estimate and the cohort hint are prose, not facts: one is a guess and
 * says so, the other is a statement about other people's runs. As chips they
 * would be a paragraph in a pill. They keep the `data-countdown-to` /
 * `data-cohort-since` hooks the ticker reads.
 */
function ProgressNote(
  { p }: { p: NonNullable<Extract<TranscriptRow, { t: 'attached' }>['progress']> },
): ReactNode {
  const { now } = useStoreState(nowStore);
  const w = fmt();
  const countdown = p.countdownTo != null && typeof w.formatCountdown === 'function'
    ? w.formatCountdown(p.countdownTo, now > 0 ? now : Date.now())
    : '';
  // #906: the cohort hint is resolved on every tick from ELAPSED TIME alone.
  // It used to carry a `data-cohort-gated` flag computed once at render from
  // `msg._estimate`, which is necessarily falsy on the first paint and was
  // never refreshed — so the range blurb sat beside a live countdown for the
  // whole run. `runCohortHint` owns the whole rule; elapsed is its only input.
  const hint = p.cohortSince != null && now > 0 && typeof w.runCohortHint === 'function'
    ? w.runCohortHint(Math.max(0, now - p.cohortSince))
    : '';
  return (
    <span className="dc-cc-note">
      <span
        className="dc-cc-estimate"
        title="Experimental: a small AI model's rough guess from the progress log. May be wrong."
      >
        {p.estimate ? `\u2726 AI guess: ${p.estimate}` : ''}
        {p.estimate && p.countdownTo != null
          ? <span className="dc-cc-countdown" data-countdown-to={p.countdownTo}>{countdown}</span>
          : null}
      </span>
      {p.cohortSince != null
        ? <span className="dc-cc-cohort" data-cohort-since={p.cohortSince}>{hint}</span>
        : null}
    </span>
  );
}

function Attached({ r }: { r: Extract<TranscriptRow, { t: 'attached' }> }): ReactNode {
  const { open, onToggle } = useDetails(r.details);
  return (
    <details
      className="dc-cc-attached" data-persist-id={r.details.persistId}
      data-default-open={r.details.defaultOpen ? '1' : '0'}
      open={open} onToggle={onToggle}
    >
      {/* TWO ROWS INSIDE THE SUMMARY, not one line. Everything a collapsed
          card shows has to live in the <summary> — a <details> hides every
          other child — so the head and the chip row are siblings here rather
          than the chips being a block under the disclosure. */}
      <summary className="dc-status-line dc-cc-attached-summary">
        <span className="dc-cc-head">
          <StatusIcon kind={r.icon} />
          {r.html !== undefined
            ? <span dangerouslySetInnerHTML={{ __html: ` ${r.html}` }} />
            : ` ${r.text}`}
          <span className="dc-cc-attached-chevron" aria-hidden="true"></span>
          <Stamp text={r.stamp} />
        </span>
        <span className="dc-cc-chips">
          {r.progress
            ? <ProgressChips p={r.progress} elapsed={r.elapsed} />
            : <Elapsed e={r.elapsed} />}
        </span>
        {r.progress ? <ProgressNote p={r.progress} /> : null}
      </summary>
      {r.body.kind === 'log'
        ? <pre className="dc-cc-attached-log" data-persist-id={r.body.persistId}>{r.body.text}</pre>
        : <div className="dc-cc-attached-md" dangerouslySetInnerHTML={{ __html: r.body.html }} />}
    </details>
  );
}

function SpecCard({ r }: { r: Extract<TranscriptRow, { t: 'spec' }> }): ReactNode {
  return (
    <>
      <StatusLine r={r.status} />
      {/* No onClick: `initScrollTracking` delegates click AND keydown on
          `#dc-messages` and reads `data-spec-version` off whichever card was
          hit. The host outlives every repaint of its contents. */}
      <div
        className="dc-spec-preview-card" data-spec-version={r.version}
        role="button" tabIndex={0} aria-label="Open spec viewer"
      >
        <div className="dc-spec-preview-header">
          <span className="dc-spec-preview-title">{r.header}</span>
          <span className="dc-spec-preview-cta">View full spec →</span>
        </div>
        <div className="dc-spec-preview-snippet" dangerouslySetInnerHTML={{ __html: r.snippetHtml }} />
      </div>
    </>
  );
}

function IssueDraftCard({ r }: { r: Extract<TranscriptRow, { t: 'issueDraft' }> }): ReactNode {
  const body = r.body;
  const details = body.kind === 'details' ? body.details : null;
  const d = useDetails(details || { persistId: '', defaultOpen: false });
  const resolve = (action: 'confirm' | 'dismiss', el: HTMLButtonElement) =>
    controller()?.resolvePlatformIssueDraft?.(r.msgId, action, el);
  return (
    <>
      <StatusLine r={r.status} />
      <div className="dc-pr-card" data-platform-issue-msg={r.msgId || ''}>
        <div className="dc-pr-card-header">
          <span style={{ color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {r.destLabel}
          </span>
        </div>
        <div style={{ fontWeight: 600, margin: '4px 0 2px' }}>{r.title}</div>
        {body.kind === 'plain' ? (
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', marginBottom: '6px' }}>
            {body.text}
          </div>
        ) : null}
        {body.kind === 'details' ? (
          <details
            className="dc-pi-report" data-persist-id={body.details.persistId}
            open={d.open} onToggle={d.onToggle}
          >
            <summary className="dc-pi-report-summary">
              {body.summary}
              <span className="dc-pi-report-cue">… Show full report</span>
            </summary>
            <div className="dc-pi-report-rest">{body.rest}</div>
          </details>
        ) : null}
        <div className="dc-pr-card-actions">
          {r.action.kind === 'link' ? (
            <a href={r.action.href} target="_blank" rel="noreferrer"
              className="dc-pr-btn dc-pr-btn-preview" style={{ textDecoration: 'none' }}>
              {r.action.label}
            </a>
          ) : null}
          {r.action.kind === 'note' ? (
            <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{r.action.text}</span>
          ) : null}
          {r.action.kind === 'buttons' ? (
            <>
              <button className="dc-pr-btn dc-pr-btn-promote"
                onClick={(e) => resolve('confirm', e.currentTarget)}>{r.action.confirmLabel}</button>
              <button className="dc-pr-btn dc-pr-btn-preview"
                onClick={(e) => resolve('dismiss', e.currentTarget)}>Dismiss</button>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}

const MERGED_TITLE = 'This change is merged and now live in the app.';
const PREVIEW_GONE = 'Preview removed after merge. This change is now live in the app';

function ChangesCard({ r, embedded = false, historical = false }: { r: Extract<TranscriptRow, { t: 'changes' }>; embedded?: boolean; historical?: boolean }): ReactNode {
  return (
    <>
      <StatusLine r={r.status} />
      <PrCard r={r} embedded={embedded} historical={historical} />
    </>
  );
}

/**
 * The card under a `changes` row's status line, on its own. `ChangesCard`
 * draws both; `DevChatTranscript` draws this after the LAST row once later
 * iterations follow the change (#1889), with the status line left in the
 * timeline where the change landed.
 */
function PrCard({ r, embedded = false, historical = false }: { r: Extract<TranscriptRow, { t: 'changes' }>; embedded?: boolean; historical?: boolean }): ReactNode {
  const preview = (testing: boolean, url: string) => controller()?.previewStaging?.(url, testing);
  return (
    <>
      {/* `revealPrCard` adds `dc-pr-card-highlight` to this node for 1.5s to
          flash it after the header's "PR #12" jump. That stays a classList
          mutation, and it survives every repaint because this `className` is
          a CONSTANT literal: React writes it once and never again unless the
          prop VALUE changes. Rendering it from a variable would silently drop
          the flash — the same rule the adopted dialog roots follow. */}
      <div className="dc-pr-card" id="dc-pr-card">
        <div className="dc-pr-card-header">
          {r.prUrl && !embedded
            ? <a href={r.prUrl} target="_blank" rel="noreferrer" className="dc-pr-link">{`PR #${r.prNumber}`}</a>
            : <span style={{ color: 'var(--text-muted)' }}>Changes ready</span>}
          {r.title ? <span className="dc-pr-title">{r.title}</span> : null}
          {r.closesHtml ? <span className="contents" dangerouslySetInnerHTML={{ __html: r.closesHtml }} /> : null}
          <span style={{ fontSize: '9px', opacity: 0.4, marginLeft: '8px' }}>{r.stamp}</span>
        </div>
        {r.visualsHtml ? (
          <div className="dc-pr-card-visuals" style={{ margin: '6px 0 2px' }}
            dangerouslySetInnerHTML={{ __html: r.visualsHtml }} />
        ) : null}
        {!embedded && !historical ? <div className="dc-pr-card-actions">
          <button
            className="dc-pr-btn dc-pr-btn-preview"
            disabled={!r.preview.enabled}
            title={r.preview.enabled ? undefined : PREVIEW_GONE}
            onClick={r.preview.enabled ? () => preview(false, r.preview.url) : undefined}
          >Preview staging</button>
          {r.test ? (
            <button
              className="dc-pr-btn dc-pr-btn-preview"
              disabled={!r.test.enabled}
              title={r.test.enabled ? undefined : PREVIEW_GONE}
              onClick={r.test.enabled ? () => preview(true, r.test!.url) : undefined}
            >Test this change</button>
          ) : null}
          {r.prUrl ? (
            <a href={r.prUrl} target="_blank" rel="noreferrer"
              className="dc-pr-btn dc-pr-btn-preview" style={{ textDecoration: 'none' }}>View on GitHub</a>
          ) : null}
          {/* #558: the in-flight state is the MODEL's, not this element's.
              `promotePR` used to disable the button and swap its innerHTML
              for a spinner; a 3s status poll's repaint would have undone
              both, re-entry guard included. #1602 keeps the terminal state
              in that same model so a promoted card remains visibly locked. */}
          {r.propose ? (
            <button
              className="dc-pr-btn dc-pr-btn-promote"
              disabled={r.propose.kind !== 'ready'}
              aria-busy={r.propose.kind === 'pending' ? 'true' : undefined}
              title={r.propose.kind === 'blocked' ? r.propose.reason : undefined}
              onClick={r.propose.kind === 'ready' ? () => controller()?.promotePR?.() : undefined}
            >
              {r.propose.kind === 'pending'
                ? <><span className="dc-status-icon dc-status-spinner-arc" aria-hidden="true"></span>{' Proposing…'}</>
                : r.propose.kind === 'completed' ? 'Already proposed'
                  : r.propose.kind === 'blocked' ? r.propose.label : 'Submit for review'}
            </button>
          ) : null}
          {r.status2.kind === 'merged'
            ? <span className="ms-badge ms-badge-violet" title={MERGED_TITLE}>✓ Merged, now live in the app</span>
            : null}
          {r.status2.kind === 'badge'
            ? <span className="contents" dangerouslySetInnerHTML={{ __html: r.status2.html }} />
            : null}
        </div> : <p className="dev-topic-note">{r.status2.kind === 'merged' ? 'Merged, now live in the app' : historical ? 'Earlier build result' : 'Build result. Current actions are above.'}</p>}
      </div>
    </>
  );
}

/**
 * The one bubble a live turn is writing into.
 *
 * It is the ONLY subscriber to `streamStore`, which is what keeps a 60fps
 * publish from re-rendering the whole list — see the store's header. Until the
 * first frame lands (and after the turn seals, when `renderMessages` moves the
 * final text into the row model) it renders the model's own html.
 */
function LiveContent({ rowKey, html }: { rowKey: string; html: string }): ReactNode {
  const s = useStoreState(streamStore);
  const live = s.key === rowKey ? s.html : '';
  return <div className="dc-msg-content" dangerouslySetInnerHTML={{ __html: live || html }} />;
}

function Bubble({ r }: { r: Extract<TranscriptRow, { t: 'msg' }> }): ReactNode {
  const more = useDetails(r.more ? r.more.details : { persistId: '', defaultOpen: false });
  const reasoning = useDetails(r.reasoning ? r.reasoning.details : { persistId: '', defaultOpen: false });
  const who = r.who === 'user' ? 'You' : r.who === 'cc' ? 'Claude Code' : 'AI';
  // "You" is READ, not shown. Side and surface already say whose turn it is —
  // the row is right-aligned and it is the only one drawn as a card — so the
  // word was labelling a thing that labels itself, at the top of every second
  // row. It stays in the accessible tree because alignment is not available
  // to a screen reader, which is the one audience it was actually telling.
  //
  // The agent's rows keep theirs visible: "AI" sits in a meta line that also
  // carries the model and what the reply cost, so it is the first word of a
  // sentence rather than a label on its own.
  const whoClass = r.who === 'user'
    ? 'sr-only'
    : 'text-emerald-700 dark:text-emerald-400';
  return (
    <div className={`dc-msg ${r.who === 'user' ? 'dc-msg-user' : 'dc-msg-assistant'}`}>
      <div className="dc-msg-header">
        <span className={whoClass}>{who}</span>
        {r.model ? <span className="dc-msg-model">{r.model}</span> : null}
        <span className="dc-msg-meta">{r.stamp}</span>
      </div>
      {r.live
        ? <LiveContent rowKey={r.key} html={r.contentHtml} />
        : <div className="dc-msg-content" dangerouslySetInnerHTML={{ __html: r.contentHtml }} />}
      {r.more ? (
        <details
          className="dc-cc-log" style={{ marginTop: '6px' }}
          data-persist-id={r.more.details.persistId}
          open={more.open} onToggle={more.onToggle}
        >
          <summary className="dc-cc-log-toggle">Full output</summary>
          <div className="dc-msg-content" style={{ padding: '8px 10px' }}
            dangerouslySetInnerHTML={{ __html: r.more.html }} />
        </details>
      ) : null}
      {r.attachments && r.attachments.length ? (
        <div className="dc-msg-attachments">
          {r.attachments.map((a) => (a.kind === 'image' ? (
            <a key={a.href} href={a.href} target="_blank" rel="noopener noreferrer" title={`${a.name}: open full size`}>
              <img className="dc-msg-att-img" src={a.href} alt={a.name} loading="lazy" />
            </a>
          ) : (
            <a key={a.href} className="dc-msg-att-chip" href={a.href} download={a.name} title={`Download ${a.name}`}>
              <span className="contents" dangerouslySetInnerHTML={{ __html: a.badgeHtml || '' }} />
              <span className="dc-attach-name">{a.name}</span>
              <span className="dc-attach-size">{a.size}</span>
            </a>
          )))}
        </div>
      ) : null}
      {r.reasoning ? (
        <details
          className="dc-cc-log" style={{ marginTop: '6px' }}
          data-persist-id={r.reasoning.details.persistId}
          open={reasoning.open} onToggle={reasoning.onToggle}
        >
          <summary className="dc-cc-log-toggle">Mayor reasoning (raw)</summary>
          <pre className="dc-cc-log-content">{r.reasoning.raw}</pre>
        </details>
      ) : null}
      {/* #32's chips. No onClick — `initScrollTracking`'s delegated listener
          on `#dc-messages` reads `data-qa-group` / `data-qa-answer` and the
          two action flags off whichever control was hit. */}
      {r.qa ? (
        <div className="dc-qa-chips">
          {r.qa.groups.map((g, gi) => (
            <div className="dc-qa-group" key={gi}>
              {g.label ? <div className="dc-qa-group-label">{g.label}</div> : null}
              {g.kind === 'number' && g.number ? (
                /* A QUANTITY, asked as one. The model offered bare magnitudes,
                   so a row of chips would be five guesses at the value you
                   want and no way to give the sixth. `defaultValue` and a
                   commit on blur/Enter, not a controlled field: a controlled
                   one republishes the whole transcript per keystroke and
                   takes the caret with it. */
                <div className="dc-qa-number">
                  <button
                    type="button" className="dc-qa-step" aria-label="Less"
                    data-qa-group={gi} data-qa-step="-1"
                  >{'\u2212'}</button>
                  <input
                    className="dc-qa-number-field" type="text" inputMode="decimal"
                    aria-label={g.label || 'Value'}
                    data-qa-number={gi} defaultValue={g.number.value} key={g.number.value}
                    onBlur={(e) => controller()?._onQaNumberCommit?.(e.currentTarget)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                    }}
                  />
                  <button
                    type="button" className="dc-qa-step" aria-label="More"
                    data-qa-group={gi} data-qa-step="1"
                  >{'+'}</button>
                  {/* The default is still NAMED, in the same muted voice the
                      suggested chip uses — a stepper that opens on a value
                      says nothing about whether that value was recommended. */}
                  <span className="dc-qa-chip-hint">suggested {g.number.suggested}</span>
                </div>
              ) : (
                <div className="dc-qa-chip-row">
                  {g.answers.map((a, ai) => (
                    <button
                      key={ai} type="button"
                      className={`dc-qa-chip${a.suggested ? ' dc-qa-chip-default' : ''}${a.selected ? ' dc-qa-chip-selected' : ''}`}
                      data-qa-group={gi} data-qa-answer={ai}
                    >
                      {a.text}
                      {a.suggested ? <span className="dc-qa-chip-hint">suggested</span> : null}
                    </button>
                  ))}
                  {g.escape ? (
                    <button
                      type="button"
                      className={`dc-qa-chip dc-qa-escape${g.escape.open ? ' dc-qa-escape-open' : ''}`}
                      data-qa-escape={gi}
                    >
                      <span aria-hidden="true">{'\u270e'}</span> {g.escape.label}
                    </button>
                  ) : null}
                </div>
              )}
              {g.escape && g.escape.open ? (
                <input
                  className="dc-qa-typed" type="text"
                  aria-label={g.label || g.escape.label}
                  placeholder={g.escape.label}
                  data-qa-typed={gi} defaultValue={g.escape.value} autoFocus
                  onBlur={(e) => controller()?._onQaTypedCommit?.(e.currentTarget)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                  }}
                />
              ) : null}
            </div>
          ))}
          {r.qa.multi ? (
            <div className="dc-qa-actions">
              <button type="button" className="dc-qa-send" data-qa-send="1">Send answers</button>
              <button type="button" className="dc-qa-defaults" data-qa-defaults="1">Use the suggested defaults</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Row({ r, embedded = false, historical = false }: { r: TranscriptRow; embedded?: boolean; historical?: boolean }): ReactNode {
  switch (r.t) {
    case 'status': return <StatusLine r={r} />;
    case 'failure': return <Failure r={r} />;
    case 'spec': return <SpecCard r={r} />;
    case 'issueDraft': return <IssueDraftCard r={r} />;
    case 'ccLog': return <CcLog r={r} />;
    case 'attached': return <Attached r={r} />;
    case 'changes': return <ChangesCard r={r} embedded={embedded} historical={historical} />;
    // `CreditOptions.cardHtml`'s markup, whole: two declared checks select
    // into it (`.dc-credits-card > .dc-credits-options`, and its
    // `details[data-credits-dev]`), and the banner and the Generate-proposal
    // modal render the same builder. The sink generates no box.
    case 'credits': return <span className="contents" dangerouslySetInnerHTML={{ __html: r.html }} />;
    case 'msg': return <Bubble r={r} />;
    default: return null;
  }
}

/**
 * The rows, the walkthrough and the trailing dots.
 *
 * ── Who wires the two foreign cards ───────────────────────────────────
 *
 * `_wireCreditsCards` and `_wireDevFlowCard` scan `#dc-messages` for
 * `[data-credits-card]` / `[data-flow-wizard]` and hand each one to its own
 * module's `wire()`. Both are listener-only and idempotent per element, so
 * neither is a second author here — but they must run after EVERY render that
 * could have introduced such a card, and a ref on a stable wrapper fires once
 * per mount, not once per publish.
 *
 * So they stay where they were: three unconditional calls at the end of
 * `renderMessages`, on the line after the publish. `transcriptStore` flushes
 * synchronously, so the cards are in the document by then — the same contract
 * they had when the line above was an `innerHTML` assignment. Unconditional
 * matters for `_bindDevFlowVisibility` in particular: in a hand-off venue the
 * walkthrough renders in the composer's place instead of here, and that path
 * wires the card but not the visibility re-check.
 *
 * ── Where the Changes card sits (#1889) ───────────────────────────────
 *
 * A `changes` row is persisted by the turn that landed the change, but the
 * card's actions are the SESSION's: Preview, Test, View on GitHub and Submit
 * for review all read session state, which is why only the latest card
 * carries them and every earlier one is `historical`. Anchored to its turn,
 * that card was left mid-transcript by every later iteration that ended
 * without a new one — a question answered, a run stopped or failed, a turn
 * with nothing to commit — and the bottom of the chat had no way to submit.
 *
 * So once a later USER turn follows the latest card, the card renders after
 * the last row, and its status line stays in the timeline as the record of
 * when the change landed. Three things bound that rule:
 *
 *   - A single iteration is unchanged. The wrap-up bubble under the card is
 *     the same turn, not a new one, and the card stays above it.
 *   - A turn in flight keeps the card in its slot: the tail then belongs to
 *     the run (its progress, #990's dots), and the actions come back to the
 *     bottom with the `renderMessages` that settles the turn — or a new card
 *     lands, and it is the latest.
 *   - The embedded workspace never moves it: its cards carry no actions
 *     (the change card above does), so there is nothing to keep at hand.
 *
 * One card either way — `#dc-pr-card`, with the visuals and the actions —
 * so `revealPrCard` and the declared checks under that id resolve wherever
 * it sits.
 */
export function DevChatTranscript({ embedded = false }: { embedded?: boolean }): ReactNode {
  const s = useStoreState(transcriptStore);
  const latestAt = s.rows.findLastIndex((r) => r.t === 'changes');
  const latest = latestAt >= 0 ? s.rows[latestAt] as Extract<TranscriptRow, { t: 'changes' }> : null;
  // #1889: a later iteration — a user turn after the latest card — with the
  // chat idle. See "Where the Changes card sits" in the header.
  const trails = !!latest && !embedded && !s.busy
    && s.rows.some((r, i) => i > latestAt && r.t === 'msg' && r.who === 'user');
  return (
    <>
      {s.rows.map((r, i) => {
        if (r.t !== 'changes') return <Row key={r.key} r={r} embedded={embedded} />;
        if (i !== latestAt) return <Row key={r.key} r={r} embedded={embedded} historical />;
        // The status line keeps the change's place in the timeline; the
        // card is drawn after the last row instead.
        if (trails) return <Row key={r.key} r={r.status} embedded={embedded} />;
        return <Row key={r.key} r={r} embedded={embedded} />;
      })}
      {trails && latest ? <PrCard r={latest} embedded={embedded} /> : null}
      {/* #1049: the walkthrough sits at the END of the transcript, so on an
          empty session it is the only thing in the pane and on a resumed one
          it stays next to the composer the brief is typed into. Another
          module's markup (`DevFlowSelect`), through a host that generates no
          box so the card stays a direct child of the scroll container. */}
      {s.devFlowHtml
        ? <div className="contents" dangerouslySetInnerHTML={{ __html: s.devFlowHtml }} />
        : null}
      {/* #990's trailing dots, suppressed while a live coding run is already
          painting progress of its own. */}
      {s.activity ? (
        <div id="dc-spinner" className="dc-status-line dc-activity-line">
          <div className="dc-streaming-dots"><span></span><span></span><span></span></div>
          {s.activity.label ? <span className="dc-activity-label">{s.activity.label}</span> : null}
        </div>
      ) : null}
    </>
  );
}

export { StatusLine, Failure, Attached, ChangesCard, Bubble, LiveContent, Row };
