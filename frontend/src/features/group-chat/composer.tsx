/**
 * A project's chat's message box — a topic's channel and the thread on a
 * request, a change or a decision — and the status line over it.
 *
 * ── The box is Messages' box (one message box, 27 Nov 2026) ───────────
 *
 * The box is ../messages/composer.tsx's MessageBox, the one every chat
 * draws: the field, the formatting, the @, # and emoji menus, the draft, the
 * attachments strip, dictation and the send. This file only says where the
 * words go — the PLACE: sent over the chat's socket (GroupChat.send, which
 * queues it while the socket is down and takes the staged reply), files
 * uploaded to the project's chat, `@` and `#` answered by ./chat-sources.ts,
 * and the staged reply's chip from ./composer-store.ts. The box's draft is
 * saved the one way every box saves it (../messages/store draftFor), under
 * the place's own scope (`chatScopeKey`), and a draft the old box saved
 * under `usernode:gc-draft:*` is carried over once, on the first visit.
 *
 * It replaces the form, the reply strip, the error line and the uploads
 * strip this file drew for public/js/group-chat.js, which bound its own
 * listeners, menus and drafts to them by id. The ids stay on the box
 * (`gc-thread-input`, `gc-form` …): the quote's focus, the request page's
 * plan card and the declared checks find it by them.
 *
 * ── What stays the chat's ─────────────────────────────────────────────
 *
 * The status line (who is typing, the reconnect notice, Homeroom bot's
 * line) is published by the module into ./composer-store.ts and drawn here.
 * Which message a staged reply points at is the module's too: it is staged
 * from a row (GroupChat.setQuote) and taken by GroupChat.send.
 */

import { useState, type ReactNode, type RefObject } from 'react';

import { ChatStatusLine } from '@/components/ui/chat';
import { chatAttachmentLimit } from '../attachments/limits';
import { MessageBox, type ComposerIds, type ComposerPlace, type ComposerReply } from '../messages/composer';
import { draftFor, setDraft, type ComposerScope as DraftScope } from '../messages/store';
import { BOT_CHIP_CLASS } from './bot-request';
import { chatPeople, chatRefMatch, heldChatRefs, loadChatRefs, uploadChatFile } from './chat-sources';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import {
  composerStore,
  type ComposerScope,
  type ComposerSlot,
  type QuoteChipView,
} from './composer-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).GroupChat : null) || null;
}

/**
 * The ids each scope's box answers to. Read back by public/js/group-chat.js
 * (`setQuote` focuses the field), by the request page's plan card, and by
 * `dapp.json`'s declared checks. Written out per scope rather than built by
 * interpolation, which also keeps them greppable.
 */
const IDS: Record<ComposerScope, ComposerIds & { typing: string }> = {
  general: { card: 'gc-form', input: 'gc-input', attach: 'gc-attach-btn', file: 'gc-file-input', typing: 'gc-typing' },
  thread: { card: 'gc-thread-form', input: 'gc-thread-input', attach: 'gc-thread-attach-btn', file: 'gc-thread-file-input', typing: 'gc-thread-typing' },
};

/** A topic's channel, or the thread on a request, a change or a decision. */
export interface ChatThreadRef {
  type: string;
  ref: number;
}

/**
 * The draft scope of a project chat's box: the project's own stream, a
 * topic's channel, or a thread (`app:<slug>`, `app:<slug>:<type>:<ref>`).
 * The comments under a change write into that change's thread, so they
 * share its draft.
 */
export function chatScopeKey(slug: string, thread: ChatThreadRef | null | undefined): string {
  return thread ? `app:${slug}:${thread.type}:${thread.ref}` : `app:${slug}`;
}

/**
 * Carry a draft the old box saved (`usernode:gc-draft:<slug>`, and
 * `…:<type>:<ref>` for a thread) into the box's scope, once, and stop
 * writing it: what was typed before this change is still there on the
 * first visit after it. A topic's channel read the project's own key.
 */
const carried = new Set<string>();
export function carryOldChatDraft(slug: string, thread: ChatThreadRef | null | undefined, scope: string, channel = false): void {
  if (carried.has(scope) || typeof localStorage === 'undefined') return;
  carried.add(scope);
  const old = thread && !channel ? `usernode:gc-draft:${slug}:${thread.type}:${thread.ref}` : `usernode:gc-draft:${slug}`;
  try {
    const words = localStorage.getItem(old);
    if (words == null) return;
    if (!draftFor(scope)) setDraft(scope, words.slice(0, 8000));
    localStorage.removeItem(old);
  } catch { /* storage unavailable */ }
}

/**
 * The box each scope draws now, so a classic caller can put words in it
 * (`putInChatComposer`): the reply starters, Go ahead on a request's plan.
 */
const shown: Partial<Record<ComposerScope, DraftScope>> = {};
export function shownChatScope(which: ComposerScope): DraftScope | null {
  return shown[which] ?? null;
}

export function useComposerSlot(scope: ComposerScope): ComposerSlot {
  return useStoreState(composerStore)[scope];
}

/** #6228: the status line's words for each state of the bot's reply line. */
const BOT_STATUS_WORDS = {
  will_read: 'chat:group.botStatus.willRead',
  reading: 'chat:group.botStatus.reading',
  quiet: 'chat:group.botStatus.quiet',
} as const;

/**
 * The one-line slot under the messages — who is typing, or the reconnect
 * notice. `*View` is the pure half, which is what the tests render.
 *
 * It is the chat foot's status line (@/components/ui/chat ChatStatusLine),
 * so its size, colour and inset are the ones Messages' typing line has, and
 * it takes no room while it is empty (1 November 2026). The callers passed
 * their own Tailwind (`h-5` in the chat pane and the topic thread, `h-4` in
 * the boxed one, three different insets), which held the line open while it
 * said nothing and made each copy a little different.
 */
export function StatusLineView({ scope, status, bot = null }: {
  scope: ComposerScope;
  status: string;
  bot?: ComposerSlot['bot'];
}) {
  const t = useMessages('chat');
  // Typing, or the reconnect notice, takes the line while it says something;
  // the bot's line comes back afterwards.
  const words = !status && bot
    ? t(bot.state === 'reading' && bot.mine
      ? 'chat:group.botStatus.readingYours'
      : BOT_STATUS_WORDS[bot.state])
    : '';
  return (
    <ChatStatusLine id={IDS[scope].typing}>
      {status || (bot ? (
        <span className={BOT_CHIP_CLASS} data-bot-status={bot.state}>
          {bot.state === 'quiet' ? null : <span aria-hidden="true">👀</span>}
          <span>{words}</span>
        </span>
      ) : null)}
    </ChatStatusLine>
  );
}

export function StatusLine({ scope }: { scope: ComposerScope }) {
  const slot = useComposerSlot(scope);
  return <StatusLineView scope={scope} status={slot.status} bot={slot.bot} />;
}

/**
 * "Replying to @alice" over the quoted line (#15), worded as the chat words
 * it: a platform message, a message whose author is gone, a stand-in
 * author, or a pull request each have a sentence of their own.
 */
export function replyChip(t: (id: string, values?: Record<string, unknown>) => string, quote: QuoteChipView): ComposerReply {
  const title = quote.unnamed === 'event' ? t('chat:group.composer.replyingToPlatform')
    : quote.unnamed === 'message' ? t('chat:group.composer.replyingToMessage')
      : quote.unnamed === 'system' ? t('chat:group.composer.replyingToSystem')
        : quote.unnamed === 'someone' ? t('chat:group.composer.replyingToSomeone')
          : quote.pr != null ? (quote.pr ? t('chat:group.composer.replyingToPr', { number: quote.pr }) : t('chat:group.composer.replyingToPrUnnumbered'))
            : t('chat:group.composer.replyingTo', { name: quote.label });
  return { key: `${title}\n${quote.snippet}`, title, snippet: quote.snippet };
}

export interface ChatComposerProps {
  scope: ComposerScope;
  /** The project the chat is. */
  slug: string;
  /**
   * The thread a `thread` box posts to; for `general`, the topic's channel
   * the pane shows (null: the project's own stream).
   */
  thread?: ChatThreadRef | null;
  placeholder: string;
  /** Drawn over the card: the reply starters. */
  above?: ReactNode;
  /**
   * #6810: the transcript over the box, kept at its newest line when the
   * box shrinks (../../lib/use-auto-grow.ts).
   */
  scroller?: RefObject<HTMLElement | null>;
}

/** A project chat's box: Messages' box, with this chat as its place. */
export function ChatComposer({ scope, slug, thread = null, placeholder, above, scroller }: ChatComposerProps) {
  const t = useMessages('chat');
  const slot = useComposerSlot(scope);
  const draftScope = chatScopeKey(slug, thread);
  carryOldChatDraft(slug, thread, draftScope, scope === 'general');
  shown[scope] = draftScope;
  // The refs `#` offers are read when somebody first types `#`, not when a
  // chat is merely shown; their arrival draws the list.
  const [, refsArrived] = useState(0);
  const posts = scope === 'thread' ? thread : null;
  const place: ComposerPlace = {
    scope: draftScope,
    inThread: scope === 'thread',
    placeholder,
    label: scope === 'thread' ? t('chat:group.composer.page.reply') : placeholder,
    // A topic's channel is a channel: it formats as Messages' channels do.
    formatting: scope === 'general',
    ids: IDS[scope],
    above,
    // Sent over the chat's socket, or queued until it is back. The general
    // pane's box posts to the channel the pane shows (GroupChat._channel).
    send: (input) => { controller()?.send?.(input.content, posts, input.attachmentIds); },
    upload: (file) => uploadChatFile(slug, file),
    fileLimit: chatAttachmentLimit,
    typing: (on) => { if (on) controller()?.sendTyping?.(posts); },
    people: chatPeople(slug),
    refs: (before) => {
      const held = heldChatRefs(slug);
      if (!held && before.includes('#')) void loadChatRefs(slug).then(() => refsArrived((n) => n + 1));
      return chatRefMatch(before, held);
    },
    reply: slot.quote ? replyChip(t, slot.quote) : null,
    cancelReply: () => controller()?.clearQuote?.(),
  };
  return <MessageBox place={place} scroller={scroller} />;
}
