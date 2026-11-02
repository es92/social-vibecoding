'use strict';

// Before/after visuals on UI-affecting proposals (issue #195).
//
// Runs AFTER a staging preview comes up healthy: decides whether the
// commit range plausibly affects the UI (changed-file heuristic), spawns
// the one-shot headless-Chromium capture container (capture/) to shoot
// the production app ("before") and the staging container ("after") over
// the internal docker network, uploads the artifacts and stores their keys
// in Postgres (session_visuals, latest set per session only), patches the GitHub PR
// body's marker-delimited "Before / after" block when a PR exists, and
// emits a `visuals_ready` event so open dev-chat cards upgrade in place.
//
// Capture is an automatic platform pipeline step, not an agent
// responsibility — the worker image has no browser and the coding turn is
// already over by the time staging exists. It is fire-and-forget and
// strictly best-effort: captureForSession never throws, never delays
// staging_ready, and never changes the outcome of a dev turn (same
// contract as the #183 non-fatal staging build).

const crypto = require('crypto');
const mediaStore = require('./media-store');
const visualMedia = require('./check-visual-media');
const path = require('path');
const log = require('./logger');
const checkStore = require('../workflow/rules/check-store.ts');
const platformJwt = require('./platform-jwt');
const docker = require('./docker');
const kubernetes = require('./kubernetes');
const applicationRuntime = require('./application-runtime');
const github = require('./github');
const caddy = require('./caddy');
const prMetadata = require('./pr-metadata');
const sessionBus = require('./session-bus');
const appManifest = require('./app-manifest');
const checkHistory = require('./check-history');
const checkSignals = require('./check-signals');
const unitSuite = require('./unit-suite');
const unitSuiteRow = require('./unit-suite-row');
const contentReview = require('./content-review');
const smallChange = require('./small-change');
const assetRouteCheck = require('./asset-route-check');
const renderHealth = require('./render-health');
const checkRuns = require('./check-runs');
const checksQueue = require('./checks-queue');
const { CAPTURE_MAX_PATHS, normalizeStoredPath, VIEWPORT_MOBILE } = require('./testing-notes');
const { sameSha } = require('./pr-vote-revision');
const { isFrontendFile, isUiAffecting } = require('./visual-file-classifier');
const { getPool } = require('../db/pool');
const repoRef = require('./repo-ref');
const {
  connectionCensus, mentionsConnectionLimit, connectionExhaustionMessage,
} = require('../db/connection-census');

const CAPTURE_IMAGE = 'usernode-capture:latest';

// Match the ingress created by deployApplication. Browser sessions use Secure
// cookies in Paketo's production runtime, including staging previews.
function kubernetesCaptureOrigin(config, app, sessionId = null) {
  const cfg = config.kubernetes;
  if (!cfg?.appDomain) throw new Error('Kubernetes capture requires a configured ingress hostname');
  const hostname = sessionId != null
    ? `${app.slug}--s${sessionId}.${cfg.appDomain}`
    : app.slug === config.selfAppSlug
      ? cfg.platformDomain
      : `${app.slug}.${cfg.appDomain}`;
  if (!hostname || !/^[a-z0-9.-]+$/i.test(hostname)) {
    throw new Error('Kubernetes capture requires a configured ingress hostname');
  }
  return `https://${hostname}`;
}

function captureRuntimeMode() {
  const mode = process.env.CAPTURE_RUNTIME || process.env.APP_RUNTIME || 'docker';
  if (!['docker', 'kubernetes'].includes(mode)) {
    throw new Error(`Unsupported CAPTURE_RUNTIME=${mode}`);
  }
  return mode;
}

// Pixel frame for the phone-sized capture (#768, now automatic) — an
// iPhone-14-class portrait viewport, passed per-target to the capture
// container. EVERY capture path is shot in both the desktop frame
// (full media) and this frame (PNG still only) via expandCapturePaths;
// desktop targets omit the field and get the container's fixed 1280x800
// default. The label→pixels mapping lives here (not in capture/) so the
// container stays a dumb executor of resolved targets; deviceScaleFactor
// stays governed by the app's screenshot_device_scale setting for both
// frames (stills — recordings are always 1x, see capture/capture.js).
const MOBILE_VIEWPORT = { width: 390, height: 844 };

// Dedicated capture identity (seeded by src/db/migrate.js). A non-admin
// service account so the public artifacts (/visuals/:id is unauthenticated;
// PR bodies embed them on GitHub) never show anyone's personal data or
// admin-only UI. The capture run is capped at RUN_TIMEOUT_MS (640s); 15
// minutes covers the lazy image build + retry comfortably.
const CAPTURE_USERNAME = 'usernode-capture';
// Separate view-only-admin identity (is_admin + admin_readonly; seeded by
// src/db/migrate.js) used ONLY to sign the proposal-checks assertion suite,
// so the admin-only check routes (/admin, /dashboard) render under test.
// Never signs a public screenshot — see the testsToken block below.
const CAPTURE_ADMIN_USERNAME = 'usernode-capture-admin';
const CAPTURE_AUTH_TTL_MS = 15 * 60 * 1000;

// Per-artifact storage caps. Over-cap artifacts are dropped individually —
// the rest of the set still stores, and the PR embed falls back from GIF
// to PNG per side. 1280x800 PNGs run 100-400 KB; a 5-9s webm ~0.5-2 MB;
// the 640px/10fps GIF typically 1-4 MB.
const MAX_BYTES = {
  png: 4 * 1024 * 1024,
  webm: 8 * 1024 * 1024,
  gif: 8 * 1024 * 1024,
};
const CONTENT_TYPES = {
  png: 'image/png',
  webm: 'video/webm',
  gif: 'image/gif',
};

// Recording + GIF encoding add real seconds per page on top of load, and
// the worst-case stdout is six base64 artifacts (2 png + 2 webm + 2 gif).
//
// Raised 240s → 600s when every declared check started running: the media
// pass is unchanged, but the suite that follows it now has its own 420s
// budget, and the container needs room to finish that budget and still emit
// its sentinel. This is the OUTER bound — the suite stops dispatching at
// TESTS_DEADLINE_MS long before we get here, so hitting it means the
// container is genuinely wedged, not merely busy.
//
// 600s → 640s with the 480 → 530 ceiling bump: the suite deadline below
// crossed 480s, and this one has to stay 120s above it (pinned by
// tests/checks-budget.test.js and tests/capture-pool.test.js).
//
// 640s → 680s with 530 → 560 (#1699 crossed 512): the deadline moved to
// 560s, and 120s above it is 680s.
//
// 680s → 690s with 560 → 580 (a proposal in flight at the same time): the
// deadline moved to 570s, and 120s above it is exactly 690s.
//
// 690s → 710s with 580 → 600 (#1824, which found the manifest sitting exactly
// on the 20-slot floor): the deadline moved to 590s, and 120s above it is
// 710s.
//
// 710s → 740s with 600 → 630 (#1876, whose two-step waitlist declares eight
// checks where one stood): the deadline moved to 620s, and 120s above it is
// 740s.
//
// 740s → 770s with 630 → 660 (#1960): the deadline moved to 650s, and 120s
// above it is 770s.
const RUN_TIMEOUT_MS = 770 * 1000;
const RUN_MAX_BUFFER = 128 * 1024 * 1024;

// The capture container drives up to TEST_CONCURRENCY headless pages at
// once. One Chromium page is ~50-80 MiB of renderer (80-150 MiB for this
// repo's own shell), so sixteen of them plus the browser process needs
// materially more than the 1g runOneShot default — an OOM-kill there loses
// the whole run, sentinel included, and reads to the platform as a crashed
// container. 4g → 6g when the pool doubled 8 → 16; the worker LimitRange
// allows 16Gi per container, and tests/checks-budget.test.js pins the
// per-page headroom.
const CAPTURE_MEMORY = process.env.CAPTURE_MEMORY || '6g';
// Eight browser groups saturated the former four-core quota even on an idle
// node — because Chromium was compositing every page on the CPU through
// SwiftShader (see CHROMIUM_LAUNCH_ARGS in capture/capture.js, which now
// puts compositing on Skia's software path). A group costs well under a
// core with that in place, so 8 covers sixteen groups plus the media pass
// with room. It stays at 8 rather than growing with the pool: the worker
// LimitRange caps a container there, and memory is the bound on the pool
// now, not CPU.
const CAPTURE_CPUS = process.env.CAPTURE_CPUS || '8';

// Suite bounds handed to the container. Kept here rather than left to the
// image's own defaults so the platform's timeout arithmetic (below) and the
// container's agree by construction.
//
// 8 → 16 lanes with software compositing: the pool used to be bound by its
// own container's CPU, and is now bound by the wire (a cold load is ~5-7s
// whatever runs beside it), so doubling the lanes roughly halves the suite's
// wall clock — ~186s → ~80-100s for this repo's 169 groups in replay. The
// sizing is written up on poolSize in capture/capture.js.
const TEST_CONCURRENCY = process.env.TEST_CONCURRENCY || '16';
const TEST_TIMEOUT_MS = process.env.TEST_TIMEOUT_MS || '25000';
// 470s → 490s, moved together with MAX_DECLARED_TESTS 480 → 500 in
// services/app-manifest.js — the two are one decision, and the note on that
// constant says so. A full 500-check suite is ~244s of ideal work at the
// measured ~3.9s per check over this pool of 8; 490s keeps the 2x margin
// tests/checks-budget.test.js pins, which is what stops a real manifest's
// tail being cut on every build. RUN_TIMEOUT_MS above stayed at 600s then: it
// only has to clear this by 120s, and it cleared it by 130s.
//
// 470s → 520s with MAX_DECLARED_TESTS 480 → 530: ~258s of ideal work for a
// full suite, so 520s keeps the 2x margin with ~3s to spare. This crossed the
// 480s line the note above warned about, so RUN_TIMEOUT_MS moved with it.
//
// 520s → 560s with MAX_DECLARED_TESTS 530 → 560, when the manifest reached 512
// and left 18 of the 20 slots the headroom rule requires. ~273s of ideal work
// for a full suite, so 560s keeps the 2x margin by 14s — more room than the
// last move left, deliberately, because the previous two both had to be redone
// within a few hundred checks. RUN_TIMEOUT_MS moves 640s → 680s with it, the
// required 120s clear and no more, as every one of these moves has done.
//
// 560s → 570s with MAX_DECLARED_TESTS 560 → 580, a proposal in flight at the
// same time: ~283s of ideal work for a full suite, so 570s keeps the 2x
// margin with ~4s to spare. RUN_TIMEOUT_MS moves 680s → 690s with it again.
//
// 570s → 590s with MAX_DECLARED_TESTS 580 → 600 (#1824): ~293s of ideal work
// for a full suite, so 590s keeps the 2x margin with ~5s to spare, and
// RUN_TIMEOUT_MS moves 690s → 710s with it.
//
// 590s → 620s with MAX_DECLARED_TESTS 600 → 630 (#1876): ~307s of ideal work
// for a full suite, so 620s keeps the 2x margin with ~6s to spare, and
// RUN_TIMEOUT_MS moves 710s → 740s with it.
//
// 620s → 650s with MAX_DECLARED_TESTS 630 → 660 (#1960): ~322s of ideal work
// for a full suite, so 650s keeps the 2x margin with ~6s to spare, and
// RUN_TIMEOUT_MS moves 740s → 770s with it.
//
// Left at 650s when the pool doubled 8 → 16: the ideal work for a full suite
// halved to ~161s, so the margin is now 4x rather than 2x. Deliberately not
// tightened — this deadline only ever binds a suite that is wedged, and a
// healthy one finishes in a fraction of it either way; what it buys is that
// the container gets to emit its sentinel rather than being killed.
const TESTS_DEADLINE_MS = process.env.TESTS_DEADLINE_MS || '650000';

// ── Browser checks across several pods ──
//
// On 10 Oct 2026 one 733-check run took 126s in a single browser pod that
// spent it at 7.9 of its 8 CPUs, throttled most of the time, while the
// preview it was testing idled under one CPU: the browser was the bound. So
// a run of at least CAPTURE_SHARD_MIN_TESTS checks is split across
// CAPTURE_SHARDS pods. Each gets the whole list and its shard number and
// runs only its share of the page groups (capture/capture.js shardGroups);
// the first also takes the screenshots. Their output is joined in shard
// order and read exactly as one pod's would be. A check no shard reported,
// when no shard ran out of time, is asked again in one more pod before the
// verdict (`sweep`), so a lost pod costs a short re-run, never a red.
//
// A shard asks the scheduler for CAPTURE_SHARD_CPU_REQUEST CPUs (it may
// burst to CAPTURE_CPUS), so three shards ask for 6 where one pod asked
// for 4: the worker namespace's quota counts requests, and the checks
// queue's four runs must still fit in it. CAPTURE_SHARDS=1 runs one pod,
// as before.
function captureShardCount(raw = process.env.CAPTURE_SHARDS) {
  if (raw == null || String(raw).trim() === '') return 3;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, 8) : 3;
}
const CAPTURE_SHARD_MIN_TESTS = Number.parseInt(process.env.CAPTURE_SHARD_MIN_TESTS, 10) || 60;
const CAPTURE_SHARD_CPU_REQUEST = process.env.CAPTURE_SHARD_CPU_REQUEST || '2';
// Pages each shard keeps open at once, in place of TEST_CONCURRENCY. Every
// page loads the one preview, and through it the Postgres primary that
// production and every preview share; on 7 Oct 2026 that primary was the
// bottleneck when too many runs went at once (services/checks-queue.js).
// Three shards of 5 are 15 pages where one pod had 8 starved of CPU, so a
// run's load on the primary is about doubled during its shorter browser
// phase rather than tripled.
const CAPTURE_SHARD_CONCURRENCY = process.env.CAPTURE_SHARD_CONCURRENCY || '5';
// The checks' own pixel density (capture/capture.js TEST_DEVICE_SCALE_FACTOR):
// 1× unless set. The shots keep the app's density.
const CAPTURE_TEST_DEVICE_SCALE = process.env.CAPTURE_TEST_DEVICE_SCALE || '1';

// Mint a 15-minute capture identity token for a seeded capture identity
// row, scoped to the app being captured.
//
// Delegates to platformJwt.signAppIdentityToken, so a capture token is the
// SAME kind of credential /api/iframe-token mints — RS256, issuer
// `usernode`, audience `usernode:app:<appId>`, `pur: 'iframe'` — just with
// a shorter life. Homeroom's own captures also carry `env: 'preview'`
// so production platform consumers refuse them. Authored apps retain their
// existing preview integrations. The self-app clone exchanges its token for a local
// session via middleware/auth.js.
//
// Returns '' when the row is absent so callers degrade to unauthenticated
// capture — never throws on a missing user.
function mintCaptureToken(user, appId, { previewOnly = false } = {}) {
  if (!user) return '';
  return platformJwt.signAppIdentityToken({
    appId,
    user: {
      id: user.id,
      username: user.username,
      usernode_pubkey: user.usernode_pubkey || null,
      locale: user.locale ?? null,
    },
    ttl: platformJwt.CAPTURE_TTL,
    environment: previewOnly || process.env.USERNODE_ENV === 'staging' ? 'preview' : 'production',
  });
}

// Route the two capture identities to their jobs (#47). Screenshots always
// sign as the non-admin capture user (public artifacts must never show
// admin-only UI), while the proposal-checks assertion suite prefers the
// view-only-admin token so the admin-gated check routes (/admin, /dashboard)
// render under test — falling back to the non-admin token when the admin
// identity is missing (migration not yet run / lookup failed). Pure so the
// routing + fallback is unit-testable without spinning up the pipeline.
function selectCaptureTokens({ captureToken, adminToken }) {
  const screenshot = captureToken || '';
  return {
    screenshotToken: screenshot,
    testsToken: adminToken || screenshot,
  };
}

// Append the capture JWT as a `token` query param. testing_path can
// legitimately carry its own query string (e.g. `/board?demo-pr=1`, see
// testing-notes.js), so the join must pick '?' vs '&'. An empty token
// returns the URL unchanged (unauthenticated capture — current behaviour).
//
// Fragment-safe (#353): the self-app's non-app screens still carry hashes,
// and a query param MUST sit before the fragment or it never reaches the
// server. Split off any `#...` tail, splice `token=` onto the path+query part,
// then re-attach the fragment. Clean app pathname URLs (no `#`) are
// byte-identical to the old concat behaviour.
function withToken(url, token) {
  if (!token) return url;
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const frag = hashAt === -1 ? '' : url.slice(hashAt);
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) + frag;
}

// The address one declared check visits. A `guest` check must really be
// signed out, so it gets the bare address: a `token` query parameter is the
// sign-in, and appending it would make the check a signed-in one wearing a
// visitor's hat. Every other check signs in as the view-only admin.
function checkVisitUrl(origin, visitPath, token, persona) {
  const url = `${origin}${visitPath}`;
  return persona === 'guest' ? url : withToken(url, token);
}

// The self-app uses clean pathname routes for app screens
// (`/app/<slug>/...`) and keeps the rest of its SPA screens in fragments
// (`#leaderboard`, `#admin/...`, ...). A non-app testing path joined as a
// pathname loads index.html with an empty fragment → the home feed, for both
// "before" and "after".
//
// Normalise a self-app testing path into the form the SPA actually
// routes off: if its first segment is one of the SPA hash routes, move
// the whole path into the URL fragment (pathname stays '/'). Anything
// else — the bare '/', a path already written as a fragment ('/#...'),
// or a genuinely standalone server page (/cli/authorize) — is left
// exactly as-is so those real routes still resolve. Only applied for the
// self-app; child apps are genuinely path-routed and pass through
// untouched.
//
// #860 added 'admin': the seven former standalone admin pages
// (/dashboard, /admin, /status, /node-status, /debug, /gallery,
// /admin-features) are sections of the #admin console now, so
// `path: /admin/analytics` normalises straight into the fragment. Their
// OLD pathnames still work too — they fall through untouched and hit the
// client-side redirect stubs — just with one extra hop.
//
// 'apps' (plural) is the browse-all-apps screen and its per-app detail
// page (`#apps`, `#apps/<slug>`). There is no server page at that
// pathname, so before it was listed here a `path: /apps` silently loaded
// index.html with an empty hash and captured the home screen — the exact
// failure mode this whole function exists to prevent. It is distinct from
// the singular 'app' (the clean app-view route), which deliberately stays in
// the pathname. The first path segment is matched exactly, not by prefix.
const SELF_APP_HASH_ROUTES = new Set([
  'apps', 'leaderboard', 'group-chat', 'individual-chat', 'create', 'admin', 'messages',
]);
function selfAppHashPath(p) {
  const path = typeof p === 'string' ? p : '/';
  if (!path.startsWith('/') || path.startsWith('/#')) return path;
  const firstSeg = path.slice(1).split(/[/?#]/)[0];
  if (!SELF_APP_HASH_ROUTES.has(firstSeg)) return path;
  return '/#' + path.slice(1);
}

// "Before" (production) target hostname for an app. Child apps run as
// `usernode-app-<slug>`; the platform itself is reached via
// config.selfAppContainer (default 'usernode' — under blue-green that's
// the shared network ALIAS both colors carry, not a container name), NOT
// as `usernode-app-<selfAppSlug>` — which is why self-app sessions used
// to get no "before" image at all (#195 follow-up).
function beforeContainerName(config, slug) {
  return slug === config.selfAppSlug
    ? (config.selfAppContainer || 'usernode')
    : `usernode-app-${slug}`;
}

// A stored runtime name that is a bare 64-hex string is a container ID, not a
// hostname. `docker run` prints the ID, and every deploy before eec6adf
// returned it as `runtimeName` — so it was persisted into
// chat_sessions.staging_runtime_name and apps.runtime_name for the whole of
// that window. Docker's embedded DNS resolves container NAMES and network
// aliases and never the full ID, so a capture aimed at one dies with
// ERR_NAME_NOT_RESOLVED on every route, before a byte of app code runs.
//
// That is not self-healing: those columns are only rewritten by a full
// staging BUILD, and a re-check reuses a live container rather than
// rebuilding it, so an affected proposal repeats the same broken hostname
// forever and the only escape is a new commit — which clears its votes.
// Refusing the ID here falls back to the deterministic name the container
// actually carries, which fixes every row written in that window with no
// migration, no rebuild and no vote lost.
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/i;
function usableRuntimeName(name) {
  const value = String(name == null ? '' : name).trim();
  return !value || CONTAINER_ID_RE.test(value) ? null : value;
}

// The same failure, one wall further out. A container ID is unresolvable
// because Docker's DNS does not serve it; a container NAME longer than 63
// bytes is unresolvable because 63 is the maximum length of a DNS label and
// nothing — Chrome's resolver, Go's, glibc's — will even send the query.
// `usernode-staging-<slug>--<sessionId>` crosses that line at a 43-character
// slug, which is an app name a human can plausibly type, and the symptom is
// identical: ERR_NAME_NOT_RESOLVED on every route, before a byte of app code
// runs, scored as the app's fault.
//
// Containers therefore carry a short network ALIAS alongside the long name
// (application-runtime.dnsAlias). Prefer it, but only when it is real: for a
// name that still fits, an alias we could not confirm is strictly worse than
// the name that has always worked. When the name does NOT fit there is no
// safe fallback — the alias is the only thing that can resolve — so use it
// either way and let the capture report honestly if it is missing too.
const MAX_DNS_LABEL = 63;
function dnsHostname(name, alias, { aliasConfirmed = false } = {}) {
  const value = String(name == null ? '' : name).trim();
  const short = String(alias == null ? '' : alias).trim();
  if (!short) return value;
  if (value.length > MAX_DNS_LABEL) return short;
  return aliasConfirmed ? short : value;
}

// The dapp.json visual-impact glob matcher lives in its own module now.
// #2512: it used to compile each glob to a RegExp here, which turned every
// `**` into an unbounded `.*` and made a hostile pattern from a proposal's
// own dapp.json stall the platform's event loop for over a minute. The
// replacement is an NFA simulation with the identical dialect — see
// services/visuals-glob.js for the measurement and the equivalence argument.
const { visualImpactMatches } = require('./visuals-glob');

function visualScenarioFingerprint(test) {
  return crypto.createHash('sha256').update(JSON.stringify({
    id: test.id,
    path: test.path,
    expectSelector: test.expectSelector || null,
    expectText: test.expectText || null,
  })).digest('hex');
}

// Select the executable visual flows whose repository ownership overlaps the
// proposal diff. Declaration order is priority order, matching the existing
// dapp.json checks contract. One path is photographed once even when several
// checks assert the same state; the first named scenario owns its provenance.
function selectVisualScenarios(declaredTests, changedFiles) {
  if (!Array.isArray(declaredTests) || !Array.isArray(changedFiles)) return [];
  const files = changedFiles.map((f) => String(f || '')).filter(Boolean);
  const paths = new Set();
  const out = [];
  for (const test of declaredTests) {
    if (!test || test.visual !== true || typeof test.id !== 'string'
      || !Array.isArray(test.impact) || !test.impact.length) continue;
    if (!test.impact.some((pattern) => files.some((file) => visualImpactMatches(pattern, file)))) continue;
    if (paths.has(test.path)) continue;
    paths.add(test.path);
    out.push({
      id: test.id,
      path: test.path,
      fingerprint: visualScenarioFingerprint(test),
      expectSelector: test.expectSelector || null,
      expectText: test.expectText || null,
    });
    if (out.length >= CAPTURE_MAX_PATHS) break;
  }
  return out;
}

// Submission routes remain an explicit override. With none, prefer a matching
// named scenario and finally retain the established app-root fallback. The
// fallback is deliberately labelled `default` / pathDefaulted so an irrelevant
// screenshot remains visible and reportable while scenario coverage grows.
function deriveCapturePlan(session, declaredTests, changedFiles) {
  const raw = (Array.isArray(session?.testing_paths) && session.testing_paths.length)
    ? session.testing_paths
    : (session?.testing_path ? [session.testing_path] : []);
  const seen = new Set();
  const submitted = [];
  for (const item of raw) {
    const value = normalizeStoredPath(item);
    if (!value || seen.has(value.path)) continue;
    seen.add(value.path);
    submitted.push(value.path);
    if (submitted.length >= CAPTURE_MAX_PATHS) break;
  }
  if (submitted.length) {
    return { paths: submitted, pathDefaulted: false, routeSource: 'submitted', scenarios: [] };
  }
  const scenarios = selectVisualScenarios(declaredTests, changedFiles);
  if (scenarios.length) {
    return {
      paths: scenarios.map((scenario) => scenario.path),
      pathDefaulted: false,
      routeSource: 'scenario',
      scenarios,
    };
  }
  return { paths: ['/'], pathDefaulted: true, routeSource: 'default', scenarios: [] };
}

// What the legacy capture outcome says when it took no screenshots because
// route-based media is suppressed (suppressLegacyMediaForSession: the
// proposal declared before & after shots, or the shots kill switch is on).
// It used to say "No frontend files in commit range" on every such run,
// including ones that changed the UI and had verified shots.
const LEGACY_SUPERSEDED_REASON = 'Route-based screenshots are retired in favour of before & after shots; this run only checks the console';

function shouldCaptureMedia(uiAffecting, routeSource, {
  suppressLegacyMedia = false,
} = {}) {
  // Once a proposal declares shots-v2 intent, route-only media is no
  // longer what reviewers see. Keep running the existing browser/check suite,
  // but do not create or publish screenshots from its default `/` (or even
  // an explicit legacy path). The global v2 kill switch also suppresses this
  // media: an emergency stop must not make the old irrelevant screenshots
  // look trustworthy again.
  if (suppressLegacyMedia) return false;
  return !!uiAffecting || routeSource === 'submitted' || routeSource === 'scenario';
}

async function suppressLegacyMediaForSession(pool, config, session) {
  // Production config ties collect/execute/present to this one switch. Treat
  // disabled as "no review media" rather than falling back to route capture;
  // checks and staging still run through the legacy pipeline below.
  if (config.shots?.enabled === false) return true;
  if (!config.shots?.collect) return false;
  if (session?.shots_detail && typeof session.shots_detail === 'object') return true;
  try {
    const { rows } = await pool.query(
      'SELECT shots_detail FROM chat_sessions WHERE id = $1',
      [session.id]
    );
    return !!(rows[0]?.shots_detail && typeof rows[0].shots_detail === 'object');
  } catch (err) {
    log.warn('visuals', 'Shots enrollment lookup failed — suppressing legacy media', {
      sessionId: session.id, err: err.message,
    });
    // Fail closed when collection is enabled. Checks still run; only legacy
    // review media is withheld until enrollment can be established.
    return true;
  }
}

// ── Capture image ──────────────────────────────────────────────────────
// Built lazily by the platform from the repository root, mirroring the worker-image
// pattern (worker.js ensureWorkerImage). Memoized per process: capture/
// only changes when the platform itself redeploys, which restarts the
// process anyway; Docker's layer cache makes the one build per boot fast.
let _imagePromise = null;
function ensureCaptureImage() {
  if (captureRuntimeMode() === 'kubernetes') {
    if (!(process.env.KUBERNETES_CAPTURE_IMAGE || '').includes('@sha256:')) {
      return Promise.reject(new Error('KUBERNETES_CAPTURE_IMAGE must be configured with an immutable digest'));
    }
    return Promise.resolve();
  }
  if (!_imagePromise) {
    const repositoryRoot = path.join(__dirname, '../..');
    _imagePromise = docker.buildImage(repositoryRoot, CAPTURE_IMAGE, {}, {
      dockerfile: path.join(repositoryRoot, 'capture/Dockerfile'),
    }).catch((err) => {
      _imagePromise = null; // allow a retry on the next capture
      throw err;
    });
  }
  return _imagePromise;
}

// ── Output protocol parsing ────────────────────────────────────────────
// capture.js emits one frame per artifact:
//   __USERNODE_SHOT__ kind=before media=png status=200 bytes=12345 index=0
//   <base64, single line>
//   __USERNODE_SHOT_END__
// and __USERNODE_SHOT_FAIL__ kind=... media=... reason=... index=... for
// failures. `index` is the capture group (multi-route, #270); it defaults
// to 0 when absent so an older capture container is parsed as one group.
function parseShots(stdout) {
  const shots = [];
  const failures = [];
  const lines = String(stdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('__USERNODE_SHOT__ ')) {
      const attrs = {};
      for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
      const payload = lines[i + 1] || '';
      if (lines[i + 2] === '__USERNODE_SHOT_END__'
          && (attrs.kind === 'before' || attrs.kind === 'after')
          && CONTENT_TYPES[attrs.media]) {
        try {
          const buf = Buffer.from(payload, 'base64');
          if (buf.length) {
            shots.push({
              kind: attrs.kind,
              media: attrs.media,
              status: parseInt(attrs.status, 10) || 0,
              index: parseInt(attrs.index, 10) || 0,
              // fellback=1 tags a "before" frame that was actually shot at
              // the fallback '/' (the deep path 404'd on prod). Absent on
              // older capture images → false.
              fellBack: attrs.fellback === '1',
              buf,
            });
          }
        } catch { /* malformed base64 — treat as a missing frame */ }
        i += 2;
      }
    } else if (line.startsWith('__USERNODE_SHOT_FAIL__ ')) {
      const attrs = {};
      for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
      failures.push({
        kind: attrs.kind, media: attrs.media,
        reason: decodeURIComponent(attrs.reason || 'unknown'),
      });
    }
  }
  return { shots, failures };
}

// ── Console-error check (#381) ───────────────────────────────────────────
// capture.js emits one console frame per "after" target:
//   __USERNODE_CONSOLE__ index=<n> errors=<count> loadStatus=<n>
//   <base64 JSON array of { kind, message, source }>
//   __USERNODE_CONSOLE_END__
// Parse them into one frame per capture index (latest wins on a dup index).
const CONSOLE_MAX_ERRORS = 20;
const CONSOLE_MAX_MSG_LEN = 500;

function parseConsole(stdout) {
  const byIndex = new Map();
  const lines = String(stdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('__USERNODE_CONSOLE__ ')) continue;
    const attrs = {};
    for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
    const payload = lines[i + 1] || '';
    if (lines[i + 2] !== '__USERNODE_CONSOLE_END__') continue;
    const index = parseInt(attrs.index, 10) || 0;
    const loadStatus = parseInt(attrs.loadStatus, 10) || 0;
    let errors = [];
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
      if (Array.isArray(parsed)) errors = parsed;
    } catch { /* malformed base64/JSON — treat the frame as no parsed errors */ }
    byIndex.set(index, { index, loadStatus, errors });
    i += 2;
  }
  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}

// Classify the parsed frames into the persisted snapshot:
//   'errors'  — at least one console error / page error / failed load
//   'clean'   — every checked target navigated OK with no error output
//   'unknown' — nothing to classify (no frame parsed: container crashed,
//               no staging "after" reachable, …) → no badge
// The flattened error list is deduped by message and capped, matching the
// capture-side caps so a runaway app can't bloat the row.
function classifyConsole(frames) {
  if (!Array.isArray(frames) || !frames.length) return { state: 'unknown', errors: [] };
  const seen = new Set();
  const errors = [];
  for (const f of frames) {
    for (const e of (Array.isArray(f.errors) ? f.errors : [])) {
      const message = String((e && e.message) || '').slice(0, CONSOLE_MAX_MSG_LEN);
      if (!message || seen.has(message)) continue;
      seen.add(message);
      errors.push({
        kind: (e && typeof e.kind === 'string') ? e.kind : 'console',
        message,
        source: (e && e.source) ? String(e.source).slice(0, CONSOLE_MAX_MSG_LEN) : '',
      });
      if (errors.length >= CONSOLE_MAX_ERRORS) break;
    }
    if (errors.length >= CONSOLE_MAX_ERRORS) break;
  }
  return { state: errors.length ? 'errors' : 'clean', errors };
}

// ── Test suite (#47, "CI for proposals") ─────────────────────────────────
// capture.js emits one frame per declared test:
//   __USERNODE_TEST__ index=<n> status=<pass|fail> loadStatus=<n>
//   <base64 JSON { name, path, consoleErrors:[...], failureReason }>
//   __USERNODE_TEST_END__
// Parse them into one record per index (latest wins on a dup index).
//
// Was 20 back when the reader itself kept only 12 declared checks. Now every
// declared check runs, so the row cap has to reach the declaration ceiling
// or the card would silently hide the tail it exists to surface. The
// serialised payload is separately byte-capped in storeChecks.
const TEST_MAX_RESULTS = appManifest.MAX_DECLARED_TESTS;

function parseTests(stdout) {
  const byIndex = new Map();
  const lines = String(stdout || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('__USERNODE_TEST__ ')) continue;
    const attrs = {};
    for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
    const payloadLine = lines[i + 1] || '';
    if (lines[i + 2] !== '__USERNODE_TEST_END__') continue;
    const index = parseInt(attrs.index, 10) || 0;
    const status = attrs.status === 'pass' ? 'pass' : 'fail';
    const loadStatus = parseInt(attrs.loadStatus, 10) || 0;
    let payload = {};
    try {
      const parsed = JSON.parse(Buffer.from(payloadLine, 'base64').toString('utf8'));
      if (parsed && typeof parsed === 'object') payload = parsed;
    } catch { /* malformed — keep the status from the header line */ }
    byIndex.set(index, {
      index,
      name: typeof payload.name === 'string' ? payload.name : `test ${index + 1}`,
      path: typeof payload.path === 'string' ? payload.path : '',
      status,
      loadStatus,
      consoleErrors: Array.isArray(payload.consoleErrors) ? payload.consoleErrors : [],
      failureReason: typeof payload.failureReason === 'string' ? payload.failureReason : '',
      // Set on a frame that is a SECOND OPINION on another check rather
      // than a check of its own: the container re-ran a failure on its own
      // cold document. Names the index it is a retry of.
      retryOf: Number.isInteger(payload.retryOf) ? payload.retryOf : null,
      // A primary's group start in its pod's run, and the pod, which the
      // retry classes read (services/check-signals.js). Absent from older
      // images' frames and from retries.
      ...(Number.isFinite(payload.startedMs) ? { startedMs: payload.startedMs } : {}),
      ...(typeof payload.pod === 'string' ? { pod: payload.pod.slice(0, 16) } : {}),
      // The check held only on a fresh load after its hash switch failed it.
      ...(checkSignals.cohortFallbackOf(payload) ? { cohortFallback: checkSignals.cohortFallbackOf(payload) } : {}),
      // The runner's render-health reading of this check's document (see
      // services/render-health.js). Absent from frames an older capture
      // image produced, which the row then treats as "no reading".
      ...(payload.render && typeof payload.render === 'object' ? { render: payload.render } : {}),
    });
    i += 2;
  }
  return Array.from(byIndex.values()).sort((a, b) => a.index - b.index);
}

// The suite's completion sentinel:
//   __USERNODE_TESTS_DONE__ ran=<n> expected=<n> deadline=<0|1>
// Absent when the container died before finishing, or when an OLD capture
// image (which never emitted it) served the run — both callers below treat
// `null` as "no claim made" and fall back to counting frames.
//
// One pod's line: the last wins, as it always has. A run split across
// browser pods (runCaptureShards) has one line per shard, each naming its
// shard: those add up, with the sweep's line if there was one, and any
// shard's deadline is the run's.
function parseTestsDone(stdout) {
  const lines = String(stdout || '').split('\n');
  let last = null;
  const shards = new Map();
  for (const line of lines) {
    if (!line.startsWith('__USERNODE_TESTS_DONE__ ')) continue;
    const attrs = {};
    for (const m of line.matchAll(/(\w+)=(\S+)/g)) attrs[m[1]] = m[2];
    const one = {
      ran: parseInt(attrs.ran, 10) || 0,
      expected: parseInt(attrs.expected, 10) || 0,
      deadline: attrs.deadline === '1',
    };
    if (attrs.shard) shards.set(attrs.shard, one);
    else last = one;
  }
  if (!shards.size) return last;
  return [...shards.values(), ...(last ? [last] : [])].reduce((sum, one) => ({
    ran: sum.ran + one.ran, expected: sum.expected + one.expected, deadline: sum.deadline || one.deadline,
  }), { ran: 0, expected: 0, deadline: false });
}

// The declared checks a capture output has a frame for (retries excluded).
function reportedTestIndexes(stdout) {
  const seen = new Set();
  for (const line of String(stdout || '').split('\n')) {
    if (!line.startsWith('__USERNODE_TEST__ ')) continue;
    const m = /\bindex=(\d+)\b/.exec(line);
    if (!m) continue;
    const index = parseInt(m[1], 10);
    if (index < CAPTURE_RETRY_INDEX_BASE) seen.add(index);
  }
  return seen;
}

// What the capture container wrote down about itself while it ran
// (capture.js emitDiag), one line each:
//   __USERNODE_DIAG__ kind=<kind> <base64 JSON>
// Two kinds: 'network-changed', the pod's network state when a cold load
// was cancelled by a network change and its group started over, and
// 'checks-timing', one line per pod at its end: how long its groups and cold
// loads took. Logged, not stored: they are for finding out what the runs do,
// not verdicts. A sharded run's stdout
// is its pods' joined, so the timing lines have a cap of their own (eight
// shards and a sweep) and never take the other kinds' places.
const MAX_DIAGNOSTICS = 5;
const MAX_TIMING_DIAGNOSTICS = 9;

function parseDiagnostics(stdout) {
  const out = [];
  let others = 0;
  let timings = 0;
  for (const line of String(stdout || '').split('\n')) {
    if (!line.startsWith('__USERNODE_DIAG__ ')) continue;
    const m = line.match(/^__USERNODE_DIAG__ kind=([\w-]+) (\S+)$/);
    if (!m) continue;
    const timing = m[1] === 'checks-timing';
    if (timing ? timings >= MAX_TIMING_DIAGNOSTICS : others >= MAX_DIAGNOSTICS) continue;
    let data = {};
    try {
      const parsed = JSON.parse(Buffer.from(m[2], 'base64').toString('utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch { /* malformed: the kind alone still says something happened */ }
    out.push({ kind: m[1], data });
    if (timing) timings += 1; else others += 1;
  }
  return out;
}

// A suite-level failure happens outside any individual declared check, so
// there is no __USERNODE_TEST__ payload to carry its explanation. The
// capture process writes those failures as `capture: fatal ...` on stderr;
// Kubernetes' log API may fold that stream into the text we call stdout,
// while Docker keeps the streams separate. Read both, then fall back to the
// runtime's bounded termination summary. This string is persisted in
// check_error_detail, so scrub the same credential shapes as the logger and
// strip token-like query parameters before returning it.
function captureFailureDetail({ stdout = '', stderr = '', runPartialReason = '', fallbackReason = '' } = {}) {
  const clean = (value) => log.redactString(String(value || ''))
    .replace(/([?&](?:token|jwt|auth|key)=)[^&\s]+/gi, '$1****')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const cap = (value) => {
    const text = clean(value);
    return text.length > 280 ? `${text.slice(0, 279)}…` : text;
  };
  for (const blob of [stderr, stdout]) {
    const lines = String(blob || '').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const match = /^\s*capture:\s*fatal\s+(.+)\s*$/i.exec(lines[i]);
      if (match) return cap(`Browser check runner failed: ${match[1]}`);
    }
  }
  const runtimeReason = [runPartialReason, stderr, fallbackReason]
    .map((value) => clean(value))
    .find(Boolean);
  if (runtimeReason) {
    return cap(`Browser check runner ended before producing results: ${runtimeReason}`);
  }
  return 'Browser check runner produced no result frames.';
}

function normalizeConsoleErrors(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, CONSOLE_MAX_ERRORS)
    .map((e) => ({
      kind: (e && typeof e.kind === 'string') ? e.kind : 'console',
      message: String((e && e.message) || '').slice(0, CONSOLE_MAX_MSG_LEN),
      source: (e && e.source) ? String(e.source).slice(0, CONSOLE_MAX_MSG_LEN) : '',
    }));
}

// Origin-level browser failures: the request never reached the app because
// the hostname did not resolve or nothing was listening. These are reported
// as `kind: 'load'` console errors, and they are indistinguishable — from
// inside a check row — from an app that renders a broken page.
//
// They are not the same thing, and scoring them the same way is what made
// #1381 permanent. 'failing' is a verdict ABOUT THE APP: it sticks to the
// commit, it records fail_count against the check's history, it schedules no
// retry, and it escalates to nobody, because a failing test is the author's
// problem to fix. An origin that does not resolve is the platform's problem,
// and 'error' is the state that already handles it — backoff, a retry
// schedule, `check_error_detail`, owner escalation, and "⚠ Checks couldn't
// run" on the card instead of a red X next to the author's name.
const UNREACHABLE_ORIGIN_RE = new RegExp([
  'ERR_NAME_NOT_RESOLVED',
  'ERR_CONNECTION_REFUSED',
  'ECONNREFUSED',
  'ERR_ADDRESS_UNREACHABLE',
].join('|'), 'i');

// Returns a human-readable detail string when EVERY container-produced row
// failed at the origin, or null.
//
// "Every" is the load-bearing word. One unreachable route among passing ones
// is an app-side deep link pointing at a host the app itself got wrong — a
// real, author-fixable failure that must keep blocking. It is only when not a
// single route could be reached that the origin, rather than the app, is the
// thing that is broken.
function unreachableOriginDetail(rows, origin) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  let sample = '';
  for (const r of list) {
    if (r.status === 'pass') return null;
    const hit = (Array.isArray(r.consoleErrors) ? r.consoleErrors : []).find(
      (e) => e && e.kind === 'load' && UNREACHABLE_ORIGIN_RE.test(String(e.message || ''))
    );
    if (!hit) return null;
    if (!sample) sample = String(hit.message || '').slice(0, CONSOLE_MAX_MSG_LEN);
  }
  const where = origin ? ` at ${origin}` : '';
  return `Staging preview unreachable${where} — no route could be loaded (${sample}).`;
}

// The same re-labelling as unreachableOriginDetail, for the other way the
// platform breaks a preview without the diff being involved (#1771).
//
// One Postgres server backed the platform, every production app and every
// preview, with the stock 100 connections (previews now have a server of
// their own, the same holds there). When the fleet uses
// them all, a preview's own queries throw, its API answers 500, and every
// declared check records an assertion failure. Sixty-five of them citing
// one endpoint reads exactly like a broken commit, which is how the author
// spends an afternoon on a diff that was fine.
//
// Two independent pieces of evidence, either sufficient:
//
//   - a row NAMES it (Postgres's complaint reached the page or the failure
//     reason), which is proof;
//   - the census says the server was saturated as the run finished, which
//     is circumstance, and is usually all there is, because a 500 page
//     rarely quotes the database.
//
// Guarded by the same "every container row failed" rule as #1381, and for
// the same reason: one broken route among passing ones is the diff's doing
// even on a busy server, and only a total wipeout is consistent with the
// preview having no working database at all. `rows` must already exclude
// synthesized rows, which never loaded a page.
function connectionExhaustionDetail(rows, { origin = '', census = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  let named = false;
  for (const r of list) {
    if (r.status === 'pass') return null;
    if (mentionsConnectionLimit(r.failureReason)) named = true;
    const errs = Array.isArray(r.consoleErrors) ? r.consoleErrors : [];
    if (errs.some((e) => e && mentionsConnectionLimit(e.message))) named = true;
  }
  if (!named && !(census && census.saturated)) return null;
  return connectionExhaustionMessage(census, { where: 'ran its checks' });
}

// Classify the parsed test frames into the persisted snapshot:
//   'passing' — every BLOCKING check that ran passed
//   'failing' — a blocking check failed an assertion / had console errors
//   'error'   — the run cannot be trusted: no frames at all, or a check
//               that has earned gating produced no verdict → the gate
//               blocks fail-closed, the UI shows "couldn't run". Those two
//               carry `missingResults`, which settleCaptureRun reads to
//               blame a test Pod that never started (#5054)
//
// Two call shapes:
//
//   classifyTests(frames, expectedCount)
//     Legacy. Every check is blocking and ANY missing frame is an 'error'.
//     Exactly the pre-#1019 semantics, kept because it is the honest answer
//     when the caller has no history to consult.
//
//   classifyTests(frames, expectedCount, { dispatched, sentinel })
//     Earned gating. `dispatched` is [{ index, checkKey, name, path,
//     graduated }] — the suite as sent to the container, in dispatch order.
//     A check is BLOCKING iff it has been observed passing before
//     (`graduated`); everything else is ADVISORY: it runs, it shows on the
//     card, it does not block the merge.
//
// Results are matched to declarations BY INDEX, never by position. With a
// pool the frames arrive out of order, and a missing frame shifts every
// later row — positional matching would silently attribute check 40's
// failure to check 39 and, worse, judge it against check 39's graduation.
//
// `options.extraRows` are synthesised blocking rows that did not come from
// the container at all (today: the over-ceiling guard).
//
// The merge-blocking unit-suite row of a suite that never ran
// (unit-suite.js notRunOutcome), or null.
function blockingNotRun(extraRows) {
  return (Array.isArray(extraRows) ? extraRows : [])
    .find((r) => unitSuiteRow.isNotRunRow(r) && !r.advisory) || null;
}

function classifyTests(frames, expectedCount, options) {
  const opts = options || {};
  const dispatched = Array.isArray(opts.dispatched) ? opts.dispatched : null;
  const sentinel = opts.sentinel || null;
  const extraRows = Array.isArray(opts.extraRows) ? opts.extraRows : [];

  // The manifest ceiling bounds declarations, not observations. A full
  // suite can emit additional retry frames; dropping those before grouping
  // them falsely keeps recovered checks blocking. Earned-gating output is
  // already bounded by the dispatched declarations below.
  const parsed = Array.isArray(frames) ? frames : [];

  // ── Legacy shape ───────────────────────────────────────────────────────
  // extraRows (the unit-suite row today) still ride along: the synthesized
  // baseline suite has no graduation history, but the extra rows carry
  // their own advisory flag and must not vanish just because the app
  // declares no dapp.json checks. Error verdicts stay decided by the
  // container's own frames, exactly as before.
  if (!dispatched) {
    const results = parsed.slice(0, TEST_MAX_RESULTS).map((f) => ({
      name: String(f.name || '').slice(0, CONSOLE_MAX_MSG_LEN),
      path: String(f.path || '').slice(0, CONSOLE_MAX_MSG_LEN),
      status: f.status === 'pass' ? 'pass' : 'fail',
      consoleErrors: normalizeConsoleErrors(f.consoleErrors),
      failureReason: String(f.failureReason || '').slice(0, CONSOLE_MAX_MSG_LEN),
      ...(checkSignals.cohortFallbackOf(f) ? { cohortFallback: checkSignals.cohortFallbackOf(f) } : {}),
    }));
    const expected = Number.isInteger(expectedCount) ? expectedCount : results.length;
    if (!results.length) return { state: 'error', results: extraRows.slice(), missingResults: true };
    if (expected > 0 && results.length < expected) {
      return { state: 'error', results: results.concat(extraRows), missingResults: true };
    }
    const all = results.concat(extraRows);
    // A merge-blocking unit suite that never ran gave no verdict: 'error'.
    const notRun = blockingNotRun(extraRows);
    if (notRun) {
      return {
        state: 'error', results: all, errorDetail: unitSuiteRow.notRunDetail(notRun),
        platformFault: unitSuiteRow.isPlatformNotRun(notRun),
      };
    }
    // Legacy container rows carry no advisory flag (always blocking);
    // extra rows block only when non-advisory — an ungraduated unit-suite
    // failure shows on the card without closing the gate (#1019 stance).
    const anyFail = all.some((r) => r.status !== 'pass' && !r.advisory && !unitSuiteRow.isNotRunRow(r));
    return { state: anyFail ? 'failing' : 'passing', results: all };
  }

  // ── Earned-gating shape ────────────────────────────────────────────────
  const byIndex = new Map();
  for (const f of parsed) byIndex.set(Number(f.index) || 0, f);

  const rows = [];
  const missingGraduated = [];
  const missingAdvisory = [];
  let blockingFailures = 0;
  let advisoryFailures = 0;
  let passed = 0;

  // A check on its first appearance is dispatched NEW_CHECK_RUNS times, as
  // one primary entry plus repeats pointing back at it. The repeats are not
  // rows — the card shows one line per declared check, as it always has —
  // they are extra OBSERVATIONS of it, and every one of them has to pass.
  // A check that passes twice and fails once on its debut is flaky, and
  // saying so on the proposal that introduces it is the whole point.
  const repeatsOf = new Map();
  for (const d of dispatched) {
    if (d.repeatOf == null) continue;
    if (!repeatsOf.has(d.repeatOf)) repeatsOf.set(d.repeatOf, []);
    repeatsOf.get(d.repeatOf).push(d);
  }
  // Retries are not dispatched — the container decides at runtime which
  // failures to ask again — so they arrive only as frames, each naming the
  // check it is a second opinion on.
  const retriesOf = new Map();
  for (const f of parsed) {
    if (!Number.isInteger(f.retryOf)) continue;
    if (!retriesOf.has(f.retryOf)) retriesOf.set(f.retryOf, []);
    retriesOf.get(f.retryOf).push(f);
  }
  // Why each retried check was retried: the run's fault, a flaky check, or
  // a real failure (services/check-signals.js). Advisory: nothing below
  // reads it for the verdict.
  const retryClasses = checkSignals.classifyRetries(parsed).byIndex;

  for (const d of dispatched) {
    if (d.repeatOf != null) continue;
    const frame = byIndex.get(Number(d.index) || 0);
    const graduated = !!d.graduated;
    if (!frame) {
      (graduated ? missingGraduated : missingAdvisory).push(d);
      continue;
    }
    // Every observation of this check in this run: its own frame, plus one
    // per first-appearance repeat that reported.
    const observed = [frame];
    for (const r of (repeatsOf.get(Number(d.index) || 0) || [])) {
      const f = byIndex.get(Number(r.index) || 0);
      if (f) observed.push(f);
    }
    const retried = retriesOf.get(Number(d.index) || 0) || [];
    for (const f of retried) observed.push(f);
    const passes = observed.filter((f) => f.status === 'pass').length;
    const fails = observed.length - passes;
    // Two rules, and the difference is who asked for the extra runs.
    //
    // DEBUT repeats are dispatched up front, before anything is known: all
    // of them have to pass, because one failure among them is the check
    // saying it is not deterministic and letting it land anyway is how a
    // flake gets the power to block strangers.
    //
    // RETRIES are asked for BECAUSE the check already failed. Any pass
    // among them means the failure was not reproducible, so the check did
    // not really fail — but it did not really pass either, which is what
    // the flaky tag and the reset streak are for. Demanding all of them
    // would make the retry pointless; ignoring the failure entirely would
    // lose the only evidence that the check is unreliable.
    const passedOnRetry = retried.length > 0 && retried.some((f) => f.status === 'pass');
    const pass = passedOnRetry || fails === 0;
    // Disagreement inside one run is the loudest flake signal there is, and
    // unlike the lifetime rate it needs no history to read.
    const flakyRun = passes > 0 && fails > 0;
    const worst = pass ? frame : (observed.find((f) => f.status !== 'pass') || frame);
    if (pass) passed += 1;
    else if (graduated) blockingFailures += 1;
    else advisoryFailures += 1;
    rows.push({
      index: Number(d.index) || 0,
      name: String(frame.name || d.name || '').slice(0, CONSOLE_MAX_MSG_LEN),
      path: String(frame.path || d.path || '').slice(0, CONSOLE_MAX_MSG_LEN),
      status: pass ? 'pass' : 'fail',
      // What this run actually observed, so history records three passes as
      // three rather than as one, and the card can say "1 of 3 runs failed".
      runs: observed.length,
      passes,
      fails,
      flakyRun,
      // It failed, it was asked again, and it answered differently. The
      // merge is not blocked on it — and nobody has to wonder why the run
      // is green when the log shows a failure.
      passedOnRetry,
      // The card renders advisory rows muted with a chip rather than
      // rewriting the name, so the check reads identically whichever power
      // it currently has.
      advisory: pass ? false : !graduated,
      // How often this check has failed across its whole recorded life.
      // Carried on PASSING rows too: a check that passes today and failed
      // four times last week is the one worth knowing about, and a chip
      // that only ever appears beside a red row would never say so.
      flakeRate: d.flakeRate != null ? d.flakeRate : null,
      consoleErrors: normalizeConsoleErrors(worst.consoleErrors),
      failureReason: pass ? '' : String(worst.failureReason || '').slice(0, CONSOLE_MAX_MSG_LEN),
      ...(retryClasses.has(Number(d.index) || 0) ? { retryClass: retryClasses.get(Number(d.index) || 0) } : {}),
      ...(checkSignals.cohortFallbackOf(frame) ? { cohortFallback: checkSignals.cohortFallbackOf(frame) } : {}),
    });
  }

  // Nothing at all came back: the container crashed, staging never booted,
  // stdout was lost. Never a verdict.
  if (!rows.length && dispatched.length) {
    return {
      state: 'error', results: extraRows.slice(), missingResults: true,
      blockingCount: 0, advisoryCount: 0, passingCount: 0,
      ranCount: 0, declaredCount: dispatched.filter((d) => d.repeatOf == null).length,
    };
  }
  if (!rows.length && !dispatched.length && !extraRows.length) {
    return {
      state: 'error', results: [],
      blockingCount: 0, advisoryCount: 0, passingCount: 0,
      ranCount: 0, declaredCount: 0,
    };
  }

  // FAIL CLOSED on a graduated check with no verdict. A check that has
  // earned gating must produce an answer every run — "we ran out of time"
  // is not a pass, and letting the budget silently drop a guard rail would
  // make the deadline a merge bypass.
  if (missingGraduated.length) {
    const names = missingGraduated.slice(0, 3).map((d) => d.name || `check ${(d.index || 0) + 1}`);
    const more = missingGraduated.length > 3 ? ` (+${missingGraduated.length - 3} more)` : '';
    return {
      state: 'error',
      results: rows.concat(extraRows),
      missingResults: true,
      errorDetail: `${missingGraduated.length} merge-blocking check${missingGraduated.length === 1 ? '' : 's'} produced no result: ${names.join(', ')}${more}`,
      blockingCount: blockingFailures, advisoryCount: advisoryFailures, passingCount: passed,
      ranCount: rows.length, declaredCount: dispatched.filter((d) => d.repeatOf == null).length,
    };
  }

  // Advisory checks that never reported collapse into a single honest row
  // instead of N indistinguishable "no result" lines.
  if (missingAdvisory.length) {
    const why = sentinel && sentinel.deadline
      ? 'did not finish in the run budget'
      : 'produced no result';
    rows.push({
      index: -1,
      name: `${missingAdvisory.length} check${missingAdvisory.length === 1 ? '' : 's'} ${why}`,
      path: '',
      status: 'fail',
      advisory: true,
      // This one ROW stands for `count` checks. Without it the card's
      // summary line counts rows and quietly under-reports the suite —
      // "239 checks" for a 241-check manifest, which is the same species of
      // silent undercount #1019 exists to remove.
      count: missingAdvisory.length,
      consoleErrors: [],
      failureReason: 'These checks have never been observed passing, so they do not block the merge.',
    });
    advisoryFailures += missingAdvisory.length;
  }

  const results = rows.concat(extraRows);
  const blocking = blockingFailures + extraRows
    .filter((r) => r && r.status !== 'pass' && !r.advisory && !unitSuiteRow.isNotRunRow(r)).length;
  // A merge-blocking unit suite that never reached `npm test` (its Job was
  // refused, its pod stopped in setup) is the same fail-closed case as a
  // graduated check with no verdict above: 'error', never 'failing'. The
  // merge stays blocked, storeChecks schedules the error lane's retry, and
  // no check history moves. Its sentence is the reason the card shows. An
  // advisory one changes nothing here; its row says why it has no result.
  const notRun = blockingNotRun(extraRows);
  if (notRun) {
    return {
      state: 'error',
      results,
      errorDetail: unitSuiteRow.notRunDetail(notRun),
      // Its Job refused or lost before any code ran: the platform's fault,
      // which the error lane keeps retrying past its usual cap.
      platformFault: unitSuiteRow.isPlatformNotRun(notRun),
      blockingCount: blocking, advisoryCount: advisoryFailures, passingCount: passed,
      ranCount: rows.length, declaredCount: dispatched.filter((d) => d.repeatOf == null).length,
    };
  }
  return {
    state: blocking > 0 ? 'failing' : 'passing',
    results,
    blockingCount: blocking,
    advisoryCount: advisoryFailures,
    passingCount: passed,
    ranCount: rows.length,
    declaredCount: dispatched.filter((d) => d.repeatOf == null).length,
  };
}

// The run's own signals, beside its verdict (services/check-signals.js).
// Never throws and never changes a verdict.
//
//   * Logs how the retried checks split, and a burst of early failures whose
//     retries all passed as a warning of its own ("Checks early retry
//     burst"), so a cold preview that failed a pod's first groups is counted
//     in Loki the day it happens. A suspicion, not a finding: the same shape
//     is an app whose address change throws (review of #5322).
//   * Marks `authored` on the rows that needed a cohort fallback and are
//     checks this proposal adds or changes: those carry the "fix the
//     navigation" note. Compared against the proposal's MERGE BASE, an
//     immutable commit, never main's tip: a main that moved on would else
//     hand a check nobody here touched to this author, or hide the note on
//     one they did. When dapp.json is not among the proposal's changes no
//     check is theirs and nothing is read; otherwise dapp.json is read at
//     the head and at the merge base. Anything unread, or slower than
//     SIGNAL_READ_TIMEOUT_MS all told, leaves no note: the advice is the
//     one thing here allowed to be missing.
const SIGNAL_READ_TIMEOUT_MS = 8000;
const signalDeps = {
  compareRefs: (owner, repo, basehead) => github.compareRefs(owner, repo, basehead),
  readDeclaredTests: (owner, repo, ref) => resolveDeclaredTests(owner, repo, ref),
};
async function authoredSince(repoOwner, repoName, commitHash, deps) {
  const cmp = await deps.compareRefs(repoOwner, repoName, `main...${commitHash}`);
  const mergeBase = cmp && cmp.mergeBaseSha;
  if (!mergeBase) return null;
  if (cmp.filesComplete && Array.isArray(cmp.files) && !cmp.files.includes(appManifest.MANIFEST_FILENAME)) {
    return new Set();
  }
  const [head, base] = await Promise.all([
    deps.readDeclaredTests(repoOwner, repoName, commitHash),
    deps.readDeclaredTests(repoOwner, repoName, mergeBase),
  ]);
  return checkSignals.authoredChecks(head, base);
}
async function noteCheckSignals(checksResult, frames, { sessionId, commitHash, repoOwner, repoName } = {}, deps = signalDeps) {
  try {
    const { byIndex, bursts } = checkSignals.classifyRetries(frames);
    if (byIndex.size) {
      log.info('visuals', 'Checks retries', {
        sessionId, commitHash: commitHash || null, ...checkSignals.retryCounts(byIndex),
      });
    }
    for (const burst of bursts) {
      log.warn('visuals', 'Checks early retry burst', {
        sessionId, commitHash: commitHash || null, pod: burst.pod, checks: burst.checks,
        lastStartedMs: burst.lastStartedMs, windowMs: checkSignals.EARLY_BURST_WINDOW_MS,
      });
    }
    const rows = checksResult && Array.isArray(checksResult.results) ? checksResult.results : [];
    const fellBack = rows.filter((r) => r && r.cohortFallback);
    if (!fellBack.length || !repoOwner || !repoName || !commitHash) return;
    let timer = null;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), deps.timeoutMs || SIGNAL_READ_TIMEOUT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    let authored;
    try {
      // A read that fails, or settles after the deadline, is no note, never
      // an unhandled rejection.
      const reads = authoredSince(repoOwner, repoName, commitHash, deps).catch(() => null);
      authored = await Promise.race([reads, timedOut]);
    } finally {
      clearTimeout(timer);
    }
    const marked = authored === 'timeout' ? 0 : checkSignals.markAuthored(rows, authored);
    log.info('visuals', 'Checks cohort fallbacks', {
      sessionId, commitHash, checks: fellBack.length, authored: marked,
      ...(authored === 'timeout' ? { authorship: 'timed out' } : (authored ? {} : { authorship: 'unread' })),
      waitMs: fellBack.reduce((n, r) => n + (r.cohortFallback.waitMs || 0), 0),
    });
  } catch (err) {
    log.warn('visuals', 'Check signals skipped', { sessionId, err: err && err.message });
  }
}

// What a checks run leaves on the row (the verdict, the skipped and deferred
// stamps, 'pending', the capture outcome) is the preview machine's to write
// (src/workflow/preview/check-store.ts); the vocabularies it shares with this
// module are src/workflow/rules/check-store.ts. A trimmed snapshot is logged
// here.
const TEST_RESULTS_MAX_BYTES = checkStore.TEST_RESULTS_MAX_BYTES;
function serializeTestResults(results) {
  const { json, dropped, kept } = checkStore.serializeTestResults(results);
  if (dropped) log.info('visuals', 'Trimmed oversized test_results payload', { dropped, kept });
  return json;
}
const DEFAULT_CHECKS_SKIPPED_REASON = checkStore.DEFAULT_CHECKS_SKIPPED_REASON;
// The stage of a 'pending' run, alone (a preview machine's run: the machine
// owns the verdict columns, and the run says only which stage it is in).
async function setChecksPhase(pool, sessionId, commitSha, phase) {
  const write = await pool.query(
    `UPDATE chat_sessions SET check_phase = $3::text,
            -- The testing half's clock, as setChecksPending stamps it: the
            -- verdict's checking time is counted from it.
            checks_checked_at = CASE WHEN $3::text = 'testing' THEN NOW() ELSE checks_checked_at END
      WHERE id = $1 AND check_state = 'pending' AND checks_commit_sha IS NOT DISTINCT FROM $2::text`,
    [sessionId, commitSha || null, normalizeCheckPhase(phase)]);
  return write.rowCount !== 0;
}
const CHECK_PHASES = checkStore.CHECK_PHASES;
const normalizeCheckPhase = checkStore.normalizeCheckPhase;
const CHECK_TRIGGERS = checkStore.CHECK_TRIGGERS;
const normalizeCheckTrigger = checkStore.normalizeCheckTrigger;

// Expand the deduped capture-path list into the ordered capture targets:
// EVERY path is shot in BOTH the desktop frame (full media — png/webm/gif)
// and a phone-sized frame (PNG still only). Desktop and mobile land on
// adjacent capture indexes (i*2 / i*2+1) so the rendered rows pair up.
// This supersedes the per-path `@mobile` opt-in (#768): the annotation is
// still parsed and validated, but every route now gets the phone frame
// automatically. Pure so it's unit-testable without the pipeline.
//
// One entry per path, carrying the phone frame as a `companion`. It used to
// emit TWO sibling entries per path, which the container turned into two
// full navigations per side — a two-route proposal loaded 8 pages instead
// of 4 and paid a cold page + networkidle2 wait for each, the single
// biggest cost inside the capture run.
function expandCapturePaths(paths) {
  const out = [];
  (Array.isArray(paths) ? paths : []).forEach((path, i) => {
    out.push({
      index: i * 2,
      path,
      viewport: null,
      still: false,
      // The phone frame is a COMPANION of this target, not a target of its
      // own: the container shoots it by reloading the page it already has
      // open (see shootCompanion in capture/capture.js) instead of opening
      // a second one. Same capture indexes as before — i*2 desktop,
      // i*2+1 mobile — so every renderer, the PR-body block and
      // session_visuals.captured_viewport are untouched; only the number
      // of page loads changes (4 per two-route proposal, not 8).
      companion: { index: i * 2 + 1, viewport: VIEWPORT_MOBILE },
    });
  });
  return out;
}

// Extract a concise, human-readable reason from a staging build/boot failure
// (docker.waitForHealthy attaches containerLogs/containerStatus to the thrown
// error) for storage in check_error_detail + display in the merge gate, the
// proposal thread, and the checks badge tooltip. Prefers the most specific
// error line in the container's boot logs — the app's own crash message, e.g.
// a Postgres "no unique or exclusion constraint matching the ON CONFLICT
// specification" — and falls back to the container status / raw error
// message. Length-bounded so it fits a chat line and a tooltip.
// Implementation moved to services/deploy-failure.js (issue #416) so the
// production deploy paths (app-creator / staging.deployProduction) share
// the same error-line extraction; this thin delegate keeps the legacy
// string shape for check_error_detail consumers.
function summarizeBootFailure(err) {
  return require('./deploy-failure').summarizeBootFailure(err);
}

// Map the structured test result onto the legacy advisory console snapshot
// so the dual-written console_* columns stay coherent for one release.
//
// Advisory rows are skipped. The console snapshot's whole meaning is "the
// staging build is clean", and folding in errors from checks that have
// never been observed passing would report a long-broken tail route as if
// this proposal had dirtied the build.
function consoleSnapshotFromTests(result) {
  if (!result || result.state === 'error') return { state: 'unknown', errors: [] };
  const seen = new Set();
  const errors = [];
  for (const r of (result.results || [])) {
    if (r && r.advisory) continue;
    for (const e of (Array.isArray(r.consoleErrors) ? r.consoleErrors : [])) {
      const message = String((e && e.message) || '').slice(0, CONSOLE_MAX_MSG_LEN);
      if (!message || seen.has(message)) continue;
      seen.add(message);
      errors.push({ kind: e.kind || 'console', message, source: e.source || '' });
      if (errors.length >= CONSOLE_MAX_ERRORS) break;
    }
    if (errors.length >= CONSOLE_MAX_ERRORS) break;
  }
  return { state: errors.length ? 'errors' : 'clean', errors };
}

// ── Storage ────────────────────────────────────────────────────────────
// Client shape (#270): an ordered list of capture groups —
//   { captures: [ { index, path, viewport, before: {png,webm,gif}, after: {...} } ] }
// one group per captured route, ascending by capture_index; `viewport` is
// 'mobile' for a `@mobile`-annotated route (#768), null otherwise. A group
// is only kept when it has an "after" artifact (nothing to show otherwise).
// A single-route proposal yields a one-element list, so the common case is
// unchanged in substance — just wrapped. Renderers (pr-metadata.js,
// app-view.js) iterate `captures` and label each row with its `path`.

// Assemble rows ([{kind, media, capture_index, captured_path,
// captured_viewport, scenario_id, scenario_fingerprint, commit_hash, id}])
// into the ordered { captures: [...] } shape.
// Groups missing an "after" are dropped. Shared by storeArtifacts /
// getForSession / shapeAgg so all three surfaces emit byte-identical
// shapes. Each group's `viewport` is the label it was shot at ('mobile'
// for a `@mobile` path, #768) or null for the desktop default — pre-#768
// rows carry no viewport and land on null.
//
// When an expected commit is known, only rows tagged with that exact revision
// are eligible. Unknown-provenance legacy rows remain readable only to a
// caller that genuinely has no head to compare. This is the read gate that
// prevents yesterday's successful screenshots from representing a newer head
// whose capture is pending or failed.
function groupRows(rows, expectedCommit = null) {
  const input = Array.isArray(rows) ? rows : [];
  const current = expectedCommit
    ? input.filter((r) => sameSha(r.commit_hash || r.commitHash, expectedCommit))
    : input;
  const byIndex = new Map();
  for (const r of current) {
    const idx = Number.isInteger(r.index) ? r.index : (parseInt(r.capture_index, 10) || 0);
    let g = byIndex.get(idx);
    if (!g) {
      g = { index: idx, path: null, viewport: null, scenarioId: null, scenarioFingerprint: null };
      byIndex.set(idx, g);
    }
    if (!g[r.kind]) g[r.kind] = {};
    g[r.kind][r.media] = r.id;
    const p = r.path || r.captured_path;
    if (p && !g.path) g.path = p;
    const vp = r.viewport || r.captured_viewport;
    if (vp && !g.viewport) g.viewport = vp;
    const scenarioId = r.scenarioId || r.scenario_id;
    if (scenarioId && !g.scenarioId) g.scenarioId = scenarioId;
    const scenarioFingerprint = r.scenarioFingerprint || r.scenario_fingerprint;
    if (scenarioFingerprint && !g.scenarioFingerprint) g.scenarioFingerprint = scenarioFingerprint;
    // A "before" side actually shot at the fallback '/' — renderers caption
    // the pair so the mismatched comparison is explained.
    if (r.kind === 'before' && (r.before_fell_back || r.fellBack)) g.beforeFellBack = true;
  }
  const captures = [];
  for (const idx of Array.from(byIndex.keys()).sort((a, b) => a - b)) {
    const g = byIndex.get(idx);
    if (!g.after) continue; // nothing to show without an "after"
    captures.push({
      index: g.index, path: g.path || '/', viewport: g.viewport || null,
      before: g.before || null, after: g.after,
      ...(g.scenarioId ? { scenarioId: g.scenarioId } : {}),
      ...(g.scenarioFingerprint ? { scenarioFingerprint: g.scenarioFingerprint } : {}),
      // Only present when true so pre-existing shapes stay byte-identical.
      ...(g.beforeFellBack ? { beforeFellBack: true } : {}),
    });
  }
  return captures.length ? { captures } : null;
}

// Latest set per session only: each successful capture deletes the
// session's prior rows and inserts the fresh set inside one transaction.
// Growth is bounded at <= 8 artifacts per capture path (a full-media
// desktop group + a PNG-only mobile group); with CAPTURE_MAX_PATHS paths
// that's <= 24 rows/session ever. `targets` is the ordered capture target
// list ([{ index, path }]) so each row records its capture_index +
// captured_path (the group label). Each row also persists its shot's HTTP
// status and, for a "before", whether it fell back to '/'. `dropped`, when
// provided, collects { kind, media, index, bytes } for every over-cap
// artifact so the caller can persist WHY a recording is missing (the
// capture_detail snapshot) instead of only logging it. Returns the grouped
// shape, or null when nothing usable was stored (no group has an "after").
// Even a null outcome replaces the prior set: retaining an older successful
// capture after a failed re-shot is how stale evidence survived a revision.
// `hold` ({ runId }, the preview machine's checks run): the media go to
// check_run_media under the run's id instead, and the transition that
// settles the run publishes them to session_visuals with its verdict.
async function storeArtifacts(pool, sessionId, commitHash, targets, shots, dropped = null, hold = null,
  { store = mediaStore.getStore() } = {}) {
  const pathByIndex = new Map();
  const viewportByIndex = new Map();
  const scenarioByIndex = new Map();
  for (const t of (Array.isArray(targets) ? targets : [])) {
    pathByIndex.set(t.index, t.path);
    if (t.viewport) viewportByIndex.set(t.index, t.viewport);
    if (t.scenario) scenarioByIndex.set(t.index, t.scenario);
    // The automatic phone shot is emitted under the companion's odd index,
    // but it depicts the parent target's exact path/scenario at a mobile
    // viewport. Record that provenance explicitly instead of letting the
    // renderer mislabel every companion as an unscoped desktop '/'.
    if (t.companion && Number.isInteger(t.companion.index)) {
      pathByIndex.set(t.companion.index, t.path);
      viewportByIndex.set(t.companion.index, VIEWPORT_MOBILE);
      if (t.scenario) scenarioByIndex.set(t.companion.index, t.scenario);
    }
  }

  const rows = [];
  for (const s of shots) {
    if (s.buf.length > MAX_BYTES[s.media]) {
      log.warn('visuals', 'Artifact over size cap — dropped', {
        sessionId, kind: s.kind, media: s.media, bytes: s.buf.length, index: s.index,
      });
      if (Array.isArray(dropped)) {
        dropped.push({ kind: s.kind, media: s.media, index: s.index || 0, bytes: s.buf.length });
      }
      continue;
    }
    const index = Number.isInteger(s.index) ? s.index : 0;
    const scenario = scenarioByIndex.get(index) || null;
    rows.push({
      id: crypto.randomBytes(16).toString('hex'),
      index,
      capturedPath: pathByIndex.has(index) ? pathByIndex.get(index) : null,
      capturedViewport: viewportByIndex.get(index) || null,
      scenarioId: scenario?.id || null,
      scenarioFingerprint: scenario?.fingerprint || null,
      ...s,
    });
  }
  const hasAfter = rows.some((r) => r.kind === 'after');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializes replacement sets for a session, while keeping uploads and
    // their references in the existing transaction. Deletes lock old rows
    // before shared registry keys, keeping concurrent replacements ordered.
    await client.query('SELECT id FROM chat_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    if (hold) await client.query('DELETE FROM check_run_media WHERE run_id = $1', [hold.runId]);
    else await client.query('DELETE FROM session_visuals WHERE session_id = $1', [sessionId]);
    const kept = hasAfter ? rows : [];
    const keys = await mediaStore.putMany(client, store, kept.map((r) => ({ data: r.buf, contentType: CONTENT_TYPES[r.media] })));
    for (const [i, r] of kept.entries()) {
      const meta = visualMedia.metadata(r.buf);
      const values = [r.id, sessionId, commitHash || null, r.kind, r.media, CONTENT_TYPES[r.media], r.capturedPath || null, r.index, r.capturedViewport,
        Number.isInteger(r.status) && r.status > 0 ? r.status : null,
        r.kind === 'before' && !!r.fellBack,
        r.scenarioId, r.scenarioFingerprint];
      if (hold) {
        await client.query(
          `INSERT INTO check_run_media (id, session_id, commit_hash, kind, media, content_type, captured_path, capture_index, captured_viewport, shot_status, before_fell_back, scenario_id, scenario_fingerprint, run_id,
            object_key, sha256, bytes, legacy_etag)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [...values, hold.runId, keys[i], meta.sha256, meta.bytes, meta.legacyEtag]
        );
      } else {
        await client.query(
          `INSERT INTO session_visuals (id, session_id, commit_hash, kind, media, content_type, captured_path, capture_index, captured_viewport, shot_status, before_fell_back, scenario_id, scenario_fingerprint,
            object_key, sha256, bytes, legacy_etag)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [...values, keys[i], meta.sha256, meta.bytes, meta.legacyEtag]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (!hasAfter) return null;

  return groupRows(rows.map((r) => ({
    kind: r.kind, media: r.media, id: r.id, index: r.index,
    captured_path: r.capturedPath, captured_viewport: r.capturedViewport,
    scenario_id: r.scenarioId, scenario_fingerprint: r.scenarioFingerprint,
    commit_hash: commitHash || null,
    fellBack: r.fellBack,
  })));
}

// Shape a session's stored artifact ids for clients into the grouped
// { captures: [...] } form (ascending by capture_index). Used by GET
// /api/sessions/:id (history reloads) and exported for any other surface
// that wants the same shape. Pre-#270 rows all carry capture_index 0, so
// they collapse into a single legacy group — back-compatible by default.
async function getForSession(pool, sessionId, expectedCommit = null) {
  const { rows } = await pool.query(
    `SELECT id, kind, media, commit_hash, captured_path, capture_index, captured_viewport,
            before_fell_back, scenario_id, scenario_fingerprint
       FROM session_visuals WHERE session_id = $1`,
    [sessionId]
  );
  if (!rows.length) return null;
  return groupRows(rows, expectedCommit);
}

// Shape the jsonb_object_agg(...) form produced by the /promoted
// vote-panel query into the grouped client shape. The agg key is
// `kind_index_media` (#270); the legacy `kind_media` key (pre-#270 stored
// rows, or an older query) is also accepted, mapping to capture group 0.
// The agg VALUE is either a bare artifact id string (legacy query) or an
// object { id, path, viewport, commit, scenarioId, scenarioFingerprint,
// fellBack } (current query) — the object form carries the group label,
// frame, revision/scenario provenance, and before-fallback flag so the
// vote-panel tiles render only current, correctly labelled shots.
function shapeAgg(agg, expectedCommit = null) {
  if (!agg || typeof agg !== 'object') return null;
  const rows = [];
  for (const [key, val] of Object.entries(agg)) {
    const id = (val && typeof val === 'object') ? val.id : val;
    if (typeof id !== 'string' || !id) continue;
    const extra = (val && typeof val === 'object')
      ? {
        captured_path: val.path || null,
        captured_viewport: val.viewport || null,
        commit_hash: val.commit || null,
        scenario_id: val.scenarioId || null,
        scenario_fingerprint: val.scenarioFingerprint || null,
        fellBack: !!val.fellBack,
      }
      : {};
    let m = key.match(/^(before|after)_(\d+)_(png|webm|gif)$/);
    if (m) {
      rows.push({ kind: m[1], index: parseInt(m[2], 10) || 0, media: m[3], id, ...extra });
      continue;
    }
    m = key.match(/^(before|after)_(png|webm|gif)$/);
    if (m) rows.push({ kind: m[1], index: 0, media: m[2], id, ...extra });
  }
  return groupRows(rows, expectedCommit);
}

// ── PR body patch ──────────────────────────────────────────────────────
// Targeted text patch for the interactive ordering (PR exists before the
// capture finishes): fetch the live body, replace/append the
// marker-delimited block, write it back, and stamp pr_visuals_applied so
// the next applyPrMetadata turn sees an up-to-date snapshot.
async function patchPrBody(pool, session, repoOwner, repoName, block) {
  const pr = await github.getPR(repoOwner, repoName, session.pr_number);
  const body = pr.body || '';
  const next = prMetadata.upsertVisualsBlock(body, block);
  if (next !== body) {
    await github.updatePR(repoOwner, repoName, session.pr_number, { body: next });
  }
  // #1333. The body just changed, so the mirror get_proposal reports as
  // `description` moves with it — otherwise it goes stale the moment
  // screenshots land, which reads worse than the null it replaced. Written
  // whether or not GitHub needed the patch: `next` is the body either way,
  // and this is also how a row that predates the mirror heals.
  session.pr_body = next;
  await pool.query(
    `UPDATE chat_sessions SET pr_visuals_applied = $1, pr_body = $2 WHERE id = $3`,
    [block || null, next, session.id]
  );
}

async function clearPrVisuals(pool, session, repoOwner, repoName) {
  if (!session.pr_number || !repoOwner || !repoName || !github.isEnabled()) return;
  try {
    await patchPrBody(pool, session, repoOwner, repoName, '');
  } catch (err) {
    log.warn('visuals', 'Stale PR body visuals removal failed', {
      sessionId: session.id, pr: session.pr_number, err: err.message,
    });
  }
}

// Resolve the capture pixel density from an apps row (issue #360).
// 1 only when the app explicitly opted out via dapp.json's
// `screenshot.deviceScaleFactor: 1` (persisted on
// apps.screenshot_device_scale); everything else — including a missing
// row/column — defaults to 2× (HiDPI).
function resolveCaptureScale(row) {
  return row && row.screenshot_device_scale === 1 ? 1 : 2;
}

// #866: which git ref identifies this session's code in the app's OWN repo.
// Ordinary native rows push their work to a platform-owned branch, so the
// branch name resolves. Two sources require an immutable commit instead:
// imported PRs may be fork-headed (their branch name need not exist in the
// base repo), and native CLI handoffs allow the local checkout to push the
// managed branch directly while an older capture is running. Pin both to the
// recorded/build SHA so changed-file detection and dapp.json test discovery
// describe the same code as the staging container and terminal verdict.
function sessionGitRef(session, commitHash) {
  if (session && session.source === 'imported') {
    return session.imported_pr_head_sha || commitHash || null;
  }
  if (session && session.source === 'cli_handoff') {
    return commitHash || session.checks_commit_sha || session.handoff_head_sha || null;
  }
  return (session && session.branch_name) || null;
}

// Wait for the run's checks slot (services/checks-queue.js), saying so on
// the card while it waits. A run admitted at its first ask says nothing and
// goes straight on to 'testing'; one that has to wait is stamped 'queued',
// its build half is closed (the preview is up), and every change of its
// place in line is written to checks_progress.queue and broadcast, so the
// card can say "Waiting for a checks slot (2 ahead)".
//
// The run leaves the line without a verdict ('superseded') when the session
// stops waiting on this commit (a newer head, a closed session). A newer
// revision cancels the machine's work item, whose abort is thrown as usual.
// Never throws otherwise: the queue fails open.
async function waitForChecksSlot(pool, {
  session, commitHash, trigger, stagingResult, operation, runId,
}) {
  const { signal } = operation;
  let stamped = false;
  let firstAhead = null;
  // Until the row says 'queued' it may still read as it did before this run
  // (a forced re-run of a passing head): only then is "not pending on this
  // commit" a run nobody is waiting for.
  const stillWanted = async () => {
    if (!stamped) return true;
    const { rows } = await pool.query(
      'SELECT status, check_state, checks_commit_sha FROM chat_sessions WHERE id = $1', [session.id]);
    const row = rows[0];
    return !!row && ['active', 'paused', 'promoted', 'merging'].includes(row.status)
      && row.check_state === 'pending'
      && (row.checks_commit_sha || null) === (commitHash || null);
  };
  const onPosition = async ({ ahead, queuedAt }) => {
    if (!stamped) {
      stamped = true;
      firstAhead = ahead;
      log.info('visuals', 'Waiting for a checks slot', {
        sessionId: session.id, commitHash: commitHash || null, trigger, ahead,
      });
      await setChecksPhase(pool, session.id, commitHash, 'queued').catch((err) => {
        log.warn('visuals', 'setChecksPhase(queued) failed (non-fatal)', { sessionId: session.id, err: err.message });
      });
      notifyChecksPending(session.id, commitHash, 'queued', trigger);
      await finishPrepareChecks(pool, session, commitHash, stagingResult, trigger, 'queued');
    }
    const build = buildProgressFromTimings(stagingResult && stagingResult.timings);
    const since = queuedAt ? new Date(queuedAt) : null;
    const progress = {
      ...(build ? { build } : {}),
      queue: { ahead, since: since && Number.isFinite(since.getTime()) ? since.toISOString() : null },
    };
    if (await setChecksProgress(pool, session.id, commitHash, progress).catch(() => false)) {
      notifyChecksProgress(session.id, commitHash, progress, 'queued', trigger);
    }
  };
  const slot = await checksQueue.waitForSlot(pool, { runId, signal, stillWanted, onPosition });
  if (stamped) {
    log.info('visuals', slot.outcome === 'admitted' ? 'Checks slot granted' : 'Left the checks queue', {
      sessionId: session.id, commitHash: commitHash || null, outcome: slot.outcome,
      waitedMs: slot.waitedMs, failedOpen: slot.failedOpen || undefined,
    });
  }
  return { ...slot, waited: stamped, firstAhead };
}

// The preview machine's checks.run (src/workflow/preview/services.ts): run
// the checks for the attempt that serves and RETURN the settlement instead of
// storing it, as { outcome: 'verdict' | 'deferred' | 'blocked', ... }. The
// machine owns the seat, the verdict, the history, the follow-ups and when to
// run at all; the run's media go to check_run_media under the run's key,
// published with the verdict. `opts.workflow` is { runId, runKey, signal,
// unitRunId, queuedSince }: this claim's id (its Jobs and check_runs row),
// the work item's key, its lease's abort signal, the run id of the unit suite
// started with the attempt's build (preview services checks.unitEarly), read
// here when it is on the cluster, and the place in the checks queue an
// earlier claim of the run had. `trigger` names why this run started (see
// CHECK_TRIGGERS) and rides into the merge-debug trace.
async function captureForSession(config, session, app, commitHash, stagingResult, opts = {}) {
  const workflow = opts.workflow;
  if (!workflow) throw new Error('captureForSession runs only as the preview machine\'s checks.run');
  const operation = workflowOperation(workflow);
  const { trigger = null } = opts;
  const pool = getPool(config);

  // Per-run timing trace (kind='checks'). Nothing recorded how long a checks
  // run took, so diagnosing the slowdown that motivated this meant reading a
  // few hundred lines of container log before they rotated away. This is the
  // one chokepoint every verdict flows through, so the run is opened here and
  // the build half's phases are replayed from stagingResult.timings (absent
  // when the caller reused a live preview — then the trace is capture-only).
  // Best-effort throughout: merge-debug's helpers no-op on a null runId and
  // never throw, so tracing can't fail a capture.
  const runStartedAt = Date.now();
  const mergeDebug = require('./merge-debug');
  // #4696: a run that follows a build starts at the build (staging.js
  // timings.startedAt), so its time to a verdict (topic-figures.js
  // 'pipeline.checks-time') counts the build it waited for. A run on a live
  // preview has no build and starts now.
  const builtFrom = Number(stagingResult?.timings?.startedAt);
  const debugRunId = await mergeDebug.startRun(pool, {
    appId: app.id, sessionId: session.id, prNumber: session.pr_number || null,
    // Every run used to record trigger='capture' — the name of this function.
    // With the real trigger, the same trace query that measures re-run COUNT
    // can finally attribute it.
    kind: 'checks', trigger: normalizeCheckTrigger(trigger) || 'capture',
    startedAt: Number.isFinite(builtFrom) && builtFrom <= runStartedAt ? new Date(builtFrom) : null,
  });
  const traceStep = (phase, message, detail) =>
    mergeDebug.step(pool, debugRunId, { phase, message, detail });
  // Verdict the trace closes on. A checks run ends on its suite's outcome
  // ('passing' | 'failing' | 'skipped' | 'error') rather than a merge
  // outcome; 'error' is the default so a run that throws before reaching a
  // verdict is not left reading 'running' forever.
  let traceStatus = 'error';
  // Set once the run's progress state exists (see makeChecksProgressState);
  // a no-op until then so the catch below can always call it.
  let closeProgress = () => {};
  // The early unit suite this run reads, when it does (below).
  let earlyUnitRunId = null;
  // The run's identity on the cluster (services/check-runs.js): the work
  // item claim's run id, which labels its Jobs, so the retry of the item can
  // find THIS run's Jobs and nobody else's (check-harvest.collectForWorkflow).
  // The manifest and its heartbeat exist only where there is something to
  // collect: a Kubernetes Job outlives the process that created it, a docker
  // one-shot does not.
  const runId = operation.runId;
  const harvestable = config.captureRuntime === 'kubernetes';
  let stopHeartbeat = () => {};
  // True once the run is settled: its Jobs have nothing left to give.
  let settledRun = false;
  try {
    const buildTimings = (stagingResult && stagingResult.timings) || null;
    if (buildTimings) {
      if (buildTimings.sourceFetchMs != null) {
        // Everything before the image build: the shallow clone of the branch,
        // its submodules, and the manifest/secrets gating. It was the one leg
        // of the build half with no phase of its own, so its cost showed up
        // only as the gap between the run's start and its first step — which
        // is exactly where an unexplained regression hides.
        traceStep('source_fetch', 'Branch source fetched', { durationMs: buildTimings.sourceFetchMs });
      }
      if (buildTimings.imageBuildMs != null) {
        traceStep('image_build', 'Staging image built', { durationMs: buildTimings.imageBuildMs });
      }
      if (buildTimings.cloneMs != null) {
        // Historically the single largest phase of the whole run: a full
        // logical dump/restore of the app's database. See
        // db-manager.privateDataExclusions for what shrank it.
        traceStep('clone', 'Preview database cloned', {
          durationMs: buildTimings.cloneMs,
          // 'template' is the file-level copy of the app's staging template;
          // 'direct' is the dump/restore of the live database. The one that
          // also refreshed the template paid the direct cost this run.
          via: buildTimings.cloneVia || undefined,
          templateRefreshed: buildTimings.templateRefreshed || undefined,
        });
      }
      if (buildTimings.healthMs != null) {
        traceStep('staging_health', 'Preview answered its healthcheck', { durationMs: buildTimings.healthMs });
      }
    }
    const { owner: repoOwner, repo: repoName } = repoRef.ownerRepo(app.repo_url) || {};

    // A provisional manifest from the moment the run asks for its checks
    // slot (launched: false — there is no Job to read yet), so a retry of the
    // work item knows the run never got as far as its Jobs.
    //
    // The same row is the run's place in the checks queue
    // (services/checks-queue.js): the preview is built, and no Job exists
    // yet, so this is where the run waits for one of the few slots the
    // cluster runs at once. Its Jobs, and their deadlines, start once it has
    // one.
    if (harvestable) {
      const provisional = {
        runId, sessionId: session.id, commitSha: commitHash || null,
        manifest: { launched: false, trigger: trigger || null, debugRunId, startedAt: runStartedAt,
          workflow: true, runKey: workflow.runKey },
      };
      const place = checksQueue.isEnabled()
        ? await checksQueue.enqueue(pool, { ...provisional, queuedSince: workflow.queuedSince || null })
        : null;
      if (!place) await checkRuns.record(pool, provisional);
      stopHeartbeat = checkRuns.startHeartbeat(pool, runId);
      if (place) {
        const slot = await waitForChecksSlot(pool, {
          session, commitHash, trigger, stagingResult, operation, runId,
        });
        if (slot.waited) {
          traceStep('queue', 'Waited for a checks slot', {
            durationMs: slot.waitedMs, ahead: slot.firstAhead, outcome: slot.outcome,
            failedOpen: slot.failedOpen || undefined,
          });
        }
        if (slot.outcome === 'superseded') {
          // Nothing was started, so there is nothing to settle: the row
          // leaves the line in the finally below.
          traceStatus = 'superseded';
          settledRun = true;
          return { outcome: 'blocked', reason: 'The session stopped waiting on this commit before its checks started.' };
        }
      }
    }

    // Phase 'testing': the staging preview is already up by the time capture
    // starts, so everything from here is the suite running against it. (The
    // machine marked the checks 'pending' for this commit when it began.)
    await setChecksPhase(pool, session.id, commitHash, 'testing').catch((err) => {
      log.warn('visuals', 'setChecksPhase failed (non-fatal)', { sessionId: session.id, err: err.message });
    });
    // #607: flip open clients' badges to "Checks running…" right away —
    // the verdict can be minutes out.
    notifyChecksPending(session.id, commitHash, 'testing', trigger);
    // The build half is over: close its fifth step with the time the
    // hand-off took (and whether it was spent queued), and publish the
    // finished build so the card does not keep a step pulsing under
    // "Running the automated tests…" until the first test frame.
    await finishPrepareChecks(pool, session, commitHash, stagingResult, trigger);

    // Heuristic gate. It classifies a route-less proposal as either
    // intentionally console-only or missing visual coverage. An explicit
    // route or matching scenario is stronger evidence and triggers media
    // even when the changed-file heuristic would call the diff backend-only.
    let uiAffecting = true;
    let changedFiles = null;
    const gitRef = sessionGitRef(session, commitHash);
    if (github.isEnabled() && repoOwner && repoName && gitRef) {
      try {
        changedFiles = await github.listChangedFiles(
          repoOwner, repoName, `main...${gitRef}`
        );
        uiAffecting = isUiAffecting(changedFiles);
      } catch (err) {
        log.warn('visuals', 'Changed-file compare failed — visual scenarios cannot be matched', {
          sessionId: session.id, err: err.message,
        });
      }
    }

    // Fetch the branch manifest once, before choosing screenshot routes: its
    // normal checks still form the full CI suite, while visual:true checks
    // are also executable screenshot scenarios when their `impact` globs
    // overlap this diff.
    const declared = await resolveDeclaredTests(repoOwner, repoName, gitRef);
    const declaredTests = declared.tests;
    const capturePlan = deriveCapturePlan(session, declaredTests, changedFiles);
    const capturePaths = capturePlan.paths;
    const pathDefaulted = capturePlan.pathDefaulted;
    const captureRouteSource = capturePlan.routeSource;
    const visualScenarios = capturePlan.scenarios;
    const navigationPaths = capturePaths;
    // A UI change must declare its visible changes for before & after
    // shots. The run reports it; the preview machine tells the shots machine,
    // whose slot says a declaration is needed (src/workflow/shots/).
    if (config.shots?.collect && uiAffecting && opts.workflow?.report) {
      opts.workflow.report.uiAffecting = true;
    }
    // #381: the headless run ALWAYS happens so every proposal gets a
    // console-error check. Explicit routes and named scenarios are strong
    // evidence that media was requested even if the file heuristic misses the
    // UI. Otherwise preserve the prior behaviour: UI-affecting changes shoot
    // the app root, while backend-only changes stay console-only.
    const suppressLegacyMedia = await suppressLegacyMediaForSession(pool, config, session);
    const media = shouldCaptureMedia(uiAffecting, captureRouteSource, {
      suppressLegacyMedia,
    });
    if (captureRouteSource === 'default' && media) {
      log.info('visuals', 'No submitted route or matching visual scenario — defaulting capture to app root', {
        sessionId: session.id, ref: gitRef, captureRouteSource,
      });
    } else if (!media) {
      log.info('visuals', suppressLegacyMedia
        ? 'Legacy route media suppressed; checks continue'
        : 'No frontend files in commit range — console-only check', {
        sessionId: session.id, ref: gitRef, captureRouteSource,
        legacyMediaSuppressed: suppressLegacyMedia || undefined,
      });
    }

    await ensureCaptureImage();

    // Capture identity: sign every target visit as the seeded non-admin
    // usernode-capture user so screenshots show the real logged-in app
    // instead of the login screen. Strictly best-effort — a missing row
    // (migration not yet run) degrades to unauthenticated capture, never
    // a failed one. JWT payload mirrors /api/iframe-token (server.js):
    // child apps verify it in prod and staging, and the self-app staging
    // clone exchanges it for a local session via middleware/auth.js.
    let captureUser = null;
    let captureToken = '';
    try {
      const { rows } = await pool.query(
        'SELECT id, username, usernode_pubkey FROM users WHERE username = $1',
        [CAPTURE_USERNAME]
      );
      captureUser = rows[0] || null;
      if (captureUser) {
        captureToken = mintCaptureToken(captureUser, app.id, { previewOnly: app.slug === config.selfAppSlug });
      } else {
        log.warn('visuals', 'Capture user missing — capturing unauthenticated', {
          sessionId: session.id, username: CAPTURE_USERNAME,
        });
      }
    } catch (err) {
      log.warn('visuals', 'Capture user lookup failed — capturing unauthenticated', {
        sessionId: session.id, err: err.message,
      });
    }

    // #47: the proposal-checks ASSERTION suite signs its per-test
    // navigations as a separate VIEW-ONLY admin (usernode-capture-admin,
    // seeded in migrate.js) so the admin-only check routes (/admin,
    // /dashboard) render their gated content instead of "Admin access
    // required". Kept distinct from captureToken because test frames are
    // pass/fail + console errors only — never a published image — so this
    // admin visibility leaks nothing public, whereas the non-admin
    // captureToken still signs every screenshot. Degrades gracefully:
    // falls back to captureToken (then to unauthenticated when even that
    // is absent), never throws.
    let adminToken = '';
    try {
      const { rows } = await pool.query(
        'SELECT id, username, usernode_pubkey FROM users WHERE username = $1',
        [CAPTURE_ADMIN_USERNAME]
      );
      const adminUser = rows[0] || null;
      if (adminUser) {
        adminToken = mintCaptureToken(adminUser, app.id, { previewOnly: app.slug === config.selfAppSlug });
      } else {
        log.warn('visuals', 'Capture admin user missing — tests run as non-admin capture user', {
          sessionId: session.id, username: CAPTURE_ADMIN_USERNAME,
        });
      }
    } catch (err) {
      log.warn('visuals', 'Capture admin lookup failed — tests run as non-admin capture user', {
        sessionId: session.id, err: err.message,
      });
    }
    // Screenshots keep the non-admin token; tests prefer the admin token.
    const { screenshotToken, testsToken } = selectCaptureTokens({ captureToken, adminToken });

    const kubernetesCapture = config.captureRuntime === 'kubernetes';
    const stagingName = usableRuntimeName(stagingResult?.runtimeName)
      || usableRuntimeName(session.staging_runtime_name)
      || `usernode-staging-${app.slug}--${session.id}`;
    const isSelfApp = app.slug === config.selfAppSlug;
    // The "before" half is exposed the same way: apps.runtime_name was written
    // by the same deploy, so a production container deployed in that window
    // poisons the before-screenshot origin too.
    const prodName = usableRuntimeName(app.runtime_name) || beforeContainerName(config, app.slug);
    const prodRuntimeKind = app.runtime_kind || 'docker';
    const prodRunning = (await applicationRuntime.status(config, {
      runtimeKind: prodRuntimeKind, runtimeName: prodName,
    })) === 'running';
    // ── DNS-resolvable identities (#1381) ──
    //
    // Under the Kubernetes capture runtime the Service name is already
    // clamped to 63 by kubernetes.dnsName(), so that branch is untouched.
    // On docker, back-fill the short alias onto the LIVE containers first:
    // a re-check reuses a running preview rather than rebuilding it, so a
    // preview created before aliases existed would otherwise stay
    // unreachable until a new commit — which would clear its votes. This is
    // idempotent, costs one `docker inspect` on the overwhelmingly common
    // already-aliased path, and never throws.
    const stagingAlias = kubernetesCapture
      ? null
      : applicationRuntime.dnsAlias({ environment: 'staging', sessionId: session.id });
    const prodAlias = kubernetesCapture && prodRuntimeKind === 'kubernetes'
      ? null
      : applicationRuntime.dnsAlias({ environment: 'production', dockerName: prodName });
    const stagingAliasOk = stagingAlias
      ? await docker.ensureNetworkAlias(stagingName, stagingAlias)
      : false;
    const prodAliasOk = prodAlias && prodRunning
      ? await docker.ensureNetworkAlias(prodName, prodAlias)
      : false;
    const stagingHost = kubernetesCapture
      ? stagingName
      : dnsHostname(stagingName, stagingAlias, { aliasConfirmed: stagingAliasOk });
    const prodHost = kubernetesCapture && prodRuntimeKind === 'kubernetes'
      ? prodName
      : dnsHostname(prodName, prodAlias, { aliasConfirmed: prodAliasOk });
    const stagingOrigin = kubernetesCapture
      ? kubernetesCaptureOrigin(config, app, session.id)
      : `http://${stagingHost}:3000`;
    const prodOrigin = kubernetesCapture && prodRuntimeKind === 'kubernetes'
      ? kubernetesCaptureOrigin(config, app)
      : `http://${prodHost}:3000`;

    // Self-app "before" auth: the production platform never honours the
    // query token by design (replay protection — middleware/auth.js gates
    // the iframe-JWT path on USERNODE_ENV === 'staging'). For the self-app,
    // `pool` IS the platform's own DB, so mint ONE transient sessions-table
    // cookie for the capture user and reuse it across every before-path
    // (same origin, same TTL); deleted once in the finally below, with the
    // short expiry as the backstop if the process dies.
    let beforeCookie = '';
    let beforeSessionToken = '';
    if (media && prodRunning && isSelfApp && captureUser) {
      try {
        beforeSessionToken = crypto.randomBytes(32).toString('hex');
        await pool.query(
          'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
          [beforeSessionToken, captureUser.id, new Date(Date.now() + CAPTURE_AUTH_TTL_MS)]
        );
        beforeCookie = `session=${beforeSessionToken}`;
      } catch (err) {
        beforeSessionToken = '';
        log.warn('visuals', 'Capture session-cookie mint failed — "before" unauthenticated', {
          sessionId: session.id, err: err.message,
        });
      }
    }

    // One capture target per path (expandCapturePaths), each carrying the
    // phone frame as a companion still: the desktop frame gets the full
    // media set, the phone frame a PNG shot from the same reloaded page.
    // The "after" (staging) target always exists; the "before"
    // (prod) target only when prod is running. A newly-added deep page 404s
    // on prod, so each before-target falls back to '/' (capture.js retries
    // and tags the frames fellback=1) — "before" shows the prior root state
    // rather than an error page. Child-app prod verifies the query token
    // directly (scaffold middleware); the self-app uses the minted cookie.
    //
    // Self-app (#353): the visited path is normalised into a `#`-fragment
    // deep link so the hash-routed SPA renders the changed screen instead
    // of the home feed. For a fragment target the server pathname is
    // always '/', so prod never 404s on a deep page — the '/' fallback is
    // moot and skipped (the bare-'/' and standalone-page cases keep it).
    const targets = expandCapturePaths(navigationPaths).map((entry) => {
      const p = entry.path;
      const scenario = visualScenarios.find((item) => item.path === p) || null;
      const mobile = entry.viewport === VIEWPORT_MOBILE;
      const visitPath = isSelfApp ? selfAppHashPath(p) : p;
      const isFragmentTarget = visitPath.startsWith('/#');
      const afterUrl = withToken(`${stagingOrigin}${visitPath}`, screenshotToken);
      let beforeUrl = '';
      let beforeFallbackUrl = '';
      if (media && prodRunning) {
        if (isSelfApp) {
          beforeUrl = `${prodOrigin}${visitPath}`;
          if (p !== '/' && !isFragmentTarget) beforeFallbackUrl = `${prodOrigin}/`;
        } else {
          beforeUrl = withToken(`${prodOrigin}${visitPath}`, screenshotToken);
          if (p !== '/') beforeFallbackUrl = withToken(`${prodOrigin}/`, screenshotToken);
        }
      }
      return {
        index: entry.index, path: p, afterUrl, beforeUrl, beforeFallbackUrl,
        still: entry.still,
        viewport: mobile ? VIEWPORT_MOBILE : null,
        viewportPixels: mobile ? MOBILE_VIEWPORT : null,
        scenario,
        ready: scenario ? {
          expectSelector: scenario.expectSelector || '',
          expectText: scenario.expectText || '',
        } : null,
        // The phone-frame still shot from this target's own page. Same
        // capture index the sibling target used to carry, so the stored
        // artifact lands in exactly the same rendered row.
        companion: entry.companion
          ? { index: entry.companion.index, viewportPixels: MOBILE_VIEWPORT }
          : null,
        beforeCookie: (beforeUrl && isSelfApp) ? beforeCookie : '',
        // Plumbed for symmetry; unused today (the after side always
        // authenticates via the query token).
        afterCookie: '',
      };
    });

    // Pixel density for the shots (issue #360). Default 2× (HiDPI), with
    // a per-app 1× opt-out persisted on apps.screenshot_device_scale by
    // the deploy-time reconcile (app-manifest.reconcileAppScreenshot).
    // Read fresh from the DB so we don't depend on the width of the `app`
    // row the caller happened to pass; an unreadable/absent value falls
    // back to 2× (the capture container also defaults to 2× regardless).
    let deviceScaleFactor = 2;
    try {
      const { rows } = await pool.query(
        'SELECT screenshot_device_scale FROM apps WHERE id = $1', [app.id]
      );
      deviceScaleFactor = resolveCaptureScale(rows[0]);
    } catch (err) {
      log.warn('visuals', 'Screenshot-scale lookup failed — defaulting to 2×', {
        sessionId: session.id, err: err.message,
      });
    }

    // Which half of the run this head gets (services/check-admission.js). A
    // promoted head that conflicts with main is previewed and not judged:
    // no assertions, no unit suite, and the verdict below is a deferral
    // stamp rather than a state. Decided AFTER the tests are resolved so the
    // log line can say what was held back.
    const admission = await require('./check-admission').decide({
      pool, session, app, commitHash, trigger,
    });
    const shotsOnly = admission.mode === 'shots_only';
    if (shotsOnly) {
      log.info('visuals', 'Head conflicts with main — capturing the preview, deferring the verdict', {
        sessionId: session.id, commitHash: commitHash || null, trigger,
        declaredTests: declaredTests.length,
        conflictPaths: (admission.measured && admission.measured.conflictPaths || []).slice(0, 5),
      });
      traceStep('admission', 'Verdict deferred: the head conflicts with main', {
        reason: admission.reason, declaredTests: declaredTests.length,
      });
    }

    const tests = (shotsOnly ? [] : (declaredTests.length
      ? declaredTests
      : navigationPaths.map((p) => ({ name: `Loads ${p}`, path: p, expectSelector: '', expectText: '', allowConsoleErrors: false }))
    )).map((t, index) => {
      const visitPath = isSelfApp ? selfAppHashPath(t.path) : t.path;
      return {
        index,
        name: t.name,
        path: t.path,
        // Tests sign as the view-only-admin so admin-gated check routes
        // render; screenshots (TARGETS) keep the non-admin captureToken.
        // A guest check is the exception: no token at all, so it is really
        // signed out.
        url: checkVisitUrl(stagingOrigin, visitPath, testsToken, t.persona),
        expectSelector: t.expectSelector || '',
        expectText: t.expectText || '',
        // Opt-in, like the load bits below: a signed-out check and a check
        // that loads its page more than once each get their own browser
        // (capture.js groupTests), and the runner judges every load.
        ...(t.persona === 'guest' ? { persona: 'guest' } : {}),
        ...(t.repeat > 1 ? { repeat: t.repeat } : {}),
        allowConsoleErrors: !!t.allowConsoleErrors,
        // How capture.js groupTests loads its page, from the app's
        // `bootParams` / `routingBoundaries` against the address visited:
        // `coldLoad` (a load of its own) and `endsGroup` (nothing is
        // switched to after it). Neither is ever a check's own setting.
        ...appManifest.checkLoadFlags(visitPath, declared.loadRules),
      };
    });

    // Earned gating (#1019). Every declared check runs on every build, but a
    // check only BLOCKS the merge once this app has been observed passing it
    // — otherwise switching a long-neglected tail of checks on would block
    // the next proposal on hundreds of failures it did not cause.
    //
    // The SYNTHESIZED baseline suite (no declared tests) is exempt: it keeps
    // the pre-#1019 all-blocking semantics, because it is one "loads without
    // console errors" check per capture path and has always gated.
    let dispatched = null;
    if (declaredTests.length && !shotsOnly) {
      try {
        // First run for this app pre-graduates the head the merge gate used
        // to enforce, so turning this on never OPENS a gate that was closed.
        await checkHistory.bootstrapIfEmpty(pool, app.id, declaredTests);
        const passedOnce = await checkHistory.loadGraduated(pool, app.id, { sessionId: session.id });
        // Cosmetic, and loaded beside the gating set so it costs one more
        // query per run rather than one per check. A check with no failures
        // in its whole history is simply absent from the map.
        const flakes = await checkHistory.loadFlakeRates(pool, app.id);
        // A check absent from this has never run against this app, so this
        // run is its first. Null means the read failed, and then nothing is
        // treated as new: an unreadable history must not turn every check
        // in the suite into three.
        const seen = await checkHistory.loadSeen(pool, app.id);
        dispatched = tests.map((t) => {
          const key = appManifest.checkKey(t.name, t.path);
          const flake = flakes.get(key);
          const firstRun = !!seen && !seen.has(key);
          return {
            index: t.index, checkKey: key, name: t.name, path: t.path,
            // A declared check blocks. The one exception is the legacy
            // backlog: seen before, never once passing. Those are
            // unfinished rather than broken-by-this-proposal, and they earn
            // their gate by passing once. Nothing new can enter that state,
            // because a new check has to pass its first runs to land.
            graduated: passedOnce.has(key) || firstRun,
            firstRun,
            flakeRate: (flake && flake.rate != null) ? flake.rate : null,
          };
        });
        // The first-appearance repeats. Each is its own dispatch entry with
        // its own index and its own cold load (`solo`), and each reports a
        // real verdict — a check that passes twice and fails once on its
        // debut has told everyone something worth knowing before it ever
        // gates a stranger's proposal.
        const extras = [];
        for (const d of dispatched) {
          if (!d.firstRun) continue;
          // A check that loads its page its own several times (`repeat`)
          // is already making the debut observations this exists for: ONE
          // verdict from N loads, every one of which has to pass. Three
          // more dispatches of it would be N×3 pages and no new answer.
          const base = tests[d.index];
          if (Number(base && base.repeat) > 1) continue;
          for (let i = 1; i < checkHistory.NEW_CHECK_RUNS; i++) extras.push(d);
        }
        for (const d of extras.slice(0, checkHistory.MAX_NEW_CHECK_REPEATS)) {
          const base = tests[d.index];
          if (!base) continue;
          const index = tests.length;
          tests.push({ ...base, index, solo: true });
          dispatched.push({ ...d, index, repeatOf: d.index, solo: true });
        }
        if (extras.length) {
          log.info('visuals', 'First-appearance repeats dispatched', {
            sessionId: session.id,
            newChecks: dispatched.filter((d) => d.firstRun && !d.repeatOf).length,
            extraLoads: Math.min(extras.length, checkHistory.MAX_NEW_CHECK_REPEATS),
          });
        }
      } catch (err) {
        log.warn('visuals', 'Check-history lookup failed — legacy gating for this run', {
          sessionId: session.id, err: err.message,
        });
        dispatched = null;
      }
    }

    // Live progress. Two containers report into ONE snapshot: the capture
    // run's per-check frames (the tracker dedupes them by index) and the
    // unit suite's TAP lines (its own tracker, under `unit`). Both observers
    // see stdout as it streams; persist and broadcast are throttled to one
    // snapshot per second, with a done sentinel always flushed. Every step
    // is best-effort and swallowed: the verdict below is still read from
    // the whole stdout. `closeProgress` is called before the verdict is
    // written so a late timer can never broadcast 'pending' after it.
    // How many browser pods this run's checks are split across.
    const captureShards = kubernetesCapture && !(shotsOnly && !media)
      && tests.length >= CAPTURE_SHARD_MIN_TESTS ? captureShardCount() : 1;
    const progress = makeChecksProgressState({
      expected: tests.length,
      shards: captureShards,
      // The build half, finished, rides every testing-half snapshot.
      build: buildProgressFromTimings(stagingResult && stagingResult.timings),
      flush: async (snap) => {
        if (operation.signal.aborted) return;
        try {
          await setChecksProgress(pool, session.id, commitHash, snap);
          await operation.check();
        } catch { return; }
        notifyChecksProgress(session.id, commitHash, snap, 'testing', trigger);
      },
    });
    closeProgress = progress.close;
    const progressObserver = progress.observeCapture;

    // The unit suite started with this attempt's build, when its Jobs are on
    // the cluster: read rather than run again. A deferred verdict runs no
    // suite; the attempt's retirement stops it.
    earlyUnitRunId = !shotsOnly && workflow.unitRunId && config.workerRuntime === 'kubernetes'
      ? await kubernetes.findCheckJobs(config, { sessionId: session.id, previewRunId: workflow.unitRunId })
        .then((jobs) => ((jobs.unitSuites && jobs.unitSuites.length) || jobs.unitSuite ? workflow.unitRunId : null))
        .catch(() => null)
      : null;
    // Or no suite at all: this commit already passed it under the same
    // conditions, and nobody asked for a fresh run (services/unit-suite-
    // reuse.js). The pass is copied, marked as reused, and the run settles
    // as soon as the browser checks are done.
    let reusedUnit = null;
    if (!shotsOnly && !earlyUnitRunId) {
      reusedUnit = await unitSuite.reusablePass({
        config, pool, appId: app.id, sessionId: session.id, repoOwner, repoName, commitSha: commitHash, trigger,
      });
      if (reusedUnit) {
        log.info('visuals', 'Reusing an earlier unit-suite pass of this commit', {
          sessionId: session.id, commitHash, trigger, from: reusedUnit.reused,
        });
        traceStep('unit_suite', 'Unit suite reused from an earlier pass of this commit', reusedUnit.reused);
        progress.observeUnit(reusedUnit.snapshot);
      }
    }

    // The full manifest, written before either Job exists: everything the
    // verdict needs that the Jobs' own output does not carry, so a process
    // that dies from here on leaves a run the work item's retry can settle
    // (check-harvest.collectForWorkflow → settleCaptureRun). The capture
    // targets are recorded without their URLs — those embed the capture
    // tokens, and storeArtifacts wants only the index, path and frame.
    if (harvestable) {
      await checkRuns.record(pool, {
        runId, sessionId: session.id, commitSha: commitHash || null,
        manifest: {
          launched: true,
          trigger: trigger || null,
          debugRunId,
          startedAt: runStartedAt,
          shotsOnly,
          admissionReason: admission.reason || null,
          media,
          legacyMediaSuppressed: suppressLegacyMedia,
          capturePaths,
          pathDefaulted,
          captureRouteSource,
          visualScenarios,
          prodRunning,
          stagingOrigin,
          targets: targets.map((t) => ({
            index: t.index, path: t.path, still: t.still || undefined,
            viewport: t.viewport || undefined, companion: t.companion || undefined,
            scenario: t.scenario || undefined, ready: t.ready || undefined,
          })),
          testsCount: tests.length,
          dispatched,
          ceilingDropped: Number(declared.ceilingDropped) || 0,
          build: buildProgressFromTimings(stagingResult && stagingResult.timings),
          captureShards,
          // Where a collect finds the unit suite when it is the early one.
          ...(earlyUnitRunId ? { unitRunId: earlyUnitRunId } : {}),
          // Or the pass it copied instead of running one: a collect stores
          // the same row, and looks for no unit-suite Job.
          ...(reusedUnit ? { unitReused: { row: reusedUnit.row, earned: reusedUnit.earned || null, snapshot: reusedUnit.snapshot } } : {}),
          workflow: true,
          runKey: workflow.runKey,
        },
      });
      // This run is now the one the session waits on. The Jobs of its runs
      // for another commit, still going on the cluster, are read by nobody:
      // stop them before this run's own Jobs ask for the same capacity.
      await require('./check-harvest').stopSupersededRuns(config, pool, {
        sessionId: session.id, runId, commitSha: commitHash || null,
      });
    }

    // Repo unit suite (aggregate `npm test` check). Launched BEFORE the
    // capture container and awaited after it, so the suite runs in its own
    // one-shot container CONCURRENTLY with the browser checks and adds
    // ~zero wall clock unless it outlasts the whole capture run. Usually it
    // is already running, started with the preview build (earlyUnitRunId);
    // one that cannot be read is run again here. It tests the head itself,
    // not the branch that may have moved since, and a suite whose runner
    // broke is a run that could not say (below), never a run without its
    // suite.
    const ownUnitSuite = () => unitSuite.maybeRunUnitSuite({
      config, pool, appId: app.id, sessionId: session.id,
      repoOwner, repoName, ref: commitHash || gitRef,
      prNumber: Number(session.pr_number) || null,
      onProgress: progress.observeUnit,
      signal: operation.signal, previewRunId: runId,
      // The commit it judges: a pass is recorded for reuse
      // (services/unit-suite-reuse.js) when every Job checked out exactly it.
      commitSha: commitHash,
      strict: true,
    });
    const unitSuitePromise = (shotsOnly ? Promise.resolve(null) : reusedUnit
      ? Promise.resolve({ row: reusedUnit.row, history: null, earned: reusedUnit.earned || null }) : earlyUnitRunId
      ? unitSuite.collectUnitSuite({
        config, pool, appId: app.id, sessionId: session.id, previewRunId: earlyUnitRunId,
        onProgress: progress.observeUnit, signal: operation.signal,
      }).then((outcome) => outcome || ownUnitSuite())
      : ownUnitSuite()).catch((err) => {
      log.warn('visuals', 'Unit-suite check failed to run', {
        sessionId: session.id, err: err.message,
      });
      return { runnerFailed: String(err.message || 'the unit suite could not run').slice(0, 300) };
    });

    log.info('visuals', 'Starting capture', {
      sessionId: session.id, slug: app.slug, before: media && prodRunning,
      paths: capturePaths, pathDefaulted, captureRouteSource,
      visualScenarios: visualScenarios.map((scenario) => scenario.id), targets: targets.length,
      authenticated: !!captureToken, selfApp: isSelfApp, deviceScaleFactor, media,
      tests: tests.length, declaredTests: declaredTests.length,
      blocking: dispatched ? dispatched.filter((d) => d.graduated).length : tests.length,
      deferred: shotsOnly || undefined,
    });
    let stdout;
    let captureStderr = '';
    let runPartial = false;
    let runPartialReason = '';
    let notStarted = [];
    const captureStartedAt = Date.now();
    try {
      // #47 payload routing: a Linux exec caps any single argv/env string at
      // 128KB (MAX_ARG_STRLEN). A manifest-scale suite — this repo's own 232
      // checks, each carrying a tokenized staging URL — exceeds that as one
      // `-e TESTS=...` string, and the docker spawn dies with E2BIG before
      // the container starts (that was every self-app proposal fail-closing
      // to "Checks couldn't run"). Large suites ride the container's stdin
      // instead (TESTS='@stdin' marker; docker.runOneShot pipes it); small
      // ones keep the env var, which older capture images also understand.
      const testsJson = JSON.stringify(tests);
      const testsViaStdin = testsJson.length > 90 * 1024;
      let res;
      const captureEnv = {
          // Multi-target protocol (#270). The container loops over these
          // sequentially and tags each shot frame with its index=. The
          // optional per-target `viewport` (#768) is the resolved pixel
          // frame ({ width, height }) for a `@mobile` path; absent →
          // the container's desktop default. An older capture image
          // ignores the extra field (desktop shot) — graceful rolling
          // deploy, same stance as the scalar fallback below.
          TARGETS: JSON.stringify(targets.map((t) => ({
            index: t.index,
            beforeUrl: t.beforeUrl,
            afterUrl: t.afterUrl,
            beforeFallbackUrl: t.beforeFallbackUrl,
            beforeCookie: t.beforeCookie,
            afterCookie: t.afterCookie,
            viewport: t.viewportPixels || undefined,
            // A named visual scenario reuses its declared check assertions
            // as a readiness barrier. The capture image only applies this
            // to staging (`after`); production may legitimately predate the
            // feature and must remain photographable.
            ready: t.ready || undefined,
            // PNG-only phone-frame companion (no recording). An older
            // capture image ignores the field and records anyway —
            // graceful rolling deploy, same stance as `viewport`.
            still: t.still || undefined,
            // The phone-frame still this target shoots from its own page.
            // An older capture image ignores the field, which costs the run
            // its mobile stills for one rolling deploy but breaks nothing —
            // same stance as `viewport` / `still` above.
            companion: t.companion
              ? { index: t.companion.index, viewport: t.companion.viewportPixels }
              : undefined,
          }))),
          // Scalar single-target fallback (first target) so an older
          // capture image still works during a rolling platform deploy.
          BEFORE_URL: targets[0].beforeUrl,
          AFTER_URL: targets[0].afterUrl,
          BEFORE_FALLBACK_URL: targets[0].beforeFallbackUrl,
          BEFORE_COOKIE: targets[0].beforeCookie,
          AFTER_COOKIE: '',
          // Pixel density (#360). Global to the run — all of a proposal's
          // screens share one density, matching the single shared viewport.
          DEVICE_SCALE_FACTOR: String(deviceScaleFactor),
          // #381: MEDIA=0 → console-only run (no screenshots/recordings,
          // no prod "before"). The console-error check still runs.
          MEDIA: media ? '1' : '0',
          // #47: the proposal's automated test suite (each entry pre-resolved
          // to a staging url + assertions). The container runs these and
          // emits one __USERNODE_TEST__ frame each. '@stdin' → the real
          // payload is on stdin (see testsViaStdin above).
          TESTS: testsViaStdin ? '@stdin' : testsJson,
          // Pool bounds (#1019). An older capture image ignores all three
          // and runs the suite sequentially — slower, but correct, so a
          // rolling deploy degrades rather than breaks.
          TEST_CONCURRENCY,
          TEST_TIMEOUT_MS,
          TESTS_DEADLINE_MS,
          // The checks' own density, 1× (capture.js TEST_DEVICE_SCALE_FACTOR).
          TEST_DEVICE_SCALE_FACTOR: CAPTURE_TEST_DEVICE_SCALE,
      };
      if (shotsOnly && !media) {
        // A deferred verdict on a range with no frontend files: no
        // assertions to run and no screens to shoot, so there is nothing
        // for the container to do. The stamp below still lands.
        stdout = '';
        res = { partial: false };
      } else if (kubernetesCapture && captureShards > 1) {
        ({ stdout, ...res } = await runCaptureShards(config, {
          shards: captureShards, tests, env: captureEnv, onStdoutLine: progressObserver,
          signal: operation.signal, previewRunId: runId, sessionId: session.id,
        }));
      } else if (kubernetesCapture) {
        ({ stdout, ...res } = await kubernetes.runCaptureJob(config, {
          onStdoutLine: progressObserver,
          memory: CAPTURE_MEMORY,
          cpus: CAPTURE_CPUS,
          signal: operation.signal, previewRunId: runId,
          sessionId: session.id,
          env: captureEnv,
          stdinPayload: testsViaStdin ? testsJson : null,
          timeoutMs: RUN_TIMEOUT_MS,
          maxBuffer: RUN_MAX_BUFFER,
          salvagePartial: true,
        }));
      } else {
        ({ stdout, ...res } = await docker.runOneShot(`usernode-capture-${session.id}`, {
          onStdoutLine: progressObserver,
          image: CAPTURE_IMAGE,
          env: captureEnv,
          stdinPayload: testsViaStdin ? testsJson : null,
          // Eight concurrent Chromium pages need materially more than the
          // 1g/1cpu one-shot default.
          memory: CAPTURE_MEMORY,
          cpus: CAPTURE_CPUS,
          timeoutMs: RUN_TIMEOUT_MS,
          maxBuffer: RUN_MAX_BUFFER,
        // Improvement 5: the output protocol is a stream of independently
        // parseable frames, so a run killed at RUN_TIMEOUT_MS still carries
        // every frame it already emitted. Salvage them instead of losing the
        // whole proposal's screenshots to one slow page.
          salvagePartial: true,
        }));
      }
      runPartial = !!res.partial;
      runPartialReason = res.partialReason || '';
      captureStderr = res.stderr || '';
      notStarted = Array.isArray(res.notStarted) ? res.notStarted
        : [captureNotStarted({ res: { ...res, stdout } })].filter(Boolean);
      if (runPartial) {
        log.warn('visuals', 'Capture run cut short — parsing partial output', {
          sessionId: session.id, reason: runPartialReason,
        });
      }
    } finally {
      if (beforeSessionToken) {
        await pool.query('DELETE FROM sessions WHERE token = $1', [beforeSessionToken])
          .catch((err) => log.warn('visuals', 'Capture session-cookie cleanup failed', {
            sessionId: session.id, err: err.message,
          }));
      }
    }

    const captureMs = Date.now() - captureStartedAt;
    traceStep('capture', 'Capture container finished', {
      durationMs: captureMs,
      targets: targets.length, tests: tests.length, media,
      partial: runPartial || undefined,
      partialReason: runPartialReason || undefined,
    });

    await operation.check();
    // The unit-suite container started before the capture run; by now it
    // has usually been finished for minutes. Its own timeoutMs bounds this
    // await, and the .catch at launch made rejection impossible.
    const unitOutcome = await unitSuitePromise;
    closeProgress();
    await operation.check();
    if (unitOutcome?.runnerFailed) throw new Error(`The unit suite could not run: ${unitOutcome.runnerFailed}`);

    // Everything from here is the settlement — shared with the work item's
    // retry, which runs it on a Job whose launching process died. One code
    // path for the verdict, whoever reads the output.
    const settled = await settleCaptureRun(config, pool, {
      session, app, commitHash, traceStep, runStartedAt,
      shotsOnly, admissionReason: admission.reason,
      media, legacyMediaSuppressed: suppressLegacyMedia, capturePaths, pathDefaulted, captureRouteSource,
      visualScenarios,
      prodRunning, stagingOrigin, targets,
      testsCount: tests.length, dispatched, ceilingDropped: declared.ceilingDropped,
      stdout, stderr: captureStderr, runPartial, runPartialReason, unitOutcome, notStarted,
      collect: { runId: workflow.runKey },
    });
    traceStatus = settled.traceStatus;
    settledRun = true;
    return settled.result;
  } catch (err) {
    closeProgress();
    if (operation.signal.aborted) {
      traceStatus = 'superseded';
      throw operation.signal.reason || err;
    }
    // The run broke before a verdict: the machine records an 'error' with
    // this reason, and its error lane runs it again. A Job the API refused
    // or lost, or a Pod that never started, is the platform's fault and says
    // so (check-pod-start.js).
    traceStep('capture_error', 'Checks run threw', { error: err.message, level: 'error' });
    const fault = require('./check-pod-start').checkStartFault(err);
    return fault
      ? { outcome: 'blocked', reason: require('./check-pod-start').browserNotRunSentence(fault), platformFault: true }
      : { outcome: 'blocked', reason: captureFailureDetail({ stdout: err.stdout, stderr: err.stderr, fallbackReason: err.message }) };
  } finally {
    // Close the timing trace whatever happened, so a run never sits at
    // 'running' in the admin view. The total is the figure this exists for:
    // it is what "the checks step got slower" is measured in.
    const totalMs = Date.now() - runStartedAt;
    mergeDebug.endRun(pool, debugRunId, {
      status: traceStatus,
      summary: `checks ${traceStatus} in ${Math.round(totalMs / 1000)}s`,
    });
    stopHeartbeat();
    // A run that did not settle keeps its row: the retry of its work item
    // collects its Jobs by it, and the machine's cancel clears it.
    if (harvestable && settledRun) await checkRuns.finish(pool, runId);
    // ...and so do its Jobs, once it settled: with the row gone nothing will
    // read them, and the Job TTL would hold the worker namespace's Job slots
    // for another hour. A run that ended any other way keeps its Jobs for
    // whoever cancels them, and the TTL.
    if (harvestable && settledRun) releaseCheckJobs(config, session.id, runId);
    if (harvestable && settledRun && earlyUnitRunId) releaseCheckJobs(config, session.id, earlyUnitRunId);
  }
}

// What captureForSession reads from the machine's work item: the abort
// signal its lease renewal fires (a cancelled or lost item), and its run id.
// The run writes only its progress and its media's holding rows.
function workflowOperation(workflow) {
  const { signal, runId } = workflow;
  return {
    runId, signal,
    check: async () => {
      if (signal.aborted) throw signal.reason || new Error('The checks run was cancelled');
    },
  };
}

// The tests as a capture Job takes them: inline when small, through its
// input Secret (TESTS='@stdin') when not (see the #47 note in
// captureForSession).
function captureTestsInput(tests) {
  const json = JSON.stringify(tests);
  return json.length > 90 * 1024 ? { TESTS: '@stdin', stdinPayload: json } : { TESTS: json, stdinPayload: null };
}

// One run's browser checks across `shards` capture Jobs at once (see
// CAPTURE_SHARDS above). Shard 0 carries the screenshots; the rest run
// checks only. Resolves the shape runCaptureJob does, with the shards'
// output joined in shard order. Any declared check no shard reported, when
// none of them ran out of time, is run once more in a sweep Job, which also
// takes the screenshots when shard 0 is what was lost. A cancelled run
// throws its signal's reason; a sweep that cannot run throws, as a single
// capture Job that could not run always has.
async function runCaptureShards(config, {
  shards, tests, env, onStdoutLine = null, signal = null, previewRunId = null, sessionId,
  runJob = (opts) => kubernetes.runCaptureJob(config, opts),
}) {
  const { TESTS: _tests, ...rest } = env;
  const base = { ...rest, TEST_CONCURRENCY: CAPTURE_SHARD_CONCURRENCY };
  const checksOnly = {
    ...base, TARGETS: '[]', BEFORE_URL: '', AFTER_URL: '', BEFORE_FALLBACK_URL: '',
    BEFORE_COOKIE: '', AFTER_COOKIE: '', MEDIA: '0',
  };
  const input = captureTestsInput(tests);
  const common = {
    onStdoutLine, memory: CAPTURE_MEMORY, cpus: CAPTURE_CPUS, cpuRequest: CAPTURE_SHARD_CPU_REQUEST,
    signal, previewRunId, sessionId, timeoutMs: RUN_TIMEOUT_MS, maxBuffer: RUN_MAX_BUFFER, salvagePartial: true,
  };
  const settled = await Promise.allSettled(Array.from({ length: shards }, (_, shard) => runJob({
    ...common,
    env: { ...(shard === 0 ? base : checksOnly), TESTS: input.TESTS,
      TEST_SHARD_INDEX: String(shard), TEST_SHARD_COUNT: String(shards) },
    stdinPayload: input.stdinPayload,
    shard, nameSuffix: shard === 0 ? null : `k${shard}`,
  })));
  signal?.throwIfAborted();
  const outs = [];
  const lost = [];
  // Shards that reported nothing because their Pod never started (#5054):
  // the settle step reads them when the run is left with checks missing.
  const notStarted = [];
  settled.forEach((r, shard) => {
    if (r.status === 'fulfilled') outs.push(r.value || {});
    else lost.push({ shard, err: r.reason });
    const never = r.status === 'fulfilled' ? captureNotStarted({ res: r.value, shard }) : captureNotStarted({ err: r.reason, shard });
    if (never) notStarted.push(never);
  });
  let stdout = outs.map((o) => String(o.stdout || '')).join('\n');
  const stderr = outs.map((o) => String(o.stderr || '')).filter(Boolean).join('\n');
  let partial = outs.some((o) => o.partial);
  const reasons = outs.map((o) => o.partialReason).filter(Boolean);
  const reported = reportedTestIndexes(stdout);
  const missing = tests.filter((t) => !reported.has(t.index));
  const outOfTime = !!(parseTestsDone(stdout) || {}).deadline;
  if (lost.length || (missing.length && !outOfTime)) {
    const mediaLost = lost.some((l) => l.shard === 0);
    log.warn('visuals', 'Browser-check shards came back short; running the rest once more', {
      sessionId, shards, lost: lost.map((l) => ({ shard: l.shard, err: String(l.err && l.err.message || l.err).slice(0, 200) })),
      missing: missing.length, outOfTime, retakingShots: mediaLost,
    });
    const sweepInput = captureTestsInput(missing);
    const sweep = await runJob({
      ...common,
      env: { ...(mediaLost ? base : checksOnly), TESTS: sweepInput.TESTS, TEST_RETRY_SLOT: String(shards) },
      stdinPayload: sweepInput.stdinPayload,
      shard: shards, nameSuffix: 'r',
    });
    stdout = `${stdout}\n${String(sweep.stdout || '')}`;
    partial = partial || !!sweep.partial;
    if (sweep.partialReason) reasons.push(sweep.partialReason);
    // The sweep ran the lost checks: a shard it covered is no longer the
    // reason anything is missing. One it did not cover still is, and so is
    // a sweep that never started itself.
    const reportedAfter = reportedTestIndexes(stdout);
    if (tests.every((t) => reportedAfter.has(t.index))) notStarted.length = 0;
    else {
      const never = captureNotStarted({ res: sweep, shard: shards });
      if (never) notStarted.push(never);
    }
  }
  return { stdout, stderr, partial, partialReason: [...new Set(reasons)].join('; '), shards, notStarted };
}

// A capture Job, or one shard of one, that reported no check because its Pod
// never started its container or was evicted (check-pod-start.js), as
// `{ shard, lead, cause }`, or null. `res` is what the Job resolved (a
// partial result carries its podStart), `err` what it threw.
function captureNotStarted({ res = null, err = null, shard = 0 } = {}) {
  const podStart = require('./check-pod-start');
  const fault = err ? podStart.checkStartFault(err)
    : (res && res.partial ? podStart.podStartCause(res.podStart) : null);
  if (!fault) return null;
  const said = err ? err.stdout : res.stdout;
  return reportedTestIndexes(String(said || '')).size ? null : { shard, ...fault };
}

// Best-effort and detached: a Job left behind still goes with its TTL.
function releaseCheckJobs(config, sessionId, runId) {
  kubernetes.deleteSettledCheckJobs(config, { sessionId, previewRunId: runId })
    .catch((err) => log.warn('visuals', 'Settled check Jobs not deleted; their TTL will', {
      sessionId, runId, err: err.message,
    }));
}

// Everything after the containers have ended: parse the frames, take the
// verdict, hold the media. Split from captureForSession so the retry of a
// machine's work item (check-harvest.collectForWorkflow) can run exactly this
// on a Job whose launching process died — same code, same order. Nothing is
// stored here but the media's holding rows (check_run_media, under
// `collect.runId`): the settlement is returned, for the machine to store in
// one transaction.
//
// `run` is the launch-time context a live run has in scope and a collect
// reads back from the check_runs manifest: the session, app, commit and
// trigger; the capture geometry (media, targets, capturePaths, pathDefaulted,
// captureRouteSource, visualScenarios, prodRunning,
// stagingOrigin); the dispatch (testsCount, dispatched,
// ceilingDropped); the admission (shotsOnly, admissionReason); the output
// (stdout, runPartial, runPartialReason); and the unit-suite outcome, already
// awaited. `traceStep` is the live run's; a collect passes a no-op. Returns
// { traceStatus, result }: the verdict the run's trace closes on, and the
// settlement captureForSession hands the machine.
//
// A run is judged on its own results, whoever reads them. A collected run
// crossed a restart, and its red verdict used to be recorded as an 'error'
// to run again (#3828, ROLLOUT_RETRY_DETAIL); so was a live run that started
// within five minutes of a boot. Red runs followed load rather than
// rollouts, so that excused real failures; the checks queue
// (services/checks-queue.js) bounds the load instead. What still reads as
// infrastructure is what the run's own frames show to be: an unreachable
// origin (#1381), a starved Postgres (#1771), a unit suite that never ran.
// Is a run of `commitHash` where the unit suite really runs owed to a
// person on this proposal (chat_sessions.unit_suite_fresh_sha,
// services/unit-suite-reuse.js)? true, false, or null when the row could
// not be read.
async function freshRunOwedFor(pool, sessionId, commitHash) {
  if (!commitHash) return false;
  try {
    const { rows: [row] } = await pool.query(
      'SELECT unit_suite_fresh_sha FROM chat_sessions WHERE id = $1', [sessionId]
    );
    return !!(row && row.unit_suite_fresh_sha
      && String(row.unit_suite_fresh_sha).toLowerCase() === String(commitHash).toLowerCase());
  } catch {
    return null;
  }
}

async function settleCaptureRun(config, pool, run) {
  const {
    session, app, commitHash,
    traceStep = () => {}, runStartedAt = Date.now(),
    shotsOnly = false, admissionReason = null,
    media, legacyMediaSuppressed = false, capturePaths, pathDefaulted, captureRouteSource = null,
    visualScenarios = [], prodRunning, stagingOrigin, targets,
    testsCount, dispatched = null, ceilingDropped = 0,
    stdout, stderr = '', runPartial = false, runPartialReason = '', unitOutcome = null,
    notStarted = [],
    // { runId }: the machine's work item key the media are held under.
    collect,
  } = run;
  const { owner: repoOwner, repo: repoName } = repoRef.ownerRepo(app.repo_url) || {};
  let traceStatus = 'error';
  const { shots, failures } = parseShots(stdout);
  for (const f of failures) {
    log.warn('visuals', 'Capture frame failed', { sessionId: session.id, ...f });
  }

  // #47: the test suite result is stored FIRST so it lands even on the
  // console-only path (no media artifacts; storeArtifacts returns early).
  // Best-effort: a missing/partial set degrades to 'error' (the gate
  // blocks fail-closed, the card shows "couldn't run"), never throws.
  // The advisory console_* columns are dual-written from the same run for
  // one release so a rolling deploy's old readers stay coherent.
  const extraRows = [];
  try {
    const overRow = await overCeilingCheckRow(repoOwner, repoName, ceilingDropped);
    if (overRow) extraRows.push(overRow);
  } catch (err) {
    log.warn('visuals', 'Over-ceiling guard failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  }
  if (unitOutcome) extraRows.push(unitOutcome.row);
  // #2315: does the preview's own origin serve the hosted assets? Probed at
  // settlement rather than beside the capture launch so the harvester's
  // path (a run whose launching process died) reports it too. A deferred
  // run takes no verdict, so it does not probe. Never throws.
  const assetOutcome = shotsOnly ? null : await assetRouteCheck.maybeRunAssetRouteCheck({
    config, pool, appId: app.id, appSlug: app.slug, sessionId: session.id, stagingOrigin,
  });
  if (assetOutcome) extraRows.push(assetOutcome.row);
  // #2722: the Content rules review. Also at settlement so a harvested run
  // carries it; cached per head, so the harvest does not pay for it twice.
  // A deferred run takes no verdict, so it does not review. Never throws.
  const contentOutcome = shotsOnly ? null : await contentReview.maybeRunContentReview({
    pool, sessionId: session.id, appId: app.id, repoOwner, repoName, commitHash,
  }).catch(() => null);
  if (contentOutcome) extraRows.push(contentOutcome.row);
  // The small-change tag, watch only: a row for admins, never a check row,
  // so it is not awaited and nothing below reads it. Cached per head like
  // the review above. Never rejects.
  if (!shotsOnly) {
    void smallChange.maybeTagSmallChange({
      config, pool, sessionId: session.id, appId: app.id, repoOwner, repoName, commitHash,
    });
  }
  // Render health: the platform's own reading of every checked page — a
  // stylesheet that failed or came back empty, a page that shows nothing —
  // which no dapp.json setting can opt out of. Built from the same frames
  // the verdict below reads; a run whose frames carry no reading gets no
  // row. Never throws.
  const renderOutcome = shotsOnly ? null : await renderHealth.maybeBuildRenderHealthRow({
    pool, appId: app.id, sessionId: session.id, frames: parseTests(stdout),
  });
  if (renderOutcome) extraRows.push(renderOutcome.row);

  if (shotsOnly) {
    // No verdict was taken: the machine keeps the row 'pending' in phase
    // 'deferred' until the head merges cleanly. The preview half still
    // lands — the screenshots are the point of having run at all.
    traceStatus = 'deferred';
    traceStep('tests', 'Suite verdict: deferred', {
      state: 'deferred', reason: admissionReason, durationMs: Date.now() - runStartedAt,
    });
    const media = await holdMedia(pool, run, { shots, failures, collect, deferred: true });
    return { traceStatus, result: { outcome: 'deferred', capture: media.capture, visuals: media.visuals } };
  }

  for (const diag of parseDiagnostics(stdout)) {
    const fields = { sessionId: session.id, commitHash: commitHash || null, kind: diag.kind, ...diag.data };
    // A pod's own timing summary is a reading, not a warning.
    if (diag.kind === 'checks-timing') {
      log.info('visuals', 'Checks timing', fields);
      continue;
    }
    log.warn('visuals', diag.kind === 'network-changed'
      ? 'Checks browser saw its network change; the group started over'
      : 'Checks container diagnostic', fields);
  }

  const parsedTests = parseTests(stdout);
  const checksResult = classifyTests(parsedTests, testsCount, dispatched
    ? { dispatched, sentinel: parseTestsDone(stdout), extraRows }
    : { extraRows });
  await noteCheckSignals(checksResult, parsedTests, {
    sessionId: session.id, commitHash, repoOwner, repoName,
  });

  // No browser row means the suite never reached a check-level verdict.
  // Preserve the runner/runtime explanation instead of storing a bare
  // check_state='error' that sends the author back to an unchanged diff.
  if (checksResult.state === 'error' && parsedTests.length === 0 && testsCount > 0) {
    checksResult.errorDetail = captureFailureDetail({ stdout, stderr, runPartialReason });
    // The capture produced nothing, which the proposal's preview can cause:
    // not the platform's fault alone, whatever the unit suite said.
    checksResult.platformFault = false;
  }

  // #5054: the checks that produced no result were on a test Pod that never
  // started its container, or was evicted (`notStarted`, check-pod-start.js).
  // Nothing of the proposal's ran there, so it is the platform's fault: the
  // error lane retries it past the proposal's own retries, and the card says
  // the browser checks could not start. Only when results are missing; a
  // run whose checks reported, or whose Pods started, keeps today's reading.
  const neverStarted = (Array.isArray(notStarted) ? notStarted : []).filter((n) => n && n.cause);
  if (checksResult.state === 'error' && checksResult.missingResults && neverStarted.length) {
    const fault = neverStarted.find((n) => n.lead === 'start') || neverStarted[0];
    const sentence = require('./check-pod-start').browserNotRunSentence(fault);
    const joined = checksResult.errorDetail ? `${sentence} | ${checksResult.errorDetail}` : sentence;
    checksResult.platformFault = true;
    checksResult.errorDetail = joined.length > unitSuiteRow.FAILURE_DETAIL_MAX
      ? `${joined.slice(0, unitSuiteRow.FAILURE_DETAIL_MAX - 1)}…` : joined;
    log.warn('visuals', 'Browser checks could not start — recorded as the platform\'s fault', {
      sessionId: session.id, commitHash: commitHash || null, shards: neverStarted.map((n) => n.shard), cause: fault.cause,
    });
  }

  // Re-label a whole-origin outage as 'error' rather than 'failing'
  // (#1381). Only rows the container actually produced count — the
  // synthesized extraRows (over-ceiling guard, unit suite) never load a
  // page and would otherwise veto the override for free.
  if (checksResult.state === 'failing') {
    const containerRows = checksResult.results.filter((r) => !extraRows.includes(r));
    const detail = unreachableOriginDetail(containerRows, stagingOrigin);
    if (detail) {
      checksResult.state = 'error';
      checksResult.errorDetail = detail;
      log.warn('visuals', 'Checks unreachable origin — recorded as error, not failing', {
        sessionId: session.id, origin: stagingOrigin, rows: containerRows.length,
      });
    }
  }

  // #1771: a run that did not pass asks whether the shared Postgres was
  // starved while it ran. Twenty previews each holding six warm
  // connections, on a server whose max_connections is the stock 100, is
  // how a proposal's checks came back with 65 failures all citing one
  // endpoint's 500s and nothing anywhere naming the cause.
  //
  // Sampled HERE rather than at the write: this is the moment the run
  // finished, and storeChecks has a call-order contract two tests pin.
  //
  // The census is taken for ANY non-passing run, because the log line is
  // worth having either way, but it only changes the VERDICT under
  // connectionExhaustionDetail's every-row rule.
  if (checksResult.state !== 'passing') {
    const census = await connectionCensus(getPool(config));
    if (census && census.saturated) {
      log.warn('visuals', 'Checks ran while Postgres was near its connection limit', {
        sessionId: session.id,
        used: census.used,
        max: census.max,
        idle: census.idle,
        top: census.topDatabases.slice(0, 3),
      });
    }
    if (checksResult.state === 'failing') {
      const containerRows = checksResult.results.filter((r) => !extraRows.includes(r));
      const detail = connectionExhaustionDetail(containerRows, { origin: stagingOrigin, census });
      if (detail) {
        checksResult.state = 'error';
        checksResult.errorDetail = detail;
        log.warn('visuals', 'Checks starved of Postgres connections — recorded as error, not failing', {
          sessionId: session.id,
          rows: containerRows.length,
          used: census ? census.used : null,
          max: census ? census.max : null,
        });
      }
    }
  }

  // A run with no unit-suite row while a person is owed a run of this head
  // where the suite really runs (services/unit-suite-reuse.js). Only a suite
  // confirmed not to apply (no runnable `test` script, or the suite turned
  // off) answers the request; storeChecks then settles it. Any other missing
  // row (package.json unreadable, the runner failed before a Job, an outcome
  // nobody could read) did not run the suite they asked for: the verdict is
  // a retryable 'error' and the request stands.
  //
  // "Does not apply" needs evidence about this commit, not a bare 404 on
  // package.json (which a repository the reader cannot reach also answers):
  // a commit with any recorded unit-suite pass has a suite, so it is never
  // read as absent. A commit with none has nothing to copy either, so the
  // request it settles cannot be answered with a copy later.
  // An unreadable marker (null) is not "nothing owed": the transition that
  // stores the verdict reads the marker again under the row's lock and
  // refuses a pass with no unit row for an owed head (check-store's
  // unitAnswer), and the head stays pending for the stale sweep.
  if (!unitOutcome) {
    const owed = await freshRunOwedFor(pool, session.id, commitHash);
    if (owed !== false) {
      // The suite turned off (or GitHub off) answers the request as it
      // always did: nothing runs, whatever the commit's history. The pass
      // evidence below is about the repository's content only.
      const switchedOff = !unitSuite.isEnabled() || !github.isEnabled();
      const applies = switchedOff ? false : await unitSuite.suiteApplies({ repoOwner, repoName, ref: commitHash });
      if (switchedOff
          || (applies === false && !(await require('./unit-suite-reuse').hasAnyPass(pool, { appId: app.id, commitSha: commitHash })))) {
        checksResult.unitSuiteAbsent = true;
      } else if (owed === true && checksResult.state !== 'error') {
        checksResult.state = 'error';
        checksResult.errorDetail = unitSuiteRow.MISSING_UNIT_DETAIL;
        checksResult.platformFault = true;
        log.warn('visuals', 'A fresh unit suite was owed and this run has none: recorded as a retryable error', {
          sessionId: session.id, commitHash, applies,
        });
      }
    }
  }

  const blockingCount = Number.isInteger(checksResult.blockingCount)
    ? checksResult.blockingCount
    : checksResult.results.filter((r) => r.status !== 'pass' && !r.advisory).length;
  const advisoryCount = Number.isInteger(checksResult.advisoryCount) ? checksResult.advisoryCount : 0;
  const failingCount = blockingCount;
  traceStatus = checksResult.state;
  traceStep('tests', `Suite verdict: ${checksResult.state}`, {
    state: checksResult.state, tests: checksResult.results.length, failing: failingCount,
    advisory: advisoryCount || undefined, durationMs: Date.now() - runStartedAt,
  });
  const held = await holdMedia(pool, run, { shots, failures, collect, deferred: false });
  return { traceStatus, result: {
    outcome: 'verdict',
    state: checksResult.state,
    results: JSON.parse(serializeTestResults(checksResult.results)),
    errorDetail: checksResult.errorDetail || null,
    platformFault: checksResult.state === 'error' && checksResult.platformFault === true,
    console: consoleSnapshotFromTests(checksResult),
    // An 'error' verdict is "we could not find out", not "this check
    // failed": it records no history.
    history: checksResult.state === 'error' ? []
      : historyRowsOf(checksResult, { dispatched, unitOutcome, assetOutcome, renderOutcome }),
    capture: held.capture,
    visuals: held.visuals,
    // The repo unit suite, for the transition that stores this
    // (services/unit-suite-reuse.js): confirmed not to apply, which answers
    // a person's request for it; the gate a copied pass earns the proposal;
    // the key of a suite that ran and passed, whose recorded pass may be
    // copied once its history row lands with the verdict.
    ...(checksResult.unitSuiteAbsent === true ? { unitSuiteAbsent: true } : {}),
    unitEarned: unitOutcome && !unitOutcome.history && unitOutcome.earned ? unitOutcome.earned : null,
    unitObserved: unitOutcome && unitOutcome.history && unitOutcome.history.passed
      ? unitOutcome.history.checkKey : null,
  } };
}

// The app_check_history rows a verdict adds: the dispatched checks by their
// counts (a check on its first appearance was observed NEW_CHECK_RUNS times,
// folded into one row by classifyTests), and the unit, asset-route and
// render-health rows, which graduate through the same history. A suite that
// never ran observed nothing, so it records nothing.
function historyRowsOf(checksResult, { dispatched, unitOutcome, assetOutcome, renderOutcome }) {
  const rows = [];
  if (dispatched) {
    const byIndex = new Map(dispatched.map((d) => [d.index, d]));
    for (const r of checksResult.results) {
      const d = byIndex.get(r.index);
      if (!d) continue;
      rows.push({
        checkKey: d.checkKey, name: d.name, path: d.path,
        passes: Number.isInteger(r.passes) ? r.passes : (r.status === 'pass' ? 1 : 0),
        fails: Number.isInteger(r.fails) ? r.fails : (r.status === 'pass' ? 0 : 1),
      });
    }
  }
  if (unitOutcome && unitOutcome.history) rows.push(unitOutcome.history);
  if (assetOutcome) rows.push(assetOutcome.history);
  if (renderOutcome) rows.push(renderOutcome.history);
  return rows;
}

// A machine's run's media, held under its run id (check_run_media) for the
// settling transition to publish, and the capture outcome that describes
// them, returned for the settlement (settleCaptureRun's own wording).
async function holdMedia(pool, run, { shots, failures, collect, deferred }) {
  const { session, commitHash, media, legacyMediaSuppressed = false, capturePaths, pathDefaulted,
    captureRouteSource = null, visualScenarios = [], prodRunning, targets, runPartial = false, runPartialReason = '' } = run;
  const dropped = [];
  const stored = await storeArtifacts(pool, session.id, commitHash, targets, shots, dropped, { runId: collect.runId });
  const state = !media ? 'console_only'
    : (!stored ? 'failed' : ((failures.length || dropped.length || runPartial) ? 'partial' : 'captured'));
  const detail = {
    media, pathDefaulted, routeSource: captureRouteSource, scenarios: visualScenarios, prodRunning, paths: capturePaths,
    failures: failures.slice(0, 20), droppedOverCap: dropped.slice(0, 20),
    beforeFellBack: Array.from(new Set(shots.filter((x) => x.kind === 'before' && x.fellBack).map((x) => x.index))),
    runCutShort: runPartial ? (runPartialReason || true) : false,
    ...(deferred ? { deferred: true } : {}),
  };
  if (!media) {
    detail.reason = legacyMediaSuppressed ? LEGACY_SUPERSEDED_REASON
      : (deferred ? 'No frontend files in commit range and the verdict is deferred — nothing to capture'
        : 'No frontend files in commit range — console/tests-only run');
  } else if (!stored) detail.reason = 'No usable "after" artifact was produced';
  else if (runPartial) detail.reason = `Capture run cut short (${runPartialReason || 'unknown'}) — partial set stored`;
  return { capture: { state, detail }, visuals: stored || null };
}

// #47: fetch the proposal's declared dapp.json `tests` from GitHub (the
// staging clone is gone by now) and normalise via the manifest reader.
// `ref` is anything getFileContent accepts — a branch for native rows, a
// head SHA for imported (possibly fork-headed) ones, see sessionGitRef.
// Returns an empty suite when GitHub is disabled, the file is absent, or
// anything goes wrong — the caller then synthesizes the baseline suite.
//
// The shape is { tests, rawCount, ceilingDropped, ok } (plus, on a read,
// the app's `loadRules` for checkLoadFlags) rather than a bare
// array because the over-ceiling guard has to tell "the base branch declares
// zero checks" apart from "we could not read the base branch". Both give
// tests.length === 0; only the second must NOT be used as a baseline to
// accuse a proposal of deleting checks. `ok: false` says so explicitly.
async function resolveDeclaredTests(repoOwner, repoName, ref) {
  const empty = (ok) => ({ tests: [], rawCount: 0, ceilingDropped: 0, ok });
  if (!github.isEnabled() || !repoOwner || !repoName || !ref) return empty(false);
  try {
    const raw = await github.getFileContent(repoOwner, repoName, appManifest.MANIFEST_FILENAME, ref);
    // A repo with no dapp.json genuinely declares no checks — that IS a
    // successful read of an empty suite, not a failure.
    if (!raw) return empty(true);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return empty(false); }
    const meta = appManifest.readTestsWithMeta(parsed);
    return {
      tests: meta.tests, rawCount: meta.rawCount, ceilingDropped: meta.ceilingDropped, ok: true,
      loadRules: meta.loadRules,
    };
  } catch (err) {
    log.warn('visuals', 'Declared-test fetch failed — using baseline', {
      repo: `${repoOwner}/${repoName}`, ref, err: err.message,
    });
    return empty(false);
  }
}

// The declaration ceiling is a real limit, and silently discarding the
// checks past it would be the exact failure this whole change exists to
// end. So when a proposal's manifest declares MORE checks than the reader
// will accept, the run carries one synthesised BLOCKING row saying so.
//
// Two things make it safe to block on:
//
//  * It only fires when the reader actually refused entries for CEILING
//    reasons (`ceilingDropped`), not when it dropped malformed ones. Those
//    are two different complaints and only one of them is about the limit.
//  * It only fires when the head is over the ceiling BY MORE than the base
//    already was. A repo that merged its way over the limit shouldn't block
//    every subsequent unrelated proposal on a pre-existing condition — only
//    the proposal that adds to the overflow answers for it. A base we could
//    not read (`ok: false`) is not evidence of anything, so the guard stays
//    quiet rather than guessing.
async function overCeilingCheckRow(repoOwner, repoName, headCeilingDropped) {
  const over = Number(headCeilingDropped) || 0;
  if (over <= 0) return null;
  const base = await resolveDeclaredTests(repoOwner, repoName, 'main');
  if (!base.ok) {
    log.warn('visuals', 'Over-ceiling guard skipped — base manifest unreadable', {
      repo: `${repoOwner}/${repoName}`, over,
    });
    return null;
  }
  const baseOver = Number(base.ceilingDropped) || 0;
  if (over <= baseOver) return null;
  return {
    index: -2,
    name: `Manifest declares more than ${appManifest.MAX_DECLARED_TESTS} checks`,
    path: appManifest.MANIFEST_FILENAME,
    status: 'fail',
    advisory: false,
    consoleErrors: [],
    failureReason: `${over} declared check${over === 1 ? '' : 's'} past the ${appManifest.MAX_DECLARED_TESTS}-check ceiling were not run (base: ${baseOver}). Remove or consolidate checks so every declared check can run.`,
  };
}

// The global socket's frame for a session's event: `type` must stay
// 'session_event', which is the only case the shell's socket router has for
// these. Spreading the event AFTER `type` (as every copy of this used to)
// let the event's own `type: 'checks_ready'` overwrite it, and the router
// dropped every checks and visuals frame on the floor: the progress ticks,
// the verdicts, the before/after tiles.
function sessionEventEnvelope(sessionId, name, event) {
  return { ...event, type: 'session_event', sessionId, event: name };
}

// Capture completes after staging_ready fired, so the staging card needs a
// follow-up event to upgrade in place. Prefer the turn's own `send` (POST
// SSE + global WS + session bus, all dedup'd by _seq client-side); fall
// back to bus + WS directly when no turn is alive (promote-time capture).
let _notifySeq = 0;
function notifyVisualsReady(sessionId, visuals, send) {
  const data = { sessionId, visuals };
  try {
    if (send) {
      send('visuals_ready', data);
      return;
    }
    const event = { type: 'visuals_ready', _seq: `vis${Date.now().toString(36)}-${++_notifySeq}`, ...data };
    sessionBus.publish(sessionId, event);
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal(sessionEventEnvelope(sessionId, 'visuals_ready', event));
  } catch (err) {
    log.warn('visuals', 'visuals_ready notify failed', { sessionId, err: err.message });
  }
}

// #47: the per-check WS push lives in notifyChecks below. (The #381
// console-only `console_check_ready` notifier was retired when the
// console check became one test in the suite — clients now listen for
// `checks_ready`.)

// #607: tell open clients a checks run just STARTED so badges flip to the
// spinning "Checks running…" state immediately (proposal creation, manual
// re-run, sweeper retry) instead of waiting minutes for the terminal
// verdict. Always broadcastGlobal (never the turn's `send`) — the pending
// transition matters to every open vote panel / home strip, not just the
// focused dev chat, and app.js's existing `checks_ready` handler already
// refreshes both on any state.
//
// `phase` rides along so a card that re-renders from the event alone shows
// the right stage caption without waiting for its next fetch.
// ── Live progress of a run in flight ──
//
// The capture container prints one `__USERNODE_TEST__ index=<n> status=…`
// header per check, and `__USERNODE_TESTS_DONE__ ran=… expected=…` when the
// suite stops dispatching. The verdict is read from the whole stdout after
// exit (parseTests / classifyTests, unchanged); this tracker only listens to
// the same lines as they stream past, so "checks running" can say how far
// along it is. Dedup is by index, exactly as parseTests does, so a retried
// frame counts once. Nothing here can change a verdict.
//
// #4287: a frame from the capture's retry pass is not counted. It is a
// second opinion on a check that has already run, under its own index from
// CAPTURE_RETRY_INDEX_BASE up, and counting it took a 732-check run to
// "744 of 732". The container's own done line counts declared checks only,
// for the same reason.
const CAPTURE_RETRY_INDEX_BASE = 1000000; // capture/capture.js RETRY_INDEX_BASE
function makeChecksProgressTracker(expected, { shards = 1 } = {}) {
  const byIndex = new Map();
  let done = false;
  let doneRan = null;
  // A run split across pods is done when every shard has said so.
  let doneLines = 0;
  const doneNeeded = Math.max(1, Number(shards) || 1);
  const total = Number.isInteger(expected) && expected >= 0 ? expected : null;
  return {
    // Returns true when the line advanced the state (a new frame, or done).
    feed(line) {
      const l = String(line || '');
      if (l.startsWith('__USERNODE_TEST__ ')) {
        const m = /\bindex=(\d+)\b/.exec(l);
        const st = /\bstatus=(pass|fail)\b/.exec(l);
        if (!m) return false;
        const index = parseInt(m[1], 10);
        if (index >= CAPTURE_RETRY_INDEX_BASE) return false;
        const status = st && st[1] === 'pass' ? 'pass' : 'fail';
        const before = byIndex.get(index);
        byIndex.set(index, status);
        return before !== status;
      }
      if (l.startsWith('__USERNODE_TESTS_DONE__ ')) {
        doneLines += 1;
        const r = /\bran=(\d+)\b/.exec(l);
        if (r) doneRan = (doneRan || 0) + parseInt(r[1], 10);
        if (doneLines < doneNeeded) return false;
        done = true;
        return true;
      }
      return false;
    },
    snapshot() {
      let passed = 0;
      let failed = 0;
      for (const st of byIndex.values()) { if (st === 'pass') passed++; else failed++; }
      const ran = byIndex.size;
      return {
        ran, passed, failed,
        expected: total,
        done,
        updatedAt: new Date().toISOString(),
        ...(done && doneRan !== null && doneRan !== ran ? { reportedRan: doneRan } : {}),
      };
    },
  };
}

// Persist a progress snapshot on the row — only while THIS run is the one in
// flight. `check_state = 'pending'` and the commit guard together mean a
// verdict that has already landed, or a newer run that has since started,
// can never be overwritten by a late frame from an older container.
async function setChecksProgress(pool, sessionId, commitSha, progress) {
  if (!pool || !sessionId) return false;
  const res = await pool.query(
    `UPDATE chat_sessions
        SET checks_progress = $2::jsonb
      WHERE id = $1
        AND check_state = 'pending'
        AND (checks_commit_sha IS NOT DISTINCT FROM $3::text)`,
    [sessionId, JSON.stringify(progress || null), commitSha || null]
  );
  return !!(res && res.rowCount);
}

// The same event type the finished verdict rides on (#47), so no client has
// to learn a second one: `checkState: 'pending'` plus a `progress` block.
// A client that patches from the event gets a live bar; one that refetches
// gets the same numbers from the row.
// `commitSha` and `trigger` are OMITTED from the event when the caller
// passes undefined (a build-step tick knows neither), so a client that
// patches its row from the event keeps what it has instead of nulling it.
function notifyChecksProgress(sessionId, commitSha, progress, phase = null, trigger) {
  try {
    const event = {
      type: 'checks_ready',
      _seq: `chk${Date.now().toString(36)}-${++_notifySeq}`,
      sessionId,
      checkState: 'pending',
      failingCount: progress && Number.isInteger(progress.failed) ? progress.failed : 0,
      ...(commitSha === undefined ? {} : { commitSha: commitSha || null }),
      checkPhase: normalizeCheckPhase(phase),
      ...(trigger === undefined ? {} : { checkTrigger: normalizeCheckTrigger(trigger) }),
      progress: progress || null,
    };
    sessionBus.publish(sessionId, event);
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal(sessionEventEnvelope(sessionId, 'checks_ready', event));
  } catch (err) {
    log.warn('visuals', 'checks_progress notify failed', { sessionId, err: err.message });
  }
}

// The build half's progress: which step the staging build is on, and how
// long the finished ones took. Merged INTO checks_progress rather than
// replacing it, guarded only by the pending state (the build runs before
// the row's commit pin is necessarily settled), and carried through the
// testing half by makeChecksProgressState so the ledger can keep saying
// how long the build took beside the checks bar.
//   { step: 'source_fetch'|'image_build'|'clone'|'health'|'prepare_checks'|'done',
//     startedAt, steps: [{ key, ms, via? }], totalMs?, queued? }
//
// 'prepare_checks' is the hand-off between the container answering its
// healthcheck and the phase flipping to testing: edge verification, the
// staging_ready note, and — the long case — waiting in the capture queue
// behind an earlier run on the same proposal (`queued: true` while it is,
// `via: 'queued'` on the finished step). Opened by staging.js, closed by
// captureForSession, and NOT counted in totalMs, which stays the build
// alone: "Preview built in 20s, checks prepared in 9m 40s" is the sentence
// that says where the wait was.
const BUILD_STEP_KEYS = ['source_fetch', 'image_build', 'clone', 'health', 'prepare_checks'];

async function setChecksBuildProgress(pool, sessionId, build) {
  if (!pool || !sessionId || !build) return false;
  const res = await pool.query(
    `UPDATE chat_sessions
        SET checks_progress = COALESCE(checks_progress, '{}'::jsonb)
                              || jsonb_build_object('build', $2::jsonb, 'updatedAt', $3::text)
      WHERE id = $1
        AND check_state = 'pending'`,
    [sessionId, JSON.stringify(build), new Date().toISOString()]
  );
  return !!(res && res.rowCount);
}

function notifyChecksBuildProgress(sessionId, build) {
  notifyChecksProgress(sessionId, undefined, { build: build || null }, 'building', undefined);
}

// The finished build, from the timings staging.js threads out, in the same
// shape the live steps use — so the testing half's snapshots carry it.
function buildProgressFromTimings(timings) {
  if (!timings || typeof timings !== 'object') return null;
  const steps = [];
  const push = (key, ms, extra) => {
    if (Number.isFinite(ms)) steps.push({ key, ms: Math.round(ms), ...(extra || {}) });
  };
  push('source_fetch', timings.sourceFetchMs);
  push('image_build', timings.imageBuildMs, Array.isArray(timings.imagePhases) && timings.imagePhases.length
    ? { phases: timings.imagePhases.map((ph) => ({ name: String(ph.name), ms: Number.isFinite(ph.ms) ? Math.round(ph.ms) : null })) }
    : null);
  push('clone', timings.cloneMs, timings.cloneVia ? { via: timings.cloneVia } : null);
  push('health', timings.healthMs);
  push('prepare_checks', timings.prepareChecksMs, timings.prepareChecksVia ? { via: timings.prepareChecksVia } : null);
  if (!steps.length) return null;
  return {
    step: 'done',
    steps,
    ...(Number.isFinite(timings.totalMs) ? { totalMs: Math.round(timings.totalMs) } : {}),
  };
}

// Close the 'prepare_checks' step: the phase has just flipped to testing,
// or to 'queued' when the run waits for a checks slot first. Records how
// long the hand-off took on the timings — so every testing-half snapshot
// (makeChecksProgressState reads them next) carries the finished five-step
// build — and publishes the finished build at once, under that phase, so
// the card stops pulsing the step before the first test frame arrives.
// Idempotent on the timings: a re-drive of the same stagingResult, or the
// testing half after a wait, keeps the first measurement.
async function finishPrepareChecks(pool, session, commitSha, stagingResult, trigger, phase = 'testing') {
  try {
    const timings = stagingResult && stagingResult.timings;
    if (!timings || !Number.isFinite(timings.deployedAt)) return;
    if (!Number.isFinite(timings.prepareChecksMs)) {
      timings.prepareChecksMs = Math.max(0, Date.now() - timings.deployedAt);
    }
    const build = buildProgressFromTimings(timings);
    if (!build) return;
    await setChecksBuildProgress(pool, session.id, build).catch(() => {});
    notifyChecksProgress(session.id, commitSha, { build }, phase, trigger);
  } catch { /* status only */ }
}

// Minimum gap between two persisted/broadcast snapshots for one run. A pool
// of eight can finish several checks in the same second; the last frame
// (and the done sentinel) always gets through regardless.
const CHECKS_PROGRESS_MIN_GAP_MS = 1000;

// One run's progress state: the capture tracker plus the latest unit-suite
// snapshot, merged into one `{ ran, passed, failed, expected, done, unit }`
// and handed to `flush` at most once per CHECKS_PROGRESS_MIN_GAP_MS. A
// `done` from either side flushes at once. `close()` drops any pending
// timer and makes every later observation a no-op: the verdict write that
// follows it must be the last thing anyone hears about this run. The clock
// (`now`, defaulting to Date.now) can be injected for tests so the throttle
// gap is driven, not raced against real time.
function makeChecksProgressState({ expected, flush, minGapMs = CHECKS_PROGRESS_MIN_GAP_MS, build = null, shards = 1, now = Date.now }) {
  const tracker = makeChecksProgressTracker(expected, { shards });
  let unit = null;
  let lastFlushAt = 0;
  let timer = null;
  let closed = false;
  const snapshot = () => ({
    ...tracker.snapshot(),
    ...(unit ? { unit } : {}),
    ...(build ? { build } : {}),
  });
  const doFlush = () => {
    timer = null;
    if (closed) return;
    lastFlushAt = now();
    try { flush(snapshot()); } catch { /* best-effort */ }
  };
  const schedule = (urgent) => {
    if (closed) return;
    const gap = now() - lastFlushAt;
    if (urgent || gap >= minGapMs) {
      if (timer) { clearTimeout(timer); timer = null; }
      doFlush();
    } else if (!timer) {
      timer = setTimeout(doFlush, minGapMs - gap);
      if (typeof timer.unref === 'function') timer.unref();
    }
  };
  return {
    observeCapture(line) {
      if (closed || !tracker.feed(line)) return;
      schedule(tracker.snapshot().done);
    },
    observeUnit(snap) {
      if (closed || !snap || typeof snap !== 'object') return;
      unit = snap;
      schedule(!!snap.done);
    },
    close() {
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    snapshot,
  };
}

function notifyChecksPending(sessionId, commitSha, phase = null, trigger = null) {
  try {
    const event = {
      type: 'checks_ready',
      _seq: `chk${Date.now().toString(36)}-${++_notifySeq}`,
      sessionId,
      checkState: 'pending',
      failingCount: 0,
      commitSha: commitSha || null,
      checkPhase: normalizeCheckPhase(phase),
      checkTrigger: normalizeCheckTrigger(trigger),
    };
    sessionBus.publish(sessionId, event);
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal(sessionEventEnvelope(sessionId, 'checks_ready', event));
  } catch (err) {
    log.warn('visuals', 'checks_pending notify failed', { sessionId, err: err.message });
  }
}

// #47: tell open clients the checks landed so the checks badge upgrades in
// place without a full panel reload. Same emit strategy as
// notifyVisualsReady — prefer the turn's `send`, else bus + global WS.
//
// `failingCount` is the BLOCKING count and nothing else — it drives the
// "Checks failing · N" badge, and a badge that counts advisory failures
// would tell a reviewer their merge is blocked when it isn't. Advisory
// failures ride along separately for surfaces that want to show both.
function notifyChecks(sessionId, result, commitSha, send) {
  const blocking = Number.isInteger(result.blockingCount)
    ? result.blockingCount
    : (result.results || []).filter((r) => r.status !== 'pass' && !r.advisory).length;
  const data = {
    sessionId,
    checkState: result.state,
    failingCount: blocking,
    blockingCount: blocking,
    advisoryCount: Number.isInteger(result.advisoryCount)
      ? result.advisoryCount
      : (result.results || []).filter((r) => r.status !== 'pass' && r.advisory).length,
    commitSha: commitSha || null,
  };
  try {
    // A live turn's `send` fans out to the session bus AND the global
    // socket itself. Without one, both are published here. A caller with no
    // turn must pass nothing: a no-op `send` swallows the verdict for every
    // open page (see captureForSession's `send` note).
    if (send) {
      send('checks_ready', data);
      return;
    }
    const event = { type: 'checks_ready', _seq: `chk${Date.now().toString(36)}-${++_notifySeq}`, ...data };
    sessionBus.publish(sessionId, event);
    const { broadcastGlobal } = require('./ws');
    broadcastGlobal(sessionEventEnvelope(sessionId, 'checks_ready', event));
  } catch (err) {
    log.warn('visuals', 'checks_ready notify failed', { sessionId, err: err.message });
  }
}

module.exports = {
  kubernetesCaptureOrigin,
  sessionEventEnvelope,
  captureForSession,
  // The settlement half of a run, for the retry of a machine's work item
  // (check-harvest.collectForWorkflow) reading a run whose launcher died.
  settleCaptureRun,
  // The preview machine's checks.publish (src/workflow/preview/services.ts).
  patchPrBody,
  clearPrVisuals,
  runCaptureShards,
  captureShardCount,
  reportedTestIndexes,
  captureNotStarted,
  CAPTURE_SHARD_MIN_TESTS,
  notifyChecks,
  RUN_TIMEOUT_MS,
  RUN_MAX_BUFFER,
  // Exported for the regression test: the capture hostname is the only
  // consumer of these columns that needs a NAME rather than any handle
  // `docker` accepts, so the guard lives here and is asserted here.
  usableRuntimeName,
  storeArtifacts,
  getForSession,
  shapeAgg,
  expandCapturePaths,
  // Exported so the admin /gallery endpoint groups artifacts through the
  // SAME implementation the proposal cards and PR bodies use, instead of a
  // third copy that would drift (routes/gallery.js).
  groupRows,
  parseConsole,
  classifyConsole,
  parseTests,
  parseTestsDone,
  parseDiagnostics,
  captureFailureDetail,
  classifyTests,
  noteCheckSignals,
  unreachableOriginDetail,
  connectionExhaustionDetail,
  dnsHostname,
  serializeTestResults,
  overCeilingCheckRow,
  DEFAULT_CHECKS_SKIPPED_REASON,
  notifyChecksPending, makeChecksProgressTracker, makeChecksProgressState, setChecksProgress, notifyChecksProgress,
  CAPTURE_RETRY_INDEX_BASE,
  setChecksBuildProgress, notifyChecksBuildProgress, buildProgressFromTimings, BUILD_STEP_KEYS,
  finishPrepareChecks,
  normalizeCheckTrigger,
  CHECK_TRIGGERS,
  // The phases a pending run can be in, exported so the connector's output
  // schema can be held to the same vocabulary (tests/mcp-tools.test.js, #2137).
  CHECK_PHASES,
  summarizeBootFailure,
  consoleSnapshotFromTests,
  resolveDeclaredTests,
  sessionGitRef,
  isFrontendFile,
  isUiAffecting,
  shouldCaptureMedia,
  suppressLegacyMediaForSession,
  visualImpactMatches,
  selectVisualScenarios,
  deriveCapturePlan,
  parseShots,
  withToken,
  checkVisitUrl,
  mintCaptureToken,
  selectCaptureTokens,
  CAPTURE_USERNAME,
  CAPTURE_ADMIN_USERNAME,
  selfAppHashPath,
  beforeContainerName,
  resolveCaptureScale,
  CAPTURE_IMAGE,
  ensureCaptureImage,
  MOBILE_VIEWPORT,
};
