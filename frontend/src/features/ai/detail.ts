/**
 * THE DETAIL COLUMN — one place for everything a thread opens to read beside
 * it (3 Nov 2026, #6230). It began as a design's preview alone
 * (./preview.ts, 1 Nov 2026, threads one loop C1) and is now the same column
 * for three kinds of thing:
 *
 *   design   a design's preview (../messages/design-pane.tsx)
 *   plan     a plan or spec, any version (the shared-spec reader)
 *   shots    a change's before and after viewer
 *
 * and the same three layouts on every surface:
 *
 *   three    list | thread | detail, side by side, where they fit
 *   halves   thread | detail, in halves; the list steps aside (the tab, or
 *            the detail's ×, brings it back)
 *   full     the detail takes the whole screen, with a back arrow
 *
 * Which of the three is open, of what, at which version, and the words it
 * shows are this one store's, so the card that opens it and the surface that
 * draws it need nothing of each other's. The address the column writes
 * (./column.ts) names the detail too, so a reload or a copied link reopens it.
 *
 * Pure but for that state; no React beyond two hooks.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

export type DetailKind = 'design' | 'plan' | 'shots' | 'draft';

/** What the detail is about: a design's thread, a plan's session, a change. */
export interface DetailRef {
  conversationId?: number;
  rootId?: number;
  sessionId?: number;
  changeId?: number;
  /** A request draft's offer (`homeroom_bot_dm_actions.id`, #6248). */
  actionId?: number;
}

/** What the message says about a draft, shown until the saved row is read. */
export interface DetailDraftCopy {
  title: string;
  project: string;
  details: string;
  appSlug: string | null;
}

/** A plan that exists only as text (a request card's Read): no fetch, no address. */
export interface DetailPayload {
  title?: string;
  markdown?: string;
  html?: string | null;
  /** The text is an error or a 404, so it renders as text, never as a document. */
  error?: boolean;
  /** A request draft's own copy, until the pane reads the saved row (#6248). */
  draft?: DetailDraftCopy;
}

export interface DetailEntry {
  kind: DetailKind;
  ref: DetailRef;
  version: number | null;
  payload?: DetailPayload;
  /** The column key of the thread it was opened from, when the opener knew it. */
  from: string | null;
  /** Counts each open, so a second press on the same thing shows it again. */
  seq: number;
}

export type SpecPanelBody =
  /** A 404 or a load failure. Deliberately NOT markdown: formatting an error
   *  message turns it into something that looks like a spec. */
  | { kind: 'error'; text: string }
  /** Sanitized markdown. */
  | { kind: 'markdown'; html: string }
  /** An HTML spec (#3699): two halves when `split`. */
  | { kind: 'spec'; split: boolean; preambleHtml: string; userHtml: string; techHtml: string; html: string };

export interface DetailState {
  entry: DetailEntry | null;
  title: string;
  /** "v3 · Mar 4, 09:12 · PR #128", or null when none of the three is known. */
  subtitle: string | null;
  canCopy: boolean;
  body: SpecPanelBody | null;
  /** The raw markdown Copy takes; never the rendered body. */
  raw: string | null;
}

export type DetailLayout = 'three' | 'halves' | 'full';
export type DetailSurface = 'bot' | 'workshop' | 'topic';

/** Where the bot page's three columns fit (the design preview's own breakpoint). */
export const THREE_COLUMNS = '(min-width: 1500px)';
/** Where the Workshop's list, page and detail fit side by side. */
export const WORKSHOP_THREE = '(min-width: 1760px)';
/** Where a request's own page docks its detail beside the page. */
export const TOPIC_DOCK = '(min-width: 1024px)';
/** A phone: the detail takes the whole screen. */
export const DETAIL_PHONE = '(max-width: 767px)';

/** The width a surface makes its three columns from. */
export function detailThreeQuery(surface: DetailSurface): string {
  if (surface === 'workshop') return WORKSHOP_THREE;
  if (surface === 'topic') return TOPIC_DOCK;
  return THREE_COLUMNS;
}

/** The detail's layout on this surface, read from its own media queries. */
export function useDetailLayout(surface: DetailSurface): DetailLayout {
  const [flags, setFlags] = useState({ phone: false, wide: false });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const phone = window.matchMedia(DETAIL_PHONE);
    const wide = window.matchMedia(detailThreeQuery(surface));
    const sync = () => setFlags({ phone: phone.matches, wide: wide.matches });
    sync();
    phone.addEventListener?.('change', sync);
    wide.addEventListener?.('change', sync);
    return () => {
      phone.removeEventListener?.('change', sync);
      wide.removeEventListener?.('change', sync);
    };
  }, [surface]);
  return detailLayout(surface, flags);
}

/**
 * Pure: how the detail stands beside the thread, by the surface and its
 * media flags. `three` on a topic page means docked beside the page, with its
 * own remembered width (there is no list there to make three columns of).
 */
export function detailLayout(
  surface: DetailSurface,
  { phone, wide }: { phone: boolean; wide: boolean },
): DetailLayout {
  if (phone) return 'full';
  if (surface === 'workshop') return wide ? 'three' : 'halves';
  return wide ? 'three' : 'halves';
}

const CLOSED: DetailState = { entry: null, title: '', subtitle: null, canCopy: false, body: null, raw: null };

/**
 * The state lives on the global object, not in this module's closure.
 *
 * The shell is built into several bundles and a page can be drawn by more
 * than one of them: the topic frame's React root and the AI page's are not
 * always the same copy of this module. A store kept in module state then has
 * two owners — opening a plan in one never reaches the pane drawn by the
 * other — which is exactly what the browser showed on #6230's first build.
 * One holder, keyed on the global, is one store however many copies load.
 */
interface Shared {
  state: DetailState;
  seq: number;
  listeners: Set<() => void>;
  /** A change's before and after whose page had no column to draw it (#6315). */
  shotsArrival?: { id: number; at: number };
}
const holder: Shared = ((globalThis as any).__usernodeDetail ||= {
  state: CLOSED,
  seq: 0,
  listeners: new Set(),
});
const notify = () => holder.listeners.forEach((fn) => fn());

function valid(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
}

function demoQS(): string {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

function stamp(builtAt: unknown): string {
  const gc = typeof window !== 'undefined' ? (window as any).GroupChat : null;
  const text = gc?._stamp?.(builtAt)?.text;
  return typeof text === 'string' ? text : '';
}

function markdownBody(markdown: string): SpecPanelBody {
  const devChat = typeof window !== 'undefined' ? (window as any).DevChat : null;
  const render = devChat?.renderMarkdown;
  return render ? { kind: 'markdown', html: render(markdown) } : { kind: 'error', text: markdown };
}

function specBody(markdown: string, html: string | null): SpecPanelBody {
  const host = typeof window !== 'undefined' ? (window as any).UsernodeReact?.specHtml : null;
  const doc = !html || typeof host?.render !== 'function'
    ? null
    : host.render(String(html), { key: `gc-detail-${holder.seq}` });
  return doc ? { kind: 'spec', ...doc } : markdownBody(markdown);
}

/** Publish a document as the detail, once it is the one still wanted. */
function show(entry: DetailEntry, shown: { title: string; subtitle: string | null; canCopy: boolean; body: SpecPanelBody; raw: string | null }): void {
  if (holder.state.entry !== entry) return;
  holder.state = { entry, ...shown };
  notify();
}

function subtitleFor(version: number | null, builtAt: unknown, prNumber: unknown): string | null {
  const parts: string[] = [];
  if (version != null) parts.push(`v${version}`);
  const built = stamp(builtAt);
  if (built) parts.push(built);
  if (prNumber) {
    const t = (window as any).PlatformI18n?.t;
    const label = t ? t('chat:group.quote.pr', { number: prNumber }) : `PR #${prNumber}`;
    parts.push(label);
  }
  return parts.length ? parts.join(' · ') : null;
}

/** Fallback wording, only when the shell has not loaded its catalogs. */
function say(id: string, values?: Record<string, unknown>, fallback = ''): string {
  const t = (window as any).PlatformI18n?.t;
  return t ? t(id, values) : fallback;
}

async function fetchPlan(entry: DetailEntry): Promise<void> {
  const sessionId = entry.ref.sessionId;
  if (!valid(sessionId)) return;
  const previewTitle = entry.payload?.title || say('chat:group.spec.title', { version: entry.version ?? 1 }, 'Plan');
  show(entry, { title: previewTitle, subtitle: subtitleFor(entry.version, null, null), canCopy: false, body: { kind: 'error', text: say('chat:group.spec.loading', undefined, 'Loading…') }, raw: null });
  try {
    const path = entry.version != null
      ? `/api/sessions/${sessionId}/specs/${entry.version}${demoQS()}`
      : `/api/sessions/${sessionId}/spec${demoQS()}`;
    const resp = await fetch(path);
    if (!resp.ok) {
      show(entry, {
        title: previewTitle,
        subtitle: entry.version != null ? subtitleFor(entry.version, null, null) : null,
        canCopy: false,
        body: {
          kind: 'error',
          text: resp.status === 404
            ? say('chat:group.spec.gone', undefined, 'This plan has gone.')
            : say('chat:group.spec.loadFailed', { status: resp.status }, `Could not load the plan (${resp.status}).`),
        },
        raw: null,
      });
      return;
    }
    const data = await resp.json();
    const spec = data.spec || data;
    const markdown = spec.content || say('chat:group.spec.empty', undefined, 'This plan is empty.');
    const version = valid(spec.version) ? spec.version : entry.version;
    show(entry, {
      title: previewTitle,
      subtitle: subtitleFor(version, spec.built_at, spec.pr_number),
      canCopy: !!spec.content,
      body: specBody(markdown, spec.content_html || null),
      raw: spec.content == null ? null : String(spec.content),
    });
  } catch (err) {
    if (holder.state.entry !== entry) return;
    show(entry, {
      title: previewTitle,
      subtitle: entry.version != null ? subtitleFor(entry.version, null, null) : null,
      canCopy: false,
      body: { kind: 'error', text: say('chat:group.spec.error', { message: (err as Error)?.message || '' }, 'The plan could not be loaded.') },
      raw: null,
    });
  }
}

/** The bot page's column when the detail was opened inside the side panel's frame. */
function topStore(): any {
  if (typeof window === 'undefined' || window.top === window.self) return null;
  try {
    // #6315: ONLY the bot page draws every kind of detail in its own column
    // (./index.tsx). Every other page's column is a DetailSlot, which lives in
    // the frame's own document — so an open there stays in the frame's store
    // instead of being sent to a top document that draws nothing.
    if (!/^#homeroom-bot(?:\/|$)/.test(String((window.top as any).location?.hash || ''))) return null;
    const detail = (window.top as any).UsernodeReact?.detail;
    return detail && typeof detail.open === 'function' ? detail : null;
  } catch {
    return null;
  }
}

/** Whether `doc` draws the column right now: the slot open, or the bot pane shown. */
function drawnIn(doc: Document | undefined): boolean {
  if (!doc) return false;
  try {
    const slot = doc.getElementById('gc-spec-side-panel');
    if (slot && slot.classList.contains('gc-spec-side-panel-open')) return true;
    const pane = doc.querySelector('[data-ai-preview-pane]');
    return !!pane
      && typeof pane.getClientRects === 'function'
      && pane.getClientRects().length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether the detail is actually on screen: the slot is open, or the bot
 * page's preview pane is shown. #6315: an open that lands nowhere looks like
 * a dead button, so the caller asks before it gives up.
 *
 * With no `doc`, it answers for wherever the open went — this document, or
 * the top document when the side panel's frame forwarded it to the bot page's
 * column (topStore). A named `doc` is answered alone.
 */
export function detailDrawn(doc?: Document): boolean {
  const own = doc ?? (typeof document === 'undefined' ? undefined : document);
  if (drawnIn(own)) return true;
  if (doc) return false;
  try {
    if (typeof window === 'undefined' || window.top === window.self) return false;
    if (!/^#homeroom-bot(?:\/|$)/.test(String((window.top as any).location?.hash || ''))) return false;
    return drawnIn((window.top as any).document);
  } catch {
    return false;
  }
}

// ── A before and after whose page had no column (#6315) ────────────────

/** How long an arrival waits for its page: a door that opened nothing is forgotten. */
export const SHOTS_ARRIVAL_TTL_MS = 30_000;

/**
 * The press had no column to open in, so the person was sent to the change's
 * page: its before and after open there as soon as the change is drawn.
 */
export function markShotsArrival(changeId: unknown, now: number = Date.now()): void {
  const id = Number(changeId);
  holder.shotsArrival = Number.isInteger(id) && id > 0 ? { id, at: now } : undefined;
}

/** The page the arrival names: whether it was asked for, recently. Answers once. */
export function takeShotsArrival(changeId: unknown, now: number = Date.now()): boolean {
  const id = Number(changeId);
  const arrival = holder.shotsArrival;
  if (!arrival || arrival.id !== id) return false;
  holder.shotsArrival = undefined;
  return now - arrival.at <= SHOTS_ARRIVAL_TTL_MS;
}

/**
 * Open the detail — replacing whatever was open (the chosen answer to "Read
 * while a design preview is open": the new detail replaces the old one).
 */
export function openDetail(input: {
  kind: DetailKind;
  ref: DetailRef;
  version?: number | null;
  payload?: DetailPayload;
  from?: string | null;
}): void {
  const kind = input?.kind;
  if (kind !== 'design' && kind !== 'plan' && kind !== 'shots' && kind !== 'draft') return;
  const ref = input.ref || {};
  if (kind === 'design' && (!valid(ref.conversationId) || !valid(ref.rootId))) return;
  if (kind === 'draft' && (!valid(ref.conversationId) || !valid(ref.actionId)
    || (ref.rootId != null && !valid(ref.rootId)))) return;
  if (!valid(input.version)) input = { ...input, version: null };
  // Inside the side panel's frame the bot page's column is the top document's.
  const top = topStore();
  if (top && top !== api) {
    top.open({ kind, ref, version: input.version ?? null, payload: input.payload, from: input.from ?? null });
    return;
  }
  // #6441: opening a change's before-and-after is seeing it, so its "Ready
  // to try" leaves the bell. The top document's store only (the branch above
  // has already handed the side panel's frame over to it), so it runs once.
  if (kind === 'shots' && valid(ref.changeId)) {
    if (typeof window !== 'undefined') window.Notifications?.markProposalSeen?.(Number(ref.changeId));
  }
  holder.seq += 1;
  const entry: DetailEntry = {
    kind,
    ref,
    version: input.version ?? null,
    payload: input.payload,
    from: input.from ?? null,
    seq: holder.seq,
  };
  holder.state = { entry, title: '', subtitle: null, canCopy: false, body: null, raw: null };
  notify();
  if (kind === 'plan') {
    if (valid(ref.sessionId)) {
      void fetchPlan(entry);
    } else {
      const markdown = String(input.payload?.markdown ?? '');
      show(entry, {
        title: String(input.payload?.title ?? ''),
        subtitle: null,
        canCopy: !!markdown && !input.payload?.error,
        body: input.payload?.error
          ? { kind: 'error', text: markdown }
          : input.payload?.html ? specBody(markdown, input.payload.html) : markdownBody(markdown),
        raw: input.payload?.error ? null : (markdown || null),
      });
    }
  }
  // #6315: a design drawn in this page's own column needs no jump. Wait two
  // frames for that column to open; only where nothing draws it does the
  // person go to the bot page's thread, as before.
  if (kind === 'design' && typeof window !== 'undefined') {
    const doc = typeof document === 'undefined' ? undefined : document;
    const rootId = ref.rootId;
    const go = () => {
      if (!rootId || detailDrawn(doc)) return;
      if (/^#homeroom-bot(?:\/|$)/.test(window.location.hash)) return;
      window.location.hash = `homeroom-bot/thread/${rootId}`;
    };
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(() => window.requestAnimationFrame(go));
    } else {
      window.setTimeout(go, 32);
    }
  }
  // #6248: a draft goes to the thread it was said in, or to Main.
  if (kind === 'draft' && typeof window !== 'undefined' && !/^#homeroom-bot(?:\/|$)/.test(window.location.hash)) {
    window.location.hash = valid(ref.rootId) ? `homeroom-bot/thread/${ref.rootId}` : 'homeroom-bot/main';
  }
}

/** Close the detail. */
export function closeDetail(): void {
  if (!holder.state.entry) return;
  holder.state = CLOSED;
  notify();
}

export function isDetailOpen(): boolean {
  return !!holder.state.entry;
}

/** The entry open now (not a hook): for the shims and for tests. */
export function detailEntry(): DetailEntry | null {
  return holder.state.entry;
}

/** The entry open now, or null. Null on the server and in the first render. */
export function useDetail(): DetailEntry | null {
  return useSyncExternalStore(
    (fn) => { holder.listeners.add(fn); return () => { holder.listeners.delete(fn); }; },
    () => holder.state.entry,
    () => null,
  );
}

/** The entry and the words it shows, for the pane that draws it. */
export function useDetailState(): DetailState {
  return useSyncExternalStore(
    (fn) => { holder.listeners.add(fn); return () => { holder.listeners.delete(fn); }; },
    () => holder.state,
    () => CLOSED,
  );
}

// ── Escape, once, while something is open ───────────────────────────────

let escapeBound = false;
function bindEscape(): void {
  if (escapeBound || typeof document === 'undefined') return;
  escapeBound = true;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !holder.state.entry) return;
    const target = e.target as HTMLElement | null;
    if (target && target.closest('input, textarea, [contenteditable="true"]')) return;
    // The owner of the detail closes it; a surface's own Escape (the
    // Workshop's panel) sees defaultPrevented and stays open.
    e.preventDefault();
    closeDetail();
  }, true);
}
if (typeof document !== 'undefined') bindEscape();

// ── What a surface opened from (the address remembers it) ──────────────

/**
 * Pure: the address's detail suffix, if this entry can be written into one.
 * A text plan has no address of its own.
 */
export function detailAddress(
  kind: DetailKind | null | undefined,
  ref: DetailRef | null | undefined,
  version: number | null | undefined,
): string {
  if (kind === 'plan' && valid(ref?.sessionId)) {
    return `/plan/${ref!.sessionId}${valid(version) ? `/${version}` : ''}`;
  }
  if (kind === 'shots' && valid(ref?.changeId)) return `/shots/${ref!.changeId}`;
  if (kind === 'design') return `/design${valid(version) ? `/${version}` : ''}`;
  return '';
}

/** The store, for the side panel's frame and the legacy shims. */
const api = {
  open: openDetail,
  close: closeDetail,
  get: () => holder.state.entry,
  isOpen: isDetailOpen,
  subscribe: (fn: () => void) => { holder.listeners.add(fn); return () => { holder.listeners.delete(fn); }; },
};

if (typeof window !== 'undefined') {
  const host = ((window as any).UsernodeReact ||= {});
  host.detail = api;
}
