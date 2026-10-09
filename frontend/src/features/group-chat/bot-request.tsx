import { waitingWords } from '../messages/approval-words';
import { releaseSentence } from '../../lib/release-eta';
import { useReleaseNow } from '../../lib/use-release-now';
import type { BotRequestCard, BotRequestChip, BotRequestState } from './transcript-store';

/*
 * B9: a request asked of Homeroom bot in a project's chat, on the message
 * that asked it (services/homeroom-bot-chat.js). WP-C: or an idea of a
 * newcomer's, which their card offers to suggest to the group.
 *
 * THE CHIP is what everybody in the room sees, first in the message's
 * reactions row: its status, set by the server alone, never a reaction
 * anybody can add or toggle, in the bot's own periwinkle rather than the
 * accent a reaction of yours wears. An emoji and a sentence that says who has
 * the message and what it is doing ("Homeroom bot is looking at this"), so
 * the room can tell from the chip alone that the bot took it. It said one
 * word ("👀 Reading") until 5 October 2026, when the person who suggested an
 * idea read it as part of their private card and asked for the group to be
 * told the bot had it (CHIP_WORDS). Ready is a Try it chip that opens the
 * change's preview for anyone. When the work stops the chip goes; the
 * requester's card and their chat with the bot say why.
 *
 * THE CARD is under the requester's own message only, "Only you can see
 * this": what was taken from it and how long it usually takes, or the
 * question it asks first. It is read from their own requests, never from the
 * room's messages, so nobody else's transcript can hold it. Just after a
 * request is filed it also says that the chip is everybody's (SHARED_LINE).
 *
 * The card follows its request (`state`, read from the platform's records
 * each time the card is: homeroom-bot-chat.js cardsOf): building, built and
 * testing, built and waiting for approval (from whom, with Try it), live,
 * or what stopped it. A fix asked on one of the bot's changes still waiting
 * for approval (`revise`) says it goes into that change, and follows it the
 * same way. Its chip, Fixing, is everybody's: the fix was asked in public.
 *
 * A request filed while its project's first version is not live waits for
 * it (`waiting_first_version`, homeroom-bot.js firstVersionHolds): the card
 * says so in the DM's words, and the chip says Homeroom bot has it, never
 * that it is looking at it.
 */

// `max-w-full`: on a narrow phone a sentence wraps inside the chip rather
// than running past the message.
const CHIP_CLASS = 'inline-flex max-w-full items-center gap-1 rounded-full bg-[color:var(--brand-tint)] px-2.5 py-0.5 text-left text-[0.8125rem] font-semibold text-[color:var(--brand-ink)]';

/**
 * What each chip says (`words`), and what a screen reader hears (`said`)
 * when the words alone leave out who has it or why it waits. Every chip but
 * Live names Homeroom bot: the room learns from it that the bot has the
 * message. Each fits on one line under a message on a 390px phone.
 */
export const CHIP_WORDS: Readonly<Record<Exclude<BotRequestChip['status'], 'ready'>, { glyph: string; words: string; said?: string }>> = Object.freeze({
  reading: { glyph: '👀', words: 'Homeroom bot is looking at this' },
  building: { glyph: '🔨', words: 'Homeroom bot is building this' },
  fixing: { glyph: '🔧', words: 'Homeroom bot is fixing this' },
  waiting_first_version: {
    glyph: '⏳',
    words: 'Homeroom bot has this',
    said: 'Homeroom bot has this, and starts on it once the first version is live',
  },
  live: { glyph: '✅', words: 'Live', said: 'Homeroom bot built this, and it’s live' },
});

/** Pure: what a screen reader hears for a chip (the Try it button says Try it). */
export function chipLabel(status: Exclude<BotRequestChip['status'], 'ready'>): string {
  const { words, said } = CHIP_WORDS[status];
  return said || words;
}

/** What a request held for its project's first version waits for (the DM card's words). */
export const FIRST_VERSION_WAIT_LINE = 'Waiting for the first version to go live. I’ll start on this as soon as it does.';

export function BotStatusChip({ chip, mine = false, onTry, onProgress }: {
  chip: BotRequestChip;
  mine?: boolean;
  onTry?: (sessionId: number) => void;
  /** The requester's own chip opens their progress card in the bot's chat. */
  onProgress?: () => void;
}) {
  if (chip.status === 'ready') {
    return (
      <button
        type="button"
        className={CHIP_CLASS}
        data-bot-request={chip.status}
        disabled={!chip.sessionId}
        onClick={() => { if (chip.sessionId) onTry?.(chip.sessionId); }}
      >
        <span aria-hidden="true">▶</span>
        <span>Try it</span>
      </button>
    );
  }
  const { glyph, words } = CHIP_WORDS[chip.status];
  const label = chipLabel(chip.status);
  return mine ? (
    <button type="button" className={CHIP_CLASS} data-bot-request={chip.status} aria-label={label} onClick={() => onProgress?.()}>
      <span aria-hidden="true">{glyph}</span>
      <span>{words}</span>
    </button>
  ) : (
    <span className={CHIP_CLASS} data-bot-request={chip.status} aria-label={label}>
      <span aria-hidden="true">{glyph}</span>
      <span>{words}</span>
    </span>
  );
}

/** WP-C: under somebody's first request on a project. */
export const STAYS_LINE = 'It stays in the project’s requests with your name on it.';

/**
 * Under a request the bot has just taken (sharedNow): the card is theirs
 * alone, but the chip on their message is the room's. 5 October 2026: an
 * idea suggested with Suggest it read as if it had stayed private.
 */
export const SHARED_LINE = 'Everyone here can see Homeroom bot has it.';

// The stages at which a filed request's card still says "Got it": the bot
// has it and has not started building. Its chip names the bot for the room.
const JUST_FILED = new Set(['waiting_first_version', 'reading', 'waiting']);

/** Pure: whether a card says that the room can see the bot has it (SHARED_LINE). */
export function sharedNow(card: BotRequestCard): boolean {
  return card.kind === 'filed' && !!card.issueNumber && (!card.state?.stage || JUST_FILED.has(card.state.stage));
}

/**
 * Pure: who a built change still waits on, in the DM's ready card's words
 * (../messages/approval-words.ts, as ../messages/bot-ready.tsx waitingLine
 * says it): "Waiting for approval from you and @jordan." when it needs every
 * one of them, "Needs one more approval from @priya or @mo." when any of
 * them will do, and nobody named once it has the approvals it needs.
 */
export function approvalWords(state?: BotRequestState): string {
  if (state?.missing === 0) return 'It has the approvals it needs.';
  const words = waitingWords({
    you: !!state?.youApprove, names: state?.waitingOn || [], more: state?.more, missing: state?.missing, needed: state?.needed,
  });
  return words ? `${words}.` : 'Waiting for approval.';
}

/**
 * Pure: an approved change's next words. A merge of the platform's own app
 * waits for the platform's next release and says when (`release`,
 * ../../lib/release-eta.ts): "Merged; goes live in the next release (about 8
 * minutes)." Any other approved change goes live in a minute or two.
 */
function goingLiveWords(state: BotRequestState | undefined, now: number): string {
  const words = state?.release ? releaseSentence(state.release, now) : null;
  return words ? `${words}.` : 'It’s going live.';
}

/** Pure: a request the bot builds, where it stands. */
function filedWords(card: BotRequestCard, stays: string, now: number): string {
  const title = card.title || 'your request';
  switch (card.state?.stage) {
    case 'waiting_first_version': return `Got it: ${title}. ${FIRST_VERSION_WAIT_LINE}${stays}`;
    case 'waiting': return `Got it: ${title}. Waiting for a free builder.${stays}`;
    case 'building': return `Building it now: ${title}.${stays}`;
    case 'question': return 'I have a question about this. It’s in our chat.';
    case 'checking': return `Built: ${title}. Testing it now.`;
    case 'proposed': return `Built: ${title}. ${approvalWords(card.state)}`;
    case 'approved': return `Approved: ${title}. ${goingLiveWords(card.state, now)}`;
    case 'live': return `Live: ${title}.`;
    case 'closed': return `Closed: ${title}. It won’t go live.`;
    case 'person': return 'I left this for the group to decide.';
    case 'stopped': return 'I couldn’t finish this. Our chat says why.';
    default:
      return `Got it: ${title}.${card.typicalMinutes ? ` Usually about ${card.typicalMinutes} minutes.` : ''}${stays}`;
  }
}

/** Pure: the change a fix went to: "the first version", or its name. */
function changeName(card: BotRequestCard): string {
  if (card.firstVersion) return 'the first version';
  return card.title ? `“${card.title}”` : 'that change';
}

/** Pure: a fix sent to one of the bot's changes, where it stands. */
function reviseWords(card: BotRequestCard, now: number): string {
  const it = changeName(card);
  const It = it.charAt(0).toUpperCase() + it.slice(1);
  switch (card.state?.stage) {
    case 'checking': return `Updated ${it}. Testing it now.`;
    case 'proposed': return `Updated ${it}. ${approvalWords(card.state)}`;
    case 'asked': return `I have a question about your fix. It’s in the discussion of ${it}.`;
    case 'answered': return `I answered you in the discussion of ${it}.`;
    case 'person': return `I left your fix to ${it} for the group to decide.`;
    case 'approved': return `${It} was approved. ${goingLiveWords(card.state, now)}`;
    case 'live': return `${It} is live.`;
    case 'closed': return `${It} was closed. It won’t go live.`;
    case 'stopped': return `I couldn’t finish fixing ${it}.`;
    default: return `Got it. I’ll fix that in ${it} before it goes live.`;
  }
}

/** Pure: what a card says. */
export function cardWords(card: BotRequestCard, now: number = Date.now()): string {
  const stays = card.first ? ` ${STAYS_LINE}` : '';
  switch (card.kind) {
    case 'filed':
      return filedWords(card, stays, now);
    case 'revise':
      return reviseWords(card, now);
    case 'revise_refused':
      return `I couldn’t change ${changeName(card)} just now. You can say what you want in its discussion.`;
    case 'group':
      return `Filed as a request for the group: ${card.title || 'your request'}.${stays}`;
    case 'offer':
      return card.title
        ? `Suggest this to the group? It goes in the project’s requests as “${card.title}”, in your name.`
        : 'Suggest this to the group? It goes in the project’s requests, in your name.';
    case 'unsure':
      return `Want me to file this as a request?${card.title ? ` ${card.title}` : ''}`;
    case 'question':
      return 'I answer questions in our chat.';
    case 'busy':
      return 'You’ve asked me for a lot in the last hour. Try again in a little while.';
    default:
      return 'I couldn’t file it just now. Try again in a minute.';
  }
}

export interface BotRequestCardActions {
  onProgress?: () => void;
  onRequest?: (issueNumber: number) => void;
  onFile?: () => void;
  onDismiss?: () => void;
  onOpenChat?: () => void;
  /** Its change's preview, once it is built. */
  onTry?: (sessionId: number) => void;
  /** The change a fix went to: its page and its discussion. */
  onChange?: (sessionId: number) => void;
}

// The stages a request's card offers See progress at: it is still going.
const GOING = new Set(['waiting_first_version', 'reading', 'waiting', 'building', 'checking']);

export function BotRequestCardView({ card, actions = {} }: { card: BotRequestCard; actions?: BotRequestCardActions }) {
  // An approved merge of Homeroom itself counts down to the platform's next release.
  const now = useReleaseNow(card.state?.stage === 'approved' ? card.state.release : null);
  const buttons: Array<{ key: string; label: string; primary?: boolean; act?: () => void }> = [];
  const stage = card.state?.stage;
  const change = card.state?.sessionId || card.sessionId || null;
  const tryIt = { key: 'try', label: 'Try it', primary: true, act: () => { if (change) actions.onTry?.(change); } };
  const seeChange = { key: 'change', label: 'See change', act: () => { if (change) actions.onChange?.(change); } };
  if (card.kind === 'filed') {
    if (stage === 'proposed' && change) buttons.push(tryIt);
    else if (stage === 'question' || stage === 'stopped') buttons.push({ key: 'chat', label: 'Open chat', act: actions.onOpenChat });
    else if ((stage === 'closed' || stage === 'person') && card.issueNumber) {
      buttons.push({ key: 'request', label: 'See request', act: () => actions.onRequest?.(card.issueNumber as number) });
    } else if (!stage || GOING.has(stage)) buttons.push({ key: 'progress', label: 'See progress', act: actions.onProgress });
  }
  if ((card.kind === 'revise' || card.kind === 'revise_refused') && change && stage !== 'live' && stage !== 'approved') {
    if (stage === 'proposed') buttons.push(tryIt);
    buttons.push(seeChange);
  }
  if (card.kind === 'group' && card.issueNumber) buttons.push({ key: 'request', label: 'See request', act: () => actions.onRequest?.(card.issueNumber as number) });
  if (card.kind === 'unsure') {
    buttons.push({ key: 'file', label: 'File it', primary: true, act: actions.onFile });
    buttons.push({ key: 'not-now', label: 'Not now', act: actions.onDismiss });
  }
  if (card.kind === 'offer') {
    buttons.push({ key: 'file', label: 'Suggest it', primary: true, act: actions.onFile });
    buttons.push({ key: 'not-now', label: 'Not now', act: actions.onDismiss });
  }
  if (card.kind === 'question') buttons.push({ key: 'chat', label: 'Open chat', act: actions.onOpenChat });
  if (card.kind === 'failed') buttons.push({ key: 'again', label: 'Try again', act: actions.onFile });
  return (
    <div
      className="mt-1.5 flex max-w-[480px] flex-col gap-2 rounded-2xl bg-[color:var(--messages-surface)] px-3 py-2.5"
      role="group"
      aria-label="Homeroom bot, only you can see this"
      data-bot-request-card={card.kind}
    >
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        <img className="h-4 w-4 rounded" src="/brand/homeroom-mark.png" alt="" aria-hidden="true" />
        <span>Only you can see this</span>
      </div>
      <p className="text-[0.9375rem] leading-[1.35] text-zinc-900 dark:text-zinc-100">{cardWords(card, now)}</p>
      {sharedNow(card) ? (
        <p className="text-[0.8125rem] leading-snug text-zinc-500 dark:text-zinc-400" data-bot-request-shared="">{SHARED_LINE}</p>
      ) : null}
      {buttons.length ? (
        <div className="messages-bot-answers" role="group" aria-label="Choices">
          {buttons.map((b) => (
            <button
              key={b.key}
              type="button"
              className={b.primary ? 'messages-bot-primary' : 'messages-bot-secondary'}
              data-bot-request-action={b.key}
              onClick={() => b.act?.()}
            >
              <span>{b.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
