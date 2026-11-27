import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/ui/field';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { useMessages } from '../../../lib/i18n/react';
import { agoStamp } from '../../../lib/timestamp';
import { PermissionsEmpty } from '../permissions-empty';

type BlockedApp = { slug: string; name: string; created_at?: string | null };

/**
 * One blocked app (#6512): the shared row, its name over when it was
 * blocked, and Unblock at its end. The date is the product's card form
 * (`agoStamp`: "3d ago", a date from a week on) with the full stamp on
 * hover, and is left out for a row with no stamp.
 */
export function BlockedAppRow({ app, busy, onUnblock }: {
  app: BlockedApp;
  busy: string | null;
  onUnblock: (app: BlockedApp) => void;
}) {
  const t = useMessages('settings');
  const when = agoStamp(app.created_at);
  return <ListRow
    title={app.name}
    tooltip={app.name}
    subtitle={when.text ? <time data-role="blocked-at" dateTime={app.created_at ?? undefined} title={when.title}>{t('settings:blockedApps.blockedAt', { when: when.text })}</time> : undefined}
    trailing={<Button type="button" layout="shrink" aria-label={busy === app.slug ? undefined : t('settings:blockedApps.unblockLabel', { app: app.name })} disabled={!!busy} onClick={() => onUnblock(app)}>{busy === app.slug ? t('settings:blockedApps.unblocking') : t('settings:blockedApps.unblock')}</Button>}
    chevron={false}
  />;
}
function BlockedAppsList() {
  const t = useMessages('settings');
  const host = useRef<HTMLDivElement>(null);
  const [apps, setApps] = useState<BlockedApp[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    const pane = host.current?.closest('[data-settings-section]');
    let seq = 0;
    async function load() {
      const current = ++seq;
      if (!pane || pane.classList.contains('hidden')) { setApps(null); return; }
      setError('');
      try {
        const response = await fetch('/api/me/app-blocks');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t('settings:blockedApps.loadFailed'));
        if (current === seq) setApps(data.apps);
      } catch (err) { if (current === seq) setError((err as Error).message); }
    }
    refresh.current = () => { void load(); };
    const observer = new MutationObserver(() => { void load(); });
    if (pane) observer.observe(pane, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('app-blocks-changed', refresh.current);
    void load();
    return () => { seq++; observer.disconnect(); window.removeEventListener('app-blocks-changed', refresh.current); };
  }, []);
  async function unblock(app: BlockedApp) {
    if (busy) return;
    setBusy(app.slug); setError('');
    try {
      const response = await fetch(`/api/me/app-blocks/${encodeURIComponent(app.slug)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('settings:blockedApps.unblockFailed'));
      setApps(current => current?.filter(row => row.slug !== app.slug) ?? null);
      window.dispatchEvent(new CustomEvent('app-blocks-changed', { detail: data }));
      (window as any).Home?.load?.();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }
  return <div ref={host} className="ui-card mt-4 space-y-3">
    {apps === null && !error ? <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('settings:blockedApps.loading')}</p> : null}
    {apps?.length === 0 ? <PermissionsEmpty kind="blocked">{t('settings:blockedApps.empty')}</PermissionsEmpty> : null}
    {apps?.length ? <GroupedList className="mx-0">{apps.map(app => <BlockedAppRow key={app.slug} app={app} busy={busy} onUnblock={row => void unblock(row)} />)}</GroupedList> : null}
    {error ? <div role="alert"><p className="text-sm text-red-700 dark:text-red-400">{error}</p><Button type="button" onClick={() => refresh.current()}>{t('core:common.retry')}</Button></div> : null}
  </div>;
}
// The router owns this static wrapper's visibility; React owns its whole interior.
export function BlockedAppsSection() {
  const t = useMessages('settings');
  return <div data-settings-section="blocked-apps" className="hidden">
    <SectionHeading title={t('settings:blockedApps.title')} blurbClassName="dark:text-zinc-400">{t('settings:blockedApps.intro')}</SectionHeading>
    <BlockedAppsList />
  </div>;
}
