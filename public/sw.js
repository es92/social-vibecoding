// Platform-shell service worker — read-only offline mode (#487).
//
// Design contract (see the offline-mode spec):
//   - A GOOD CONNECTION STILL GETS THE NEWEST BUILD ON THIS LOAD; a bad
//     one gets the cached one immediately. Shell strategies are network-first
//     against a DEADLINE (#1021): a response that has not arrived in time
//     is answered from cache, and the network response — still in flight —
//     replaces the cached copy when it lands. This preserves the
//     platform's hard-learned freshness rule
//     (src/services/static-cache.js): the next page load is fresh, and
//     the drawer's stale-version pill (App.renderPlatformVersionPill)
//     remains the visible recovery for a tab that is behind a deploy.
//     Without the deadline a stalled-but-open connection held the
//     navigation (and every one of the shell's ~70 scripts) open forever
//     while a complete cached copy sat unused — the reported white screen.
//
//     The deadlines are DELIBERATELY SHORTER THAN A ROUND TRIP for the
//     shell (200ms), because being one deploy behind for one load is
//     cheap and a blank screen is not; see the constants below for the
//     full reasoning, and note the two mechanisms that keep it honest —
//     shellFromCacheThisLoad, so one load cannot mix two builds, and the
//     `api-updated` message, so a stale API answer corrects itself on
//     screen instead of waiting for a reload.
//   - Only GETs are ever intercepted. Writes, SSE streams, auth flows and
//     credentials are hard-bypassed (see classifyRequest below).
//   - Permitted GET /api/* JSON lets previously-viewed screens re-render
//     offline. The page requests fresh reads, so these fall back on network
//     failure, or when the network has not answered within
//     FRESH_API_TIMEOUT_MS (a link that connects but carries nothing never
//     fails). Entries honor response policy, require matching
//     page/server session labels, and are fenced and cleared at identity
//     boundaries. Identity and credential reads never enter the cache.
//
// classifyRequest(), isImmuneApiRequest() and raceNetworkAndCache() are
// pure functions on purpose: tests/pwa-sw-classify.test.js and
// tests/pwa-offline-cache.test.js load this file in Node (module.exports
// branch at the bottom) and pin their behaviour without a browser.

// Hosted releases use a generated worker and per-asset content hashes.
// scripts/build-shell-release.js appends this strategy implementation to the
// generated manifest and release-cache helper. A UI-only change automatically
// changes the worker bytes and stages a complete shell without a manual bump.
// The legacy strategy remains for unbuilt development and existing v36 caches.
// API caching is independent from either shell strategy.
//
// Legacy development/cache-format identity only. Hosted /sw.js is generated
// from the final asset manifest: UI changes never require editing this value.
//
// v37 (#3331): replace the In review sorting pill with the compact header
// button. Bumped past v36 so an unbuilt development checkout also retires the
// pre-compact-sorting shell cache, matching the fresh-browser renderer
// (tests/pwa-offline-cache.test.js).
const SW_VERSION = 'v37';
const SHELL_CACHE = `usernode-shell-${SW_VERSION}`;
const IMMUTABLE_CACHE = `usernode-immutable-${SW_VERSION}`;

// The API cache is DELIBERATELY NOT VERSIONED WITH SW_VERSION (#1021).
// It used to be `usernode-api-${SW_VERSION}`, and the activate handler
// below deletes every `usernode-*` cache not listed in ALL_CACHES — so
// every routine service-worker bump silently wiped the cached feed. Keep
// certified session partitions across ordinary shell upgrades. Offline
// boot's display-only session snapshot is separate from this cache.
//
// Storage-contract changes must migrate or discard incompatible entries
// during activation; a routine shell bump must never empty this cache.
const API_CACHE_FORMAT = '';
const API_CACHE = `usernode-api${API_CACHE_FORMAT}`;
const ALL_CACHES = [SHELL_CACHE, API_CACHE, IMMUTABLE_CACHE];

// Version-named API caches left behind by workers older than #1021.
// Their unscoped entries have no trustworthy owner. Activation removes
// these legacy copies rather than assigning them to the current viewer.
const LEGACY_API_CACHE_RE = /^usernode-api-v\d+$/;

// API-cache hygiene knobs.
const API_CACHE_MAX_ENTRIES = 300;
const API_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const CACHED_AT_HEADER = 'sw-cached-at';
// A non-credential fingerprint of the current browser session. The page
// reads its companion cookie; the server independently confirms the label.
const API_SCOPE_HEADER = 'X-Usernode-Cache-Scope';
const API_SCOPE_PARAM = '__usernode_cache_scope';

function apiScopeOf(request) {
  const scope = request.headers?.get(API_SCOPE_HEADER);
  return /^[a-f0-9]{64}$/.test(scope || '') ? scope : null;
}

function disallowsStorage(response) {
  return /(?:^|,)\s*(?:no-store|no-cache)(?:\s*(?:,|=|$))/i.test(responseHeader(response, 'Cache-Control') || '')
    || /\bno-cache\b/i.test(responseHeader(response, 'Pragma') || '')
    || (responseHeader(response, 'Vary') || '').split(',').some(v => v.trim() === '*');
}

function apiCacheKey(request, scope) {
  const url = new URL(request.url);
  url.searchParams.set(API_SCOPE_PARAM, scope);
  return new Request(url.href, { headers: request.headers });
}

function apiEntryCanReplay(response, scope, now = Date.now()) {
  if (!response || response.status !== 200 || disallowsStorage(response)
      || responseHeader(response, API_SCOPE_HEADER) !== scope) return false;
  const at = Number(responseHeader(response, CACHED_AT_HEADER));
  if (!at || at > now) return false;
  const policy = responseHeader(response, 'Cache-Control') || '';
  const maxAge = /(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(policy);
  const ageLimit = maxAge ? Math.min(Number(maxAge[1]) * 1000, API_CACHE_MAX_AGE_MS)
    : /\bmust-revalidate\b/i.test(policy) ? 0 : API_CACHE_MAX_AGE_MS;
  return now - at < ageLimit;
}

// Identity reads never enter this cache. Offline boot's display-only
// session snapshot lives separately; no API entry is exempt from eviction.
const IMMUNE_API_PATHS = [];

// Network deadlines. A deadline is how long a request may hold the page
// before the CACHED copy is shown instead. The request itself is never
// cancelled and its answer still refreshes the cache, so the deadline only
// ever unlocks the cache — it never shortens a fetch.
//
// #1021 introduced these at 3s/3s/4s, which fixed the reported hang but
// left the reported SLOWNESS, because the tiers run SERIALLY: nothing
// requests a shell asset until index.html has parsed, and nothing calls
// /api/auth/me until those scripts have run. Three patient tiers plus
// App.BOOT_SESSION_TIMEOUT_MS was ~11 seconds to a painted signed-in shell
// on a weak link — not a hang, just four individually-reasonable waits in
// a row.
//
// 200ms is BELOW a healthy same-origin round trip on purpose. Every shell
// asset is local and served with `no-cache, must-revalidate`
// (src/services/static-cache.js), so a good connection answers a
// conditional GET with a 304 well inside it and still gets the newest
// build on THIS load; anything slower falls straight through to the cached
// shell instead of holding a blank screen. Being one deploy behind for one
// load is the accepted cost, and it already has a designed recovery — the
// drawer's stale-version pill (App.renderPlatformVersionPill) and the
// reload upgrade in App._refreshOrReload.
//
// The API tier keeps a real deadline (1s) because a stale answer there is
// WRONG CONTENT, not merely an old build, and 200ms would sit under the
// round trip of most mobile networks — turning "network-first" into
// cache-first for everyone not on wifi while still claiming otherwise.
// What makes serving a stale API answer safe at all is the notify path in
// networkFirstApi: the page is told when the real answer lands and
// disagrees. Do not shorten this one without keeping that.
// The platform's identity fetch wrapper requests fresh reads (`reload`),
// which skip these compatibility deadlines for the much longer
// FRESH_API_TIMEOUT_MS below.
const NAVIGATE_TIMEOUT_MS = 200;
const SHELL_TIMEOUT_MS = 200;
const API_TIMEOUT_MS = 1000;

// ── The reads that gate a first paint ────────────────────────────────
//
// The staging a returning visitor sees is NOT an asset problem. A warm
// second load requests all ~38 shell assets in one batch at ~35ms — the
// precache list below is complete and the sync test keeps it that way. What
// arrives in stages is DATA, and it arrives in SERIAL stages: on home,
// /api/apps, /api/home-layout and /api/home-panels answer around 240ms on a
// warm local link and every app icon and avatar starts loading only THEN,
// because its URL is a field inside those answers. On an app's dev board it
// is worse, because the requests form a chain — GET /api/apps/:slug has to
// answer before AppView._loadDevData can ask for the board at all, and the
// board is nine more requests whose slowest one (/promoted) is the content.
// Measured warm, under a 4x CPU throttle: the session check lands at ~870ms,
// the app record at ~1130ms, the last board read at ~1550ms, the first real
// card at ~2430ms. Three of those milestones are round trips stacked
// end to end, and on a phone each is worth several hundred ms, not the
// ~100ms a loopback charges.
//
// These reads get a ZERO deadline, which means: if there is a cached copy,
// serve it on this tick and let the network answer land behind it. The
// previous session's launcher paints on the first frame, complete with its
// icons (cache-first '/app-icons' and '/avatars' already hold them), and the
// board paints its previous cards instead of a skeleton — then both are
// corrected in place by the api-updated path below. (A FRESH read, which is
// what the page's identity wrapper sends, waits FRESH_BOOT_API_TIMEOUT_MS
// here instead; see there.)
//
// Why THESE and not the API tier at large: each one is a screen's own
// standing state, on a screen this device has already rendered once, with a
// live correction path that repaints it in place. The board's repaint is
// AppView._repaintDevBody — it swaps the cards under the filter bar and
// never puts the skeleton back, so a correction reads as the row updating,
// not as the screen reloading. What is deliberately NOT here is everything
// whose staleness has no such repaint or no such second look: an app's
// message pages, a proposal's detail, anything paginated. Those keep the 1s
// deadline above.
//
// NOT /promoted AND /merged (polish board #3, 19 Oct 2026). The board used to
// cross a line this list draws at the launcher: a cached /promoted carries
// VOTE COUNTS and CHECK STATES, /merged what went live, and for the first
// moments of a warm load those were last visit's. The project's hub states
// them as facts, in its own words and on the Communities tab's badge ("6 to
// vote", the Needs you line, Recently live), and every warm open drew last
// visit's and then swapped them half a second later. The hub already waits
// for its community record, which is not in this lane, so those two reads
// now take the ordinary deadline beside it: on a healthy link the hub draws
// once, with today's numbers; on a slow one the saved copy still answers at
// API_TIMEOUT_MS and is corrected in place below.
//
// The correction is not optional: it is what makes this safe. networkFirstApi
// posts `api-updated` when the copy it served disagrees with the answer that
// arrives, and App._onApiUpdated re-runs the visible screen's own loader
// (App.refreshActiveScreen → Home.load / AppView.refreshDevData). If that
// path is ever removed, remove this list with it.
//
// NOT in the lane on purpose: /api/auth/me. It gates the whole boot
// (App._fetchSession) and it is the one read whose cached copy can be
// affirmatively WRONG rather than merely old — a session that has since
// ended answers 401, error responses are never cached, so a cached 200
// would paint the signed-in shell with nothing left to correct it. The
// snapshot path (App.readSessionSnapshot / _reconcileSession) is where that
// case is already handled, and moving boot onto it is an auth change, not a
// caching one.
const BOOT_READ_PATHS = [
  // Home: the launcher's own list, its layout, its widgets.
  '/api/apps',
  '/api/home-layout',
  '/api/home-panels',
  // The dev board's "In progress" rows. Global rather than per-app, so it
  // belongs to the exact list even though the board is what waits on it.
  '/api/me/active-sessions',
];

// Per-app reads with a slug in the path, so an exact match cannot express
// them. Anchored at both ends and one segment wide on purpose: this must
// admit `/api/apps/:slug/issues` and refuse `/api/apps/:slug/messages`,
// which is paginated and stays on the ordinary deadline.
//
// The first is the app record itself — it is not board content, it is the
// SERIAL GATE in front of the board's nine requests, so leaving it out would
// have left the chain one round trip long and bought nothing.
const BOOT_READ_PATTERNS = [
  /^\/api\/apps\/[^/]+$/,
  /^\/api\/apps\/[^/]+\/(?:github-issues|issues|board-order|sessions|shared-sessions|topic-categories)$/,
];

const BOOT_API_TIMEOUT_MS = 0;

// ── Fresh reads on a link that is not answering ──────────────────────
//
// Every permitted page read arrives as a fresh read: the page's identity
// wrapper (frontend/src/lib/api-cache-identity.ts) sends them all with
// `cache: 'reload'`, and live-reads' re-reads ask with 'no-cache' (#4177).
// Such a read used to get no deadline at all, so the saved copy answered only
// when the fetch REJECTED. A link that connects but carries nothing (a Wi-Fi
// with no internet behind it, a connection that died silently between
// networks, a lift) never rejects: in the offline test of 2 Nov 2026 a cold
// launch sat on Home's skeleton for over a minute with the saved apps in this
// cache, while the same launch with the internet fully off showed them at
// once.
//
// So a fresh read gets a deadline too, a long one. It is not a race the cache
// is meant to win: a working link answers well inside it, and then nothing
// differs from before. Only a read the network has not answered by then gets
// the saved copy, and it is exactly the copy a failed fetch would get (the
// same entry, the same scope and age rules, the same `sw-cached-at` stamp).
// The request keeps going: its answer is stored under the usual rules, and
// networkFirstApi posts `api-updated` when that answer differs from the copy
// or retires it. With nothing saved, the deadline unlocks nothing and the
// read waits for the network exactly as before; the page's own read timeout
// decides when a read with nothing to show has waited too long, because only
// the page can tell a dead link from a slow answer worth waiting for.
//
// 4s sits far above a healthy round trip on any mobile network and well
// inside the page's read timeout, so the copy arrives before the page gives
// up on the read.
const FRESH_API_TIMEOUT_MS = 4000;
// The boot reads get a shorter one, for the reasons that give them a zero
// deadline when they are not fresh: each is a screen's standing state, on a
// screen this device has drawn before, with an in-place repaint for the
// correction. And the board's reads are a SERIAL chain (the app record has
// to answer before the board's nine reads can start), so 4s per stage would
// add up to a skeleton twice as long. 2s is still several healthy round
// trips, connection setup included, so a working link keeps answering first;
// the lane rules (`correcting`, a refresh's intent) shut it as they do for
// the zero deadline, and such a read then waits FRESH_API_TIMEOUT_MS.
const FRESH_BOOT_API_TIMEOUT_MS = 2000;

/**
 * Is this one of the reads that gates a screen's first paint? Pure and
 * exported: apiTimeoutFor reads it for the deadline, and trimApiCache reads
 * it to decide what a full cache evicts LAST.
 */
function isBootReadRequest(url, selfOrigin) {
  let p;
  try { p = new URL(url, selfOrigin).pathname; } catch { return false; }
  if (BOOT_READ_PATHS.includes(p)) return true;
  return BOOT_READ_PATTERNS.some((re) => re.test(p));
}

/**
 * The deadline for one API request: 0 for a boot read, API_TIMEOUT_MS
 * otherwise.
 */
function apiTimeoutFor(url, selfOrigin) {
  return isBootReadRequest(url, selfOrigin) ? BOOT_API_TIMEOUT_MS : API_TIMEOUT_MS;
}

// How long an announced refresh keeps the lane shut. One pull re-pulls a
// screen's several endpoints, not one, and on a slow link they do not all
// leave within a few hundred ms — so the window has to outlast the request
// fan-out. It is bounded because a stuck flag would turn every later boot
// into a cold one.
const REFRESH_INTENT_WINDOW_MS = 10_000;

// Does this request get the fast lane?
//
// The rule is already stated where `correcting` is declared: THE FAST LANE
// ANSWERS A BOOT, NOT A REFRESH. `correcting` enforces it reactively — one
// URL at a time, and only after a stale answer has already been served and
// noticed. That is enough for the case it was written for, a body that
// changes every call.
//
// It is not enough for a PULL. A pull is the same rule known in advance:
// somebody has asked for the current state with their thumb, on the one
// gesture people reach for when they suspect a screen is stale. Serving it
// from cache is exactly backwards, and the correction that undoes it cannot
// fire until the network answer it compares against arrives — so the defect
// hides on a fast link and shows on a slow one, which is the wrong way round.
// A phone on mobile data is both the slowest case and where pulls happen.
//
// So an announced refresh shuts the lane outright for a short window, and
// every read in it pays the ordinary deadline. Offline is unaffected: that
// deadline still falls back to the cache when the network fails.
function bootLaneApplies(url, selfOrigin, now, refreshUntil) {
  if (refreshUntil && now < refreshUntil) return false;
  return apiTimeoutFor(url, selfOrigin) === BOOT_API_TIMEOUT_MS;
}

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
  // churn on every build. A deployed document loads it, like every script and
  // stylesheet here, from `/b/<build sha>/shell/assets/shell.js`: the build
  // moves into the URL's prefix rather than the filename, precacheShell
  // derives that address from this plain path, and the server answers it
  // immutable (see "Build-scoped asset URLs" above parseBuildScopedPath).
  // A checkout keeps the plain path under `no-cache, must-revalidate`
  // (src/services/static-cache.js) plus this worker being network-first.
  '/shell/assets/shell.js',
  // ── LAZY CHUNKS ARE DELIBERATELY NOT HERE ────────────────────────────
  //
  // The React build emits route chunks beside shell.js now
  // (frontend/vite.config.ts) — assets/shell-sections.js, the admin
  // console's twenty section modules, 421KB that a non-admin never
  // downloads and nobody parses until the console is opened; and
  // assets/shell-settings-chunk.js, the Settings controller and its sixteen
  // panes, loaded on the first open or at idle for a signed-in viewer
  // (frontend/src/features/settings/facade.js).
  //
  // Precaching one would hand that bandwidth straight back: install() would
  // fetch it for every visitor on every worker version, which is most of what
  // splitting it out was for. It does not need to be here. classifyRequest
  // routes it to networkFirstShell like any other /shell/assets/*.js, so the
  // first open caches it and every later one is served from that cache under
  // the build-identity fast path.
  //
  // The one thing this costs is opening the admin console offline having
  // never opened it online — which is not a scenario: every section polls a
  // live endpoint (Health & status hits /api/status every 5s), so the chunk
  // would arrive to render a screen with nothing to show.
  //
  // A future chunk that IS needed for a first paint belongs in this list.
  // One reached by navigation does not.

  // Vendored third-party libs (public/vendor/README.md records provenance).
  '/vendor/qrcode-1.0.0.min.js',
  '/vendor/marked-15.0.12.min.js',
  '/vendor/purify-3.4.17.min.js',
  '/usernode-native/v1/native.css',
  '/usernode-native/v1/native.js',
  '/usernode-bridge.js',
  '/js/auth-screens.js',
  // The admin console's ten modules (admin-console.js, admin-topochain.js and
  // the eight folded-in #860 section modules) used to be listed here. #1082
  // chunk E moved them into the React bundle, so /shell/assets/shell.js above
  // is what precaches them now.
  // The app-secrets dialog's module used to be listed here. #1078 chunk I
  // moved it into the React bundle, so /shell/assets/shell.js above is what
  // precaches it now.
  // The browse-all-apps screen's module used to be listed here. #1083 chunk F
  // moved it into the React bundle, so /shell/assets/shell.js above is what
  // precaches it now.
  // #1036: the real-anchor / new-tab seam. Loads ahead of every other
  // module in index.html, so a cache miss here breaks the whole shell.
  '/js/nav-link.js',
  '/js/platform-ui.js',
  '/js/ui-telemetry.js',
  '/js/app-view.js',
  '/js/app.js',
  '/js/build-log.js',
  '/js/cc-progress-summary.js',
  '/js/topochain-events.js',
  '/js/confirm-modal.js',
  '/js/dev-alerts.js',
  // '/js/dev-chat.js' — #1084 chunk G moved it into the React bundle
  // (frontend/src/features/dev-chat/dev-chat.js), which /shell/assets/shell.js
  // already precaches. Precaching it here as well would 404 the install.
  '/js/dev-flow-select.js',
  '/js/dev-host.js',
  // #1054: the offline feedback outbox. It has to be precached like any other
  // shell module — the whole point is that it works on the load where the
  // network does not.
  '/js/feedback-queue.js',
  '/js/group-chat.js',
  // The home screen's three modules (the grid, its widget renderers and the
  // layout geometry they share) were listed here. #1083 chunk F moved all
  // three into the React bundle with the screen they render, so
  // /shell/assets/shell.js above is what precaches them now — which matters
  // more here than for the other chunks: home is the offline landing screen,
  // so a cache miss on it is the whole app.
  // The Kudos widget and the Leaderboard screen's own renderer were listed
  // here. #1083 chunk F moved both into the React bundle with the screen, so
  // /shell/assets/shell.js above is what precaches them now.
  '/js/merge-status.js',
  '/js/native-chrome.js',
  '/js/social-push.js',
  '/js/build-venues.js',
  '/js/credit-options.js',
  // The profile screen's renderer used to be listed here. #1083 chunk F moved
  // it into the React bundle, so /shell/assets/shell.js above is what
  // precaches it now.
  // The feedback dialog's screenshot-capture module used to be listed here.
  // #1078 chunk I moved it into the React bundle, so /shell/assets/shell.js
  // above is what precaches it now.
  '/js/session-options.js',
  '/js/session-transcript.js',
  '/js/spec-sections.js',
  '/js/streaming-markdown.js',
  '/js/session-state.js',
  // The Leaderboard screen's three Topochain-domain panes were listed here
  // too, and moved in the same chunk. Only the shared event RULES they read
  // (topochain-events.js, above) are still a classic script.
  '/manifest.webmanifest',
  '/icons/v3/icon-192.png',
  '/icons/v3/icon-512.png',
  '/icons/v3/icon-maskable-512.png',
  // The signed-out landing's illustration. It has no fallback to draw in its
  // place, and it is the first thing a visitor who has never signed in sees —
  // on a document that is itself precached. An offline first run would
  // otherwise render the new landing around a broken image.
  // Provenance and export settings in public/brand/README.md.
  '/brand/people.png',
  // #2718: the Homeroom mark, drawn in the header on EVERY route — the
  // button that opens the platform's menu. The landing's illustration above
  // is precached because the signed-out screen has nothing to put in its
  // place; this one because a missing header logo is a hole at the top of
  // every screen, offline and on a cold cache alike.
  '/brand/homeroom-mark.png',
  // The logotype the held boot ground masks its ink with (frontend/src/
  // head.html): the first thing a cold load paints, so it must be on hand
  // offline as well. It already ships for the mail frame's raster.
  '/brand/homeroom-logotype-black.png',
  // The built-in challenge artwork (frontend/src/lib/challenge-illustrations.ts,
  // one file per slug). It used to stay on the network, as decoration with a
  // fallback, and that cost Home a visible step on every cold load: the
  // Challenges cards drew, and their pictures arrived a frame or more later
  // (#1 and #10, the polish board of 19 Oct 2026; in the app the launch cover
  // now waits for them). From the release cache they are on hand when the
  // cards are. About 150 KB together; tests/pwa-sw-classify.test.js holds this
  // list to the directory.
  '/illustrations/challenges/block-production.svg',
  '/illustrations/challenges/connect-participants.svg',
  '/illustrations/challenges/identity-level-one.svg',
  '/illustrations/challenges/identity-level-two.svg',
  '/illustrations/challenges/invite-to-network.svg',
  '/illustrations/challenges/make-a-proposal.svg',
  '/illustrations/challenges/network-participation.svg',
  '/illustrations/challenges/proposal-accepted.svg',
  '/illustrations/challenges/ten-minutes-in-apps.svg',
  '/illustrations/challenges/try-three-apps.svg',
  '/illustrations/challenges/useful-feedback.svg',
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
  // The notification ask's code to scan (routes/public-api.js /get-app): a
  // redirect to the phone's own store, never a shell route. The cached shell
  // answering it would open Homeroom's home screen instead of the store.
  '/get-app',
];

// Prefix-matched counterpart of NO_FALLBACK_PAGES, for standalone pages
// whose path carries a variable segment.
//
// /reports/<token> is a PUBLIC report share link (routes/
// report-snapshots.js, mounted before authMiddleware): a sandboxed,
// self-contained server document meant to be pasted to people with no
// platform session. The recipient most likely to hit this worker is a
// platform user who is logged out on that device — and serving them the
// cached SPA shell (offline, or on the 3s navigate deadline of a slow
// connection) replaces the report with the LOGIN SCREEN, turning a
// deliberately unauthenticated link into an auth wall. The report is
// no-store by design (unshare must bite immediately), so there is no
// cached copy to fall back to either way: bypass, and let it load or
// fail like any plain document.
//
// /embed/<slug> is the same kind of page (routes/project-preview.js): a
// public project as a post on X frames it, a server document with no
// session that is never the shell. It is no-store too.
const NO_FALLBACK_PREFIXES = [
  '/reports/',
  '/embed/',
];

// An app's install page: a server page under /app/<slug>/ that is never the
// shell (classifyRequest and isShellDocumentUrl below).
const APP_INSTALL_PAGE = /^\/app\/[a-z0-9][a-z0-9-]{0,254}\/install$/;

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
  // Identity/credential reads always reach the server. Offline boot's
  // display-only session snapshot is owned by App, never an API credential.
  if (p.startsWith('/api/auth/')) return 'bypass';

  // Local-dev mock namespace and short-lived credentials.
  if (p.startsWith('/__mock/')) return 'bypass';
  if (p === '/api/iframe-token') return 'bypass';
  if (p.startsWith('/api/cli/')) return 'bypass';
  if (p === '/api/me/cli-tokens' || p.startsWith('/api/me/cli-tokens/')) {
    return 'bypass';
  }
  // Slot availability and pending requests must reflect the current account,
  // including immediately after an admin edit. Never replay an offline count.
  if (p === '/api/me/app-allowance' || p.startsWith('/api/me/app-allowance/')) return 'bypass';
  // Network/receiver configuration must be live. Completed epoch responses
  // have their own device cache keyed by chain, wallet and epoch.
  if (p === '/api/me/staking' || p.startsWith('/api/me/staking/')) return 'bypass';
  // Hosted MCP connector and social-account OAuth: endpoints, OAuth
  // surfaces and identity status. Same hard bypass as the CLI's, for the
  // same reason — none of this may ever be answered from a cache.
  if (p === '/mcp') return 'bypass';
  if (p.startsWith('/api/connect/')) return 'bypass';
  if (p === '/api/me/connectors' || p.startsWith('/api/me/connectors/')) {
    return 'bypass';
  }
  if (p === '/api/me/social-identities' || p.startsWith('/api/me/social-identities/')) {
    return 'bypass';
  }
  if (p === '/api/me/github' || p.startsWith('/api/me/github/')) return 'bypass';
  if (p === '/api/me/x' || p.startsWith('/api/me/x/')) return 'bypass';
  // App creation status rechecks are an explicit freshness request. Ordinary
  // GET /api/apps/:slug stays in the zero-deadline boot lane so a warm screen
  // paints immediately, but a recovery loop cannot clear a stale `creating`
  // placeholder if the worker is allowed to hand that same cached snapshot
  // straight back. The query tag is scoped to exactly the app-detail route;
  // the server ignores it and answers the normal representation.
  if (/^\/api\/apps\/[^/]+$/.test(p)
      && u.searchParams.get('status_recheck') === '1') return 'bypass';
  // Waitlist social connect (routes/waitlist-connect.js): the start route
  // redirects to the provider and the callback is a standalone status page.
  // As ordinary navigations both fell into the 200ms shell race, so a
  // returning visitor saw the cached SPA home page in place of the provider
  // redirect, and again in place of the status page on the way back.
  if (p.startsWith('/waitlist/connect/')) return 'bypass';
  // The OpenRouter catalog is private, key-filtered, and has its own short
  // server cache plus an explicit refresh control. Replaying the PWA's much
  // longer offline copy can hide newly released models and account-policy
  // changes, while an offline picker cannot start a usable run anyway.
  if (p === '/api/me/coding-agent/models') return 'bypass';
  if (p.startsWith('/.well-known/oauth-')) return 'bypass';
  // Auth endpoints are online-only — EXCEPT /api/auth/me, which is cached
  // so the SPA's boot check succeeds offline for a logged-in user.
  if (p.startsWith('/api/auth/') && p !== '/api/auth/me') return 'bypass';
  // The optional boot read (#5678): "nobody is signed in" must never be
  // replayed from the cache, and offline it is a non-answer, as the
  // no-snapshot boot always was.
  if (p === '/api/auth/me' && u.searchParams.get('optional') === '1') return 'bypass';

  // Group-chat attachment responses are files, not JSON or SPA documents.
  // In particular, clicking an image opens this URL as a navigation. If the
  // worker races that navigation against its cached document, the 200ms shell
  // fallback can replace a slow image response with the app home screen.
  // Leave both the byte route and the sandboxed HTML preview to the browser;
  // their server responses already carry the appropriate private cache rules.
  if (/^\/api\/apps\/[^/]+\/chat-attachments\/[a-f0-9]{32}(?:\/view)?$/.test(p)) {
    return 'bypass';
  }

  // Online-only rules must run before this fallback. OAuth Connect and
  // callback URLs are document navigations too: serving index.html after
  // 200ms replaces their redirect with the app, even while the network
  // request creates an unfinished OAuth state (#1543).
  if (mode === 'navigate') {
    if (NO_FALLBACK_PAGES.includes(p)) return 'bypass';
    if (NO_FALLBACK_PREFIXES.some((pre) => p.startsWith(pre))) return 'bypass';
    // #3381: a navigation to /api/... is a file or a redirect, never the
    // shell: the server has no SPA route under /api/. A download link is a
    // navigation too, and the shell-release cache (sw-release.js navigate)
    // answers every navigation with a shell document, so each admin CSV
    // export saved the app page as export.csv. The chat-attachments rule
    // above was the first case of this; this is all of them.
    if (p.startsWith('/api/')) return 'bypass';
    // #3585: the same holds for the server's file routes outside /api/. An
    // issue's screenshot (/issue-images/<id>) opens in a new tab when it is
    // clicked, and the shell answered that navigation with the home screen.
    // Only the navigation is exempted: as subresources these stay
    // 'immutable' below.
    if (/^\/(?:issue-images|visuals|app-icons|avatars|app-files)\/[a-f0-9]{32}$/.test(p)) {
      return 'bypass';
    }
    // The same again for an app's install page (/app/<slug>/install,
    // routes/app-install.js), which "Add to home screen" opens from Home's
    // card menu, Discover and the app menu's About. It is a server page, not
    // a shell route, so the cached shell answered it, the router read
    // `install` as the App tab and reopened the app: the tap did nothing a
    // tester could see.
    if (APP_INSTALL_PAGE.test(p)) return 'bypass';
    return 'navigate';
  }

  // A native foreground push is an explicit freshness signal. Its feed read
  // must reach the network: returning the ordinary offline API-cache fallback
  // would consume the invalidation while still omitting the new activity.
  if (p === '/api/notifications' &&
      u.searchParams.get('native_invalidation') === '1') return 'bypass';

  if (p.startsWith('/api/')) return 'api';

  // Content-addressed, already served with a year-long immutable header.
  // /avatars/ joins them (#982): the id rotates whenever the bytes change
  // (POST /api/me/avatar upserts a fresh one), so a cached entry can never
  // be stale — a replaced id simply 404s.
  if (p.startsWith('/app-icons/') || p.startsWith('/visuals/')
      || p.startsWith('/avatars/')) return 'immutable';

  // The shell's own static assets (incl. /usernode-bridge/v1/... versions).
  if (/\.(?:html|js|css|webmanifest)$/i.test(p)) return 'shell';
  // A pack the server's translation cache serves (src/routes/languages.js):
  // its URL is its content hash, so it never changes, and the runtime checks
  // its bytes against the hash GET /api/languages gave. It is no build's, so
  // no release lists it: kept cache-first, like the other hashed assets.
  if (/^\/locales\/live\/[a-zA-Z-]+\.[a-z-]+\.[a-f0-9]{64}\.json$/.test(p)) return 'immutable';
  // A language pack (scripts/language-packs.js): content-hashed, fetched only
  // when a person's language asks for it, verified against the release and
  // kept for offline use from then on. Never in SHELL_ASSETS, so installing
  // this worker downloads no language.
  if (/^\/locales\/[a-zA-Z-]+\.[a-z-]+\.[a-f0-9]{64}\.json$/.test(p)) return 'shell';
  if (p.startsWith('/icons/')) return 'shell';
  // The brand assets the shell itself draws, precached above. Without this rule
  // the SHELL_ASSETS entry would fill the cache on install and never be read.
  if (p.startsWith('/brand/')) return 'shell';
  // The built-in challenge artwork, precached above for the same reason.
  if (p.startsWith('/illustrations/challenges/')) return 'shell';
  // Uploaded challenge artwork: minted per upload and served immutable
  // (src/routes/topochain/challenge-illustrations.js), so cache-first like
  // the app icons. Its card draws the moment it is on hand rather than a
  // frame after.
  if (/^\/challenge-illustrations\/[a-f0-9]{32}$/.test(p)) return 'immutable';

  // Everything else (e.g. the /health connectivity probe) goes straight
  // to the network so it always reflects real reachability.
  return 'bypass';
}

// The URLs at which the server serves the SPA shell ITSELF, as opposed to a
// document that merely falls back to it offline. `networkFirstNavigate`
// caches under the fixed '/index.html' key — one document answers every
// client route — so it may only write back a response that really IS that
// document. Clean app paths are first-class shell documents alongside `/`.
//
// The distinction matters because `classifyRequest` returns 'navigate' for
// far more than these two. /login.html, /dashboard.html, /gallery.html and
// the rest of #860's redirect stubs are a KB of `location.replace()` each:
// correct to *serve* the cached shell for when offline, catastrophic to
// *store* as the cached shell, which would leave every later cache-served
// navigation holding a stub instead of the app. Anything else navigable
// bounces to '/' at the server (middleware/auth.js), so its response is a
// redirect rather than the shell too.
//
// Pure, and exported, so tests/pwa-offline-cache.test.js can pin the stub
// list directly rather than inferring the guard from source text.
const SHELL_DOCUMENT_PATHS = ['/', '/index.html'];

function isShellDocumentUrl(url, selfOrigin) {
  try {
    const u = new URL(url, selfOrigin);
    if (u.origin !== selfOrigin) return false;
    if (APP_INSTALL_PAGE.test(u.pathname)) return false;
    return SHELL_DOCUMENT_PATHS.includes(u.pathname)
      || /^\/app\/[a-z0-9][a-z0-9-]{0,254}(?:\/.*)?$/.test(u.pathname);
  } catch { return false; }
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

// #4177: a read that asks for the CURRENT answer gets it. The page re-reads
// what is on screen after a gap (a dropped socket, a hidden tab, this
// worker's own `api-updated`; frontend/src/lib/live-reads.ts) with
// `cache: 'no-cache'`, and a re-read answered from this cache after the 1s
// deadline would be the stale copy the re-read exists to replace. Such a
// request waits for the network, keeps refreshing the cache, and falls back
// to the cached copy when the network fails, so offline still works, or when
// it has not answered within FRESH_API_TIMEOUT_MS, so a link that carries
// nothing does too. That deadline is long enough that a working link always
// answers first, and the late answer still corrects the screen.
// `reload` asks for the same thing more strongly. `no-store` never gets here:
// the fetch handler leaves it to the browser.
function wantsFreshAnswer(cacheMode) {
  return cacheMode === 'no-cache' || cacheMode === 'reload';
}

// For an answer networkFirstApi has just declined to keep: does it also say
// that the saved copy is no longer this viewer's to see? A 200 the cache may
// not keep (no-store, another session's scope, not JSON), a redirect, a
// refusal (401, 403) and a "gone" (404, 410) do. The entry is retired either
// way; this decides whether a page already SHOWN that copy, because the
// network missed its deadline, is told so. A server error, a rate limit or a
// 304 says nothing about the copy, so the screen keeps it, and its next read
// asks the network.
const RETIRING_STATUSES = [401, 403, 404, 410];

function declinedAnswerRetiresCopy(response) {
  if (!response) return false;
  return !!response.redirected || response.status === 200
    || RETIRING_STATUSES.includes(response.status);
}

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
//     never fail early just because it is slow. No cap is added here: the
//     worker cannot tell a dead link from a slow answer, and the page's own
//     read timeout owns that decision (FRESH_API_TIMEOUT_MS).
//   - `timeoutMs: null`             → no deadline at all: the network's
//     answer, however long it takes, and the cached copy only when the
//     network fails. No strategy passes it now; fresh reads take
//     FRESH_API_TIMEOUT_MS (see `wantsFreshAnswer`).
//
// `schedule(fn, ms)` returns a cancel function.
async function raceNetworkAndCache({ startFetch, matchCache, timeoutMs, schedule }) {
  const network = startFetch();
  // We may hand this promise back to the caller, or abandon it entirely
  // on the cache-hit path — either way nothing here may surface as an
  // unhandled rejection.
  network.catch(() => {});

  let cancelTimer = null;
  const deadline = timeoutMs == null
    ? new Promise(() => {})
    : new Promise((resolve) => {
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

// Whole-body compare, used to decide whether a late network answer
// actually disagrees with the cached copy the page was already shown. The
// bodies here are API JSON — a few KB — so a byte loop is cheaper than
// hashing and, unlike a hash, has no false positives. Pure and exported so
// tests/pwa-offline-cache.test.js can pin it directly.
function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// ── Build-scoped asset URLs ───────────────────────────────────────────
//
// A deployed document loads its scripts and stylesheets from
// `/b/<build sha>/…` (scripts/shell-stamp.js has the scheme; the server side
// is src/services/static-cache.js). The sha in the URL names the build the
// bytes belong to, which changes two things here:
//
//   - such a URL is CACHE-FIRST, with no deadline and no race. A hit is the
//     right build by construction — that is what the sha in the key means —
//     so the document/asset build check networkFirstShell makes for the
//     plain paths has nothing left to ask. A miss goes to the network, the
//     way a miss always did.
//   - the precache has to store the URLs the document will actually ask
//     for. SHELL_ASSETS stays the readable, hand-maintained list of plain
//     paths; precacheShell reads the build id off the document it fetches
//     first and scopes each script and stylesheet under it (the manifest,
//     the icons and the document itself have no scoped form).
//
// A checkout has no build id, so its document keeps the plain paths and
// every strategy below behaves exactly as it did.
const BUILD_SCOPED_PATH_RE = /^\/b\/([0-9a-f]{7,40})(\/.*)$/;

function parseBuildScopedPath(pathname) {
  const m = BUILD_SCOPED_PATH_RE.exec(String(pathname == null ? '' : pathname));
  return m ? { build: m[1], path: m[2] } : null;
}

// Mirrors scripts/shell-stamp.js's isBuildScopedAssetPath: scripts and
// stylesheets, never the worker itself.
function isBuildScopedAssetPath(pathname) {
  const p = String(pathname == null ? '' : pathname);
  if (p === '/sw.js') return false;
  return /\.(?:js|css)$/i.test(p);
}

// The URL a document of build `build` loads `path` from: scoped for a
// script or stylesheet when there is a build id, the plain path otherwise.
function shellAssetUrl(path, build) {
  if (!build || !isBuildScopedAssetPath(path) || parseBuildScopedPath(path)) return path;
  return `/b/${build}${path}`;
}

// A SHA identifies a build, but it cannot order two builds. The server stamps
// index.html with both: X-Platform-Build is its identity, and
// X-Platform-Build-Time is the generated document's mtime. The latter moves
// forward for a normal deploy AND for an intentional rollback, whose image is
// rebuilt now. Together they prevent an older rollout answer from replacing a
// newer cached document at the one fixed key every navigation reads.
const SHELL_BUILD_HEADER = 'x-platform-build';
const SHELL_BUILD_TIME_HEADER = 'x-platform-build-time';

function responseHeader(response, name) {
  try {
    return response && response.headers && response.headers.get(name);
  } catch { return null; }
}

function buildIdOf(response) {
  return responseHeader(response, SHELL_BUILD_HEADER) || null;
}

function buildTimeOf(response) {
  const raw = responseHeader(response, SHELL_BUILD_TIME_HEADER);
  if (!/^\d+$/.test(String(raw || ''))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Whether `candidate` may replace `current` at the fixed /index.html key.
 *
 * Same-build refreshes and the first deployed document over a legacy
 * unstamped entry are safe. Cross-build replacement is allowed only with two
 * ordered stamps and a strictly newer candidate. Missing metadata fails
 * closed in production; a dev checkout (neither response has a build id)
 * keeps its normal network-first behaviour.
 */
function shouldReplaceShellDocument(current, candidate) {
  if (!candidate) return false;
  if (!current) return true;
  const currentBuild = buildIdOf(current);
  const candidateBuild = buildIdOf(candidate);
  if (!currentBuild && !candidateBuild) return true;
  if (!currentBuild && candidateBuild) return true;
  if (currentBuild === candidateBuild) return true;
  if (!candidateBuild) return false;
  const currentTime = buildTimeOf(current);
  const candidateTime = buildTimeOf(candidate);
  return currentTime != null && candidateTime != null && candidateTime > currentTime;
}

async function putShellDocumentIfNewer(cache, candidate, key = '/index.html') {
  const current = await cache.match(key);
  if (!shouldReplaceShellDocument(current, candidate)) return false;
  await cache.put(key, candidate);
  return true;
}

/* ------------------------------------------------------------------ */
/* Service-worker runtime (skipped when loaded in Node for tests).     */
/* ------------------------------------------------------------------ */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    classifyRequest,
    apiTimeoutFor,
    bootLaneApplies,
    REFRESH_INTENT_WINDOW_MS,
    isBootReadRequest,
    BOOT_READ_PATHS,
    BOOT_READ_PATTERNS,
    BOOT_API_TIMEOUT_MS,
    FRESH_API_TIMEOUT_MS,
    FRESH_BOOT_API_TIMEOUT_MS,
    API_TIMEOUT_MS,
    isImmuneApiRequest,
    isShellDocumentUrl,
    SHELL_DOCUMENT_PATHS,
    raceNetworkAndCache,
    wantsFreshAnswer,
    declinedAnswerRetiresCopy,
    RETIRING_STATUSES,
    bytesEqual,
    SHELL_ASSETS,
    parseBuildScopedPath,
    isBuildScopedAssetPath,
    shellAssetUrl,
    buildIdOf,
    buildTimeOf,
    shouldReplaceShellDocument,
    putShellDocumentIfNewer,
    SHELL_BUILD_HEADER,
    SHELL_BUILD_TIME_HEADER,
    NO_FALLBACK_PAGES,
    NO_FALLBACK_PREFIXES,
    SW_VERSION,
    API_CACHE,
    API_SCOPE_HEADER,
    API_SCOPE_PARAM,
    apiScopeOf,
    apiCacheKey,
    apiEntryCanReplay,
    disallowsStorage,
    ALL_CACHES,
    LEGACY_API_CACHE_RE,
    IMMUNE_API_PATHS,
    NAVIGATE_TIMEOUT_MS,
    SHELL_TIMEOUT_MS,
    API_TIMEOUT_MS,
  };
} else {
  const ORIGIN = self.location.origin;
  const releaseCache = self.__USERNODE_SHELL_RELEASE__
    ? createShellReleaseCache({
      manifest: self.__USERNODE_SHELL_RELEASE__, storage: caches,
      fetcher: fetch, worker: self, cryptoApi: self.crypto, origin: ORIGIN,
      canReplaceDocument: shouldReplaceShellDocument,
    }) : null;

  // ── Per-page-load shell consistency ─────────────────────────────────
  // The shell's assets are deliberately UNHASHED, so index.html does not
  // pin the build its scripts come from: 38 assets each racing their own
  // deadline independently can hand ONE load a mix of two deploys. The
  // navigation is the first request of a load and answers the only
  // question that matters — is this connection fast right now? — so it
  // records its own outcome here and every shell asset in the same load
  // follows it, instead of re-rolling the dice 38 more times.
  //
  // (A deployed document's scripts are build-scoped URLs and never reach
  // this race — the sha in the path already pins the build; see
  // parseBuildScopedPath. The plain paths a checkout loads still do.)
  //
  // Heuristic, and deliberately so: a worker restart mid-load resets it,
  // and two tabs loading at once share it. Both degrade to the `false`
  // default, which is the pre-existing per-asset race — never to something
  // that fails.
  let shellFromCacheThisLoad = false;

  // ── Which build the document being parsed belongs to ─────────────────
  //
  // The flag above is the answer to "was the connection bad?", and it was
  // being used as a proxy for "are the cached assets safe to serve?". Those
  // are not the same question, and using one for the other put the shortcut
  // on the wrong side of the trade: the document only loses its race on a
  // link slower than 200ms, so the shortcut fired only when the network was
  // BAD, and the ~34 shell assets each paid a 200ms deadline whenever it was
  // GOOD. Measured warm on a 150ms link, every asset was answered from cache
  // — after 459ms of waiting to find that out. 483ms for the set, on a load
  // where nothing had been deployed.
  //
  // The real question is build identity, and the server now answers it
  // directly: X-Platform-Build on the document and on every shell asset (see
  // src/services/static-cache.js). A cached asset stamped with the same build
  // as the document being parsed is not stale by any definition — the network
  // would answer 304 — so it is served on this tick and revalidated behind.
  // A DIFFERENT stamp means a deploy landed, and that asset races exactly as
  // it did before, which is what keeps a redeploy reaching a WebView on the
  // next load.
  //
  // Null in three cases, all of which fall back to the race rather than to
  // something that can be wrong: a checkout (no GIT_SHA, so no header — an
  // edit to public/js/app.js must still show up), a worker restarted
  // mid-load, and a document served before this shipped.
  let documentBuildThisLoad = null;

  // Stamp a response copy with the cached-at time so activate() can prune
  // stale entries. Only used for the API cache. Takes an already-cloned
  // response (cloning must happen synchronously, before the page starts
  // consuming the original body).
  //
  // Returns true when the stored bytes DIFFER from the entry they replaced,
  // but only when asked (`detectChange`) — the comparison costs an extra
  // cache read and a full-body compare, and the only caller that needs the
  // answer is the stale-serve path, where the entry being replaced is the
  // very copy the page is currently rendering.
  async function stampAndPut(cache, request, response, { detectChange = false, stillCurrent = () => true } = {}) {
    try {
      const headers = new Headers(response.headers);
      headers.set(CACHED_AT_HEADER, String(Date.now()));
      // Download outside the storage queue: a stalled old body must not
      // delay logout's wipe or a new session's reads.
      const body = await response.arrayBuffer();
      return await queueApiCacheWork(async () => {
        if (!stillCurrent()) return false;
        let changed = false;
        if (detectChange) {
          // Both fallbacks below resolve to "unchanged", i.e. stay quiet:
          //   - no previous entry (evicted between the serve and now) means
          //     there is nothing on screen this could be correcting;
          //   - an unreadable previous body leaves us genuinely unable to
          //     tell, and a re-render we cannot justify is worse than a
          //     stale row the next navigation will fix anyway.
          try {
            const prev = await cache.match(request);
            changed = !!prev && !bytesEqual(await prev.arrayBuffer(), body);
          } catch { changed = false; }
        }
        if (!stillCurrent()) return false;
        await cache.put(request, new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        }));
        if (!stillCurrent()) { await cache.delete(request); return false; }
        return changed;
      });
    } catch { /* quota or clone failure — offline copy just isn't saved */ }
    return false;
  }

  // Tell every open tab that a cached answer we already served is now out
  // of date. The worker gets exactly ONE response per request, so without
  // this the corrected copy would sit in the cache until the next reload
  // and "instant" would mean "instant and wrong".
  //
  // Broadcast rather than event.clientId: a second tab on this origin was
  // served the same stale entry from the same cache and is just as wrong.
  // The noise that buys is bounded on the page side — App.refreshActiveScreen
  // bails on a hidden tab or an open sheet.
  async function notifyClients(message) {
    try {
      const windows = await self.clients.matchAll({ type: 'window' });
      for (const client of windows) client.postMessage(message);
    } catch { /* best-effort — a missed correction is just a stale screen */ }
  }

  // Oldest-first eviction keeps the API cache bounded. Cache keys iterate
  // in insertion order, so dropping from the front approximates LRU-by-write.
  // Immune entries (the session) are excluded from BOTH the budget and the
  // eviction list, so they can neither be dropped nor push a real entry out.
  async function trimApiCache(cache) {
    try {
      const keys = await cache.keys();
      const evictable = keys.filter((k) => !isImmuneApiRequest(k.url, ORIGIN));
      // Same 300-entry budget, but ORDINARY ENTRIES GO FIRST. A boot read is
      // the last known state of a screen — the launcher grid, an app's board
      // — and losing one silently drops that screen out of the fast lane
      // above and back onto the network, which is the exact regression the
      // lane exists to prevent, arriving as "it used to be instant" with
      // nothing on screen to explain it. Reading one busy chat is enough to
      // do it: /api/apps/:slug/messages?before=… mints a NEW key per page,
      // so a long scroll-back walks the whole budget, and insertion order
      // alone would evict the board the user is scrolling back inside of.
      //
      // Insertion order still decides within each class, so this only ever
      // changes WHICH entry goes when the cache is full, never how many.
      const queue = evictable.filter((k) => !isBootReadRequest(k.url, ORIGIN))
        .concat(evictable.filter((k) => isBootReadRequest(k.url, ORIGIN)));
      for (let i = 0; i < queue.length - API_CACHE_MAX_ENTRIES; i++) {
        await cache.delete(queue[i]);
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

  // Cache Storage has no compare-and-swap. Without one queue, two navigation
  // responses can both inspect the same old entry and then commit in reverse
  // order, defeating shouldReplaceShellDocument's ordering check. A rejected
  // write is swallowed only by the stored tail so one quota failure cannot
  // poison every later navigation; each caller still receives its real result.
  let shellDocumentWrite = Promise.resolve();

  function queueShellDocumentWrite(cache, response) {
    const result = shellDocumentWrite.then(
      () => putShellDocumentIfNewer(cache, response),
      () => putShellDocumentIfNewer(cache, response)
    );
    shellDocumentWrite = result.catch(() => false);
    return result;
  }

  async function networkFirstShell(event) {
    if (releaseCache) {
      const response = await releaseCache.respond(event);
      if (response) return response;
    }
    const cache = await caches.open(SHELL_CACHE);
    const fetchAndCache = () => fetch(event.request).then((res) => {
      // Clone synchronously, before the page can start reading the body.
      if (res && res.ok) cache.put(event.request, res.clone()).catch(() => {});
      return res;
    });

    // A build-scoped URL: the sha in the path says which build these bytes
    // are, so a cached copy is current by construction and there is nothing
    // to race for — see parseBuildScopedPath. Cache-first, then the network.
    // The network answer is stored only when the server confirms it IS that
    // build (X-Platform-Build matches the sha asked for): during a rollout a
    // request for the new build can land on the old colour, which answers
    // with its own bytes under the revalidate policy, and caching those under
    // the new build's URL would pin the wrong script there for a year.
    const scoped = parseBuildScopedPath(new URL(event.request.url).pathname);
    if (scoped) {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res && res.ok && buildIdOf(res) === scoped.build) {
        cache.put(event.request, res.clone()).catch(() => {});
      }
      return res;
    }

    // This load's navigation already lost its race, so the connection is
    // known-slow AND the document being parsed is the cached one. Serve the
    // cached asset outright rather than making all 38 of them re-discover
    // the same fact one 200ms deadline at a time — that serial rediscovery
    // is most of the reported slowness, and mixing a cached document with
    // freshly-fetched scripts is the split-build hazard the flag exists to
    // avoid. The network copy still lands in the cache for the next load.
    //
    // This branch KEEPS its revalidation, unlike the build check below,
    // and the difference is not an oversight: it asks no question about
    // the entry it serves, so it will hand back an asset from a build the
    // server has already moved past. That fetch is the only thing that
    // repairs one. It also only fires on a connection slow enough to lose
    // the document its own 200ms race, so it is not on the path a normal
    // load takes.
    if (shellFromCacheThisLoad) {
      const hit = await cache.match(event.request, { ignoreSearch: true });
      if (hit) {
        event.waitUntil(fetchAndCache().catch(() => {}));
        return hit;
      }
      // A miss here is a genuinely new asset (a deploy added one). Fall
      // through: there is nothing cached to prefer.
    }

    // Same build as the document being parsed: the cached copy IS the
    // current copy, so there is nothing to race for. See
    // documentBuildThisLoad for why this is a different question from the
    // flag above, and why it is the one worth asking.
    //
    // AND NOTHING GOES OUT BEHIND IT. This used to revalidate in a
    // waitUntil, described as repairing "a cache entry the server has
    // since changed under the same build id" — which is a state a deploy
    // cannot produce, because a deploy is what changes the build id. So
    // the revalidation only ever ran on the branch where the ids already
    // agree, i.e. where there is by construction nothing new to fetch,
    // and it ran for EVERY shell asset on EVERY load: ~34 requests, each
    // re-read and re-stored, competing with the boot for the connection
    // pool and for main-thread time on the response.
    //
    // It was not free, and the page was paying for it. Warm board,
    // 390x844, 4x CPU throttle, 150ms link, two interleaved runs of nine
    // samples per arm, timing the first board card onto the screen:
    // median 1621ms -> 1455ms, mean -173ms.
    // The main thread is ~85% blocked across that window, which the
    // longtask API reports none of — the work is chopped finer than its
    // 50ms floor, and measuring it needs a timer sampler instead. With
    // these requests gone a fully offline load is no faster than an
    // online one, so nothing is left waiting on the network at all.
    //
    // Redeploy still reaches a warm client on its second load, unchanged:
    // the new document carries a new build id, every cached asset then
    // mismatches HERE, and they all fall through to the race below and
    // re-cache. Verified against a simulated deploy (build id changed,
    // asset bytes changed) on a 150ms and a 400ms link, with the document
    // served from the network and from cache.
    if (documentBuildThisLoad) {
      const hit = await cache.match(event.request, { ignoreSearch: true });
      if (hit && buildIdOf(hit) === documentBuildThisLoad) return hit;
      // Either nothing cached, or cached from a DIFFERENT build. Both mean
      // the network has something to say; fall through and let it race.
    }

    const { response, pending } = await raceNetworkAndCache({
      startFetch: fetchAndCache,
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
    if (releaseCache) return releaseCache.navigate(event);
    const cache = await caches.open(SHELL_CACHE);

    // The cached document MUST be refreshed from here. install() precaches
    // /index.html once per worker, so without this the cached shell is frozen
    // at whatever shipped the last time sw.js itself changed bytes — and every
    // load that misses the 200ms deadline (i.e. most of them: the deadline is
    // deliberately BELOW a round trip) serves it.
    //
    // That is not a hypothetical. #1400 moved the page ground from
    // `bg-white` to `bg-zinc-100` in the <body> class and, correctly, did
    // not touch this file — so install() never re-ran, and every ordinary
    // load kept rendering the pre-reskin document with the white ground
    // while a hard refresh, which bypasses the worker entirely, showed the
    // new grey one. It could not self-heal, because the deploy that would
    // have fixed it is exactly the thing not being stored.
    //
    // Written under the FIXED '/index.html' key, not event.request: that is
    // the key matchCache reads for every route, and storing per-URL would
    // leave the one key that is actually read still stale. Guarded by
    // isShellDocumentUrl for the reason given there — 'navigate' also covers
    // redirect stubs, and caching one of those AS the shell would be far worse
    // than the staleness this fixes.
    //
    // Two details here are load-bearing:
    //   1. queueShellDocumentWrite compares the build-time stamps and refuses
    //      an older rollout answer after a newer document has been cached.
    //   2. cacheWrite is joined to event.waitUntil below. The old fire-and-
    //      forget cache.put let a fast network document render correctly but
    //      allowed the worker to die before the write finished; a later slow
    //      load then appeared to "revert" to the old cached UI.
    let cacheWrite = Promise.resolve(false);
    const fetchAndCache = () => fetch(event.request).then((res) => {
      // Clone synchronously, before the page can start reading the body.
      if (res && res.ok && !res.redirected
          && isShellDocumentUrl(event.request.url, ORIGIN)) {
        cacheWrite = queueShellDocumentWrite(cache, res.clone());
      }
      return res;
    });

    // Any SPA path serves index.html online (the server's catch-all), so
    // the cached shell is the correct fallback for every route —
    // including the old standalone auth pages, which are redirect stubs
    // into the SPA's hash routes now (fold-auth-pages-into-SPA).
    const { response, fromCache, pending } = await raceNetworkAndCache({
      startFetch: fetchAndCache,
      matchCache: () => cache.match('/index.html'),
      timeoutMs: NAVIGATE_TIMEOUT_MS,
      schedule: swSchedule,
    });
    // Publish the verdict for the ~38 shell assets this document is about
    // to request. See shellFromCacheThisLoad.
    shellFromCacheThisLoad = fromCache;
    // And WHICH BUILD they should be measured against. Read off the
    // response actually served, so a cached document publishes the build it
    // was cached at rather than the one the network is still fetching —
    // those assets have to match the document being parsed, not the one
    // that will be parsed next time. See documentBuildThisLoad.
    documentBuildThisLoad = buildIdOf(response);
    // If cache won the deadline, `pending` reaches cacheWrite only after the
    // network response creates it. If network won, cacheWrite already names
    // the queued put. Either way the document write is part of this event's
    // lifetime without delaying the response being rendered.
    const durableWrite = pending ? pending.then(() => cacheWrite) : cacheWrite;
    event.waitUntil(durableWrite.catch(() => {}));
    return response;
  }

  // URLs we have just told the page were wrong. The VERY NEXT request for
  // one is the page re-pulling on that message (App._onApiUpdated →
  // refreshActiveScreen → the screen's own loader), so answering it from the
  // cache we are in the middle of correcting closes a loop: serve stale →
  // notify → re-pull → serve stale → notify, forever, at about 600ms a lap.
  //
  // That loop is not hypothetical and it is not a demo-mode artefact — it is
  // what ANY endpoint whose body varies per request does the moment its
  // deadline reaches zero. Staging's `?demo=1` fixtures re-derive their
  // timestamps on every call, which is exactly that; so would a signed asset
  // URL, a server-stamped `now`, or a genuinely busy board. Under the 1s
  // deadline the network simply won every lap and the loop never armed.
  //
  // The rule this expresses: the fast lane answers a BOOT, not a REFRESH. A
  // refresh means "give me the current state", so it gets the network and the
  // ordinary deadline. Consumed on read, so it costs exactly one lane-skipped
  // request per correction and nothing after — a second tab booting later
  // pays for one request, not for the lane.
  const correcting = new Set();
  // Set by the page's `refresh-intent` message; see bootLaneApplies.
  let refreshIntentUntil = 0;
  // A URL corrected and then never requested again would sit here forever.
  // The live set is one entry per boot read per app visited; this only ever
  // trips on a pathological session, and dropping it wholesale is harmless —
  // the worst an empty set costs is one extra correction lap.
  const CORRECTING_MAX = 200;
  // The same loop on the ORDINARY deadline. The lane guard above covers only
  // a lane serve, but an endpoint that is BOTH slow and never the same twice
  // loops there too: the Workshop's /promoted list carries every running
  // check's live progress (ran, passed, updatedAt), so under load it lost the
  // 1s race and differed on every lap, and each correction re-pulled the
  // whole board — about nine requests a second per visible tab, until Chrome
  // refused new requests (net::ERR_INSUFFICIENT_RESOURCES). A re-pull after
  // such a correction is asking for the current state, so it WAITS for the
  // network (up to CORRECTION_WAIT_MS) instead of racing the cache it was
  // just told is wrong. Consumed on read like `correcting`; a boot in another
  // tab keeps its zero-deadline lane and its own correction.
  const awaitingNetwork = new Set();
  const CORRECTION_WAIT_MS = 10000;

  // ── One network request for identical reads in flight ─────────────────
  //
  // A screen is assembled from components that each load what they draw, and
  // several ask for the same read in the same moment: measured across the
  // shell, the Notifications screen fetched its list twice, Create read the
  // app allowance three times, a change's page its own row and status twice,
  // a request's page its issue and comments twice. Each duplicate is a round
  // trip on a phone, and on a six-connection HTTP/1.1 link it queues behind
  // the others.
  //
  // So an API GET for a URL that went to the network within the last
  // API_SHARE_WINDOW_MS waits for that request instead of starting another.
  // Every asker still gets its own Response (a clone; the shared original is
  // never read), and nothing is kept once the request settles.
  //
  // Only reads asked for in the same moment share. A request can be seconds
  // in flight on a slow link, and a read that joined it late could get an
  // answer the server gave before something the page has since done: vote,
  // then reload the list the vote changed. So a request stops taking joiners
  // after the window, and any write the page sends (the fetch handler below)
  // ends sharing for every request already in flight. A read asked for after
  // either is a new request, exactly as before.
  const API_SHARE_WINDOW_MS = 100;
  const inflightApi = new Map();
  const apiReadStates = new Map();
  let apiReadSerial = 0;
  let apiEpoch = 0;
  let activeApiScope = null;
  const retiredApiScopes = new Set();
  let apiCacheWork = Promise.resolve();

  // Serialize storage puts and wipes, with identity checks after body reads.
  // An old response cannot put its contents back after the wipe completes.
  function queueApiCacheWork(work) {
    const run = apiCacheWork.then(work, work);
    apiCacheWork = run.catch(() => {});
    return run;
  }

  function apiReadState(key) {
    if (!apiReadStates.has(key.url)) {
      // Dropped state objects fence their outstanding reads and writes.
      if (apiReadStates.size > API_CACHE_MAX_ENTRIES * 4) apiReadStates.clear();
      apiReadStates.set(key.url, { latestRead: 0, invalidation: 0 });
    }
    return apiReadStates.get(key.url);
  }

  function invalidateApiEntry(key) {
    // A refusal is authoritative even when a newer request has started or
    // failed. Fence every already-started read/put before awaiting storage;
    // only a request begun after this decision may refill the entry.
    apiReadState(key).invalidation++;
    inflightApi.clear();
    return queueApiCacheWork(async () => {
      const cache = await caches.open(API_CACHE);
      // A URL's permission applies to every Vary representation, including
      // one cached under a different Accept/header combination.
      await cache.delete(key, { ignoreVary: true });
    });
  }

  function apiContext(request) {
    const scope = apiScopeOf(request);
    if (!scope || retiredApiScopes.has(scope)) return null;
    if (activeApiScope && activeApiScope !== scope) {
      retiredApiScopes.add(activeApiScope);
      void clearApiCaches().catch(() => {});
    }
    activeApiScope = scope;
    return { scope, epoch: apiEpoch };
  }

  function currentApiContext(context) {
    return context && context.epoch === apiEpoch && context.scope === activeApiScope
      && !retiredApiScopes.has(context.scope);
  }

  function staleApiResponse() {
    return new Response('{"error":"Session changed"}', {
      status: 409, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  function sharedApiFetch(request) {
    // URL alone can join two users' reads, or a fresh/authorized read to
    // a different set of headers. A credential-bearing read never shares.
    const key = JSON.stringify([request.url, request.credentials, request.cache, [...request.headers]]);
    const now = Date.now();
    const open = inflightApi.get(key);
    if (open && now - open.startedAt <= API_SHARE_WINDOW_MS) {
      return open.pending.then((res) => res.clone());
    }
    const entry = { pending: fetch(request), startedAt: now };
    inflightApi.set(key, entry);
    const settle = () => { if (inflightApi.get(key) === entry) inflightApi.delete(key); };
    entry.pending.then(settle, settle);
    return entry.pending.then((res) => res.clone());
  }

  async function networkFirstApi(event) {
    const context = apiContext(event.request);
    if (!context) return fetch(new Request(event.request, { cache: 'no-store' }));
    await apiCacheWork;
    if (!currentApiContext(context)) return staleApiResponse();
    const cache = await caches.open(API_CACHE);
    const key = apiCacheKey(event.request, context.scope);
    const state = apiReadState(key);
    const invalidation = state.invalidation;
    const serial = ++apiReadSerial;
    state.latestRead = serial;
    // Starting another read cannot revoke a valid offline fallback. Only
    // identity changes and actual refusal/storage decisions can do that.
    const canReplay = () => currentApiContext(context) && apiReadStates.get(key.url) === state
      && state.invalidation === invalidation;
    // Keep write ordering separate: an older success must not overwrite a
    // newer response or undo a known refusal, even while its body downloads.
    const stillCurrent = () => canReplay() && state.latestRead === serial;
    // Did we answer this request from cache while the network was still in
    // flight? Only then is a late, DIFFERENT answer worth telling the page
    // about — on an ordinary fresh load the page already HAS that answer,
    // and posting anyway would re-render every screen on every load.
    //
    // Set inside matchCache rather than from the returned `fromCache`: the
    // cache read completes before raceNetworkAndCache resolves, so the flag
    // is already true by the time the late network response can run the
    // handler below. Reading it afterwards would leave a window in which a
    // just-missed response found it still false.
    const served = { fromCache: false };

    // #4177: a read that asks for the current answer (every page read, see
    // FRESH_API_TIMEOUT_MS) gets the long deadline, so the saved copy answers
    // it only on a link that is not answering. It consumes the correction
    // marks like any read: a re-pull after a correction is such a read, and
    // it is the request those marks exist to slow down.
    const fresh = wantsFreshAnswer(event.request.cache);
    // Consume the correction mark, if any: this request pays the ordinary
    // deadline once and the next one is back in the lane.
    const settling = awaitingNetwork.delete(event.request.url);
    const laned = !correcting.delete(event.request.url) && !settling
      && bootLaneApplies(event.request.url, ORIGIN, Date.now(), refreshIntentUntil);
    const timeoutMs = settling ? CORRECTION_WAIT_MS
      : fresh ? (laned ? FRESH_BOOT_API_TIMEOUT_MS : FRESH_API_TIMEOUT_MS)
        : laned ? BOOT_API_TIMEOUT_MS : API_TIMEOUT_MS;

    const { response, fromCache, pending } = await raceNetworkAndCache({
      startFetch: () => sharedApiFetch(event.request).then((res) => {
        // Only genuine successes are worth replaying offline; 401/403/500
        // must never mask a later real answer. Clone before returning —
        // once the page starts reading the body the response is locked.
        if (res && res.status === 200 && !res.redirected && !disallowsStorage(res)
            && /\bapplication\/json\b/i.test(responseHeader(res, 'Content-Type') || '')
            && responseHeader(res, API_SCOPE_HEADER) === context.scope) {
          const copy = res.clone();
          event.waitUntil(stampAndPut(cache, key, copy,
            { detectChange: served.fromCache, stillCurrent }).then(changed => queueApiCacheWork(async () => {
            if (!stillCurrent()) return;
            await trimApiCache(cache);
            if (served.fromCache && changed) {
              // Only a LANE serve arms the guard. A stale answer on the
              // ordinary deadline (1s, or FRESH_API_TIMEOUT_MS for a fresh
              // read) means the network was slow, not that this URL is in a
              // correction loop, and it re-races honestly next time.
              if (laned) {
                if (correcting.size >= CORRECTING_MAX) correcting.clear();
                correcting.add(event.request.url);
              } else {
                if (awaitingNetwork.size >= CORRECTING_MAX) awaitingNetwork.clear();
                awaitingNetwork.add(event.request.url);
              }
              await notifyClients({ type: 'api-updated', url: event.request.url, scope: context.scope });
            }
          })));
        } else if (currentApiContext(context)) {
          // A known refusal, changed policy or 304 always retires the old
          // body, regardless of overlapping requests or their start order.
          // When this request was ANSWERED with that body (its deadline
          // passed first), retiring the entry is not enough: the screen is
          // showing it. Once the entry is gone, tell the page, the same
          // message a changed answer gets, so its re-read meets the
          // network's answer instead of the copy (declinedAnswerRetiresCopy).
          event.waitUntil(invalidateApiEntry(key).then(() => {
            if (!served.fromCache || !declinedAnswerRetiresCopy(res)) return undefined;
            return notifyClients({ type: 'api-updated', url: event.request.url, scope: context.scope });
          }));
        }
        return res;
      }),
      matchCache: async () => {
        await apiCacheWork;
        if (!canReplay()) return undefined;
        const hit = await cache.match(key);
        if (!canReplay()) return undefined;
        if (!apiEntryCanReplay(hit, context.scope)) {
          if (hit) await queueApiCacheWork(() => cache.delete(key));
          return undefined;
        }
        if (hit) served.fromCache = true;
        return hit;
      },
      timeoutMs,
      schedule: swSchedule,
    });
    if (pending) event.waitUntil(pending.catch(() => {}));
    return currentApiContext(context) && (!fromCache || canReplay()) ? response : staleApiResponse();
  }

  async function cacheFirstImmutable(event) {
    const cache = await caches.open(IMMUTABLE_CACHE);
    const hit = await cache.match(event.request);
    if (hit && !disallowsStorage(hit)
        && !/\bprivate\b/i.test(responseHeader(hit, 'Cache-Control') || '')) return hit;
    if (hit) await cache.delete(event.request);
    const res = await fetch(event.request);
    if (res && res.ok && !disallowsStorage(res)
        && !/\bprivate\b/i.test(responseHeader(res, 'Cache-Control') || '')) {
      event.waitUntil(cache.put(event.request, res.clone()).catch(() => {}));
    }
    return res;
  }

  // Fill the shell cache with ONE build: fetch the document first, then every
  // other SHELL_ASSETS entry at the URL that document loads it from — scoped
  // under the document's build id when it has one (X-Platform-Build on the
  // response; the document's own <meta> is written from the same GIT_SHA),
  // the plain path when it does not. Returns one settled result per asset,
  // so install() can stay best-effort while the deploy prefetch demands all
  // of them.
  //
  // `reload` bypasses the HTTP cache on every request. The deploy prefetch
  // needs that for the plain paths, where a revalidated 304 would report
  // success having stored nothing new; a scoped URL is new to the browser
  // whenever the build is, so there it costs nothing.
  //
  // A targeted deploy prefetch also supplies `expectedBuild` and asks for
  // `documentLast`. That validates the document before touching the cache and
  // promotes /index.html only AFTER every asset it names was stored. A failed
  // or rollout-crossed prefetch therefore leaves the previous complete shell
  // active instead of advertising a partially downloaded new one.
  //
  // The rollout-crossed case is named (`code: 'build-mismatch'`), because it
  // is the one failure that is not a failure of the update: the request landed
  // on the build being retired in the seconds a rollout has both serving. The
  // page asks again on its next cue instead of giving up on the build — see
  // _ensureShellPrefetch in public/js/app.js.
  function buildMismatch(message) {
    const err = new Error(message);
    err.code = 'build-mismatch';
    return err;
  }

  async function precacheShell(cache, {
    reload = false, expectedBuild = null, documentLast = false,
  } = {}) {
    const init = reload ? { cache: 'reload' } : undefined;
    const [documentPath, ...assets] = SHELL_ASSETS;
    let build = null;
    let document = null;
    let documentResult = null;
    try {
      const doc = await fetch(documentPath, init);
      if (!doc || !doc.ok) throw new Error(`HTTP ${doc && doc.status}`);
      build = buildIdOf(doc);
      if (expectedBuild && build !== expectedBuild) {
        throw buildMismatch(`expected build ${expectedBuild}, served ${build || 'unstamped'}`);
      }
      document = doc.clone();
      // '/index.html' is stored under exactly the key networkFirstNavigate
      // reads, so the document itself is refreshed here and not only the
      // assets around it. Install stays best-effort and writes it now;
      // targeted prefetches promote it only after all asset writes below.
      if (!documentLast) {
        await cache.put(documentPath, document);
        documentResult = { status: 'fulfilled', value: documentPath };
      }
    } catch (err) {
      documentResult = { status: 'rejected', reason: err };
    }
    // A targeted request whose document was served by the wrong rollout pod
    // must not fall back to fetching and caching the unscoped asset set.
    if (expectedBuild && documentResult && documentResult.status === 'rejected') {
      return SHELL_ASSETS.map(() => documentResult);
    }
    const assetResults = await Promise.allSettled(assets.map(async (path) => {
      const url = shellAssetUrl(path, build);
      const res = await fetch(url, init);
      if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
      // A scoped URL is stored only as the build it names — the rule
      // networkFirstShell applies, for the same rollout reason.
      if (url !== path && buildIdOf(res) !== build) throw buildMismatch('served by a different build');
      await cache.put(url, res.clone());
      return url;
    }));
    if (documentLast && document) {
      if (assetResults.every((result) => result.status === 'fulfilled')) {
        try {
          const stored = await queueShellDocumentWrite(cache, document);
          if (!stored) throw new Error('a newer shell document is already cached');
          documentResult = { status: 'fulfilled', value: documentPath };
        } catch (err) {
          documentResult = { status: 'rejected', reason: err };
        }
      } else {
        documentResult = {
          status: 'rejected',
          reason: new Error('shell assets incomplete; document not promoted'),
        };
      }
    }
    const results = [documentResult, ...assetResults];
    if (build && documentResult && documentResult.status === 'fulfilled') {
      await pruneOtherBuilds(cache, build);
    }
    return results;
  }

  // Scoped entries of any OTHER build are dead weight once a build is in:
  // nothing asks for them again (a document always asks for its own), and
  // each deploy would otherwise leave the previous build's ~4MB behind.
  async function pruneOtherBuilds(cache, keep) {
    try {
      const keys = await cache.keys();
      await Promise.all(keys.map(async (req) => {
        const scoped = parseBuildScopedPath(new URL(req.url).pathname);
        if (scoped && scoped.build !== keep) await cache.delete(req);
      }));
    } catch { /* best-effort housekeeping */ }
  }

  self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
      if (releaseCache) {
        await releaseCache.install();
        await self.skipWaiting();
        return;
      }
      const shell = await caches.open(SHELL_CACHE);
      // Per-asset, best-effort: one 404 must not brick the whole install.
      // Every asset the shell needs is same-origin now, so a completed
      // install is enough to render offline — there is no second,
      // cross-origin precache pass that can partially fail any more.
      await precacheShell(shell);
      await self.skipWaiting();
    })());
  });

  // Stable cache name, upgraded storage contract. Unscoped legacy bodies
  // have no trustworthy owner and cannot be relabeled as today's viewer.
  // Preserve only entries already stamped and partitioned by this policy.
  async function migrateLegacyApiCaches(names) {
    await Promise.all(names.filter(n => LEGACY_API_CACHE_RE.test(n)).map(n => caches.delete(n)));
    const target = await caches.open(API_CACHE);
    for (const key of await target.keys()) {
      const scope = new URL(key.url).searchParams.get(API_SCOPE_PARAM);
      if (!/^[a-f0-9]{64}$/.test(scope || '') || !apiEntryCanReplay(await target.match(key), scope)) {
        await target.delete(key);
      }
    }
  }

  // Logout must not leave one user's API responses readable by the next.
  // Legacy names are included: they may still hold a pre-migration copy.
  function clearApiCaches() {
    apiEpoch++;
    inflightApi.clear();
    apiReadStates.clear();
    correcting.clear();
    awaitingNetwork.clear();
    return queueApiCacheWork(async () => {
      const names = await caches.keys();
      await Promise.all(names
        .filter((n) => n === API_CACHE || LEGACY_API_CACHE_RE.test(n))
        .map((n) => caches.delete(n)));
    });
  }

  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await migrateLegacyApiCaches(names);
      if (releaseCache) {
        await releaseCache.activate();
        await pruneStaleApiEntries();
        await self.clients.claim();
        return;
      }
      // Drop caches from older SW versions.
      await Promise.all(names
        .filter((n) => n.startsWith('usernode-') && !ALL_CACHES.includes(n))
        .map((n) => caches.delete(n)));
      await pruneStaleApiEntries();
      await self.clients.claim();
    })());
  });

  // ── Pulling the NEXT build down before it is asked for ───────────────
  //
  // The shell is precached in install(), which re-runs only when THIS FILE's
  // bytes change. A platform deploy rebuilds /shell/assets/shell.js (an
  // unhashed path) and index.html without touching sw.js, so nothing ever
  // refreshed the precache on a deploy — the cache kept the build it was
  // filled with until some later load happened to win a 200ms race per asset.
  //
  // That is what made the drawer's "reload" button a lie. It is
  // `location.reload()`, which is an ordinary navigation, so it goes through
  // networkFirstNavigate and races the cached document on a deadline the
  // header of this file calls DELIBERATELY SHORTER THAN A ROUND TRIP. Lose
  // that race — which is the common case, by design — and the reload serves
  // the OLD document, sets shellFromCacheThisLoad, and therefore serves all
  // ~38 old assets too, while the new build lands in the cache for next time.
  // You clicked reload and downloaded the update instead of switching to it.
  //
  // The page now asks for the new build the moment its /api/version poll sees
  // a new SHA (App._ensureShellPrefetch), and only offers the reload once this
  // answers. Then it does not matter who wins the race: network and cache both
  // hold the new build, and shellFromCacheThisLoad keeps the assets consistent
  // with whichever document was served.
  //
  // A prefetch must never store an old build's bytes as the new one's. The
  // generated release worker (sw-release.js, the path every hosted image
  // takes) asks the HTTP cache first and is still safe: every asset it
  // downloads is hashed against the new release's manifest, js and css live
  // under the new build's /b/<sha>/ URL, and a copy that does not match is
  // fetched again with `cache: 'reload'` before anything is stored. Its
  // release.json is always fetched with 'reload'. The precacheShell fallback
  // below (no generated release, so no hashes to check against) keeps
  // `cache: 'reload'` on every request, because there the HTTP cache is the
  // other copy of the old build
  // and a prefetch that revalidated its way to a 304 would report success
  // having stored nothing new.
  const shellPrefetches = new Map();

  // Resolves `{ ok, mismatch }`: `ok` when the whole build is in the cache,
  // `mismatch` when it is not because a response came from a different build
  // — the rollout-crossed case precacheShell names, which the page retries
  // rather than settles.
  async function prefetchShellAssets(expectedBuild) {
    if (releaseCache) return releaseCache.prefetch(expectedBuild);
    if (!/^[0-9a-f]{7,40}$/.test(String(expectedBuild || ''))) {
      return { ok: false, mismatch: false };
    }
    const cache = await caches.open(SHELL_CACHE);
    // The new document first, then its assets at the URLs IT loads them
    // from: a new build's scripts live under a new /b/<sha>/ prefix, so
    // fetching the plain paths here would refresh nothing the next load asks
    // for. See precacheShell.
    const results = await precacheShell(cache, {
      reload: true,
      expectedBuild,
      documentLast: true,
    });
    // ALL of them, deliberately. A partial refresh is the split-build state
    // shellFromCacheThisLoad exists to prevent, and reporting success for one
    // would put the page's reload button on top of it.
    return {
      ok: results.every((r) => r.status === 'fulfilled'),
      mismatch: results.some((r) => r.status === 'rejected'
        && r.reason && r.reason.code === 'build-mismatch'),
    };
  }

  self.addEventListener('message', (event) => {
    const type = event.data && event.data.type;
    if (type === 'shell-client-build' && releaseCache && event.source?.id) {
      event.waitUntil(releaseCache.noteClient(event.source.id, event.data.build)
        .then(() => releaseCache.cleanup()).catch(() => {}));
    }
    if (type === 'clear-api-cache') {
      event.waitUntil((async () => {
        await clearApiCaches();
        const port = event.ports && event.ports[0];
        if (port) port.postMessage({ done: true });
      })());
    }
    // A pull-to-refresh, or the drawer's reload button, announcing itself
    // before the screen's loader runs. Deliberately fire-and-forget: a
    // refresh must never wait on the worker, and a message that arrives
    // late only costs one lane-served request.
    if (type === 'refresh-intent') {
      refreshIntentUntil = Date.now() + REFRESH_INTENT_WINDOW_MS;
    }
    if (type === 'prefetch-shell') {
      event.waitUntil((async () => {
        const expectedBuild = String(event.data && event.data.sha || '').trim().toLowerCase();
        // Every open tab polls /api/version on its own 10s timer. Calls for
        // the SAME build share one download; a second deploy is a different
        // key and can never receive the first build's success reply.
        if (!shellPrefetches.has(expectedBuild)) {
          const run = prefetchShellAssets(expectedBuild)
            .finally(() => {
              if (shellPrefetches.get(expectedBuild) === run) {
                shellPrefetches.delete(expectedBuild);
              }
            });
          shellPrefetches.set(expectedBuild, run);
        }
        let ok = false;
        let mismatch = false;
        try {
          ({ ok, mismatch } = await shellPrefetches.get(expectedBuild));
        } catch { ok = false; mismatch = false; }
        const port = event.ports && event.ports[0];
        if (port) port.postMessage({ ok, sha: expectedBuild || null, mismatch });
      })());
    }
  });

  self.addEventListener('fetch', (event) => {
    const req = event.request;

    // A write ends sharing: no read asked for after it may join one that
    // could have been answered before it (sharedApiFetch). A logout is one.
    if (req.method !== 'GET' && req.method !== 'HEAD') inflightApi.clear();

    // Auth writes also fence in-flight reads, even before their response.
    // A refused mutation may retain the same session; retire its label only
    // when an actual different session is observed in apiContext().
    const url = new URL(req.url);
    if (url.origin === ORIGIN && req.method !== 'GET' && req.method !== 'HEAD'
        && url.pathname.startsWith('/api/auth/')) {
      event.waitUntil(clearApiCaches());
      return;
    }

    // Explicit session confirmation must reach the server, even if an
    // earlier user has an offline /me response in the API cache.
    if (req.cache === 'no-store') {
      // Keep the hard network bypass, but invalidate an earlier offline
      // representation and any older pending put of this same read.
      const scope = apiScopeOf(req);
      if (scope && url.origin === ORIGIN && url.pathname.startsWith('/api/')) {
        const key = apiCacheKey(req, scope);
        event.waitUntil(invalidateApiEntry(key));
      }
      return;
    }
    if (url.origin === ORIGIN && req.method === 'GET' && url.pathname === '/api/auth/me') {
      event.respondWith(fetch(new Request(req, { cache: 'no-store' })));
      return;
    }
    // Bearer/JWT and Range responses are not browser-session snapshots.
    if (req.headers.get('authorization') || req.headers.get('x-usernode-token')
        || req.headers.get('range') || url.searchParams.has('token')) return;

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
