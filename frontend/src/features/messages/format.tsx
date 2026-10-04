import { useMemo, type MouseEvent } from 'react';

import { messageStamp } from '../../lib/timestamp';
import { decorateRefs } from './channels';
import type { ConversationUser, SharedObjectCard } from './types';

const NO_CHANNELS: ReadonlySet<string> = new Set();

export function initials(label: string): string {
  return label
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';
}

// `relativeTime` lived here — the conversation list's own copy of the ago
// ladder, one of five that had each drifted to a different cutoff. It is
// `agoStamp` from lib/timestamp.ts now (#1808); import that directly.

export function fullTime(value: string): string {
  return messageStamp(value).title;
}

function fallbackMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/**
 * A message body: the shared markdown renderer, then its references chipped
 * (#2783) — `@name`, `#123` and `PR#123` as the app chat draws them, and a
 * `#name` that names one of the viewer's channels as a link to it. Built on
 * the sanitized HTML with DOM APIs (./channels.ts `decorateRefs`), never by a
 * regex over markup.
 *
 * `appSlug`: the project the message is about, when it names one (#3770, a
 * Homeroom bot message's request). Its `#N` chips then open that project's
 * requests, and record this conversation as where they were opened from, as
 * a shared card does (`recordObjectOrigin`).
 */
export function MessageMarkdown({ content, channels, appSlug }: { content: string; channels?: ReadonlySet<string>; appSlug?: string | null }) {
  const html = useMemo(() => {
    const rendered = typeof window !== 'undefined' && window.DevChat?.renderMarkdown
      ? window.DevChat.renderMarkdown(content, { breaks: true })
      : fallbackMarkdown(content);
    if (typeof document === 'undefined') return rendered;
    const root = document.createElement('div');
    root.innerHTML = rendered;
    const me = String(window.App?.user?.username || '').toLowerCase();
    decorateRefs(root, channels || NO_CHANNELS, me, appSlug);
    return root.innerHTML;
  }, [content, channels, appSlug]);
  // The SAME object while the html is unchanged. React 19 compares this prop
  // by identity and reassigns innerHTML when it differs, so an inline
  // `{ __html }` tore down and rebuilt every message body on every render of
  // its row, even with identical text (board-frame.tsx documents the same).
  const inner = useMemo(() => ({ __html: html }), [html]);
  const openRef = (event: MouseEvent<HTMLDivElement>) => {
    const href = (event.target as Element | null)?.closest?.('a.gc-ref[href]')?.getAttribute('href');
    if (href) recordObjectOrigin(event, href);
  };
  return <div className="messages-markdown gc-msg-content" onClick={appSlug ? openRef : undefined} dangerouslySetInnerHTML={inner} />;
}

/**
 * A stable colour per name, so the same person or group is the same swatch
 * in every row without the server storing one. The same six swatches as the
 * app chat's `swatchFor` (../group-chat/transcript.tsx), kept in step by
 * hand, so a person reads as one voice across the two surfaces.
 *
 * FNV-1a with a final mix, not the app chat's `h * 31`. That one has two
 * faults this surface would show on every screen: past about eleven
 * characters the float product exceeds 2^53 and its low bits — the only
 * ones ToUint32 keeps — are all zero, and 31 ≡ 1 (mod 6), so before that
 * the pick is just the sum of the character codes mod 6. Both put "ada",
 * "Launch crew" and "Design review" in the same green.
 */
const SWATCHES = ['#5b7553', '#c0532f', '#6fb3a8', '#4a6fa5', '#8a5a83', '#b08344'];
export function swatchFor(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16;
  return SWATCHES[(h >>> 0) % SWATCHES.length];
}

/**
 * Two shapes, the language's own split (see @/components/ui/feed.tsx):
 * `square` for a person speaking in a conversation — the list, the thread's
 * title row and the named rows of a group — and `circle` for a person in a
 * roster, which is what the dialogs show. A square wears the person's swatch
 * with white initials; a circle keeps the accent tint the dialogs had.
 */
export function UserAvatar({ user, title, size = 'md', shape = 'circle' }: {
  user?: ConversationUser | null;
  title?: string;
  size?: 'sm' | 'md' | 'lg';
  shape?: 'circle' | 'square';
}) {
  const label = title || user?.username || 'Conversation';
  const sizeClass = size === 'sm' ? 'w-7 h-7 text-[10px]' : size === 'lg' ? 'w-11 h-11 text-sm' : 'w-9 h-9 text-xs';
  const square = shape === 'square';
  const radius = square ? (size === 'sm' ? 'rounded-lg' : 'rounded-xl') : 'rounded-full';
  if (user?.avatarUrl) {
    return <img src={user.avatarUrl} alt="" className={`${sizeClass} ${radius} object-cover bg-zinc-100 dark:bg-zinc-800 shrink-0`} />;
  }
  if (square) {
    return (
      <span aria-hidden="true" className={`${sizeClass} ${radius} text-white font-bold flex items-center justify-center shrink-0`} style={{ backgroundColor: swatchFor(label) }}>
        {initials(label)}
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={`${sizeClass} rounded-full bg-violet-100 dark:bg-violet-950 text-violet-700 dark:text-violet-300 font-semibold flex items-center justify-center shrink-0`}>
      {initials(label)}
    </span>
  );
}

const OBJECT_LABELS: Record<SharedObjectCard['type'], string> = {
  // B4: a code proposal is a change, as the bot and the rest of the shell say.
  app: 'App', issue: 'Issue', proposal: 'Change', governance: 'Governance proposal', spec: 'Spec version',
  // #3660: the two pages a pasted Homeroom link can name that are not items.
  hub: 'Community hub', discussion: 'Discussion',
};

// The glyph tile a card leads with: the app's diamond for an app and its
// community, the `#` a channel is named with for a discussion, the section
// sign for a spec, and the number sign for everything that has one.
function objectGlyph(type: SharedObjectCard['type']): string {
  if (type === 'app' || type === 'hub') return '◆';
  if (type === 'spec') return '§';
  return '#';
}

// #3103: a shared card that opens a Workshop topic or a dev session records
// the conversation it was tapped in, so that page's back returns here rather
// than to the app's Workshop. The Improve store's own "where from" is the last
// APP route, and a Messages conversation is not one. Plain clicks only: a
// modified click opens a new tab, which navigates nothing here. Not in the side
// panel's document, whose links are the top window's to follow.
//
// #3660: `inboxOnly` is for a card under a message in an app's discussion,
// which is drawn on the app's own pages as well as in this inbox. There the
// page's own back already leads to the discussion, so the card records an
// origin only while the discussion is open here.
//
// #3770: a request's `#N` chip in a message about its project records one
// too (MessageMarkdown), from a press on the message body.
export function recordObjectOrigin(event: MouseEvent<Element>, href: string, inboxOnly = false): void {
  const w = window as unknown as {
    NavLink?: { isNativeClick?: (e: unknown) => boolean };
    App?: { embeddedPanel?: boolean };
    Improve?: { enterTopicFrom?: (href: string) => void; enterSessionFrom?: (href: string) => void };
  };
  if (!href.startsWith('#app/') || w.App?.embeddedPanel) return;
  if (w.NavLink?.isNativeClick?.(event)) return;
  const here = window.location.hash;
  if (inboxOnly && !here.startsWith('#messages')) return;
  const origin = here.startsWith('#messages') ? here : '#messages';
  if (/\/dev\/sessions\//.test(href)) w.Improve?.enterSessionFrom?.(origin);
  else if (/\/dev\/(?:issues|proposals|governance)\//.test(href)) w.Improve?.enterTopicFrom?.(origin);
}

export function ObjectCard({ object, compact = false, inboxOnly = false }: {
  object: SharedObjectCard;
  compact?: boolean;
  /** Drawn in an app's discussion: see `recordObjectOrigin`. */
  inboxOnly?: boolean;
}) {
  if (!object.available) {
    return (
      <div className="messages-object-card messages-object-unavailable" aria-disabled="true">
        <span className="messages-object-icon">?</span>
        <div className="min-w-0"><div className="text-base font-semibold">Unavailable</div><div className="text-sm text-zinc-500 dark:text-zinc-400">You can’t access this item.</div></div>
      </div>
    );
  }
  const body = (
    <>
      <span className="messages-object-icon">{objectGlyph(object.type)}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-semibold">{OBJECT_LABELS[object.type]}</div>
        <div className="text-base font-semibold text-zinc-900 dark:text-zinc-100 truncate">{object.title || 'Untitled'}</div>
        {!compact && (object.subtitle || object.state || object.author) ? (
          <div className="text-sm text-zinc-500 dark:text-zinc-400 truncate">
            {[object.subtitle, object.state, object.author ? `by ${object.author}` : null].filter(Boolean).join(' · ')}
          </div>
        ) : null}
      </div>
      {object.href ? <span aria-hidden="true" className="text-zinc-500 dark:text-zinc-400">›</span> : null}
    </>
  );
  return object.href ? (
    <a href={object.href} className="messages-object-card" target={object.href.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" onClick={(event) => recordObjectOrigin(event, object.href as string, inboxOnly)}>{body}</a>
  ) : <div className="messages-object-card">{body}</div>;
}

export function fileSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
