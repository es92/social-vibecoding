/**
 * What public/js/group-chat.js publishes about its two boxes, as view
 * models: the staged reply's chip and the status line over the box.
 *
 * ── Two scopes, one shape ─────────────────────────────────────────────
 *
 * The chat has two boxes: `general`, at the foot of a channel's pane, and
 * `thread`, at the foot of a request's, a change's or a decision's page.
 * They are the same box (Messages' own, ./composer.tsx), so the module
 * publishes into a slot per scope without asking which is on screen.
 *
 * ── What stays in group-chat.js ───────────────────────────────────────
 *
 * Which message a staged reply points at (GroupChat.replyDraft, taken by
 * GroupChat.send), and the typing ticker and offline queue the status line
 * reports on. The box's words, its draft, its files and its menus are the
 * box's (../messages/composer.tsx MessageBox).
 */

import { createStore } from '../../lib/plain-store.js';

/** The staged reply chip: "↩ Replying to @alice" over a one-line snippet. */
export interface QuoteChipView {
  /** Who is being replied to: "@alice", "PR #12". Empty when `unnamed` is set. */
  label: string;
  /** The pull request being replied to, by number ('' when it has none); null for anything else. */
  pr?: string | null;
  /**
   * A row with nobody to name: a platform message (`event`), or a message
   * whose author is gone (`message`). The strip then has a sentence of its own.
   * `system` and `someone`: the row showed a stand-in where an author would
   * be ("System", "Someone"), and `label` is that stand-in, not a name.
   */
  unnamed?: 'event' | 'message' | 'system' | 'someone' | null;
  snippet: string;
}

export interface ComposerSlot {
  quote: QuoteChipView | null;
  /**
   * The one-line slot under the messages: who is typing, or — when the
   * socket is down, which wins because it is the actionable one — how many
   * messages are waiting to go out.
   */
  status: string;
  /**
   * #6228: what Homeroom bot is doing with the newest reply in this thread,
   * shown in the status slot only while nothing else (typing, reconnecting)
   * is saying something there. `mine`: the viewer wrote the reply.
   */
  bot?: { state: 'will_read' | 'reading' | 'quiet'; mine: boolean } | null;
}

export type ComposerScope = 'general' | 'thread';

export const EMPTY_SLOT: ComposerSlot = {
  quote: null,
  status: '',
};

export interface ComposerState {
  general: ComposerSlot;
  thread: ComposerSlot;
}

export const EMPTY_COMPOSER: ComposerState = { general: EMPTY_SLOT, thread: EMPTY_SLOT };

export const composerStore = createStore<ComposerState>(EMPTY_COMPOSER);
