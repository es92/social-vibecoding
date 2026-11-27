/**
 * A live app draft, as its private thread with Homeroom bot shows it
 * (services/live-drafts.js). There is no standing button: a draft is opened
 * by asking Homeroom bot (homeroom-bot-mayor.js open_app_preview), or with
 * New chat's "I want to make changes to a live preview of…" start
 * (./new-thread.tsx).
 *
 * 20 Nov 2026 (live-draft review, G): there is no bar any more. The "Live
 * preview · Tell Homeroom bot what to change. [Show preview] [Propose] [Close
 * draft]" strip under the thread's head, and its twin at the foot of the
 * thread's opening card, are gone. What they held is where the draft is
 * looked at:
 *
 *   - Propose (Update proposal once it is up for a vote) is in the preview's
 *     own header, beside its ×, with one short line saying where the draft
 *     stands (LiveDraftControls, drawn by ../staging/staging-overlay.tsx
 *     while the preview shown is this draft's);
 *   - Discard draft is the last entry of the menu under the preview's title
 *     (useLiveDraftActs' `discardItem`, drawn by ../detail/detail-card.tsx
 *     DetailPicker). Until 24 Nov 2026 it was "Close draft", a button beside
 *     Propose that people read as the ×: the × only hides the preview, and
 *     the draft stays open; this ends it;
 *   - showing the preview again is the thread head's Artifacts button
 *     (./index.tsx), whose column lists the draft as "Live preview of <app>"
 *     (../detail/detail-card.tsx).
 *
 * What the bar did besides drawing stays, in a part that draws nothing
 * (LiveDraftWatch, mounted on an open thread of theirs): the draft is read in
 * an effect, its preview comes up beside the chat the moment the draft is
 * opened (the change preview's own placement: ../staging/placement.ts), and
 * the frame reloads when a saved edit restarted it (`live_draft_changed`,
 * which public/js/app.js hands on as the window event LIVE_DRAFT_EVENT).
 *
 * C: a draft survives Propose. It stays the thread's, its preview running;
 * edits after it are "not in the proposal yet" until Update proposal.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { confirmAction } from '../../lib/confirm';
import { stagingBridge } from '../staging/staging-bridge.js';
import { stagingStore } from '../staging/staging-store.js';

/** The window event public/js/app.js turns a `live_draft_changed` frame into. */
export const LIVE_DRAFT_EVENT = 'live-draft-changed';

export interface LiveDraft {
  id: number;
  state: 'open' | 'proposed' | 'closed';
  live: 'starting' | 'live' | 'rebuilding' | 'failed' | 'proposed' | 'closed' | null;
  sessionId: number | null;
  rootId: number;
  /** J: the chat its thread is in (the server's, from 20 Nov 2026). */
  conversationId?: number | null;
  app: { slug: string; name: string };
  edits: number;
  headSha: string | null;
  prNumber: number | null;
  error: string | null;
  /** C: still worked on: open, or up for a vote with its own proposal. */
  editable?: boolean;
  /** C: its proposal while it is one, and how many edits are not in it yet. */
  proposal?: { sessionId: number; prNumber: number | null; open: boolean; pending: number; headSha: string | null } | null;
  /**
   * 24 Nov 2026: the proposal it started from, or null for main. `linked`:
   * the person's own, which the draft is on from the start.
   */
  builtOn?: { sessionId: number; prNumber: number | null; open: boolean; merged: boolean; linked: boolean } | null;
}

/** Pure (C): whether a draft is still shown: open, or up for a vote and still edited. */
export function liveDraftShown(draft: LiveDraft | null | undefined): draft is LiveDraft {
  if (!draft || !draft.sessionId) return false;
  return draft.state === 'open' || (draft.state === 'proposed' && draft.editable === true);
}

/** Pure: the status line's message id and values for a draft. */
export function draftLine(draft: LiveDraft): { id: string; values?: Record<string, unknown> } {
  if (draft.live === 'starting') return { id: 'messages:liveDraft.starting' };
  if (draft.live === 'rebuilding') return { id: 'messages:liveDraft.rebuilding' };
  if (draft.live === 'failed') return { id: 'messages:liveDraft.failed' };
  if (!draft.edits) return { id: 'messages:liveDraft.liveNone' };
  return { id: 'messages:liveDraft.live', values: { count: draft.edits } };
}

/**
 * Pure (G): the one short line the preview's header says about the draft,
 * and whether it is bad news. A preview that could not start is said here,
 * where the bar used to say it.
 */
export function draftHeadLine(draft: LiveDraft): { id: string; values?: Record<string, unknown>; bad: boolean } {
  if (draft.live === 'failed') return { id: 'messages:liveDraft.head.failed', bad: true };
  if (draft.live === 'starting') return { id: 'messages:liveDraft.head.starting', bad: false };
  if (draft.live === 'rebuilding') return { id: 'messages:liveDraft.head.rebuilding', bad: false };
  const proposal = draft.state === 'proposed' ? draft.proposal : null;
  if (proposal) {
    if (proposal.pending > 0) return { id: 'messages:liveDraft.head.pending', values: { count: proposal.pending }, bad: false };
    // Started on their own proposal and not changed yet: it is on that PR,
    // with nothing of its own ("Up for a vote with every change" said a
    // change was made).
    if (draft.builtOn?.linked && !draft.edits) {
      const number = draft.builtOn.prNumber ?? proposal.prNumber;
      return number
        ? { id: 'messages:liveDraft.head.onProposal', values: { number }, bad: false }
        : { id: 'messages:liveDraft.head.none', bad: false };
    }
    return { id: 'messages:liveDraft.head.inProposal', bad: false };
  }
  if (!draft.edits) return { id: 'messages:liveDraft.head.none', bad: false };
  return { id: 'messages:liveDraft.head.edits', values: { count: draft.edits }, bad: false };
}

/**
 * Pure (G, C): the header's one action to press: Propose for an open draft
 * with an edit, Update proposal for one up for a vote with changes not in it
 * yet, else none.
 */
export function draftAction(draft: LiveDraft): 'propose' | 'update' | null {
  if (draft.state === 'open') return draft.edits > 0 ? 'propose' : null;
  if (draft.state === 'proposed' && draft.proposal?.open && draft.proposal.pending > 0) return 'update';
  return null;
}

/**
 * Pure (request 7119, 27 Nov 2026): the proposal's page a draft opens, once it
 * has one, or null until then. A draft's own preview change (`sessionId`) is
 * not it: every open draft has one, and there is nothing to vote on yet.
 * Neither is the proposal it was started on (`builtOn.sessionId`), unless that
 * is its proposal (the linked case, where `proposal.sessionId` names it too).
 */
export function draftChangeHref(draft: LiveDraft | null | undefined): string | null {
  const slug = draft?.app?.slug;
  const sessionId = Number(draft?.proposal?.sessionId);
  if (!slug || !(sessionId > 0)) return null;
  return `#app/${encodeURIComponent(slug)}/dev/proposals/${sessionId}`;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data && typeof data.message === 'string' ? data.message : null;
    throw Object.assign(new Error(message || 'failed'), { status: res.status, said: message });
  }
  return data as T;
}

// ── The drafts this page knows, by the change their preview is ─────────
//
// The watcher of each open thread writes its draft here, and the preview's
// header reads the one whose change it shows (staging-store's sessionId).
// Kept on the global object, as the detail column's store is (../ai/detail.ts):
// the shell can be drawn by more than one copy of this module.

interface Known { drafts: Map<number, LiveDraft>; listeners: Set<() => void>; version: number }
const known: Known = ((globalThis as any).__usernodeLiveDrafts ||= { drafts: new Map(), listeners: new Set(), version: 0 });

function noteDraft(draft: LiveDraft | null, sessionId: number | null = draft?.sessionId ?? null): void {
  if (!sessionId) return;
  if (draft && liveDraftShown(draft)) known.drafts.set(sessionId, draft);
  else known.drafts.delete(sessionId);
  known.version += 1;
  known.listeners.forEach((fn) => fn());
}

/** The live draft whose preview is the change `sessionId`, or null. */
export function useDraftForSession(sessionId: number | null | undefined): LiveDraft | null {
  useSyncExternalStore(
    (fn) => { known.listeners.add(fn); return () => { known.listeners.delete(fn); }; },
    () => known.version,
    () => 0,
  );
  return sessionId ? known.drafts.get(Number(sessionId)) || null : null;
}

/** The live draft whose preview is the change `sessionId`, or null (not a hook: ./showing.ts). */
export function draftForSession(sessionId: number | null | undefined): LiveDraft | null {
  return sessionId ? known.drafts.get(Number(sessionId)) || null : null;
}

// The session whose preview this page last opened, so a saved edit reloads
// that frame and no other.
let shownSession: number | null = null;

/** A thread's live draft (open, or up for a vote and still edited), or null. */
export async function readLiveDraft(rootId: number): Promise<LiveDraft | null> {
  const out = await call<{ draft: LiveDraft | null }>(`/api/live-drafts?rootId=${encodeURIComponent(String(rootId))}`);
  return out.draft || null;
}

/** Show a live draft's preview beside its thread (the Artifacts column's row). */
export function openLivePreview(draft: LiveDraft) {
  noteDraft(draft);
  // Brought up to the draft's newest edit first: a preview that slept wakes on its image.
  void call<{ draft: LiveDraft }>(`/api/live-drafts/${draft.id}/preview`, { method: 'POST' })
    .then((out) => { if (out?.draft) noteDraft(out.draft); }, () => {});
  openPreview(draft);
}

/**
 * Pure (24 Nov 2026): what a draft's preview is opened with. The look-only
 * open: the draft's preview is built by the server, never by this press
 * (services/live-drafts.js open). `waitForStart`: a preview not up yet is
 * still starting (the server says "live" a moment before its address is
 * written), so the pane waits for it and opens it by itself, rather than
 * saying it stopped and that somebody who works on the project can start it
 * (AppView.ensureStaging). Not for one that could not start: that is said.
 */
export function draftPreviewOpts(draft: LiveDraft): { readOnly: true; app: { slug: string }; waitForStart?: true } {
  return {
    readOnly: true,
    app: { slug: draft.app.slug },
    ...(draft.live === 'failed' ? {} : { waitForStart: true as const }),
  };
}

function openPreview(draft: LiveDraft) {
  const view = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (!draft.sessionId || !view || typeof view.ensureStaging !== 'function') return;
  shownSession = draft.sessionId;
  void view.ensureStaging(draft.sessionId, null, null, draftPreviewOpts(draft));
}

/**
 * Pure (24 Nov 2026): whether a frame whose `src` ATTRIBUTE is `src` shows a
 * preview: an http(s) address on another origin than Homeroom's (`home`).
 * Empty and about:blank are not one. The `src` property is never what is
 * read: a cleared frame's reads back as Homeroom's own page.
 */
export function showsPreview(src: string | null | undefined, home: string): boolean {
  if (!src || src === 'about:blank') return false;
  let url: URL;
  try { url = home ? new URL(src, home) : new URL(src); } catch { return false; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  try { return url.origin !== new URL(home).origin; } catch { return true; }
}

function frameShowsPreview(frame: HTMLIFrameElement | null = stagingBridge.frame()): boolean {
  const home = typeof location !== 'undefined' ? location.origin : '';
  return !!frame && showsPreview(frame.getAttribute('src'), home);
}

// The pane is open on this session's preview: the one this page last opened,
// and the one the pane says it shows (../staging/placement.ts).
function paneOn(sessionId: number | null): boolean {
  const st = stagingStore.get();
  return !!sessionId && sessionId === shownSession && st.open
    && (st.sessionId == null || st.sessionId === sessionId);
}

/**
 * Pure (24 Nov 2026): what a `live_draft_changed` frame does to the preview.
 * 'open' brings it up (ensureStaging asks the server again), 'reload' points
 * the frame at the draft's newest edit, null leaves it. A preview still
 * starting when its pane opened has no preview in its frame (a dead end, or
 * a loader): when it comes up, or a reload is asked for, the pane is opened
 * on it again, so it comes up by itself.
 */
export function draftPreviewStep(input: {
  draft: LiveDraft;
  /** Where the preview stood before this frame. */
  last: LiveDraft['live'];
  opened?: boolean;
  reload?: boolean;
  /** The pane is open on this draft's preview. */
  paneHere: boolean;
  /** Its frame shows a preview (showsPreview). */
  framed: boolean;
}): 'open' | 'reload' | null {
  const { draft, last } = input;
  const shown = liveDraftShown(draft);
  // Opened just now (by asking Homeroom bot): its preview comes up beside the chat.
  if (input.opened && shown) return 'open';
  // Started, or built again (a new package): the frame shows it once it serves.
  const cameUp = shown && draft.live === 'live' && (last === 'starting' || last === 'rebuilding');
  if (!input.reload && !cameUp) return null;
  if (shown && input.paneHere && !input.framed) return 'open';
  return 'reload';
}

// The frame shows the draft's newest edit: the same address, with a sign-in
// token minted now (the one it opened with lasts an hour).
async function reloadPreview(sessionId: number | null, slug: string) {
  if (!paneOn(sessionId)) return;
  const frame = stagingBridge.frame();
  // 24 Nov 2026: never Homeroom's own page, which a cleared frame's `src` reads as.
  if (!frame || !frameShowsPreview(frame)) return;
  let src = frame.getAttribute('src') as string;
  try {
    const view = (window as any).AppView;
    const token = typeof view?._mintToken === 'function' ? await view._mintToken(slug) : null;
    const url = new URL(src);
    if (token && url.searchParams.has('token')) {
      url.searchParams.set('token', token);
      src = url.toString();
    }
  } catch { /* the address it has */ }
  if (stagingBridge.frame() === frame && sessionId === shownSession) stagingBridge.setSrc(src);
}

/**
 * A thread's live draft, read in an effect and kept current from the
 * server's `live_draft_changed` frames: a newly opened draft brings its
 * preview up, and a saved edit reloads it. Null while there is none.
 */
export function useLiveDraft(rootId: number | null | undefined): LiveDraft | null {
  const [draft, setDraft] = useState<LiveDraft | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const lastLive = useRef<LiveDraft['live']>(null);
  useEffect(() => { lastLive.current = draft?.live ?? null; }, [draft]);

  const load = useCallback(async () => {
    if (!rootId) return;
    try {
      const next = await readLiveDraft(rootId);
      if (!alive.current) return;
      setDraft(liveDraftShown(next) ? next : null);
      noteDraft(next);
    } catch { /* nothing is open that it could show */ }
  }, [rootId]);

  useEffect(() => {
    setDraft(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!rootId) return undefined;
    const heard = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const next: LiveDraft | null = detail.draft || null;
      if (!next || Number(next.rootId) !== Number(rootId)) return;
      const shown = liveDraftShown(next);
      const last = lastLive.current;
      lastLive.current = next.live;
      setDraft(shown ? next : null);
      noteDraft(next);
      const step = draftPreviewStep({
        draft: next, last, opened: !!detail.opened, reload: !!detail.reload,
        paneHere: paneOn(next.sessionId), framed: frameShowsPreview(),
      });
      if (step === 'open') openPreview(next);
      else if (step === 'reload') void reloadPreview(next.sessionId, next.app.slug);
    };
    window.addEventListener(LIVE_DRAFT_EVENT, heard);
    return () => window.removeEventListener(LIVE_DRAFT_EVENT, heard);
  }, [rootId]);

  return draft;
}

/** What the bar did besides drawing, for an open thread of theirs: it draws nothing. */
export function LiveDraftWatch({ rootId, onDraft }: { rootId: number; onDraft?: (draft: LiveDraft | null) => void }): ReactNode {
  const draft = useLiveDraft(rootId);
  useEffect(() => { onDraft?.(draft); }, [draft, onDraft]);
  return null;
}

/** What a live draft's preview can do to it: Propose or Update proposal, and Discard draft. */
export interface LiveDraftActs {
  busy: 'propose' | 'update' | 'close' | null;
  /** Why the last of them failed, said on the header's line. */
  error: string | null;
  act: (what: 'propose' | 'update') => Promise<void>;
  /** Asks first, then ends the draft (POST /api/live-drafts/:id/close). */
  discard: () => Promise<void>;
  /**
   * Discard draft as the title menu's last entry (DetailPicker's `end`), or
   * null when the preview is not a draft's. `alone` names the title's button
   * where the menu holds nothing else: on a phone, and in the whole window.
   */
  discardItem: { label: string; alone: (title: string) => string; danger: true; disabled: boolean; onSelect: () => void; data: Record<string, string> } | null;
}

/**
 * The actions of the draft a preview shows, held once for its header: the
 * header's line and its button (LiveDraftControls) and the title menu's
 * Discard draft read the same busy and error.
 */
export function useLiveDraftActs(draft: LiveDraft | null): LiveDraftActs {
  const t = useMessages('messages');
  const [busy, setBusy] = useState<LiveDraftActs['busy']>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // A refusal is said until the draft moves on: another draft, or this one
  // proposed (24 Nov 2026: by the Propose under the bot's reply, tapped with
  // this one, whose own answer was that it is being put up for a vote).
  useEffect(() => { setError(null); }, [draft?.id, draft?.state]);

  const failed = (err: any) => {
    if (alive.current) setError(err?.said || t('messages:liveDraft.error'));
  };
  const act = async (what: 'propose' | 'update') => {
    if (!draft) return;
    setBusy(what);
    setError(null);
    try {
      const out = await call<{ draft: LiveDraft }>(`/api/live-drafts/${draft.id}/${what}`, { method: 'POST', body: '{}' });
      if (out?.draft) noteDraft(out.draft, draft.sessionId);
    } catch (err) { failed(err); } finally { if (alive.current) setBusy(null); }
  };
  const discard = async () => {
    if (!draft) return;
    const ok = await confirmAction({
      title: t('messages:liveDraft.closeConfirm.title'),
      message: draft.state === 'proposed'
        ? t('messages:liveDraft.closeConfirm.proposed')
        : t('messages:liveDraft.closeConfirm.open'),
      confirmLabel: t('messages:liveDraft.close'),
      danger: true,
    });
    if (!ok) return;
    setBusy('close');
    setError(null);
    try {
      await call(`/api/live-drafts/${draft.id}/close`, { method: 'POST' });
      noteDraft(null, draft.sessionId);
      // The draft's preview goes with it.
      if (stagingStore.get().open) (window as any).AppView?.closeStagingOverlay?.();
    } catch (err) { failed(err); } finally { if (alive.current) setBusy(null); }
  };
  const discardItem = draft ? {
    label: t('messages:liveDraft.discard'),
    alone: (title: string) => t('messages:liveDraft.menu', { title }),
    danger: true as const,
    disabled: busy === 'close',
    onSelect: () => { void discard(); },
    data: { 'data-live-draft-close': '' },
  } : null;
  return { busy, error, act, discard, discardItem };
}

/**
 * G: a live draft's own controls in its preview's header, beside its ×: one
 * short line saying where the draft stands, Open change (request 7119: the
 * way through to its proposal, drawn only once the draft is proposed), and
 * Propose (Update proposal once it is up for a vote with changes not in it
 * yet). Discard draft is not here: it is the title menu's last entry
 * (useLiveDraftActs). Drawn by
 * ../staging/staging-overlay.tsx only while the preview shown is this
 * draft's, with the actions it holds for the header.
 */
export function LiveDraftControls({ draft, acts }: { draft: LiveDraft | null; acts?: LiveDraftActs }): ReactNode {
  const t = useMessages('messages');
  // Not a live draft's preview: nothing.
  if (!draft || !acts) return null;

  const { busy, error, act } = acts;
  const line = draftHeadLine(draft);
  const action = draftAction(draft);
  const changeHref = draftChangeHref(draft);

  return (
    <span className="staging-draft" data-live-draft={draft.id} data-live-draft-state={draft.live || ''} role="group"
      aria-label={t('messages:liveDraft.controls')}>
      <span className="staging-draft-line" data-bad={line.bad ? '' : undefined} data-live-draft-line="" aria-live="polite"
        title={line.bad ? t('messages:liveDraft.foot.failedSub') : undefined}>
        {error || t(line.id, line.values)}
      </span>
      {changeHref ? (
        <button type="button" className="staging-draft-quiet" data-live-draft-change=""
          onClick={() => {
            // The preview closes as its change page opens, as Discard draft does.
            if (stagingStore.get().open) (window as any).AppView?.closeStagingOverlay?.();
            window.location.hash = changeHref;
          }}>
          {t('messages:liveDraft.openChange')}
        </button>
      ) : null}
      {action === 'propose' ? (
        <button type="button" className="staging-draft-act" data-live-draft-propose=""
          disabled={busy === 'propose' || draft.live !== 'live'} onClick={() => void act('propose')}>
          {busy === 'propose' ? t('messages:liveDraft.proposing') : t('messages:liveDraft.propose')}
        </button>
      ) : null}
      {action === 'update' ? (
        <button type="button" className="staging-draft-act" data-live-draft-update=""
          title={t('messages:liveDraft.updateNote')}
          disabled={busy === 'update'} onClick={() => void act('update')}>
          {busy === 'update' ? t('messages:liveDraft.updating') : t('messages:liveDraft.update')}
        </button>
      ) : null}
    </span>
  );
}
