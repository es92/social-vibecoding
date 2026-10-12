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
import { TitleContent } from '../card/dev-card';
import type { RequestStatusView, RequestView } from './model';
import {
  STAGES,
  newestSpecVersion,
  openRequestSpec,
  requestStage,
  requestThreadStore,
  type RequestSpecCard,
} from './request-model';
import { requestShots, togglePinShot } from './request-shots';
import { TopicBack } from './topic-back';
import { saveIssueBody } from './topic-head';

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

/** The sheet's header: what this is, the category, and everything else behind ⋯. */
function RequestBar({ r }: { r: RequestView }): ReactNode {
  const t = useMessages('project');
  return (
    <header className="messages-thread-header">
      <div className="min-w-0 flex-1">
        <div className="messages-thread-name">{t('project:topic.request.bar.title', { number: r.number })}</div>
        {r.category ? <div className="messages-thread-sub" data-request-category="">{r.category}</div> : null}
      </div>
      {r.menuKey ? (
        <button
          type="button"
          className="messages-thread-action dev-card-menu-btn"
          data-card-menu={r.menuKey}
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
export function RequestWords({ html }: { html: string }): ReactNode {
  const t = useMessages('project');
  const text = useRef<HTMLDivElement>(null);
  // `t` is the language on screen's: a switch lifts the pictures again, so
  // their "Hide comment" buttons are in its words.
  const { words, shots } = useMemo(() => requestShots(html), [html, t]);
  // Memoised on the strings, so a re-render keeps the nodes, and with them
  // a comment someone hid.
  const inner = useInnerHtml(words);
  const shotsInner = useInnerHtml(shots);
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
  if (!words && !shots) return null;
  return (
    <div className="dev-request-ask" onClick={togglePin}>
      {/* DevChat.renderMarkdown's output, sanitised where it is built. The
          clamp class is React's; the fold writes the node's height only for
          the length of the animation, and puts the clamp back as it ends so
          React's next render agrees with the DOM. */}
      {words ? <div ref={text} className={`dev-request-ask-text${open ? '' : ' line-clamp-4'}`} data-request-words="" dangerouslySetInnerHTML={inner} /> : null}
      {words && (folds || open) ? (
        <button
          type="button"
          className="dev-ws-reveal dev-ws-reveal-start touch-target-32 dev-request-more"
          aria-expanded={shown}
          onClick={toggle}
        >
          <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
          {shown ? t('project:topic.request.words.showLess') : t('project:topic.request.words.showMore')}
        </button>
      ) : null}
      {shots ? <div className="dev-request-shots" data-request-shots="" dangerouslySetInnerHTML={shotsInner} /> : null}
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
function RequestStatus({ s, specs }: { s: RequestStatusView; specs: RequestSpecCard[] }): ReactNode {
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
      {s.closed ? null : (
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
        <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-semibold">{card.version ? t('project:topic.request.spec.kickerVersion', { version: card.version }) : t('project:topic.request.spec.kicker')}</div>
        <div className="text-base font-semibold text-zinc-900 dark:text-zinc-100 line-clamp-2">{card.title}</div>
        <div className="text-sm text-zinc-500 dark:text-zinc-400 truncate">
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

export function RequestHead({ r }: { r: RequestView }): ReactNode {
  const thread = useStoreState(requestThreadStore);
  const specs = thread.number === r.number ? thread.specs : [];
  const [editing, setEditing] = useState(false);
  const images = useInlineImageViewer();
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
  return (
    <>
      {back ? createPortal(<TopicBack />, back) : null}
      {bar ? createPortal(<RequestBar r={r} />, bar) : null}
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
            <TitleContent t={{ text: r.title, title: r.title, editing: r.titleEditing || undefined }} />
          </h1>
          {editing ? <RequestEditor r={r} onClose={() => setEditing(false)} /> : <RequestWords html={r.bodyHtml} />}
          <RequestStatus s={r.status} specs={specs} />
          {specs.length ? (
            <div className="messages-object-list dev-request-specs">
              {specs.map((card) => <SpecCard key={card.key} card={card} />)}
            </div>
          ) : null}
        </div>
      </article>
    </>
  );
}
