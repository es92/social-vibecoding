// Platform-shell service worker — read-only offline mode (#487).
//
// Design contract (see the offline-mode spec):
//   - ONLINE BEHAVIOUR STAYS AS CLOSE TO NO-SW AS IT USEFULLY CAN. Every
//     strategy here is network-first, with ONE relaxation (#1021): a
//     response that has not arrived within its deadline may be answered
//     from cache, and the network response — which is still in flight —
//     still replaces the cached copy when it lands. This preserves the
//     platform's hard-learned freshness rule
//     (src/services/static-cache.js): the next page load is fresh, and
//     the drawer's stale-version pill (App.renderPlatformVersionPill)
//     remains the visible recovery for a tab that is behind a deploy.
//     Without the deadline a stalled-but-open connection held the
//     navigation (and every one of the shell's ~70 scripts) open forever
//     while a complete cached copy sat unused — the reported white screen.
//   - Only GETs are ever intercepted. Writes, SSE streams, auth flows and
//     credentials are hard-bypassed (see classifyRequest below).
//   - Cached GET /api/* JSON lets previously-viewed screens (home feed,
//     per-app dev views, chats) re-render offline. Entries are stamped,
//     capped, and cleared on logout.
//
// classifyRequest(), isImmuneApiRequest() and raceNetworkAndCache() are
// pure functions on purpose: tests/pwa-sw-classify.test.js and
// tests/pwa-offline-cache.test.js load this file in Node (module.exports
// branch at the bottom) and pin their behaviour without a browser.

// v6: the shell has no cross-origin assets left (Tailwind is compiled into
// /css/tailwind.css and marked/DOMPurify/qrcodejs are vendored under
// /vendor/), so the CDN cache and its stale-while-revalidate strategy are
// gone. The activate handler prunes any `usernode-*` cache not listed in
// ALL_CACHES, which retires the old usernode-cdn-v5 entries automatically.
//
// The React + shadcn chassis swap added one local asset to the shell —
// /shell/assets/shell.js — and SHELL_ASSETS below precaches it like any
// other. It needed no version bump of its own: a byte change to this file
// re-runs install(), which re-runs the precache with the current list.
const SW_VERSION = 'v7';
const SHELL_CACHE = `usernode-shell-${SW_VERSION}`;
const IMMUTABLE_CACHE = `usernode-immutable-${SW_VERSION}`;

// The API cache is DELIBERATELY NOT VERSIONED WITH SW_VERSION (#1021).
// It used to be `usernode-api-${SW_VERSION}`, and the activate handler
// below deletes every `usernode-*` cache not listed in ALL_CACHES — so
// every routine service-worker bump silently wiped the offline session
// (the cached GET /api/auth/me the SPA's boot check depends on) along
// with the whole cached feed. That is exactly what shipping v7 did on the
// evening #1021 was reported. The shell and immutable caches stay
// versioned because they are network-first / content-addressed and cost
// nothing to refill; this one holds the only offline state we have.
//
// Bump API_CACHE_FORMAT only when the STORED SHAPE changes (e.g. a new
// stamp header), never as part of a shell bump.
const API_CACHE_FORMAT = '';
const API_CACHE = `usernode-api${API_CACHE_FORMAT}`;
const ALL_CACHES = [SHELL_CACHE, API_CACHE, IMMUTABLE_CACHE];

// Version-named API caches left behind by workers older than #1021.
// activate() migrates their entries into API_CACHE *before* the prune
// deletes them, so an existing install keeps its offline copy across the
// one-time rename instead of losing it exactly like a version bump would.
const LEGACY_API_CACHE_RE = /^usernode-api-v\d+$/;

// API-cache hygiene knobs.
const API_CACHE_MAX_ENTRIES = 300;
const API_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const CACHED_AT_HEADER = 'sw-cached-at';

// Entries that eviction must never touch. /api/auth/me is what decides
// whether an offline boot shows the signed-in shell or the sign-in
// screen, and it otherwise competes for the 300-entry budget with every
// paginated /api/apps/:slug/messages?... key — one busy chat session
// could evict the session itself.
const IMMUNE_API_PATHS = ['/api/auth/me'];

// Network deadlines (#1021). Well above a healthy same-origin round trip
// — every shell asset is local and served with `no-cache,
// must-revalidate`, so the common case is a 304 — but short enough that a
// stalling connection reads as "showing saved content", not as a hang.
const NAVIGATE_TIMEOUT_MS = 3000;
const SHELL_TIMEOUT_MS = 3000;
const API_TIMEOUT_MS = 4000;

// Same-origin shell assets precached on install so the very next offline
// load works even for screens the session never touched. Must list every
// local script/stylesheet index.html references — the precache-list sync
// test enforces that, and also enforces that index.html loads NOTHING
// cross-origin, so this list is now the complete set of assets the shell
// needs to render. (login.html etc. are redirect stubs into the SPA's
// hash routes now — fold-auth-pages-into-SPA — so index.html is the one
// document to precache.)
const SHELL_ASSETS = [
  '/index.html',
  '/css/tailwind.css',
  '/css/app.css',
  // The React chassis: the runtime plus the shell tree, hydrating the markup
  // index.html already ships (frontend/src/main.tsx). Deliberately UNHASHED —
  // this list is hand-maintained and content-hashed filenames would make it
  // churn on every build; freshness comes from `no-cache, must-revalidate`
  // (src/services/static-cache.js) plus this worker being network-first.
  '/shell/assets/shell.js',
  // Vendored third-party libs (public/vendor/README.md records provenance).
  '/vendor/qrcode-1.0.0.min.js',
  '/vendor/marked-15.0.12.min.js',
  '/vendor/purify-3.4.4.min.js',
  '/usernode-native/v1/native.css',
  '/usernode-native/v1/native.js',
  '/usernode-bridge.js',
  '/js/admin-console.js',
  '/js/auth-screens.js',
  '/js/admin-topochain.js',
  // Folded-in console sections (#860) — one module per section that used to
  // be a standalone page. The retired page scripts (/js/dashboard.js,
  // /js/debug.js, /js/gallery.js, /js/admin-features.js) are gone.
  '/js/admin-status.js',
  '/js/admin-node.js',
  '/js/admin-analytics.js',
  '/js/admin-estimator.js',
  '/js/admin-merges.js',
  '/js/admin-gallery.js',
  '/js/admin-campaigns.js',
  '/js/admin-mail.js',
  '/js/app-secrets.js',
  '/js/browse.js',
  // #1036: the real-anchor / new-tab seam. Loads ahead of every other
  // module in index.html, so a cache miss here breaks the whole shell.
  '/js/nav-link.js',
  '/js/platform-ui.js',
  '/js/app-view.js',
  '/js/app.js',
  '/js/build-log.js',
  '/js/cc-progress-summary.js',
  '/js/topochain-events.js',
  '/js/confirm-modal.js',
  '/js/dev-alerts.js',
  '/js/dev-chat.js',
  '/js/dev-console.js',
  '/js/dev-flow-select.js',
  '/js/dev-host.js',
  '/js/group-chat.js',
  '/js/header-layout.js',
  '/js/home.js',
  '/js/home-layout.js',
  '/js/home-panels.js',
  '/js/kudos.js',
  '/js/ai-credit.js',
  '/js/leaderboard.js',
  '/js/merge-status.js',
  '/js/native-chrome.js',
  '/js/node-pill.js',
  '/js/notifications.js',
  '/js/social-push.js',
  '/js/offline.js',
  '/js/credit-options.js',
  '/js/profile.js',
  '/js/screenshot-select.js',
  '/js/session-transcript.js',
  '/js/settings.js',
  '/js/spec-sections.js',
  '/js/streaming-markdown.js',
  '/js/theme.js',
  '/js/session-state.js',
  '/js/topochain-event-context.js',
  '/js/topochain-leaderboard.js',
  '/js/topochain-challenges.js',
  '/js/wallet-sheet.js',
  '/js/work-drawer.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

// Server-rendered standalone pages that stay online-only: never serve the
// SPA shell as an offline fallback for them (it would render the wrong
// app entirely). They just fail offline, like today.
//
// #860 emptied most of this list: /admin, /admin-features, /dashboard,
// /debug, /gallery, /node-status and /status are redirect stubs into the
// SPA's #admin console now, so falling back to the cached shell is exactly
// right for them (the same change the auth pages got in
// fold-auth-pages-into-SPA). /cli/authorize is the last genuine standalone
// server page — a pre-auth device-authorisation flow with its own
// stylesheet, deliberately outside the app shell.
const NO_FALLBACK_PAGES = [
  '/cli/authorize',
  // The hosted-connector consent page. Same reasoning as /cli/authorize: a
  // standalone pre-auth server page with its own stylesheet, outside the
  // app shell. Serving the cached SPA shell for it offline would show a
  // page that looks signed in but cannot approve anything.
  '/connect/authorize',
];

// Pure request classifier — the single source of truth for what the fetch
// handler does with a request. Returns one of:
//   'bypass'   — don't touch it; the browser talks to the network directly.
//   'navigate' — page navigation: network-first, offline falls back to the
//                cached SPA shell (index.html).
//   'shell'    — same-origin HTML/JS/CSS/manifest/icons: network-first.
//   'api'      — GET /api/* JSON: network-first, cache 200s for offline.
//   'immutable'— content-addressed images (/app-icons, /visuals, /avatars):
//                cache-first.
function classifyRequest(method, url, acceptHeader, mode, selfOrigin) {
  if (method !== 'GET') return 'bypass';

  let u;
  try { u = new URL(url, selfOrigin); } catch { return 'bypass'; }

  // Cross-origin is never intercepted. The shell loads no cross-origin
  // assets at all now, so anything off-origin is a child-app subdomain, an
  // outbound link or a user-supplied image — all of which the browser should
  // handle itself.
  if (u.origin !== selfOrigin) return 'bypass';

  const p = u.pathname;

  // SSE streams must never be intercepted or cached (they'd buffer forever).
  if (/text\/event-stream/i.test(acceptHeader || '')) return 'bypass';
  if (/^\/api\/sessions\/[^/]+\/events$/.test(p)) return 'bypass';

  if (mode === 'navigate') {
    return NO_FALLBACK_PAGES.includes(p) ? 'bypass' : 'navigate';
  }

  // Local-dev mock namespace and short-lived credentials.
  if (p.startsWith('/__mock/')) return 'bypass';
  if (p === '/api/iframe-token') return 'bypass';
  if (p.startsWith('/api/cli/')) return 'bypass';
  if (p === '/api/me/cli-tokens' || p.startsWith('/api/me/cli-tokens/')) {
    return 'bypass';
  }
  // Hosted MCP connector: the endpoint itself, its OAuth surfaces, and the
  // credential-bearing management reads. Same hard bypass as the CLI's, for
  // the same reason — none of this may ever be answered from a cache.
  if (p === '/mcp') return 'bypass';
  if (p.startsWith('/api/connect/')) return 'bypass';
  if (p === '/api/me/connectors' || p.startsWith('/api/me/connectors/')) {
    return 'bypass';
  }
  if (p === '/api/me/github' || p.startsWith('/api/me/github/')) return 'bypass';
  if (p.startsWith('/.well-known/oauth-')) return 'bypass';
  // Auth endpoints are online-only — EXCEPT /api/auth/me, which is cached
  // so the SPA's boot check succeeds offline for a logged-in user.
  if (p.startsWith('/api/auth/') && p !== '/api/auth/me') return 'bypass';

  if (p.startsWith('/api/')) return 'api';

  // Content-addressed, already served with a year-long immutable header.
  // /avatars/ joins them (#982): the id rotates whenever the bytes change
  // (POST /api/me/avatar upserts a fresh one), so a cached entry can never
  // be stale — a replaced id simply 404s.
  if (p.startsWith('/app-icons/') || p.startsWith('/visuals/')
      || p.startsWith('/avatars/')) return 'immutable';

  // The shell's own static assets (incl. /usernode-bridge/v1/... versions).
  if (/\.(?:html|js|css|webmanifest)$/i.test(p)) return 'shell';
  if (p.startsWith('/icons/')) return 'shell';

  // Everything else (e.g. the /health connectivity probe) goes straight
  // to the network so it always reflects real reachability.
  return 'bypass';
}

// Is this cached API entry exempt from eviction? Pure so the trim and
// age-prune passes can be pinned in Node.
function isImmuneApiRequest(url, selfOrigin) {
  try {
    return IMMUNE_API_PATHS.includes(new URL(url, selfOrigin).pathname);
  } catch { return false; }
}

// Sentinel resolved by the deadline timer. A plain object identity check
// can never collide with a Response.
const TIMED_OUT = { timedOut: true };

// Network-first WITH a deadline (#1021). Pure: every effect is injected,
// so tests drive all three branches with fake fetch / cache / timer.
//
//   { startFetch, matchCache, timeoutMs, schedule } →
//   { response, fromCache, pending }
//
//   - network resolves first        → its response, `pending: null`.
//     Cache-write behaviour is the caller's, inside startFetch, so it is
//     unchanged from before.
//   - network rejects first         → cached copy if there is one, else
//     rethrow. Exactly today's behaviour.
//   - deadline first, cache HIT     → the cached copy immediately, and
//     the still-in-flight request handed back as `pending` so the caller
//     can event.waitUntil() it. The late response still refreshes the
//     cache, which is what keeps the freshness contract honest.
//   - deadline first, cache MISS    → keep waiting on the network. A
//     first-ever load (or a screen this device has never visited) must
//     never fail early just because it is slow.
//
// `schedule(fn, ms)` returns a cancel function.
async function raceNetworkAndCache({ startFetch, matchCache, timeoutMs, schedule }) {
  const network = startFetch();
  // We may hand this promise back to the caller, or abandon it entirely
  // on the cache-hit path — either way nothing here may surface as an
  // unhandled rejection.
  network.catch(() => {});

  let cancelTimer = null;
  const deadline = new Promise((resolve) => {
    cancelTimer = schedule(() => resolve(TIMED_OUT), timeoutMs);
  });

  let first;
  try {
    first = await Promise.race([network, deadline]);
  } catch (err) {
    if (cancelTimer) cancelTimer();
    const hit = await matchCache();
    if (hit) return { response: hit, fromCache: true, pending: null };
    throw err;
  }

  if (first !== TIMED_OUT) {
    if (cancelTimer) cancelTimer();
    return { response: first, fromCache: false, pending: null };
  }

  const hit = await matchCache();
  if (hit) return { response: hit, fromCache: true, pending: network };

  try {
    return { response: await network, fromCache: false, pending: null };
  } catch (err) {
    const late = await matchCache();
    if (late) return { response: late, fromCache: true, pending: null };
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Service-worker runtime (skipped when loaded in Node for tests).     */
/* ------------------------------------------------------------------ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    classifyRequest,
    isImmuneApiRequest,
    raceNetworkAndCache,
    SHELL_ASSETS,
    NO_FALLBACK_PAGES,
    SW_VERSION,
    API_CACHE,
    ALL_CACHES,
    LEGACY_API_CACHE_RE,
    IMMUNE_API_PATHS,
    NAVIGATE_TIMEOUT_MS,
    SHELL_TIMEOUT_MS,
    API_TIMEOUT_MS,
  };
} else {
  const ORIGIN = self.location.origin;

  // Stamp a response copy with the cached-at time so activate() can prune
  // stale entries. Only used for the API cache. Takes an already-cloned
  // response (cloning must happen synchronously, before the page starts
  // consuming the original body).
  async function stampAndPut(cache, request, response) {
    try {
      const headers = new Headers(response.headers);
      headers.set(CACHED_AT_HEADER, String(Date.now()));
      const body = await response.arrayBuffer();
      await cache.put(request, new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }));
    } catch { /* quota or clone failure — offline copy just isn't saved */ }
  }

  // Oldest-first eviction keeps the API cache bounded. Cache keys iterate
  // in insertion order, so dropping from the front approximates LRU-by-write.
  // Immune entries (the session) are excluded from BOTH the budget and the
  // eviction list, so they can neither be dropped nor push a real entry out.
  async function trimApiCache(cache) {
    try {
      const keys = await cache.keys();
      const evictable = keys.filter((k) => !isImmuneApiRequest(k.url, ORIGIN));
      for (let i = 0; i < evictable.length - API_CACHE_MAX_ENTRIES; i++) {
        await cache.delete(evictable[i]);
      }
    } catch { /* best-effort */ }
  }

  async function pruneStaleApiEntries() {
    try {
      const cache = await caches.open(API_CACHE);
      const keys = await cache.keys();
      const now = Date.now();
      for (const key of keys) {
        if (isImmuneApiRequest(key.url, ORIGIN)) continue;
        const res = await cache.match(key);
        const at = Number(res && res.headers.get(CACHED_AT_HEADER));
        if (at && now - at > API_CACHE_MAX_AGE_MS) await cache.delete(key);
      }
    } catch { /* best-effort */ }
  }

  // Deadline timer for raceNetworkAndCache; returns its cancel function.
  function swSchedule(fn, ms) {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  }

  async function networkFirstShell(event) {
    const cache = await caches.open(SHELL_CACHE);
    const { response, pending } = await raceNetworkAndCache({
      startFetch: () => fetch(event.request).then((res) => {
        // Clone synchronously, before the page can start reading the body.
        if (res && res.ok) cache.put(event.request, res.clone()).catch(() => {});
        return res;
      }),
      matchCache: () => cache.match(event.request, { ignoreSearch: true }),
      timeoutMs: SHELL_TIMEOUT_MS,
      schedule: swSchedule,
    });
    // Served from cache on the deadline: keep the request alive so its
    // response still lands in the cache for the next load.
    if (pending) event.waitUntil(pending.catch(() => {}));
    return response;
  }

  async function networkFirstNavigate(event) {
    const cache = await caches.open(SHELL_CACHE);
    // Any SPA path serves index.html online (the server's catch-all), so
    // the cached shell is the correct fallback for every route —
    // including the old standalone auth pages, which are redirect stubs
    // into the SPA's hash routes now (fold-auth-pages-into-SPA).
    const { response, pending } = await raceNetworkAndCache({
      startFetch: () => fetch(event.request),
      matchCache: () => cache.match('/index.html'),
      timeoutMs: NAVIGATE_TIMEOUT_MS,
      schedule: swSchedule,
    });
    if (pending) event.waitUntil(pending.catch(() => {}));
    return response;
  }

  async function networkFirstApi(event) {
    const cache = await caches.open(API_CACHE);
    const { response, pending } = await raceNetworkAndCache({
      startFetch: () => fetch(event.request).then((res) => {
        // Only genuine successes are worth replaying offline; 401/403/500
        // must never mask a later real answer. Clone before returning —
        // once the page starts reading the body the response is locked.
        if (res && res.status === 200) {
          const copy = res.clone();
          event.waitUntil((async () => {
            await stampAndPut(cache, event.request, copy);
            await trimApiCache(cache);
          })());
        }
        return res;
      }),
      matchCache: () => cache.match(event.request),
      timeoutMs: API_TIMEOUT_MS,
      schedule: swSchedule,
    });
    if (pending) event.waitUntil(pending.catch(() => {}));
    return response;
  }

  async function cacheFirstImmutable(event) {
    const cache = await caches.open(IMMUTABLE_CACHE);
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const res = await fetch(event.request);
    if (res && res.ok) cache.put(event.request, res.clone()).catch(() => {});
    return res;
  }

  self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      const shell = await caches.open(SHELL_CACHE);
      // Per-asset, best-effort: one 404 must not brick the whole install.
      // Every asset the shell needs is same-origin now, so a completed
      // install is enough to render offline — there is no second,
      // cross-origin precache pass that can partially fail any more.
      await Promise.allSettled(SHELL_ASSETS.map((path) => shell.add(path)));
      await self.skipWaiting();
    })());
  });

  // One-time rescue of the API entries a pre-#1021 worker parked under a
  // version-named cache. Runs on activate BEFORE the prune below deletes
  // those names — otherwise this very upgrade would sign the device out
  // offline, which is the bug #1021 reported.
  async function migrateLegacyApiCaches(names) {
    const legacy = names.filter((n) => LEGACY_API_CACHE_RE.test(n));
    if (!legacy.length) return;
    try {
      const target = await caches.open(API_CACHE);
      for (const name of legacy) {
        const src = await caches.open(name);
        for (const key of await src.keys()) {
          // Never overwrite a fresher entry the new worker already stored.
          if (await target.match(key)) continue;
          const res = await src.match(key);
          if (res) await target.put(key, res);
        }
      }
    } catch { /* best-effort — a failed migration must not block activate */ }
  }

  // Logout must not leave one user's API responses readable by the next.
  // Legacy names are included: they may still hold a pre-migration copy.
  async function clearApiCaches() {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n === API_CACHE || LEGACY_API_CACHE_RE.test(n))
      .map((n) => caches.delete(n)));
  }

  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await migrateLegacyApiCaches(names);
      // Drop caches from older SW versions.
      await Promise.all(names
        .filter((n) => n.startsWith('usernode-') && !ALL_CACHES.includes(n))
        .map((n) => caches.delete(n)));
      await pruneStaleApiEntries();
      await self.clients.claim();
    })());
  });

  self.addEventListener('message', (event) => {
    const type = event.data && event.data.type;
    if (type === 'clear-api-cache') {
      event.waitUntil((async () => {
        await clearApiCaches();
        const port = event.ports && event.ports[0];
        if (port) port.postMessage({ done: true });
      })());
    }
  });

  self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Belt-and-braces logout isolation: a logout passing through (never
    // intercepted — it's a POST) still wipes the per-user API cache.
    if (req.method === 'POST' && new URL(req.url).pathname === '/api/auth/logout') {
      event.waitUntil(clearApiCaches());
      return;
    }

    const kind = classifyRequest(
      req.method, req.url, req.headers.get('accept'), req.mode, ORIGIN
    );
    switch (kind) {
      case 'navigate': event.respondWith(networkFirstNavigate(event)); break;
      case 'shell': event.respondWith(networkFirstShell(event)); break;
      case 'api': event.respondWith(networkFirstApi(event)); break;
      case 'immutable': event.respondWith(cacheFirstImmutable(event)); break;
      default: /* bypass — browser default network handling */ break;
    }
  });
}
