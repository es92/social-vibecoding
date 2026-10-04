import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { ArrowUpIcon, ArrowUpTrayIcon, PaperClipIcon, PlusIcon } from '@/components/ui/icons';
import * as api from './api';
import { channels, draftFor, notifyTyping, replyFor, scopeKey, send, setDraft, setReply, takePendingShare, useMessagesSnapshot } from './store';
import { mirrorsReplies, requestPlace } from './bot-question';
import type { ConversationUser, MessageAttachment, SharedObjectReference } from './types';
import { fileSize, senderName } from './format';
import { plainText } from './plain-text';
import { useAutoGrow } from '../../lib/use-auto-grow';
import { prefixLookup, type PrefixLookup } from '../../lib/prefix-lookup';
import { orderFriendsFirst, useFriendIds } from '../friends/store';
import { wantsKeyboardFocus } from '../message-actions/focus';
import { completedShortcodeAt, findShortcodeToken, matchShortcodes, replaceShortcodeToken } from '../message-actions/emoji-shortcodes';

const MAX_ATTACHMENTS = 4;
// People asked for per `@` prefix in a channel (#3361).
const CHANNEL_MENTION_LIMIT = 8;

function attachmentLimit(file: File): number {
  const name = file.name.toLowerCase();
  if (file.type.startsWith('image/')) return 4 * 1024 * 1024;
  if (/\.(txt|md|markdown|json|ya?ml|toml|xml|csv|tsv|js|jsx|ts|tsx|css|html?|py|rb|rs|go|java|kt|swift|dart|sh|sql|diff|patch)$/i.test(name) || file.type.startsWith('text/')) return 200 * 1024;
  if (name.endsWith('.zip') || file.type === 'application/zip') return 20 * 1024 * 1024;
  return 10 * 1024 * 1024;
}

function objectLabel(object: SharedObjectReference): string {
  const app = object.appSlug ? `${object.appSlug} · ` : '';
  if (object.type === 'app') return `${app}App`;
  if (object.type === 'issue') return `${app}Issue #${object.issueNumber}`;
  if (object.type === 'governance') return `${app}Governance #${object.proposalId}`;
  if (object.type === 'spec') return `${app}Spec v${object.version} · session ${object.sessionId}`;
  return `${app}Proposal ${object.sessionId}`;
}

/**
 * The conversation's composer — or, with `threadRootId` (#2387), the composer
 * of the reply thread open beside it. The two keep their own drafts and
 * their own staged reply (the store's composer scope), and only the
 * conversation's own composer takes shared items: a card shared into
 * Messages lands in the conversation, never inside a thread.
 */
export function MessageComposer({ threadRootId = null }: { threadRootId?: number | null } = {}) {
  const snap = useMessagesSnapshot();
  const conversationId = snap.route.conversationId || 0;
  const active = snap.active;
  const scope = scopeKey(conversationId, threadRootId);
  const inThread = !!threadRootId;
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [object, setObject] = useState<SharedObjectReference | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  // #1955: the paperclip and the share tray were two adjacent icons that both
  // answered "put something in this message", and neither said which was
  // which — two guesses at a 40px target, on the narrowest row in the app.
  // One "+" opens both as named rows instead.
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // #1408: grow with the message, up to the max-height already in app.css.
  useAutoGrow(inputRef, value);
  const fileRef = useRef<HTMLInputElement>(null);
  const typingStop = useRef<number | null>(null);
  const reply = replyFor(scope);
  // #2386: friends lead the @ list (features/friends/store.ts).
  const friendIds = useFriendIds();

  useEffect(() => {
    setValue(draftFor(scope)); setAttachments([]); setObject(null); setError('');
  }, [scope]);

  // Reply puts the caret here where there is a hardware keyboard, so the
  // next keystroke is the reply (message-actions/focus.ts).
  const replyId = reply?.id ?? null;
  useEffect(() => {
    if (replyId && wantsKeyboardFocus()) inputRef.current?.focus({ preventScroll: true });
  }, [replyId]);

  useEffect(() => {
    if (inThread) return undefined;
    const onSelected = (event: Event) => {
      const detail = (event as CustomEvent<SharedObjectReference>).detail;
      if (detail) { setObject(detail); inputRef.current?.focus(); }
    };
    const onShare = (event: Event) => {
      // A bare Messages screen is asking the user to choose a destination;
      // leave the one-shot in the store until a conversation route exists.
      if (!conversationId) return;
      const eventDetail = (event as CustomEvent<SharedObjectReference | null>).detail;
      // share() publishes synchronously when this composer is already mounted.
      // Consume its store fallback here so a later remount cannot reopen it.
      const pending = takePendingShare();
      const detail = pending === undefined ? eventDetail : pending;
      window.UsernodeReact?.dialogs?.messagesShare?.open(detail || undefined);
    };
    window.addEventListener('usernode:messages-object-selected', onSelected);
    window.addEventListener('usernode:messages-share', onShare);
    // An app/card share can navigate into Messages before this conversation
    // composer mounts. Consume that one-shot payload after listeners exist.
    if (conversationId) {
      const pending = takePendingShare();
      if (pending !== undefined) window.UsernodeReact?.dialogs?.messagesShare?.open(pending || undefined);
    }
    return () => {
      window.removeEventListener('usernode:messages-object-selected', onSelected);
      window.removeEventListener('usernode:messages-share', onShare);
    };
  }, [conversationId, inThread]);

  useEffect(() => () => {
    if (typingStop.current) window.clearTimeout(typingStop.current);
    notifyTyping(false);
  }, [conversationId]);

  // The `@word` being typed at the caret, or undefined when there is none.
  const mentionPrefix = useMemo(() => {
    const cursor = inputRef.current?.selectionStart ?? value.length;
    return value.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/)?.[1];
  }, [value]);

  // #3361: a channel's roster is counted, not loaded (the server's
  // serializeConversation), so `active.members` is empty there and `@`
  // offered nobody. A channel asks the server for the people matching what
  // has been typed instead, a beat after the last keystroke. One lookup per
  // conversation (lib/prefix-lookup.ts) remembers each answer, shares a
  // request in flight and drops an answer for a prefix no longer being
  // typed, so a slow `@a` cannot replace the list for `@alex`. Groups and
  // DMs keep reading their loaded roster below, exactly as before.
  const isChannel = active?.kind === 'channel';
  const channelLookup = useMemo<PrefixLookup<ConversationUser> | null>(() => (isChannel && conversationId
    ? prefixLookup((query) => api.getMentionCandidates(conversationId, query, CHANNEL_MENTION_LIMIT))
    : null), [isChannel, conversationId]);
  const [channelPeople, setChannelPeople] = useState<{ lookup: PrefixLookup<ConversationUser> | null; key: string; users: ConversationUser[] }>({ lookup: null, key: '', users: [] });
  useEffect(() => {
    if (!channelLookup || mentionPrefix === undefined) return undefined;
    const key = mentionPrefix.toLowerCase();
    let live = true;
    const ask = () => {
      void channelLookup.ask(mentionPrefix).then((users) => {
        if (live && users) setChannelPeople({ lookup: channelLookup, key, users });
      });
    };
    if (channelLookup.cached(mentionPrefix)) { ask(); return () => { live = false; }; }
    const timer = window.setTimeout(ask, 120);
    return () => { live = false; window.clearTimeout(timer); };
  }, [channelLookup, mentionPrefix]);

  const mention = useMemo(() => {
    if (mentionPrefix === undefined) return null;
    const prefix = mentionPrefix.toLowerCase();
    if (isChannel) {
      // The answer for this prefix, or — while it loads — for a shorter one
      // whose answer was complete (under the limit), which narrows exactly.
      const held = channelPeople.lookup === channelLookup
        && (channelPeople.key === prefix
          || (prefix.startsWith(channelPeople.key) && channelPeople.users.length < CHANNEL_MENTION_LIMIT));
      const people = held ? channelPeople.users : [];
      return orderFriendsFirst(people.filter((member) => member.username.toLowerCase().startsWith(prefix)), friendIds).slice(0, 6);
    }
    return orderFriendsFirst((active?.members || []).filter((member) => member.status === 'member'
      && member.username.toLowerCase().startsWith(prefix)), friendIds).slice(0, 6);
  }, [active?.members, isChannel, channelPeople, channelLookup, mentionPrefix, friendIds]);

  // #2783: `#` offers the viewer's channels — #general and their apps' —
  // and inserts `#handle`, which every chat renders as a link to it. Only a
  // word after the `#`: `#123` is an issue reference, and a DM has no app to
  // look issues up in.
  const channelMatches = useMemo(() => {
    const cursor = inputRef.current?.selectionStart ?? value.length;
    const prefix = value.slice(0, cursor).match(/(?:^|\s)#([A-Za-z][A-Za-z0-9-]*|)$/)?.[1];
    if (prefix === undefined) return null;
    const q = prefix.toLowerCase();
    return channels().filter((item) => item.handle.startsWith(q)).slice(0, 6);
  }, [value, snap.conversations, snap.discussions]);

  // ── Choosing a suggestion from the keyboard (QA 2026-09-24 Q13) ──────
  //
  // The @ and # lists were mouse-only: the arrows moved the caret, and Enter
  // SENT the half-typed "@qaf" instead of picking the person it was
  // suggesting. Now the open list is a listbox the textarea drives through
  // `aria-activedescendant`: the first row is highlighted, ArrowUp/ArrowDown
  // move the highlight, Enter or Tab picks it, and Escape closes the list
  // for the text as it stands (typing brings it back). Enter sends only
  // while no list is showing.
  const listId = useId();
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const listOpen = dismissedAt !== value;
  const mentionShown = listOpen && !!mention?.length;
  const channelShown = listOpen && !mentionShown && !!channelMatches?.length;
  const suggestions: Array<{ key: string; pick: () => void }> = mentionShown
    ? (mention || []).map((member) => ({ key: `@${member.id}`, pick: () => insertMention(member.username) }))
    : channelShown
      ? (channelMatches || []).map((item) => ({ key: `#${item.handle}`, pick: () => insertChannel(item.handle) }))
      : [];
  const suggestionKey = suggestions.map((item) => item.key).join(' ');
  // A new list (or a narrower one) starts from its first row again.
  useEffect(() => { setHighlight(0); }, [suggestionKey]);
  const activeOption = suggestions.length ? Math.min(highlight, suggestions.length - 1) : -1;
  const optionId = (index: number) => `${listId}-opt-${index}`;
  useEffect(() => {
    if (activeOption < 0) return;
    document.getElementById(optionId(activeOption))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeOption, suggestionKey]);

  /** The suggestion list's share of the textarea's keys; true when it took the key. */
  function suggestionKeys(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!suggestions.length || event.nativeEvent.isComposing) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((activeOption + step + suggestions.length) % suggestions.length);
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      suggestions[Math.max(0, activeOption)].pick();
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissedAt(value);
      return true;
    }
    return false;
  }

  // `:th` offers emoji by shortcode, Discord's way, and a complete `:tada:`
  // becomes 🎉 as its closing colon is typed. The token rules and the ranking
  // are features/message-actions/emoji-shortcodes.ts, which the app chat's
  // composer shares. ↑/↓ move the highlight, Enter or Tab inserts it, Escape
  // closes the menu until the token changes.
  const [emojiPick, setEmojiPick] = useState({ key: '', index: 0 });
  const [emojiDismissed, setEmojiDismissed] = useState('');
  const emojiListRef = useRef<HTMLDivElement>(null);
  // Where the caret goes once a swap has rendered. A layout effect, not a
  // frame later: a key typed inside that frame would land before the caret
  // moved and end up on the wrong side of the emoji.
  const emojiCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = emojiCaret.current;
    if (at === null) return;
    emojiCaret.current = null;
    inputRef.current?.setSelectionRange(at, at);
  }, [value]);
  const emoji = useMemo(() => {
    const input = inputRef.current;
    const cursor = input?.selectionStart ?? value.length;
    const token = findShortcodeToken(value, cursor, input?.selectionEnd ?? cursor);
    const items = token ? matchShortcodes(token.query, 8) : [];
    return token && items.length ? { ...token, key: `${token.start}:${token.query}`, items } : null;
  }, [value]);
  const emojiOpen = !!emoji && emoji.key !== emojiDismissed && !mention?.length && !channelMatches?.length;
  const emojiActive = emoji && emojiPick.key === emoji.key ? emojiPick.index : 0;
  useEffect(() => {
    emojiListRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [emojiOpen, emojiActive]);

  function insertEmoji(glyph: string) {
    const input = inputRef.current;
    const cursor = input?.selectionStart ?? value.length;
    const token = findShortcodeToken(value, cursor, input?.selectionEnd ?? cursor);
    if (!token) return;
    const next = replaceShortcodeToken(value, token.start, cursor, glyph);
    emojiCaret.current = next.caret;
    input?.focus();
    updateValue(next.value);
  }

  /** The menu's keys, ahead of Enter-to-send. True when the key was the menu's. */
  function onEmojiKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!emojiOpen || !emoji || event.nativeEvent.isComposing) return false;
    // The caret can have moved off the token since the last keystroke (the
    // menu follows the text, not the caret); then the key is not the menu's.
    const input = event.currentTarget;
    const live = findShortcodeToken(input.value, input.selectionStart, input.selectionEnd);
    if (!live || `${live.start}:${live.query}` !== emoji.key) return false;
    const count = emoji.items.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setEmojiPick({ key: emoji.key, index: (emojiActive + step + count) % count });
    } else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
      insertEmoji(emoji.items[emojiActive].emoji);
    } else if (event.key === 'Escape') {
      setEmojiDismissed(emoji.key);
    } else {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  function onComposerChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const input = event.target;
    const done = (event.nativeEvent as InputEvent).data === ':' ? completedShortcodeAt(input.value, input.selectionStart) : null;
    if (!done) { updateValue(input.value); return; }
    const next = replaceShortcodeToken(input.value, done.start, done.end, done.emoji, '');
    emojiCaret.current = next.caret;
    updateValue(next.value);
  }

  function insertChannel(handle: string) {
    const input = inputRef.current;
    const cursor = input?.selectionStart ?? value.length;
    const before = value.slice(0, cursor).replace(/#([A-Za-z][A-Za-z0-9-]*|)$/, `#${handle} `);
    const next = before + value.slice(cursor);
    updateValue(next);
    // A pick closes the list for the text it produced. The lists read the
    // caret during render, before the caret moves past the inserted name, so
    // without this the list reopened on the OLD caret and a second Enter
    // picked again.
    setDismissedAt(next.slice(0, 8000));
    placeCaretAfterPick(input, before.length);
  }

  // The caret moves in the layout effect the new value renders, as an emoji
  // swap's does (`emojiCaret`), not a frame later: a key typed straight after
  // Enter picked a name would land before the caret moved and end up on the
  // wrong side of it (QA 2026-09-24 Q13, where the keyboard made that fast).
  function placeCaretAfterPick(input: HTMLTextAreaElement | null, at: number) {
    emojiCaret.current = at;
    input?.focus();
  }

  function updateValue(next: string) {
    const trimmed = next.slice(0, 8000);
    setValue(trimmed); setDraft(scope, trimmed);
    notifyTyping(true);
    if (typingStop.current) window.clearTimeout(typingStop.current);
    typingStop.current = window.setTimeout(() => notifyTyping(false), 2200);
  }

  function insertMention(username: string) {
    const input = inputRef.current;
    const cursor = input?.selectionStart ?? value.length;
    const before = value.slice(0, cursor).replace(/@([^\s@]*)$/, `@${username} `);
    const next = before + value.slice(cursor);
    updateValue(next);
    setDismissedAt(next.slice(0, 8000));
    placeCaretAfterPick(input, before.length);
  }

  async function addFiles(files: File[]) {
    const room = Math.max(0, MAX_ATTACHMENTS - attachments.length - uploading);
    const selected = files.slice(0, room);
    if (!selected.length) { setError(`You can attach up to ${MAX_ATTACHMENTS} files.`); return; }
    for (const file of selected) {
      if (file.size > attachmentLimit(file)) {
        setError(`${file.name} is too large for this file type.`);
        continue;
      }
      setUploading((count) => count + 1); setError('');
      try {
        const attachment = await api.uploadAttachment(conversationId, file);
        setAttachments((items) => [...items, attachment]);
      }
      catch (err) { setError(err instanceof Error ? err.message : `Couldn’t upload ${file.name}.`); }
      finally { setUploading((count) => Math.max(0, count - 1)); }
    }
  }

  // The menu closes the way every other transient panel in the shell does: a
  // press outside it, or Escape. Bound only while it is open, so a closed
  // composer costs nothing.
  useEffect(() => {
    if (!addOpen) return undefined;
    const onDown = (event: MouseEvent) => {
      if (!addRef.current?.contains(event.target as Node)) setAddOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setAddOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [addOpen]);

  // NO SENDING STATE (#2907). The message is drawn in the transcript the
  // moment it is sent — faded until the server has it, with a Retry if it
  // never does — so the box empties at once and is ready for the next one.
  // The button does not wait on the round trip or change its glyph.
  function submit() {
    if (uploading || (!value.trim() && !attachments.length && !object)) return;
    setError(''); notifyTyping(false);
    const input = { content: value.trim(), attachmentIds: attachments.map((item) => item.id), attachments, object: object || undefined };
    setValue(''); setAttachments([]); setObject(null);
    requestAnimationFrame(() => inputRef.current?.focus());
    send({ ...input, threadRootId }).catch((err) => setError(err instanceof Error ? err.message : 'Your message wasn’t sent.'));
  }

  if (!active || active.membershipStatus !== 'member') return null;

  // QA 2026-09-24 Q2: a direct request the other person has not accepted
  // yet. It carries ONE opening message; once that is sent (or in flight —
  // the optimistic row counts, so a quick second Enter cannot slip in) the
  // composer gives way to a plain statement of what the thread is waiting
  // for. Every later send used to come back "Not sent · Retry", and the
  // Retry could never work.
  const awaiting = !inThread && !!active.awaitingAcceptance;
  const waitingOn = awaiting
    ? active.peer?.username || active.members.find((member) => member.status === 'invited')?.username || ''
    : '';
  const who = waitingOn ? `@${waitingOn}` : 'them';
  if (awaiting && (!active.canSend || snap.messages.length > 0)) {
    return (
      <div className="messages-composer messages-composer-awaiting platform-safe-bar" data-awaiting-acceptance="">
        <div className="messages-awaiting" role="status">
          <strong>Message request sent</strong>
          <p>Waiting for {who} to accept your message request. You can send more once they do.</p>
        </div>
      </div>
    );
  }
  if (!active.canSend) return <div className="messages-composer-disabled platform-safe-bar">You can’t send messages in this conversation.</div>;
  // Where the count turns amber, and the only length a phone shows it at.
  const nearLimit = value.length > 7600;

  return (
    <div className={`messages-composer platform-safe-bar ${inThread ? 'messages-composer-thread' : ''} ${dragging ? 'messages-composer-dragging' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles([...event.dataTransfer.files]); }}>
      {/* QA 2026-09-24 Q2: before the opening message of a request, what it
          will be — so the composer turning into a notice after it is no
          surprise. */}
      {awaiting ? <p className="messages-composer-hint" data-awaiting-acceptance="">{waitingOn ? `@${waitingOn} gets` : 'They get'} your first message as a message request. You can send more once they accept.</p> : null}
      {/* The white card. The bar around it is what carries the home-indicator
          inset (`platform-safe-bar`), so the card keeps its own padding on a
          notched phone instead of growing a tall blank foot. */}
      <div className="messages-composer-card">
      {reply ? <div className="messages-reply-draft"><div className="min-w-0"><span className="font-semibold">Replying to {senderName(reply.sender)}</span><p className="truncate">{plainText(reply.content) || 'Attachment'}</p>{reply.sender.bot && mirrorsReplies(reply.metadata?.homeroomBot) ? <p className="messages-bot-note">{`Your reply is posted on ${requestPlace(reply.metadata.homeroomBot)}’s public discussion.`}</p> : null}</div><button type="button" onClick={() => setReply(scope, null)} aria-label="Cancel reply">×</button></div> : null}
      {object ? <div className="messages-pending-object"><span aria-hidden="true">◆</span><span className="truncate">{objectLabel(object)}</span><button type="button" onClick={() => setObject(null)} aria-label="Remove shared item">×</button></div> : null}
      {attachments.length || uploading ? <div className="dc-attach-strip dc-attach-strip-active">{attachments.map((item) => <div key={item.id} className="dc-attach-item"><div className="min-w-0"><div className="dc-attach-name">{item.name}</div><div className="dc-attach-size">{fileSize(item.size)}</div></div><button type="button" className="dc-attach-remove" onClick={() => setAttachments((items) => items.filter((candidate) => candidate.id !== item.id))} aria-label={`Remove ${item.name}`}>×</button></div>)}{uploading ? <span className="dc-attach-uploading">Uploading {uploading}…</span> : null}</div> : null}
      {channelShown && channelMatches ? <div className="messages-mention-menu" id={listId} role="listbox" aria-label="Channels">{channelMatches.map((item, index) => <button key={item.handle} id={optionId(index)} type="button" role="option" tabIndex={-1} aria-selected={index === activeOption} data-channel-option={item.handle} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setHighlight(index)} onClick={() => insertChannel(item.handle)}>#{item.handle}{item.kind === 'app' && item.name.toLowerCase() !== item.handle ? <span className="messages-channel-option-name"> {item.name}</span> : null}</button>)}</div> : null}
      {mentionShown && mention ? <div className="messages-mention-menu" id={listId} role="listbox" aria-label="People">{mention.map((member, index) => <button key={member.id} id={optionId(index)} type="button" role="option" tabIndex={-1} aria-selected={index === activeOption} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setHighlight(index)} onClick={() => insertMention(member.username)}>@{member.username}</button>)}</div> : null}
      {emojiOpen && emoji ? (
        <div className="messages-mention-menu messages-emoji-menu">
          <div className="messages-emoji-menu-heading">Emoji matching <span className="messages-emoji-menu-query">:{emoji.query}</span></div>
          <div ref={emojiListRef} className="messages-emoji-menu-list" role="listbox" aria-label="Emoji">
            {emoji.items.map((item, i) => (
              <button key={item.emoji} type="button" role="option" aria-selected={i === emojiActive} data-emoji-option={item.shortcode} onMouseDown={(event) => event.preventDefault()} onClick={() => insertEmoji(item.emoji)}>
                <span className="messages-emoji-option-glyph" aria-hidden="true">{item.emoji}</span>
                <span className="messages-emoji-option-code">:{item.shortcode}:</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex items-end gap-1.5">
        <input ref={fileRef} type="file" multiple className="hidden" onChange={(event) => { void addFiles([...(event.target.files || [])]); event.target.value = ''; }} />
        <div className="messages-composer-add" ref={addRef}>
          <button type="button" className="messages-composer-action" onClick={() => setAddOpen((open) => !open)} aria-haspopup="menu" aria-expanded={addOpen} aria-label="Add to message" title="Add to message"><PlusIcon aria-hidden="true" /></button>
          {addOpen ? (
            <div className="messages-composer-menu" role="menu" aria-label="Add to message">
              {/* The attachment cap disables the ROW, not the whole control:
                  sharing an item is still available with four files queued,
                  which a disabled "+" would have taken away with it. */}
              <button type="button" role="menuitem" disabled={attachments.length + uploading >= MAX_ATTACHMENTS} onClick={() => { setAddOpen(false); fileRef.current?.click(); }}>
                <PaperClipIcon aria-hidden="true" />
                <span>Attach files</span>
              </button>
              {inThread ? null : (
                <button type="button" role="menuitem" onClick={() => { setAddOpen(false); window.UsernodeReact?.dialogs?.messagesShare?.open(); }}>
                  <ArrowUpTrayIcon aria-hidden="true" />
                  <span>Share item</span>
                </button>
              )}
            </div>
          ) : null}
        </div>
        <textarea ref={inputRef} value={value} onChange={onComposerChange} onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void addFiles(files); } }} onKeyDown={(event) => { if (onEmojiKeyDown(event)) return; if (suggestionKeys(event)) return; if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } else if (event.key === 'Escape' && reply) setReply(scope, null); }} onBlur={() => notifyTyping(false)} rows={1} maxLength={8000} placeholder={inThread ? 'Reply in thread…' : 'Message…'} aria-label={inThread ? 'Reply in thread' : 'Message'} aria-autocomplete="list" aria-controls={suggestions.length ? listId : undefined} aria-activedescendant={activeOption >= 0 ? optionId(activeOption) : undefined} className="messages-composer-input" />
        <button type="button" onClick={submit} disabled={!!uploading || (!value.trim() && !attachments.length && !object)} className="messages-send" aria-label="Send message"><ArrowUpIcon aria-hidden="true" /></button>
      </div>
      {error ? <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
      {/* The count's line is always laid out, empty or not: it appearing
          with the first keystroke pushed the whole composer up by a line.
          On a phone (#3735) it is not laid out at all until the text nears
          the limit (`data-near-limit`, app.css), so the card stays one row. */}
      <div className="messages-composer-count mt-1 px-1 flex justify-end h-[15px]" data-near-limit={nearLimit ? '' : undefined} aria-hidden={!value.length}><span className={`text-[10px] leading-[15px] ${nearLimit ? 'text-amber-800 dark:text-amber-300' : 'text-zinc-500 dark:text-zinc-400'}`}>{value.length ? `${value.length}/8000` : ''}</span></div>
      </div>
      {dragging ? <div className="messages-drop-overlay">Drop files to attach</div> : null}
    </div>
  );
}
