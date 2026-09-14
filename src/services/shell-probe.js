// Anonymous-app probe: checks the shell and the platform-convention API
// gate without a session. The landing page's app directory
// uses this to gray out "account required" apps instead of letting an
// anonymous visitor tap through into a 401.
//
// How: fetch `http://usernode-app-<slug>:3000/` (the app's container on
// the shared docker network — the same address Caddy proxies to) with NO
// cookies and NO Sec-Fetch-Dest header, exactly like an anonymous
// browser hitting the app subdomain, and classify the response:
//
//   2xx                      -> check the app's /api/ gate before opening
//   401 / 403                -> 'gated'   (scaffold's "Open in Homeroom" page)
//   3xx off-origin           -> 'gated'   (bounce to the platform login)
//   3xx same-origin          -> followed (<= 3 hops), then classified
//   anything else / timeout  -> 'unknown' (never claim public on a guess)
//
// A static index can return 200 before the app's auth middleware runs
// (#1522, WorkQuest). A second, read-only GET /api/ catches the scaffold's
// deny-by-default API middleware without crawling endpoints or executing
// client-side JavaScript. 401/403 or an off-origin redirect means gated. A missing API (404)
// is fine for static apps; other failures remain unknown. This is a
// conservative convention check, not a proof that arbitrary app-specific
// login flows or optional authenticated features work anonymously.
//
// Results land on apps.anon_shell + anon_shell_checked_at (schema.sql).
// The sweep runs every SWEEP_INTERVAL_MS and re-probes an app when it has
// never been probed, was deployed since its last probe, or its result is
// older than RECHECK_AFTER_MS. Boot also refreshes positive verdicts so an
// older shell-only result does not remain unlocked for another hour.

const http = require('http');
const log = require('./logger');
const { getPool } = require('../db/pool');

const APP_CONTAINER_PORT = 3000;
const PROBE_TIMEOUT_MS = 5000;
const MAX_REDIRECT_HOPS = 3;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const RECHECK_AFTER_MS = 60 * 60 * 1000;
// Probes are cheap (at most two intra-network GETs before redirects), but
// keep the fan-out bounded so a 200-app fleet doesn't burst 200 sockets
// on one tick.
const SWEEP_CONCURRENCY = 4;

let intervalHandle = null;
let sweepInFlight = false;
let lastSweepAt = null;
let lastError = null;

function appShellUrl(slug) {
  return `http://usernode-app-${slug}:${APP_CONTAINER_PORT}/`;
}

// Pure classifier over (statusCode, Location header, probed URL) so tests
// can exercise the decision table without sockets. Returns 'public',
// 'gated', 'unknown', or { follow: <absolute next URL> }.
function classifyResponse(statusCode, location, currentUrl) {
  if (statusCode >= 200 && statusCode < 300) return 'public';
  if (statusCode === 401 || statusCode === 403) return 'gated';
  if (statusCode >= 300 && statusCode < 400) {
    if (!location) return 'unknown';
    let next;
    try { next = new URL(location, currentUrl); } catch { return 'unknown'; }
    const cur = new URL(currentUrl);
    // Off-origin redirect = the app is punting anonymous traffic somewhere
    // else (in practice: the platform's login). Same-origin = internal
    // routing (e.g. / -> /home.html); follow it and judge the destination.
    if (next.origin !== cur.origin) return 'gated';
    return { follow: next.toString() };
  }
  return 'unknown';
}

// One GET without cookies/Sec-Fetch-Dest; resolves to the raw
// { statusCode, location } pair. Rejects on network error / timeout.
function fetchShell(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, {
      headers: { accept: 'text/html' },
      timeout: PROBE_TIMEOUT_MS,
    }, (res) => {
      // Drain so the socket is reusable; the body content is irrelevant.
      res.resume();
      resolve({ statusCode: res.statusCode, location: res.headers.location || null });
    });
    req.on('timeout', () => req.destroy(new Error('probe timeout')));
    req.on('error', reject);
  });
}

// One endpoint: follows same-origin redirects up to MAX_REDIRECT_HOPS.
async function probeEndpoint(url, { allowMissing = false } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let res;
    try {
      res = await fetchShell(current);
    } catch {
      return 'unknown';
    }
    if (allowMissing && res.statusCode === 404) return 'public';
    const verdict = classifyResponse(res.statusCode, res.location, current);
    if (typeof verdict === 'string') return verdict;
    current = verdict.follow;
  }
  return 'unknown';
}

// A successful document alone does not establish anonymous usability.
// Keep this check in the probe, so every directory consumer gets the same
// verdict and previously misclassified apps converge on the regular sweep.
async function probeUrl(url) {
  const shell = await probeEndpoint(url);
  if (shell !== 'public') return shell;
  return probeEndpoint(new URL('/api/', url).toString(), { allowMissing: true });
}

async function probeApp(pool, app) {
  const verdict = await probeUrl(appShellUrl(app.slug));
  await pool.query(
    `UPDATE apps SET anon_shell = $1, anon_shell_checked_at = NOW() WHERE id = $2`,
    [verdict, app.id]
  );
  if (verdict !== app.anon_shell) {
    log.info('shell-probe', 'App anon-shell classification changed', {
      slug: app.slug, from: app.anon_shell, to: verdict,
    });
  }
  return verdict;
}

// Apps worth (re-)probing this tick. Only running, platform-hosted,
// view-public apps: self-hosted containers aren't on our network, and
// view-private apps never appear on the landing page anyway.
async function selectDueApps(pool, refreshPublic = false) {
  const { rows } = await pool.query(
    `SELECT id, slug, anon_shell FROM apps
      WHERE status = 'running'
        AND self_hosted IS NOT TRUE
        AND view_visibility = 'public'
        AND (
          anon_shell_checked_at IS NULL
          OR last_deploy_at > anon_shell_checked_at
          OR anon_shell_checked_at < NOW() - ($1 * INTERVAL '1 millisecond')
          OR ($2::boolean AND anon_shell = 'public' AND anon_shell_checked_at <= NOW())
        )
      ORDER BY anon_shell_checked_at ASC NULLS FIRST`,
    // Future stamps belong to the container-free staging fixtures. Do not
    // invalidate those while refreshing real, previously public apps.
    [RECHECK_AFTER_MS, refreshPublic]
  );
  return rows;
}

async function sweep(config) {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const pool = getPool(config);
    const due = await selectDueApps(pool, lastSweepAt === null);
    if (due.length) {
      log.info('shell-probe', 'Probing app shells', { count: due.length });
    }
    // Simple bounded worker pool over the due list.
    let idx = 0;
    const workers = Array.from({ length: Math.min(SWEEP_CONCURRENCY, due.length) }, async () => {
      while (idx < due.length) {
        const app = due[idx++];
        try {
          await probeApp(pool, app);
        } catch (err) {
          log.warn('shell-probe', 'Probe failed', { slug: app.slug, err: err.message });
        }
      }
    });
    await Promise.all(workers);
    lastSweepAt = new Date();
    lastError = null;
  } catch (err) {
    lastError = err.message;
    log.warn('shell-probe', 'Sweep failed', { err: err.message });
  } finally {
    sweepInFlight = false;
  }
}

function start(config) {
  if (intervalHandle) return;
  // First pass shortly after boot (give app containers a moment to come
  // up alongside the platform), then steady-state ticks.
  setTimeout(() => { sweep(config); }, 15 * 1000);
  intervalHandle = setInterval(() => { sweep(config); }, SWEEP_INTERVAL_MS);
  intervalHandle.unref?.();
}

function stop() {
  if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
}

function getStatus() {
  return { lastSweepAt, lastError, sweepInFlight };
}

module.exports = {
  start,
  stop,
  sweep,
  getStatus,
  // Exported for tests:
  classifyResponse,
  probeUrl,
  probeApp,
  selectDueApps,
  appShellUrl,
};
