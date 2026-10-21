// Anonymous-app probe: checks the shell and the platform-convention API
// gate without a session. The landing page's app directory
// uses this to gray out "account required" apps instead of letting an
// anonymous visitor tap through into a 401.
//
// How: fetch the app's own origin — `applicationRuntime.appOrigin()`, which
// is the container name on the shared docker network or the ClusterIP
// Service on kubernetes, whichever lane this app actually runs in — with NO
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
// AS A GUEST TOO. Where the app-host sign-in half is on, a visitor with no
// account reaches a public app as a guest (services/edge-gate.js, "Guests
// (P15)"): every request carries the guest token the gate mints, which the
// scaffold reads as `req.guest` and lets READ. The same two GETs are made a
// second time carrying that token in `x-usernode-token`, the header the gate
// hands the app, and the verdict lands on apps.guest_shell. An app already
// open to a visitor with no credential at all needs no second pass. With the
// sign-in half off there are no guests, so nothing is asked and the column
// keeps what it had: `guest_ready` ignores it then (public-app-directory.js).
//
// Results land on apps.anon_shell + anon_shell_checked_at (schema.sql).
// The sweep runs every SWEEP_INTERVAL_MS and re-probes an app when it has
// never been probed, was deployed since its last probe, or its result is
// older than RECHECK_AFTER_MS. The first sweep a new platform build runs also
// refreshes positive verdicts, so an older shell-only result does not remain
// unlocked for another hour. It is a pass of the `shell-probe` clock
// (src/workflow/clock/services.ts), which hands each run the build the last one
// ran under.

const http = require('http');
const log = require('./logger');
const platformJwt = require('./platform-jwt');
const applicationRuntime = require('./application-runtime');
const { getPool } = require('../db/pool');

const PROBE_TIMEOUT_MS = 5000;
const MAX_REDIRECT_HOPS = 3;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const RECHECK_AFTER_MS = 60 * 60 * 1000;
// Probes are cheap (at most two intra-network GETs before redirects), but
// keep the fan-out bounded so a 200-app fleet doesn't burst 200 sockets
// on one tick.
const SWEEP_CONCURRENCY = 4;


// The app ROW decides the address, not the slug alone: `runtime_kind` and
// `runtime_name` are what the deploy actually created, so an app on
// kubernetes resolves through its Service and one on docker through its
// container name.
//
// The identity check is NOT defensive noise. productionRef() DERIVES a name
// when `runtime_name` is null, and neither lane's derivation validates its
// inputs: a row without an id and slug yields the plausible-looking
// `sv-app-undefined-undefined`, which resolves nowhere, classifies 'unknown'
// and gates the app — the same silent failure #1894 is about, one layer
// down. Return null instead and let the caller leave the verdict alone.
function appShellUrl(app, config) {
  if (!app) return null;
  if (!app.runtime_name && !(app.id && app.slug)) return null;
  const origin = applicationRuntime.appOrigin(config, applicationRuntime.productionRef(config, app));
  return origin ? `${origin}/` : null;
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
// `headers` adds to the request's own: the guest pass's token.
function fetchShell(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, {
      headers: { accept: 'text/html', ...headers },
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
async function probeEndpoint(url, { allowMissing = false, headers = {} } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    let res;
    try {
      res = await fetchShell(current, headers);
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
async function probeUrl(url, { headers = {} } = {}) {
  const shell = await probeEndpoint(url, { headers });
  if (shell !== 'public') return shell;
  return probeEndpoint(new URL('/api/', url).toString(), { allowMissing: true, headers });
}

// The guest pass (see the header): null when there are no guests to ask
// about, so the stored verdict is left alone.
async function probeGuest(url, app, anonVerdict, { guestsOn = require('./edge-gate').signinEnabled() } = {}) {
  if (!guestsOn) return null;
  if (anonVerdict === 'public') return 'public';
  let token;
  try {
    token = platformJwt.signGuestToken({ appId: app.id });
  } catch (err) {
    log.warn('shell-probe', 'Could not mint a guest token; guest pass skipped', { slug: app.slug, err: err.message });
    return null;
  }
  return probeUrl(url, { headers: { 'x-usernode-token': token } });
}

// `guestsOn` defaults to the app-host sign-in switch (probeGuest).
async function probeApp(pool, app, config, { guestsOn } = {}) {
  const url = appShellUrl(app, config);
  // No address to ask means no evidence either way. Leave the stored verdict
  // and its timestamp alone rather than writing 'unknown' over a good one.
  if (!url) {
    log.warn('shell-probe', 'No runtime address for app; skipping probe', { slug: app.slug });
    return app.anon_shell;
  }
  const verdict = await probeUrl(url);
  const guest = await probeGuest(url, app, verdict, guestsOn === undefined ? undefined : { guestsOn });
  await pool.query(
    `UPDATE apps SET anon_shell = $1, anon_shell_checked_at = NOW(),
            guest_shell = COALESCE($3, guest_shell)
      WHERE id = $2`,
    [verdict, app.id, guest]
  );
  if (verdict !== app.anon_shell) {
    log.info('shell-probe', 'App anon-shell classification changed', {
      slug: app.slug, from: app.anon_shell, to: verdict,
    });
  }
  if (guest !== null && guest !== app.guest_shell) {
    log.info('shell-probe', 'App guest-shell classification changed', {
      slug: app.slug, from: app.guest_shell, to: guest,
    });
  }
  return verdict;
}

// Apps worth (re-)probing this tick. Only running, platform-hosted,
// view-public apps: self-hosted containers aren't on our network, and
// view-private apps never appear on the landing page anyway.
async function selectDueApps(pool, refreshPublic = false) {
  const { rows } = await pool.query(
    `SELECT id, slug, anon_shell, guest_shell, runtime_kind, runtime_name FROM apps
      WHERE status = 'running'
        AND self_hosted IS NOT TRUE
        AND view_visibility = 'public'
        AND (
          anon_shell_checked_at IS NULL
          OR last_deploy_at > anon_shell_checked_at
          OR anon_shell_checked_at < NOW() - ($1 * INTERVAL '1 millisecond')
          OR ($2::boolean AND (anon_shell = 'public' OR guest_shell = 'public') AND anon_shell_checked_at <= NOW())
        )
      ORDER BY anon_shell_checked_at ASC NULLS FIRST`,
    // Future stamps belong to the container-free staging fixtures. Do not
    // invalidate those while refreshing real, previously public apps.
    [RECHECK_AFTER_MS, refreshPublic]
  );
  return rows;
}

// `refreshPublic`: re-probe every app that read public (the first sweep of
// a new build). Returns what it probed.
async function sweep(config, { refreshPublic = false, shouldStop = () => false } = {}) {
  const pool = getPool(config);
  const due = await selectDueApps(pool, refreshPublic);
  if (due.length) {
    log.info('shell-probe', 'Probing app shells', { count: due.length });
  }
  let failed = 0;
  // Simple bounded worker pool over the due list.
  let idx = 0;
  const workers = Array.from({ length: Math.min(SWEEP_CONCURRENCY, due.length) }, async () => {
    while (idx < due.length && !shouldStop()) {
      const app = due[idx++];
      try {
        await probeApp(pool, app, config);
      } catch (err) {
        failed += 1;
        log.warn('shell-probe', 'Probe failed', { slug: app.slug, err: err.message });
      }
    }
  });
  await Promise.all(workers);
  return { probed: due.length, failed, refreshedPublic: !!refreshPublic };
}

module.exports = {
  sweep,
  // Exported for tests:
  classifyResponse,
  probeUrl,
  probeGuest,
  probeApp,
  selectDueApps,
  appShellUrl,
};
