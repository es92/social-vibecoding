/**
 * The Activity feed's inline discussion: recent replies under a row, and a box
 * to add one without opening the row.
 *
 * ── What this replaces, and what it does not ───────────────────────────
 *
 * The feed already previewed comments, but only on ISSUE rows and only from
 * GitHub — `AppView._fillFeedComments` fetched the issue's GitHub thread and
 * wrote the last two into `.dev-feed-comments` by innerHTML. That preview is
 * untouched and still renders above this: it is the conversation happening on
 * the repository, and it is read-only here because it is read-only to us.
 *
 * This is the other conversation — the app's own thread for that item, the one
 * the topic page mounts under the card (`GroupChat.mountThread`). It is the
 * one a reply from the feed can actually land in, which is why the composer
 * belongs to it and not to the GitHub preview above. Both being visible is the
 * point: you see what has been said, and the box you type into is directly
 * under the messages it will join.
 *
 * ── Keyed by thread, loaded on sight ───────────────────────────────────
 *
 * State lives in ./feed-thread-store.ts, keyed `${slug}/${type}:${ref}`
 * rather than by row — see that file for why. Loading waits for the row to come into view,
 * the same rule (and roughly the same 200px margin) the GitHub preview's
 * IntersectionObserver uses: a 20-row feed would otherwise open 20 requests on
 * paint to fill three lines each.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
import { agoStamp } from '../../../lib/timestamp';
import { useStoreState } from '../../../lib/use-store-state';
import { chatPeople, chatRefMatch, heldChatRefs, loadChatRefs } from '../../group-chat/chat-sources';
import { chatScopeKey } from '../../group-chat/composer';
import { PostedViaChip, postedViaOf } from '../../group-chat/posted-via-chip';
import { MessageBox, putInComposer, type ComposerPlace } from '../../messages/composer';
import { swatchFor } from '../../messages/format';
import { ClampedComment } from '../comment-clamp';
import {
  feedThreadStore,
  patchThread,
  readThread,
  threadKey,
  type FeedThreadMessage,
} from './feed-thread-store';

/** Two, matching the GitHub preview's FEED_COMMENT_PREVIEW above it. */
const PREVIEW = 2;

/** Fetch a few more than are shown, so "N earlier" is right without a count query. */
const FETCH_LIMIT = 20;

/**
 * #6730: the mark that says "this is the comment I already tried to send".
 * A retry after a failed or hung send reuses it, so the server returns the
 * row the first attempt stored instead of writing a second one. Same shape
 * as the Messages composer's key (features/messages/store.ts).
 */
function newClientKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function demoQS(): string {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1' ? '&demo=1' : '';
  } catch {
    return '';
  }
}

// `relTime` lived here — the fifth copy of the ago ladder, and one that never
// degraded at all: a reply from March read "180d ago". It is `agoStamp` from
// lib/timestamp.ts now (#1808).

/**
 * Turn the chat endpoint's oldest-first rows into the compact human preview.
 *
 * The websocket command that creates a reply is named `chat`, but persisted
 * human rows use `msg_type: "message"`. Keep untyped legacy rows too; every
 * other kind is a system/event entry that the card itself already represents.
 */
export function feedThreadPreview(rows: any[]): {
  messages: FeedThreadMessage[];
  total: number;
} {
  const human = rows.filter((r: any) => !r.msg_type || r.msg_type === 'message');
  return {
    messages: human.slice(-PREVIEW).map((r: any) => ({
      id: r.id,
      author: r.username || translate('project:feedThread.unknownAuthor'),
      userId: r.user_id != null ? Number(r.user_id) : null,
      content: String(r.content || ''),
      createdAt: r.created_at,
      postedVia: postedViaOf(r.posted_via),
    })),
    total: human.length,
  };
}

/** Whether the signed-in viewer wrote this reply (App.user is app.js's). */
function isMine(m: FeedThreadMessage): boolean {
  const u = typeof window !== 'undefined' ? (window as any).App?.user : null;
  if (!u) return false;
  if (m.userId != null && u.id != null) return Number(u.id) === Number(m.userId);
  return !!u.username && u.username === m.author;
}

/**
 * One reply, as a BUBBLE — the Messages screen's row, at the feed's scale: a
 * 22px swatch avatar outside, a white r16 bubble with the name and the age
 * on its first line and the text under them, and the viewer's own replies in
 * the accent tint. They used to be three runs of 12px text lying directly on
 * the entry, which is where a reply and the card above it blurred together.
 */
export function MessageLine({ m }: { m: FeedThreadMessage }): ReactNode {
  const mine = isMine(m);
  const when = agoStamp(m.createdAt);
  return (
    <div
      className={mine ? 'dev-feed-msg dev-feed-msg-mine' : 'dev-feed-msg'}
      {...(m.postedVia ? { 'data-posted-via': m.postedVia } : {})}
    >
      <span className="dev-feed-msg-avatar" aria-hidden="true" style={{ backgroundColor: swatchFor(m.author) }}>
        {(m.author || '?').slice(0, 1).toUpperCase()}
      </span>
      <div className="dev-feed-msg-bubble">
        <div className="dev-feed-msg-head">
          <span className="dev-feed-msg-author">{m.author}</span>
          <PostedViaChip via={m.postedVia} />
          <time className="dev-feed-msg-time" dateTime={m.createdAt} title={when.title}>{when.text}</time>
        </div>
        {/* Plain text, never markdown and never innerHTML. This is the one
            surface in the feed that renders something a person typed, and it
            renders it as a text child so React escapes it — the topic page is
            where the full, formatted thread lives. `whitespace-pre-wrap` keeps
            the line breaks the multiline composer deliberately accepts.

            #2556: and four lines of them at a time. A reply pasted from
            somewhere else pushed the card below it off the screen, which is
            the opposite of what a preview is for. */}
        <ClampedComment
          className="dev-feed-msg-text whitespace-pre-wrap break-words"
          contentKey={m.content}
        >
          {m.content}
        </ClampedComment>
      </div>
    </div>
  );
}

/**
 * The box under a row's comments: Messages' box (one message box, 27 Nov
 * 2026; ../../messages/composer.tsx MessageBox), with this change's thread
 * as its place. `@` and `#` are a project chat's (../../group-chat/
 * chat-sources.ts), the draft is saved under the thread's own scope (the
 * one the thread's page writes too), and Enter sends by the rule every box
 * keeps (lib/enter-sends.ts). It takes no files and has no formatting: the
 * comments above it are plain text.
 *
 * The row is inside #dev-body's delegated click handler, which opens the
 * topic for a click anywhere on a card, so a click in the box stays here.
 */
export function FeedReplyComposer({
  slug, type, refId, onSend,
}: {
  slug: string;
  type: string;
  refId: number;
  onSend: (content: string) => void | Promise<void>;
}): ReactNode {
  const t = useMessages('project');
  // The refs `#` offers are read when somebody first types `#`; their
  // arrival draws the list.
  const [, refsArrived] = useState(0);
  const place: ComposerPlace = {
    scope: chatScopeKey(slug, { type, ref: refId }),
    bare: true,
    placeholder: t('project:feedThread.reply.placeholder'),
    label: t('project:feedThread.reply.name'),
    send: (input) => onSend(input.content),
    people: chatPeople(slug),
    refs: (before) => {
      const held = heldChatRefs(slug);
      if (!held && before.includes('#')) void loadChatRefs(slug).then(() => refsArrived((n) => n + 1));
      return chatRefMatch(before, held);
    },
  };
  return (
    <div className="dev-feed-reply" onClick={(e) => e.stopPropagation()}>
      <MessageBox place={place} />
    </div>
  );
}

export function FeedThread({
  slug, type, refId, canPost,
}: {
  slug: string;
  type: string;
  refId: number;
  canPost: boolean;
}): ReactNode {
  const key = threadKey(slug, type, refId);
  const all = useStoreState(feedThreadStore);
  const state = all[key] || readThread(key);
  const t = useMessages('project');
  const hostRef = useRef<HTMLDivElement>(null);
  // #6730: the key each comment was sent with, kept while its send failed,
  // so pressing Send again with the same words is the same comment; editing
  // them makes it a new one.
  const failedKeys = useRef(new Map<string, string>());

  const load = useCallback(async () => {
    if (readThread(key).loading) return;
    patchThread(key, { loading: true, error: null });
    try {
      const qs = `thread_type=${encodeURIComponent(type)}&thread_ref=${encodeURIComponent(String(refId))}`
        + `&limit=${FETCH_LIMIT}${demoQS()}`;
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows = Array.isArray(data.messages) ? data.messages : [];
      // `msg_type` carries system and agent entries into this stream too. The
      // preview is for what PEOPLE said — a build notice under a feed row is
      // noise, and the row's own card already says where the work has got to.
      const preview = feedThreadPreview(rows);
      patchThread(key, {
        messages: preview.messages,
        total: preview.total,
        loading: false,
        loaded: true,
      });
    } catch {
      // A thread that will not load is a quiet row, not an error banner: the
      // card above it is the thing the viewer came for.
      patchThread(key, { loading: false, loaded: true, error: 'load' });
    }
  }, [key, slug, type, refId]);

  // Load when the row is near the viewport, once. `rootMargin` matches the
  // GitHub preview's, so both halves of a row's comment area arrive together
  // rather than one scrolling in behind the other.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return undefined;
    if (readThread(key).loaded || readThread(key).loading) return undefined;
    if (typeof IntersectionObserver !== 'function') {
      void load();
      return undefined;
    }
    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.unobserve(entry.target);
        void load();
      }
    }, { rootMargin: '200px 0px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [key, load]);

  const submit = useCallback(async (words: string) => {
    const content = words.trim();
    if (!content) return;
    const clientKey = failedKeys.current.get(content) || newClientKey();
    failedKeys.current.delete(content);
    patchThread(key, { posting: true, error: null });
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, thread_type: type, thread_ref: refId, client_key: clientKey }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Stored (201) or matched to the row the first attempt stored (200):
      // either way this comment is done, and the next press is a new one.
      patchThread(key, { posting: false });
      // Re-read rather than append what we sent: the server assigns the id and
      // the timestamp, and this is also what picks up anything else posted to
      // the thread while the box was open.
      await load();
    } catch {
      // The box emptied as the comment left, as every box does: the words
      // come back to it (unless something new is being typed), with the
      // key, so Send again is the same comment.
      failedKeys.current.set(content, clientKey);
      patchThread(key, { posting: false, error: 'post' });
      putInComposer(chatScopeKey(slug, { type, ref: refId }), content, { onlyIfEmpty: true });
    }
  }, [key, slug, type, refId, load]);

  const hidden = state.total - state.messages.length;

  return (
    <div ref={hostRef} className="dev-feed-thread">
      {/* "N earlier replies" leads the thread — directly under the card,
          where the replies it stands for would be — then the bubbles, then
          the box. It used to sit under the bubbles, reading as a footer. */}
      {hidden > 0 ? (
        <div className="dev-feed-earlier text-xs text-zinc-400 dark:text-zinc-500">
          {t('project:feedThread.earlier', { count: hidden })}
        </div>
      ) : null}
      {state.messages.map((m) => <MessageLine key={m.id} m={m} />)}
      {state.error === 'post' ? (
        <div className="text-xs text-rose-600 dark:text-rose-400">
          {t('project:feedThread.postFailed')}
        </div>
      ) : null}
      {canPost ? <FeedReplyComposer slug={slug} type={type} refId={refId} onSend={submit} /> : null}
    </div>
  );
}
