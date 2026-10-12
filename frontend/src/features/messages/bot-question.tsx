import { useState } from 'react';

import { InfoCircleIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import { InviteSheet } from '../first-session/made';
import type { Made } from '../first-session/make';
import { AnsweredChoices } from './bot-plan-view';
import { answerBotQuestion, quoteInComposer, tapBotAction } from './store';
import type { ConversationMessage, HomeroomBotAction, HomeroomBotMeta } from './types';

/*
 * #3624: what hangs under a message from the Homeroom bot.
 *
 * A QUESTION carries its suggested answers as buttons, the bot's default
 * first and marked as such, and a "Write my own" that quotes the question
 * in the composer for an answer of one's own. Tapping an answer sends it at
 * once, quoting the question, which is how the server knows which request
 * it answers (services/homeroom-bot-dm.js). Once answered (or closed by
 * newer news on the same request) the buttons go and the answer stays:
 * #4197, a filled chip under a small "You answered" label, the tapped
 * answer's look without its button (./bot-plan-view.tsx AnsweredChoices).
 *
 * EVERY ANSWER IS PUBLIC, and the line under an open question says so
 * before anybody taps: the bot posts it on the request's discussion, where
 * the rest of the group reads it. A reply quoting any other message the bot
 * sent about a request is posted there too; the composer's reply bar says
 * that one (./composer.tsx).
 *
 * #3624 stage 2: an OFFER (kind `confirm`) uses the same buttons: File it
 * and Not now under a request the bot offers to file. Nothing is posted
 * anywhere until File it, so it has no public note, no "suggested" and no
 * Write my own (anything typed is read by the bot instead). #3770: File
 * it is the act, filled in the accent; Not now is the neutral fill beside
 * it. A question's answers keep one look: none of them is the act.
 * #11 (WP3): an offer to withdraw one of the bot's proposals is the same
 * pair, Withdraw it and Keep it, named by its own question.
 *
 * B3: buttons are real now. A message that carries `actions` draws them
 * (BotActions), and a tap is decided on the server, once, rather than sent
 * as the button's words in the person's name (store.tapBotAction). Then the
 * buttons give way to one quiet line, "You chose File it", on every device.
 * A message from before carries `answers` only and works as it did.
 */

/**
 * B3: the bot's news a reply is posted publicly for (services/homeroom-bot-
 * dm.js MIRRORED_KINDS): a question, and a message that asks for a reply to
 * look again with. A reply to any other news stays in the DM. Older messages
 * say `mirrors` on everything, so the kind decides here too.
 */
export const MIRRORED_KINDS: ReadonlySet<string> = new Set(['question', 'followup_ask', 'blocked', 'person', 'empty']);

/** Whether a reply quoting this bot message is posted on its request. */
export function mirrorsReplies(meta: HomeroomBotMeta | null | undefined): meta is HomeroomBotMeta {
  return !!meta?.mirrors && MIRRORED_KINDS.has(meta.kind);
}

export function botMeta(message: ConversationMessage): HomeroomBotMeta | null {
  if (!message.sender.bot) return null;
  const meta = message.metadata?.homeroomBot;
  return meta && typeof meta === 'object' ? meta : null;
}

/** "Homeroom request #12", the place an answer is posted. */
/** Where an answer or a reply is posted, one whole sentence per case. */
const POSTED_NOTES = {
  answer: {
    firstVersion: 'messages:bot.posted.answer.firstVersion',
    firstVersionUnnamed: 'messages:bot.posted.answer.firstVersionUnnamed',
    request: 'messages:bot.posted.answer.request',
    requestUnnamed: 'messages:bot.posted.answer.requestUnnamed',
  },
  answers: {
    firstVersion: 'messages:bot.posted.answers.firstVersion',
    firstVersionUnnamed: 'messages:bot.posted.answers.firstVersionUnnamed',
    request: 'messages:bot.posted.answers.request',
    requestUnnamed: 'messages:bot.posted.answers.requestUnnamed',
  },
  reply: {
    firstVersion: 'messages:bot.posted.reply.firstVersion',
    firstVersionUnnamed: 'messages:bot.posted.reply.firstVersionUnnamed',
    request: 'messages:bot.posted.reply.request',
    requestUnnamed: 'messages:bot.posted.reply.requestUnnamed',
  },
} as const;

/**
 * The line that says an answer, a pair of answers or a reply is posted on the
 * request's public discussion, naming the request it is posted on.
 */
export function postedNote(meta: HomeroomBotMeta, what: keyof typeof POSTED_NOTES): string {
  const ids = POSTED_NOTES[what];
  const project = meta.appName || meta.appSlug || '';
  if (meta.firstVersion) return project ? translate(ids.firstVersion, { project }) : translate(ids.firstVersionUnnamed);
  const number = String(meta.issueNumber);
  return project ? translate(ids.request, { project, number }) : translate(ids.requestUnnamed, { number });
}

export function BotQuestion({ message, conversationId, hidePrompts = false }: {
  message: ConversationMessage;
  conversationId: number;
  /**
   * #4046: a plan or a question in the chat offers its own answers now
   * (./bot-plan.tsx planLayout), so questions to tap give way until it is
   * answered.
   */
  hidePrompts?: boolean;
}) {
  const t = useMessages('messages');
  const meta = botMeta(message);
  // The answer tapped here, until the server's own state comes back.
  const [chosen, setChosen] = useState<string | null>(null);
  if (meta?.actions?.length) return <BotActions message={message} meta={meta} conversationId={conversationId} hidePrompts={hidePrompts} />;
  if (!meta || !meta.question) return null;
  const answers = (meta.answers || []).filter((a) => typeof a === 'string' && a.trim());
  const open = meta.status === 'open' && !chosen && !message.deleted;
  const answered = meta.status === 'answered' ? (meta.answer || chosen) : chosen;
  const offer = meta.kind === 'confirm';

  function choose(answer: string) {
    setChosen(answer);
    void answerBotQuestion(message, answer).catch(() => setChosen(null));
  }

  function writeOwn() {
    quoteInComposer(message, conversationId);
  }

  return (
    <div className="messages-bot-question" data-bot-question={meta.status || 'open'}>
      {open ? (
        <div className="messages-bot-answers" role="group" aria-label={offer ? (meta.question || t('messages:bot.question.fileRequest')) : t('messages:bot.question.suggestedAnswers')}>
          {answers.map((answer, index) => (
            <button
              key={answer}
              type="button"
              className={offer ? (index === 0 ? 'messages-bot-primary' : 'messages-bot-secondary') : undefined}
              data-bot-answer={index === 0 ? 'default' : 'other'}
              onClick={() => choose(answer)}
            >
              <span>{answer}</span>
              {index === 0 && !offer ? <span className="messages-bot-default">{t('messages:bot.question.suggested')}</span> : null}
            </button>
          ))}
          {offer ? null : <button type="button" className="messages-bot-other" onClick={writeOwn}>{t('messages:bot.question.writeOwn')}</button>}
        </div>
      ) : null}
      {answered && offer ? <p className="messages-bot-answered">{t('messages:bot.question.youChose', { answer: answered })}</p> : null}
      {answered && !offer ? <AnsweredChoices items={[{ question: t('messages:bot.question.youAnswered'), answer: answered }]} /> : null}
      {(open || chosen) && mirrorsReplies(meta) ? (
        <p className="messages-bot-note">
          <InfoCircleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{postedNote(meta, 'answer')}</span>
        </p>
      ) : null}
      {meta.status === 'closed' && !answered ? <p className="messages-bot-answered">{t('messages:bot.question.closed')}</p> : null}
    </div>
  );
}

/**
 * B3: a bot message's buttons (types.ts HomeroomBotAction). The act is
 * filled in the accent, the rest beside it in the neutral fill. A `server`
 * button is pressed once: the buttons go at once, the line says what was
 * chosen, and the message's own update (decided here or on another device)
 * keeps it that way. A refused press (decided already elsewhere) brings
 * nothing back: that device's choice arrives with the update.
 */
/*
 * Quoting `message` in the composer (store.quoteInComposer) puts the caret
 * there: a reply bar, for them to write what the message asks for, in the
 * request's thread when the message is in one. A phone gets the caret too,
 * since this is a request to type.
 */

/** Whether a message's buttons are all suggestions of what to say next (homeroom-bot-dm.js suggestsOnly). */
export function suggestsOnly(actions: readonly HomeroomBotAction[]): boolean {
  return actions.length > 0 && actions.every((action) => action.type === 'prompt' || action.type === 'reply');
}

function BotActions({ message, meta, conversationId, hidePrompts = false }: {
  message: ConversationMessage;
  meta: HomeroomBotMeta;
  conversationId: number;
  hidePrompts?: boolean;
}) {
  // The button pressed here, until the server's own state comes back.
  const t = useMessages('messages');
  const [pressed, setPressed] = useState<HomeroomBotAction | null>(null);
  // #4231: the invite sheet, opened in place by Invite people.
  const [inviting, setInviting] = useState(false);
  const actions = meta.actions || [];
  const invite = inviteMade(meta);
  const settled = meta.status === 'answered' || meta.status === 'closed';
  const open = !settled && !pressed && !message.deleted;
  const chosen = meta.status === 'answered' ? (meta.answer || null) : (pressed ? pressed.label : null);
  // B5: a question offered to tap reads back as asked, a choice as chosen.
  const chosenAction = actions.find((action) => action.id === meta.chosen) || pressed;
  const prompts = actions.length > 0 && actions.every((action) => action.type === 'prompt' && !action.quote);
  const suggestions = suggestsOnly(actions);
  // #4097 follow-up: suggestions the bot has moved on from (its newer
  // message closed them, homeroom-bot-dm.js retireSuggestions) go quietly;
  // "No longer needed." is for a decision that was overtaken.
  // A request's own step (Try again, Add detail, Go ahead) closed by newer
  // news about the same request says why in its place (`closedWhy`).
  const closedWhy = meta.status === 'closed' && !chosen ? meta.closedWhy || null : null;
  if (meta.status === 'closed' && !chosen && suggestions && !closedWhy) return null;
  // #4046: one set of suggestions at a time: while a plan or a question
  // offers its own answers, what to say next waits (a button that quotes,
  // such as Try again, is not a suggestion). Asked already, it still says so.
  if (open && hidePrompts && actions.every((action) => (action.type === 'prompt' && !action.quote) || action.type === 'reply')) return null;
  // A tap that is posted where the group reads it says so, before the tap.
  const posts = open && !!meta.mirrors && actions.some((action) => action.type === 'prompt' && action.quote);

  function press(action: HomeroomBotAction) {
    if (action.type === 'open') {
      void tapBotAction(message, action).catch(() => {});
      return;
    }
    // #4231: decided here, on the device, and the buttons stay.
    if (action.type === 'invite') {
      if (invite) setInviting(true);
      return;
    }
    // A reply to write: the message quoted in the composer. Nothing is
    // decided yet, so the buttons stay.
    if (action.type === 'reply') {
      quoteInComposer(message, conversationId);
      return;
    }
    // A prompt is their own message; the buttons give way at once, and the
    // server settles them on every device when it lands.
    setPressed(action);
    void tapBotAction(message, action).catch(() => setPressed(null));
  }

  return (
    <div className="messages-bot-question" data-bot-question={meta.status || 'open'}>
      {open ? (
        <div className="messages-bot-answers" role="group" aria-label={meta.question || (prompts ? t('messages:bot.actions.questionsYouCanAsk') : suggestions ? t('messages:bot.actions.whatNext') : t('messages:bot.actions.choices'))}>
          {actions.map((action, index) => (
            <button
              key={action.id}
              type="button"
              // B5: a prompt keeps the suggestion pill's look; a choice is
              // filled, and so is a step to take on the message ("Try again").
              className={action.type === 'prompt' && !action.quote ? undefined : action.style === 'primary' ? 'messages-bot-primary' : 'messages-bot-secondary'}
              data-bot-answer={index === 0 ? 'default' : 'other'}
              data-bot-prompt={action.type === 'prompt' ? '' : undefined}
              onClick={() => press(action)}
            >
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {posts ? (
        <p className="messages-bot-note">
          <InfoCircleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{postedNote(meta, 'answer')}</span>
        </p>
      ) : null}
      {chosen ? <p className="messages-bot-answered">{chosenAction?.type === 'prompt' && !chosenAction.quote ? t('messages:bot.actions.youAsked', { question: chosen }) : t('messages:bot.actions.youChose', { choice: chosen })}</p> : null}
      {meta.status === 'closed' && !chosen ? <p className="messages-bot-answered" data-bot-closed-why={closedWhy ? '' : undefined}>{closedWhy || t('messages:bot.actions.closed')}</p> : null}
      {inviting && invite ? (
        <InviteSheet made={invite} me={inviterName()} onClose={() => setInviting(false)} onSent={() => {}} />
      ) : null}
    </div>
  );
}

/**
 * #4231: the project an Invite people button invites to, as the first
 * session's invite sheet takes it (../first-session/made.tsx InviteSheet):
 * the message's own project, live already. Null without one.
 */
export function inviteMade(meta: HomeroomBotMeta): Made | null {
  const slug = meta.appSlug || '';
  if (!slug) return null;
  return {
    slug, name: meta.appName || slug, emoji: null, description: null, example: null, conversationId: null,
  };
}

/** The signed-in person's name, for the invite's "<name> made <project>" (empty: "Made: <project>"). */
function inviterName(): string {
  const name = typeof window !== 'undefined' ? window.App?.user?.username : null;
  return typeof name === 'string' ? name : '';
}
