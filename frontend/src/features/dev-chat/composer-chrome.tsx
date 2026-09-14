/**
 * `#dc-quick-replies` and `#dc-runner` — the two strips above the dev chat's
 * send row — as the only React writers below those hosts.
 * See ./composer-chrome-store.ts for the split.
 */

import { useStoreState } from '../../lib/use-store-state';
import {
  quickRepliesStore,
  runnerStore,
  type QuickRepliesState,
  type RunnerState,
} from './composer-chrome-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).DevChat : null) || null;
}

/**
 * The pills.
 *
 * NO onClick: `_wireQuickReplies` binds one delegated `click` on the bar,
 * once per `renderChatView`, and reads `data-quick-reply-idx` off whichever
 * pill was hit. The bar outlives every repaint of its contents, so the
 * listener belongs there — and the index is the whole contract with it.
 */
export function QuickRepliesView({ replies }: QuickRepliesState) {
  return (
    <>
      {replies.map((reply, i) => (
        <button
          key={`${i}:${reply}`}
          type="button"
          className="dc-quick-pill"
          data-quick-reply-idx={i}
        >
          {reply}
        </button>
      ))}
    </>
  );
}

export function QuickReplies() {
  return <QuickRepliesView {...useStoreState<QuickRepliesState>(quickRepliesStore)} />;
}

/**
 * The pills WITH their bar, for a caller whose element is React's.
 *
 * `dc-quick-replies-active` is what gives the strip a height; an empty bar
 * keeps the node — `_wireQuickReplies` finds it by id and binds the delegated
 * click there — and no class. Same split as ../attachments/pending-strip.tsx's
 * two exports, and the same reason: the composer owns the element now, the
 * transcript-era portal host did not.
 */
export function QuickRepliesBar() {
  const { replies } = useStoreState<QuickRepliesState>(quickRepliesStore);
  return (
    <div
      id="dc-quick-replies"
      className={replies.length ? 'dc-quick-replies dc-quick-replies-active' : 'dc-quick-replies'}
    >
      <QuickRepliesView replies={replies} />
    </div>
  );
}

const PAST_TITLE = (label: string) =>
  `The last turn ran on ${label}. That machine has detached, so the next turn runs on Homeroom.`;

const LIVE_TITLE = (label: string) =>
  `Spec and coding turns in this session run on ${label}, using its own Claude subscription. `
  + 'A spec turn is read-only; after a coding turn Homeroom still opens the PR, builds the '
  + 'preview and runs the checks.';

export function RunnerControlsView({ kind, label }: RunnerState) {
  if (kind === 'none') return null;
  if (kind === 'past') {
    return (
      <span className="dc-runner-chip dc-runner-chip-past" title={PAST_TITLE(label)}>
        {`Last turn: ${label}`}
      </span>
    );
  }
  return (
    <>
      <label className="text-xs text-zinc-500 dark:text-zinc-400" htmlFor="dc-runner-select">
        Run on:
      </label>
      {/*
          Picking "Homeroom" is a HAND-BACK, not a selection: the module puts
          the value straight back to `local` and asks for confirmation, because
          releasing the lease is destructive and the select must not look like
          it already happened. That is why this is `value` + a snap-back rather
          than a controlled field over a store.
      */}
      <select
        id="dc-runner-select"
        className="rounded bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-2 focus:ring-violet-500"
        defaultValue="local"
        onChange={(e) => {
          if (e.target.value !== 'platform') return;
          e.target.value = 'local';
          controller()?._handBackToUsernode?.();
        }}
      >
        <option value="local">{label}</option>
        <option value="platform">Homeroom</option>
      </select>
      <span className="dc-runner-chip" title={LIVE_TITLE(label)}>Running on your machine</span>
    </>
  );
}

export function RunnerControls() {
  return <RunnerControlsView {...useStoreState<RunnerState>(runnerStore)} />;
}

/**
 * The strip WITH its host span, for a caller whose element is React's.
 *
 * `#dc-runner` renders even in the `none` state, which is most sessions: it
 * is what `_renderRunnerControls` looks up to decide there is a composer at
 * all, and `.dc-runner:empty` collapses it — so the ordinary composer row is
 * exactly what it was, with an empty span in it that draws nothing.
 */
export function RunnerControlsBar() {
  return <span id="dc-runner" className="dc-runner"><RunnerControls /></span>;
}
