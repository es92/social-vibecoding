'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Screenshot gallery section of the admin console (#860) — the retired
// standalone /gallery page, ported into #admin/gallery.
//
// Tiles are rendered by AppView.visualsTilesHtml in GALLERY MODE —
// { preload: 'none', overlay: false } — so recordings are click-to-play
// and the SPA-only comparison overlay isn't wired. Reusing that renderer
// is deliberate: the gallery must show exactly what a reviewer sees on a
// proposal card, including the fell-back / no-before captions, and a
// second renderer would drift. app-view.js is already loaded by the SPA
// shell, so the standalone page's own <script src="/js/app-view.js"> is
// gone.
//
// PERMISSIONS: admin-only, enforced by the inline `req.user?.isAdmin` 403
// gate on /api/gallery/* (src/routes/gallery.js). Read-only surface, so
// full and view-only admins both get it.
//
// ── React-owned (#1120 slice 7) ───────────────────────────────────────
//
// Second section through the seam `admin-e2e.tsx` established: same
// `{ render(host), destroy() }` shape, `mountLegacyPortal` in place of the
// `innerHTML` assignment. What this one adds over the e2e report is that it
// FETCHES, so it is the section that shows what the conversion is actually
// worth:
//
//   * The four `hidden` toggles — the gate, the content wrapper, the stats
//     strip, the Load-older button and the empty note — were five
//     `classList.toggle` calls reaching for elements by id after every
//     request. They are all derived from state here, so a request that
//     resolves after the operator has left cannot leave one of them
//     inconsistent with the others.
//   * The `if (!$('admin-gallery-proposals')) return;` guards were a
//     hand-rolled is-this-still-mounted check on a torn-down section. A
//     mounted ref does the same job without depending on the id still
//     resolving to THIS mount of the section.
//   * The app filter's `<option>` list was built with `createElement` +
//     `appendChild` into a node the same module also rendered. It is data now.
//
// The one thing that stays a raw HTML string is the tiles, and deliberately:
// `AppView.visualsTilesHtml` is the renderer a reviewer sees on a proposal
// card and the gallery must not drift from it. In gallery mode its output is
// inert — `<figure>` elements around a native `<video controls>`, no handlers,
// no ids — so React renders it once through `dangerouslySetInnerHTML` and
// nothing writes into it afterwards. That is a React-owned host, not a
// legacy-filled one.

const PAGE_LIMIT = 20;

// Guarded for the SSG prerender pass, which evaluates this module in Node
// (#1082 chunk E). In the browser this is the same boolean as before.
const DEMO = typeof window !== 'undefined'
  && new URLSearchParams(location.search).get('demo') === '1';

interface Cursor { before: string; before_id: number }

interface Visuals { [key: string]: unknown }

interface Proposal {
  id: number;
  title?: string;
  appId?: number;
  appName?: string;
  appSlug?: string;
  prUrl?: string;
  prNumber?: number;
  mergedAt?: string;
  captureState?: string;
  captureReason?: string;
  visuals?: Visuals;
  visualEvidence?: {
    state?: string;
    failureReason?: string;
    [key: string]: unknown;
  } | null;
}

interface Stats {
  total: number;
  complete?: number;
  missing_recording?: number;
  missing_before?: number;
  before_fell_back?: number;
  root_only?: number;
  failed_or_skipped?: number;
  unknown_state?: number;
  evidence_verified?: number;
  relevance_failure?: number;
  replay_failure?: number;
  unsupported_agent?: number;
  override?: number;
}

interface AppOption { value: string; label: string }

interface Applied { app: string; problem: string; nonce: number }

async function getJSON(url: string): Promise<any> {
  const resp = await fetch(url, { headers: { accept: 'application/json' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function filterParams(applied: Applied): URLSearchParams {
  const params = new URLSearchParams();
  if (applied.app) params.set('app', applied.app);
  if (applied.problem) params.set('problem', applied.problem);
  // Staging demo rows (src/routes/gallery.js) — the SPA form is
  // /?demo=1#admin/gallery, so the flag rides in location.search.
  if (DEMO) params.set('demo', '1');
  return params;
}

function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Capture-state chip. A NULL state means the proposal merged before capture
// outcomes were persisted — render it as "unknown" rather than mislabelling
// it as a success or a failure.
const CHIP: Record<string, { label: string; cls: string }> = {
  captured: { label: 'Captured', cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  partial: { label: 'Partial', cls: 'bg-amber-500/15 text-amber-800 dark:text-amber-400' },
  console_only: { label: 'No visual change expected', cls: 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400' },
  failed: { label: 'Capture failed', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
};
const CHIP_UNKNOWN = { label: 'Outcome unknown', cls: 'bg-zinc-500/15 text-zinc-500 dark:text-zinc-400' };

const SELECT_CLASS = 'mt-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 '
  + 'rounded px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100';

const PROBLEMS: Array<[string, string]> = [
  ['', 'Any'],
  ['missing_recording', 'Missing recording'],
  ['missing_before', 'Missing before side'],
  ['before_fell_back', 'Before fell back to home page'],
  ['root_only', 'Shot at the front page only'],
  ['failed_or_skipped', 'Capture failed or skipped'],
  ['relevance_failure', 'Preview not relevant'],
  ['replay_failure', 'Preview replay failed'],
  ['unsupported_agent', 'Unsupported preview agent'],
  ['override', 'Preview overridden'],
];

const DOT = <span className="text-zinc-500 dark:text-zinc-500">·</span>;

function Chip({ state, reason }: { state?: string; reason?: string }) {
  const chip = (state && CHIP[state]) || CHIP_UNKNOWN;
  return (
    <span className={`text-[0.65rem] px-1.5 py-0.5 rounded ${chip.cls}`} title={reason || undefined}>
      {chip.label}
    </span>
  );
}

const LINK = 'text-violet-700 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-300';

function ProposalCard({ p }: { p: Proposal }) {
  const appView = typeof window !== 'undefined' ? (window as any).AppView : null;
  // A v2 record owns this proposal's visual story even while pending or
  // failed. Never fall back to a route-only capture that may show a different
  // screen. Both paths use AppView's shared reviewer renderer.
  const tiles: string = appView && p.visualEvidence
    ? appView.visualEvidenceHtml(p.visualEvidence, { sessionId: p.id })
    : ((appView && p.visuals)
      ? appView.visualsTilesHtml(p.visuals, { preload: 'none', overlay: false })
      : '');
  const appLabel = p.appName || p.appSlug || `app ${p.appId}`;
  const merged = fmtDate(p.mergedAt);

  const meta: React.ReactNode[] = [];
  if (p.prUrl && p.prNumber) {
    meta.push(
      <a key="pr" href={p.prUrl} target="_blank" rel="noopener"
        className="font-mono text-violet-700 dark:text-violet-400 hover:underline">PR#{p.prNumber}</a>,
    );
  } else if (p.prNumber) {
    meta.push(<span key="pr" className="font-mono text-zinc-500 dark:text-zinc-400">PR#{p.prNumber}</span>);
  }
  if (merged) meta.push(<span key="date">{merged}</span>);
  if (p.appSlug) {
    meta.push(
      <a key="open" href={`/#app/${p.appSlug}/dev/proposals/${p.id}`} className={LINK}>Open proposal →</a>,
    );
  }

  return (
    <article className={`${AdminUI.card} p-3`}>
      <div className="flex items-start justify-between gap-3 mb-1">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{p.title || `Proposal ${p.id}`}</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {p.appSlug ? <a href={`/#app/${p.appSlug}/dev`} className={LINK}>{appLabel}</a> : appLabel}
            {meta.length ? <> {DOT} </> : null}
            {meta.map((node, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <span key={i}>{i ? <> {DOT} </> : null}{node}</span>
            ))}
          </div>
        </div>
        <div className="shrink-0"><Chip
          state={p.visualEvidence
            ? (p.visualEvidence.state === 'verified' ? 'captured'
              : (p.visualEvidence.state === 'failed' ? 'failed' : 'partial'))
            : p.captureState}
          reason={(p.visualEvidence?.failureReason as string | undefined) || p.captureReason}
        /></div>
      </div>
      {/* No tiles is a real state, not an error: console_only / failed
          proposals legitimately stored nothing. Say which, using the
          persisted reason. */}
      {tiles
        ? <div dangerouslySetInnerHTML={{ __html: tiles }} />
        : (
          <div className="text-xs text-zinc-500 dark:text-zinc-400 py-2">
            {p.captureReason || 'No screenshots were stored for this proposal.'}
          </div>
        )}
    </article>
  );
}

function StatsStrip({ s }: { s: Stats }) {
  const pct = (n: number) => (s.total ? Math.round((n / s.total) * 100) : 0);
  const item = (label: string, n: number, withPct: boolean) => (
    <span key={label}>
      <strong className="text-zinc-700 dark:text-zinc-200">{n}</strong>
      {` ${label}`}{withPct && s.total ? ` (${pct(n)}%)` : ''}
    </span>
  );
  return (
    <section
      id="admin-gallery-stats"
      className={`flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400 ${AdminUI.card} px-3 py-2`}
    >
      {item('matching proposals', s.total, false)}
      {item('complete', s.complete || 0, true)}
      {item('missing recording', s.missing_recording || 0, true)}
      {item('missing before', s.missing_before || 0, true)}
      {item('before fell back', s.before_fell_back || 0, true)}
      {item('front page only', s.root_only || 0, true)}
      {item('failed / skipped', s.failed_or_skipped || 0, true)}
      {item('preview captured', s.evidence_verified || 0, true)}
      {item('relevance failures', s.relevance_failure || 0, true)}
      {item('replay failures', s.replay_failure || 0, true)}
      {item('unsupported agents', s.unsupported_agent || 0, true)}
      {item('overrides', s.override || 0, true)}
      {s.unknown_state ? item('outcome not recorded', s.unknown_state, true) : null}
    </section>
  );
}

function GallerySection() {
  const [gate, setGate] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [apps, setApps] = useState<AppOption[]>([]);
  const [app, setApp] = useState('');
  const [problem, setProblem] = useState('');
  // Apply and Refresh both commit the draft filters. `nonce` is what makes
  // Refresh reload when nothing about the filters changed — the old code got
  // that for free by calling loadFirstPage() directly.
  const [applied, setApplied] = useState<Applied>({ app: '', problem: '', nonce: 0 });
  const [items, setItems] = useState<Proposal[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alive = useRef(true);
  const cursor = useRef<Cursor | null>(null);
  const loading = useRef(false);

  useEffect(() => () => { alive.current = false; }, []);

  // Admin check up front. The /api/gallery/* endpoints are independently
  // enforced server-side; this is only for a clean in-section message. We do
  // NOT navigate away on failure — a transient 401 shouldn't bounce an admin,
  // and it keeps the section coherent under headless checks.
  useEffect(() => {
    (async () => {
      let me: any = null;
      try {
        me = await getJSON('/api/auth/me');
      } catch {
        if (alive.current) setGate('Sign in as an admin to view the screenshot gallery.');
        return;
      }
      if (!alive.current) return;
      if (!me.user?.isAdmin) {
        setGate('Admins only. This section shows before/after screenshots for merged proposals.');
        return;
      }
      setReady(true);
      try {
        const { apps: list } = await getJSON(`/api/gallery/apps${DEMO ? '?demo=1' : ''}`);
        if (!alive.current) return;
        setApps((list || []).map((a: any) => ({
          value: a.slug || String(a.id),
          label: `${a.name || a.slug} (${a.proposal_count})`,
        })));
      } catch { /* non-fatal — the filter just stays "All apps" */ }
    })();
  }, []);

  const loadPage = useCallback(async (append: boolean, forFilters: Applied) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const params = filterParams(forFilters);
      params.set('limit', String(PAGE_LIMIT));
      if (append && cursor.current) {
        params.set('before', cursor.current.before);
        params.set('before_id', String(cursor.current.before_id));
      }
      const data = await getJSON(`/api/gallery/proposals?${params.toString()}`);
      if (!alive.current) return;
      const page: Proposal[] = data.proposals || [];
      setItems((prev) => (append ? prev.concat(page) : page));
      cursor.current = data.nextCursor || null;
      setHasMore(!!data.hasMore);
      setError(null);
    } catch (err: any) {
      if (!alive.current) return;
      if (!append) {
        setItems([]);
        setError(String(err && err.message ? err.message : err));
      }
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    cursor.current = null;
    loadPage(false, applied);
    (async () => {
      try {
        const { stats: s } = await getJSON(`/api/gallery/stats?${filterParams(applied).toString()}`);
        if (alive.current) setStats(s && typeof s.total === 'number' ? s : null);
      } catch {
        if (alive.current) setStats(null);
      }
    })();
  }, [ready, applied, loadPage]);

  const commit = () => setApplied((prev) => ({ app, problem, nonce: prev.nonce + 1 }));

  return (
    <div id="admin-gallery-root">
      <h2 className="text-lg font-semibold mb-4">Before/after shots gallery</h2>
      {gate ? <div id="admin-gallery-gate" className="text-zinc-500 dark:text-zinc-400 text-center py-20">{gate}</div> : null}

      {ready ? (
        <main id="admin-gallery-content" className="space-y-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Before/after shots of each declared change on merged proposals, newest first.
            Historical proposals retain their legacy capture diagnostics.
          </p>

          {/* Filter bar */}
          <section className={`${AdminUI.card} p-3 flex flex-wrap items-end gap-3`}>
            <label className="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">App
              <select id="admin-gallery-f-app" className={SELECT_CLASS}
                value={app} onChange={(e) => setApp(e.target.value)}>
                <option value="">All apps</option>
                {apps.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">Problem
              <select id="admin-gallery-f-problem" className={SELECT_CLASS}
                value={problem} onChange={(e) => setProblem(e.target.value)}>
                {PROBLEMS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </label>
            <button id="admin-gallery-apply" type="button" onClick={commit}
              className="ml-auto px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-700 text-white text-sm">Apply</button>
            <button id="admin-gallery-refresh" type="button" onClick={commit}
              className="px-3 py-1.5 rounded bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-sm">Refresh</button>
          </section>

          {/* Stats strip for the current filter */}
          {stats ? <StatsStrip s={stats} /> : null}

          <div id="admin-gallery-proposals" className="space-y-4">
            {error
              ? <div className="text-sm text-rose-500 dark:text-rose-400">Failed to load the gallery: {error}</div>
              : items.map((p) => <ProposalCard key={p.id} p={p} />)}
          </div>

          <div className="flex justify-center py-4">
            {hasMore ? (
              <button id="admin-gallery-load-older" type="button"
                onClick={() => loadPage(true, applied)}
                className="px-4 py-2 rounded bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-sm">Load older</button>
            ) : null}
            {!error && !items.length ? (
              <span id="admin-gallery-empty" className="text-zinc-500 dark:text-zinc-400 text-sm">
                No merged proposals match these filters yet.
              </span>
            ) : null}
          </div>
        </main>
      ) : null}
    </div>
  );
}

let host: Element | null = null;

const AdminGallery = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <GallerySection />);
  },

  // No timers or body-level listeners of its own — the tiles are inert markup
  // inside the section host, so dropping the portal is all the teardown this
  // section needs. It is also what cancels the in-flight requests' effects:
  // the component's cleanup clears `alive`, so a response that lands after
  // the operator has left writes nothing.
  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminGallery = AdminGallery;

export { AdminGallery };
