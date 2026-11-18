'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// App storage (#admin/storage): how much of its own database each app is
// using against the per-app cap (#2253), and the two admin levers that undo
// a freeze, a per-app cap override and a timed grace window. Beside it,
// each app's stored files (services/app-files.js) against its file
// allowance, which an admin may set per app as well.
//
// The figures come from GET /api/admin/storage, which reads what the
// leader's sweep last recorded on the app rows (services/app-storage-cap.js);
// "Measure now" runs that sweep on demand, and saving a cap runs it again so
// the change shows at once instead of at the next quarter hour.
//
// PERMISSIONS: visible to any admin. Every control is gated on
// AdminConsole.canWrite() here and on requireAdminWrite on the server; a
// view-only admin sees the table and no controls they could not use.
//
// Staging demo passthrough, as the estimator and gallery sections do it: the
// page-level ?demo=1 rides in location.search and is forwarded to the
// endpoint, which answers with fixed "Staging demo app" rows so the section
// can be photographed on a preview whose cloned apps table has no figures.

type StorageState = 'ok' | 'warning' | 'frozen' | 'grace';

interface StorageRow {
  slug: string;
  name: string;
  dbSizeBytes: number | null;
  measuredAt: string | null;
  capBytes: number;
  capOverrideBytes: number | null;
  frozenAt: string | null;
  graceUntil: string | null;
  warnedAt: string | null;
  state: StorageState;
  fileBytes: number;
  fileAppOwnedBytes: number;
  fileCapBytes: number;
  fileCapOverrideBytes: number | null;
}

interface SweepSummary {
  startedAt: string;
  finishedAt: string | null;
  staging: boolean;
  measured: number;
  skipped: number;
  frozen: number;
  unfrozen: number;
  warned: number;
  cleared: number;
  errors: string[];
}

interface StoragePayload {
  apps: StorageRow[];
  defaults: { capBytes: number; warnPercent: number; sweepIntervalMs: number; fileCapBytes: number };
  lastSweep: SweepSummary | null;
}

type Tone = 'ok' | 'err';
interface Status { text: string; tone: Tone }

const DEMO = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('demo') === '1';
const withDemo = (url: string) => `${url}${DEMO ? `${url.includes('?') ? '&' : '?'}demo=1` : ''}`;

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const GRACE_MINUTES = 60;

const STATE_BADGE: Record<StorageState, string> = {
  ok: AdminUI.badge.success,
  warning: AdminUI.badge.warn,
  frozen: AdminUI.badge.destructive,
  grace: AdminUI.badge.secondary,
};
const STATE_LABEL: Record<StorageState, string> = {
  ok: 'OK',
  warning: 'Nearly full',
  frozen: 'Read only',
  grace: 'Writes allowed',
};
const BAR_FILL: Record<StorageState, string> = {
  ok: 'bg-violet-500',
  warning: 'bg-amber-500',
  frozen: 'bg-red-500',
  grace: 'bg-violet-400',
};

function oneDecimal(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return 'Not measured yet';
  if (bytes >= GB) return `${oneDecimal(bytes / GB)} GB`;
  if (bytes >= MB) return `${oneDecimal(bytes / MB)} MB`;
  if (bytes >= 1024) return `${oneDecimal(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** The cap field's text for a stored override: gigabytes, two decimals at most. */
function gbField(bytes: number | null): string {
  return bytes == null ? '' : (Math.round((bytes / GB) * 100) / 100).toString();
}

/** Blank clears the override (null); anything else must be a non-negative number of GB. */
function parseGb(text: string, what = 'cap'): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Enter the ${what} in gigabytes, or leave it blank to use the default.`);
  }
  return Math.round(n * GB);
}

function filesTitle(row: StorageRow): string {
  return row.fileAppOwnedBytes
    ? `${formatBytes(row.fileAppOwnedBytes)} of it kept by the app itself, the rest uploaded by people`
    : 'Uploaded by people using the app';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60000) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${plural(mins, 'minute', 'minutes')} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${plural(hours, 'hour', 'hours')} ago`;
  return `${plural(Math.floor(hours / 24), 'day', 'days')} ago`;
}

function fromNow(iso: string | null): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return plural(mins, 'minute', 'minutes');
  return plural(Math.ceil(mins / 60), 'hour', 'hours');
}

function summarize(s: SweepSummary): string {
  const parts = [`Measured ${plural(s.measured, 'app', 'apps')}.`];
  if (s.frozen) parts.push(`${plural(s.frozen, 'app is', 'apps are')} now read only.`);
  if (s.unfrozen) parts.push(`${plural(s.unfrozen, 'app can', 'apps can')} save data again.`);
  if (s.warned) parts.push(`${plural(s.warned, 'app is', 'apps are')} nearly full.`);
  if (s.staging) parts.push('This is a preview, so nothing was frozen or notified from here.');
  if (s.errors.length) parts.push(`${plural(s.errors.length, 'app', 'apps')} could not be checked: ${s.errors[0]}`);
  return parts.join(' ');
}

function StatusLine({ status }: { status: Status | null }) {
  return (
    <p id="admin-storage-status" className={status
      ? `text-xs mt-2 ${status.tone === 'err' ? 'text-red-400' : 'text-green-800 dark:text-green-400'}`
      : 'text-xs mt-2 hidden'}>
      {status ? status.text : ''}
    </p>
  );
}

function AppRow({ row, canWrite, onChanged, setStatus }: {
  row: StorageRow;
  canWrite: boolean;
  onChanged: () => Promise<void>;
  setStatus: (s: Status | null) => void;
}) {
  const [cap, setCap] = useState(gbField(row.capOverrideBytes));
  const [fileCap, setFileCap] = useState(gbField(row.fileCapOverrideBytes));
  const [busy, setBusy] = useState(false);
  // A reload after a save carries the stored value back; the field follows
  // it rather than keeping what was typed.
  useEffect(() => { setCap(gbField(row.capOverrideBytes)); }, [row.capOverrideBytes]);
  useEffect(() => { setFileCap(gbField(row.fileCapOverrideBytes)); }, [row.fileCapOverrideBytes]);

  const used = row.dbSizeBytes;
  const pct = used == null || row.capBytes <= 0 ? 0 : Math.min(100, Math.round((used / row.capBytes) * 100));
  const overCap = used != null && row.capBytes > 0 && used >= row.capBytes;
  const showGrace = canWrite && (row.state === 'frozen' || overCap);

  const send = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/admin/storage/${encodeURIComponent(row.slug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus({ text: done, tone: 'ok' });
      await onChanged();
    } catch (err: any) {
      setStatus({ text: `Could not save: ${err.message}`, tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const saveCap = () => {
    let capBytes: number | null;
    try {
      capBytes = parseGb(cap);
    } catch (err: any) {
      setStatus({ text: err.message, tone: 'err' });
      return;
    }
    send({ capBytes }, capBytes == null
      ? `${row.name} uses the default cap again.`
      : `Cap for ${row.name} set to ${formatBytes(capBytes)}.`);
  };
  const saveFileCap = () => {
    let fileCapBytes: number | null;
    try {
      fileCapBytes = parseGb(fileCap, 'file allowance');
    } catch (err: any) {
      setStatus({ text: err.message, tone: 'err' });
      return;
    }
    send({ fileCapBytes }, fileCapBytes == null
      ? `${row.name} uses the default file allowance again.`
      : `File allowance for ${row.name} set to ${formatBytes(fileCapBytes)}.`);
  };
  const allowWrites = () => send({ graceMinutes: GRACE_MINUTES },
    `${row.name} can save data again for the next ${GRACE_MINUTES} minutes.`);

  return (
    <tr className={AdminUI.trHover} data-storage-slug={row.slug} data-storage-state={row.state}>
      <td className={`${AdminUI.td} align-top`}>
        <div className="font-medium text-zinc-900 dark:text-zinc-100">{row.name}</div>
        <div className="text-xs font-mono text-zinc-500 dark:text-zinc-400">{row.slug}</div>
      </td>
      <td className={`${AdminUI.td} align-top whitespace-nowrap tabular-nums`}>{formatBytes(used)}</td>
      <td className={`${AdminUI.td} align-top whitespace-nowrap tabular-nums`}>
        {formatBytes(row.capBytes)}
        {row.capOverrideBytes != null
          ? <span className={`${AdminUI.badge.outline} ms-2`} title="This app has its own cap">custom</span>
          : null}
      </td>
      <td className={`${AdminUI.td} align-top min-w-[9rem]`}>
        <div className="flex items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
            role="progressbar" aria-label={`${row.name} storage used`}
            aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={`h-2 rounded-full ${BAR_FILL[row.state]}`} style={{ width: `${pct}%` }} />
          </div>
          <span className="w-10 text-end text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
            {used == null ? '' : `${pct}%`}
          </span>
        </div>
      </td>
      <td className={`${AdminUI.td} align-top whitespace-nowrap`}>
        <span className={STATE_BADGE[row.state]}>{STATE_LABEL[row.state]}</span>
        {row.state === 'grace' && row.graceUntil
          ? <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">for {fromNow(row.graceUntil)}</div>
          : null}
      </td>
      <td className={`${AdminUI.td} align-top whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400`}
        title={row.measuredAt || ''}>
        {ago(row.measuredAt)}
      </td>
      <td className={`${AdminUI.td} align-top whitespace-nowrap tabular-nums`} data-storage-files
        title={filesTitle(row)}>
        {formatBytes(row.fileBytes)} of {formatBytes(row.fileCapBytes)}
        {row.fileCapOverrideBytes != null
          ? <span className={`${AdminUI.badge.outline} ms-2`} title="This app has its own file allowance">custom</span>
          : null}
      </td>
      {canWrite ? (
        <td className={`${AdminUI.td} align-top`}>
          <div className="flex flex-wrap items-center gap-2">
            <input type="number" min="0" step="0.5" inputMode="decimal" disabled={busy}
              className={`${AdminUI.input} w-24 disabled:opacity-60`} placeholder="default"
              aria-label={`Cap for ${row.name} in gigabytes`}
              value={cap} onChange={(e) => setCap(e.target.value)} />
            <span className="text-xs text-zinc-500 dark:text-zinc-400">GB</span>
            <button type="button" className={AdminUI.btn.outlineSm} onClick={saveCap} disabled={busy}>Save</button>
            {showGrace ? (
              <button type="button" className={AdminUI.btn.primarySm} onClick={allowWrites} disabled={busy}>
                Allow writes for {GRACE_MINUTES} minutes
              </button>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input type="number" min="0" step="1" inputMode="decimal" disabled={busy}
              className={`${AdminUI.input} w-24 disabled:opacity-60`} placeholder="default"
              aria-label={`File allowance for ${row.name} in gigabytes`}
              value={fileCap} onChange={(e) => setFileCap(e.target.value)} />
            <span className="text-xs text-zinc-500 dark:text-zinc-400">GB of files</span>
            <button type="button" className={AdminUI.btn.outlineSm} onClick={saveFileCap} disabled={busy}>Save</button>
          </div>
        </td>
      ) : null}
    </tr>
  );
}

function StorageSection() {
  const console_ = () => (window as any).AdminConsole;
  const canWrite = !!console_()?.canWrite();

  const [data, setData] = useState<StoragePayload | null>(null);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { ok, status: code, data: body } = await console_().fetchJson(withDemo('/api/admin/storage'));
    if (!alive.current) return;
    if (!ok || !body || typeof body !== 'object') {
      setLoadError(code === 0 ? 'Could not reach the server.' : `Could not load the storage figures (HTTP ${code}).`);
      return;
    }
    setLoadError('');
    setData(body as StoragePayload);
  }, []);
  useEffect(() => { load(); }, [load]);

  const runSweep = async (): Promise<SweepSummary> => {
    const res = await fetch('/api/admin/storage/sweep', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body.sweep as SweepSummary;
  };

  const measureNow = async () => {
    setMeasuring(true);
    setStatus(null);
    try {
      const summary = await runSweep();
      if (!alive.current) return;
      setStatus({ text: summarize(summary), tone: summary.errors.length ? 'err' : 'ok' });
      await load();
    } catch (err: any) {
      if (alive.current) setStatus({ text: `Measuring failed: ${err.message}`, tone: 'err' });
    } finally {
      if (alive.current) setMeasuring(false);
    }
  };

  // After a cap change the new limit is only applied by a measurement, so
  // one runs here; if it cannot, the saved value still stands and the next
  // scheduled sweep applies it.
  const afterChange = async () => {
    try { await runSweep(); } catch { /* the save stands; the timer will apply it */ }
    await load();
  };

  const apps = data ? data.apps : [];
  const defaults = data ? data.defaults : null;
  const lastMeasured = apps.reduce<string | null>((latest, a) => (
    a.measuredAt && (!latest || a.measuredAt > latest) ? a.measuredAt : latest
  ), null);
  const frozenCount = apps.filter((a) => a.state === 'frozen').length;
  const warningCount = apps.filter((a) => a.state === 'warning').length;

  return (
    <div id="admin-storage">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>App storage</h2>
          {canWrite ? (
            <button id="admin-storage-measure-btn" type="button" className={AdminUI.btn.outline}
              onClick={measureNow} disabled={measuring}>
              {measuring ? 'Measuring' : 'Measure now'}
            </button>
          ) : null}
        </div>
        <p className={AdminUI.muted}>
          {defaults
            ? `Each app's database is capped at ${formatBytes(defaults.capBytes)} unless it has its own limit below: `
              + `at ${defaults.warnPercent}% the app's admins are warned, and at the cap the database goes read only `
              + 'until it shrinks, its limit is raised, or writes are allowed for a while.'
            : 'Each app\'s database is capped, and goes read only at the cap until it shrinks or an admin raises its limit.'}
          {defaults
            ? ` Stored files are counted separately, against ${formatBytes(defaults.fileCapBytes)} per app unless it has its own allowance.`
            : ' Stored files are counted separately.'}
        </p>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          {defaults ? `Measured automatically every ${plural(Math.round(defaults.sweepIntervalMs / 60000), 'minute', 'minutes')}. ` : ''}
          Last measured {ago(lastMeasured)}.
          {frozenCount ? ` ${plural(frozenCount, 'app is', 'apps are')} read only.` : ''}
          {warningCount ? ` ${plural(warningCount, 'app is', 'apps are')} nearly full.` : ''}
        </p>
        <StatusLine status={status} />
      </div>

      <div className={`${AdminUI.card} p-4 mt-4`}>
        {loadError ? <p className="text-sm text-red-400">{loadError}</p> : null}
        {!loadError && !data ? <p className={AdminUI.loading}>Loading…</p> : null}
        {data ? (
          <div className={AdminUI.tableWrap}>
            <table id="admin-storage-table" className={AdminUI.table}>
              <thead className={AdminUI.thead}>
                <tr>
                  <th className={AdminUI.th}>App</th>
                  <th className={AdminUI.th}>Used</th>
                  <th className={AdminUI.th}>Cap</th>
                  <th className={AdminUI.th}>Usage</th>
                  <th className={AdminUI.th}>State</th>
                  <th className={AdminUI.th}>Last measured</th>
                  <th className={AdminUI.th}>Files</th>
                  {canWrite ? <th className={AdminUI.th}>Limit</th> : null}
                </tr>
              </thead>
              <tbody id="admin-storage-rows">
                {apps.length === 0 ? (
                  <tr>
                    <td className={`${AdminUI.td} text-zinc-500 dark:text-zinc-400`} colSpan={canWrite ? 8 : 7}>
                      No apps yet.
                    </td>
                  </tr>
                ) : apps.map((row) => (
                  <AppRow key={row.slug} row={row} canWrite={canWrite}
                    onChanged={afterChange} setStatus={setStatus} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminStorage = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <StorageSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminStorage = AdminStorage;

export { AdminStorage };
