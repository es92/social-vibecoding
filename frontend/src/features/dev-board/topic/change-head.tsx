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
 *   - `#gc-thread-bar`: the sheet's header, "Change #N" and its status pill
 *     (the board card's, #5178), the category in plain words, and the ⋯
 *     disc, which holds everything that is not on the page
 *     (`AppView._topicCard`'s rows: the pull request, Share, Explore,
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
 *
 * 6 Nov 2026 (#6419): the pair stays caught under the sheet's header as the
 * reader scrolls, shrunk to one line each, until the change's own content
 * ends above the replies. It replaces the second Votes card that used to
 * appear there (#5725).
 *
 * An UPDATE (docs/plans/versions.md: a change a version was given by the
 * project it was made from, its original) adds two things: under the summary,
 * the From <original> card (what it brings from there, then "In <version>":
 * which of the version's own changes it keeps, and what it does to its data
 * and its outside connections, in words read off the diff); and under Votes
 * and Testing, "Not for your version?" with Skip this update, or, when it
 * clashes with the version's own changes, Ask Homeroom bot to fit it.
 */

import { createContext, forwardRef, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Html } from '../../../lib/html';
import { Diagram, readDiagram } from '../../../lib/diagram/diagram';
import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { listText, t as translate } from '../../../lib/i18n/runtime';
import { releaseSentence } from '../../../lib/release-eta';
import { useReleaseNow } from '../../../lib/use-release-now';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/feed';
import { CheckIcon, EllipsisHorizontalIcon, XIcon } from '@/components/ui/icons';
import { swatchFor } from '../../group-chat/swatch';
import { AppIconContent, appIconKind } from '../../apps/app-card-view';
import { askToFit, upstreamAction } from '../../versions/upstream';
import { useInlineImageViewer } from '../../image-viewer/image-viewer';
import { ActionButton, StatusPill, TitleContent, VoteButton, isVoteSpec } from '../card/dev-card';
import type { ActionSpec, DevCardModel } from '../card/model';
import type { ChangeGateView, ChangeMergeView, ChangeThreadView, ChangeUpstreamView, FixChecksView, TopicBody } from './model';
import { shortDate } from '../../../lib/timestamp';
import { changeRail, type RailOpen } from './rail-model';
import { changeFoot, changePhase, fixStanding, type ChangePhase } from './card-model';
import { closeStep, isGates, openStep, useOpenStep } from './step-store';
import { NoPicture, PlanWords, StepLayer, ThreadBarTile, ThreadCardContext, ThreadFoot, ThreadKicker, WordsBy, threadProjectName } from './thread-card';
import { ThreadExits } from './thread-exits';
import { askFix, useChecksExplanation } from './failed-checks';
import { RequestWords, SpecCard, sentences } from './request-head';
import { openRequestSpec } from './request-model';
import { TopicPageContext } from './topic-store';
import { ThreadItems, pageSlug } from './thread-items';
import type { ClosesRequest } from './thread-model';
import { changeMenuKey } from './thread-menu';
import { ThreadRail } from './thread-rail';
import { ThreadPicture } from './thread-picture';
import { usePanelHead } from '../../side-panel/head-store';
import { TopicBack } from './topic-back';
import { WorkWithBotButton } from './work-with-bot';
import { holdVotesInView, onVotesAsked, takeVotesInView } from './votes-in-view';
import { IncludedIn, IssueAssociations, ProposalBody, SummaryMore } from './topic-head';
import { isFrameSkin, useLiveSkin } from '../../../lib/skin';
import { useFramePage } from '../../frame/frame-page-store';
import { placeName } from '../workshop/places';
import { TopicFrameBy, TopicFrameHead, TopicFrameLabel, TopicFrameStatus } from './frame/topic-frame';
import { liveTally } from '../card/fold';
import { useSideStack } from './frame/side-stack';
import { dotLine, pillKind, topicBack } from './frame/topic-page';

function host(id: string): Element | null {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

/**
 * The sheet's header: what this is, its status, its category, and everything
 * else behind ⋯. When the change has a technical half (`detailsId`, the same
 * gate the ⋯ Details row uses), the title itself opens the Details sheet
 * (#5329): it looks as it always did, and underlines on hover.
 */
export function ChangeBar({ v, menuKey, detailsId = null, name = null }: {
  v: ChangeThreadView;
  menuKey: string;
  detailsId?: number | null;
  /** The change's own title, for the kit's head under one of the frame's looks. */
  name?: string | null;
}): ReactNode {
  const t = useMessages('project');
  const title = v.number ? t('project:topic.change.bar.titleNumbered', { number: v.number }) : t('project:topic.change.bar.title');
  // #6431: beside the Homeroom bot page this bar is not drawn at all (app.css),
  // and the column's heading carries its pill and its rows instead. Publishing
  // them is all this does there; nowhere else does it publish anything.
  usePanelHead({ kind: 'change', pill: v.status || null, menuKey: menuKey || null });
  // UNDER ONE OF THE FRAME'S LOOKS the page's head is the kit's (the tour's
  // s34): what it is in a small line over the change's title, with this menu.
  const frame = isFrameSkin(useLiveSkin());
  if (frame) return <TopicFrameHead title={name || title} over={dotLine([title, v.category])} menu={menuKey ? { key: menuKey, label: t('project:topic.change.bar.more') } : null} />;
  // 18 Nov 2026: the bar is the thread's header pill (app.css), on its own
  // page and in either panel alike. Its second line is the project, then the
  // topic, which the card's kicker said before.
  const project = threadProjectName();
  const where = dotLine([project, v.category]);
  return (
    <header className="messages-thread-header">
      <ThreadBarTile />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="messages-thread-name min-w-0">
            {detailsId ? (
              <button
                type="button"
                className="messages-thread-name-link"
                data-change-details-open=""
                onClick={() => (window as any).AppView?.openTechnicalDetails?.(detailsId)}
                aria-label={t('project:topic.change.bar.openDetails', { title })}
                title={t('project:topic.change.bar.openDetailsTitle')}
              >
                {title}
              </button>
            ) : title}
          </div>
          {v.status ? (
            <span className="shrink-0" data-change-status={v.status.key}>
              <StatusPill s={v.status} inline />
            </span>
          ) : null}
        </div>
        {v.category
          ? <div className="messages-thread-sub" data-change-category="">{where}</div>
          : where ? <div className="messages-thread-sub">{where}</div> : null}
      </div>
      {menuKey ? (
        <button
          type="button"
          className="messages-thread-action dev-card-menu-btn"
          data-card-menu={menuKey}
          aria-haspopup="true"
          aria-label={t('project:topic.change.bar.more')}
          title={t('project:topic.change.bar.more')}
        >
          <EllipsisHorizontalIcon aria-hidden="true" />
        </button>
      ) : null}
      <ThreadExits />
    </header>
  );
}

/**
 * A change's Votes and Testing cards are put away in the layer a step opens
 * over the card (./thread-card.tsx), and that layer is shut: the card's foot
 * holds their buttons, so the page offers each action once.
 */
const GatesShut = createContext(false);

/**
 * The Testing card's Fix it, for the change's author, with the re-run beside
 * it (./failed-checks.ts askFix): the author's thread with Homeroom bot
 * about the change.
 */
function FixRow({ fix, rerun }: { fix: FixChecksView; rerun: ReactNode }): ReactNode {
  const t = useMessages('project');
  // Put away in a shut layer, the card's foot offers Fix it instead.
  if (useContext(GatesShut)) return null;
  return (
    <div className="dev-change-gate-fix">
      <button
        type="button"
        className="gc-vote-btn gc-vote-btn-accent"
        data-change-fix-checks={fix.changeId}
        onClick={() => askFix(fix)}
      >
        {t('project:topic.change.gate.fix')}
      </button>
      {rerun}
    </div>
  );
}

/**
 * #6225: what a yes on a change would close, under its Votes card's tally:
 * every request the change closes, each a link to its page with its title and
 * filer. #6606: the line then says where its filer stands — nothing when it
 * is confirmed, "already closed", "its filer says this doesn't close it", or
 * that it is waiting for whoever filed it to agree. Only a line that is
 * waiting, seen by the person who filed it, carries Confirm. Five lines, then
 * one tap for the rest.
 */
function VoteCloses({ closes, id }: { closes: ClosesRequest[]; id: number | null }): ReactNode {
  const t = useMessages('project');
  const [open, setOpen] = useState(false);
  const [answered, setAnswered] = useState<number[]>([]);
  const [sending, setSending] = useState<number | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const shown = open || closes.length <= 5 ? closes : closes.slice(0, 5);
  const rest = closes.length - shown.length;
  const slug = (window as any).AppView?.appData?.slug || '';
  const linkClass = 'font-semibold text-violet-700 hover:underline dark:text-violet-300';
  const link = (n: number) => (
    <a href={slug ? `#app/${encodeURIComponent(slug)}/dev/issues/${n}` : `#${n}`} className={linkClass} />
  );
  async function confirm(n: number) {
    if (sending != null || !slug || id == null) return;
    setSending(n);
    setFailed(null);
    try {
      const res = await fetch(
        `/api/apps/${encodeURIComponent(slug)}/issues/${n}/changes/${id}/confirm-closing`,
        { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!res.ok) throw new Error(String(res.status));
      setAnswered((was) => (was.includes(n) ? was : [...was, n]));
    } catch {
      setFailed(n);
    } finally {
      setSending(null);
    }
  }
  return (
    <div
      className="col-span-full mt-2.5 border-t border-[color:var(--app-sheet-line)] pt-2 text-[13px] leading-normal text-zinc-500 dark:text-zinc-400"
      data-change-vote-closes={closes.length}
    >
      <p className="font-semibold text-zinc-700 dark:text-zinc-300">
        {t('project:topic.change.gate.closesHead', { count: closes.length })}
      </p>
      {shown.map((r) => {
        const confirmed = r.confirmed || answered.includes(r.number);
        const tail = r.closed
          ? t('project:topic.change.gate.closesClosed')
          : confirmed
            ? null
            : r.disputed
              ? t('project:topic.change.gate.closesDisputed')
              : r.waiting
                ? t('project:topic.change.gate.closesUnconfirmed')
                : null;
        return (
          <p
            key={r.number}
            // #6225: a hanging indent, so a long title wrapping on a phone stays
            // aligned after the "#number" link rather than under it.
            className="ps-[3.4em] -indent-[3.4em]"
            data-change-vote-closes-on={r.number}
            data-confirmed={confirmed ? 'true' : 'false'}
          >
            {r.title && r.by ? (
              <RichMessage
                id="project:topic.change.gate.closesLine"
                values={{ number: r.number, title: r.title, by: r.by }}
                components={[link(r.number)]}
              />
            ) : r.title ? (
              <RichMessage id="project:topic.change.gate.closesLineNoFiler" values={{ number: r.number, title: r.title }} components={[link(r.number)]} />
            ) : (
              <RichMessage id="project:topic.change.gate.closesLineUntitled" values={{ number: r.number }} components={[link(r.number)]} />
            )}
            {tail ? (
              <>{' · '}<span className="whitespace-nowrap font-semibold text-zinc-700 dark:text-zinc-300">{tail}</span></>
            ) : null}
            {!confirmed && !r.closed && !r.disputed && r.waiting && r.canConfirm ? (
              <>
                <Button
                  type="button"
                  variant="pillAccent"
                  size="sm"
                  className="align-middle ms-1"
                  disabled={sending === r.number}
                  data-change-vote-closes-confirm={r.number}
                  onClick={() => void confirm(r.number)}
                >
                  {t('project:topic.change.gate.closesConfirm')}
                </Button>
              </>
            ) : null}
            {failed === r.number ? (
              <>
                <span className="ms-1 text-[color:var(--state-blocked)]" role="alert">
                  {t('project:topic.thread.page.claimDisputeFailed')}
                </span>
              </>
            ) : null}
          </p>
        );
      })}
      {rest > 0 ? (
        <button
          type="button"
          className={linkClass}
          aria-expanded="false"
          data-change-vote-closes-more={rest}
          onClick={() => setOpen(true)}
        >
          {t('project:topic.change.gate.closesMore', { count: rest })}
        </button>
      ) : null}
    </div>
  );
}

/**
 * One card: its name and figure over its bar, its button beside them, and
 * one line under. A bar still moving is drawn in the lit ink; a finished
 * one is full and green, with a green check and figure (AGENTS.md: a
 * finished progress bar may be green).
 *
 * The Testing card whose checks failed says what went wrong in plain words
 * over that line (`explain`: the model's sentence once read, the failure's
 * own words until then), and offers its author Fix it with the re-run
 * beside it (`fix`, `rerun`).
 */
export function GateCard({ which, g, action, rerun = null, id, closes = [], line = false }: {
  which: 'votes' | 'testing' | 'merge'; g: ChangeGateView; action: ReactNode; rerun?: ReactNode; id: number | null; closes?: ClosesRequest[];
  /** #6615: one of the pair's one-line rows, drawn in the strip that floats under the sheet's header. */
  line?: boolean;
}): ReactNode {
  const t = useMessages('project');
  const open = () => (window as any).AppView?.openTechnicalDetails?.(id, 'checks');
  // A merge of Homeroom itself: when its release comes, counted down here
  // rather than frozen when the page was read.
  const now = useReleaseNow(g.release);
  const release = g.release ? releaseSentence(g.release, now) : null;
  const explanation = useChecksExplanation(g.explain);
  // What went wrong, over the line: the lead ("One of this change's checks
  // failed on its preview.") and the sentence, as one paragraph in the
  // card's own ink. The page the failing check opened rides at its end,
  // when the change's preview can reopen it.
  const why = g.explain ? sentences([...g.note, explanation || g.explain.fallback]) : '';
  const page = g.explain?.page || null;
  const openPage = () => {
    if (page) (window as any).AppView?.ensureStaging?.(id, page.stagingUrl, { path: page.path }, {});
  };
  // The note's sentences arrive worded (AppView._changeThreadView); the door
  // into Details rides at the paragraph's end, in one message with them.
  const lines = g.explain
    ? [g.authorNote, g.fix ? t('project:topic.change.gate.fixNote') : null]
    : (release ? [...g.note, t('project:topic.change.gate.release', { release })] : g.note);
  const note = sentences(lines);
  const door = <button type="button" className="dev-change-gate-link" onClick={open} />;
  // #6615: the strip's rows carry `data-change-gate-line` instead of
  // `data-change-gate`, so declared checks and `holdVotesInView` (which
  // queries `[data-change-gate="votes"]`) see only the cards in the page's
  // flow.
  return (
    <div
      className="dev-change-gate"
      data-change-gate={line ? undefined : which}
      data-change-gate-line={line ? which : undefined}
      data-done={g.done ? 'true' : 'false'}
      data-tone={g.tone}
      data-change-bot-fix={g.botFix || undefined}
      role="group"
      aria-label={g.name}
    >
      <div className="dev-change-gate-main">
        <div className="dev-change-gate-head">
          <span className="dev-change-gate-name">
            {g.done ? <CheckIcon className="dev-change-gate-check" aria-hidden="true" /> : null}
            {g.name}
          </span>
          <span className="dev-change-gate-figure" title={g.figure}>{g.figure}</span>
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
      {/* #3800: the vote's lines under the bar. */}
      {g.facts?.length ? (
        <div className="dev-change-gate-facts">
          {g.facts.map((fact) => (
            <p key={fact.key} data-change-vote-fact={fact.key} data-ask={fact.ask ? 'true' : undefined}>{fact.text}</p>
          ))}
        </div>
      ) : null}
      {/* #6225: what a yes would close, under the tally. */}
      {which === 'votes' && closes.length ? <VoteCloses closes={closes} id={id} /> : null}
      {why ? (
        <p className="dev-change-gate-why" data-change-gate-why={explanation ? 'explained' : 'own-words'}>
          {page ? `${why} ` : why}
          {page ? (
            <button type="button" className="dev-change-gate-link" data-change-gate-page="" onClick={openPage}>
              {t('project:topic.change.gate.openPage')}
            </button>
          ) : null}
        </p>
      ) : null}
      {g.mainFailure?.href ? (
        <p className="dev-change-gate-note">
          <a className="dev-change-gate-link" href={g.mainFailure.href} data-change-main-fix="">
            {g.mainFailure.label}
          </a>
        </p>
      ) : null}
      {g.fix ? <FixRow fix={g.fix} rerun={rerun} /> : null}
      {g.noteDetail ? (
        <details className="dev-change-gate-note" data-change-gate-explanation="">
          <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500" title={g.noteDetail}>
            {note}
          </summary>
          <p className="mt-2">{g.noteDetail}</p>
        </details>
      ) : note || (g.details && id) ? (
        <p className="dev-change-gate-note" data-change-release={release ? '' : undefined}>
          {g.details && id
            ? (note
              ? <RichMessage id="project:topic.change.gate.noteSeeFailed" values={{ note }} components={[door]} />
              : <button type="button" className="dev-change-gate-link" onClick={open}>{t('project:topic.change.gate.seeFailed')}</button>)
            : note}
        </p>
      ) : null}
      {/* #6284: the stopped bot's Try again sits under what failed and the
          line saying it stopped, as Re-run checks does beside Fix it. */}
      {g.botFix === 'stopped' && !g.fix && rerun ? (
        <div className="dev-change-gate-fix">{rerun}</div>
      ) : null}
    </div>
  );
}

/** #6563: how long a held merge may wait before the card calls it out. */
export const MERGE_WAIT_LONG_MS = 30 * 60 * 1000;
/** #6563: how often the times under the Merging card are worded again. */
export const MERGE_TICK_MS = 30 * 1000;

const minutesBetween = (fromIso: string | null, toMs: number): number | null => {
  if (!fromIso) return null;
  const at = Date.parse(fromIso);
  if (!Number.isFinite(at)) return null;
  return Math.floor((toMs - at) / 60000);
};

/**
 * #6563: the merge step, under Votes and Tested, while GitHub holds an
 * approved change's merge or it is under way. It reuses GateCard: the same
 * card, bar and grey line. Its one job is to say what the merge still waits
 * on, so it carries the last try and the next one, counted from the viewer's
 * own clock (a timer every MERGE_TICK_MS, started only in an effect so the
 * first render matches what the view holds) — except while GitHub's required
 * checks are still running (#6593), where those tries are bookkeeping and
 * only the note and the wait's length are said. A wait of MERGE_WAIT_LONG_MS
 * or more turns amber and says how long and what to do; GitHub's checks
 * failing again is red, with no times and no button.
 */
export function MergeCard({ g, id, line = false }: { g: ChangeMergeView; id: number | null; line?: boolean }): ReactNode {
  const t = useMessages('project');
  const wait = g.wait || null;
  const held = !!wait;
  const [, setTick] = useState(0);
  const now = Date.now();
  useEffect(() => {
    if (!held) return undefined;
    const timer = window.setInterval(() => setTick((n) => n + 1), MERGE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [held]);
  const triedMin = minutesBetween(wait?.triedAt || null, now);
  const retryAt = wait?.retryAt ? Date.parse(wait.retryAt) : NaN;
  // A retry time that is missing or already past reads "Trying again now."
  const nextMin = Number.isFinite(retryAt) && retryAt > now ? Math.max(1, Math.round((retryAt - now) / 60000)) : null;
  const waitedMin = minutesBetween(wait?.since || null, now);
  const long = wait?.since ? waitedMin != null && waitedMin * 60000 >= MERGE_WAIT_LONG_MS : false;
  const note = [...g.note];
  if (long) note.push(t('project:topic.change.gate.merge.long', { minutes: waitedMin ?? 0 }));
  // #6593: GitHub building and scanning the release images is a normal wait,
  // not a failed try. Homeroom's own tries are bookkeeping, so this hold
  // says nothing about them; a busy or refused merge still does.
  if (held && g.hold !== 'github_checks' && wait?.triedAt) {
    note.push(triedMin == null || triedMin < 1
      ? t('project:topic.change.gate.merge.triedJustNow')
      : t(triedMin === 1 ? 'project:topic.change.gate.merge.tried_one' : 'project:topic.change.gate.merge.tried_other', { count: triedMin }));
  }
  if (held && g.hold !== 'github_checks') {
    note.push(nextMin == null
      ? t('project:topic.change.gate.merge.nextNow')
      : t(nextMin === 1 ? 'project:topic.change.gate.merge.next_one' : 'project:topic.change.gate.merge.next_other', { count: nextMin }));
  }
  const shown: ChangeGateView = {
    ...g,
    figure: long ? t('project:topic.change.gate.merge.longFigure') : g.figure,
    tone: long ? 'warn' : g.tone,
    note,
  };
  return <GateCard which="merge" g={shown} action={null} id={id} line={line} />;
}

/**
 * A change whose code did not come across when Homeroom moved off GitHub
 * (`v.codeMissing`, src/services/code-missing.js): its branch is not on the
 * git host, so it cannot be built, tested or merged until it is back. Said
 * once, above Votes and Testing, as the project page says its own "code
 * changes are paused" (../board-frame.tsx CodePauseNotice): the same amber
 * notice. Votes still count, so the cards under it stay as they are.
 */
export function CodeMissingNotice(): ReactNode {
  const t = useMessages('project');
  return (
    <Alert variant="notice" density="compact" className="mt-3" data-change-code-missing="">
      <span>{t('project:topic.change.codeMissing')}</span>
    </Alert>
  );
}

/**
 * Where its pull request merges, when that is not main
 * (src/workflow/rules/pr-base.ts). Stacked on another open change's branch
 * (`v.waitsFor`): it goes live only after that change does, and the notice
 * names it, with a door to its page. Based on a branch no open change has
 * (`v.baseNotMain`): it says what a person does about it. Said once, above
 * Votes and Testing, as CodeMissingNotice is.
 */
export function StackNotice({ v }: { v: ChangeThreadView }): ReactNode {
  const t = useMessages('project');
  const w = v.waitsFor;
  if (w) {
    const door = (
      <a
        href={w.href}
        className="font-semibold underline"
        data-change-waits-for-link={w.sessionId}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          (window as any).AppView?.openTopic?.('proposal', w.sessionId);
        }}
      />
    );
    return (
      <Alert variant="notice" density="compact" className="mt-3" data-change-waits-for={w.sessionId}>
        <span>
          <RichMessage
            id={!w.number ? 'project:topic.change.waitsForUnnumbered'
              : w.title ? 'project:topic.change.waitsFor' : 'project:topic.change.waitsForUntitled'}
            values={{ number: w.number ?? '', title: w.title || '' }}
            components={[door]}
          />
        </span>
      </Alert>
    );
  }
  if (v.baseNotMain) {
    return (
      <Alert variant="notice" density="compact" className="mt-3" data-change-base-not-main="">
        <span>{t('project:topic.change.baseNotMain', { branch: v.baseNotMain.branch })}</span>
      </Alert>
    );
  }
  return null;
}

/** The Before and after card: the shots, or the line that says where they are. */
export function ShotsCard({ s, single = false, status = null }: {
  s: NonNullable<ChangeThreadView['shots']>;
  /** The card's picture: it opens on After alone, one picture with the switch, not side by side. */
  single?: boolean;
  /** The change's status key, for what the picture's two sides are called. */
  status?: string | null;
}): ReactNode {
  const t = useMessages('project');
  const box = useRef<HTMLElement>(null);
  const [tiles, setTiles] = useState<{ src: string; pick: string }[]>([]);
  const [at, setAt] = useState(0);
  const [legend, setLegend] = useState('');
  // The card's picture is the viewer the change's shots are drawn in, read
  // as one picture: it starts on After (the viewer's own start is side by
  // side where there is room), its screens are tiles under it, and the
  // legend of the screen showing sits beside them. The tiles and the legend
  // are read off the viewer's own markup, in its order, and a tile presses
  // the viewer's own screen pick; nothing is written into the viewer but
  // which of its radios is checked.
  useEffect(() => {
    const el = box.current;
    if (!single || s.state !== 'verified' || !el) { setTiles([]); setLegend(''); return undefined; }
    const auto = el.querySelector<HTMLInputElement>('.shots-side-auto:checked');
    const after = el.querySelector<HTMLInputElement>('.shots-side-after');
    if (auto && after) after.checked = true;
    const views = Array.from(el.querySelectorAll<HTMLElement>('.shots-view'));
    const picks = Array.from(el.querySelectorAll<HTMLInputElement>('.shots-screen-pick'));
    const read = () => {
      const index = Math.max(0, picks.findIndex((pick) => pick.checked));
      setAt(index);
      setLegend(views[index]?.querySelector('.shots-view-notes')?.innerHTML || '');
    };
    setTiles(views.length > 1 && picks.length === views.length
      ? views.map((view, i) => ({
        src: view.querySelector<HTMLImageElement>('.shots-flip-after img, .shots-flip-before img')?.getAttribute('src') || '',
        pick: picks[i].id,
      }))
      : []);
    read();
    el.addEventListener('change', read);
    return () => el.removeEventListener('change', read);
  }, [single, s.state, s.html]);
  const legendInner = useMemo(() => ({ __html: legend }), [legend]);
  // What each side of the one picture is for this change: what the app does
  // today and what it will do if the change passes; once live, what it did
  // and what it does now; closed, what was proposed. The viewer's own chip
  // says only "Before" or "After" (app.css draws these in its place).
  const chips = !single ? null
    : status === 'merged' || status === 'live' || status === 'deployed_reload' || status === 'merged_reload'
      ? { before: t('project:topic.card.shots.chipWas'), after: t('project:topic.card.shots.chipLive') }
      : status === 'closed' || status === 'archived'
        ? { before: t('project:topic.card.shots.chipToday'), after: t('project:topic.card.shots.chipProposed') }
        : { before: t('project:topic.card.shots.chipTodayBefore'), after: t('project:topic.card.shots.chipIfPasses') };
  const pickScreen = (id: string) => {
    const pick = box.current?.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`);
    if (!pick) return;
    pick.checked = true;
    pick.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // The previous version's shots (AppView._changeShotsView `previous`): the
  // picture stays, under a line that says whose it is and where this
  // version's stand.
  const previous = s.previous ? <PreviousShotsLine s={s} /> : null;
  // A run that worked out its screens is drawn with the Needs you page's
  // slider (./thread-picture.tsx); the viewer stays behind its Expand. A
  // change that is up for a vote keeps the slider's own words on each side.
  if (single && s.state === 'verified' && s.screens && s.screens.length) {
    const voting = !!chips && chips.after === t('project:topic.card.shots.chipIfPasses');
    if (previous) {
      return <div className="dev-change-shots-previous" data-change-shots="previous">{previous}<ThreadPicture s={s} captions={voting ? null : chips} /></div>;
    }
    return <ThreadPicture s={s} captions={voting ? null : chips} />;
  }
  if (s.state === 'verified') {
    return (
      <section
        ref={box}
        className="dev-change-shots"
        data-change-shots={s.previous ? 'previous' : 'verified'}
        data-thread-picture={single ? '' : undefined}
        data-thread-chips={chips ? '' : undefined}
        style={chips ? ({ '--thread-chip-after': JSON.stringify(chips.after), '--thread-chip-before': JSON.stringify(chips.before) } as CSSProperties) : undefined}
      >
        {previous}
        {/* AppView.shotsHtml's `thread` reading — escaped where it is built. */}
        <Html className="dev-change-shots-html" html={s.html} />
        {single && (tiles.length || legend) ? (
          <div className="dev-thread-tiles" data-thread-tiles={tiles.length}>
            {tiles.map((tile, i) => (
              <button
                key={tile.pick}
                type="button"
                className="dev-thread-tile"
                aria-pressed={i === at}
                aria-label={t('project:topic.card.shots.tile', { index: i + 1, total: tiles.length })}
                onClick={() => pickScreen(tile.pick)}
              >
                {tile.src ? <img src={tile.src} alt="" loading="lazy" decoding="async" /> : null}
              </button>
            ))}
            <div className="dev-thread-tiles-cap">
              {tiles.length ? <p className="dev-thread-tiles-count">{t('project:topic.card.shots.screenOf', { index: at + 1, total: tiles.length })}</p> : null}
              {legend ? <div className="dev-thread-tiles-legend shots-view-notes" dangerouslySetInnerHTML={legendInner} /> : null}
            </div>
          </div>
        ) : null}
      </section>
    );
  }
  return (
    <section className="dev-change-shots dev-change-shots-plain" data-change-shots={s.state} aria-label={t('project:topic.change.shots.title')}>
      <div className="dev-change-card-name">{t('project:topic.change.shots.title')}</div>
      {s.html ? <Html className="dev-change-shots-tiles usn-visuals-body" data-visuals-scope="1" html={s.html} /> : null}
      {s.line ? (
        <p className="dev-change-shots-line">
          {s.waiting ? <span className="dc-status-spinner-arc" aria-hidden="true"></span> : null}
          <span>{s.line}</span>
        </p>
      ) : null}
      {s.retake ? (
        <button
          type="button"
          className="gc-vote-btn"
          data-shots-retake="1"
          title={translate('changes:page.menu.takeShotsAgainTitle')}
          onClick={(e) => (window as any).AppView?.rerunShots?.(s.retake!, e.currentTarget)}
        >
          {translate('changes:shots.card.takeAgain')}
        </button>
      ) : null}
    </section>
  );
}

/**
 * Over the previous version's shots: they are the previous version's, and
 * this version's are being taken, or why it has none (its failure or skip,
 * as the card would say it), with the retake when this viewer may press it.
 */
export function PreviousShotsLine({ s }: { s: NonNullable<ChangeThreadView['shots']> }): ReactNode {
  const p = s.previous;
  if (!p) return null;
  return (
    <p className="dev-change-shots-line dev-change-shots-previous-line" data-shots-previous={p.state} role="status">
      {p.waiting ? <span className="dc-status-spinner-arc" aria-hidden="true"></span> : null}
      <span>{p.line}</span>
      {p.detail ? <span>{p.detail}</span> : null}
      {s.retake ? (
        <button
          type="button"
          className="gc-vote-btn"
          data-shots-retake="1"
          title={translate('changes:page.menu.takeShotsAgainTitle')}
          onClick={(e) => (window as any).AppView?.rerunShots?.(s.retake!, e.currentTarget)}
        >
          {translate('changes:shots.card.takeAgain')}
        </button>
      ) : null}
    </p>
  );
}

/**
 * The buttons on a change's two cards, from its card model: Yes and No (or
 * Propose) on Votes; Preview or Open app, the re-run and Fix it on Testing.
 */
function gateActions(card: DevCardModel, v: ChangeThreadView) {
  const all: ActionSpec[] = card.actions || [];
  const yes = all.find((a) => isVoteSpec(a, 'yes'));
  const no = all.find((a) => isVoteSpec(a, 'no'));
  const submit = all.find((a) => a.key === 'propose-change');
  const preview = all.find((a) => a.preview);
  const openApp = all.find((a) => a.key === 'open-app');
  const vote = yes && no ? <VoteButton yes={yes} no={no} /> : (submit ? <ActionButton a={submit} /> : null);
  // #6282: an update on its way holds the Vote button: a yes cast now is
  // cleared when it lands (the card's own note says so).
  const voteAction = v.votes.hold ? null : vote;
  // With Fix it on the card, the re-run sits beside it, under the line; the
  // card's corner keeps Preview.
  const testingActions = (v.testing.actions || []).map((a) => <ActionButton key={a.key} a={a} />);
  const withFix = !!v.testing.fix;
  // #6284: a stopped bot change offers Let it try again (and its re-run)
  // under the line that says the bot stopped, not above the reason, so the
  // card reads what failed, that it stopped, then the button.
  const stopped = v.testing.botFix === 'stopped';
  const testAction = (preview || openApp || (!withFix && !stopped && testingActions.length)) ? (
    <>
      {withFix || stopped ? null : testingActions}
      {/* A preview that did not start is the card's own words and its retry. */}
      {openApp ? <ActionButton a={openApp} />
        : (preview && !(v.testing.actions || []).some((a) => a.key === 'retry-preview') ? <ActionButton a={preview} /> : null)}
    </>
  ) : null;
  return { voteAction, testAction, withFix, testingActions, stopped };
}

/**
 * A change's Votes and Testing cards, one above the other, with their
 * buttons: its own page draws them under its summary, and #6019's request
 * page under each change in the request's thread (./thread-changes.tsx).
 * 1 Nov 2026: `ballot`, a change folded under the ballot that decides
 * between it and its rivals keeps its Votes card without its own Vote
 * button, so there is one way to vote.
 *
 * 6 Nov 2026 (#6419): on the change's own page this same pair stays caught
 * under the sheet's header as the reader scrolls. #6615 (11 Nov 2026): the
 * cards keep their full size where they are, and the one-line Votes and
 * Testing rows float under the header in a strip drawn outside the page's
 * flow, so nothing above or below the reader changes height when the strip
 * appears or goes (the first version shrank the pair in place and gave the
 * lost height back as a margin, which made the page jump while the change
 * updated). The zero-height sticky holder travels within the article's
 * content column, which ends with the change's own content, above the
 * replies, so the strip lets go there. The page that holds the pair decides
 * it: only the change's own article carries `dev-change-root`, so a change
 * section on a request's page draws the pair as before, and never a strip.
 */
export const ChangeGates = forwardRef<HTMLDivElement, {
  id: number | null; card: DevCardModel; v: ChangeThreadView; ballot?: boolean; closes?: ClosesRequest[];
}>(function ChangeGates({ id, card, v, ballot = false, closes = [] }, ref) {
  const t = useMessages('project');
  // Under the card look (./thread-card.tsx) a change that is voted on here,
  // not under a ballot, says where it stands in the card's foot, and this
  // pair is the content of the layer its steps open over the card: kept in
  // the page while the layer is shut, and never floating under the header.
  const thread = useContext(ThreadCardContext);
  const layer = thread.card && !ballot;
  const openNow = useOpenStep(thread.page);
  // Shut, the layer's cards carry no buttons: the foot has them, so the page
  // never offers the same action twice.
  const shut = layer && !isGates(openNow, id);
  const acts = gateActions(card, v);
  const { withFix, stopped } = acts;
  const voteAction = shut ? null : acts.voteAction;
  const testAction = shut ? null : acts.testAction;
  const testingActions = shut ? null : acts.testingActions;
  // Under one of the frame's looks, on the change's own page, each card's
  // name is the kit's label over it (app.css puts the name inside away).
  const frame = isFrameSkin(useLiveSkin());
  const pair = useRef<HTMLDivElement>(null);
  const mark = useRef<HTMLSpanElement>(null);
  const [stick, setStick] = useState(false);
  const [stuck, setStuck] = useState(false);
  const setPair = useCallback((node: HTMLDivElement | null) => {
    pair.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) (ref as { current: HTMLDivElement | null }).current = node;
  }, [ref]);
  // Only the change's own page holds the pair in `dev-change-root`; a change
  // section on a request's page does not, and keeps the pair as it was. Found
  // from the pair itself so every caller writes the same element.
  useEffect(() => {
    setStick(!!pair.current?.closest('.dev-change-root'));
  }, [id]);
  // Stuck is where the mark above the pair has left the top of the thread's
  // own scroller. The scroller is found from the mark itself, never by a
  // document-wide id: another pane can hold the same id (#4640). A browser
  // without an observer leaves the pair at full size and draws no strip.
  useEffect(() => {
    if (!stick || layer) return;
    const el = mark.current;
    const scroller = el ? el.closest<HTMLElement>('#gc-thread-scroll') : null;
    if (!el || !scroller || typeof IntersectionObserver !== 'function') return;
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      setStuck(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0));
    }, { root: scroller, rootMargin: '4px 0px 0px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [id, stick, layer]);
  const drawn = (
    <>
      {stick ? <span ref={mark} className="dev-change-pair-mark" aria-hidden="true" /> : null}
      {/* #6615: the one-line rows, out of the page's flow under the sheet's
          header. The holder is always here while the page is a change's own,
          so adding the strip to it never moves anything; its zero height
          keeps the page's scroll height the same whether the strip shows or
          not. */}
      {stick ? (
        <div className="dev-change-pair-float">
          {stuck ? (
            <div className="dev-change-pair" data-stuck="">
              <GateCard line which="votes" g={v.votes} action={ballot ? null : voteAction} id={id} />
              <GateCard line which="testing" g={v.testing} action={null} id={id} />
              {v.merge ? <MergeCard line g={v.merge} id={id} /> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div ref={setPair} className="dev-change-pair" data-stick={stick ? '' : undefined}>
        {frame && stick ? <TopicFrameLabel>{v.votes.name}</TopicFrameLabel> : null}
        <GateCard which="votes" g={v.votes} action={ballot ? null : voteAction} id={id} closes={closes} />
        {frame && stick ? <TopicFrameLabel>{v.testing.name}</TopicFrameLabel> : null}
        <GateCard which="testing" g={v.testing} action={testAction} rerun={withFix || stopped ? testingActions : null} id={id} />
        {/* #6563: the merge itself, while GitHub holds it or it is under way. */}
        {frame && stick && v.merge ? <TopicFrameLabel>{v.merge.name}</TopicFrameLabel> : null}
        {v.merge ? <MergeCard g={v.merge} id={id} /> : null}
      </div>
    </>
  );
  if (!layer) return drawn;
  return (
    <GatesShut.Provider value={shut}>
    <StepLayer
      keep
      open={isGates(openNow, id)}
      name="gates"
      title={openNow?.kind === 'checks'
        ? (v.checks && v.checks.failed ? t('project:topic.rail.testsFailed', { count: v.checks.failed }) : v.testing.name)
        : v.votes.name}
      sub={openNow?.kind === 'checks' ? t('project:topic.card.layer.checksSub') : t('project:topic.card.layer.votesSub')}
      onClose={closeStep}
    >
      {/* One step, one thing: the Tested step shows its tests, and the vote's
          step its votes (app.css puts the other card away while it is open).
          Shut, both stay in the page for the doors and the declared checks. */}
      <div data-gates-show={isGates(openNow, id) ? (openNow?.kind === 'checks' ? 'checks' : 'votes') : undefined}>
        {/* The tests, as counts and one row per failure. The Testing card
            stays in the page under it (app.css puts it away), for the doors
            that reach into it. */}
        {openNow?.kind === 'checks' && isGates(openNow, id) && v.checks ? (
          <ChecksSummary v={v} actions={<>{testingActions}{testAction}</>} />
        ) : null}
        {drawn}
      </div>
    </StepLayer>
    </GatesShut.Provider>
  );
});

/**
 * The foot of a change's card: where it stands, said once, with its action.
 * The headline and the line under it come from whichever of its votes, its
 * tests and its merge decides what happens next (./card-model.ts); the cards
 * themselves are a press away, in the layer the timeline's steps open
 * (`page` is the page whose layer that is, ./step-store.ts).
 */
/**
 * What a finished run of the change's tests came to, in the layer See what
 * failed (or See checks) opens: how many failed and passed as chips, each
 * failure as a row with its name and its own reason, the plain-words account
 * when there is one, and the run's actions.
 */
function ChecksSummary({ v, actions }: { v: ChangeThreadView; actions: ReactNode }): ReactNode {
  const t = useMessages('project');
  const explanation = useChecksExplanation(v.testing.explain);
  const c = v.checks;
  if (!c) return null;
  const why = c.failed ? (explanation || v.testing.explain?.fallback || '') : '';
  return (
    <div className="dev-checks-sum" data-checks-summary={c.failed ? 'failed' : 'passed'}>
      <p className="dev-thread-facts">
        {c.failed ? (
          <span className="dev-thread-fact" data-tone="bad"><XIcon className="h-3.5 w-3.5" aria-hidden="true" />{t('project:topic.card.checks.failed', { count: c.failed })}</span>
        ) : null}
        <span className="dev-thread-fact" data-tone="ok"><CheckIcon className="h-3.5 w-3.5" aria-hidden="true" />{t('project:topic.card.checks.passed', { count: c.passed })}</span>
      </p>
      {why ? <p className="dev-checks-why">{why}</p> : null}
      {c.fails.length ? (
        <ul className="dev-checks-rows">
          {c.fails.map((row) => (
            <li key={row.key} className="dev-checks-row" data-checks-row={row.advisory ? 'advisory' : 'failed'}>
              <b><XIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>{row.name}</span></b>
              {row.reason ? <span>{row.reason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="dev-checks-acts">{actions}</div>
    </div>
  );
}

/** The one phase a change is in (./card-model.ts), from its page's view. */
export function phaseOf(v: ChangeThreadView): ChangePhase {
  return changePhase({ status: v.status ? { key: v.status.key, label: v.status.label } : null, votes: v.votes, testing: v.testing, merge: v.merge || null });
}

export function ChangeFoot({ id, card, v, page, ballot = false, tail = null, float = false }: {
  id: number | null; card: DevCardModel; v: ChangeThreadView; page: string; ballot?: boolean;
  /** A quiet row at the foot's end, inside its band (the private suggestion). */
  tail?: ReactNode;
  /**
   * 18 Nov 2026: while the foot offers a vote, it rides under the header
   * pill once it has scrolled up behind it (./thread-card.tsx `FootFloat`).
   * Only the change's own page asks: a request's page can hold several.
   */
  float?: boolean;
}): ReactNode {
  const t = useMessages('project');
  const foot = changeFoot({ status: v.status ? { key: v.status.key, label: v.status.label, yes: v.status.yes, majority: v.status.majority } : null, votes: v.votes, testing: v.testing, merge: v.merge || null });
  const { voteAction, testAction, testingActions } = gateActions(card, v);
  const now = useReleaseNow(v.votes.release);
  const release = v.votes.release ? releaseSentence(v.votes.release, now) : null;
  const failed = foot.key === 'failed';
  // The line under the headline: short facts, then the card's own sentences.
  // The long account of what failed is in the layer See what failed opens,
  // and what an approved change waits on is the timeline's note.
  let lines = foot.sub;
  if (foot.gate === 'votes' && release) lines = [...lines, t('project:topic.change.gate.release', { release })];
  const facts = foot.facts.map((f) => (typeof f === 'string' ? f : t(f.id, f.values)));
  // "Live · Since Nov 14": the day it went live leads its line.
  if (foot.key === 'live' && v.liveAt) facts.unshift(t('project:topic.card.foot.since', { when: shortDate(v.liveAt) }));
  const see = (kind: 'checks' | 'votes') => { if (id != null) openStep(page, { kind, changeId: id }); };
  const tests = foot.gate === 'testing';
  // Settled by the group: nothing asks for a vote any more.
  const decided = foot.key === 'approved' || foot.key === 'merging' || foot.key === 'live' || foot.key === 'closed';
  // Short facts lead, a dot between them; the sentences follow.
  const line = (lead: string[], rest: string[]) => dotLine([...lead.map((f) => f.replace(/[.\s]+$/, '')), sentences(rest)]);
  // The Vote the foot offers, by the same rules as its buttons below: with
  // failed tests only while the viewer has one to cast, otherwise until the
  // group has settled it. A ballot votes for its changes elsewhere.
  const footVote = ballot ? null : (failed ? (v.votes.tone === 'ask' ? voteAction : null) : (decided ? null : voteAction));
  // Under the header the foot keeps its headline, its short facts on one
  // line, Preview and the Vote; the sentences and the rest stay in the card.
  const floating = float && footVote ? {
    sub: dotLine(facts.map((f) => f.replace(/[.\s]+$/, ''))) || null,
    actions: <>{failed ? null : testAction}{footVote}</>,
  } : null;
  return (
    <ThreadFoot
      what={foot.key}
      headline={foot.title ? t(foot.title.id, foot.title.values) : foot.headline}
      sub={line(facts, lines) || null}
      tone={foot.tone}
      progress={foot.progress}
      busy={foot.key === 'testing'}
      extra={tail}
      float={floating}
    >
      {tests ? (
        <button type="button" className="gc-vote-btn" data-thread-foot-see="checks" onClick={() => see('checks')}>
          {failed ? t('project:topic.rail.seeFailed') : t('project:topic.card.foot.seeProgress')}
        </button>
      ) : null}
      {/* Failed: See what failed, Vote when the viewer has one to cast, and
          the one action that moves it on (Fix it, else the re-run). Preview
          and the other re-run are in the layer, with what failed. */}
      {failed && !ballot && v.votes.tone === 'ask' ? voteAction : null}
      {failed && v.testing.fix ? (
        <span className="contents" data-thread-foot-next="">
          <button type="button" className="gc-vote-btn gc-vote-btn-accent" data-change-fix-checks={v.testing.fix.changeId} onClick={() => askFix(v.testing.fix!)}>
            {t('project:topic.change.gate.fix')}
          </button>
        </span>
      ) : null}
      {/* With no Fix it, or under a bot that stopped: the re-run. Otherwise
          it rides with Preview (gateActions). */}
      {failed && !v.testing.fix && testingActions.length ? <span className="contents" data-thread-foot-next="">{testingActions}</span> : null}
      {failed ? null : testAction}
      {/* Tests still running: the vote is open meanwhile, beside See progress. */}
      {failed || ballot || decided ? null : voteAction}
    </ThreadFoot>
  );
}

export function ChangeThreadHead({ id, card, body, v, linkedIssues, onIssuesSaved, threadNumber = null, threadAsChange = false }: {
  id: number | null;
  card: DevCardModel;
  body: TopicBody;
  v: ChangeThreadView;
  linkedIssues: number[];
  onIssuesSaved: (issues: number[]) => void;
  /** #6019: a number in the change's thread: its own pull request's, else its first request's. */
  threadNumber?: number | null;
  /** `threadNumber` is its own pull request's: its thread is read as the change's (a request may share it). */
  threadAsChange?: boolean;
}): ReactNode {
  const t = useMessages('project');
  // #6608: the thread list and the bot door read the project THIS page was
  // painted for (TopicPageContext), never whichever project the app last
  // loaded. `pageSlug()` is the fallback for the Workshop's own side panel
  // and older callers outside a painted head.
  const slug = useContext(TopicPageContext).slug || pageSlug();
  // Under one of the frame's looks the page tells the bar its trail (the
  // Workshop, then this change) and stands its status, votes and checks in
  // the context column beside its words (./frame/side-stack.ts).
  const frame = isFrameSkin(useLiveSkin());
  const trail = v.number ? t('project:topic.change.bar.titleNumbered', { number: v.number }) : t('project:topic.change.bar.title');
  useFramePage(frame ? [placeName('workshop'), trail] : null, topicBack);
  useSideStack(frame, `[data-change-root="${id ?? ''}"] > [data-image-viewer-scope]`, ['.dev-change-status', '.dev-change-pair']);
  const images = useInlineImageViewer();
  const thanks = v.thanks && id ? <span className="contents" data-kudos-host={id} data-kudos-face="thread"></span> : null;
  const issues = body.issues || [];
  const back = host('gc-thread-back');
  const bar = host('gc-thread-bar');
  // 31 Oct 2026: the ⋯ lists the thread's Notify me / Mute and moves
  // (./thread-items.tsx), so a signed-in viewer always has one.
  const signedIn = typeof window !== 'undefined' && !!(window as any).App?.user;
  const menuKey = card.rail?.menuKey || (signedIn ? changeMenuKey(null, id ?? null) : '');
  // Run four (13 Oct 2026): a door that sends someone to vote on this change
  // ("See the change", a vote's notification) opens it at the Votes card,
  // below the header, rather than at its title (./votes-in-view.ts).
  const pair = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let release: (() => void) | null = null;
    const show = () => {
      // Under the card look the vote is the card's foot, and the Votes card
      // is in the layer. Found from the pair itself, never by a
      // document-wide lookup: another pane can hold the same change (#4640).
      const card = pair.current?.closest('[data-thread-card]')?.querySelector<HTMLElement>('.dev-thread-foot')
        || pair.current?.querySelector<HTMLElement>('[data-change-gate="votes"]');
      if (!card || !takeVotesInView(id)) return;
      release?.();
      release = holdVotesInView(card);
    };
    show();
    const off = onVotesAsked(show);
    return () => { off(); release?.(); };
  }, [id]);
  // "How it got here": the change's big events, beside its card on a wide
  // page and under it on a narrow one (./thread-rail.tsx). The frame's looks
  // have their own context column, so they draw none.
  const rail = frame ? null : host('gc-thread-rail');
  const railSteps = useMemo(() => changeRail({
    id,
    author: v.author || null,
    at: v.at || null,
    plan: body.plan || null,
    testing: v.testing || null,
    status: v.status ? { key: v.status.key, label: v.status.label, yes: v.status.yes, majority: v.status.majority } : null,
    votes: v.votes || null,
    merge: v.merge || null,
    fixNote: v.testing?.authorNote || null,
    liveAt: v.liveAt || null,
  }), [id, v.author, v.at, body.plan, v.testing, v.status, v.votes, v.merge, v.liveAt]);
  // The standard look and the brand look draw the card the thread design
  // agreed (./thread-card.tsx): a kicker, the summary and whose words it is,
  // the picture, and a foot that says where it stands. A step of the
  // timeline opens over it.
  const cardLook = !frame;
  const page = `change:${id ?? ''}`;
  const openNow = useOpenStep(page);
  useEffect(() => closeStep, [page]);
  const openRail = (open: RailOpen) => {
    if (!cardLook) {
      if (open.kind === 'plan' && body.plan) void openRequestSpec(body.plan);
      else if (open.kind === 'checks') (window as any).AppView?.openTechnicalDetails?.(open.changeId);
      return;
    }
    openStep(page, open);
  };
  const cardContext = useMemo(() => ({ card: cardLook, page }), [cardLook, page]);
  // 1 Nov 2026: ask about it, or sketch a revision, privately. #6392: the
  // words say so, and the bot building or fixing it leaves this out.
  const workWithBot = (
    <WorkWithBotButton
      slug={slug}
      number={v.number}
      voting={!!v.votes.facts?.length}
      botAtWork={v.testing.botFix === 'fixing' || v.testing.botFix === 'queued'}
    />
  );
  return (
    <>
      {back ? createPortal(<TopicBack />, back) : null}
      {bar ? createPortal(<ChangeBar v={v} menuKey={menuKey} detailsId={id && body.changeId ? id : null} name={card.title.text || card.title.title || null} />, bar) : null}
      {rail ? createPortal(<ThreadRail steps={railSteps} onOpen={openRail} current={cardLook ? openNow : null} />, rail) : null}
      {images.viewer}
      <ThreadCardContext.Provider value={cardContext}>
      <article className={`messages-message dev-request-root dev-change-root${cardLook ? ' dev-thread-card' : ''}`} data-change-root={id ?? ''} data-thread-card={cardLook ? 'change' : undefined}>
        <Avatar shape="square" size="sm" color={swatchFor(v.author)} aria-hidden="true">
          {(v.author || '?').charAt(0).toUpperCase()}
        </Avatar>
        <div className="min-w-0 flex-1" {...images.scope}>
          {cardLook ? <ThreadKicker kind="change" number={v.number} category={v.category} /> : null}
          <div className="messages-message-head">
            <span className="messages-message-author">{v.author}</span>
            {v.time ? <time dateTime={v.at || undefined} title={v.timeTitle}>{v.time}</time> : null}
            {v.via ? <span className="dev-change-via">{`· ${v.via}`}</span> : null}
          </div>
          <h1 className="dev-request-title" data-change-title={id ?? ''}>
            <TitleContent t={card.title} />
          </h1>
          {/* Under a look: "The change" over its card, and who put it up
              and what built it at the card's top (the head above, which the
              kit's page puts away with the title). A change with a diagram
              says them on a line over the diagram. */}
          {frame ? <TopicFrameLabel>{t('project:frame.topic.theChange')}</TopicFrameLabel> : null}
          {frame ? <TopicFrameBy name={v.author} color={swatchFor(v.author)} line={dotLine([v.time, v.via])} title={v.timeTitle} at={v.at} /> : null}
          <ChangeDiagram value={body.diagram} />
          <RequestWords html={body.summaryHtml || ''} />
          {cardLook && body.summaryBy ? <WordsBy who={body.summaryBy} name={v.author || null} /> : null}
          {body.summaryMore ? <SummaryMore m={body.summaryMore} /> : null}
          {v.upstream ? <UpstreamCard u={v.upstream} /> : null}
          {body.descriptionFold && body.proposalBody
            ? <ProposalBody b={body.proposalBody} named="description" part="description" />
            : null}
          {body.summaryStale && body.summaryHtml
            ? <p className="dev-change-stale" role="note">{t('project:topic.change.summaryStale')}</p>
            : null}
          {body.plan && !cardLook ? (
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
          {/* #6019: the requests, other changes and votes in its thread. */}
          {id ? <ThreadItems slug={slug} number={threadNumber} asChange={threadAsChange} here={{ type: 'change', id }} menuKey={menuKey || null} /> : null}
          {body.note ? <p className="dev-change-stale">{body.note}</p> : null}
          {/* Under a look: where it stands, as a pill, leading the context
              column over Votes and Tested, with its final counted vote
              beside the word once live, as the standard bar's pill has it.
              No five-stop line: the standard page has none for a change. */}
          {frame && v.status ? (
            <div className="dev-change-status">
              <TopicFrameStatus label={t('project:frame.topic.status')} pill={{ word: dotLine([v.status.label, liveTally(v.status)?.text]), kind: pillKind(v.status, v.votes) }} />
            </div>
          ) : null}
          {v.codeMissing ? <CodeMissingNotice /> : null}
          {v.waitsFor || v.baseNotMain ? <StackNotice v={v} /> : null}
          <ChangeGates ref={pair} id={id} card={card} v={v} />
          {v.upstream ? <UpstreamDecline u={v.upstream} id={id} /> : null}
          {v.shots ? <ShotsCard s={v.shots} single={cardLook} status={v.status?.key || null} /> : null}
          {/* The card look: with nothing to picture it says so; then the foot,
              which says where it stands once. Votes and Testing above are the
              content of the layer their steps open, kept in the page. */}
          {cardLook && !v.shots ? <NoPicture none={!!v.shotsNone} phase={phaseOf(v)} stopped={fixStanding(v.testing) === 'stopped'} touches={v.touches} diagramLed={!!readDiagram(body.diagram)} /> : null}
          {/* The private suggestion rides at the foot's end, inside its band. */}
          {cardLook ? <ChangeFoot id={id} card={card} v={v} page={page} tail={workWithBot} float /> : null}
          {cardLook && body.plan && openNow?.kind === 'plan' ? (
            <StepLayer open name="plan" title={body.plan.title || t('project:topic.rail.planned')} sub={body.plan.by && !body.plan.byUnknown && !body.plan.bySystem ? t('project:topic.card.layer.planBy', { name: body.plan.by }) : null} when={body.plan.time || null} onClose={closeStep}>
              <PlanWords plan={body.plan} />
            </StepLayer>
          ) : null}
          {cardLook ? null : workWithBot}
        </div>
      </article>
      </ThreadCardContext.Provider>
    </>
  );
}

/**
 * #4490: the change's diagram, leading its page above the description. A
 * Mermaid diagram that cannot be drawn says so in a muted line, with the
 * author's source one tap down, rather than leaving a hole.
 */
function ChangeDiagram({ value }: { value: unknown }): ReactNode {
  const t = useMessages('project');
  const d = useMemo(() => readDiagram(value), [value]);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [d]);
  if (!d) return null;
  if (failed && d.kind === 'mermaid') {
    return (
      <div className="dev-change-diagram-failed" data-change-diagram-failed="">
        <p>{t('project:topic.change.diagram.failed')}</p>
        <details>
          <summary>{t('project:topic.change.diagram.showSource')}</summary>
          <pre>{d.source}</pre>
        </details>
      </div>
    );
  }
  return <Diagram d={d} source="author" onFail={() => setFailed(true)} className="dev-change-diagram" />;
}

/* ── Versions: an update from the original ───────────────────────────── */

/** The version this page is on, as the app view has it: its slug for the update's actions, its name for "In <version>". */
function thisVersion(): { slug: string; name: string } {
  const data = typeof window === 'undefined' ? null : (window as any).AppView?.appData;
  const slug = typeof data?.slug === 'string' ? data.slug : '';
  return { slug, name: (typeof data?.name === 'string' && data.name) || slug };
}

const names = (items: unknown): string[] => (Array.isArray(items) ? items.filter((x): x is string => typeof x === 'string' && !!x) : []);

/**
 * What an update brings, and what it does in this version, as the card's
 * lines: the original's change titles, then the version's own changes it
 * keeps, what it does to the data (tables it adds, or nothing, or what it
 * changes of what is there), its outside connections, any new key it needs,
 * and whether it starts using AI or storing files. Only what the diff says,
 * never the bot's words; a fact the server left out is left out. Pure, for
 * the tests.
 */
export function upstreamLines(u: ChangeUpstreamView | null | undefined): {
  brings: string[];
  here: Array<{ text: string; warn?: boolean }>;
} {
  if (!u) return { brings: [], here: [] };
  const brings = (Array.isArray(u.brings) ? u.brings : []).map((b) => (b && typeof b.title === 'string' ? b.title : '')).filter(Boolean);
  const here: Array<{ text: string; warn?: boolean }> = [];
  const keeps = u.keeps && typeof u.keeps === 'object' ? u.keeps : null;
  const kept = Math.max(0, Math.floor(Number(keeps?.count) || 0));
  const titles = names(keeps?.titles);
  if (titles.length && kept > titles.length) {
    here.push({ text: translate('project:topic.change.upstream.keepsMore', { titles: listText(titles), count: kept - titles.length }) });
  } else if (titles.length) {
    here.push({ text: translate('project:topic.change.upstream.keeps', { titles: listText(titles), count: titles.length }) });
  } else if (kept) {
    here.push({ text: translate('project:topic.change.upstream.keepsCount', { count: kept }) });
  }
  const facts = u.facts && typeof u.facts === 'object' ? u.facts : null;
  if (facts) {
    const tables = names(facts.tablesAdded);
    const destructive = names(facts.destructive);
    const hosts = names(facts.hostsAdded);
    const secrets = names(facts.secretsAdded);
    if (destructive.length) {
      here.push({ text: translate('project:topic.change.upstream.destructive', { items: listText(destructive) }), warn: true });
    } else if (tables.length) {
      here.push({ text: translate('project:topic.change.upstream.tables', { count: tables.length, names: listText(tables) }) });
    } else {
      here.push({ text: translate('project:topic.change.upstream.dataSame') });
    }
    here.push({
      text: hosts.length
        ? translate('project:topic.change.upstream.hosts', { count: hosts.length, hosts: listText(hosts) })
        : translate('project:topic.change.upstream.hostsNone'),
    });
    if (secrets.length) here.push({ text: translate('project:topic.change.upstream.secrets', { count: secrets.length, keys: listText(secrets) }) });
    if (facts.ai) here.push({ text: translate('project:topic.change.upstream.ai') });
    if (facts.storage) here.push({ text: translate('project:topic.change.upstream.storage') });
  }
  return { brings, here };
}

/**
 * FROM <ORIGINAL>: under an update's summary, a card on the request page's
 * own surface. The original's tile and name over how many of its changes
 * this brings; those changes, each with a check; then "In <this version>"
 * and what it does here. The original's name is a text child, never markup.
 */
export function UpstreamCard({ u }: { u: ChangeUpstreamView }): ReactNode {
  const t = useMessages('project');
  const from = u.from && typeof u.from === 'object' ? u.from : null;
  const project = (from && (from.name || from.slug)) || '';
  const { brings, here } = upstreamLines(u);
  if (!project) return null;
  const tile = { slug: from?.slug || '', name: project, icon_emoji: from?.emoji || null, icon_url: null };
  const version = thisVersion().name;
  return (
    <section className="dev-change-upstream" data-change-upstream={from?.slug || ''} aria-label={t('project:topic.change.upstream.from', { project })}>
      <div className="dev-change-upstream-head">
        <span className="app-icon-tile dev-change-upstream-tile" data-icon={appIconKind(tile)} aria-hidden="true">
          <AppIconContent app={tile} />
        </span>
        <span className="min-w-0">
          <span className="dev-change-upstream-name">{t('project:topic.change.upstream.from', { project })}</span>
          {brings.length ? (
            <span className="dev-change-upstream-sub">{t('project:topic.change.upstream.made', { count: brings.length })}</span>
          ) : null}
        </span>
      </div>
      {brings.length ? (
        <ul className="dev-change-upstream-list" data-change-upstream-brings="">
          {brings.map((line, i) => (
            <li key={`${i}:${line}`}><CheckIcon className="dev-change-upstream-glyph" aria-hidden="true" /><span>{line}</span></li>
          ))}
        </ul>
      ) : null}
      {here.length && version ? (
        <>
          <p className="dev-change-upstream-label">{t('project:topic.change.upstream.in', { project: version })}</p>
          <ul className="dev-change-upstream-list dev-change-upstream-here" data-change-upstream-here="">
            {here.map((line, i) => (
              <li key={`${i}:${line.text}`} className={line.warn ? 'dev-change-upstream-warn' : undefined}>
                <span className="dev-change-upstream-dot" aria-hidden="true" />
                <span>{line.text}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/**
 * NOT FOR YOUR VERSION?: under Votes and Testing, quieter than either. Skip
 * this update closes the change and moves the version past it without
 * touching its code (POST /api/apps/:slug/upstream/skip), after a question.
 * An update that clashes with the version's own changes (`needs_fit`) says
 * which files, and offers Ask Homeroom bot to fit it (…/upstream/fit, a
 * request the bot builds) beside Skip. Only while it is still up, and never
 * for a reader who cannot take part.
 */
export function UpstreamDecline({ u, id }: { u: ChangeUpstreamView; id: number | null }): ReactNode {
  const t = useMessages('project');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const state = u.state || 'open';
  const from = u.from && typeof u.from === 'object' ? u.from : null;
  const project = (from && (from.name || from.slug)) || '';
  const av = typeof window === 'undefined' ? null : (window as any).AppView;
  if (!project || av?.readOnly || (state !== 'open' && state !== 'needs_fit')) return null;
  const fit = state === 'needs_fit';
  const conflicts = names(u.conflicts);

  const refresh = () => {
    if (typeof av?._loadDevData === 'function') Promise.resolve(av._loadDevData()).catch(() => {});
    if (id) window.dispatchEvent(new CustomEvent('change-detail-refresh', { detail: Number(id) }));
  };
  const skip = async () => {
    const { slug } = thisVersion();
    if (busy || !slug) return;
    const ui = (window as any).PlatformUI;
    const go = ui && typeof ui.confirm === 'function'
      ? await ui.confirm({
        title: t('project:topic.change.upstream.skip.confirmTitle', { project }),
        message: t('project:topic.change.upstream.skip.confirmMessage'),
        confirmLabel: t('project:topic.change.upstream.skip.confirm'),
      })
      : true;
    if (!go) return;
    setBusy(true);
    setError('');
    try {
      await upstreamAction(slug, 'skip', {}, 'project:topic.change.upstream.skip.failed');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('project:topic.change.upstream.skip.failed'));
    } finally {
      setBusy(false);
    }
  };
  const askFit = async () => {
    const { slug } = thisVersion();
    if (busy || !slug) return;
    setBusy(true);
    setError('');
    try {
      setAsked((await askToFit(slug, 'project:topic.change.upstream.fit.failed')) || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('project:topic.change.upstream.fit.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dev-change-upstream-skip" data-change-upstream-skip={state}>
      <span className="min-w-0 flex-1">
        <span className="dev-change-upstream-skip-title">
          {fit ? t('project:topic.change.upstream.fit.title') : t('project:topic.change.upstream.skip.title')}
        </span>
        <span className="dev-change-upstream-skip-sub">
          {fit && conflicts.length
            ? t('project:topic.change.upstream.fit.sub', { count: conflicts.length, files: listText(conflicts) })
            : t('project:topic.change.upstream.skip.sub', { project })}
        </span>
        {asked !== null ? (
          <span className="dev-change-upstream-skip-sub" role="status">
            <RichMessage
              id="project:topic.change.upstream.fit.asked"
              components={[asked ? <a className="dev-ws-link" href={asked} /> : <span />]}
            />
          </span>
        ) : null}
        {error ? <span className="dev-change-upstream-skip-sub dev-change-upstream-warn" role="alert">{error}</span> : null}
      </span>
      <span className="dev-change-upstream-skip-actions">
        {fit && asked === null ? (
          <button type="button" className="dev-change-upstream-skip-btn dev-change-upstream-fit-btn un-touch-target" data-change-upstream-fit="" disabled={busy} onClick={() => { void askFit(); }}>
            {t('project:hub.update.fit')}
          </button>
        ) : null}
        <button type="button" className="dev-change-upstream-skip-btn un-touch-target" data-change-upstream-skip-btn="" disabled={busy} onClick={() => { void skip(); }}>
          {t('project:topic.change.upstream.skip.button')}
        </button>
      </span>
    </div>
  );
}
