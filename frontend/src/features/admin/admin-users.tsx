'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { ProgrammeUsers } from './topochain/programme-users.tsx';

// Users (#admin/users) — one row per account, with every per-user dial the
// platform has: role, app quota, daily spend cap, linked Homeroom wallet, and
// the company OpenRouter key when the user claimed one.
//
// #1179: the programme's own users screen (event enrolment, podium and log
// settings, CSV import/export) is merged into this section — one Users menu
// entry, both feature sets. That card was admin-topochain.js's markup, filled
// into an `#admin-users-programme` host this file rendered once and never
// looked inside — the documented legacy-host seam in AGENTS.md. #1120 slice 35
// made it a React component, so the host, the seam and the audit's
// `except: ['#admin-users-programme']` exemption are all gone: the whole
// section is one tree.
//
// PERMISSIONS: visible to any admin. Every control is gated on
// AdminConsole.canWrite(); a view-only admin sees the role as text rather than
// a select, the inputs disabled, and no overflow menu at all. The server
// enforces each route independently.
//
// ── Seventh section out of the chassis (#1120 slice 22) ───────────────
//
// The biggest of the eight, and the one where the old shape cost the most.
// `_paintUsers` built each row as an HTML string, appended it, and then
// `_wireUserRows(list)` made SEVEN `querySelectorAll(...).forEach(...)` passes
// over the nodes that same paint had just created — role selects, quota
// inputs, cap inputs, wallet inputs, two OpenRouter buttons, delete, reset,
// and the kebab buttons. Every one of them re-bound on every reload, and
// every reload happens after any successful edit, so a row's handlers were
// rebuilt several times a session.
//
// The `data-original` attributes are the other half of that shape: each input
// carried its own committed value in the DOM so `commit()` could tell an edit
// from a no-op, and had to write the attribute back by hand after a
// successful save. That is the row's own state now.
//
// Two things stay with the chassis on purpose:
//
//   * `_showTempPasswordModal`. The dialog is chassis furniture — index.tsx
//     renders `#admin-temp-pw-modal` as static React markup and the console
//     fills it — so this section calls the console rather than reaching for
//     those ids itself.
//   * `centsToDollars` / `parseDollarsToCents`, which admin-limits.tsx also
//     reads off the global. They are the console's shared money helpers.

interface User {
  id: number;
  username: string;
  is_admin?: boolean;
  admin_readonly?: boolean;
  is_self?: boolean;
  activation_code?: string;
  cost_today_cents?: number | string;
  cost_week_cents?: number | string;
  app_quota?: number | null;
  app_quota_requested_at?: string | null;
  apps_created?: number | null;
  daily_limit_cents?: number | null;
  weekly_limit_cents?: number | null;
  usernode_pubkey?: string | null;
  social_verified?: boolean;
  openrouter_key_id?: string | null;
  openrouter_key_status?: string | null;
  openrouter_key_hash?: string | null;
  openrouter_daily_limit_usd?: number | null;
}

const console_ = () => (window as any).AdminConsole;

const SMALL_INPUT = 'rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-mono disabled:opacity-60';
const TINY_LABEL = 'text-xs text-zinc-500 dark:text-zinc-400';
const CONTROL = 'flex items-center gap-1 shrink-0';

const ROLE_LABEL: Record<string, string> = {
  user: 'User', view_admin: 'View-only admin', admin: 'Admin',
};

const MANAGED_STATUS_LABEL: Record<string, string> = {
  provisioning: 'Provisioning', active: 'Active', disabled: 'Blocked',
  deleted: 'Deleted', needs_review: 'Needs review',
};

/**
 * A commit-on-blur-or-Enter field. The value the server last confirmed is
 * `committed`; an edit that matches it is a no-op, and a failed save reverts
 * to it. This is what the `data-original` attribute was doing, held by the
 * component that owns the input instead of written back onto the DOM node.
 */
function CommitField({
  id, className, committed, disabled, placeholder, type, inputMode, spellCheck, title, onCommit,
}: {
  id?: string; className: string; committed: string; disabled: boolean;
  placeholder?: string; type: string; inputMode?: any; spellCheck?: boolean; title?: string;
  onCommit: (next: string, revert: () => void, accept: (v: string) => void) => Promise<void> | void;
}) {
  const [value, setValue] = useState(committed);
  const [busy, setBusy] = useState(false);
  // A reload replaces `committed`; adopt it unless the operator is mid-edit.
  const last = useRef(committed);
  useEffect(() => {
    if (last.current !== committed) { last.current = committed; setValue(committed); }
  }, [committed]);

  const commit = async () => {
    const next = value.trim();
    if (next === last.current) return;
    setBusy(true);
    await onCommit(
      next,
      () => setValue(last.current),
      (v: string) => { last.current = v; setValue(v); },
    );
    setBusy(false);
  };

  return (
    <input id={id} type={type} className={className} disabled={disabled || busy}
      placeholder={placeholder} inputMode={inputMode} spellCheck={spellCheck}
      autoComplete={spellCheck === false ? 'off' : undefined}
      title={title} value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
  );
}

/**
 * The "…" overflow menu. Only full admins get one.
 *
 * WHICH menu is open is the SECTION's state, not the row's — one at a time is
 * the behaviour, and a row cannot enforce it about its siblings. The old code
 * got there by calling `_closeUserMenus()` (a `querySelectorAll` over every
 * menu in the document) before opening the clicked one, which is the same
 * rule expressed as a sweep.
 */
function Kebab({ user, open, onToggle, onReload }: {
  user: User; open: boolean; onToggle: (open: boolean) => void; onReload: () => void;
}) {
  const setOpen = onToggle;

  const resetPassword = async () => {
    setOpen(false);
    const ok = await console_()._confirm({
      title: `Reset ${user.username}'s password?`,
      message: 'This signs them out everywhere and issues a one-time temporary password.',
      confirmLabel: 'Reset',
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/admin/users/${user.id}/reset-password`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { console_()._alert(data.error || `Reset failed (HTTP ${res.status})`); return; }
      console_()._showTempPasswordModal(data.username || user.username, data.tempPassword);
    } catch (err: any) {
      console_()._alert(`Reset failed: ${err.message}`);
    }
  };

  const remove = async () => {
    setOpen(false);
    const ok = await console_()._confirm({
      title: 'Delete user?',
      message: 'This will remove all their data.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const res = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
    if (res.ok) onReload();
    else {
      const data = await res.json().catch(() => ({}));
      console_()._alert(data.error || `Delete failed (HTTP ${res.status})`);
    }
  };

  return (
    <div className="relative shrink-0 admin-user-actions">
      <button type="button" className="admin-kebab-btn rounded px-2 py-1 text-lg leading-none text-zinc-500 hover:text-zinc-700 dark:text-zinc-300 dark:hover:text-zinc-200"
        aria-label="User actions" aria-haspopup="true" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>⋯</button>
      <div className={`admin-kebab-menu${open ? '' : ' hidden'} absolute right-0 mt-1 z-20 min-w-[11rem] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 py-1 shadow-lg`}>
        <button type="button" data-reset-id={user.id} data-username={user.username} onClick={resetPassword}
          className="admin-reset-pw-btn block w-full text-left px-3 py-2 text-sm text-violet-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 dark:text-violet-400">
          Reset password</button>
        {/* Delete stays hidden for admins. */}
        {!user.is_admin ? (
          <button type="button" data-delete-id={user.id} onClick={remove}
            className="admin-delete-user-btn block w-full text-left px-3 py-2 text-sm text-red-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 dark:text-red-400">
            Delete</button>
        ) : null}
      </div>
    </div>
  );
}

function OpenRouterCard({ user, onReload }: { user: User; onReload: () => void }) {
  const [busy, setBusy] = useState(false);
  const canWrite = !!console_()?.canWrite();
  const status = user.openrouter_key_status || null;
  const hash = user.openrouter_key_hash || '';
  const limit = user.openrouter_daily_limit_usd == null
    ? '' : `$${Number(user.openrouter_daily_limit_usd).toFixed(2)}/day`;

  const toggle = async (disabled: boolean) => {
    const action = disabled ? 'block' : 'enable';
    const ok = await console_()._confirm({
      title: `${disabled ? 'Block' : 'Enable'} company OpenRouter key?`,
      message: `This will ${action} the child key at OpenRouter immediately.`,
      confirmLabel: disabled ? 'Block key' : 'Enable key',
      danger: disabled,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/openrouter-keys/${user.openrouter_key_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) console_()._alert(data.error || `Update failed (HTTP ${res.status})`);
      else onReload();
    } catch (err: any) {
      console_()._alert(`Update failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await console_()._confirm({
      title: 'Delete company OpenRouter key?',
      message: 'This permanently deletes the child key at OpenRouter. The user cannot claim another company key, but may add a personal key later.',
      confirmLabel: 'Delete key',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/openrouter-keys/${user.openrouter_key_id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) console_()._alert(data.error || `Delete failed (HTTP ${res.status})`);
      else onReload();
    } catch (err: any) {
      console_()._alert(`Delete failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const showActions = canWrite && user.openrouter_key_id && hash && status !== 'deleted';

  return (
    <div className="mt-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50/70 dark:bg-zinc-900/40 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Company OpenRouter key</span>
        <span className="rounded px-1.5 py-0.5 bg-zinc-200 dark:bg-zinc-800">
          {(status && MANAGED_STATUS_LABEL[status]) || status || 'None'}
        </span>
        {limit ? <span className="text-zinc-500 dark:text-zinc-400">{limit}</span> : null}
        <span className="text-zinc-500 dark:text-zinc-400">
          {user.social_verified ? 'verified identity' : 'no verified identity'}
        </span>
        <div className="ml-auto flex gap-2">
          {showActions && status === 'active' ? (
            <button type="button" className={`admin-openrouter-toggle ${AdminUI.btn.outlineSm}`}
              data-key-id={user.openrouter_key_id} data-disabled="true"
              disabled={busy} onClick={() => toggle(true)}>Block</button>
          ) : null}
          {showActions && status === 'disabled' ? (
            <button type="button" className={`admin-openrouter-toggle ${AdminUI.btn.outlineSm}`}
              data-key-id={user.openrouter_key_id} data-disabled="false"
              disabled={busy} onClick={() => toggle(false)}>Enable</button>
          ) : null}
          {showActions ? (
            <button type="button" className={`admin-openrouter-delete ${AdminUI.btn.destructiveSm}`}
              data-key-id={user.openrouter_key_id} disabled={busy} onClick={remove}>Delete</button>
          ) : null}
        </div>
      </div>
      <div className="mt-1 text-zinc-500 dark:text-zinc-400 break-all">
        {hash
          ? <>{'OpenRouter hash: '}<code>{hash}</code></>
          : 'No confirmed remote hash; reconcile this user label in the OpenRouter dashboard.'}
      </div>
    </div>
  );
}

function UserRow({ user, fullAdminCount, canWrite, menuOpen, onMenu, onReload }: {
  user: User; fullAdminCount: number; canWrite: boolean;
  menuOpen: boolean; onMenu: (open: boolean) => void; onReload: () => void;
}) {
  const isAdmin = !!user.is_admin;
  const isReadonlyAdmin = isAdmin && !!user.admin_readonly;
  const role = !isAdmin ? 'user' : (isReadonlyAdmin ? 'view_admin' : 'admin');
  const isSelf = !!user.is_self;
  // Disable the role selector for the sole remaining FULL admin — the server
  // enforces the same rule (last-full-admin guard); this is the matching UX
  // affordance. View-only admins don't count (issue #311).
  const isLastFullAdmin = isAdmin && !isReadonlyAdmin && fullAdminCount <= 1;
  const roleTitle = isSelf ? "You can't change your own role."
    : isLastFullAdmin ? "Can't drop the last full admin."
      : "Set this user's role.";

  const costToday = (parseFloat(String(user.cost_today_cents || 0)) / 100).toFixed(2);
  const costWeek = (parseFloat(String(user.cost_week_cents || 0)) / 100).toFixed(2);
  const [requestBusy, setRequestBusy] = useState(false);
  const appQuota = user.app_quota == null ? 0 : user.app_quota;
  const appsCreated = user.apps_created == null ? 0 : user.apps_created;
  const overrideDollars = user.daily_limit_cents == null
    ? '' : console_().centsToDollars(user.daily_limit_cents);
  const weeklyOverrideDollars = user.weekly_limit_cents == null
    ? '' : console_().centsToDollars(user.weekly_limit_cents);
  const walletAddr = user.usernode_pubkey == null ? '' : user.usernode_pubkey;
  const [roleBusy, setRoleBusy] = useState(false);

  const changeRole = async (next: string) => {
    if (next === role) return;
    setRoleBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/is-admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console_()._alert(data.error || `Role change failed (HTTP ${res.status})`);
        return;
      }
      // Reload so the last-full-admin disabling and the Delete visibility
      // (hidden for admins) both refresh.
      onReload();
    } catch (err: any) {
      console_()._alert(`Role change failed: ${err.message}`);
    } finally {
      setRoleBusy(false);
    }
  };

  // Save on blur or Enter. Empty string clears the override. Input is
  // dollars; the API speaks integer cents.
  const commitCap = async (next: string, revert: () => void, accept: (v: string) => void) => {
    let body: any;
    if (next === '') body = { cents: null };
    else {
      try { body = { cents: console_().parseDollarsToCents('Cap', next) }; } catch (err: any) {
        console_()._alert(err.message); revert(); return;
      }
    }
    try {
      const res = await fetch(`/api/admin/users/${user.id}/daily-limit`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console_()._alert(data.error || `Save failed (HTTP ${res.status})`);
        revert();
      } else {
        const data = await res.json();
        accept(data.daily_limit_cents == null ? '' : console_().centsToDollars(data.daily_limit_cents));
      }
    } catch (err: any) {
      console_()._alert(`Save failed: ${err.message}`);
      revert();
    }
  };

  // #1788: the weekly companion to commitCap. Same contract — blank clears
  // the override and falls back to the platform default; 0 switches the
  // weekly window off for this account.
  const commitWeeklyCap = async (next: string, revert: () => void, accept: (v: string) => void) => {
    let body: any;
    if (next === '') body = { cents: null };
    else {
      try { body = { cents: console_().parseDollarsToCents('Weekly cap', next) }; } catch (err: any) {
        console_()._alert(err.message); revert(); return;
      }
    }
    try {
      const res = await fetch(`/api/admin/users/${user.id}/weekly-limit`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console_()._alert(data.error || `Save failed (HTTP ${res.status})`);
        revert();
      } else {
        const data = await res.json();
        accept(data.weekly_limit_cents == null ? '' : console_().centsToDollars(data.weekly_limit_cents));
      }
    } catch (err: any) {
      console_()._alert(`Save failed: ${err.message}`);
      revert();
    }
  };

  // Save on blur or Enter. Empty = clear the wallet. On a 409 the address
  // already belongs to another user; offer to reassign (move) it, which the
  // backend does atomically.
  const commitWallet = async (next: string, revert: () => void) => {
    if (next !== '' && !/^ut1\S{5,252}$/.test(next)) {
      console_()._alert('Wallet address must start with "ut1" and contain no spaces.');
      revert();
      return;
    }
    const send = (reassign: boolean) => {
      const body: any = { pubkey: next === '' ? null : next };
      if (reassign) body.reassign = true;
      return fetch(`/api/admin/users/${user.id}/wallet`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    };
    try {
      let res = await send(false);
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        const other = data.conflictUser?.username || 'another user';
        const move = await console_()._confirm({
          title: 'Wallet already linked',
          message: `${next} is currently linked to "${other}". Move it to this user? This clears it from "${other}".`,
          confirmLabel: 'Move it',
        });
        if (!move) { revert(); return; }
        res = await send(true);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console_()._alert(data.error || `Save failed (HTTP ${res.status})`);
        revert();
        return;
      }
      // A reassign empties the previous holder's row too; reload so both
      // affected rows reflect the new state.
      onReload();
    } catch (err: any) {
      console_()._alert(`Save failed: ${err.message}`);
      revert();
    }
  };

  const reviewRequest = async (grant: boolean) => {
    setRequestBusy(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/app-quota-request${grant ? '/approve' : ''}`, {
        method: grant ? 'POST' : 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) await onReload();
        throw new Error(data.error || 'Could not review this request.');
      }
      await onReload();
    } catch (err: any) {
      console_()._alert(err.message);
    } finally { setRequestBusy(false); }
  };

  const commitQuota = async (next: string, revert: () => void, accept: (v: string) => void) => {
    const n = Number(next);
    if (next === '' || !Number.isInteger(n) || n < 0) {
      console_()._alert('Quota must be a non-negative whole number.');
      revert();
      return;
    }
    try {
      const res = await fetch(`/api/admin/users/${user.id}/app-quota`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quota: n }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console_()._alert(data.error || `Save failed (HTTP ${res.status})`);
        revert();
      } else {
        const data = await res.json();
        accept(String(data.app_quota));
        await onReload();
      }
    } catch (err: any) {
      console_()._alert(`Save failed: ${err.message}`);
      revert();
    }
  };

  return (
    <div className="p-4 flex items-start gap-3">
      <div className="flex-1 min-w-0 flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between xl:gap-6">
        <div className="min-w-0">
          <div className="font-medium break-words">{user.username}</div>
          <div className="text-sm text-zinc-500 dark:text-zinc-400 truncate">
            {`$${costToday} spent today · $${costWeek} this week `}
            {user.activation_code ? (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {'code: '}<code className="text-zinc-500 dark:text-zinc-400">{user.activation_code}</code>
              </span>
            ) : null}
          </div>
          {user.app_quota_requested_at ? (
            <div className="mt-2 flex flex-wrap items-center gap-2" data-app-quota-request={user.id}>
              <span className="text-xs font-medium text-amber-800 dark:text-amber-400">Requested more app slots</span>
              {canWrite ? <>
                <button type="button" className={AdminUI.btn.primarySm} disabled={requestBusy || appQuota > 2147483645}
                  onClick={() => reviewRequest(true)}>Grant 2 more</button>
                <button type="button" className={AdminUI.btn.outlineSm} disabled={requestBusy}
                  onClick={() => reviewRequest(false)}>Decline request</button>
              </> : null}
            </div>
          ) : null}
          {user.openrouter_key_id ? <OpenRouterCard user={user} onReload={onReload} /> : null}
        </div>
        {/* Stacked under the name on narrow screens; from xl the console is
            full width, so the controls sit on the same line, pushed right,
            instead of leaving half the row empty. */}
        <div className="flex flex-wrap items-center gap-3 xl:justify-end xl:shrink-0">
          <div className={CONTROL} title='Linked Homeroom wallet (ut1…). Blank = no wallet linked.'>
            <span className={TINY_LABEL}>Wallet</span>
            <CommitField className={`admin-wallet-input w-44 max-w-full ${SMALL_INPUT}`}
              type="text" spellCheck={false} placeholder="none" disabled={!canWrite}
              committed={walletAddr} onCommit={commitWallet} />
          </div>
          <div className={CONTROL} title="Per-user daily cap in dollars. Blank = use platform default. 0 switches the daily window off.">
            <span className={TINY_LABEL}>Cap $</span>
            <CommitField className={`admin-user-limit-input w-20 ${SMALL_INPUT}`}
              type="number" inputMode="decimal" placeholder="default" disabled={!canWrite}
              committed={overrideDollars} onCommit={commitCap} />
          </div>
          <div className={CONTROL} title="Per-user weekly cap in dollars, enforced on top of the daily one. Blank = use platform default. 0 switches the weekly window off.">
            <span className={TINY_LABEL}>Weekly $</span>
            <CommitField className={`admin-user-weekly-limit-input w-20 ${SMALL_INPUT}`}
              type="number" inputMode="decimal" placeholder="default" disabled={!canWrite}
              committed={weeklyOverrideDollars} onCommit={commitWeeklyCap} />
          </div>
          {canWrite ? (
            <div className="flex items-center gap-2 shrink-0" title={roleTitle}>
              <span className={TINY_LABEL}>Role</span>
              <select className="admin-role-select rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs"
                data-user-id={user.id} data-original={role} value={role}
                disabled={isSelf || isLastFullAdmin || roleBusy}
                onChange={(e) => changeRole(e.target.value)}>
                <option value="user">User</option>
                <option value="view_admin">View-only admin</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          ) : (
            <div className="flex items-center gap-2 shrink-0">
              <span className={TINY_LABEL}>Role</span>
              <span className="text-xs font-medium text-zinc-500 dark:text-zinc-300">{ROLE_LABEL[role]}</span>
            </div>
          )}
          <div className={CONTROL} title="Max apps this user may create. 0 = cannot create. Admins bypass this.">
            <span className={TINY_LABEL}>App quota</span>
            <CommitField className={`admin-quota-input w-16 ${SMALL_INPUT}`}
              type="number" inputMode="numeric" disabled={!canWrite}
              committed={String(appQuota)} onCommit={commitQuota} />
            <span className="text-xs text-zinc-500 dark:text-zinc-400 whitespace-nowrap">{`${appsCreated} used`}</span>
          </div>
        </div>
      </div>
      {canWrite ? <Kebab user={user} open={menuOpen} onToggle={onMenu} onReload={onReload} /> : null}
    </div>
  );
}

function UsersSection() {
  const canWrite = !!console_()?.canWrite();
  const [users, setUsers] = useState<User[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [bulk, setBulk] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [requestsOnly, setRequestsOnly] = useState(false);
  // One open overflow menu at a time, and ONE document-level listener pair,
  // installed only while one is open. The old shape bound its pair once for
  // the module's lifetime behind a `_menusWired` flag and never removed them.
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { status, data } = await console_().fetchJson('/api/admin/users');
    if (!alive.current) return;
    if (status === 403) { setDenied(true); return; }
    if (!Array.isArray(data)) return;
    setDenied(false);
    setUsers(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (openMenu == null) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as Element)?.closest?.('.admin-user-actions')) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('click', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const bulkQuota = async () => {
    const raw = bulk.trim();
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < 0) {
      console_()._alert('Enter a non-negative whole number.');
      return;
    }
    const ok = await console_()._confirm({
      title: 'Set all quotas?',
      message: `Set EVERY user's app quota to ${n}? This overwrites all current quotas.`,
      confirmLabel: 'Set all',
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const res = await fetch('/api/admin/users/app-quota', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quota: n }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console_()._alert(data.error || `Set all failed (HTTP ${res.status})`);
        return;
      }
      if (!alive.current) return;
      setBulk('');
      await load();
    } catch (err: any) {
      console_()._alert(`Set all failed: ${err.message}`);
    } finally {
      if (alive.current) setBulkBusy(false);
    }
  };

  // Counted over the WHOLE list, never the filtered one. This is what guards
  // "you cannot demote the last full admin", so a search box that happens to
  // hide the other admins must not make the guard think there is one left.
  const fullAdminCount = (users || []).filter((u) => u.is_admin && !u.admin_readonly).length;

  // Client-side, because /api/admin/users returns every user in one shot with
  // no query parameter — the same shape admin-e2e.tsx filters, and the reason
  // this is a controlled AdminUI input rather than the topochain sections'
  // commit-on-blur box (those re-fetch per keystroke-commit; this does not).
  const query = filter.trim().toLowerCase();
  const requestCount = (users || []).filter((u) => u.app_quota_requested_at).length;
  const shown = (users || []).filter((u) =>
    (!query || (u.username || '').toLowerCase().includes(query))
    && (!requestsOnly || !!u.app_quota_requested_at));

  return (
    <>
      <div className={AdminUI.card}>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className={AdminUI.cardTitle}>Users</h2>
          <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <input type="checkbox" checked={requestsOnly} onChange={(e) => setRequestsOnly(e.target.checked)} />
            App slot requests ({requestCount})
          </label>
          {/* Named for what it searches. The Programme users card below this
              one carries its own search box, so two unlabelled fields would
              sit on the same screen filtering different lists. */}
          <input
            id="admin-users-filter"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Filter by username…"
            aria-label="Filter users by username"
            className={`${AdminUI.input} max-w-xs`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {canWrite ? (
            <div id="admin-bulk-quota-control" className="flex items-center gap-2"
              title="Set every user's app quota to this number.">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Set all quotas to</span>
              <input id="admin-bulk-quota-input" type="number" min="0" step="1" inputMode="numeric"
                className={`w-16 ${SMALL_INPUT}`} placeholder="0"
                value={bulk} onChange={(e) => setBulk(e.target.value)} />
              <button id="admin-bulk-quota-btn" type="button" className={AdminUI.btn.primarySm}
                disabled={bulkBusy} onClick={bulkQuota}>Set all</button>
            </div>
          ) : null}
        </div>
        <div id="admin-user-list" className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {denied ? <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">Admin access required.</p> : null}
          {!denied && users == null ? <p className="p-4 text-xs text-zinc-500 dark:text-zinc-400">Loading…</p> : null}
          {!denied && users != null && !shown.length && (query || requestsOnly) ? (
            <p className="p-4 text-xs text-zinc-500 dark:text-zinc-400">
              {requestsOnly ? 'No pending app slot requests match this filter.' : `No user matches “${filter.trim()}”.`}
            </p>
          ) : null}
          {shown.map((u) => (
            <UserRow key={u.id} user={u} fullAdminCount={fullAdminCount} canWrite={canWrite}
              menuOpen={openMenu === u.id} onMenu={(v) => setOpenMenu(v ? u.id : null)}
              onReload={load} />
          ))}
        </div>
      </div>
      <div id="admin-users-programme" className="mt-6">
        <ProgrammeUsers />
      </div>
    </>
  );
}

let host: Element | null = null;

const AdminUsers = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <UsersSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminUsers = AdminUsers;

export { AdminUsers };
