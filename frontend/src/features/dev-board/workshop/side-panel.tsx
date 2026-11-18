/**
 * The panel beside the Workshop tab's list, on a wide window (#4457).
 *
 * A row opens its item's page here, so the list stays where it was and the
 * next row is one tap away: go down your work, or a week's changes, one
 * after another. The row you are on is highlighted in the list, ✕ closes
 * the panel, and "Open as a page" gives the page the whole tab (its own
 * route, with its "‹ Workshop" chip).
 *
 * ── The SAME page, not a copy ─────────────────────────────────────────
 *
 * The page in here is the request's or the change's page itself: the panel
 * renders `#dev-topic-thread`, the host the full page's frame renders
 * (../topic-frame.tsx), and `AppView.openTopicInPanel` mounts into it
 * exactly what `_renderTopicSubView` mounts there — the request's Messages
 * thread (GroupChat.mountThread, RequestShell) or the change page
 * (mountChangePage). The topic sub-view is never up while the Workshop is,
 * so the id stays unique.
 *
 * The panel is portalled into <body>, out of the page's frosted layers,
 * whose transforms would pin a `position: fixed` box to them.
 *
 * The host is an empty leaf React never looks inside, like the full page's.
 * It is KEYED by the item, so another row gets a fresh host rather than a
 * second page mounted over the first one's portal (the NotFoundError
 * `_renderTopicHead`'s header describes).
 *
 * ── The detail column has a slot here too (#4875, #6230) ──────────────
 *
 * A request's page shows its plan card, and its Read opens the one detail
 * column beside the page (../../detail/detail-slot.tsx). In the panel's
 * width the page and the plan share it in halves, instead of the plan
 * covering the page. The topic frame is never up while this panel is, so
 * the id stays unique. Escape closes the detail before the panel, and the
 * panel closes the detail on its way out, so a plan read here is not left
 * open for the next screen to restore.
 */

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ArrowRightIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { dirSign } from '../../../lib/i18n/direction';
import { readSplitWidth, splitKey, startSplitDrag, writeSplitWidth, type SplitDrag } from '../../../lib/split-drag';
import { callAppView } from '../card/fold';
import { DetailSlot } from '../../detail/detail-slot';
import { setWorkshopSideActions } from './side-actions';
import type { TopicRef } from './work-row';


export function TopicSidePanel({ item, onClose }: { item: TopicRef; onClose: () => void }): ReactNode {
  const t = useMessages('project');
  // Mount the page once the host is in the document, and take it down with
  // the panel (or before the next item's).
  //
  // IN A MICROTASK, the defer actions-row.tsx already gives the kanban
  // filter bar: the mount publishes through a `flushSync`
  // (lib/legacy-portals.tsx), which React drops while it is still
  // committing — and an effect body is inside the commit. mountThread then
  // reads its container before the shell is in the DOM, finds no
  // `#gc-thread-input`, and skips the whole composer wiring (submit, the
  // draft, Enter, attachments and the three autocomplete controllers), so
  // typing @, # or : in the panel's Reply box opened nothing (#4629).
  // From the microtask the flushSync runs and the composer is wired.
  useEffect(() => {
    let live = true;
    queueMicrotask(() => { if (live) void callAppView('openTopicInPanel', item.kind, item.id); });
    return () => { live = false; callAppView('closeTopicPanel', item.kind, item.id); };
  }, [item.kind, item.id]);
  // A plan open in this panel's reader closes with the panel (or before the
  // next item's page). A LAYOUT cleanup, so it runs while the slot is still
  // in the document: `_closeSpecPanel` finds the host by id, and a passive
  // cleanup runs after the panel has already left.
  useLayoutEffect(() => () => {
    (window as any).UsernodeReact?.detail?.close?.();
  }, [item.kind, item.id]);
  // Escape closes it, as it closes a sheet: but a detail open beside the
  // page goes first. The detail column's own capture listener (#6230,
  // ../../ai/detail.ts) closes it and calls preventDefault, so this one
  // sees that and stays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest('input, textarea, [contenteditable="true"]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const openFull = () => {
    onClose();
    callAppView('openTopic', item.kind, item.id);
  };
  // 18 Nov 2026: the page's own header pill ends with ↗ and × here
  // (../topic/thread-exits.tsx), which do what this panel's bar did.
  useEffect(() => {
    setWorkshopSideActions({ close: onClose, openFull });
    return () => setWorkshopSideActions(null);
  });
  if (typeof document === 'undefined') return null;
  // Into <body>: the Workshop sits inside the page's frosted layers, whose
  // transforms would make `position: fixed` relative to them.
  return createPortal((
    <aside className="dev-ws-side" data-ws-side={`${item.kind}:${item.id}`} aria-label={t('project:sidePanel.label')}>
      <SideDivider />
      <div className="dev-ws-side-bar">
        <button type="button" className="dev-ws-side-btn dev-ws-side-close" aria-label={t('core:common.close')} data-ws-side-close="" onClick={onClose}>
          <XIcon aria-hidden="true" />
        </button>
        <button type="button" className="dev-ws-side-btn dev-ws-side-full" data-ws-side-full="" onClick={openFull}>
          {t('project:sidePanel.openAsPage')}
          <ArrowRightIcon aria-hidden="true" />
        </button>
      </div>
      <div className="dev-ws-side-body">
        <div key={`${item.kind}:${item.id}`} id="dev-topic-thread" className="dev-ws-side-page" />
        {/* #4875, #6230: the detail column's slot. In halves the page and
            the plan share the panel; from 1760px all three stand side by
            side. React owns it (../../detail/detail-slot.tsx). */}
        <DetailSlot key={`spec:${item.kind}:${item.id}`} surface="workshop" resizerLabel={t('project:topic.frame.resizeSpecPanel')} />
      </div>
    </aside>
  ), document.body);
}

/**
 * THE LINE BETWEEN THE LIST AND THE PANEL IS A HANDLE (18 Nov 2026). It
 * shows a grip under the pointer, and dragging it moves the line: the list
 * takes the width it is dragged to and the panel the rest, since both read
 * `--dev-ws-side-list-w` (app.css). The width is kept for the next visit;
 * a double-click goes back to the default. The arrow keys move it too.
 * The list keeps 360px and the panel 440px whatever the drag.
 */
const LIST_W_KEY = 'homeroom:ws-side-list-w';
const LIST_MIN = 360;
const KEY_STEP = 24;

function listWidthValue(px: number): string {
  // The panel's floor, 440px, and the inset, gap and margin around them.
  return `clamp(${LIST_MIN}px, ${Math.round(px)}px, calc(var(--platform-usable-w) - 2 * var(--platform-gutter, 0px) - 520px))`;
}

function applyListWidth(px: number | null): void {
  if (typeof document === 'undefined') return;
  if (px == null) document.body.style.removeProperty('--dev-ws-side-list-w');
  else document.body.style.setProperty('--dev-ws-side-list-w', listWidthValue(px));
}

/** The list's width on screen now: what a drag starts from. */
function listWidthNow(): number {
  const list = document.getElementById('dev-workshop');
  return list ? list.getBoundingClientRect().width : 600;
}

const LIST_DRAG: SplitDrag = {
  start: listWidthNow,
  apply: applyListWidth,
  // Keep what the screen shows, not what the pointer reached past a floor.
  done: () => writeSplitWidth(LIST_W_KEY, listWidthNow()),
};

/**
 * The grip stands in the middle of the gap the reader SEES: between the
 * list's edge and the page's pill, not the panel's box (which keeps room for
 * the cards' shadows inside it). Both edges are read off the screen, so it
 * holds whatever the list's own insets are; it is placed again when the
 * window changes and as the pointer comes to it, since the pill arrives a
 * moment after the panel.
 */
function placeDivider(el: HTMLElement | null): void {
  const panel = el?.parentElement;
  const list = document.getElementById('dev-workshop');
  if (!el || !panel || !list) return;
  const p = panel.getBoundingClientRect();
  const l = list.getBoundingClientRect();
  const page = panel.querySelector<HTMLElement>('#gc-thread-bar .messages-thread-header, #gc-thread-head');
  const c = page ? page.getBoundingClientRect() : p;
  const rtl = dirSign() < 0;
  const mid = rtl ? (l.left + c.right) / 2 : (l.right + c.left) / 2;
  const fromStart = rtl ? p.right - mid : mid - p.left;
  el.style.insetInlineStart = `${Math.round(fromStart - el.offsetWidth / 2)}px`;
}

function SideDivider(): ReactNode {
  const t = useMessages('agent');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    applyListWidth(readSplitWidth(LIST_W_KEY, LIST_MIN));
    return () => applyListWidth(null);
  }, []);
  useLayoutEffect(() => {
    const place = () => placeDivider(ref.current);
    place();
    const late = window.setTimeout(place, 600);
    window.addEventListener('resize', place);
    return () => { window.clearTimeout(late); window.removeEventListener('resize', place); };
  }, []);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => startSplitDrag(e, LIST_DRAG);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (splitKey(e.key, KEY_STEP, LIST_DRAG)) e.preventDefault();
  };
  const reset = () => {
    writeSplitWidth(LIST_W_KEY, null);
    applyListWidth(null);
  };
  return (
    <div
      className="dev-ws-side-divider split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('agent:sidePanel.resize')}
      title={t('agent:sidePanel.resizeTitle')}
      tabIndex={0}
      data-ws-side-divider=""
      ref={ref}
      onPointerEnter={() => placeDivider(ref.current)}
      onFocus={() => placeDivider(ref.current)}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={reset}
    />
  );
}
