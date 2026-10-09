/**
 * #4455 — a change's page, drawn as the thread Messages opens beside a
 * message, as a request's page is (./request-head.tsx, #4453): the change is
 * the root post, and its replies and everything that happened to it follow
 * in `#gc-thread-messages` (../../group-chat/transcript.tsx `ChangeRows`).
 *
 * This is the head, rendered by `ChangeDetail` (./topic-head.tsx, which keeps
 * the page's own read of its row) into `#gc-thread-head`, the top of the
 * thread shell's scroller. Two pieces portal into the shell's other hosts
 * (../../group-chat/thread-shell.tsx `RequestShell`, in its change layout):
 *
 *   - `#gc-thread-back`: the "‹ Workshop" chip, above the sheet;
 *   - `#gc-thread-bar`: the sheet's header, "Change #N", the category in
 *     plain words, and the ⋯ disc, which holds everything that is not on the
 *     page (`AppView._topicCard`'s rows: the pull request, Share, Explore,
 *     Edit requests, the tags, Shot details, Take the shots again, Details).
 *
 * The root post: who put it up, when and what built it; the title; the
 * summary as a quote folded at four lines (the request page's own fold);
 * the plan it was built from, as the request page's plan card (#4479);
 * one row with the requests it addresses and the thanks; then where it
 * stands, as two cards one above the other, Votes then Testing, each its
 * name and figure over its bar, its button beside them and one line under;
 * then the Before and after card. The view model is
 * `AppView._changeThreadView`; this only draws.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Html } from '../../../lib/html';
import { Diagram, readDiagram } from '../../../lib/diagram/diagram';
import { Avatar } from '@/components/ui/feed';
import { CheckIcon, EllipsisHorizontalIcon } from '@/components/ui/icons';
import { swatchFor } from '../../group-chat/swatch';
import { useInlineImageViewer } from '../../image-viewer/image-viewer';
import { ActionButton, TitleContent, VoteButton, isVoteSpec } from '../card/dev-card';
import type { ActionSpec, DevCardModel } from '../card/model';
import type { ChangeGateView, ChangeThreadView, TopicBody } from './model';
import { RequestWords, SpecCard } from './request-head';
import { TopicBack } from './topic-back';
import { IncludedIn, IssueAssociations, ProposalBody, SummaryMore } from './topic-head';

function host(id: string): Element | null {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

/** The sheet's header: what this is, its category, and everything else behind ⋯. */
function ChangeBar({ v, menuKey }: { v: ChangeThreadView; menuKey: string }): ReactNode {
  return (
    <header className="messages-thread-header">
      <div className="min-w-0 flex-1">
        <div className="messages-thread-name">{v.number ? `Change #${v.number}` : 'Change'}</div>
        {v.category ? <div className="messages-thread-sub" data-change-category="">{v.category}</div> : null}
      </div>
      {menuKey ? (
        <button
          type="button"
          className="messages-thread-action dev-card-menu-btn"
          data-card-menu={menuKey}
          aria-haspopup="true"
          aria-label="More actions"
          title="More actions"
        >
          <EllipsisHorizontalIcon aria-hidden="true" />
        </button>
      ) : null}
    </header>
  );
}

/**
 * One card: its name and figure over its bar, its button beside them, and
 * one line under. A bar still moving is drawn in the lit ink; a finished
 * one is full and green, with a green check and figure (AGENTS.md: a
 * finished progress bar may be green).
 */
function GateCard({ which, g, action, id }: { which: 'votes' | 'testing'; g: ChangeGateView; action: ReactNode; id: number | null }): ReactNode {
  const open = () => (window as any).AppView?.openTechnicalDetails?.(id, 'checks');
  return (
    <div className="dev-change-gate" data-change-gate={which} data-done={g.done ? 'true' : 'false'} data-tone={g.tone} role="group" aria-label={g.name}>
      <div className="dev-change-gate-main">
        <div className="dev-change-gate-head">
          <span className="dev-change-gate-name">
            {g.done ? <CheckIcon className="dev-change-gate-check" aria-hidden="true" /> : null}
            {g.name}
          </span>
          <span className="dev-change-gate-figure">{g.figure}</span>
        </div>
        <div className="dev-change-bar" role="img" aria-label={g.label}>
          {g.segments.map((seg, i) => (
            <span key={i} className="dev-change-bar-seg" style={{ flexGrow: seg.weight, flexBasis: 0 }}>
              <span className="dev-change-bar-fill" data-state={seg.state} style={{ width: `${Math.max(0, Math.min(100, seg.pct))}%` }} />
            </span>
          ))}
        </div>
      </div>
      {action ? <div className="dev-change-gate-act">{action}</div> : null}
      {g.noteDetail ? (
        <details className="dev-change-gate-note" data-change-gate-explanation="">
          <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500" title={g.noteDetail}>
            {g.note.join(' ')}
          </summary>
          <p className="mt-2">{g.noteDetail}</p>
        </details>
      ) : g.note.length || (g.details && id) ? (
        <p className="dev-change-gate-note">
          {g.note.join(' ')}
          {g.details && id ? <>{g.note.length ? ' ' : ''}<button type="button" className="dev-change-gate-link" onClick={open}>See what failed</button></> : null}
        </p>
      ) : null}
    </div>
  );
}

/** The Before and after card: the shots, or the line that says where they are. */
function ShotsCard({ s }: { s: NonNullable<ChangeThreadView['shots']> }): ReactNode {
  if (s.state === 'verified') {
    return (
      <section className="dev-change-shots" data-change-shots="verified">
        {/* AppView.shotsHtml's `thread` reading — escaped where it is built. */}
        <Html className="dev-change-shots-html" html={s.html} />
      </section>
    );
  }
  return (
    <section className="dev-change-shots dev-change-shots-plain" data-change-shots={s.state} aria-label="Before and after">
      <div className="dev-change-card-name">Before and after</div>
      {s.html ? <Html className="dev-change-shots-tiles usn-visuals-body" data-visuals-scope="1" html={s.html} /> : null}
      {s.line ? (
        <p className="dev-change-shots-line">
          {s.waiting ? <span className="dc-status-spinner-arc" aria-hidden="true"></span> : null}
          <span>{s.line}</span>
        </p>
      ) : null}
    </section>
  );
}

export function ChangeThreadHead({ id, card, body, v, linkedIssues, onIssuesSaved }: {
  id: number | null;
  card: DevCardModel;
  body: TopicBody;
  v: ChangeThreadView;
  linkedIssues: number[];
  onIssuesSaved: (issues: number[]) => void;
}): ReactNode {
  const images = useInlineImageViewer();
  const all: ActionSpec[] = card.actions || [];
  const yes = all.find((a) => isVoteSpec(a, 'yes'));
  const no = all.find((a) => isVoteSpec(a, 'no'));
  const submit = all.find((a) => a.key === 'propose-change');
  const preview = all.find((a) => a.preview);
  const openApp = all.find((a) => a.key === 'open-app');
  const voteAction = yes && no ? <VoteButton yes={yes} no={no} /> : (submit ? <ActionButton a={submit} /> : null);
  const testAction = (preview || openApp || (v.testing.actions || []).length) ? (
    <>
      {(v.testing.actions || []).map((a) => <ActionButton key={a.key} a={a} />)}
      {/* A preview that did not start is the card's own words and its retry. */}
      {openApp ? <ActionButton a={openApp} />
        : (preview && !(v.testing.actions || []).some((a) => a.key === 'retry-preview') ? <ActionButton a={preview} /> : null)}
    </>
  ) : null;
  const thanks = v.thanks && id ? <span className="contents" data-kudos-host={id} data-kudos-face="thread"></span> : null;
  const issues = body.issues || [];
  const back = host('gc-thread-back');
  const bar = host('gc-thread-bar');
  return (
    <>
      {back ? createPortal(<TopicBack />, back) : null}
      {bar ? createPortal(<ChangeBar v={v} menuKey={card.rail?.menuKey || ''} />, bar) : null}
      {images.viewer}
      <article className="messages-message dev-request-root dev-change-root" data-change-root={id ?? ''}>
        <Avatar shape="square" size="sm" color={swatchFor(v.author)} aria-hidden="true">
          {(v.author || '?').charAt(0).toUpperCase()}
        </Avatar>
        <div className="min-w-0 flex-1" {...images.scope}>
          <div className="messages-message-head">
            <span className="messages-message-author">{v.author}</span>
            {v.time ? <time dateTime={v.at || undefined} title={v.timeTitle}>{v.time}</time> : null}
            {v.via ? <span className="dev-change-via">{`· ${v.via}`}</span> : null}
          </div>
          <h1 className="dev-request-title" data-change-title={id ?? ''}>
            <TitleContent t={card.title} />
          </h1>
          <ChangeDiagram value={body.diagram} />
          <RequestWords html={body.summaryHtml || ''} />
          {body.summaryMore ? <SummaryMore m={body.summaryMore} /> : null}
          {body.descriptionFold && body.proposalBody
            ? <ProposalBody b={body.proposalBody} label="Description" part="description" />
            : null}
          {body.summaryStale && body.summaryHtml
            ? <p className="dev-change-stale" role="note">Written for an earlier version of this change.</p>
            : null}
          {body.plan ? (
            <div className="messages-object-list dev-request-specs" data-change-plan={id ?? ''}>
              <SpecCard card={body.plan} />
            </div>
          ) : null}
          {body.includedIn ? <IncludedIn r={body.includedIn} /> : null}
          {id && (issues.length || body.canEditIssues || thanks) ? (
            <IssueAssociations
              proposalId={id}
              issues={issues}
              issueOptions={body.issueOptions || []}
              linkedIssues={linkedIssues}
              editable={body.canEditIssues === true}
              onSaved={onIssuesSaved}
              thread={{ thanks }}
            />
          ) : null}
          {body.note ? <p className="dev-change-stale">{body.note}</p> : null}
          <div className="dev-change-pair">
            <GateCard which="votes" g={v.votes} action={voteAction} id={id} />
            <GateCard which="testing" g={v.testing} action={testAction} id={id} />
          </div>
          {v.shots ? <ShotsCard s={v.shots} /> : null}
        </div>
      </article>
    </>
  );
}

/**
 * #4490: the change's diagram, leading its page above the description. A
 * Mermaid diagram that cannot be drawn says so in a muted line, with the
 * author's source one tap down, rather than leaving a hole.
 */
function ChangeDiagram({ value }: { value: unknown }): ReactNode {
  const d = useMemo(() => readDiagram(value), [value]);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [d]);
  if (!d) return null;
  if (failed && d.kind === 'mermaid') {
    return (
      <div className="dev-change-diagram-failed" data-change-diagram-failed="">
        <p>The author’s diagram could not be drawn.</p>
        <details>
          <summary>Show its text</summary>
          <pre>{d.source}</pre>
        </details>
      </div>
    );
  }
  return <Diagram d={d} source="author" onFail={() => setFailed(true)} className="dev-change-diagram" />;
}
