/**
 * `#cli-tokens-list` — the CLI / coding-agent credential rows, as the only
 * React writer below that host.
 *
 * The host is STATIC in the React tree (sections/cli.tsx), so this is a plain
 * child component rather than a portal: there is nothing to mount, and nothing
 * outside React writes here any more. settings.js keeps the keyset fetch, the
 * DELETE and the status line; this file keeps the markup.
 *
 * `Settings._revokeCliToken` is called BY NAME on `window.Settings` for the
 * reason ./grants-list.tsx gives: settings.js is a classic-shaped module
 * loaded before this bundle and cannot be imported. It already owns its own
 * disable-on-click, its refetch and its status reporting, so the component
 * hands it the id and the button and forgets.
 *
 * Each credential is the shared row (ListRow): its hint over what it is and
 * when it was last used, and Revoke at the end. The local-agent setup guide
 * lives beside this host in sections/cli.tsx so it never depends on list
 * state.
 */

import { GroupedList, ListRow } from '@/components/ui/grouped-list';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { cliTokensStore } from './cli-tokens-store.js';

type CliTokenView = {
  id: string | null;
  hint: string;
  detail: string;
  revocable: boolean;
};

type CliTokensState = { phase: 'idle' | 'loading' | 'ready'; tokens: CliTokenView[] };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Settings : null) || null;
}

export function CliTokensListView({ phase, tokens }: CliTokensState) {
  const t = useMessages('settings');
  if (phase === 'idle') return null;
  // A bare text node, as `list.textContent = 'Loading credentials…'` produced.
  if (phase === 'loading') return <>{t('settings:cli.tokens.loading')}</>;
  if (!tokens.length) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('settings:cli.tokens.empty')}</p>;
  }
  return (
    <GroupedList className="mx-0">
      {tokens.map((token, i) => (
        <ListRow
          // A revoked credential leaves the list on the refetch, so `id` is
          // stable for every row that has one; the demo rows have none and
          // never change, so their index is as stable as they are.
          key={token.id || `demo:${i}`}
          title={token.hint}
          titleClassName="font-mono"
          subtitle={token.detail}
          subtitleClassName="whitespace-normal"
          // Demo rows (staging ?demo=1) are fabricated server-side and have
          // nothing to revoke — they get no button.
          trailing={token.revocable ? (
            <button
              type="button"
              className="shrink-0 rounded bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900 px-2 py-1 text-xs font-medium text-red-700 dark:text-red-400 transition-colors touch-target-32"
              onClick={(e) => controller()?._revokeCliToken?.(token.id, e.currentTarget)}
            >
              {t('settings:cli.tokens.revoke')}
            </button>
          ) : undefined}
          chevron={false}
        />
      ))}
    </GroupedList>
  );
}

export function CliTokensList() {
  return <CliTokensListView {...useStoreState<CliTokensState>(cliTokensStore)} />;
}
