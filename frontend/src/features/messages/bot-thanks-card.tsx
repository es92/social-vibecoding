import { useEffect, useState, type ReactNode } from 'react';

import type { BuildLineState } from '../first-session/build-line';
import { ThumbRow } from '../first-session/sketch-card';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { ACTIVITY_OUTCOME_LABELS } from './bot-activity';
import { cardRecord, ensureBotActivity, loadBotActivity, readsAsked, useBotActivity } from './bot-activity-store';
import type { ConversationMessage, HomeroomBotActivity, HomeroomBotMeta } from './types';

/*
 * #4392: the bot's thanks for answering a first version's plan.
 *
 * Build it, tapped on the plan or typed under it, moves the request's
 * activity card under the plan (services/homeroom-bot-activity.js
 * cardUnderPlan). Until now that card was not drawn at all: its words
 * reached only the inbox's preview and the push, so the chat said nothing
 * after Build it. Now it is a message the maker sees: its words ("Building
 * it now. I'll tell you when it's ready to try.", the server's), then a card for the app, the thumbnail row the hub draws
 * (../first-session/sketch-card.tsx ThumbRow: the icon tile in the
 * project's colour, and its name) with the build line under the name
 * (../first-session/build-line.tsx). The line follows the build from the
 * card's own state, read as every activity card is: "Building it · usually
 * 10 to 25 min", then "Testing it", then "Ready to try". A build that ended
 * any other way says how, in the activity card's words, with no spinner.
 *
 * The plan above keeps its step line and Notify me (./bot-plan.tsx): this
 * card is where the chat answers the tap, the plan is where the step is
 * counted.
 */

// How long building a first version usually takes, as the progress module
// says it (services/homeroom-bot-progress.js TYPICAL_MINUTES.building).
export const BUILD_TYPICAL_MINUTES = { from: 10, to: 25 } as const;

// The stages of a build being tested, and of one up to try
// (services/homeroom-bot-progress.js STEP_OF_STAGE's checks and vote).
const TESTING_STAGES = new Set(['checks', 'checks_failed', 'fix_queued', 'fixing']);
const READY_STAGES = new Set(['followup_queued', 'revising', 'vote', 'merging']);

/** What the card's line says: a build line (with a note after it), or the words a build that ended otherwise ended with. */
export interface ThanksLine {
  line: BuildLineState | null;
  note: string | null;
  words: string | null;
}

/** Whether a message is the bot's thanks under a plan. */
export function isThanksMessage(message: ConversationMessage): boolean {
  const meta = message.metadata?.homeroomBot;
  return !!message.sender.bot && meta?.kind === 'activity' && !!meta.thanks && !meta.movedTo && !message.deleted;
}

/**
 * Pure: the line under the app's name, from its activity card (null while
 * the first read has not landed: it was just sent, so it is building).
 * `known` false is a card the reads no longer answer for: no line.
 */
export function thanksLine(card: HomeroomBotActivity | null | undefined, known = true): ThanksLine {
  const building: ThanksLine = {
    line: 'building', note: translate('messages:bot.thanks.usually', { from: BUILD_TYPICAL_MINUTES.from, to: BUILD_TYPICAL_MINUTES.to }), words: null,
  };
  if (!card) return known ? building : { line: null, note: null, words: null };
  if (card.state === 'working') {
    const stage = card.stage || '';
    if (TESTING_STAGES.has(stage)) return { line: 'testing', note: null, words: null };
    if (READY_STAGES.has(stage)) return { line: 'ready', note: null, words: null };
    return building;
  }
  switch (card.outcome) {
    case 'checking': return { line: 'testing', note: null, words: null };
    case 'proposed':
    case 'going_live': return { line: 'ready', note: null, words: null };
    case 'live': return { line: 'live', note: null, words: null };
    default: return { line: null, note: null, words: card.outcome ? translate(ACTIVITY_OUTCOME_LABELS[card.outcome]) : null };
  }
}

// Complete literals only: Tailwind's extractor reads source text.
const CARD = 'mt-2 flex max-w-[480px] flex-col rounded-[20px] bg-[color:var(--messages-surface)] p-3 shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';

/** Pure: the words, then the app's card with its line. */
export function BotThanksCardView({ meta, line, words = null }: {
  meta: HomeroomBotMeta;
  line: ThanksLine;
  /** The message's own words, as the row draws them. */
  words?: ReactNode;
}) {
  const t = useMessages('messages');
  const name = meta.appName || meta.appSlug || t('messages:bot.thanks.unnamedProject');
  return (
    <div data-bot-thanks={line.line || (line.words ? 'ended' : 'none')}>
      {words}
      <div className={CARD} role="group" aria-label={name} data-bot-thanks-card="">
        <ThumbRow
          name={name}
          colorKey={meta.appSlug || name}
          emoji={meta.appEmoji || null}
          line={line.line}
          lineNote={line.note}
          tagline={line.words}
        />
      </div>
    </div>
  );
}

/** The thanks, kept current with its activity card's state. */
export function BotThanksCard({ message, words = null }: { message: ConversationMessage; words?: ReactNode }) {
  // Subscribed: thanksLine reads its words as this renders.
  useMessages('messages');
  const snap = useBotActivity();
  const [drawnAt] = useState(readsAsked);
  const known = cardRecord(snap, message.id, drawnAt);
  useEffect(() => { ensureBotActivity(); }, []);
  // Sent after the last read was asked for: ask once more, as the activity card does.
  useEffect(() => {
    if (known === 'pending' && snap.loaded && readsAsked() === drawnAt) void loadBotActivity();
  }, [known, snap.loaded, drawnAt]);
  const meta = message.metadata?.homeroomBot;
  if (!meta) return null;
  return <BotThanksCardView meta={meta} line={thanksLine(snap.cards.get(message.id), known !== 'none')} words={words} />;
}
