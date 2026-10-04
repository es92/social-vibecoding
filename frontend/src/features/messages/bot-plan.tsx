import { useState } from 'react';

import { InfoCircleIcon } from '@/components/ui/icons';

import * as api from './api';
import { botMeta, requestPlace } from './bot-question';
import { PlanCardView, type PlanCardState } from './bot-plan-view';
import { MessageMarkdown } from './format';
import { answerBotQuestion, scopeKey, setReply } from './store';
import type { ConversationMessage, HomeroomBotMeta } from './types';

/*
 * B6: two kinds of bot message that stand in place of their words, as the
 * activity card does (./message-row.tsx): their words still say the same for
 * the inbox, the push and search.
 *
 * A PLAN (kind `plan`): a first version's plan, waiting for Build it
 * (./bot-plan-view.tsx). Build it is decided on the server, once, from any
 * device (api.decideBotAction with the choices tapped); Change something
 * quotes the card in the composer, and the reply is read by the bot, never
 * posted on the request.
 *
 * TWO QUESTIONS (a `question` carrying `questions`): a request the bot has
 * two questions about, answered together. Each is a row of answers to tap,
 * the suggested one marked; Build it sends the answers as one message
 * quoting the card (the way a tapped answer has always gone, and so posted
 * on the request's public discussion, which the note says), with the
 * suggested answer for any left alone. Something else quotes it for answers
 * of one's own. One question keeps BotQuestion's one tap (./bot-question.tsx).
 */

/** Whether a message is a plan the bot drew as its card. */
export function isPlanMessage(message: ConversationMessage): boolean {
  const meta = botMeta(message);
  return !!meta && meta.kind === 'plan' && !!meta.plan && !message.deleted;
}

/** Whether a message asks two questions at once. */
export function isTwoQuestions(message: ConversationMessage): boolean {
  const meta = botMeta(message);
  return !!meta && meta.kind === 'question' && (meta.questions?.length || 0) > 1 && !message.deleted;
}

/** Pure: a plan card's state, from its message (and a Build it pressed here, until the update lands). */
export function planState(meta: HomeroomBotMeta, pressed = false): PlanCardState {
  if (meta.status === 'answered' || pressed) return 'built';
  if (meta.replaced) return 'replaced';
  if (meta.stopped) return 'stopped';
  if (meta.changing) return 'changing';
  if (meta.status === 'closed' || !meta.actionId) return 'closed';
  return 'open';
}

/** Put the card in the composer's reply bar, and the caret after it. */
function quote(message: ConversationMessage, conversationId: number) {
  setReply(scopeKey(conversationId, null), message);
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLTextAreaElement>('.messages-composer-input')?.focus({ preventScroll: true });
  });
}

export function BotPlanCard({ message, conversationId }: { message: ConversationMessage; conversationId: number }) {
  const meta = botMeta(message);
  const [pressed, setPressed] = useState(false);
  if (!meta?.plan) return null;
  const actionId = meta.actionId;

  function build(answers: Array<string | null>) {
    if (!actionId) return;
    setPressed(true);
    // A refusal (decided on another device, or the plan was replaced) brings
    // nothing back here: the card's own update says what happened.
    void api.decideBotAction(actionId, 'build', answers.map((a) => a || '')).catch(() => setPressed(false));
  }

  return (
    <PlanCardView
      appName={meta.appName || meta.appSlug || 'your project'}
      plan={meta.plan}
      state={planState(meta)}
      choices={meta.choices}
      busy={pressed && meta.status !== 'answered'}
      onBuild={build}
      onChange={() => quote(message, conversationId)}
    />
  );
}

export function BotTwoQuestions({ message, conversationId }: { message: ConversationMessage; conversationId: number }) {
  const meta = botMeta(message);
  const questions = meta?.questions || [];
  const [picked, setPicked] = useState<Array<string | null>>(() => questions.map(() => null));
  const [sent, setSent] = useState<string | null>(null);
  if (!meta || questions.length < 2) return null;
  const open = meta.status === 'open' && !sent;
  const answered = meta.status === 'answered' ? (meta.answer || sent) : sent;

  function build() {
    const text = questions.map((q, i) => `${q.question} ${picked[i] || q.answers[0]}`).join('\n');
    setSent(text);
    void answerBotQuestion(message, text).catch(() => setSent(null));
  }

  return (
    <div className="messages-bot-question" data-bot-question={meta.status || 'open'} data-bot-questions="2">
      {meta.lead ? <MessageMarkdown content={meta.lead} appSlug={meta.appSlug} /> : null}
      {open ? questions.map((q, index) => (
        <div key={q.question} className="mt-2.5">
          <p className="text-[0.9375rem] font-medium text-zinc-900 dark:text-zinc-100">{q.question}</p>
          <div className="mt-1.5 messages-bot-answers" role="group" aria-label={q.question}>
            {q.answers.map((answer, j) => (
              <button
                key={answer}
                type="button"
                aria-pressed={picked[index] === answer}
                data-bot-answer={j === 0 ? 'default' : 'other'}
                onClick={() => setPicked((current) => current.map((value, i) => (i === index ? answer : value)))}
              >
                <span>{answer}</span>
                {j === 0 ? <span className="messages-bot-default">suggested</span> : null}
              </button>
            ))}
          </div>
        </div>
      )) : (
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-[0.9375rem] text-zinc-900 dark:text-zinc-100">
          {questions.map((q) => <li key={q.question}>{q.question}</li>)}
        </ol>
      )}
      {open ? (
        <div className="mt-2.5 messages-bot-answers" role="group" aria-label="Actions">
          <button type="button" className="messages-bot-primary" data-bot-answer="build" onClick={build}>Build it</button>
          <button type="button" className="messages-bot-other" onClick={() => quote(message, conversationId)}>Something else</button>
        </div>
      ) : null}
      {answered ? <p className="messages-bot-answered whitespace-pre-line">{`You answered:\n${answered}`}</p> : null}
      {meta.status === 'closed' && !answered ? <p className="messages-bot-answered">No longer needed.</p> : null}
      {open || sent ? (
        <p className="messages-bot-note">
          <InfoCircleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{`Your answers are posted on ${requestPlace(meta)}’s public discussion, where the group can see them.`}</span>
        </p>
      ) : null}
    </div>
  );
}
