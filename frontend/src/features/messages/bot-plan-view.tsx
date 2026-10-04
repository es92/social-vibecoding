import { useState } from 'react';

import type { HomeroomBotPlan } from './types';

/*
 * B6: a first version's plan, before anything is built.
 *
 * Homeroom bot reads a new project's description and sends its creator the
 * plan first: 3 to 5 plain bullets of what the first version will do, up to
 * two choices with the suggested answer marked, then Build it and Change
 * something. Nothing is built until Build it. The same card is drawn in the
 * creator's chat with the bot (./bot-plan.tsx) and on the project's App tab
 * while its first version waits (../app-frame/app-status.tsx), and both send
 * the tap to the same endpoint, which decides it once
 * (services/homeroom-bot-dm.js decidePlanTap).
 *
 * A CHIP IS A CHOICE, NOT A SEND. Tapping one fills it and nothing goes
 * anywhere until Build it, which takes the choices tapped; a question left
 * alone goes with its suggested answer. Change something is the card's
 * owner's to wire: in the chat it quotes the card in the composer, on the
 * App tab it opens the chat to do the same.
 *
 * Once its buttons go, the card says why in one quiet line: built, replaced
 * by a newer plan (its bullets fold away), stopped after a week with no tap
 * (its bullets stay), changes asked for, or no longer needed.
 *
 * Pure: no store, so the App tab draws it without the Messages screen.
 */

export type PlanCardState = 'open' | 'built' | 'replaced' | 'stopped' | 'changing' | 'closed';

/** What the line under a card that is no longer open says. */
export const PLAN_STATE_LINES: Record<Exclude<PlanCardState, 'open' | 'replaced'>, string> = {
  built: 'You chose Build it',
  stopped: 'I stopped waiting on this plan. Reply to pick it up again.',
  changing: 'You asked for changes. A new plan is on its way.',
  closed: 'No longer needed.',
};

export interface PlanCardViewProps {
  appName: string;
  plan: HomeroomBotPlan;
  state: PlanCardState;
  /** Built: the answer each choice went with, in order. */
  choices?: string[];
  /** Build it was pressed here and is on its way. */
  busy?: boolean;
  /** Build it, with the answer tapped for each choice (null for one left alone). */
  onBuild?: (answers: Array<string | null>) => void;
  onChange?: () => void;
  /** The chat's bubble surface, or the App tab's card. */
  surface?: 'messages' | 'app';
}

// Complete literals only: Tailwind's extractor reads source text.
const SURFACES = {
  messages: 'mt-1 flex max-w-[480px] flex-col gap-3 rounded-2xl bg-[color:var(--messages-surface)] px-3 py-3 text-left',
  app: 'flex w-full max-w-sm flex-col gap-3 rounded-[20px] bg-[color:var(--dc-sheet-solid)] px-4 py-4 text-left shadow-[inset_0_0_0_1px_var(--app-sheet-line)]',
} as const;

export function PlanCardView({
  appName, plan, state, choices = [], busy = false, onBuild, onChange, surface = 'messages',
}: PlanCardViewProps) {
  const [picked, setPicked] = useState<Array<string | null>>(() => plan.questions.map(() => null));
  const open = state === 'open' && !busy;
  const shown: PlanCardState = busy ? 'built' : state;

  function choose(index: number, answer: string) {
    setPicked((current) => current.map((value, i) => (i === index ? answer : value)));
  }

  return (
    <div className={SURFACES[surface]} role="group" aria-label={`Plan for ${appName}`} data-bot-plan={shown}>
      <div>
        <div className={`text-[0.9375rem] font-semibold ${shown === 'replaced' ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-900 dark:text-zinc-100'}`}>
          {`Here’s my plan for ${appName}:`}
        </div>
        {shown === 'replaced' ? (
          <p className="messages-bot-answered">Replaced by a newer plan</p>
        ) : (
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[0.9375rem] leading-[1.35] text-zinc-900 dark:text-zinc-100">
            {plan.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}
          </ul>
        )}
      </div>
      {open ? plan.questions.map((q, index) => (
        <div key={q.question}>
          <p className="text-[0.9375rem] font-medium text-zinc-900 dark:text-zinc-100">{q.question}</p>
          <div className="mt-1.5 messages-bot-answers" role="group" aria-label={q.question}>
            {q.answers.map((answer, j) => (
              <button
                key={answer}
                type="button"
                aria-pressed={picked[index] === answer}
                data-bot-answer={j === 0 ? 'default' : 'other'}
                onClick={() => choose(index, answer)}
              >
                <span>{answer}</span>
                {j === 0 ? <span className="messages-bot-default">suggested</span> : null}
              </button>
            ))}
          </div>
        </div>
      )) : null}
      {shown === 'built' && choices.length ? (
        <ul className="space-y-0.5 text-[0.8125rem] text-zinc-500 dark:text-zinc-400">
          {plan.questions.map((q, i) => (choices[i] ? <li key={q.question}>{`${q.question} ${choices[i]}`}</li> : null))}
        </ul>
      ) : null}
      {open ? (
        <div className="messages-bot-answers" role="group" aria-label="Actions">
          <button type="button" className="messages-bot-primary" data-bot-plan-build="" onClick={() => onBuild?.(picked)}>Build it</button>
          <button type="button" className="messages-bot-secondary" data-bot-plan-change="" onClick={() => onChange?.()}>Change something</button>
        </div>
      ) : null}
      {shown !== 'open' && shown !== 'replaced' ? <p className="messages-bot-answered" role="status">{PLAN_STATE_LINES[shown]}</p> : null}
    </div>
  );
}
