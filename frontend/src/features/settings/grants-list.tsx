/**
 * `#llm-grants-list` — the App AI permissions rows, as the only React writer
 * below that host.
 *
 * The host is STATIC in the React tree (sections/app-ai.tsx), so this is a
 * plain child component rather than a portal: there is nothing to mount, and
 * nothing outside React writes here any more. settings.js keeps every fetch,
 * every POST/PATCH/DELETE and the confirm dialog; this file keeps the markup.
 *
 * The handlers are called BY NAME on `window.Settings` rather than passed in,
 * for the same reason the transcript calls `window.GroupChat`: settings.js is
 * loaded as a classic script before this bundle and cannot be imported. Each
 * one already does its own optimistic-revert and status reporting, so the
 * component hands it the value and forgets.
 *
 * Each app is the shared row (ListRow) in one grouped list: its name over
 * what it spent today, and under them (the row's children) the day's spend
 * bar, the cap and the actions. The `data-role` attributes are the ones the
 * string this once replaced carried.
 */

import { Button } from '@/components/ui/button';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { grantsStore } from './grants-store.js';
import { PermissionsEmpty } from './permissions-empty';

type GrantView = {
  appId: number;
  appName: string;
  appSlug: string;
  revoked: boolean;
  spent: string;
  spentCents?: number;
  cap: string;
  capValue: string;
  capCents: number;
  showByok: boolean;
  allowByok: boolean;
};

type GrantsState = { phase: 'idle' | 'loading' | 'error' | 'ready'; grants: GrantView[] };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

/**
 * What sits under an app's name: the spend bar, the note and the line of
 * controls, at the 12px the controls were drawn for.
 */
const BELOW = 'text-xs';

/*
 * #1957: the way back. A revoked row used to be the badge and nothing else —
 * re-approving happened only through the app's own consent dialog, which an
 * app that never asks again never opens. Re-enable re-grants through the same
 * POST that dialog uses (Settings._onGrantReenable), restoring the cap and
 * BYOK choice the row still carries, and the copy beside it says what comes
 * back so the click is an informed one.
 *
 * The button is the language's compact accent action — the `compact` + `xs`
 * string the App permissions rows' Re-enable writes, one card over. Revoke
 * above keeps its hand-written red tint because it is destructive; this is the
 * opposite act.
 */
function RevokedRow({ grant }: { grant: GrantView }) {
  const t = useMessages('settings');
  return (
    <ListRow
      title={grant.appName}
      tooltip={grant.appName}
      titleClassName="text-zinc-500 dark:text-zinc-500"
      subtitle={t('settings:grants.reenableNote', { cap: grant.cap })}
      subtitleClassName="whitespace-normal"
      trailing={(
        <span className="flex shrink-0 items-center gap-2 text-xs">
          <span className="shrink-0 rounded px-1.5 py-0.5 bg-zinc-200 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400">
            {t('settings:grants.revoked')}
          </span>
          <Button
            type="button"
            aria-label={t('settings:grants.reenableLabel', { app: grant.appName })}
            data-role="re-enable"
            layout="shrink"
            variant="compact"
            size="xs"
            onClick={() => { void controller()?._onGrantReenable?.(grant); }}
          >
            {t('settings:grants.reenable')}
          </Button>
        </span>
      )}
      chevron={false}
    />
  );
}

/** From this share of the daily cap, the row says the app is close to it. */
const NEAR_CAP = 0.8;

/**
 * #6512 item 6: how much of today's cap the app has used, as the bar
 * Settings > Usage draws for building time (./building-time.tsx), and in
 * words once it is close (80%) or there. The figures are the row's own: the
 * cap bounds both what the budget and the person's own key paid, which is
 * what `spentCents` adds up. A call that was running when the cap was
 * reached can end past it, so the bar stops at full.
 */
function capUse(grant: GrantView): { percent: number; level: 'under' | 'near' | 'at' } | null {
  const cap = Number(grant.capCents) || 0;
  if (!(cap > 0)) return null;
  const share = Math.max(0, Number(grant.spentCents) || 0) / cap;
  return {
    percent: Math.min(100, Math.floor(share * 100)),
    level: share >= 1 ? 'at' : share >= NEAR_CAP ? 'near' : 'under',
  };
}

function GrantRow({ grant }: { grant: GrantView }) {
  const t = useMessages('settings');
  const use = capUse(grant);
  return (
    <ListRow
      title={grant.appName}
      tooltip={grant.appName}
      subtitle={t('settings:grants.spentToday', { spent: grant.spent, cap: grant.cap })}
      subtitleClassName="font-mono"
      chevron={false}
    >
      <div className={BELOW}>
      {use ? (
        <div
          data-role="spend-bar"
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
          role="meter"
          aria-label={t('settings:grants.usedOfCapLabel', { app: grant.appName, percent: use.percent })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={use.percent}
        >
          <div
            className={use.level === 'under'
              ? 'h-full rounded-full bg-[color:var(--lit-ink)]'
              : 'h-full rounded-full bg-[color:var(--state-attention)]'}
            style={{ width: `${use.percent}%` }}
          />
        </div>
      ) : null}
      {use && use.level !== 'under' ? (
        <p data-role="cap-note" className="mt-1.5 text-zinc-600 dark:text-zinc-400">
          {use.level === 'at' ? t('settings:grants.atCap') : t('settings:grants.nearCap')}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2 mt-2 flex-wrap">
        <label className="flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
          {t('settings:grants.capLabel')}
          {/* #2437 widened tests/shell-primitive-adoption.test.js's field-box
              scan to the WHITE fill, which is the fill this row has always
              used — so this field, hand-written since the conversion, became
              visible to the rule for the first time. It renders the same class
              attribute, token for token: `w20` + `insetTight` + `mono` +
              `text`, with `ring={false}` because the string carried no focus
              rule and the browser's own outline is the cue. */}
          <Input
            aria-label={t('settings:grants.capFieldLabel', { app: grant.appName })}
            data-role="cap"
            type="number"
            min="0.01"
            step="0.01"
            defaultValue={grant.capValue}
            width="w20"
            box="insetTight"
            mono={true}
            ring={false}
            text={true}
            onChange={(e) => controller()?._onGrantCapChange?.(grant.appId, e.currentTarget.value)}
          />
        </label>
        {grant.showByok ? (
          <label className="flex items-center gap-1 cursor-pointer select-none text-zinc-600 dark:text-zinc-400">
            <input
              data-role="byok"
              type="checkbox"
              className="accent-violet-500 w-3.5 h-3.5"
              checked={grant.allowByok}
              onChange={(e) => controller()?._onGrantByokChange?.(grant.appId, e.currentTarget.checked)}
            />
            {t('settings:grants.useOwnKey')}
          </label>
        ) : null}
        {/*
            Filled, not a red outline — the language draws no outlined control
            (see the `neutral` variant in @/components/ui/button.tsx and the
            profile screen's six buttons). Revoke keeps its red because it IS
            destructive; only the box changed.
        */}
        <button
          type="button"
          aria-label={t('settings:grants.revokeLabel', { app: grant.appName })}
          data-role="revoke"
          className="rounded bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900 px-2 py-0.5 font-medium text-red-700 dark:text-red-400 transition-colors touch-target-32"
          onClick={() => { void controller()?._onGrantRevoke?.(grant.appId, grant.appName); }}
        >
          {t('settings:grants.revoke')}
        </button>
      </div>
      </div>
    </ListRow>
  );
}

export function GrantsListView({ phase, grants }: GrantsState) {
  const t = useMessages('settings');
  if (phase === 'idle') return null;
  if (phase === 'loading') return <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('core:common.loading')}</p>;
  if (phase === 'error') return <p className="text-xs text-red-700 dark:text-red-400">{t('settings:grants.loadFailed')}</p>;
  if (!grants.length) {
    return <PermissionsEmpty kind="ai">{t('settings:grants.empty')}</PermissionsEmpty>;
  }
  // #6512 item 6: what the apps spent between them, for the same day each
  // row's own figure covers (the cap is daily, so the total is today's). A
  // revoked app's spend from earlier today still counts: it was spent. With
  // nothing spent and no app still allowed, a zero would say nothing.
  const totalCents = grants.reduce((sum, g) => sum + (Number(g.spentCents) || 0), 0);
  const showTotal = totalCents > 0 || grants.some((g) => !g.revoked);
  return (
    <>
      {showTotal ? (
        <p data-role="spend-total" className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {t('settings:grants.totalToday', { spent: (totalCents / 100).toFixed(2) })}
        </p>
      ) : null}
      <GroupedList className="mx-0">
        {grants.map((g) => (
          g.revoked ? <RevokedRow key={g.appId} grant={g} /> : <GrantRow key={g.appId} grant={g} />
        ))}
      </GroupedList>
    </>
  );
}

export function GrantsList() {
  return <GrantsListView {...useStoreState<GrantsState>(grantsStore)} />;
}
