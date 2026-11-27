/**
 * #4453 — a request's page, drawn as the thread Messages opens beside a
 * message: the request is the root post, and its replies follow it in
 * `#gc-thread-messages` (../../group-chat/transcript.tsx, `RequestRows`).
 *
 * This is the head: everything the ISSUE ROW says. It renders into
 * `#gc-thread-head`, which the thread shell's request layout puts at the top
 * of its scroller, and portals two more pieces into that layout's other
 * empty hosts (../../group-chat/thread-shell.tsx `RequestShell`):
 *
 *   - `#gc-thread-back`: the "‹ Workshop" chip, above the sheet;
 *   - `#gc-thread-bar`: the sheet's header, "Request #N", the category in
 *     plain words, and the ⋯ disc. Its rows are the card menu's
 *     (`AppView._registerCardMenu`), so the disc carries `data-card-menu` and
 *     the document-level handler opens it, as a card's ⋯ does.
 *
 * Then, in the root post: who asked and when, the title, the request in its
 * own words as a quote folded at four lines, the card that says where it
 * stands, and one card per spec (`requestThreadStore`, which the stream
 * publishes, since the specs are posted in it).
 *
 * 31 Oct 2026: a plan a change was built from (the same session) is drawn
 * with that change, not in the list of plans (./thread-changes.tsx). And
 * the ⋯ lists the thread's own rows (./thread-menu.ts): Build it with your
 * own Claude Code, which opens its panel here, then Notify me / Mute and
 * the moves (./thread-items.tsx).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { reducedMotion } from '../../../lib/reduced-motion';
import type { FormEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useInnerHtml } from '../../../lib/html';
import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
import { useStoreState } from '../../../lib/use-store-state';
import { ISSUE_BODY_MAX } from '../../../lib/issue-body-limit';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/feed';
import { ChevronDownIcon, EllipsisHorizontalIcon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/textarea';
import { swatchFor } from '../../group-chat/swatch';
import { useInlineImageViewer } from '../../image-viewer/image-viewer';
import { ChangeTag, TitleContent } from '../card/dev-card';
import type { StatusPillState } from '../card/model';
import { normalizeBotTrack } from '../../messages/api';
import type { BotTrack } from '../../messages/types';
import { normalizeWorkState, type Standing, type WorkState } from '../../../lib/work-state';
import { TrackCard, trackClock, trackEyebrow, trackLinks } from '../../messages/bot-track';
import { RequestPlan } from './request-plan';
import type { RequestStatusView, RequestView } from './model';
import { TranslateNote, useTranslate } from '../../messages/translate';
import { ThreadHeadCard } from './thread-head';
import {
  STAGES,
  newestSpecVersion,
  openRequestSpec,
  publishRequestChanges,
  requestStage,
  requestThreadStore,
  type RequestSpecCard,
} from './request-model';
import { requestShots, togglePinShot } from './request-shots';
import { newestPlan, requestRail, type RailOpen } from './rail-model';
import { requestFoot } from './card-model';
import { closeStep, openStep, useLead, useOpenStep } from './step-store';
import { PlanWords, StepLayer, ThreadBarTile, ThreadCardContext, ThreadFoot, ThreadKicker, WordsBy, threadProjectName } from './thread-card';
import { ThreadExits, ThreadShowList } from './thread-exits';
import { ThreadItems, pageSlug, useThreadPayload } from './thread-items';
import { ThreadChanges, ChangeSectionSkeleton, letterOf } from './thread-changes';
import { ballotOf, requestPill, threadLayout, type ThreadHere } from './thread-model';
import { ThreadRail } from './thread-rail';
import { rereadOnChangeNews } from './change-detail-refresh';
import { TopicBack } from './topic-back';
import { saveIssueBody } from './topic-head';
import { OwnAgentLink } from './own-agent-link';
import { requestMenuKey, useThreadMenu } from './thread-menu';
import { holdTopInView, isVotesInViewAsked } from './votes-in-view';
import { usePanelHead } from '../../side-panel/head-store';
import { dotLine } from './topic-page';

function appView(): any {
  return typeof window !== 'undefined' ? (window as any).AppView : null;
}

function call(fn: string, args: unknown[] = []): void {
  const av = appView();
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

/**
 * A change's own section on its request's page, brought into view; a change
 * folded under the ballot is opened first.
 */
function showChangeSection(id: number): void {
  if (typeof document === 'undefined') return;
  const section = document.querySelector<HTMLElement>(`#gc-thread-head [data-thread-change="${id}"]`);
  if (!section) return;
  if (section.getAttribute('data-thread-fold') === 'shut') {
    section.querySelector<HTMLElement>(`[data-thread-fold-toggle="${id}"]`)?.click();
  }
  section.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** One of the layout's empty hosts, or null when the shell is not the request layout. */
function host(id: string): Element | null {
  return typeof document === 'undefined' ? null : document.getElementById(id);
}

/**
 * #6081: translated words as the markup RequestWords draws. The same
 * markdown renderer the request's own words go through, and the same wrapper
 * `_issueBodyHtml` gives them, so a translated request looks like the one it
 * replaces.
 */
function translatedWords(markdown: string): string {
  const renderer = typeof window !== 'undefined' ? window.PlatformMarkdown : null;
  if (!renderer?.render) {
    const escaped = markdown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    return `<div class="dev-issue-body">${escaped}</div>`;
  }
  const rendered = renderer.render(markdown, { images: true });
  const mentions = typeof window !== 'undefined' ? (window as any).renderRequestMentions : null;
  return `<div class="dev-issue-body">${mentions ? mentions(rendered) : rendered}</div>`;
}

/**
 * #6962: whether text carries any markdown worth rendering — a heading, a
 * list item, a quote, bold or italic, code, or a link. A single `*` used as
 * multiplication ("5 * 3") is not emphasis; emphasis needs a non-space after
 * its opening mark and a closing mark.
 */
export function hasMarkdown(text: string): boolean {
  if (!text) return false;
  return /^\s*(?:#{1,6} |[-*+] |> |\d+[.)] )/m.test(text)
    || /\*\*(?=\S)[\s\S]*?\S\*\*/.test(text)
    || /(?<![\w*])__(?=\S)[\s\S]*?\S__(?![\w_])/.test(text)
    || /(?:^|[^*\w])\*(?=\S)[^*\n]*?\S\*(?!\*)/.test(text)
    || /(?:^|[^_\w])_(?=\S)[^_\n]*?\S_(?![\w_])/.test(text)
    || /`[^`\n]+`/.test(text)
    || /\[[^\]\n]+\]\([^)\s]+\)/.test(text);
}

/**
 * Homeroom bot's summary, as the markup RequestWords draws. Text with
 * formatting goes through the same renderer the asker's words do (#6962), so
 * bold, lists and links read as such; plain text keeps its escaped,
 * paragraph-per-line markup unchanged.
 */
export function summaryWords(text: string): string {
  if (hasMarkdown(text)) return translatedWords(text);
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paragraphs = text.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((line) => `<p>${escape(line)}</p>`).join('');
  return `<div class="dev-issue-body">${paragraphs}</div>`;
}

/**
 * The sheet's header: what this is, the category, and everything else
 * behind ⋯. #6019: where the request's work stands rides beside its number,
 * as a change's status pill rides beside "Change #N" (./change-head.tsx
 * ChangeBar), once its thread is read (`pill`).
 */
export function RequestBar({ r, pill = null, threadMenu = false, title = null }: {
  r: RequestView;
  pill?: StatusPillState | null;
  /** The thread has ⋯ rows of its own (./thread-menu.ts): the ⋯ shows even when the request has none. */
  threadMenu?: boolean;
  /** #6081: the title as the page shows it, translated when the reader asked; the request's own otherwise. */
  title?: string | null;
}): ReactNode {
  const t = useMessages('project');
  // F18 (#5683): the bar names the request itself, under a small-caps line
  // that says its number and, once it is settled, how it ended.
  const kicker = r.status.closed
    ? t('project:topic.request.bar.kickerClosed', { number: r.number })
    : r.status.stage === 'voted'
      ? t('project:topic.request.bar.kickerDone', { number: r.number })
      : t('project:topic.request.bar.title', { number: r.number });
  // #6431: beside the Homeroom bot page this bar is not drawn at all (app.css),
  // and the column's heading carries its pill and its rows instead. Publishing
  // them is all this does there; nowhere else does it publish anything.
  const menuKey = r.menuKey || threadMenu ? requestMenuKey(r.menuKey, r.number) : null;
  // #7120: while a vote to close the request is open, the bar says so before
  // the title, so the page's head reads what the vote is about. The column
  // beside Homeroom bot's lists draws its title from this same report, since
  // app.css hides the bar's there.
  const base = title || r.title;
  const closing = pill?.key === 'close';
  const shown = closing ? t('project:topic.request.bar.closeTitle', { title: base }) : base;
  usePanelHead({ kind: 'request', pill, menuKey, title: closing ? shown : null });
  // 18 Nov 2026: the bar is the thread's head (app.css), as a change's is
  // (./change-head.tsx ChangeBar). 19 Nov 2026: a card that leads with the
  // request's title; the project, the topic, the number and the status are
  // the small line over it, which app.css lays out from these same nodes.
  // 20 Nov 2026: the card every thread page leads with (./thread-head.tsx),
  // measured and tightened as the thread scrolls.
  const where = dotLine([threadProjectName(), r.category]);
  return (
    <ThreadHeadCard
      lead={<ThreadShowList />}
      tile={<ThreadBarTile />}
      line={pill ? (
        <div className="flex min-w-0 items-center gap-2">
          <div className="messages-thread-kicker min-w-0" data-request-kicker="">{kicker}</div>
          <span className="shrink-0" data-request-status={pill.key}><ChangeTag s={pill} /></span>
        </div>
      ) : <div className="messages-thread-kicker" data-request-kicker="">{kicker}</div>}
      title={<div className="messages-thread-name line-clamp-2 dev-request-bar-title">{shown}</div>}
      sub={r.category
        ? <div className="messages-thread-sub" data-request-category="">{where}</div>
        : where ? <div className="messages-thread-sub">{where}</div> : null}
      menu={menuKey ? (
        <button
          type="button"
          className="messages-thread-action dev-card-menu-btn"
          data-card-menu={menuKey}
          aria-haspopup="true"
          aria-label={t('project:topic.request.bar.more')}
          title={t('project:topic.request.bar.more')}
        >
          <EllipsisHorizontalIcon aria-hidden="true" />
        </button>
      ) : null}
      exits={<ThreadExits />}
    />
  );
}

/** Whole sentences, one after another, as one short paragraph. */
export function sentences(parts: readonly (string | null | undefined | false)[]): string {
  const said = parts.filter((part): part is string => typeof part === 'string' && part !== '');
  if (!said.length) return '';
  return said.reduce((first, second) => translate('project:sentences.pair', { first, second }));
}

/** The curve the sheets move on, and how long the fold takes to open. */
const FOLD_MS = 240;
const FOLD_EASE = 'cubic-bezier(.32, .72, 0, 1)';

/**
 * The fewest lines a fold may hide. Folded, the words show four lines and a
 * "Show more" row under them; a fold that hid one or two lines would stand
 * as tall as the words whole and save nothing, so up to six lines show in
 * full and seven or more fold.
 */
export const FOLD_HIDES_AT_LEAST = 3;

/**
 * One line of the words, in pixels: their computed line height (24px in
 * the card look, 1.5 of the text's own size elsewhere). `normal` is read as
 * the 1.5 the words are set in.
 */
export function wordsLineHeight(style: { lineHeight: string; fontSize: string }): number {
  const lh = parseFloat(style.lineHeight);
  const fs = parseFloat(style.fontSize);
  // A unitless number is a multiple of the font size; a length ends in px.
  if (Number.isFinite(lh) && lh > 0) return /px$/.test(style.lineHeight.trim()) || !(fs > 0) ? lh : lh * fs;
  return Number.isFinite(fs) && fs > 0 ? fs * 1.5 : 0;
}

/**
 * Pure: does folding at four lines hide enough to be worth a "Show more"?
 * `hiddenPx` is what the fold leaves out (the words' whole height less
 * their folded height), `linePx` one line of them. A box with no layout yet
 * (a section that is shut) measures nothing and does not fold. A pixel of
 * slack absorbs the rounding of fractional line heights.
 */
export function foldHidesEnough(hiddenPx: number, linePx: number): boolean {
  if (!(linePx > 0) || !(hiddenPx > 0)) return false;
  return hiddenPx + 1 >= linePx * FOLD_HIDES_AT_LEAST;
}

/**
 * Measure the words both ways and say whether they fold, or null while
 * they have no box. Whole, the paragraphs' last margin falls outside the
 * box; folded, the clamp's box is its own block, so the gap between them is
 * the lines and paragraph breaks the fold would hide. The clamp class is put
 * back as React last rendered it before anything paints.
 */
function measureFold(el: HTMLElement): boolean | null {
  if (typeof window === 'undefined' || !el.getClientRects().length) return null;
  const had = el.classList.contains('line-clamp-4');
  if (had) el.classList.remove('line-clamp-4');
  const whole = el.getBoundingClientRect().height;
  el.classList.add('line-clamp-4');
  const folded = el.getBoundingClientRect().height;
  if (!had) el.classList.remove('line-clamp-4');
  return foldHidesEnough(whole - folded, wordsLineHeight(window.getComputedStyle(el)));
}

/**
 * The request's words, set apart as a quote and folded at four lines when
 * that hides three lines or more (FOLD_HIDES_AT_LEAST). "Show more" (the
 * hub's own reveal, `.dev-ws-reveal-start`) opens it by animating the text's
 * height between the fold and its full length; reduced motion snaps.
 * Whether there is enough to fold is measured before the first paint, and
 * again when the words or the column's width change, so words that fit in
 * six lines show whole, with no clamp and no control under them.
 *
 * Its screenshots (./request-shots.ts): a picture that carries a C
 * comment's pin shows the comment over it, with a button to hide it (#4482);
 * and the screenshots leave the fold and are always shown under it, so
 * "Show more" opens only the words (#4481).
 */
export function RequestWords({ html, translate, note }: {
  html: string;
  /** #6081: the Translate control that sits beside Show more, when the reader may ask. */
  translate?: ReactNode;
  /** The line under the words saying what happened, or how to go back. */
  note?: ReactNode;
}): ReactNode {
  const t = useMessages('project');
  const text = useRef<HTMLDivElement>(null);
  // `t` is the language on screen's: a switch lifts the pictures again, so
  // their "Hide comment" buttons are in its words.
  const { words, shots } = useMemo(() => requestShots(html), [html, t]);
  // Memoised on the strings, so a re-render keeps the nodes, and with them
  // a comment someone hid.
  const inner = useInnerHtml(words);
  const shotsInner = useInnerHtml(shots);
  // #6387: a picture or video keeps a fixed box (app.css) until it has its
  // own shape, so the cards under it do not jump as it loads. The nodes come
  // from `dangerouslySetInnerHTML`, which React does not reconcile, so the
  // attribute it writes is safe.
  const shotBox = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = shotBox.current;
    if (!box) return undefined;
    const cleanups: Array<() => void> = [];
    const settle = (el: Element, ready: () => boolean, events: string[]) => {
      if (ready()) { el.setAttribute('data-shot-ready', ''); return; }
      const done = () => {
        el.setAttribute('data-shot-ready', '');
        off();
      };
      const off = () => { for (const name of events) el.removeEventListener(name, done); };
      for (const name of events) el.addEventListener(name, done);
      cleanups.push(off);
    };
    for (const img of Array.from(box.querySelectorAll<HTMLImageElement>('img.dc-inline-img'))) {
      settle(img, () => img.complete && img.naturalWidth > 0, ['load', 'error']);
    }
    for (const video of Array.from(box.querySelectorAll<HTMLVideoElement>('video.dc-inline-video'))) {
      settle(video, () => video.readyState >= 1, ['loadedmetadata', 'error']);
    }
    return () => { for (const off of cleanups) off(); };
  }, [shots]);
  // `open` is what the clamp says; `shown` is what the button says, which
  // turns with the press rather than when the text has finished moving.
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  // null until measured: the first render keeps the clamp and draws no
  // control (the server's markup), and the layout effect settles it before
  // the first paint. false shows the words whole, with no clamp at all, so
  // no line is ever cut with an ellipsis that nothing opens.
  const [folds, setFolds] = useState<boolean | null>(null);
  const moving = useRef(false);
  useLayoutEffect(() => {
    const el = text.current;
    if (!el || open) return undefined;
    const measure = () => {
      if (moving.current) return;
      const next = measureFold(el);
      if (next !== null) setFolds(next);
    };
    measure();
    // The column's width decides how many lines the words take (a pane
    // resized, a phone turned, a shut section opened); a translation swaps
    // the words, which reruns this. The measure puts the clamp back as it
    // found it, so the observer sees no change of its own making.
    let width = el.getBoundingClientRect().width;
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      const now = el.getBoundingClientRect().width;
      if (now === width) return;
      width = now;
      measure();
    }) : null;
    watch?.observe(el);
    return () => watch?.disconnect();
  }, [words, open]);
  const toggle = () => {
    const el = text.current;
    if (!el || moving.current) return;
    const opening = !open;
    setShown(opening);
    if (reducedMotion()) { setOpen(opening); return; }
    moving.current = true;
    const from = el.getBoundingClientRect().height;
    // Measure the far end with the clamp off, then run from where it is.
    el.classList.remove('line-clamp-4');
    const to = opening ? el.scrollHeight : Number(el.dataset.folded || from);
    if (opening) el.dataset.folded = String(from);
    el.style.overflow = 'hidden';
    el.style.height = `${from}px`;
    el.getBoundingClientRect();
    el.style.transition = `height ${FOLD_MS}ms ${FOLD_EASE}`;
    el.style.height = `${to}px`;
    let timer = 0;
    const done = (event?: TransitionEvent) => {
      if (event && event.propertyName !== 'height') return;
      el.removeEventListener('transitionend', done);
      window.clearTimeout(timer);
      el.style.transition = '';
      el.style.height = '';
      el.style.overflow = '';
      moving.current = false;
      if (!opening) el.classList.add('line-clamp-4');
      setOpen(opening);
    };
    el.addEventListener('transitionend', done);
    // Settles even where the transition never runs (a hidden tab).
    timer = window.setTimeout(() => done(), FOLD_MS + 80);
  };
  // A picture's "Hide comment" is markup in the words, so its press is
  // taken here; claiming it keeps the image viewer's scope from acting on it.
  const togglePin = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (togglePinShot(event.target, event.currentTarget)) event.preventDefault();
  };
  if (!words && !shots && !translate && !note) return null;
  const showMore = words && (folds === true || open);
  const more = showMore ? (
    <button
      type="button"
      className="dev-ws-reveal dev-ws-reveal-start touch-target-32 dev-request-more"
      aria-expanded={shown}
      onClick={toggle}
    >
      <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
      {shown ? t('project:topic.request.words.showLess') : t('project:topic.request.words.showMore')}
    </button>
  ) : null;
  return (
    <div className="dev-request-ask" onClick={togglePin}>
      {/* PlatformMarkdown.render's output, sanitised where it is built. The
          clamp class is React's; the fold writes the node's height only for
          the length of the animation, and puts the clamp back as it ends so
          React's next render agrees with the DOM. Words that do not fold
          carry no clamp at all. */}
      {words ? <div ref={text} className={`dev-request-ask-text${open || folds === false ? '' : ' line-clamp-4'}`} data-request-words="" dangerouslySetInnerHTML={inner} /> : null}
      {translate ? <div className="mt-1 flex flex-wrap items-center gap-4">{more}{translate}</div> : more}
      {note}
      {shots ? <div ref={shotBox} className="dev-request-shots" data-request-shots="" dangerouslySetInnerHTML={shotsInner} /> : null}
    </div>
  );
}

/** The author's editor for the request's words, opened from ⋯ "Edit request". */
function RequestEditor({ r, onClose }: { r: RequestView; onClose: () => void }): ReactNode {
  const t = useMessages('project');
  const [draft, setDraft] = useState(r.editor.markdown);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const slug = appView()?.appData?.slug;
    if (!slug) { setError(t('project:topic.request.body.unavailable')); return; }
    setSaving(true);
    setError('');
    try {
      await saveIssueBody(slug, r.editor.issue, r.editor.source ? `${r.editor.source}\n\n${draft}` : draft);
      onClose();
      call('_renderTopicHead');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('project:topic.request.body.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="mt-2 space-y-3" data-issue-body-editor={r.editor.issue} onSubmit={save}>
      <Textarea
        id="dev-issue-body-input"
        aria-label={t('project:topic.request.editor.label')}
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
        <Button type="button" variant="pillNeutral" size="xsText" ink="neutral" onClick={onClose} disabled={saving}>{t('core:common.cancel')}</Button>
        <Button type="submit" variant="pillAccent" size="xsText" disabledStyle="dim" disabled={saving}>{saving ? t('project:topic.request.editor.saving') : t('core:common.save')}</Button>
      </div>
    </form>
  );
}

/**
 * One spec, at its newest version, as a shared item hangs off a message.
 * #4479: a change's page hangs the plan it was built from the same way
 * (./change-head.tsx).
 */
export function SpecCard({ card }: { card: RequestSpecCard }): ReactNode {
  const t = useMessages('project');
  const [loading, setLoading] = useState(false);
  return (
    <div className="messages-object-card dev-request-spec" data-request-spec={card.key}>
      <span className="messages-object-icon" aria-hidden="true">📋</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-semibold">{card.version
          ? t(card.ended === 'replaced' ? 'project:topic.request.spec.kickerReplaced'
            : card.ended === 'stopped' ? 'project:topic.request.spec.kickerStopped'
            : 'project:topic.request.spec.kickerVersion', { version: card.version })
          : t('project:topic.request.spec.kicker')}</div>
        <div className="text-base font-semibold text-zinc-900 dark:text-zinc-100 break-words">{card.title}</div>
        <div className="text-sm text-zinc-500 dark:text-zinc-400 break-words">
          {card.time ? (
            <RichMessage
              id={card.bySystem ? 'project:topic.request.spec.bySystemAt' : card.byUnknown ? 'project:topic.request.spec.bySomeoneAt' : 'project:topic.request.spec.byAt'}
              values={card.byUnknown || card.bySystem ? { time: card.time } : { author: card.by, time: card.time }}
              components={[<time dateTime={card.at || undefined} title={card.timeTitle} />]}
            />
          ) : card.bySystem ? t('project:topic.request.spec.bySystem') : card.byUnknown ? t('project:topic.request.spec.bySomeone') : t('project:topic.request.spec.by', { author: card.by })}
        </div>
      </div>
      <button
        type="button"
        className="dev-request-read"
        disabled={loading}
        aria-label={t('project:topic.request.spec.readNamed', { title: card.title })}
        onClick={async () => {
          setLoading(true);
          try { await openRequestSpec(card); } finally { setLoading(false); }
        }}
      >
        {loading ? t('project:topic.request.spec.opening') : t('project:topic.request.spec.read')}
      </button>
    </div>
  );
}

/**
 * Pure: which plans a change in the thread was built from, by that change's
 * session (a plan is posted on a session, and the session that carries it
 * out is the change), and the plans no change was built from yet, in
 * order. Every version of a built plan goes with its change; the newest is
 * the one shown. 1 Nov 2026 (C2.3): a change built from a plan posted on
 * another session (a person's plan, or the bot's own plan its requester
 * approved) names it (`builtFrom`), and goes with it too. The map is by
 * the change's id.
 */
export function plansByChange(
  specs: readonly RequestSpecCard[],
  changes: readonly { id: number; builtFrom?: { sessionId: number } | null }[],
): {
  plans: Map<number, RequestSpecCard>;
  unbuilt: RequestSpecCard[];
} {
  const changeOf = new Map<number, number>();
  for (const c of changes) {
    const from = c.builtFrom?.sessionId;
    if (from != null && !changeOf.has(from)) changeOf.set(from, c.id);
  }
  // A change's own session wins over a change built from it.
  for (const c of changes) changeOf.set(c.id, c.id);
  const plans = new Map<number, RequestSpecCard>();
  const unbuilt: RequestSpecCard[] = [];
  for (const card of specs) {
    const session = card.read.kind === 'shared' ? card.read.sessionId : null;
    const change = session != null ? changeOf.get(session) : undefined;
    if (change != null) {
      if (!plans.has(change)) plans.set(change, card);
    } else unbuilt.push(card);
  }
  return { plans, unbuilt };
}

/**
 * The foot of a request's card with no change built for it yet: where it
 * stands, said once, and its one action. It replaced the stepper and the
 * sentence box under the words and Homeroom bot's progress card, which the
 * timeline's last step now opens over the card.
 */
function RequestFoot({ s, specs, standing, yours, track, page, echo = '' }: {
  /** The page whose layer Read plan opens (./step-store.ts). */
  page: string;
  /** The note under the timeline's current step: a sentence it carries is not repeated here. */
  echo?: string;
  s: RequestStatusView;
  specs: RequestSpecCard[];
  standing: WorkState | null;
  yours: boolean;
  track: BotTrack | null;
}): ReactNode {
  const t = useMessages('project');
  const stage = requestStage(s.stage, specs.length);
  const foot = standing ? requestFoot(standing, yours) : null;
  const stageLabel = STAGES.find((step) => step.key === stage)?.label;
  const headline = s.closed
    ? t('core:work.stage.closed')
    : track ? trackEyebrow(track)
      : foot ? t(foot.headline.id, foot.headline.values) : stageLabel ? t(stageLabel) : '';
  const version = newestSpecVersion(specs);
  const specLine = stage === 'spec' && !s.botSays
    ? (version ? t('project:topic.request.status.specVersionReady', { version }) : t('project:topic.request.status.specReady'))
    : null;
  // The page's own sentence for where it is, when it has one; else the
  // server's line for the stage, else the plain one.
  const own = s.closed || sentences([s.lead, s.note || specLine]);
  const said = foot?.sub ? t(foot.sub.id, foot.sub.values) : '';
  // With Homeroom bot's progress known, the headline is its stage and try,
  // so the page's own "Building." would only repeat it.
  const picked = track && !s.closed ? (said || own) : (own || said);
  // A sentence that only repeats the headline ("Voted in" over "Voted in.") is left out.
  const plain = (text: string) => text.replace(/[.\s]+$/, '').toLowerCase();
  // 17 Nov 2026: nor one the timeline's current step says under its title,
  // which is where the explanation lives; the foot keeps the headline, the
  // clock and what there is to press.
  const said2 = plain(picked);
  const noted = plain(echo);
  const repeats = !!said2 && !!noted && (noted.includes(said2) || said2.includes(noted));
  const sub = said2 === plain(headline) || repeats ? '' : picked;
  const clock = track ? trackClock(track, new Date()) : null;
  // A button that only says Homeroom bot is busy is not something to press:
  // the headline and the timeline already say it.
  const a = s.action && !(s.action.disabled && foot?.busy) ? s.action : null;
  // The newest plan still standing, read over the card. The plan card that
  // hung under the words is the timeline's Planned step and this button.
  const plan = s.closed ? null : newestPlan(specs);
  return (
    <ThreadFoot
      what={s.closed ? 'closed' : foot?.key || stage}
      headline={headline}
      sub={dotLine([clock, sub]) || null}
      tone={s.closed ? 'muted' : foot?.tone || null}
      extra={s.fine ? <p className="dev-thread-foot-also" data-thread-foot-fine="">{s.fine}</p> : null}
    >
      {plan ? (
        <button type="button" className="gc-vote-btn" data-thread-foot-plan={plan.key} onClick={() => openStep(page, { kind: 'plan', key: plan.key })}>
          {t('project:topic.card.foot.readPlan')}
        </button>
      ) : null}
      {a ? (a.href ? (
        <a className="dev-request-primary" href={a.href} title={a.title}>{a.label}</a>
      ) : (
        <button
          type="button"
          className="dev-request-primary"
          title={a.title}
          disabled={!!a.disabled}
          data-act={a.act?.fn}
          onClick={() => { if (a.act) call(a.act.fn, a.act.args || []); }}
        >
          {a.label}
        </button>
      )) : null}
    </ThreadFoot>
  );
}

export function RequestHead({ r }: { r: RequestView }): ReactNode {
  const thread = useStoreState(requestThreadStore);
  const specs = thread.number === r.number ? thread.specs : [];
  const [editing, setEditing] = useState(false);
  const images = useInlineImageViewer();
  // #6081: the reader's language, asked for on a tap. The title and the words
  // are translated together so the pair reads as one; a request with no words
  // sends only its title.
  const t = useMessages('project');
  const myUsername = typeof window !== 'undefined' ? String((window as any).App?.user?.username || '') : '';
  const sources: string[] = [];
  const titleAt = r.title?.trim() && r.title.length <= 8000 ? sources.push(r.title) - 1 : -1;
  // The route takes at most 8000 characters per text; a longer body leaves
  // its title to be translated on its own rather than failing the pair.
  const bodyAt = r.bodyMarkdown?.trim() && r.bodyMarkdown.length <= 8000 ? sources.push(r.bodyMarkdown) - 1 : -1;
  const canTranslate = !!myUsername && !!r.asker && r.asker !== myUsername && sources.length > 0;
  const translation = useTranslate(sources, { enabled: canTranslate });
  const shownTitle = translation.state === 'shown' && titleAt >= 0 ? translation.texts[titleAt] : r.title;
  const shownBody = translation.state === 'shown' && bodyAt >= 0 ? translation.texts[bodyAt] : null;
  // Rendering markdown on every render would rebuild the body's nodes under a
  // reader who is just scrolling; the strings are the key, not the arrays.
  const bodyHtml = useMemo(() => (shownBody == null ? r.bodyHtml : translatedWords(shownBody)), [shownBody, r.bodyHtml]);
  // The card look shows Homeroom bot's summary of the thread once there is
  // one, in place of the asker's words, which the timeline's first step
  // still opens whole. Text with no formatting, drawn as paragraphs; text
  // with formatting, through the same renderer as the asker's words (#6962).
  const summary = r.summary?.text ? r.summary : null;
  const summaryHtml = useMemo(() => (summary ? summaryWords(summary.text) : ''), [summary]);
  // ⋯ "Edit request" asks for the editor by event, as a change page's
  // "Edit description" does: the menu's row is a closure in AppView.
  useEffect(() => {
    const open = (event: Event) => {
      if (Number((event as CustomEvent).detail) === r.number && r.editor.canEdit) setEditing(true);
    };
    window.addEventListener('request-body-edit', open);
    return () => window.removeEventListener('request-body-edit', open);
  }, [r.number, r.editor.canEdit]);
  const back = host('gc-thread-back');
  const bar = host('gc-thread-bar');
  const track = useMemo(() => (r.track ? normalizeBotTrack(r.track) : null), [r.track]);
  // #6019: the request's thread, read once for the page: its changes and a
  // vote to close follow the request under a rule (./thread-changes.tsx),
  // and the list under them names the rest.
  const slug = pageSlug();
  const here = useMemo<ThreadHere>(() => ({ type: 'request', id: r.number }), [r.number]);
  const threadRead = useThreadPayload(slug, r.number);
  const layout = useMemo(() => threadLayout(threadRead.data, here), [threadRead.data, here]);
  // #6387: the row says a change addresses this request, so while its thread
  // is still being read the page holds the change section's place instead of
  // drawing a status card that may contradict it ("needs 1 more yes" while a
  // check has failed) and swapping it out a moment later. #6604: the same
  // hold covers a request with no change yet — the plan card waits for the
  // thread, so the panel does not draw the plan and then replace it with a
  // change's line.
  const holding = !r.status.closed && threadRead.loading;
  // #6604: a thread opens at its top and stays there while its change's
  // pieces fill in below, unless a door asked for the Votes card — the
  // change's own, or the request's vote to close.
  const topHeld = useRef<number | null>(null);
  useEffect(() => {
    if (topHeld.current === r.number) return undefined;
    topHeld.current = r.number;
    if (isVotesInViewAsked(r.number)) return undefined;
    const closeId = layout.close ? layout.close.id : null;
    if (closeId != null && isVotesInViewAsked(`close:${closeId}`)) return undefined;
    if (typeof document === 'undefined') return undefined;
    // 24 Nov 2026 (mobile 04): nor when a door asked for one of its thread's
    // messages (the Homeroom bot tab's Reply on an @), which the thread
    // brings into view and holds there itself (group-chat.js revealInThread).
    if ((window as unknown as { GroupChat?: { threadRevealAsked?: () => boolean } }).GroupChat?.threadRevealAsked?.()) return undefined;
    return holdTopInView(document.getElementById('gc-thread-scroll'));
  }, [r.number, layout.close?.id]);
  // Once a change is built for it (or a vote to close it is open), the
  // change's own cards say where it stands, so the steps and the bot's track
  // give way to them; a closed request still says how it ended. A change
  // section held open while the thread loads counts the same way: its own
  // outline already says where things stand.
  const working = layout.changes.length > 0 || (!!layout.close && layout.close.status === 'open') || holding;
  // 11 Nov 2026 (one model): the pill draws the request's standing, as the
  // server stored and worded it (issue.standing; from an older server, the
  // track's own work state). A standing gone live never draws a vote, and a
  // build waiting its turn is Ready to build (thread-model.ts requestPill).
  // Its word and tone are the standing's, as its requester or anyone else
  // reads them; the thread's changes only add detail.
  const standing = useMemo(() => normalizeWorkState(r.standing) || track?.work || null, [r.standing, track]);
  const pill = requestPill(
    layout, r.status.closed ? 'closed' : standing, (id, values) => translate(id, values),
    (r.standing as { mine?: boolean } | null | undefined)?.mine !== false,
  );
  // A plan a change in the thread was built from goes with that change.
  const { plans } = useMemo(() => plansByChange(specs, layout.changes), [specs, layout.changes]);
  // 1 Nov 2026 (one page per thread): its changes' replies are in its one
  // discussion. The stream tags each with its change, and the chat hears
  // their live rows for this page too (GroupChat.setThreadMembers).
  const changeKey = layout.changes.map((c) => `${c.id}:${c.number ?? ''}:${c.state ?? ''}`).join(',');
  useEffect(() => {
    if (!threadRead.data) return;
    publishRequestChanges(r.number, layout.changes);
    (window as any).GroupChat?.setThreadMembers?.('issue', r.number, layout.changes.map((c) => c.id));
  }, [r.number, changeKey, !!threadRead.data]);
  // #6139: the pill and the line say whether a change underway has finished.
  const underwayKey = layout.changes.filter((c) => c.state === 'underway').map((c) => c.id).join(',');
  useEffect(() => rereadOnChangeNews(window, layout.changes, threadRead.reread, (window as any).SessionState), [underwayKey]);
  // #5987, 31 Oct 2026: Build it with your own Claude Code is a ⋯ row; it
  // opens its panel under the request.
  const agentSlug = r.slug || '';
  const ownAgent = !!(r.status.ownAgent && !r.status.closed && agentSlug && r.number);
  const [agentOpen, setAgentOpen] = useState(false);
  const menuKey = requestMenuKey(r.menuKey, r.number);
  useThreadMenu(menuKey, 'agent', [
    ...(ownAgent ? [{
      label: translate('project:topic.request.ownAgent.summary'),
      icon: 'generate',
      act: () => setAgentOpen(true),
    }] : []),
  ]);
  const threadMenu = ownAgent || !!threadRead.data?.follow;
  // "How it got here": the thread's big events, beside the card on a wide
  // page and under it on a narrow one (./thread-rail.tsx).
  const rail = host('gc-thread-rail');
  // The changes that compete are named by their letter on the ballot, in the
  // timeline as on the card ("Change A built").
  const letters = useMemo(() => {
    const ballot = threadRead.data ? ballotOf(threadRead.data, [r.number]) : null;
    return ballot && ballot.options.length ? new Map(ballot.options.map((o, i) => [o.id, letterOf(i)] as const)) : null;
  }, [threadRead.data, r.number]);
  // The request's one change, as its section published it (./step-store.ts):
  // the timeline then ends on the phase that change's foot shows.
  const lead = useLead(`request:${r.number}`);
  // An open ballot names itself in the timeline as it does in the foot, and
  // its rule is the last step's note.
  const ballotNow = useMemo(() => {
    const ballot = threadRead.data ? ballotOf(threadRead.data, [r.number]) : null;
    if (!ballot || !ballot.options.length) return null;
    const project = (typeof window !== 'undefined' && (window as any).AppView?.appData?.name) || '';
    return {
      count: ballot.options.length,
      about: ballot.close ? t('project:topic.thread.ballot.aboutClose', { project }) : t('project:topic.thread.ballot.about', { project }),
    };
  }, [threadRead.data, r.number, t]);
  const railSteps = useMemo(() => requestRail({
    asker: r.asker || null,
    askedAt: r.askedAt || null,
    specs,
    changes: layout.changes,
    standing,
    yours: (r.standing as { mine?: boolean } | null | undefined)?.mine !== false,
    words: !!r.bodyMarkdown?.trim(),
    track: !!track,
    letters,
    ballot: ballotNow,
    lead: r.status.closed ? null : lead,
  }), [r.asker, r.askedAt, r.bodyMarkdown, r.standing, r.status.closed, specs, layout.changes, standing, track, letters, ballotNow, lead]);
  // What the timeline's current step already says under its title: the foot
  // does not say it again.
  const nowNote = railSteps.find((step) => step.now)?.note || null;
  const echo = nowNote ? (typeof nowNote === 'string' ? nowNote : t(nowNote.id, nowNote.values)) : '';
  // The page draws the card the thread design agreed (./thread-card.tsx),
  // and a step of the timeline opens over it.
  const page = `request:${r.number}`;
  const openNow = useOpenStep(page);
  useEffect(() => closeStep, [page]);
  // One summary for the request and its one change, as the card credits it:
  // the change's own words are not said again under it.
  const covers = !editing && summary?.basis === 'change';
  const yours = (r.standing as { mine?: boolean } | null | undefined)?.mine !== false;
  // The request's own stored row, for the foot of its one change
  // (./thread-changes.tsx): the page is the request's, so that foot says
  // where the request stands, as the timeline's last step does (requestRail).
  // A closed request's page says how it ended; its change keeps its own foot.
  const row = useMemo<Standing | null>(
    () => (standing && !r.status.closed ? { ...standing, mine: yours } : null),
    [standing, r.status.closed, yours],
  );
  const cardContext = useMemo(() => ({ card: true, page, covers, row }), [page, covers, row]);
  const planOpen = openNow?.kind === 'plan' ? specs.find((card) => card.key === openNow.key) || null : null;
  /** One of the ballot's changes, which the card look opens over the card (./thread-changes.tsx LookedChange). */
  const competes = (id: number) => typeof document !== 'undefined' && !!document.querySelector(`#gc-thread-head [data-thread-look="${id}"]`);
  const openRail = (open: RailOpen) => {
    if (open.kind === 'request' || open.kind === 'plan' || open.kind === 'track') {
      openStep(page, open);
      return;
    }
    if (open.kind === 'checks' || open.kind === 'votes') {
      // A change on its own holds its votes and tests in a layer; one that
      // competes is voted on in the ballot, so the change itself is opened
      // over the card, where its tests are.
      const layer = typeof document === 'undefined' ? null : document.querySelector(`[data-thread-change="${open.changeId}"] [data-step-layer="gates"]`);
      if (layer) openStep(page, open);
      else if (competes(open.changeId)) openStep(page, { kind: 'change', changeId: open.changeId });
      else showChangeSection(open.changeId);
      return;
    }
    if (open.kind === 'change' && competes(open.changeId)) {
      openStep(page, open);
      return;
    }
    showChangeSection(open.changeId);
  };
  return (
    <>
      {back ? createPortal(<TopicBack />, back) : null}
      {bar ? createPortal(<RequestBar r={r} pill={pill} threadMenu={threadMenu} title={shownTitle} />, bar) : null}
      {rail ? createPortal(<ThreadRail steps={railSteps} onOpen={openRail} current={openNow} />, rail) : null}
      {images.viewer}
      <article className="messages-message dev-request-root dev-thread-card" data-ref-issue={r.number} data-request-root={r.number} data-thread-card="request">
        <Avatar shape="square" size="sm" color={swatchFor(r.asker)} aria-hidden="true">
          {(r.asker || '?').charAt(0).toUpperCase()}
        </Avatar>
        <div className="min-w-0 flex-1" {...images.scope}>
          <ThreadKicker kind="request" number={r.number} category={r.category} />
          <div className="messages-message-head">
            <span className="messages-message-author">{r.asker}</span>
            {r.askedTime ? <time dateTime={r.askedAt || undefined} title={r.askedTitle}>{r.askedTime}</time> : null}
          </div>
          <h1 className="dev-request-title" data-issue-title={r.number}>
            <TitleContent t={{ text: shownTitle, title: r.title, editing: r.titleEditing || undefined }} />
          </h1>
          {/* #6421: a request in a merged thread says which thread it is one of
              and opens its lead's page. */}
          {(() => {
            const held = threadRead.data?.thread;
            if (!slug || !held || Number(held.requests) <= 1 || held.number == null || held.number === r.number) return null;
            return (
              <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400" data-thread-part-of={held.number}>
                <RichMessage
                  id="project:topic.thread.page.partOf"
                  values={{ count: Number(held.requests), name: held.name || `#${held.number}` }}
                  components={[(
                    <a
                      key="lead"
                      href={`#app/${encodeURIComponent(slug)}/dev/issues/${held.number}`}
                      className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
                      data-thread-part-of-link={held.number}
                    />
                  )]}
                />
              </p>
            );
          })()}
          {r.similar && slug ? (
            <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400" data-request-twin={r.similar.number}>
              <RichMessage id="project:topic.request.twin" values={{ number: r.similar.number, title: r.similar.title }} components={[
                <a key="twin" className="font-semibold text-violet-700 hover:underline dark:text-violet-300" href={`#app/${encodeURIComponent(slug)}/dev/issues/${r.similar.number}`} />,
              ]} />
            </p>
          ) : null}
          {editing ? <RequestEditor r={r} onClose={() => setEditing(false)} /> : (
            // Homeroom bot's summary stands in for the asker's words, which
            // the timeline's first step opens whole.
            summary ? <RequestWords html={summaryHtml} /> : (
            <RequestWords
              html={bodyHtml}
              translate={!canTranslate || editing || (translation.state !== 'idle' && translation.state !== 'pending') ? null : (
                <button
                  type="button"
                  className="dev-ws-reveal dev-ws-reveal-start touch-target-32 dev-request-more"
                  onClick={translation.ask}
                  disabled={translation.state === 'pending'}
                >
                  {translation.state === 'pending' ? translate('messages:translate.pending') : t('project:topic.request.words.translate')}
                </button>
              )}
              note={!canTranslate || translation.state === 'idle' ? undefined : <TranslateNote view={translation} className="mt-1" />}
            />
            )
          )}
          {!editing && summary ? <WordsBy who="bot" basis={summary.basis} />
            : !editing && (r.bodyMarkdown?.trim() || r.bodyHtml) ? <WordsBy who="asker" name={r.asker || null} /> : null}
          {/* #6680: the viewer's own design thread, linked under the request's
              words (right after "Filed from a design thread…"), which opens it
              in the Homeroom bot column. Nobody else's read carries it, so no
              one else sees a hint that the thread exists. */}
          {!editing && r.fromThread ? (
            <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400" data-request-from-thread={r.fromThread.rootId}>
              <a
                className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
                href={`#homeroom-bot/thread/${r.fromThread.rootId}`}
              >
                {t('project:topic.request.fromThread')}
              </a>
              {/* Artifacts, stage 4: the design the plan was made from, running,
                  at the version the plan shows: for its author alone, as the
                  link above is. Everyone else sees the plan's own screens. */}
              {r.fromThread.designVersion ? (
                <>
                  <span aria-hidden="true"> · </span>
                  <a
                    className="font-semibold text-violet-700 hover:underline dark:text-violet-300"
                    href={`#homeroom-bot/thread/${r.fromThread.rootId}/design/${r.fromThread.designVersion}${r.fromThread.artifactId && r.fromThread.artifactId > 1 ? `?artifact=${r.fromThread.artifactId}` : ''}`}
                    data-request-design-door={r.fromThread.designVersion}
                  >
                    {t('project:topic.request.openDesign', { version: r.fromThread.designVersion })}
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          {/* #6207/#6210: Homeroom bot's plan, public, with Build it for any member. */}
          {working || r.status.closed || !slug ? null : <RequestPlan slug={slug} number={r.number} specs={specs} />}
          {ownAgent && agentOpen ? <OwnAgentLink slug={agentSlug} number={r.number} startOpen onClose={() => setAgentOpen(false)} /> : null}
          {track && !working ? (
            // Homeroom bot's progress card (16 Oct 2026, C4, V3) is the
            // content of the timeline's last step: kept in the page, opened
            // over the card. The foot below says the stage and its try.
            <StepLayer keep open={openNow?.kind === 'track'} name="track" title={trackEyebrow(track)} sub={t('project:topic.card.layer.trackSub')} onClose={closeStep}>
              <div className="dev-request-track" data-request-track={r.trackPending ? 'pending' : track.work.stage} inert={!!r.trackPending}>
                <TrackCard track={track} title={r.title} links={trackLinks(track, { request: false })} pictures />
              </div>
            </StepLayer>
          ) : null}
          {/* #6019: the changes and the vote to close in this request's
              thread, under a rule; then the rest of it as a list. */}
          <ThreadCardContext.Provider value={cardContext}>
            {threadRead.data ? (
              <ThreadChanges slug={slug} data={threadRead.data} number={r.number} changes={layout.changes} close={layout.close} plans={plans} onChanged={threadRead.reread} />
            ) : holding ? (
              <ChangeSectionSkeleton />
            ) : null}
          </ThreadCardContext.Provider>
          {/* The foot: where a request with no change yet stands, and its action. */}
          {!working || r.status.closed ? (
            <RequestFoot s={r.status} specs={specs} standing={r.status.closed ? null : standing} yours={yours} track={working ? null : track} page={page} echo={echo} />
          ) : null}
          {openNow?.kind === 'request' ? (
            <StepLayer open name="request" title={t('project:topic.rail.asked')} sub={r.asker ? t('project:topic.card.layer.requestSub', { name: r.asker }) : null} when={r.askedTime || null} onClose={closeStep}>
              <div className="dev-step-doc" data-step-request="" dangerouslySetInnerHTML={{ __html: r.bodyHtml || '' }} />
            </StepLayer>
          ) : null}
          {planOpen ? (
            <StepLayer open name="plan" title={planOpen.title || t('project:topic.rail.planned')} sub={planOpen.by && !planOpen.byUnknown && !planOpen.bySystem ? t('project:topic.card.layer.planBy', { name: planOpen.by }) : null} when={planOpen.time || null} onClose={closeStep}>
              <PlanWords plan={planOpen} />
            </StepLayer>
          ) : null}
          <ThreadItems slug={slug} number={r.number} here={here} payload={threadRead.data} items={layout.listed} onChanged={threadRead.reread} menuKey={menuKey} />
        </div>
      </article>
    </>
  );
}
