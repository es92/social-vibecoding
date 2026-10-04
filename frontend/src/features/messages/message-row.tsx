import { memo, useRef, useState } from 'react';

import {
  BookmarkIcon, BookmarkSolidIcon, CopyIcon, DraftTrashIcon, EnvelopeIcon, FlagIcon, LinkIcon, NoSymbolIcon,
  PencilSquareIcon, ReplyArrowIcon, ThreadIcon,
} from '@/components/ui/icons';

import { openReport } from '../dialogs/report';
import {
  deleteMessage, discardFailed, edit, markUnread, messageAddress, openThread, react, retrySend, scopeKey, setReply,
  setUserBlocked, toggleSaved,
} from './store';
import type { ConversationKind, ConversationMessage } from './types';
import { fileSize, fullTime, MessageMarkdown, ObjectCard, UserAvatar, senderName } from './format';
import { BotActivityCard, isActivityMessage } from './bot-activity';
import { BotQuestion, botMeta } from './bot-question';
import { BotPlanCard, BotTwoQuestions, isPlanMessage, isTwoQuestions } from './bot-plan';
import { BotReadyCard, isReadyMessage } from './bot-ready';
import { LinkEmbeds } from './link-cards';
import { plainText } from './plain-text';
import { confirmAction } from '../../lib/confirm';
import { useAutoGrow } from '../../lib/use-auto-grow';
import { messageStamp, timeOfDay } from '../../lib/timestamp';
import { MessageActionBar, MessageMenu, placementFor, type MenuItem } from '../message-actions/action-bar';
import { MessageActionSheet, useLongPress } from '../message-actions/action-sheet';
import { absoluteLink, copyToClipboard, toast } from '../message-actions/clipboard';
import { EmojiPicker } from '../message-actions/emoji-picker';
import { ImageViewer, openInViewer } from '../image-viewer/image-viewer';
import { rememberReaction, useRecentReactions } from '../message-actions/recents';
import { ThreadSummaryChip } from '../message-actions/thread-summary';
import { useDismiss } from '../message-actions/use-dismiss';

/*
 * ONE SHAPE, DISCORD'S (#2783). Every chat — a DM, a group, #general and an
 * app's channel — draws its messages as named rows: square avatar, bold name,
 * muted time, flat text. A DM used to be a bubble transcript, on the reading
 * that with two participants the side says who is speaking; it no longer is,
 * so a conversation reads the same whichever list it came from.
 *
 * CONSECUTIVE MESSAGES GROUP. A message from the same person, close behind
 * their previous one (`groupsWithPrevious`, @/components/ui/chat.tsx — the app
 * chat uses the same rule), drops its avatar and name and becomes a
 * continuation line, with its time in the gutter where the avatar would be.
 *
 * THE CONTROLS ARE ONE BAR (#2387): ../message-actions/action-bar.tsx — the
 * three recent reactions, the picker, Reply, Save and ⋯ — on hover with a
 * pointer, and the same acts in a sheet on a long press on a phone. ⋯ holds
 * the rarer ones: the thread, edit, copy, the link, mark unread, delete,
 * report and block. Report message opens the shared reporting dialog
 * (../dialogs/report.tsx), which feeds the platform's one moderation queue
 * rather than an inline form of its own (issue #2721).
 */

function Attachment({ attachment }: { attachment: ConversationMessage['attachments'][number] }) {
  const image = attachment.contentType.startsWith('image/');
  const html = attachment.contentType === 'text/html' || /\.html?$/i.test(attachment.name);
  // #3286: a plain tap opens the picture in the app's own viewer, which has
  // a way out (../image-viewer/image-viewer.tsx).
  const [viewing, setViewing] = useState(false);
  return (
    <div className="messages-attachment">
      {image ? <a href={attachment.url} target="_blank" rel="noopener noreferrer" data-image-open="" onClick={(event) => openInViewer(event, () => setViewing(true))}><img src={attachment.url} alt={attachment.name} loading="lazy" /></a> : <span className="messages-file-icon" aria-hidden="true">{html ? '</>' : '↓'}</span>}
      {viewing ? <ImageViewer src={attachment.url} alt={attachment.name} onClose={() => setViewing(false)} /> : null}
      <div className="min-w-0 flex-1"><a className="font-medium truncate block" href={attachment.url} download>{attachment.name}</a><span>{fileSize(attachment.size)}</span></div>
      {html && attachment.viewUrl ? <a className="messages-attachment-view" href={attachment.viewUrl} target="_blank" rel="noopener noreferrer">Preview</a> : null}
    </div>
  );
}

/*
 * MEMOIZED. The Messages store publishes one snapshot for everything, so any
 * publish — the inbox reloading, someone else's typing ping — re-rendered the
 * open transcript and every row in it. A row's inputs are its props: the
 * message objects keep their identity across publishes that do not touch the
 * transcript, and the channel set is shared (store.ts `handleSetFor`), so a
 * row whose message did not change skips the render.
 */
export const MessageRow = memo(function MessageRow({
  message,
  conversationId,
  grouped = false,
  channels,
  kind = 'group',
  inThread = false,
  threadOpen = false,
  focused = false,
}: {
  message: ConversationMessage;
  conversationId: number;
  /** A continuation of the same person's previous message. */
  grouped?: boolean;
  /** The viewer's channel handles, so `#name` in the body links (#2783). */
  channels?: ReadonlySet<string>;
  /** The conversation's kind: a DM has no threads (#2387). */
  kind?: ConversationKind;
  /** Drawn inside a reply thread — no thread of its own, no "mark unread". */
  inThread?: boolean;
  /** The thread that hangs off this message is the one open beside it. */
  threadOpen?: boolean;
  /** The message a link pointed at — flashed once (#2387). */
  focused?: boolean;
}) {
  const mine = Number(typeof window !== 'undefined' ? window.App?.user?.id : 0) === message.sender.id;
  const [picker, setPicker] = useState<'above' | 'below' | null>(null);
  const [menu, setMenu] = useState<'above' | 'below' | null>(null);
  const [sheet, setSheet] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.content);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const bar = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const recents = useRecentReactions();
  // #1408: the edit box grows with the message being edited, same as the
  // composer it visually replaces.
  const editRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(editRef, editValue);

  const live = !message.deleted && !message.pending && !message.failed && message.id > 0;
  const canThread = live && !inThread && kind !== 'direct';
  const scope = scopeKey(conversationId, inThread ? message.threadRootId : null);
  useDismiss(!!(picker || menu), [bar], () => { setPicker(null); setMenu(null); });
  const longPress = useLongPress(() => setSheet(true), { disabled: !live || editing });

  async function saveEdit() {
    const content = editValue.trim();
    if (!content || content === message.content) { setEditing(false); return; }
    setBusy(true); setNotice('');
    try { await edit(message.id, content); setEditing(false); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Your edit wasn’t saved.'); }
    finally { setBusy(false); }
  }

  const reacted = (emoji: string) => message.reactions.some((reaction) => reaction.emoji === emoji && reaction.reacted);

  async function toggle(emoji: string) {
    setPicker(null); setNotice('');
    try { await react(message.id, emoji); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Couldn’t update the reaction.'); }
  }

  // A pick from the full picker ADDS the reaction (and makes it recent); it
  // never takes one away, which is what the pill under the message is for.
  function pick(emoji: string) {
    rememberReaction(emoji);
    setPicker(null);
    if (!reacted(emoji)) void toggle(emoji);
  }

  async function save() {
    setNotice('');
    try { await toggleSaved(message.id); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Couldn’t update your saved messages.'); }
  }

  async function blockSender() {
    if (mine || !message.sender.id) return;
    // QA 2026-09-24 Q15: the app's confirm dialog, not window.confirm().
    const ok = await confirmAction({
      title: `Block ${senderName(message.sender)}?`,
      message: 'Their messages in shared chats and app discussions will be hidden, and they won’t be able to message you directly.',
      confirmLabel: 'Block',
      danger: true,
    });
    if (!ok) return;
    setBusy(true); setNotice('');
    try { await setUserBlocked(message.sender.id, true); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Couldn’t block this person.'); }
    finally { setBusy(false); }
  }

  async function remove() {
    const ok = await confirmAction({
      title: 'Delete this message?',
      message: 'Everyone will see “Message deleted” in its place. This can’t be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    setNotice('');
    try { await deleteMessage(message.id); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Couldn’t delete this message.'); }
  }

  async function unread() {
    setNotice('');
    try { await markUnread(message.id); toast('Marked unread'); }
    catch (err) { setNotice(err instanceof Error ? err.message : 'Couldn’t mark this unread.'); }
  }

  function startEdit() { setEditValue(message.content); setEditing(true); }

  // The ⋯ menu, by whose message it is and what kind of chat it sits in.
  const items: MenuItem[] = [];
  if (canThread) {
    items.push({ key: 'thread', label: message.thread ? 'View thread' : 'Reply in thread', icon: ThreadIcon, onSelect: () => openThread(message.id) });
  }
  if (mine && message.content && live) items.push({ key: 'edit', label: 'Edit message', icon: PencilSquareIcon, onSelect: startEdit });
  if (message.content) {
    items.push({ key: 'copy', label: 'Copy text', icon: CopyIcon, onSelect: () => { void copyToClipboard(message.content, 'Message text copied'); } });
  }
  items.push({
    key: 'link', label: 'Copy link to message', icon: LinkIcon,
    onSelect: () => { void copyToClipboard(absoluteLink(messageAddress(conversationId, message.id)), 'Link copied'); },
  });
  if (!mine && !inThread) items.push({ key: 'unread', label: 'Mark unread', icon: EnvelopeIcon, onSelect: () => { void unread(); } });
  if (mine) {
    items.push({ key: 'delete', label: 'Delete message', icon: DraftTrashIcon, danger: true, separated: true, onSelect: () => { void remove(); } });
  } else {
    items.push({
      key: 'report', label: 'Report message', icon: FlagIcon, separated: true,
      onSelect: () => openReport({ targetType: 'conversation_message', target: message.id, label: `Message from ${senderName(message.sender)}`, userId: message.sender.id }),
    });
    if (message.sender.id) {
      items.push({ key: 'block', label: `Block ${senderName(message.sender)}`, icon: NoSymbolIcon, danger: true, disabled: busy, onSelect: () => { void blockSender(); } });
    }
  }

  // The phone's sheet: the bar's Reply and Save first, then the same menu.
  const sheetItems: MenuItem[] = [
    { key: 'reply', label: 'Reply', icon: ReplyArrowIcon, onSelect: () => setReply(scope, message) },
    { key: 'save', label: message.saved ? 'Unsave' : 'Save', icon: message.saved ? BookmarkSolidIcon : BookmarkIcon, onSelect: () => { void save(); } },
    ...items,
  ];

  // The time of day for today's messages, prefixed with the date once it is
  // not today's (#1808). `fullTime` on the title never elides.
  const time = messageStamp(message.createdAt, { hour: 'numeric' }).text;
  // The gutter's clock on a continuation line: the time of day alone, since
  // the header above it already said which day.
  const shortTime = timeOfDay(message.createdAt);

  // The words, as markdown. A Homeroom bot message about a request names its
  // project, so its `#N` chips open that project's requests (#3770).
  const words = message.content
    ? <MessageMarkdown content={message.content} channels={channels} appSlug={botMeta(message)?.appSlug} />
    : null;

  // The quoted reply, the body and the inline editor: the part of the
  // message that stands as the row's text. A deleted message says so in its
  // place and nothing else (#2387).
  const body = message.deleted ? (
    <p className="messages-deleted">Message deleted</p>
  ) : (
    <>
      {message.reply ? <button type="button" className="messages-quote" onClick={() => document.getElementById(`messages-message-${message.reply?.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}><span>{senderName(message.reply.sender)}</span><p>{message.reply.deleted ? 'Message deleted' : plainText(message.reply.content) || 'Attachment'}</p></button> : null}
      {editing ? (
        <div className="messages-edit"><textarea ref={editRef} aria-label="Edit message" value={editValue} onChange={(event) => setEditValue(event.target.value.slice(0, 8000))} rows={2} maxLength={8000} autoFocus onKeyDown={(event) => { if (event.key === 'Escape') setEditing(false); if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void saveEdit(); } }} /><div><button type="button" disabled={busy} onClick={() => void saveEdit()}>Save</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></div></div>
      ) : isActivityMessage(message) ? (
        // #3736: the bot's activity card stands in place of its words, which
        // say the same for the inbox preview and the bell (./bot-activity.tsx).
        // #3770: a card with nothing on record keeps its words.
        <>
          {/* B5: the bot's hello leads the first card it sends somebody. */}
          {message.metadata?.homeroomBot?.hello ? <p className="messages-bot-hello">{message.metadata.homeroomBot.hello}</p> : null}
          <BotActivityCard message={message} words={words} />
        </>
      ) : isPlanMessage(message) ? (
        // B6: a first version's plan, and two questions at once, stand in
        // place of their words too (./bot-plan.tsx).
        <BotPlanCard message={message} conversationId={conversationId} />
      ) : isTwoQuestions(message) ? (
        <BotTwoQuestions message={message} conversationId={conversationId} />
      ) : isReadyMessage(message) ? (
        // B7: a change ready to try, with Try it, Approve and Change something.
        <BotReadyCard message={message} conversationId={conversationId} />
      ) : words}
    </>
  );

  // Everything a message carries besides its text: files, shared items,
  // reactions, the thread under it and the status line.
  const extras = (
    <>
      {message.sender.bot && (message.metadata?.homeroomBot?.question || message.metadata?.homeroomBot?.actions?.length)
        && !isTwoQuestions(message) && !isReadyMessage(message)
        ? <BotQuestion message={message} conversationId={conversationId} /> : null}
      {message.attachments.length ? <div className="messages-attachments">{message.attachments.map((attachment) => <Attachment key={attachment.id} attachment={attachment} />)}</div> : null}
      {message.objects.length ? <div className="messages-object-list">{message.objects.map((object, index) => <ObjectCard key={`${object.type}-${index}`} object={object} />)}</div> : null}
      {/* #3660: a link in the words to one of Homeroom's own pages, as the
          card it names — for this reader, and never one already above. */}
      {message.content && !message.moderated ? <LinkEmbeds text={message.content} exclude={message.objects} /> : null}
      {message.reactions.length ? <div className="messages-reactions">{message.reactions.map((reaction) => <button type="button" key={reaction.emoji} aria-pressed={reaction.reacted} title={reaction.users?.join(', ')} onClick={() => void toggle(reaction.emoji)} className={reaction.reacted ? 'messages-reaction-mine' : ''}><span>{reaction.emoji}</span><span>{reaction.count}</span></button>)}</div> : null}
      {message.thread && !inThread ? (
        <ThreadSummaryChip
          replyCount={message.thread.replyCount}
          lastReplyAt={message.thread.lastReplyAt}
          active={threadOpen}
          avatars={message.thread.participants.map((person) => <UserAvatar key={person.id} user={person} size="sm" shape="square" />)}
          lastReply={message.thread.lastReply ? {
            face: <span className="msgx-thread-face"><UserAvatar user={message.thread.lastReply.sender} size="sm" shape="square" /></span>,
            name: message.thread.lastReply.sender.username,
            text: message.thread.lastReply.content,
          } : null}
          onOpen={() => openThread(message.id)}
        />
      ) : null}
      {notice ? <p role="status" className="mt-1 text-sm text-red-700 dark:text-red-400">{notice}</p> : null}
    </>
  );

  // The bar. WHILE A SEND IS IN FLIGHT it is still laid out, but invisible
  // and inert (#2907). A failed row has no bar — its Retry is its control —
  // and neither has a deleted one.
  const actions = !message.failed && !message.deleted ? (
    <MessageActionBar
      className={`messages-message-actions ${message.pending ? 'messages-message-actions-reserved' : ''}`}
      hidden={!!message.pending}
      // What useDismiss measures "outside" against: without it every press —
      // on a menu item or an emoji too — closed the popover before its click.
      barRef={bar}
      recents={recents}
      reacted={reacted}
      onReact={(emoji) => { void toggle(emoji); }}
      pickerOpen={!!picker}
      pickerButtonRef={pickerButton}
      onTogglePicker={() => { setMenu(null); setPicker((open) => (open ? null : placementFor(pickerButton.current, 430))); }}
      onReply={() => setReply(scope, message)}
      saved={!!message.saved}
      onToggleSave={() => { void save(); }}
      moreOpen={!!menu}
      moreButtonRef={moreButton}
      onToggleMore={() => { setPicker(null); setMenu((open) => (open ? null : placementFor(moreButton.current, items.length * 38 + 24))); }}
    >
      {picker ? <EmojiPicker placement={picker} onPick={pick} onClose={() => setPicker(null)} /> : null}
      {menu ? <MessageMenu items={items} placement={menu} onClose={() => { setMenu(null); moreButton.current?.focus({ preventScroll: true }); }} /> : null}
    </MessageActionBar>
  ) : null;

  const stateClasses = `${mine ? 'messages-message-self' : ''} ${message.saved ? 'messages-message-saved' : ''} ${message.pending ? 'messages-message-pending' : ''} ${message.failed ? 'messages-message-failed' : ''} ${message.deleted ? 'messages-message-deleted' : ''} ${focused ? 'messages-message-focus' : ''} ${message.system ? 'messages-message-system' : ''}`;

  // The state word a header carries — edited. A continuation line has no
  // header, so it carries it on a meta line of its own, beside nothing: the
  // time is already in the gutter.
  //
  // NO "sending…" (#2907). A message in flight says so by being faded
  // (app.css), which changes no line's height; the word came and went in a
  // line of its own on a continuation row and moved the transcript twice.
  const status = message.editedAt && !message.deleted ? <span title={fullTime(message.editedAt)}>edited</span> : null;

  // A send that failed says so under its text, with the two things to do
  // about it: send it again (the same idempotency key, so never twice) or
  // drop it. Its own line, not the header's: three more words beside the
  // name and time wrapped the header on a phone.
  const failedNote = message.failed ? <div className="messages-message-meta messages-message-failed-note" role="status">
    <span className="text-red-700 dark:text-red-400">Not sent</span>
    {message.clientKey ? <button type="button" className="messages-retry" onClick={() => void retrySend(message.clientKey as string)}>Retry</button> : null}
    {message.clientKey ? <button type="button" className="messages-discard" onClick={() => discardFailed(message.clientKey as string)}>Discard</button> : null}
  </div> : null;

  return (
    <article id={`messages-message-${message.id}`} data-message-id={message.id} className={`messages-message group ${grouped ? 'messages-message-grouped' : ''} ${stateClasses}`} {...longPress}>
      {grouped
        ? <time className="messages-message-gutter" dateTime={message.createdAt} title={fullTime(message.createdAt)}>{shortTime}</time>
        : <UserAvatar user={message.sender} size="md" shape="square" />}
      <div className="min-w-0 flex-1">
        {grouped ? null : <div className="messages-message-head"><span className={`messages-message-author ${mine ? 'text-violet-700 dark:text-violet-300' : ''}`}>{senderName(message.sender)}</span>{message.sender.bot ? <span className="messages-bot-badge">AI</span> : null}<time dateTime={message.createdAt} title={fullTime(message.createdAt)}>{time}</time>{status}</div>}
        {body}
        {extras}
        {grouped && message.editedAt && !message.deleted ? <div className="messages-message-meta">{status}</div> : null}
        {failedNote}
      </div>
      {actions}
      <MessageActionSheet
        open={sheet}
        onClose={() => setSheet(false)}
        recents={recents}
        reacted={reacted}
        onReact={(emoji) => { void toggle(emoji); }}
        onPick={pick}
        items={sheetItems}
        preview={{ who: senderName(message.sender), text: message.content }}
      />
    </article>
  );
});
