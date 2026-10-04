/**
 * `#app-content`'s placeholder states — what the App tab shows when there is
 * no running app to frame.
 *
 * Five of them: spinning up, awaiting secrets, failed to start, not
 * available, and offline-with-no-app-worker. `renderAppTab` built each as an
 * `innerHTML` string and then bound two buttons by id afterwards, because
 * the branch re-renders on every status change and a delegated listener
 * would have re-attached. A sixth since #15: the first version, being built
 * by the Homeroom bot from the project's description, with a line or two on
 * where it is, the way into the bot's DM for its creator, and the starter
 * for anyone who wants it anyway.
 *
 * ── Why this can own `#app-content` ────────────────────────────────────
 *
 * That host is SHARED: the four Dev sub-views mount their own frames into
 * it, and `showLaunchCoverShot` still writes it by hand. It is single-owner
 * anyway, at the boundary rather than at a node inside it — every path into
 * `#app-content` runs `_teardownDevRoots()` first, exactly the way
 * `AdminConsole._renderSection` tears the previous section down before
 * mounting the next. The ownership audit's entry is scoped with `when` for
 * the same reason.
 *
 * ── What is NOT here ───────────────────────────────────────────────────
 *
 * The launch cover (`showLaunchCoverShot`) stays a string builder: it is the
 * one launch surface with no app behind it, `_launchCoverHtml` has four
 * other callers, and `insertAdjacentHTML`-ing a cover BESIDE a live iframe
 * is the whole point of that path — the frame must survive.
 */

import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { useStoreState } from '../../lib/use-store-state';
import { PlanCardView } from '../messages/bot-plan-view';
import type { HomeroomBotPlanQuestion } from '../messages/types';
import { appStatusStore } from './app-status-store.js';

/** The resolved placeholder. `null` means some other owner has the host. */
export interface AppStatusView {
  /** `creating` and `awaiting` share the amber dot; `error` gets the red one. */
  dot: 'creating' | 'error' | null;
  message: string;
  /** The missing secret names, or the failure reason — one mono red line. */
  detail: string | null;
  /**
   * Plain lines under the message, which then reads as the screen's title
   * (#15: the first version's step, and what comes next).
   */
  lines?: string[];
  /**
   * At most one, and only for a viewer who can act on it. `botChat` opens
   * the viewer's DM with the Homeroom bot (#15), by its id when known.
   */
  action: {
    key: 'secrets' | 'buildLog' | 'botChat';
    label: string;
    slug: string;
    conversationId?: number | null;
  } | null;
  /** A quieter way on, under the action (#15: the starter, for now). */
  secondary?: { key: 'starter'; label: string; slug: string } | null;
  /**
   * B6: the plan a first version waits on, for its creator: the same card as
   * in their chat with Homeroom bot, whose Build it is decided the same way.
   */
  plan?: FirstVersionPlan | null;
}

export interface FirstVersionPlan {
  appName: string;
  slug: string;
  bullets: string[];
  questions: HomeroomBotPlanQuestion[];
  actionId: number;
  messageId: number | null;
  conversationId: number | null;
}

/** B6: the plan, with its taps handed to AppView (buildFirstVersion, changeFirstVersionPlan). */
function FirstVersionPlanCard({ plan }: { plan: FirstVersionPlan }): ReactNode {
  // Pressed here until the screen reads the project again and moves on.
  const [pressed, setPressed] = useState(false);
  return (
    <div className="mt-3 flex w-full justify-center">
      <PlanCardView
        surface="app"
        appName={plan.appName}
        plan={{ bullets: plan.bullets, questions: plan.questions }}
        state="open"
        busy={pressed}
        onBuild={(answers) => {
          setPressed(true);
          call('buildFirstVersion', plan.slug, plan.actionId, answers);
        }}
        onChange={() => call('changeFirstVersionPlan', plan.slug, plan.conversationId, plan.messageId)}
      />
    </div>
  );
}

function call(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

/** Each action's id (the declared checks select on the first two) and its opener on AppView. */
const ACTIONS = {
  secrets: { id: 'awaiting-open-secrets', opener: 'openAwaitingSecrets' },
  buildLog: { id: 'app-error-build-log', opener: 'openAppBuildLog' },
  botChat: { id: 'app-first-version-chat', opener: 'openBotChat' },
} as const;

export function AppStatusView_({ view }: { view: AppStatusView }): ReactNode {
  const action = view.action;
  const titled = !!view.lines?.length;
  return (
    <div className="flex flex-col items-center justify-center h-full text-zinc-500 dark:text-zinc-400 gap-2 p-4 text-center">
      {view.dot ? <div className={`status-dot ${view.dot}`}></div> : null}
      <p className={titled ? 'max-w-sm text-base font-semibold text-zinc-900 dark:text-zinc-100' : 'text-sm'}>{view.message}</p>
      {titled ? view.lines!.map((line) => <p key={line} className="max-w-sm text-sm">{line}</p>) : null}
      {view.plan ? <FirstVersionPlanCard key={view.plan.actionId} plan={view.plan} /> : null}
      {view.detail ? (
        <p className="text-xs font-mono text-red-700 max-w-md break-words dark:text-red-400">{view.detail}</p>
      ) : null}
      {action ? (
        <Button
          id={ACTIONS[action.key].id}
          className="mt-3"
          onClick={() => call(ACTIONS[action.key].opener, action.slug, action.conversationId ?? null)}
        >
          {action.label}
        </Button>
      ) : null}
      {view.secondary ? (
        <Button
          id="app-first-version-starter"
          variant="neutral"
          ink="neutral"
          className={action ? '' : 'mt-3'}
          onClick={() => call('showStarter', view.secondary!.slug)}
        >
          {view.secondary.label}
        </Button>
      ) : null}
    </div>
  );
}

export function AppStatus(): ReactNode {
  const { view } = useStoreState<{ view: AppStatusView | null }>(appStatusStore);
  return view ? <AppStatusView_ view={view} /> : null;
}
