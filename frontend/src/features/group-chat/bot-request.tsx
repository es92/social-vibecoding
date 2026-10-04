import type { BotRequestCard, BotRequestChip } from './transcript-store';

/*
 * B9: a request asked of Homeroom bot in a project's chat, on the message
 * that asked it (services/homeroom-bot-chat.js).
 *
 * THE CHIP is what everybody in the room sees, first in the message's
 * reactions row: its status, set by the server alone, never a reaction
 * anybody can add or toggle, in the bot's own periwinkle rather than the
 * accent a reaction of yours wears. An emoji with a word, so it does not read
 * as one. Ready is a Try it chip that opens the change's preview for anyone.
 * When the work stops the chip goes; the requester's card and their chat with
 * the bot say why.
 *
 * THE CARD is under the requester's own message only, "Only you can see
 * this": what was taken from it and how long it usually takes, or the
 * question it asks first. It is read from their own requests, never from the
 * room's messages, so nobody else's transcript can hold it.
 */

const CHIP_CLASS = 'inline-flex items-center gap-1 rounded-full bg-[color:var(--brand-tint)] px-2.5 py-0.5 text-[0.8125rem] font-semibold text-[color:var(--brand-ink)]';

const CHIP_WORDS: Record<Exclude<BotRequestChip['status'], 'ready'>, { glyph: string; word: string }> = {
  reading: { glyph: '👀', word: 'Reading' },
  building: { glyph: '🔨', word: 'Building' },
  live: { glyph: '✅', word: 'Live' },
};

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
  const { glyph, word } = CHIP_WORDS[chip.status];
  const label = `Homeroom bot: ${word}`;
  return mine ? (
    <button type="button" className={CHIP_CLASS} data-bot-request={chip.status} aria-label={label} onClick={() => onProgress?.()}>
      <span aria-hidden="true">{glyph}</span>
      <span>{word}</span>
    </button>
  ) : (
    <span className={CHIP_CLASS} data-bot-request={chip.status} aria-label={label}>
      <span aria-hidden="true">{glyph}</span>
      <span>{word}</span>
    </span>
  );
}

/** Pure: what a card says. */
export function cardWords(card: BotRequestCard): string {
  switch (card.kind) {
    case 'filed':
      return `Got it: ${card.title || 'your request'}.${card.typicalMinutes ? ` Usually about ${card.typicalMinutes} minutes.` : ''}`;
    case 'group':
      return `Filed as a request for the group: ${card.title || 'your request'}.`;
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
}

export function BotRequestCardView({ card, actions = {} }: { card: BotRequestCard; actions?: BotRequestCardActions }) {
  const buttons: Array<{ key: string; label: string; primary?: boolean; act?: () => void }> = [];
  if (card.kind === 'filed') buttons.push({ key: 'progress', label: 'See progress', act: actions.onProgress });
  if (card.kind === 'group' && card.issueNumber) buttons.push({ key: 'request', label: 'See request', act: () => actions.onRequest?.(card.issueNumber as number) });
  if (card.kind === 'unsure') {
    buttons.push({ key: 'file', label: 'File it', primary: true, act: actions.onFile });
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
      <p className="text-[0.9375rem] leading-[1.35] text-zinc-900 dark:text-zinc-100">{cardWords(card)}</p>
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
