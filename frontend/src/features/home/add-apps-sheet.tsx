/**
 * "Add to My apps" — the sheet EDIT MODE's (#4669) trailing tile opens.
 *
 * The seam is the one features/auth/verify-identity.tsx uses: the kit owns
 * the sheet (PlatformUI.sheet), React owns what is in it, a legacy portal
 * mounted on open and dropped on dismiss. Published on
 * window.UsernodeReact.addAppsSheet.open for the legacy callers.
 *
 * The data is a SNAPSHOT taken when the sheet opens — the same Home._apps
 * the grid behind it renders from — and the rows' own state is local, so a
 * press can flip its row to "Added" without repainting the sheet's lists.
 * The write itself is Home.toggleAdded(slug, true), the same action the
 * Discover rails' + badges run: it flips the cached flags, repaints the
 * grid behind the sheet, and toasts. A failed add reverts in toggleAdded
 * and reloads; this sheet's row stays as its local state left it, which is
 * the same trade every optimistic row here makes.
 */

import { useState } from 'react';

import { CheckIcon } from '@/components/ui/icons';
import { Button } from '@/components/ui/button';
import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';

import { useMessages } from '../../lib/i18n/react';
import { t as message } from '../../lib/i18n/runtime';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { iconViewFor } from '../apps/app-card.js';
import type { IconView } from './grid-store';

function home(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

/**
 * The sheet's two lists, as data, so a test can read the decision without a
 * sheet. "Your other apps" is every app the viewer belongs to but does not
 * keep a tile for — the member pin hidden, a collaborator with the pin
 * hidden, an app they joined without pinning — and never a demo tile, which
 * has no DB row to favourite. "Popular" is Home.popularApps' answer with the
 * first list's slugs taken back out (a hidden-pin collaborator is not
 * "joined" and not "yours" as popularApps reads those words, so it can reach
 * both lists). A demo tile is offered by neither list: it has no DB row to
 * favourite, so its Add button would be the silent no-op toggleAdded's own
 * comment warns about.
 *
 * `Home` is read off window at call time, the way every consumer of it that
 * lives outside home.js reads it.
 */
export function addSheetLists(apps: unknown): { yours: any[]; popular: any[] } {
  const H = home();
  const list = Array.isArray(apps) ? apps : [];
  const yours = H && typeof H.isYours === 'function'
    ? list.filter((a) => a && !a.demo && !H.isYours(a) && (a.is_member || a.is_collaborator))
    : [];
  const taken = new Set(yours.map((a) => a.slug));
  const popular = H && typeof H.popularApps === 'function'
    ? (H.popularApps(list) || []).filter((a) => a && !a.demo && !taken.has(a.slug))
    : [];
  return { yours, popular };
}

/** The audience words the rest of the product uses for these three values. */
function audienceWords(audience: unknown): string {
  if (audience === 'open') return message('communities:sections.open.noun');
  if (audience === 'invited') return message('communities:sections.invited.noun');
  if (audience === 'solo') return message('communities:sections.solo.noun');
  return '';
}

function RowIcon({ icon }: { icon: IconView }) {
  if (icon.kind === 'image') {
    return <img src={icon.src} alt="" draggable={false} className="w-full h-full object-cover" />;
  }
  if (icon.kind === 'emoji') return <span className="text-2xl leading-none">{icon.emoji}</span>;
  return <>{icon.letter}</>;
}

function AddAppsSheet({ onBrowse }: { onBrowse: () => void }) {
  const t = useMessages('home');
  // One snapshot per opening; nothing re-renders the lists behind the
  // viewer's presses except their own.
  const [lists] = useState(() => addSheetLists(home()?._apps));
  const [added, setAdded] = useState<Set<string>>(() => new Set());

  const markAdded = (slug: string) => {
    setAdded((prev) => {
      const next = new Set(prev);
      next.add(slug);
      return next;
    });
    home()?.toggleAdded?.(slug, true);
  };

  const rows = (apps: any[]) => apps.map((a) => {
    const isAdded = added.has(a.slug);
    return (
      <ListRow
        key={a.slug}
        chevron={false}
        leading={(
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-zinc-100 font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            aria-hidden="true"
          >
            <RowIcon icon={iconViewFor(a)} />
          </span>
        )}
        title={a.name || a.slug}
        subtitle={audienceWords(a.audience) || undefined}
        trailing={isAdded ? (
          <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-zinc-400 dark:text-zinc-500">
            <CheckIcon className="h-4 w-4" aria-hidden="true" />
            <span>{t('home:addSheet.added')}</span>
          </span>
        ) : (
          <Button
            variant="pillAccent"
            size="xsText"
            className="shrink-0"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              markAdded(a.slug);
            }}
          >
            {t('home:addSheet.add')}
          </Button>
        )}
      />
    );
  });

  const empty = !lists.yours.length && !lists.popular.length;
  return (
    <div data-add-apps-sheet="" className="px-4 pb-5">
      <h2 className="pt-3 text-[17px] font-[650] text-zinc-900 dark:text-zinc-100">
        {t('home:addSheet.title')}
      </h2>
      {lists.yours.length ? (
        <>
          <SectionHeader>{t('home:addSheet.yours')}</SectionHeader>
          <GroupedList>{rows(lists.yours)}</GroupedList>
        </>
      ) : null}
      {lists.popular.length ? (
        <>
          <SectionHeader>{t('home:addSheet.popular')}</SectionHeader>
          <GroupedList>{rows(lists.popular)}</GroupedList>
        </>
      ) : null}
      {empty ? (
        <>
          <p className="py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
            {t('home:addSheet.empty')}
          </p>
          <div className="flex justify-center pb-2">
            <button
              type="button"
              className="text-[14px] font-semibold text-[color:var(--accent)] hover:underline un-touch-target"
              onClick={onBrowse}
            >
              {t('home:addSheet.browse')}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

type SheetKit = { sheet?: (opts: { contentEl: HTMLElement; onDismiss?: () => void }) => { dismiss: () => void } | null };

let openOnce: (() => void) | null = null;

/** Open the sheet, one at a time — a second tap while one is up is a no-op. */
export function openAddAppsSheet(): void {
  if (openOnce) return;
  const kit = (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
  if (!kit || typeof kit.sheet !== 'function' || typeof document === 'undefined') return;
  const panel = document.createElement('div');
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    openOnce = null;
    unmountLegacyPortal(panel);
  };
  openOnce = finish;
  const handle = kit.sheet({ contentEl: panel, onDismiss: finish });
  if (!handle) { finish(); return; }
  const leave = () => { finish(); handle?.dismiss(); };
  mountLegacyPortal(panel, (
    <AddAppsSheet
      onBrowse={() => {
        // One Home (#6361): the directory is Home's own Communities to join.
        leave();
        (window as unknown as { Home?: { showCommunitiesToJoin?: () => void } }).Home?.showCommunitiesToJoin?.();
      }}
    />
  ));
}

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.addAppsSheet = { open: openAddAppsSheet };
}
