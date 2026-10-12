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
import { ChatMessageRow, NewMessagesDivider, groupsWithPrevious } from '@/components/ui/chat';
import { Avatar, ReactionPill } from '@/components/ui/feed';
import {
  BookmarkIcon, BookmarkSolidIcon, ChatIcon, CopyIcon, DownloadIcon, DraftTrashIcon, EnvelopeIcon, FlagIcon, LinkIcon, NoSymbolIcon,
  PencilSquareIcon, ReplyArrowIcon, ThreadIcon,
} from '@/components/ui/icons';

import { confirmAction } from '../../lib/confirm';
import { RichMessage, useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { timeOfDay } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { PostedViaChip } from './posted-via-chip';
import { BotRequestCardView, BotStatusChip } from './bot-request';
import { ImageViewer, openInViewer, useInlineImageViewer } from '../image-viewer/image-viewer';
import { downloadLabel, downloadableImages, saveImages, useCanSaveImage } from '../image-viewer/save-image';
import { EventRow } from './proposal-event';
import { QuietCard } from './quiet-card';
import { swatchFor } from './swatch';
import { LinkEmbeds } from '../messages/link-cards';
import { openAppTarget } from '../messages/bot-shared';
import { setUserBlocked } from '../messages/store';
import { firstUnreadId, transcriptRow } from '../messages/unread-anchor';
import { displayName, openRequestSpec, replyCount, requestStream } from '../dev-board/topic/request-model';
import { changeLine, changeReplyCount, changeStream } from '../dev-board/topic/change-model';
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
  type BotOfferView,
  type Quote,
  type TranscriptMarker,
  type TranscriptMessage,
  type TranscriptView,
} from './transcript-store';
import { MergedTopicCard } from '../dev-board/workshop/merged-topic-card';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).GroupChat : null) || null;
}

/**
 * The buttons under Homeroom bot's offer in a thread (File it / Not now,
 * Withdraw it / Keep it, Propose to close / Keep it open), for the one
 * person it was offered to. A tap is sent once (GroupChat.decideBotOffer);
 * the buttons then go for everybody when the room hears it was decided.
 */
function BotOfferButtons({ id, offer }: { id: number | null; offer: BotOfferView }) {
  const [busy, setBusy] = useState(false);
  if (id == null) return null;
  const decide = async (choice: 'yes' | 'no') => {
    if (busy) return;
    setBusy(true);
    try {
      await controller()?.decideBotOffer?.(id, choice);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 flex flex-wrap gap-2" data-gc-bot-offer="">
      {offer.actions.map((action) => (
        <Button
          key={action.id}
          type="button"
          onClick={() => { void decide(action.id); }}
          disabled={busy}
          variant={action.primary ? 'pillAccent' : 'pillNeutral'}
          ink={action.primary ? 'solid' : 'neutral'}
          size="sm"
          className="font-semibold"
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
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
  const t = useMessages('chat');
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
        title={att.unnamed ? t('chat:group.attachment.openFullSizeUnnamed') : t('chat:group.attachment.openFullSize', { file: att.name })}
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
  const t = useMessages('chat');
  const size = <span className="dc-attach-size">{att.size}</span>;
  const download = (
    <a
      className="gc-att-action"
      href={att.url}
      download={att.name}
      title={att.unnamed ? t('chat:group.attachment.downloadUnnamed') : t('chat:group.attachment.download', { file: att.name })}
      aria-label={att.unnamed ? t('chat:group.attachment.downloadUnnamed') : t('chat:group.attachment.download', { file: att.name })}
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
          data-att-unnamed={att.unnamed ? '' : undefined}
          title={att.unnamed ? t('chat:group.attachment.viewUnnamed') : t('chat:group.attachment.view', { file: att.name })}
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
          title={att.unnamed ? t('chat:group.attachment.previewTitleUnnamed') : t('chat:group.attachment.previewTitle', { file: att.name })}
        >
          {t('chat:group.attachment.preview')}
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
      title={att.unnamed ? t('chat:group.attachment.downloadUnnamed') : t('chat:group.attachment.download', { file: att.name })}
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
          onProgress={() => (msg.botRequest?.status === 'fixing' && msg.botRequest.sessionId
            ? controller()?.openBotChange?.(msg.botRequest.sessionId)
            : controller()?.openBotChat?.())}
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
  const t = useMessages('chat');
  if (!(msg.showEdit || msg.showBookmark || msg.showReact)) return null;
  const saved = msg.bookmarked;
  return (
    <>
      {msg.showEdit ? (
        <button type="button" className="gc-msg-edit" title={t('chat:group.row.editTitle')} aria-label={t('chat:group.row.edit')} tabIndex={-1}>
          {'\u270F\uFE0F'}
        </button>
      ) : null}
      {msg.showBookmark ? (
        <button
          type="button"
          className={saved ? 'gc-msg-save gc-msg-saved' : 'gc-msg-save'}
          title={saved ? t('chat:group.row.savedTitle') : t('chat:group.row.saveTitle')}
          aria-label={saved ? t('chat:group.row.unsave') : t('chat:group.row.save')}
          aria-pressed={saved}
        >
          {/* Solid when saved, outline when not — the state lives in the SHAPE,
              which is legible at 12px and in a screenshot. Not one path with
              its fill flipped; see the note in @/components/ui/icons.tsx. */}
          {saved ? <BookmarkSolidIcon /> : <BookmarkIcon strokeWidth="1.5" />}
        </button>
      ) : null}
      {msg.showReact ? (
        <button type="button" className="gc-react-add" title={t('chat:group.row.reactTitle')} aria-label={t('chat:group.row.addReaction')} tabIndex={-1}>
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
  const t = useMessages('chat');
  return (
    <div
      className={`gc-msg-system ${msg.kind === 'vote' ? 'gc-msg-vote' : ''}${msg.voteRowClass ? ` ${msg.voteRowClass}` : ''}${msg.flash ? ' gc-msg-flash' : ''}`}
      data-msg-id={msg.id ?? ''}
    >
      <span className="gc-msg-system-text">{msg.systemText}</span>
      {msg.repeat && msg.repeat > 1 ? (
        <span className="gc-msg-system-repeat" title={t('chat:group.row.repeated', { count: msg.repeat })}>{` · ×${msg.repeat}`}</span>
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
  const t = useMessages('chat');
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
      data-shared-by-unknown={spec.sharedByUnknown ? '' : undefined}
    >
      <div className="gc-spec-card-header">
        <span className="gc-spec-card-icon">📋</span>
        <span className="gc-spec-card-title">{spec.title}</span>
        <span className="gc-msg-time" title={msg.timeTitle}>{msg.time}</span>
      </div>
      <div className="gc-spec-card-attribution">
        {/* One sentence per shape, so the name, the version, the date and
            the link keep their order in the language on screen. */}
        <RichMessage
          id={spec.sharedByUnknown
            ? (spec.built
              ? (spec.prNumber ? 'chat:group.specCard.sharedBySomeoneBuiltPr' : 'chat:group.specCard.sharedBySomeoneBuilt')
              : (spec.prNumber ? 'chat:group.specCard.sharedBySomeonePr' : 'chat:group.specCard.sharedBySomeone'))
            : (spec.built
              ? (spec.prNumber ? 'chat:group.specCard.sharedByBuiltPr' : 'chat:group.specCard.sharedByBuilt')
              : (spec.prNumber ? 'chat:group.specCard.sharedByPr' : 'chat:group.specCard.sharedBy'))}
          values={{ name: spec.sharedBy, version: spec.version, built: spec.built, number: spec.prNumber }}
          components={[
            <strong />,
            <a className="gc-spec-pr" href="#" data-pr={spec.prNumber ?? undefined} />,
          ]}
        />
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
          {loading ? t('chat:group.specCard.loading') : t('chat:group.specCard.view')}
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
  // Subscribed: the menu's labels are read in the language on screen.
  useMessages('chat');
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
    items.push({ key: 'ask-bot', label: translate('chat:group.menu.makeRequest'), icon: ChatIcon, onSelect: () => { void chat?.makeBotRequest?.(id); } });
  }
  if (surface === 'main' && msg.canThread) {
    items.push({ key: 'thread', label: msg.thread ? translate('chat:group.menu.viewThread') : translate('chat:group.menu.replyInThread'), icon: ThreadIcon, onSelect: () => chat?.openReplyThread?.(id) });
  }
  if (msg.showEdit) items.push({ key: 'edit', label: translate('chat:group.menu.edit'), icon: PencilSquareIcon, onSelect: () => chat?._startEdit?.(id) });
  if (msg.text) items.push({ key: 'copy', label: translate('chat:group.menu.copyText'), icon: CopyIcon, onSelect: () => { void copyToClipboard(msg.text || '', translate('chat:group.menu.textCopied')); } });
  // #4055: its pictures onto the device, whoever posted them.
  const pictures = downloadableImages((msg.attachments || []).filter((att) => att.kind === 'image').map((att) => ({ src: att.url, name: att.name })));
  if (pictures.length) items.push({ key: 'download', label: downloadLabel(pictures.length), icon: DownloadIcon, onSelect: () => { void saveImages(pictures); } });
  const link = chat?.messageAddress?.(id);
  if (link) items.push({ key: 'link', label: translate('chat:group.menu.copyLink'), icon: LinkIcon, onSelect: () => { void copyToClipboard(absoluteLink(link), translate('chat:group.menu.linkCopied')); } });
  if (!msg.mine && surface === 'main') {
    items.push({
      key: 'unread', label: translate('chat:group.menu.markUnread'), icon: EnvelopeIcon,
      onSelect: () => { Promise.resolve(chat?.markUnread?.(id)).then(() => toast(translate('chat:group.menu.markedUnread'))).catch(() => toast(translate('chat:group.menu.markUnreadFailed'))); },
    });
  }
  if (msg.mine && msg.kind === 'message') {
    items.push({
      key: 'delete', label: translate('chat:group.menu.delete'), icon: DraftTrashIcon, danger: true, separated: true,
      // QA 2026-09-24 Q15: the app's confirm dialog, not window.confirm().
      onSelect: () => {
        void confirmAction({
          title: translate('chat:group.deleteConfirm.title'),
          message: translate('chat:group.deleteConfirm.message'),
          confirmLabel: translate('chat:group.deleteConfirm.confirm'),
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          Promise.resolve(chat?.deleteMessage?.(id)).catch(() => toast(translate('chat:group.menu.deleteFailed')));
        });
      },
    });
  } else if (!msg.mine && msg.senderId && msg.kind === 'message') {
    items.push({ key: 'report', label: translate('chat:group.menu.report'), icon: FlagIcon, separated: true, onSelect: onReportMessage });
    items.push({
      key: 'block', label: msg.usernameMissing ? translate('chat:group.menu.blockUnknown') : translate('chat:group.menu.block', { username: msg.username }), icon: NoSymbolIcon, danger: true,
      onSelect: () => {
        const senderId = msg.senderId;
        if (!senderId) return;
        void confirmAction({
          title: msg.usernameMissing ? translate('chat:group.blockConfirm.titleUnknown') : translate('chat:group.blockConfirm.title', { username: msg.username }),
          message: translate('chat:group.blockConfirm.message'),
          confirmLabel: translate('chat:group.blockConfirm.confirm'),
          danger: true,
        }).then((ok) => {
          if (!ok) return;
          setUserBlocked(senderId, true).catch((error) => window.alert(error instanceof Error ? error.message : translate('chat:group.menu.blockFailed')));
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
  const t = useMessages('chat');
  const [sheet, setSheet] = useState(false);
  const recents = useRecentReactions();
  const chat = controller();
  const live = !msg.deleted && !!msg.id;
  // #4055: in the app, whether its build can save a picture is known only
  // once asked; asking re-renders the row so the menu's Download line can
  // appear. Nothing is asked for a row without a picture.
  useCanSaveImage((msg.attachments || []).find((att) => att.kind === 'image')?.url || '');
  const longPress = useLongPress(() => setSheet(true), { disabled: !live });
  const reportMessage = () => msg.id && openReport({ targetType: 'app_message', target: msg.id, label: msg.usernameMissing ? t('chat:group.report.labelUnknown') : t('chat:group.report.label', { username: msg.username }), userId: msg.senderId });
  const reacted = (emoji: string) => msg.reactions.some((r) => r.emoji === emoji && r.mine);
  const items = live ? messageMenuItems(msg, surface, reportMessage) : [];
  const sheetItems: MenuItem[] = live ? [
    ...(!chat?._readOnly?.() ? [{ key: 'reply', label: t('chat:group.sheet.reply'), icon: ReplyArrowIcon, onSelect: () => chat?.replyToMessage?.(msg.id, surface) }] : []),
    ...(msg.showBookmark ? [{ key: 'save', label: msg.bookmarked ? t('chat:group.sheet.unsave') : t('chat:group.sheet.save'), icon: msg.bookmarked ? BookmarkSolidIcon : BookmarkIcon, onSelect: () => chat?.toggleBookmark?.(msg.id) }] : []),
    ...items,
  ] : [];
  return (
    <ChatMessageRow
      className={`gc-msg ${msg.mine ? 'gc-msg-self' : ''}${msg.flash ? ' gc-msg-flash' : ''}${msg.deleted ? ' gc-msg-deleted' : ''}`}
      grouped={grouped}
      gutter={grouped ? <span className="gc-msg-gutter-time" title={msg.timeTitle}>{timeOfDay(msg.at) || msg.time}</span> : undefined}
      data-msg-id={msg.id ?? ''}
      data-username={msg.username}
      data-username-missing={msg.usernameMissing ? '' : undefined}
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
          {msg.unread ? <span className="gc-unread-dot" aria-label={t('chat:group.row.unreadMention')} /> : null}
          <span className={msg.mine ? 'gc-msg-username-self' : undefined}>{msg.username}</span>
          <PostedViaChip via={msg.postedVia} className="ml-1.5" />
        </>
      )}
      timestamp={(
        <>
          <span className="gc-msg-time" title={msg.timeTitle}>{msg.time}</span>
          {msg.editedTitle && !msg.deleted ? (
            <span className="gc-msg-edited" title={msg.editedTitle}>{t('chat:group.row.edited')}</span>
          ) : null}
        </>
      )}
      actions={live ? <MessageActions msg={msg} surface={surface} onReportMessage={reportMessage} /> : undefined}
    >
      {msg.deleted ? <p className="gc-msg-deleted-text">{t('chat:group.row.deleted')}</p> : (
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
          {/* #4238: Homeroom bot's first-version line opens the app. */}
          {msg.openApp ? (
            <Button
              type="button"
              data-gc-open-app=""
              onClick={() => openAppTarget(msg.openApp?.target)}
              variant="pillAccent"
              size="sm"
              className="mt-2 font-semibold"
            >
              {msg.openApp.label}
            </Button>
          ) : null}
          {/* Homeroom bot's offer in a thread: its buttons, for the person it was offered to. */}
          {msg.botOffer && msg.botOffer.forMe && msg.botOffer.status === 'open' && msg.botOffer.actions.length ? (
            <BotOfferButtons id={msg.id} offer={msg.botOffer} />
          ) : null}
          {grouped && msg.editedTitle ? (
            <span className="gc-msg-edited" title={msg.editedTitle}>{t('chat:group.row.edited')}</span>
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
                onTry: (sessionId) => chat?.tryBotChange?.(sessionId),
                onChange: (sessionId) => chat?.openBotChange?.(sessionId),
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
            ...(msg.thread.lastReply.unnamed ? { unnamed: 'someone' as const } : {}),
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
  // #4453: a request's page draws its own stream.
  if (source !== 'main' && view.lead.language === 'request') return <RequestRows view={view} />;
  // #4455: so does a change's page.
  if (source !== 'main' && view.lead.language === 'change') return <ChangeRows view={view} />;
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

/**
 * #4453: a comment on the request's GitHub issue, in a request's stream. The
 * same named row a Homeroom reply is (so the two read as one conversation),
 * with "· on GitHub" after the time. It is GitHub's to edit and react to, so
 * it carries none of the row's controls.
 */
const GitHubRow = memo(function GitHubRow({ msg }: { msg: TranscriptMessage }) {
  const t = useMessages('project');
  return (
    <ChatMessageRow
      className="gc-msg gc-msg-github"
      data-github-comment={msg.key || ''}
      data-username={msg.username}
      data-username-missing={msg.usernameMissing ? '' : undefined}
      avatar={(
        <Avatar shape="square" size="md" color={swatchFor(msg.username)} aria-hidden="true">
          {displayName(msg.username).charAt(0).toUpperCase()}
        </Avatar>
      )}
      name={displayName(msg.username)}
      timestamp={(
        msg.time ? (
          <RichMessage
            id="project:topic.request.stream.timeOnGitHub"
            values={{ time: msg.time }}
            components={[<span className="gc-msg-time" title={msg.timeTitle} />, <span className="gc-msg-via" />]}
          />
        ) : <span className="gc-msg-via">{t('project:topic.request.stream.onGitHub')}</span>
      )}
    >
      <Body html={msg.bodyHtml} />
    </ChatMessageRow>
  );
});

/** Whether a shared plan is Homeroom bot's, which a request's page words in its own sentence. */
function isBotPlan(spec: { sharedBy: string; sharedByUnknown?: boolean; botNote?: string | null }): boolean {
  return !!spec.botNote || (!spec.sharedByUnknown && /^homeroom_bot$/i.test(spec.sharedBy));
}

/**
 * #4453: something that happened on a request — a claim, a spec posted, a
 * notice — as one quiet line with a glyph, where the stream reached it.
 * `.gc-msg-system` keeps the module's row hooks (tap-to-quote's row
 * selector, the repeat fold's count).
 */
const RequestEvent = memo(function RequestEvent({ msg, onRead }: { msg: TranscriptMessage; onRead?: () => void }) {
  const spec = msg.kind === 'spec_share' ? msg.specShare : null;
  const gh = msg.kind === 'github' ? msg.githubSpec : null;
  const claim = /^(\S+) claimed this (?:issue|request)$/.exec((msg.systemText || '').trim());
  const t = useMessages('project');
  const tChat = useMessages('chat');
  let glyph = '•';
  let text: ReactNode = msg.systemText;
  // Each line is one whole message, with <0> around who did it.
  if (spec && isBotPlan(spec)) {
    // Homeroom bot's plan says where it stands, in its own sentence:
    // "Plan v1: Dark mode. I'm building it now." (homeroom-bot-live.js specCard).
    glyph = '📋';
    const values = { version: spec.version, title: spec.title };
    text = spec.botNote === 'building' ? t('project:topic.request.stream.botPlanBuilding', values)
      : spec.botNote === 'waiting'
        ? (spec.waitingFor
          ? t('project:topic.request.stream.botPlanWaiting', { ...values, requester: spec.waitingFor })
          : t('project:topic.request.stream.botPlanWaitingUnnamed', values))
        : t('project:topic.request.stream.botPlan', values);
  } else if (spec) {
    glyph = '📋';
    text = spec.sharedByUnknown
      ? <RichMessage id="project:topic.request.stream.postedSpecVersionUnnamed" values={{ version: spec.version }} components={[<b />]} />
      : <RichMessage id="project:topic.request.stream.postedSpecVersion" values={{ author: spec.sharedBy, version: spec.version }} components={[<b />]} />;
  } else if (gh) {
    glyph = '📋';
    text = msg.usernameMissing
      ? <RichMessage id="project:topic.request.stream.postedSpecSystem" components={[<b />]} />
      : <RichMessage id="project:topic.request.stream.postedSpec" values={{ author: displayName(msg.username) }} components={[<b />]} />;
  } else if (claim) {
    glyph = '✋';
    text = <RichMessage id="project:topic.request.stream.claimed" values={{ member: claim[1] }} components={[<b />]} />;
  }
  return (
    <div className="gc-msg-system dev-request-event" data-msg-id={msg.id ?? ''} data-request-event={spec || gh ? 'spec' : claim ? 'claim' : 'notice'}>
      <span className="dev-request-event-glyph" aria-hidden="true">{glyph}</span>
      <span className="dev-request-event-text">
        {text}
        {msg.repeat && msg.repeat > 1 ? (
          <span className="gc-msg-system-repeat" title={tChat('chat:group.row.repeated', { count: msg.repeat })}>{` · ×${msg.repeat}`}</span>
        ) : null}
        {onRead ? <>{' · '}<button type="button" className="dev-request-event-link" onClick={onRead}>{t('project:topic.request.stream.read')}</button></> : null}
        {msg.time ? <span className="dev-request-event-time" title={msg.timeTitle}>{` · ${msg.time}`}</span> : null}
      </span>
    </div>
  );
});

/**
 * #4453: a request's stream. Under the request (the topic head, drawn above
 * this host) comes "N replies", then every reply in the order it was
 * written, wherever it was written: the thread's messages and the issue's
 * GitHub comments are merged by time in `GroupChat.renderThread`. A person's
 * message is the named row; a claim, a spec posted or a notice is a line.
 * Homeroom bot's GitHub copy of a spec that was posted here is the same
 * posting twice, so it is left out (../dev-board/topic/request-model.ts).
 */
export function RequestRows({ view }: { view: TranscriptView }) {
  const t = useMessages('project');
  const stream = useMemo(() => requestStream(foldRepeats(view.messages)), [view.messages]);
  const specs = stream.specs;
  const count = replyCount(stream.rows);
  const loaded = !!view.lead.request?.loaded;
  const more = view.lead.request?.githubMore;
  // #3908: a screenshot in a GitHub comment opens in the app's viewer over
  // the page, as one in the request's own words does (request-head.tsx).
  const images = useInlineImageViewer();
  const drawn: ReactNode[] = [];
  let previous: TranscriptMessage | null = null;
  stream.rows.forEach((msg, i) => {
    const key = msg.id != null ? `m${msg.id}` : (msg.key ? `g${msg.key}` : `i${i}`);
    if (msg.kind === 'message') {
      const grouped = !!previous && previous.kind === 'message' && !msg.deleted && !previous.deleted
        && !!msg.at && !!previous.at
        && groupsWithPrevious(
          { author: previous.username, at: previous.at },
          { author: msg.username, at: msg.at, reply: !!msg.quote },
        );
      drawn.push(<MessageRow key={key} msg={msg} grouped={grouped} surface="thread" />);
    } else if (msg.kind === 'github' && !msg.githubSpec) {
      drawn.push(<GitHubRow key={key} msg={msg} />);
    } else if (msg.kind === 'vote') {
      drawn.push(<SystemRow key={key} msg={msg} />);
    } else {
      const card = msg.kind === 'spec_share' && msg.specShare
        ? specs.find((c) => c.read.kind === 'shared' && c.read.sessionId === Number(msg.specShare?.sessionId))
        : msg.kind === 'github' ? specs.find((c) => c.key === `g${msg.key}`) : null;
      // A spec's line opens the version it posted, which may be older than
      // the card's.
      const read = msg.kind === 'spec_share' && msg.specShare && msg.specShare.sessionId
        ? () => controller()?.openSharedSpec?.(msg.specShare?.sessionId, msg.specShare?.version, msg.specShare?.previewTitle)
        : card ? () => openRequestSpec(card) : undefined;
      drawn.push(<RequestEvent key={key} msg={msg} onRead={read} />);
    }
    previous = msg;
  });
  return (
    <>
      <div className="messages-reply-count" data-request-replies={count}>
        <span>{count ? t('project:topic.request.stream.replies', { count }) : loaded ? t('project:topic.request.stream.noReplies') : t('project:topic.request.stream.loading')}</span>
      </div>
      {view.lead.earlier ? (
        <div className="text-center py-1">
          <button type="button" id="gc-thread-earlier" className="messages-load-older" onClick={() => controller()?.loadThreadHistoryForOpen?.()}>
            {t('project:topic.request.stream.loadEarlier')}
          </button>
        </div>
      ) : null}
      {more ? (
        <div className="dev-request-event dev-request-gh-more">
          <span className="dev-request-event-glyph" aria-hidden="true">•</span>
          <span className="dev-request-event-text">
            {more.url ? (
              <RichMessage
                id="project:topic.request.stream.earlierOnGitHub"
                components={[<a href={more.url} target="_blank" rel="noopener" className="dev-request-event-link" />]}
              />
            ) : t('project:topic.request.stream.earlierNotShown')}
          </span>
        </div>
      ) : null}
      {view.lead.error ? (
        <div role="alert" className="gc-history-error flex items-center gap-2 px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{view.lead.error}</span>
          <Button type="button" variant="neutral" size="xsText" ink="neutral" onClick={() => controller()?.loadThreadHistoryForOpen?.()}>
            {t('core:common.tryAgain')}
          </Button>
        </div>
      ) : null}
      {images.viewer}
      <div className="dev-request-stream" {...images.scope}>{drawn}</div>
    </>
  );
}

/**
 * #4455: something that happened to a change, as one quiet line in its
 * page's stream (../dev-board/topic/change-model.ts `changeLine` words it):
 * the request page's own line (`.dev-request-event`), so the two pages read
 * alike. `.gc-msg-system` keeps the module's row hooks.
 */
const ChangeEvent = memo(function ChangeEvent({ msg }: { msg: TranscriptMessage }) {
  const t = useMessages('project');
  const tChat = useMessages('chat');
  const line = changeLine(msg);
  if (!line) return null;
  const sessionId = Number(msg.event?.sessionId || msg.voteRef?.sessionId || controller()?.activeThread?.ref || 0);
  return (
    <div className="gc-msg-system dev-request-event" data-msg-id={msg.id ?? ''} data-change-event={line.kind}>
      <span className="dev-request-event-glyph" aria-hidden="true">{line.glyph}</span>
      <span className="dev-request-event-text">
        {/* A line the page words is one whole message: <0> is who did it,
            <1> a vote's reason. */}
        {line.id
          ? <RichMessage id={line.id} values={line.values} components={[<b />, <span className="dev-change-event-reason" />]} />
          : line.text}
        {msg.repeat && msg.repeat > 1 ? (
          <span className="gc-msg-system-repeat" title={tChat('chat:group.row.repeated', { count: msg.repeat })}>{` · ×${msg.repeat}`}</span>
        ) : null}
        {line.tryIt && sessionId ? (
          <>{' · '}<button type="button" className="dev-request-event-link" onClick={() => (window as any).AppView?._tryChangePreview?.(sessionId)}>{t('project:topic.change.stream.tryIt')}</button></>
        ) : null}
        {/* A plan's line opens the version it posted, as the request page's does. */}
        {line.kind === 'spec' && msg.specShare?.sessionId ? (
          <>{' · '}<button type="button" className="dev-request-event-link" onClick={() => controller()?.openSharedSpec?.(msg.specShare?.sessionId, msg.specShare?.version, msg.specShare?.previewTitle)}>{t('project:topic.request.stream.read')}</button></>
        ) : null}
        {msg.time ? <span className="dev-request-event-time" title={msg.timeTitle}>{` · ${msg.time}`}</span> : null}
      </span>
    </div>
  );
});

/**
 * #4455: a change's stream. Under the change (the topic head, drawn above
 * this host) comes "N replies", then every reply and every thing that
 * happened in the order it happened: a person's message is the Messages
 * row, a vote, the ask for approval, the preview being ready or a notice is
 * one line. While nobody else can see the change, the stream is the one
 * line that says so (`lead.change.closed`).
 */
export function ChangeRows({ view }: { view: TranscriptView }) {
  const rows = useMemo(() => changeStream(foldRepeats(view.messages)), [view.messages]);
  const count = changeReplyCount(rows);
  const lead = view.lead.change;
  const loaded = !!lead?.loaded;
  const t = useMessages('project');
  if (lead?.closed) {
    return (
      <>
        <div className="messages-reply-count" data-change-replies="0"><span>{t('project:topic.change.stream.noReplies')}</span></div>
        <p className="dev-change-closed-note">{lead.closed}</p>
      </>
    );
  }
  const drawn: ReactNode[] = [];
  let previous: TranscriptMessage | null = null;
  rows.forEach((msg, i) => {
    const key = msg.id != null ? `m${msg.id}` : `i${i}`;
    if (msg.kind === 'message') {
      const grouped = !!previous && previous.kind === 'message' && !msg.deleted && !previous.deleted
        && !!msg.at && !!previous.at
        && groupsWithPrevious(
          { author: previous.username, at: previous.at },
          { author: msg.username, at: msg.at, reply: !!msg.quote },
        );
      drawn.push(<MessageRow key={key} msg={msg} grouped={grouped} surface="thread" />);
    } else {
      drawn.push(<ChangeEvent key={key} msg={msg} />);
    }
    previous = msg;
  });
  return (
    <>
      <div className="messages-reply-count" data-change-replies={count}>
        <span>{count ? t('project:topic.change.stream.replies', { count }) : loaded ? t('project:topic.change.stream.noReplies') : t('project:topic.change.stream.loading')}</span>
      </div>
      {view.lead.earlier ? (
        <div className="text-center py-1">
          <button type="button" id="gc-thread-earlier" className="messages-load-older" onClick={() => controller()?.loadThreadHistoryForOpen?.()}>
            {t('project:topic.change.stream.loadEarlier')}
          </button>
        </div>
      ) : null}
      {view.lead.error ? (
        <div role="alert" className="gc-history-error flex items-center gap-2 px-4 py-2 text-xs text-zinc-500 dark:text-zinc-400">
          <span>{view.lead.error}</span>
          <Button type="button" variant="neutral" size="xsText" ink="neutral" onClick={() => controller()?.loadThreadHistoryForOpen?.()}>
            {t('core:common.tryAgain')}
          </Button>
        </div>
      ) : null}
      <div className="dev-request-stream dev-change-stream">{drawn}</div>
    </>
  );
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
  const t = useMessages('chat');
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
  const quiet = (main || chat) && view.lead.quiet && !view.messages.some((m) => m.kind === 'message' && !m.openApp)
    ? view.lead.quiet
    : null;
  // The general chat's "New" line: above the first message after where
  // reading stood when the channel opened (`lead.unread`), or above the
  // first row drawn after it when that message is not drawn itself. The
  // pane opens with it near the top (mount.ts openAtUnreadLine).
  const unread = main ? view.lead.unread : null;
  const lineAt = useMemo(
    () => (unread ? firstUnreadId(view.messages.map(transcriptRow), unread.lastReadId) : null),
    [unread, view.messages],
  );
  let lineDrawn = lineAt === null;
  const drawn: ReactNode[] = [];
  // #4417: the cards drawn by time (a merged topic's), oldest first, each
  // before the first row written after it. One older than every loaded row
  // waits for "Load earlier" to reach it, unless the history is all here.
  const markers = useMemo(
    () => (view.lead.markers || []).filter((m) => m && Number.isFinite(Date.parse(m.at)))
      .slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    [view.lead.markers],
  );
  let marker = 0;
  const markersBefore = (row: TranscriptMessage | null) => {
    const at = row && row.at ? Date.parse(row.at) : Infinity;
    while (marker < markers.length && Date.parse(markers[marker].at) <= at) {
      const m = markers[marker];
      marker += 1;
      if (Number.isFinite(at) && !drawn.length && (view.lead.earlier || view.lead.moreBefore)) continue;
      drawn.push(<TranscriptMarkerCard key={`marker-${m.key}`} marker={m} />);
    }
  };
  // The row the next one groups under; a thread-activity card resets it, so
  // the message after a card always carries its own name.
  let previous: TranscriptMessage | null = null;
  for (let i = 0; i < rows.length; i += 1) {
    // #2387 follow-up: in the general chat a reply-thread reply is drawn
    // where it landed — one card for a run of replies to one thread with
    // nothing else said between them. A deleted reply leaves the run.
    const replyOf = main ? rows[i].replyOf : null;
    if (markers.length) markersBefore(rows[i]);
    if (!lineDrawn && rows[i].id != null && (rows[i].id as number) >= (lineAt as number)) {
      lineDrawn = true;
      drawn.push(<NewMessagesDivider key="unread-line" />);
    }
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
          <span>{replies ? t('chat:group.thread.replies', { count: replies }) : t('chat:group.thread.noReplies')}</span>
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
            {t('chat:group.history.loadEarlier')}
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
            {t('core:common.tryAgain')}
          </Button>
        </div>
      ) : null}
      {drawn}
      {markers.length ? <TrailingMarkers markers={markers.slice(marker)} /> : null}
      {quiet ? <QuietCard {...quiet} /> : null}
    </>
  );
}

/** #4417: the cards newer than every loaded row, after them. */
function TrailingMarkers({ markers }: { markers: TranscriptMarker[] }) {
  return <>{markers.map((m) => <TranscriptMarkerCard key={`marker-${m.key}`} marker={m} />)}</>;
}

/** #4417: one card drawn by time: a topic merged into this one. */
function TranscriptMarkerCard({ marker }: { marker: TranscriptMarker }) {
  if (marker.kind === 'merged-topic') return <MergedTopicCard from={marker.from} at={marker.at} />;
  return null;
}
