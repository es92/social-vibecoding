import { useRef, useState, type FormEvent } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useDialog } from './use-dialog';

// `delete_block` is the server's reason can_delete is false (routes/apps.js
// deleteBlockReason): 'core' for the platform's own app, 'shared' for a
// creator whose app has other contributors, 'not_owner' otherwise.
type AppSettings = {
  slug: string;
  name: string;
  repo_url?: string | null;
  self_hosted?: boolean;
  can_manage?: boolean;
  collab_visibility?: 'public' | 'private';
  view_visibility?: 'public' | 'private';
  can_delete: boolean;
  delete_block?: 'core' | 'shared' | 'not_owner' | null;
  contributor_count?: number;
  // Demo mode (routes/demo-mode.js): the creator has switched this app into
  // a recording mode where a synthetic partner proposes and votes. Marked
  // here so nobody who opens the settings mistakes those for a person's.
  demo_mode?: boolean;
  demo_partner?: string | null;
};

type AccessMode = 'public' | 'public-invite' | 'private';

const ACCESS_MODES: Array<{
  id: AccessMode;
  title: string;
  description: string;
  collabVisibility: 'public' | 'private';
  viewVisibility: 'public' | 'private';
}> = [
  {
    id: 'public',
    title: 'Public',
    description: 'Everyone can use and build this app.',
    collabVisibility: 'public',
    viewVisibility: 'public',
  },
  {
    id: 'public-invite',
    title: 'Public, invite-only building',
    description: 'Everyone can use it. Only collaborators can build it.',
    collabVisibility: 'private',
    viewVisibility: 'public',
  },
  {
    id: 'private',
    title: 'Private',
    description: 'Only collaborators can use or build this app.',
    collabVisibility: 'private',
    viewVisibility: 'private',
  },
];

function currentAccessMode(app: AppSettings): AccessMode {
  if (app.collab_visibility === 'public') return 'public';
  return app.view_visibility === 'private' ? 'private' : 'public-invite';
}

function visibilityForAccess(mode: AccessMode) {
  return ACCESS_MODES.find((item) => item.id === mode) || ACCESS_MODES[0];
}

// Copy for the blocked state, keyed by the server's reason. Plain text, no
// dashes: it is read aloud as the dialog's status line.
function blockedCopy(app: AppSettings) {
  if (app.delete_block === 'core') {
    return 'This is a core platform app. It cannot be deleted from the UI.';
  }
  if (app.delete_block === 'shared') {
    const others = Math.max(0, (app.contributor_count || 0) - 1);
    return `This app has ${others} other ${others === 1 ? 'contributor' : 'contributors'}, `
      + 'so no one person can delete it. Deleting a shared app needs the group\'s agreement.';
  }
  return 'You do not have permission to delete this app.';
}

export function AppSettingsDialog() {
  const [app, setApp] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [accessDraft, setAccessDraft] = useState<AccessMode>('public');
  const [accessMessage, setAccessMessage] = useState('');
  const [accessMessageIsError, setAccessMessageIsError] = useState(false);
  const [accessBusy, setAccessBusy] = useState(false);
  const [accessProposalOpen, setAccessProposalOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  // #2161: a full admin deleting an app that has other contributors must
  // also tick the acknowledgement; the server refuses the request without it.
  const [sharedAck, setSharedAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const slug = useRef('');
  const dangerRef = useRef<HTMLElement>(null);
  useHiddenClass(dangerRef, !app?.can_delete);

  async function load(target: string) {
    const current = ++generation.current;
    setApp(null);
    setConfirmation('');
    setSharedAck(false);
    setError('');
    setAccessMessage('');
    setAccessMessageIsError(false);
    setAccessProposalOpen(false);
    setLoading(true);
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(target)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load app settings.');
      if (current === generation.current) {
        setApp(data.app);
        setAccessDraft(currentAccessMode(data.app));
      }
    } catch (err) {
      if (current === generation.current) setError(err instanceof Error ? err.message : 'Could not load app settings.');
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  const dialog = useDialog<{ slug: string }>('appSettings', {
    onOpen: (payload) => {
      slug.current = payload?.slug || '';
      if (slug.current) void load(slug.current);
    },
    onClose: () => {
      ++generation.current;
      setApp(null);
      setConfirmation('');
      setSharedAck(false);
      setAccessDraft('public');
      setAccessMessage('');
      setAccessMessageIsError(false);
      setAccessProposalOpen(false);
    },
    canClose: () => !pending.current,
  });

  // Other contributors exist: the server will refuse a plain delete, so the
  // dialog asks for the acknowledgement up front and sends it along.
  const shared = !!app && (app.contributor_count || 0) > 1;
  const others = app ? Math.max(0, (app.contributor_count || 0) - 1) : 0;
  const armed = !!app?.can_delete && !!app?.name && confirmation === app.name && (!shared || sharedAck);
  const currentAccess = app ? currentAccessMode(app) : 'public';
  const accessChanged = !!app && accessDraft !== currentAccess;

  async function proposeAccess() {
    if (pending.current || !app?.can_manage || app.self_hosted || !app.repo_url
        || !accessChanged || accessProposalOpen) return;
    const target = visibilityForAccess(accessDraft);
    pending.current = true;
    setAccessBusy(true);
    setAccessMessage('');
    setAccessMessageIsError(false);
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(app.slug)}/visibility-pr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collabVisibility: target.collabVisibility,
          viewVisibility: target.viewVisibility,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) {
        setAccessProposalOpen(true);
        setAccessMessage('A visibility change is already up for vote. See it in the Dev board.');
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Could not open the visibility proposal.');
      setAccessProposalOpen(true);
      setAccessMessage(`Proposal opened (PR #${data.prNumber}). It needs the group's vote before the new access applies.`);
    } catch (err) {
      setAccessMessageIsError(true);
      setAccessMessage(err instanceof Error ? err.message : 'Could not open the visibility proposal.');
    } finally {
      pending.current = false;
      setAccessBusy(false);
    }
  }

  async function remove(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !app?.can_delete || !app.name || confirmation !== app.name) return;
    const isShared = (app.contributor_count || 0) > 1;
    if (isShared && !sharedAck) return;
    const target = app.slug;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/apps/${encodeURIComponent(target)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm_name: confirmation, acknowledge_shared: isShared && sharedAck }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Could not delete the app. Try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the app. Try again.');
      return;
    } finally {
      pending.current = false;
      setBusy(false);
    }
    dialog.close();
    window.App?.navigateHome?.();
    window.PlatformUI?.toast?.('App deleted for everyone.');
    // Refresh failure must not imply the completed deletion failed.
    Promise.resolve().then(() => window.Home?.load?.()).catch(() => {});
  }

  return <DialogRoot id="app-settings-modal" ref={dialog.rootRef} {...dialog.backdropProps}>
    <DialogCard size="sm">
      <h2 className="text-lg font-bold mb-1">App settings</h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">{app?.name}</p>
      {app?.demo_mode ? <Alert
        id="app-demo-mode-notice"
        role="status"
        variant="notice"
        density="compact"
        className="mb-4"
      >
        This app is in demo mode. Proposals and votes from <b>@{app.demo_partner || 'its demo partner'}</b> are
        synthetic: the app’s creator made them to record how a change is proposed, previewed and merged.
        {app.approvals_required != null ? <> While demo mode is on, a proposal here merges
        on {app.approvals_required} approval{app.approvals_required === 1 ? '' : 's'} rather than
        on the app’s usual timed rules; switching demo mode off puts that back.</> : null}
      </Alert> : null}
      {loading ? <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400 mb-4">Loading app settings…</p> : null}
      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400 mb-4">{error}</p> : null}
      {!loading && !app && error ? <Button onClick={() => void load(slug.current)}>Retry</Button> : null}
      <section
        id="app-access-section"
        className={`mb-4 ${app?.can_manage && !app.self_hosted ? '' : 'hidden'}`}
      >
        <h3 className="font-semibold mb-1">Access</h3>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
          Choose who can use this app and who can build changes for it.
        </p>
        <div role="radiogroup" aria-label="App access" className="space-y-2">
          {ACCESS_MODES.map((mode) => {
            const selected = accessDraft === mode.id;
            const current = currentAccess === mode.id;
            return <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={accessBusy || accessProposalOpen || !app?.repo_url}
              onClick={() => {
                setAccessDraft(mode.id);
                setAccessMessage('');
                setAccessMessageIsError(false);
              }}
              className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${selected
                ? 'border-violet-600 bg-violet-50 dark:border-violet-500 dark:bg-violet-950/30'
                : 'border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800'}`}
            >
              <span className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{mode.title}</span>
                {current ? <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">Current</span> : null}
              </span>
              <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">{mode.description}</span>
            </button>;
          })}
        </div>
        {!app?.repo_url ? <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          This app has no GitHub repository, so its access setting is read-only.
        </p> : <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Changing access opens a proposal. The new setting applies after the group votes it in and the app redeploys.
        </p>}
        <p
          id="app-access-status"
          role={accessMessageIsError ? 'alert' : 'status'}
          className={`${accessMessage ? '' : 'hidden'} mt-3 text-sm ${accessMessageIsError ? 'text-red-700 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-300'}`}
        >{accessMessage}</p>
        <Button
          id="app-access-propose"
          type="button"
          size="sm"
          className="mt-3"
          disabled={accessBusy || accessProposalOpen || !app?.repo_url || !accessChanged}
          onClick={() => void proposeAccess()}
        >
          {accessBusy ? 'Opening proposal…' : (accessProposalOpen ? 'Proposal open' : 'Propose access change')}
        </Button>
      </section>
      {app && !app.can_delete ? <p id="app-delete-blocked" role="status" className="text-sm mb-4">{blockedCopy(app)}</p> : null}
      <section ref={dangerRef} className="hidden border border-red-300 dark:border-red-800 rounded-lg p-4 mb-4">
        <h3 className="font-semibold text-red-700 dark:text-red-400 mb-2">Danger zone</h3>
        <p className="text-sm mb-4">{`Deleting ${app?.name || 'this app'} removes it for everyone, including its app data. This cannot be undone. It does not just remove the icon from your home page.`}</p>
        <form onSubmit={remove} className="space-y-3">
          <label htmlFor="app-delete-name" className="block text-sm">Type <strong>{app?.name}</strong> to confirm deletion.</label>
          <Input id="app-delete-name" autoComplete="off" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} disabled={busy || !app?.can_delete} />
          {shared ? <label htmlFor="app-delete-shared-ack" className="flex items-start gap-2 cursor-pointer select-none text-sm">
            <input
              id="app-delete-shared-ack"
              type="checkbox"
              className="accent-red-600 w-4 h-4 mt-0.5"
              checked={sharedAck}
              onChange={(e) => setSharedAck(e.target.checked)}
              disabled={busy}
            />
            <span>
              {`This app has ${others} other ${others === 1 ? 'contributor' : 'contributors'} who have not agreed to this. `}
              Delete it anyway as a platform admin. They will be notified.
            </span>
          </label> : null}
          <Button type="submit" variant="destructive" ink="danger" disabled={busy || !armed}>
            {busy ? 'Deleting…' : 'Delete app for everyone'}
          </Button>
        </form>
      </section>
      {/* Close is a dismissal, not this dialog's primary act — the widget
          language's filled NEUTRAL pill, the same one #app-notifications-done
          and #members-close wear (#2442). */}
      <Button
        type="button"
        variant="neutral"
        ink="neutral"
        disabled={busy}
        onClick={() => dialog.close()}
      >Close</Button>
    </DialogCard>
  </DialogRoot>;
}
