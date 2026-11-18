/**
 * The pieces a thread's card is drawn from on a request's and a change's
 * page, under the standard look and the brand look (the frame's looks keep
 * their own page, ./frame/topic-frame.tsx):
 *
 *   - `ThreadKicker`: the project's icon and name, then "Request #N" or
 *     "Change #N", over the title. It replaces the author row and the number
 *     in the sheet's header, which app.css puts away on these pages.
 *   - `WordsBy`: the line under the card's words that says whose they are.
 *   - `ThreadFoot`: where the thread stands, in one headline and one line
 *     under it, with the action beside them (./card-model.ts).
 *   - `StepLayer`: a step of "How it got here" (./thread-rail.tsx), opened
 *     over the card. It lies over the card's content and never changes the
 *     card's height; × on its right, Escape, or a press on the dimmed card
 *     closes it (./step-store.ts).
 *   - `PlanWords` and `ShotsWait`: a plan's text for the layer, and the well
 *     that holds the picture's place before there is one.
 */

import { createContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode , type CSSProperties } from 'react';

import { SparklesIcon, XIcon } from '@/components/ui/icons';

import { useInnerHtml } from '../../../lib/html';
import { useMessages } from '../../../lib/i18n/react';
import { AppIconContent, appIconKind } from '../../apps/app-card-view';
import type { FootTone } from './card-model';
import { dotLine } from './frame/topic-page';
import type { RequestSpecCard } from './request-model';

/**
 * Whether the page draws the card (the standard look and the brand look), and
 * which page's layer a step opens (./step-store.ts). A request's page gives
 * it to the change sections under it (./thread-changes.tsx).
 */
export const ThreadCardContext = createContext<{
  card: boolean;
  page: string;
  /** The card's own summary was written from the request and its change, so the change's is not said twice. */
  covers?: boolean;
}>({ card: false, page: '' });

function appData(): { slug: string; name: string; icon_emoji: string | null; icon_url: string | null } | null {
  const data = typeof window === 'undefined' ? null : (window as any).AppView?.appData;
  if (!data || typeof data.slug !== 'string') return null;
  return {
    slug: data.slug,
    name: (typeof data.name === 'string' && data.name) || data.slug,
    icon_emoji: data.icon_emoji || null,
    icon_url: data.icon_url || null,
  };
}

/**
 * THE THREAD'S HEADER PILL (18 Nov 2026): the project's tile at the start of
 * the sheet's header, which now says what the card's kicker said (the
 * project, the number and the topic) on every surface that draws the thread.
 */
export function ThreadBarTile(): ReactNode {
  const app = appData();
  if (!app) return null;
  return (
    <span className="app-icon-tile dev-thread-bar-tile" data-icon={appIconKind(app as any)} aria-hidden="true">
      <AppIconContent app={app as any} />
    </span>
  );
}

/** The project's name for the header pill's second line, or null outside a project. */
export function threadProjectName(): string | null {
  return appData()?.name || null;
}

export function ThreadKicker({ kind, number, category = null }: {
  kind: 'request' | 'change'; number: number | null;
  /** The topic it is filed under, which used to sit on a row of its own above the card. */
  category?: string | null;
}): ReactNode {
  const t = useMessages('project');
  const app = appData();
  const what = kind === 'request'
    ? t('project:topic.request.bar.title', { number: number ?? '' })
    : number ? t('project:topic.change.bar.titleNumbered', { number }) : t('project:topic.change.bar.title');
  return (
    <p className="dev-thread-kicker" data-thread-kicker={kind}>
      {app ? (
        <span className="app-icon-tile dev-thread-kicker-tile" data-icon={appIconKind(app as any)} aria-hidden="true">
          <AppIconContent app={app as any} />
        </span>
      ) : null}
      <span className="min-w-0">
        {dotLine([app ? app.name : null, what, category])}
      </span>
    </p>
  );
}

/**
 * Whose words the card's summary is: the asker's own, a change's author's,
 * or Homeroom bot's. A request's summary by the bot says what it drew on
 * (`basis`): the request and its plan, its change, or its changes.
 */
export function WordsBy({ who, name = null, basis = null }: {
  who: 'asker' | 'author' | 'bot';
  name?: string | null;
  basis?: 'plan' | 'change' | 'changes' | null;
}): ReactNode {
  const t = useMessages('project');
  if (who !== 'bot' && !name) return null;
  const words = who === 'asker' ? t('project:topic.card.ownWords', { name })
    : who === 'author' ? t('project:topic.card.summaryBy', { name })
      : basis === 'plan' ? t('project:topic.card.summaryByBotPlan')
        : basis === 'change' ? t('project:topic.card.summaryByBotChange')
          : basis === 'changes' ? t('project:topic.card.summaryByBotChanges')
            : t('project:topic.card.summaryByBot');
  return (
    <p className="dev-thread-by" data-thread-by={who}>
      {who === 'bot' ? <SparklesIcon className="dev-thread-by-glyph" aria-hidden="true" /> : null}
      <span>{words}</span>
    </p>
  );
}

export function ThreadFoot({ what, headline, sub, tone = null, progress = null, busy = false, children = null, extra = null }: {
  /** For `data-thread-foot`: what the foot is saying. */
  what: string;
  headline: string;
  sub?: string | null;
  tone?: FootTone;
  /** 0 to 1 while something is running. */
  progress?: number | null;
  busy?: boolean;
  /** The actions, at the foot's end. */
  children?: ReactNode;
  /** A full-width row under the status and its actions. */
  extra?: ReactNode;
}): ReactNode {
  const pct = progress == null ? null : Math.round(Math.max(0, Math.min(1, progress)) * 100);
  // Whether the foot ends its card: nothing drawn follows it, at any level
  // up to the card. app.css runs the foot's band to the card's rounded end
  // then; with something under it (another change, the thread's list) the
  // band stops at its own line. Read after every render: what follows a foot
  // comes and goes with the thread's reads.
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    const card = el?.closest<HTMLElement>('[data-thread-card]');
    if (!el || !card) return;
    let end = true;
    for (let node: HTMLElement | null = el; node && node !== card && end; node = node.parentElement) {
      for (let next = node.nextElementSibling as HTMLElement | null; next; next = next.nextElementSibling as HTMLElement | null) {
        if (next.hidden || next.classList.contains('dev-step-layer')) continue;
        if (next.offsetHeight > 0) { end = false; break; }
      }
    }
    el.toggleAttribute('data-thread-foot-end', end);
  });
  return (
    <div ref={box} className="dev-thread-foot" data-thread-foot={what} data-thread-foot-tone={tone || undefined} role="group">
      <div className="dev-thread-foot-st" role="status">
        <b className="dev-thread-foot-head">{headline}</b>
        {sub ? <span className="dev-thread-foot-sub">{sub}</span> : null}
        {pct != null ? (
          <span className="dev-thread-foot-bar" data-busy={busy ? '' : undefined} aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
        ) : null}
      </div>
      {children ? <div className="dev-thread-foot-acts">{children}</div> : null}
      {extra ? <div className="dev-thread-foot-extra">{extra}</div> : null}
    </div>
  );
}

/**
 * A step's content over the card. `keep` leaves the content in the page while
 * the layer is shut (put away with `hidden`): a change's Votes and Testing
 * cards live here, and the page's declared checks and the doors that bring
 * the vote into view still find them.
 *
 * The card it lies over is its nearest `[data-thread-card]`, which app.css
 * makes its containing block. It is placed in the part of the card that is
 * on screen, centred there when it fits, and never over the card's kicker
 * and title: they say what the layer belongs to. Over a short card (a
 * request with two lines of words) it starts under the title and hangs past
 * the card's end.
 */
export function StepLayer({ open, keep = false, name, title, sub = null, when = null, mark = null, onClose, children }: {
  open: boolean;
  keep?: boolean;
  /** For `data-step-layer`: which step's content this is. */
  name: string;
  title: string;
  sub?: string | null;
  when?: string | null;
  /** The step's marker, as the timeline draws it. */
  mark?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  const t = useMessages('project');
  const box = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<{ top: number; max: number; floor: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setPlace(null); return undefined; }
    const el = box.current;
    const card = el?.closest<HTMLElement>('[data-thread-card]');
    if (!el || !card) return undefined;
    const fit = () => {
      const room = card.clientHeight;
      // The part of the card on screen: a tall card on a phone is mostly
      // out of view, and the layer belongs where the reader is looking.
      const rect = card.getBoundingClientRect();
      const scroller = card.closest<HTMLElement>('#gc-thread-scroll');
      const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: typeof window === 'undefined' ? 800 : window.innerHeight };
      // Under the title, which stays in view above the layer.
      const title = card.querySelector<HTMLElement>('.dev-request-title');
      const floor = title ? Math.max(8, Math.round(title.getBoundingClientRect().bottom - rect.top) + 8) : 8;
      const from = Math.min(Math.max(view.top - rect.top, floor), room);
      const to = Math.min(Math.max(view.bottom - rect.top, 0), room);
      const seen = Math.max(0, to - from);
      const left = room - floor;
      const max = Math.round(Math.max(200, Math.min(left >= 320 ? left - 8 : 600, view.bottom - view.top - 24)));
      el.style.maxHeight = `${max}px`;
      const height = el.offsetHeight;
      // Directly under the title, as the thread design drew it (17 Nov 2026:
      // it used to be centred in the part of the card on screen, which left
      // the card's words showing above it and ran it over the replies). A
      // reader who has scrolled past the title gets it where they are.
      const wanted = from > floor && seen >= height ? from + 8 : floor;
      const top = Math.round(Math.max(floor, Math.min(wanted, Math.max(floor, room - height - 8))));
      // The layer stays inside the card: a card shorter than the layer
      // grows to hold it while it is open.
      const need = top + height + 8;
      card.style.minHeight = need > room ? `${need}px` : card.style.minHeight;
      setPlace((was) => (was && was.top === top && was.max === max && was.floor === floor ? was : { top, max, floor }));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => { window.removeEventListener('resize', fit); card.style.minHeight = ''; };
  }, [open, children]);
  useEffect(() => {
    if (!open) return undefined;
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus({ preventScroll: true });
    // Pressed from a timeline that sits under the card (a narrow page), the
    // layer may be out of view: bring it in once it has its place.
    const frame = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(() => box.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }))
      : 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      if (frame && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey);
      if (before && typeof before.focus === 'function' && document.contains(before)) before.focus({ preventScroll: true });
    };
    // `onClose` is the store's, the same function every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open && !keep) return null;
  return (
    <div className="dev-step-layer" data-step-layer={name} data-open={open ? 'true' : 'false'} hidden={!open}
      // The scrim starts under the title, which stays as it was.
      style={place ? ({ '--step-floor': `${Math.max(0, place.floor - 6)}px` } as CSSProperties) : undefined}>
      <button type="button" className="dev-step-scrim" tabIndex={-1} aria-label={t('project:topic.card.layer.close')} onClick={onClose} />
      <div
        ref={box}
        className="dev-step-sheet"
        role="dialog"
        aria-label={title}
        style={place ? { top: `${place.top}px`, maxHeight: `${place.max}px` } : undefined}
      >
        <div className="dev-step-head">
          {mark}
          <div className="min-w-0 flex-1">
            <b className="dev-step-title">{title}</b>
            {sub ? <span className="dev-step-sub">{sub}</span> : null}
          </div>
          {when ? <span className="dev-step-when">{when}</span> : null}
          <button ref={close} type="button" className="dev-step-close" data-step-close="" aria-label={t('project:topic.card.layer.close')} onClick={onClose}>
            <XIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="dev-step-body">{children}</div>
      </div>
    </div>
  );
}

function demoQuery(): string {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

/** Markdown as the request's own words are drawn (the platform's renderer, which sanitises). */
export function markdownHtml(markdown: string): string {
  const renderer = typeof window !== 'undefined' ? (window as any).PlatformMarkdown : null;
  if (!renderer?.render) {
    const escaped = markdown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    return `<div class="dev-issue-body">${escaped}</div>`;
  }
  return `<div class="dev-issue-body">${renderer.render(markdown, { images: true })}</div>`;
}

/**
 * A plan's text, for the layer. A plan posted on Homeroom is read from its
 * session (the same read the reader beside the thread makes); the bot's
 * GitHub copy carries its own text.
 */
export function PlanWords({ plan }: { plan: RequestSpecCard }): ReactNode {
  const t = useMessages('project');
  const read = plan.read;
  const own = read.kind === 'text' ? markdownHtml(read.markdown || '') : null;
  const [state, setState] = useState<{ key: string; html: string | null; failed: boolean }>({ key: '', html: null, failed: false });
  const key = read.kind === 'shared' ? `${read.sessionId}:${read.version}` : '';
  useEffect(() => {
    if (read.kind !== 'shared') return undefined;
    let live = true;
    setState({ key, html: null, failed: false });
    fetch(`/api/sessions/${read.sessionId}/specs/${read.version}${demoQuery()}`, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data) => {
        if (!live) return;
        const spec = data?.spec || data || {};
        setState({ key, html: markdownHtml(String(spec.content || '')), failed: false });
      })
      .catch(() => { if (live) setState({ key, html: null, failed: true }); });
    return () => { live = false; };
    // `key` names the plan and its version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const html = own ?? (state.key === key ? state.html : null);
  const inner = useInnerHtml(html || '');
  if (html) return <div className="dev-step-doc" data-step-plan="" dangerouslySetInnerHTML={inner} />;
  return (
    <p className="dev-step-plain" role="status">
      {state.failed ? t('project:topic.card.layer.planFailed') : t('project:topic.card.layer.planLoading')}
    </p>
  );
}

/**
 * A change with no picture says why where the picture would be: nothing a
 * person can see changes, its tests have not passed yet (the screenshots
 * are taken after them), or this version never passed them. A change that
 * is past its tests with no picture says nothing: there is no reason to give.
 */
export function NoPicture({ none, phase, stopped }: { none: boolean; phase: string; stopped: boolean }): ReactNode {
  const t = useMessages('project');
  if (none) return <ShotsWait state="none" title={t('project:topic.card.shots.noneTitle')} text={t('project:topic.card.shots.noneText')} />;
  if (phase === 'testing') return <ShotsWait state="waiting" title={t('project:topic.card.shots.notYetTitle')} text={t('project:topic.card.shots.notYetText')} />;
  if (phase === 'failed') {
    return stopped
      ? <ShotsWait state="never" title={t('project:topic.card.shots.neverTitle')} text={t('project:topic.card.shots.neverText')} />
      : <ShotsWait state="waiting" title={t('project:topic.card.shots.notYetTitle')} text={t('project:topic.card.shots.notYetText')} />;
  }
  return null;
}

/** Where the picture will be, before there is one: a well with one line saying why. */
export function ShotsWait({ title, text, busy = false, state }: { title: string; text?: string | null; busy?: boolean; state: string }): ReactNode {
  return (
    <div className="dev-thread-wait" data-thread-wait={state} data-busy={busy ? '' : undefined}>
      <b>{title}</b>
      {text ? <span>{text}</span> : null}
    </div>
  );
}
