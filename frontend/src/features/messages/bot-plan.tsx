import { useEffect, useState } from 'react';

import { InfoCircleIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';
import * as api from './api';
import { ACTIVITY_OUTCOME_LABELS, isActivityMessage, isMovedActivity } from './bot-activity';
import { ensureBotActivity, useBotActivity } from './bot-activity-store';
import { changeKey } from './bot-shared';
import { botMeta, postedNote } from './bot-question';
import { AnsweredChoices, PlanCardView, type AnsweredChoice, type PlanCardState, type PlanProgress } from './bot-plan-view';
import { BotHeadWords, botHead } from './bot-head-card';
import { MessageMarkdown } from './format';
import { NotifyMe, notifyMeChosen } from './notify-me';
import { answerBotQuestion, quoteInComposer, useMessagesSnapshot } from './store';
import type { ConversationMessage, HomeroomBotActivity, HomeroomBotMeta } from './types';

/*
 * B6: two kinds of bot message that stand in place of their words, as the
 * activity card does (./message-row.tsx): their words still say the same for
 * the inbox, the push and search.
 *
 * A PLAN (kind `plan`): a first version's plan (or, #4488, a complicated
 * change's), waiting for Build it
 * (./bot-plan-view.tsx). Build it is decided on the server, once, from any
 * device (api.decideBotAction with the choices picked); Change something
 * quotes the card in the composer, and the reply is read by the bot, never
 * posted on the request. #4488: a complicated change's plan, on a project
 * that already exists, is the request's: that reply is posted there.
 *
 * #4046: THE PLAN CARRIES ITS REQUEST'S STEP. A first version's activity
 * card begins when its request is queued, above the plan, and Build it moves
 * it under the plan (services/homeroom-bot-activity.js cardUnderPlan). The
 * chat drew both: "Step 3 of 7 · Write a plan" on the card, the plan under
 * it, then the card again under the plan once it was built. Now the plan is
 * the one place its step shows (planLayout below): a card above its plan is
 * not drawn, the plan reads that card's state for the line at its top
 * (planProgress). The card Build it moved under the plan is drawn as the
 * bot's thanks for answering (#4392, ./bot-thanks-card.tsx: its words over
 * the app's thumbnail row and build line); one moved before the thanks
 * existed (no `thanks` in its metadata) is still not drawn. While it is
 * being built, "Notify me when it's ready" is inside the plan card
 * (BotPlanCard's footer, ./notify-me.tsx).
 *
 * #4046: ONE SET OF SUGGESTIONS. While a plan or a question offers its own
 * answers, the bot's generic questions to tap (its hello's "How long will
 * this take?" and the rest) are not drawn (planLayout `answersOpen`). The
 * server closes the hello's questions once the plan is sent (#4108,
 * homeroom-bot-dm.js retireSuggestions), so they do not come back after
 * Build it; a question still open then does.
 *
 * TWO QUESTIONS (a `question` carrying `questions`): a request the bot has
 * two questions about, answered together. Each is a row of answers to tap,
 * the suggested one marked; Build it sends the answers as one message
 * quoting the card (the way a tapped answer has always gone, and so posted
 * on the request's public discussion, which the note says), with the
 * suggested answer for any left alone (its button says Send answers, not
 * Build it: Build it starts building a plan and nothing else). Write my own
 * quotes it for answers of one's own. One question keeps BotQuestion's one tap (./bot-question.tsx).
 * #4197: answered, each question is a label over its answer's chip, read
 * back from the message's lines; an answer of one's own stays as written.
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

function capitalized(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Pure (#4046): how long a step usually takes, as the plan's line says it:
 * "10 to 25 min", or "about 3 min". Short, so the line stays on one line at
 * 375px (owner, 7 October); the activity card keeps its own words
 * (./bot-activity.tsx typicalText).
 */
export function planTime(range?: { from: number; to: number } | null): { kind: 'about' | 'range'; from: number; count: number } | null {
  if (!range || !(range.to > 0)) return null;
  return { kind: range.from >= range.to ? 'about' : 'range', from: range.from, count: range.to };
}

/** The built plan's progress line, one whole message per what it leads with and how the time is said. */
const PROGRESS_LINES = {
  stepNamed: { about: 'messages:bot.plan.progress.stepNamedAbout', range: 'messages:bot.plan.progress.stepNamedRange' },
  step: { about: 'messages:bot.plan.progress.stepAbout', range: 'messages:bot.plan.progress.stepRange' },
  working: { about: 'messages:bot.plan.progress.workingAbout', range: 'messages:bot.plan.progress.workingRange' },
  doing: { about: 'messages:bot.plan.progress.doingAbout', range: 'messages:bot.plan.progress.doingRange' },
} as const;

/**
 * Pure (#4046): the line at the top of a plan in `state`, from its request's
 * activity card (`card`, as the reads have it), or null for none. While the
 * plan waits: "Step 3 of 7". Once built: "Step 4 of 7 · Build it · 10 to 25
 * min" (the step, its name, how long it usually takes: one line on a phone,
 * planTime), or how it ended. A plan that stopped waiting says so in its
 * own line instead.
 */
export function planProgress(card: HomeroomBotActivity | null | undefined, state: PlanCardState): PlanProgress | null {
  if (!card || (state !== 'open' && state !== 'built')) return null;
  if (card.state === 'done') {
    return state === 'built' && card.outcome ? { line: translate(ACTIVITY_OUTCOME_LABELS[card.outcome]), step: null, of: null } : null;
  }
  const stepped = card.step && card.of ? { step: card.step, of: card.of } : null;
  if (state === 'open') return stepped ? { line: translate('messages:bot.plan.step', { step: stepped.step, total: stepped.of }), ...stepped } : null;
  const lead: keyof typeof PROGRESS_LINES = stepped ? (card.stepName ? 'stepNamed' : 'step') : card.doing ? 'doing' : 'working';
  const values = {
    step: stepped?.step ?? 0, total: stepped?.of ?? 0, name: card.stepName || '', doing: card.doing ? capitalized(card.doing) : '',
  };
  const time = planTime(card.typicalMinutes);
  const what = lead === 'stepNamed' ? translate('messages:bot.plan.stepNamed', values)
    : lead === 'step' ? translate('messages:bot.plan.step', values)
      : lead === 'doing' ? values.doing : translate('messages:bot.plan.working');
  return { line: time ? translate(PROGRESS_LINES[lead][time.kind], { ...values, from: time.from, count: time.count }) : what, step: stepped?.step ?? null, of: stepped?.of ?? null };
}

/**
 * Pure (#4046): whether a bot message offers its own answers to pick now: a
 * plan waiting for Build it, or an open question.
 */
export function offersAnswers(message: ConversationMessage): boolean {
  const meta = botMeta(message);
  if (!meta || message.deleted || meta.status !== 'open') return false;
  if (meta.kind === 'plan') return isPlanMessage(message) && planState(meta) === 'open';
  return meta.kind === 'question';
}

/** How a transcript draws its plans and the activity cards of their requests (planLayout). */
export interface PlanLayout {
  /** Activity cards whose step a plan of their request carries: not drawn. */
  hidden: ReadonlySet<number>;
  /** A request's newest plan, waiting or built, by message id: the card whose state it reads. */
  cardOf: ReadonlyMap<number, number>;
  /** A plan or a question offers its own answers: the bot's generic questions to tap give way. */
  answersOpen: boolean;
}

export const NO_PLAN_LAYOUT: PlanLayout = { hidden: new Set(), cardOf: new Map(), answersOpen: false };

/**
 * Pure (#4046): how the transcript `messages` draws its plans (see THE PLAN
 * CARRIES ITS REQUEST'S STEP above), by message id. Only the bot's own
 * messages count; a card Build it moved is left out already
 * (isMovedActivity). For each request with a plan:
 *
 *   - an activity card before its plan is not drawn: the plan carries it,
 *     and neither is one after a plan that waits for Build it or was built
 *     (the card that follows the build), unless it is the bot's thanks
 *     (#4392), which is always drawn;
 *   - the newest plan, waiting or built, reads the newest card's state.
 *
 * One request, one story: a plan posted in its request's thread (the card
 * is the thread's root, and the main chat may also show the plan there) hides
 * no card, since the card is the way into the thread, and reads the state of
 * the card it hangs off.
 */
export function planLayout(messages: readonly ConversationMessage[]): PlanLayout {
  const plans = new Map<string, ConversationMessage>();
  const cards = new Map<string, number[]>();
  const thanks = new Set<number>();
  const threadedPlans = new Map<number, number>();
  let answersOpen = false;
  for (const message of messages) {
    const meta = botMeta(message);
    if (!meta || message.deleted || !(message.id > 0)) continue;
    if (offersAnswers(message)) answersOpen = true;
    // #4564: the change a message is about, read the same way its change
    // block is (./bot-shared.ts changeKey), so the two cannot disagree.
    const key = changeKey(message);
    if (!key) continue;
    if (isPlanMessage(message)) {
      // In its request's thread: the card it hangs off, never hidden.
      if (message.threadRootId) {
        if (['open', 'built'].includes(planState(meta))) threadedPlans.set(message.id, message.threadRootId);
        continue;
      }
      const newest = plans.get(key);
      if (!newest || message.id > newest.id) plans.set(key, message);
    } else if (isActivityMessage(message) && !isMovedActivity(message)) {
      cards.set(key, [...(cards.get(key) || []), message.id]);
      if (meta.thanks) thanks.add(message.id);
    }
  }
  if (!plans.size && !threadedPlans.size) return answersOpen ? { ...NO_PLAN_LAYOUT, answersOpen } : NO_PLAN_LAYOUT;
  const hidden = new Set<number>();
  const cardOf = new Map<number, number>(threadedPlans);
  for (const [key, plan] of plans) {
    const ids = cards.get(key) || [];
    const carried = ['open', 'built'].includes(planState(botMeta(plan) as HomeroomBotMeta));
    for (const id of ids) if ((id < plan.id || carried) && !thanks.has(id)) hidden.add(id);
    const newest = Math.max(0, ...ids);
    if (newest && carried) cardOf.set(plan.id, newest);
  }
  return { hidden, cardOf, answersOpen };
}

/**
 * #4197: pure: two questions' answer, one "question answer" line each as
 * Build it sends it, back as pairs. Null for anything else (an answer typed
 * in one's own words), which is shown as written.
 */
export function answeredPairs(questions: ReadonlyArray<{ question: string }>, text: string | null | undefined): AnsweredChoice[] | null {
  const lines = String(text || '').split('\n');
  if (!questions.length || lines.length !== questions.length) return null;
  const pairs = questions.map((q, i) => {
    const line = lines[i];
    return line.startsWith(`${q.question} `) ? { question: q.question, answer: line.slice(q.question.length + 1).trim() } : null;
  });
  return pairs.every((pair) => pair && pair.answer) ? pairs as AnsweredChoice[] : null;
}

/**
 * Pure (#4227): whether the build a plan's Build it started is running now,
 * from its request's activity card in the transcript (the one moved under
 * the plan: services/homeroom-bot-activity.js cardUnderPlan): working, or
 * not read yet. Undefined when the transcript has no card for it, so the
 * plan card decides by its own press.
 */
export function planBuilding(
  meta: HomeroomBotMeta, messages: readonly ConversationMessage[], cards: ReadonlyMap<number, HomeroomBotActivity>,
): boolean | undefined {
  let newest: ConversationMessage | null = null;
  for (const m of messages) {
    if (!isActivityMessage(m) || isMovedActivity(m)) continue;
    const card = m.metadata?.homeroomBot;
    if (card?.appSlug !== meta.appSlug || Number(card?.issueNumber) !== Number(meta.issueNumber)) continue;
    if (!newest || m.id > newest.id) newest = m;
  }
  if (!newest) return undefined;
  const card = cards.get(newest.id);
  return !card || card.state === 'working';
}

/** Put the card in the composer's reply bar (its thread's, in a request's thread), and the caret after it. */
function quote(message: ConversationMessage, conversationId: number) {
  quoteInComposer(message, conversationId);
}

export function BotPlanCard({ message, conversationId, cardId = null }: {
  message: ConversationMessage;
  conversationId: number;
  /** #4046: its request's activity card, whose step it carries (planLayout). */
  cardId?: number | null;
}) {
  // Subscribed: the progress line is read from the catalog as this renders.
  useMessages('messages');
  const meta = botMeta(message);
  const [pressed, setPressed] = useState(false);
  const activity = useBotActivity();
  const { messages } = useMessagesSnapshot();
  const userId = typeof window !== 'undefined' ? Number(window.App?.user?.id) || null : null;
  // Decided when it is drawn: an account that chose here is not asked again.
  const [offer] = useState(() => !notifyMeChosen(userId));
  useEffect(() => { if (cardId) ensureBotActivity(); }, [cardId]);
  if (!meta?.plan) return null;
  const actionId = meta.actionId;
  const state = planState(meta, pressed);
  const card = cardId ? activity.cards.get(cardId) : null;

  function build(answers: Array<string | null>) {
    if (!actionId) return;
    setPressed(true);
    // A refusal (decided on another device, or the plan was replaced) brings
    // nothing back here: the card's own update says what happened.
    void api.decideBotAction(actionId, 'build', answers.map((a) => a || '')).catch(() => setPressed(false));
  }

  return (
    <PlanCardView
      appName={meta.appName || meta.appSlug || ''}
      plan={meta.plan}
      state={planState(meta)}
      choices={meta.choices}
      busy={pressed && meta.status !== 'answered'}
      building={planBuilding(meta, messages, activity.cards)}
      onBuild={build}
      onChange={() => quote(message, conversationId)}
      progress={planProgress(card, state)}
      footer={offer && state === 'built' && card && card.state !== 'done' ? <div className="mt-3"><NotifyMe userId={userId} /></div> : null}
    />
  );
}

export function BotTwoQuestions({ message, conversationId }: { message: ConversationMessage; conversationId: number }) {
  const t = useMessages('messages');
  const meta = botMeta(message);
  const questions = meta?.questions || [];
  const [picked, setPicked] = useState<Array<string | null>>(() => questions.map(() => null));
  const [sent, setSent] = useState<string | null>(null);
  if (!meta || questions.length < 2) return null;
  // #4097: the lead's request line is the request's card, as in any row.
  const head = meta.lead ? botHead(meta.lead, meta) : null;
  const open = meta.status === 'open' && !sent;
  const answered = meta.status === 'answered' ? (meta.answer || sent) : sent;
  const pairs = answered ? answeredPairs(questions, answered) : null;

  function build() {
    const text = questions.map((q, i) => `${q.question} ${picked[i] || q.answers[0]}`).join('\n');
    setSent(text);
    void answerBotQuestion(message, text).catch(() => setSent(null));
  }

  return (
    <div className="messages-bot-question" data-bot-question={meta.status || 'open'} data-bot-questions="2">
      {head ? <BotHeadWords head={head} objects={message.objects} />
        : meta.lead ? <MessageMarkdown content={meta.lead} appSlug={meta.appSlug} /> : null}
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
                {j === 0 ? <span className="messages-bot-default">{t('messages:bot.questions.suggested')}</span> : null}
              </button>
            ))}
          </div>
        </div>
      )) : pairs ? <AnsweredChoices items={pairs} className="mt-2" /> : (
        <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-[0.9375rem] text-zinc-900 dark:text-zinc-100">
          {questions.map((q) => <li key={q.question}>{q.question}</li>)}
        </ol>
      )}
      {open ? (
        <div className="mt-2.5 messages-bot-answers" role="group" aria-label={t('messages:bot.questions.actions')}>
          <button type="button" className="messages-bot-primary" data-bot-answer="build" onClick={build}>{t('messages:bot.questions.send')}</button>
          <button type="button" className="messages-bot-other" onClick={() => quote(message, conversationId)}>{t('messages:bot.questions.writeOwn')}</button>
        </div>
      ) : null}
      {answered && !pairs ? <p className="messages-bot-answered whitespace-pre-line">{t('messages:bot.questions.youAnswered', { answers: answered })}</p> : null}
      {meta.status === 'closed' && !answered ? <p className="messages-bot-answered">{t('messages:bot.questions.closed')}</p> : null}
      {open || sent ? (
        <p className="messages-bot-note">
          <InfoCircleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{postedNote(meta, 'answers')}</span>
        </p>
      ) : null}
    </div>
  );
}
