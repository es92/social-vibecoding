import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';

import { Button } from '@/components/ui/button';
import { ChatComposerBar } from '@/components/ui/chat';
import { ArrowUpIcon, ArrowUpTrayIcon, BoldIcon, CheckIcon, CopyIcon, FormatTextIcon, HeadingIcon, ItalicIcon, LinkIcon, ListBulletIcon, PaperClipIcon, PlusIcon, QuoteIcon, SaveDraftIcon, StrikethroughIcon, UnderlineIcon } from '@/components/ui/icons';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import * as api from './api';
import { applyFormat, hasFormatting, normalizeLinkUrl, type FormatKind } from './composer-format';
import { waitingFor } from './waiting-for';
import { channels, draftAttachmentsFor, draftFor, notifyTyping, replyFor, scopeKey, send, setDraft, setDraftAttachments, setReply, takePendingShare, typingUsers, useMessagesSnapshot, type ComposerScope } from './store';
import { mirrorsReplies } from './bot-question';
import { deleteBotDraft, saveBotDraft, takeBotDraft, useBotDrafts, type SavedDraft } from './bot-drafts';
import { BotSavedDrafts } from './bot-drafts-list';
import { answeringIn, sendMode, stopMode, STOPPING_MAX_MS } from './bot-stop';
import { botRequestNames, threadsAllowed } from './bot-shared';
import type { ConversationUser, MessageAttachment, SharedObjectCard, SharedObjectReference, StagedObject } from './types';
import { MessageMarkdown, pendingObjectLabel, senderName } from './format';
import { plainText } from './plain-text';
import { useAutoGrow } from '../../lib/use-auto-grow';
import { useComposerStack } from '../../lib/use-composer-stack';
import { enterSends, useEnterSends } from '../../lib/enter-sends';
import { MAX_ATTACHMENTS, stageFiles } from '../attachments/limits';
import { PendingStripRows } from '../attachments/pending-strip';
import { attachmentView, pendingUploadView, type PendingUpload } from './attachment-views';
import { registerComposerDrop } from './pane-drop';
import { prefixLookup, type PrefixLookup } from '../../lib/prefix-lookup';
import { orderFriendsFirst, useFriendIds } from '../friends/store';
import { wantsKeyboardFocus } from '../message-actions/focus';
import { completedShortcodeAt, findShortcodeToken, matchShortcodes, replaceShortcodeToken } from '../message-actions/emoji-shortcodes';

import { SpeakButton } from '../dictation/speak-button';
import { NotifyAsk } from '../notify-ask/notify-ask';

// People asked for per `@` prefix in a channel (#3361).
const CHANNEL_MENTION_LIMIT = 8;

// #6035: the formatting row a channel's composer wears. Each button is named
// by its catalog entry, shown as its tooltip and announced by screen readers.
const FORMAT_BUTTONS: Array<{ kind: FormatKind; label: string; Icon: typeof BoldIcon }> = [
  { kind: 'bold', label: 'messages:composer.format.bold', Icon: BoldIcon },
  { kind: 'italic', label: 'messages:composer.format.italic', Icon: ItalicIcon },
  { kind: 'underline', label: 'messages:composer.format.underline', Icon: UnderlineIcon },
  { kind: 'strike', label: 'messages:composer.format.strike', Icon: StrikethroughIcon },
  { kind: 'heading', label: 'messages:composer.format.heading', Icon: HeadingIcon },
  { kind: 'quote', label: 'messages:composer.format.quote', Icon: QuoteIcon },
  { kind: 'bullet', label: 'messages:composer.format.bullets', Icon: ListBulletIcon },
  { kind: 'link', label: 'messages:composer.format.link', Icon: LinkIcon },
];

// #6653: the same inline marks on selected words, offered where the pointer
// is, plus Copy. Every row is one action; the menu has no primary.
const SELECT_MENU_ACTIONS: Array<{ kind: FormatKind; label: string; Icon: typeof BoldIcon }> = [
  { kind: 'bold', label: 'messages:composer.format.bold', Icon: BoldIcon },
  { kind: 'italic', label: 'messages:composer.format.italic', Icon: ItalicIcon },
  { kind: 'underline', label: 'messages:composer.format.underline', Icon: UnderlineIcon },
  { kind: 'strike', label: 'messages:composer.format.strike', Icon: StrikethroughIcon },
  { kind: 'quote', label: 'messages:composer.format.quote', Icon: QuoteIcon },
];

/** The reference alone, as the server takes it: the staged title stays here. */
function referenceOf(object: StagedObject): SharedObjectReference {
  const { type, appId, appSlug, issueNumber, sessionId, proposalId, version } = object;
  return { type, appId, appSlug, issueNumber, sessionId, proposalId, version };
}

/**
 * The server's reading of a staged item for this viewer, the same one a
 * sent card gets (api.resolveLinkCards), so its chip names its title and
 * project. Null until it comes, and for what a link cannot name (a spec).
 */
export function useStagedCard(object: StagedObject | null): SharedObjectCard | null {
  const [read, setRead] = useState<{ key: string; card: SharedObjectCard | null }>({ key: '', card: null });
  const linkable = !!object && object.type !== 'spec' && !!object.appSlug;
  const key = linkable && object ? JSON.stringify(referenceOf(object)) : '';
  useEffect(() => {
    if (!key || !object?.appSlug || object.type === 'spec') return undefined;
    let live = true;
    const type = object.type;
    const appSlug = object.appSlug;
    const { issueNumber, sessionId, proposalId } = object;
    void api.resolveLinkCards([{ type, appSlug, issueNumber, sessionId, proposalId }])
      .then((cards) => { if (live) setRead({ key, card: cards[0] || null }); })
      .catch(() => { if (live) setRead({ key, card: null }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return key && read.key === key ? read.card : null;
}

/**
 * #6254: the composer's half of the thread's drop zone. It renders nothing;
 * it tells ./pane-drop that a box which can take files is drawn for this
 * scope, so the pane around it lights and hands over what is dropped. A ref
 * carries the latest `addFiles`, which closes over the upload it belongs to.
 */
function ComposerDropTarget({ scope, onFiles }: { scope: ComposerScope; onFiles: (files: File[]) => void }) {
  const latest = useRef(onFiles);
  latest.current = onFiles;
  useEffect(() => registerComposerDrop(scope, (files) => latest.current(files)), [scope]);
  return null;
}

/**
 * WHERE A MESSAGE BOX'S WORDS GO (one message box, 27 Nov 2026). The box
 * below is the one every chat draws: Messages' conversations and reply
 * threads, a project's topic channels, the thread on a request, a change or
 * a decision (../group-chat/composer.tsx), and the comments under a change
 * (../dev-board/card/feed-thread.tsx). What differs between them is only
 * where the message goes, so that comes in as a PLACE: how it is sent, how a
 * file is uploaded, who `@` offers and what `#` offers, the staged reply's
 * chip, and the scope its draft is saved under (./store draftFor, the one
 * way every box saves a draft). The box itself keeps the field, the menus,
 * the formatting, the attachments strip and the send.
 */
export interface ComposerSend {
  content: string;
  attachmentIds: string[];
  attachments: MessageAttachment[];
  object?: SharedObjectReference;
}

/**
 * A person the `@` list offers. `insert` is what a pick puts after the `@`
 * when it is not the username (Homeroom bot goes in as its name), and
 * `match` what the typed prefix is read against.
 */
export interface MentionPerson {
  key: string;
  id: number;
  username: string;
  insert?: string;
  match?: string;
}

/**
 * Who `@` offers: a roster the place already holds (a group, a direct
 * message), or a lookup asked by what has been typed (a channel, a
 * project's chat). `key` names the lookup, so a new place starts a new one.
 */
export type ComposerPeople =
  | { kind: 'roster'; people: MentionPerson[] }
  | { kind: 'lookup'; key: string; ask: (query: string) => Promise<MentionPerson[]> };

/** One row of the `#` list: what it says, and what a pick puts in the token's place. */
export interface ComposerRef {
  key: string;
  insert: string;
  label: string;
  /** A muted second half: a channel's name, a request's title. */
  name?: string;
  /** A channel's handle, for `data-channel-option`. */
  channel?: string;
}

/** The `#` token before the caret (its `#` at `start`) and the rows it offers. */
export interface ComposerRefMatch {
  start: number;
  items: ComposerRef[];
}

/** The staged reply's chip, worded by the place. */
export interface ComposerReply {
  key: string | number;
  title: string;
  snippet: string;
  notes?: string[];
}

/** The ids a place's own code and its declared checks look the box up by. */
export interface ComposerIds {
  card?: string;
  input?: string;
  attach?: string;
  file?: string;
}

export interface ComposerPlace {
  /** The draft's scope (./store draftFor): the place's own key. */
  scope: ComposerScope;
  /** A reply thread's box (`messages-composer-thread`). */
  inThread?: boolean;
  placeholder: string;
  label: string;
  send: (input: ComposerSend) => Promise<unknown> | void;
  /** Absent: the box takes no files (no Attach row, no paste, no drop). */
  upload?: (file: File) => Promise<MessageAttachment>;
  /** The ceiling for one file, when the place's server has its own. */
  fileLimit?: (file: File) => number;
  typing?: (on: boolean) => void;
  people: ComposerPeople;
  refs?: (before: string) => ComposerRefMatch | null;
  reply?: ComposerReply | null;
  cancelReply?: () => void;
  /** #6035: the formatting row, Ctrl/Cmd+B and I, the select menu and the preview. */
  formatting?: boolean;
  ids?: ComposerIds;
  /** Drawn in the bar over the card: a hint, the reply starters. */
  above?: ReactNode;
  /**
   * Not at a screen's foot (the comments under a change, inside a card): no
   * chat foot's bar round the card, so no home-indicator inset either.
   */
  bare?: boolean;
  /** Messages' own conversation: the bot's Stop, its saved drafts, shared items. */
  conversationId?: number;
  threadRootId?: number | null;
  botChat?: boolean;
  /** Takes a shared item (Share, the picker): a conversation's own box. */
  shares?: boolean;
  /** Dictation off: the box is drawn where nothing can be sent. */
  speakOff?: boolean;
  /** A message went out (the "Hear when they answer?" ask). */
  onSent?: () => void;
}

/**
 * Words put in a box from outside it (a channel's reply starters, Go ahead
 * on a request's plan), by the box's scope, as ./pane-drop.ts hands it a
 * dropped file. The box registers while it is drawn; the last one for a
 * scope wins, and its removal removes only itself.
 */
type PutWords = (text: string, onlyIfEmpty: boolean) => void;
const wordsTargets = new Map<string, PutWords>();

/**
 * Put `text` in the box drawn for `scope` and give it the caret at the end.
 * `onlyIfEmpty` leaves words already typed alone and only focuses the box.
 * False when no box is drawn for the scope.
 */
export function putInComposer(scope: ComposerScope, text: string, { onlyIfEmpty = false }: { onlyIfEmpty?: boolean } = {}): boolean {
  const put = wordsTargets.get(String(scope));
  if (!put) return false;
  put(text, onlyIfEmpty);
  return true;
}

/** A roster member as the `@` list reads them. */
function personOf(member: ConversationUser): MentionPerson {
  return { key: `@${member.id}`, id: member.id, username: member.username };
}

/** #2783: the `#` token Messages reads: a word after `#`, never `#123`. */
const MESSAGES_REF_RE = /(?:^|\s)#([A-Za-z][A-Za-z0-9-]*|)$/;

/**
 * The conversation's composer — or, with `threadRootId` (#2387), the composer
 * of the reply thread open beside it. The two keep their own drafts and
 * their own staged reply (the store's composer scope), and only the
 * conversation's own composer takes shared items: a card shared into
 * Messages lands in the conversation, never inside a thread.
 */
export function MessageComposer({ threadRootId = null, scroller }: { threadRootId?: number | null; scroller?: RefObject<HTMLElement | null> } = {}) {
  const t = useMessages('messages');
  const snap = useMessagesSnapshot();
  const conversationId = snap.route.conversationId || 0;
  const active = snap.active;
  const scope = scopeKey(conversationId, threadRootId);
  const inThread = !!threadRootId;
  // A message went out to somebody who may answer (anyone but Homeroom bot,
  // whose own news rings as it is): the notification ask, "Hear when they
  // answer?" (../notify-ask/notify-ask.tsx), over the box. Held here, not in
  // the box, because the box gives way to the awaiting notice after a first
  // message and the ask stays over that notice.
  const [askReply, setAskReply] = useState(false);
  useEffect(() => { setAskReply(false); }, [scope]);
  const reply = replyFor(scope);

  if (!active || active.membershipStatus !== 'member') return null;
  // A conversation that did not load has no box to write in, though its
  // header still names it when the read got no answer (store.ts loadThread).
  if (!inThread && snap.threadError && !snap.messages.length) return null;

  // QA 2026-09-24 Q2: a direct request the other person has not accepted
  // yet. It carries ONE opening message; once that is sent (or in flight —
  // the optimistic row counts, so a quick second Enter cannot slip in) the
  // composer gives way to a plain statement of what the thread is waiting
  // for. Every later send used to come back "Not sent · Retry", and the
  // Retry could never work.
  const awaiting = !inThread && !!active.awaitingAcceptance;
  const { name: waitingOn, unknown: waitingUnknown } = awaiting ? waitingFor(active) : { name: '', unknown: false };
  // The bar round the card is the chat foot's (@/components/ui/chat
  // ChatComposerBar), as in every chat: its padding and its clearance under
  // it are decided there (1 November 2026). "You can't send here" is a line
  // of text in the card's place, not a bar round one, so it keeps its own.
  if (awaiting && (!active.canSend || snap.messages.length > 0)) {
    return (
      <ChatComposerBar className="messages-composer messages-composer-awaiting" data-awaiting-acceptance="">
        {askReply ? <NotifyAsk moment="reply" className="mb-2" /> : null}
        <div className="messages-awaiting" role="status">
          <strong>{t('messages:composer.requestSent.title')}</strong>
          <p>{waitingUnknown ? t('messages:composer.requestSent.waitingUnknown') : waitingOn ? t('messages:composer.requestSent.waitingNamed', { username: waitingOn }) : t('messages:composer.requestSent.waitingUnnamed')}</p>
        </div>
      </ChatComposerBar>
    );
  }
  if (!active.canSend) return <div className="messages-composer-disabled platform-safe-bar">{t('messages:composer.cannotSend')}</div>;
  // One request, one story: inside a request's thread in the chat with
  // Homeroom bot the box says a reply is about the request. The pane's
  // header names it; the full title here wrapped the box to three lines on
  // a phone (polish N16).
  const botRoot = inThread && active.kind === 'direct' && threadsAllowed(active)
    ? (snap.thread?.rootId === threadRootId ? snap.thread.root : null) || snap.messages.find((item) => item.id === threadRootId) || null
    : null;
  const botRequest = botRoot?.sender.bot && botRoot.metadata?.homeroomBot ? botRequestNames(botRoot.metadata.homeroomBot) : null;
  // ONE LOOK (25 Nov 2026): the box names who it goes to, as the agreed
  // mockups draw it ("Message pat_parrot"): the other person of a direct
  // message, or a group's name. A person with no name keeps "Message…".
  const viewerId = typeof window !== 'undefined' ? Number(window.App?.user?.id) || 0 : 0;
  const toPeer = active.kind === 'direct' ? active.peer || active.members.find((member) => Number(member.id) !== viewerId) || null : null;
  const toName = active.kind === 'group' ? active.title : toPeer && !toPeer.unnamed ? senderName(toPeer, { bare: true }) : '';
  const mainPlaceholder = toName ? t('messages:composer.placeholderTo', { name: toName }) : t('messages:composer.placeholder');
  const threadPlaceholder = !botRequest ? t('messages:composer.placeholderThread')
    : botRequest.firstVersion ? t('messages:composer.placeholderBotThreadFirstVersion')
      : botRequest.title || botRequest.number ? t('messages:composer.placeholderBotThread')
        : t('messages:composer.placeholderThread');
  // A plan's reply: a first version's is read by the bot alone (its next
  // look), a request's plan's is posted on the request (#4488).
  const planReply = reply?.sender.bot && reply.metadata?.homeroomBot?.kind === 'plan' ? reply.metadata.homeroomBot : null;
  const replyNotes = reply ? [
    ...(reply.sender.bot && mirrorsReplies(reply.metadata?.homeroomBot) ? [t('messages:bot.draft.reply')] : []),
    ...(planReply ? [planReply.firstVersion ? t('messages:composer.planReplyNote') : t('messages:composer.planReplyNotePublic')] : []),
  ] : [];
  const isChannel = active.kind === 'channel';
  // The viewer's own chat with the bot, and the one the route is on: the
  // conversation drawn can be the last one for a moment after a move.
  const botChat = active?.homeroomBot === true && active.id === conversationId;
  const answerable = active.homeroomBot !== true;
  const place: ComposerPlace = {
    scope,
    inThread,
    conversationId,
    threadRootId,
    botChat,
    shares: !inThread,
    speakOff: !active.canSend,
    formatting: isChannel,
    placeholder: inThread ? threadPlaceholder : mainPlaceholder,
    label: inThread ? t('messages:composer.labelThread') : t('messages:composer.label'),
    send: (input) => send({ ...input, threadRootId }),
    upload: (file) => api.uploadAttachment(conversationId, file),
    // 31 Oct 2026: typed in a thread, it is that thread's typing line.
    typing: (on) => notifyTyping(on, threadRootId),
    // #3361: a channel's roster is counted, not loaded (the server's
    // serializeConversation), so `active.members` is empty there and `@`
    // offered nobody. A channel asks the server for the people matching what
    // has been typed instead. Groups and DMs keep reading their loaded
    // roster, exactly as before.
    people: isChannel
      ? { kind: 'lookup', key: `c${conversationId}`, ask: (query) => api.getMentionCandidates(conversationId, query, CHANNEL_MENTION_LIMIT).then((users) => users.map(personOf)) }
      : { kind: 'roster', people: active.members.filter((member) => member.status === 'member').map(personOf) },
    // #2783: `#` offers the viewer's channels — #general and their apps' —
    // and inserts `#handle`, which every chat renders as a link to it. Only a
    // word after the `#`: `#123` is an issue reference, and a DM has no app to
    // look issues up in.
    refs: (before) => {
      const match = before.match(MESSAGES_REF_RE);
      if (!match || match.index === undefined) return null;
      const q = match[1].toLowerCase();
      return {
        start: match.index + match[0].length - match[1].length - 1,
        items: channels().filter((item) => item.handle.startsWith(q)).slice(0, 6).map((item) => ({
          key: item.handle,
          insert: `#${item.handle}`,
          label: `#${item.handle}`,
          channel: item.handle,
          ...(item.kind === 'app' && item.name.toLowerCase() !== item.handle ? { name: item.name } : {}),
        })),
      };
    },
    reply: reply ? {
      key: reply.id,
      title: reply.sender.unnamed ? (reply.sender.id ? t('messages:composer.replyingToUnknownHandle') : t('messages:composer.replyingToUnknown')) : t('messages:composer.replyingTo', { name: senderName(reply.sender, { bare: active.kind === 'direct' }) }),
      snippet: plainText(reply.content) || t('messages:composer.replyAttachment'),
      notes: replyNotes,
    } : null,
    cancelReply: () => setReply(scope, null),
    onSent: () => { if (answerable) setAskReply(true); },
    above: (
      <>
        {askReply ? <NotifyAsk moment="reply" className="mb-2" /> : null}
        {/* QA 2026-09-24 Q2: before the opening message of a request, what it
            will be — so the composer turning into a notice after it is no
            surprise. */}
        {awaiting ? <p className="messages-composer-hint" data-awaiting-acceptance="">{waitingUnknown ? t('messages:composer.firstMessageHintUnknown') : waitingOn ? t('messages:composer.firstMessageHintNamed', { username: waitingOn }) : t('messages:composer.firstMessageHintUnnamed')}</p> : null}
      </>
    ),
  };
  return <MessageBox place={place} scroller={scroller} />;
}

/**
 * The message box itself, for any place (above). Its scope is the draft's:
 * the box reads the draft back when the scope changes, and writes it as the
 * words change.
 */
export function MessageBox({ place, scroller }: { place: ComposerPlace; scroller?: RefObject<HTMLElement | null> }) {
  const t = useMessages('messages');
  const conversationId = place.conversationId || 0;
  const threadRootId = place.threadRootId ?? null;
  const scope = place.scope;
  // Where a save lands, and whether its chips are the ones on screen: an
  // upload started here can finish after the person moved to another draft.
  const scopeRef = useRef<ComposerScope>(scope);
  scopeRef.current = scope;
  const inThread = !!place.inThread;
  const isChannel = !!place.formatting;
  const ids = place.ids || {};
  const [value, setValue] = useState('');
  const [dictating, setDictating] = useState(false);
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  // #6862: a file still uploading is drawn too — an image as its own local
  // preview, dimmed with a progress ring, with no × until it lands.
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const uploading = pending.length;
  const pendingRef = useRef<PendingUpload[]>([]);
  pendingRef.current = pending;
  const uploadSeq = useRef(0);
  // An item the person chose to share (Share, the picker): a chip over the
  // box until they send it or press ×. 14 Nov 2026: nothing else attaches
  // one. The Homeroom bot tab's list attached what a row opened to Main
  // Chat's box, and Ask for changes put its change there (#6212); Main Chat
  // is gone, and those go into a new chat's box (./new-thread.tsx).
  const [object, setObject] = useState<StagedObject | null>(null);
  const stagedCard = useStagedCard(object);
  const [error, setError] = useState('');
  // Task 2148: the message whose answer the viewer pressed Stop for, while
  // that Stop is on its way (./bot-stop.ts).
  const [stoppingFor, setStoppingFor] = useState<number | null>(null);
  // #1955: the paperclip and the share tray were two adjacent icons that both
  // answered "put something in this message", and neither said which was
  // which — two guesses at a 40px target, on the narrowest row in the app.
  // One "+" opens both as named rows instead.
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // #6653: selected words can be formatted from a right-click menu, and a
  // link asks for its address in the formatting row's place.
  const [selMenu, setSelMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuRange = useRef<{ start: number; end: number } | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  // Request #7164 (phone audit): under 768px a channel's box stands alone and
  // the formatting row waits behind "Formatting" in the "+" menu. Closed to
  // begin with, and it stays as the person left it: sending does not close
  // it. A desktop draws the row always and never the menu's row (app.css).
  const [formatOpen, setFormatOpen] = useState(false);
  const formatBarId = useId();
  const [linkValue, setLinkValue] = useState('');
  const linkRange = useRef<{ start: number; end: number } | null>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  // A phone's long press keeps its own text menu (the Android double menu
  // app-grid.tsx documents), so only a pointer that is not touch opens ours.
  const lastPointer = useRef('');
  // #1408: grow with the message, up to the max-height already in app.css.
  // #6810: and, after a deletion collapses the box, keep the transcript above
  // it at its newest line when that is where it was.
  useAutoGrow(inputRef, value, scroller);
  // Phone review #58: once the text wraps, it has the card's whole width.
  const stacked = useComposerStack(inputRef, value);
  // Plain Enter sends on this device (lib/enter-sends.ts): what the hint
  // under the box and the send button's tooltip say. False on the first
  // render, so the prerender and the hydration draw neither.
  const enterKey = useEnterSends();
  const fileRef = useRef<HTMLInputElement>(null);
  const typingStop = useRef<number | null>(null);
  const reply = place.reply || null;
  // #2386: friends lead the @ list (features/friends/store.ts).
  const friendIds = useFriendIds();
  // The place's latest callbacks, for effects and timers that outlive a render.
  const placeRef = useRef(place);
  placeRef.current = place;

  // #6862: a file still uploading belongs to the draft it was started in, so
  // a change of draft takes its local previews with it.
  const clearPending = () => {
    for (const item of pendingRef.current) if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    setPending([]);
  };
  // A preview outlives neither the composer nor a change of draft.
  useEffect(() => () => {
    for (const item of pendingRef.current) if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  }, []);

  // #6249: the attached files come back with the words they were saved with.
  // A scope change is still the one place the composer reads a draft back.
  useEffect(() => {
    setValue(draftFor(scope)); setAttachments(draftAttachmentsFor(scope)); setObject(null); setError('');
    clearPending();
    setSelMenu(null); setLinkOpen(false); menuRange.current = null; linkRange.current = null;
  }, [scope]);

  /**
   * #6249: save a draft's attached files, and draw them when that draft is
   * the one on screen. `target` is the scope the change belongs to, which is
   * not always the one open now.
   */
  const updateAttachments = (target: ComposerScope, change: (items: MessageAttachment[]) => MessageAttachment[]) => {
    const next = change(draftAttachmentsFor(target));
    setDraftAttachments(target, next);
    if (target === scopeRef.current) setAttachments(next);
  };

  /** #6862: an upload's row and its local preview go together. */
  const forgetPending = (key: string) => {
    setPending((items) => {
      const gone = items.find((item) => item.key === key);
      if (gone?.thumbUrl) URL.revokeObjectURL(gone.thumbUrl);
      return items.filter((item) => item.key !== key);
    });
  };

  // Reply puts the caret here where there is a hardware keyboard, so the
  // next keystroke is the reply (message-actions/focus.ts).
  const replyId = reply?.key ?? null;
  useEffect(() => {
    if (replyId && wantsKeyboardFocus()) inputRef.current?.focus({ preventScroll: true });
  }, [replyId]);

  const shares = !!place.shares;
  useEffect(() => {
    if (!shares) return undefined;
    const onSelected = (event: Event) => {
      const detail = (event as CustomEvent<SharedObjectReference & { conversationId?: number }>).detail;
      if (!detail) return;
      // Addressed to one conversation: every other composer mounted under a
      // hidden screen leaves it alone.
      const { conversationId: to, ...object } = detail;
      if (to != null && to !== conversationId) return;
      setObject(object); inputRef.current?.focus();
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
  }, [conversationId, shares]);

  // The typing line of the place being left stops with it: the place is
  // taken when its scope is drawn, not read again when it goes.
  useEffect(() => {
    const leaving = placeRef.current;
    return () => {
      if (typingStop.current) window.clearTimeout(typingStop.current);
      leaving.typing?.(false);
    };
  }, [scope]);

  // Task 2148: Stop, in the viewer's chat with Homeroom bot (./bot-stop.ts).
  // What the bot is answering in THIS place (the chat, or this thread) is
  // its typing entry's; nothing types on a first render, so that draws Send.
  const answering = conversationId ? answeringIn(typingUsers(conversationId, threadRootId)) : null;
  // The viewer's own chat with the bot (the place says; MessageComposer).
  const botChat = !!place.botChat;
  const sendKind = sendMode({
    botChat,
    answering,
    words: !!value.trim(),
    empty: !value.trim() && !attachments.length && !object && !uploading && !dictating,
    stopping: stoppingFor,
  });
  // The Stop button's own state, alone or beside "Save draft".
  const stopKind = stopMode({ answering, stopping: stoppingFor });
  // "Stopping" ends when the bot's typing clears here (the answer ended, or
  // another began), or after STOPPING_MAX_MS, and the button is Send again.
  useEffect(() => {
    if (stoppingFor == null) return undefined;
    if (stoppingFor !== answering) { setStoppingFor(null); return undefined; }
    const timer = window.setTimeout(() => setStoppingFor(null), STOPPING_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [stoppingFor, answering]);
  function stopBot() {
    if (!conversationId || !answering || stoppingFor === answering) return;
    const stopped = answering;
    setError('');
    setStoppingFor(stopped);
    api.stopBotAnswer(conversationId, stopped)
      // Nothing was being answered any more: the answer is on its way in.
      .then((stopping) => { if (!stopping) setStoppingFor((now) => (now === stopped ? null : now)); })
      .catch(() => {
        setStoppingFor((now) => (now === stopped ? null : now));
        setError(t('messages:composer.stopFailed'));
      });
  }

  // SAVED DRAFTS, in the viewer's chat with Homeroom bot (./bot-drafts.ts,
  // the agent chats' list). While the bot works here, what is typed is saved
  // instead of sent, and sent later by a tap on its row, never on its own.
  // The list is this place's: the chat's, or this thread's. Nothing is read
  // for any other conversation, and nothing on a first render.
  const savedDrafts = useBotDrafts(conversationId, threadRootId, botChat);
  // A draft is words only. The files, the quoted reply and the attached
  // item staged in the box are not part of it and stay where they are.
  function saveTyped() {
    const startScope = scope;
    const saved = saveBotDraft(conversationId, threadRootId, value, (text) => {
      // The server refused it after the box emptied: the words come back,
      // ahead of anything typed since, or to the draft of the place they
      // were typed in when the viewer has moved on.
      if (scopeRef.current === startScope) {
        const now = inputRef.current?.value || '';
        const back = (now.trim() ? `${text}\n\n${now}` : text).slice(0, 8000);
        setValue(back); setDraft(startScope, back);
      } else if (!draftFor(startScope)) {
        setDraft(startScope, text);
      }
    });
    if (!saved) return;
    setError(''); place.typing?.(false);
    setValue(''); setDraft(scope, '');
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }
  // Send a draft: its words go as the message, with whatever is staged in
  // the box (files, a quoted reply, an attached item), exactly as Send
  // would send them typed. What was typed is kept as another draft first
  // (takeBotDraft). Never while the bot works here, a file is on its way up
  // or dictation runs: the row's button is disabled then.
  function sendSavedDraft(draft: SavedDraft) {
    if (answering || dictating || uploading) return;
    const text = takeBotDraft(conversationId, threadRootId, draft.id, value);
    if (text == null) return;
    setError(''); place.typing?.(false);
    const input = { content: text, attachmentIds: attachments.map((item) => item.id), attachments, object: object ? referenceOf(object) : undefined };
    setValue(''); setAttachments([]); setObject(null);
    Promise.resolve(place.send(input))
      .catch((err) => setError(err instanceof Error ? err.message : t('messages:composer.sendFailed')));
  }
  // Edit a draft: its words go back in the box, and what was typed there is
  // kept as another draft first.
  function editSavedDraft(draft: SavedDraft) {
    const text = takeBotDraft(conversationId, threadRootId, draft.id, value);
    if (text == null) return;
    setValue(text); setDraft(scope, text);
    // The caret goes to the end of the words, in the layout effect their
    // render runs (as after an emoji swap).
    emojiCaret.current = text.length;
    inputRef.current?.focus({ preventScroll: true });
  }


  // The `@word` being typed at the caret, or undefined when there is none.
  const mentionPrefix = useMemo(() => {
    const cursor = inputRef.current?.selectionStart ?? value.length;
    return value.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/)?.[1];
  }, [value]);

  // #3361: a lookup asks the place for the people matching what has been
  // typed, a beat after the last keystroke. One lookup per place
  // (lib/prefix-lookup.ts, named by `people.key`) remembers each answer,
  // shares a request in flight and drops an answer for a prefix no longer
  // being typed, so a slow `@a` cannot replace the list for `@alex`. A
  // roster is read as it stands, below.
  const people = place.people;
  const lookupKey = people.kind === 'lookup' ? people.key : '';
  const askPeople = useRef<((query: string) => Promise<MentionPerson[]>) | null>(null);
  askPeople.current = people.kind === 'lookup' ? people.ask : null;
  const channelLookup = useMemo<PrefixLookup<MentionPerson> | null>(() => (lookupKey
    ? prefixLookup((query) => (askPeople.current ? askPeople.current(query) : Promise.resolve([])))
    : null), [lookupKey]);
  const [channelPeople, setChannelPeople] = useState<{ lookup: PrefixLookup<MentionPerson> | null; key: string; users: MentionPerson[] }>({ lookup: null, key: '', users: [] });
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

  const roster = people.kind === 'roster' ? people.people : null;
  const mention = useMemo(() => {
    if (mentionPrefix === undefined) return null;
    const prefix = mentionPrefix.toLowerCase();
    const matches = (member: MentionPerson) => (member.match || member.username).toLowerCase().startsWith(prefix);
    if (channelLookup) {
      // The answer for this prefix, or — while it loads — for a shorter one
      // whose answer was complete (under the limit), which narrows exactly.
      const held = channelPeople.lookup === channelLookup
        && (channelPeople.key === prefix
          || (prefix.startsWith(channelPeople.key) && channelPeople.users.length < CHANNEL_MENTION_LIMIT));
      const found = held ? channelPeople.users : [];
      return orderFriendsFirst(found.filter(matches), friendIds).slice(0, 6);
    }
    return orderFriendsFirst((roster || []).filter(matches), friendIds).slice(0, 6);
  }, [roster, channelPeople, channelLookup, mentionPrefix, friendIds]);

  // #2783: `#` offers what the place has to offer (Messages: the viewer's
  // channels; a project's chat: its requests and changes too), read off the
  // text before the caret.
  const refMatch = useMemo(() => {
    if (!place.refs) return null;
    const cursor = inputRef.current?.selectionStart ?? value.length;
    return place.refs(value.slice(0, cursor));
  }, [value, place.refs]);
  const channelMatches = refMatch ? refMatch.items : null;

  // ── Choosing a suggestion from the keyboard (QA 2026-09-24 Q13) ──────
  //
  // The @ and # lists were mouse-only: the arrows moved the caret, and Enter
  // SENT the half-typed "@qaf" instead of picking the person it was
  // suggesting. Now the open list is a listbox the textarea drives through
  // `aria-activedescendant`: the first row is highlighted, ArrowUp/ArrowDown
  // move the highlight, Enter or Tab picks it, and Escape closes the list
  // for the text as it stands (typing brings it back). While no list is
  // showing, Enter sends where there is a keyboard and Shift+Enter is a new
  // line, as in a project's channel; on a touch device Enter stays a new
  // line. Ctrl/Cmd+Enter sends everywhere (lib/enter-sends.ts, which
  // replaced #5361's Enter-is-a-new-line rule).
  const listId = useId();
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const listOpen = dismissedAt !== value;
  const mentionShown = listOpen && !!mention?.length;
  const channelShown = listOpen && !mentionShown && !!channelMatches?.length;
  const suggestions: Array<{ key: string; pick: () => void }> = mentionShown
    ? (mention || []).map((member) => ({ key: member.key, pick: () => insertMention(member.insert || member.username) }))
    : channelShown
      ? (channelMatches || []).map((item) => ({ key: `#${item.key}`, pick: () => insertChannel(item) }))
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
  // #6035: where the selection goes after a formatting button edited the
  // text, put back in the same layout effect as an emoji swap's caret.
  const formatCaret = useRef<{ start: number; end: number } | null>(null);
  useLayoutEffect(() => {
    const selection = formatCaret.current;
    if (!selection) return;
    formatCaret.current = null;
    inputRef.current?.setSelectionRange(selection.start, selection.end);
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

  // A list opens over the box. Where a box stands at the top of a scrolling
  // body (the comments under a change, in Needs you), over it is cut off by
  // the body's edge, so the list opens under the box instead, as the
  // comments box's own list did. Measured as it opens, before it is painted.
  const listKey = mentionShown ? 'mention' : channelShown ? 'refs' : emojiOpen ? 'emoji' : '';
  const listBoxRef = useRef<HTMLDivElement>(null);
  const [listBelow, setListBelow] = useState(false);
  useLayoutEffect(() => {
    const el = listBoxRef.current;
    if (!listKey || !el) { setListBelow(false); return; }
    let edge = 0;
    for (let up = el.parentElement; up; up = up.parentElement) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(up).overflowY)) edge = Math.max(edge, up.getBoundingClientRect().top);
    }
    if (el.getBoundingClientRect().top < edge) setListBelow(true);
  }, [listKey]);

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

  /** The menu's keys, ahead of the send chord. True when the key was the menu's. */
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

  function insertChannel(item: ComposerRef) {
    const input = inputRef.current;
    const cursor = input?.selectionStart ?? value.length;
    const start = refMatch ? refMatch.start : cursor;
    const before = `${value.slice(0, start)}${item.insert} `;
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

  /** #6035: Ctrl/Cmd+B and Ctrl/Cmd+I in a channel, as other chat apps do. */
  function onFormatKey(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!isChannel || event.nativeEvent.isComposing || event.altKey || event.shiftKey) return false;
    if (!(event.metaKey || event.ctrlKey)) return false;
    const key = event.key.toLowerCase();
    if (key !== 'b' && key !== 'i') return false;
    event.preventDefault();
    formatSelected(key === 'b' ? 'bold' : 'italic');
    return true;
  }

  function updateValue(next: string) {
    const trimmed = next.slice(0, 8000);
    setValue(trimmed); setDraft(scope, trimmed);
    // The place's typing line (a thread's own, in a thread).
    const typing = place.typing;
    typing?.(true);
    if (typingStop.current) window.clearTimeout(typingStop.current);
    typingStop.current = window.setTimeout(() => typing?.(false), 2200);
  }

  // Words from outside the box (`putInComposer`), with the caret after them.
  const putWords = useRef<PutWords>(() => undefined);
  putWords.current = (text, onlyIfEmpty) => {
    const input = inputRef.current;
    if (!(onlyIfEmpty && (input?.value || '').trim())) {
      emojiCaret.current = Math.min(text.length, 8000);
      updateValue(text);
    }
    input?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const key = String(scope);
    const put: PutWords = (text, onlyIfEmpty) => putWords.current(text, onlyIfEmpty);
    wordsTargets.set(key, put);
    return () => { if (wordsTargets.get(key) === put) wordsTargets.delete(key); };
  }, [scope]);

  /** #6035: format the selection (or the caret's line/spot) and keep the focus. */
  function formatSelected(kind: FormatKind) {
    const input = inputRef.current;
    if (!input) return;
    const result = applyFormat(input.value.slice(0, 8000), input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, kind);
    formatCaret.current = { start: result.start, end: result.end };
    input.focus({ preventScroll: true });
    updateValue(result.value);
  }

  // ── #6653: formatting what is selected, from a right-click menu ──────
  //
  // The menu and the link field both go through the same `applyFormat` the
  // row uses, so pressing an item twice unwraps exactly as the button does.
  // A menu closes before its edit, and the range it held is put back first:
  // the textarea keeps its selection while the menu has focus.
  const restoreRange = (range: { start: number; end: number } | null) => {
    const input = inputRef.current;
    if (!input || !range) return false;
    input.focus({ preventScroll: true });
    input.setSelectionRange(range.start, range.end);
    return true;
  };

  function openLinkField() {
    const input = inputRef.current;
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    linkRange.current = { start, end };
    setSelMenu(null);
    setLinkValue('');
    setLinkOpen(true);
  }

  function applyLink(raw: string) {
    const input = inputRef.current;
    const url = normalizeLinkUrl(raw);
    if (!input || !url) return;
    const range = linkRange.current
      || { start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length };
    const result = applyFormat(input.value.slice(0, 8000), range.start, range.end, 'link', url);
    formatCaret.current = { start: result.start, end: result.end };
    linkRange.current = null;
    setLinkOpen(false);
    input.focus({ preventScroll: true });
    updateValue(result.value);
  }

  function cancelLink() {
    const range = linkRange.current;
    setLinkOpen(false);
    linkRange.current = null;
    restoreRange(range);
  }

  function runMenuFormat(kind: FormatKind) {
    const range = menuRange.current;
    setSelMenu(null);
    if (restoreRange(range)) formatSelected(kind);
  }

  function linkFromMenu() {
    linkRange.current = menuRange.current;
    setSelMenu(null);
    setLinkValue('');
    setLinkOpen(true);
  }

  async function copySelection() {
    const range = menuRange.current;
    const input = inputRef.current;
    setSelMenu(null);
    if (!input || !range) return;
    const words = input.value.slice(range.start, range.end);
    restoreRange(range);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(words);
    }
    catch {
      // The older path, and the one a refused permission leaves: the words
      // are already selected in the field. No "Copied" line is shown.
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
    }
  }

  function onTextareaContextMenu(event: ReactMouseEvent<HTMLTextAreaElement>) {
    // A channel's box only: a direct message keeps the browser's menu, and a
    // long press on a phone keeps the phone's own text menu.
    if (!isChannel || dictating || lastPointer.current === 'touch') return;
    const input = event.currentTarget;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    if (start === null || end === null || start === end) return;
    event.preventDefault();
    menuRange.current = { start, end };
    setSelMenu({ x: event.clientX, y: event.clientY });
  }

  // The menu sits at the pointer's bottom-left, kept inside the viewport,
  // and flips below the pointer when there is no room above it. Measured in
  // a layout effect, so it never paints where it does not belong.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!selMenu || !element) return;
    const rect = element.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(selMenu.x, window.innerWidth - rect.width - pad));
    let top = selMenu.y - rect.height;
    if (top < pad) top = selMenu.y + 4;
    top = Math.max(pad, Math.min(top, window.innerHeight - rect.height - pad));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  }, [selMenu]);

  // The menu is a menu from the keyboard too: the first item takes focus,
  // the arrows move, Escape closes and gives the field back. A press
  // outside, a scroll or a resize closes it.
  useEffect(() => {
    if (!selMenu) return undefined;
    const element = menuRef.current;
    const items = () => Array.from(element?.querySelectorAll<HTMLElement>('[role="menuitem"]') || []);
    items()[0]?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSelMenu(null);
        inputRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const list = items();
      if (!list.length) return;
      event.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus({ preventScroll: true });
    };
    const onDown = (event: PointerEvent) => {
      if (!element?.contains(event.target as Node)) setSelMenu(null);
    };
    const close = () => setSelMenu(null);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [selMenu]);

  // The link field takes the caret when it opens, so the address can be
  // typed straight away.
  useLayoutEffect(() => {
    if (linkOpen) linkInputRef.current?.focus({ preventScroll: true });
  }, [linkOpen]);

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
    // #6249: an upload that finishes after the person moved on is saved to
    // the draft it was started in, never drawn in the one they moved to.
    const startScope = scopeRef.current;
    // #6256: the cap, the per-type ceiling and the line naming what was left
    // out are shared with the blank thread's composer (../attachments/limits).
    const uploadTo = place.upload;
    if (!uploadTo) return;
    const { upload, refused } = stageFiles(files, attachments.length + uploading, t, place.fileLimit);
    setError(refused);
    for (const file of upload) {
      // #6862: the row appears at once. An image shows its own picture, made
      // from the File and not yet on the server; anything else waits as a
      // card. Both say "uploading" and offer no × until the upload lands.
      const key = `p${(uploadSeq.current += 1)}`;
      const thumbUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      setPending((items) => [...items, { key, file, thumbUrl }]);
      try {
        const attachment = await uploadTo(file);
        updateAttachments(startScope, (items) => [...items, attachment]);
        forgetPending(key);
      }
      catch (err) { setError(err instanceof Error ? err.message : t('messages:composer.uploadFailed', { file: file.name })); forgetPending(key); }
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
  //
  // THE FIELD KEEPS THE KEYBOARD THROUGH A SEND (first-session run, 4 Oct
  // 2026). In the iOS app, sending with the keyboard up blanked the whole
  // conversation, header and composer included, until the keyboard was put
  // away. The likely sequence (read from the code, not measured): a button
  // takes no focus on Apple platforms, so the tap on Send cleared it from
  // the field and the keyboard started down; the refocus below, a frame
  // later, brought it back with iOS's reveal-the-field scroll, while the
  // app's shell was resizing its web view around the keyboard, and nothing
  // put that scroll back until the keyboard closed. So Send keeps focus
  // where it is (`onMouseDown` on the button: the field never blurs), and
  // the refocus, which is for the keyboard or mouse user who moved focus to
  // Send, never scrolls. Every other focus in this feature is
  // `preventScroll` for the same reason.
  function submit() {
    if (dictating || uploading || (!value.trim() && !attachments.length && !object)) return;
    // While Homeroom bot works here, Enter and Cmd/Ctrl + Enter save what is
    // typed as a draft, as the "Save draft" button does (./bot-stop.ts).
    if (sendKind === 'save') { saveTyped(); return; }
    setError(''); place.typing?.(false);
    const input = { content: value.trim(), attachmentIds: attachments.map((item) => item.id), attachments, object: object ? referenceOf(object) : undefined };
    setValue(''); setAttachments([]); setObject(null);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    Promise.resolve(place.send(input))
      .then(() => { placeRef.current.onSent?.(); })
      .catch((err) => setError(err instanceof Error ? err.message : t('messages:composer.sendFailed')));
  }

  const addRows = !!place.upload || shares || isChannel;
  // Where the count turns amber, and the only length a phone shows it at.
  const nearLimit = value.length > 7600;
  const keysHint = enterKey && value.includes('\n') && !nearLimit;
  // #6035, Drea: the draft as it will be sent, drawn by the same renderer a
  // sent message is. It is shown once the draft carries formatting, so a
  // plain message's box stays the one row it was; the field keeps the
  // source that gets sent.
  const preview = isChannel && hasFormatting(value) && plainText(value).length > 0 ? value.trim() : null;

  // #6862: what is staged, as the pending strip draws it — the files already
  // uploaded, then the ones still in flight. Only a landed file carries a ×;
  // the strip reads an index over this whole list.
  const staged = [...attachments.map(attachmentView), ...pending.map(pendingUploadView)];
  const removeStaged = (index: number) => {
    const item = attachments[index];
    if (item) updateAttachments(scope, (items) => items.filter((candidate) => candidate.id !== item.id));
  };

  // A screen's foot draws the chat foot's bar round the card; a box inside
  // a card (`bare`) a plain block, with no home-indicator inset.
  const Bar = place.bare ? 'div' : ChatComposerBar;
  return (
    <Bar className={`messages-composer ${inThread ? 'messages-composer-thread' : ''}`}>
      {/* What the place draws over the card: Messages' notification ask
          and its first-message hint, a channel's reply starters. */}
      {place.above}
      {/* The saved drafts of this place (./bot-drafts-list.tsx): only in the
          chat with Homeroom bot, and nothing at all with no drafts. */}
      {botChat ? <BotSavedDrafts drafts={savedDrafts} busy={!!answering} held={dictating || !!uploading} onSend={sendSavedDraft} onEdit={editSavedDraft} onDelete={(draft) => deleteBotDraft(conversationId, threadRootId, draft.id)} /> : null}
      {/* The white card. The bar around it is what carries the home-indicator
          inset (`platform-safe-bar`), so the card keeps its own padding on a
          notched phone instead of growing a tall blank foot. */}
      {/* Audit C06: files staged are something to send, so Send is not drawn
          faded over an empty field while they are (app.css reads the empty
          field off :placeholder-shown). */}
      <div className="messages-composer-card" id={ids.card} data-gc-files={staged.length ? '' : undefined}>
      {/* #6254: a file dropped anywhere on the thread reaches this box's
          upload. The pane draws the outline and calls this. */}
      {place.upload ? <ComposerDropTarget scope={scope} onFiles={(files) => { void addFiles(files); }} /> : null}
      {reply ? <div className="messages-reply-draft"><div className="min-w-0"><span className="font-semibold">{reply.title}</span><p className="truncate">{reply.snippet}</p>{(reply.notes || []).map((note) => <p key={note} className="messages-bot-note">{note}</p>)}</div><button type="button" onClick={() => place.cancelReply?.()} aria-label={t('messages:composer.cancelReply')}>×</button></div> : null}
      {object ? <div className="messages-pending-object"><span aria-hidden="true">◆</span><span className="truncate">{pendingObjectLabel(object, stagedCard)}</span><button type="button" onClick={() => setObject(null)} aria-label={t('messages:composer.removeSharedItem')}>×</button></div> : null}
      {staged.length ? <div className="dc-attach-strip dc-attach-strip-active"><PendingStripRows items={staged} onRemove={removeStaged} />{uploading ? <span className="dc-attach-uploading">{t('messages:composer.uploading', { count: uploading })}</span> : null}</div> : null}
      {channelShown && channelMatches ? <div ref={listBoxRef} className="messages-mention-menu" data-below={listBelow ? '' : undefined} id={listId} role="listbox" aria-label={t('messages:composer.channelsMenu')}>{channelMatches.map((item, index) => <button key={item.key} id={optionId(index)} type="button" role="option" tabIndex={-1} aria-selected={index === activeOption} data-channel-option={item.channel} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setHighlight(index)} onClick={() => insertChannel(item)}>{item.label}{item.name ? <span className="messages-channel-option-name"> {item.name}</span> : null}</button>)}</div> : null}
      {mentionShown && mention ? <div ref={listBoxRef} className="messages-mention-menu" data-below={listBelow ? '' : undefined} id={listId} role="listbox" aria-label={t('messages:composer.peopleMenu')}>{mention.map((member, index) => <button key={member.key} id={optionId(index)} type="button" role="option" tabIndex={-1} aria-selected={index === activeOption} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setHighlight(index)} onClick={() => insertMention(member.insert || member.username)}>@{member.insert || member.username}</button>)}</div> : null}
      {emojiOpen && emoji ? (
        <div ref={listBoxRef} className="messages-mention-menu messages-emoji-menu" data-below={listBelow ? '' : undefined}>
          <div className="messages-emoji-menu-heading"><RichMessage id="messages:composer.emojiMatching" values={{ query: emoji.query }} components={[<span className="messages-emoji-menu-query" />]} /></div>
          <div ref={emojiListRef} className="messages-emoji-menu-list" role="listbox" aria-label={t('messages:composer.emojiMenu')}>
            {emoji.items.map((item, i) => (
              <button key={item.emoji} type="button" role="option" aria-selected={i === emojiActive} data-emoji-option={item.shortcode} onMouseDown={(event) => event.preventDefault()} onClick={() => insertEmoji(item.emoji)}>
                <span className="messages-emoji-option-glyph" aria-hidden="true">{item.emoji}</span>
                <span className="messages-emoji-option-code">:{item.shortcode}:</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {selMenu ? (
        // Its mousedown is prevented so the message field keeps the
        // keyboard (and the selection) while one of these actions is
        // chosen; the mark is what makes a tap there keep it
        // (tests/keyboard-dismiss.test.js).
        <div ref={menuRef} className="messages-select-menu" role="menu" data-keep-keyboard="" aria-label={t('messages:composer.format.menu')} style={{ left: `${selMenu.x}px`, top: `${selMenu.y}px` }} onMouseDown={(event) => event.preventDefault()}>
          {SELECT_MENU_ACTIONS.map(({ kind, label, Icon }) => (
            <button key={kind} type="button" role="menuitem" onClick={() => runMenuFormat(kind)}>
              <Icon aria-hidden="true" />
              <span>{t(label)}</span>
            </button>
          ))}
          <button type="button" role="menuitem" onClick={linkFromMenu}>
            <LinkIcon aria-hidden="true" />
            <span>{t('messages:composer.format.link')}</span>
          </button>
          <hr />
          <button type="button" role="menuitem" onClick={() => { void copySelection(); }}>
            <CopyIcon aria-hidden="true" />
            <span>{t('messages:composer.format.copy')}</span>
          </button>
        </div>
      ) : null}
      {preview ? (
        <div className="messages-format-preview" role="group" aria-label={t('messages:composer.format.preview')}>
          <span className="messages-format-preview-label" aria-hidden="true">{t('messages:composer.format.preview')}</span>
          <div className="messages-format-preview-body">
            <MessageMarkdown content={preview} />
          </div>
        </div>
      ) : null}
      {isChannel && linkOpen ? (
        <div className="messages-format-link">
          <input
            ref={linkInputRef}
            type="url"
            inputMode="url"
            dir="auto"
            value={linkValue}
            onChange={(event) => setLinkValue(event.target.value)}
            placeholder={t('messages:composer.format.linkPlaceholder')}
            aria-label={t('messages:composer.format.linkField')}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); applyLink(linkValue); }
              else if (event.key === 'Escape') { event.preventDefault(); cancelLink(); }
            }}
          />
          <button type="button" className="messages-format-link-cancel" onMouseDown={(event) => event.preventDefault()} onClick={cancelLink}>{t('messages:composer.format.linkCancel')}</button>
          <button type="button" className="messages-format-link-add" onMouseDown={(event) => event.preventDefault()} onClick={() => applyLink(linkValue)} disabled={!normalizeLinkUrl(linkValue)}>{t('messages:composer.format.linkAdd')}</button>
        </div>
      ) : null}
      {isChannel ? (
        <div className="messages-format-bar" role="toolbar" id={formatBarId} data-open={formatOpen ? '' : undefined} aria-label={t('messages:composer.format.bar')} style={linkOpen ? { display: 'none' } : undefined}>
          {FORMAT_BUTTONS.map(({ kind, label, Icon }) => (
            <button key={kind} type="button" className="messages-format-btn" data-format={kind} onMouseDown={(event) => event.preventDefault()} onClick={() => (kind === 'link' ? openLinkField() : formatSelected(kind))} disabled={dictating} aria-label={t(label)} title={t(label)}>
              <Icon aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
      {/* Said in words, above what is typed, the moment it applies: while
          Homeroom bot works here, Enter and the button keep this as a draft.
          It is not sent, and nothing sends it on its own. */}
      {sendKind === 'save' ? (
        <p className="px-2 pb-1 text-[13px] text-zinc-600 dark:text-zinc-300" data-bot-save-note="">
          <RichMessage id="messages:composer.saveNote" components={[<span className="font-semibold" />]} />
        </p>
      ) : null}
      <div className="messages-composer-row flex items-end gap-1.5" data-stacked={stacked ? '' : undefined}>
        {place.upload ? <input ref={fileRef} id={ids.file} type="file" multiple className="hidden" onChange={(event) => { void addFiles([...(event.target.files || [])]); event.target.value = ''; }} /> : null}
        {/* The "+" holds what this place can add: files where it takes them,
            a shared item in a conversation's own box, the formatting row on
            a phone in a channel. A place that offers none draws no "+". */}
        {addRows ? <div className="messages-composer-add" ref={addRef}>
          <button type="button" className="messages-composer-action" id={ids.attach} onClick={() => setAddOpen((open) => !open)} aria-haspopup="menu" aria-expanded={addOpen} aria-label={t('messages:composer.addToMessage')} title={t('messages:composer.addToMessage')}><PlusIcon aria-hidden="true" /></button>
          {addOpen ? (
            <div className="messages-composer-menu" role="menu" aria-label={t('messages:composer.addToMessage')}>
              {/* The attachment cap disables the ROW, not the whole control:
                  sharing an item is still available with four files queued,
                  which a disabled "+" would have taken away with it. */}
              {place.upload ? (
                <button type="button" role="menuitem" disabled={attachments.length + uploading >= MAX_ATTACHMENTS} onClick={() => { setAddOpen(false); fileRef.current?.click(); }}>
                  <PaperClipIcon aria-hidden="true" />
                  <span>{t('messages:composer.attachFiles')}</span>
                </button>
              ) : null}
              {!shares ? null : (
                <button type="button" role="menuitem" onClick={() => { setAddOpen(false); window.UsernodeReact?.dialogs?.messagesShare?.open(); }}>
                  <ArrowUpTrayIcon aria-hidden="true" />
                  <span>{t('messages:composer.shareItem')}</span>
                </button>
              )}
              {/* Request #7164: a channel's alone, and a phone's alone
                  (app.css hides it from 768px, where the row always shows).
                  A checked row, so the menu says whether the row is open. */}
              {isChannel ? (
                <button type="button" role="menuitemcheckbox" className="messages-composer-menu-format" aria-checked={formatOpen} aria-controls={formatBarId} onMouseDown={(event) => event.preventDefault()} onClick={() => { setAddOpen(false); setFormatOpen((open) => !open); }}>
                  <FormatTextIcon aria-hidden="true" />
                  <span>{t('messages:composer.format.toggle')}</span>
                  {formatOpen ? <CheckIcon aria-hidden="true" className="messages-composer-menu-check" /> : null}
                </button>
              ) : null}
            </div>
          ) : null}
        </div> : null}
        <textarea ref={inputRef} id={ids.input} dir="auto" value={value} onChange={onComposerChange} onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length && place.upload) { event.preventDefault(); void addFiles(files); } }} onKeyDown={(event) => { if (onEmojiKeyDown(event)) return; if (suggestionKeys(event)) return; if (enterSends(event.nativeEvent)) { event.preventDefault(); submit(); } else if (event.key === 'Escape' && reply) place.cancelReply?.(); else if (onFormatKey(event)) return; }} onBlur={() => place.typing?.(false)} onPointerDown={(event) => { lastPointer.current = event.pointerType; }} onContextMenu={onTextareaContextMenu} rows={1} maxLength={8000} placeholder={place.placeholder} aria-label={place.label} aria-autocomplete="list" aria-controls={suggestions.length ? listId : undefined} aria-activedescendant={activeOption >= 0 ? optionId(activeOption) : undefined} className="messages-composer-input" />
        <SpeakButton scope={`messages:${scope}`} getText={() => inputRef.current?.value || ''} onText={updateValue} maxLength={8000} onBusyChange={setDictating} disabled={!!place.speakOff} />
        {/* Task 2148: while Homeroom bot works on the viewer's message here and
            the box is empty, Send's place is Stop (./bot-stop.ts): the same
            disc, a filled square, and its press is the only way to stop.
            With words typed it is Stop and, beside it, "Save draft": words,
            not a round button in Send's place, which read as Send. Enter in
            the box saves then, sends
            otherwise, and never stops; an empty box sends nothing. */}
        {sendKind === 'send' ? (
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={submit} disabled={dictating || !!uploading || (!value.trim() && !attachments.length && !object)} className="messages-send" aria-label={t('messages:composer.send')} title={enterKey ? t('messages:composer.sendShortcut') : undefined}><ArrowUpIcon aria-hidden="true" /></button>
        ) : (
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={stopBot} disabled={stopKind === 'stopping'} className="messages-send messages-send-stop" data-bot-stop={stopKind} aria-label={t(stopKind === 'stopping' ? 'messages:composer.stopping' : 'messages:composer.stop')} title={t(stopKind === 'stopping' ? 'messages:composer.stopping' : 'messages:composer.stop')}><span className="h-3.5 w-3.5 rounded-sm bg-current" aria-hidden="true" /></button>
        )}
        {sendKind === 'save' ? (
          <Button
            type="button"
            data-bot-save-draft=""
            disabled={dictating || !!uploading}
            onMouseDown={(event) => event.preventDefault()}
            onClick={submit}
            variant="unstyled"
            ink="solid"
            disabledStyle="dim"
            // A pill of words. On a phone the row is this box's
            // one 36px line and the field shares it, so the pill is the
            // row's height and its words alone.
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-emerald-600 px-3 text-sm font-semibold hover:bg-emerald-700 md:h-10 md:px-3.5"
            aria-label={t('messages:composer.saveAsDraft')}
            title={enterKey ? t('messages:composer.saveTitleShortcut') : t('messages:composer.saveTitle')}
          >
            <SaveDraftIcon width={18} height={18} className="hidden md:block" aria-hidden="true" />
            <span>{t('messages:composer.saveDraft')}</span>
          </Button>
        ) : null}
      </div>
      {error ? <p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
      {/* What the keys do, said where there is a keyboard and only once the
          text already runs to a second line (typed with Shift + Enter, or
          pasted): the box has grown by then, so the first keystroke still
          does not push the composer up by a line (#4202). A touch device,
          where Enter is a new line already, never draws it. It gives its
          line to the count once the text nears the limit, and it is in the
          count's own muted ink. */}
      {keysHint ? <p className="mt-1 px-3 text-end text-[11px] leading-[15px] text-zinc-500 dark:text-zinc-400" data-enter-hint="">{t('messages:composer.newLineHint')}</p> : null}
      {/* The count's line is not laid out until the text nears the limit
          (`data-near-limit`, app.css): on a phone since #3735, and at every
          width since #4202, so the card stays one row and the first
          keystroke does not push the composer up by a line. */}
      <div className="messages-composer-count mt-1 px-1 flex justify-end h-[15px]" data-near-limit={nearLimit ? '' : undefined} aria-hidden={!value.length}><span className={`text-[10px] leading-[15px] ${nearLimit ? 'text-amber-800 dark:text-amber-300' : 'text-zinc-500 dark:text-zinc-400'}`}>{value.length ? `${value.length}/8000` : ''}</span></div>
      </div>
    </Bar>
  );
}
