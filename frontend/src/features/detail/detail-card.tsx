/**
 * THE DETAIL COLUMN AS CARDS, WITH A PICKER (20 Nov 2026).
 *
 * Beside a thread on the Homeroom bot tab, what the thread opened to read
 * (a design, its running preview, a request draft, a plan, a change's before
 * and after: ../ai/detail.ts) is drawn as the thread itself is: a head card,
 * then the thing in a card under it, on the page's own ground. It used to be
 * a flat panel to the window's edge, each kind with a header of its own.
 *
 * The head card is the one place that says what is showing and switches it:
 * its title opens a picker of everything this thread has that the column can
 * show (what was opened beside it, its design with every version, and its
 * live preview while one runs), and its × closes the column. Each kind keeps
 * its own buttons (Comment, Request it, Copy), drawn into the head card
 * (DetailActions), and says its own title and small line (useDetailLabel),
 * so the pane that knows what it shows stays the one that says it.
 *
 * The column belongs to its thread: ../ai/index.tsx holds what it shows when
 * another thread is opened and shows it again on the way back.
 */

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import {
  AppWindowIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, DescriptionIcon, PencilSquareIcon, PhotoIcon, PlayIcon, XIcon,
} from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import {
  closeDetail, detailIdentity, detailLabel, noteDetailLabel, reopenDetail, seenDetails,
  type DetailEntry, type DetailKind, type DetailLayout,
} from '../ai/detail';
import { openPreview } from '../ai/preview';
import { readDesign } from '../messages/design-card';
import { openLivePreview, readLiveDraft, type LiveDraft } from '../messages/live-draft-bar';
import type { DesignThread } from '../messages/api';

export interface DetailLabel {
  title: string;
  line: string | null;
}

interface Chrome {
  /** Drawn as cards beside a thread: the kind's own header steps aside. */
  card: boolean;
  /** Where the kind's own buttons go: the head card's. */
  actions: HTMLElement | null;
  /** The kind says what it shows, for the head card and its row in the picker. */
  label: (label: DetailLabel | null) => void;
}

const NO_CHROME: Chrome = { card: false, actions: null, label: () => {} };
const DetailChrome = createContext<Chrome>(NO_CHROME);

/** Whether this pane is drawn in the card column (its own header steps aside). */
export function useDetailCard(): boolean {
  return useContext(DetailChrome).card;
}

/** A kind's own buttons: in the head card where it is drawn as cards, else where they are. */
export function DetailActions({ children }: { children: ReactNode }): ReactNode {
  const chrome = useContext(DetailChrome);
  if (!chrome.card) return children;
  return chrome.actions ? createPortal(children, chrome.actions) : null;
}

/** A kind says its title and small line to the head card. */
export function useDetailLabel(label: DetailLabel | null): void {
  const { label: say } = useContext(DetailChrome);
  const title = label?.title ?? '';
  const line = label?.line ?? null;
  useEffect(() => { say(title ? { title, line } : null); }, [say, title, line]);
}

const GLYPH: Record<DetailKind, typeof AppWindowIcon> = {
  design: AppWindowIcon,
  preview: PlayIcon,
  draft: PencilSquareIcon,
  plan: DescriptionIcon,
  shots: PhotoIcon,
};

/** One row of the picker. */
interface PickRow {
  id: string;
  kind: DetailKind;
  title: string;
  line: string | null;
  current: boolean;
  open: () => void;
  /** A design's versions, under its row. */
  versions?: Array<{ version: number; note: string | null; current: boolean; open: () => void }>;
}

/** The thread's own root, when the column belongs to a private thread. */
function rootOf(owner: string | null): number | null {
  const match = /^private:(\d+)$/.exec(owner || '');
  return match ? Number(match[1]) : null;
}

/**
 * What the thread has that the column can show, besides what it opened: its
 * design (read once per thread, ../messages/design-card.tsx) and its live
 * preview while one runs. Read when the column opens, and again on a new open.
 */
function useThreadHas(owner: string | null, seq: number): { design: DesignThread | null; live: LiveDraft | null } {
  const rootId = rootOf(owner);
  const [design, setDesign] = useState<DesignThread | null>(null);
  const [live, setLive] = useState<LiveDraft | null>(null);
  useEffect(() => {
    let alive = true;
    if (!rootId) {
      setDesign(null);
      setLive(null);
      return () => { alive = false; };
    }
    readDesign(rootId, 0).then((d) => { if (alive) setDesign(d); }, () => { if (alive) setDesign(null); });
    readLiveDraft(rootId).then((d) => { if (alive) setLive(d && d.state === 'open' && d.sessionId ? d : null); }, () => { if (alive) setLive(null); });
    return () => { alive = false; };
  }, [rootId, seq]);
  return { design, live };
}

/**
 * The picker (20 Nov 2026): what shows now, as a button, and the list of
 * everything this thread can show here. The list is drawn at the top of the
 * page, under its anchor, so nothing beside it covers it: a running
 * preview's frame stands over the column, above the column's own layers.
 * Drawn in the head card, and in a running preview's own bar, which is that
 * preview's head (../staging/staging-overlay.tsx).
 */
export function DetailPicker({ entry, label, className, anchor, children }: {
  entry: DetailEntry;
  /** What shows now, for the button's name and its row in the list. */
  label: DetailLabel | null;
  className: string;
  /** What the list hangs under: the head card, or the preview's bar. */
  anchor?: RefObject<HTMLElement | null>;
  children: ReactNode;
}): ReactNode {
  const t = useMessages('messages');
  const [menu, setMenu] = useState(false);
  const [at, setAt] = useState<{ start: number; top: number; width: number; rtl: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { setMenu(false); }, [entry.seq]);
  useEffect(() => { if (label) noteDetailLabel(entry, label); }, [entry, label]);
  const has = useThreadHas(entry.owner, entry.seq);
  const rows = useMemo(() => pickRows(entry, has, t), [entry, has, t, label]);

  // Under its anchor's start edge, as wide as it up to 420px, kept there as
  // the window moves.
  useLayoutEffect(() => {
    if (!menu) return undefined;
    const place = () => {
      const box = (anchor?.current || trigger.current)?.getBoundingClientRect();
      if (!box) return;
      const rtl = document.documentElement.dir === 'rtl';
      setAt({ start: rtl ? window.innerWidth - box.right : box.left, top: box.bottom + 8, width: Math.min(420, box.width), rtl });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [menu, anchor]);

  // The list closes on a press outside it and its button, and on Escape
  // (before the column's own Escape, which would close the column).
  useEffect(() => {
    if (!menu) return undefined;
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || list.current?.contains(target)) return;
      setMenu(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [menu]);

  const choose = (open: () => void) => { setMenu(false); open(); };
  const title = label?.title || t(KIND_WORD[entry.kind]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={menu}
        aria-label={t('messages:detail.picker.label', { title })}
        onClick={() => setMenu((open) => !open)}
        data-detail-picker=""
      >
        {children}
      </button>
      {menu && at && typeof document !== 'undefined' ? createPortal(
        <div
          ref={list}
          className="detail-card-menu"
          role="menu"
          aria-label={t('messages:detail.picker.section')}
          style={at.rtl ? { right: at.start, top: at.top, width: at.width } : { left: at.start, top: at.top, width: at.width }}
          data-detail-menu=""
        >
          <div className="detail-card-menu-head">{t('messages:detail.picker.section')}</div>
          {rows.map((row) => {
            const RowGlyph = GLYPH[row.kind];
            return (
              <div key={row.id} className="detail-card-menu-group">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={row.current && !row.versions?.some((v) => v.current)}
                  className="detail-card-row"
                  onClick={() => choose(row.open)}
                  data-detail-item={row.kind}
                  data-current={row.current && !(row.versions && row.versions.length > 1) ? '' : undefined}
                >
                  <span className="detail-card-tile" aria-hidden="true"><RowGlyph className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1">
                    <b>{row.title}</b>
                    {row.line ? <small>{row.line}</small> : null}
                  </span>
                  {row.current ? <CheckIcon className="h-[18px] w-[18px] shrink-0" aria-hidden="true" /> : null}
                </button>
                {row.versions && row.versions.length > 1 ? row.versions.map((v) => (
                  <button
                    key={v.version}
                    type="button"
                    role="menuitemradio"
                    aria-checked={v.current}
                    className="detail-card-version"
                    onClick={() => choose(v.open)}
                    data-detail-version={v.version}
                    data-current={v.current ? '' : undefined}
                  >
                    <b>{t('messages:detail.row.version', { version: v.version })}</b>
                    {v.note ? <span>{v.note}</span> : null}
                  </button>
                )) : null}
              </div>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

export function DetailCard({ entry, layout, children }: {
  entry: DetailEntry;
  layout: DetailLayout;
  children: ReactNode;
}): ReactNode {
  const t = useMessages('messages');
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [label, setLabel] = useState<DetailLabel | null>(null);
  const head = useRef<HTMLDivElement>(null);
  const say = useCallback((next: DetailLabel | null) => {
    setLabel((had) => (had?.title === next?.title && had?.line === next?.line ? had : next));
  }, []);
  // A new thing open: its words come from its own pane.
  useEffect(() => { setLabel(null); }, [entry.seq]);
  const chrome = useMemo<Chrome>(() => ({ card: true, actions, label: say }), [actions, say]);
  const body = (
    <div className="detail-card-body" data-detail-body={entry.kind}>
      <DetailChrome.Provider value={chrome}>{children}</DetailChrome.Provider>
    </div>
  );
  // A running preview is one card: its own bar is its head, and draws the
  // picker (../staging/staging-overlay.tsx), so there is one header, not two.
  if (entry.kind === 'preview') return <div className="detail-card" data-detail-card={entry.kind}>{body}</div>;

  const Glyph = GLYPH[entry.kind];
  const shown = label || { title: t(KIND_WORD[entry.kind]), line: null };
  const back = layout === 'full';
  return (
    <div className="detail-card" data-detail-card={entry.kind}>
      <div ref={head} className="detail-card-head" data-detail-head="">
        {back ? (
          <button type="button" className="detail-card-disc" onClick={closeDetail} aria-label={t('messages:detail.back')} title={t('messages:detail.back')} data-detail-close="back">
            <ChevronLeftIcon className="h-5 w-5" aria-hidden="true" />
          </button>
        ) : null}
        <span className="detail-card-tile" aria-hidden="true"><Glyph className="h-[18px] w-[18px]" /></span>
        <DetailPicker entry={entry} label={label} className="detail-card-pick" anchor={head}>
          {shown.line ? <span className="detail-card-line">{shown.line}</span> : null}
          <span className="detail-card-title">
            <span>{shown.title}</span>
            <ChevronDownIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
          </span>
        </DetailPicker>
        <span ref={setActions} className="detail-card-acts" data-detail-actions="" />
        {back ? null : (
          <span className="detail-card-exits">
            <button type="button" className="detail-card-disc" onClick={closeDetail} aria-label={t('messages:detail.close')} title={t('messages:detail.close')} data-detail-close="close">
              <XIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
      {body}
    </div>
  );
}

const KIND_WORD: Record<DetailKind, string> = {
  design: 'messages:detail.kind.design',
  preview: 'messages:detail.kind.preview',
  draft: 'messages:detail.kind.draft',
  plan: 'messages:detail.kind.plan',
  shots: 'messages:detail.kind.shots',
};

/**
 * The picker's rows: the thread's design first (with its versions), its live
 * preview, then everything else opened beside it, in the order it was first
 * opened. The thing showing now is marked.
 */
function pickRows(
  entry: DetailEntry,
  has: { design: DesignThread | null; live: LiveDraft | null },
  t: (id: string, values?: Record<string, unknown>) => string,
): PickRow[] {
  const owner = entry.owner;
  const now = detailIdentity(entry);
  const rows: PickRow[] = [];
  const taken = new Set<string>();
  const seen = seenDetails(owner);
  const design = has.design;
  if (design && design.rootId) {
    const id = `design:${design.rootId}`;
    const conversationId = design.conversationId || entry.ref.conversationId || 0;
    const showing = now === id;
    const latest = design.latest || 0;
    const at = showing ? (entry.version || latest) : null;
    rows.push({
      id,
      kind: 'design',
      title: design.title || t('messages:detail.kind.design'),
      line: t('messages:detail.row.design', { count: design.versions.length || latest }),
      current: showing,
      open: () => openPreview({ conversationId, rootId: design.rootId, version: null }),
      versions: design.versions.map((v) => ({
        version: v.version,
        note: v.note,
        current: at === v.version,
        open: () => openPreview({ conversationId, rootId: design.rootId, version: v.version }),
      })),
    });
    taken.add(id);
  }
  const live = has.live;
  if (live && live.sessionId) {
    const id = `preview:${live.sessionId}`;
    rows.push({
      id,
      kind: 'preview',
      title: t('messages:detail.kind.preview'),
      line: live.app?.name || null,
      current: now === id,
      open: () => openLivePreview(live),
    });
    taken.add(id);
  }
  for (const had of seen) {
    const id = detailIdentity(had);
    if (taken.has(id)) continue;
    taken.add(id);
    const words = detailLabel(owner, id);
    rows.push({
      id,
      kind: had.kind,
      title: words?.title || t(KIND_WORD[had.kind]),
      line: words?.line || null,
      current: now === id,
      open: () => reopenDetail(had),
    });
  }
  if (!taken.has(now)) {
    const words = detailLabel(owner, now);
    rows.unshift({ id: now, kind: entry.kind, title: words?.title || t(KIND_WORD[entry.kind]), line: words?.line || null, current: true, open: () => {} });
  }
  return rows;
}
