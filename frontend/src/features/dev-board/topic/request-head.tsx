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
import type { FormEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useInnerHtml } from '../../../lib/html';
import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
import { useStoreState } from '../../../lib/use-store-state';
import { ISSUE_BODY_MAX } from '../../../lib/issue-body-limit';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/feed';
import { CheckIcon, ChevronDownIcon, EllipsisHorizontalIcon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/textarea';
import { swatchFor } from '../../group-chat/swatch';
import { useInlineImageViewer } from '../../image-viewer/image-viewer';
import { StatusPill, TitleContent } from '../card/dev-card';
import type { StatusPillState } from '../card/model';
import { normalizeBotTrack } from '../../messages/api';
import { TrackCard, trackLinks } from '../../messages/bot-track';
import { RequestPlan } from './request-plan';
import type { RequestStatusView, RequestView } from './model';
import { TranslateNote, useTranslate } from '../../messages/translate';
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
import { ThreadItems, pageSlug, useThreadPayload } from './thread-items';
import { ThreadChanges, ChangeSectionSkeleton } from './thread-changes';
import { requestPill, threadLayout, type ThreadHere } from './thread-model';
import { rereadOnChangeNews } from './change-detail-refresh';
import { TopicBack } from './topic-back';
import { saveIssueBody } from './topic-head';
import { OwnAgentLink } from './own-agent-link';
import { requestMenuKey, useThreadMenu } from './thread-menu';
import { usePanelHead } from '../../side-panel/head-store';

function appView(): any {
  return typeof window !== 'undefined' ? (window as any).AppView : null;
}

function call(fn: string, args: unknown[] = []): void {
  const av = appView();
  if (av && typeof av[fn] === 'function') av[fn](...args);
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
  const devChat = typeof window !== 'undefined' ? (window as any).DevChat : null;
  if (!devChat?.renderMarkdown) {
    const escaped = markdown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    return `<div class="dev-issue-body">${escaped}</div>`;
  }
  const rendered = devChat.renderMarkdown(markdown, { images: true });
  const mentions = typeof window !== 'undefined' ? (window as any).renderRequestMentions : null;
  return `<div class="dev-issue-body">${mentions ? mentions(rendered) : rendered}</div>`;
}

/**
 * The sheet's header: what this is, the category, and everything else
 * behind ⋯. #6019: where the request's work stands rides beside its number,
 * as a change's status pill rides beside "Change #N" (./change-head.tsx
 * ChangeBar), once its thread is read (`pill`).
 */
export function RequestBar({ r, pill = null, threadMenu = false }: {
  r: RequestView;
  pill?: StatusPillState | null;
  /** The thread has ⋯ rows of its own (./thread-menu.ts): the ⋯ shows even when the request has none. */
  threadMenu?: boolean;
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
  usePanelHead({ kind: 'request', pill, menuKey });
  return (
    <header className="messages-thread-header">
      <div className="min-w-0 flex-1">
        {pill ? (
          <div className="flex min-w-0 items-center gap-2">
            <div className="messages-thread-kicker min-w-0" data-request-kicker="">{kicker}</div>
            <span className="shrink-0" data-request-status={pill.key}><StatusPill s={pill} inline /></span>
          </div>
        ) : <div className="messages-thread-kicker" data-request-kicker="">{kicker}</div>}
        <div className="messages-thread-name line-clamp-2 dev-request-bar-title">{r.title}</div>
        {r.category ? <div className="messages-thread-sub" data-request-category="">{r.category}</div> : null}
      </div>
      {menuKey ? (
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
    </header>
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

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The request's words, set apart as a quote and folded at four lines. "Show
 * more" (the hub's own reveal, `.dev-ws-reveal-start`) opens it by
 * animating the text's height between the fold and its full length; reduced
 * motion snaps. Whether there is anything to fold is measured, so a short
 * request has no control under it.
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
  const [folds, setFolds] = useState(false);
  const moving = useRef(false);
  useLayoutEffect(() => {
    const el = text.current;
    if (!el || open) return;
    // Clamped, it is shorter than its content exactly when it folds something.
    setFolds(el.scrollHeight > el.clientHeight + 1);
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
  const showMore = words && (folds || open);
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
      {/* DevChat.renderMarkdown's output, sanitised where it is built. The
          clamp class is React's; the fold writes the node's height only for
          the length of the animation, and puts the clamp back as it ends so
          React's next render agrees with the DOM. */}
      {words ? <div ref={text} className={`dev-request-ask-text${open ? '' : ' line-clamp-4'}`} data-request-words="" dangerouslySetInnerHTML={inner} /> : null}
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
 * Where the request stands: Asked, Spec, Built, Voted in, with the stop it
 * is at marked; one sentence; the claim's lapse in small words; and the one
 * thing this viewer would do next. A step already done gets no fill.
 */
function RequestStatus({ s, specs, tracked = false }: {
  s: RequestStatusView;
  specs: RequestSpecCard[];
  /** Homeroom bot's track card follows, with its own steps (TrackBar): one
      row of steps on the page, not two that disagree (polish board #12). */
  tracked?: boolean;
}): ReactNode {
  const t = useMessages('project');
  const stage = requestStage(s.stage, specs.length);
  const at = STAGES.findIndex((step) => step.key === stage);
  // Voted in is the end: every stop is done.
  const done = stage === 'voted';
  const version = newestSpecVersion(specs);
  // Homeroom bot's plan says what it is waiting for in the sentence itself.
  const specLine = stage === 'spec' && !s.botSays
    ? (version ? t('project:topic.request.status.specVersionReady', { version }) : t('project:topic.request.status.specReady'))
    : null;
  const say = sentences([s.lead, s.note || specLine]);
  const a = s.action;
  return (
    <div className="dev-request-status" role="group" aria-label={t('project:topic.request.status.label')} data-request-stage={stage}>
      {s.closed || tracked ? null : (
        <ol className="dev-request-steps">
          {STAGES.map((step, i) => {
            const state = done || i < at ? 'done' : i === at ? 'now' : 'next';
            return (
              <li key={step.key} className="dev-request-step" data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
                <span className="dev-request-step-mark">{state === 'done' ? <CheckIcon aria-hidden="true" /> : null}</span>
                <span className="dev-request-step-label">{t(step.label)}</span>
              </li>
            );
          })}
        </ol>
      )}
      {s.closed || say ? <p className="dev-request-say">{s.closed || say}</p> : null}
      {s.fine ? <p className="dev-request-fine">{s.fine}</p> : null}
      {a ? (
        <div className="dev-request-actions">
          {a.href ? (
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
          )}
        </div>
      ) : null}
    </div>
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
  // check has failed) and swapping it out a moment later.
  const holding = !r.status.closed && !!r.status.changeExpected && threadRead.loading;
  // Once a change is built for it (or a vote to close it is open), the
  // change's own cards say where it stands, so the steps and the bot's track
  // give way to them; a closed request still says how it ended. A change
  // section held open while the thread loads counts the same way: its own
  // outline already says where things stand.
  const working = layout.changes.length > 0 || (!!layout.close && layout.close.status === 'open') || holding;
  // #6532: a build waiting its turn reads Ready to build, as the progress
  // card under the bar does, never Being built.
  const stand = useMemo(() => {
    if (r.status.closed) return 'closed';
    if (!track) return null;
    const code = track.work.line?.code;
    if (track.work.stage === 'building' && !track.busy
      && (code === 'queued' || code === 'held_builds' || code === 'held_waiting')) return 'ready_to_build';
    return track.work.stage;
  }, [track, r.status.closed]);
  const pill = requestPill(layout, stand, (id) => translate(id));
  // A plan a change in the thread was built from goes with that change.
  const { plans, unbuilt } = useMemo(() => plansByChange(specs, layout.changes), [specs, layout.changes]);
  // 1 Nov 2026 (one page per thread): its changes' replies are in its one
  // discussion. The stream tags each with its change, and the chat hears
  // their live rows for this page too (GroupChat.setThreadMembers).
  const changeKey = layout.changes.map((c) => `${c.id}:${c.number ?? ''}`).join(',');
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
  // 1 Nov 2026: Build it now left the face for Work on this with Homeroom
  // bot, and is the row beside it here, as an agent session.
  const agentSession = !!(r.status.agentSession && !r.status.closed && r.number);
  useThreadMenu(menuKey, 'agent', [
    ...(agentSession ? [{
      label: translate('project:topic.request.agentSession.summary'),
      icon: 'generate',
      act: () => call('chooseIssueWork', [r.number]),
    }] : []),
    ...(ownAgent ? [{
      label: translate('project:topic.request.ownAgent.summary'),
      icon: 'generate',
      act: () => setAgentOpen(true),
    }] : []),
  ]);
  const threadMenu = ownAgent || agentSession || !!threadRead.data?.follow;
  return (
    <>
      {back ? createPortal(<TopicBack />, back) : null}
      {bar ? createPortal(<RequestBar r={r} pill={pill} threadMenu={threadMenu} />, bar) : null}
      {images.viewer}
      <article className="messages-message dev-request-root" data-ref-issue={r.number} data-request-root={r.number}>
        <Avatar shape="square" size="sm" color={swatchFor(r.asker)} aria-hidden="true">
          {(r.asker || '?').charAt(0).toUpperCase()}
        </Avatar>
        <div className="min-w-0 flex-1" {...images.scope}>
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
          {editing ? <RequestEditor r={r} onClose={() => setEditing(false)} /> : (
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
          )}
          {working && !r.status.closed ? null : (
            <RequestStatus s={r.status} specs={specs} tracked={!!track} />
          )}
          {/* #6207/#6210: Homeroom bot's plan, public, with Build it for any member. */}
          {working || r.status.closed || !slug ? null : <RequestPlan slug={slug} number={r.number} specs={specs} />}
          {ownAgent && agentOpen ? <OwnAgentLink slug={agentSlug} number={r.number} startOpen onClose={() => setAgentOpen(false)} /> : null}
          {track && !working ? (
            // 16 Oct 2026 (C4, V3): the same card a request's thread leads
            // with, where it is and why, its bar and its pictures, in place
            // of having to open the chat to find out. Drawn from the board's
            // older row it holds its place unseen (`trackPending`, app.css),
            // and says where the work is once the fresh row lands.
            <div className="dev-request-track" data-request-track={r.trackPending ? 'pending' : track.work.stage} inert={!!r.trackPending}>
              <TrackCard track={track} title={r.title} links={trackLinks(track, { request: false })} pictures />
            </div>
          ) : null}
          {unbuilt.length ? (
            <div className="messages-object-list dev-request-specs">
              {unbuilt.map((card) => <SpecCard key={card.key} card={card} />)}
            </div>
          ) : null}
          {/* #6019: the changes and the vote to close in this request's
              thread, under a rule; then the rest of it as a list. */}
          {threadRead.data ? (
            <ThreadChanges slug={slug} data={threadRead.data} number={r.number} changes={layout.changes} close={layout.close} plans={plans} onChanged={threadRead.reread} />
          ) : holding ? (
            <ChangeSectionSkeleton />
          ) : null}
          <ThreadItems slug={slug} number={r.number} here={here} payload={threadRead.data} items={layout.listed} onChanged={threadRead.reread} menuKey={menuKey} />
        </div>
      </article>
    </>
  );
}
