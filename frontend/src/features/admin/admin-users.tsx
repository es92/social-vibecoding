'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AccountDeletions } from './account-deletions';
import { AdminUI } from './admin-console.js';
import { DetailCard, Row, fmtDate, orDash } from './admin-detail-parts.tsx';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { ProgrammeUsers } from './topochain/programme-users.tsx';
import { fetchAllEvents, fetchJson, send } from './topochain/api.ts';
import { openAccountDetail } from './topochain/onchain-accounts.tsx';

// Users (#admin/users) — one scannable row per account (spend, tier, apps,
// pending app slot request), and a per-user details view behind "More"
// (#admin/users/<id>) that holds every dial the platform has: role, app
// quota, weekly and daily caps, linked Homeroom wallet, the company
// OpenRouter key, and the programme profile the v4 admin API serves. The
// row used to carry every one of those as an inline input, which wrapped
// into one unreadable strip; editing lives in the details view now.
//
// The details view reads two existing endpoints and adds none: the
// `/api/admin/users` row already in memory feeds the platform cards, and
// `GET /api/v4/admin/users/:id` (same `users` table, same id) feeds the
// programme cards. Nothing credential-bearing is in either response.
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
  // All-time programme points, the same total the global leaderboard shows.
  total_points?: number | null;
  daily_limit_cents?: number | null;
  weekly_limit_cents?: number | null;
  usernode_pubkey?: string | null;
  social_verified?: boolean;
  // #838: the identity tier the weekly cap follows, and its three proofs.
  identity_tier?: 'unverified' | 'social' | 'zkpassport';
  has_github?: boolean;
  has_x?: boolean;
  has_zkpassport?: boolean;
  openrouter_key_id?: string | null;
  openrouter_key_status?: string | null;
  openrouter_key_hash?: string | null;
  openrouter_daily_limit_usd?: number | null;
  openrouter_limit_reset?: string | null;
  openrouter_issued_at?: string | null;
  openrouter_disabled_at?: string | null;
  openrouter_deleted_at?: string | null;
  created_at?: string | null;
}

// The v4 programme profile of the same account (GET /api/v4/admin/users/:id).
interface Profile {
  id: number;
  email?: string | null;
  telegram?: string | null;
  discord?: string | null;
  display_name?: string | null;
  exclude_podium?: boolean;
  accept_logs?: boolean;
  github?: string | null;
  x?: string | null;
  country?: string | null;
  city?: string | null;
  referrer?: string | null;
  referrer_handle?: string | null;
  is_in_waitlist?: boolean;
  updated_at?: string | null;
  events?: { id: number; name?: string }[];
  onchain_accounts?: { id: number; address?: string | null; tier?: string | null; is_used?: boolean; amount?: number }[];
  global_leaderboard?: {
    rank: number; total_points: number; extra_points: number;
    events_participated: number; total_produced_blocks: number;
  } | null;
}

const console_ = () => (window as any).AdminConsole;

const SMALL_INPUT = 'rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs font-mono disabled:opacity-60';

// #838: the identity tier as the console names it, and what it is short of.
// The weekly cap in Spend limits is set per tier, so the row says which one
// this account is on and, for the unverified tier, which proofs it holds.
const TIER_LABEL: Record<string, string> = {
  unverified: 'No verified identity',
  social: 'GitHub and X verified',
  zkpassport: 'zkPassport verified',
};
function tierDetail(user: User): string {
  if (user.identity_tier === 'zkpassport' || user.identity_tier === 'social') return '';
  if (user.has_github && !user.has_x) return 'GitHub only';
  if (user.has_x && !user.has_github) return 'X only';
  return '';
}
const TINY_LABEL = 'text-xs text-zinc-500 dark:text-zinc-400';

const ROLE_LABEL: Record<string, string> = {
  user: 'User', view_admin: 'View-only admin', admin: 'Admin',
};

const MANAGED_STATUS_LABEL: Record<string, string> = {
  provisioning: 'Provisioning', active: 'Active', disabled: 'Blocked',
  deleted: 'Deleted', needs_review: 'Needs review',
};
// #2119: the allowance's period is read from the key, never assumed; keys
// issued before the weekly policy stay "/day" until they are migrated.
const RESET_PERIOD: Record<string, string> = { daily: 'day', weekly: 'week', monthly: 'month' };

/**
 * A commit-on-blur-or-Enter field. The value the server last confirmed is
 * `committed`; an edit that matches it is a no-op, and a failed save reverts
 * to it. This is what the `data-original` attribute was doing, held by the
 * component that owns the input instead of written back onto the DOM node.
 */
function CommitField({
  id, className, committed, disabled, placeholder, type, inputMode, spellCheck, title, ariaLabel, onCommit,
}: {
  id?: string; className: string; committed: string; disabled: boolean; ariaLabel?: string;
  placeholder?: string; type: string; inputMode?: any; spellCheck?: boolean; title?: string;
  onCommit: (next: string, revert: () => void, accept: (v: string) => void) => Promise<void> | void;
}) {
  const [value, setValue] = useState(committed);
  const [busy, setBusy] = useState(false);
  // A short "Saved" note after a confirmed save, so an edit that commits on
  // blur says it landed.
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return undefined;
    const t = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(t);
  }, [saved]);
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
      (v: string) => { last.current = v; setValue(v); setSaved(true); },
    );
    setBusy(false);
  };

  return (
    <>
      <input id={id} type={type} className={className} disabled={disabled || busy}
        placeholder={placeholder} inputMode={inputMode} spellCheck={spellCheck}
        autoComplete={spellCheck === false ? 'off' : undefined}
        title={title} value={value} aria-label={ariaLabel}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
      {saved ? <span className="text-xs text-emerald-700 dark:text-emerald-400" role="status">Saved</span> : null}
    </>
  );
}


// ── Shared account actions ─────────────────────────────────────────────
//
// The row's "…" menu and the details view's header both offer these, so they
// live once, here, rather than as two copies that drift.

async function resetUserPassword(user: User) {
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
}

async function deleteUser(user: User): Promise<boolean> {
  const ok = await console_()._confirm({
    title: 'Delete user?',
    message: 'Permanently remove this account and sign-in access? Shared messages and attachments stay under “Deleted user.” External cleanup may remain pending.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return false;
  const res = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'DELETE' }) });
  if (res.ok) return true;
  const data = await res.json().catch(() => ({}));
  console_()._alert(data.error || `Delete failed (HTTP ${res.status})`);
  return false;
}

/**
 * The "…" overflow menu. Only full admins get one.
 *
 * WHICH menu is open is the SECTION's state, not the row's — one at a time is
 * the behaviour, and a row cannot enforce it about its siblings.
 */
function Kebab({ user, open, onToggle, onReload }: {
  user: User; open: boolean; onToggle: (open: boolean) => void; onReload: () => void;
}) {
  const setOpen = onToggle;
  return (
    <div className="relative shrink-0 admin-user-actions">
      <button type="button" className="admin-kebab-btn rounded px-2 py-1 text-lg leading-none text-zinc-500 hover:text-zinc-700 dark:text-zinc-300 dark:hover:text-zinc-200"
        aria-label="User actions" aria-haspopup="true" aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>⋯</button>
      <div className={`admin-kebab-menu${open ? '' : ' hidden'} absolute right-0 mt-1 z-20 min-w-[11rem] rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 py-1 shadow-lg`}>
        <button type="button" data-reset-id={user.id} data-username={user.username}
          onClick={() => { setOpen(false); resetUserPassword(user); }}
          className="admin-reset-pw-btn block w-full text-left px-3 py-2 text-sm text-violet-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 dark:text-violet-400">
          Reset password</button>
        {/* Delete stays hidden for admins. */}
        {!user.is_admin ? (
          <button type="button" data-delete-id={user.id}
            onClick={async () => { setOpen(false); if (await deleteUser(user)) onReload(); }}
            className="admin-delete-user-btn block w-full text-left px-3 py-2 text-sm text-red-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 dark:text-red-400">
            Delete</button>
        ) : null}
      </div>
    </div>
  );
}

// ── Formatting ─────────────────────────────────────────────────────────

const dollars = (cents?: number | string | null) => (parseFloat(String(cents || 0)) / 100).toFixed(2);
const roleOf = (u: User) => (!u.is_admin ? 'user' : (u.admin_readonly ? 'view_admin' : 'admin'));
const tierText = (u: User) => `${TIER_LABEL[u.identity_tier || 'unverified']}${tierDetail(u) ? ` (${tierDetail(u)})` : ''}`;
const KEY_BADGE: Record<string, string> = {
  active: 'Key active', disabled: 'Key blocked', needs_review: 'Key needs review',
  provisioning: 'Key provisioning', deleted: 'Key deleted',
};

// ── The list row ───────────────────────────────────────────────────────

function AppSlotRequest({ user, canWrite, onReload }: { user: User; canWrite: boolean; onReload: () => void }) {
  const [busy, setBusy] = useState(false);
  const appQuota = user.app_quota == null ? 0 : user.app_quota;
  const review = async (grant: boolean) => {
    setBusy(true);
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
    } finally { setBusy(false); }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" data-app-quota-request={user.id}>
      <span className="text-xs font-medium text-amber-800 dark:text-amber-400">Requested more app slots</span>
      {canWrite ? <>
        <button type="button" className={AdminUI.btn.primarySm} disabled={busy || appQuota > 2147483645}
          onClick={() => review(true)}>Grant 2 more</button>
        <button type="button" className={AdminUI.btn.outlineSm} disabled={busy}
          onClick={() => review(false)}>Decline request</button>
      </> : null}
    </div>
  );
}

// Fixed columns from md up, so the same value sits in the same place on
// every row; stacked below md.
const ROW_GRID = 'p-4 flex flex-col gap-3 md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto] md:items-start md:gap-4';
const CELL_LABEL = 'md:hidden text-xs text-zinc-500 dark:text-zinc-400';

function UserListRow({ user, canWrite, menuOpen, onMenu, onReload, onMore }: {
  user: User; canWrite: boolean; menuOpen: boolean;
  onMenu: (open: boolean) => void; onReload: () => void; onMore: () => void;
}) {
  const role = roleOf(user);
  const status = user.openrouter_key_id ? (user.openrouter_key_status || '') : '';
  const cap = user.weekly_limit_cents == null
    ? 'default weekly cap' : `of $${dollars(user.weekly_limit_cents)} weekly cap`;
  const joined = fmtDate(user.created_at);
  return (
    <div className={ROW_GRID} data-user-row={user.id}>
      <div className="min-w-0">
        <button type="button" data-open-support={user.id} title="Open in Support"
          className="font-medium break-words text-left text-zinc-900 dark:text-zinc-100 hover:underline focus-visible:underline"
          onClick={() => { location.hash = `#admin/support/${user.id}`; }}>{user.username}</button>
        {joined ? <div className="text-xs text-zinc-500 dark:text-zinc-400">{`Joined ${joined}`}</div> : null}
        <div className="mt-1 flex flex-wrap gap-1.5">
          {role !== 'user' ? <span className={AdminUI.badge.secondary}>{ROLE_LABEL[role]}</span> : null}
          {status ? (
            <span className={status === 'active' ? AdminUI.badge.success : AdminUI.badge.warn}>
              {KEY_BADGE[status] || status}
            </span>
          ) : null}
        </div>
        {user.app_quota_requested_at ? <AppSlotRequest user={user} canWrite={canWrite} onReload={onReload} /> : null}
      </div>
      <div className="text-sm">
        <div className={CELL_LABEL}>Spend</div>
        <div className="text-zinc-900 dark:text-zinc-100">{`$${dollars(user.cost_today_cents)} today`}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{`$${dollars(user.cost_week_cents)} this week`}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{cap}</div>
      </div>
      <div className="text-sm">
        <div className={CELL_LABEL}>Tier</div>
        <span className="admin-user-tier text-zinc-700 dark:text-zinc-300" data-tier={user.identity_tier || 'unverified'}>
          {tierText(user)}
        </span>
      </div>
      <div className="text-sm">
        <div className={CELL_LABEL}>Apps</div>
        <span className="text-zinc-700 dark:text-zinc-300 whitespace-nowrap">
          {`${user.apps_created || 0} of ${user.app_quota == null ? 0 : user.app_quota} used`}
        </span>
      </div>
      <div className="text-sm">
        <div className={CELL_LABEL}>Total points</div>
        <span className="text-zinc-700 dark:text-zinc-300 tabular-nums" data-user-points={user.id}>
          {Number(user.total_points || 0).toLocaleString('en-US')}
        </span>
      </div>
      <div className="flex items-center gap-1 md:justify-end">
        <button type="button" className={AdminUI.btn.outlineSm} data-user-more={user.id} onClick={onMore}>More</button>
        {canWrite ? <Kebab user={user} open={menuOpen} onToggle={onMenu} onReload={onReload} /> : null}
      </div>
    </div>
  );
}

// ── The details view ───────────────────────────────────────────────────

const DETAIL_INPUT = `${AdminUI.input} max-w-[12rem]`;

function OpenRouterCard({ user, onReload }: { user: User; onReload: () => void }) {
  const [busy, setBusy] = useState(false);
  const canWrite = !!console_()?.canWrite();
  const status = user.openrouter_key_status || null;
  const hash = user.openrouter_key_hash || '';
  const reset = user.openrouter_limit_reset || '';
  const period = RESET_PERIOD[reset] || reset;
  const limit = user.openrouter_daily_limit_usd == null
    ? '' : `$${Number(user.openrouter_daily_limit_usd).toFixed(2)}${period ? `/${period}` : ''}`;

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
    <DetailCard title="Company OpenRouter key" id="admin-user-details-openrouter">
      <Row label="Status">
        <span className={status === 'active' ? AdminUI.badge.success : AdminUI.badge.warn}>
          {(status && MANAGED_STATUS_LABEL[status]) || status || 'None'}
        </span>
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
            data-key-id={user.openrouter_key_id} disabled={busy} onClick={remove}>Delete key</button>
        ) : null}
      </Row>
      <Row label="Allowance">{limit || 'Not set'}</Row>
      <Row label="Identity">{user.social_verified ? 'Verified identity' : 'No verified identity'}</Row>
      <Row label="Issued">{fmtDate(user.openrouter_issued_at) || 'Not recorded'}</Row>
      {user.openrouter_disabled_at ? <Row label="Blocked">{fmtDate(user.openrouter_disabled_at)}</Row> : null}
      {user.openrouter_deleted_at ? <Row label="Deleted">{fmtDate(user.openrouter_deleted_at)}</Row> : null}
      <Row label="OpenRouter hash">
        {hash
          ? <code className="text-xs break-all">{hash}</code>
          : <span className="text-zinc-500 dark:text-zinc-400">No confirmed remote hash; reconcile this user label in the OpenRouter dashboard.</span>}
      </Row>
    </DetailCard>
  );
}

function ProgrammeProfileCard({ user, profile, canWrite, onSaved }: {
  user: User; profile: Profile; canWrite: boolean; onSaved: () => void;
}) {
  const [email, setEmail] = useState(profile.email || '');
  const [telegram, setTelegram] = useState(profile.telegram || '');
  const [discord, setDiscord] = useState(profile.discord || '');
  const [displayName, setDisplayName] = useState(profile.display_name || '');
  const [acceptLogs, setAcceptLogs] = useState(!!profile.accept_logs);
  const [enrolled, setEnrolled] = useState<string[]>((profile.events || []).map((e) => String(e.id)));
  const [events, setEvents] = useState<{ id: number; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!canWrite) return undefined;
    let live = true;
    (async () => {
      const list = await fetchAllEvents();
      if (live) setEvents(list);
    })();
    return () => { live = false; };
  }, [canWrite]);

  const reset = () => {
    setEmail(profile.email || ''); setTelegram(profile.telegram || ''); setDiscord(profile.discord || '');
    setDisplayName(profile.display_name || ''); setAcceptLogs(!!profile.accept_logs);
    setEnrolled((profile.events || []).map((e) => String(e.id))); setError(null);
  };

  const noIdentifier = !email.trim() && !telegram.trim() && !discord.trim();

  const save = async () => {
    if (noIdentifier) return;
    setBusy(true); setError(null); setSaved(false);
    const { ok, data } = await send('PUT', `/api/v4/admin/users/${encodeURIComponent(user.id)}`, {
      email: email.trim() || null,
      telegram: telegram.trim() || null,
      discord: discord.trim() || null,
      display_name: displayName.trim() || null,
      accept_logs: acceptLogs,
      season_event_ids: enrolled.map((v) => parseInt(v, 10)),
    });
    setBusy(false);
    if (!ok || !data?.success) { setError((data && data.error) || 'Save failed.'); return; }
    setSaved(true);
    onSaved();
  };

  const toggleRanking = async () => {
    const { ok, data } = await send('PATCH', `/api/v4/admin/users/${encodeURIComponent(user.id)}/toggle-exclude-podium`);
    if (ok && data?.success) { onSaved(); return; }
    console_()._alert((data && data.error) || 'Update failed.');
  };

  const eventNames = (profile.events || []).map((e) => e.name || `Event #${e.id}`);

  if (!canWrite) {
    return (
      <DetailCard title="Programme profile" id="admin-user-details-profile">
        <Row label="Email">{orDash(profile.email)}</Row>
        <Row label="Telegram">{orDash(profile.telegram)}</Row>
        <Row label="Discord">{orDash(profile.discord)}</Row>
        <Row label="Display name">{orDash(profile.display_name)}</Row>
        <Row label="Accept logs">{profile.accept_logs ? 'Yes' : 'No'}</Row>
        <Row label="Events">{eventNames.length ? eventNames.join(', ') : 'Not enrolled in any event'}</Row>
        <Row label="Ranking">{profile.exclude_podium ? 'Excluded' : 'Ranked'}</Row>
      </DetailCard>
    );
  }

  return (
    <DetailCard title="Programme profile" id="admin-user-details-profile">
      <Row label="Email"><input className={AdminUI.input} type="text" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} /></Row>
      <Row label="Telegram"><input className={AdminUI.input} type="text" aria-label="Telegram" value={telegram} onChange={(e) => setTelegram(e.target.value)} /></Row>
      <Row label="Discord"><input className={AdminUI.input} type="text" aria-label="Discord" value={discord} onChange={(e) => setDiscord(e.target.value)} /></Row>
      <Row label="Display name"><input className={AdminUI.input} type="text" aria-label="Display name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></Row>
      <Row label="Accept logs">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={acceptLogs} onChange={(e) => setAcceptLogs(e.target.checked)} />
          <span>{acceptLogs ? 'Yes' : 'No'}</span>
        </label>
      </Row>
      <Row label="Events" help="Ctrl or Cmd click to select more than one.">
        <select multiple size={4} className={AdminUI.select} aria-label="Enrolled events" value={enrolled}
          onChange={(e) => setEnrolled([...e.target.selectedOptions].map((o) => o.value))}>
          {/* Keep enrolled events selectable even before the event list loads. */}
          {(events.length ? events : (profile.events || []).map((ev) => ({ id: ev.id, name: ev.name || `Event #${ev.id}` })))
            .map((ev) => <option key={ev.id} value={String(ev.id)}>{`${ev.name} (#${ev.id})`}</option>)}
        </select>
      </Row>
      <Row label="Ranking">
        <span>{profile.exclude_podium
          ? <span className="text-amber-800 dark:text-amber-400">Excluded</span> : 'Ranked'}</span>
        <button type="button" className={AdminUI.btn.outlineSm} onClick={toggleRanking}>
          {profile.exclude_podium ? 'Include in ranking' : 'Exclude from ranking'}
        </button>
      </Row>
      {noIdentifier ? (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-400">Add an email, Telegram or Discord to save programme details.</p>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" id="admin-user-details-save-profile" className={AdminUI.btn.primarySm}
          disabled={busy || noIdentifier} onClick={save}>Save profile</button>
        <button type="button" className={AdminUI.btn.outlineSm} disabled={busy} onClick={reset}>Cancel</button>
        {saved ? <span className="text-xs text-emerald-700 dark:text-emerald-400" role="status">Saved</span> : null}
      </div>
    </DetailCard>
  );
}

function UserDetails({ user, fullAdminCount, canWrite, onBack, onReload, onDeleted }: {
  user: User; fullAdminCount: number; canWrite: boolean;
  onBack: () => void; onReload: () => void; onDeleted: () => void;
}) {
  const role = roleOf(user);
  const isAdmin = !!user.is_admin;
  const isSelf = !!user.is_self;
  // Same guard the server enforces: the last FULL admin keeps the role,
  // and nobody changes their own (issue #311).
  const isLastFullAdmin = isAdmin && !user.admin_readonly && fullAdminCount <= 1;
  const roleTitle = isSelf ? "You can't change your own role."
    : isLastFullAdmin ? "Can't drop the last full admin."
      : "Set this user's role.";
  const [roleBusy, setRoleBusy] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSeq, setProfileSeq] = useState(0);

  useEffect(() => {
    let live = true;
    setProfileError(null);
    (async () => {
      const { ok, status, data } = await fetchJson(`/api/v4/admin/users/${encodeURIComponent(user.id)}`);
      if (!live) return;
      if (ok && data?.success) setProfile(data.data);
      else setProfileError((data && data.error) || `Could not load the programme details (HTTP ${status}).`);
    })();
    return () => { live = false; };
  }, [user.id, profileSeq]);

  const appQuota = user.app_quota == null ? 0 : user.app_quota;
  const overrideDollars = user.daily_limit_cents == null ? '' : console_().centsToDollars(user.daily_limit_cents);
  const weeklyOverrideDollars = user.weekly_limit_cents == null ? '' : console_().centsToDollars(user.weekly_limit_cents);
  const walletAddr = user.usernode_pubkey == null ? '' : user.usernode_pubkey;

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

  // Blank clears the override; the input is dollars and the API speaks
  // integer cents. `path` is daily-limit or weekly-limit (#1788: blank
  // falls back to the tier default, 0 switches the weekly window off).
  const commitLimit = (path: string, label: string, field: string) =>
    async (next: string, revert: () => void, accept: (v: string) => void) => {
      let body: any;
      if (next === '') body = { cents: null };
      else {
        try { body = { cents: console_().parseDollarsToCents(label, next) }; } catch (err: any) {
          console_()._alert(err.message); revert(); return;
        }
      }
      try {
        const res = await fetch(`/api/admin/users/${user.id}/${path}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console_()._alert(data.error || `Save failed (HTTP ${res.status})`);
          revert();
        } else {
          const data = await res.json();
          accept(data[field] == null ? '' : console_().centsToDollars(data[field]));
          onReload();
        }
      } catch (err: any) {
        console_()._alert(`Save failed: ${err.message}`);
        revert();
      }
    };
  const commitCap = commitLimit('daily-limit', 'Cap', 'daily_limit_cents');
  const commitWeeklyCap = commitLimit('weekly-limit', 'Weekly cap', 'weekly_limit_cents');

  // Empty = clear the wallet. On a 409 the address already belongs to
  // another user; offer to reassign (move) it, which the backend does
  // atomically.
  const commitWallet = async (next: string, revert: () => void, accept: (v: string) => void) => {
    if (next !== '' && !/^ut1\S{5,252}$/.test(next)) {
      console_()._alert('Wallet address must start with "ut1" and contain no spaces.');
      revert();
      return;
    }
    const sendWallet = (reassign: boolean) => {
      const body: any = { pubkey: next === '' ? null : next };
      if (reassign) body.reassign = true;
      return fetch(`/api/admin/users/${user.id}/wallet`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    };
    try {
      let res = await sendWallet(false);
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        const other = data.conflictUser?.username || 'another user';
        const move = await console_()._confirm({
          title: 'Wallet already linked',
          message: `${next} is currently linked to "${other}". Move it to this user? This clears it from "${other}".`,
          confirmLabel: 'Move it',
        });
        if (!move) { revert(); return; }
        res = await sendWallet(true);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console_()._alert(data.error || `Save failed (HTTP ${res.status})`);
        revert();
        return;
      }
      accept(next);
      // A reassign empties the previous holder too; reload the list.
      onReload();
    } catch (err: any) {
      console_()._alert(`Save failed: ${err.message}`);
      revert();
    }
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

  const viewAccount = (id: number) => {
    const c = console_();
    if (c && c.isOpen()) c.setSection('onchain-accounts');
    openAccountDetail(id);
  };

  const title = user.username || profile?.display_name || `User #${user.id}`;
  const joined = fmtDate(user.created_at);
  const lb = profile?.global_leaderboard;

  return (
    <div id="admin-user-details">
      <button type="button" id="admin-user-details-back" className={`${AdminUI.btn.ghost} text-sm mb-3`} onClick={onBack}>
        ← Back to users
      </button>
      <div className={`${AdminUI.card} p-5 mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between`}>
        <div className="min-w-0">
          <h2 className={`${AdminUI.cardTitle} break-words`}>{title}</h2>
          <div className="text-sm text-zinc-500 dark:text-zinc-400">
            {`User #${user.id}`}{joined ? ` · Joined ${joined}` : ''}
            {user.activation_code ? <> {' · code: '}<code>{user.activation_code}</code></> : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className={AdminUI.badge.secondary}>{ROLE_LABEL[role]}</span>
            <span className={AdminUI.badge.default}>{tierText(user)}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <button type="button" id="admin-user-details-open-support" className={AdminUI.btn.outlineSm}
            onClick={() => { location.hash = `#admin/support/${user.id}`; }}>Open in Support</button>
          {canWrite ? (
            <>
              <button type="button" className={AdminUI.btn.outlineSm} onClick={() => resetUserPassword(user)}>Reset password</button>
              {!isAdmin && !isSelf ? (
                <button type="button" className={AdminUI.btn.destructiveSm}
                  onClick={async () => { if (await deleteUser(user)) onDeleted(); }}>Delete account</button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <DetailCard title="Access" id="admin-user-details-access">
          <Row label="Role">
            {canWrite ? (
              <select className={`admin-role-select ${AdminUI.select} max-w-[12rem]`} title={roleTitle}
                data-user-id={user.id} data-original={role} value={role} aria-label="Role"
                disabled={isSelf || isLastFullAdmin || roleBusy}
                onChange={(e) => changeRole(e.target.value)}>
                <option value="user">User</option>
                <option value="view_admin">View-only admin</option>
                <option value="admin">Admin</option>
              </select>
            ) : <span>{ROLE_LABEL[role]}</span>}
          </Row>
          <Row label="App quota" help="Max apps this user may create. 0 means they cannot create any. Admins bypass this.">
            {canWrite ? (
              <CommitField className={`admin-quota-input ${DETAIL_INPUT}`} ariaLabel="App quota"
                type="number" inputMode="numeric" disabled={false}
                committed={String(appQuota)} onCommit={commitQuota} />
            ) : <span>{appQuota}</span>}
            <span className="text-zinc-500 dark:text-zinc-400">{`${user.apps_created || 0} used`}</span>
          </Row>
          {user.app_quota_requested_at ? (
            <Row label="App slot request"><AppSlotRequest user={user} canWrite={canWrite} onReload={onReload} /></Row>
          ) : null}
        </DetailCard>

        <DetailCard title="Spending" id="admin-user-details-spending">
          <Row label="Spent today">{`$${dollars(user.cost_today_cents)}`}</Row>
          <Row label="Spent this week">{`$${dollars(user.cost_week_cents)}`}</Row>
          <Row label="Weekly cap" help="The account's only AI limit. Blank uses the platform default for this tier. 0 leaves no allowance.">
            {canWrite ? (
              <CommitField className={`admin-user-weekly-limit-input ${DETAIL_INPUT}`} ariaLabel="Weekly cap in dollars"
                type="number" inputMode="decimal" placeholder="Platform default" disabled={false}
                committed={weeklyOverrideDollars} onCommit={commitWeeklyCap} />
            ) : <span className="admin-user-weekly-limit-value">{weeklyOverrideDollars ? `$${weeklyOverrideDollars}` : 'Platform default for this tier'}</span>}
          </Row>
          <Row label="Tier">
            <span>{TIER_LABEL[user.identity_tier || 'unverified']}</span>
          </Row>
          <Row label="Proofs">
            <span className={user.has_github ? AdminUI.badge.success : AdminUI.badge.outline}>{`GitHub: ${user.has_github ? 'held' : 'not held'}`}</span>
            <span className={user.has_x ? AdminUI.badge.success : AdminUI.badge.outline}>{`X: ${user.has_x ? 'held' : 'not held'}`}</span>
            <span className={user.has_zkpassport ? AdminUI.badge.success : AdminUI.badge.outline}>{`zkPassport: ${user.has_zkpassport ? 'held' : 'not held'}`}</span>
          </Row>
          <Row label="Daily cap (no longer enforced)" help="Kept so an existing value is not lost. The weekly cap is the limit that applies.">
            {canWrite ? (
              <CommitField className={`admin-user-limit-input ${DETAIL_INPUT}`} ariaLabel="Daily cap in dollars"
                type="number" inputMode="decimal" placeholder="Not set" disabled={false}
                committed={overrideDollars} onCommit={commitCap} />
            ) : <span>{overrideDollars ? `$${overrideDollars}` : 'Not set'}</span>}
          </Row>
        </DetailCard>

        <DetailCard title="Wallet" id="admin-user-details-wallet">
          <Row label="Homeroom wallet" help="Starts with ut1. Leave blank to unlink.">
            {canWrite ? (
              <CommitField className={`admin-wallet-input ${AdminUI.input} font-mono`} ariaLabel="Wallet address"
                type="text" spellCheck={false} placeholder="No wallet linked" disabled={false}
                committed={walletAddr} onCommit={commitWallet} />
            ) : <span className="font-mono break-all">{walletAddr || 'No wallet linked'}</span>}
          </Row>
        </DetailCard>

        {user.openrouter_key_id ? <OpenRouterCard user={user} onReload={onReload} /> : null}

        {profileError ? (
          <DetailCard title="Programme profile" id="admin-user-details-profile">
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">{profileError}</p>
            <button type="button" className={`${AdminUI.btn.outlineSm} mt-2`} onClick={() => setProfileSeq((n) => n + 1)}>Try again</button>
          </DetailCard>
        ) : profile == null ? (
          <DetailCard title="Programme profile"><p className={AdminUI.loading}>Loading…</p></DetailCard>
        ) : (
          <>
            <ProgrammeProfileCard key={`${profile.id}-${profile.updated_at || ''}-${profile.exclude_podium}`}
              user={user} profile={profile} canWrite={canWrite}
              onSaved={() => setProfileSeq((n) => n + 1)} />
            <DetailCard title="Other details" id="admin-user-details-other">
              <Row label="GitHub">{orDash(profile.github)}</Row>
              <Row label="X">{orDash(profile.x)}</Row>
              <Row label="Country">{orDash(profile.country)}</Row>
              <Row label="City">{orDash(profile.city)}</Row>
              <Row label="Referrer">{orDash(profile.referrer)}{profile.referrer_handle ? ` (${profile.referrer_handle})` : ''}</Row>
              <Row label="Waitlist">{profile.is_in_waitlist ? 'On the waitlist' : 'Not on the waitlist'}</Row>
              <Row label="Last updated">{fmtDate(profile.updated_at) || 'Not recorded'}</Row>
            </DetailCard>
            <DetailCard title="Onchain accounts" id="admin-user-details-onchain">
              {(profile.onchain_accounts || []).length ? (profile.onchain_accounts || []).map((a) => (
                <Row key={a.id} label={`Account #${a.id}`}>
                  <span className="font-mono text-xs break-all">{a.address || 'No address'}</span>
                  {a.tier ? <span className={AdminUI.badge.default}>{a.tier}</span> : null}
                  <span className={AdminUI.badge.outline}>{a.is_used ? 'Used' : 'Unused'}</span>
                  <button type="button" className={AdminUI.btn.outlineSm} onClick={() => viewAccount(a.id)}>View account</button>
                </Row>
              )) : <p className={AdminUI.muted}>No onchain accounts linked.</p>}
            </DetailCard>
            <DetailCard title="Leaderboard" id="admin-user-details-leaderboard">
              {lb ? (
                <>
                  <Row label="All-time rank">{`#${lb.rank}`}</Row>
                  <Row label="Total points">{String(lb.total_points)}</Row>
                  <Row label="Extra points">{String(lb.extra_points)}</Row>
                  <Row label="Events joined">{String(lb.events_participated)}</Row>
                  <Row label="Blocks produced">{String(lb.total_produced_blocks)}</Row>
                </>
              ) : <p className={AdminUI.muted}>Not on the leaderboard yet.</p>}
            </DetailCard>
          </>
        )}
      </div>
    </div>
  );
}

// ── The section ────────────────────────────────────────────────────────

const PAGE = 50;
const DETAIL_HASH = /^#admin\/users\/(\d+)(?:$|[/?])/;

function hashDetailId(): number | null {
  if (typeof location === 'undefined') return null;
  const m = DETAIL_HASH.exec(location.hash || '');
  return m ? Number(m[1]) : null;
}

// The `#admin/users/<id>` tail is owned by this module, the same way
// admin-campaigns.tsx owns `#admin/campaigns/<id>`: replaceState, guarded on
// still being inside the Users section so a late write never yanks the
// operator out of another screen.
function writeDetailHash(id: number | null) {
  if (!String(location.hash || '').startsWith('#admin/users')) return;
  const target = id != null ? `#admin/users/${id}` : '#admin/users';
  if (location.hash !== target) history.replaceState(null, '', target);
}

const CHIP = 'rounded-full px-3 py-1 text-xs font-medium transition-colors';
const CHIP_ON = `${CHIP} bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900`;
const CHIP_OFF = `${CHIP} bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700`;

function UsersSection() {
  const canWrite = !!console_()?.canWrite();
  const [users, setUsers] = useState<User[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [bulk, setBulk] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [requestsOnly, setRequestsOnly] = useState(false);
  const [visible, setVisible] = useState(PAGE);
  const [detailId, setDetailId] = useState<number | null>(() => hashDetailId());
  // One open overflow menu at a time, and ONE document-level listener pair,
  // installed only while one is open.
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

  // A new search starts back at the first page.
  useEffect(() => { setVisible(PAGE); }, [filter, requestsOnly]);

  const openDetails = useCallback((id: number) => {
    setOpenMenu(null);
    setDetailId(id);
    writeDetailHash(id);
    if (typeof window !== 'undefined') window.scrollTo(0, 0);
  }, []);
  const closeDetails = useCallback(() => {
    setDetailId(null);
    writeDetailHash(null);
  }, []);

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

  if (detailId != null) {
    if (denied) return <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">Admin access required.</p>;
    if (users == null) return <p className={`${AdminUI.loading} p-4`}>Loading…</p>;
    const target = users.find((u) => u.id === detailId);
    if (!target) {
      return (
        <div id="admin-user-details" className={`${AdminUI.card} p-5`}>
          <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-3">{`User #${detailId} was not found.`}</p>
          <button type="button" id="admin-user-details-back" className={AdminUI.btn.outlineSm} onClick={closeDetails}>Back to users</button>
        </div>
      );
    }
    return (
      <UserDetails key={target.id} user={target} fullAdminCount={fullAdminCount} canWrite={canWrite}
        onBack={closeDetails} onReload={load}
        onDeleted={() => { closeDetails(); load(); }} />
    );
  }

  // Client-side, because /api/admin/users returns every user in one shot with
  // no query parameter — the same shape admin-e2e.tsx filters, and the reason
  // this is a controlled AdminUI input rather than the topochain sections'
  // commit-on-blur box (those re-fetch per keystroke-commit; this does not).
  const query = filter.trim().toLowerCase();
  const requestCount = (users || []).filter((u) => u.app_quota_requested_at).length;
  const shown = (users || []).filter((u) =>
    (!query || (u.username || '').toLowerCase().includes(query))
    && (!requestsOnly || !!u.app_quota_requested_at));
  const page = shown.slice(0, visible);

  return (
    <>
      <div className={AdminUI.card}>
        <div className="flex flex-wrap items-center gap-3 p-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-baseline gap-2 mr-auto">
            <h2 className={AdminUI.cardTitle}>Users</h2>
            {users ? <span className={AdminUI.muted}>{`${users.length} accounts`}</span> : null}
          </div>
          <div className="flex items-center gap-1.5" role="group" aria-label="Show">
            <button type="button" className={requestsOnly ? CHIP_OFF : CHIP_ON} aria-pressed={!requestsOnly}
              onClick={() => setRequestsOnly(false)}>All</button>
            <button type="button" id="admin-users-requests-chip" className={requestsOnly ? CHIP_ON : CHIP_OFF}
              aria-pressed={requestsOnly} onClick={() => setRequestsOnly(true)}>
              {`App slot requests (${requestCount})`}
            </button>
          </div>
          {/* Named for what it searches. The Programme users card below this
              one carries its own search box, so two unlabelled fields would
              sit on the same screen filtering different lists. */}
          <input
            id="admin-users-filter"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search by username"
            aria-label="Filter users by username"
            className={`${AdminUI.input} w-full sm:w-72`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="hidden md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_auto] md:gap-4 px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          <span>User</span><span>Spend</span><span>Tier</span><span>Apps</span><span id="admin-users-points-header">Total points</span><span className="w-24" />
        </div>
        <div id="admin-user-list" className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {denied ? <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">Admin access required.</p> : null}
          {!denied && users == null ? <p className={`${AdminUI.loading} p-4`}>Loading…</p> : null}
          {!denied && users != null && !shown.length && (query || requestsOnly) ? (
            <p className="p-4 text-xs text-zinc-500 dark:text-zinc-400">
              {requestsOnly ? 'No pending app slot requests match this filter.' : `No user matches “${filter.trim()}”.`}
            </p>
          ) : null}
          {page.map((u) => (
            <UserListRow key={u.id} user={u} canWrite={canWrite}
              menuOpen={openMenu === u.id} onMenu={(v) => setOpenMenu(v ? u.id : null)}
              onReload={load} onMore={() => openDetails(u.id)} />
          ))}
        </div>
        {shown.length > visible ? (
          <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-3">
            <button type="button" id="admin-users-more" className={AdminUI.btn.outlineSm}
              onClick={() => setVisible((n) => n + PAGE)}>Show 50 more</button>
            <span className={AdminUI.muted}>{`Showing ${page.length} of ${shown.length}`}</span>
          </div>
        ) : null}
        {canWrite ? (
          <div id="admin-bulk-quota-control" className="flex flex-wrap items-center gap-2 p-4 border-t border-zinc-200 dark:border-zinc-800"
            title="Set every user's app quota to this number.">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Set every user's app quota to</span>
            <input id="admin-bulk-quota-input" type="number" min="0" step="1" inputMode="numeric"
              aria-label="App quota for every user"
              className={`w-16 ${SMALL_INPUT}`} placeholder="0"
              value={bulk} onChange={(e) => setBulk(e.target.value)} />
            <button id="admin-bulk-quota-btn" type="button" className={AdminUI.btn.outlineSm}
              disabled={bulkBusy} onClick={bulkQuota}>Set all</button>
          </div>
        ) : null}
      </div>
      <div id="admin-users-programme" className="mt-6">
        <ProgrammeUsers onOpenDetails={openDetails} />
      </div>
      {canWrite ? <AccountDeletions /> : null}
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
