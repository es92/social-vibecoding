'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Homeroom bot (#admin/homeroom-bot) — #2684, slice 1.
//
// The bot triages open requests in SHADOW MODE: for each issue it runs a
// read-only scout turn with the app's repository open and records one
// verdict — the question it would ask, that the issue is ready to build,
// or that a person has to decide — without posting, claiming, building or
// notifying anybody. This screen is the only place those verdicts show,
// and the two one-tap ratings per row are the calibration signal the later
// slices (posting, building) are gated on. services/homeroom-bot.js has the
// full reasoning; routes/admin.js the four endpoints.
//
// PERMISSIONS: visible to any admin; the controls, the "run now" box and
// the ratings are gated on AdminConsole.canWrite(), and the server enforces
// the same with requireAdminWrite on the three writes.

interface Settings {
  mode: 'off' | 'shadow' | 'live';
  concurrency: number;
  batchSize: number;
  pausedApps: string[];
}

interface Bot {
  id: number;
  username: string;
  weeklyLimitCents: number;
  weeklySpentCents: number;
  hasIncludedKey: boolean;
  model: string | null;
}

interface Totals {
  days: number;
  runs: number;
  questions: number;
  ready: number;
  person: number;
  failed: number;
  rated: number;
  agreed: number;
  suppressed: number;
  costUsd: number;
}

interface QueueItem {
  id: number;
  issue_number: number;
  priority: number;
  reason: string;
  enqueued_at: string;
  started_at: string | null;
  app_slug: string;
  app_name: string;
}

interface Run {
  id: number;
  issue_number: number;
  mode: string;
  verdict: 'question' | 'ready' | 'person' | 'failed';
  determined: boolean | null;
  missing_fact: string | null;
  question: string | null;
  question_default: string | null;
  build_note: string | null;
  reason: string | null;
  cap_suppressed: string | null;
  rating: 'yes' | 'no' | null;
  rating_note: string | null;
  rated_at: string | null;
  rated_by: string | null;
  model: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
  app_slug: string;
  app_name: string;
  issueUrl: string | null;
}

interface LastPass {
  at: string;
  mode: string | null;
  busy: boolean;
  refreshed: boolean;
  processed: number;
  paused: string | null;
  detail?: string | null;
}

interface Payload {
  settings: Settings;
  modes: string[];
  bot: Bot | null;
  loop: LastPass | null;
  totals: Totals;
  queue: { depth: number; items: QueueItem[] };
  runs: Run[];
  apps: { slug: string; name: string }[];
  caps: { proposalsPerApp: number; questionsPerAppPerDay: number };
}

type Tone = 'ok' | 'err';
interface Status { text: string; tone: Tone }

function money(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(Number(usd))) return '–';
  return `$${Number(usd).toFixed(2)}`;
}

function dollarsFromCents(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(Number(cents))) return '–';
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const VERDICT_LABEL: Record<Run['verdict'], string> = {
  question: 'Needs a question',
  ready: 'Ready to build',
  person: 'Needs a person',
  failed: 'Failed',
};

const VERDICT_BADGE: Record<Run['verdict'], string> = {
  question: AdminUI.badge.warn,
  ready: AdminUI.badge.success,
  person: AdminUI.badge.secondary,
  failed: AdminUI.badge.destructive,
};

const CAP_LABEL: Record<string, string> = {
  proposals_per_app: 'would be held: 2 bot proposals already open on this app',
  question_tripwire: 'would be held: question tripwire for this app tripped today',
};

/** What the bot would have posted, as one block of plain text per verdict. */
function VerdictBody({ run }: { run: Run }) {
  if (run.verdict === 'question') {
    return (
      <div className="space-y-1">
        <p className="text-sm">{run.question || '(no question text)'}</p>
        {run.question_default ? (
          <p className={AdminUI.muted}>Suggested default: {run.question_default}</p>
        ) : null}
      </div>
    );
  }
  if (run.verdict === 'ready') {
    return <p className="text-sm whitespace-pre-line">{run.build_note || '(no build note)'}</p>;
  }
  if (run.verdict === 'person') {
    return <p className="text-sm">{run.reason || '(no reason given)'}</p>;
  }
  return <p className="text-sm text-red-400 break-words">{run.error || 'The run failed before it produced a verdict.'}</p>;
}

function HomeroomBotSection() {
  const console_ = () => (window as any).AdminConsole;
  const canWrite = !!console_()?.canWrite();

  const [payload, setPayload] = useState<Payload | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState('');
  const [appFilter, setAppFilter] = useState('');
  const [verdictFilter, setVerdictFilter] = useState('');
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [capDraft, setCapDraft] = useState('');
  const [runSlug, setRunSlug] = useState('');
  const [runIssue, setRunIssue] = useState('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const apply = useCallback((data: Payload) => {
    setPayload(data);
    setCapDraft(data.bot ? (data.bot.weeklyLimitCents / 100).toFixed(2) : '');
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (appFilter) params.set('app', appFilter);
    if (verdictFilter) params.set('verdict', verdictFilter);
    const qs = params.toString();
    const { data } = await console_().fetchJson(`/api/admin/homeroom-bot${qs ? `?${qs}` : ''}`);
    if (alive.current && data && typeof data === 'object') apply(data as Payload);
  }, [apply, appFilter, verdictFilter]);

  useEffect(() => { load(); }, [load]);

  // A pass takes a minute or two per issue; a slow poll keeps the queue and
  // the totals honest without hammering the endpoint. Cleared on destroy.
  useEffect(() => {
    const handle = window.setInterval(() => { load(); }, 30_000);
    return () => window.clearInterval(handle);
  }, [load]);

  const write = async (url: string, method: string, body: unknown, okText: string) => {
    setStatus(null);
    setBusy(url);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (!alive.current) return null;
      setStatus({ text: okText, tone: 'ok' });
      return data;
    } catch (err: any) {
      if (alive.current) setStatus({ text: `Save failed: ${err.message}`, tone: 'err' });
      return null;
    } finally {
      if (alive.current) setBusy('');
    }
  };

  const saveSettings = async (patch: Partial<Settings> & { weeklyLimitCents?: number }, okText: string) => {
    const data = await write('/api/admin/homeroom-bot/settings', 'PUT', patch, okText);
    if (data) apply(data as Payload);
  };

  const rate = async (run: Run, rating: 'yes' | 'no' | null) => {
    const data = await write(`/api/admin/homeroom-bot/runs/${run.id}/rating`, 'POST', { rating },
      rating ? `#${run.issue_number} rated.` : `#${run.issue_number} rating cleared.`);
    if (data) load();
  };

  const runNow = async () => {
    const n = Number(runIssue);
    if (!runSlug || !Number.isInteger(n) || n <= 0) {
      setStatus({ text: 'Pick an app and type an issue number.', tone: 'err' });
      return;
    }
    const data = await write('/api/admin/homeroom-bot/run', 'POST', { slug: runSlug, issueNumber: n },
      `#${n} on ${runSlug} is at the head of the queue${payload?.settings.mode === 'off' ? ' (the bot is off, so it waits)' : ''}.`);
    if (data) { setRunIssue(''); load(); }
  };

  const togglePause = async (slug: string) => {
    if (!payload) return;
    const paused = new Set(payload.settings.pausedApps);
    const willPause = !paused.has(slug);
    if (willPause) paused.add(slug); else paused.delete(slug);
    await saveSettings({ pausedApps: [...paused] }, willPause ? `${slug} paused.` : `${slug} resumed.`);
  };

  const settings = payload?.settings;
  const totals = payload?.totals;
  const bot = payload?.bot;
  const runs = payload?.runs || [];
  const paused = new Set(settings?.pausedApps || []);
  const agreement = totals && totals.rated > 0 ? Math.round((totals.agreed / totals.rated) * 100) : null;

  const tile = (label: string, value: string, id: string) => (
    <div className="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3" id={id}>
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );

  return (
    <div className="space-y-4" id="admin-homeroom-bot">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>Homeroom bot</h2>
          <span className={AdminUI.cardDescription} id="admin-homeroom-bot-mode-label">
            {settings ? (settings.mode === 'off' ? 'Off' : settings.mode === 'shadow' ? 'Shadow mode: triaging, posting nothing' : 'Live') : 'Loading…'}
          </span>
        </div>
        <p className={`${AdminUI.muted} mb-4`} id="admin-homeroom-bot-intro">
          In shadow mode the bot reads each open request, its discussion and the app’s code, and records what it
          would do: the one question it would ask, that the request is ready to build, or that a person has to decide.
          It posts nothing, claims nothing and builds nothing. Rate its verdicts here; that is what decides whether it
          is ever allowed to post.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {tile(`Runs, ${totals?.days || 7} days`, String(totals?.runs ?? 0), 'admin-homeroom-bot-tile-runs')}
          {tile('Ask / ready / person', totals ? `${totals.questions} / ${totals.ready} / ${totals.person}` : '–', 'admin-homeroom-bot-tile-mix')}
          {tile('Agreed with', agreement == null ? (totals && totals.rated ? '–' : 'unrated') : `${agreement}% of ${totals?.rated}`, 'admin-homeroom-bot-tile-agreement')}
          {tile('Spent this week', bot ? `${dollarsFromCents(bot.weeklySpentCents)} of ${dollarsFromCents(bot.weeklyLimitCents)}` : '–', 'admin-homeroom-bot-tile-spend')}
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bot-mode">Mode</label>
            <select
              id="admin-homeroom-bot-mode"
              className={`${AdminUI.select} mt-1`}
              value={settings?.mode || 'off'}
              disabled={!canWrite || busy !== ''}
              onChange={(e) => saveSettings({ mode: e.target.value as Settings['mode'] },
                e.target.value === 'off' ? 'The bot is off.' : 'Shadow mode on: the next pass starts within two minutes.')}
            >
              <option value="off">Off</option>
              <option value="shadow">Shadow (record only)</option>
              <option value="live" disabled>Live (not in this build)</option>
            </select>
          </div>
          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bot-cap">Weekly cap, dollars</label>
            <div className="flex items-center gap-2 mt-1">
              <input
                id="admin-homeroom-bot-cap"
                type="number" min="0" step="1" inputMode="decimal"
                className={AdminUI.input}
                value={capDraft}
                disabled={!canWrite}
                onChange={(e) => setCapDraft(e.target.value)}
              />
              {canWrite ? (
                <button
                  type="button" className={AdminUI.btn.primarySm}
                  disabled={busy !== ''}
                  onClick={() => {
                    const dollars = Number(capDraft);
                    if (!Number.isFinite(dollars) || dollars < 0) {
                      setStatus({ text: 'Enter a dollar amount.', tone: 'err' });
                      return;
                    }
                    saveSettings({ weeklyLimitCents: Math.round(dollars * 100) }, `Weekly cap is now $${dollars.toFixed(2)}.`);
                  }}
                >Save</button>
              ) : null}
            </div>
          </div>
          <div>
            <label className={AdminUI.label} htmlFor="admin-homeroom-bot-batch">Issues per app before switching apps</label>
            <div className="flex items-center gap-2 mt-1">
              <input
                id="admin-homeroom-bot-batch"
                type="number" min="1" max="500" step="1"
                className={AdminUI.input}
                defaultValue={settings?.batchSize ?? 100}
                key={`batch-${settings?.batchSize ?? 100}`}
                disabled={!canWrite}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (n === settings?.batchSize) return;
                  if (!Number.isInteger(n) || n < 1 || n > 500) {
                    setStatus({ text: 'Issues per app must be a whole number from 1 to 500.', tone: 'err' });
                    return;
                  }
                  saveSettings({ batchSize: n }, `The bot now takes up to ${n} issues on one app before it looks at another.`);
                }}
              />
            </div>
          </div>
        </div>

        <p className={`${AdminUI.muted} mt-3`} id="admin-homeroom-bot-identity">
          {`${bot
            ? `Runs as ${bot.username} on ${bot.model || 'the platform default model'}, ${bot.hasIncludedKey ? 'with its included OpenRouter key' : 'with no OpenRouter key yet (the first pass mints one)'}.`
            : 'The bot user is not set up yet; the dashboard creates it on load, so check the logs if this persists.'} Before posting anything the live rules would hold a verdict at ${payload?.caps.proposalsPerApp ?? 2} open bot proposals per app and ${payload?.caps.questionsPerAppPerDay ?? 10} questions per app per day; rows below say when they would have.`}
        </p>

        <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-loop">
          {payload?.loop
            ? `Last pass ${when(payload.loop.at)}: ${payload.loop.processed} triaged${payload.loop.refreshed ? ', queue refreshed' : ''}${
              payload.loop.paused === 'budget' ? '; paused on the weekly cap'
                : payload.loop.paused === 'infra' ? `; paused on a platform fault (${payload.loop.detail || 'see the logs'})`
                  : payload.loop.paused === 'mode_off' ? '; stopped because the mode was switched off'
                    : payload.loop.busy ? '; another instance held the loop' : ''}.`
            : 'No pass has run since the platform started.'}
        </p>
        <p className={`${AdminUI.muted} mt-1`} id="admin-homeroom-bot-cadence">
          The loop wakes the moment a request is filed, edited or discussed here, drains the queue, then sleeps until the next one. A sweep of GitHub every five minutes catches what happens there directly.
        </p>
        <p id="admin-homeroom-bot-status" className={status
          ? `text-xs mt-3 ${status.tone === 'err' ? 'text-red-400' : 'text-green-800 dark:text-green-400'}`
          : 'text-xs mt-3 hidden'}>
          {status ? status.text : ''}
        </p>
      </div>

      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h3 className={AdminUI.cardTitle}>Queue</h3>
          <span className={AdminUI.cardDescription} id="admin-homeroom-bot-queue-depth">
            {payload ? `${payload.queue.depth} waiting` : ''}
          </span>
        </div>
        {payload && payload.queue.items.length ? (
          <ul className="text-sm space-y-1" id="admin-homeroom-bot-queue">
            {payload.queue.items.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-2">
                <span className={q.started_at ? AdminUI.badge.secondary : AdminUI.badge.default}>
                  {q.started_at ? 'running' : q.priority === 0 ? 'run now' : q.reason}
                </span>
                <span>{q.app_name}</span>
                <span className={AdminUI.muted}>#{q.issue_number}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={AdminUI.muted}>Nothing queued. The queue refreshes from open requests every five minutes while the bot is on.</p>
        )}
        {canWrite ? (
          <div className="flex flex-wrap items-end gap-2 mt-4">
            <div>
              <label className={AdminUI.label} htmlFor="admin-homeroom-bot-run-app">Run now on</label>
              <select
                id="admin-homeroom-bot-run-app"
                className={`${AdminUI.select} mt-1`}
                value={runSlug}
                onChange={(e) => setRunSlug(e.target.value)}
              >
                <option value="">Pick an app…</option>
                {(payload?.apps || []).map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
              </select>
            </div>
            <div>
              <label className={AdminUI.label} htmlFor="admin-homeroom-bot-run-issue">Issue #</label>
              <input
                id="admin-homeroom-bot-run-issue"
                type="number" min="1" step="1"
                className={`${AdminUI.input} mt-1 w-28`}
                value={runIssue}
                onChange={(e) => setRunIssue(e.target.value)}
              />
            </div>
            <button type="button" className={AdminUI.btn.outlineSm} disabled={busy !== ''} onClick={runNow}>
              Queue it first
            </button>
          </div>
        ) : null}
      </div>

      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h3 className={AdminUI.cardTitle}>Verdicts</h3>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id="admin-homeroom-bot-filter-app"
              className={AdminUI.select}
              aria-label="Filter by app"
              value={appFilter}
              onChange={(e) => setAppFilter(e.target.value)}
            >
              <option value="">All apps</option>
              {(payload?.apps || []).map((a) => <option key={a.slug} value={a.slug}>{a.name}</option>)}
            </select>
            <select
              id="admin-homeroom-bot-filter-verdict"
              className={AdminUI.select}
              aria-label="Filter by verdict"
              value={verdictFilter}
              onChange={(e) => setVerdictFilter(e.target.value)}
            >
              <option value="">All verdicts</option>
              <option value="question">Needs a question</option>
              <option value="ready">Ready to build</option>
              <option value="person">Needs a person</option>
              <option value="failed">Failed</option>
            </select>
          </div>
        </div>
        <div className={AdminUI.tableWrap}>
          <table className={AdminUI.table} id="admin-homeroom-bot-table">
            <thead className={AdminUI.thead}>
              <tr>
                <th className={AdminUI.th}>When</th>
                <th className={AdminUI.th}>App</th>
                <th className={AdminUI.th}>Issue</th>
                <th className={AdminUI.th}>Verdict</th>
                <th className={AdminUI.th}>Cost</th>
                <th className={AdminUI.th}>Rating</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const isOpen = !!open[run.id];
                const ratingLabel = run.verdict === 'question' ? 'Right question?' : run.verdict === 'ready' ? 'Would you have built this?' : 'Agree?';
                return [
                  <tr className={AdminUI.trHover} key={run.id} data-homeroom-bot-run={run.id} data-verdict={run.verdict}>
                    <td className={`${AdminUI.td} whitespace-nowrap`}>{when(run.created_at)}</td>
                    <td className={AdminUI.td}>
                      <span>{run.app_name}</span>
                      {canWrite ? (
                        <button
                          type="button"
                          className={`${AdminUI.btn.ghost} ml-2 text-xs`}
                          disabled={busy !== ''}
                          onClick={() => togglePause(run.app_slug)}
                        >{paused.has(run.app_slug) ? 'resume' : 'pause'}</button>
                      ) : null}
                    </td>
                    <td className={AdminUI.td}>
                      {run.issueUrl
                        ? <a className={AdminUI.btn.link} href={run.issueUrl}>#{run.issue_number}</a>
                        : <span>#{run.issue_number}</span>}
                    </td>
                    <td className={AdminUI.td}>
                      <button
                        type="button"
                        className="text-left"
                        aria-expanded={isOpen}
                        onClick={() => setOpen((o) => ({ ...o, [run.id]: !isOpen }))}
                      >
                        <span className={VERDICT_BADGE[run.verdict]}>{VERDICT_LABEL[run.verdict]}</span>
                        {run.cap_suppressed ? <span className={`${AdminUI.badge.outline} ml-1`}>held</span> : null}
                        <span className={`${AdminUI.muted} ml-2`}>{isOpen ? 'hide' : 'show'}</span>
                      </button>
                    </td>
                    <td className={`${AdminUI.td} whitespace-nowrap`}>{money(run.cost_usd)}</td>
                    <td className={`${AdminUI.td} whitespace-nowrap`}>
                      {run.verdict === 'failed' ? (
                        <span className={AdminUI.muted}>–</span>
                      ) : canWrite ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            className={run.rating === 'yes' ? AdminUI.btn.primarySm : AdminUI.btn.outlineSm}
                            disabled={busy !== ''}
                            title={ratingLabel}
                            onClick={() => rate(run, run.rating === 'yes' ? null : 'yes')}
                          >Yes</button>
                          <button
                            type="button"
                            className={run.rating === 'no' ? AdminUI.btn.destructiveSm : AdminUI.btn.outlineSm}
                            disabled={busy !== ''}
                            title={ratingLabel}
                            onClick={() => rate(run, run.rating === 'no' ? null : 'no')}
                          >No</button>
                        </div>
                      ) : (
                        <span className={AdminUI.muted}>{run.rating ? `${run.rating}${run.rated_by ? ` (${run.rated_by})` : ''}` : 'unrated'}</span>
                      )}
                    </td>
                  </tr>,
                  isOpen ? (
                    <tr key={`${run.id}-detail`} data-homeroom-bot-detail={run.id}>
                      <td className={AdminUI.td} colSpan={6}>
                        <div className="space-y-2">
                          <div className={AdminUI.muted}>{ratingLabel}</div>
                          <VerdictBody run={run} />
                          <div className={`${AdminUI.muted} flex flex-wrap gap-x-4 gap-y-1`}>
                            <span>determined: {run.determined == null ? '–' : run.determined ? 'yes' : 'no'}</span>
                            {run.missing_fact ? <span>missing: {run.missing_fact}</span> : null}
                            {run.cap_suppressed ? <span>{CAP_LABEL[run.cap_suppressed] || run.cap_suppressed}</span> : null}
                            {run.model ? <span>{run.model}</span> : null}
                            {run.duration_ms != null ? <span>{Math.round(run.duration_ms / 1000)}s</span> : null}
                            {run.rating_note ? <span>note: {run.rating_note}</span> : null}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
              {runs.length === 0 ? (
                <tr>
                  <td className={AdminUI.td} colSpan={6} id="admin-homeroom-bot-empty">
                    {payload
                      ? (settings?.mode === 'off'
                        ? 'No verdicts yet. Switch the mode to shadow and the first pass starts within two minutes.'
                        : 'No verdicts yet for this filter.')
                      : 'Loading…'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminHomeroomBot = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <HomeroomBotSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminHomeroomBot = AdminHomeroomBot;

export { AdminHomeroomBot };
