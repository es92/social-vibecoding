'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Limits (#admin/limits): the server's app limit, GitHub's hourly request
// budget (read-only), the platform's LLM budget dials, and the Anthropic
// credit balance the remaining-credit figure is derived from.
//
// PERMISSIONS: visible to any admin; every field and every Save button is
// gated on AdminConsole.canWrite() (canAdminWrite). The server enforces the
// same on PUT /api/admin/app-limit, PUT /api/admin/limits and
// PUT /api/admin/anthropic-credits.
//
// ── Sixth section out of the chassis (#1120 slice 21) ─────────────────
//
// `centsToDollars` and `parseDollarsToCents` stay on AdminConsole rather than
// moving here: the Users section still uses both for its per-user cap
// override, and it is still in the chassis. They come back here when it
// leaves — until then this module reads them off the global exactly as it
// reads `fetchJson` and `canWrite`.
//
// The two status lines were `<p>`s whose className was REASSIGNED on every
// write — `status.className = 'text-xs mt-2 text-red-400'` — so the base
// classes were repeated at each of the six call sites and a seventh would
// have had to remember them. They are one `{ text, tone }` value each now.
// The limits one keeps its 2s auto-hide, and the timer is cleared on unmount
// rather than left to fire into a section the operator has left.

type Tone = 'ok' | 'err';

interface Status { text: string; tone: Tone }

const TONE_CLASS: Record<Tone, string> = {
  // Two different greens, preserved: the credits line has always been
  // emerald and the limits line green-500.
  ok: '',
  err: 'text-red-400',
};

const LABEL = 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400';
const MONEY_INPUT = `${AdminUI.input} pl-6 font-mono disabled:opacity-60`;

/** A `$`-prefixed money field. */
function MoneyField({ id, label, title, placeholder, value, onChange, disabled }: {
  id: string; label: string; title?: string; placeholder: string;
  value: string; onChange: (v: string) => void; disabled: boolean;
}) {
  return (
    <label className="block">
      <span className={LABEL} title={title}>{label}</span>
      <div className="relative mt-1">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-zinc-500 dark:text-zinc-400 pointer-events-none">$</span>
        <input id={id} type="number" min="0" step="0.01" inputMode="decimal" disabled={disabled}
          className={MONEY_INPUT} placeholder={placeholder}
          value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </label>
  );
}

function StatusLine({ id, status, okClass }: { id: string; status: Status | null; okClass: string }) {
  return (
    <p id={id} className={status
      ? `text-xs mt-2 ${status.tone === 'err' ? TONE_CLASS.err : okClass}`
      : 'text-xs mt-2 hidden'}>
      {status ? status.text : ''}
    </p>
  );
}

// The server-wide app limit (services/app-limit.js). Its own card, endpoint
// and Save, not a field of the spend form below: a different unit, a
// different audience (it is what "This server is at its app limit" asks an
// admin to raise), and the platform limit alert opens this section for it.
//
// The field is blank while the deploy's MAX_APPS is in force, with MAX_APPS
// as its placeholder, and "Use MAX_APPS" clears a stored value. When the
// deploy has switched the cap off (MAX_APPS=0) there is nothing to set, and
// the card says so instead of offering a field the server would refuse.
function AppLimitCard({ canWrite }: { canWrite: boolean }) {
  const console_ = () => (window as any).AdminConsole;
  const [data, setData] = useState<any>(null);
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const fill = useCallback((next: any) => {
    setData(next);
    setValue(next && next.setting ? String(next.setting.value) : '');
  }, []);

  useEffect(() => {
    (async () => {
      const { data: next } = await console_().fetchJson('/api/admin/app-limit');
      if (alive.current && next && typeof next === 'object') fill(next);
    })();
  }, [fill]);

  const put = async (limit: number | null) => {
    setStatus(null);
    setSaving(true);
    try {
      const res = await fetch('/api/admin/app-limit', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit }),
      });
      const next = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(next.error || `Save failed (${res.status})`);
      if (!alive.current) return;
      fill(next);
      setStatus({ text: limit === null ? 'Using MAX_APPS again.' : 'Saved. It applies within ten seconds.', tone: 'ok' });
    } catch (err: any) {
      if (alive.current) setStatus({ text: err.message, tone: 'err' });
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const save = () => {
    const raw = value.trim();
    if (!raw) { put(null); return; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      setStatus({ text: 'Enter a whole number of apps, 1 or more.', tone: 'err' });
      return;
    }
    put(n);
  };

  const off = data && data.source === 'disabled';
  const usage = !data ? 'Loading…'
    : off ? `${data.used} live apps · no limit`
      : `${data.used} of ${data.limit} live apps`;
  let source = '';
  if (data && off) {
    source = 'The deploy has switched the limit off (MAX_APPS is 0), so anyone with app slots can create apps.';
  } else if (data && data.source === 'admin') {
    const who = data.setting.updatedBy ? ` by @${data.setting.updatedBy}` : '';
    const when = data.setting.updatedAt ? ` on ${String(data.setting.updatedAt).slice(0, 10)}` : '';
    source = `Set here${who}${when}. Without it, the deploy's MAX_APPS (${data.defaultLimit}) applies.`;
  } else if (data) {
    source = `Using the deploy's MAX_APPS (${data.defaultLimit}). Enter a number to change it here.`;
  }

  return (
    <div id="admin-app-limit" className={`${AdminUI.card} p-4`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className={AdminUI.cardTitle}>App limit</h2>
        <span id="admin-app-limit-usage" className="text-xs text-zinc-500 dark:text-zinc-400">{usage}</span>
      </div>
      <p className={`${AdminUI.muted} mb-3`}>
        How many live apps the whole server allows. At the limit, everyone but full admins is
        told the server is full when they create or fork an app. Apps that failed to build
        do not count. Full admins are notified at {data ? data.warnPercent : 80}% of the limit
        and again when it is reached. A change applies to every server within ten seconds,
        with no deploy.
      </p>
      {off ? null : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <label className="block">
            <span className={LABEL}>Live apps allowed</span>
            <input id="admin-app-limit-input" type="number" min="1" step="1" inputMode="numeric"
              disabled={!canWrite || !data}
              className={`${AdminUI.input} mt-1 font-mono disabled:opacity-60`}
              placeholder={data ? String(data.defaultLimit) : ''}
              value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id="admin-app-limit-source" className="text-xs text-zinc-500 dark:text-zinc-400">{source}</p>
        {canWrite && !off ? (
          <div className="flex items-center gap-2">
            {data && data.source === 'admin' ? (
              <button id="admin-app-limit-reset-btn" type="button" className={AdminUI.btn.outline}
                disabled={saving} onClick={() => put(null)}>Use MAX_APPS</button>
            ) : null}
            <button id="admin-save-app-limit-btn" type="button" className={AdminUI.btn.primary}
              disabled={saving || !data} onClick={save}>Save</button>
          </div>
        ) : null}
      </div>
      <StatusLine id="admin-app-limit-status" status={status} okClass="text-green-800 dark:text-green-400" />
    </div>
  );
}

// GitHub's hourly REST budget per credential (services/github-budget.js),
// read-only: what GitHub reported on the last response with each one. Its
// own card under the app limit because it is the other server-wide ceiling
// an admin is told about (the GitHub platform-limit alert opens this
// section), though nothing here can raise it: GitHub sets it.
//
// The bar fills as the hour's requests are used: amber from the alert line
// (a fifth left), red once background work is held (under the reserve the
// server reports, 15%). A preview has no GitHub token and is answered with
// labelled sample figures (routes/admin.js).
const GITHUB_BAR_TONE = {
  ok: 'bg-violet-500',
  low: 'bg-amber-500',
  held: 'bg-red-500',
} as const;

// Who spent a credential's hour (services/github-budget.js noteRequest): the
// requests this server sent in GitHub's window, by caller and endpoint, and
// what GitHub counted that this server did not send.
interface GithubSpendEndpoint { endpoint: string; count: number; free: number }
interface GithubSpendCaller { caller: string; count: number; free: number; endpoints: GithubSpendEndpoint[] }
interface GithubSpend {
  expired: boolean;
  counted: number;
  free: number;
  usedBeforeCounting: number;
  notCounted: number;
  callers: GithubSpendCaller[];
  otherCallers: { callers: number; count: number } | null;
}

interface GithubBudgetRow {
  credential: string;
  kind: 'pat' | 'installation' | 'anonymous';
  owner: string | null;
  resource: string;
  limit: number;
  remaining: number;
  used: number;
  resetInSeconds: number;
  expired: boolean;
  held: boolean;
  spend?: GithubSpend | null;
  previousSpend?: GithubSpend | null;
}

interface GithubReads {
  installation: number;
  pat: number;
  patReasons: Record<string, number>;
  noInstallation?: Record<string, number>;
}

interface GithubBudgetPayload {
  reservePercent: number;
  credentials: GithubBudgetRow[];
  reads?: GithubReads;
  configured?: { botToken: boolean; app: boolean };
  demo?: boolean;
}

const figure = (v: number) => v.toLocaleString('en-US');

// One window's spenders, most first, each with the endpoints it called. A
// <details> so the card stays short until an admin asks who used the hour.
function GithubSpendList({ id, title, spend }: { id: string; title: string; spend: GithubSpend }) {
  if (!spend.counted && !spend.free && !spend.notCounted) return null;
  return (
    <details id={`admin-github-spend-${id}`} className="mt-2">
      <summary className={`${AdminUI.btn.ghost} cursor-pointer text-xs`}>
        {title}: {figure(spend.counted)} sent by this server
        {spend.notCounted ? `, ${figure(spend.notCounted)} by something else` : ''}
      </summary>
      <ul className="mt-2 space-y-2">
        {spend.callers.map((c) => (
          <li key={c.caller} data-caller={c.caller}>
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-mono text-zinc-900 dark:text-zinc-100 break-all">{c.caller}</span>
              <span className="font-mono text-zinc-700 dark:text-zinc-300 shrink-0">
                {figure(c.count)}{c.free ? ` (+${figure(c.free)} free)` : ''}
              </span>
            </div>
            <ul className="mt-0.5">
              {c.endpoints.map((e) => (
                <li key={e.endpoint} className="flex items-baseline justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span className="font-mono break-all">{e.endpoint}</span>
                  <span className="font-mono shrink-0">{figure(e.count)}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {spend.otherCallers ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
          {figure(spend.otherCallers.count)} more from {figure(spend.otherCallers.callers)} other callers.
        </p>
      ) : null}
      {spend.free ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
          {figure(spend.free)} answered "not modified", which GitHub does not count.
        </p>
      ) : null}
      {spend.notCounted ? (
        <p className="text-xs text-amber-700 dark:text-amber-400 mt-2">
          GitHub counted {figure(spend.notCounted)} more than this server sent: another copy of the
          token (a container, another server) or a call that does not go through services/github.js.
        </p>
      ) : null}
      {spend.usedBeforeCounting ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
          {figure(spend.usedBeforeCounting)} were already used when this server started counting.
        </p>
      ) : null}
    </details>
  );
}

// Why a read routed through the App went to the bot token instead
// (services/github.js getReadOctokit), in words.
function readReasonLabel(reason: string): string {
  if (reason === 'no_installation') return 'App not installed on the owner';
  if (reason === 'budget_used_up' || reason === 'rate_limited') return "the App's hour used up";
  if (reason === 'not_a_read') return 'writes on a read client';
  const status = /^status_(\d+)$/.exec(reason);
  if (status) return `the App refused (${status[1]})`;
  return reason;
}

function githubCredentialLabel(row: GithubBudgetRow): string {
  if (row.kind === 'pat') return 'Bot token';
  if (row.kind === 'installation') return row.owner ? `GitHub App (${row.owner})` : 'GitHub App';
  return 'Reads without a token';
}

function githubResetLine(row: GithubBudgetRow): string {
  if (row.expired) return 'The hour has reset since the last request, so the whole budget is available.';
  const left = `${row.remaining.toLocaleString('en-US')} left`;
  const minutes = Math.max(1, Math.ceil(row.resetInSeconds / 60));
  const reset = minutes === 1 ? 'resets in about a minute' : `resets in about ${minutes} minutes`;
  return `${left}, ${reset}.${row.held ? ' Background work is waiting for the reset.' : ''}`;
}

// The figures, from one payload: the missing installations, then one row per
// credential with its bar, its reset, and who spent it. A component of its
// own so it renders from a payload alone (tests/github-spend.test.js).
function GithubBudgetFigures({ data }: { data: GithubBudgetPayload }) {
  const rows = data.credentials.filter((r) => r.resource === 'core');
  const reads = data.reads || null;
  const missing = reads && reads.noInstallation
    ? Object.entries(reads.noInstallation).sort((a, b) => b[1] - a[1])
    : [];
  const patReasons = reads ? Object.entries(reads.patReasons).sort((a, b) => b[1] - a[1]) : [];
  let empty = '';
  if (!rows.length) {
    empty = data.configured && !data.configured.botToken && !data.configured.app
      ? 'GitHub is not configured on this server.'
      : 'No GitHub response since this server started. The figures appear after its next request.';
  }

  return (
    <>
      {empty ? <p id="admin-github-budget-empty" className={AdminUI.muted}>{empty}</p> : null}
      {missing.length ? (
        <p id="admin-github-no-installation" className="text-sm text-amber-700 dark:text-amber-400 mb-3">
          The GitHub App is not installed on {missing.map(([owner]) => owner).join(', ')}, so reads of
          {missing.length === 1 ? ' its repositories' : ' their repositories'} use the bot token
          ({figure(missing.reduce((sum, [, c]) => sum + c, 0))} since this server started). Installing the App
          there moves them to the App's own budget.
        </p>
      ) : null}
      {rows.length ? (
        <ul id="admin-github-budget-rows" className="space-y-3">
          {rows.map((row) => {
            const pct = row.limit > 0 ? Math.min(100, Math.round((row.used / row.limit) * 100)) : 0;
            const tone = row.held ? 'held' : (row.remaining <= row.limit * 0.2 && !row.expired ? 'low' : 'ok');
            const key = row.credential.replace(/[^a-z0-9-]/gi, '-');
            return (
              <li key={row.credential} data-credential={row.credential}>
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{githubCredentialLabel(row)}</span>
                  <span className="font-mono text-zinc-700 dark:text-zinc-300">
                    {(row.expired ? 0 : row.used).toLocaleString('en-US')} of {row.limit.toLocaleString('en-US')} used
                  </span>
                </div>
                <div className="h-1.5 mt-1 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                  <div className={`h-full ${GITHUB_BAR_TONE[tone]}`} style={{ width: `${row.expired ? 0 : pct}%` }} />
                </div>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{githubResetLine(row)}</p>
                {row.kind === 'pat' && reads && (reads.installation || reads.pat) ? (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                    Reads since this server started: {figure(reads.installation)} through the App, {figure(reads.pat)} with the bot token
                    {patReasons.length ? ` (${patReasons.map(([r, c]) => `${readReasonLabel(r)}: ${figure(c)}`).join(', ')})` : ''}.
                  </p>
                ) : null}
                {row.spend && !row.spend.expired ? (
                  <GithubSpendList id={key} title="Who used this hour" spend={row.spend} />
                ) : null}
                {row.previousSpend ? (
                  <GithubSpendList id={`${key}-previous`} title="The hour before" spend={row.previousSpend} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {data.demo ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-3">
          This preview has no GitHub token, so these are sample figures.
        </p>
      ) : null}
    </>
  );
}

function GithubBudgetCard() {
  const console_ = () => (window as any).AdminConsole;
  const [data, setData] = useState<GithubBudgetPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const { data: next } = await console_().fetchJson('/api/admin/github-budget');
      if (!alive.current) return;
      if (next && typeof next === 'object' && Array.isArray(next.credentials)) setData(next);
      else setFailed(true);
    })();
  }, []);

  const reserve = data ? data.reservePercent : 15;

  return (
    <div id="admin-github-budget" className={`${AdminUI.card} p-4 mt-4`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className={AdminUI.cardTitle}>GitHub requests</h2>
        {data && data.demo ? <span className={AdminUI.badge.outline}>Sample figures</span> : null}
      </div>
      <p className={`${AdminUI.muted} mb-3`}>
        GitHub allows each of Homeroom's credentials a number of requests an hour, and these are
        the figures it sent with the last response on each one. Background work, such as checking
        apps for new commits, waits when less than {reserve}% is left, so what people start keeps
        the rest. Full admins are notified when a fifth is left and again when it runs out.
      </p>
      {!data && !failed ? <p className={AdminUI.loading}>Loading…</p> : null}
      {failed ? <p className="text-xs text-red-400">Couldn’t load the GitHub figures.</p> : null}
      {data ? <GithubBudgetFigures data={data} /> : null}
    </div>
  );
}

function LimitsSection() {
  const console_ = () => (window as any).AdminConsole;
  const canWrite = !!console_()?.canWrite();
  const dis = !canWrite;

  // #2571: there is no per-user DAILY field any more — that cap is switched
  // off platform-wide (src/services/limits.js) and the weekly one is the
  // account's only limit. The stored `user_daily_limit_cents` setting and
  // the PUT field that writes it are retained so an operator's historical
  // value is not destroyed; this page simply no longer offers it.
  const [weekly, setWeekly] = useState('');
  // #838: the two higher identity tiers. Blank means "same as the unverified
  // cap" (nothing stored), and saving a blank clears a stored value.
  const [weeklySocial, setWeeklySocial] = useState('');
  const [weeklyZk, setWeeklyZk] = useState('');
  const [weeklyPhone, setWeeklyPhone] = useState('');
  // The verified-identity rule: on since `ruleSince`, or off (null).
  const [ruleSince, setRuleSince] = useState<string | null>(null);
  const [ruleOn, setRuleOn] = useState(false);
  const [global, setGlobal] = useState('');
  const [system, setSystem] = useState('');
  const [limitsStatus, setLimitsStatus] = useState<Status | null>(null);

  const [balance, setBalance] = useState('');
  const [asOf, setAsOf] = useState('');
  const [derived, setDerived] = useState('');
  const [creditsStatus, setCreditsStatus] = useState<Status | null>(null);

  const alive = useRef(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    alive.current = false;
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  const fillLimits = useCallback((data: any) => {
    setWeekly(console_().centsToDollars(data.user_weekly_limit_cents));
    setWeeklySocial(data.user_weekly_limit_social_cents == null
      ? '' : console_().centsToDollars(data.user_weekly_limit_social_cents));
    setWeeklyZk(data.user_weekly_limit_zk_cents == null
      ? '' : console_().centsToDollars(data.user_weekly_limit_zk_cents));
    setWeeklyPhone(data.user_weekly_limit_phone_cents == null
      ? '' : console_().centsToDollars(data.user_weekly_limit_phone_cents));
    setRuleSince(data.identity_rule_since || null);
    setRuleOn(!!data.identity_rule_since);
    setGlobal(console_().centsToDollars(data.global_daily_limit_cents));
    setSystem(console_().centsToDollars(data.system_tokens_daily_limit_cents));
  }, []);

  // Echo the derived figure back here, so an admin can confirm the admin key
  // is actually working. This is the only place it shows.
  const fillCredits = useCallback((data: any) => {
    if (data.configured) {
      setBalance(console_().centsToDollars(data.balanceCents));
      setAsOf(data.asOf || '');
    }
    if (!data.configured) {
      setDerived('Nothing recorded yet: no remaining-credit figure is being tracked.');
    } else if (typeof data.remainingCents !== 'number') {
      setDerived(`Couldn’t reach Anthropic to compute the remaining credit${
        data.error ? ` (${data.error})` : ''}.`);
    } else {
      const src = data.source === 'anthropic'
        ? 'from Anthropic’s billed cost report'
        : 'estimated from platform spend records (no ANTHROPIC_ADMIN_KEY configured)';
      setDerived(`$${console_().centsToDollars(data.remainingCents)} remaining, `
        + `$${console_().centsToDollars(data.spentCents)} spent since ${data.asOf}, ${src}.`
        + (data.stale ? ' Showing a cached figure; the last refresh failed.' : ''));
    }
  }, []);

  useEffect(() => {
    (async () => {
      const { data } = await console_().fetchJson('/api/admin/limits');
      if (alive.current && data && typeof data === 'object') fillLimits(data);
    })();
    (async () => {
      const { data } = await console_().fetchJson('/api/admin/anthropic-credits');
      if (alive.current && data && typeof data === 'object') fillCredits(data);
    })();
  }, [fillLimits, fillCredits]);

  const saveLimits = async () => {
    setLimitsStatus(null);
    const body: Record<string, number | null | boolean> = {};
    try {
      const w = console_().parseDollarsToCents('Weekly cap, unverified', weekly.trim());
      const g = console_().parseDollarsToCents('Global', global.trim());
      const s = console_().parseDollarsToCents('System tokens', system.trim());
      // #838: a blank tier field is sent as null, which clears the stored
      // value so that tier inherits the unverified cap again.
      const ws = console_().parseDollarsToCents('Weekly cap, GitHub and X', weeklySocial.trim());
      const wz = console_().parseDollarsToCents('Weekly cap, zkPassport', weeklyZk.trim());
      const wp = console_().parseDollarsToCents('Weekly cap, phone', weeklyPhone.trim());
      if (w !== null) body.weekly = w;
      body.weeklySocial = ws;
      body.weeklyZk = wz;
      body.weeklyPhone = wp;
      // Sent only when it changes: switching on records the time once.
      if (ruleOn !== !!ruleSince) body.identityRule = ruleOn;
      if (g !== null) body.global = g;
      if (s !== null) body.system = s;
    } catch (err: any) {
      setLimitsStatus({ text: err.message, tone: 'err' });
      return;
    }
    try {
      const res = await fetch('/api/admin/limits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!alive.current) return;
      fillLimits(data);
      setLimitsStatus({ text: 'Saved.', tone: 'ok' });
      if (hideTimer.current) clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(() => setLimitsStatus(null), 2000);
    } catch (err: any) {
      if (alive.current) setLimitsStatus({ text: `Save failed: ${err.message}`, tone: 'err' });
    }
  };

  const saveCredits = async () => {
    setCreditsStatus(null);
    let body: any;
    try {
      const cents = console_().parseDollarsToCents('Credit balance', balance.trim());
      const when = asOf.trim();
      if (cents === null) throw new Error('Enter the credit balance.');
      if (!when) throw new Error('Enter the date that balance was correct.');
      body = { balanceCents: cents, asOf: when };
    } catch (err: any) {
      setCreditsStatus({ text: err.message, tone: 'err' });
      return;
    }
    try {
      const res = await fetch('/api/admin/anthropic-credits', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Save failed (${res.status})`);
      if (!alive.current) return;
      fillCredits(data);
      setCreditsStatus({ text: 'Saved.', tone: 'ok' });
    } catch (err: any) {
      if (alive.current) setCreditsStatus({ text: err.message, tone: 'err' });
    }
  };

  return (
    <>
      <AppLimitCard canWrite={canWrite} />

      <GithubBudgetCard />

      <div className={`${AdminUI.card} p-4 mt-4`}>
        <div className="flex items-center justify-between mb-3">
          <h2 className={AdminUI.cardTitle}>LLM Spend Limits</h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">USD · per-user cap resets Monday 00:00 UTC, platform caps midnight UTC</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <MoneyField id="admin-limit-global" label="Global daily cap" placeholder="200.00"
            value={global} onChange={setGlobal} disabled={dis} />
          <MoneyField id="admin-limit-system" label="System tokens daily cap" placeholder="25.00"
            title="Funds platform-driven merge-conflict / sync-with-main resolution turns"
            value={system} onChange={setSystem} disabled={dis} />
        </div>
        {/* #838: the weekly cap by identity tier. The first field keeps the
            #admin-limit-weekly id: it is the same stored value it always was
            (the base weekly cap), now read as the unverified tier's, and a
            declared check selects on it. The two others inherit it while
            blank. */}
        <div id="admin-limit-tiers" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <MoneyField id="admin-limit-weekly" label="Default per-user weekly cap (no verified identity)" placeholder="50.00"
            title="The account's only AI limit, for accounts with no verified identity, and the value the other two tiers inherit while blank. It covers every kind of spend the platform funds. Set it to 0 and the account has no allowance at all."
            value={weekly} onChange={setWeekly} disabled={dis} />
          <MoneyField id="admin-limit-weekly-phone" label="Weekly cap: phone verified" placeholder="same as unverified"
            title="For accounts with a verified phone number, and, while the verified-identity rule is on, accounts let in before it was switched on. Blank inherits the unverified cap."
            value={weeklyPhone} onChange={setWeeklyPhone} disabled={dis} />
          <MoneyField id="admin-limit-weekly-social" label="Weekly cap: GitHub and X verified" placeholder="same as unverified"
            title="For accounts that have verified both a GitHub and an X account. Blank inherits the unverified cap."
            value={weeklySocial} onChange={setWeeklySocial} disabled={dis} />
          <MoneyField id="admin-limit-weekly-zk" label="Weekly cap: zkPassport verified" placeholder="same as unverified"
            title="For accounts that have completed a zkPassport-verified challenge. Blank inherits the unverified cap."
            value={weeklyZk} onChange={setWeeklyZk} disabled={dis} />
        </div>
        {/* The verified-identity rule (schema.sql identity_rule_since):
            saved with the caps, and on records the time once. */}
        <label htmlFor="admin-identity-rule" data-admin-identity-rule="" className="flex items-start gap-2 mb-3 text-sm text-zinc-700 dark:text-zinc-300">
          <input id="admin-identity-rule" type="checkbox" className="mt-1 accent-violet-600" checked={ruleOn} disabled={dis}
            onChange={(e) => setRuleOn(e.target.checked)} />
          <span>
            <span className="font-medium">Verified identity rule</span>
            {`: a vote on a public app counts only from an account with a verified phone, GitHub and X, or zkPassport, and accounts without one get the unverified cap. Accounts let in before it was switched on are exempt and get the phone cap. Off, every vote counts and nobody is exempt, so earlier members without one get the unverified cap too. ${ruleSince ? `On since ${new Date(ruleSince).toLocaleString()}.` : 'Off.'}`}
          </span>
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            An account has ONE AI limit and it is weekly: the same pool covers work run on
            the platform's own Claude key and work run on the account's included OpenRouter
            key. Per-user overrides live in the Users section; these are the platform
            defaults. The weekly cap follows the account's identity tier: the default
            applies to accounts with no verified identity, and the phone, GitHub-and-X
            and zkPassport tiers use the default while left blank. A cap set to 0 means the
            account has no AI allowance at all. The two daily caps above are the platform's
            own safety limits, not a per-user one.
          </p>
          {canWrite ? (
            <button id="admin-save-limits-btn" type="button" className={AdminUI.btn.primary}
              onClick={saveLimits}>Save</button>
          ) : null}
        </div>
        <StatusLine id="admin-limits-status" status={limitsStatus} okClass="text-green-800 dark:text-green-400" />
      </div>

      {/* Anthropic credits (#555). Anthropic's API publishes billed spend,
          never a balance, so the remaining figure is derived: the balance
          recorded here minus cost_report spend since the as-of date.
          Re-record both after every top-up. View-only admins see the values,
          disabled.

          This is the ONLY surface for the figure — the drawer's status pane
          carried a matching row until it was removed for reading "Not set up"
          indefinitely. */}
      <div className={`${AdminUI.card} p-4 mt-4`}>
        <div className="flex items-center justify-between mb-3">
          <h2 className={AdminUI.cardTitle}>Anthropic credits</h2>
        </div>
        <p className={`${AdminUI.muted} mb-3`}>
          Anthropic doesn’t publish a remaining-credit figure, only what it has
          billed. Record the balance and the date it was correct, and the platform
          subtracts billed spend since then. Re-record both after every top-up.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
          <MoneyField id="admin-credit-balance" label="Credit balance" placeholder="5000.00"
            value={balance} onChange={setBalance} disabled={dis} />
          <label className="block">
            <span className={LABEL} title="The date that balance was correct">As of</span>
            <input id="admin-credit-as-of" type="date" disabled={dis}
              className={`${AdminUI.input} mt-1 font-mono disabled:opacity-60`}
              value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id="admin-credit-derived" className="text-xs text-zinc-500 dark:text-zinc-400">{derived}</p>
          {canWrite ? (
            <button id="admin-save-credits-btn" type="button" className={AdminUI.btn.primary}
              onClick={saveCredits}>Save</button>
          ) : null}
        </div>
        <StatusLine id="admin-credits-status" status={creditsStatus} okClass="text-emerald-700 dark:text-emerald-400" />
      </div>
    </>
  );
}

let host: Element | null = null;

const AdminLimits = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <LimitsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminLimits = AdminLimits;

// AppLimitCard is exported for tests/app-limit.test.js, which renders it,
// GithubBudgetCard for tests/github-budget.test.js, and GithubBudgetFigures
// for tests/github-spend.test.js, which renders it from a payload.
export { AdminLimits, AppLimitCard, GithubBudgetCard, GithubBudgetFigures };
