'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { AdminUI } from './admin-console.js';
import { DetailCard, Row, fmtDate, fmtDateTime, orDash } from './admin-detail-parts.tsx';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { fetchJson, send } from './topochain/api.ts';

// Support (#admin/support, #admin/support/<id>): one screen for answering a
// participant's question about their account. Find them by anything they
// might quote (username, an old username, email, Telegram, Discord, wallet,
// onchain address, id), then read who they are, where their points came
// from, which events and seasons they are in, their kudos, where they stand
// on both leaderboards, and a merged activity timeline.
//
// Every card loads on its own from src/routes/admin-support.js, so a slow
// timeline never holds the header back, and each has its own loading, error
// and empty state.
//
// PERMISSIONS: visible to any admin. The two writes (adjust points, reverse
// an adjustment) render only when AdminConsole.canWrite(); the server gates
// both on requireAdminWrite independently.
//
// Wallet and onchain addresses are rendered as text, never as links: they
// are API-supplied strings, and the console never makes those clickable.

const console_ = () => (window as any).AdminConsole;

const DETAIL_HASH = /^#admin\/support\/(\d+)(?:$|[/?])/;

function hashUserId(): number | null {
  const m = DETAIL_HASH.exec(String(location.hash || ''));
  return m ? Number(m[1]) : null;
}

function writeDetailHash(id: number | null) {
  if (!String(location.hash || '').startsWith('#admin/support')) return;
  const target = id != null ? `#admin/support/${id}` : '#admin/support';
  if (location.hash !== target) history.replaceState(null, '', target);
}

const CHIP = 'rounded-full px-3 py-1 text-xs font-medium transition-colors';
const CHIP_ON = `${CHIP} bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900`;
const CHIP_OFF = `${CHIP} bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700`;

const MUTED = 'text-sm text-zinc-500 dark:text-zinc-400';
const SMALL_MUTED = 'text-xs text-zinc-500 dark:text-zinc-400';
const LIST = 'divide-y divide-zinc-100 dark:divide-zinc-800';

const MATCHED_ON: Record<string, string> = {
  id: 'User id',
  username: 'Username',
  previous_username: 'Previous username',
  email: 'Email',
  telegram: 'Telegram',
  discord: 'Discord',
  display_name: 'Display name',
  wallet: 'Wallet',
  onchain_account: 'Onchain account',
};

const ROLE_LABEL: Record<string, string> = { user: 'User', view_admin: 'View-only admin', admin: 'Admin' };

export const SOURCE_LABEL: Record<string, string> = {
  challenge_scorer: 'Automatic scoring',
  scanner: 'Scanner',
  admin_ui: 'Admin',
  import: 'Import',
  api: 'API',
  support_adjustment: 'Support adjustment',
  migration: 'Migration',
  zkpassport: 'zkPassport',
};

const STATUS_BADGE: Record<string, string> = {
  running: AdminUI.badge.success,
  upcoming: AdminUI.badge.outline,
  ended: AdminUI.badge.secondary,
};
const STATUS_LABEL: Record<string, string> = { running: 'Running', upcoming: 'Upcoming', ended: 'Ended' };

const TIMELINE_FILTERS: [string, string][] = [
  ['all', 'All'], ['points', 'Points'], ['kudos', 'Kudos'], ['proposals', 'Proposals'], ['account', 'Account'],
];

const TIMELINE_TYPE: Record<string, string> = {
  kudos_given: 'Gave kudos',
  kudos_received: 'Received kudos',
  bounty_pledged: 'Pledged a bounty',
  bounty_awarded: 'Was awarded a bounty',
  pr_opened: 'Opened a proposal',
  pr_promoted: 'Proposal went up for vote',
  pr_merged: 'Proposal merged',
  pr_vote_cast: 'Voted on a proposal',
  pr_vote_received: 'Proposal received a vote',
  dev_session_started: 'Started a dev session',
  app_created: 'Created an app',
  username_changed: 'Changed username',
  collab_joined: 'Joined as a collaborator',
  approver_joined: 'Joined as an approver',
  chat_message_sent: 'Sent a chat message',
  dapp_active_day: 'Used an app',
  enrolled: 'Enrolled',
};

const ACTION_LABEL: Record<string, string> = {
  view: 'Viewed this account',
  points_adjustment: 'Adjusted points',
  points_reversal: 'Reversed an adjustment',
};

function fmtPoints(n: number | null | undefined): string {
  const v = Number(n) || 0;
  return (Math.round(v * 100) / 100).toLocaleString('en-GB');
}

function signed(n: number | null | undefined): string {
  const v = Number(n) || 0;
  return v > 0 ? `+${fmtPoints(v)}` : fmtPoints(v);
}

// "Earned 200 points: Try 3 apps" / "Lost 50 points: Duplicate claim".
export function activityTitle(points: number, goal?: string | null): string {
  const n = Math.abs(Number(points) || 0);
  const verb = points < 0 ? 'Lost' : 'Earned';
  const noun = n === 1 ? 'point' : 'points';
  const head = `${verb} ${fmtPoints(n)} ${noun}`;
  return goal ? `${head}: ${goal}` : head;
}

function appText(app: { name?: string; slug?: string } | null | undefined): string {
  return app ? (app.name || app.slug || '') : '';
}

// ── Shared card states ─────────────────────────────────────────────────

function Loading() {
  return <div className={AdminUI.loading}>Loading…</div>;
}

function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className={MUTED}>{`Could not load ${what}.`}</p>
      <button type="button" className={AdminUI.btn.outlineSm} onClick={onRetry}>Try again</button>
    </div>
  );
}

function Empty({ children }: { children: string }) {
  return <p className={MUTED}>{children}</p>;
}

// Loads one endpoint into { data, error, loading } with a reload handle.
function useLoad<T>(url: string | null, deps: unknown[] = []) {
  const [state, setState] = useState<{ data: T | null; error: boolean; loading: boolean }>(
    { data: null, error: false, loading: !!url },
  );
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: false }));
    const { ok, data } = await fetchJson(url);
    if (mine !== seq.current) return;
    setState({ data: ok ? data : null, error: !ok, loading: false });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

// ── Search ─────────────────────────────────────────────────────────────

interface SearchResult { id: number; username: string; display_name?: string | null; created_at?: string; matched_on: string }

function SupportSearch({ onOpen, initialQuery, onQuery }: {
  onOpen: (id: number) => void; initialQuery: string; onQuery: (q: string) => void;
}) {
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const last = useRef('');

  const run = useCallback(async (raw: string, autoOpen: boolean) => {
    const q = raw.trim();
    if (q === last.current && results) return;
    last.current = q;
    onQuery(q);
    if (!q) { setResults(null); setError(''); return; }
    if (!/^\d+$/.test(q) && q.length < 3) { setResults(null); setError('Type at least 3 characters, or a user id.'); return; }
    setBusy(true);
    setError('');
    const { ok, data } = await fetchJson(`/api/admin/support/search?q=${encodeURIComponent(q)}`);
    setBusy(false);
    if (!ok) { setResults(null); setError(data?.error || 'Search failed. Try again.'); return; }
    const list: SearchResult[] = data?.results || [];
    setResults(list);
    if (autoOpen && list.length === 1) onOpen(list[0].id);
  }, [onOpen, onQuery, results]);

  useEffect(() => { if (initialQuery) run(initialQuery, false); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div id="admin-support-search-view">
      <div className={`${AdminUI.card} p-5 mb-4`}>
        <h2 className={AdminUI.cardTitle}>Find a user</h2>
        <p className={`${AdminUI.cardDescription} mb-3`}>
          Search by username, a previous username, email, Telegram, Discord, display name, wallet or onchain address, or user id.
        </p>
        <label htmlFor="admin-support-search" className="sr-only">Search users</label>
        <input id="admin-support-search" type="search" className={AdminUI.input} defaultValue={initialQuery}
          placeholder="Username, email, address or id" autoComplete="off"
          onBlur={(e) => run(e.currentTarget.value, false)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); last.current = '\u0000'; run(e.currentTarget.value, true); } }} />
        <p className={`${SMALL_MUTED} mt-2`}>Press Enter to search. A single match opens straight away.</p>
      </div>

      <div id="admin-support-results">
        {busy ? <Loading /> : null}
        {!busy && error ? <p className={MUTED}>{error}</p> : null}
        {!busy && !error && results && results.length === 0 ? <Empty>No users match that search.</Empty> : null}
        {!busy && results && results.length > 0 ? (
          <div className={AdminUI.card}>
            <ul className={LIST}>
              {results.map((r) => (
                <li key={r.id}>
                  <button type="button" data-support-result={r.id}
                    className="w-full text-left px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 focus-visible:bg-zinc-50 dark:focus-visible:bg-zinc-800/50"
                    onClick={() => onOpen(r.id)}>
                    <span className="font-medium text-zinc-900 dark:text-zinc-100 break-words">{r.username}</span>
                    {r.display_name ? <span className={MUTED}>{r.display_name}</span> : null}
                    <span className={SMALL_MUTED}>{`#${r.id}`}</span>
                    <span className={AdminUI.badge.outline}>{`Matched: ${MATCHED_ON[r.matched_on] || r.matched_on}`}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── Detail view ────────────────────────────────────────────────────────

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className={SMALL_MUTED}>{label}</div>
      <div className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 break-words">{value}</div>
      {sub ? <div className={SMALL_MUTED}>{sub}</div> : null}
    </div>
  );
}

function summaryText(s: any): string {
  const u = s.user;
  const g = s.glance;
  const lines = [
    `User #${u.id}: ${u.username}${u.display_name ? ` (${u.display_name})` : ''}`,
    `Joined ${fmtDate(u.created_at)}. Role: ${ROLE_LABEL[u.role] || u.role}. Tier: ${u.identity_tier}.`,
    `Total points: ${fmtPoints(g.total_points)}${g.all_time_rank ? `. Rank ${g.all_time_rank} of ${g.participants}` : ''}.`,
    `Events joined: ${g.events_joined}. Kudos received: ${g.kudos_received}.`,
    g.last_active ? `Last active: ${fmtDateTime(g.last_active)}.` : 'No recorded activity.',
  ];
  for (const p of s.points || []) {
    lines.push(`${p.event_name}: ${fmtPoints(p.ledger_points)} points in the ledger, ${p.leaderboard_points == null ? 'not on the leaderboard yet' : `${fmtPoints(p.leaderboard_points)} on the leaderboard (rank ${p.rank})`}.`);
  }
  return lines.join('\n');
}

function HeaderCard({ summary, onBack }: { summary: any; onBack: () => void }) {
  const u = summary.user;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(summaryText(summary));
      const kit = (window as any).unNative;
      if (kit?.toast) kit.toast('Summary copied'); else console_()?._alert('Summary copied.');
    } catch {
      console_()?._alert('Could not copy the summary.');
    }
  };
  return (
    <>
      <button type="button" id="admin-support-back" className={`${AdminUI.btn.ghost} text-sm mb-3`} onClick={onBack}>
        ← Back to search
      </button>
      <div id="admin-support-header" className={`${AdminUI.card} p-5 mb-4`}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className={`${AdminUI.cardTitle} break-words`}>{u.username}</h2>
            <div className={MUTED}>{`User #${u.id}`}{u.created_at ? ` · Joined ${fmtDate(u.created_at)}` : ''}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className={AdminUI.badge.secondary}>{ROLE_LABEL[u.role] || u.role}</span>
              <span className={AdminUI.badge.default}>{`Tier: ${u.identity_tier}`}</span>
              {u.exclude_podium ? <span className={AdminUI.badge.outline}>Hidden from podium</span> : null}
              {u.deletion_requested_at ? <span className={AdminUI.badge.destructive}>Deletion requested</span> : null}
            </div>
          </div>
          <div className="flex flex-wrap gap-2 shrink-0">
            <button type="button" id="admin-support-copy" className={AdminUI.btn.outlineSm} onClick={copy}>Copy summary</button>
            <button type="button" id="admin-support-open-users" className={AdminUI.btn.outlineSm}
              onClick={() => { location.hash = `#admin/users/${u.id}`; }}>Open in Users</button>
          </div>
        </div>
        <div className="mt-3">
          <Row label="Display name">{orDash(u.display_name)}</Row>
          <Row label="Email">{orDash(u.email)}</Row>
          <Row label="Telegram">{orDash(u.telegram)}</Row>
          <Row label="Discord">{orDash(u.discord)}</Row>
          <Row label="Wallet"><span className="font-mono text-xs break-all">{orDash(u.wallet)}</span></Row>
          <Row label="Previous usernames">
            {u.previous_usernames?.length
              ? u.previous_usernames.map((h: any) => (
                <span key={`${h.username}-${h.changed_at}`} className={AdminUI.badge.outline}
                  title={h.changed_at ? `Until ${fmtDate(h.changed_at)}` : undefined}>{h.username}</span>
              ))
              : 'None'}
          </Row>
          {u.deletion_requested_at ? <Row label="Deletion requested">{fmtDateTime(u.deletion_requested_at)}</Row> : null}
        </div>
      </div>
    </>
  );
}

function GlanceCard({ summary }: { summary: any }) {
  const g = summary.glance;
  return (
    <DetailCard title="At a glance" id="admin-support-glance">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        <Stat label="Total points" value={fmtPoints(g.total_points)}
          sub={g.ledger_points !== g.total_points ? `${fmtPoints(g.ledger_points)} in the ledger` : undefined} />
        <Stat label="Rank" value={g.all_time_rank ? `${g.all_time_rank}` : 'Unranked'}
          sub={g.participants ? `of ${g.participants} participants` : undefined} />
        <Stat label="Events joined" value={String(g.events_joined || 0)} />
        <Stat label="Kudos received" value={String(g.kudos_received || 0)} />
        <Stat label="Last active" value={g.last_active ? fmtDate(g.last_active) : 'Never'} />
      </div>
    </DetailCard>
  );
}

// ── Points ─────────────────────────────────────────────────────────────

function PointsByEvent({ points }: { points: any[] }) {
  if (!points.length) return <Empty>No points in any event yet.</Empty>;
  return (
    <div className={AdminUI.tableWrap}>
      <table className={AdminUI.table}>
        <thead className={AdminUI.thead}>
          <tr>
            <th className={AdminUI.th}>Event</th>
            <th className={AdminUI.th}>Ledger</th>
            <th className={AdminUI.th}>Leaderboard</th>
            <th className={AdminUI.th}>Rank</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => {
            const behind = p.leaderboard_points != null && Math.abs(p.leaderboard_points - p.ledger_points) > 0.005;
            return (
              <tr key={p.season_event_id} className={AdminUI.trHover} data-support-event={p.season_event_id}>
                <td className={AdminUI.td}>
                  <div className="font-medium text-zinc-900 dark:text-zinc-100">{p.event_name}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <span className={STATUS_BADGE[p.status] || AdminUI.badge.outline}>{STATUS_LABEL[p.status] || p.status}</span>
                    {!p.enrolled ? <span className={AdminUI.badge.warn}>Not enrolled</span> : null}
                    {p.season_name ? <span className={SMALL_MUTED}>{p.season_name}</span> : null}
                  </div>
                </td>
                <td className={AdminUI.td}>
                  <div>{fmtPoints(p.ledger_points)}</div>
                  <div className={SMALL_MUTED}>{`${p.activity_count} ${p.activity_count === 1 ? 'entry' : 'entries'}`}</div>
                </td>
                <td className={AdminUI.td}>
                  {p.leaderboard_points == null ? <span className={MUTED}>Not on the leaderboard yet</span> : (
                    <>
                      <div>{fmtPoints(p.leaderboard_points)}</div>
                      {p.snapshot_at ? <div className={SMALL_MUTED}>{`Leaderboard last refreshed ${fmtDateTime(p.snapshot_at)}`}</div> : null}
                      {behind ? <div className="text-xs text-amber-700 dark:text-amber-400">Differs from the ledger until the next refresh</div> : null}
                    </>
                  )}
                </td>
                <td className={AdminUI.td}>{p.rank != null ? p.rank : <span className={MUTED}>None</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReverseControl({ activity, onDone }: { activity: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const actionId = activity.metadata?.support_action_id;
  if (!actionId) return null;
  if (!open) {
    return <button type="button" className={AdminUI.btn.outlineSm} data-support-reverse={activity.id} onClick={() => setOpen(true)}>Reverse</button>;
  }
  const submit = async () => {
    setError('');
    if (reason.trim().length < 10) { setError('Give a reason of at least 10 characters.'); return; }
    const ok = await console_()?._confirm({
      title: 'Reverse this adjustment?',
      message: `This adds ${signed(-activity.points)} points to cancel it out. The original entry stays in the history.`,
      confirmLabel: 'Reverse adjustment',
    });
    if (!ok) return;
    setBusy(true);
    const res = await send('POST', `/api/admin/support/actions/${actionId}/reverse`, { reason: reason.trim() });
    setBusy(false);
    if (!res.ok) { setError(res.data?.error || 'Could not reverse the adjustment. Try again.'); return; }
    setOpen(false);
    onDone();
  };
  return (
    <div className="mt-2 flex flex-col gap-2">
      <label className={AdminUI.label} htmlFor={`admin-support-reverse-reason-${activity.id}`}>Reason for reversing</label>
      <input id={`admin-support-reverse-reason-${activity.id}`} className={AdminUI.input} value={reason}
        onChange={(e) => setReason(e.target.value)} maxLength={1000} />
      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="flex gap-2">
        <button type="button" className={AdminUI.btn.destructiveSm} disabled={busy} onClick={submit}>Reverse adjustment</button>
        <button type="button" className={AdminUI.btn.ghost} disabled={busy} onClick={() => { setOpen(false); setError(''); }}>Cancel</button>
      </div>
    </div>
  );
}

function PointsHistory({ userId, events, canWrite, version, onChanged }: {
  userId: number; events: any[]; canWrite: boolean; version: number; onChanged: () => void;
}) {
  const [eventId, setEventId] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [more, setMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (p: number) => {
    const mine = ++seq.current;
    if (p === 1) setState('loading'); else setMore(true);
    const qs = `page=${p}${eventId ? `&season_event_id=${eventId}` : ''}`;
    const { ok, data } = await fetchJson(`/api/admin/support/users/${userId}/points?${qs}`);
    if (mine !== seq.current) return;
    setMore(false);
    if (!ok) { if (p === 1) setState('error'); else console_()?._alert('Could not load more points. Try again.'); return; }
    setRows((prev) => (p === 1 ? data.activities : [...prev, ...data.activities]));
    setHasMore(!!data.has_more);
    setPage(p);
    setState('ready');
  }, [userId, eventId]);

  useEffect(() => { load(1); }, [load, version]);

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-2">
        <h4 className={AdminUI.sectionTitle}>History</h4>
        <label className="flex items-center gap-2 text-sm">
          <span className={MUTED}>Event</span>
          <select id="admin-support-points-event" className={`${AdminUI.select} max-w-xs`} value={eventId}
            onChange={(e) => setEventId(e.target.value)}>
            <option value="">All events</option>
            {events.map((p) => <option key={p.season_event_id} value={p.season_event_id}>{p.event_name}</option>)}
          </select>
        </label>
      </div>
      {state === 'loading' ? <Loading /> : null}
      {state === 'error' ? <LoadError what="the points history" onRetry={() => load(1)} /> : null}
      {state === 'ready' && rows.length === 0 ? <Empty>No point entries for this filter.</Empty> : null}
      {state === 'ready' && rows.length > 0 ? (
        <>
          <ul className={LIST} id="admin-support-points-history">
            {rows.map((a) => {
              const isReversal = !!a.metadata?.reverses;
              const reversible = canWrite && a.source === 'support_adjustment' && !a.reversed && !isReversal;
              return (
                <li key={a.id} className="py-3" data-support-activity={a.id}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 break-words">
                        {activityTitle(a.points, a.challenge?.goal || a.description)}
                      </div>
                      <div className={SMALL_MUTED}>
                        {[fmtDateTime(a.activity_at), a.event?.name, SOURCE_LABEL[a.source] || a.source,
                          a.added_by_user?.name ? `by ${a.added_by_user.name}` : ''].filter(Boolean).join(' · ')}
                      </div>
                      {a.source === 'support_adjustment' && a.metadata?.reason && a.challenge?.goal
                        ? <div className={`${SMALL_MUTED} mt-1`}>{`Reason: ${a.metadata.reason}`}</div> : null}
                      {a.metadata?.ticket ? <div className={SMALL_MUTED}>{`Ticket: ${a.metadata.ticket}`}</div> : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {a.reversed ? <span className={AdminUI.badge.secondary}>Reversed</span> : null}
                      {isReversal ? <span className={AdminUI.badge.outline}>Reversal</span> : null}
                      {reversible ? <ReverseControl activity={a} onDone={onChanged} /> : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {hasMore ? (
            <button type="button" className={`${AdminUI.btn.outlineSm} mt-3`} disabled={more} onClick={() => load(page + 1)}>
              {more ? 'Loading…' : 'Show 50 more'}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function AdjustPointsForm({ userId, username, onDone }: { userId: number; username: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<any[] | null>(null);
  const [challenges, setChallenges] = useState<any[] | null>(null);
  const [eventId, setEventId] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  const [ticket, setTicket] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || events) return;
    fetchJson(`/api/admin/support/events`).then(({ ok, data }) => {
      if (ok) setEvents(data.events || []); else setError('Could not load events. Close and try again.');
    });
  }, [open, events]);

  useEffect(() => {
    setChallenges(null);
    setChallengeId('');
    if (!eventId) return;
    fetchJson(`/api/admin/support/challenges?season_event_id=${eventId}`).then(({ ok, data }) => {
      if (ok) setChallenges(data.challenges || []); else setError('Could not load challenges for that event.');
    });
  }, [eventId]);

  const reset = () => {
    setOpen(false); setEventId(''); setPoints(''); setReason(''); setTicket(''); setError('');
  };

  if (!open) {
    return <button type="button" id="admin-support-adjust" className={AdminUI.btn.outlineSm} onClick={() => setOpen(true)}>Adjust points</button>;
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const n = Number(points);
    if (!eventId) { setError('Choose an event.'); return; }
    if (!challengeId) { setError('Choose a challenge.'); return; }
    if (!Number.isFinite(n) || n === 0) { setError('Points must be a number other than 0.'); return; }
    if (reason.trim().length < 10) { setError('Give a reason of at least 10 characters.'); return; }
    const ev = (events || []).find((x) => String(x.id) === eventId);
    const ok = await console_()?._confirm({
      title: 'Adjust points?',
      message: `${signed(n)} points for ${username} in ${ev ? ev.name : 'this event'}. The leaderboard shows it after its next refresh.`,
      confirmLabel: 'Adjust points',
    });
    if (!ok) return;
    setBusy(true);
    const res = await send('POST', `/api/admin/support/users/${userId}/points-adjustment`, {
      season_event_id: Number(eventId), challenge_id: Number(challengeId), points: n,
      reason: reason.trim(), ticket: ticket.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) { setError(res.data?.error || 'Could not adjust points. Try again.'); return; }
    reset();
    onDone();
  };

  return (
    <form id="admin-support-adjust-form" className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={submit}>
      <label className="flex flex-col gap-1">
        <span className={AdminUI.label}>Event</span>
        <select className={AdminUI.select} value={eventId} onChange={(e) => setEventId(e.target.value)} disabled={!events}>
          <option value="">{events ? 'Choose an event' : 'Loading events…'}</option>
          {(events || []).map((ev) => (
            <option key={ev.id} value={ev.id}>{`${ev.name}${ev.season_name ? ` (${ev.season_name})` : ''}`}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className={AdminUI.label}>Challenge</span>
        <select className={AdminUI.select} value={challengeId} onChange={(e) => setChallengeId(e.target.value)}
          disabled={!eventId || !challenges}>
          <option value="">{!eventId ? 'Choose an event first' : (challenges ? 'Choose a challenge' : 'Loading challenges…')}</option>
          {(challenges || []).map((c) => <option key={c.id} value={c.id}>{c.goal || `Challenge #${c.id}`}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className={AdminUI.label}>Points</span>
        <input type="number" step="any" className={AdminUI.input} value={points} placeholder="Use a minus sign to remove points"
          onChange={(e) => setPoints(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className={AdminUI.label}>Ticket (optional)</span>
        <input className={AdminUI.input} value={ticket} maxLength={200} onChange={(e) => setTicket(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className={AdminUI.label}>Reason</span>
        <textarea className={AdminUI.textarea} rows={2} value={reason} maxLength={1000}
          placeholder="Shown in the user's support history" onChange={(e) => setReason(e.target.value)} />
      </label>
      {error ? <p className="sm:col-span-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="sm:col-span-2 flex gap-2">
        <button type="submit" className={AdminUI.btn.primarySm} disabled={busy}>{busy ? 'Saving…' : 'Adjust points'}</button>
        <button type="button" className={AdminUI.btn.ghost} disabled={busy} onClick={reset}>Cancel</button>
      </div>
    </form>
  );
}

function PointsCard({ summary, canWrite, version, onChanged }: {
  summary: any; canWrite: boolean; version: number; onChanged: () => void;
}) {
  return (
    <DetailCard title="Points" id="admin-support-points">
      <PointsByEvent points={summary.points || []} />
      {canWrite ? (
        <div className="mt-4">
          <AdjustPointsForm userId={summary.user.id} username={summary.user.username} onDone={onChanged} />
        </div>
      ) : null}
      <PointsHistory userId={summary.user.id} events={summary.points || []} canWrite={canWrite}
        version={version} onChanged={onChanged} />
    </DetailCard>
  );
}

// ── Events and seasons ─────────────────────────────────────────────────

function EventsCard({ summary }: { summary: any }) {
  const enrollments: any[] = summary.enrollments || [];
  const accounts: any[] = summary.onchain_accounts || [];
  return (
    <DetailCard title="Events and seasons" id="admin-support-events">
      <h4 className={`${AdminUI.sectionTitle} mb-1`}>Enrollments</h4>
      {enrollments.length === 0 ? <Empty>Not enrolled in any season or event.</Empty> : (
        <ul className={LIST}>
          {enrollments.map((e) => (
            <li key={e.id} className="py-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm text-zinc-900 dark:text-zinc-100">
                  {e.scope === 'season' ? `${e.season_name} (whole season)` : `${e.event_name} (${e.season_name})`}
                </div>
                <div className={SMALL_MUTED}>{e.registered_at ? `Enrolled ${fmtDate(e.registered_at)}` : 'Enrollment date unknown'}</div>
              </div>
              <span className={STATUS_BADGE[e.status] || AdminUI.badge.outline}>{STATUS_LABEL[e.status] || e.status}</span>
            </li>
          ))}
        </ul>
      )}
      <h4 className={`${AdminUI.sectionTitle} mt-4 mb-1`}>Onchain accounts</h4>
      {accounts.length === 0 ? <Empty>No onchain accounts assigned.</Empty> : (
        <ul className={LIST}>
          {accounts.map((a) => (
            <li key={a.id} className="py-2">
              <div className="font-mono text-xs break-all text-zinc-900 dark:text-zinc-100">{a.address}</div>
              <div className={SMALL_MUTED}>
                {[a.event_name || a.season_name, a.tier ? `Tier ${a.tier}` : '',
                  a.is_used ? `Used ${fmtDate(a.used_at)}` : 'Not used yet'].filter(Boolean).join(' · ')}
              </div>
            </li>
          ))}
        </ul>
      )}
    </DetailCard>
  );
}

// ── Kudos ──────────────────────────────────────────────────────────────

function KudosList({ title, rows, render, empty }: {
  title: string; rows: any[]; render: (r: any) => string; empty: string;
}) {
  return (
    <div className="mt-4">
      <h4 className={`${AdminUI.sectionTitle} mb-1`}>{title}</h4>
      {rows.length === 0 ? <Empty>{empty}</Empty> : (
        <ul className={LIST}>
          {rows.map((r, i) => (
            <li key={`${r.at}-${i}`} className="py-2">
              <div className="text-sm text-zinc-900 dark:text-zinc-100 break-words">{render(r)}</div>
              <div className={SMALL_MUTED}>{[fmtDateTime(r.at), appText(r.app)].filter(Boolean).join(' · ')}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KudosCard({ summary }: { summary: any }) {
  const k = summary.kudos;
  const list = useLoad<any>(`/api/admin/support/users/${summary.user.id}/kudos`);
  const pr = (r: any) => (r.title || (r.pr_number ? `PR #${r.pr_number}` : 'a proposal'));
  return (
    <DetailCard title="Kudos" id="admin-support-kudos">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Kudos received" value={String(k.received)} />
        <Stat label="Bounties received" value={String(k.bounties_received)} />
        <Stat label="Kudos given" value={String(k.given)} />
        <Stat label="Bounties pledged" value={String(k.bounties_given)} />
      </div>
      <p className={`${MUTED} mt-3`}>
        {`${k.week.kudos_used} of ${k.week.kudos_limit} kudos used this week. ${k.week.bounties_used} of ${k.week.bounties_limit} bounties used this week.`}
      </p>
      {list.loading ? <div className="mt-4"><Loading /></div> : null}
      {list.error ? <div className="mt-4"><LoadError what="kudos" onRetry={list.reload} /></div> : null}
      {list.data ? (
        <>
          <KudosList title="Received" rows={list.data.received} empty="No kudos received yet."
            render={(r) => `From ${r.from || 'a deleted user'} for ${pr(r)}`} />
          <KudosList title="Given" rows={list.data.given} empty="No kudos given yet."
            render={(r) => `To ${r.to || 'a deleted user'} for ${pr(r)}`} />
          <KudosList title="Bounties received" rows={list.data.bounties_received} empty="No bounties received yet."
            render={(r) => `Issue #${r.issue}, pledged by ${r.from || 'a deleted user'}`} />
          <KudosList title="Bounties pledged" rows={list.data.bounties_given} empty="No bounties pledged yet."
            render={(r) => `Issue #${r.issue} (${r.status})`} />
        </>
      ) : null}
    </DetailCard>
  );
}

// ── Leaderboard ────────────────────────────────────────────────────────

function LeaderboardCard({ summary }: { summary: any }) {
  const lb = summary.leaderboard;
  const rankText = (r: { rank: number; of: number } | null) => (r ? `${r.rank} of ${r.of}` : 'Not ranked');
  return (
    <DetailCard title="Leaderboard" id="admin-support-leaderboard">
      <Row label="Programme" help={lb.programme ? `${fmtPoints(lb.programme.total_points)} points across ${lb.programme.events_participated} events` : undefined}>
        {lb.programme ? `Rank ${lb.programme.rank} of ${lb.programme.participants}` : 'Not ranked'}
      </Row>
      <Row label="Kudos this week">{rankText(lb.kudos_week)}</Row>
      <Row label="Kudos all time">{rankText(lb.kudos_all)}</Row>
    </DetailCard>
  );
}

// ── Recent activity ────────────────────────────────────────────────────

function timelineLine(it: any): string {
  if (it.kind === 'points') return activityTitle(it.points, it.title);
  const label = TIMELINE_TYPE[it.type] || it.type;
  if (it.type === 'username_changed') return `${label} from ${it.title || 'unknown'} to ${it.detail || 'unknown'}`;
  if (it.type === 'enrolled') return `${label} in ${it.title}`;
  if (it.type === 'kudos_given') return `${label} to ${it.detail || 'a deleted user'}${it.title ? ` for ${it.title}` : ''}`;
  if (it.type === 'kudos_received') return `${label} from ${it.detail || 'a deleted user'}${it.title ? ` for ${it.title}` : ''}`;
  return it.title ? `${label}: ${it.title}` : label;
}

function TimelineCard({ userId, version }: { userId: number; version: number }) {
  const [type, setType] = useState('all');
  const [items, setItems] = useState<any[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [more, setMore] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async (before: string | null) => {
    const mine = ++seq.current;
    if (!before) setState('loading'); else setMore(true);
    const qs = `types=${type}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const { ok, data } = await fetchJson(`/api/admin/support/users/${userId}/timeline?${qs}`);
    if (mine !== seq.current) return;
    setMore(false);
    if (!ok) { if (!before) setState('error'); else console_()?._alert('Could not load older activity. Try again.'); return; }
    setItems((prev) => (before ? [...prev, ...data.items] : data.items));
    setNext(data.nextBefore || null);
    setState('ready');
  }, [userId, type]);

  useEffect(() => { load(null); }, [load, version]);

  return (
    <DetailCard title="Recent activity" id="admin-support-timeline">
      <div className="flex flex-wrap gap-2 mb-3" role="group" aria-label="Filter activity">
        {TIMELINE_FILTERS.map(([key, label]) => (
          <button key={key} type="button" data-support-filter={key} aria-pressed={type === key}
            className={type === key ? CHIP_ON : CHIP_OFF} onClick={() => setType(key)}>{label}</button>
        ))}
      </div>
      {state === 'loading' ? <Loading /> : null}
      {state === 'error' ? <LoadError what="recent activity" onRetry={() => load(null)} /> : null}
      {state === 'ready' && items.length === 0 ? <Empty>No activity of this kind yet.</Empty> : null}
      {state === 'ready' && items.length > 0 ? (
        <>
          <ul className={LIST}>
            {items.map((it, i) => (
              <li key={`${it.at}-${it.type}-${i}`} className="py-2">
                <div className="text-sm text-zinc-900 dark:text-zinc-100 break-words">{timelineLine(it)}</div>
                <div className={SMALL_MUTED}>
                  {[fmtDateTime(it.at), it.kind === 'points' ? it.detail : '', appText(it.app),
                    it.kind === 'points' ? (SOURCE_LABEL[it.type] || it.type) : ''].filter(Boolean).join(' · ')}
                </div>
              </li>
            ))}
          </ul>
          {next ? (
            <button type="button" className={`${AdminUI.btn.outlineSm} mt-3`} disabled={more} onClick={() => load(next)}>
              {more ? 'Loading…' : 'Show older'}
            </button>
          ) : null}
        </>
      ) : null}
    </DetailCard>
  );
}

// ── Support history ────────────────────────────────────────────────────

function HistoryCard({ userId, version }: { userId: number; version: number }) {
  const h = useLoad<any>(`/api/admin/support/users/${userId}/history`, [version]);
  const actions: any[] = h.data?.actions || [];
  return (
    <DetailCard title="Support history" id="admin-support-history">
      {h.loading && !h.data ? <Loading /> : null}
      {h.error ? <LoadError what="the support history" onRetry={h.reload} /> : null}
      {h.data && actions.length === 0 ? <Empty>No support actions yet.</Empty> : null}
      {actions.length > 0 ? (
        <ul className={LIST}>
          {actions.map((a) => (
            <li key={a.id} className="py-2">
              <div className="text-sm text-zinc-900 dark:text-zinc-100">
                {ACTION_LABEL[a.action] || a.action}
                {a.payload?.points != null ? ` (${signed(a.payload.points)} points)` : ''}
              </div>
              <div className={SMALL_MUTED}>
                {[fmtDateTime(a.created_at), a.actor ? `by ${a.actor.username}` : 'by a deleted admin',
                  a.payload?.ticket ? `Ticket: ${a.payload.ticket}` : ''].filter(Boolean).join(' · ')}
              </div>
              {a.reason ? <div className={`${SMALL_MUTED} mt-1 break-words`}>{`Reason: ${a.reason}`}</div> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </DetailCard>
  );
}

// ── Detail screen ──────────────────────────────────────────────────────

function SupportDetail({ userId, onBack }: { userId: number; onBack: () => void }) {
  const [version, setVersion] = useState(0);
  const summary = useLoad<any>(`/api/admin/support/users/${userId}`, [version]);
  const canWrite = !!console_()?.canWrite();
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  if (summary.loading && !summary.data) return <div id="admin-support-detail"><Loading /></div>;
  if (!summary.data) {
    return (
      <div id="admin-support-detail">
        <button type="button" id="admin-support-back" className={`${AdminUI.btn.ghost} text-sm mb-3`} onClick={onBack}>
          ← Back to search
        </button>
        <div className={`${AdminUI.card} p-5`}>
          <LoadError what={`user #${userId}`} onRetry={summary.reload} />
        </div>
      </div>
    );
  }
  const s = summary.data;
  return (
    <div id="admin-support-detail" data-support-user={s.user.id}>
      <HeaderCard summary={s} onBack={onBack} />
      <div className="grid gap-4">
        <GlanceCard summary={s} />
        <PointsCard summary={s} canWrite={canWrite} version={version} onChanged={bump} />
        <div className="grid gap-4 lg:grid-cols-2">
          <EventsCard summary={s} />
          <LeaderboardCard summary={s} />
        </div>
        <KudosCard summary={s} />
        <div className="grid gap-4 lg:grid-cols-2">
          <TimelineCard userId={s.user.id} version={version} />
          <HistoryCard userId={s.user.id} version={version} />
        </div>
      </div>
    </div>
  );
}

function Support() {
  const [userId, setUserId] = useState<number | null>(() => hashUserId());
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onHash = () => {
      if (!String(location.hash || '').startsWith('#admin/support')) return;
      setUserId(hashUserId());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const open = useCallback((id: number) => { setUserId(id); writeDetailHash(id); }, []);
  const back = useCallback(() => { setUserId(null); writeDetailHash(null); }, []);

  return (
    <div id="admin-support" className="max-w-5xl">
      {userId != null
        ? <SupportDetail key={userId} userId={userId} onBack={back} />
        : <SupportSearch onOpen={open} initialQuery={query} onQuery={setQuery} />}
    </div>
  );
}

let host: HTMLElement | null = null;

const AdminSupport = {
  render(el: HTMLElement) { host = el; mountLegacyPortal(el, <Support />); },
  destroy() { if (host) unmountLegacyPortal(host); host = null; },
};

if (typeof window !== 'undefined') (window as any).AdminSupport = AdminSupport;

export { AdminSupport };
