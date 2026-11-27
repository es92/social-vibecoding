/**
 * The legacy → React seam for the group chat transcript.
 *
 * `public/js/group-chat.js` is a classic script that runs before this bundle,
 * so it cannot import anything from here. It calls by name instead:
 * `window.UsernodeReact.groupChat.mountTranscript(host)` where it used to
 * assign `container.innerHTML = …`, and pushes its view model through
 * `publishTranscript`.
 *
 * ── Why the host is mounted, not rendered into the tree ───────────────
 *
 * `#gc-messages` does not exist in the shell's markup. `AppView.renderGroupChatTab`
 * creates it at runtime inside `#app-content`, and destroys it on every tab
 * switch — so there is no node for the main React tree to own, and the portal
 * has to be (re)established each time the host is rebuilt. That is the same
 * situation the Dev board's regions are in, and this uses the same machinery
 * (../../lib/legacy-portals).
 *
 * `unmount` matters here more than it does for the board: the transcript is
 * re-created on every switch between the chat tab and anything else, and a
 * portal left pointing at a detached node keeps its subtree — and its store
 * subscription — alive for the life of the page.
 *
 * Published at module-evaluation time, like features/dev-board/mount.ts, so the
 * API exists before hydration and therefore long before `App.switchTab()` can
 * reach the chat tab. The `typeof window` guard is not decoration: the SSG
 * prerender pass evaluates this whole module graph in Node.
 */

import { createElement } from 'react';
import { flushSync } from 'react-dom';

import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { putInComposer } from '../messages/composer';
import { shownChatScope } from './composer';
import {
  composerStore,
  type ComposerScope,
  type ComposerSlot,
} from './composer-store';
import { GENERAL_FOLLOW_PX, GeneralChat, type GeneralChatProps } from './general-chat';
import { ReactionBar, type ReactionBarProps } from './reaction-bar';
import { reactionBarStore, type ReactionBarState } from './reaction-bar-store';
import { ThreadShell, type ThreadShellProps } from './thread-shell';
import { Transcript } from './transcript';
import {
  EMPTY_VIEW,
  transcriptStore,
  unreadOpenings,
  type TranscriptLead,
  type TranscriptMessage,
  type TranscriptState,
} from './transcript-store';
import { attachLineHold, lineTopIn, openingScrollTop } from '../messages/unread-anchor';

/**
 * Whether two view-model values hold the same data. The rows are plain data
 * (strings, numbers, booleans, null, arrays and plain objects) that
 * `GroupChat._messageView` builds afresh on every whole publish.
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!sameData(a[i], b[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(right, k) && sameData(left[k], right[k]));
}

/**
 * A whole publish, with every row that says nothing new replaced by the row
 * already on screen (by id), and the list itself kept when no row changed.
 *
 * `GroupChat.render()` rebuilds the whole list from its messages — after a
 * delete, a history page, a membership change — so every row arrived as a
 * new object, and the memo()'d rows (./transcript.tsx) all rendered again:
 * every body's markup and every thumbnail rebuilt for one changed row. Kept,
 * an unchanged row skips its render. The store is still published, so the
 * rows' surroundings (the lead, which reply thread is open) are read again.
 */
export function keepUnchanged(previous: TranscriptMessage[] | undefined, next: TranscriptMessage[]): TranscriptMessage[] {
  if (!previous || !previous.length) return next;
  const byId = new Map<number, TranscriptMessage>();
  for (const m of previous) if (m.id != null) byId.set(m.id, m);
  let same = previous.length === next.length;
  const kept = next.map((m, i) => {
    const held = m.id != null ? byId.get(m.id) : undefined;
    const row = held && sameData(held, m) ? held : m;
    if (row !== previous[i]) same = false;
    return row;
  });
  return same ? previous : kept;
}

/** Mount (or re-establish) the transcript inside the host app-view just built. */
export function mountTranscript(host: Element | null, key = 'main'): void {
  if (!host) return;
  mountLegacyPortal(host, createElement(Transcript, { source: key }));
}

export function unmountTranscript(host: Element | null): void {
  if (!host) return;
  unmountLegacyPortal(host);
}

/**
 * The whole transcript, replacing whatever was there.
 *
 * Batched by default. `flush` commits the rows before this returns, for a
 * caller that measures the scroller on the next line — a history page lands
 * above the reader, and the offset that keeps them in place is the height the
 * new rows added. Measured against a batched publish that height was 0: the
 * first page opened at its OLDEST message instead of the newest, and every
 * "earlier" page threw the reader to the top of what had just loaded (iOS has
 * no scroll anchoring to hide it). Only for callers outside React's own
 * render and effects, where flushSync logs a console error — see
 * `appendTranscriptMessage` below.
 */
export function publishTranscript(
  messages: TranscriptMessage[],
  key = 'main',
  lead: TranscriptLead = { earlier: false, placeholder: null },
  opts: { flush?: boolean } = {},
): void {
  const set = () => transcriptStore.set((s: TranscriptState) => ({
    ready: true,
    byKey: { ...s.byKey, [key]: { messages: keepUnchanged(s.byKey[key]?.messages, messages), lead } },
  }));
  if (opts.flush) flushSync(set);
  else set();
}

/**
 * Append one row — the live-message path.
 *
 * A separate entry point rather than a re-publish of the whole list because
 * that is what the caller has: `appendMessage` used to `insertAdjacentHTML` a
 * single row precisely so an incoming message did not rebuild the transcript
 * under the reader's scroll position. Appending to the array preserves that
 * property through the reconciler instead of around it.
 */
export function appendTranscriptMessage(message: TranscriptMessage, key = 'main'): void {
  // Flushed, and only here (#2389): both callers — `handleIncoming` and
  // `_handleThreadIncoming` — scroll to the bottom on the very next line,
  // measuring `scrollHeight`. Batched, that measured the transcript WITHOUT
  // the new row, so the message you had just sent landed under the fold. The
  // store as a whole is deliberately not `setFlush(flushSync)`: its patch path
  // runs from `refreshVoteControls` inside a React effect, where flushSync
  // logs a console error. Both append callers are websocket handlers.
  flushSync(() => {
    transcriptStore.set((s: TranscriptState) => {
      const view = s.byKey[key] || EMPTY_VIEW;
      // `lead` is carried through deliberately: this is a single-row append,
      // not a re-publish, and rebuilding it here is not how the empty-state
      // line is cleared. A placeholder published for an empty thread stops
      // rendering because `TranscriptRows` derives it from the rows
      // (`view.lead.placeholder && !rows.length`), the same way the quiet
      // card does — see #2498 and tests/group-chat-thread-placeholder.test.js,
      // which pins that the append leaves `lead` alone.
      return {
        ready: true,
        byKey: { ...s.byKey, [key]: { ...view, messages: [...view.messages, message] } },
      };
    });
  });
}

/**
 * Patch one row in place — reactions, a bookmark toggle, an edit.
 *
 * Each of these used to be its own targeted `innerHTML` write into a row the
 * module had built. They are a field update now, and React repaints only the
 * row whose identity changed. A patch for an unknown id is a no-op rather than
 * an append: the row may legitimately have been pruned by a reload that raced
 * the websocket event.
 */
/** Whether a patched field says the same thing: identity, or the same plain-object facts. */
function sameValue(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  if (!isPlainObject(before) || !isPlainObject(after)) return false;
  return JSON.stringify(before) === JSON.stringify(after);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

export function patchTranscriptMessage(id: number, patch: Partial<TranscriptMessage>): void {
  transcriptStore.set((s: TranscriptState) => {
    let hit = false;
    const byKey: Record<string, typeof EMPTY_VIEW> = {};
    // Patched across EVERY transcript: the same message can be on screen in
    // both the general chat and an open thread, and a reaction on one is a
    // reaction on the other.
    for (const [k, view] of Object.entries(s.byKey)) {
      byKey[k] = {
        ...view,
        messages: view.messages.map((m: TranscriptMessage) => {
          if (m.id !== id) return m;
          // A patch that says nothing new is not a state change. That is a
          // saved repaint everywhere, and a REQUIREMENT for the one caller
          // that runs after every render: `refreshVoteControls` patches each
          // vote row's tint from the effect in transcript.tsx, so an
          // unconditional new object would render → patch → render forever.
          // #6236: it patches `vote` too, a plain object built afresh on
          // every refresh, so a plain object that spells the same facts is
          // the same value here; anything else compares by identity.
          const keys = Object.keys(patch) as (keyof TranscriptMessage)[];
          if (keys.every((key) => sameValue(m[key], patch[key]))) return m;
          hit = true;
          return { ...m, ...patch };
        }),
      };
    }
    return hit ? { ...s, byKey } : s;
  });
}

/**
 * The reaction bar's store is flushed synchronously:
 * `_openReactionBar` publishes `{ gridOpen: false, editable }` and then reads
 * `bar.offsetWidth` / `bar.offsetHeight` to decide whether the bar fits above
 * the row or has to flip below it. Whether the pencil is rendered changes the
 * first of those, so a batched publish would place the bar against the
 * PREVIOUS row's answer.
 */
reactionBarStore.setFlush(flushSync);

/**
 * The composer's store gets it too: `setQuote` publishes the staged reply
 * and then focuses the box on its next line, so the chip is drawn when the
 * caret arrives, as it was when the chip was `innerHTML`.
 */
composerStore.setFlush(flushSync);

/**
 * Put words in a project chat's box, the channel pane's (`general`) or a
 * thread's (`thread`): Go ahead on a request's plan
 * (AppView.answerBotOnRequest). The box is Messages' (../messages/composer.tsx
 * putInComposer), so the words go through its own state and draft.
 */
export function putInChatComposer(which: ComposerScope, text: string, opts: { onlyIfEmpty?: boolean } = {}): boolean {
  const scope = shownChatScope(which);
  return scope != null && putInComposer(scope, text, opts);
}
//
/**
 * The thread panel's shell — scroller, messages host, typing slot, composer.
 *
 * `mountThread` used to assign `container.innerHTML` and then bind its
 * listeners to what came back. The assignment is this; the box at its foot
 * is Messages' (./composer.tsx ChatComposer) and needs no listeners.
 *
 * The props go through the portal node rather than a store: they are fixed for
 * the life of one mount and only change when `mountThread` runs again, and
 * `mountLegacyPortal` re-renders and commits synchronously — so the node IS
 * the publish.
 */
export function mountThreadShell(host: Element | null, props: ThreadShellProps): void {
  if (!host) return;
  mountLegacyPortal(host, createElement(ThreadShell, props));
}

// ── The two boxes ─────────────────────────────────────────────────────
//
// One store with a slot per scope (the staged reply, the status line), two
// callers. See ./composer-store.ts for why they are together.

/**
 * The general chat pane, into `#dev-chat-body`.
 *
 * `AppView.renderGroupChatTab` used to assign that host's `innerHTML` and then
 * bind its listeners to what came back. The assignment is this; the box is
 * Messages' and needs none, as on a thread's page.
 */
export function mountGeneralChat(host: Element | null, props: GeneralChatProps): void {
  if (!host) return;
  mountLegacyPortal(host, createElement(GeneralChat, props));
}

export function unmountGeneralChat(host: Element | null): void {
  if (!host) return;
  unmountLegacyPortal(host);
}

/**
 * Patch one box's slot — the staged reply, the status line — leaving the
 * other scope's alone. A patch rather than a whole-state publish because the
 * module's writers are independent: the quote knows nothing about the
 * typing ticker.
 */
export function publishComposer(scope: ComposerScope, patch: Partial<ComposerSlot>): void {
  composerStore.set((s) => ({ ...s, [scope]: { ...s[scope], ...patch } }));
}

// ── The long-press reaction bar ───────────────────────────────────────
//
// One floating host for every message row, created and placed by
// `_ensureReactionBar` / `_openReactionBar`. Its contents are a portal
// established once, and its two moving parts are a publish.

/**
 * Establish the bar's contents. Idempotent — the host is cached by the module.
 *
 * The emoji sets arrive as props on the portal node rather than through the
 * store: they are constants in public/js/group-chat.js, fixed for the life of
 * the page, and `mountLegacyPortal` commits synchronously — so the mount IS
 * their publish, the same way ThreadShell's layout is.
 */
export function mountReactionBar(host: Element | null, props: ReactionBarProps): void {
  if (!host) return;
  mountLegacyPortal(host, createElement(ReactionBar, props));
}

/**
 * The grid's open state and whether this row offers Edit, together — the two
 * `classList.toggle` calls that used to reach into the built markup.
 */
export function publishReactionBar(next: ReactionBarState): void {
  reactionBarStore.set(next);
}

/**
 * Open the channel at its "New" line (`GroupChat._openAtUnread`): the line a
 * row or two under the top of `container`, as a conversation in Messages
 * opens (../messages/unread-anchor.ts), and held there while what is drawn
 * above it fills in. Answers where it went and whether that is the bottom
 * (`pinned`, the module's `_lockedToBottom`), or null with no line drawn.
 * The line is the transcript's (./transcript.tsx), so it is found and
 * measured here rather than by the module.
 */
let releaseLine: (() => void) | null = null;
export function openAtUnreadLine(container: HTMLElement | null): { top: number; pinned: boolean } | null {
  const line = container?.querySelector<HTMLElement>('[data-unread-line]') || null;
  if (!container || !line) return null;
  const at = openingScrollTop({
    lineTop: lineTopIn(container, line),
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    slack: GENERAL_FOLLOW_PX,
  });
  container.scrollTop = at.top;
  releaseLine?.();
  releaseLine = at.pinned ? null : attachLineHold(container, line);
  unreadOpenings.set((s: { count: number }) => ({ count: s.count + 1 }));
  return at;
}

if (typeof window !== 'undefined') {
  const w = window as unknown as { UsernodeReact?: Record<string, unknown> };
  w.UsernodeReact = w.UsernodeReact || {};
  (w.UsernodeReact as Record<string, unknown>).groupChat = {
    mountTranscript,
    unmountTranscript,
    publishTranscript,
    appendTranscriptMessage,
    patchTranscriptMessage,
    mountThreadShell,
    mountReactionBar,
    publishReactionBar,
    mountGeneralChat,
    unmountGeneralChat,
    publishComposer,
    putInChatComposer,
    openAtUnreadLine,
  };
}
