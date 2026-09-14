'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';
import { messageStamp } from '../../lib/timestamp';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Health & status section of the admin console (#860) — the whole of the
// retired standalone /status page, ported into the console's
// #admin/status section. Same markup, same renderers, same 5s
// auto-refresh with the pause checkbox and manual refresh button.
//
// The `.admin-only` visibility flag lives on this section's own root
// element rather than on <body class="is-admin">, so it can never hide
// `.admin-only` markup elsewhere in the SPA (see #admin-status-root in
// public/css/app.css). The "→ full status" link switches to the in-console
// #admin/node section rather than opening /node-status in a new tab.
//
// PERMISSIONS: this is one of the two `public` console sections. The
// server does the real work — GET /api/status runs the payload through
// src/services/status.js `redact()`, which strips live worker progress,
// model names, spend, host RAM/load, DB pool internals, stuck sessions
// and the event ring buffer for non-admins. This module only mirrors
// that with the `is-admin` class so the admin-only HEADINGS disappear
// too; it never gates on a client-side flag for data it wouldn't
// otherwise receive.
//
// ── React-owned (#1120 slice 13) ──────────────────────────────────────
//
// Eighth section through the seam, and the largest so far: ten renderers
// producing one string each, written into ten hosts by a `set(id, html)`
// helper on every 5s tick, plus three more fields written by textContent and
// one banner toggled by class. It is now ten components over one piece of
// state, and the tick is a `setSnapshot`.
//
// Two lifecycle details this section had that the others did not:
//
//   * TWO intervals — the 5s poll and a 1s countdown — rebuilt together by
//     `_scheduleRefresh()` every time the pause checkbox changed. They are
//     one effect keyed on the checkbox now, so pausing cannot leave the
//     countdown running without the poll (or the reverse).
//   * `if (!document.getElementById('admin-status-root')) return;` twice
//     inside refresh(), with the comment "or, worse, resurrect the poll
//     after destroy()". Nothing can resurrect an interval whose effect has
//     been cleaned up.

const REFRESH_MS = 5000;

type Tone = 'zinc' | 'green' | 'yellow' | 'red';

interface StatusData { [key: string]: any }

// Seconds → "45s" / "3m 20s" / "2h 5m" / "1d 3h".
function fmtDurationSeconds(seconds?: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

// Milliseconds → the compact inline form ("2h 5m" / "45s"). The old page had
// TWO functions both called fmtDuration — a seconds one and a later ms one
// that shadowed it — so every seconds-taking call site was silently reading
// the ms version. Two explicit names here; call sites use whichever unit the
// field actually is.
function fmtDurationMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hrs = Math.floor(m / 60);
  const remM = m % 60;
  if (hrs < 24) return remM ? `${hrs}h ${remM}m` : `${hrs}h`;
  const d = Math.floor(hrs / 24);
  return `${d}d ${hrs % 24}h`;
}

function fmtDollars(cents?: number): string {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function fmtBytes(bytes?: number | null): string {
  if (bytes == null) return '—';
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

const BAR_TONE: Record<Tone, string> = {
  zinc: 'bg-zinc-500', green: 'bg-green-500', yellow: 'bg-yellow-500', red: 'bg-red-500',
};

function MeterRow({ label, value, pct, tone = 'zinc' }: {
  label: string; value: React.ReactNode; pct?: number; tone?: Tone;
}) {
  const w = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return (
    <div className="mb-2">
      <div className="flex justify-between text-xs mb-1">
        <span className="text-zinc-600 dark:text-zinc-400">{label}</span>
        <span className="mono text-zinc-700 dark:text-zinc-300">{value}</span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
        <div className={`h-full ${BAR_TONE[tone] || BAR_TONE.zinc}`} style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

const PILL_STATE: Record<string, string> = {
  running: 'pill-running',
  exited: 'pill-stopped',
  stopped: 'pill-stopped',
  paused: 'pill-stopped',
  dead: 'pill-missing',
  missing: 'pill-missing',
  creating: 'pill-creating',
  restarting: 'pill-creating',
  unknown: 'pill-stopped',
};

function StatePill({ state, label }: { state?: string; label?: string }) {
  return (
    <span className={`pill ${(state && PILL_STATE[state]) || 'pill-stopped'}`}>
      <span className="dot" />{label || state}
    </span>
  );
}

const CARD_TONE: Record<Tone, string> = {
  zinc: 'border-zinc-200 dark:border-zinc-800',
  green: 'border-green-300 dark:border-green-700/40',
  yellow: 'border-yellow-300 dark:border-yellow-700/40',
  red: 'border-red-300 dark:border-red-700/40',
};

function SummaryCard({ label, tone = 'zinc', children }: {
  label: string; tone?: Tone; children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border ${CARD_TONE[tone]} bg-zinc-50 dark:bg-zinc-900/60 p-3`}>
      <div className="text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">{label}</div>
      <div className="text-xl font-semibold mt-0.5">{children}</div>
    </div>
  );
}

// Capacity & host panel — the ramp dashboard. Leads with the two numbers that
// decide whether the box is near its limit (sessions vs cap, active turns)
// then host RAM/load and DB pool saturation, then the lifecycle backlog
// (paused / stale-heading-to-archive / resumable archives).
function Capacity({ data }: { data: StatusData }) {
  const c = data.capacity;
  if (!c) return <div className="text-zinc-500 dark:text-zinc-400">No capacity data.</div>;
  const host = data.host;
  const db = data.db;
  const sessPct = c.globalCap ? (c.globalUsed / c.globalCap) * 100 : 0;
  const sessTone: Tone = sessPct >= 90 ? 'red' : sessPct >= 70 ? 'yellow' : 'green';
  const bs = c.byStatus || {};
  const namespaces = Array.isArray(c.namespaces) ? c.namespaces : [];
  const memUsed = host ? host.memTotalBytes - host.memFreeBytes : 0;
  const memTone: Tone = host && host.memUsedPct >= 90 ? 'red' : host && host.memUsedPct >= 75 ? 'yellow' : 'green';
  const loadPct = host && host.cpus ? (host.loadAvg1 / host.cpus) * 100 : 0;
  const loadTone: Tone = loadPct >= 100 ? 'red' : loadPct >= 70 ? 'yellow' : 'zinc';
  const poolBusy = db ? Math.max(0, db.total - db.idle) : 0;
  const poolPct = db && db.max ? (poolBusy / db.max) * 100 : 0;
  const poolTone: Tone = db && db.waiting > 0 ? 'red' : poolPct >= 80 ? 'yellow' : 'zinc';
  // #1771: the figure the pool above is competing FOR. One Postgres backs the
  // platform, every app and every preview; the pool meter can read 3 / 60
  // while the server is one connection from refusing work.
  const server = db ? db.server : null;
  const serverPct = server && server.max ? (server.used / server.max) * 100 : 0;
  const serverTone: Tone = serverPct >= 90 ? 'red' : serverPct >= 75 ? 'yellow' : 'green';

  return (
    <>
      <MeterRow label="Sessions (active + promoted)" value={`${c.globalUsed} / ${c.globalCap}`} pct={sessPct} tone={sessTone} />
      <div className="flex justify-between text-xs mb-3 text-zinc-600 dark:text-zinc-400">
        <span>
          {'Active turns '}<span className="mono text-zinc-800 dark:text-zinc-200">{c.activeTurns}</span>
          {' · warm idle '}<span className="mono text-zinc-800 dark:text-zinc-200">{c.warmIdleWorkers}</span>
        </span>
        <span>{'per-user cap '}<span className="mono text-zinc-800 dark:text-zinc-200">{c.userCap}</span></span>
      </div>

      {data.runtimeKind === 'kubernetes' ? (
        <>
          {!namespaces.length
            ? <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">Namespace quota status is unavailable.</div>
            : null}
          {namespaces.map((item: any) => {
            const resources = item.resources;
            const rows: Array<[string, any]> = resources ? [
              ['Pods', resources.pods],
              ['CPU requests', resources.requestsCpu],
              ['Memory requests', resources.requestsMemory],
              ['CPU limits', resources.limitsCpu],
              ['Memory limits', resources.limitsMemory],
              ['Ephemeral storage requests', resources.requestsEphemeralStorage],
              ['Ephemeral storage limits', resources.limitsEphemeralStorage],
              ['Persistent storage requests', resources.requestsStorage],
              ['Volume claims', resources.persistentVolumeClaims],
              ['Services', resources.services],
              ['Secrets', resources.secrets],
              ['ConfigMaps', resources.configMaps],
              ['Jobs', resources.jobs],
              ['Build records', resources.builds],
            ] : [];
            return (
              <div key={item.namespace} className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800">
                <div className="text-xs font-medium mono text-zinc-700 dark:text-zinc-300 mb-2">{item.namespace}</div>
                {!resources
                  ? <div className="text-xs text-zinc-500 dark:text-zinc-400">No readable ResourceQuota.</div>
                  : rows.filter(([, metric]) => metric).map(([label, metric]) => {
                    const pct = metric.percent == null ? 0 : metric.percent;
                    const tone: Tone = pct >= 90 ? 'red' : pct >= 75 ? 'yellow' : 'green';
                    return (
                      <MeterRow key={label} label={label} pct={pct} tone={tone}
                        value={`${metric.used} / ${metric.hard}${
                          metric.headroomPercent == null ? '' : ` · ${metric.headroomPercent}% headroom`}`} />
                    );
                  })}
              </div>
            );
          })}
        </>
      ) : host ? (
        <>
          <MeterRow label="Host RAM" pct={host.memUsedPct} tone={memTone}
            value={`${fmtBytes(memUsed)} / ${fmtBytes(host.memTotalBytes)} (${host.memUsedPct}%)`} />
          <MeterRow label={`Load (1m) / ${host.cpus} cores`} pct={loadPct} tone={loadTone} value={`${host.loadAvg1}`} />
        </>
      ) : null}

      {db ? (
        <MeterRow label="DB pool (busy / max)" pct={poolPct} tone={poolTone}
          value={`${poolBusy} / ${db.max} · ${db.idle} idle${db.waiting > 0 ? ` · ${db.waiting} waiting` : ''}`} />
      ) : null}

      {server ? (
        <>
          <MeterRow label="Postgres server (backends / max_connections)" pct={serverPct} tone={serverTone}
            value={`${server.used} / ${server.max}${server.idle ? ` · ${server.idle} idle` : ''}`} />
          {server.topDatabases?.length ? (
            <div className="text-xs mb-3 text-zinc-600 dark:text-zinc-400">
              {server.topDatabases.slice(0, 4).map((row: any, index: number) => (
                <span key={row.name}>
                  {index ? ' · ' : ''}
                  <span className="mono text-zinc-800 dark:text-zinc-200">{row.name}</span>
                  {` ${row.count}`}
                </span>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-800 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="flex justify-between"><span className="text-zinc-500 dark:text-zinc-400">active</span><span className="mono">{bs.active ?? 0}</span></div>
        <div className="flex justify-between"><span className="text-zinc-500 dark:text-zinc-400">promoted</span><span className="mono">{bs.promoted ?? 0}</span></div>
        <div className="flex justify-between"><span className="text-zinc-500 dark:text-zinc-400">paused</span><span className="mono">{bs.paused ?? 0}</span></div>
        <div className="flex justify-between"><span className="text-zinc-500 dark:text-zinc-400">archived</span><span className="mono">{bs.archived ?? 0}</span></div>
        <div className="flex justify-between">
          <span className="text-zinc-500 dark:text-zinc-400">stale → archive</span>
          <span className={c.staleNotified > 0 ? 'mono text-yellow-800 dark:text-yellow-400' : 'mono'}>{c.staleNotified}</span>
        </div>
        <div className="flex justify-between"><span className="text-zinc-500 dark:text-zinc-400">resumable</span><span className="mono">{c.archivedResumable}</span></div>
      </div>
    </>
  );
}

// Maps the sidecar's `node_sync_status` (Synced / Syncing / Connected /
// Connecting / unreachable / unknown) onto a human label, a status pill
// class, and the summary-card tone. Centralized so Node and Summary agree.
function nodeStatusMeta(node: any): { label: string; pill: string; tone: Tone } {
  if (!node || !node.status) return { label: 'unknown', pill: 'pill-stopped', tone: 'zinc' };
  switch (node.status) {
    case 'Synced': return { label: 'Synced', pill: 'pill-running', tone: 'green' };
    // Syncing after first sync is healthy ("just applying new tip blocks").
    // Before first sync it's a fresh boot still catching up — yellow there.
    case 'Syncing': return {
      label: 'Syncing',
      pill: node.hasBeenSynced ? 'pill-running' : 'pill-creating',
      tone: node.hasBeenSynced ? 'green' : 'yellow',
    };
    case 'Connected': return { label: 'Connected', pill: 'pill-creating', tone: 'yellow' };
    case 'Connecting': return { label: 'Connecting', pill: 'pill-creating', tone: 'yellow' };
    case 'unreachable': return { label: 'Unreachable', pill: 'pill-missing', tone: 'red' };
    case 'mock': return { label: 'Mock', pill: 'pill-stopped', tone: 'zinc' };
    default: return { label: node.status, pill: 'pill-stopped', tone: 'zinc' };
  }
}

function Summary({ s, node, runtimeKind }: { s: StatusData; node: any; runtimeKind?: string }) {
  if (runtimeKind === 'preview') return (
    <SummaryCard label="Runtime status" tone="zinc">Unavailable in previews</SummaryCard>
  );
  const prodTone: Tone = s.prodMissing > 0 ? 'red' : 'green';
  const workerTone: Tone = s.workersOrphaned > 0 ? 'red' : 'zinc';
  const stuckTone: Tone = s.stuckSessions > 0 ? 'yellow' : 'zinc';
  // Node summary card. Tone matches the dot colour in <Node/> so the
  // top-of-page glance and the dedicated section agree.
  const nodeMeta = nodeStatusMeta(node);

  // Long-lived worker breakdown: "in-flight" is what used to be the only
  // meaningful workersRunning figure; warm-idle is the new background memory
  // cost the operator pays for fast subsequent dispatches.
  const inFlight = s.workersInFlight ?? s.workersRunning ?? 0;
  const warmIdle = s.workersWarmIdle ?? 0;
  const k8s = runtimeKind === 'kubernetes';

  const cards: React.ReactNode[] = [
    <SummaryCard key="node" label="Node" tone={nodeMeta.tone}>
      {nodeMeta.label}
      {node && typeof node.peers === 'number'
        ? <> <span className="text-zinc-500 dark:text-zinc-400 text-xs">{`${node.peers}p`}</span></>
        : null}
    </SummaryCard>,
    <SummaryCard key="apps" label="Apps" tone={prodTone}>{`${s.prodRunning}/${s.apps}`}</SummaryCard>,
    <SummaryCard key="staging" label="Staging">
      {k8s ? `${s.stagingRunning || 0}/${s.stagingTotal || 0}` : `${s.stagingRunning}/${s.stagingCap}`}
    </SummaryCard>,
    <SummaryCard key="workers" label="Workers" tone={workerTone}>
      {k8s ? (
        <>
          {`${s.workersReady || 0}/${s.workersTotal || 0}`}
          {inFlight > 0 ? <> <span className="text-zinc-500 dark:text-zinc-400 text-xs">{`${inFlight} active`}</span></> : null}
        </>
      ) : (
        <>
          {inFlight}
          {warmIdle > 0 ? <> <span className="text-zinc-500 dark:text-zinc-400 text-xs">{`+${warmIdle} warm`}</span></> : null}
          {s.workersOrphaned > 0 ? <> <span className="text-red-700 dark:text-red-400 text-xs">{`+${s.workersOrphaned} orphan`}</span></> : null}
        </>
      )}
    </SummaryCard>,
    <SummaryCard key="stuck" label="Missing previews" tone={stuckTone}>{`${s.stuckSessions}`}</SummaryCard>,
    <SummaryCard key="prodmissing" label="Prod missing" tone={s.prodMissing > 0 ? 'red' : 'zinc'}>{`${s.prodMissing}`}</SummaryCard>,
  ];

  if (s.globalSpendCents != null) {
    const spendPct = Math.round((s.globalSpendCents / s.globalSpendCap) * 100);
    const spendTone: Tone = spendPct > 80 ? 'red' : spendPct > 50 ? 'yellow' : 'zinc';
    cards.splice(5, 0, (
      <SummaryCard key="llm" label="LLM today" tone={spendTone}>
        {`${fmtDollars(s.globalSpendCents)} / ${fmtDollars(s.globalSpendCap)}`}
      </SummaryCard>
    ));
  }

  // Ramp headlines. Sessions vs the global cap (what 429s/eviction gate on)
  // and active turns (the real RAM pressure) are the two numbers to watch
  // during a load ramp. Host RAM/load are admin-only (stripped for non-admins
  // server-side), so guard on presence.
  if (s.sessionsGlobalCap != null) {
    const sessPct = s.sessionsGlobalCap ? Math.round((s.sessionsGlobalUsed / s.sessionsGlobalCap) * 100) : 0;
    const sessTone: Tone = sessPct >= 90 ? 'red' : sessPct >= 70 ? 'yellow' : 'zinc';
    cards.push(
      <SummaryCard key="sessions" label="Sessions" tone={sessTone}>
        {`${s.sessionsGlobalUsed}/${s.sessionsGlobalCap}`}
      </SummaryCard>,
    );
  }
  if (s.activeTurns != null) {
    cards.push(
      <SummaryCard key="turns" label="Active turns" tone={s.activeTurns > 0 ? 'green' : 'zinc'}>{`${s.activeTurns}`}</SummaryCard>,
    );
  }
  if (s.hostMemUsedPct != null) {
    const memTone: Tone = s.hostMemUsedPct >= 90 ? 'red' : s.hostMemUsedPct >= 75 ? 'yellow' : 'zinc';
    cards.push(<SummaryCard key="ram" label="Host RAM" tone={memTone}>{`${s.hostMemUsedPct}%`}</SummaryCard>);
  }
  if (s.dbPoolWaiting != null) {
    cards.push(
      <SummaryCard key="dbq" label="DB queue" tone={s.dbPoolWaiting > 0 ? 'red' : 'zinc'}>{`${s.dbPoolWaiting}`}</SummaryCard>,
    );
  }

  return <>{cards}</>;
}

const EXPLORER_META: Record<string, { label: string; pill: string }> = {
  ok: { label: 'Reachable', pill: 'pill-running' },
  unreachable: { label: 'Unreachable', pill: 'pill-missing' },
  bad_response: { label: 'Bad response', pill: 'pill-missing' },
  mock: { label: 'Mock', pill: 'pill-stopped' },
};

// Block-explorer card. The explorer is external infrastructure — this card
// reports, it does not repair. Its whole reason for existing is the
// consequence line: when the explorer is unreachable the wallet-link poller
// can't see incoming link transactions, so "Link wallet" silently never
// completes and nothing else says so.
function Explorer({ ex }: { ex: any }) {
  if (!ex || ex.status === 'unknown') {
    return <div className="text-zinc-500 dark:text-zinc-400">Explorer not probed yet.</div>;
  }
  const meta = EXPLORER_META[ex.status] || { label: ex.status, pill: 'pill-stopped' };
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`pill ${meta.pill}`}>{meta.label}</span>
        <span className="mono text-xs text-zinc-500 dark:text-zinc-400 break-all">{ex.host || '—'}</span>
        {ex.chainId ? <span className="text-xs text-zinc-500 dark:text-zinc-400">{'chain '}<span className="mono">{ex.chainId}</span></span> : null}
        {ex.latencyMs != null ? <span className="text-xs text-zinc-500 dark:text-zinc-400">{`${ex.latencyMs}ms`}</span> : null}
        {ex.status !== 'ok' && ex.downSince ? (
          <span className="text-red-700 dark:text-red-300/80">
            {`unreachable for ${fmtDurationMs(Date.now() - ex.downSince)}`}
            {ex.consecutiveFailures ? ` (${ex.consecutiveFailures} failed probes)` : ''}
          </span>
        ) : null}
      </div>
      {ex.status !== 'ok' ? (
        <div className="mt-3 rounded border border-red-300 dark:border-red-700/40 bg-red-50 dark:bg-red-900/20 p-2 text-xs">
          <span className="font-semibold text-red-700 dark:text-red-300">Wallet linking is paused: </span>
          <span className="text-red-700 dark:text-red-300/80">
            the chain poller reads incoming link transactions from this explorer, so &quot;Link wallet&quot; will not
            complete until it is reachable again. Retries are backing off; no action is needed here beyond restoring the upstream.
          </span>
        </div>
      ) : null}
      {ex.error ? <div className="mt-2 text-xs text-red-700 dark:text-red-400 mono break-all">{ex.error}</div> : null}
    </>
  );
}

function Node({ node }: { node: any }) {
  if (!node || node.status === 'unknown') {
    return <div className="text-zinc-500 dark:text-zinc-400">No NODE_RPC_URL configured, so node status is unavailable.</div>;
  }
  const meta = nodeStatusMeta(node);
  const ourTip = node.bestTipHeight;
  const peerTip = node.peerBestTipHeight;
  // Sync progress is only meaningful when we have both numbers; otherwise
  // hide the bar rather than render a misleading 0%/100%.
  const showBar = ourTip != null && peerTip != null && peerTip > 0;
  const pct = showBar ? Math.max(0, Math.min(100, (ourTip / peerTip) * 100)) : 0;
  const behind = showBar ? Math.max(0, peerTip - ourTip) : null;
  // Fresh-boot Syncing bar is yellow ("we're behind"); steady-state catch-up
  // after first sync is green ("just applying new tip blocks").
  const barColor = node.status === 'Syncing' && !node.hasBeenSynced ? 'bg-yellow-500'
    : node.status === 'Syncing' ? 'bg-green-500'
      : 'bg-violet-500';
  const ageSeconds = node.at ? Math.max(0, Math.floor((Date.now() - new Date(node.at).getTime()) / 1000)) : null;

  return (
    <>
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`pill ${meta.pill}`}><span className="dot" />{meta.label}</span>
        <span className="text-zinc-700 dark:text-zinc-300">{`${node.peers} peer${node.peers === 1 ? '' : 's'}`}</span>
        {node.hasFullUtxoDb === true ? <span className="pill pill-running"><span className="dot" />full UTXO DB</span> : null}
        {ageSeconds != null ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-400 ml-auto">
            {`updated ${ageSeconds < 60 ? `${ageSeconds}s` : `${Math.floor(ageSeconds / 60)}m`} ago`}
          </span>
        ) : null}
      </div>
      {(ourTip != null || peerTip != null) ? (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          {'tip '}<span className="mono text-zinc-700 dark:text-zinc-300">{ourTip != null ? ourTip.toLocaleString() : '—'}</span>
          {peerTip != null ? <>{' / '}<span className="mono text-zinc-600 dark:text-zinc-400">{peerTip.toLocaleString()}</span>{' on network'}</> : null}
          {behind != null && behind > 0
            ? <span className="text-yellow-800 dark:text-yellow-400 ml-1">{`(${behind.toLocaleString()} blocks behind)`}</span>
            : null}
        </div>
      ) : null}
      {showBar ? (
        <div className="mt-2">
          <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
            <div className={`h-full ${barColor} transition-all duration-300`} style={{ width: `${pct.toFixed(1)}%` }} />
          </div>
        </div>
      ) : null}
      {node.error ? <div className="mt-2 text-xs text-red-700 dark:text-red-400 mono break-all">{node.error}</div> : null}
      {/* PARTIAL_LEDGER_RECENT_TX_SOURCE_BUG warning. False here means the
          sidecar booted without HAS_FULL_UTXO_DB, which causes the recent-tx
          stream to silently drop tx from non-tracked senders. */}
      {node.hasFullUtxoDb === false ? (
        <div className="mt-3 rounded border border-red-300 dark:border-red-700/40 bg-red-50 dark:bg-red-900/20 p-2 text-xs">
          <span className="font-semibold text-red-700 dark:text-red-300">Partial ledger mode: </span>
          <span className="text-red-700 dark:text-red-300/80">
            sidecar booted without HAS_FULL_UTXO_DB. Incoming tx from non-tracked senders may be silently dropped.
            Restart with a fresh archive snapshot.
          </span>
        </div>
      ) : null}
    </>
  );
}

function SessionRow({ s }: { s: any }) {
  const stagingState = s.runtimeAvailable === false ? 'unknown'
    : s.staging?.state || (s.stagingDriftWarning ? 'missing' : 'creating');
  const stagingLabel = s.runtimeAvailable === false ? 'unavailable'
    : s.staging?.state || (s.stagingDriftWarning ? 'drift' : 'pending');
  const resolve = typeof window !== 'undefined' && typeof (window as any).resolveDevHost === 'function'
    ? (window as any).resolveDevHost
    : (u: string) => u;
  const stagingResolved = s.stagingUrl ? resolve(s.stagingUrl) : '';
  return (
    <div className="pl-3 border-l-2 border-zinc-200 dark:border-zinc-800 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <StatePill state={stagingState} label={`staging: ${stagingLabel}`} />
        <span className="text-zinc-600 dark:text-zinc-400 text-xs">{`#${s.id}`}</span>
        <span className="text-zinc-700 dark:text-zinc-300 text-xs">{`@${s.username}`}</span>
        <span className="mono text-zinc-500 dark:text-zinc-400 text-xs">{s.branchName || '—'}</span>
        <span className="text-xs">
          {s.prUrl
            ? <a href={s.prUrl} target="_blank" rel="noopener" className="text-violet-700 dark:text-violet-400 hover:underline">{`PR #${s.prNumber}`}</a>
            : <span className="text-zinc-500 dark:text-zinc-400">no PR</span>}
        </span>
        {s.prTitle ? <span className="text-zinc-700 dark:text-zinc-300 ml-2 truncate">{s.prTitle}</span> : null}
        <span className="text-zinc-500 dark:text-zinc-400 text-xs ml-auto">{fmtDurationSeconds(s.ageSeconds)}</span>
      </div>
      <div className="mt-0.5 text-xs flex items-center gap-2 flex-wrap">
        {s.stagingUrl ? (
          <a href={stagingResolved} target="_blank" rel="noopener"
            className="text-violet-700 dark:text-violet-400 hover:underline mono text-xs break-all">{stagingResolved}</a>
        ) : null}
        {s.staging?.stats ? (
          <span className="mono text-zinc-500 dark:text-zinc-400 ml-2">{`${s.staging.stats.mem} · ${s.staging.stats.cpu}`}</span>
        ) : null}
      </div>
      {s.worker ? (
        <div className="mt-1.5 pl-3 border-l-2 border-violet-300 dark:border-violet-800 text-xs">
          <div className="flex items-center gap-2">
            <StatePill state={s.worker.state || 'unknown'} label={`worker: ${s.worker.state || 'unknown'}`} />
            <span className="text-zinc-600 dark:text-zinc-400">
              {fmtDurationSeconds(s.worker.uptimeSeconds)}
              {s.worker.orphan ? <span className="text-red-700 dark:text-red-400 ml-1">(orphan)</span> : null}
            </span>
            {s.worker.model ? <span className="mono text-zinc-500 dark:text-zinc-400">{s.worker.model}</span> : null}
          </div>
          {s.worker.lastProgress
            ? <div className="text-zinc-600 dark:text-zinc-400 mt-0.5 mono truncate">{`▸ ${s.worker.lastProgress}`}</div>
            : null}
        </div>
      ) : null}
    </div>
  );
}

function Apps({ apps }: { apps: any[] }) {
  if (!apps.length) return <div className="text-sm text-zinc-500 dark:text-zinc-400">No apps yet.</div>;
  return (
    <>
      {apps.map((a) => {
        // The self-hosted app is this platform, and the platform runs as the
        // blue/green pair its deploy workflow manages, never as a
        // `usernode-app-<slug>` container. So "missing" is the wrong word for
        // it: the container was never supposed to exist. The summary counters
        // already skip it (status.js `prodMissing`); say so on the row too,
        // otherwise the one app that is definitely up reads as the one app
        // that is down.
        const selfHostedNoContainer = !!a.selfHosted && !a.prod;
        const prodState = a.runtimeAvailable === false ? 'unknown' : selfHostedNoContainer
          ? 'running'
          : (a.prod?.state || (a.dbStatus === 'creating' ? 'creating' : 'missing'));
        const prodLabel = a.runtimeAvailable === false ? 'unavailable' : selfHostedNoContainer
          ? 'self-hosted'
          : (a.prod?.state || a.dbStatus || 'missing');
        let repoHost = '';
        if (a.repoUrl) {
          try { repoHost = new URL(a.repoUrl).pathname.replace(/^\//, ''); } catch { repoHost = a.repoUrl; }
        }
        return (
          <div key={a.slug} className={AdminUI.card}>
            <div className="p-3 flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold">{a.name}</span>
                  <span className="mono text-zinc-500 dark:text-zinc-400 text-xs">{a.slug}</span>
                  <StatePill state={prodState} label={`prod: ${prodLabel}`} />
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 flex items-center gap-3 flex-wrap">
                  {a.repoUrl ? (
                    <a href={a.repoUrl} target="_blank" rel="noopener"
                      className="hover:text-violet-600 dark:hover:text-violet-300 mono">{repoHost}</a>
                  ) : null}
                  <span>{`by @${a.createdBy || 'unknown'}`}</span>
                  <span>{`${a.openSessions} session${a.openSessions === 1 ? '' : 's'}`}</span>
                  <span>{`${a.openIssues} issue${a.openIssues === 1 ? '' : 's'}`}</span>
                  {a.prod ? <span>{`up ${fmtDurationSeconds(a.prod.uptimeSeconds)}`}</span> : null}
                  {a.prod?.stats?.mem ? <span className="mono text-zinc-500 dark:text-zinc-400">{a.prod.stats.mem}</span> : null}
                  {a.prod?.stats?.cpu ? <span className="mono text-zinc-500 dark:text-zinc-400">{a.prod.stats.cpu}</span> : null}
                </div>
              </div>
            </div>
            {a.sessions.length ? (
              <div className="border-t border-zinc-200 dark:border-zinc-800 px-3 pb-2">
                {a.sessions.map((s: any) => <SessionRow key={s.id} s={s} />)}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

// Visual taxonomy for long-lived workers:
//   in-flight    : currently running a docker exec — busy with a turn
//   warm-idle    : waiting for the next dispatch (memory cost only)
//   bootstrapping: clone + checkout + warm-ready in flight
//   unregistered : container exists but isn't in the warm registry
const WORKER_MODE_PILL: Record<string, string> = {
  'in-flight': 'pill-running',
  'warm-idle': 'pill-creating',
  bootstrapping: 'pill-creating',
  unregistered: 'pill-stopped',
};

function Workers({ workers }: { workers: any[] }) {
  if (!workers.length) return <div className="text-zinc-500 dark:text-zinc-400">No workers running.</div>;
  return (
    <>
      {workers.map((w) => {
        const idleLabel = w.workerMode === 'warm-idle' && w.idleMs != null
          ? `idle ${fmtDurationSeconds(Math.floor(w.idleMs / 1000))}` : '';
        return (
          <div key={w.sessionId}
            className={`rounded border ${w.orphan ? 'border-red-300 dark:border-red-700/40' : 'border-zinc-200 dark:border-zinc-800'} bg-zinc-50 dark:bg-zinc-900/40 p-2`}>
            <div className="flex items-center gap-2 flex-wrap">
              <StatePill state={w.state} label={w.state} />
              {w.workerMode ? (
                <span className={`pill ${WORKER_MODE_PILL[w.workerMode] || 'pill-stopped'}`}>
                  <span className="dot" />{w.workerMode}
                </span>
              ) : null}
              <span className="text-xs text-zinc-600 dark:text-zinc-400">{`session #${w.sessionId}`}</span>
              {w.appSlug ? <span className="mono text-xs text-zinc-500 dark:text-zinc-400">{w.appSlug}</span> : null}
              {w.username ? <span className="text-xs">{`@${w.username}`}</span> : null}
              {idleLabel ? <span className="text-xs text-zinc-500 dark:text-zinc-400">{idleLabel}</span> : null}
              <span className="text-xs text-zinc-500 dark:text-zinc-400 ml-auto">
                {fmtDurationSeconds(w.uptimeSeconds)}
                {w.orphan ? <span className="text-red-700 dark:text-red-400 ml-1">orphan</span> : null}
              </span>
            </div>
            {w.lastProgress
              ? <div className="mt-1 mono text-xs text-zinc-600 dark:text-zinc-400 truncate">{`▸ ${w.lastProgress}`}</div>
              : null}
          </div>
        );
      })}
    </>
  );
}

function Stuck({ stuck }: { stuck: any[] }) {
  if (!stuck.length) return <div className="text-zinc-500 dark:text-zinc-400">None.</div>;
  return (
    <>
      {stuck.map((s) => (
        <div key={s.id} className="rounded border border-yellow-300 dark:border-yellow-700/40 bg-zinc-50 dark:bg-zinc-900/40 p-2">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="pill pill-stopped"><span className="dot" />preview missing</span>
            <span className="text-xs text-zinc-600 dark:text-zinc-400">{`session #${s.id}`}</span>
            <span className="mono text-xs text-zinc-500 dark:text-zinc-400">{s.appSlug}</span>
            <span className="text-xs">{`@${s.username || 'unknown'}`}</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400 ml-auto">{fmtDurationSeconds(s.ageSeconds)}</span>
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mono">{s.branchName}</div>
        </div>
      ))}
    </>
  );
}

function Llm({ data }: { data: StatusData }) {
  const { llmUsage, stagingPerUser, summary, limits } = data;
  if (!summary || !limits) return <div className="text-zinc-500 dark:text-zinc-400 text-xs">no data</div>;
  const pct = Math.min(100, Math.round((summary.globalSpendCents / summary.globalSpendCap) * 100));
  return (
    <>
      <div className="mb-2">
        <div className="flex justify-between text-xs mb-1">
          <span className="text-zinc-600 dark:text-zinc-400">global</span>
          <span className="mono">{`${fmtDollars(summary.globalSpendCents)} / ${fmtDollars(summary.globalSpendCap)} (${pct}%)`}</span>
        </div>
        <div className="h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
          <div className="h-full bg-violet-500" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {(llmUsage || []).length ? (llmUsage as any[]).map((u) => {
        const userPct = Math.min(100, Math.round((u.costCents / limits.userDailyCents) * 100));
        const atCap = u.costCents >= limits.userDailyCents;
        const stagingCt = (stagingPerUser || {})[u.username] || 0;
        return (
          <div key={u.username} className="flex items-center justify-between text-xs py-0.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate">{`@${u.username}`}</span>
              {stagingCt >= limits.stagingPerUser
                ? <span className="text-red-700 dark:text-red-400 text-[10px]">{`${stagingCt}/${limits.stagingPerUser} staging`}</span>
                : stagingCt > 0
                  ? <span className="text-zinc-500 dark:text-zinc-400 text-[10px]">{`${stagingCt} staging`}</span>
                  : null}
            </div>
            <span className={`mono ${atCap ? 'text-red-700 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-400'}`}>
              {`${fmtDollars(u.costCents)} (${userPct}%)`}
            </span>
          </div>
        );
      }) : <div className="text-zinc-500 dark:text-zinc-400 text-xs">no activity</div>}
    </>
  );
}

function Drift({ drift }: { drift: any[] }) {
  if (!drift.length) return <div className="text-zinc-500 dark:text-zinc-400">No drift detected.</div>;
  return (
    <>
      {drift.map((d, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className="rounded border border-red-300 dark:border-red-700/40 bg-zinc-50 dark:bg-zinc-900/40 p-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="pill pill-missing"><span className="dot" />{`${d.kind} missing`}</span>
            <span className="mono text-zinc-600 dark:text-zinc-400">{d.expected}</span>
          </div>
        </div>
      ))}
    </>
  );
}

// A log line's stamp: the time WITH seconds, preceded by the day once the
// event is not today's. `messageStamp` drops seconds by design (a transcript
// does not need them); a log does, so the time half is spelled here and only
// the date half comes from the shared helper (#1808).
function eventTime(ts: string | number | Date): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString();
  const stamp = messageStamp(ts);
  // `text` is the bare time when the instant is today's; anything longer
  // means it carried a date, and that date is everything before the comma.
  const comma = stamp.text.lastIndexOf(', ');
  return comma < 0 ? time : `${stamp.text.slice(0, comma)}, ${time}`;
}

const EVENT_LEVEL: Record<string, string> = {
  ERROR: 'text-red-700 dark:text-red-400',
  WARN: 'text-yellow-800 dark:text-yellow-400',
  INFO: 'text-zinc-600 dark:text-zinc-400',
  DEBUG: 'text-zinc-600',
};

function Events({ events }: { events: any[] }) {
  if (!events.length) return <div className="text-zinc-500 dark:text-zinc-400 text-xs">no events yet</div>;
  return (
    <>
      {events.map((e, i) => {
        const data = e.data ? ` ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}` : '';
        return (
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="truncate">
            {/* #1808: seconds stay — this is a log and the ordering within a
                minute is the point — but the day rides in front of it once
                the event is not today's, and `title` carries the full
                instant either way. */}
            <time
              className="text-zinc-600 dark:text-zinc-400"
              title={messageStamp(e.ts).title}
            >{eventTime(e.ts)}</time>
            <span className={EVENT_LEVEL[e.level] || 'text-zinc-600 dark:text-zinc-400'}>{` ${e.level}`}</span>
            <span className="text-zinc-500 dark:text-zinc-400">{` [${e.category}]`}</span>{` ${e.message}`}
            <span className="text-zinc-600 dark:text-zinc-400">{data.substring(0, 200)}</span>
          </div>
        );
      })}
    </>
  );
}

const SECTION_H3 = 'text-sm font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-wide';

function StatusSection() {
  const [data, setData] = useState<StatusData | null>(null);
  const [auto, setAuto] = useState(true);
  const [countdown, setCountdown] = useState(Math.ceil(REFRESH_MS / 1000));
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/status', { credentials: 'include' });
      if (!alive.current || !res.ok) return;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return;
      const next = await res.json();
      if (!alive.current) return;
      setData(next);
    } catch (err) {
      console.error('status refresh failed', err);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // One effect for BOTH timers. They used to be rebuilt together by
  // _scheduleRefresh() on every checkbox change, and keeping them in step by
  // hand is exactly the thing that goes wrong.
  useEffect(() => {
    if (!auto) return undefined;
    setCountdown(Math.ceil(REFRESH_MS / 1000));
    let remaining = REFRESH_MS;
    const countdownTimer = setInterval(() => {
      remaining -= 1000;
      if (remaining <= 0) remaining = REFRESH_MS;
      setCountdown(Math.ceil(remaining / 1000));
    }, 1000);
    const refreshTimer = setInterval(refresh, REFRESH_MS);
    // /api/status performs runtime inventory calls, so leaving the 5s poll
    // running would keep paying for a screen nobody is looking at.
    return () => { clearInterval(countdownTimer); clearInterval(refreshTimer); };
  }, [auto, refresh]);

  const d = data || {};
  const isAdmin = !!d.isAdmin;
  const deploy = d.deployProgress;
  const sha = deploy?.sha ? String(deploy.sha).substring(0, 7) : '';
  const elapsed = deploy?.startedAt
    ? fmtDurationSeconds(Math.floor((Date.now() - new Date(deploy.startedAt).getTime()) / 1000))
    : '';

  return (
    // Scoped to this section's root, NOT <body> — see public/css/app.css.
    <div id="admin-status-root" className={isAdmin ? 'is-admin' : undefined}>
      <header className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <div className="flex items-center gap-3">
          <h2 className={AdminUI.cardTitle}>Health &amp; status</h2>
          <span id="admin-status-version" className="text-xs mono text-zinc-500 dark:text-zinc-400">{d.version || ''}</span>
          <span id="admin-status-badge" className="admin-only text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-700/30 text-violet-700 dark:text-violet-300">admin view</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-zinc-500 dark:text-zinc-400">
          <label className="flex items-center gap-2">
            <input id="admin-status-autorefresh" type="checkbox" className="accent-violet-500"
              checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            {'auto-refresh '}
            <span id="admin-status-countdown" className="mono">{auto ? `(${countdown}s)` : '(paused)'}</span>
          </label>
          <button id="admin-status-refresh-now" type="button" onClick={refresh}
            className="px-2 py-1 rounded bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200">refresh</button>
        </div>
      </header>

      {/* Deploy-in-progress banner. */}
      <div id="admin-status-deploy-banner"
        className={`${deploy?.deploying || deploy?.failed || deploy?.unavailable || deploy?.phase === 'paused' ? '' : 'hidden '}mb-4 rounded-lg border border-violet-300 dark:border-violet-700/50 bg-violet-50 dark:bg-violet-900/20 px-4 py-3`}>
        <div className="flex items-center gap-3">
          <span className="relative flex h-2.5 w-2.5">
            {deploy?.deploying ? <span className="absolute inline-flex h-full w-full rounded-full bg-violet-400 opacity-75 animate-ping" /> : null}
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-violet-500" />
          </span>
          <div className="text-sm">
            <span className="font-semibold text-violet-800 dark:text-violet-200">{deploy?.failed ? 'Deployment failed:' : deploy?.unavailable ? 'Deployment status unavailable:' : deploy?.phase === 'paused' ? 'Deployment paused:' : 'Deploy in progress:'}</span>
            <span className="text-violet-700 dark:text-violet-300/80"> {deploy?.failed ? deploy.message : deploy?.unavailable ? 'the rollout could not be observed.' : deploy?.phase === 'paused' ? 'waiting for the rollout to resume.' : 'your changes may take a minute to go live.'}</span>
          </div>
          <span id="admin-status-deploy-meta" className="ml-auto text-xs mono text-violet-700 dark:text-violet-400">
            {[sha, elapsed && `${elapsed} ago`].filter(Boolean).join(' · ')}
          </span>
        </div>
      </div>

      {/* Summary bar */}
      <div id="admin-status-summary" className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2 mb-6">
        {data ? <Summary s={d.summary || {}} node={d.node} runtimeKind={d.runtimeKind} /> : null}
      </div>

      {/* Homeroom node sidecar status. The cached snapshot is updated server-side
          every 500ms-2s by services/node-status.js, so this card stays fresh
          without each tab independently polling the sidecar. "→ full status"
          switches to the Node & chain section. */}
      <section className="mb-6">
        <div className="flex items-baseline justify-between mb-2">
          <h3 className={SECTION_H3}>Homeroom node</h3>
          <button type="button" data-admin-section="node"
            className="text-xs text-violet-700 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300"
            onClick={() => {
              const c = (window as any).AdminConsole;
              if (c?.setSection) c.setSection('node');
            }}>
            → full status
          </button>
        </div>
        <div id="admin-status-node" className={`${AdminUI.card} p-4 text-sm`}>
          {data ? <Node node={d.node} /> : null}
        </div>
      </section>

      {/* Block-explorer reachability. Separate card from the node above:
          different host, different failure mode, and when it's down the
          consequence (wallet linking stops completing) is invisible anywhere
          else. */}
      <section className="mb-6">
        <div className="flex items-baseline justify-between mb-2">
          <h3 className={SECTION_H3}>Block explorer</h3>
        </div>
        <div id="admin-status-explorer" className={`${AdminUI.card} p-4 text-sm`}>
          {data ? <Explorer ex={d.explorer} /> : null}
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Left: Apps tree */}
        <div className="space-y-3 min-w-0">
          <h3 className={SECTION_H3}>Apps</h3>
          <div id="admin-status-apps" className="space-y-3">
            {data ? <Apps apps={d.apps || []} /> : null}
          </div>
        </div>

        {/* Right: System lanes */}
        <div className="space-y-6 min-w-0">
          <section className="admin-only">
            <h3 id="admin-status-capacity-heading" className={`${SECTION_H3} mb-2`}>
              {d.runtimeKind === 'kubernetes' ? 'Capacity' : 'Capacity & host'}
            </h3>
            <div id="admin-status-capacity" className={`${AdminUI.card} p-4 text-sm`}>
              {data && isAdmin ? <Capacity data={d} /> : null}
            </div>
          </section>

          <section>
            <h3 className={`${SECTION_H3} mb-2`}>Workers</h3>
            <div id="admin-status-workers" className="space-y-2 text-sm">
              {data ? <Workers workers={d.workers || []} /> : null}
            </div>
          </section>

          <section>
            <h3 className={`${SECTION_H3} mb-2`}>Missing previews</h3>
            <div id="admin-status-stuck" className="space-y-2 text-sm">
              {data ? <Stuck stuck={d.stuckSessions || []} /> : null}
            </div>
          </section>

          <section className="admin-only">
            <h3 className={`${SECTION_H3} mb-2`}>LLM today</h3>
            <div id="admin-status-llm" className="space-y-1 text-sm">
              {data && isAdmin ? <Llm data={d} /> : null}
            </div>
          </section>

          <section>
            <h3 className={`${SECTION_H3} mb-2`}>Drift</h3>
            <div id="admin-status-drift" className="space-y-2 text-sm">
              {data ? <Drift drift={d.driftContainers || []} /> : null}
            </div>
          </section>

          <section className="admin-only">
            <h3 className={`${SECTION_H3} mb-2`}>Recent events</h3>
            <div id="admin-status-events" className="space-y-0.5 text-xs mono max-h-80 overflow-y-auto">
              {data && isAdmin ? <Events events={d.events || []} /> : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminStatus = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <StatusSection />);
  },

  // Called by AdminConsole before it swaps this section out, and when the
  // console itself closes. /api/status performs runtime inventory calls, so
  // leaving the 5s poll running would keep paying for a screen nobody is
  // looking at — dropping the portal unmounts the effect that owns it.
  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminStatus = AdminStatus;

export { AdminStatus };
