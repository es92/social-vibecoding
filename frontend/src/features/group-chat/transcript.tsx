import { openReport } from '../dialogs/report';
/**
 * `#gc-messages` — the group chat transcript, as the only React writer below
 * that host.
 *
 * This is the deck's NAMED-ROW transcript (its "Recipe App · 2 members"
 * screen): a square avatar, a bold name at reading size, a time, and flat
 * content. It is built from @/components/ui/chat.tsx, which is what that
 * module was written for — the bubble transcript in the same file belongs to
 * the agent chat, and the two are different shapes on purpose.
 *
 * ── What React owns, and what it deliberately does not ────────────────
 *
 * React owns every row: the shell, the header, the body, the quote block and
 * the reactions — all of which are DATA on the message, so all of which
 * reconcile. That is the point of the conversion: a reaction toggle used to
 * rebuild one row's `innerHTML`, an edit used to rebuild another's, and a
 * bookmark toggle swapped an icon element in place. All three are store
 * updates now.
 *
 * ONE thing stays a module-filled host, per the controller-host seam in
 * AGENTS.md: `[data-gc-vote-controls]`, the inline vote buttons on a vote row.
 * Its markup is `AppView.voteButtonsHtml` + `voteCountPill` + the merge
 * badges — the Dev screen's own vote renderers, sixteen call sites of them in
 * public/js/app-view.js — re-filled in place by `refreshVoteControls()` from
 * `AppView.voteState`, which arrives on its own schedule. So it is not
 * independently convertible: its ownership boundary is the Dev screen, not
 * this transcript. It is rendered ONCE as an empty host with a constant
 * `className`, so React never writes an attribute the module has since
 * changed — the same rule the dialog islands run under (see
 * ../../lib/legacy-dom.ts).
 *
 * `[data-gc-spec-share]` used to be the second one, and it was never filled by
 * anything — see SpecShareRow below.
 *
 * ── The inline editor is the third, and it is a different shape ───────
 *
 * `GroupChat._startEdit` puts a `.gc-edit` block into a row: it INSERTS a
 * sibling after `.gc-msg-content` and hides that node with an inline
 * `display:none`. It does not write any node React renders — React manages
 * this row's `className` and its body's `dangerouslySetInnerHTML`, neither of
 * which the editor touches, and an unknown sibling plus an inline style are
 * both things the reconciler leaves alone. The row's key is `m<id>`, so the
 * element itself survives every repaint the editor could overlap with.
 *
 * That is why it stays where it is. What did NOT stay is anything that wrote
 * a node React owns: the save button's icon and attributes, and the two
 * `.gc-msg-content.innerHTML` assignments the edit paths used, all of which
 * are store patches now (`_paintBookmark`, `_patchBody` in group-chat.js).
 * The `innerHTML` ones were not merely redundant — `Body` memoises on the
 * string, so React kept believing the old content and repainted the row from
 * it the next time anything else about the message changed.
 */

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { ChatMessageRow, groupsWithPrevious } from '@/components/ui/chat';
import { Avatar, ReactionPill } from '@/components/ui/feed';
import {
  BookmarkIcon, BookmarkSolidIcon, ChatIcon, CopyIcon, DraftTrashIcon, EnvelopeIcon, FlagIcon, LinkIcon, NoSymbolIcon,
  PencilSquareIcon, ReplyArrowIcon, ThreadIcon,
} from '@/components/ui/icons';

import { confirmAction } from '../../lib/confirm';
import { timeOfDay } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { PostedViaChip } from './posted-via-chip';
import { BotRequestCardView, BotStatusChip } from './bot-request';
import { ImageViewer, openInViewer } from '../image-viewer/image-viewer';
import { EventRow } from './proposal-event';
import { QuietCard } from './quiet-card';
import { swatchFor } from './swatch';
import { LinkEmbeds } from '../messages/link-cards';
import { setUserBlocked } from '../messages/store';
import { MessageActionBar, MessageMenu, placementFor, type MenuItem } from '../message-actions/action-bar';
import { MessageActionSheet, useLongPress } from '../message-actions/action-sheet';
import { absoluteLink, copyToClipboard, toast } from '../message-actions/clipboard';
import { EmojiPicker } from '../message-actions/emoji-picker';
import { rememberReaction, useRecentReactions } from '../message-actions/recents';
import { ThreadActivityCard } from '../message-actions/thread-activity';
import { ThreadSummaryChip } from '../message-actions/thread-summary';
import { useDismiss } from '../message-actions/use-dismiss';
import {
  transcriptStore,
  type Attachment,
  type Quote,
  type TranscriptMessage,
  type TranscriptView,
} from './transcript-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).GroupChat : null) || null;
}

/**
 * The sanitized markdown the module produced.
 *
 * Memoised on the STRING, so the `{__html}` wrapper keeps its identity across
 * re-renders. React diffs host props by reference and re-assigns `innerHTML`
 * whenever that object is new — even for an identical string — which on a long
 * transcript means every row's body is rewritten on every reaction. The Dev
 * board hit exactly this and its note is in features/dev-board/board-frame.tsx.
 */
function Body({ html }: { html: string }) {
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  return <div className="gc-msg-content" dangerouslySetInnerHTML={wrapper} />;
}

/**
 * The quoted reply above a message (#15).
 *
 * ── Why this is not a widget primitive ────────────────────────────────
 *
 * It was, briefly, and that is what went wrong: the conversion reached for
 * `ThreadReplySummary`, the language's "N replies" control for a thread, so a
 * quoted reply rendered "1 reply alice" — no icon, no snippet, and the wrong
 * sentence. `.gc-quoted` is restored here, class for class.
 *
 * It stays on app.css for now, beside `.gc-reply-preview-inner`, the
 * composer's staged-reply strip. The two open with the same accent border and
 * author line; since #2391 the strip is sized for the composer (the Messages
 * screen's reply draft) while this block keeps its compact in-transcript
 * form. Both convert together when the composer does.
 *
 * ── The attributes are the handler's ──────────────────────────────────
 *
 * No `onClick`. `_attachQuoteHandlers` binds one listener on the messages
 * container, checks `.gc-quoted` BEFORE its "real links and buttons win" rule,
 * and dispatches on `data-quote-source`: a PR opens `data-quote-href` in a new
 * tab, anything else scrolls to `data-quote-ref` and flashes it. Those three
 * attributes and the class are the whole contract.
 */
function QuoteBlock({ quote }: { quote: Quote }) {
  return (
    <div
      className="gc-quoted"
      data-quote-source={quote.source}
      {...(quote.source === 'pr'
        ? { 'data-quote-href': quote.href || '' }
        : { 'data-quote-ref': quote.targetId ?? '' })}
    >
      <span className="gc-quoted-author">{`${quote.icon} ${quote.username}`}</span>
      <span className="gc-quoted-snippet">{quote.excerpt}</span>
    </div>
  );
}

/**
 * The files on a message.
 *
 * Four shapes, exactly as the string renderer this replaces drew them: an
 * image is an inline thumbnail wrapped in a link to full size; a markdown
 * file is a chip whose name opens the spec side panel; an HTML file is a chip
 * with a sandboxed Preview beside its download; anything else is one download
 * chip. It is rendered outside the message body because DOMPurify strips
 * `<img>` out of untrusted markdown and must keep doing so — these elements
 * point only at the app-gated attachment routes the module resolved.
 *
 * ── Two seams stay the module's ───────────────────────────────────────
 *
 * The markdown chip keeps `data-att-md` / `data-att-name` and NO onClick:
 * `_ensureAttachClickHandler` binds one capture-phase listener on the
 * document, and the capture plus `stopPropagation()` is what keeps the same
 * click from also staging a tap-to-quote. Per-row handlers would not have
 * that ordering.
 *
 * And `_quoteFromRow` reads `.dc-msg-attachments .dc-attach-name` (falling
 * back to an `img`'s `alt`) to caption a reply to a file-only message, so
 * those two hooks are a contract, not decoration.
 */
function AttachmentBadge({ badge }: { badge: string | null }) {
  return badge ? <span className="dc-attach-kind">{badge}</span> : null;
}

function AttachmentImage({ att }: { att: Attachment }) {
  // A staging clone copies chat_messages but not attachment bytes
  // (staging:private), so a thumbnail whose blob is gone degrades to a plain
  // chip rather than a broken-image icon. The module used to rewrite the
  // anchor in place; this is the same anchor, drawn the other way.
  const [broken, setBroken] = useState(false);
  // #3286: a plain tap opens the picture in the app's own viewer, which has
  // a way out; the link is still the file for a new tab on purpose.
  const [viewing, setViewing] = useState(false);
  if (broken) {
    return (
      <a href={att.url} target="_blank" rel="noopener" className="dc-msg-att-chip">
        {`🖼 ${att.name}`}
      </a>
    );
  }
  return (
    <>
      <a
        href={att.url}
        target="_blank"
        rel="noopener"
        title={`${att.name}: open full size`}
        data-image-open=""
        onClick={(event) => openInViewer(event, () => setViewing(true))}
      >
        <img
          className="dc-msg-att-img"
          src={att.url}
          alt={att.name}
          loading="lazy"
          onError={() => setBroken(true)}
        />
      </a>
      {viewing ? <ImageViewer src={att.url} alt={att.name} onClose={() => setViewing(false)} /> : null}
    </>
  );
}

function AttachmentChip({ att }: { att: Attachment }) {
  const size = <span className="dc-attach-size">{att.size}</span>;
  const download = (
    <a
      className="gc-att-action"
      href={att.url}
      download={att.name}
      title={`Download ${att.name}`}
      aria-label={`Download ${att.name}`}
    >
      <span aria-hidden="true">↓</span>
    </a>
  );
  if (att.kind === 'markdown') {
    return (
      <span className="dc-msg-att-chip">
        <AttachmentBadge badge={att.badge} />
        <button
          type="button"
          className="dc-attach-name gc-att-open"
          data-att-md={att.url}
          data-att-name={att.name}
          title={`View ${att.name}`}
        >
          {att.name}
        </button>
        {size}
        {download}
      </span>
    );
  }
  if (att.kind === 'html') {
    return (
      <span className="dc-msg-att-chip">
        <AttachmentBadge badge={att.badge} />
        <span className="dc-attach-name">{att.name}</span>
        {size}
        <a
          className="gc-att-action"
          href={`${att.url}/view`}
          target="_blank"
          rel="noopener"
          title={`Open sandboxed preview of ${att.name}`}
        >
          Preview
        </a>
        {download}
      </span>
    );
  }
  return (
    <a
      className="dc-msg-att-chip"
      href={att.url}
      download={att.name}
      title={`Download ${att.name}`}
    >
      <AttachmentBadge badge={att.badge} />
      <span className="dc-attach-name">{att.name}</span>
      {size}
    </a>
  );
}

export function Attachments({ items }: { items: Attachment[] }) {
  if (!items.length) return null;
  return (
    <div className="dc-msg-attachments">
      {items.map((att) => (att.kind === 'image'
        ? <AttachmentImage key={att.id} att={att} />
        : <AttachmentChip key={att.id} att={att} />))}
    </div>
  );
}

/**
 * The pills under a message, and the one control here that is NOT delegated.
 *
 * The three header controls below have no `onClick` on purpose — group-chat.js
 * dispatches them off one listener on the container, and delegation does not
 * care which renderer made the node. A pill cannot go through that listener,
 * because the class it dispatched on (`.gc-react-pill`) is gone: the reskin
 * draws these with @/components/ui/feed's `ReactionPill`, whose classes come
 * from the widget language. So the click is a prop, and it calls the module's
 * own `sendReact` — the same fire-and-forget over the chat socket the
 * delegated branch called, with the server's aggregate coming back as a
 * `reaction` frame and landing through `patchTranscriptMessage`.
 *
 * "Yours" is `tone="accent"` on the primitive — the widget language's own
 * spelling of the state. It used to be `.gc-react-mine` in app.css, an accent
 * border over the pill's surface; against the reskinned pill that rule drew
 * nothing at all (Tailwind's ground wins the cascade, and preflight zeroes
 * the border width), so the affordance had quietly gone missing.
 */
export function Reactions({ msg }: { msg: TranscriptMessage }) {
  if (!msg.reactions.length && !msg.botRequest) return <div className="gc-reactions" id={`gc-react-${msg.id ?? ''}`} />;
  return (
    <div className="gc-reactions" id={`gc-react-${msg.id ?? ''}`}>
      {/* B9: a request asked of Homeroom bot here, first and in its own colour (./bot-request.tsx). */}
      {msg.botRequest ? (
        <BotStatusChip
          chip={msg.botRequest}
          mine={msg.mine}
          onTry={(sessionId) => controller()?.tryBotChange?.(sessionId)}
          onProgress={() => controller()?.openBotChat?.()}
        />
      ) : null}
      {msg.reactions.map((r) => (
        <ReactionPill
          key={r.emoji}
          emoji={r.emoji}
          count={r.count}
          tone={r.mine ? 'accent' : 'neutral'}
          title={r.users.join(', ')}
          data-emoji={r.emoji}
          onClick={() => controller()?.sendReact?.(msg.id, r.emoji)}
        />
      ))}
    </div>
  );
}

/**
 * The row's three header controls: edit, save, react.
 *
 * NO onClick. group-chat.js binds ONE delegated `click` listener to the
 * messages container and dispatches on `closest('.gc-msg-save')` and friends —
 * delegation does not care which renderer made the node, so the module's
 * existing handlers catch these the moment they exist. Wiring them here would
 * be a second handler for the same click.
 *
 * `tabindex={-1}` on edit and react is the legacy behaviour and deliberate:
 * both are hover affordances with a long-press equivalent on touch, and
 * putting them in the tab order would mean two extra stops per message.
 * Save is NOT one of those — it is the row's only keyboard-reachable control
 * and carries `aria-pressed`, which is how its state is announced.
 *
 * These three were dropped when the transcript became React: the store
 * modelled `bookmarked` and `canEdit` and the component rendered neither, so
 * every message in the group chat quietly lost all three. Found by seeding a
 * chat and counting the buttons, not by a test.
 */
function RowActions({ msg }: { msg: TranscriptMessage }) {
  if (!(msg.showEdit || msg.showBookmark || msg.showReact)) return null;
  const saved = msg.bookmarked;
  return (
    <>
      {msg.showEdit ? (
        <button type="button" className="gc-msg-edit" title="Edit" aria-label="Edit message" tabIndex={-1}>
          {'\u270F\uFE0F'}
        </button>
      ) : null}
      {msg.showBookmark ? (
        <button
          type="button"
          className={saved ? 'gc-msg-save gc-msg-saved' : 'gc-msg-save'}
          title={saved ? 'Saved. Click to unsave' : 'Save to your notifications'}
          aria-label={saved ? 'Unsave message' : 'Save message'}
          aria-pressed={saved}
        >
          {/* Solid when saved, outline when not — the state lives in the SHAPE,
              which is legible at 12px and in a screenshot. Not one path with
              its fill flipped; see the note in @/components/ui/icons.tsx. */}
          {saved ? <BookmarkSolidIcon /> : <BookmarkIcon strokeWidth="1.5" />}
        </button>
      ) : null}
      {msg.showReact ? (
        <button type="button" className="gc-react-add" title="React" aria-label="Add reaction" tabIndex={-1}>
          {'\u{1F642}'}
        </button>
      ) : null}
    </>
  );
}

/**
 * Consecutive system lines that say the same thing fold into one, with a
 * count: a merge gate that re-runs on every check posts "PR #N reached the
 * vote threshold but has 1 test failing…" each time, and eight copies of
 * one sentence were the longest thing on a topic page. The last copy is
 * the one kept, so a reaction or a save lands on the newest. Vote rows and
 * people's messages never fold.
 */
export function foldRepeats(messages: TranscriptMessage[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let run = 0;
  for (const m of messages) {
    const prev = out[out.length - 1];
    const foldable = m.kind === 'system' && !!m.systemText;
    if (foldable && prev && prev.kind === 'system' && prev.systemText === m.systemText) {
      run += 1;
      out[out.length - 1] = { ...m, repeat: run + 1 };
    } else {
      run = 0;
      out.push(m);
    }
  }
  return out;
}

/**
 * A system or vote row — one line of text, plus whatever the module fills in.
 * The topic threads' form; the general chat draws its two proposal events as
 * ./proposal-event.tsx's row instead, and nothing else of this kind.
 */
export const SystemRow = memo(function SystemRow({ msg }: { msg: TranscriptMessage }) {
  return (
    <div
      className={`gc-msg-system ${msg.kind === 'vote' ? 'gc-msg-vote' : ''}${msg.voteRowClass ? ` ${msg.voteRowClass}` : ''}${msg.flash ? ' gc-msg-flash' : ''}`}
      data-msg-id={msg.id ?? ''}
    >
      <span className="gc-msg-system-text">{msg.systemText}</span>
      {msg.repeat && msg.repeat > 1 ? (
        <span className="gc-msg-system-repeat" title={`Posted ${msg.repeat} times in a row; this is the latest`}>{` · ×${msg.repeat}`}</span>
      ) : null}
      {/*
          The controls host, rendered once as an empty span with a constant
          className and never looked inside — the controller-host seam. The
          three attributes are the contract with `GroupChat.refreshVoteControls`:
          it selects on `[data-vote-controls]` and resolves the pair beside it
          against `AppView.voteState`. This span used to carry
          `data-gc-vote-controls` and nothing else, which matched that selector
          not at all, so the Yes/No pair and the tally pill were missing from
          every vote row.
      */}
      {msg.kind === 'vote' && msg.voteRef ? (
        <span
          className="gc-vote-inline"
          data-vote-controls=""
          data-session-id={msg.voteRef.sessionId}
          data-pr-number={msg.voteRef.prNumber}
        />
      ) : null}
      {/*
          A system or vote row is savable and reactable, exactly as the string
          template had it — the same two buttons, in the same place, before the
          reaction pills. Not editable: `showEdit` is false for every row whose
          kind is not `message`, which is how the legacy branch expressed it
          (it simply never called the edit builder here).
      */}
      <RowActions msg={msg} />
      <Reactions msg={msg} />
    </div>
  );
});

/**
 * A shared spec, as a card in the transcript.
 *
 * ── It had stopped rendering ──────────────────────────────────────────
 *
 * This host — `[data-gc-spec-share]` — was emitted empty for group-chat.js to
 * fill, exactly like the vote controls below it. Nothing filled it: the card's
 * only renderer lived in `GroupChat.renderMessageHtml`, which the transcript
 * conversion left with no callers, so a shared spec has been an invisible
 * empty div in the chat ever since. Found by publishing a spec_share row into
 * a running transcript and counting what came out.
 *
 * ── The button owns its own in-flight state ───────────────────────────
 *
 * "View full spec" used to be reached by a click delegate on the messages
 * container, which wrote `disabled` and `textContent` back onto it. Those two
 * writes are exactly what a React-owned row must not receive from outside, so
 * `GroupChat.openSharedSpec` returns a promise and this brackets it. The
 * address bookkeeping, the fetch and every failure wording stay in the module.
 */
export const SpecShareRow = memo(function SpecShareRow({ msg }: { msg: TranscriptMessage }) {
  const [loading, setLoading] = useState(false);
  const spec = msg.specShare;
  if (!spec) return null;
  return (
    <div
      className={msg.flash ? 'gc-spec-card gc-msg-flash' : 'gc-spec-card'}
      data-msg-id={msg.id ?? ''}
      data-spec-title={spec.previewTitle}
      data-session-id={spec.sessionId ?? ''}
      data-shared-by={spec.sharedBy}
    >
      <div className="gc-spec-card-header">
        <span className="gc-spec-card-icon">📋</span>
        <span className="gc-spec-card-title">{spec.title}</span>
        <span className="gc-msg-time" title={msg.timeTitle}>{msg.time}</span>
      </div>
      <div className="gc-spec-card-attribution">
        {'Shared by '}
        <strong>{spec.sharedBy}</strong>
        {` · v${spec.version}`}
        {spec.built ? ` · ${spec.built}` : null}
        {spec.prNumber ? (
          <>
            {' · '}
            <a
              className="gc-spec-pr"
              href="#"
              data-pr={spec.prNumber}
            >
              {`PR #${spec.prNumber}`}
            </a>
          </>
        ) : null}
      </div>
      {spec.snippetHtml ? <SpecSnippet html={spec.snippetHtml} /> : null}
      {spec.snippetText ? (
        <div className="gc-spec-card-snippet">{spec.snippetText}</div>
      ) : null}
      <div className="gc-spec-card-actions">
        <button
          className="gc-spec-card-view"
          data-session-id={spec.sessionId ?? ''}
          data-version={spec.version}
          disabled={loading}
          onClick={async (e) => {
            e.preventDefault();
            setLoading(true);
            try {
              await controller()?.openSharedSpec?.(spec.sessionId, spec.version, spec.previewTitle);
            } finally {
              setLoading(false);
            }
          }}
        >
          {loading ? 'Loading…' : 'View full spec'}
        </button>
      </div>
      <Reactions msg={msg} />
      <RowActions msg={msg} />
    </div>
  );
});

/** Memoised on the string, for the reason `Body` gives. */
function SpecSnippet({ html }: { html: string }) {
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  return <div className="gc-spec-card-snippet" dangerouslySetInnerHTML={wrapper} />;
}

/**
 * A person's message — a named row, Discord's shape, on every surface
 * (#2783): square avatar, name, time, flat text, the viewer's own on the
 * left like everybody else's. The general chat used to put a person's body in
 * a bubble and the viewer's own on the right; the Messages screen's DMs did
 * the same and dropped it at the same time, so every chat reads alike.
 *
 * `grouped` is a continuation of the same person's previous message
 * (`groupsWithPrevious`): no avatar and no header, the time in the gutter.
 * `gc-msg-self` stays on the viewer's own rows, which the reaction bar and a
 * thread's tint key off.
 *
 * ── The controls are the shared bar (#2387) ───────────────────────────
 *
 * ../message-actions/action-bar.tsx, the same bar a Messages conversation's
 * rows carry: the three recent reactions, the picker, Reply, Save and ⋯. Its
 * acts are the module's own — `sendReact`, `toggleBookmark`, `_startEdit`,
 * `replyToMessage`, `deleteMessage`, `markUnread`, `openReplyThread` on
 * `GroupChat` — called directly rather than through the container's
 * delegated listener, whose classes (`.gc-msg-save`, `.gc-react-add`,
 * `.gc-msg-edit`) this row no longer draws. A long press on a phone opens
 * the same acts as a sheet; the module's own long-press stands down for a
 * `.gc-msg` row (see `_attachQuoteHandlers`).
 */
function MessageActions({ msg, surface, onReportMessage }: {
  msg: TranscriptMessage;
  /** Which transcript the row is in: a reply thread offers no thread of its own. */
  surface: 'main' | 'thread';
  onReportMessage: () => void;
}) {
  const [picker, setPicker] = useState<'above' | 'below' | null>(null);
  const [menu, setMenu] = useState<'above' | 'below' | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const recents = useRecentReactions();
  useDismiss(!!(picker || menu), [bar], () => { setPicker(null); setMenu(null); });
  const chat = controller();
  const items = messageMenuItems(msg, surface, onReportMessage);
  const reacted = (emoji: string) => msg.reactions.some((r) => r.emoji === emoji && r.mine);
  const pick = (emoji: string) => {
    rememberReaction(emoji);
    setPicker(null);
    if (!reacted(emoji) && msg.id) chat?.sendReact?.(msg.id, emoji);
  };
  return (
    <span ref={bar} className="gc-msg-bar-host">
      <MessageActionBar
        className="gc-msg-actions"
        moreClassName="gc-msg-more-action"
        recents={recents}
        reacted={reacted}
        onReact={msg.showReact && msg.id ? (emoji) => chat?.sendReact?.(msg.id, emoji) : undefined}
        pickerOpen={!!picker}
        pickerButtonRef={pickerButton}
        onTogglePicker={msg.showReact ? () => { setMenu(null); setPicker((open) => (open ? null : placementFor(pickerButton.current, 430))); } : undefined}
        onReply={!chat?._readOnly?.() && msg.id ? () => chat?.replyToMessage?.(msg.id, surface) : undefined}
        saved={msg.bookmarked}
        onToggleSave={msg.showBookmark && msg.id ? () => chat?.toggleBookmark?.(msg.id) : undefined}
        moreOpen={!!menu}
        moreButtonRef={moreButton}
        onToggleMore={items.length ? () => { setPicker(null); setMenu((open) => (open ? null : placementFor(moreButton.current, items.length * 38 + 24))); } : undefined}
      >
        {picker ? <EmojiPicker placement={picker} onPick={pick} onClose={() => setPicker(null)} /> : null}
        {menu ? <MessageMenu items={items} placement={menu} onClose={() => { setMenu(null); moreButton.current?.focus({ preventScroll: true }); }} /> : null}
      </MessageActionBar>
    </span>
  );
}

/**
 * The ⋯ menu of an app chat row — the same acts, in the same order, as a
 * Messages conversation's (#2387). What differs is only where each one goes:
 * the module, over the app's own socket and routes.
 */
export function messageMenuItems(
  msg: TranscriptMessage,
  surface: 'main' | 'thread',
  onReportMessage: () => void,
): MenuItem[] {
  const chat = controller();
  const id = msg.id;
  if (!id) return [];
  const items: MenuItem[] = [];
  // B9: hand one of your own messages to Homeroom bot, in your words.
  if (surface === 'main' && msg.canAskBot) {
    items.push({ key: 'ask-bot', label: 'Make this a request', icon: ChatIcon, onSelect: () => { void chat?.makeBotRequest?.(id); } });
  }
  if (surface === 'main' && msg.canThread) {
    items.push({ key: 'thread', label: msg.thread ? 'View thread' : 'Reply in thread', icon: ThreadIcon, onSelect: () => chat?.openReplyThread?.(id) });
  }
  if (msg.showEdit) items.push({ key: 'edit', label: 'Edit message', icon: PencilSquareIcon, onSelect: () => chat?._startEdit?.(id) });
  if (msg.text) items.push({ key: 'copy', label: 'Copy text', icon: CopyIcon, onSelect: () => { void copyToClipboard(msg.text || '', 'Message text copied'); } });
  const link = chat?.messageAddress?.(id);
  if (link) items.push({ key: 'link', label: 'Copy link to message', icon: LinkIcon, onSelect: () => { void copyToClipboard(absoluteLink(link), 'Link copied'); } });
  if (!msg.mine && surface === 'main') {
    items.push({
      key: 'unread', label: 'Mark unread', icon: EnvelopeIcon,
      onSelect: () => { Promise.resolve(chat?.markUnread?.(id)).then(() => toast('Marked unread')).catch(() => toast('Couldn’t mark this unread.')); },
    });
  }
  if (msg.mine && msg.kind === 'message') {
    items.push({
      key: 'delete', label: 'Delete message', icon: DraftTrashIcon, danger: true, separated: true,
      // QA 2026-09-24 Q15: the app's confirm dialog, not window.confirm().
      onSelect: () => {
        void confirmAction({
          title: 'Delete this message?',
          message: 'Everyone will see “Message deleted” in its place. This can’t be undone.',
          confirmLabel: 'Delete',
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          Promise.resolve(chat?.deleteMessage?.(id)).catch(() => toast('Couldn’t delete this message.'));
        });
      },
    });
  } else if (!msg.mine && msg.senderId && msg.kind === 'message') {
    items.push({ key: 'report', label: 'Report message', icon: FlagIcon, separated: true, onSelect: onReportMessage });
    items.push({
      key: 'block', label: `Block @${msg.username}`, icon: NoSymbolIcon, danger: true,
      onSelect: () => {
        const senderId = msg.senderId;
        if (!senderId) return;
        void confirmAction({
          title: `Block @${msg.username}?`,
          message: 'Their messages in Messages and app discussions will be hidden.',
          confirmLabel: 'Block',
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          setUserBlocked(senderId, true).catch((error) => window.alert(error instanceof Error ? error.message : 'Couldn’t block this person.'));
        });
      },
    });
  }
  return items;
}

/**
 * memo()'d, as Messages' row is (#3104): an appended message, a reaction or
 * an edit changes one row's object and leaves every other row's alone
 * (./mount.ts keeps them), so only that row renders. Everything the row
 * draws must therefore arrive as a prop. `threadOpen` is one: it was read
 * from the controller here, and a memo()'d row would have kept the answer
 * from its last render.
 */
export const MessageRow = memo(function MessageRow({ msg, grouped = false, surface = 'main', threadOpen = false }: {
  msg: TranscriptMessage;
  grouped?: boolean;
  /** #2387: `thread` inside a reply thread, where the row offers no thread of its own. */
  surface?: 'main' | 'thread';
  /** #2387: this row's reply thread is the one open beside the channel, which lights its chip. */
  threadOpen?: boolean;
}) {
  const [sheet, setSheet] = useState(false);
  const recents = useRecentReactions();
  const chat = controller();
  const live = !msg.deleted && !!msg.id;
  const longPress = useLongPress(() => setSheet(true), { disabled: !live });
  const reportMessage = () => msg.id && openReport({ targetType: 'app_message', target: msg.id, label: `Message from @${msg.username}`, userId: msg.senderId });
  const reacted = (emoji: string) => msg.reactions.some((r) => r.emoji === emoji && r.mine);
  const items = live ? messageMenuItems(msg, surface, reportMessage) : [];
  const sheetItems: MenuItem[] = live ? [
    ...(!chat?._readOnly?.() ? [{ key: 'reply', label: 'Reply', icon: ReplyArrowIcon, onSelect: () => chat?.replyToMessage?.(msg.id, surface) }] : []),
    ...(msg.showBookmark ? [{ key: 'save', label: msg.bookmarked ? 'Unsave' : 'Save', icon: msg.bookmarked ? BookmarkSolidIcon : BookmarkIcon, onSelect: () => chat?.toggleBookmark?.(msg.id) }] : []),
    ...items,
  ] : [];
  return (
    <ChatMessageRow
      className={`gc-msg ${msg.mine ? 'gc-msg-self' : ''}${msg.flash ? ' gc-msg-flash' : ''}${msg.deleted ? ' gc-msg-deleted' : ''}`}
      grouped={grouped}
      gutter={grouped ? <span className="gc-msg-gutter-time" title={msg.timeTitle}>{timeOfDay(msg.at) || msg.time}</span> : undefined}
      data-msg-id={msg.id ?? ''}
      data-username={msg.username}
      // #2236: only when set, so an ordinary row's attribute set is exactly
      // what it was.
      {...(msg.postedVia ? { 'data-posted-via': msg.postedVia } : {})}
      {...longPress}
      avatar={(
        <Avatar shape="square" size="md" color={swatchFor(msg.username)} aria-hidden="true">
          {msg.username.charAt(0).toUpperCase()}
        </Avatar>
      )}
      name={(
        <>
          {msg.unread ? <span className="gc-unread-dot" aria-label="Unread mention" /> : null}
          <span className={msg.mine ? 'gc-msg-username-self' : undefined}>{msg.username}</span>
          <PostedViaChip via={msg.postedVia} className="ml-1.5" />
        </>
      )}
      timestamp={(
        <>
          <span className="gc-msg-time" title={msg.timeTitle}>{msg.time}</span>
          {msg.editedTitle && !msg.deleted ? (
            <span className="gc-msg-edited" title={msg.editedTitle}>edited</span>
          ) : null}
        </>
      )}
      actions={live ? <MessageActions msg={msg} surface={surface} onReportMessage={reportMessage} /> : undefined}
    >
      {msg.deleted ? <p className="gc-msg-deleted-text">Message deleted</p> : (
        <>
          {msg.quote ? <QuoteBlock quote={msg.quote} /> : null}
          <Body html={msg.bodyHtml} />
          <Attachments items={msg.attachments} />
          {/*
              #3660: a link in the words to one of Homeroom's own pages —
              a request, a proposal, a community's hub or discussion — as
              the card it names, the same card a DM draws for it, resolved
              for whoever is reading (../messages/link-cards.tsx).
          */}
          {msg.text ? <LinkEmbeds text={msg.text} inboxOnly /> : null}
          {/*
              #3288: a message that carries a proposal (the Homeroom bot's
              "built this" post, now an ordinary message from its user) hangs
              the same vote card a vote row does. The same controller host as
              SystemRow's: an empty span, never looked inside, filled by
              GroupChat.refreshVoteControls from the two data-* attributes.
          */}
          {msg.voteRef ? (
            <span
              className="gc-vote-inline gc-vote-inline-block"
              data-vote-controls=""
              data-session-id={msg.voteRef.sessionId}
              data-pr-number={msg.voteRef.prNumber}
            />
          ) : null}
          {grouped && msg.editedTitle ? (
            <span className="gc-msg-edited" title={msg.editedTitle}>edited</span>
          ) : null}
          <Reactions msg={msg} />
          {/* B9: the card under your own message that asked Homeroom bot, yours alone. */}
          {msg.mine && msg.botCard ? (
            <BotRequestCardView
              card={msg.botCard}
              actions={{
                onProgress: () => chat?.openBotChat?.(),
                onRequest: (n) => chat?.openBotRequest?.(n),
                onFile: () => chat?.makeBotRequest?.(msg.id),
                onDismiss: () => chat?.dismissBotRequest?.(msg.id),
                onOpenChat: () => chat?.openBotChat?.(),
              }}
            />
          ) : null}
        </>
      )}
      {msg.thread && surface === 'main' && msg.id ? (
        <ThreadSummaryChip
          replyCount={msg.thread.replyCount}
          lastReplyAt={msg.thread.lastReplyAt}
          active={threadOpen}
          avatars={msg.thread.participants.slice(0, 3).map((name) => (
            <Avatar key={name} shape="square" size="sm" color={swatchFor(name)} aria-hidden="true">{name.charAt(0).toUpperCase()}</Avatar>
          ))}
          lastReply={msg.thread.lastReply ? {
            face: <ReplyFace name={msg.thread.lastReply.name} />,
            name: msg.thread.lastReply.name,
            text: msg.thread.lastReply.text,
          } : null}
          onOpen={() => chat?.openReplyThread?.(msg.id)}
        />
      ) : null}
      {live ? (
        <MessageActionSheet
          open={sheet}
          onClose={() => setSheet(false)}
          recents={recents}
          reacted={reacted}
          onReact={msg.showReact ? (emoji) => chat?.sendReact?.(msg.id, emoji) : undefined}
          onPick={msg.showReact ? (emoji) => { rememberReaction(emoji); if (!reacted(emoji)) chat?.sendReact?.(msg.id, emoji); } : undefined}
          items={sheetItems}
          preview={{ who: msg.username, text: msg.text || '' }}
        />
      ) : null}
    </ChatMessageRow>
  );
});

/**
 * `source` names which transcript this host shows — `main` for the general
 * chat, `thread` for the topic sub-view. One component for both: they are the
 * same rows in different containers, and the differences (a "Load earlier"
 * control, an empty/loading line) are data.
 */
export function Transcript({ source = 'main' }: { source?: string }) {
  const state = useStoreState(transcriptStore);
  const view = state.byKey[source];

  /**
   * Fill the vote rows' controls hosts once they exist.
   *
   * `AppView.loadVotePanel` calls `refreshVoteControls` whenever the vote
   * state moves, which covers a vote being cast — but not a vote row arriving
   * on a transcript that has already rendered, and not the first paint of a
   * chat whose panel finished loading before it. The string renderer had no
   * such gap: it filled the wrapper inline as it built the row.
   *
   * Keyed on WHICH vote rows are present, not on every render: filling is an
   * `innerHTML` write per host, and the rows themselves repaint on every
   * reaction. `refreshVoteControls` patches each row's tint back, and
   * `patchTranscriptMessage` drops a patch that says nothing new — which is
   * what keeps this from looping.
   */
  const voteRows = (view ? view.messages : [])
    .filter((m) => m.kind === 'vote')
    .map((m) => m.id)
    .join(',');
  useEffect(() => {
    if (voteRows) controller()?.refreshVoteControls?.();
  }, [voteRows]);

  if (!state.ready || !view) return null;
  return <TranscriptRows view={view} source={source} />;
}

/**
 * One row, by kind. `fallbackKey` is for a row the server has not stamped
 * with an id yet. In the general chat (`main`) a person's message is a
 * bubble, on the right when it is the viewer's own, and a row that carries a
 * proposal event is that event's message row; the thread draws every row
 * flat, and the line itself where the general chat draws an event.
 */
/**
 * The thread-head copy of a message (`thread: null`), one per message
 * OBJECT: a copy built during render is a new object every time, and the
 * memo()'d row it is handed would render every time with it.
 */
const threadHeads = new WeakMap<TranscriptMessage, TranscriptMessage>();
function threadHead(msg: TranscriptMessage): TranscriptMessage {
  let head = threadHeads.get(msg);
  if (!head) {
    head = { ...msg, thread: null };
    threadHeads.set(msg, head);
  }
  return head;
}

function renderRow(msg: TranscriptMessage, fallbackKey: string, main = false, chat = false, previous: TranscriptMessage | null = null) {
  const key = msg.id != null ? `m${msg.id}` : fallbackKey;
  // #2387: the message a reply thread hangs off, drawn at the thread's head —
  // a row of its own (never grouped with the first reply), with its thread
  // chip left off since the thread is what is open.
  if (msg.threadRoot) return <MessageRow key={key} msg={threadHead(msg)} surface="thread" />;
  if (msg.kind === 'spec_share') return <SpecShareRow key={key} msg={msg} />;
  // `chat` is a change page's own Discussion, drawn in the general chat's
  // language: every notice as a message (its rows arrive with an event from
  // `GroupChat._threadEvent`). A person's message is the same named row on
  // every surface, grouped under the previous one when it continues it.
  if (msg.kind === 'message') {
    const grouped = !!previous && previous.kind === 'message' && !previous.event && !msg.event
      && !previous.threadRoot && !msg.deleted && !previous.deleted
      && !!msg.at && !!previous.at
      && groupsWithPrevious(
        { author: previous.username, at: previous.at },
        { author: msg.username, at: msg.at, reply: !!msg.quote },
      );
    // Whether this row's reply thread is the open one: read here, on every
    // render of the rows, and handed down, because the row itself is memo()'d.
    const threadOpen = main && !!msg.thread && msg.id != null && !!controller()?.isReplyThreadOpen?.(msg.id);
    return <MessageRow key={key} msg={msg} grouped={grouped} surface={main ? 'main' : 'thread'} threadOpen={threadOpen} />;
  }
  if ((main || chat) && msg.event) return <EventRow key={key} msg={msg} />;
  return <SystemRow key={key} msg={msg} />;
}

/** A reply's face on a thread card: the chat's letter swatch at 22px. */
function ReplyFace({ name }: { name: string }) {
  return (
    <span className="msgx-thread-face">
      <Avatar shape="square" size="sm" color={swatchFor(name)} aria-hidden="true">{name.charAt(0).toUpperCase()}</Avatar>
    </span>
  );
}

/** A run of one reply thread's replies in the general chat (#2387 follow-up). */
function ThreadActivityRun({ run }: { run: TranscriptMessage[] }) {
  const first = run[0];
  const last = run[run.length - 1];
  const replyOf = first.replyOf as NonNullable<TranscriptMessage['replyOf']>;
  const time = first.time === last.time ? last.time : `${first.time} – ${last.time}`;
  return (
    <ThreadActivityCard
      rootText={replyOf.rootText}
      rootDeleted={replyOf.rootDeleted}
      time={time}
      timeTitle={last.timeTitle}
      replies={run.map((m, index) => ({
        key: m.id ?? `r${index}`,
        face: <ReplyFace name={m.username} />,
        name: m.username,
        text: m.text || '',
      }))}
      onOpen={() => controller()?.openReplyThread?.(replyOf.rootId)}
    />
  );
}

/**
 * What the general chat draws: people, shared specs, and the two proposal
 * events. Every other notice the platform posts into the stream — a request
 * closing, a check verdict, main's suite going red, a settings change — is
 * left in the data and in the topic thread it was dual-posted to, and not
 * drawn here. The thread transcript keeps them all (see TranscriptRows).
 */
export function drawnInGeneralChat(m: TranscriptMessage): boolean {
  return m.kind === 'message' || m.kind === 'spec_share' || !!m.event;
}

/** A card in the general chat: a proposal event, which is never a person's message. */
/**
 * The rows of one transcript, given its view: the lead, the rows, and for the
 * general chat the two things that make a quiet app's Discussion readable.
 *
 * ── The general chat draws people and proposals; the thread draws all ──
 *
 * `source === 'main'` keeps only the rows `drawnInGeneralChat` admits — people,
 * shared specs, and a proposal put up for a vote or merged, each of those a
 * message from whoever did it (./proposal-event.tsx). The thread transcript
 * is a proposal's or an issue's own Discussion, where every notice is the
 * story of that topic, so it keeps them all, in the centred form.
 *
 * And when no message from a PERSON is among the loaded rows, the general
 * chat ends with the quiet card (./quiet-card.tsx). The rows decide that,
 * not the module: a reply that lands live is appended to the same list, and
 * the card goes with the next render.
 *
 * Separate from `Transcript` so it can be rendered from a view directly,
 * without the store, which is how tests/group-chat-proposal-events.test.js
 * checks it.
 */
export function TranscriptRows({ view, source }: {
  view: TranscriptView;
  source: string;
}) {
  const main = source === 'main';
  // A change page's Discussion (`lead.language === 'chat'`) keeps every row,
  // as a thread does, and draws each in the general chat's language — and
  // ends with the quiet card when nobody has commented, as the general chat
  // does when nobody has posted.
  const chat = !main && view.lead.language === 'chat';
  // Folded once per message list: a fold is a new object, and one rebuilt on
  // every render would redraw its memo()'d row every time.
  const folded = useMemo(() => foldRepeats(view.messages), [view.messages]);
  const rows = folded.filter((m) => !main || drawnInGeneralChat(m));
  const quiet = (main || chat) && view.lead.quiet && !view.messages.some((m) => m.kind === 'message')
    ? view.lead.quiet
    : null;
  const drawn: ReactNode[] = [];
  // The row the next one groups under; a thread-activity card resets it, so
  // the message after a card always carries its own name.
  let previous: TranscriptMessage | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    // #2387 follow-up: in the general chat a reply-thread reply is drawn
    // where it landed — one card for a run of replies to one thread with
    // nothing else said between them. A deleted reply leaves the run.
    const replyOf = main ? rows[i].replyOf : null;
    if (replyOf) {
      const run = [rows[i]];
      while (i + 1 < rows.length && rows[i + 1].replyOf?.rootId === replyOf.rootId) {
        run.push(rows[i + 1]);
        i += 1;
      }
      const live = run.filter((m) => !m.deleted);
      if (live.length) drawn.push(<ThreadActivityRun key={`thread-activity-${live[0].id ?? i}`} run={live} />);
      previous = null;
      continue;
    }
    drawn.push(renderRow(rows[i], `i${i}`, main, chat, previous));
    previous = rows[i];
    // #2387: under a reply thread's first message, how many replies follow —
    // the line Slack draws between a thread's head and its replies.
    if (rows[i].threadRoot) {
      const replies = rows.length - i - 1;
      drawn.push(
        <div key="reply-count" className="gc-reply-count">
          <span>{replies ? `${replies} ${replies === 1 ? 'reply' : 'replies'}` : 'No replies yet'}</span>
        </div>,
      );
    }
  }
  return (
    <>
      {view.lead.earlier ? (
        <div className="text-center py-1">
          <button
            type="button"
            id="gc-thread-earlier"
            className="gc-vote-btn"
            onClick={() => controller()?.loadThreadHistoryForOpen?.()}
          >
            Load earlier
          </button>
        </div>
      ) : null}
      {/* Derived at render from the rows, like the quiet card above, rather
          than trusted from the lead: `appendTranscriptMessage` copies `lead`
          through untouched, so a placeholder published for an empty thread
          ("No messages yet…", or "Loading…" before the history returns)
          outlived the first row that landed on it and only went away on the
          next full publish — a remount or a refresh (#2498). */}
      {view.lead.placeholder && !rows.length ? (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 px-2 py-2">{view.lead.placeholder}</div>
      ) : null}
      {/* #2992: the history request failed. The module keeps the failure on
          its own state and republishes; "Try again" re-enters the same load
          the channel or thread opened with, and a success clears the line. */}
      {view.lead.error ? (
        <div role="alert" className="gc-history-error flex items-center gap-2 px-2 py-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{view.lead.error}</span>
          <Button
            type="button"
            variant="neutral"
            size="xsText"
            ink="neutral"
            onClick={() => (main ? controller()?.loadHistory?.() : controller()?.loadThreadHistoryForOpen?.())}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {drawn}
      {quiet ? <QuietCard {...quiet} /> : null}
    </>
  );
}
