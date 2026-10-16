require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { loadShellRelease } = require('./src/services/shell-release');
const shellRelease = loadShellRelease(path.join(__dirname, 'public'));
// The baked artifact is authoritative even when a runtime omits build args.
// loadShellRelease rejects an explicitly different runtime revision.
if (shellRelease && shellRelease.revision !== 'dev') process.env.GIT_SHA = shellRelease.revision;
const { load: loadConfig, runsClusterMaintenance } = require('./src/config');
const { migrate } = require('./src/db/migrate');
const {
  shellAssetCacheControl,
  applyShellBuildHeader,
  applyShellDocumentHeaders,
  buildScopedAssetHandler,
} = require('./src/services/static-cache');
const { authMiddleware } = require('./src/middleware/auth');
const { errorHandler } = require('./src/middleware/error-handler');
const { explorerProxyRoutes } = require('./src/routes/explorer-proxy');
const { githubWebhookRoutes } = require('./src/routes/github-webhook');
const { mobileAppLinkRoutes } = require('./src/routes/mobile-app-links');
const { authRoutes } = require('./src/routes/auth');
const { illustrationRoutes, illustrationImageRoutes } = require('./src/routes/app-illustrations');
const { challengeIllustrationImageRoutes } = require('./src/routes/topochain/challenge-illustrations');
const { appRoutes } = require('./src/routes/apps');
const { chatRoutes } = require('./src/routes/chat');
const { conversationRoutes } = require('./src/routes/conversations');
const { friendRoutes } = require('./src/routes/friends');
const { contentReportRoutes } = require('./src/routes/content-reports');
const { sessionRoutes } = require('./src/routes/sessions');
const { agentSessionRoutes } = require('./src/routes/agent-sessions');
const { proposalHandoffRoutes } = require('./src/routes/proposal-handoff');
const { voteRoutes } = require('./src/routes/votes');
const { demoModeRoutes } = require('./src/routes/demo-mode');
const { kudosRoutes } = require('./src/routes/kudos');
const { publicApiRoutes } = require('./src/routes/public-api');
const { publicProfileRoutes } = require('./src/routes/profiles');
const { waitlistConnectRoutes } = require('./src/routes/waitlist-connect');
const { issueRoutes } = require('./src/routes/issues');
const { requestSpecRoutes } = require('./src/routes/request-specs');
const { campaignRoutes } = require('./src/routes/campaigns');
const { adminRoutes } = require('./src/routes/admin');
const { adminWorkflowRoutes } = require('./src/routes/admin-workflow');
const { adminSupportRoutes } = require('./src/routes/admin-support');
const { adminUserMergeRoutes } = require('./src/routes/admin-user-merge');
const { dashboardRoutes } = require('./src/routes/dashboard');
const { uiTelemetryRoutes } = require('./src/routes/ui-telemetry');
const { feedbackRoutes } = require('./src/routes/feedback');
const { notificationsRoutes } = require('./src/routes/notifications');
const { collaboratorRoutes } = require('./src/routes/collaborators');
const appDirectoryRoutes = require('./src/routes/app-directory');
const { approverRoutes } = require('./src/routes/approvers');
const { statusRoutes } = require('./src/routes/status');
const { internalRoutes } = require('./src/routes/internal');
const { appErrorRoutes } = require('./src/routes/app-error');
const { visualsRoutes } = require('./src/routes/visuals');
const { shotsRoutes } = require('./src/routes/shots');
const { appIconRoutes } = require('./src/routes/app-icons');
const { issueImageRoutes } = require('./src/routes/issue-images');
const { issueVideoRoutes } = require('./src/routes/issue-videos');
const { avatarRoutes } = require('./src/routes/avatars');
const { profileRoutes } = require('./src/routes/profile');
const { stakingRoutes } = require('./src/routes/staking');
const { appFileServeRoutes, appFileShellRoutes } = require('./src/routes/app-files');
const appStorageRoutes = require('./src/routes/app-storage');
const anthropicProxyRoutes = require('./src/routes/anthropic-proxy');
const { credentialRoutes } = require('./src/routes/credentials');
const { globalChatRoutes } = require('./src/routes/global-chat');
const appLlmProxyRoutes = require('./src/routes/app-llm-proxy');
const appPlatformApiRoutes = require('./src/routes/app-platform-api');
const { llmGrantsRoutes } = require('./src/routes/llm-grants');
const { appPermissionsRoutes, declaredFor, grantedCapabilities, effectiveCapabilities } = require('./src/routes/app-permissions');
const { userAgentFilesRoutes } = require('./src/routes/user-agent-files');
const { topicAttributeRoutes } = require('./src/routes/topic-attributes');
const { boardOrderRoutes } = require('./src/routes/board-order');
const { reportAiRoutes } = require('./src/routes/report-ai');
const { workshopAskRoutes } = require('./src/routes/workshop-ask');
const { workshopThemesRoutes } = require('./src/routes/workshop-themes');
const { sinceSummaryRoutes } = require('./src/routes/since-summary');
const { topicFiguresRoutes } = require('./src/routes/topic-figures');
const { workshopOverviewRoutes, demoNeedsVoteRoutes } = require('./src/routes/workshop-overview');
const { appNoticesRoutes } = require('./src/routes/app-notices');
const { messagesOverviewRoutes } = require('./src/routes/messages-overview');
const { platformAboutRoutes } = require('./src/routes/platform-about');
const { reportSnapshotRoutes, reportShareRoutes } = require('./src/routes/report-snapshots');
const { homePanelRoutes } = require('./src/routes/home-panels');
const { onboardingRoutes } = require('./src/routes/onboarding');
const { homeLayoutRoutes } = require('./src/routes/home-layout');
const { chatDraftsRoutes } = require('./src/routes/chat-drafts');
const { agentSessionDraftsRoutes } = require('./src/routes/agent-session-drafts');
const { devFlowRoutes } = require('./src/routes/dev-flow');
const { pmOrderRoutes } = require('./src/routes/pm-order');
const { debugRoutes } = require('./src/routes/debug');
const { galleryRoutes } = require('./src/routes/gallery');
const { appInstallRoutes } = require('./src/routes/app-install');
const communityInviteRoutes = require('./src/routes/community-invites');
const memberWaitlistRoutes = require('./src/routes/member-waitlist');
const {
  cliAuthGate,
  cliApiBearerAuth,
  cliPreAuthRoutes,
  cliBrowserRoutes,
} = require('./src/routes/cli-auth');
// Hosted MCP connector (Claude.ai / ChatGPT). Same three-way split as the
// CLI surface above: a hard staging/enablement gate, then the public +
// bearer routes before cookie auth, then the browser-session management
// routes after it.
const {
  mcpConnectGate,
  mcpPreAuthRoutes,
  mcpBrowserRoutes,
} = require('./src/routes/mcp-remote');
const { socialIdentityRoutes } = require('./src/routes/social-identities');
// Topochain v4 (plan Task 3): public/partner/ingest/mobile carry their own
// auth and mount BEFORE authMiddleware; admin reuses the platform's own
// admin auth and mounts AFTER it (architecture decision #2 — see the mount
// sites below for the full rationale).
const { topochainPublicRoutes } = require('./src/routes/topochain/public');
const { topochainPartnerRoutes } = require('./src/routes/topochain/partner');
const { topochainIngestRoutes } = require('./src/routes/topochain/ingest');
const { topochainMobileRoutes } = require('./src/routes/topochain/mobile');
const { topochainAdminRoutes } = require('./src/routes/topochain/admin');
const github = require('./src/services/github');
const worker = require('./src/services/worker');
const activeWorkersSvc = require('./src/services/active-workers');
const turnWatchdog = require('./src/services/turn-watchdog');
const recoveryRetry = require('./src/services/recovery-retry');
const turnLifecycle = require('./src/services/turn-lifecycle');
const stopRegistry = require('./src/services/stop-registry');
const sessionBus = require('./src/services/session-bus');
const turnEffects = require('./src/services/turn-effects');
const recoveryPills = require('./src/services/recovery-pills');
const sessionLifecycle = require('./src/services/session-lifecycle');
const stagingRecovery = require('./src/services/staging-recovery');
const stagingReap = require('./src/services/staging-reap');
// Named stagingSvc because recoverActiveWorkers() already binds a local
// `staging`.
const stagingSvc = require('./src/services/staging');
const { hasInFlightHandoffPipeline } = require('./src/services/handoff-pipeline');
const limits = require('./src/services/limits');
const events = require('./src/services/events');
const ws = require('./src/services/ws');
const log = require('./src/services/logger');
const lifecycle = require('./src/services/lifecycle');
const leaderTimers = require('./src/services/leader-timers');
// The platform's processes and what each holds (docs/plans/draining-releases.md).
const processes = require('./src/services/processes');
const drain = require('./src/services/drain');
const processRole = require('./src/services/process-role');
const { singleFlight } = require('./src/services/single-flight');
const inflightWork = require('./src/services/inflight-work');
const inflightRequests = require('./src/middleware/inflight-requests');
const chainPoller = require('./src/services/chain-poller');
const genesisAccounts = require('./src/services/genesis-accounts');
const nodeStatus = require('./src/services/node-status');
const statusService = require('./src/services/status');
const mobilePush = require('./src/services/mobile-push');
const { getActiveWorkerCount } = require('./src/routes/sessions');
const appAccess = require('./src/services/app-access');
const platformJwt = require('./src/services/platform-jwt');
const usernames = require('./src/services/usernames');
const appHostConfig = require('./src/services/app-host-config');
const { getPool } = require('./src/db/pool');
const { createLeadership, withMigrationLock } = require('./src/services/leadership');
const { publicApiCors } = require('./src/middleware/public-cors');
const { responseCompression } = require('./src/middleware/response-compression');
const { trustedProxyClientIp } = require('./src/services/client-ip');
const { currentVotePredicateSql } = require('./src/services/pr-vote-revision');

const config = loadConfig();
log.setLevel(config.logLevel);

const app = express();
let startupDiagnostics = null;

// First of all: count every request until it is answered, so the shutdown
// drain in cleanup() can wait for the handlers still writing rather than
// exit from under them. Event streams and long polls leave the count (see
// src/middleware/inflight-requests.js).
app.use(inflightRequests.inflightRequests());

// Express never trusts forwarding headers globally. Docker mode resolves one
// configured proxy peer; Kubernetes mode lets Cilium/Envoy supply the client
// address without a proxy hostname. Direct child/worker calls carry no
// forwarding header and therefore retain their real socket address.
app.set('trust proxy', false);
app.use(trustedProxyClientIp({
  hostname: config.trustedProxyHost,
  trustDirectPeer: config.appRuntime === 'kubernetes',
}));

// Brotli / gzip for the shell's own text responses — its scripts, styles,
// document and JSON. Nothing in front of this process compresses, so without
// it every byte crossed the network as written. Mounted ahead of every route
// so each one's answer passes through it; GET/HEAD only, and never a stream.
// See src/middleware/response-compression.js.
app.use(responseCompression());

// Cross-origin support for the anonymous `/api/public/*` tier, and for
// nothing else. Marketing pages the platform does not host (the waitlist
// join + check-my-status forms) call it from the browser, so those responses
// need an Access-Control-Allow-Origin header and the JSON POST's OPTIONS
// preflight needs an answer. Mounted here, ahead of every gate and the body
// parser, so a preflight is a 204 that depends on nothing: no cookie, no
// bearer, no parser, no route. See src/middleware/public-cors.js for why a
// wildcard origin with no credentials is the safe shape for this prefix.
app.use(publicApiCors());

// OS domain verification is anonymous and must never reach login redirects
// or the SPA/static fallback (which does not serve dot directories).
app.use(mobileAppLinkRoutes());

// Global CLI authentication has a hard staging/enablement gate before any
// body parser, cookie lookup, bearer lookup, or static fallback. Public
// device + bearer routes also mount here so they never inherit browser
// session semantics.
app.use(cliAuthGate(config));
app.use(cliPreAuthRoutes(config));

// The hosted MCP connector gets the same treatment for the same reason: a
// staging preview's browser identity comes from an iframe token, so a
// connector credential must never be mintable or usable there. POST /mcp
// authenticates with its own OAuth bearer and must never see a cookie, so
// it mounts here rather than behind authMiddleware.
app.use(mcpConnectGate(config));
app.use(mcpPreAuthRoutes(config));

// ── Explorer API passthrough ───────────────────────────────────────────────
// #2505: lifted into src/routes/explorer-proxy.js, which carries the full
// rationale. Still mounted HERE — before the JSON body parser so the raw
// body streams through, and before authMiddleware so it isn't redirected to
// the login page. What changed is that it is now bounded: a capped request
// body, a capped upstream response, an upstream timeout, an IP-keyed rate
// limit, an allow-list of methods and a path-traversal refusal.
app.use(explorerProxyRoutes(config));

// ── GitHub webhook ─────────────────────────────────────────────────────────
// #2737. Mounted HERE for the same two reasons as the passthrough above: the
// signature is over the RAW bytes, so it must precede the JSON parser, and
// the caller is GitHub, which has no session for authMiddleware to find. The
// route verifies an HMAC before it reads anything, and is off entirely when
// no secret is configured. src/routes/github-webhook.js carries the rest.
app.use(githubWebhookRoutes(config));
app.use(require('./src/routes/mail-webhooks').mailWebhookRoutes(config));

// ── Work-order patch uploads (#4264) ───────────────────────────────────────
// A coding agent's one-time upload of a large patch for a connector work
// order. HERE for the webhook's two reasons: the body is raw patch bytes
// under whatever Content-Type curl sends, so it must precede the JSON
// parser, and the caller is a sandbox with no session, authenticated by the
// task's own token. src/routes/external-agent-patch-upload.js has the rest.
app.use(require('./src/routes/external-agent-patch-upload').externalAgentPatchUploadRoutes(config));

// ── Challenges API (SV web shell) ──────────────────────────────────────────
// /challenges-api/* used to be a READ-ONLY proxy to the (now retired)
// external leaderboard deployment. Since the topochain merge the same five
// GET surfaces are served in-process by topochainMobileRoutes (see the
// "/challenges-api (SV web shell reads)" section of
// src/routes/topochain/mobile.js), authenticated by the platform session
// cookie — so there is no proxy block here anymore.

// Skip the global JSON parser for the Anthropic-proxy path so the proxy
// can mount its own parser with a 32MB limit (matching Anthropic's
// actual request-size cap). With the default 100kb limit a normal CC
// turn body (often a few MB of file context) gets 413'd at the parser
// boundary, and the `claude` CLI surfaces the generic
// "Request too large (max 32MB). Try with a smaller file." message —
// even though our parser, not Anthropic, is the one rejecting. Keep
// the rest of the app on the small default; only the proxy needs the
// large limit. See routes/anthropic-proxy.js for the scoped parser.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/internal/anthropic/')) return next();
  if (req.path.startsWith('/api/app-llm/')) return next();
  // CLI-auth POSTs own a strict 4 KiB route-scoped parser. Browser approval
  // reaches its parser only after cookie auth; public device routes were
  // already handled by cliPreAuthRoutes above.
  if (req.path.startsWith('/api/cli/')) return next();
  if (req.path === '/api/me/cli-tokens'
      || req.path.startsWith('/api/me/cli-tokens/')) return next();
  // Native CLI proposal payloads deliberately carry a bounded spec, durable
  // history, structured local test summaries, and (for /commits) a bounded
  // base64 snapshot of the changed Git blobs. These endpoints own scoped
  // parsers in routes/proposal-handoff.js (512 KiB normally, 12 MiB only for
  // commit upload). Do not widen the rest of the app's JSON surface.
  if (req.method === 'POST'
      && (/^\/api\/apps\/[^/]+\/proposal-handoffs$/.test(req.path)
          || /^\/api\/sessions\/[^/]+\/proposal-handoff\/(?:context|build|commits)$/.test(req.path))) {
    return next();
  }
  // The browser diagnostics collector owns a stricter 32 KiB parser in
  // routes/ui-telemetry.js. Leave its stream untouched here so that lower
  // bound is enforced before JSON decoding.
  if (req.method === 'POST' && req.path === '/api/ui-telemetry/batch') return next();
  // Private conversation uploads carry raw bytes and own a bounded 21 MB
  // parser in routes/conversations.js. In particular, a .json file may have
  // application/json content-type; letting this global parser consume it
  // first would turn valid attachment bytes into an object/empty upload.
  if (req.method === 'POST'
      && /^\/api\/conversations\/[^/]+\/attachments$/.test(req.path)) {
    return next();
  }
  // Agent-file uploads (#460) carry up to 48 KB of file content, which
  // can exceed the 100kb default once JSON-escaped — the route mounts
  // its own 256kb parser (see routes/user-agent-files.js).
  if (req.path === '/api/me/agent-files' && req.method === 'POST') return next();
  // Locked report snapshots (report-lock-share) carry the full standalone
  // report HTML, which routinely exceeds 100kb; the route mounts its own
  // 3mb parser (routes/report-snapshots.js).
  if (req.method === 'POST' && /^\/api\/apps\/[^/]+\/report-snapshots$/.test(req.path)) return next();
  // A PR import carries the description and the declared changes, which
  // together can exceed the global 100kb parser.
  if (req.method === 'POST'
      && /^\/api\/apps\/[^/]+\/pr-import$/.test(req.path)) {
    return express.json({ limit: '512kb' })(req, res, next);
  }
  // A spec posted on a request (routes/request-specs.js) may be an HTML
  // document of up to 600,000 characters (spec-html.js MAX_SPEC_HTML_CHARS),
  // which JSON escaping makes larger still. The route checks the length
  // itself and refuses an oversized spec with the numbers.
  if (req.method === 'POST'
      && /^\/api\/apps\/[^/]+\/issues\/[^/]+\/spec$/.test(req.path)) {
    return express.json({ limit: '1mb' })(req, res, next);
  }
  // #4194: a request's body may be as long as GitHub allows (65,536
  // characters, services/issue-body-limit.js), which JSON escaping and
  // multi-byte text take past the global 100kb parser; the feedback submit
  // also carries an app's state snapshot. Both routes check the length
  // themselves and refuse an oversized body with the numbers.
  if ((req.method === 'POST' && req.path === '/api/feedback')
      || (req.method === 'PATCH' && /^\/api\/feedback\/\d+$/.test(req.path))
      || (req.method === 'PATCH' && /^\/api\/apps\/[^/]+\/github-issues\/[^/]+\/body$/.test(req.path))) {
    return express.json({ limit: '1mb' })(req, res, next);
  }
  express.json()(req, res, next);
});
app.use(cookieParser());

app.get('/health', (_req, res) => {
  // `topochain: true` (plan Task 3; SPEC 815-818 "merge into the platform's
  // existing health check") — a static presence flag confirming this
  // deployment carries the /api/v4 topochain surface, not a live subsystem
  // probe (there's no separate topochain process to be unhealthy).
  res.json({ status: 'ok', topochain: true, startup: startupDiagnostics });
});

// The platform is never a dapp in "mock mode". The shared usernode-bridge
// auto-detects mock mode by probing `GET /__mock/enabled` and treating ANY
// 200 as "use the local-dev /__mock/* endpoints". Our SPA catch-all
// (`app.get('*')` below) answers that probe with index.html + 200, which
// fools the bridge into routing `sendTransaction` to `/__mock/sendTransaction`
// — an endpoint we don't implement — so the POST 404s and surfaces the
// misleading "Mock API not enabled" error on the wallet register flow.
// Explicitly 404 the whole mock namespace (before authMiddleware so it's
// authoritative for anonymous + authenticated callers alike) so the bridge
// correctly concludes mock is off and uses the native transport.
app.all('/__mock/*', (_req, res) => {
  res.status(404).json({ error: 'mock mode not available on the platform' });
});

// Lightweight endpoint polled by the header "platform version" pill
// (public/js/app.js → renderPlatformVersionPill). Four pieces of
// information packaged together so the client only needs one fetch:
//   - `sha`            : the SHA the running platform was built from.
//   - `name`           : short label shown in the pill (mirrors how the
//                        per-app pill leads with the app slug, so the
//                        two read symmetrically as "usernode · sha"
//                        and "myapp · sha · #pr"). Overridable via env.
//   - `repoUrl`        : where to link the pill (commit on GitHub).
//                        Overridable via env so forks point at their own repo.
//   - `deployProgress` : null in idle state, or { deploying, sha, startedAt }
//                        when the deploy workflow has flagged a redeploy in
//                        flight (see services/deploy-status.js + deploy.yml).
const deployStatus = require('./src/services/deploy-status');
app.get('/api/version', async (_req, res) => {
  res.json({
    sha: process.env.GIT_SHA || 'dev',
    name: process.env.USERNODE_PROJECT_NAME || 'usernode',
    repoUrl: config.platformRepoUrl,
    deployProgress: await deployStatus.read(config),
    // Which environment this build is: 'staging' | 'production' | null.
    // Only used to NAME the no-SHA state in the drawer's "Platform
    // version" row: staging previews of the platform are built without
    // GIT_SHA, so `sha` comes back as the literal "dev" there and a row
    // reading "Platform version  dev" tells a tester nothing. With this,
    // the client renders "staging" instead. Purely a label — nothing
    // gates behaviour on it, and USERNODE_ENV is platform-injected (a
    // reserved key), so there's no new declaration to make.
    env: process.env.USERNODE_ENV || null,
    // SELF-HOSTING.md Phase 2f: the platform's own slug in the apps
    // table, so a client can recognize self-app surfaces without
    // guessing. No client reads it today — the "Platform updating…"
    // banner that did was removed in #1015 — but it stays as the
    // documented way to identify the self-app: cheap to include
    // (already in config) and it saves a second round-trip for any
    // future code path that needs it.
    selfAppSlug: config.selfAppSlug,
  });
});

// The languages the shell is offered in, and their packs, from the
// translation cache (src/routes/languages.js). Before authMiddleware: the
// sign-in screens are translated too.
app.use(require('./src/routes/languages').languageRoutes(config));

// Public conventions endpoint. Apps' own CLAUDE.md files point here so
// a developer (or Claude Code) running locally against a repo can
// fetch the current platform rules without cloning the harness.
// Mounted before authMiddleware so it's open to anyone.
app.get('/claude.md', (_req, res) => {
  const fs = require('fs');
  const fp = path.join(__dirname, 'src', 'prompts', 'app-conventions.md');
  try {
    // Through the loader, NOT a raw read: the document carries a
    // {{PLATFORM_ORIGIN}} token that services/prompts.js resolves to this
    // deployment's own origin. Reading the file directly here would publish
    // the token itself to the very people this URL exists for.
    const body = require('./src/services/prompts').getAppConventions();
    const stat = fs.statSync(fp);
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Last-Modified', stat.mtime.toUTCString());
    // No strong caching — the whole point is that this URL serves the
    // current conventions, not a snapshot.
    res.set('Cache-Control', 'public, max-age=60');
    res.send(body);
  } catch (err) {
    log.error('conventions', 'Failed to serve /claude.md', { err: err.message });
    res.status(500).type('text/plain').send('conventions unavailable');
  }
});

// Public sidecar-status endpoints. All read the cached snapshot maintained
// by `services/node-status.js` (one poll per process, regardless of how
// many clients are watching). Mounted before authMiddleware so anonymous
// visitors and embedded child-app pages can both read them. All on-chain
// info is already public, so no progressive disclosure here.
//
// Three surfaces:
//   - /api/node-status        : compact node snapshot (powers the summary
//                                card in the #admin/status section)
//   - /api/node-status/full   : full snapshot (server + node + explorer +
//                                chain-dependent services). Powers the
//                                #admin/node section.
//   - /node-status            : redirect stub into #admin/node (#860)
//
// The two JSON endpoints stay mounted here, BEFORE authMiddleware, and must
// not move: since #860 folded the viewer pages into the signed-in console,
// these are the anonymous surface — external monitoring and embedded
// child-app reads depend on them being open.
app.get('/api/node-status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(nodeStatus.get());
});

app.get('/api/node-status/full', (_req, res) => {
  // Lazy require here (rather than top of file) keeps the import graph
  // straight: chain-poller and genesis-accounts are leaf modules; node-
  // status doesn't import them. The callback shape is what wires them
  // together at request time.
  const chainPollerSvc = require('./src/services/chain-poller');
  const genesisAccountsSvc = require('./src/services/genesis-accounts');
  res.set('Cache-Control', 'no-store');
  res.json(nodeStatus.getFull({
    name: 'usernode-social-vibecoding',
    mode: process.env.USERNODE_LOCAL_DEV ? 'local-dev' : 'production',
    services: () => ({
      chainPoller: chainPollerSvc.getStatus(),
      // getStatus() carries the same outage shape as chainPoller's
      // (consecutiveFailures / downSince / lastError) on top of the
      // loaded/count pair, so the viewer can say how long the genesis
      // fetch has been failing rather than just "not loaded".
      genesisAccounts: genesisAccountsSvc.getStatus(),
    }),
  }));
});

app.get('/node-status', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'node-status.html'));
});

// Status routes are public (with progressive disclosure for admins) —
// mount before authMiddleware so they don't redirect anonymous visitors.
app.use(statusRoutes(config));

// Worker → platform internal API (git push proxy, PR creation).
// Mounted BEFORE authMiddleware because requests come from worker
// containers, not users — they carry a session-scoped JWT in
// Authorization: Bearer, verified by internal-auth middleware inside
// the router. Also gated by a private-IP check; not reachable through
// Caddy's external vhosts in production.
app.use(internalRoutes(config));

// Worker → platform Anthropic proxy. The CC worker container holds a
// session-scoped JWT (in ANTHROPIC_API_KEY env, picked up as x-api-key
// by the SDK) and ANTHROPIC_BASE_URL points at /api/internal/anthropic
// here. The proxy verifies the JWT, swaps in the real platform key, and
// forwards to api.anthropic.com — so the platform key never enters the
// worker container and "echo $ANTHROPIC_API_KEY" exfiltrates only a
// short-lived JWT useless against Anthropic directly. Same private-IP
// gate as internalRoutes; not reachable through Caddy externally.
app.use(anthropicProxyRoutes(config));

// Dapp → platform LLM proxy (issue #34). App containers call
// /api/app-llm/v1/messages with their per-app token
// (USERNODE_LLM_PROXY_TOKEN) plus the user's iframe JWT; the proxy
// verifies both, requires an active per-(app,user) grant, swaps in the
// real key (platform or the user's own, per the grant), meters spend
// against the user's daily budget AND the grant's per-app cap, and
// forwards to api.anthropic.com. Same private-IP gate as the worker
// proxy; mounted before authMiddleware because callers are app
// containers, not browser sessions.
app.use(appLlmProxyRoutes(config));

// Dapp → platform app-storage API (#752). App containers upload/delete
// user files with their per-app token (USERNODE_STORAGE_TOKEN) plus the
// user's iframe JWT — same credential pattern and private-IP gate as
// the app-LLM proxy above; mounted before authMiddleware because
// callers are app containers, not browser sessions.
app.use(appStorageRoutes(config));

// Versioned app-facing read-only platform API (#744, #1908). App containers
// call /api/app-platform/v1/* with the same per-app token
// (USERNODE_LLM_PROXY_TOKEN) to read their OWN proposal/vote/merge
// feed or the public app directory. The legacy unversioned paths remain
// aliases. App-token-only endpoints need no user token or grant because
// they expose only public or already-viewable data. User-directory calls
// additionally verify the forwarded user token. Same private-IP gate;
// mounted before authMiddleware because callers are app containers, not
// browser sessions.
app.use(appPlatformApiRoutes(config));

// Before/after visuals artifacts (#195). Public by design: GitHub's camo
// proxy fetches the PR-body embeds anonymously, so this must not redirect
// to login. Access control is the unguessable 32-hex artifact id.
app.use(visualsRoutes(config));

// App homescreen icon images. Public for the same reason as visuals:
// home tiles load them with plain <img> tags; access control is the
// unguessable 32-hex icon id.
app.use(appIconRoutes(config));

// Issue-screenshot images (#683). Public for the same reason as visuals:
// GitHub's camo proxy fetches the issue-body embeds anonymously; access
// control is the unguessable 32-hex screenshot id.
app.use(issueImageRoutes(config));

// Issue-attached video clips (#3940). Public for the same reason as the
// screenshots above: the issue-body link, the in-app player and the
// coding agents fetch it anonymously; access control is the unguessable
// 32-hex clip id.
app.use(issueVideoRoutes(config));

// Profile pictures (#982). Public for the same reason as app-icons: the
// profile screen and the hamburger drawer load them with plain <img>
// tags; access control is the unguessable 32-hex avatar id, and the image
// is published to other users by design.
app.use(avatarRoutes(config));
app.use(illustrationImageRoutes(config));
// Uploaded challenge artwork, public for the same reason: challenge cards draw
// it with plain <img> tags for anonymous viewers too. Access control is the
// unguessable 32-hex id; the admin list/upload/archive routes live in
// topochainAdminRoutes behind the admin gates.
app.use(challengeIllustrationImageRoutes(config));

// Publicly shared locked report snapshots (report-lock-share). Mounted
// before authMiddleware like visuals: access control is the unguessable
// 32-hex share token, and the HTML is served under a sandbox CSP.
app.use(reportShareRoutes(config));

// WP-E: the unsubscribe link in activity mail (src/routes/activity-mail.js).
// Before authMiddleware: a mail client's one-click POST carries no session,
// and the HMAC token in the link is the whole of the access check.
app.use(require('./src/routes/activity-mail').activityMailRoutes(config));
app.use(require('./src/routes/mail-tracking').mailTrackingRoutes(config));
// The configuration every process that runs the workflow machines sets up
// (src/workflow/setup.ts): activity mail, the account-deletion guard on workers.
require('./src/workflow/setup.ts').configureWorkflowProcess(config);

// App-stored user files (#752). Public for the same reason as app-icons:
// app pages load them with plain <img> tags from their own subdomains.
// visibility='public' rows are guarded by the unguessable 32-hex id;
// visibility='private' rows additionally require a user JWT (?token=)
// inside the route. Bytes stream from the MinIO sidecar.
app.use(appFileServeRoutes(config));

// Friendly "app is restarting" page for dead app containers (#426).
// Caddy's wildcard-site handle_errors rewrites upstream 502/503/504s to
// /__app_unavailable and proxies them here with the original app-
// subdomain Host. Mounted before authMiddleware: the request carries no
// platform session (and needs none — for view-private apps the edge
// gate already passed before the proxy attempt failed).
app.use(appErrorRoutes(config));

// Topochain v4 (plan Task 3; architecture decision #2). Public/partner/
// ingest/mobile each carry their OWN auth (optionalSessionAuth /
// partnerApiKey / mobileTokenAuth, applied per-route inside these
// routers — never a platform session), so they mount BEFORE
// authMiddleware like the pre-auth routers above. A request that matches
// one of these routers' paths is answered here and never reaches
// authMiddleware at all.
//
// NOTE on unmatched /api/v4/* paths: these four routers currently only
// expose their Task-3 __ping stubs (real endpoints land in Tasks 5-10), so
// most /api/v4/* paths are NOT yet matched here and fall through to
// authMiddleware below. /api/v4 is deliberately NOT added to
// authMiddleware's PUBLIC_PATHS: an anonymous request for an unmounted v4
// path therefore gets authMiddleware's standard 401 JSON (`{"error": "Not
// authenticated"}`), not a 404. This is intentional — unmounted API
// surface fails closed (requires auth) rather than being anonymously
// reachable by default; it also means every REAL public v4 endpoint (Task
// 5 onward) must be mounted in one of these pre-auth routers itself (as
// this file already does), never rely on falling through past
// authMiddleware. See tests/topochain-foundation.test.js for the exercised
// behavior.
app.use(topochainPublicRoutes(config));
app.use(topochainPartnerRoutes(config));
app.use(topochainIngestRoutes(config));
app.use(topochainMobileRoutes(config));

// User-facing JSON APIs may authenticate with a scoped CLI bearer token.
// This mounts after internal/app/topochain bearer surfaces so the CLI token
// can never be confused for one of those distinct credentials.
app.use(cliApiBearerAuth(config));
app.use(authMiddleware(config));
// Every admin write, on whichever router declares it, answers only the
// Homeroom page itself (middleware/same-site-browser.js). Mounted ahead of
// all of them; the CLI's bearer calls carry no Sec-Fetch-Site and pass.
app.use(['/api/admin', '/api/v4/admin'], require('./src/middleware/same-site-browser').sameOriginBrowserWrites);
app.use(require('./src/middleware/moderation').moderationGuard(config));
app.use(require('./src/routes/moderation').moderationRoutes(config));
app.use(require('./src/routes/app-blocks').appBlockRoutes(config));
app.use(require('./src/services/account-deletion-runtime').trackResponse);
app.use(require('./src/routes/account-deletion').accountDeletionRoutes(config));
app.use(cliBrowserRoutes(config));
// Social identity proofs are a platform account surface, independent of
// the hosted MCP connector. They remain reviewable (with fixtures only) in
// staging even when connector credential minting is disabled there.
app.use(socialIdentityRoutes(config));
// Connector consent decision + connected-chat-product management. These
// need a real platform session, so they mount after authMiddleware — the
// consent POST must never be satisfiable by a bearer token approving itself.
app.use(mcpBrowserRoutes(config));
app.use(authRoutes(config));
// Apple and Google sign-in, and Admin → Sign-in providers, where they are set up.
app.use(require('./src/routes/sign-in-providers').signInProviderRoutes(config));
// Firebase phone sign-in and sign-up (routes/phone-auth.js), pre-login
// (middleware/auth.js PUBLIC_PATHS): fail-closed 404 unless
// FIREBASE_PHONE_AUTH_ENABLED and its three companion values are set
// (src/services/firebase-phone-auth.js).
app.use(require('./src/routes/phone-auth').phoneAuthRoutes(config));
app.use(credentialRoutes(config));
app.use(globalChatRoutes(config));
app.use(appRoutes(config));
app.use(illustrationRoutes(config));
// Shell relay for usernode.uploadFile()/deleteFile()/getStorageUsage()
// (#752): session-cookie authed, called only by public/js/app-view.js's
// storage bridge handler on behalf of the app iframe.
app.use(appFileShellRoutes(config));
app.use(chatRoutes(config));
app.use(conversationRoutes(config));
app.use(require('./src/routes/dictation').dictationRoutes(config));
// #2386: mutual friends — the viewer's own lists, requests and answers.
app.use(friendRoutes(config));
app.use(contentReportRoutes(config));
app.use(proposalHandoffRoutes(config));
// #2779: agent sessions, the per-user conversation that starts changes.
app.use(agentSessionRoutes(config, {
  scheduleInteractiveRecovery: scheduleInteractiveTurnRecovery,
}));
// #4313: the ?demo=1 Needs-you cards' votes, answered before the session
// routers' guard refuses their negative ids (staging only).
app.use(demoNeedsVoteRoutes());
app.use(sessionRoutes(config, {
  scheduleInteractiveRecovery: scheduleInteractiveTurnRecovery,
}));
app.use(voteRoutes(config));
app.use(shotsRoutes(config));
// Demo mode: a creator's synthetic partner proposes, votes and resets, on a
// demo-mode app only (routes/demo-mode.js). Mounted beside the vote routes
// it borrows recordVote/checkAndMerge from.
app.use(demoModeRoutes(config));
// "Suggest this back": a remix's owner sends the copy's changes to the app
// it was copied from, as a proposal there (routes/suggest-back.js).
app.use(require('./src/routes/suggest-back').suggestBackRoutes(config));
app.use(kudosRoutes(config));
// Public read-only apps + contributors API. Mounted after authMiddleware
// like kudosRoutes; reachable anonymously via the `/api/public/` prefix in
// PUBLIC_PATHS (src/middleware/auth.js).
app.use(publicApiRoutes(config));
// Public-profile reads use the anonymous /api/public prefix; owner controls,
// reports and moderation share this router but remain behind authMiddleware.
app.use(publicProfileRoutes(config));
// Waitlist social-connect OAuth round-trip (two-stage waitlist survey).
// Anonymous via the '/waitlist/connect/' PUBLIC_PATHS prefix.
app.use(waitlistConnectRoutes(config));
app.use(issueRoutes(config));
app.use(requestSpecRoutes(config));
app.use(campaignRoutes(config));
app.use(adminRoutes(config));
app.use(adminWorkflowRoutes(config));
// #3654: the Homeroom bot's benchmark (services/bench/), beside its console.
app.use(require('./src/routes/homeroom-bench').homeroomBenchRoutes(config));
// The App bench studio, and the admin connector's reads of the bot and of the
// recent screenshots (routes/bench-studio.js).
app.use(require('./src/routes/bench-studio').benchStudioRoutes(config));
// The Homeroom bot's first-version configurations, and their blind pairs.
app.use(require('./src/routes/bot-configs').botConfigRoutes(config));
// Before & after shots evals: the shots agent's configurations compared with
// the live one on merged proposals, through the admin connector.
app.use(require('./src/routes/shots-evals').shotsEvalRoutes(config));
// Test accounts for first-run testing, minted by a full admin's connector
// session (services/test-accounts.js).
app.use(require('./src/routes/test-accounts').testAccountRoutes(config));
// The programme's challenges (events, their challenges, templates and scoring
// rules) through a full admin's connector session: each door hands on to the
// console's own /api/v4/admin route (routes/challenge-admin.js).
app.use(require('./src/routes/challenge-admin').challengeAdminRoutes(config));
app.use(adminSupportRoutes(config));
app.use(adminUserMergeRoutes(config));
app.use(dashboardRoutes(config));
app.use(uiTelemetryRoutes(config));
app.use(feedbackRoutes(config));
app.use(notificationsRoutes(config));
app.use(collaboratorRoutes(config));
// Session-authenticated user directory for the shell's iframe bridge
// relay (#1195) — must be AFTER authMiddleware; req.user is required.
app.use(appDirectoryRoutes(config));
app.use(approverRoutes(config));
app.use(llmGrantsRoutes(config));
app.use(appPermissionsRoutes(config));
app.use(userAgentFilesRoutes(config));
app.use(topicAttributeRoutes(config));
app.use(boardOrderRoutes(config));
app.use(reportAiRoutes(config));
app.use(workshopAskRoutes(config));
app.use(workshopThemesRoutes(config));
// The hub's since-your-last-visit line (services/since-summary.js).
app.use(sinceSummaryRoutes(config));
// The figures a topic's channel shows above its room (services/topic-figures.js).
app.use(topicFiguresRoutes(config));
// The top-level Workshop screen's per-app counts (#workshop): one query for
// every app the viewer can see. Me-scoped like the ordering routes, so it
// sits behind authMiddleware and refuses an anonymous caller outright.
app.use(workshopOverviewRoutes(config));
// A project's notices on its Workshop tab: settings changed lately and this
// week's card (services/app-notices.js). View access, as its chat is.
app.use(appNoticesRoutes(config));
app.use(messagesOverviewRoutes(config));
// The mark menu's "About Homeroom" pane: the platform's name, tagline and
// version, and its apps / members / merged figures. One cached answer for
// every viewer, so it sits behind authMiddleware beside the other overviews.
app.use(platformAboutRoutes(config));
// The Workshop's placement stage runs when a card arrives on or leaves a
// board — which every route and service announces through ws.pushSessionUpdate
// / pushIssueUpdate — on whichever instance handled the change (the row's
// lease keeps two from racing). Registered here, not under the leader, for
// that reason; the daily re-draft is the leader's sweep below.
{
  const workshopThemes = require('./src/services/workshop-themes');
  if (typeof ws.onBoardChange === 'function') {
    ws.onBoardChange((info) => workshopThemes.noteBoardChange(getPool(config), info));
  }
}
// A promoted head whose checks were deferred because it conflicted with main
// (services/check-admission.js) gets them the moment it measures clean —
// against the preview that is already up for it, so a run rather than a
// rebuild. Measurement happens on whichever instance took the vote, the
// sweep or the capture, so the hook is registered on every instance, like
// the board hook above. The preview machine joins a second kick for the same
// head, so it costs nothing.
{
  const integration = require('./src/services/integration');
  integration.onBecameClean(async (row) => {
    const pool = getPool(config);
    const { rows } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.name AS app_name
         FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
        WHERE cs.id = $1 AND cs.status = 'promoted'
          AND cs.check_state = 'pending' AND cs.check_phase = 'deferred'`,
      [row.id]
    );
    if (!rows[0]) return;
    await require('./src/services/staging-recovery').recheckSessionChecks({
      config, pool, session: rows[0], reason: 'conflict-resolved',
    });
  });
}
app.use(reportSnapshotRoutes(config));
// Home-screen panels (#911): the challenges card's data + its per-user
// show/hide. Me-scoped reads, so it sits behind authMiddleware like the
// ordering routes above.
app.use(homePanelRoutes(config));
// A new account's first run (communities, stage 5): the join screen that
// follows the username and terms steps, and the Getting started card on
// Home. Me-scoped, so behind authMiddleware with the panels above.
app.use(onboardingRoutes(config));
// Free-form home-grid placement: where each app tile and widget sits, per
// breakpoint. Me-scoped like the panels route above.
app.use(homeLayoutRoutes(config));
// Profile customization (#982): the display name / bio / handle write, the
// avatar upload-delete pair, and the viewer's own completed challenges.
// Me-scoped, so behind authMiddleware — the avatar READ side is the
// separate public avatarRoutes mounted above.
app.use(profileRoutes(config));
app.use(stakingRoutes(config));
// #940: saved dev-chat drafts, now server-backed so they follow a user
// across devices. Owner-scoped per session, like the /api/sessions/* family
// in routes/sessions.js.
app.use(chatDraftsRoutes(config));
app.use(agentSessionDraftsRoutes(config));
// #1049: the alternate development flows (Claude Code / Codex web UI) as
// ordinary browser routes rather than MCP-only tools. App-scoped with the
// same 'collab' bar as the other dev surfaces, so behind authMiddleware.
app.use(devFlowRoutes(config));
app.use(pmOrderRoutes(config));
app.use(debugRoutes(config));
app.use(galleryRoutes(config));
// Topochain v4 admin (plan Task 3; architecture decision #2): mounted
// AFTER authMiddleware — req.user is already resolved by the time this
// router's own adminMiddleware runs, exactly like src/routes/admin.js.
app.use(topochainAdminRoutes(config));
// Per-app "Add to Home Screen" (#1508): `/app/<slug>/install` and the
// app's own manifest beside it. AFTER authMiddleware because both need
// req.user (the page renders a sign-in variant without one, the manifest
// 404s), and BEFORE the `app.get('*')` SPA catch-all, which would otherwise
// serve index.html for these clean app paths. The shell's own manifest
// link and public/manifest.webmanifest are untouched — see the route.
app.use(appInstallRoutes(config));
// Invite links (routes/community-invites.js): the API, the anonymous
// preview under /api/public/, and the `/invite/<token>` page. AFTER
// authMiddleware (every route but the preview needs req.user) and BEFORE the
// `app.get('*')` catch-all, which would otherwise answer the page with a
// plain index.html and no link preview.
app.use(communityInviteRoutes(config));
// A private member's waitlist card (routes/member-waitlist.js): joining the
// waitlist from inside, with the account's own email or a confirmed one.
app.use(memberWaitlistRoutes(config));

// Mint the iframe identity token the shell injects into an app iframe.
//
// The token is APP-SCOPED (RS256, audience `usernode:app:<apps.id>`), so
// the caller must name which app it is for: `?app=<slug>`. That is what
// closes the cross-app replay hole the single shared-secret token had —
// every app used to be handed a credential that every OTHER app would
// also accept, so any app operator could take a visitor's token and
// spend it against an unrelated app's API as that user.
//
// The slug is resolved through appAccess.getAppForUser at the 'view'
// level: you cannot mint an identity for an app you are not allowed to
// see. Unknown slug and no-view-access both return the SAME 404 — see
// the comment on that branch.
app.get('/api/iframe-token', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });

  const slug = typeof req.query.app === 'string' ? req.query.app.trim() : '';
  if (!slug) {
    return res.status(400).json({ error: 'app query parameter is required' });
  }

  const pool = getPool(config);
  let appRow;
  try {
    // ACCESS_COLUMNS, not a trimmed list. checkAppAccess() reads
    // `view_visibility` off the row it is handed; trimming it away used to
    // make the gate below silently pass for every app — including the
    // view-private ones whose existence the 404 is here to hide. That
    // default is gone (checkAppAccess now THROWS on a missing column, and
    // the catch below turns it into a 500), but keep the full list: a 500
    // on every iframe token is its own outage.
    appRow = await appAccess.getAppForUser(pool, slug, req.user, 'view', appAccess.ACCESS_COLUMNS);
  } catch (err) {
    log.error('iframe-token', 'App resolve failed', { slug, err: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
  if (!appRow) {
    // Existence-hiding, and deliberately the SAME response for "no such
    // slug" and "you can't view this app". getAppForUser cannot tell the
    // two apart (both are a null return), and splitting them into
    // 400-vs-404 would hand an unauthenticated prober an app-existence
    // oracle for every private app — precisely what the existence-hiding
    // 404 exists to prevent. The 400 above is reserved for a caller that
    // named no app at all, which leaks nothing.
    return res.status(404).json({ error: 'App not found' });
  }

  let usernodePubkey = null;
  // Platform-level language preference (issue #757): a BCP-47 tag or null
  // when unset. Always present in the payload so app servers never need
  // `'locale' in payload` checks.
  let userLocale = null;
  let provisionalHandle = false;
  try {
    const { rows } = await pool.query(
      `SELECT usernode_pubkey, locale, username_provisional_since IS NOT NULL AS provisional
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    usernodePubkey = rows[0]?.usernode_pubkey || null;
    userLocale = rows[0]?.locale || null;
    provisionalHandle = rows[0]?.provisional === true;
  } catch {}
  // A provisional handle (an invite's phone sign-up, made from its name)
  // is for private groups: a public app gets a username the person chose,
  // and the shell asks for one first (services/usernames.js).
  if (provisionalHandle && appRow.view_visibility === 'public') {
    return res.status(409).json(usernames.USERNAME_REQUIRED);
  }

  const tokenUser = {
    id: req.user.id,
    username: req.user.username,
    usernode_pubkey: usernodePubkey,
    locale: userLocale,
  };

  // App-scoped RS256 is the ONLY mint path. There is deliberately no
  // downgrade branch: a staging-only pre-cutover bootstrap shim signed a
  // bare-HS256 token here for the one deploy window in which previews were
  // built by a platform with no IFRAME_JWT_PRIVATE_KEY, and it has been
  // removed. A staging clone — which still gets no platform keys — self-signs
  // an ephemeral pair at boot instead (config.load() →
  // platformJwt.generateStagingIframeKeyPair), so it reaches this line with a
  // real key and takes the identical path production does. A deployment that
  // genuinely cannot sign gets the structured 503 below.
  let token = null;
  let signErr = null;
  try {
    token = platformJwt.signAppIdentityToken({ appId: appRow.id, user: tokenUser });
  } catch (err) {
    signErr = err;
  }

  if (!token) {
    // A missing/broken IFRAME_JWT_PRIVATE_KEY is an operator problem, not a
    // client one, and it is not transient within the life of the process —
    // so say which it is instead of a bare 500.
    // config.load() refuses to boot production without the key, so this is
    // the self-hosted / misconfigured-staging edge.
    log.error('iframe-token', 'Signing failed', { slug, err: signErr && signErr.message });
    return res.status(503).json({
      error: 'App identity signing is not configured on this deployment',
      code: 'signing_unavailable',
    });
  }

  // Gated browser capabilities for THIS user and THIS app (#2219).
  //
  // It rides the token response because of when the shell needs it. A
  // frame's Permissions Policy is computed from `allow` at NAVIGATION, so
  // the granted set has to be in hand on the line before `src` is assigned
  // — which is exactly the line that already has this token. A separate
  // fetch would be a second round trip on the launch path, in the one place
  // the platform measures (docs/preview-performance.md), for data the mint
  // is already authenticated and app-scoped for.
  //
  // `effective` is the intersection of granted and still-declared: a
  // capability an app has dropped from its dapp.json stops being delegated
  // on the next deploy, without the grant row being destroyed.
  //
  // Best-effort by design. A failure here degrades to delegating NOTHING
  // beyond the ungated base, which is the safe direction, and never fails
  // the token the app needs to boot at all.
  let permissions = { declared: [], granted: [], effective: [] };
  try {
    const { rows } = await pool.query(
      'SELECT manifest_snapshot FROM apps WHERE id = $1',
      [appRow.id]
    );
    const declared = declaredFor(rows[0] || {});
    const granted = await grantedCapabilities(pool, appRow.id, req.user.id);
    permissions = { declared, granted, effective: effectiveCapabilities(declared, granted) };
  } catch (err) {
    log.warn('iframe-token', 'Permission read failed; delegating none', {
      slug, err: err.message,
    });
  }

  res.json({ token, permissions });
});

// Bridge centralization: versioned bridge served from /usernode-bridge/vN/.
// Within a major version (e.g. v1), bug fixes ship by editing the file in
// SV and redeploying — every dapp picks the fix up on next page load.
// Browsers must therefore revalidate on every request so changes propagate
// quickly; the file is ~100KB and revalidates via 304 when unchanged.
// Across major versions the URL changes (/v1/ → /v2/) so caches segregate
// naturally. Dapps still vendor their own copy for now; this is the
// additive scaffolding for a future migration off vendoring.
app.use('/usernode-bridge', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  next();
});

// Where the platform is, for the bridge's Homeroom button on an app opened
// at its own address (#3657): the platform origin, the apps domain and the
// site's front door, from this deployment's settings. Same document the
// Kubernetes asset server answers on app hosts (src/services/app-host-config.js).
app.get('/usernode-bridge/v1/platform.json', (_req, res) => {
  const { USERNODE_DOMAIN, USERNODE_APPS_DOMAIN } = require('./src/services/caddy');
  const doc = appHostConfig.appHostConfig({
    platformDomain: USERNODE_DOMAIN,
    appsDomain: USERNODE_APPS_DOMAIN,
    marketingBaseUrl: config.marketingBaseUrl,
  });
  if (!doc) return res.status(404).type('text/plain').send('Not found');
  res.set(appHostConfig.CONFIG_HEADERS);
  return res.send(JSON.stringify(doc));
});

// Build-scoped asset URLs — /b/<build sha>/js/app.js and so on. A deployed
// document loads every script and stylesheet this way, and these are the one
// set of shell responses that may be cached for a year: the URL IS the
// build, so a deploy changes the URL rather than the bytes behind it, and the
// browser gets to keep V8's compiled-code cache for the shell across loads.
// A sha that is not this process's build (the seconds of a blue-green
// rollout, or a document from a build this server has moved past) is served
// under the revalidate policy instead and the worker declines to cache it.
// Same files as the handler below serves at their plain paths; see
// src/services/static-cache.js.
app.use(require('./src/middleware/precompressed-assets').precompressedAssets(path.join(__dirname, 'public')));
app.use(buildScopedAssetHandler(path.join(__dirname, 'public')));
app.get('/sw.js', (_req, res, next) => {
  if (!shellRelease) return next();
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('application/javascript').sendFile(path.join(__dirname, 'public', 'shell', 'worker.js'));
});
app.get('/shell/release.json', (_req, res, next) => {
  if (!shellRelease) return next();
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.json(shellRelease);
});

// Serve the shell's static assets, but force HTML/JS/CSS to revalidate on
// every load (see src/services/static-cache.js). Without this, mobile
// WebViews cached the shell's own /js/app.js on a PR's stable staging URL
// and kept running pre-fix code across redeploys — fixes appeared to have
// no effect ("same as before"). setHeaders runs as `send` streams the file,
// so it reliably overrides send's default `max-age=0`. 304s still apply.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    const cc = shellAssetCacheControl(filePath);
    if (cc) res.setHeader('Cache-Control', cc);
    // Which build these bytes belong to, so the service worker can tell a
    // cached copy that is still current from one a deploy has superseded.
    // Same asset set as the Cache-Control above — see static-cache.js.
    if (cc && path.basename(filePath) === 'index.html') {
      applyShellDocumentHeaders(res, filePath);
    } else if (cc) {
      applyShellBuildHeader(res);
    }
  },
}));

// ── Retired standalone admin pages → #admin console sections (#860) ──────
//
// /admin, /admin-features, /dashboard, /debug and /gallery used to be
// full-browser pages of their own. They are now SECTIONS of the in-app
// admin console, and each of these routes serves a tiny client-side
// redirect stub (public/<name>.html) that rewrites the URL into the
// matching #admin/<section>. The static handler above already serves the
// `.html` forms of the same stubs, so both /admin and /admin.html forward.
//
// The stubs are client-side rather than a server 302 on purpose: a 302's
// own Location fragment wins over the request's, so /admin#campaign-3
// would silently lose the campaign id. Only a stub sees both halves.
//
// Access control is unchanged and lives where it always did — the console
// gates navigation on App.user.isAdmin and every /api/admin/*, /api/debug/*
// and /api/gallery/* endpoint is independently enforced server-side.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/admin-features', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-features.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/debug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'debug.html'));
});

app.get('/gallery', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

app.get('*', (req, res) => {
  if (req.accepts('html')) {
    // Client-side-routing fallback: serve the SPA shell. Same revalidation
    // policy as the static handler so a redeployed index.html (which pulls
    // in fresh /js/*.js) is never pinned in a WebView cache.
    res.setHeader('Cache-Control', shellAssetCacheControl('index.html'));
    // The document carries the build id too — it is the reference the
    // worker compares every cached asset against on this load.
    const indexPath = path.join(__dirname, 'public', 'index.html');
    applyShellDocumentHeaders(res, indexPath);
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ── The error handler, LAST ──────────────────────────────────────────────
//
// #2508: there was no error-handling middleware at all, so anything thrown
// out of a route reached express's own default handler — which writes
// `err.stack` into the response body unless NODE_ENV is 'production', and
// the Dockerfile never set NODE_ENV. See src/middleware/error-handler.js for
// the whole argument; the short version is that a stack trace was one
// unhandled throw away from any client.
//
// It is registered here because express picks the error handler by ARRIVAL
// ORDER: only middleware mounted after a route can catch that route's
// errors. Anything added below this line is outside its reach.
app.use(errorHandler);

// Leadership coordinator for blue-green deploys (assigned in start()).
// During a rollout both colors serve HTTP, but singleton background work
// is gated to the leader so it never double-runs. See services/leadership.js.
let leadership = null;

// What every process does for itself, whatever its role
// (services/process-role.js) and whether or not it leads: each one sweeps
// what only it holds. A staging preview runs none of it, as it runs no
// leader duties (config.runsClusterMaintenance).
function startProcessDuties() {
  // Idle-eviction sweeper. Warm workers cost ~256MB resident; eviction
  // reclaims that memory after a tunable idle period. The CC volume
  // (cc-volume-<sessionId>) is preserved so the next dispatch's
  // re-warm replays prior conversation state via `claude --resume`.
  //
  // WORKER_IDLE_EVICTION_MS is the only knob (default 10min). Lower it
  // if memory headroom shrinks; raise it if we're seeing frequent
  // re-warms in production logs.
  startIdleEvictionSweeper();
}

// Leader-only singleton work. Runs exactly once per cluster — at boot for
// the leader / the single-instance case (PLATFORM_LEADER_LOCK unset), or at
// promotion for a follower whose old leader has exited (blue-green handoff).
// EVERYTHING here either mutates shared cluster state (worker containers,
// PR/merge rows, staging, Postgres roles, GitHub) or is a singleton
// poller/sweeper that must never double-run across the two colors. The
// follower serves HTTP from boot, and so does a web process, which never
// leads (docs/plans/web-and-conductor.md): what the leader sets up or keeps
// in memory and a route reads (the read-only database roles, the admin
// statuses) is recorded for them (platform_db_roles, services/leader-status.js).
async function becomeLeader() {
  log.info('server', 'Running leader duties (role bootstraps, recovery, sweepers)', {
    identity: leadership && leadership.identity,
  });

  // The workflow's timers and services, and the boot backfill: the leader is
  // where they run. A leader without them would leave every governance
  // proposal's timers and work to the next election, with no other path, so
  // a failure stops this process through its own drain (cleanup, on SIGTERM)
  // and another one leads.
  await require('./src/workflow/platform.ts').startWorkflowLoops().catch((err) => {
    log.error('server', 'Workflow loops failed to start; stopping so another process leads', { err: err.message });
    process.kill(process.pid, 'SIGTERM');
  });

  // What leader work keeps in memory and an admin screen reads, written for
  // the processes that do not lead (services/leader-status.js): a web process
  // never does (docs/plans/web-and-conductor.md), and a follower of a rollout
  // reads the same copy.
  const leaderStatus = require('./src/services/leader-status');
  leaderStatus.provide(require('./src/services/homeroom-bot').MEMORY_STATUS_KEY,
    () => require('./src/services/homeroom-bot').memoryStatus());
  leaderStatus.provide('bench-lane', () => require('./src/services/bench/lane').laneStatus());
  leaderStatus.provide('staging-reap.automatic', () => stagingReap.readAutomatic());
  leaderStatus.provide('app-domains.sweep', () => require('./src/services/app-domains').getStatus());
  leaderStatus.provide(require('./src/services/app-storage-cap').LAST_SWEEP_STATUS_KEY,
    () => require('./src/services/app-storage-cap').lastSweep());
  leaderStatus.start({ pool: getPool(config) });

  // #2045: reconcile the shared hosted-asset backend once per rollout.
  //
  // It is otherwise only reconciled from deployApplication, which means a
  // fix to how it is BUILT does not reach a backend that already exists
  // until some child app happens to deploy. An app whose Ingress already
  // carries the asset paths then answers 503 on every one of them — it
  // cannot detect that, cannot serve those paths itself because the Ingress
  // rule wins, and cannot fix it from app code. That is the state #2042
  // left the fleet in, and it is what this call ends.
  //
  // Leader-only and fire-and-forget: the backend is singleton
  // infrastructure, so reconciling it from both colors during a rollout
  // would race two read-then-replace writes at the same Deployment for no
  // benefit. Failure is logged and nothing else — an app deploy retries it,
  // and a platform that cannot reach its own cluster has louder problems.
  if (require('./src/services/application-runtime').mode(config) === 'kubernetes') {
    require('./src/services/kubernetes').ensurePlatformAssetBackend(config)
      .then((name) => log.info('server', 'Hosted-asset backend reconciled', { name }))
      .catch((err) => log.warn('server', 'Hosted-asset backend reconcile deferred', { err: err.message }));
    // The app-host gate follows APP_GATE on every boot, in both directions:
    // on brings it up and routes every app through it, off routes them all
    // straight back (services/kubernetes.js reconcileAppGateIngresses).
    require('./src/services/kubernetes').reconcileAppGateIngresses(config)
      .then((r) => log.info('server', 'App-host gate routing reconciled', r))
      .catch((err) => log.warn('server', 'App-host gate routing reconcile deferred', { err: err.message }));
  }

  // Credential rows deliberately outlive their active period for settings
  // and audit correlation, then age out on the documented schedule.
  const { cleanupCliAuth } = require('./src/services/cli-auth');
  const runCliAuthCleanup = () => cleanupCliAuth(getPool(config))
    .then((counts) => {
      if (Object.values(counts).some((count) => count > 0)) {
        log.info('cli-auth', 'Retention cleanup completed', counts);
      }
    })
    .catch((err) => {
      log.warn('cli-auth', 'Retention cleanup failed', { message: err.message });
    });
  // Six-hourly on the clock leader_sweeps keeps (services/leader-timers.js),
  // rather than once at every election and then on an interval that the
  // next release reset: due at once if it never ran.
  leaderTimers.every('cli-auth-cleanup', runCliAuthCleanup, 6 * 60 * 60 * 1000, { durable: getPool(config) });

  // Before & after shots is private, revision-scoped data: enforce the
  // shorter failed-media and bounded audit-retention windows, and remove
  // copies and checkouts nothing owns any more. Runs themselves are the
  // shots machine's (src/workflow/shots/), which settles and cleans up every
  // run it starts.
  const shotsGc = require('./src/services/shots-gc');
  let shotsGcRunning = false;
  const runShotsGc = () => {
    if (shotsGcRunning) return leaderTimers.SKIPPED;
    shotsGcRunning = true;
    return shotsGc.sweep(config, getPool(config))
      .then((counts) => {
        if (Object.values(counts).some((count) => count > 0)) {
          log.info('shots', 'Retention sweep completed', counts);
        }
      })
      .catch((err) => log.warn('shots', 'Retention sweep failed', { err: err.message }))
      .finally(() => { shotsGcRunning = false; });
  };
  // Six-hourly on the durable clock, like the cleanup above.
  leaderTimers.every('shots-gc', runShotsGc, 6 * 60 * 60 * 1000, { durable: getPool(config) });

  // #616: ensure the read-only prod-debug Postgres role (fresh in-memory
  // password every boot) and refresh its deny-listed grants so tables
  // added by this deploy's migrations are covered. On failure the
  // prod-debug endpoints return 503 and dev sessions run without the
  // capability — boot proceeds normally.
  //
  // #891: these two role bootstraps MUST run in sequence, not concurrently.
  // Both sweep `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public` plus a
  // per-table GRANT loop over the SAME catalog rows, so firing them together
  // (as they were, both un-awaited) made Postgres raise `tuple concurrently
  // updated` on whichever lost. In production prod-debug lost every time —
  // observed 42ms apart across consecutive deploys — and because nothing
  // re-invokes ensureRole, `usernode-debug sql` stayed dead for the entire
  // process lifetime, then the next deploy re-ran the same race. Awaiting
  // them costs a few hundred ms of boot; each still swallows its own
  // failures, so neither can block startup.
  const debugAccess = require('./src/services/debug-access');
  await debugAccess.ensureRole(config).catch((err) => {
    log.warn('server', 'prod-debug role bootstrap failed (capability disabled)', {
      err: err.message,
    });
  });

  // Task 13 fix round: same pattern as debugAccess.ensureRole just above,
  // for the topochain admin SQL console's dedicated read-only, column-
  // scoped Postgres role (src/services/topochain/db-console-role.js) —
  // it, not the regex validation in sql-console.js, is the actual
  // security boundary for POST /api/v4/admin/sql-query/execute. Self-
  // contained (ensureConsoleRole never rejects; it catches its own
  // failures and leaves the capability unavailable), so this `.catch()`
  // is defense-in-depth, matching the debugAccess call above line for
  // line. On failure, execute degrades to a 503 rather than ever running
  // a console query unscoped — boot proceeds normally.
  const topochainConsoleRole = require('./src/services/topochain/db-console-role');
  await topochainConsoleRole.ensureConsoleRole(config).catch((err) => {
    log.warn('server', 'topochain SQL console role bootstrap failed (capability disabled)', {
      err: err.message,
    });
  });

  // A project being set up when its process died is resumed, not failed
  // (services/app-creation-owner.js): each attempt keeps a heartbeat on its
  // row, and the leader takes over one that went quiet, at boot and every
  // minute after. A row nobody owns (from before that) is taken by the old
  // boot rule: at boot, once it is ten minutes old.
  await require('./src/services/app-creation-owner').start(config).catch(() => {});
  // And the first session's card a restart kept out of a new repository
  // (services/app-sketch.js sweepUncommitted): every quarter hour.
  require('./src/services/app-sketch').startCommitSweep(config);

  // A normal failed build deletes itself in services/kubernetes.js. This
  // leader-only boot pass catches terminal Builds left behind if the platform
  // was restarted between kpack reporting failure and that cleanup.
  const applicationRuntime = require('./src/services/application-runtime');
  applicationRuntime.cleanupFailedBuilds(config)
    .then((result) => {
      if (result.deleted) log.info('server', 'Removed failed kpack Builds', result);
    })
    .catch((err) => {
      log.warn('server', 'Failed kpack Build sweep failed', { err: err.message });
    });
  require('./src/services/build-retention').start(config);
  // Ownerless check input Secrets and finished check Pods whose Job is gone:
  // nothing else collects either, and the Secrets count against the worker
  // namespace's quota. Bounded, every quarter hour. See services/check-retention.js.
  require('./src/services/check-retention').start(config);
  // A promoted proposal failing only checks that main failed too, and has
  // since fixed, is brought up to date with main: its preview builds its own
  // copy of the broken fixture until it is. Every five minutes, at most
  // four syncs a pass. See services/fixed-check-sync.js.
  require('./src/services/fixed-check-sync').start(config, getPool(config));
  // Interface text merged in English and not yet in Homeroom's other
  // languages is translated and put to the community as one proposal. Every
  // three hours; a whole language goes as a Message Batch. See
  // services/language-sync-runner.js.
  require('./src/services/language-sync-runner').start(config, getPool(config));

  // Backfill `main_sha` for apps created before #21 added the column.
  // Non-blocking: we log and continue so a single slow/unauthorized
  // repo doesn't delay the server coming up.
  const { backfillMainShas } = require('./src/services/app-version');
  backfillMainShas(getPool(config)).catch((err) => {
    log.warn('server', 'main_sha backfill failed', { err: err.message });
  });

  // Public-only audit: scan existing `apps` rows and log a warning for
  // any repo that's currently private. The worker bootstrap guard
  // refuses to spawn against private repos, so these apps will fail
  // to start a dev session until the user makes the repo public —
  // surfacing them at boot lets operators see the impact ahead of
  // first user contact. Non-blocking.
  auditExistingRepoPrivacy(getPool(config)).catch((err) => {
    log.warn('server', 'private-repo audit failed', { err: err.message });
  });

  // Resume fleet maintenance campaigns interrupted by the restart —
  // campaign state is a DB state machine (maintenance_campaign_apps),
  // so re-entering the loop just continues from the first pending app.
  // Again every two minutes: a driver that stopped anywhere (a follower's
  // run, a process that died) lets its lease lapse, and this takes it up;
  // one still running keeps it (fleet-maintenance.runCampaign).
  const { resumeRunningCampaigns } = require('./src/services/fleet-maintenance');
  const resumeCampaigns = () => resumeRunningCampaigns(config, getPool(config)).catch((err) => {
    log.warn('server', 'Campaign resume failed', { err: err.message });
  });
  resumeCampaigns();
  leaderTimers.every('campaign-resume', resumeCampaigns, 2 * 60 * 1000);

  // The push SENDER claims queued jobs — a singleton. Enqueueing (HTTP
  // side) works on every color; only the leader drains the queue.
  mobilePush.start();
  // Periodically check imported / bot-owned repos for new commits on
  // `main` we didn't make ourselves and redeploy via the same path
  // that the dev-chat merge flow uses. See main-drift-poller.js.
  require('./src/services/main-drift-poller').start(config);
  // Anonymous-shell probe: classifies each running app's shell as
  // public/gated for the landing page's app directory. Re-probes after
  // deploys and hourly. See services/shell-probe.js.
  require('./src/services/shell-probe').start(config);
  // Custom domains (#4405): verify pending claims against public DNS, route
  // verified ones at the edge, and confirm the certificate came. Leader-only,
  // like the probe above; see services/app-domains.js.
  require('./src/services/app-domains').start(config);
  // #1405 path B: fires the "your agent is waiting on you" nudges whose delay
  // has elapsed without the agent standing them down. One query a minute
  // against a partial index; see services/connector-input-waits.js.
  require('./src/services/connector-input-waits').start(config);
  // Production app-container watchdog (#426): restart/rebuild
  // status='running' apps whose `usernode-app-<slug>` container is
  // stopped or missing — the drift poller above only acts on new
  // commits, so without this a dead container 502s forever. Not gated
  // on GitHub config: the fast `docker start` path needs none.
  require('./src/services/app-heal').start(config);
  // #892: resolve progress-estimate rows orphaned by a server restart
  // mid-run. The live backfill only exists inside the turn, so ~10% of runs
  // historically stayed unscored forever — which the v1-vs-v2 accuracy
  // comparison can't afford. See services/estimate-backfill.js.
  require('./src/services/estimate-backfill').start(config);
  // #1374: the once-a-day "what needs your vote" digest. Hourly sweep,
  // advisory-locked so only one instance sends, and the counterweight to
  // new-proposal notifications now defaulting off.
  require('./src/services/vote-digest').start(config);
  // #2684: the Homeroom bot's shadow-mode triage loop. Leader-only for the
  // same reason the digests are — a pass runs container turns that cost
  // money — and inert until an admin switches homeroom_bot_mode on.
  require('./src/services/homeroom-bot').start(config);
  // #3654: its benchmark lane. Leader-only like the bot (a trial runs a
  // container turn that costs money) and inert until an admin launches a run.
  require('./src/services/bench/lane').start(config);
  // Before & after shots evals' runner (services/shots-eval-runner.js).
  // Leader-only for the same reason: a trial builds two copies and runs the
  // shots agent, which costs money. Inert until an admin launches an eval.
  require('./src/services/shots-eval-runner').startRunner(config);
  // #3654 Core v1: the default suite, made from its checked-in definition in
  // the background a little after boot (reads GitHub only; a no-op once it
  // is done). Production and staging, when GitHub is configured.
  require('./src/services/bench/core').startOnBoot(config);
  // #3737: and the taste eval's suite, from its checked-in briefs (rows
  // only: no GitHub, model or worker; nothing runs until an admin launches).
  require('./src/services/bench/taste').startOnBoot(config);
  // #1688: the Friday "this week on <app>" card. Same shape as the digest
  // above — hourly sweep, advisory-locked — posting one card per app into
  // its chat on Fridays, and nothing at all on a quiet week.
  require('./src/services/weekly-digest').start(config);
  // Welcome messages: somebody let in gets a group with the people an admin
  // chose. Leader-only so one Pod sends; the queue row's lock and the
  // message's idempotency key keep a retry from sending twice anyway.
  require('./src/services/welcome-dm').start(config);
  // The Homeroom bot's one welcome to everybody who had an account when it
  // went on for everyone: a few a minute until nobody is left, then never
  // again. Leader-only so one Pod sends; each person's one hello is claimed
  // before the message goes, so a second sender could not send it twice.
  require('./src/services/homeroom-bot-welcome').start(config);
  // Season challenges are read from the points ledger, and until this ran
  // only two of them ever wrote to it without an admin typing the rows in.
  // Leader-only and advisory-locked on top of that, because a tick costs
  // model calls for the two graded challenges.
  require('./src/services/topochain/challenge-scorer').start(config);

  // Adopt any worker containers left over from a previous server run —
  // either still executing or already exited but un-finalized. These
  // orphans are a feature, not a bug: workers are intentionally detached
  // from the server lifecycle so `node --watch` restarts don't interrupt
  // in-flight Claude Code sessions.
  reconcilePendingTurnCleanup(config)
    .catch((err) => {
      log.warn('server', 'Pending turn cleanup reconciliation failed', { err: err.message });
    })
    .then(() => recoverActiveWorkers(config))
    .catch((err) => {
      log.warn('server', 'Worker adoption failed', { err: err.message });
    })
    .finally(() => {
      // Resume headless auto sessions that were 'generating' when the
      // previous process died. Runs after worker adoption so any warm
      // container for a headless session is already registered (the
      // resume path also tolerates adoption not having finished — it
      // falls back to the deterministic container name). Each row is
      // carried forward from its persisted headless_step checkpoint;
      // unresumable rows are marked 'failed' (the pre-resume behavior).
      const { resumeHeadlessRuns } = require('./src/routes/sessions');
      resumeHeadlessRuns(config)
        .catch((err) => {
          log.warn('server', 'Headless resume failed', { err: err.message });
        })
        // #786: last of the recovery chain — repair dev-chat pill bars the
        // restart emptied in shapes that leave NO breadcrumb of their own
        // (a Mayor turn killed mid-stream, a phase-2 wrap-up lost while the
        // worker was merely warm-idle, plus sessions left broken by earlier
        // restarts). Runs after the paths above have claimed their sessions,
        // and its busy / active_turn guards skip anything still in flight.
        .then(() => restoreMissingQuickReplies(config))
        .catch((err) => {
          log.warn('server', 'Quick-reply backfill failed', { err: err.message });
        });
    });
  // What a process leaves behind later (it exits at its drain deadline, or
  // dies) is adopted as it goes, not at the next election: the replaced Pod
  // may still be finishing turns when this one is elected
  // (docs/plans/draining-releases.md). Turns, then headless runs that have
  // not moved for a while and that no live process holds.
  leaderTimers.every('orphan-turn-sweep', () => sweepOrphanTurns(config)
    .catch((err) => log.warn('server', 'Orphan turn sweep failed', { err: err.message })),
  ORPHAN_SWEEP_MS, { firstDelayMs: ORPHAN_SWEEP_MS });
  leaderTimers.every('process-reap', () => processes.reap()
    .catch((err) => log.warn('server', 'Reaping gone processes failed', { err: err.message })),
  5 * 60 * 1000);
  leaderTimers.every('orphan-headless-sweep', () => require('./src/routes/sessions')
    .resumeHeadlessRuns(config, { minIdleMs: ORPHAN_MIN_AGE_MS })
    .catch((err) => log.warn('server', 'Orphan headless sweep failed', { err: err.message })),
  ORPHAN_SWEEP_MS, { firstDelayMs: ORPHAN_SWEEP_MS });
  // And the warm workers of a process that exited: a web process's release
  // or crash elects nobody (docs/plans/web-and-conductor.md), so nobody would
  // adopt and later evict them.
  leaderTimers.every('left-warm-worker-sweep', () => sweepLeftWarmWorkers(config)
    .catch((err) => log.warn('server', 'Left-behind warm worker sweep failed', { err: err.message })),
  LEFT_WARM_SWEEP_MS, { firstDelayMs: LEFT_WARM_SWEEP_MS });

  // Durable deletion tasks survive provider outages and platform restarts.
  const runAccountDeletionCleanup = () => require('./src/services/account-deletion-cleanup')
    .sweep(getPool(config), config).catch(err => log.warn('account-deletion', 'Cleanup sweep failed', { code: err.code }));
  void runAccountDeletionCleanup();
  leaderTimers.every('account-deletion-cleanup', runAccountDeletionCleanup, 60_000);

  // A project created with a description files it as its first request once
  // its repository holds the starter (services/homeroom-bot-dm.js
  // FILEABLE_SQL; 15 Oct 2026, while it is still being set up). The
  // creation hooks in app-creator.js do it; this files one the hooks missed
  // or could not file yet, whether or not the Homeroom bot is on. A no-op on
  // staging.
  const runFirstRequestSweep = () => require('./src/services/homeroom-bot-dm')
    .sweepFirstVersions(getPool(config), config)
    .then((n) => { if (n) log.info('apps', 'First requests filed', { filed: n }); })
    .catch((err) => log.warn('apps', 'First-request sweep failed', { err: err.message }));
  leaderTimers.every('first-request-sweep', runFirstRequestSweep, 5 * 60 * 1000);

  // #2779: delegated connector grants — the agent-session Mayor's, one or two
  // a turn — are dead the moment their turn ends. Keep a week for the audit
  // trail's sake, then remove them and their tokens. Hourly on the durable
  // clock: as a bare setInterval it restarted at every election and, with a
  // release every twenty minutes, hardly ever ran.
  const runDelegationPrune = () => require('./src/services/mcp-oauth')
    .pruneDelegations(getPool(config))
    .then((n) => { if (n) log.info('mcp', 'Pruned ended delegated grants', { count: n }); })
    .catch((err) => log.warn('mcp', 'Delegated-grant prune failed', { code: err.code, message: err.message }));
  leaderTimers.every('delegation-prune', runDelegationPrune, 60 * 60 * 1000, { durable: getPool(config) });

  // Session auto-pause sweeper (separate, longer timer than worker
  // eviction above). Flips long-idle 'active' sessions to 'paused' so
  // they stop counting against the per-user / global session caps. The
  // CC volume + branch + PR are preserved; reopening auto-resumes.
  startConversationAttachmentSweeper(config);
  startSessionAutoPauseSweeper(config);

  // Stale-promoted-PR policy + reversible-archive GC. Warns authors of
  // promoted PRs that have gone quiet, auto-archives them after a grace
  // period, and hard-purges archived CC volumes once their retention
  // window elapses. Day-scale, so it polls on its own slow interval.
  startStalePrSweeper(config);

  // The Workshop's theme sweep: every app opened in the last week gets its
  // board re-checked hourly, and its themes re-drafted once a day when
  // anything changed, or sooner when a tenth of the board did.
  startWorkshopThemeSweeper(config);

  // #2253: measure every app's database against the per-app storage cap,
  // warn its admins on the way up and freeze it read-only at the top.
  startAppStorageCapSweeper(config);

  // Tell the full admins when a server-wide cap (MAX_APPS,
  // MAX_GLOBAL_SESSIONS) nears or reaches its ceiling.
  startPlatformLimitSweeper(config);

  // #4296: a daily digest of errors that should not happen, and an alert
  // when one kind piles up within an hour, for the full admins.
  startPlatformIncidentAlertSweeper(config);

  // #907: release local coding-agent leases whose machine stopped
  // heartbeating, and fail the turn they were holding.
  startLocalAgentLeaseSweeper(config);

  // Agent sessions: a Mayor turn whose process died (a crash, a kill) left
  // its lease to go stale; say in its conversation that it was interrupted,
  // with Retry, and hand the lease back (services/mayor/agent-turn.js).
  require('./src/services/mayor/agent-turn').startInterruptedTurnSweeper({
    pool: require('./src/db/pool').getPool(config),
  });

  // Reconcile open PR sessions ('promoted'/'merging') against GitHub's
  // actual merge state. Reports to the merge-followups machine a merge
  // GitHub made whose own report was lost (a crash between GitHub's answer
  // and the append) — it would otherwise stay 'promoted' and keep showing
  // as "up for voting" forever — and demotes 'merging' rows GitHub never merged (crash mid-merge) back to
  // 'promoted' so the next vote/retry can redrive. See the function body.
  // #390: after the GitHub-state reconcile completes (which demotes
  // crash-stuck 'merging' rows back to 'promoted' so they're eligible
  // again this same boot), re-drive the per-app drain for every app with
  // open proposals so any PR that crossed the vote-majority threshold
  // while the process was down — or whose background merge was lost to the
  // restart — actually merges now instead of waiting for a fresh vote.
  // Both stay off the critical path so the server still comes up
  // immediately, like the other recovery steps below. (A checks run a
  // rollout interrupted is the preview machine's work: claimed again once
  // its lease lapses, and its Jobs are collected rather than started over.)
  const mainWatch = require('./src/services/main-watch');
  recoverStuckMerges(config)
    .then(() => reconcileEligibleMerges(config))
    // #447: after reconciling merge state, hand the preview machine any
    // proposal whose checks were never recorded or were left 'pending' from
    // before it held the row. Off the critical path. (The machine retries
    // the platform's own faults at a release itself: platform.ts.)
    .then(() => reconcileStuckChecks(config))
    // The whole-tree check under direct merges (services/main-watch.js) is
    // fire-and-forget from the process that merged — which, for the
    // platform's own app, is the process the deploy of that merge replaces.
    // A row left at 'running' or 'confirming' by that has no run behind it;
    // re-drive it, or the app reads "checking the last merge" forever (or
    // stays paused with no verdict coming and no Resume verb, since a
    // provisional red hides it). Rows younger than a run's deadline are a
    // live run's and are left alone.
    .then(() => mainWatch.resumeInterrupted(config))
    .catch((err) => {
      log.warn('server', 'Stuck-merge recovery / eligible-merge reconcile failed', {
        err: err.message,
      });
    });
  mainWatch.start(config);

  // Fallback recovery: for sessions whose container is already gone but
  // whose branch is ahead of main (i.e. CC pushed commits during an old
  // pre-autonomous-worker run), complete the PR + staging tail.
  recoverSessions(config).catch((err) => {
    log.warn('server', 'Session recovery failed', { err: err.message });
  });

  // #851: one stale-env preview pass at boot, then on the sweeper's long
  // interval (Pass 7). A restart is exactly when a platform env change has
  // just landed, which is when the fleet is most likely to be holding stale
  // env — the same "a restart is when to look" reasoning the quick-reply
  // backfill documents. This also means the pass still happens at least once
  // per deploy on a host that has the session sweeper disabled
  // (SESSION_AUTOPAUSE_IDLE_MS=0), where Pass 7 never ticks.
  //
  // Ordered after recoverSessions so the vote-backed previews it REBUILDS are
  // already current by the time this looks for ones to tear down. Detached
  // and self-swallowing: sweepStale never throws, and boot must not wait on
  // docker.
  if (stagingReap.staleSweepDue()) {
    stagingReap.sweepStale(config, { isInFlight: (id) => activeWorkersSvc.isSessionBusy(id) })
      .catch((err) => log.warn('server', 'Boot stale-preview sweep failed', { err: err.message }));
  }

  // Merge-debug retention: prune /debug runs (and their cascaded steps)
  // older than the window every six hours, on the durable clock (once at
  // every election, before), so the staging:private merge_debug_* tables
  // can't grow without bound. Off the critical path; swallows its own errors.
  const mergeDebug = require('./src/services/merge-debug');
  const MERGE_DEBUG_RETENTION_DAYS = parseInt(process.env.MERGE_DEBUG_RETENTION_DAYS || '30', 10);
  leaderTimers.every('merge-debug-prune',
    () => mergeDebug.pruneOldRuns(getPool(config), MERGE_DEBUG_RETENTION_DAYS).catch(() => {}),
    6 * 60 * 60 * 1000, { durable: getPool(config) });

  // #451: periodic auto-merge safety net. The boot sequence above runs
  // reconcileEligibleMerges / reconcileStuckChecks exactly once; the live
  // triggers (a vote landing, a checks verdict turning green — see
  // services/visuals.js, services/conflict-resolver.js, routes/votes.js)
  // cover the common case, but a lost broadcast or a crash between the
  // checks-store and its drain trigger could still leave a PR that has both
  // a winning vote AND passing checks sitting in review until the next
  // restart. Re-run the same idempotent, bounded reconcilers on a slow
  // interval so a genuinely-ready proposal can never stall indefinitely.
  // Off the critical path, single-flight per app inside the drain, and a
  // no-op when GitHub isn't wired up. Tunable via ELIGIBLE_MERGE_SWEEP_MS.
  startEligibleMergeSweeper(config);

  // Title auto-heal: retry LLM title generation for PRs/feedback issues
  // that were filed with the fallback template while the Anthropic API was
  // unavailable (services/title-heal.js). Bounded, non-overlapping, no-op
  // while the LLM stays disabled.
  startTitleHealSweeper(config);
}

async function start() {
  const startedAt = Date.now();
  // web, conductor or all (services/process-role.js): read before anything
  // starts, so a value that names no role fails boot here.
  const ownRole = processRole.processRole();
  const migrationsOnStartup = process.env.RUN_MIGRATIONS_ON_STARTUP !== 'false';
  let migration = null;
  // Schema migration is serialized across colors with an advisory lock so
  // two booting platform containers can't run DDL concurrently during a
  // blue-green rollout. No-op wrapper in single-instance mode. Orthogonal
  // to the lock_timeout retry INSIDE migrate() (applySchemaWithLockRetry):
  // this serializes the two colors against each other; that one survives
  // lock contention with pg_dump'ing staging clones.
  // Kubernetes runs the same migration through a bounded pre-deploy Job;
  // Docker/single-server mode keeps the advisory-lock boot migration.
  if (migrationsOnStartup) {
    migration = await withMigrationLock(getPool(config), () => migrate(config));
  }
  const servicesStartedAt = Date.now();
  // This process, and what it holds, for every other one to see
  // (docs/plans/draining-releases.md): before anything here can start work.
  // Never fatal: holds stay this process's own until the database takes them.
  await processes.start({ pool: getPool(config), role: ownRole });
  // The clients every process that runs the workflow machines makes
  // (src/workflow/setup.ts): the push sender, GitHub, the model.
  await require('./src/workflow/setup.ts').startWorkflowClients(config);
  // The workflow runtime (src/workflow/platform.ts): every process appends
  // and waits for outcomes; the loops start in becomeLeader(), or here on a
  // staging preview, which never stands for election but must still decide.
  // Fatal: the machines are the only paths for what they decide (governance
  // has no other), so a process without them exits and is restarted rather
  // than serving without them.
  await require('./src/workflow/platform.ts').startWorkflow(config, { loops: !runsClusterMaintenance() });
  startupDiagnostics = Object.freeze({
    totalMs: Date.now() - startedAt,
    migrationsOnStartup,
    migration,
    servicesMs: Date.now() - servicesStartedAt,
  });

  worker.ensureWorkerImage().catch((err) => {
    log.warn('server', 'Worker image build deferred', { err: err.message });
  });

  // ── Per-instance services ────────────────────────────────────────────
  // Started on EVERY color so a follower can serve traffic the moment the
  // rollout cuts over to it. These are request-serving / in-memory read
  // caches — safe (just briefly redundant) to run in both colors during
  // the rollout overlap.
  //
  // Module-scoped so cleanup() can close it on SIGTERM (#767) — a
  // function-local handle left the listener accepting new connections
  // for the entire drain, then exited from under them.
  const server = app.listen(config.port, () => {
    log.info('server', `Listening on :${config.port}`);
    // The merges into Homeroom this build carries are live now that it serves
    // (a conductor serves nobody: its web processes say so), and this process
    // is up (a second boot in one pod is a crash).
    const platformRelease = require('./src/services/platform-release');
    if (processRole.servesRequests(ownRole)) platformRelease.recordRunning(getPool(config));
    platformRelease.recordBoot(getPool(config));
    if (processRole.servesRequests(ownRole)) require('./src/workflow/platform.ts').releaseServing(getPool(config));
  });
  // Let Envoy retire idle upstream connections at 60s before Node closes them.
  // Keep a 15s margin for transit and timer scheduling; applies to self-previews too.
  server.keepAliveTimeout = 75_000;
  httpServer = server;
  shutdownPool = getPool(config);

  ws.attach(server, config);
  chainPoller.start(config);
  genesisAccounts.start();
  nodeStatus.start({ nodeRpcUrl: process.env.NODE_RPC_URL });
  // Warm the /api/status cache so the first dashboard load doesn't have
  // to wait 1-2s on `docker stats`. Subsequent loads are served from
  // cache via stale-while-revalidate (see services/status.js).
  statusService.start(config);

  // ── Leader-only singleton work ───────────────────────────────────────
  // Elect a single leader across the colors. The leader runs becomeLeader()
  // immediately; a follower serves HTTP now and runs it later, once the old
  // leader exits and frees the advisory lock. Single-instance / dev / tests
  // (PLATFORM_LEADER_LOCK unset) become leader instantly — identical to the
  // pre-blue-green boot path.
  //
  // #1771: a staging preview never stands for election. It is a throwaway
  // clone with its own database, so it would win its own lock instantly and
  // run every fleet duty above against a copy of production's rows — work it
  // cannot do (no docker socket, no GitHub credentials, no fleet) on a timer
  // that never stops. Previews last touched a week ago were measured still
  // holding six warm Postgres connections each, on a server whose
  // max_connections is the stock 100. See config.runsClusterMaintenance.
  //
  // A web process (PROCESS_ROLE=web, docs/plans/web-and-conductor.md) never
  // stands either: the conductor leads, and a release of the web Pods leaves
  // its leader work where it is. What every process does for itself (the
  // idle eviction of its own warm workers, ...) runs from
  // startProcessDuties(), whatever its role.
  if (runsClusterMaintenance()) startProcessDuties();
  if (!runsClusterMaintenance()) {
    log.info('server', 'Leader duties skipped — staging preview serves requests only');
  } else if (!processRole.standsForLeader(ownRole)) {
    log.info('server', 'Leader duties run on the conductor — this web process serves requests only', { role: ownRole });
  } else {
    leadership = createLeadership({ databaseUrl: config.databaseUrl });
    leadership.start(becomeLeader).catch((err) => {
      log.error('server', 'Leadership coordinator failed', { err: err.message });
    });
  }

  return server;
}

// Boot only when run as the entry point (`node server.js` — the Docker CMD
// and npm start path). Tests require() this module to reach the recovery
// internals exported below without starting servers or sweepers.
if (require.main === module) {
  start().catch((err) => {
    // pg's ECONNREFUSED and some Octokit errors leave `.message` empty, so
    // also surface `.code` and the stack — otherwise boot failures print
    // as `{"message":""}` and there's nothing to act on.
    log.error('server', 'Failed to start', {
      message: err.message || '(empty)',
      code: err.code,
      stack: err.stack,
    });
    process.exit(1);
  });
}

// Test-only surface (#183): the orphan-adoption + recovered-turn finalize
// internals, so the headless-recovery guards stay covered by node --test.
// `recoverStuckMerges` rides along so the GitHub-reconciliation sweep stays
// covered too, and `reconcileEligibleMerges` (#390) so the boot-time
// auto-merge eligibility sweep is covered. `cleanup` + `__setShutdownTargets`
// (#767) let tests drive the graceful-shutdown sequence against a stubbed
// listener and pool without booting a server. Not used by any runtime caller.
module.exports = {
  // #4439: the assembled Express app, every middleware and route mounted in
  // order but not listening, so a test can drive the headers production
  // sends with a shell asset (tests/spec-frame-styles.test.js).
  app,
  adoptOrphanWorker,
  // docs/plans/draining-releases.md: the leader's sweep for turns their
  // process left behind.
  sweepOrphanTurns,
  // docs/plans/web-and-conductor.md: and for idle warm workers.
  sweepLeftWarmWorkers,
  // 14 Oct 2026: the idle eviction and the auto-pause sweeper's first pass,
  // each of which leaves a session a durable build holds alone.
  sweepIdleWarmWorkers,
  autoPauseIdleSessions,
  // #1378: the detached-turn resume itself, so tests can prove a stop that
  // lands on an ADOPTED turn terminalizes it as a stop instead of narrating
  // an interruption (or retrying it). Driving it through adoptOrphanWorker
  // would need the journal transport stood up; this is the same seam
  // finalizeRecoveredTurn already exposes one level down.
  resumeDetachedTurnInner,
  // ...and the handle factory it is driven with, so a test exercises the
  // real dual-channel `send` (WS broadcast + session bus, `_seq` and all)
  // rather than a hand-rolled stand-in that could drift from it.
  buildRecoveryStopHandle,
  finalizeRecoveredTurn,
  restoreMissingQuickReplies,
  recoverStuckMerges,
  reconcileEligibleMerges,
  reconcileStuckChecks,
  cleanup,
  // Getters, not values: this module.exports literal is evaluated long
  // before the `const`s down by cleanup(), so a direct reference would hit
  // the temporal dead zone and crash the whole require.
  get DRAIN_TIMEOUT_MS() { return DRAIN_TIMEOUT_MS; },
  get POOL_CLOSE_TIMEOUT_MS() { return POOL_CLOSE_TIMEOUT_MS; },
  get SUCCESSOR_ANNOUNCE_TIMEOUT_MS() { return SUCCESSOR_ANNOUNCE_TIMEOUT_MS; },
  get BUILD_SHUTDOWN_MARK_TIMEOUT_MS() { return BUILD_SHUTDOWN_MARK_TIMEOUT_MS; },
  get SUCCESSOR_WAIT_MS() { return SUCCESSOR_WAIT_MS; },
  shutdownDrainMs: (...args) => shutdownDrainMs(...args),
  // `finishesWork`, `drainMs` and `leadership` stand in for a Kubernetes
  // Pod's drain (docs/plans/draining-releases.md) and its leader lock.
  __setShutdownTargets: ({ server, pool, finishesWork, drainMs, successor, leadership: lead } = {}) => {
    httpServer = server ?? null;
    shutdownPool = pool ?? null;
    cleanupStarted = false;
    shutdownOverrides = { finishesWork, drainMs, successor };
    if (lead !== undefined) leadership = lead;
  },
};

// Scan existing imported apps for privacy violations. Homeroom workers
// run with zero GitHub credentials and rely on unauthenticated public
// HTTPS clones; a private repo can't be cloned by the worker, so dev
// sessions against it will fail at bootstrap. Surface those rows at
// boot so the operator can decide whether to ask the user to make
// the repo public or delete the import.
//
// Bounded concurrency (a small pool) keeps the scan from spending
// minutes on a large `apps` table during startup. The check is purely
// read-only — we log and move on.
async function auditExistingRepoPrivacy(pool) {
  const github = require('./src/services/github');
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT id, slug, repo_url FROM apps
       WHERE repo_url IS NOT NULL AND status != 'archived'`
    ));
  } catch (err) {
    log.warn('server', 'private-repo audit: query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  log.info('server', 'Starting private-repo audit', { count: rows.length });

  // Cap concurrency so a 100-row deployment doesn't fire 100 GitHub
  // API calls in parallel and trip secondary rate limits.
  const CONCURRENCY = 4;
  const queue = rows.slice();
  let privateCount = 0;
  let errorCount = 0;

  // One read per app on every boot, and only a log line comes of it, so it
  // is the first thing to give way when GitHub's hourly budget is nearly
  // used up (services/github-budget.js): a rollout right after the budget
  // ran out must not spend what is left on an audit.
  const githubBudget = require('./src/services/github-budget');
  let held = false;
  async function worker() {
    while (queue.length) {
      if (!githubBudget.budgetAllows('background')) { held = true; return; }
      const row = queue.shift();
      const m = (row.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!m) continue;
      const [, owner, repo] = m;
      try {
        const result = await github.checkRepoPublic(owner, repo);
        if (!result.ok) {
          errorCount++;
          log.warn('server', 'private-repo audit: lookup failed', {
            appId: row.id, slug: row.slug, repo: `${owner}/${repo}`, err: result.message,
          });
        } else if (result.private) {
          privateCount++;
          log.warn('server', 'private-repo audit: app references a PRIVATE repo (dev sessions will fail)', {
            appId: row.id, slug: row.slug, repo: `${owner}/${repo}`,
          });
        }
      } catch (err) {
        errorCount++;
        log.warn('server', 'private-repo audit: unexpected error', {
          appId: row.id, slug: row.slug, err: err.message,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  log.info('server', 'Private-repo audit complete', {
    total: rows.length, private: privateCount, errors: errorCount,
    ...(held ? { heldForGithubBudget: queue.length } : {}),
  });
}

// Reconcile open PR sessions against GitHub's actual merge state.
// See the call site for rationale.
//
// Two failure modes are healed here:
//   1. A session merged on GitHub whose post-merge step (prod rebuild,
//      etc.) failed, leaving the row stuck in 'promoted'/'merging' even
//      though the PR is merged. Such a row keeps appearing in the Dev
//      forum's vote panel forever (GET /api/apps/:slug/promoted returns
//      `status IN ('promoted','merging')`). This is the whiteboard
//      #41/#44/#52/#54 bug.
//   2. A crash mid-merge that left a row in 'merging'. If GitHub never
//      merged it, flip it back to 'promoted' so the next vote/retry can
//      redrive (the original recoverStuckMerges behavior).
//
// We ask GitHub the truth rather than guessing. Bounded concurrency keeps
// the boot scan cheap; genuinely-open PRs simply report merged=false and
// are left untouched (only 'merging' rows are demoted to 'promoted').
//
// Every lookup spends GitHub's hourly budget, and on 9 Oct 2026 this sweep
// was one of the callers refused when the bot token ran out (21 refusals in
// a minute). So:
//   - It is background work: it asks services/github-budget.js before each
//     lookup and stops for the hour once the reserve is reached.
//   - A refusal for the hourly limit ends the sweep: every remaining lookup
//     would be refused too, and still counted.
//   - The timer sweep (attemptedOnly) revisits a demoted attempt every time
//     for its first hour, while GitHub may still report a merge the platform
//     lost, and once an hour after that. A merge attempt is never cleared,
//     so every open proposal that ever tried to merge used to cost one
//     lookup per sweep, every four minutes, for as long as it stayed open.
//     A row still 'merging' is looked up every time.
const RECENT_MERGE_ATTEMPT_MS = 60 * 60 * 1000;
const OLD_MERGE_ATTEMPT_RECHECK_MS = 60 * 60 * 1000;
// sessionId -> when the timer sweep last looked up its old attempt.
const oldMergeAttemptLookedUpAt = new Map();

async function recoverStuckMerges(config, { attemptedOnly = false, now = Date.now } = {}) {
  const { getPool } = require('./src/db/pool');
  const github = require('./src/services/github');
  const githubBudget = require('./src/services/github-budget');
  const mergeLock = require('./src/services/merge-finalization-lock');
  const pool = getPool(config);
  const workflow = require('./src/workflow/platform.ts');

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT cs.id, cs.app_id, cs.status, cs.pr_number, cs.merge_commit_sha,
              cs.merge_attempt_at,
              a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON a.id = cs.app_id
        WHERE cs.status IN ('promoted', 'merging')
          AND (NOT $1::boolean OR cs.status = 'merging' OR cs.merge_attempt_at IS NOT NULL)`,
      [attemptedOnly]
    ));
  } catch (err) {
    log.warn('server', 'recoverStuckMerges query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  // Without GitHub auth the outcome is unknown. Keep the claim until a
  // later sweep can ask GitHub; a blind demotion can reopen a merged PR.
  if (!github.isEnabled()) {
    const merging = rows.filter((row) => row.status === 'merging').length;
    if (merging) log.warn('server', 'Cannot reconcile merging sessions without GitHub auth', { count: merging });
    return;
  }

  // An old attempt the timer looked up within the hour waits its turn.
  let deferred = 0;
  if (attemptedOnly) {
    const listed = new Set(rows.map((row) => row.id));
    for (const id of oldMergeAttemptLookedUpAt.keys()) {
      if (!listed.has(id)) oldMergeAttemptLookedUpAt.delete(id);
    }
    rows = rows.filter((row) => {
      if (row.status === 'merging' || !row.merge_attempt_at) return true;
      if (now() - new Date(row.merge_attempt_at).getTime() < RECENT_MERGE_ATTEMPT_MS) return true;
      const last = oldMergeAttemptLookedUpAt.get(row.id);
      if (last && now() - last < OLD_MERGE_ATTEMPT_RECHECK_MS) { deferred++; return false; }
      return true;
    });
    if (!rows.length) return;
  }

  log.info('server', 'Reconciling open PR sessions against GitHub', { count: rows.length, deferred });

  const CONCURRENCY = 4;
  const queue = rows.slice();
  let healed = 0;
  let demoted = 0;
  let errors = 0;
  let held = 0;
  let stoppedForLimit = false;

  async function worker() {
    while (queue.length) {
      if (!githubBudget.budgetAllows('background')) {
        held += queue.length;
        queue.length = 0;
        break;
      }
      const row = queue.shift();
      const release = await mergeLock.acquire(pool, row.id, { tryOnly: true });
      if (!release) continue; // A live process still owns this merge.
      try {
        const oldAttempt = !row.merge_attempt_at
          || Date.now() - new Date(row.merge_attempt_at).getTime() >= 5 * 60 * 1000;
        const m = (row.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
        if (!m || !row.pr_number) {
          // The repository or PR identity is missing; there is no safe
          // inference about the irreversible GitHub operation.
          continue;
        }
        const [, owner, repo] = m;
        try {
          const pr = await github.getPR(owner, repo, row.pr_number);
          if (attemptedOnly) oldMergeAttemptLookedUpAt.set(row.id, now());
          if (pr && pr.merged) {
            // The merge-followups machine records the merge and runs every
            // follow-up the lost report would have (F2), not only the status.
            await workflow.mergeObserved({
              sessionId: row.id, appId: row.app_id,
              mergeSha: pr.merge_commit_sha || null, mergedAt: pr.merged_at || null,
            });
            healed++;
            log.info('server', 'Reported a merged-on-GitHub session to the merge-followups machine', {
              sessionId: row.id, prNumber: row.pr_number, repo: `${owner}/${repo}`, mergeSha: pr.merge_commit_sha || null,
            });
          } else if (row.status === 'merging' && oldAttempt) {
            // Not merged on GitHub and stuck in 'merging' (crash mid-merge):
            // demote so the next vote/retry can redrive.
            const { rowCount } = await pool.query(
              `UPDATE chat_sessions SET status = 'promoted'
                WHERE id = $1 AND status = 'merging'
                  AND (merge_attempt_at IS NULL OR merge_attempt_at < NOW() - interval '5 minutes')`,
              [row.id]
            ).catch(() => ({ rowCount: 0 }));
            if (rowCount) demoted++;
          }
          // Not merged + 'promoted' == genuinely open proposal: leave alone.
        } catch (err) {
          errors++;
          if (githubBudget.isRateLimitError(err)) {
            // The hour is used up: the rest of the queue would be refused
            // too. The next sweep after the reset picks them up.
            if (!stoppedForLimit) {
              stoppedForLimit = true;
              log.warn('server', 'recoverStuckMerges: GitHub\'s hourly limit is used up; stopping until the next sweep', {
                sessionId: row.id, prNumber: row.pr_number, repo: `${owner}/${repo}`,
                left: queue.length,
              });
            }
            held += queue.length;
            queue.length = 0;
          } else {
            log.warn('server', 'recoverStuckMerges: GitHub lookup failed', {
              sessionId: row.id, prNumber: row.pr_number,
              repo: `${owner}/${repo}`, err: err.message,
            });
          }
          // A failed lookup is not proof the merge failed. The next timer
          // sweep retries without changing this session's status.
        }
      } finally {
        await release();
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  } catch (err) {
    log.warn('server', 'recoverStuckMerges reconciliation failed', { err: err.message });
  }
  log.info('server', 'PR session reconciliation complete', {
    scanned: rows.length, healed, demoted, errors,
    ...(held ? { heldForGithubBudget: held } : {}),
  });
}

// Boot-time auto-merge reconcile sweep (#390). recoverStuckMerges above
// reconciles each open session's status against GitHub's actual merge
// state, but it deliberately leaves genuinely-open 'promoted' rows alone
// (see its body: "Not merged + 'promoted' == genuinely open proposal:
// leave alone"). It never re-checks whether a proposal has crossed the
// vote-majority threshold.
//
// Auto-merge is otherwise PURELY event-driven: a merge is only attempted
// in the background of a live vote (routes/votes.js fires checkAndMerge
// fire-and-forget). So a proposal that crossed threshold while the process
// was down — or whose background merge was lost to a restart mid-flight,
// or that became eligible because the active-user count (and thus the
// majority) dropped — sits in the Dev vote panel forever until someone
// happens to cast a fresh vote. That is the "auto-merge stops after
// restart/update" bug.
//
// The fix re-drives the existing per-app drain (checkAndResolveConflicts →
// drainApp) once at boot for every app that has any open proposal. The
// drain re-reads everything from Postgres, only ever touches PRs already
// at/above the active-user majority (the same bar checkAndMerge gates on,
// so nothing below threshold is resolved pre-emptively — #380), merges
// them in the normal priority order, and inherits the normal single-flight
// + Phase 1/Phase 2 conflict handling. It is idempotent and safe to run on
// every boot. Bounded cross-app concurrency keeps a many-app fleet from
// fanning out unbounded GitHub calls; per-app work is already serialized
// by the drain's own single-flight.
async function reconcileEligibleMerges(config) {
  const github = require('./src/services/github');
  // Without GitHub auth the drain's per-session resolve is a no-op
  // (github_disabled_or_no_pr merges nothing), so skip the work entirely —
  // matches the no-auth short-circuit in recoverStuckMerges above.
  if (!github.isEnabled()) return;

  const { getPool } = require('./src/db/pool');
  const { checkAndResolveConflicts } = require('./src/services/conflict-resolver');
  const pool = getPool(config);

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT DISTINCT app_id FROM chat_sessions WHERE status = 'promoted'`
    ));
  } catch (err) {
    log.warn('server', 'reconcileEligibleMerges query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  log.info('server', 'Reconciling eligible auto-merges on startup', { apps: rows.length });

  const CONCURRENCY = 4;
  const queue = rows.slice();
  let drained = 0;
  let errors = 0;

  async function worker() {
    // A drain started now would die with the process; the next leader's boot
    // reconcile takes every app with open proposals.
    while (queue.length && !lifecycle.isShuttingDown()) {
      const { app_id: appId } = queue.shift();
      try {
        await checkAndResolveConflicts(config, { app_id: appId });
        drained++;
      } catch (err) {
        // checkAndResolveConflicts swallows drainApp errors internally, so
        // this is belt-and-braces; never let one app's failure abort the rest.
        errors++;
        log.warn('server', 'reconcileEligibleMerges: drain failed', {
          appId, err: err.message,
        });
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  } catch (err) {
    log.warn('server', 'reconcileEligibleMerges sweep failed', { err: err.message });
  }
  log.info('server', 'Eligible auto-merge reconciliation complete', {
    apps: rows.length, drained, errors,
  });
}

// #447: how long a 'pending' check may sit before it's treated as stuck.
// The headless capture run is capped at RUN_TIMEOUT_MS (240s in
// services/visuals.js) plus the staging build, so 10 minutes is comfortably
// beyond any legitimately in-flight run. Tunable via CHECKS_STALE_MS.
const CHECKS_STALE_MS = stagingRecovery.checksStaleMs();

// #237: crash-loop short-circuit. A staging build that crashes deterministically
// (e.g. an app whose staging-only seed hits a missing constraint) used to be
// retried by the sweeper every sweep forever — a silent, churning deadlock.
// Build/boot failures now land a terminal 'error' verdict (services/visuals
// storeChecks) with an exponential backoff retry schedule (check_next_retry_at:
// 2m → 4m → … → 30m). The sweeper only re-picks an errored row once its backoff
// has elapsed AND it's still under this cap; past the cap we stop auto-retrying
// and leave it 'error' (the owner is already notified, and a NEW commit resets
// the streak via setChecksPending so a fix re-enables checks). Tunable via
// CHECK_MAX_AUTO_RETRIES; read in staging-recovery.
const CHECK_MAX_AUTO_RETRIES = stagingRecovery.checkMaxAutoRetries();

// A turn or a hand-off tail still working on the session submits its own
// revision when it finishes; the stuck sweep leaves the session to it.
function checkRecoveryInFlight(sessionId) {
  return activeWorkersSvc.isSessionBusy(sessionId) || hasInFlightHandoffPipeline(sessionId);
}

// #447: reconcile stuck proposal checks. A submitted CLI handoff or a
// promoted PR whose checks were never recorded (NULL), were left 'pending'
// from before the preview machine held the row, or errored before it did,
// is handed to the machine (findStuckCheckSessions leaves out every session
// the machine is building, checking or retrying). Drafts and unsubmitted
// uploads stay out. Bounded per run like the staging-heal sweep; runs at
// boot and from the session sweeper (Pass 4). Safe + idempotent on every
// boot.
async function reconcileStuckChecks(config) {
  const github = require('./src/services/github');
  // Without GitHub auth a rebuild/capture is a no-op (rebuildSessionStaging
  // returns 'skipped' with no bot token), so skip the work entirely.
  if (!github.isEnabled()) return;

  const { getPool } = require('./src/db/pool');
  const pool = getPool(config);

  let rows;
  try {
    ({ rows } = await stagingRecovery.findStuckCheckSessions({
      pool,
      staleMs: CHECKS_STALE_MS,
      maxAutoRetries: CHECK_MAX_AUTO_RETRIES,
      limit: 50,
    }));
  } catch (err) {
    log.warn('server', 'reconcileStuckChecks query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;

  log.info('server', 'Reconciling stuck proposal checks on startup', { count: rows.length });

  const MAX_RECHECKS = 5;
  let rechecked = 0;
  for (const session of rows) {
    if (rechecked >= MAX_RECHECKS) break;
    if (checkRecoveryInFlight(session.id)) continue;
    rechecked++;
    try {
      await stagingRecovery.recheckSessionChecks({
        config, pool, session, reason: 'stuck-checks-boot',
      });
    } catch (err) {
      log.warn('server', 'reconcileStuckChecks recheck failed', {
        sessionId: session.id, err: err.message,
      });
    }
  }
  log.info('server', 'Stuck-check reconciliation complete', {
    scanned: rows.length, rechecked,
  });
}

// #451: how often the auto-merge safety-net sweep runs. A few minutes is
// well below the cost of letting a ready proposal linger but far above the
// per-pass work (one indexed query per app with an open proposal, then the
// single-flight drain). Tunable via ELIGIBLE_MERGE_SWEEP_MS; floored so a
// mis-set tiny value can't busy-loop the drain.
const ELIGIBLE_MERGE_SWEEP_MS = Math.max(
  parseInt(process.env.ELIGIBLE_MERGE_SWEEP_MS || String(4 * 60 * 1000), 10) || (4 * 60 * 1000),
  30 * 1000
);

// #451: periodic re-drive of the boot-time auto-merge reconcilers. Both
// reconcileEligibleMerges (merge any promoted PR that now has votes + passing
// checks) and reconcileStuckChecks (re-run checks left 'pending'/NULL by a
// mid-capture restart, so they reach a terminal verdict the eligible-merge
// pass can then act on) are idempotent and bounded, so re-running them on a
// timer is safe. Guards: skip when GitHub isn't enabled (both are no-ops
// then), never overlap a still-running sweep, and swallow all errors so the
// timer can't crash the process. A leader timer (services/leader-timers.js):
// no pass starts once shutdown has begun, and one under way is drained.
function startEligibleMergeSweeper(config) {
  const github = require('./src/services/github');
  let running = false;
  leaderTimers.every('eligible-merge-sweep', () => {
    if (running) return undefined;
    if (!github.isEnabled()) return undefined;
    running = true;
    return Promise.resolve()
      // A merge request may outlive a leader rollout. Revisit attempts even
      // after demotion, since GitHub may report their merge a little later.
      .then(() => recoverStuckMerges(config, { attemptedOnly: true }))
      .then(() => reconcileStuckChecks(config))
      .then(() => reconcileEligibleMerges(config))
      .catch((err) => {
        log.warn('server', 'Eligible-merge sweep tick failed', { err: err.message });
      })
      .finally(() => { running = false; });
  }, ELIGIBLE_MERGE_SWEEP_MS);
}

// How often the title auto-heal sweep runs (services/title-heal.js). Ten
// minutes keeps the placeholder window short once credits/API come back
// without hammering a still-dead API (each pass is a handful of Haiku
// calls at most, and issue rows carry their own per-row backoff on top).
// Tunable via TITLE_HEAL_SWEEP_MS; floored so a mis-set value can't spin.
const TITLE_HEAL_SWEEP_MS = Math.max(
  parseInt(process.env.TITLE_HEAL_SWEEP_MS || String(10 * 60 * 1000), 10) || (10 * 60 * 1000),
  60 * 1000
);

// Periodic re-drive of title generation for fallback-titled PRs and
// feedback issues. Same guard shape as startEligibleMergeSweeper: never
// overlap a still-running pass, swallow all errors, unref'd timer. An
// early first pass (~90s after boot) covers the common "credits restored,
// platform redeployed" sequence so placeholders heal right away instead
// of waiting out the first full interval.
function startTitleHealSweeper(config) {
  const titleHeal = require('./src/services/title-heal');
  let running = false;
  const tick = () => {
    if (running) return undefined;
    running = true;
    return titleHeal.sweep(config)
      .catch((err) => {
        log.warn('server', 'Title-heal sweep tick failed', { err: err.message });
      })
      .finally(() => { running = false; });
  };
  leaderTimers.every('title-heal', tick, TITLE_HEAL_SWEEP_MS, { firstDelayMs: 90 * 1000 });
}

// #907: how often expired local-agent leases are swept. A lease is a 120s
// TTL refreshed by a 30s heartbeat, so a machine that goes to sleep is
// already ignorable within two minutes on read (every query filters on
// expires_at). The sweep exists to mark the row released and fail any turn
// still sitting on it, so the dev chat stops saying "running on your
// machine" about a laptop in a bag. One minute is well inside that TTL.
const LOCAL_AGENT_SWEEP_MS = 60 * 1000;

// Release leases whose machine stopped heartbeating. Same guard shape as the
// sweepers above: never overlap a running pass, swallow every error, unref'd
// timer so it can't hold the process open during shutdown.
function startLocalAgentLeaseSweeper(config) {
  const localAgent = require('./src/services/local-agent');
  const { getPool } = require('./src/db/pool');
  let running = false;
  const tick = () => {
    if (running) return undefined;
    running = true;
    return localAgent.sweepExpiredLeases(getPool(config))
      .catch((err) => {
        log.warn('server', 'Local-agent lease sweep tick failed', { err: err.message });
      })
      // A turn the sweep just failed may have lost its waiter too (the
      // restart that took the platform took the laptop's connection with
      // it): finish it now rather than on the next recovery tick.
      .then(() => recoverLocalAgentTurns(config))
      .finally(() => { running = false; });
  };
  leaderTimers.every('local-agent-lease-sweep', tick, LOCAL_AGENT_SWEEP_MS);
  // Turns whose platform-side waiter died with its process are taken over
  // and finished (services/local-agent-recovery.js): at boot, and on a
  // tick well inside the waiter's stale window.
  recoverLocalAgentTurns(config);
  leaderTimers.every('local-agent-recovery', () => recoverLocalAgentTurns(config), LOCAL_AGENT_RECOVERY_MS);
}

const LOCAL_AGENT_RECOVERY_MS = 15 * 1000;
let localAgentRecoveryRunning = false;

// One recovery pass; never overlaps itself, never throws. The turns it takes
// over are finished in the background (a turn still running on the laptop
// is waited for), so a pass is one UPDATE.
async function recoverLocalAgentTurns(config) {
  if (localAgentRecoveryRunning) return 0;
  localAgentRecoveryRunning = true;
  try {
    const { adopted } = await require('./src/services/local-agent-recovery').recoverOrphanedLocalTurns({
      config,
      pool: getPool(config),
      deps: { finalizeRecoveredTurn, buildRecoveryStopHandle },
    });
    return adopted;
  } catch (err) {
    log.warn('server', 'Local-agent turn recovery pass failed', { err: err.message });
    return 0;
  } finally {
    localAgentRecoveryRunning = false;
  }
}

// stagingNeedsRebuild + rebuildSessionStaging moved to
// src/services/staging-recovery.js so the startup recovery, the heal
// sweep (Pass 3), and the on-demand ensure-staging route share one
// implementation. Imported as stagingRecovery at the top of this file.

// Recover sessions where CC finished but post-processing didn't complete,
// AND promoted/merging PRs whose staging preview is missing or dead.
//
// The staging gap: GC (sweeper Pass 2 → teardownStagingForSession) retires
// the preview of an idle session, and a container can also be lost
// independently (host restart that didn't bring it back, manual cleanup,
// crash). Either way a promoted PR's group-chat vote card loses its
// working preview. recoverSessions hands these to the preview machine on
// startup; the sweeper's Pass 3 does it live without a restart. The
// liveness check (stagingNeedsRebuild) means healthy, still-running
// previews are left untouched — only genuinely broken ones are rebuilt.
async function recoverSessions(config) {
  const { getPool } = require('./src/db/pool');
  const pool = getPool(config);

  const { rows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
     FROM chat_sessions cs
     JOIN apps a ON cs.app_id = a.id
     WHERE cs.status IN ('active', 'promoted', 'merging')
       AND cs.branch_name IS NOT NULL
       -- #3654: a benchmark trial's session never gets a staging preview.
       AND cs.user_id NOT IN (SELECT id FROM users WHERE username = 'homeroom_bench' AND is_synthetic = TRUE)`
  );

  for (const session of rows) {
    try {
      // A live process still working on the session (the Pod a release
      // replaced, finishing a turn: docs/plans/draining-releases.md) submits
      // its revision itself.
      if ((await processes.holders(['session'], session.id, pool)).length) continue;
      if (!(await stagingRecovery.stagingNeedsRebuild(session, { config }))) continue;
      // The machine rebuilds what it served (PreviewLost) or builds the head
      // it is handed; a preview it is still building or retrying is left to
      // it (staging-recovery.rebuildSessionStaging).
      await stagingRecovery.rebuildSessionStaging({ config, pool, session, reason: 'startup' });
    } catch (err) {
      log.warn('server', 'Failed to recover session', { sessionId: session.id, err: err.message });
    }
  }
}

// Boot-time dev-chat quick-reply backfill (#786).
//
// The recovery paths above each drop a breadcrumb carrying pills, but two
// restart shapes leave no breadcrumb at all and so no pills:
//
//   1. A Mayor-only turn (no dispatch) killed mid-stream. It isn't in
//      activeWorkers, so the 5s drain doesn't wait for it and nothing is
//      persisted — the session's last rows are the user's message and the
//      "Thinking about your request..." status line, and the user has no
//      indication their message was dropped.
//   2. A phase-2 wrap-up lost while the worker was already warm-idle:
//      adoptOrphanWorker's warm-idle branch adopts silently (correctly —
//      nothing was interrupted), so the dispatch turn's pills, which only
//      ever come from phase 2, never land.
//
// Both leave the newest user/assistant row without quickReplies, which is
// exactly what the client's pill resolution reads. Repair them in place:
// attach derived pills to an assistant row, or post the missed-reply
// breadcrumb when the turn died before replying at all. The reap/skip
// decision itself is the pure classifyMissingPills policy in
// services/recovery-pills.js.
//
// Deliberately a one-shot boot sweep (not a sweeper pass): the shapes it
// heals are created by a restart, so a restart is exactly when to look.
// Bounded by LIMIT + a recency window so a large history can't make boot
// recovery expensive. Exported for tests.
const QR_BACKFILL_LIMIT = 200;
const QR_BACKFILL_WINDOW_DAYS = 7;

async function restoreMissingQuickReplies(config) {
  const pool = getPool(config);
  const { broadcastGlobal } = require('./src/services/ws');

  const { rows } = await pool.query(
    `SELECT id, pr_number, spec_md, agent_session_id FROM chat_sessions
     WHERE status IN ('active', 'promoted')
       AND source IS DISTINCT FROM 'imported'
       AND is_headless = FALSE
       AND active_turn IS NULL
       AND last_activity_at > NOW() - make_interval(days => $1::int)
     ORDER BY last_activity_at DESC
     LIMIT $2`,
    [QR_BACKFILL_WINDOW_DAYS, QR_BACKFILL_LIMIT]
  );
  if (!rows.length) return;

  let attached = 0;
  let breadcrumbs = 0;
  let skipped = 0;

  for (const session of rows) {
    try {
      // A change an agent session started has no dev chat of its own: its
      // rows are the conversation's, whose Mayor holds a lease of its own
      // (agent-sessions.js) and whose dead turns end, once that lease is
      // stale, with the conversation's own Retry note (agent-turn.js
      // sweepInterruptedTurns). A Mayor turn still running on this pod or
      // another sets no busy flag on the change, so this sweep would read
      // its message as unanswered, bell "stopped before finishing", and pin
      // dev-chat pills onto the conversation's Mayor rows. None of that is
      // this sweep's to say.
      if (session.agent_session_id != null) { skipped++; continue; }
      // A live consumer owns this session right now (a detached-turn
      // resume started above, a turn came in while we were sweeping, or a
      // Mayor turn this process is still answering: its stop handle is
      // registered from the turn's first token) — its own
      // wrap-up/breadcrumb will supply the pills.
      if (activeWorkersSvc.isSessionBusy(session.id) || stopRegistry.get(session.id)) {
        skipped++;
        continue;
      }

      // System rows are transparent to the client's pill resolution, so
      // the deciding row is the newest user/assistant one.
      const { rows: lastRows } = await pool.query(
        `SELECT id, role, content, metadata FROM chat_session_messages
         WHERE session_id = $1 AND role IN ('user', 'assistant')
         ORDER BY id DESC LIMIT 1`,
        [session.id]
      );
      const lastRow = lastRows[0] || null;
      const verdict = recoveryPills.classifyMissingPills({ lastRow });

      if (verdict === 'attach_assistant') {
        const kind = recoveryPills.backfillKindForSession({
          hasPr: session.pr_number != null,
          hasSpec: !!(session.spec_md || '').trim(),
        });
        const pills = recoveryPills.buildRecoveryQuickReplies(kind);
        if (!pills) { skipped++; continue; }
        await pool.query(
          `UPDATE chat_session_messages
           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{quickReplies}', $1::jsonb)
           WHERE id = $2`,
          [JSON.stringify(pills), lastRow.id]
        );
        attached++;
        continue;
      }

      if (verdict === 'breadcrumb_unanswered') {
        // Idempotence across boots: if this sweep already posted its
        // breadcrumb (and the user hasn't sent anything since), the row is
        // still the session's newest system row.
        const { rows: sysRows } = await pool.query(
          `SELECT content FROM chat_session_messages
           WHERE session_id = $1 AND role = 'system'
           ORDER BY id DESC LIMIT 1`,
          [session.id]
        );
        // #896: match earlier wordings too — the breadcrumb text changed,
        // and comparing only against the current string would post a
        // second breadcrumb on top of a pre-rename one at the next boot.
        if (sysRows.length && recoveryPills.isUnansweredBreadcrumb(sysRows[0].content)) {
          skipped++;
          continue;
        }
        const pills = recoveryPills.buildRecoveryQuickReplies('unanswered', {
          lastUserText: lastRow.content || '',
        });
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [session.id, recoveryPills.UNANSWERED_BREADCRUMB,
            JSON.stringify({
              ...(pills ? { quickReplies: pills } : {}),
              recovered: true,
              recoveredReason: 'unanswered',
            })]
        );
        broadcastGlobal({
          type: 'session_event', sessionId: session.id, event: 'status',
          text: recoveryPills.UNANSWERED_BREADCRUMB,
          quickReplies: pills || undefined,
        });
        // #3181: the turn died before it could answer, which is a session
        // that stopped before finishing. Once per breadcrumb: the check
        // above skips a session this sweep already narrated.
        await notifyTurnStalled(pool, session.id);
        breadcrumbs++;
        continue;
      }

      skipped++;
    } catch (err) {
      skipped++;
      log.warn('server', 'Quick-reply backfill skipped a session', {
        sessionId: session.id, err: err.message,
      });
    }
  }

  log.info('server', 'Dev-chat quick-reply backfill done', {
    scanned: rows.length, attached, breadcrumbs, skipped,
  });
}

// Adopt orphan worker containers on startup.
//
// A worker is "orphan" if its container (usernode-worker-<sessionId>)
// still exists on the host after the server comes up. That can happen
// two ways:
//
//   1) The previous server exited (SIGTERM from `node --watch`, crash,
//      host reboot) while a worker was in flight. Because the worker's
//      entrypoint runs the full clone→claude→commit→push pipeline on
//      its own, it may be STILL RUNNING or may have EXITED cleanly
//      while we were gone.
//   2) A past server exited after push but before building staging.
//
// For each case we re-attach to `docker logs -f` (which blocks on
// running containers and dumps everything immediately on exited ones),
// parse the final __USERNODE_RESULT__ line, and run PR + staging the
// same way the live chat handler does. All client updates go over the
// global WebSocket so any open tab sees the tail of its own session.
async function recoverActiveWorkers(config) {
  const pool = getPool(config);
  const staging = require('./src/services/staging');
  const ghub = require('./src/services/github');
  const { broadcastGlobal } = require('./src/services/ws');

  const orphans = await worker.listOrphanWorkers();
  if (!orphans.length) return;

  log.info('server', 'Adopting orphan worker containers', {
    count: orphans.length,
    names: orphans.map((o) => o.name),
  });

  for (const orphan of orphans) {
    // Run each adoption in parallel; they're IO-bound and isolated.
    const deps = { config, pool, staging, ghub, broadcastGlobal };
    adoptOrphanWorker(orphan, deps)
      .catch((err) => {
        if (err?.retainActiveTurn && recoveryRetry.shouldRetryRecoveryError(err)) {
          log.warn('server', 'Orphan adoption paused with durable turn state retained', {
            name: orphan.name, sessionId: orphan.sessionId, err: err.message,
          });
          scheduleRetainedOrphanRecovery({ ...orphan, retryWorkerRecovery: !!err.retryWorkerRecovery }, deps);
          return;
        }
        log.warn('server', 'Orphan adoption failed', {
          name: orphan.name, err: err.message,
        });
      });
  }
}

// docs/plans/draining-releases.md: a turn its process leaves behind (it
// exited at its drain deadline, or died) is adopted by the leader within
// ORPHAN_SWEEP_MS, not only when a leader is elected: since a release lets
// the replaced Pod finish its work while this one leads, election is no
// longer when the previous owner is known to be gone. An orphan is a turn in
// a recoverable phase that no live process holds (services/processes.js),
// whose record has not moved for ORPHAN_MIN_AGE_MS (a dispatch just made has
// its hold written long before then), and whose worker is still there. The
// adoption itself is adoptOrphanWorker's, which reads the holders again.
const ORPHAN_SWEEP_MS = 60 * 1000;
const ORPHAN_MIN_AGE_MS = 2 * 60 * 1000;

// docs/plans/web-and-conductor.md: a worker left running by a process that
// exited, with no turn on it (a turn is sweepOrphanTurns'), that no live
// process keeps warm or runs anything in: adopted here as an election would,
// so this process's idle eviction reclaims it in its time. Read exactly
// (holders), and a session whose holders cannot be read is left for the next
// pass.
const LEFT_WARM_SWEEP_MS = 5 * 60 * 1000;
const HELD_WORKER_KINDS = ['warm', 'session', 'sync'];

async function sweepLeftWarmWorkers(config, { list = () => worker.listOrphanWorkers(), adopt = adoptOrphanWorker } = {}) {
  const pool = getPool(config);
  const mine = new Set(worker.warmRegistrySnapshot().map((m) => Number(m.sessionId)));
  const candidates = [];
  for (const w of await list()) {
    const id = Number(w.sessionId);
    if (!Number.isInteger(id) || id <= 0 || w.state !== 'running' || mine.has(id)) continue;
    if (HELD_WORKER_KINDS.some((kind) => processes.heldHere(kind, id))) continue;
    if (activeWorkersSvc.isSessionBusyHere(id) || worker.getActiveTurnMode(id)) continue;
    let holders;
    try { holders = await processes.holders(HELD_WORKER_KINDS, id, pool); } catch { continue; }
    if (!holders.length) candidates.push(w);
  }
  if (!candidates.length) return 0;
  const { rows } = await pool.query(
    'SELECT id FROM chat_sessions WHERE id = ANY($1::int[]) AND active_turn IS NOT NULL',
    [candidates.map((w) => Number(w.sessionId))]);
  const withTurn = new Set(rows.map((r) => Number(r.id)));
  const deps = { config, pool, staging: require('./src/services/staging'), ghub: require('./src/services/github'),
    broadcastGlobal: require('./src/services/ws').broadcastGlobal };
  let adopted = 0;
  for (const w of candidates) {
    if (withTurn.has(Number(w.sessionId))) continue;
    log.info('server', 'Adopting a warm worker its process left behind', { sessionId: w.sessionId, containerName: w.name });
    adopted += 1;
    await Promise.resolve().then(() => adopt(w, deps)).catch((err) => {
      log.warn('server', 'Adopting a left-behind warm worker failed', { sessionId: w.sessionId, err: err.message });
    });
  }
  return adopted;
}

async function sweepOrphanTurns(config, { adopt = adoptOrphanWorker } = {}) {
  const pool = getPool(config);
  const { rows } = await pool.query(
    `SELECT cs.id FROM chat_sessions cs
      WHERE cs.active_turn IS NOT NULL
        AND cs.active_turn->>'phase' = ANY($1::text[])
        AND COALESCE(cs.active_turn->>'lifecycleUpdatedAt', cs.active_turn->>'startedAt') < $2
        AND NOT EXISTS (
          SELECT 1 FROM process_holds h JOIN platform_processes p ON p.id = h.process_id
           WHERE h.kind = ANY($3::text[]) AND h.ref = cs.id::text
             AND p.heartbeat_at > NOW() - make_interval(secs => $4))
        -- What adoption leaves as it is, and so would come back every pass:
        -- a headless run (resumeHeadlessRuns carries it), a durable build's
        -- session (its build carries it, wherever it runs), and a shots
        -- agent's turn (the shots machine's agent step follows it).
        AND cs.is_headless IS NOT TRUE
        AND NOT EXISTS (SELECT 1 FROM wf_instances w
                         WHERE w.machine = 'shots' AND w.key = 'session:' || cs.id AND w.state = 'taking_shots')
        AND NOT (cs.workflow_owner IS NOT NULL AND EXISTS (
          SELECT 1 FROM wf_instances w
           WHERE w.machine = split_part(cs.workflow_owner, '/', 1)
             AND w.key = substr(cs.workflow_owner, length(split_part(cs.workflow_owner, '/', 1)) + 2)
             AND w.state = 'building'))
      ORDER BY cs.id
      LIMIT 20`,
    [[...turnLifecycle.RECOVERABLE_PHASES], new Date(Date.now() - ORPHAN_MIN_AGE_MS).toISOString(),
      ['session', 'sync'], processes.LIVE_SECONDS],
  );
  let adopted = 0;
  for (const { id } of rows) {
    // What this process holds, whether or not its write has landed yet.
    if (['session', 'sync'].some((kind) => processes.heldHere(kind, id))) continue;
    if (activeWorkersSvc.isSessionBusyHere(id) || worker.getActiveTurnMode(id)) continue;
    const name = worker.workerContainerName(id);
    let state;
    try { state = await worker.getWorkerStatus(name); } catch { continue; }
    if (!state || state === 'not_found') continue;
    const deps = { config, pool, staging: require('./src/services/staging'), ghub: require('./src/services/github'),
      broadcastGlobal: require('./src/services/ws').broadcastGlobal };
    log.info('server', 'Adopting a turn its process left behind', { sessionId: id, containerName: name, state });
    adopted += 1;
    Promise.resolve().then(() => adopt({ name, sessionId: id, state }, deps)).catch((err) => {
      if (err?.retainActiveTurn && recoveryRetry.shouldRetryRecoveryError(err)) {
        scheduleRetainedOrphanRecovery({ name, sessionId: id, state, retryWorkerRecovery: !!err.retryWorkerRecovery }, deps);
        return;
      }
      log.warn('server', 'Adopting a left-behind turn failed', { sessionId: id, err: err.message });
    });
  }
  return { examined: rows.length, adopted };
}

async function persistedActiveTurnExists(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      'SELECT active_turn FROM chat_sessions WHERE id = $1',
      [sessionId]
    );
    return !!rows[0]?.active_turn;
  } catch {
    // An unavailable DB cannot prove the retained state disappeared. Keep
    // ownership and try again rather than letting the watchdog race us.
    return null;
  }
}

function turnCleanupArgs(activeTurn) {
  return turnLifecycle.cleanupArgs(activeTurn);
}

async function reconcilePendingTurnCleanup(config) {
  const pool = getPool(config);
  const { rows } = await pool.query(
    `SELECT id, active_turn
       FROM chat_sessions
      WHERE active_turn->>'phase' = $1`,
    [turnLifecycle.PHASE_CLEANUP_PENDING],
  );
  for (const row of rows) {
    // A live process still finishing the turn cleans it up itself
    // (docs/plans/draining-releases.md); one whose holders cannot be read is
    // left for a later sweep.
    let held = true;
    try { held = (await processes.holders('session', row.id, pool)).length > 0; } catch { held = true; }
    if (held) continue;
    const args = turnCleanupArgs(row.active_turn);
    const cleared = await worker.finishTurn(row.id, args);
    if (!cleared) {
      log.warn('server', 'Pending turn cleanup remains durable for a later sweep', {
        sessionId: row.id,
      });
    }
  }
}

function scheduleRetainedOrphanRecovery(orphan, deps) {
  const sessionId = Number(orphan.sessionId);
  let releaseReservation = null;
  return recoveryRetry.scheduleRetainedRecovery({
    key: `interactive:${sessionId}`,
    hold: () => {
      if (!releaseReservation) {
        releaseReservation = activeWorkersSvc.beginSessionOperation(sessionId);
      }
    },
    release: () => {
      releaseReservation?.();
      releaseReservation = null;
    },
    // Every retry re-reads the durable phase. The timer is only scheduling;
    // it never remembers semantic recovery state in a closure.
    run: async () => {
      const activeTurn = await turnLifecycle.loadActiveTurn(deps.pool, sessionId);
      const action = turnLifecycle.recoveryAction(activeTurn);
      if (action === 'none' && !orphan.retryWorkerRecovery) return;
      if (action === 'cleanup') {
        const args = turnCleanupArgs(activeTurn);
        recoveryRetry.requireDurableTurnCleanup(
          await worker.finishTurn(sessionId, args),
          args,
        );
        return;
      }
      if (action === 'quarantine') return;
      await adoptOrphanWorker(orphan, deps);
    },
    onError: async (err, { failures }) => {
      if (!recoveryRetry.shouldRetryRecoveryError(err)) {
        log.error('server', 'Orphan recovery has invalid durable state; leaving it quarantined', {
          name: orphan.name, sessionId, err: err.message,
        });
        return false;
      }
      const retained = err?.retainActiveTurn
        ? true
        : await persistedActiveTurnExists(deps.pool, sessionId);
      if (retained !== false) {
        log.warn('server', 'Retrying retained orphan recovery', {
          name: orphan.name, sessionId, failures, err: err.message,
          activeTurnObservable: retained !== null,
        });
        return true;
      }
      log.warn('server', 'Retried orphan adoption failed after durable turn cleared', {
        name: orphan.name, sessionId, err: err.message,
      });
      return false;
    },
    // Out of attempts (recovery-retry DEFAULT_MAX_FAILURES). The reservation
    // is released and the durable turn left in place, so the stale-turn
    // watchdog ends it like any unowned turn and tells the user.
    onExhausted: async (err, { failures }) => {
      log.error('server', 'Retained orphan recovery gave up; leaving the turn to the stale-turn watchdog', {
        name: orphan.name, sessionId, failures, err: err.message, code: err.code || null,
      });
    },
    onComplete: () => log.info('server', 'Retained orphan recovery completed', {
      name: orphan.name, sessionId,
    }),
    onHookError: (err) => log.warn('server', 'Orphan recovery retry hook failed', {
      name: orphan.name, sessionId, err: err.message,
    }),
  });
}

// Live handlers use the exact orphan-adoption state machine after retaining
// an active_turn. Supplying it at route construction avoids a circular
// sessions.js -> server.js import while keeping one semantic recovery path
// for live failures and process restarts.
function scheduleInteractiveTurnRecovery(sessionId) {
  const id = Number(sessionId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  const key = `interactive:${id}`;
  const scheduled = scheduleRetainedOrphanRecovery({
    name: worker.workerContainerName(id),
    sessionId: id,
    // Warm workers remain running after their detached turn exits; cleanup
    // phases bypass this value before adoption is attempted.
    state: 'running',
  }, {
    config,
    pool: getPool(config),
    staging: stagingSvc,
    ghub: github,
    broadcastGlobal: ws.broadcastGlobal,
  });
  // A duplicate request means the retained owner is already scheduled, not
  // that recovery is absent.
  return scheduled || recoveryRetry.isScheduled(key);
}

function recoveredAgentIdentity(session, activeTurn = null) {
  const backend = activeTurn?.backend || session?.agent_backend || 'claude_code';
  const isOpenRouter = backend === 'codex_openrouter';
  return {
    backend,
    isOpenRouter,
    name: isOpenRouter ? 'OpenRouter' : 'Claude Code',
    metadata: {
      agentBackend: backend,
      agentModel: activeTurn?.model || session?.agent_model || null,
    },
  };
}

// Codex owns a durable per-attempt ledger row in addition to active_turn.
// Once the latter is cleared there is no remaining pointer from recovery to
// the running attempt, so terminalize it first. A transient ledger failure
// retains the turn for retry; a missing attempt quarantines it through the
// same policy used by the stale-turn watchdog.
async function abandonCodexAttempt(pool, sessionId, turn, { label, errorDetail }) {
  if (turn?.backend !== 'codex_openrouter' || !turn?.turnUuid) return;
  const agentTurn = require('./src/services/agent-turn');
  try {
    await agentTurn.completeCodexAttempt({
      pool,
      turnUuid: turn.turnUuid,
      status: 'failed',
      errorCode: 'recovery_abandoned',
      errorDetail,
      telemetryComponent: turnLifecycle.phaseOf(turn) === turnLifecycle.PHASE_DISPATCH_PENDING
        ? null
        : turn.telemetryComponent || null,
      telemetryMetrics: {
        requestMode: turn.telemetryRequestMode || null,
        requestMessageCount: turn.telemetryRequestTextCharacters == null ? null : 1,
        requestUserMessageCount: turn.telemetryRequestTextCharacters == null ? null : 1,
        requestContentBlockCount: turn.telemetryRequestTextCharacters == null ? null : 1,
        requestTextCharacters: turn.telemetryRequestTextCharacters ?? null,
        requestUserTextCharacters: turn.telemetryRequestTextCharacters ?? null,
        requestPayloadCharacters: turn.telemetryRequestTextCharacters ?? null,
        modelContextWindowTokens: turn.telemetryModelContextWindowTokens ?? null,
        modelMaxOutputTokens: turn.telemetryModelMaxOutputTokens ?? null,
      },
    });
  } catch (ledgerErr) {
    const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
      pool,
      sessionId,
      activeTurn: turn,
      error: ledgerErr,
    });
    log.error('server', disposition.action === 'retry'
      ? `${label} Codex turn retained because ledger terminalization failed`
      : `${label} Codex turn quarantined because its ledger attempt is missing`, {
      sessionId, err: ledgerErr.message,
    });
    throw ledgerErr;
  }
}

// A shots turn cannot outlive the process that dispatched it: its
// MCP bridge calls back to that process's pod address, and the run it
// answers to exists only in that process's control registry. Resumed, the
// agent retries tool calls that can no longer succeed, holding the session
// busy and spending the user's model credit with no bound. End it instead,
// without chat narration — shots turns never write chat rows. A turn the
// shots machine's run follows is left to it (adoptOrphanWorker): only a
// turn with no run taking shots is ended here.
async function abandonOrphanShotsTurn({
  pool, sessionId, containerName, activeTurn, containerRunning, retryRuntimeRecovery,
}) {
  // A follower promoted to leader recovers its own workers too, and one of
  // them may be executing a shots run this process dispatched and still
  // bounds.
  if (worker.getActiveTurnMode(sessionId) === 'shots') {
    log.info('server', 'Shots turn is live in this process; leaving it to its run', {
      containerName, sessionId,
    });
    return;
  }
  const args = turnCleanupArgs(activeTurn);
  if (containerRunning) {
    worker.adoptWarmWorker(sessionId, containerName);
    await worker.stopTurn(sessionId);
    // The stop targeted the orphan. Left pending, it would make the next
    // dispatch — the user's preview retry — skip as stopped during spin-up.
    worker.clearPendingStop(sessionId);
    if (await worker.isWorkerExecuting(containerName) !== false) {
      throw retryRuntimeRecovery('Orphaned shots turn is not confirmed stopped');
    }
  }
  await abandonCodexAttempt(pool, sessionId, activeTurn, {
    label: 'Orphaned shots',
    errorDetail: 'Visual-shots turn was abandoned after the platform process that dispatched it exited.',
  });
  recoveryRetry.requireDurableTurnCleanup(
    containerRunning
      ? await worker.finishTurn(sessionId, args)
      : await worker.clearActiveTurn(sessionId, args),
    args,
  );
  log.warn('server', 'Abandoned orphaned shots turn after restart', {
    containerName, sessionId,
    turnId: turnLifecycle.turnIdentity(activeTurn),
    backend: activeTurn.backend || null,
  });
  if (!containerRunning) await worker.destroyWorker(containerName);
}

// #3654: a benchmark trial's worker that outlived a restart and that no
// durable trial owns (trials are durable builds: services/build-runs.js; this
// is one that started before they were). The same abandonment as a shots
// turn's (above), then the session is archived and the trial put straight
// back in the lane's queue, what the attempt spent charged to its run: the
// lane runs it again from the start.
async function abandonOrphanBenchTurn({
  pool, session, sessionId, containerName, containerRunning, retryRuntimeRecovery,
}) {
  const activeTurn = session.active_turn || null;
  if (activeTurn) {
    const args = turnCleanupArgs(activeTurn);
    if (containerRunning) {
      worker.adoptWarmWorker(sessionId, containerName);
      await worker.stopTurn(sessionId);
      worker.clearPendingStop(sessionId);
      if (await worker.isWorkerExecuting(containerName) !== false) {
        throw retryRuntimeRecovery('Orphaned benchmark turn is not confirmed stopped');
      }
    }
    await abandonCodexAttempt(pool, sessionId, activeTurn, {
      label: 'Orphaned benchmark',
      errorDetail: 'A benchmark trial was abandoned after the platform process that dispatched it exited.',
    });
    recoveryRetry.requireDurableTurnCleanup(
      containerRunning
        ? await worker.finishTurn(sessionId, args)
        : await worker.clearActiveTurn(sessionId, args),
      args,
    );
  }
  await pool.query(
    "UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1 AND status IN ('active', 'paused')",
    [sessionId],
  ).catch(() => {});
  await worker.destroyWorker(containerName).catch(() => {});
  log.warn('server', 'Abandoned a benchmark trial\'s worker after restart', { containerName, sessionId });
  // After the attempt is terminalized, so the ledger it is charged from is
  // final. Never throws.
  await require('./src/services/bench/lane').releaseTrialOfSession(pool, sessionId, {
    why: 'its turn was abandoned after a restart',
  });
}

function homeroomBotRecovery() {
  return require('./src/services/homeroom-bot');
}

/**
 * #3401: a worker of the Homeroom bot's that outlived a restart and that no
 * durable build owns (a build's session is its build's: adoptOrphanWorker
 * leaves it alone before this). What is left is a read (its triage), which
 * the bot's queue reads again: its turn is stopped and its record cleared,
 * its ledger attempt closed, and its session put back to rest. The bot's
 * builds no longer come here: they carry themselves on (services/build-runs.js).
 */
async function adoptBotOrphan({ pool, session, sessionId, containerName, containerState }) {
  const bot = homeroomBotRecovery();
  const activeTurn = session.active_turn || null;
  if (activeTurn) {
    const args = turnCleanupArgs(activeTurn);
    if (containerState === 'running') {
      worker.adoptWarmWorker(sessionId, containerName);
      await worker.stopTurn(sessionId).catch(() => {});
      worker.clearPendingStop(sessionId);
    }
    await abandonCodexAttempt(pool, sessionId, activeTurn, {
      label: 'Orphaned Homeroom bot read',
      errorDetail: 'A Homeroom bot read was stopped after the platform process that dispatched it exited; its request is read again.',
    });
    recoveryRetry.requireDurableTurnCleanup(
      containerState === 'running'
        ? await worker.finishTurn(sessionId, args)
        : await worker.clearActiveTurn(sessionId, args),
      args,
    );
  }
  if (containerState !== 'running') await worker.destroyWorker(containerName).catch(() => {});
  await bot.abandonRecoveredTurn({
    pool, session, why: activeTurn ? 'the platform restarted during its turn' : 'no turn was in flight',
  });
}

async function adoptOrphanWorker(orphan, { config, pool, staging, ghub, broadcastGlobal }) {
  const { name: containerName, sessionId } = orphan;
  let containerState = orphan.state;
  const kubernetesWorker = worker.usesKubernetesWorkers();
  const retryRuntimeRecovery = (message) => Object.assign(new Error(message), {
    retainActiveTurn: true, retryWorkerRecovery: true,
  });

  const { rows } = await pool.query(
    // #896: app_self_hosted rides along so the recovered turn's Mayor
    // wrap-up gets the same system prompt a live turn would (the
    // self-hosted block changes what the Mayor is allowed to say).
    // And whether a durable build that owns the session is still under way
    // (bot-build, docs/plans/bot-build-workflow.md).
    `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url,
            a.self_hosted AS app_self_hosted, u.username,
            u.is_synthetic AS user_is_synthetic,
            (cs.workflow_owner IS NOT NULL AND EXISTS (
              SELECT 1 FROM wf_instances w
               WHERE w.machine = split_part(cs.workflow_owner, '/', 1)
                 AND w.key = substr(cs.workflow_owner, length(split_part(cs.workflow_owner, '/', 1)) + 2)
                 AND w.state = 'building'
            )) AS workflow_owned
     FROM chat_sessions cs
     JOIN apps a ON cs.app_id = a.id
     JOIN users u ON cs.user_id = u.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  if (!rows.length) {
    // Session gone (archived/deleted). Just reap the container.
    log.info('server', 'Orphan has no session row — removing', { containerName });
    await worker.destroyWorker(containerName);
    return;
  }
  const session = rows[0];

  // A turn this process is following itself is no orphan. A follower serves
  // requests and starts turns during a rollout's overlap, before it is
  // promoted; adopting its own live turn here put a second consumer on its
  // journal and finished it twice (cards, vote resets, wrap-ups), and the
  // adoption's `finally` took the live owner's busy flag with it.
  if (worker.getActiveTurnMode(sessionId) || activeWorkersSvc.isSessionBusyHere(sessionId)) {
    log.info('server', 'A turn on this worker is live in this process; not adopting it', { containerName, sessionId });
    return;
  }
  // Nor one another live process is following: the Pod a release replaced
  // finishes its turns while this one leads (docs/plans/draining-releases.md),
  // holding their sessions until they end (services/processes.js). Read
  // exactly: a session whose holders cannot be read is retried, not taken.
  let holders;
  try {
    holders = await processes.holders(['session', 'sync'], sessionId, pool);
  } catch (err) {
    throw retryRuntimeRecovery(`could not read who holds the session: ${err.message}`);
  }
  if (holders.length) {
    log.info('server', 'A turn on this worker is live in another process; not adopting it', {
      containerName, sessionId, holders,
    });
    return;
  }

  // A durable build's session: its worker and its turns are that build's,
  // whose work item the next leader claims and carries on from its last
  // saved step (services/build-runs.js). The worker is kept and registered;
  // nothing else is done to it here.
  if (session.workflow_owned) {
    if (containerState === 'running') worker.adoptWarmWorker(sessionId, containerName);
    log.info('server', 'Leaving a durable build\'s worker to its build', {
      containerName, sessionId, owner: session.workflow_owner, state: containerState,
    });
    return;
  }

  const recoveryAction = turnLifecycle.recoveryAction(session.active_turn);
  if (recoveryAction === 'quarantine') {
    log.error('server', 'Orphan turn is quarantined; preserving durable state and stopping worker', {
      sessionId,
      turnId: turnLifecycle.turnIdentity(session.active_turn),
      quarantineCode: session.active_turn?.quarantineCode || null,
    });
    // destroyWorker removes only the container/registry entry; the session
    // volume (and therefore the quarantined journal) remains for operators.
    await worker.destroyWorker(containerName);
    return;
  }
  if (recoveryAction === 'cleanup') {
    const args = turnCleanupArgs(session.active_turn);
    recoveryRetry.requireDurableTurnCleanup(
      await worker.finishTurn(sessionId, args),
      args,
    );
    session.active_turn = null;
  }

  // #1006: except a Homeroom bot session paused under a turn in flight,
  // whose turn is stopped and its record cleared (adoptBotOrphan below),
  // and a benchmark trial's (abandonOrphanBenchTurn): destroying it here, in
  // silence and with its turn record left, lost six platform builds on 10-02.
  if (!['active', 'promoted'].includes(session.status)
      && !homeroomBotRecovery().isRecoveredBotSession(session)
      && !require('./src/services/bench/runner').isRecoveredBenchSession(session)) {
    // Session became non-runnable while we were down — drop the container.
    await worker.destroyWorker(containerName);
    return;
  }

  // #3654: a Homeroom bot benchmark trial is never recovered into the
  // dev-chat tail below, which would open a PR, build staging and notify,
  // none of which a trial may do. A trial is a durable build, left to its
  // build above; one that is not (it started before trials were durable)
  // has its turn stopped and abandoned, and the trial put back in the
  // lane's queue (services/bench/lane.js).
  if (require('./src/services/bench/runner').isBenchSession(session)) {
    await abandonOrphanBenchTurn({
      pool, session, sessionId, containerName,
      containerRunning: containerState === 'running',
      retryRuntimeRecovery,
    });
    return;
  }

  // #183: headless auto sessions own their multi-step loop for ALL
  // container states — the turn resume AND the Mayor wrap-up continuation
  // both happen in resumeHeadlessRuns (runs right after worker adoption).
  // Running containers are registered warm so that loop can drive them;
  // exited ones are left strictly alone: scraping them here would replay
  // the interactive post-turn tail (PR + staging on the auto branch — the
  // original #183 bug) and clearing active_turn would destroy the journal
  // pointer the cc_running resume step needs. Leftover exited containers
  // are reaped by the normal worker sweeps once the run goes terminal.
  if (session.is_headless) {
    if (containerState === 'running') {
      log.info('server', 'Adopting headless worker (resume owned by resumeHeadlessRuns)', {
        containerName, sessionId,
      });
      worker.adoptWarmWorker(sessionId, containerName);
    } else {
      log.info('server', 'Leaving exited headless worker to resumeHeadlessRuns', {
        containerName, sessionId,
      });
    }
    return;
  }

  if (kubernetesWorker) {
    // Re-read on every retry: the startup inventory may describe a Pod that
    // was still starting. An API failure or non-ready Deployment is not death.
    try { containerState = await worker.getWorkerStatus(containerName); }
    catch (_) { throw retryRuntimeRecovery('Kubernetes worker state is unavailable'); }
    if (!['running', 'not_found'].includes(containerState)) {
      throw retryRuntimeRecovery('Kubernetes worker is not ready for recovery');
    }
  }

  // #3401: the Homeroom bot's own turns are the bot's to finish. A shadow
  // build must leave no PR, staging, wrap-up or notification, which is what
  // the dev-chat tail below would give it.
  if (homeroomBotRecovery().isRecoveredBotSession(session)) {
    await adoptBotOrphan({
      config, pool, staging, broadcastGlobal, session, sessionId, containerName, containerState,
    });
    return;
  }

  if (session.active_turn?.mode === 'shots') {
    // The shots machine's agent step follows its turn through a restart
    // (services/durable-turn.js): left to it while its run is taking shots.
    const shots = await require('./src/workflow/platform.ts').shotsInstance(sessionId).catch(() => null);
    if (shots?.state === 'taking_shots') {
      log.info('server', 'A shots turn its run follows; not adopting it', { containerName, sessionId });
      return;
    }
    await abandonOrphanShotsTurn({
      pool, sessionId, containerName,
      activeTurn: session.active_turn,
      containerRunning: containerState === 'running',
      retryRuntimeRecovery,
    });
    return;
  }

  // Long-lived worker reality check: a *running* container could be
  //   (a) a warm-idle wrapper sitting in `sleep infinity` — clean adopt,
  //       no log scrape needed.
  //   (b) a legacy single-shot still in flight — only possible during
  //       rollout from the old worker contract; tail logs as before.
  //   (c) a warm wrapper with a detached turn in flight (or finished
  //       while we were down). The turn's output lives in a journal
  //       file in the CC volume, recorded on chat_sessions.active_turn
  //       — resume it from line 0 and finish the post-turn work as if
  //       we'd never restarted.
  //   (d) a mid-exec wrapper from BEFORE the detached-turn contract
  //       (no active_turn record). Its output went to a dead pipe and
  //       is unrecoverable; kill it so it can't race the next dispatch.
  if (containerState === 'running') {
    // Case (c): detached turn with a durable record — resume it. This now
    // covers TWO shapes, distinguished only by `phase`:
    //   - phase absent  → the exec itself may still be running; the replay
    //                     follows the journal live before the tail runs.
    //   - phase 'tail'  → the agent finished cleanly and the PLATFORM side
    //                     was cut off (session 2954). The journal is
    //                     complete, so the replay returns immediately and
    //                     finalizeRecoveredTurn picks the tail up where it
    //                     stopped, skipping whatever already landed.
    // Both go down the same path deliberately: the tail is the same tail.
    const activeTurn = session.active_turn || null;
    if (activeTurn && activeTurn.journal) {
      worker.adoptWarmWorker(sessionId, containerName);
      await resumeDetachedTurn({
        config, pool, staging, broadcastGlobal, session, sessionId,
        containerName, activeTurn,
      });
      return;
    }

    const busy = await worker.isWorkerExecuting(containerName);
    if (kubernetesWorker && busy === null) {
      throw retryRuntimeRecovery('Kubernetes worker liveness is unavailable');
    }
    if (busy === false) {
      // Nothing is executing and there's no record to resume — normally
      // an idle warm container, correctly adopted in silence.
      //
      // But this branch is ALSO where a lost tail landed before the record
      // was held across it: the container was idle (the agent really had
      // finished), so adoption returned here and the chat kept
      // "Building staging preview..." as its last word forever, with no
      // spinner, no card and no error. Change 1 makes that unreachable —
      // this stays as the guard for a record lost some other way (a
      // clearActiveTurn bug, a journal deleted under us, a pre-upgrade row
      // written by an older build).
      const dangling = await findDanglingTail(pool, sessionId);
      if (dangling) {
        log.warn('server', 'Adopting warm-idle worker with a DANGLING tail — narrating', {
          containerName, sessionId, lastRow: dangling.content,
        });
        await narrateDanglingTail({ config, pool, session, sessionId, broadcastGlobal });
        worker.adoptWarmWorker(sessionId, containerName);
        return;
      }
      // Kept warm by a live process (a web process's, which never leads,
      // docs/plans/web-and-conductor.md): its own, and its idle eviction's.
      let warmThere = [];
      try { warmThere = await processes.holders('warm', sessionId, pool); } catch { warmThere = []; }
      if (warmThere.some((id) => id !== processes.ID)) {
        log.info('server', 'A live process keeps this idle worker warm; not adopting it', { containerName, sessionId });
        return;
      }
      log.info('server', 'Adopting warm-idle worker (no in-flight exec)', {
        containerName, sessionId,
      });
      worker.adoptWarmWorker(sessionId, containerName);
      return;
    }
    if (busy === true && (session.cc_session_id || kubernetesWorker)) {
      // Case (d) conservative recovery: the prior in-flight turn
      // predates the detached contract and is unrecoverable from the
      // host. Kill the orphan exec to free the warm container for
      // fresh dispatches, then post a system message so the user
      // knows to retry.
      log.info('server', 'Adopting mid-exec worker — killing orphan exec', {
        containerName, sessionId,
      });
      // worker.stopTurn walks /proc inside the container — the worker
      // image has no pkill (see TURN_PROC_KILL_SCRIPT in worker.js).
      await worker.stopTurn(sessionId).catch(() => {});
      // #786: the breadcrumb carries the turn's quick-reply pills. The
      // Mayor wrap-up that normally supplies them can't run here, and
      // without pills the bar above the composer stays empty until the
      // user types — so there'd be no one-tap way to retry.
      const killedPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [
          sessionId,
          recoveryPills.TURN_UNFINISHED_BREADCRUMB,
          JSON.stringify({
            ...(killedPills ? { quickReplies: killedPills } : {}),
            // #896: the restart moves off the user's screen and into the
            // row's metadata — same text for every unresumable shape,
            // `recoveredReason` keeps them apart for an operator.
            recovered: true,
            recoveredReason: 'mid_exec_killed',
          }),
        ]
      ).catch(() => {});
      broadcastGlobal({
        type: 'session_event', sessionId, event: 'status',
        text: recoveryPills.TURN_UNFINISHED_BREADCRUMB,
        quickReplies: killedPills || undefined,
      });
      await notifyTurnStalled(pool, sessionId);
      worker.adoptWarmWorker(sessionId, containerName);
      return;
    }
    // busy === null (couldn't probe) or true with no cc_session_id
    // (legacy single-shot rollout): fall through to the legacy
    // watchWorker scrape. Safe on already-exited containers; for a
    // hung warm wrapper it'd block, but the idle sweeper plus session
    // archive cap the worst case.
  } else if (session.active_turn) {
    // A detached turn was recorded but its container is gone (evicted /
    // host reboot). The journal lives in the unreachable volume, so the
    // turn itself can't be replayed — but if it pushed before dying,
    // recoverSessions' staging heal picks the branch up. Clear the
    // record and let the user know.
    const goneTurn = session.active_turn;
    const goneTail = (goneTurn && typeof goneTurn.tail === 'object' && goneTurn.tail) || {};
    // Did the work actually land? A held TAIL record knows: the exec is
    // over and its seed milestones carry the commit + push outcome. When
    // it did, "send your request again" is simply wrong — the commit is on
    // GitHub, and resending buys a duplicate run (see
    // buildCodeLandedBreadcrumb). Say what landed and repair the preview.
    const codeLanded = !!goneTail.sha && goneTail.pushOk === true;
    await abandonCodexAttempt(pool, sessionId, goneTurn, {
      label: 'Gone',
      errorDetail: 'Durable turn was abandoned after its worker container disappeared.',
    });
    recoveryRetry.requireDurableTurnCleanup(
      await worker.clearActiveTurn(sessionId, turnCleanupArgs(goneTurn)),
      turnCleanupArgs(goneTurn),
    );
    // Terminal marker so the dead turn's progress card doesn't stay
    // frozen on its last in-progress line ("Pushing", "Editing …").
    await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
    if (codeLanded) {
      const prNumber = goneTail.prNumber || session.pr_number || null;
      // 'code_done' rather than 'unrecoverable': the useful next steps are
      // Propose / tweak, not "try that again".
      const landedPills = recoveryPills.buildRecoveryQuickReplies('code_done');
      const landedText = recoveryPills.buildCodeLandedBreadcrumb({
        prNumber, rebuildingPreview: true,
      });
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [
          sessionId,
          landedText,
          JSON.stringify({
            ...(landedPills ? { quickReplies: landedPills } : {}),
            recovered: true,
            recoveredReason: 'tail_worker_gone',
            sha: goneTail.sha,
            ...(prNumber ? { prNumber } : {}),
          }),
        ]
      ).catch(() => {});
      broadcastGlobal({
        type: 'session_event', sessionId, event: 'status',
        text: landedText,
        quickReplies: landedPills || undefined,
      });
      log.warn('server', 'Tail record with a dead worker — code landed, healing preview', {
        sessionId, sha: String(goneTail.sha).substring(0, 8), prNumber,
      });
      // The preview is the only missing artefact, and rebuildSessionStaging
      // is the shared path that also re-runs the proposal checks. Awaited
      // (not fire-and-forget) so boot recovery's per-session try/catch owns
      // the failure, same as recoverSessions' own heal call.
      try {
        await stagingRecovery.rebuildSessionStaging({
          config, pool, session, reason: 'tail_worker_gone',
        });
      } catch (err) {
        log.warn('server', 'Tail-recovery staging rebuild failed', {
          sessionId, err: err.message,
        });
      }
      return;
    }
    // #786: pills on the breadcrumb — see the mid-exec branch above.
    const goneP = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [
        sessionId,
        recoveryPills.TURN_UNFINISHED_BREADCRUMB,
        JSON.stringify({
          ...(goneP ? { quickReplies: goneP } : {}),
          recovered: true,
          recoveredReason: 'worker_gone',
        }),
      ]
    ).catch(() => {});
    await notifyTurnStalled(pool, sessionId);
  }

  // All running Kubernetes workers return above. A positively missing one
  // has had its durable recovery handled; there are no container logs to
  // scrape or a legacy result to synthesize.
  if (kubernetesWorker) {
    await worker.destroyWorker(containerName);
    return;
  }

  const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

  const emit = (event, data) => {
    broadcastGlobal({ type: 'session_event', sessionId, event, ...data });
  };

  // #896: the same in-flight label a live turn shows. The recovery is
  // plumbing; from the user's side a coding agent is simply running.
  const recoveryAgent = recoveredAgentIdentity(session, session.active_turn);
  emit('status', {
    text: `${recoveryAgent.name} is running...`,
    ...recoveryAgent.metadata,
  });

  const result = await worker.watchWorker(containerName, {
    onProgress: (text) => {
      emit('cc_progress', { text, ...recoveryAgent.metadata });
      pool.query(
        `UPDATE chat_session_messages
         SET metadata = jsonb_set(
           metadata, '{progressLog}',
           (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
         )
         WHERE id = (
           SELECT id FROM chat_session_messages
           WHERE session_id = $2 AND role = 'system'
             AND metadata->>'progressLog' IS NOT NULL
           ORDER BY id DESC LIMIT 1
         )`,
        [JSON.stringify([text]), sessionId]
      ).catch(() => {});
    },
  });

  const finalized = await finalizeRecoveredTurn({
    config, pool, staging, session, sessionId, result, repoOwner, repoName,
    emit, containerName,
    activeTurn: session.active_turn || null,
    // Legacy single-shot containers are per-turn; reap when done.
    keepWorker: false,
  });
  if (recoveryAgent.isOpenRouter && finalized?.summary) {
    const { runRecoveredWrapUp } = require('./src/routes/sessions');
    await runRecoveredWrapUp({
      pool, config, session, sessionId,
      outcome: result.ahead > 0 && result.sha ? 'code' : 'no_changes',
      dispatchSummary: finalized.summary,
      fallbackPillKind: result.ahead > 0 && result.sha ? 'code_done' : 'chat_generic',
      turnModel: recoveryAgent.metadata.agentModel,
      turnId: session.active_turn?.turnId || null,
      emit,
    });
  }
}

// Shared post-turn finalization for both recovery transports (legacy
// `docker logs` scrape and detached-journal resume): persist the CC
// session id, then — when the turn pushed a commit — run the same PR +
// staging tail the live dev-turn path runs. `keepWorker` distinguishes
// the long-lived warm contract (container stays adoptable) from the
// legacy single-shot contract (container is reaped when done).
// Append one line to the session's latest persisted progressLog row —
// the same row flushProgress/onProgress write to. Used to stamp a
// terminal marker ([interrupted] etc.) on turns whose journal can't
// provide one, so the dev-chat progress card never ends frozen on an
// in-progress label. Best-effort: a session with no progress row is a
// clean no-op (the WHERE id subquery matches nothing).
// The status texts a dev turn's TAIL emits before it is finished. If one
// of these is a session's newest system row and no completion artefact
// followed it, the tail was cut off: the transcript's last word is
// "…preview" or "PR #N created" and nothing will ever come after it.
//
// Matched loosely (prefix / regex) because the wording is shared with the
// live path, which owns it — see sendStatus in routes/sessions.js.
const TAIL_IN_PROGRESS_PATTERNS = [
  /^Building staging preview/i,
  /^PR #\d+ created$/i,
];

// Is session `sessionId`'s transcript sitting on an unfinished tail?
//
// "Finished" means the newest system row carries one of the artefacts a
// completed tail produces — the agent's summary card (ccOutput), the
// Changes-ready card (stagingUrl / changesReady), an explicit failure
// (stagingFailed / checkError / turnError) — or an assistant reply came
// after it (the Mayor's wrap-up, which is always last). Anything else
// with a tail-in-progress row on top is dangling.
//
// Returns the offending row or null. Deliberately cheap: one indexed
// lookup of the last few rows.
async function findDanglingTail(pool, sessionId) {
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT role, content, metadata FROM chat_session_messages
        WHERE session_id = $1 AND role IN ('system', 'assistant')
        ORDER BY id DESC LIMIT 1`,
      [sessionId]
    ));
  } catch (err) {
    log.warn('server', 'Dangling-tail probe failed', { sessionId, err: err.message });
    return null;
  }
  const row = rows[0];
  if (!row || row.role !== 'system') return null;
  const meta = row.metadata || {};
  if (meta.ccOutput || meta.stagingUrl || meta.changesReady
      || meta.stagingFailed || meta.checkError || meta.turnError) {
    return null;
  }
  const content = String(row.content || '');
  return TAIL_IN_PROGRESS_PATTERNS.some((re) => re.test(content)) ? row : null;
}

// Close out a dangling tail we cannot resume (no record, no journal): the
// honest breadcrumb, a terminal progress marker so the card stops reading
// as in-flight, and a preview heal when the branch carries work.
//
// This is the fallback wording, so it can't inspect a milestone map —
// what it knows comes from the session row. A session with a pr_number
// pushed successfully (the PR could not exist otherwise), so it earns the
// "code landed" wording; anything else gets the resend breadcrumb.
async function narrateDanglingTail({ config, pool, session, sessionId, broadcastGlobal }) {
  await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
  const landed = !!session.pr_number;
  const kind = landed ? 'code_done' : 'unrecoverable';
  const pills = recoveryPills.buildRecoveryQuickReplies(kind);
  const text = landed
    ? recoveryPills.buildCodeLandedBreadcrumb({
      prNumber: session.pr_number, rebuildingPreview: true,
    })
    : recoveryPills.TURN_UNFINISHED_BREADCRUMB;
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata)
     VALUES ($1, 'system', $2, $3)`,
    [sessionId, text, JSON.stringify({
      ...(pills ? { quickReplies: pills } : {}),
      recovered: true,
      recoveredReason: 'dangling_tail',
    })]
  ).catch(() => {});
  broadcastGlobal({
    type: 'session_event', sessionId, event: 'status',
    text, quickReplies: pills || undefined,
  });
  // #3181: the resend breadcrumb is a turn that stopped before finishing.
  if (!landed) await notifyTurnStalled(pool, sessionId);
  if (!landed) return;
  // recoverSessions' own sweep would eventually heal the preview, but it
  // runs before adoption on a cold boot — so heal it here too rather than
  // leaving the row promising a rebuild that nothing started.
  try {
    if (await stagingRecovery.stagingNeedsRebuild(session, { config })) {
      await stagingRecovery.rebuildSessionStaging({
        config, pool, session, reason: 'dangling_tail',
      });
    }
  } catch (err) {
    log.warn('server', 'Dangling-tail staging rebuild failed', { sessionId, err: err.message });
  }
}

async function appendTerminalProgressLine(pool, sessionId, line) {
  await pool.query(
    `UPDATE chat_session_messages
     SET metadata = jsonb_set(metadata, '{progressLog}',
       (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb))
     WHERE id = (
       SELECT id FROM chat_session_messages
       WHERE session_id = $2 AND role = 'system'
         AND metadata->>'progressLog' IS NOT NULL
       ORDER BY id DESC LIMIT 1
     )`,
    [JSON.stringify([line]), sessionId]
  ).catch(() => {});
}

// #3181: a turn the platform could not finish tells its owner, in the bell
// and as a push, that the session stopped before finishing, instead of
// leaving the breadcrumb for them to find whenever they next look. Called
// beside every "didn't finish, send it again" breadcrumb (a worker lost to
// a restart or an eviction, a failed replay, an orphan the watchdog reaps).
// Never throws: notifySessionStalled swallows its own errors.
async function notifyTurnStalled(pool, sessionId) {
  await require('./src/routes/sessions').notifySessionStalled(pool, sessionId);
}

// Returns { outcome, summary } for the recovered turn:
//
//   outcome — the terminal state for the progress card: 'done' (turn
//     wrapped up, including the no-changes case), 'push_failed' (commit
//     exists only in the worker — re-push heal failed), or 'skip'
//     (headless — owned by resumeHeadlessRuns).
//   summary — the dispatch narrative for the Mayor wrap-up, assembled the
//     same way runClaudeCodeTool builds its `summaryParts` tool result.
//     Null on 'skip'. #896: without this the wrap-up would have to
//     re-derive what happened from the transcript.
//
// Every persisted row carries metadata.recovered so an operator can find
// recovery-written rows in SQL — the audit trail that replaces the
// restart wording the build cards used to carry (#896).
//
// `alreadyDone` is the interrupted turn's tail-milestone map
// (active_turn.tail — written by the live tail as each step landed; see
// the "Post-agent TAIL" note in services/worker.js). It exists because
// this function is now also reached for a turn whose EXEC finished
// cleanly and whose TAIL was cut in half by a restart, so some of the
// work below has already happened once. Every step it gates is one that
// is NOT naturally idempotent: a duplicate completion card, a duplicate
// PR-opened event, a redundant ~5-minute staging rebuild. Absent/empty
// (a genuine mid-exec recovery) means "nothing landed yet" and the whole
// tail runs, exactly as before.
async function finalizeRecoveredTurn({
  config, pool, staging, session, sessionId, result, repoOwner, repoName,
  emit, containerName, keepWorker, startedAtMs, alreadyDone = null,
  activeTurn = null,
  // The machine a local agent's turn ran on (services/local-agent-recovery.js):
  // its completion card names it, as the live card does.
  localAgentLabel = null,
}) {
  const done = alreadyDone && typeof alreadyDone === 'object' ? alreadyDone : {};
  const recoveryAgent = recoveredAgentIdentity(session, activeTurn);
  if (localAgentLabel) {
    recoveryAgent.metadata = {
      agentBackend: 'claude_code', agentModel: null,
      runner: 'local', localAgentLabel, localMode: 'build',
    };
  }
  const noteMilestone = async (milestone) => {
    if (!activeTurn) return false;
    const noted = await worker.noteTailMilestone(
      sessionId,
      milestone,
      turnLifecycle.cleanupArgs(activeTurn),
    );
    if (noted) Object.assign(done, milestone);
    return noted;
  };
  // #183 belt-and-braces: headless rows must never get the interactive
  // post-turn tail (PR on the auto branch + staging + system message) from
  // any recovery transport — resumeHeadlessRuns owns them. adoptOrphanWorker
  // already routes headless sessions away before reaching here; this guard
  // protects against future transports forgetting to.
  if (session.is_headless) {
    log.info('server', 'Skipping recovered-turn finalize for headless session (owned by resumeHeadlessRuns)', {
      sessionId,
    });
    return { outcome: 'skip', summary: null };
  }

  const summaryParts = [];
  // Turn duration for the completion card's "(took 4m 12s)" suffix. The
  // pre-restart process recorded when the turn started on active_turn;
  // a legacy record without it just omits the suffix.
  const durationMs = startedAtMs ? Date.now() - startedAtMs : null;

  // #896: the live path persists an outcome-aware completion row carrying
  // the agent's own summary (sessions.js runClaudeCodeTool). Recovery
  // persisted none, so the coding-agent completion card was missing
  // AND every later Mayor turn was blind to what this turn built
  // (buildMayorMessages folds ccOutput rows into the model's context).
  const persistCompletionRow = async (ccText, ccOutcome) => {
    if (!ccText) return;
    const directOpenRouterReply = recoveryAgent.isOpenRouter && ccOutcome === 'no_changes';
    // The interrupted tail already wrote this card — a second one would
    // duplicate the agent's summary in the transcript AND double-count it
    // in every later Mayor turn's context (buildMayorMessages folds
    // ccOutput rows in). The summary still goes to the wrap-up below.
    if (done.completionRowPosted) {
      log.info('server', 'Recovered turn: completion card already posted — skipping', { sessionId });
      if (directOpenRouterReply) summaryParts.unshift(ccText);
      else summaryParts.unshift(`What the agent did:\n${ccText}`);
      return;
    }
    const statusText = (ccOutcome === 'success'
      ? `${recoveryAgent.name} finished`
      : ccOutcome === 'no_changes'
        ? (recoveryAgent.isOpenRouter
          ? `${recoveryAgent.name} replied`
          : `${recoveryAgent.name} made no changes`)
        : `${recoveryAgent.name} did not complete`)
      + (localAgentLabel ? ` Coding done on ${localAgentLabel}, so no Homeroom credits were used.` : '');
    const metadata = {
      ccOutput: ccText,
      ccOutcome,
      ...recoveryAgent.metadata,
      ...(durationMs != null ? { durationMs } : {}),
      recovered: true,
    };
    let emitted = true;
    if (!directOpenRouterReply) {
      if (activeTurn?.turnId) {
        const receipt = await turnEffects.runDbEffect({
          pool,
          turnId: activeTurn.turnId,
          effectKey: 'completion_row',
          sessionId,
          run: async (client) => {
            await client.query(
              `INSERT INTO chat_session_messages (session_id, role, content, metadata)
               VALUES ($1, 'system', $2, $3)`,
              [sessionId, statusText, JSON.stringify(metadata)],
            );
            return { persisted: true };
          },
        });
        emitted = receipt.applied;
      } else {
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [sessionId, statusText, JSON.stringify(metadata)],
        );
      }
      if (emitted) emit('status', { text: statusText, ...metadata });
    }
    await noteMilestone({ completionRowPosted: true });
    if (directOpenRouterReply) summaryParts.unshift(ccText);
    else summaryParts.unshift(`What the agent did:\n${ccText}`);
  };

  // #127 parity: peel the TESTING block off the agent's summary once, up
  // front — the cleaned text is both what the completion card shows and
  // what feeds the PR body prompt below.
  const testingNotes = require('./src/services/testing-notes');
  const recoveredTesting = testingNotes.extract(result.lastResultText || '');
  const recoveredCcSummary = (recoveredTesting.cleanedText || '').trim();

  // Capture the CC session id so the next turn can --resume, even though
  // the server process that originally spawned this worker is gone.
  const newCcId = result.sessionId || result.initSessionId || null;
  if (newCcId && newCcId !== session.cc_session_id) {
    await pool.query(
      `UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2`,
      [newCcId, sessionId]
    ).catch(() => {});
  }

  const hasChanges = result.ahead > 0 && !!result.sha;
  if (!hasChanges) {
    // #896: persist the same outcome-aware row the live path writes, so
    // the no-changes case survives a reload instead of vanishing with the
    // emit — and so the wrap-up below has something honest to describe.
    const noChangeOutcome = (result.fatalError || result.ccIsError) ? 'error' : 'no_changes';
    await persistCompletionRow(recoveredCcSummary, noChangeOutcome);
    if (result.fatalError) {
      summaryParts.push(`The coding agent hit an error: ${String(result.fatalError).substring(0, 200)}`);
    } else if (result.branchMismatch) {
      summaryParts.push('The coding agent ended up working on a different branch that does not build on this '
        + 'change, so nothing from the turn was saved. Tell the user to send the request again.');
    } else if (!recoveryAgent.isOpenRouter) {
      summaryParts.push('The coding agent finished without committing any changes.');
    }
    if (!keepWorker) await worker.destroyWorker(containerName);
    return { outcome: 'done', summary: summaryParts.join('\n\n') };
  }

  // The turn committed locally (ahead/sha set) but the worker's
  // usernode-push callback never landed the branch on GitHub
  // (push_ok=0 — e.g. the platform was mid-restart when the worker
  // called POST /api/internal/sessions/:id/push). `result.ahead` is
  // computed from the worker's LOCAL `origin/main..HEAD`, so it's >0
  // even with the remote branch still empty. Heal it here, while the
  // worker container still exists, before applyPrMetadata's createPR —
  // otherwise createPR 422s ("No commits between main and <branch>")
  // and, once the worker is evicted, the only copy of the commit is
  // gone. (chat 510 / issue #295: a restart mid-push left the branch
  // un-pushable and the work recoverable only from the CC transcript.)
  if (!result.pushOk) {
    try {
      const pushed = await worker.execPushFromWorker(sessionId, session.branch_name);
      result.pushOk = true;
      log.info('server', 'Recovered turn: re-pushed un-pushed branch', {
        sessionId, branch: session.branch_name,
        sha: (pushed?.sha || result.sha || '').substring(0, 8),
      });
    } catch (err) {
      // #1376: same treatment as the live tail — carry the real reason into
      // chat instead of a fixed "send your request again", which for a
      // permanently unpushable branch is advice that can only fail again.
      const failure = worker.describePushFailure(err);
      log.warn('server', 'Recovered turn: re-push failed — skipping PR creation', {
        sessionId,
        branch: session.branch_name,
        code: failure.code,
        permanent: failure.permanent,
        err: err.message,
      });
      const pushFailedText = failure.text;
      emit('status', { text: pushFailedText });
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [sessionId, pushFailedText, JSON.stringify({
          recovered: true,
          pushFailureCode: failure.code,
          pushFailurePermanent: failure.permanent,
        })]
      ).catch(() => {});
      await persistCompletionRow(recoveredCcSummary, 'error');
      summaryParts.push(
        `The agent committed ${result.sha.substring(0, 8)} locally, but the push to `
        + `${session.branch_name} failed, so no PR was opened and no preview was built. `
        + (failure.permanent
          ? 'This failure is permanent for this session — do NOT tell the user to retry. '
            + `Reason: ${failure.text}`
          : 'Tell the user to send their request again to re-push and open the PR.')
      );
      if (!keepWorker) await worker.destroyWorker(containerName);
      return { outcome: 'push_failed', summary: summaryParts.join('\n\n') };
    }
  }

  try {
    // Pull the user's most recent message so the PR title helper has
    // the same "what did you ask for?" signal that the normal dev-turn
    // path gets via the live SSE request body. Without this, recovery
    // would hit the fallback template ("<user>'s changes") and never
    // regenerate titles for iterative edits.
    const { rows: userMsgRows } = await pool.query(
      `SELECT content FROM chat_session_messages
       WHERE session_id = $1 AND role = 'user'
       ORDER BY id DESC LIMIT 1`,
      [sessionId]
    );
    const recoveredUserMessage = userMsgRows[0]?.content || '';

    // The turn committed and pushed: this is the live path's 'success'
    // completion card, written before the PR/staging work so the row
    // order matches a normal turn's transcript.
    await persistCompletionRow(recoveredCcSummary, 'success');
    summaryParts.push(`Commit ${result.sha.substring(0, 8)} pushed to ${session.branch_name}.`);

    // #127: same TESTING-block handling as the live dev-turn path —
    // persist the guidance (peeled off above) before applyPrMetadata
    // reads it back for the "How to test" section.
    if (recoveredTesting.testingMd || recoveredTesting.testingPath) {
      await pool.query(
        `UPDATE chat_sessions SET testing_md = $1, testing_path = $2 WHERE id = $3`,
        [recoveredTesting.testingMd, recoveredTesting.testingPath, sessionId]
      ).catch(() => {});
      session.testing_md = recoveredTesting.testingMd;
      session.testing_path = recoveredTesting.testingPath;
    }

    // Resolve a payer for a genuinely new recovery-side metadata call. A
    // completed/pending live receipt still carries and replays its original
    // payer; if this effect was never started and no payer is available, the
    // PR is completed with deterministic metadata instead of hidden spend.
    let prMetadataApiKey = null;
    let prMetadataGenerationAllowed = false;
    try {
      const billing = await limits.resolveBillingPath(
        pool, config.dataEncryptionKey, session.user_id,
      );
      if (!billing.error) {
        prMetadataApiKey = billing.apiKey;
        prMetadataGenerationAllowed = true;
      } else {
        log.info('server', 'Recovered turn using deterministic PR metadata', {
          sessionId, reason: billing.reason || null,
        });
      }
    } catch (err) {
      log.warn('server', 'Recovered PR metadata billing resolve failed', {
        sessionId, err: err.message,
      });
    }
    const prMetadataBillingByok = prMetadataGenerationAllowed && !!prMetadataApiKey;

    const wasNewPR = !session.pr_number;
    const prMetadata = require('./src/services/pr-metadata');
    const prResult = await prMetadata.applyPrMetadata({
      pool, session, repoOwner, repoName,
      userMessage: recoveredUserMessage,
      ccSummary: recoveredCcSummary,
      username: session.username,
      broadcast: (event, data) => emit(event, data),
      apiKey: prMetadataApiKey,
      userId: session.user_id,
      effectTurnId: activeTurn?.turnId || null,
      effectSessionId: sessionId,
      effectBillingByok: prMetadataBillingByok,
      allowModelGeneration: prMetadataGenerationAllowed,
    });
    // Live-path parity: a freshly opened PR gets its own transcript row,
    // so the recovered turn reads "PR #N created" like any other.
    // `done.prNumber` means the interrupted tail already opened (and
    // announced) this PR, so it isn't "new" here even though the session
    // row we were handed may predate that write.
    const prAnnounced = !!done.prNumber || !!done.prOpenedEventRecorded;
    if (prResult && prResult.prNumber && wasNewPR && !prAnnounced) {
      const prStatus = `PR #${prResult.prNumber} created`;
      let emitted = true;
      if (activeTurn?.turnId) {
        const receipt = await turnEffects.runDbEffect({
          pool,
          turnId: activeTurn.turnId,
          effectKey: 'pr_opened_announcement',
          sessionId,
          run: async (client) => {
            await client.query(
              `INSERT INTO chat_session_messages (session_id, role, content, metadata)
               VALUES ($1, 'system', $2, $3)`,
              [sessionId, prStatus,
                JSON.stringify({ prNumber: prResult.prNumber, recovered: true })],
            );
            await client.query(
              `INSERT INTO events (user_id, app_id, session_id, event_type, metadata)
               VALUES ($1, $2, $3, $4, $5::jsonb)`,
              [
                session.user_id,
                session.app_id,
                sessionId,
                events.EVENT_TYPES.PR_OPENED,
                JSON.stringify({ prNumber: prResult.prNumber }),
              ],
            );
            return { prNumber: prResult.prNumber };
          },
        });
        emitted = receipt.applied;
      } else {
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [sessionId, prStatus,
            JSON.stringify({ prNumber: prResult.prNumber, recovered: true })],
        );
        await events.record(pool, {
          type: events.EVENT_TYPES.PR_OPENED,
          userId: session.user_id,
          appId: session.app_id,
          sessionId,
          metadata: { prNumber: prResult.prNumber },
        });
      }
      if (emitted) emit('status', { text: prStatus });
      await noteMilestone({
        prNumber: prResult.prNumber,
        prOpenedEventRecorded: true,
      });
      summaryParts.push(`Opened PR #${prResult.prNumber}: ${prResult.prUrl}`);
    } else if (session.pr_number || prResult?.prNumber) {
      summaryParts.push(`Pushed to existing PR #${session.pr_number || prResult.prNumber}.`);
    }

    // Live-path parity for a PROMOTED session (sessions.js's tail): a new
    // commit invalidates the votes cast against the old one, before the
    // commit goes to the preview machine, whose reviewed-head pin it moves.
    // Gated on the milestone so a reset the live tail already performed is
    // never re-announced.
    const retireVotesOnceStaged = async () => {
      if (session.status !== 'promoted' || done.votesResetFor === result.sha) return;
      try {
        // Claim before the destructive delete. If recovery dies after this
        // point, repeating the reset/announcement would be worse than
        // leaving the already-reset votes unannounced.
        await noteMilestone({ votesResetFor: result.sha });
        // #1688: retired by an epoch bump, not deleted — the same step the
        // live tail takes, so the recovered turn also asks the prior Yes
        // voters back, in the proposal's own thread.
        const retired = await require('./src/routes/sessions').retireVotesForNewCommit({
          pool, session, sessionId, commitHash: result.sha,
        });
        if (retired.retired > 0) {
          summaryParts.push('Group-chat votes were reset for the new commit.');
        }
      } catch (err) {
        log.warn('server', 'Recovered turn: vote reset failed (non-fatal)', {
          sessionId, err: err.message,
        });
      }
    };

    const stagingFailureSummary = (failure = {}) => (
      `Staging build failed.\n\nWhat still happened: commit ${result.sha.substring(0, 8)} was pushed to `
      + `${session.branch_name}${session.pr_number ? ` and PR #${session.pr_number} was created/updated` : ''}. `
      + `Only the staging preview container is missing — there is no preview URL for this commit.\n\n`
      + `${failure.fix || 'Retry the preview build when the staging issue is resolved.'}`
    );

    // The transcript card and its replay checkpoint commit together: a
    // retained tail must never publish its outcome twice on a later wrap-up
    // retry, nor after the live tail already did; both write it through
    // publishStagingOutcome, under one receipt. A failure a tail of an
    // earlier release checkpointed is still honoured below.
    const publishRecoveredStaging = async ({ outcome, stagingUrl = null }) => {
      const metadata = {
        changesReady: true,
        ...(outcome === 'success' ? { stagingUrl } : { stagingBuild: 'running' }),
        prNumber: prResult?.prNumber || session.pr_number || null,
        prUrl: prResult?.prUrl || session.pr_url || null,
        recovered: true,
      };
      const { applied, ...value } = await require('./src/routes/sessions')
        .publishStagingOutcome({
          pool,
          sessionId,
          turnId: activeTurn?.turnId || null,
          tailIdentity: activeTurn ? turnLifecycle.cleanupArgs(activeTurn) : null,
          outcome,
          metadata,
          failure: null,
        });
      // A completed receipt is authoritative if two recovery owners reached
      // this boundary with different observations. Restore the checkpoint
      // that committed with the card, not the retrying owner's proposal.
      const settledCheckpoint = value.checkpoint
        && typeof value.checkpoint === 'object'
        && !Array.isArray(value.checkpoint)
        ? value.checkpoint
        : (value.outcome === 'success'
            ? { stagingPublished: true }
            : {
                stagingPublished: true,
                stagingFailed: value.failure || { errMsg: value.metadata?.error || 'Staging build failed' },
              });
      Object.assign(done, settledCheckpoint);

      if (applied && value.outcome === 'success') {
        emit('staging_ready', {
          url: value.metadata.stagingUrl,
          changesReady: true,
          testingMd: session.testing_md || null,
          testingPath: session.testing_path || null,
        });
      } else if (applied && value.outcome !== 'building') {
        emit('staging_failed', {
          error: value.metadata.error,
          errorName: value.metadata.stagingErrorName,
          missingKeys: value.metadata.stagingMissingKeys,
          changesReady: true,
          prNumber: value.metadata.prNumber,
          prUrl: value.metadata.prUrl,
        });
      }
      return { applied, ...value };
    };

    if (done.stagingFailed) {
      log.info('server', 'Recovered turn: staging failure already published — skipping rebuild', {
        sessionId,
      });
      summaryParts.push(stagingFailureSummary(
        typeof done.stagingFailed === 'object' ? done.stagingFailed : {},
      ));
      return { outcome: 'done', summary: summaryParts.join('\n\n') };
    }

    // The preview machine builds and checks the recovered commit; a preview
    // it already serves for this commit is joined rather than rebuilt. A
    // promoted proposal's votes are retired first: its reviewed head is the
    // pin the machine checks a revision against.
    emit('status', { text: 'Building staging preview...' });
    await retireVotesOnceStaged();
    // Non-fatal: the commit is pushed, and the boot heal hands a preview
    // that is missing to the machine on a later pass.
    const handed = await require('./src/services/preview-workflow').revision({
      pool, session, head: result.sha, source: 'turn', trigger: 'boot-reconcile',
    }).catch((err) => {
      log.warn('server', 'Recovered turn: preview hand-off failed', { sessionId, err: err.message });
      return null;
    });
    // The live tail handed this commit over before it died, and the machine
    // has built it since: the card says it is up rather than opening a
    // "building" one nothing will close.
    const { rows: [serves] } = handed?.status === 'rejected' && handed.reason === 'same_head'
      ? await pool.query(
        'SELECT staging_url FROM chat_sessions WHERE id = $1 AND staging_commit_sha = $2 AND staging_url IS NOT NULL',
        [sessionId, result.sha])
      : { rows: [] };
    if (serves) {
      await publishRecoveredStaging({ outcome: 'success', stagingUrl: serves.staging_url });
      summaryParts.push(`Staging preview is live: ${serves.staging_url}`);
    } else {
      await publishRecoveredStaging({ outcome: 'building' });
      summaryParts.push('The staging preview is building; its checks run once it is up.');
    }
  } finally {
    if (!keepWorker) await worker.destroyWorker(containerName);
  }
  return { outcome: 'done', summary: summaryParts.join('\n\n') };
}

// Resume a detached CC turn after a restart. The turn kept running (or
// finished) while we were down — its output is in the journal file
// recorded on chat_sessions.active_turn. Replays the journal from line
// 0 (rebuilding progress + result state), follows it live if the turn
// is still going, then runs the standard post-turn tail. The warm
// container stays registered for the session's next dispatch.
// #1378: build the stop handle for an ADOPTED turn.
//
// A turn started by POST /chat registers a handle in the shared stop
// registry, and that handle is the ONLY thing POST /stop looks at. A turn
// adopted after a restart or a blue-green cutover is resumed from here
// instead, so until now it had no handle at all: POST /stop classified it
// 'no_active_turn' and answered { ok: true, stopped: false } while
// GET /status still said busy, which painted a live red Stop button that
// did nothing (production session 3539 — 36 minutes unstoppable).
//
// Phase is 'cc' for the journal tail, which is what makes
// stopPolicy.killsWorkerInPhase true so the request drives the
// in-container kill; it moves to 'mayor2' when the wrap-up starts, where
// stopping is refused by design.
function buildRecoveryStopHandle({ sessionId, containerName, activeTurn, broadcastGlobal, relayTo = [] }) {
  // Recovery narration now fans out on BOTH channels. The global WS
  // broadcast reaches tabs listening for session_event; the per-session bus
  // is what a client reconnecting over GET /events replays from. The live
  // turn's send() has always done both — recovery only did the first, so a
  // reconnected client watching an adopted turn saw nothing, which would
  // include the 'stopped' this change makes it able to receive.
  const seqPrefix = `rec-${sessionId}-${process.pid}`;
  let seq = 0;
  const send = (event, data) => {
    const payload = { type: event, _seq: `${seqPrefix}-${++seq}`, ...(data || {}) };
    // Spread first, pin the envelope last — otherwise the inner `type`
    // clobbers `type: 'session_event'` and the client never routes it.
    try {
      broadcastGlobal({ ...payload, sessionId, event, type: 'session_event' });
    } catch {}
    try { sessionBus.publish(sessionId, payload); } catch {}
    // The conversations whose Mayor dispatched this run follow it on their
    // own bus, as they follow a live dispatch. Its end is theirs to announce
    // (handBackAfterRecovery), not the change's.
    if (event === 'done' || event === 'stopped') return;
    for (const agentSessionId of relayTo) {
      try {
        sessionBus.publish(require('./src/services/mayor/agent-turn').busKey(agentSessionId), {
          ...payload, changeId: sessionId, agentSessionId,
        });
      } catch {}
    }
  };
  const handle = stopRegistry.createHandle({
    sessionId,
    phase: 'cc',
    workerName: containerName || null,
    send,
  });
  // A stop clicked in the seconds before the restart is durable on the turn
  // record. Seed the handle from it so recovery honours the intent it never
  // got to act on, instead of re-adopting the turn and narrating an
  // interruption the user already asked for.
  const durable = turnLifecycle.stopRequestOf(activeTurn);
  if (durable) {
    handle.stopped = true;
    handle.stoppedBy = durable.by;
    handle.stopRequestedAt = durable.atMs;
  }
  return handle;
}

async function resumeDetachedTurn(args) {
  const { pool, sessionId, containerName, activeTurn, broadcastGlobal } = args;
  const relayTo = [];
  require('./src/services/agent-sessions').conversationsOfChange(pool, sessionId)
    .then((conversations) => {
      for (const c of conversations) {
        relayTo.push(c.agentSessionId);
        // Their lists read the dead Mayor's lease as idle; this run is theirs.
        require('./src/services/ws').pushToUser(c.userId, {
          type: 'agent_session_changed', agentSessionId: c.agentSessionId, busy: true,
        });
      }
    })
    .catch(() => {});
  const stopHandle = buildRecoveryStopHandle({
    sessionId, containerName, activeTurn, broadcastGlobal, relayTo,
  });
  stopRegistry.set(sessionId, stopHandle);
  // Register the whole recovery (journal tail + finalize's PR/staging
  // work) in the shared activeWorkers set so the auto-pause/staging-GC
  // sweepers see the session as busy — the sessions 2391/2386 incident
  // was the sweeper pausing sessions and destroying their workers in
  // the window between the journal tail ending and finalize completing.
  await activeWorkersSvc.activeWorkers.enter(sessionId);
  // Whether the recovery got to the end of the turn's work: only then has
  // the conversation that dispatched it something new to read.
  let recoveredToEnd = false;
  try {
    const out = await resumeDetachedTurnInner({ ...args, stopHandle });
    recoveredToEnd = true;
    return out;
  } catch (err) {
    let retainedTurn;
    try {
      retainedTurn = await turnLifecycle.loadActiveTurn(pool, sessionId);
    } catch (loadErr) {
      // A DB outage cannot prove that recovery ownership disappeared.
      // Retry the durable read rather than demoting the original failure to
      // an ordinary, reapable orphan.
      loadErr.retainActiveTurn = true;
      throw loadErr;
    }
    if (retainedTurn) {
      await recoveryRetry.retainOrQuarantineRecoveryError({
        pool,
        sessionId,
        activeTurn: retainedTurn,
        error: err,
      });
    }
    throw err;
  } finally {
    // Identity-guarded: a newer turn may already own the session by the time
    // this recovery unwinds, and clearing unconditionally would strand it.
    stopRegistry.deleteIf(sessionId, stopHandle);
    activeWorkersSvc.activeWorkers.delete(sessionId);
    // The conversation whose Mayor dispatched this run is still leased to
    // that Mayor's dead turn, and its screen follows the run. Whether the run
    // finished, stopped or failed, it is over.
    require('./src/services/mayor/agent-turn')
      .handBackAfterRecovery({ pool, changeId: sessionId, finished: recoveredToEnd })
      .catch((err) => log.warn('server', 'Recovered turn: conversation hand-back failed (non-fatal)', {
        sessionId, err: err.message,
      }));
    // Turn completion counts as activity: give the freshly recovered
    // session a full idle window instead of leaving last_activity_at at
    // the pre-restart user message (which made it instantly pause-
    // eligible the moment the busy guard dropped).
    await pool.query(
      `UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1`,
      [sessionId]
    ).catch(() => {});
  }
}

async function resumeDetachedTurnInner({
  config, pool, staging, broadcastGlobal, session, sessionId,
  containerName, activeTurn, stopHandle = null,
}) {
  const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  // #1378: the adopted turn's stop handle owns the fan-out (see
  // buildRecoveryStopHandle). Callers that drive this directly get an
  // unregistered handle so the narration still works.
  const handle = stopHandle || buildRecoveryStopHandle({
    sessionId, containerName, activeTurn, broadcastGlobal,
  });
  const emit = handle.send;

  // The milestone map of an interrupted TAIL (empty for a mid-exec
  // recovery). Read once here and threaded into finalizeRecoveredTurn so
  // the tail's non-idempotent steps aren't repeated.
  let tailDone = (activeTurn && typeof activeTurn.tail === 'object' && activeTurn.tail) || {};
  let recoveryActiveTurn = activeTurn;
  const recoveryAgent = recoveredAgentIdentity(session, activeTurn);
  log.info('server', 'Resuming detached turn from journal', {
    sessionId, containerName, mode: activeTurn.mode, journal: activeTurn.journal,
    // 'tail' distinguishes "the agent was done, the platform side wasn't"
    // from a genuine mid-exec resume — the two look identical in the logs
    // otherwise, and only one of them means a turn lost minutes of work.
    phase: activeTurn.phase || 'exec',
    tailDone: Object.keys(tailDone),
  });
  // #896: the same in-flight label a live turn shows — see the note in
  // adoptOrphanWorker. Emit-only (never persisted), as before.
  emit('status', {
    text: `${recoveryAgent.name} is running...`,
    ...recoveryAgent.metadata,
  });

  // The journal replay re-feeds every line from the start of the turn,
  // including ones the previous process already appended to the latest
  // "Claude Code progress" row. Rebuild that row's progressLog
  // WHOLESALE from the replayed lines (idempotent) instead of appending
  // duplicates; live tabs still get each line over the WebSocket.
  const progressLines = [];
  let flushQueued = false;
  const flushProgress = () => {
    flushQueued = false;
    pool.query(
      `UPDATE chat_session_messages
       SET metadata = jsonb_set(metadata, '{progressLog}', $1::jsonb)
       WHERE id = (
         SELECT id FROM chat_session_messages
         WHERE session_id = $2 AND role = 'system'
           AND metadata->>'progressLog' IS NOT NULL
         ORDER BY id DESC LIMIT 1
       )`,
      [JSON.stringify(progressLines), sessionId]
    ).catch(() => {});
  };

  const onRecoveredProgress = (text) => {
    emit('cc_progress', { text, ...recoveryAgent.metadata });
    progressLines.push(text);
    if (!flushQueued) {
      flushQueued = true;
      setTimeout(flushProgress, 1000);
    }
  };
  // #1378: terminalize an adopted turn that the user stopped.
  //
  // Before this, a stop that landed on a recovered turn was invisible to
  // the recovery path: the tail finished, the code below narrated
  // "[interrupted]" with unrecoverable retry pills, and an api-error tail
  // could even be RETRIED — dispatching more work for a turn the user had
  // explicitly ended. A stop is a deliberate end, so it gets the same
  // closing row and pills the live stop path writes, and the Codex ledger
  // attempt is terminalized 'cancelled' rather than 'failed'.
  const finishAsStopped = async (turnRecord, execResult = null) => {
    const record = turnRecord || recoveryActiveTurn || activeTurn;
    const by = handle.stoppedBy
      || turnLifecycle.stopRequestOf(record)?.by
      || null;
    // #1378: stopping a RECOVERED turn discards more than stopping a live
    // one — the agent may well have committed and pushed before the restart
    // that detached it. Saying only "Stopped." would leave the user's branch
    // silently moved, and re-sending the same request would buy a duplicate
    // run. The durable tail milestones know what landed (markTurnTail writes
    // sha/pushOk at the exec→tail boundary), so reuse the live path's exact
    // wording. They carry no commit COUNT, hence `ahead: null`.
    //
    // Two sources, in order of authority. A stop caught AFTER the journal
    // tail resolved has the exec result itself, which carries the commit
    // COUNT as well as the sha. A stop that surfaced as a throw does not,
    // and falls back to the durable milestones — enough to say a commit
    // landed, not enough to count them, hence `ahead: null`.
    const { describeStoppedLanding, stopLandingMeta } = require('./src/routes/sessions');
    const stoppedTail = (record && typeof record.tail === 'object' && record.tail) || {};
    const landing = execResult
      ? { sha: execResult.sha || null, ahead: execResult.ahead ?? 0, pushOk: execResult.pushOk === true }
      : { sha: stoppedTail.sha || null, ahead: null, pushOk: stoppedTail.pushOk === true };
    const landed = describeStoppedLanding(landing);
    const text = `Stopped${by ? ` by @${by}` : ''}${landed}.`;
    // Same facts as data, for the transcript's stopped card. The tail-milestone
    // branch's `ahead: null` reaches the row as a countless "changes committed"
    // chip rather than as a fabricated 1.
    const stopLanding = stopLandingMeta({
      headline: `Stopped${by ? ` by @${by}` : ''}`,
      ...landing,
    });
    const pills = recoveryPills.turnFallbackQuickReplies({ outcome: 'stopped' });
    log.info('server', 'Recovered turn was stopped by the user', {
      sessionId, by, turnId: turnLifecycle.turnIdentity(record),
    });
    if (record?.backend === 'codex_openrouter' && record?.turnUuid) {
      const agentTurn = require('./src/services/agent-turn');
      try {
        await agentTurn.completeCodexAttempt({
          pool,
          turnUuid: record.turnUuid,
          status: 'cancelled',
          errorCode: 'user_cancelled',
        });
      } catch (err) {
        log.warn('server', 'Recovered stop: Codex attempt terminalization failed', {
          sessionId, err: err.message,
        });
      }
    }
    // The progress card must not stay frozen on the last journal line.
    if (progressLines.length) {
      if (turnWatchdog.appendTerminalLine(progressLines, '[interrupted]')) {
        emit('cc_progress', { text: '[interrupted]' });
      }
      flushProgress();
    } else {
      await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
      emit('cc_progress', { text: '[interrupted]' });
    }
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [sessionId, text, JSON.stringify({
        quickReplies: pills, recovered: true, stopped: true, stopLanding,
      })]
    ).catch(() => {});
    emit('status', { text, quickReplies: pills, stopLanding });
    emit('stopped', { by });
    const stoppedCleanupArgs = turnCleanupArgs(record);
    recoveryRetry.requireDurableTurnCleanup(
      await worker.finishTurn(sessionId, stoppedCleanupArgs),
      stoppedCleanupArgs,
    );
    emit('done', {});
  };

  // The bot's builds and the bench's trials never reach this: a durable
  // build's turns are its build's to follow (services/durable-turn.js), and
  // adoptOrphanWorker leaves them alone.
  //
  // #4533: a follow-up of the bot's on its own PROMOTED proposal goes on
  // through the person's tail below (isRecoveredBotSession leaves it there on
  // purpose) but keeps the bot's clock, from the deadline its turn record
  // carries. Each restart that reaches the turn is counted on its record
  // first, and the clock gives that time back (durable-turn.js
  // RESTART_ALLOWANCE_MS). Only a turn with the bot's mark: a person's turn
  // on the same session is never stopped on it.
  const botFollowUp = homeroomBotRecovery().isRecoveredBotFollowUp(session, activeTurn);
  let botTimedOut = false;
  let botClock = null;
  if (botFollowUp) {
    const restarts = await turnLifecycle.noteRestart(pool, { sessionId, turnId: activeTurn.turnId }).catch(() => null);
    const clockTurn = Number.isInteger(restarts) ? { ...activeTurn, restarts } : activeTurn;
    const deadline = await homeroomBotRecovery().recoveryDeadline(pool, config, session, clockTurn).catch(() => null);
    if (deadline != null) {
      const botClockMs = Math.max(0, deadline - Date.now());
      botClock = setTimeout(() => {
        botTimedOut = true;
        Promise.resolve(worker.stopTurn(sessionId)).catch(() => {});
      }, botClockMs);
      // Unref only a clock that has time left to wait: it must not hold a
      // shutting-down process open for a turn's whole budget. A turn already
      // past its deadline is stopped on the next tick, and an unref'd 0 ms
      // timer can be skipped entirely when nothing else keeps the loop alive,
      // leaving the adoption waiting on a stop that never comes.
      if (botClockMs > 0 && typeof botClock.unref === 'function') botClock.unref();
    }
  }

  let result;
  try {
    result = await worker.resumeTurnFromJournal(sessionId, {
      journal: activeTurn.journal,
      turnId: activeTurn.turnId || null,
      agentBackend: activeTurn.backend || 'claude_code',
      // The journal's own harness picks its parser (#3296). Without it the
      // registry falls back to Codex, and a recovered Claude Code turn (every
      // GLM turn since #3749) came back with no result text, progress or
      // usage: a recovered spec lost its spec, a triage its verdict.
      agentHarness: activeTurn.harness || null,
      telemetryComponent: activeTurn.telemetryComponent
        || (activeTurn.mode === 'scout' ? 'coding_agent_scout'
          : activeTurn.mode === 'build' ? 'coding_agent_build' : null),
      telemetryCorrelationId: activeTurn.telemetryCorrelationId || activeTurn.turnId || null,
      telemetryAttemptNumber: activeTurn.telemetryAttemptNumber || activeTurn.attemptNumber || 1,
      telemetryRequestMode: activeTurn.telemetryRequestMode || null,
      telemetryRequestTextCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
      telemetryRequestSystemCharacters: activeTurn.telemetryRequestSystemCharacters ?? null,
      telemetryRequestPayloadCharacters: activeTurn.telemetryRequestPayloadCharacters ?? null,
      telemetryModelContextWindowTokens: activeTurn.telemetryModelContextWindowTokens ?? null,
      telemetryModelMaxOutputTokens: activeTurn.telemetryModelMaxOutputTokens ?? null,
      requestedModel: activeTurn.model || null,
      startedAt: activeTurn.startedAt || null,
      attemptNumber: activeTurn.attemptNumber || 1,
      billingByok: activeTurn.byok === true,
      providerWasDispatched: turnLifecycle.phaseOf(activeTurn) !== turnLifecycle.PHASE_DISPATCH_PENDING,
      // #664: seed the per-turn BYOK tally from the persisted record so
      // post-restart switched calls accumulate on top of pre-restart ones.
      byokCentsSoFar: Number(activeTurn.byokCents || 0),
      onProgress: onRecoveredProgress,
      // The registry state execInWorker kept for this turn (worker.js).
      mode: activeTurn.mode || null,
      branchName: session.branch_name || null,
      stopRequestedAt: turnLifecycle.stopRequestOf(activeTurn)?.atMs || null,
    });
  } catch (err) {
    if (botClock) clearTimeout(botClock);
    // #1378: the stop machinery kills the agent process and appends an exit
    // marker, so a stopped turn usually resolves rather than throwing — but
    // when it does throw, the user still asked for this to end. Close it as
    // a stop instead of reporting a failure they caused on purpose. (A
    // benchmark turn writes no stop card: its trial is put back below.)
    if (handle.stopped) {
      await finishAsStopped(activeTurn);
      return;
    }
    log.warn('server', 'Detached-turn resume failed', { sessionId, err: err.message });
    // Fail the Codex ledger row on a resume failure too (review P1c): the
    // success path terminalizes, but a thrown resume also must not leave
    // the row 'running' / the token usable until expiry.
    if (activeTurn?.backend === 'codex_openrouter' && activeTurn?.turnUuid) {
      const agentTurn = require('./src/services/agent-turn');
      try {
        await agentTurn.completeCodexAttempt({
          pool,
          turnUuid: activeTurn.turnUuid,
          status: 'failed',
          errorCode: agentTurn.classifyErrorCode(err),
          errorDetail: agentTurn.sanitizeError(err),
          telemetryComponent: turnLifecycle.phaseOf(activeTurn) === turnLifecycle.PHASE_DISPATCH_PENDING
            ? null
            : activeTurn.telemetryComponent || null,
          telemetryMetrics: {
            requestMode: activeTurn.telemetryRequestMode || null,
            requestMessageCount: activeTurn.telemetryRequestTextCharacters == null ? null : 1,
            requestUserMessageCount: activeTurn.telemetryRequestTextCharacters == null ? null : 1,
            requestContentBlockCount: activeTurn.telemetryRequestTextCharacters == null ? null : 1,
            requestTextCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
            requestUserTextCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
            requestPayloadCharacters: activeTurn.telemetryRequestTextCharacters ?? null,
            modelContextWindowTokens: activeTurn.telemetryModelContextWindowTokens ?? null,
            modelMaxOutputTokens: activeTurn.telemetryModelMaxOutputTokens ?? null,
          },
        });
      } catch (ledgerErr) {
        const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
          pool,
          sessionId,
          activeTurn,
          error: ledgerErr,
        });
        log.error('server', disposition.action === 'retry'
          ? 'Recovered Codex terminalization failed; retaining durable state'
          : 'Recovered Codex attempt is missing; durable turn quarantined', {
          sessionId, err: ledgerErr.message,
        });
        throw ledgerErr;
      }
    }
    // Terminal marker: the card must not stay frozen on the last line
    // the journal managed to deliver before the resume died. When the
    // replay produced no lines at all, append to the persisted row
    // instead — a wholesale flush of just ['[interrupted]'] would wipe
    // the log the pre-restart process already persisted.
    emit('cc_progress', { text: '[interrupted]' });
    if (progressLines.length) {
      turnWatchdog.appendTerminalLine(progressLines, '[interrupted]');
      flushProgress();
    } else {
      await appendTerminalProgressLine(pool, sessionId, '[interrupted]');
    }
    // #786: the failed-resume breadcrumb carries retry pills — the
    // phase-2 wrap-up that would normally supply them is gone with the
    // dead SSE, so this is the turn's only chance to refill the bar.
    const failedPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [sessionId, recoveryPills.TURN_UNFINISHED_BREADCRUMB,
        JSON.stringify({
          ...(failedPills ? { quickReplies: failedPills } : {}),
          recovered: true,
          recoveredReason: 'resume_failed',
        })]
    ).catch(() => {});
    emit('status', {
      text: recoveryPills.TURN_UNFINISHED_BREADCRUMB,
      quickReplies: failedPills || undefined,
    });
    await notifyTurnStalled(pool, sessionId);
    // Cleanup is deliberately last: if its durable clear needs a retry, the
    // retry scheduler can repeat only cleanup without duplicating narration.
    const cleanupArgs = turnCleanupArgs(activeTurn);
    recoveryRetry.requireDurableTurnCleanup(
      await worker.finishTurn(sessionId, cleanupArgs),
      cleanupArgs,
    );
    return;
  }
  if (botClock) clearTimeout(botClock);
  flushProgress();

  // #1378: the tail is done and the user had asked for this turn to stop.
  // Everything below — the Codex fresh-retry, the api-error retry inside
  // finalize, the Mayor wrap-up — is work for a turn that is meant to keep
  // going, so none of it may run. Close the turn as a stop and return.
  // (A benchmark turn writes no stop card either: the lane records the
  // trial as stopped on its clock, below.)
  if (handle.stopped) {
    await finishAsStopped(recoveryActiveTurn, result);
    return;
  }

  // Mirror execInWorker's finally: the exec is over, hand the durable
  // record to the tail. A journal that detached MID-EXEC leaves active_turn
  // in 'executing', and every milestone write below requires 'tail_pending'
  // (mergeTailMilestones) — without this stamp the tail's first
  // noteTailMilestone throws invalid_turn_transition, the tail aborts with
  // the turn retained, and the retained-recovery timer replays the whole
  // tail every minute forever (session 3180: 13+ identical resume attempts,
  // each re-running the finalize narration). A record still in
  // 'dispatch_pending' needs it too, for the same reason: its replay is over
  // as well, whether or not the agent ever started (change 7490, 9 Oct 2026:
  // a follow-up a pending stop skipped left its record there, and recovery
  // retried "milestone attempted from dispatch_pending" through five
  // restarts while the proposal read as running). Only those two phases are
  // stamped — an interrupted TAIL is already 'tail_pending' and re-stamping
  // would clobber its milestone map with the seed. A failed stamp propagates
  // to the caller's retain/quarantine triage like any other recovery error.
  const replayedPhase = turnLifecycle.phaseOf(recoveryActiveTurn);
  if (replayedPhase === turnLifecycle.PHASE_EXECUTING
    || replayedPhase === turnLifecycle.PHASE_DISPATCH_PENDING) {
    await worker.markTurnTail(sessionId, {
      sha: result.sha || null,
      pushOk: result.pushOk === true,
    }, turnLifecycle.cleanupArgs(recoveryActiveTurn));
  }

  // A recovered missing-thread marker still owns its one fresh attempt.
  // Re-dispatch it before consuming the journal, then make thread + ledger
  // persistence required. Any failure here deliberately escapes BEFORE the
  // tail's clearing finally, leaving active_turn and the journal replayable.
  try {
    const agentTurn = require('./src/services/agent-turn');
    const sessionsRoutes = require('./src/routes/sessions');
    const retried = await sessionsRoutes.resumeRecoveredCodexFreshRetry({
      pool, config, session, activeTurn, result,
      onProgress: onRecoveredProgress,
    });
    if (retried) {
      result = retried.result;
      recoveryActiveTurn = retried.activeTurn;
      tailDone = (recoveryActiveTurn.tail
        && typeof recoveryActiveTurn.tail === 'object'
        && recoveryActiveTurn.tail) || {};
    }

    await agentTurn.persistRecoveredAgentThread({ pool, session, result });
    await agentTurn.settleRecoveredAgentAttempt({
      pool,
      activeTurn: recoveryActiveTurn,
      result,
      settleClaude: async () => {
        if (!result.costUsd) return null;
        let byok = recoveryActiveTurn.byok;
        if (byok === undefined || byok === null) {
          try {
            const { rows } = await pool.query(
              'SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND anthropic_key_enc IS NOT NULL) AS byok',
              [session.user_id]
            );
            byok = !!rows[0]?.byok;
          } catch {
            byok = false;
          }
        }
        const limits = require('./src/services/limits');
        return limits.settleTurnSpend(pool, session.user_id, Math.round(result.costUsd * 100), {
          turnByok: !!byok,
          byokObservedCents: worker.getTurnByokCents(sessionId),
          turnId: turnLifecycle.turnIdentity(recoveryActiveTurn),
          sessionId,
        });
      },
    });
  } catch (err) {
    const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
      pool,
      sessionId,
      activeTurn: recoveryActiveTurn,
      error: err,
    });
    log.error('server', disposition.action === 'retry'
      ? 'Required recovered-turn persistence failed; retaining durable state'
      : 'Recovered turn has invalid durable state; leaving it quarantined without retry', {
      sessionId, err: err.message,
    });
    throw err;
  }

  // Terminal marker for the progress card: pessimistic default so a
  // throw anywhere below still stamps [interrupted]; the happy paths
  // overwrite it with [done] / [push_failed] before the finally runs.
  let terminalLine = '[interrupted]';
  // #786: which pill set the generic breadcrumb below should carry. The
  // scout branches attach their own pills to their own (more specific)
  // row and leave this null — a pill-less system row is transparent to
  // the client's pill resolution, so the earlier row still wins.
  // #896: which recovery-pill set the Mayor wrap-up falls back to when
  // the model declines to call suggest_replies, and what to tell it the
  // dispatch produced. Null wrapUpOutcome means "no wrap-up" — a sync
  // turn, which has no Mayor reply on the live path either.
  let wrapUpOutcome = null;
  let wrapUpPillKind = null;
  let wrapUpSummary = null;
  // #3181: the recovered turn ended on the failures a live turn marks
  // turnError (a scout that wrote no spec, a push that never landed), so
  // its notification says it stopped before finishing.
  let recoveredStalled = false;
  let durableTailComplete = false;
  try {
    if (botFollowUp && recoveryActiveTurn.mode === 'scout') {
      // #4533: a follow-up the bot may no longer revise with runs read-only
      // (scout). Its answer is the bot's to post (below), never a spec: the
      // branch after this one would have made it the proposal's.
      terminalLine = '[done]';
    } else if (recoveryActiveTurn.mode === 'scout') {
      // Scout turns push nothing — their product is the spec text.
      // Persist it the same way runScoutTool does (spec_md + frozen
      // version) so the draft isn't lost with the dead SSE.
      const {
        captureSpecOutput, persistScoutPublication,
      } = require('./src/routes/sessions');
      // #3699: an HTML spec is kept as its markdown copy (ccText) plus the document.
      const capturedSpec = captureSpecOutput(result.lastResultText);
      const ccText = capturedSpec.text;
      if (ccText) {
        const hadSpec = !!(session.spec_md || '').trim();
        // #786: "spec drafted" pills ride the spec row itself rather than
        // the wrap-up — it's the row that describes the state the session
        // actually landed in. They stay as a safety net for the case where
        // the wrap-up below can't run at all.
        const specPills = recoveryPills.buildRecoveryQuickReplies('spec_done');
        const publication = await persistScoutPublication({
          pool,
          sessionId,
          turnId: recoveryActiveTurn.turnId || null,
          content: ccText,
          contentHtml: capturedSpec.html,
          hadSpec,
          quickReplies: specPills,
          recovered: true,
        });
        session.spec_md = ccText;
        if (publication.applied) {
          emit('status', { text: publication.scoutText, ...publication.metadata });
          emit('spec_updated', {
            length: ccText.length,
            lines: publication.lineCount,
            version: publication.specVersion,
          });
        }
        wrapUpOutcome = 'spec';
        wrapUpPillKind = 'spec_done';
        wrapUpSummary = publication.hadSpec
          ? `The scout revised the session's spec doc (now ${publication.lineCount} lines). `
            + 'The user can review it in the dev-chat spec viewer. When they are ready to ship, '
            + 'they will ask you to dispatch the coding agent.'
          : `The scout investigated the repo and drafted a ${publication.lineCount}-line markdown spec. `
            + "It now lives in the session's spec doc; the user can review it in the dev-chat "
            + 'spec viewer. When they are ready to ship, they will ask you to dispatch the coding agent.';
      } else {
        // #786: previously emit-only, so a recovered-but-empty scout turn
        // left no trace at all after a reload. Persist it (with retry
        // pills) so the state is visible and actionable.
        recoveredStalled = true;
        const noSpecPills = recoveryPills.buildRecoveryQuickReplies('unrecoverable');
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [
            sessionId,
            recoveryPills.SCOUT_NO_SPEC_BREADCRUMB,
            JSON.stringify({
              ...(noSpecPills ? { quickReplies: noSpecPills } : {}),
              recovered: true,
            }),
          ]
        ).catch(() => {});
        emit('status', {
          text: recoveryPills.SCOUT_NO_SPEC_BREADCRUMB,
          quickReplies: noSpecPills || undefined,
        });
      }
      // Persist the CC session id for the next --resume.
      const newCcId = result.sessionId || result.initSessionId || null;
      if (newCcId && newCcId !== session.cc_session_id) {
        await pool.query(
          'UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2',
          [newCcId, sessionId]
        ).catch(() => {});
      }
      terminalLine = '[done]';
    } else if (recoveryActiveTurn.mode === 'sync') {
      // A sync turn is system work: it posts its own status rows via
      // sync-main's sendStatus and has no Mayor reply on the live path
      // either, so there is no wrap-up. What it does have is a caller that
      // died with the previous process: the merge-queue pass that
      // dispatched it, which would have cleared the 'integrating' it had
      // recorded on the row and then attempted the merge. Without that,
      // the card kept saying "bringing up to date with main" until some
      // unrelated trigger happened by — and a proposal whose verdict
      // carried onto the merged head, with nothing left to rebuild, had no
      // trigger left at all. So the recovered turn hands the proposal back
      // to the queue itself.
      log.info('server', 'Recovered sync turn — handing back to the integration queue', {
        sessionId,
      });
      terminalLine = '[done]';
      await require('./src/services/integration').setBlockReasons(pool, sessionId, []);
      if (session.status === 'promoted' && session.app_id != null) {
        require('./src/services/conflict-resolver')
          .checkAndResolveConflicts(config, { app_id: session.app_id })
          .catch((err) => log.warn('server', 'post-recovery queue kick failed', {
            sessionId, err: err.message,
          }));
      }
    } else {
      const { outcome: finalizeOutcome, summary } = await finalizeRecoveredTurn({
        config, pool, staging, session, sessionId, result, repoOwner, repoName,
        emit, containerName,
        // Warm contract: the container outlives the turn.
        keepWorker: true,
        startedAtMs: recoveryActiveTurn.startedAt
          ? Date.parse(recoveryActiveTurn.startedAt) || null
          : null,
        alreadyDone: tailDone,
        activeTurn: recoveryActiveTurn,
      });
      terminalLine = finalizeOutcome === 'push_failed' ? '[push_failed]' : '[done]';
      const recoveredNoChanges = !(result.ahead > 0 && result.sha);
      wrapUpPillKind = finalizeOutcome === 'push_failed' ? 'push_failed' : 'code_done';
      if (recoveryAgent.isOpenRouter && finalizeOutcome !== 'push_failed' && recoveredNoChanges) {
        wrapUpPillKind = 'chat_generic';
      }
      wrapUpOutcome = finalizeOutcome === 'push_failed'
        ? 'push_failed'
        : (recoveredNoChanges ? 'no_changes' : 'code');
      wrapUpSummary = summary;
      recoveredStalled = finalizeOutcome === 'push_failed';
    }

    // #4533: what a follow-up of the bot's did goes in the bot's ledger and
    // is said where the bot says it, as after a live turn, once the tail
    // above has moved the proposal on (homeroom-bot.js
    // finishRecoveredFollowUp: at most once, whatever replays this). Read
    // off the record recovery began with, which carries the bot's mark.
    if (botFollowUp) {
      await homeroomBotRecovery().finishRecoveredFollowUp({
        pool, config, session, activeTurn, result, timedOut: botTimedOut,
      });
    }

    // #896: re-issue the Mayor's phase-2 wrap-up. It used to be skipped
    // outright — the turn ended on a bare recovery breadcrumb and no
    // Mayor reply at all, which is exactly what the issue reported.
    // Provider failure degrades to a short static close carrying these pills.
    // Durable receipt/message/spend failures still throw so this tail remains
    // owned and is retried from its committed effects.
    // ...unless the interrupted tail already got its wrap-up onto the
    // transcript (a restart in the seconds between the wrap-up persisting
    // and the record being released). Re-issuing it would post a second
    // assistant reply describing the same build.
    if (wrapUpOutcome && tailDone.wrapUpPosted) {
      log.info('server', 'Recovered turn: wrap-up already posted — skipping re-issue', { sessionId });
      wrapUpOutcome = null;
    }
    if (wrapUpOutcome) {
      const { runRecoveredWrapUp } = require('./src/routes/sessions');
      // #1378: phase-2 is stop-proof by design — the commit, PR and staging
      // already exist, and killing the summary would leave the user without
      // any context for changes that are real. Moving the handle to
      // 'mayor2' is what makes POST /stop answer 'wrap_up_not_stoppable'
      // for an adopted turn, exactly as it does for a live one.
      handle.phase = 'mayor2';
      emit('phase', { phase: 'mayor2' });
      await runRecoveredWrapUp({
        pool, config, session, sessionId,
        outcome: wrapUpOutcome,
        dispatchSummary: wrapUpSummary,
        fallbackPillKind: wrapUpPillKind,
        turnModel: recoveryActiveTurn.model || null,
        turnId: recoveryActiveTurn.turnId || null,
        emit,
        signal: handle.abort?.signal || null,
      });
      await worker.noteTailMilestone(
        sessionId,
        { wrapUpPosted: true },
        turnLifecycle.cleanupArgs(recoveryActiveTurn),
      );
      tailDone = { ...tailDone, wrapUpPosted: true };
    }

    // #161: the pre-restart SSE is guaranteed dead, so the owner cannot
    // have been watching this turn finish — treat recovered turns as
    // armed regardless of the persisted notify_on_done flag: clear it
    // and always create the session_done notification (the WS push
    // reaches them if they have a tab open elsewhere in the app).
    // #3181: session_stalled instead when the recovered turn failed.
    try {
      const notifications = require('./src/services/notifications');
      await pool.query(
        `UPDATE chat_sessions SET notify_on_done = FALSE WHERE id = $1`,
        [sessionId]
      ).catch(() => {});
      const create = recoveredStalled
        ? notifications.createSessionStalledNotification
        : notifications.createSessionDoneNotification;
      const created = await create(pool, {
        userId: session.user_id, appId: session.app_id, sessionId,
      });
      if (created.length) await notifications.hydrateAndPush(pool, created[0]);
    } catch (err) {
      log.warn('server', 'recovered-turn session_done notify failed', {
        sessionId, err: err.message,
      });
    }
    durableTailComplete = true;
  } finally {
    // Stamp the terminal marker on the rebuilt log (dedup: journals from
    // new worker images already end with their own [done]/[push_failed])
    // so the collapsed card label can't stay frozen on "Pushing".
    if (turnWatchdog.appendTerminalLine(progressLines, terminalLine)) {
      emit('cc_progress', { text: terminalLine });
    }
    flushProgress();
    if (durableTailComplete) {
      const cleanupArgs = turnCleanupArgs(recoveryActiveTurn);
      recoveryRetry.requireDurableTurnCleanup(
        await worker.finishTurn(sessionId, cleanupArgs),
        cleanupArgs,
      );
    } else {
      log.warn('server', 'Recovered tail failed; retaining durable turn for replay', {
        sessionId,
        turnId: turnLifecycle.turnIdentity(recoveryActiveTurn),
      });
    }
  }
}

// Idle-eviction sweeper for warm worker containers.
//
// Runs every SWEEP_INTERVAL_MS. For each session in the warm registry,
// if there's no in-flight exec AND the container hasn't been used in
// WORKER_IDLE_EVICTION_MS, we `docker stop && docker rm` it. The
// per-session CC volume is preserved so the next dispatch can re-warm
// with `claude --resume <id>` and replay conversation state.
//
// Tuning: WORKER_IDLE_EVICTION_MS (default 10min). The sweeper itself
// is cheap — a `Map` walk + at most a couple of execs per cycle — so
// the interval is fixed at 30s.
const WORKER_IDLE_EVICTION_MS = parseInt(
  process.env.WORKER_IDLE_EVICTION_MS || (10 * 60 * 1000),
  10
);
const SWEEP_INTERVAL_MS = 30 * 1000;

let sweeperHandle = null;

// 14 Oct 2026 (#5162's follow-up): a durable build holds its session for
// its whole run, its turns and the time between them, wherever the build
// runs (services/build-runs.js holdsSession), and ensureWorker keeps its
// worker on its image until the build ends. A release's draining process
// forgets its idle warm workers and the new leader adopts them
// (sweepLeftWarmWorkers), so the worker a DRAINING process's build is still
// using between turns can sit in this registry, idle by its clock, or in a
// sweep's list of idle sessions: stopping it there takes the build's worker
// from under it. So every sweep that stops or pauses a session's worker
// without that session asking (the idle eviction below, the auto-pause
// sweeper's first pass, and session-lifecycle.js's slot eviction) asks this
// first, of a session it would otherwise act on, and leaves a held one
// alone until its build ends. A read that fails answers false (build-runs
// logs it), and the sweep does what it did before.
function heldByDurableBuild(sessionId, pool = getPool(config)) {
  return require('./src/services/build-runs').holdsSession(pool, sessionId);
}

// What a sweep left to a build is logged once while it stays a candidate,
// not on every pass: each sweep keeps the ids it said (`said`), and forgets
// those it no longer finds (`seen`, this pass's candidates).
function sayLeftToBuild(said, sessionId, message, fields = {}) {
  const id = Number(sessionId);
  if (said.has(id)) return;
  said.add(id);
  log.info('server', message, { sessionId: id, ...fields });
}

function forgetUnseen(said, seen) {
  const ids = new Set([...seen].map(Number));
  for (const id of said) if (!ids.has(id)) said.delete(id);
}

const idleLeftToBuilds = new Set();

// Every process sweeps its own warm registry (startProcessDuties): a web
// process never leads, and its turns' workers are its own. A session busy
// anywhere is left alone: a turn on another process may be using the very
// worker this registry last used (a session's turns land wherever the
// Service sends them).
function startIdleEvictionSweeper() {
  if (sweeperHandle) return;
  log.info('server', 'Worker idle-eviction sweeper started', {
    idleEvictionMs: WORKER_IDLE_EVICTION_MS,
    sweepIntervalMs: SWEEP_INTERVAL_MS,
  });
  sweeperHandle = setInterval(async () => {
    if (lifecycle.isShuttingDown()) return;
    await sweepIdleWarmWorkers().catch((err) => {
      log.warn('server', 'Idle eviction sweep failed', { err: err.message });
    });
  }, SWEEP_INTERVAL_MS).unref();
  // .unref() so the sweeper doesn't hold the event loop open if everything
  // else has shut down. We still clearInterval explicitly in cleanup() to
  // race-free stop the sweeper before exit.
}

// One pass of the idle eviction: every worker in this registry idle past
// WORKER_IDLE_EVICTION_MS is evicted, unless it is in use, busy elsewhere,
// kept warm by another process, or a durable build holds its session
// (heldByDurableBuild). `held` is that question, for tests.
async function sweepIdleWarmWorkers({ now = Date.now(), held = heldByDurableBuild } = {}) {
  const snapshot = worker.warmRegistrySnapshot();
  forgetUnseen(idleLeftToBuilds, snapshot.map((meta) => meta.sessionId));
  for (const meta of snapshot) {
    if (meta.inFlight) continue;
    if (meta.bootstrapping) continue;
    if (now - meta.lastUsedMs < WORKER_IDLE_EVICTION_MS) continue;
    if (activeWorkersSvc.isSessionBusyElsewhere(meta.sessionId)) continue;
    // Warm in another process too: forget it here and leave it to them;
    // the last one keeping it warm evicts it. If they all forget it at
    // once, the leader's sweep for left-behind workers adopts it.
    if (processes.heldElsewhere('warm', meta.sessionId)) {
      worker.forgetWorker(meta.sessionId);
      log.info('server', 'Idle warm worker left to another process that keeps it warm', {
        sessionId: meta.sessionId, containerName: meta.containerName,
      });
      continue;
    }
    // A durable build's, between its turns, wherever the build runs.
    if (await held(meta.sessionId)) {
      sayLeftToBuild(idleLeftToBuilds, meta.sessionId, 'Not evicting an idle warm worker: a durable build holds its session', {
        containerName: meta.containerName, idleMs: now - meta.lastUsedMs,
      });
      continue;
    }
    idleLeftToBuilds.delete(Number(meta.sessionId));
    try {
      await worker.evictWorker(meta.sessionId);
      log.info('server', 'Idle warm worker evicted', {
        sessionId: meta.sessionId,
        containerName: meta.containerName,
        idleMs: now - meta.lastUsedMs,
      });
    } catch (err) {
      log.warn('server', 'Idle eviction failed', {
        sessionId: meta.sessionId, err: err.message,
      });
    }
  }
}

// Session auto-pause sweeper. Distinct from the worker idle-eviction
// sweeper above: that one reclaims container RAM on a short timer; this
// one frees the cap *slot* on a long timer by transitioning idle
// 'active' sessions to 'paused' (worker + staging torn down, CC volume +
// branch + PR preserved). Reopening a paused session auto-resumes it.
//
// Tunables: SESSION_AUTOPAUSE_IDLE_MS (default 2h; 0 disables) and
// SESSION_SWEEP_INTERVAL_MS (default 60s). We only ever pause status=
// 'active' here — never 'promoted' (those are awaiting merge votes and
// should stay live, and pausing+resuming would currently lose the
// promoted distinction).
let sessionSweeperHandle = null;

// Messages attachment retention is independent of session auto-pause. In
// deployments that disable SESSION_AUTOPAUSE_IDLE_MS, abandoned private
// composer uploads must still be reclaimed. Hourly on the durable clock
// leader_sweeps keeps (services/leader-timers.js) — due at once when it never
// ran, and otherwise when the last pass says, whichever Pod leads by then —
// rather than at every election; linked rows remain retained with messages.
function startConversationAttachmentSweeper(config) {
  if (leaderTimers.has('conversation-attachment-gc')) return;
  const pool = getPool(config);
  const sweep = async () => {
    if (lifecycle.isShuttingDown()) return;
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM conversation_message_attachments
          WHERE message_id IS NULL
            AND created_at < NOW() - INTERVAL '24 hours'`
      );
      if (rowCount) log.info('server', 'GC\'d orphaned conversation attachments', { count: rowCount });
      await require('./src/services/moderation').purgeExpired(pool);
    } catch (err) {
      log.warn('server', 'Orphaned conversation attachment sweep failed', { err: err.message });
    }
  };
  leaderTimers.every('conversation-attachment-gc', sweep, 60 * 60 * 1000, { durable: pool });
}

// Per-session throttle for the sweeper's staging-heal pass (Pass 3). Maps
// sessionId -> last rebuild-attempt epoch ms so a promoted PR whose build
// keeps failing (missing secret, broken manifest) isn't rebuilt on every
// 60s tick. Entries are dropped once a build succeeds; the set is bounded
// by the (small) number of promoted sessions currently missing staging.
const stagingHealAttempts = new Map();
const STAGING_HEAL_COOLDOWN_MS = parseInt(
  process.env.STAGING_HEAL_COOLDOWN_MS || String(10 * 60 * 1000),
  10
);

// #447: per-session throttle for the sweeper's stuck-check pass (Pass 4),
// mirroring stagingHealAttempts above. Maps sessionId -> last recheck-attempt
// epoch ms so a check that keeps failing to record (broken build, missing
// secret) isn't re-run on every tick. Same cooldown as the staging heal.
const checkRecheckAttempts = new Map();

// #687 Slice 3: per-session throttle for the sweeper's imported-PR head-sync
// pass (Pass 6), mirroring the two maps above. Maps sessionId -> last
// getPR-check epoch ms so an open imported proposal is polled at most once
// per cooldown (one GitHub getPR per open imported proposal per interval),
// not on every 60s tick — bounding the API cost the spec calls out. Entries
// are naturally evicted when the proposal leaves the open set.
// #851: the stale-env preview pass (Pass 7) needs no throttle map here — it is
// fleet-wide rather than per-session, and its cadence lives in
// services/staging-reap.js (staleSweepDue / STAGING_STALE_SWEEP_INTERVAL_MS) so
// the boot run and this sweeper's tick cannot disagree about when it is due.

const importedHeadSyncAttempts = new Map();
const IMPORTED_HEAD_SYNC_COOLDOWN_MS = Math.max(
  parseInt(process.env.IMPORTED_HEAD_SYNC_COOLDOWN_MS || String(3 * 60 * 1000), 10) || (3 * 60 * 1000),
  30 * 1000
);

// #1442: the same shape again for the proposal-freshness pass (Pass 9). A
// promoted proposal waiting on votes has no event that re-measures how far
// behind main it is, whether it still merges cleanly, or whether the base its
// checks passed against is still on main — so the numbers voters read were
// whatever they had been at submission. This sweeper is the trigger that
// keeps them true; the read-path refresh in services/proposal-freshness.js
// only covers proposals somebody is actually looking at.
//
// Two GitHub calls per refreshed proposal (plus two more only when a conflict
// needs locating), bounded by MAX_FRESHNESS_REFRESH_PER_SWEEP and this
// cooldown rather than by the tick.
const freshnessRefreshAttempts = new Map();
const FRESHNESS_REFRESH_COOLDOWN_MS = Math.max(
  parseInt(process.env.PROPOSAL_FRESHNESS_REFRESH_MS || String(5 * 60 * 1000), 10) || (5 * 60 * 1000),
  60 * 1000
);

const autoPauseLeftToBuilds = new Set();

// The auto-pause sweeper's first pass (startSessionAutoPauseSweeper below):
// idle 'active' sessions paused, their workers destroyed and their slots
// freed. Never one mid-turn (active_turn, isSessionBusy), and, since 14 Oct
// 2026, never one a durable build holds between its turns
// (heldByDurableBuild): the auto-pause idle window is minutes, and a build
// on a draining process can be quiet that long while its review runs.
// `held` is that question, for tests. Resolves the ids it paused.
async function autoPauseIdleSessions(pool, { idleMs, exemptFixtures = false, held = (id) => heldByDurableBuild(id, pool) } = {}) {
  const paused = [];
  try {
    const { rows } = await pool.query(
      `SELECT id FROM chat_sessions
       WHERE status = 'active'
         AND active_turn IS NULL
         AND source IS DISTINCT FROM 'imported'
         AND last_activity_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
         AND NOT ($2::boolean AND COALESCE(branch_name, '') LIKE 'staging-fixture/%')
       ORDER BY last_activity_at ASC
       LIMIT 50`,
      [idleMs, !!exemptFixtures]
    );
    forgetUnseen(autoPauseLeftToBuilds, rows.map((row) => row.id));
    for (const row of rows) {
      if (activeWorkersSvc.isSessionBusy(row.id)) continue;
      if (await held(row.id)) {
        sayLeftToBuild(autoPauseLeftToBuilds, row.id, 'Not auto-pausing an idle session: a durable build holds it');
        continue;
      }
      autoPauseLeftToBuilds.delete(Number(row.id));
      try {
        const out = await sessionLifecycle.pauseSession({ pool, sessionId: row.id, reason: 'auto-idle' });
        if (out && out.paused) paused.push(Number(row.id));
      } catch (err) {
        log.warn('server', 'Auto-pause failed', { sessionId: row.id, err: err.message });
      }
    }
  } catch (err) {
    log.warn('server', 'Session auto-pause sweep failed', { err: err.message });
  }
  return paused;
}

function startSessionAutoPauseSweeper(config) {
  if (sessionSweeperHandle) return;
  if (!config.sessionAutopauseIdleMs || config.sessionAutopauseIdleMs <= 0) {
    log.info('server', 'Session auto-pause sweeper disabled', { reason: 'SESSION_AUTOPAUSE_IDLE_MS<=0' });
    return;
  }
  const pool = getPool(config);
  log.info('server', 'Session auto-pause sweeper started', {
    idleMs: config.sessionAutopauseIdleMs,
    stagingIdleMs: config.stagingIdleTeardownMs,
    sweepIntervalMs: config.sessionSweepIntervalMs,
  });
  // Not held for the shutdown drain as a whole: a pass can be minutes into a
  // staging rebuild, which a shutdown leaves to be re-driven (cleanup marks
  // it), and waiting for one held a release's drain to its 60s deadline on
  // 14 Oct 2026. Its long loops stop at their next row once shutdown begins,
  // and the proposal measurement, whose write the closing pool cut, is held
  // on its own below. One pass at a time (services/single-flight.js): a pass
  // minutes into a staging heal had later ticks start beside it.
  sessionSweeperHandle = setInterval(singleFlight('session-sweeper', async () => {
    if (lifecycle.isShuttingDown()) return;

    // Pass 1: auto-pause idle 'active' sessions (worker + slot only;
    // staging is left up for the cheap-resume window). Never pause a
    // session mid-turn: `active_turn IS NULL` excludes detached turns at
    // the SQL level (the watchdog pass below reaps stale rows, so this
    // can't block pausing forever), and isSessionBusy covers the whole
    // in-process window including the post-exec PR/staging tail — the
    // bare isInFlight check used to miss that tail and paused sessions
    // mid-wrap-up (sessions 2391/2386).
    //
    // STAGING ONLY: the `staging-fixture/*` sessions are exempt. They are
    // seeded 'active' by migrate.js because the states they exist to show —
    // the wrap-up quick-reply pills, the "Propose to group" button on the
    // changes-ready card, the starter suggestions on an empty session —
    // render on an ACTIVE session and on nothing else. Their seed comment
    // stamps `last_activity_at = NOW()` to survive the first sweep, but that
    // only buys one auto-pause window: five minutes after a deploy every one
    // of them flips to 'paused' and a dozen dapp.json checks start asserting
    // against a screen that can no longer paint what they name. Nobody is
    // holding a worker for them (they were never dispatched), so exempting
    // them costs no capacity. The predicate is the branch prefix migrate.js
    // seeds them under, and it is gated on USERNODE_ENV so production's
    // sweep is byte-for-byte what it was.
    await autoPauseIdleSessions(pool, {
      idleMs: config.sessionAutopauseIdleMs, exemptFixtures: process.env.USERNODE_ENV === 'staging',
    });

    // Pass 2: staging GC. Reclaim the staging container + cloned DB from
    // sessions cold past the (much longer) staging-idle window. Skips
    // promoted/merging (their preview backs the group vote) and anything
    // mid-turn. Status is untouched — only the preview is reclaimed.
    //
    // #866: 'archived' is now IN scope. A withdrawn proposal keeps no vote
    // to back, so its container is pure waste — and imported proposals made
    // that leak routine: the build takes minutes, the author can withdraw
    // mid-build, and the post-build status re-check (pr-import-sync) only
    // tears down the container it built itself. Anything already running
    // when the withdrawal landed (or built by a process that then died)
    // stayed up forever, since the old filter excluded archived rows. The
    // preview machine is what keeps this from racing a live build.
    if (config.stagingIdleTeardownMs && config.stagingIdleTeardownMs > 0) {
      try {
        const { rows } = await pool.query(
          `SELECT id FROM chat_sessions
           WHERE (staging_runtime_name IS NOT NULL OR staging_container_id IS NOT NULL)
             AND status NOT IN ('promoted', 'merging', 'merged')
             AND last_activity_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
           ORDER BY last_activity_at ASC
           LIMIT 20`,
          [config.stagingIdleTeardownMs]
        );
        for (const row of rows) {
          if (activeWorkersSvc.isSessionBusy(row.id)) continue;
          // The preview machine refuses to retire a preview it is building
          // or checking (teardownStagingForSession reports it as busy).
          try {
            await sessionLifecycle.teardownStagingForSession({ pool, sessionId: row.id, reason: 'idle-gc' });
          } catch (err) {
            log.warn('server', 'Staging GC failed', { sessionId: row.id, err: err.message });
          }
        }
      } catch (err) {
        log.warn('server', 'Staging GC sweep failed', { err: err.message });
      }
    }

    // Stale active_turn watchdog: an active_turn row whose session is
    // not busy in-process is orphaned — in healthy operation dispatch
    // holds the warm-registry inFlight flag and the recovery flows hold
    // activeWorkers for their full duration, so no live consumer means
    // the process that owned the turn died (e.g. a crash between boot
    // adoption and finalize). Left alone it looks "working" forever and
    // (with Pass 1's active_turn guard) blocks auto-pause. Reap it:
    // clear the record, stamp the progress card [interrupted], tell the
    // user to retry, and notify like any other finished turn. The pure
    // reap/skip policy lives in services/turn-watchdog.js.
    try {
      const { rows } = await pool.query(
        // pr_number: a reaped TAIL row names the PR its work landed on.
        // username / user_is_synthetic: a reaped turn of the Homeroom bot's
        // or of a benchmark trial goes back to its owner, not to a person.
        // A durable build's turn is its build's (services/durable-turn.js),
        // which follows it wherever the build runs next: never reaped here.
        `SELECT cs.id, cs.user_id, cs.app_id, cs.status, cs.pr_number, cs.active_turn, cs.workflow_owner,
                u.username, u.is_synthetic AS user_is_synthetic
           FROM chat_sessions cs
           LEFT JOIN users u ON u.id = cs.user_id
         WHERE cs.active_turn IS NOT NULL
           AND NOT (cs.workflow_owner IS NOT NULL AND EXISTS (
             SELECT 1 FROM wf_instances w
              WHERE w.machine = split_part(cs.workflow_owner, '/', 1)
                AND w.key = substr(cs.workflow_owner, length(split_part(cs.workflow_owner, '/', 1)) + 2)
                AND w.state = 'building'))
         ORDER BY (cs.active_turn->>'startedAt') ASC NULLS FIRST
         LIMIT 20`
      );
      const nowMs = Date.now();
      const { broadcastGlobal } = require('./src/services/ws');
      for (const row of rows) {
        // cleanup_pending means all user-visible/economic work committed and
        // only the identity-safe clear remains. Complete it silently; never
        // narrate a false interruption or replay the tail.
        if (turnLifecycle.recoveryAction(row.active_turn) === 'cleanup') {
          const args = turnCleanupArgs(row.active_turn);
          const cleared = await worker.finishTurn(row.id, args);
          if (!cleared) {
            log.warn('server', 'Watchdog could not finish pending turn cleanup', {
              sessionId: row.id,
            });
          }
          continue;
        }
        const busy = activeWorkersSvc.isSessionBusy(row.id);
        // Cheap pre-filter (no docker probe): fresh or busy rows skip.
        if (turnWatchdog.classifyStaleTurn({
          activeTurn: row.active_turn, nowMs, busy, executing: false,
        }) !== 'reap') continue;
        // Only now pay for the container probe. A live (or unobservable)
        // detached exec is left strictly alone — boot recovery or the
        // next dispatch will consume its journal.
        const executing = await worker.isWorkerExecuting(worker.workerContainerName(row.id));
        const verdict = turnWatchdog.classifyStaleTurn({
          activeTurn: row.active_turn, nowMs, busy, executing,
        });
        if (verdict !== 'reap') {
          log.warn('server', 'Stale active_turn has a live/unobservable exec — leaving for recovery', {
            sessionId: row.id, executing, startedAt: row.active_turn?.startedAt || null,
          });
          continue;
        }
        try {
          const reapTail = (row.active_turn && typeof row.active_turn.tail === 'object'
            && row.active_turn.tail) || {};
          // A reaped TAIL row is a different animal from a reaped exec: the
          // agent's work is done and (usually) pushed, so the breadcrumb
          // must not ask for a resend. `phase` in the log tells an operator
          // which one they're looking at.
          const reapCodeLanded = !!reapTail.sha && reapTail.pushOk === true;
          const closedSession = ['archived', 'merged'].includes(row.status);
          if (!closedSession) log.warn('server', 'Reaping orphaned active_turn', {
            sessionId: row.id, startedAt: row.active_turn?.startedAt || null,
            phase: row.active_turn?.phase || 'exec', codeLanded: reapCodeLanded,
          });
          if (row.active_turn?.backend === 'codex_openrouter'
              && row.active_turn?.turnUuid) {
            const agentTurn = require('./src/services/agent-turn');
            try {
              await agentTurn.completeCodexAttempt({
                pool,
                turnUuid: row.active_turn.turnUuid,
                status: 'failed',
                errorCode: 'recovery_abandoned',
                errorDetail: 'Durable turn was abandoned after its worker became stale.',
                telemetryComponent: turnLifecycle.phaseOf(row.active_turn) === turnLifecycle.PHASE_DISPATCH_PENDING
                  ? null
                  : row.active_turn.telemetryComponent || null,
              });
            } catch (ledgerErr) {
              const disposition = await recoveryRetry.retainOrQuarantineRecoveryError({
                pool,
                sessionId: row.id,
                activeTurn: row.active_turn,
                error: ledgerErr,
              });
              log.error('server', disposition.action === 'retry'
                ? 'Stale Codex turn retained because ledger terminalization failed'
                : 'Stale Codex turn quarantined because its ledger attempt is missing', {
                sessionId: row.id, err: ledgerErr.message,
              });
              continue;
            }
          }
          if (closedSession) {
            const cleared = await turnLifecycle.clearClosedSessionTurn(pool, {
              sessionId: row.id, activeTurn: row.active_turn,
            });
            if (cleared) log.info('server', 'Cleared obsolete turn from closed session', {
              sessionId: row.id, status: row.status,
            });
            // Housekeeping is not a new interruption. Leave finished-session
            // transcripts and notifications alone, including after a CAS miss.
            continue;
          }
          const reaped = await worker.clearActiveTurn(row.id, turnCleanupArgs(row.active_turn));
          if (!reaped) {
            log.warn('server', 'Stale turn changed while watchdog was reaping it', {
              sessionId: row.id,
            });
            continue;
          }
          // #1006: the bot's turns and a benchmark trial's have an owner that
          // is not a person. The breadcrumb, retry pills and stalled
          // notification below are for a person; these go back to the bot's
          // queue (attempt unspent) or the bench lane instead.
          if (require('./src/services/bench/runner').isBenchSession(row)) {
            // A trial's turn no durable trial owns (one started before trials
            // were durable): nothing is waiting on it.
            log.warn('server', 'Watchdog reaped a benchmark turn no trial owns', { sessionId: row.id });
            continue;
          }
          if (homeroomBotRecovery().isRecoveredBotSession(row)) {
            const outcome = await homeroomBotRecovery().settleReapedTurn({ pool, config, session: row });
            log.warn('server', 'Watchdog handed a reaped Homeroom bot turn back', {
              sessionId: row.id, status: row.status, outcome,
            });
            continue;
          }
          await appendTerminalProgressLine(pool, row.id, '[interrupted]');
          const msg = reapCodeLanded
            ? recoveryPills.buildCodeLandedBreadcrumb({
              prNumber: reapTail.prNumber || row.pr_number || null,
              // Nothing is rebuilding it here — the staging heal sweep owns
              // that, on its own schedule. Don't promise what this path
              // isn't doing.
              rebuildingPreview: false,
            })
            : recoveryPills.TURN_UNFINISHED_BREADCRUMB;
          // #786: retry pills on the breadcrumb — no wrap-up will run for
          // a reaped turn, so this row is the pill bar's only source.
          const reapPills = recoveryPills.buildRecoveryQuickReplies(
            reapCodeLanded ? 'code_done' : 'unrecoverable'
          );
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, metadata)
             VALUES ($1, 'system', $2, $3)`,
            [row.id, msg, JSON.stringify({
              ...(reapPills ? { quickReplies: reapPills } : {}),
              recovered: true,
              recoveredReason: reapCodeLanded ? 'watchdog_reap_tail' : 'watchdog_reap',
              ...(reapCodeLanded ? { sha: reapTail.sha } : {}),
            })]
          ).catch(() => {});
          broadcastGlobal({
            type: 'session_event', sessionId: row.id, event: 'status', text: msg,
            quickReplies: reapPills || undefined,
          });
          // Same "the owner cannot have watched this finish" rationale as
          // the recovered-turn notify block in resumeDetachedTurn. #3181: a
          // reaped exec never finished, so it says so; a reaped tail whose
          // commit landed is the work done, and stays session_done.
          try {
            const notifications = require('./src/services/notifications');
            await pool.query(
              `UPDATE chat_sessions SET notify_on_done = FALSE WHERE id = $1`,
              [row.id]
            ).catch(() => {});
            const create = reapCodeLanded
              ? notifications.createSessionDoneNotification
              : notifications.createSessionStalledNotification;
            const created = await create(pool, {
              userId: row.user_id, appId: row.app_id, sessionId: row.id,
            });
            if (created.length) await notifications.hydrateAndPush(pool, created[0]);
          } catch (err) {
            log.warn('server', 'stale-turn reap notify failed', { sessionId: row.id, err: err.message });
          }
        } catch (err) {
          log.warn('server', 'Stale active_turn reap failed', { sessionId: row.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Stale active_turn watchdog sweep failed', { err: err.message });
    }

    // Pass 3: staging heal. The flip side of Pass 2 — rebuild the staging
    // preview for promoted/merging sessions whose preview is missing or
    // dead. Two shapes (see stagingNeedsRebuild): staging_url IS NULL
    // (GC'd before/after promotion → no Preview button, gated on
    // staging_url in app-view.js), OR staging_url set but the container
    // is gone (Preview renders but the iframe can't connect). Their
    // preview backs the group's PR vote, so either way it must come back.
    // recoverSessions() heals these on startup; this keeps them healed
    // live without a restart. We over-fetch candidates and gate each on a
    // cheap liveness check, handing at most a few to the preview machine per
    // sweep, so healthy previews are never rebuilt. A preview the machine is
    // building or retrying is left to it (rebuildSessionStaging); the
    // per-session cooldown only spaces out the look at one it has refused.
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.status IN ('promoted', 'merging')
           AND cs.branch_name IS NOT NULL
         ORDER BY cs.promoted_at ASC NULLS FIRST
         LIMIT 50`
      );
      const MAX_HEALS_PER_SWEEP = 5;
      let healed = 0;
      for (const session of rows) {
        if (healed >= MAX_HEALS_PER_SWEEP || lifecycle.isShuttingDown()) break;
        if (activeWorkersSvc.isSessionBusy(session.id)) continue;
        if (!(await stagingRecovery.stagingNeedsRebuild(session, { config }))) continue;
        const last = stagingHealAttempts.get(session.id) || 0;
        if (Date.now() - last < STAGING_HEAL_COOLDOWN_MS) continue;
        stagingHealAttempts.set(session.id, Date.now());
        healed++;
        try {
          await stagingRecovery.rebuildSessionStaging({ config, pool, session, reason: 'heal' });
        } catch (err) {
          log.warn('server', 'Staging heal failed', { sessionId: session.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Staging heal sweep failed', { err: err.message });
    }

    // Pass 4: stuck-check reconcile (#447). The flip side of the merge gate
    // — a submitted CLI handoff or promoted PR whose checks are NULL, or
    // 'pending' past CHECKS_STALE_MS from before the preview machine held the
    // row, is handed to the machine so the same proposal can continue.
    // Bounded per sweep with a per-session cooldown, exactly like the
    // staging-heal pass above; the boot-time reconcileStuckChecks handles the
    // restart case, this keeps them healed live without a restart.
    try {
      const { rows } = await stagingRecovery.findStuckCheckSessions({
        pool,
        staleMs: CHECKS_STALE_MS,
        maxAutoRetries: CHECK_MAX_AUTO_RETRIES,
        limit: 50,
      });
      const MAX_RECHECKS_PER_SWEEP = 5;
      let rechecked = 0;
      for (const session of rows) {
        if (rechecked >= MAX_RECHECKS_PER_SWEEP) break;
        if (checkRecoveryInFlight(session.id)) continue;
        const last = checkRecheckAttempts.get(session.id) || 0;
        if (Date.now() - last < STAGING_HEAL_COOLDOWN_MS) continue;
        checkRecheckAttempts.set(session.id, Date.now());
        rechecked++;
        try {
          await stagingRecovery.recheckSessionChecks({ config, pool, session, reason: 'stuck-checks-sweep' });
        } catch (err) {
          log.warn('server', 'Stuck-check recheck failed', { sessionId: session.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Stuck-check reconcile sweep failed', { err: err.message });
    }

    // Pass 5: orphaned dev-chat attachments GC (#450). An upload that was
    // never sent (message_id still NULL — the user removed it from the
    // composer, or navigated away) has no owner message to cascade from,
    // so reclaim its bytea after 24h. Linked rows live with their session.
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM chat_session_attachments
          WHERE message_id IS NULL
            AND created_at < NOW() - INTERVAL '24 hours'`
      );
      if (rowCount) log.info('server', 'GC\'d orphaned chat attachments', { count: rowCount });
    } catch (err) {
      log.warn('server', 'Orphaned-attachment sweep failed', { err: err.message });
    }

    // Pass 6: orphaned issue screenshots GC (#683). An upload whose
    // feedback modal was cancelled (issue_number still NULL — never
    // linked to a filed issue) has nothing referencing it, so reclaim
    // its bytea after 24h. Linked rows live forever with their issue.
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM issue_screenshots
          WHERE issue_number IS NULL
            AND created_at < NOW() - INTERVAL '24 hours'`
      );
      if (rowCount) log.info('server', 'GC\'d orphaned issue screenshots', { count: rowCount });
    } catch (err) {
      log.warn('server', 'Orphaned-screenshot sweep failed', { err: err.message });
    }

    // Same sweep for feedback video clips (#3940): a 50 MB bytea is worth
    // reclaiming even more urgently than a screenshot. Linked rows live
    // forever with their issue.
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM issue_videos
          WHERE issue_number IS NULL
            AND created_at < NOW() - INTERVAL '24 hours'`
      );
      if (rowCount) log.info('server', 'GC\'d orphaned issue videos', { count: rowCount });
    } catch (err) {
      log.warn('server', 'Orphaned-video sweep failed', { err: err.message });
    }

    // Same sweep for group-chat attachments (#694): uploads never linked
    // to a message (removed from the composer, or the tab was abandoned)
    // reclaim their bytea after 24h. Linked rows live with their message.
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM chat_message_attachments
          WHERE message_id IS NULL
            AND created_at < NOW() - INTERVAL '24 hours'`
      );
      if (rowCount) log.info('server', 'GC\'d orphaned group-chat attachments', { count: rowCount });
    } catch (err) {
      log.warn('server', 'Orphaned group-chat attachment sweep failed', { err: err.message });
    }

    // Staging app-file GC (#752): uploads made from staging previews
    // (bridge relay path, app_files.staging = TRUE) are test data and
    // reclaim their object-store bytes after 7 days. Object first, row
    // second — a row whose object delete failed is retried next sweep.
    try {
      const appFilesSvc = require('./src/services/app-files');
      const removed = await appFilesSvc.sweepStagingFiles(pool, appFilesSvc.getStore(config));
      if (removed) log.info('server', 'GC\'d expired staging app files', { count: removed });
    } catch (err) {
      log.warn('server', 'Staging app-file sweep failed', { err: err.message });
    }

    // Pass 6: imported-PR head sync (#687, Slice 3). For each live imported
    // row, fetch the PR's current head.sha and no-op on an unchanged head;
    // on a head change refresh its preview/checks (and, once promoted, reset
    // the vote tally). Reuses this sweeper's cadence
    // + a per-session cooldown (importedHeadSyncAttempts) so the added
    // getPR-per-open-imported-proposal cost stays bounded.
    try {
      const prImportSync = require('./src/services/pr-import-sync');
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
           FROM chat_sessions cs
           JOIN apps a ON cs.app_id = a.id
          WHERE cs.source = 'imported'
            AND cs.status IN ('active', 'promoted', 'merging')
            AND cs.pr_number IS NOT NULL
          ORDER BY cs.promoted_at ASC NULLS FIRST
          LIMIT 50`
      );
      const MAX_HEAD_SYNCS_PER_SWEEP = 10;
      let synced = 0;
      const githubBudget = require('./src/services/github-budget');
      for (const session of rows) {
        if (synced >= MAX_HEAD_SYNCS_PER_SWEEP) break;
        // A getPR per imported proposal: background work, held while
        // GitHub's hourly budget is nearly used up (services/github-budget.js).
        if (!githubBudget.budgetAllows('background')) break;
        // A turn on any process (a web process runs the turns its routes
        // start, docs/plans/web-and-conductor.md), not only this one's.
        if (worker.isInFlight(session.id) || activeWorkersSvc.isSessionBusy(session.id)) continue;
        const last = importedHeadSyncAttempts.get(session.id) || 0;
        if (Date.now() - last < IMPORTED_HEAD_SYNC_COOLDOWN_MS) continue;
        // Stamp BEFORE the getPR (+ possible minutes-long rebuild) so a
        // later tick won't kick off a duplicate concurrent sync.
        importedHeadSyncAttempts.set(session.id, Date.now());
        synced++;
        try {
          await prImportSync.syncImportedProposal({ config, pool, session });
        } catch (err) {
          log.warn('server', 'Imported-PR head sync failed', { sessionId: session.id, err: err.message });
        }
      }
    } catch (err) {
      log.warn('server', 'Imported-PR head-sync sweep failed', { err: err.message });
    }

    // Pass 9: measure every promoted proposal (#2038).
    //
    // This replaced a freshness pass that was capped at ten rows a sweep with
    // a five-minute per-row cooldown, because each row cost two to six GitHub
    // reads against a rate limit. A proposal nobody had opened could therefore
    // carry numbers that were hours old, and the merge gate read them.
    //
    // A measurement is local plumbing against the app's mirror now, so the cap
    // and the cooldown are gone: every promoted proposal is measured every
    // pass. That is the fix for the whole class of failures where a proposal
    // was described confidently and wrongly — including the one that mattered
    // most, a drifted proposal below the vote threshold that no drain would
    // ever pick up and nothing else would ever re-measure.
    //
    // Grouped by app so one `git fetch` serves every open proposal on it.
    try {
      const integrationSvc = require('./src/services/integration');
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.repo_url
           FROM chat_sessions cs
           JOIN apps a ON cs.app_id = a.id
          WHERE cs.status = 'promoted'
            AND a.repo_url IS NOT NULL
            AND cs.branch_name IS NOT NULL
          ORDER BY cs.app_id, cs.integration_measured_at NULLS FIRST`
      );
      let measured = 0;
      // Held for the shutdown drain, which therefore waits for one
      // measurement at most: the loop stops at its next row once shutdown
      // begins, rather than writing into the closed pool.
      await inflightWork.track('session-sweeper:measure', async () => {
        for (const session of rows) {
          if (lifecycle.isShuttingDown()) break;
          // A session mid-turn is about to move its own head; measuring it now
          // records an answer that is wrong before it is written. Mid-turn on
          // any process, not only this one.
          if (worker.isInFlight(session.id) || activeWorkersSvc.isSessionBusy(session.id)) continue;
          const written = await integrationSvc.measure({ pool, session }, { force: true });
          if (written && !written.skipped) measured++;
        }
      });
      if (measured) log.info('server', 'Measured proposals against main', { count: measured });
    } catch (err) {
      log.warn('server', 'Proposal measurement sweep failed', { err: err.message });
    }

    // Pass 7: stale-env preview teardown (#851). The counterpart to Pass 3:
    // Pass 3 REBUILDS a stale preview that backs a live vote, this tears down
    // the stale rest (merged / abandoned / paused / session-gone), so the next
    // Preview click rebuilds with current env behind the existing loader.
    // Together they replace #850's one-off admin sweep. It also takes any
    // preview whose session merged, was archived or is gone, current env or
    // not: a failed merge-time teardown has no other retry.
    //
    // Throttled to its own long interval rather than given a timer of its
    // own — this sweeper already ticks, and listing the previews (Docker
    // containers or Kubernetes Deployments) + tearing down a few every 15
    // minutes has no business running every 60 seconds.
    // STAGING_STALE_SWEEP_INTERVAL_MS=0 disables it (the admin sweep stays).
    try {
      // The interval + "is it due" bookkeeping lives in the service, so this
      // tick and the boot run share one throttle. sweepStale never throws and
      // bounds its own work per pass.
      if (stagingReap.staleSweepDue()) {
        await stagingReap.sweepStale(config, { isInFlight: (id) => activeWorkersSvc.isSessionBusy(id) });
      }
    } catch (err) {
      log.warn('server', 'Stale-preview sweep failed', { err: err.message });
    }

    // Pass 8: orphaned staging-DATABASE reconciliation. Pass 7 (and every
    // other teardown path) only drops a staging DB alongside a matching
    // container; clones whose container is already gone used to accumulate
    // forever (3,479 DBs / 198 GB by 2026-07-30). This drops the ones no
    // session, build, or connection can reach anymore. Long interval (6h),
    // bounded batch, own throttle in the service; never throws.
    // STAGING_ORPHAN_DB_SWEEP_INTERVAL_MS=0 disables it.
    try {
      if (stagingReap.orphanDbSweepDue()) {
        await stagingReap.sweepOrphanDbs(config);
      }
    } catch (err) {
      log.warn('server', 'Orphan staging-DB sweep failed', { err: err.message });
    }

    // Pass 9: connection-pressure preview reclaim (#1771). Passes 7 and 8
    // reclaim previews for what is true about the PREVIEW (stale, orphaned).
    // This one reclaims healthy previews for what is true about the SERVER:
    // one Postgres backs the platform, every production app and every
    // preview, and when its connection budget runs out the failure lands on
    // whichever proposal's checks run next, recorded as a broken diff.
    // Does nothing at all until a census says the server is saturated; then
    // tears down the idle-longest previews, re-censusing after each one and
    // stopping the moment the pressure is off. Own throttle in the service;
    // never throws. STAGING_PRESSURE_SWEEP_INTERVAL_MS=0 disables it.
    try {
      if (stagingReap.pressureSweepDue()) {
        await stagingReap.sweepConnectionPressure(config);
        // The preview database server has its own budget
        // (STAGING_DB_ADMIN_URL). A no-op without one.
        await stagingReap.sweepConnectionPressure(config, { server: 'preview' });
      }
      // While a preview database server is being drained: what still depends
      // on it, logged every ten minutes. A no-op otherwise.
      await stagingReap.previewServerDrainStatus(config);
    } catch (err) {
      log.warn('server', 'Connection-pressure sweep failed', { err: err.message });
    }
  }), config.sessionSweepIntervalMs).unref();
}

// Stale-promoted-PR policy + reversible-archive hard GC.
//   Pass 1 (notify): a promoted PR with no voting interest for
//     PR_STALE_NOTIFY_MS gets its author a 'stale_pr' notification, and
//     we stamp stale_notified_at so the warning fires once.
//   Pass 2 (archive): if still untouched PR_STALE_GRACE_MS after that
//     warning, auto-archive it (reversible — keeps CC + branch).
//   Pass 3 (GC): archived sessions past ARCHIVED_RETENTION_MS get their
//     CC volume purged so memory stops occupying disk, and a merged
//     change's Kubernetes worker volume that outlived its merge is freed.
// "Interest" = the later of promoted_at and the newest vote; casting a
// vote clears stale_notified_at (see routes/votes.js), reviving the PR.
//
// Hourly (staleSweepIntervalMs) on the durable clock leader_sweeps keeps
// (services/leader-timers.js). As a bare setInterval its clock restarted at
// every election, and with a release every twenty minutes or so it almost
// never fired: warnings, auto-archive, archived volume GC and merged worker-volume reclaim (a disk
// leak) all waited for a quiet night.
function startStalePrSweeper(config) {
  if (leaderTimers.has('stale-pr-sweep')) return;
  const notifyEnabled = config.prStaleNotifyMs > 0;
  const gcEnabled = config.archivedRetentionMs > 0;
  if (!notifyEnabled && !gcEnabled) {
    log.info('server', 'Stale-PR / archived-GC sweeper disabled');
    return;
  }
  const pool = getPool(config);
  const notifications = require('./src/services/notifications');
  log.info('server', 'Stale-PR / archived-GC sweeper started', {
    notifyMs: config.prStaleNotifyMs, graceMs: config.prStaleGraceMs,
    retentionMs: config.archivedRetentionMs, intervalMs: config.staleSweepIntervalMs,
  });
  const {
    checkAndMerge,
    reconcilePromotedSweepHead,
  } = require('./src/routes/votes');
  const governance = require('./src/services/governance');
  const appAdmins = require('./src/services/app-admins');
  leaderTimers.every('stale-pr-sweep', async () => {
    if (lifecycle.isShuttingDown()) return;

    // Pass 0: window-elapsed merges. A promoted PR can become mergeable
    // purely through the passage of time, with no further vote to drive
    // checkAndMerge — either the threshold path (eased Yes threshold met,
    // minimum visibility window elapses) or the lazy-consensus path (below
    // threshold but unopposed Yes lead, its count-based clock elapses —
    // silence is consent). This pass re-checks each promoted PR's gate and
    // fires the merge once its window has elapsed. Latency is bounded by
    // staleSweepIntervalMs (default 1h) — acceptable; see SPEC "Post-window
    // latency". checkAndMerge re-validates and claims atomically, so a
    // racing vote can't double-merge.
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.self_hosted AS app_self_hosted,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                    AND ${currentVotePredicateSql('pv', 'cs')}) AS yes_count,
                (SELECT COUNT(*)::int FROM pr_votes pv
                  WHERE pv.session_id = cs.id AND pv.vote = 'no'
                    AND ${currentVotePredicateSql('pv', 'cs')}) AS no_count
           FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
          WHERE cs.status = 'promoted' AND cs.is_headless = FALSE
            AND (cs.behind_main IS NULL OR cs.behind_main = 0)
          LIMIT 100`
      );
      for (const session of rows) {
        if (activeWorkersSvc.isSessionBusy(session.id)) continue;
        try {
          // Native PR branches can be updated outside Homeroom. Refresh their
          // immutable reviewed revision before any timed governance decision,
          // including automatic rejection. Imported proposals retain their
          // existing imported-head synchronization behavior.
          const sweepRevision = await reconcilePromotedSweepHead({
            config, pool, session,
          });
          if (sweepRevision.blocked) {
            log.warn('server', 'Window-elapsed sweep skipped: native revision unavailable', {
              sessionId: session.id,
              transient: !!sweepRevision.transient,
              reason: sweepRevision.reason,
            });
            continue;
          }
          // #788: backfill the explicit-approval flag for never-classified
          // rows AND re-verify rows stored TRUE (a flag can go stale once
          // main moves or a sync rewrites the branch); FALSE rows are
          // skipped. All the policy lives in
          // services/app-admins.js sweepExplicitApproval.
          session.requires_explicit_approval =
            await appAdmins.sweepExplicitApproval(pool, session);
          // #646: governance-aware gate — honors the app's approver
          // policy + at-least-N mode (governance/electorate lookups are
          // TTL-cached in the service, so no per-app cache needed here).
          // #788: plus the no-timer modifier for a flagged proposal, so
          // the sweeper can never auto-merge one on a clock, and the
          // member floor: never on its author's Yes alone either.
          const gate = await governance.governedGate(pool, session.app_id, {
            kind: 'pr', id: session.id,
            openedAt: session.promoted_at || session.created_at,
            explicitApproval: !!session.requires_explicit_approval,
            authorId: session.user_id ?? null,
            // #2038: scoped by approval epoch inside the gate.
          });
          // Merge takes precedence: a row that just became mergeable should
          // merge, not reject. checkAndMerge re-confirms both gates atomically.
          if (gate.mergeable) {
            const result = await checkAndMerge(config, pool, session);
            if (result?.merged) {
              log.info('server', 'Window-elapsed PR merged by sweeper', {
                sessionId: session.id, yesCount: session.yes_count,
              });
            }
            continue;
          }
          // Auto-takedown: the rejection window has elapsed on a promoted PR
          // the group is voting down (No > Yes, under the keep-alive support
          // line). Reuse the real close/un-promote path (archiveSession),
          // then nudge clients to refetch /promoted so the row drops out (the
          // session_update 'archived' broadcast isn't wired to the vote panel).
          if (gate.rejectable) {
            const res = await sessionLifecycle.archiveSession({
              pool, sessionId: session.id, reason: 'auto-rejected',
            });
            if (res?.archived) {
              try {
                ws.pushVoteUpdate({
                  sessionId: session.id, appSlug: session.app_slug, merged: false,
                });
              } catch {}
              log.info('server', 'Promoted PR auto-rejected by sweeper', {
                sessionId: session.id,
                yesCount: session.yes_count, noCount: session.no_count,
              });
            }
          }
        } catch (err) {
          log.warn('server', 'Window-elapsed merge check failed', {
            sessionId: session.id, err: err.message,
          });
        }
      }
    } catch (err) {
      log.warn('server', 'Window-elapsed merge sweep failed', { err: err.message });
    }

    if (notifyEnabled) {
      // Pass 1: warn authors of quiet promoted PRs (once).
      try {
        const { rows } = await pool.query(
          `SELECT cs.id AS session_id, cs.user_id, cs.app_id, cs.pr_title, cs.pr_number,
                  a.slug AS app_slug, a.name AS app_name
           FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
           WHERE cs.status = 'promoted'
             AND cs.stale_notified_at IS NULL
             AND GREATEST(
                   COALESCE(cs.promoted_at, cs.created_at),
                   COALESCE((SELECT MAX(created_at) FROM pr_votes WHERE session_id = cs.id), cs.promoted_at, cs.created_at)
                 ) < NOW() - make_interval(secs => $1::double precision / 1000.0)
           LIMIT 50`,
          [config.prStaleNotifyMs]
        );
        for (const row of rows) {
          try {
            const inserted = await notifications.createStalePrNotification(pool, {
              userId: row.user_id, appId: row.app_id, sessionId: row.session_id,
            });
            await pool.query(`UPDATE chat_sessions SET stale_notified_at = NOW() WHERE id = $1`, [row.session_id]);
            if (inserted[0]) {
              ws.pushNotificationToUser(row.user_id, {
                type: 'notification_new',
                notification: notifications.serialize({
                  id: inserted[0].id, kind: 'stale_pr', read_at: null, created_at: inserted[0].created_at,
                  app_id: row.app_id, app_slug: row.app_slug, app_name: row.app_name,
                  chat_message_id: null, message_content: null,
                  session_id: row.session_id, pr_title: row.pr_title, pr_number: row.pr_number,
                  source_username: null, detail: null,
                }),
              });
            }
          } catch (err) {
            log.warn('server', 'Stale-PR notify failed', { sessionId: row.session_id, err: err.message });
          }
        }
      } catch (err) {
        log.warn('server', 'Stale-PR notify sweep failed', { err: err.message });
      }

      // Pass 2: archive PRs still untouched after the grace period.
      try {
        const { rows } = await pool.query(
          `SELECT id FROM chat_sessions
           WHERE status = 'promoted' AND stale_notified_at IS NOT NULL
             AND stale_notified_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
           LIMIT 50`,
          [config.prStaleGraceMs]
        );
        for (const row of rows) {
          if (activeWorkersSvc.isSessionBusy(row.id)) continue;
          try {
            await sessionLifecycle.archiveSession({ pool, sessionId: row.id, reason: 'stale-pr' });
          } catch (err) {
            log.warn('server', 'Stale-PR archive failed', { sessionId: row.id, err: err.message });
          }
        }
      } catch (err) {
        log.warn('server', 'Stale-PR archive sweep failed', { err: err.message });
      }
    }

    if (gcEnabled) {
      // Pass 3: hard-GC archived CC volumes past the retention window.
      try {
        const { rows } = await pool.query(
          `SELECT id FROM chat_sessions
           WHERE status = 'archived' AND cc_purged = FALSE AND archived_at IS NOT NULL
             AND archived_at < NOW() - make_interval(secs => $1::double precision / 1000.0)
           LIMIT 50`,
          [config.archivedRetentionMs]
        );
        for (const row of rows) {
          try {
            await sessionLifecycle.purgeArchivedCc({ pool, sessionId: row.id });
          } catch (err) {
            log.warn('server', 'Archived CC GC failed', { sessionId: row.id, err: err.message });
          }
        }
      } catch (err) {
        log.warn('server', 'Archived CC GC sweep failed', { err: err.message });
      }
      try {
        await require('./src/services/worker-volume-reclaim').reclaimWorkerVolumes({
          pool, mode: 'closed', limit: 50,
        });
      } catch (err) {
        log.warn('server', 'Merged worker volume sweep failed', { err: err.message });
      }
    }
  }, config.staleSweepIntervalMs, { durable: pool });
}

// The Workshop's theme sweep (services/workshop-themes.js sweep): the daily
// re-draft's clock, and the backstop for cards that arrived without a
// broadcast (an issue filed directly on GitHub). Leader-only, like the
// other sweepers: two instances re-drafting the same app is two model
// calls for one grouping. WORKSHOP_THEMES_SWEEP_INTERVAL_MS=0 disables it;
// the change hook and the GET backstop still place cards. Hourly on the
// durable clock (services/leader-timers.js), so the daily re-draft is not
// postponed by every release that changes the leader.
function startWorkshopThemeSweeper(config) {
  if (leaderTimers.has('workshop-theme-sweep')) return;
  if (!(config.workshopSweepIntervalMs > 0)) {
    log.info('server', 'Workshop theme sweeper disabled');
    return;
  }
  const pool = getPool(config);
  const workshopThemes = require('./src/services/workshop-themes');
  log.info('server', 'Workshop theme sweeper started', { intervalMs: config.workshopSweepIntervalMs });
  let running = false;
  leaderTimers.every('workshop-theme-sweep', async () => {
    if (lifecycle.isShuttingDown()) return undefined;
    if (running) return leaderTimers.SKIPPED;
    running = true;
    try {
      const out = await workshopThemes.sweep({ pool, isShuttingDown: () => lifecycle.isShuttingDown() });
      if (out && out.apps) log.info('workshop-themes', 'sweep done', out);
    } catch (err) {
      log.warn('server', 'Workshop theme sweep failed', { err: err.message });
    } finally {
      running = false;
    }
    return undefined;
  }, config.workshopSweepIntervalMs, { durable: pool });
}

// #2253: the per-app database storage cap. Every APP_DB_STORAGE_SWEEP_INTERVAL_MS
// the leader measures each app's Postgres database
// (services/app-storage-cap.js), records the figure on the app row, warns the
// app's admins past the warning line and flips its owner role read-only at
// the cap. Leader-only because a freeze mutates shared Postgres roles and
// sends notifications: two colors doing it would race the same transitions.
// The first run waits half a minute so it lands after the boot-time
// migrations that add its columns and after the role bootstraps above, not
// in the middle of them. Errors are logged and never thrown; the sweep
// records its own outcome for the admin console.
let appStorageCapSweeperHandle = null;
let appStorageCapFirstRunHandle = null;

function startAppStorageCapSweeper(config) {
  if (appStorageCapSweeperHandle) return;
  const pool = getPool(config);
  const appStorageCap = require('./src/services/app-storage-cap');
  const { capBytes, warnPercent, sweepIntervalMs } = appStorageCap.config();
  log.info('server', 'App storage cap sweeper started', { capBytes, warnPercent, sweepIntervalMs });
  let running = false;
  const run = async () => {
    if (lifecycle.isShuttingDown() || running) return;
    running = true;
    try {
      const out = await appStorageCap.sweep(pool);
      if (out.frozen || out.unfrozen || out.warned || out.errors.length) {
        log.info('app-storage-cap', 'sweep done', {
          measured: out.measured, frozen: out.frozen, unfrozen: out.unfrozen,
          warned: out.warned, cleared: out.cleared, errors: out.errors.length,
        });
      }
    } catch (err) {
      log.warn('server', 'App storage sweep failed', { err: err.message });
    } finally {
      running = false;
    }
  };
  appStorageCapFirstRunHandle = setTimeout(run, 30 * 1000);
  appStorageCapFirstRunHandle.unref?.();
  appStorageCapSweeperHandle = setInterval(run, sweepIntervalMs);
  appStorageCapSweeperHandle.unref?.();
}

// Early warning for the server-wide caps (services/platform-limit-alerts.js):
// every few minutes the leader counts live apps against MAX_APPS and active
// sessions against MAX_GLOBAL_SESSIONS, and tells the full admins once when
// either crosses PLATFORM_LIMIT_WARN_PERCENT and once when it is full. It
// reads GitHub's hourly budget the same way (the bot token's, and the App's),
// warning at a fifth left and again when it is used up.
// Leader-only so two colors don't each measure the same crossing (the row
// lock would stop a double notification anyway, but not the double work).
// The app-create routes nudge the apps check between sweeps. The first run
// waits half a minute to land after the boot-time migration that adds its
// table.
let platformLimitSweeperHandle = null;
let platformLimitFirstRunHandle = null;

function startPlatformLimitSweeper(config) {
  if (platformLimitSweeperHandle) return;
  const pool = getPool(config);
  const platformLimits = require('./src/services/platform-limit-alerts');
  log.info('server', 'Platform limit sweeper started', {
    maxApps: config.maxApps,
    maxGlobalSessions: config.maxGlobalSessions,
    warnPercent: platformLimits.warnPercent(),
    intervalMs: platformLimits.SWEEP_INTERVAL_MS,
  });
  let running = false;
  const run = async () => {
    if (lifecycle.isShuttingDown() || running) return;
    running = true;
    try {
      await platformLimits.sweep(pool, config);
    } catch (err) {
      log.warn('server', 'Platform limit sweep failed', { err: err.message });
    } finally {
      running = false;
    }
  };
  platformLimitFirstRunHandle = setTimeout(run, 30 * 1000);
  platformLimitFirstRunHandle.unref?.();
  platformLimitSweeperHandle = setInterval(run, platformLimits.SWEEP_INTERVAL_MS);
  platformLimitSweeperHandle.unref?.();
}

// #4296: the unexpected events digest and hourly alert
// (services/platform-incident-alerts.js). Leader-only, beside the platform
// limit sweep and on the same pattern; the sweep's own advisory lock and
// per-admin "already sent" check keep two processes from sending twice.
let platformIncidentAlertSweeperHandle = null;
let platformIncidentAlertFirstRunHandle = null;

function startPlatformIncidentAlertSweeper(config) {
  if (platformIncidentAlertSweeperHandle) return;
  const pool = getPool(config);
  const incidentAlerts = require('./src/services/platform-incident-alerts');
  log.info('server', 'Unexpected events alert sweeper started', {
    hourlyThreshold: incidentAlerts.HOURLY_THRESHOLD,
    digestHourUtc: incidentAlerts.DIGEST_HOUR_UTC,
    intervalMs: incidentAlerts.SWEEP_INTERVAL_MS,
  });
  let running = false;
  const run = async () => {
    if (lifecycle.isShuttingDown() || running) return;
    running = true;
    try {
      await incidentAlerts.sweep(pool);
    } catch (err) {
      log.warn('server', 'Unexpected events alert sweep failed', { err: err.message });
    } finally {
      running = false;
    }
  };
  platformIncidentAlertFirstRunHandle = setTimeout(run, 45 * 1000);
  platformIncidentAlertFirstRunHandle.unref?.();
  platformIncidentAlertSweeperHandle = setInterval(run, incidentAlerts.SWEEP_INTERVAL_MS);
  platformIncidentAlertSweeperHandle.unref?.();
}

// Graceful shutdown: mark drain state so new chats/app-creates/builds get
// 503'd, stop every leader timer, wait up to the drain deadline
// (shutdownDrainMs below) for in-flight HTTP handlers and registered
// background work to finish, then exit.
//
// What the drain waits for, and for how long:
//   - HTTP handlers still answering (src/middleware/inflight-requests.js,
//     less event streams and long polls) and the work registered in
//     services/inflight-work.js — a merge pass, a leader timer's tick — up to
//     shutdownDrainMs(): DRAIN_TIMEOUT_MS under docker-compose, a minute by
//     default on Kubernetes, whose 90s grace period this used to leave almost
//     entirely unspent. Before this the drain asked about workers alone, so
//     on a pod with none busy it returned at once and the exit cut every
//     handler and every background pass mid-write.
//   - Busy workers and before & after shots runs, up to DRAIN_TIMEOUT_MS
//     only, wherever this runs: both are restart-safe (below), so waiting
//     out a turn buys nothing and would only hold the leader lock longer.
//
// IMPORTANT: we deliberately do NOT force-remove worker containers here.
// Two reasons in the long-lived worker world:
//   - In-flight execs (workers in `activeWorkers`): killing them would
//     drop the user's turn mid-CC. Better to drain naturally; if the
//     drain times out the host-side `docker exec` child dies with us
//     and recoverActiveWorkers handles the orphan on restart.
//   - Warm-idle workers (NOT in `activeWorkers`): these are siblings
//     on the host Docker daemon, so they survive a `docker compose up`
//     redeploy of the server. Next boot's recoverActiveWorkers adopts
//     them as warm-idle, so the next dispatch is fast even across
//     production redeploys. The idle sweeper reclaims their memory in
//     steady state.
// Right-sized for deploys (#711): Docker SIGKILLs at stop_grace_period
// (docker-compose.yml, 10s), so the old 60s wait was unreachable dead
// time — and workers are deliberately restart-safe anyway (adopted by
// recoverActiveWorkers on the next boot), so waiting out a whole CC turn
// buys nothing. 5s is enough for in-flight HTTP handlers to flush DB
// writes while keeping the deploy cutover short. Must stay BELOW the
// compose stop_grace_period (tests/caddy-deploy-grace.test.js pins the
// relationship).
const DRAIN_TIMEOUT_MS = 5000;

// The handler drain's deadline for this process (services/lifecycle.js
// drainDeadlineMs): long only on the platform's own Kubernetes Pods. A
// staging preview runs as an app Deployment with the default 30s grace and
// nothing of the fleet's to finish, so it keeps the short drain.
function shutdownDrainMs() {
  let kubernetes = false;
  try {
    kubernetes = require('./src/services/application-runtime').mode(config) === 'kubernetes'
      && runsClusterMaintenance();
  } catch { /* an unknown APP_RUNTIME fails boot long before this */ }
  return lifecycle.drainDeadlineMs({ kubernetes, shortMs: DRAIN_TIMEOUT_MS, env: process.env });
}

// Budget for closing the pg pool after the handler drain (#767). Sits
// INSIDE the same compose stop_grace_period as DRAIN_TIMEOUT_MS —
// tests/caddy-deploy-grace.test.js pins drain + pool close
// below grace — so a
// pool that refuses to settle can never push the exit past the SIGKILL.
const POOL_CLOSE_TIMEOUT_MS = 1000;
const BUILD_SHUTDOWN_MARK_TIMEOUT_MS = 1000;

// ── The process being replaced tells its tabs where traffic went (#2545) ─
//
// Nothing in the release chain — the build workflow, the chart, Argo CD, the
// Deployment controller — reports back to the platform, and nothing in it
// knows the moment traffic moves as exactly as the process being replaced:
// Kubernetes terminates the old color only after the new one has been Ready
// for minReadySeconds, and by the time SIGTERM arrives the preStop sleep has
// already taken this Pod out of the Service. The Docker rollout writes the
// same fact to deploy-status.json before it stops the old container.
//
// So once the listener has closed — no new request can reach this process,
// so nothing a tab fetches next can be answered by the build being retired —
// read the build this deployment is moving to (deploy-status already reads
// it for the version row's spinner) and, if it is not this one, tell every
// open events socket. Tabs prefetch it and put up the reload button
// (public/js/app.js handlePlatformVersion) — they do not reload themselves —
// seconds before their next poll would have noticed and without waiting for
// the Deployment to call itself complete. A SIGTERM for any other reason — a
// node drain, an eviction, a crash restart — finds the target equal to this
// build and says nothing. Bounded, and run alongside the handler drain rather
// than before it, so it adds nothing to the shutdown budget the grace test
// pins.
const SUCCESSOR_ANNOUNCE_TIMEOUT_MS = 1500;

async function announceSuccessorBuild() {
  const own = process.env.GIT_SHA;
  if (!own || own === 'dev') return;
  let timer = null;
  try {
    const status = await Promise.race([
      deployStatus.read(config),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), SUCCESSOR_ANNOUNCE_TIMEOUT_MS);
      }),
    ]);
    const target = status && typeof status.sha === 'string' ? status.sha : null;
    if (!target || target === own) return;
    const sockets = ws.pushPlatformVersion({ sha: target, reason: 'rollout' });
    log.info('server', 'Announced successor build to open sockets', { sha: target, sockets });
  } catch (err) {
    log.warn('server', 'Successor build announcement failed', { err: err.message });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let cleanupStarted = false;
// Tests only (__setShutdownTargets).
let shutdownOverrides = null;
// Set by start() once the listener is up. cleanup() runs at module scope,
// so both need to be reachable from here.
let httpServer = null;
let shutdownPool = null;

async function cleanup() {
  if (cleanupStarted) return;
  cleanupStarted = true;
  lifecycle.setShuttingDown();
  // docs/plans/draining-releases.md: on the platform's own Kubernetes Pods a
  // release no longer cuts the work this process started. Everything below
  // that would cut it (ending the Mayor's turns, stopping the workflow
  // runtime's work, closing the listener) waits until drainUntilIdle has
  // let it finish, or its deadline has passed; the rest stops at once, as
  // before. A docker-compose color and a staging preview keep the short
  // drain: neither has a grace period to spend.
  const cleanupStartedAt = Date.now();
  let finishesWork = shutdownOverrides?.finishesWork ?? finishesWorkOnShutdown();
  let drainMs = shutdownOverrides?.drainMs ?? shutdownDrainMs();
  // Only beside a successor that says what it holds: a release from before
  // the registry would adopt this process's live turns as orphans the moment
  // it led (a rollback across it), and a Pod evicted before its replacement
  // is up would leave nobody leading. Without one, the cutover it always had:
  // a minute's drain, the lock released last.
  // Draining first, so a process stopping beside this one (a scale to zero,
  // a restart of every replica) never counts it as its successor.
  if (finishesWork) {
    await boundedStep(processes.markDraining(new Date(cleanupStartedAt + drainMs)), 1000)
      .catch((err) => log.warn('server', 'Could not mark this process draining', { err: err.message }));
    // Its idle warm workers are no longer its own: it starts no turn, and
    // its idle eviction stops. Forgotten here, before it resigns, so the
    // next leader adopts them (adoptOrphanWorker) rather than leave them to
    // a process that will not evict them.
    for (const meta of worker.warmRegistrySnapshot()) {
      if (!meta.inFlight && !meta.bootstrapping) worker.forgetWorker(meta.sessionId);
    }
  }
  const askSuccessor = shutdownOverrides?.successor ?? successorServing;
  if (finishesWork && !(await askSuccessor())) {
    finishesWork = false;
    drainMs = Math.min(drainMs, lifecycle.KUBERNETES_DRAIN_DEFAULT_MS);
    log.warn('server', 'No process that knows what this one holds is serving; cutting over without finishing the work', { drainMs });
  }
  // From SIGTERM, not from here: waiting for a successor spends the drain.
  const drainDeadline = cleanupStartedAt + drainMs;
  // The Mayor's turns in agent sessions end with this process: each one
  // records what it had said and that it was interrupted (with Retry), and
  // hands its lease back, so the conversation is never left looking busy
  // with nobody working. A turn whose coding agent is running is left to
  // restart recovery. Awaited with the drain below, before the pool closes.
  // A process finishing its work ends only those still running at its
  // drain's end.
  const endAgentTurns = () => require('./src/services/mayor/agent-turn').interruptLocalTurns({ timeoutMs: 3000 })
    .catch((err) => log.warn('server', 'Interrupting agent turns failed', { err: err.message }));
  let agentTurnsEnded = finishesWork ? null : endAgentTurns();
  require('./src/services/mayor/agent-turn').stopInterruptedTurnSweeper();
  // The Homeroom bot's loops and its benchmark lane: nothing new is claimed
  // or dispatched on a process whose pool is about to close. Their turns
  // already running are restart recovery's to finish.
  // The leader's statuses stop being written: the new leader's replace them.
  require('./src/services/leader-status').stop();
  try { require('./src/services/homeroom-bot').stop(); } catch (err) {
    log.warn('server', 'Stopping the Homeroom bot failed', { err: err.message });
  }
  try { require('./src/services/bench/lane').stop(); } catch (err) {
    log.warn('server', 'Stopping the benchmark lane failed', { err: err.message });
  }
  try { require('./src/services/shots-eval-runner').stopRunner(); } catch (err) {
    log.warn('server', 'Stopping the shots eval runner failed', { err: err.message });
  }
  try { require('./src/services/homeroom-bot-welcome').stop(); } catch (err) {
    log.warn('server', 'Stopping the Homeroom bot welcome failed', { err: err.message });
  }
  // The leader's sweeps on timers of their own: none may run beside the new
  // leader's while this process finishes its work. A creation under way here
  // keeps its own heartbeat until it ends.
  for (const [name, stop] of [
    ['app creation', () => require('./src/services/app-creation-owner').stop()],
    ['sketch commit', () => require('./src/services/app-sketch').stopCommitSweep()],
  ]) {
    try { stop(); } catch (err) { log.warn('server', `Stopping the ${name} sweep failed`, { err: err.message }); }
  }
  // The bot's builds and the bench's trials under way here are durable
  // builds (services/build-runs.js). A process finishing its work only
  // quiesces the workflow runtime below, so each goes on here to its end,
  // its own steps included (a build's promote passes the drain guard:
  // lifecycle.js OWN_WORK, after 14 Oct 2026's refused first version), and
  // the drain waits for it (workflowWorkRunning). Stopping the runtime, at
  // once without a drain or at the drain's deadline, stops each at its next
  // step, its turn left running in its worker, and gives its work item up, so
  // the next leader carries it on from the step it saved.
  const retentionStop = require('./src/services/build-retention').stop();
  const checkRetentionStop = require('./src/services/check-retention').stop();
  const fixedCheckSyncStop = require('./src/services/fixed-check-sync').stop();
  const languageSyncStop = require('./src/services/language-sync-runner').stop();
  const scorerStop = require('./src/services/topochain/challenge-scorer').stop();
  // Stop claiming push jobs immediately. The bounded drain runs in
  // parallel with HTTP/session draining and is awaited before pool close.
  // The workflow runtime has its own pool; its running work reports nothing,
  // and gives its lease up so the next leader claims it at once.
  // A process finishing its work only quiesces it here (no slot, timer or
  // claim): the work it runs goes on until the drain ends.
  const stopWorkflowNow = () => require('./src/workflow/platform.ts').stopWorkflow()
    .catch((err) => log.warn('server', 'Stopping the workflow runtime failed', { err: err.message }));
  let workflowStop = finishesWork
    ? require('./src/workflow/platform.ts').quiesceWorkflow()
      .catch((err) => log.warn('server', 'Quiescing the workflow runtime failed', { err: err.message }))
    : stopWorkflowNow();
  const pushStop = mobilePush.stop({ timeoutMs: DRAIN_TIMEOUT_MS }).catch((err) => {
    log.warn('server', 'Mobile push shutdown failed', {
      code: typeof err?.code === 'string' ? err.code : 'unknown',
    });
  });

  // Stop accepting BEFORE draining. Caddy's apex proxy and the wildcard
  // forward_auth gate both hold-and-retry a refused dial for 30s
  // (Caddyfile, #711), so a connection refused during the drain is
  // re-dialled into the new container — strictly better than accepting a
  // request into a process that is about to exit. Idle keep-alives are
  // dropped at once; connections still serving a request get until the
  // drain deadline, then closeAllConnections cuts them so `close()` can
  // actually complete.
  //
  // A process finishing its work keeps listening until its drain ends:
  // Kubernetes has already taken it out of the Service, and a shots worker
  // calls the Pod that runs its run by its own address.
  if (!finishesWork) closeListener(drainMs);
  // Behind the listener close, deliberately: what the tabs fetch on hearing
  // this must not be able to land here. Awaited with the drain below.
  const announced = announceSuccessorBuild();
  // Every leader timer, wherever it lives (services/leader-timers.js): no
  // tick starts from here on — no merge, rebuild or redeploy that the exit
  // would cut moments later — and a tick already running is held in the
  // in-flight registry the drain below waits for. The handles kept here
  // predate it; they are guarded and cleared the same way by hand.
  const stoppedTimers = leaderTimers.stopAll();
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
  if (sessionSweeperHandle) {
    clearInterval(sessionSweeperHandle);
    sessionSweeperHandle = null;
  }
  if (appStorageCapFirstRunHandle) {
    clearTimeout(appStorageCapFirstRunHandle);
    appStorageCapFirstRunHandle = null;
  }
  if (appStorageCapSweeperHandle) {
    clearInterval(appStorageCapSweeperHandle);
    appStorageCapSweeperHandle = null;
  }
  if (platformLimitFirstRunHandle) {
    clearTimeout(platformLimitFirstRunHandle);
    platformLimitFirstRunHandle = null;
  }
  if (platformLimitSweeperHandle) {
    clearInterval(platformLimitSweeperHandle);
    platformLimitSweeperHandle = null;
  }
  if (platformIncidentAlertFirstRunHandle) {
    clearTimeout(platformIncidentAlertFirstRunHandle);
    platformIncidentAlertFirstRunHandle = null;
  }
  if (platformIncidentAlertSweeperHandle) {
    clearInterval(platformIncidentAlertSweeperHandle);
    platformIncidentAlertSweeperHandle = null;
  }

  // Stop leading, then finish what this process started, up to its drain
  // deadline (drainUntilIdle); only then cut what is left, as below.
  let handlerDrainMs = drainMs;
  if (finishesWork) {
    await drainUntilIdle({ deadline: drainDeadline, announced });
    closeListener(DRAIN_TIMEOUT_MS);
    agentTurnsEnded = endAgentTurns();
    await workflowStop;
    workflowStop = stopWorkflowNow();
    handlerDrainMs = DRAIN_TIMEOUT_MS;
  }

  // The handlers still answering and the background work still running
  // (a merge pass, a leader timer's tick, whatever else registered with
  // services/inflight-work.js), up to this process's drain deadline. Started
  // here and awaited after the worker wait below, so the two run together;
  // the leader lock is released only after both.
  const startingRequests = inflightRequests.pending();
  const startingWork = inflightWork.snapshot();
  log.info('server', 'Draining in-flight requests and background work', {
    requests: startingRequests,
    background: startingWork.slice(0, 20),
    deadlineMs: drainMs,
    timersStopped: stoppedTimers.length,
  });
  const handlersDrained = inflightWork.waitIdle({
    timeoutMs: handlerDrainMs,
    also: () => inflightRequests.pending() === 0,
  });

  const startingCount = getActiveWorkerCount();
  log.info('server', 'Shutdown initiated, draining handlers', {
    activeWorkers: startingCount,
    timeoutMs: DRAIN_TIMEOUT_MS,
  });

  const [drained] = await Promise.all([
    lifecycle.waitFor(() => getActiveWorkerCount() === 0, {
      timeoutMs: DRAIN_TIMEOUT_MS, intervalMs: 500,
    }),
    announced,
  ]);

  if (!drained) {
    log.warn('server', 'Drain timeout — exiting with in-flight work', {
      remainingWorkers: getActiveWorkerCount(),
    });
  } else if (startingCount > 0) {
    log.info('server', 'All handlers drained');
  }
  if (!(await handlersDrained)) {
    log.warn('server', 'Drain deadline passed with requests or background work in flight', {
      deadlineMs: handlerDrainMs,
      requests: inflightRequests.snapshot().slice(0, 20),
      background: inflightWork.snapshot().slice(0, 20),
    });
  } else if (startingRequests > 0 || startingWork.length > 0) {
    log.info('server', 'In-flight requests and background work drained');
  }
  await pushStop;
  await agentTurnsEnded;

  // The checks runs this process launched go on without it: their Jobs
  // belong to the cluster. Their rows still carry this process's heartbeat,
  // though, and the next leader adopts a main-watch run only once its
  // heartbeat has lapsed (main-watch.adoptRun), so hand them over
  // (check-runs.release) BEFORE the leader lock is released below. Bounded
  // like the evidence write above. (A preview machine's run is its work
  // item's, collected by that item's retry once its lease lapses.)
  if (shutdownPool) {
    let releaseTimer = null;
    const released = await Promise.race([
      require('./src/services/check-runs').release(shutdownPool),
      new Promise((resolve) => {
        releaseTimer = setTimeout(() => resolve(null), BUILD_SHUTDOWN_MARK_TIMEOUT_MS);
      }),
    ]);
    if (releaseTimer) clearTimeout(releaseTimer);
    log.info('server', 'Handed this process\'s checks runs to the next leader on shutdown', {
      runs: released || 0, timedOut: released === null,
    });
  }

  // This process's row goes, and its holds with it: what it leaves is the
  // next leader's at once rather than once its heartbeat lapses
  // (services/processes.js). Bounded like the marks above.
  await boundedStep(processes.stop(), BUILD_SHUTDOWN_MARK_TIMEOUT_MS)
    .catch((err) => log.warn('server', 'Could not remove this process\'s row', { err: err.message }));

  // Close the pg pool so in-flight queries settle instead of being severed
  // by process.exit(). Bounded: a pool that won't drain must not hold the
  // process past the SIGKILL deadline.
  if (shutdownPool) {
    const poolStartedAt = Date.now();
    // Deliberately NOT unref'd, unlike the drain cutoff above: this timer
    // is what guarantees forward progress to process.exit(0) when end()
    // never settles. Unref'ing it would let the loop drain empty and exit
    // implicitly instead, skipping the exit log. Cleared the moment the
    // race resolves so it holds the loop for at most POOL_CLOSE_TIMEOUT_MS.
    let poolTimer = null;
    try {
      await Promise.race([
        Promise.all([retentionStop, checkRetentionStop, fixedCheckSyncStop, languageSyncStop, scorerStop, workflowStop]).then(() => shutdownPool.end()),
        new Promise((resolve) => { poolTimer = setTimeout(resolve, POOL_CLOSE_TIMEOUT_MS); }),
      ]);
      log.info('server', 'Pool closed', { durationMs: Date.now() - poolStartedAt });
    } catch (err) {
      log.warn('server', 'Pool close failed', {
        err: err.message, durationMs: Date.now() - poolStartedAt,
      });
    } finally {
      if (poolTimer) clearTimeout(poolTimer);
    }
  }

  // Release the leader advisory lock LAST — only after draining — so the
  // standby color promotes and runs recovery (incl. orphan worker adoption)
  // against a quiesced process, not one still finishing a turn. Uses its
  // own dedicated pg connection, so the pool close above doesn't affect
  // it. (Process exit would release the session lock anyway; doing it
  // explicitly just hands off promptly.) A process that finished its work
  // resigned long before (drainUntilIdle), and adoption skipped what it held.
  if (leadership) {
    await leadership.stop().catch(() => {});
  }

  process.exit(0);
}

// docs/plans/draining-releases.md: whether this process finishes its work on
// SIGTERM rather than cutting it: the platform's own Kubernetes Pods, the
// processes the long drain is for (shutdownDrainMs).
function finishesWorkOnShutdown() {
  try {
    return require('./src/services/application-runtime').mode(config) === 'kubernetes' && runsClusterMaintenance();
  } catch { return false; }
}

// Waits up to SUCCESSOR_WAIT_MS for another process of this role to be
// serving (services/processes.js servingOthers). On a rollout the new Pod has
// been Ready since before SIGTERM; on an eviction its replacement is starting.
const SUCCESSOR_WAIT_MS = 60 * 1000;
async function successorServing({ timeoutMs = SUCCESSOR_WAIT_MS, pollMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await processes.servingOthers()) > 0) return true; } catch { /* asked again below */ }
    if (Date.now() + pollMs > deadline) return false;
    await new Promise((r) => { const t = setTimeout(r, pollMs); t.unref?.(); });
  }
}

function boundedStep(promise, ms) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

// Stop accepting new connections. Idle keep-alives are dropped at once;
// connections still serving a request get until `timeoutMs`, then
// closeAllConnections cuts them so `close()` can complete.
function closeListener(timeoutMs) {
  if (!httpServer) return;
  try {
    httpServer.close(() => {});
    httpServer.closeIdleConnections?.();
    const cutoff = setTimeout(() => {
      try { httpServer.closeAllConnections?.(); } catch { /* already gone */ }
    }, timeoutMs);
    cutoff.unref?.();
    log.info('server', 'Listener closed to new connections', { timeoutMs });
  } catch (err) {
    log.warn('server', 'Listener close failed', { err: err.message });
  }
}

// What of this process's background work is its leader work: a leader
// timer's tick (services/leader-timers.js) and a merge pass (merge-queue.js).
// The lock goes only once they are done, or at the drain deadline: the new
// leader would run the same sweep, or the same app's merges, beside them.
const isLeaderWork = (name) => name.startsWith('timer:') || name === 'merge-queue';

// A release replaced this process: stop leading, send its tabs to the new
// Pod, and finish what it holds (services/processes.js), its background work
// (inflight-work.js), its workflow work and its requests still answering,
// until it is idle, the deadline passes, or too many newer processes are
// draining too (services/drain.js). Its leader work, its loops and its
// timers stopped before this is called, and it refuses anything new
// (lifecycle.setShuttingDown).
async function drainUntilIdle({ deadline, announced }) {
  const workflowPlatform = require('./src/workflow/platform.ts');
  const leaderWorkDone = await inflightWork.waitIdle({ timeoutMs: Math.max(0, deadline - Date.now()), only: isLeaderWork });
  if (!leaderWorkDone) {
    log.warn('server', 'Resigning with leader work still running at the drain deadline', {
      work: inflightWork.snapshot().filter((e) => isLeaderWork(e.name)).slice(0, 20),
    });
  }
  if (leadership) await leadership.resign().catch((err) => log.warn('server', 'Resigning leadership failed', { err: err.message }));
  await announced;
  const closed = ws.closeAllForRelease();
  const busy = () => ({
    holds: processes.localSnapshot(20),
    background: inflightWork.snapshot().slice(0, 20),
    workflowWork: workflowPlatform.workflowWorkRunning(),
    requests: inflightRequests.pending(),
  });
  log.info('server', 'Finishing this process\'s work before exiting', {
    sockets: closed, deadlineMs: Math.max(0, deadline - Date.now()), ...busy(),
  });
  const maxDraining = drain.drainingMax();
  let why = null;
  const outcome = await drain.untilIdle({
    deadline,
    idle: () => processes.localCount() === 0 && inflightWork.size() === 0
      && workflowPlatform.workflowWorkRunning() === 0 && inflightRequests.pending() === 0,
    // Too many newer processes draining, or no successor serving any more
    // (it died, and nothing leads): hand the rest over now.
    superseded: async () => {
      if ((await processes.newerDraining()) >= maxDraining) { why = 'crowded'; return true; }
      if ((await processes.servingOthers()) === 0) { why = 'alone'; return true; }
      return false;
    },
    describe: busy,
  });
  if (outcome.reason === 'idle') {
    log.info('server', 'Finished this process\'s work', { waitedMs: outcome.waitedMs });
  } else {
    const message = outcome.reason === 'deadline' ? 'Drain deadline passed; handing the rest of this process\'s work over'
      : why === 'alone' ? 'No successor is serving any more; handing the rest of this process\'s work over'
        : 'Newer processes are draining too; handing the rest of this one\'s work over';
    log.warn('server', message, { waitedMs: outcome.waitedMs, maxDraining, ...busy() });
  }
  return outcome;
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
