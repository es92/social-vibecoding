/**
 * #platform-side-panel — the panel beside a running app, on a desktop-width
 * window. ./controller.ts carries the whole of why and how; this is its
 * markup.
 *
 * ── The first render is the prerender, exactly ────────────────────────
 *
 * The store is at its initial state at hydration — closed, no frame, no
 * title — and nothing writes it before App.init has run. So this renders the
 * same markup the static document carries: the root hidden, the header row's
 * four controls with Back hidden, an empty title and an empty body. The
 * `hidden` classes are CONSTANT in the rendered className and toggled through
 * refs (lib/legacy-dom.ts useHiddenClass), never derived from the store in
 * render — the rule every island in this shell keeps.
 *
 * ── The frame ──────────────────────────────────────────────────────────
 *
 * The <iframe> exists only while there is a panel document (`frameSrc`), and
 * it is created ONCE per panel: keyed by `frameKey`, its `src` constant for
 * its whole life. Every later page is a navigation INSIDE it (the controller
 * talks to its document), because a new `src` would be a reload. It is the
 * body's first child and the spinner the second, so the spinner coming and
 * going can never move it.
 *
 * ── The header row ─────────────────────────────────────────────────────
 *
 * Back, the page's title, Expand, Close — the shell's own Button primitive
 * and glyphs, in the header's disc style (the app header's ✕ is the same
 * disc), so the row reads as the platform's rather than as the page's.
 *
 * ── Beside the AI tab's page: that page's own column (29 Oct 2026) ─────
 *
 * There the panel is in Main's place, the chat docked beside the list, and
 * is drawn as that column rather than as a panel of its own (Evan: "not in
 * a new side panel that can be maximized and has its own Workshop back
 * button"): the project the page is in, which opens it, the page's own name,
 * its ⋯ and a ×, which closes it; no title, Expand, Close, Back or divider,
 * and the page in it leaves out its own "‹ Workshop" (controller
 * BESIDE_AI_CLASS). Closing it gives the lists back, or a private thread
 * when one was open behind it (6 Nov 2026, #6425: the × replaced a back
 * chip).
 * Both rows are always rendered and app.css shows the one that applies
 * (`body:has(#ai-screen:not(.hidden))`), so the prerender is one markup.
 *
 * ── The divider (#2886) ────────────────────────────────────────────────
 *
 * The panel's left edge is a handle: drag it (or focus it and use the arrow
 * keys) to share the window differently between the app and the panel, and
 * double-click it to go back to the default. ./resize.ts carries the width's
 * rules. Its first render is the prerender too — no width, no value — and
 * the stored width is read in an effect, never in render.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { Button } from '@/components/ui/button';
import { ChevronLeftIcon, EllipsisHorizontalIcon, ExpandIcon, XIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useMenuKeyboard } from '../../lib/menu-keys';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { pageLinkFor } from '../ai/door';
import { StatusPill } from '../dev-board/card/dev-card';
import type { StatusPillState } from '../dev-board/card/model';
import { copyToClipboard } from '../message-actions/clipboard';
import { useDismiss } from '../message-actions/use-dismiss';
import { SidePanel as controller, type PanelMenuRow } from './controller';
import { panelPage, samePage, titleFor, workshopItemOf } from './routes';
import {
  AI_MAIN_WIDTH_KEY,
  KEY_STEP,
  WIDTH_KEY,
  aiPageUp,
  applyWidth,
  bounds,
  clampWidth,
  clearStoredWidth,
  probeLayout,
  readStoredWidth,
  inlineStartOf,
  shownWidth,
  writeStoredWidth,
  type LayoutProbe,
} from './resize';
import { sidePanelRefs, sidePanelStore } from './store.js';
import { panelEdgeStore } from './edge-store';
import { dirSign } from '../../lib/i18n/direction';

/** The app header's round control, as its #back-btn draws it — less its
 *  display, which the two ways of drawing it below each supply. */
const DISC_BOX = 'items-center justify-center w-7 h-7 shrink-0 rounded-full'
  + ' border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)]'
  + ' text-[color:var(--brand-ink)] un-touch-target';

/** Expand and Close: always there. */
const DISC = `inline-flex ${DISC_BOX}`;

/**
 * Back: SHIPS HIDDEN, and `hidden` cannot share a className with
 * `inline-flex` here — the Button primitive merges its classes with
 * tailwind-merge, which keeps only the last display utility and would drop
 * `hidden` from the prerender. So Back carries no display utility at all:
 * `hidden` while there is nowhere to go (toggled through its ref), and
 * app.css's `.side-panel-head > #side-panel-back:not(.hidden)` supplies the
 * inline-flex the other two spell out.
 */
const BACK = `hidden ${DISC_BOX}`;

export function SidePanel(): ReactNode {
  const t = useMessages('agent');
  const s = useStoreState(sidePanelStore);
  // The AI page sets this while the panel is the middle column of three,
  // beside a detail opened from the page it holds (#6394); otherwise the
  // divider keeps its own defaults.
  const edge = useStoreState(panelEdgeStore).slot;
  const rootRef = useRef<HTMLElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);
  const loadingRef = useRef<HTMLDivElement | null>(null);

  useHiddenClass(rootRef, !(s.open && !!s.frameSrc));
  useHiddenClass(backRef, !s.canBack);
  useHiddenClass(loadingRef, !s.loading);

  // React detaches the old frame's ref before it attaches a new one, so this
  // always holds the frame on screen, or null.
  const frameRef = useCallback((el: HTMLIFrameElement | null) => {
    sidePanelRefs.frame = el;
  }, []);

  // 18 Nov 2026: a request's or a change's page draws its own header pill,
  // with ↗ and × at its end (../dev-board/topic/thread-exits.tsx), so beside
  // the bot's list app.css puts this header row away for those two. Undefined
  // at hydration (no route yet), so the prerender's markup is unchanged.
  // A decision's page keeps this row: its bar is not a pill yet.
  const ownPill = s.route && /\/dev\/(issues|changes|proposals|sessions)\/\d+/.test(s.route) ? '' : undefined;
  return (
    <aside
      id="platform-side-panel"
      ref={rootRef}
      className="side-panel hidden"
      aria-labelledby="side-panel-title"
      data-thread-pill={ownPill}
    >
      <SidePanelDivider
        panelRef={rootRef}
        shown={s.open && !!s.frameSrc}
        widthKey={edge?.widthKey}
        probe={edge?.probe}
        watch={edge?.watch}
      />
      <div className="side-panel-head flex items-center gap-2 shrink-0">
        <Button
          id="side-panel-back"
          ref={backRef}
          type="button"
          variant="unstyled"
          size="icon"
          ink="none"
          className={BACK}
          aria-label={t('core:common.back')}
          title={t('core:common.back')}
          onClick={() => controller.back()}
        >
          <ChevronLeftIcon className="w-5 h-5" aria-hidden="true" />
        </Button>
        <h2
          id="side-panel-title"
          className="flex-1 min-w-0 truncate text-[15px] font-semibold text-zinc-900 dark:text-zinc-100"
        >
          {s.title}
        </h2>
        <Button
          id="side-panel-expand"
          type="button"
          variant="unstyled"
          size="icon"
          ink="none"
          className={DISC}
          aria-label={t('agent:sidePanel.expandLabel')}
          title={t('agent:sidePanel.expand')}
          onClick={() => controller.expand()}
        >
          <ExpandIcon className="w-4 h-4" aria-hidden="true" />
        </Button>
        <Button
          id="side-panel-close"
          type="button"
          variant="unstyled"
          size="icon"
          ink="none"
          className={DISC}
          aria-label={t('agent:sidePanel.close')}
          title={t('agent:sidePanel.close')}
          onClick={() => controller.close()}
        >
          <XIcon className="w-4 h-4" aria-hidden="true" />
        </Button>
        {/* Beside the AI tab's page only (app.css): the column's heading as
            Main's own reads, the project's tile, what is open, and its
            project and number (30 Oct 2026). */}
        <PanelHeading route={s.route} place={s.place} reported={s.reported} label={s.label} head={s.head} />
        <PanelMore route={s.route} />
        {/* 6 Nov 2026 (#6425): the × that closes the page, in a back chip's
            place: the lists alone behind it, or a thread when one was open
            there. The round disc the panel's own Close draws. */}
        <Button
          type="button"
          variant="unstyled"
          size="icon"
          ink="none"
          className={`side-panel-ai-close ${DISC}`}
          aria-label={t('agent:sidePanel.close')}
          title={t('agent:sidePanel.close')}
          onClick={() => controller.close()}
        >
          <XIcon className="w-4 h-4" aria-hidden="true" />
        </Button>
      </div>
      <div id="side-panel-body" className="side-panel-body">
        {/* data-un-keyboard-relay: a tap in the panel that closes the
            keyboard is reported here, so the app beside it puts its field
            away too (the kit, native.js; request #4314). */}
        {s.frameSrc ? (
          <iframe
            key={s.frameKey}
            ref={frameRef}
            id="side-panel-frame"
            title={t('agent:sidePanel.frameTitle')}
            src={s.frameSrc}
            className={s.loading ? 'side-panel-frame' : 'side-panel-frame side-panel-frame-ready'}
            data-un-keyboard-relay=""
          />
        ) : null}
        <div
          id="side-panel-loading"
          ref={loadingRef}
          className="side-panel-loading hidden"
          aria-hidden="true"
        >
          <div className="dc-status-spinner-arc side-panel-spinner"></div>
        </div>
      </div>
    </aside>
  );
}

type Place = { slug: string; name: string; icon_url?: string | null; icon_emoji?: string | null };

/** What the page on screen published for the column (#6431), as the store holds it. */
type PanelHeadView = {
  route: string;
  kind: 'request' | 'change';
  pill: StatusPillState | null;
  menuKey: string | null;
};

/** Which "Project · …" line a page's route reads as, and its number. */
function whereOf(route: string): { id: string; number: number | null } {
  const m = route.match(/\/dev\/(issues|changes|proposals|sessions|shared|governance)\/(\d+)/);
  if (!m) return { id: 'agent:sidePanel.where.project', number: null };
  if (m[1] === 'issues') return { id: 'agent:sidePanel.where.request', number: Number(m[2]) };
  if (m[1] === 'governance') return { id: 'agent:sidePanel.where.decision', number: null };
  return { id: 'agent:sidePanel.where.change', number: Number(m[2]) };
}

/**
 * The column's heading beside the AI tab's page, as Main's own header reads
 * (30 Oct 2026): the project's tile, then what is open, over its project and
 * its number. The title is the door's (the row that opened it) while the
 * panel is still on that page; after a link inside the panel, the page's own
 * (its kind, for a piece of work). The project's name is a link to its page
 * (its Hub). Its tile and name are the ones the door named, while the page is
 * still in that project; after a link to another one, the name its page
 * reported. Only the title on a page that is in no project.
 *
 * #6431: the page's own status pill rides after "Request #N" or "Change #N",
 * at the size its own bar drew it. It is the page's `head` (./head-store.ts,
 * reported through ./embedded.ts), taken only when that head is THIS page's —
 * one page's pill never shows on the next.
 */
function PanelHeading({ route, place, reported, label, head }: {
  route: string | null; place: Place | null; reported: string; label: { route: string; text: string } | null;
  head: PanelHeadView | null;
}): ReactNode {
  const t = useMessages('agent');
  if (!route) return null;
  const slug = panelPage(route)?.slug || null;
  const same = !!place && place.slug === slug;
  const project = slug ? ((same ? place!.name : '') || String(reported || '').trim() || slug) : '';
  const title = (label && label.route === route && label.text) || titleFor(route, reported);
  const where = whereOf(route);
  const link = pageLinkFor(route);
  const pill = head && head.pill && samePage(head.route, route) ? head.pill : null;
  return (
    <div className="side-panel-place">
      {same ? (
        <span className="app-icon-tile w-8 h-8 shrink-0 rounded-[10px] overflow-hidden flex items-center justify-center font-bold text-sm" data-icon={appIconKind(place as any)} aria-hidden="true">
          <AppIconContent app={place as any} />
        </span>
      ) : null}
      <span className="min-w-0 flex flex-col">
        <span className="side-panel-place-title truncate">{title}</span>
        {slug ? (
          <span className="side-panel-place-where">
            <span className="side-panel-place-where-text truncate">
              <RichMessage
                id={where.id}
                values={{ project, number: where.number }}
                components={[
                  <a
                    className="side-panel-place-link"
                    href={`#app/${encodeURIComponent(slug)}/workshop`}
                    aria-label={t('agent:sidePanel.openProject', { project })}
                    onClick={() => {
                      // A door to the project: its Hub, not the tab its page was last on.
                      try { (window as any).AppView?._landOnHub?.(slug); } catch { /* the page as it opens */ }
                    }}
                  />,
                  // The item's own page, the one Expand opens (3 Nov 2026): a
                  // plain left press goes there inside the shell, as Expand does;
                  // a middle press or a modified one gives the real address.
                  link ? (
                    <a
                      className="side-panel-place-link"
                      href={link}
                      onClick={(e) => {
                        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                        e.preventDefault();
                        try { (window as any).Improve?.enterTopicFrom?.(window.location.hash); } catch { /* the page as it opens */ }
                        controller.expand();
                      }}
                    />
                  ) : <span />,
                ]}
              />
            </span>
            {pill ? (
              <span className="side-panel-place-status" data-side-panel-status={pill.key}>
                <StatusPill s={pill} inline />
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The ⋯ beside the column's heading (3 Nov 2026), drawn as Main's own header
 * menu (../messages/index.tsx): Copy link, which copies the item's own page
 * address — the one to share, not the tab's — and (#6380) Open in workshop,
 * present only for a request, change or decision of a project. Only a page
 * that has a link shows the menu at all, so the prerender (no route yet)
 * draws nothing.
 *
 * #6431: under those two, the page's OWN rows — Build it with your own Claude
 * Code, Notify me or Mute, the moves, Change category, Edit title and the
 * rest — under a thin divider. They are read from the page when the menu
 * opens (controller `panelMenuRows`, the same list its own ⋯ shows) and run in
 * the page (controller `runPanelMenuRow`), so the column's menu and the page's
 * are one menu with one behaviour. The page's own ⋯ is not drawn beside the
 * bot page (app.css), so this is the only one there.
 */
function PanelMore({ route }: { route: string | null }): ReactNode {
  const t = useMessages('agent');
  const link = route ? pageLinkFor(route) : null;
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<PanelMenuRow[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  useDismiss(open, [wrapRef], close);
  const menuKeys = useMenuKeyboard(open, menuRef, btnRef, close);
  // Another page is another heading: a menu left open does not follow.
  useEffect(() => { setOpen(false); }, [route]);
  if (!link) return null;
  // Read when the menu opens, never while it is up: a page that moved on
  // (Notify me becoming Mute) says so the next time it is opened.
  const toggle = () => {
    if (open) { setOpen(false); return; }
    setRows(controller.panelMenuRows());
    setOpen(true);
  };
  return (
    <div className="side-panel-more relative" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className="messages-thread-action"
        aria-label={t('agent:sidePanel.moreLabel')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <EllipsisHorizontalIcon aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="messages-thread-menu"
          role="menu"
          aria-label={t('agent:sidePanel.moreLabel')}
          onKeyDown={menuKeys.onKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            data-side-panel-copy-link=""
            onClick={() => {
              btnRef.current?.focus({ preventScroll: true });
              setOpen(false);
              void copyToClipboard(window.location.origin + link, t('agent:sidePanel.linkCopied'));
            }}
          >
            {t('agent:sidePanel.menu.copyLink')}
          </button>
          {/* #6380: the same request, change or decision, open in the panel
              beside its project's Workshop. Only a project's own work has a
              place there; a private thread or a page in no project keeps the
              menu as it was. */}
          {route && workshopItemOf(route) ? (
            <button
              type="button"
              role="menuitem"
              data-side-panel-open-workshop=""
              onClick={() => {
                btnRef.current?.focus({ preventScroll: true });
                setOpen(false);
                controller.openInWorkshop();
              }}
            >
              {t('agent:sidePanel.menu.openInWorkshop')}
            </button>
          ) : null}
          {rows.length ? <div className="side-panel-menu-sep" role="separator" /> : null}
          {rows.map((row, i) => (
            <button
              key={`${i}:${row.label}`}
              type="button"
              role="menuitem"
              data-side-panel-page-row={i}
              title={row.title || undefined}
              disabled={row.disabled}
              onClick={(e) => {
                btnRef.current?.focus({ preventScroll: true });
                setOpen(false);
                controller.runPanelMenuRow(i, row.label, e.nativeEvent);
              }}
            >
              {row.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface WidthRange {
  now: number;
  min: number;
  max: number;
}

/**
 * The handle on the panel's left edge. A `separator` whose value is the
 * panel's width in pixels: the arrows move the divider the way they point
 * (Left widens the panel), Home and End go to the narrowest and the widest,
 * and a double-click forgets the chosen width.
 *
 * The value is published only once it is known — after mount, while the panel
 * is on screen — so the prerender and the first client render carry none.
 *
 * The Homeroom bot page's own column, where a thread opens, is the same
 * column (features/ai, 30 Oct 2026): its left edge is this handle too, with
 * its own `id` and the pane it controls. Since 3 Nov 2026 it sets that
 * column's own width, stored under its own key, not the side panel's: a
 * panel narrowed beside an app no longer narrows it, and dragging it leaves
 * the panel's width alone. A page
 * opened in Main's place on that page is drawn as Main's column, so its edge
 * sets Main's width too.
 */
export function SidePanelDivider({
  panelRef,
  shown,
  id = 'side-panel-divider',
  controls = 'platform-side-panel',
  widthKey,
  probe: measure = probeLayout,
  watch,
}: {
  panelRef: RefObject<HTMLElement | null>;
  shown: boolean;
  id?: string;
  controls?: string;
  /** Which stored width this edge sets; by default Main's while the bot
   *  page is up, the side panel's everywhere else. */
  widthKey?: string;
  /** The layout as this edge reads it, for a column that is not the last or
   *  has more than one neighbour (the bot page with a preview open, #6359);
   *  the side panel's own reading by default. Keep it stable (useCallback). */
  probe?: () => LayoutProbe;
  /** A neighbour whose width this edge's bound is read from: its range is
   *  read again whenever that one is resized (the preview beside the thread). */
  watch?: RefObject<HTMLElement | null>;
}): ReactNode {
  const t = useMessages('agent');
  const [range, setRange] = useState<WidthRange | null>(null);
  const drag = useRef<{ id: number; startX: number; startW: number; width: number | null } | null>(null);

  // Resolved at each use, not at mount: the side panel is a single element
  // mounted once, and it is the bot page's own column whenever that page is
  // up. `widthKey` pins it for a caller that knows which column it draws.
  const resolveKey = useCallback(
    () => widthKey ?? (aiPageUp() ? AI_MAIN_WIDTH_KEY : WIDTH_KEY),
    [widthKey],
  );

  // What is on screen now: the stored width, held inside this window, or the
  // stylesheet's default when there is none. Never writes the store — a
  // window that narrows gives the width back, and one that grows returns it.
  const settle = useCallback(() => {
    const key = resolveKey();
    const probe = measure();
    const b = bounds(probe);
    const stored = readStoredWidth(undefined, key);
    applyWidth(stored == null ? null : clampWidth(stored, b), undefined, key);
    const panel = panelRef.current;
    // Its width as chosen, which on the Duo held sideways leaves out the
    // column of system chrome it runs under (./resize.ts).
    const box = panel ? panel.getBoundingClientRect() : null;
    const now = box && box.width > 0 ? shownWidth(inlineStartOf(box), probe) : 0;
    setRange(now > 0 ? { now, ...b } : null);
  }, [panelRef, resolveKey, measure]);

  useEffect(() => {
    settle();
    if (!shown) return undefined;
    window.addEventListener('resize', settle);
    const other = watch?.current;
    const observer = other && typeof ResizeObserver === 'function' ? new ResizeObserver(() => settle()) : null;
    if (observer && other) observer.observe(other);
    return () => {
      window.removeEventListener('resize', settle);
      observer?.disconnect();
    };
  }, [shown, settle, watch]);

  // A drag that never ended (the island unmounting mid-drag) must not leave
  // the whole document stuck in the resize cursor.
  useEffect(() => () => {
    document.documentElement.classList.remove('side-panel-resizing');
  }, []);

  const set = (width: number, persist: boolean): number => {
    const key = resolveKey();
    const b = bounds(measure());
    const next = clampWidth(width, b);
    applyWidth(next, undefined, key);
    setRange({ now: next, ...b });
    if (persist) writeStoredWidth(next, undefined, key);
    return next;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* still drags while over the handle */ }
    drag.current = {
      id: e.pointerId,
      startX: e.clientX,
      startW: shownWidth(inlineStartOf(panel.getBoundingClientRect()), measure()),
      width: null,
    };
    // Frames swallow pointer events that cross them; while a drag is on, the
    // app's and the panel's both stand aside (app.css).
    document.documentElement.classList.add('side-panel-resizing');
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    // The panel is pinned to the inline-end edge, so moving toward inline-start
    // widens it: left in English, right in Arabic.
    d.width = set(d.startW + (d.startX - e.clientX) * dirSign(), false);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    document.documentElement.classList.remove('side-panel-resizing');
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    // A press that never moved is half of a double-click, not a choice.
    if (d.width != null) writeStoredWidth(d.width, undefined, resolveKey());
  };

  const onDoubleClick = () => {
    clearStoredWidth(undefined, resolveKey());
    settle();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const now = shownWidth(inlineStartOf(panel.getBoundingClientRect()), measure());
    const step = e.shiftKey ? KEY_STEP * 4 : KEY_STEP;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = now + step * dirSign();
    else if (e.key === 'ArrowRight') next = now - step * dirSign();
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = Number.POSITIVE_INFINITY;
    if (next == null) return;
    e.preventDefault();
    set(next, true);
  };

  return (
    <div
      id={id}
      className="side-panel-divider"
      role="separator"
      aria-orientation="vertical"
      aria-controls={controls}
      aria-label={t('agent:sidePanel.resize')}
      aria-valuenow={range ? range.now : undefined}
      aria-valuemin={range ? range.min : undefined}
      aria-valuemax={range ? range.max : undefined}
      title={t('agent:sidePanel.resizeTitle')}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    ></div>
  );
}
