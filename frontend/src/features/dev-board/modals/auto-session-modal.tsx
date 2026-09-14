/**
 * `#auto-session-modal` — the Generate-proposal confirmation.
 *
 * The scrim, Escape key and backdrop click stay `public/js/app-view.js`'s
 * (see ./model.ts's header on the seam). React owns everything inside it.
 *
 * The ordinary confirmation is deliberately short: what will happen, which
 * model will do it, and who pays. The catalog moves behind “Change model” so
 * a normal Generate-proposal click does not confront the user with hundreds
 * of models, rates, compatibility labels, favorites and refresh controls.
 *
 * In the chooser, an empty search shows the small recommended set. Typing
 * searches every key-visible model passed by app-view.js — not favorites —
 * and clearing the field returns to recommendations.
 */

import { useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { DialogCard } from '@/components/ui/dialog';
import { CheckIcon, ChevronLeftIcon, InfoCircleIcon } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { useStoreState } from '../../../lib/use-store-state';
import { autoSessionModalStore } from './modals-store';
import type { AutoSessionModalView, ModelOption } from './model';

const MAX_VISIBLE_MODELS = 20;

function call(fn: string, ...args: unknown[]): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av[fn] === 'function') av[fn](...args);
}

/**
 * The proposal chooser's one filtering rule, exported so the full-catalog
 * guarantee can be pinned without coupling a test to React event internals.
 */
export function proposalModelMatches(
  options: ModelOption[],
  query: string,
  selectedId: string,
  openRouter = false,
): ModelOption[] {
  const needle = query.trim().toLocaleLowerCase();
  return options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => {
      if (!needle) {
        return !openRouter || option.isRecommended === true || option.id === selectedId;
      }
      return option.searchText.toLocaleLowerCase().includes(needle);
    })
    .sort((a, b) => {
      if (!!a.option.isRecommended !== !!b.option.isRecommended) {
        return a.option.isRecommended ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map(({ option }) => option);
}

interface ModelPickerProps {
  view: AutoSessionModalView;
  selectedId: string;
  onBack: () => void;
  onCancel: () => void;
  onUse: (modelId: string) => void;
}

/** The second step, exported only for deterministic server-rendered UI tests. */
export function AutoSessionModelPicker({
  view,
  selectedId,
  onBack,
  onCancel,
  onUse,
}: ModelPickerProps): ReactNode {
  const [query, setQuery] = useState('');
  const [draftId, setDraftId] = useState(selectedId);
  const matches = proposalModelMatches(view.options, query, draftId, view.openRouter === true);
  const visible = matches.slice(0, MAX_VISIBLE_MODELS);
  const draft = view.options.find((option) => option.id === draftId) || null;
  const searching = query.trim().length > 0;

  return (
    <DialogCard
      size="md"
      relative
      role="dialog"
      aria-modal="true"
      aria-labelledby="auto-session-picker-title"
    >
      <div className="mb-1 flex items-center gap-2">
        <Button
          type="button"
          variant="unstyled"
          size="icon"
          ink="none"
          aria-label="Back to proposal summary"
          onClick={onBack}
          className="-ml-2 rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
        >
          <ChevronLeftIcon className="h-5 w-5" aria-hidden="true" />
        </Button>
        <h2 id="auto-session-picker-title" className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
          Choose a model
        </h2>
      </div>
      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
        Recommended models are shown first. Search only if you need another model.
      </p>

      {view.personalOpenRouterKey === true ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-violet-200 bg-violet-50 p-3 text-xs leading-relaxed text-zinc-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-zinc-300">
          <InfoCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-violet-700 dark:text-violet-300" aria-hidden="true" />
          <div>
            <strong className="block font-semibold text-zinc-900 dark:text-zinc-100">
              Using your own OpenRouter key
            </strong>
            <p className="mt-0.5">
              Model availability follows your OpenRouter privacy settings. To exclude providers that may train on your data, review those settings.
            </p>
            <a
              href="https://openrouter.ai/settings/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block font-semibold text-violet-700 underline decoration-violet-300 underline-offset-2 hover:text-violet-600 dark:text-violet-300 dark:hover:text-violet-200"
            >
              Review privacy settings
            </a>
          </div>
        </div>
      ) : null}

      <Label htmlFor="auto-session-model-search" className="sr-only">Search models</Label>
      <Input
        id="auto-session-model-search"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        autoComplete="off"
        placeholder="Search all available models…"
        width="full"
      />

      <div className="mt-4 max-h-80 space-y-2 overflow-y-auto pr-1" role="radiogroup" aria-label="Available models">
        {visible.map((option) => {
          const selected = option.id === draftId;
          return (
            <label
              key={option.id}
              className={selected
                ? 'flex cursor-pointer items-center gap-3 rounded-lg bg-violet-50 p-3 text-left dark:bg-violet-950/40'
                : 'flex cursor-pointer items-center gap-3 rounded-lg bg-zinc-50 p-3 text-left hover:bg-zinc-100 dark:bg-zinc-800/60 dark:hover:bg-zinc-800'}
            >
              <input
                type="radio"
                name="auto-session-model"
                value={option.id}
                checked={selected}
                onChange={() => setDraftId(option.id)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className={selected
                  ? 'flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white'
                  : 'h-5 w-5 shrink-0 rounded-full border-2 border-zinc-300 dark:border-zinc-600'}
              >
                {selected ? <CheckIcon className="h-3.5 w-3.5" strokeWidth="3" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block break-words text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                  {option.name}
                </span>
                <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
                  {option.summary}
                </span>
              </span>
            </label>
          );
        })}
        {!visible.length ? (
          <p className="rounded-lg bg-zinc-50 px-3 py-5 text-center text-sm text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
            {searching ? 'No models match that search.' : 'No recommended models are available.'}
          </p>
        ) : null}
      </div>

      {matches.length > MAX_VISIBLE_MODELS ? (
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          {`Showing the first ${MAX_VISIBLE_MODELS} of ${matches.length} matches. Keep typing to narrow the list.`}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="neutral" ink="neutral" onClick={onCancel}>Cancel</Button>
        <Button
          type="button"
          disabled={!draft}
          aria-label={draft ? `Use ${draft.name}` : 'Use this model'}
          title={draft ? `Use ${draft.name}` : undefined}
          onClick={() => draft && onUse(draft.id)}
        >
          <span className="block max-w-36 truncate sm:max-w-52">
            {draft ? `Use ${draft.name}` : 'Use this model'}
          </span>
        </Button>
      </div>
    </DialogCard>
  );
}

export function AutoSessionCard({ view }: { view: AutoSessionModalView }): ReactNode {
  const [chosen, setChosen] = useState(view.preselect);
  const [choosing, setChoosing] = useState(false);
  const option = view.options.find((item) => item.id === chosen) || null;

  if (choosing) {
    return (
      <AutoSessionModelPicker
        view={view}
        selectedId={chosen}
        onBack={() => setChoosing(false)}
        onCancel={() => call('_autoSessionCancel')}
        onUse={(modelId) => {
          setChosen(modelId);
          setChoosing(false);
        }}
      />
    );
  }

  return (
    <DialogCard
      size="md"
      relative
      role="dialog"
      aria-modal="true"
      aria-labelledby="auto-session-title"
    >
      <h2 id="auto-session-title" className="mb-2 text-lg font-bold text-zinc-900 dark:text-zinc-100">
        {`Generate proposal for issue #${view.issueNumber}?`}
      </h2>
      <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">{view.intro}</p>

      {option ? (
        <div className="mb-3 flex items-center gap-4 rounded-lg bg-zinc-100 p-4 dark:bg-zinc-800">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Model</p>
            <p className="mt-0.5 break-words text-sm font-semibold text-zinc-900 dark:text-zinc-100">{option.name}</p>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{option.summary}</p>
          </div>
          {view.options.length > 1 ? (
            <Button
              type="button"
              variant="unstyled"
              size="inline"
              ink="none"
              onClick={() => setChoosing(true)}
              className="shrink-0 font-semibold text-violet-700 hover:text-violet-600 dark:text-violet-300 dark:hover:text-violet-200"
            >
              Change model
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="mb-5 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">
          <CheckIcon className="h-3.5 w-3.5" strokeWidth="3" aria-hidden="true" />
        </span>
        <span>{view.billingNote}</span>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          data-role="cancel"
          variant="neutral"
          ink="neutral"
          onClick={() => call('_autoSessionCancel')}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-role="confirm"
          disabled={!option}
          onClick={() => call('_autoSessionConfirm', option?.id || '')}
        >
          Generate proposal
        </Button>
      </div>
    </DialogCard>
  );
}

export function AutoSessionModal(): ReactNode {
  const { view } = useStoreState<{ view: AutoSessionModalView | null }>(autoSessionModalStore);
  if (!view) return null;
  // The centring wrapper carries `data-modal-backdrop`, which is what
  // app-view.js's dismiss rule looks for — the same attribute DialogRoot
  // renders for the nine static dialogs.
  return (
    <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
      <AutoSessionCard view={view} />
    </div>
  );
}
