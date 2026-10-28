require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { once } = require('events');
const { loadShellRelease } = require('./src/services/shell-release');
const shellRelease = loadShellRelease(path.join(__dirname, 'public'));
// The baked artifact is authoritative even when a runtime omits build args.
// loadShellRelease rejects an explicitly different runtime revision.
if (shellRelease && shellRelease.revision !== 'dev') process.env.GIT_SHA = shellRelease.revision;
const { load: loadConfig, runsClusterMaintenance } = require('./src/config');
const platformPreviewPolicy = require('./src/services/platform-preview-data-policy');
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
const { adultAttestationRoutes } = require('./src/routes/adult-attestation');
const { homeLayoutRoutes } = require('./src/routes/home-layout');
const { chatDraftsRoutes } = require('./src/routes/chat-drafts');
const { agentSessionDraftsRoutes } = require('./src/routes/agent-session-drafts');
const { devFlowRoutes } = require('./src/routes/dev-flow');
const { pmOrderRoutes } = require('./src/routes/pm-order');
const { debugRoutes } = require('./src/routes/debug');
const { galleryRoutes } = require('./src/routes/gallery');
const { appInstallRoutes } = require('./src/routes/app-install');
const communityInviteRoutes = require('./src/routes/community-invites');
const projectPreviewRoutes = require('./src/routes/project-preview');
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
const worker = require('./src/services/worker');
// What a turn's recovery runs (services/turn-recovery.js): the adoption, its
// stop handle and its tail, exported below for the tests that drive them.
const turnRecovery = require('./src/services/turn-recovery');
const { adoptOrphanWorker } = turnRecovery;
const sessionBus = require('./src/services/session-bus');
const ws = require('./src/services/ws');
const log = require('./src/services/logger');
const lifecycle = require('./src/services/lifecycle');
// The platform's processes and what each holds (docs/plans/draining-releases.md).
const processes = require('./src/services/processes');
const drain = require('./src/services/drain');
const processRole = require('./src/services/process-role');
const inflightWork = require('./src/services/inflight-work');
const inflightRequests = require('./src/middleware/inflight-requests');
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
const { withMigrationLock } = require('./src/services/db-locks');
const { publicApiCors } = require('./src/middleware/public-cors');
const { responseCompression } = require('./src/middleware/response-compression');
const { trustedProxyClientIp } = require('./src/services/client-ip');

const config = loadConfig();
log.setLevel(config.logLevel);

const app = express();
let startupDiagnostics = null;

// First of all: count every request until it is answered, so the shutdown
// drain in cleanup() can wait for the handlers still writing rather than
// exit from under them. Event streams and long polls leave the count (see
// src/middleware/inflight-requests.js).
app.use(inflightRequests.inflightRequests());

// Then count every /api/ response by the route template it matched and its
// status, and each 5xx by what was thrown, for the Server errors figure and
// the server_errors signal (src/middleware/request-counts.js,
// src/services/server-error-counts.js). It only listens for `finish`.
app.use(require('./src/middleware/request-counts').requestCounts());

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
// Brevo's and Twilio's SMS webhooks (STOP replies and delivery receipts),
// HERE for the same reasons: neither has a session, and the token or the
// signature is the whole check.
app.use(require('./src/routes/sms-webhooks').smsWebhookRoutes(config));
// Alertmanager's webhook (src/routes/alerts-webhook.js): HERE for the same
// second reason, a caller with no session, authenticated by its own token.
// It parses its own JSON body.
app.use(require('./src/routes/alerts-webhook').alertsWebhookRoutes(config));

// ── Work-order patch uploads (#4264) ───────────────────────────────────────
// A coding agent's one-time upload of a large patch for a connector work
// order. HERE for the webhook's two reasons: the body is raw patch bytes
// under whatever Content-Type curl sends, so it must precede the JSON
// parser, and the caller is a sandbox with no session, authenticated by the
// task's own token. src/routes/external-agent-patch-upload.js has the rest.
app.use(require('./src/routes/external-agent-patch-upload').externalAgentPatchUploadRoutes(config));

// ── Projects made inside a platform preview ────────────────────────────────
// A platform preview asks production for the database, build and runtime of
// a project someone makes in it (services/preview-projects.js). HERE for
// the patch upload's reasons: the caller is a preview's process with no
// session, authenticated by its own credential, and a build's body is far
// over the global parser's limit, so each route parses its own once the
// caller is known. 404 when it is off (Admin > Limits, or the operator's
// PREVIEW_PROJECTS_ENABLED=false).
app.use(require('./src/routes/preview-projects').previewProjectsRoutes(config));

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
app.use(require('./src/services/browser-api-cache').browserApiCachePolicy);

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

app.get('/api/node-status/full', async (_req, res) => {
  // Lazy require here (rather than top of file) keeps the import graph
  // straight: chain-poller and genesis-accounts are leaf modules; node-
  // status doesn't import them. The callback shape is what wires them
  // together at request time.
  const chainPollerSvc = require('./src/services/chain-poller');
  const genesisAccountsSvc = require('./src/services/genesis-accounts');
  res.set('Cache-Control', 'no-store');
  // The wallet-links clock's last run, read from any process.
  const walletLinks = await require('./src/workflow/platform.ts').clockStatus(getPool(config), 'wallet-links').catch(() => null);
  res.json(nodeStatus.getFull({
    name: 'usernode-social-vibecoding',
    mode: process.env.USERNODE_LOCAL_DEV ? 'local-dev' : 'production',
    services: () => ({
      chainPoller: chainPollerSvc.statusOf(walletLinks),
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
app.use(require('./src/middleware/private-streams').privateStreamDelivery(config));
// Every admin write, on whichever router declares it, answers only the
// Homeroom page itself (middleware/same-site-browser.js). Mounted ahead of
// all of them; the CLI's bearer calls carry no Sec-Fetch-Site and pass.
app.use(['/api/admin', '/api/v4/admin'], require('./src/middleware/same-site-browser').sameOriginBrowserWrites);
app.use(require('./src/middleware/moderation').moderationGuard(config));
app.use(require('./src/routes/moderation').moderationRoutes(config));
app.use(require('./src/routes/app-blocks').appBlockRoutes(config));
app.use(require('./src/routes/community-pins').communityPinRoutes(config));
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
app.use(agentSessionRoutes(config));
// #4313: the ?demo=1 Needs-you cards' votes, answered before the session
// routers' guard refuses their negative ids (staging only).
app.use(demoNeedsVoteRoutes());
app.use(sessionRoutes(config));
app.use(voteRoutes(config));
app.use(shotsRoutes(config));
// Demo mode: a creator's synthetic partner proposes, votes and resets, on a
// demo-mode app only (routes/demo-mode.js). Mounted beside the vote routes
// it borrows recordVote from.
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
// #5048: requests only platform admins can see, kept off GitHub.
app.use(require('./src/routes/private-requests').privateRequestRoutes(config));
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
// The Workshop's placement stage is owed a pass when a card arrives on or
// leaves a board — which every route and service announces through
// ws.pushSessionUpdate / pushIssueUpdate — on whichever instance handled the
// change: its row's due time, which the workshop-changes clock runs
// (services/workshop-themes.js). Registered on every process for that
// reason; the daily re-draft is a clock too (src/workflow/clock/services.ts).
{
  const workshopThemes = require('./src/services/workshop-themes');
  if (typeof ws.onBoardChange === 'function') {
    ws.onBoardChange((info) => workshopThemes.noteBoardChange(getPool(config), info));
  }
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
// "Are you 18 or older?" (#5095): the yes the wallet, staking, node and
// passport writes wait for. Me-scoped, behind authMiddleware.
app.use(adultAttestationRoutes(config));
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
// A shared public project's link preview (routes/project-preview.js): the
// `/app/<slug>` page with the project's name, description and cover in its
// head, and the cover itself under /api/public/. AFTER authMiddleware, so a
// signed-in person's own load passes straight to the catch-all, and BEFORE
// the catch-all, which would answer an unfurler with a bare "Homeroom".
app.use(projectPreviewRoutes(config));
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
    token = platformJwt.signAppIdentityToken({
      appId: appRow.id,
      user: appRow.slug === config.selfAppSlug ? platformPreviewPolicy.previewIdentity(tokenUser) : tokenUser,
      // The platform itself is entered through cookies in production; its
      // app identity is only for the sanitized preview. Nested identities
      // minted by a preview also stay preview-only.
      environment: appRow.slug === config.selfAppSlug || process.env.USERNODE_ENV === 'staging'
        ? 'preview' : 'production',
    });
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

// What every process does for itself, whatever its role
// (services/process-role.js): each one sweeps what only it holds. A staging
// preview runs none of it (config.runsClusterMaintenance).
function startProcessDuties() {
  // (Idle workers are not a process's to evict: the worker-eviction clock
  // evicts any worker nothing used for WORKER_IDLE_EVICTION_MS, from
  // session_workers: services/worker-eviction.js.)
  // The shots checkouts a run left in this process's own temporary
  // directory (a run's work is claimed wherever the workflow runs).
  require('./src/services/shots-gc').sweepOwnCheckouts(config, getPool(config));
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
    // The read-only database roles go with the schema, under the same lock:
    // the new build's deny lists over the new tables, by one process
    // (services/db-roles.js; on Kubernetes the migration Job does both).
    migration = await withMigrationLock(getPool(config), async () => {
      const result = await migrate(config);
      await require('./src/services/db-roles').ensureRoles(config);
      return result;
    });
  }
  const servicesStartedAt = Date.now();
  // Prime the SMS provider choice once, so the synchronous offer gate
  // (firebase-phone-auth.js offered()) sees an admin's saved switch before
  // the first phone-auth request. Never fatal: an unreadable setting falls
  // back to the deploy's default.
  await require('./src/services/sms/select').selection(getPool(config)).catch(() => {});
  // This process, and what it holds, for every other one to see
  // (docs/plans/draining-releases.md): before anything here can start work.
  // Never fatal: holds stay this process's own until the database takes them.
  await processes.start({ pool: getPool(config), role: ownRole });
  // The connection budget (item 4): nothing here starts work while a
  // process this one replaces holds its capacity claim (connections above
  // its drain sizes, until they close). Registered above, this process is
  // what makes it hand over; it waits holding no pool connection
  // (processes.js waitForRoom).
  const room = await processes.waitForRoom();
  if (room.waitedMs > 0) log.info('server', 'Older processes gave back their connections; starting', room);
  // Conductors retire unsafe previews before starting work. Web processes
  // wait for a fresh result from the existing security clock before serving.
  const previewRetirement = runsClusterMaintenance()
    ? await require('./src/services/platform-preview-startup').beforeServe(config, getPool(config)) : null;
  // The limiters that gate a send, a bill or a guess count in Postgres: one
  // budget for every process, kept across a deploy (services/rate-limit-store.js).
  require('./src/services/rate-limit-store').setPool(getPool(config));
  // Turns' streams, kept where a browser served by any process reads them
  // (services/session-bus.js).
  sessionBus.init({ pool: getPool(config) });
  // The clients every process that runs the workflow machines makes
  // (src/workflow/setup.ts): the push sender, GitHub, the model.
  await require('./src/workflow/setup.ts').startWorkflowClients(config);
  // The workflow runtime (src/workflow/platform.ts): every process appends
  // and waits for outcomes; a process that runs the workflow starts its
  // loops below, once it listens. Fatal: the machines are the only paths for
  // what they decide (governance has no other), so a process without them
  // exits and is restarted rather than serving without them.
  await require('./src/workflow/platform.ts').startWorkflow(config, { loops: false, previewRetirement });
  startupDiagnostics = Object.freeze({
    totalMs: Date.now() - startedAt,
    migrationsOnStartup,
    migration,
    servicesMs: Date.now() - servicesStartedAt,
  });

  if (processRole.runsWorkflow(ownRole)) worker.ensureWorkerImage().catch((err) => {
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
  // The genesis set, which wallet sign-up asks and the wallet-links clock
  // reads (on whichever process runs the workflow), in every process.
  genesisAccounts.start();
  // The caches people's requests read: a conductor serves nobody's.
  if (processRole.servesRequests(ownRole)) {
    nodeStatus.start({ nodeRpcUrl: process.env.NODE_RPC_URL });
    // Warm the /api/status cache so the first dashboard load doesn't have
    // to wait 1-2s on `docker stats`. Subsequent loads are served from
    // cache via stale-while-revalidate (see services/status.js).
    statusService.start(config);
  }
  // Every process writes its own server-error counts to the database once a
  // minute (services/server-error-counts.js), on an unref'd timer; a minute
  // with nothing answered sends nothing.
  require('./src/services/server-error-counts').start({ pool: getPool(config) });
  // And how busy it was each minute, with a warning when its event loop
  // stalls (services/process-health.js), on unref'd timers too.
  require('./src/services/process-health').start({ pool: getPool(config), role: ownRole });

  // ── The workflow's loops ─────────────────────────────────────────────
  // A conductor (any number of replicas) or an 'all' runs every machine's
  // pipeline slots, timers and work (services/process-role.js runsWorkflow);
  // nothing elects one of them. They start once this process listens
  // and its bus is up: the work they claim calls this process's own port
  // (the bot's platform tools, services/mayor/mcp-shim.js) and pushes over
  // the bus (ws.attach above). Fatal, like the runtime itself.
  if (processRole.runsWorkflow(ownRole)) {
    if (!server.listening) await once(server, 'listening');
    const workflow = require('./src/workflow/platform.ts');
    await workflow.startWorkflowLoops();
    // Its metrics, for the alerts (src/workflow/metrics.ts), on a port of
    // their own that no Service reaches; set by the chart on the conductor.
    const metricsPort = Number(process.env.WF_METRICS_PORT);
    if (Number.isInteger(metricsPort) && metricsPort > 0) {
      require('./src/workflow/metrics.ts').serveMetrics(metricsPort, () => workflow.workflowHealth(), log);
    }
  }

  // What each process does for itself (services/shots-gc.js's checkouts),
  // never on a staging preview (#1771: a throwaway clone runs no fleet
  // work). There is no leader: what one ran is workflow work or a clock
  // (src/workflow/), which every workflow process runs.
  if (runsClusterMaintenance()) startProcessDuties();

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
// `cleanup` + `__setShutdownTargets`
// (#767) let tests drive the graceful-shutdown sequence against a stubbed
// listener and pool without booting a server. Not used by any runtime caller.
module.exports = {
  // #4439: the assembled Express app, every middleware and route mounted in
  // order but not listening, so a test can drive the headers production
  // sends with a shell asset (tests/spec-frame-styles.test.js).
  app,
  // The boot itself: the two-process tests' workflow side runs it as a
  // conductor (tests/lib/workflow-child.js), so it is what production runs.
  start,
  adoptOrphanWorker,
  // #1378: the detached-turn resume itself, so tests can prove a stop that
  // lands on an ADOPTED turn terminalizes it as a stop instead of narrating
  // an interruption (or retrying it). Driving it through adoptOrphanWorker
  // would need the journal transport stood up; this is the same seam
  // finalizeRecoveredTurn already exposes one level down.
  resumeDetachedTurnInner: turnRecovery.resumeDetachedTurnInner,
  // ...and the handle factory it is driven with, so a test exercises the
  // real dual-channel `send` (WS broadcast + session bus, `_seq` and all)
  // rather than a hand-rolled stand-in that could drift from it.
  buildRecoveryStopHandle: turnRecovery.buildRecoveryStopHandle,
  finalizeRecoveredTurn: turnRecovery.finalizeRecoveredTurn,
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
  // `finishesWork` and `drainMs` stand in for a Kubernetes Pod's drain
  // (docs/plans/draining-releases.md).
  __setShutdownTargets: ({ server, pool, finishesWork, drainMs, successor } = {}) => {
    httpServer = server ?? null;
    shutdownPool = pool ?? null;
    cleanupStarted = false;
    shutdownOverrides = { finishesWork, drainMs, successor };
  },
};

// Graceful shutdown: mark drain state so new chats/app-creates/builds get
// 503'd, stop the workflow's loops, wait up to the drain deadline
// (shutdownDrainMs below) for in-flight HTTP handlers and registered
// background work to finish, then exit.
//
// What the drain waits for, and for how long:
//   - HTTP handlers still answering (src/middleware/inflight-requests.js,
//     less event streams and long polls) and the work registered in
//     services/inflight-work.js — a merge pass, a push send — up to
//     shutdownDrainMs(): DRAIN_TIMEOUT_MS under docker-compose, a minute by
//     default on Kubernetes, whose 90s grace period this used to leave almost
//     entirely unspent. Before this the drain asked about workers alone, so
//     on a pod with none busy it returned at once and the exit cut every
//     handler and every background pass mid-write.
//   - Busy workers and before & after shots runs, up to DRAIN_TIMEOUT_MS
//     only, wherever this runs: both are restart-safe (below), so waiting
//     out a turn buys nothing.
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
  // Only beside a successor that serves: with none (a scale to zero, every
  // replica restarting), the platform is going down, and its work items are
  // the next process's to carry on from their saved steps whenever one
  // starts. Holding this Pod for the long drain then only delays that.
  // Without one, the cutover it always had: a minute's drain.
  // Draining first, so a process stopping beside this one (a scale to zero,
  // a restart of every replica) never counts it as its successor.
  if (finishesWork) {
    await boundedStep(processes.markDraining(new Date(cleanupStartedAt + drainMs)), 1000)
      .catch((err) => log.warn('server', 'Could not mark this process draining', { err: err.message }));
  }
  const askSuccessor = shutdownOverrides?.successor ?? successorServing;
  if (finishesWork && !(await askSuccessor())) {
    finishesWork = false;
    drainMs = Math.min(drainMs, lifecycle.KUBERNETES_DRAIN_DEFAULT_MS);
    log.warn('server', 'No process that knows what this one holds is serving; cutting over without finishing the work', { drainMs });
  }
  // From SIGTERM, not from here: waiting for a successor spends the drain.
  const drainDeadline = cleanupStartedAt + drainMs;
  // (The Mayor's turns are workflow work: a draining process finishes those
  // it runs as it finishes any work, and leaves the rest to the next process
  // when the runtime stops, which carries each on from its turn's record.)
  // The bot's builds and the bench's trials under way here are durable
  // builds (services/build-runs.js). A process finishing its work only
  // quiesces the workflow runtime below, so each goes on here to its end,
  // its own steps included (a build's promote passes the drain guard:
  // lifecycle.js OWN_WORK, after 14 Oct 2026's refused first version), and
  // the drain waits for it (workflowWorkRunning). Stopping the runtime, at
  // once without a drain or at the drain's deadline, stops each at its next
  // step, its turn left running in its worker, and gives its work item up, so
  // the next workflow process carries it on from the step it saved.
  // The workflow runtime has its own pool; its running work reports nothing,
  // and gives its lease up so another process claims it at once.
  // A process finishing its work only quiesces it here (no slot, timer or
  // claim): the work it runs goes on until the drain ends.
  const stopWorkflowNow = () => require('./src/workflow/platform.ts').stopWorkflow()
    .catch((err) => log.warn('server', 'Stopping the workflow runtime failed', { err: err.message }));
  let workflowStop = finishesWork
    ? require('./src/workflow/platform.ts').quiesceWorkflow()
      .catch((err) => log.warn('server', 'Quiescing the workflow runtime failed', { err: err.message }))
    : stopWorkflowNow();
  // The push sender's drain, if this process runs it (the push-drain clock),
  // stops at its next pass; the sends under way are given the drain's time
  // and awaited before the pool closes.
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
  // Kubernetes has already taken it out of the Service, a request it still
  // answers finishes, and the work it still runs calls its own port (the
  // bot's platform tools, services/mayor/mcp-shim.js).
  if (!finishesWork) closeListener(drainMs);
  // Behind the listener close, deliberately: what the tabs fetch on hearing
  // this must not be able to land here. Awaited with the drain below.
  const announced = announceSuccessorBuild();
  require('./src/services/shots-gc').stopOwnCheckouts();

  // Finish what this process started, up to its drain deadline
  // (drainUntilIdle); only then cut what is left, as below.
  let handlerDrainMs = drainMs;
  if (finishesWork) {
    await drainUntilIdle({ deadline: drainDeadline, announced });
    closeListener(DRAIN_TIMEOUT_MS);
    await workflowStop;
    workflowStop = stopWorkflowNow();
    handlerDrainMs = DRAIN_TIMEOUT_MS;
  }

  // The handlers still answering and the background work still running
  // (a merge pass, whatever else registered with services/inflight-work.js),
  // up to this process's drain deadline. Started here and awaited after the
  // worker wait below, so the two run together.
  const startingRequests = inflightRequests.pending();
  const startingWork = inflightWork.snapshot();
  // Which requests, by route: a process stopped for a failed liveness probe
  // says here what it was answering.
  log.info('server', 'Draining in-flight requests and background work', {
    requests: startingRequests,
    ...(startingRequests ? { inflight: inflightRequests.snapshot().slice(0, 20) } : {}),
    background: startingWork.slice(0, 20),
    deadlineMs: drainMs,
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

  // The checks runs this process launched go on without it: their Jobs
  // belong to the cluster. Their rows still carry this process's heartbeat,
  // though, and the next process adopts a main check's run only once its
  // heartbeat has lapsed (main-watch.adoptRun), so hand them over
  // (check-runs.release) before this process's row goes below. Bounded like
  // the evidence write above. (A preview machine's run is its work
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
    log.info('server', 'Handed this process\'s checks runs to the next process on shutdown', {
      runs: released || 0, timedOut: released === null,
    });
  }

  // This process's row goes: it is not counted as live after it, rather than
  // until its heartbeat lapses (services/processes.js). Bounded like the
  // marks above.
  await boundedStep(processes.stop(), BUILD_SHUTDOWN_MARK_TIMEOUT_MS)
    .catch((err) => log.warn('server', 'Could not remove this process\'s row', { err: err.message }));

  // The minute of server responses still counting (services/server-error-
  // counts.js) is written before the pool closes, or it is lost with the
  // process. Bounded like the marks above; flush never throws.
  if (shutdownPool) {
    const serverErrorCounts = require('./src/services/server-error-counts');
    serverErrorCounts.stop();
    await boundedStep(serverErrorCounts.flush(shutdownPool, { all: true }), BUILD_SHUTDOWN_MARK_TIMEOUT_MS).catch(() => {});
    // The process's health up to now, with the minute still going.
    const processHealth = require('./src/services/process-health');
    processHealth.stop();
    await boundedStep(processHealth.flush(shutdownPool, { all: true }), BUILD_SHUTDOWN_MARK_TIMEOUT_MS).catch(() => {});
  }

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
        workflowStop.then(() => shutdownPool.end()),
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

// A draining process starts no new work, so it keeps small pools: two
// releases draining per role are budgeted at these sizes beside the serving
// ones (item 4, the connection budget; deploy/helm checks the sum).
function shrinkPoolsForDrain(workflowPlatform) {
  const shrink = (name, fn) => { try { return fn(); } catch (err) { log.warn('server', 'Could not shrink a pool for the drain', { pool: name, err: err.message }); return null; } };
  return {
    main: shrink('main', () => require('./src/db/pool').shrinkForDrain(config)),
    workflow: shrink('workflow', () => workflowPlatform.shrinkForDrain(config)),
    databaseOperations: shrink('db-manager', () => require('./src/services/db-manager').shrinkForDrain()),
    debug: shrink('debug', () => { require('./src/services/debug-access').closePool(); return 0; }),
  };
}

// Connections this draining process still holds above its drain sizes: the
// ones checked out when it shrank, until they are given back.
function retainedAboveDrain(workflowPlatform) {
  try {
    return require('./src/db/pool').drainExcess() + workflowPlatform.drainExcess()
      + require('./src/services/db-manager').drainExcess();
  } catch { return 0; }
}

// A release replaced this process: send its tabs to the new Pod, and finish
// what it holds (services/processes.js: its own, in memory), its background
// work (inflight-work.js), its workflow work and its requests still
// answering, until it is idle, the deadline passes, or too many newer
// processes are draining too (services/drain.js). Its loops stopped before
// this is called, and it refuses anything new (lifecycle.setShuttingDown).
async function drainUntilIdle({ deadline, announced }) {
  const workflowPlatform = require('./src/workflow/platform.ts');
  await announced;
  const closed = ws.closeAllForRelease();
  const pools = shrinkPoolsForDrain(workflowPlatform);
  // What it still holds above its drain sizes, at once and every second:
  // at none its capacity claim goes, and a process starting stops waiting on
  // it (processes.js waitForRoom).
  const report = () => processes.setAboveDrain(retainedAboveDrain(workflowPlatform));
  report();
  const reporting = setInterval(report, 1000);
  reporting.unref?.();
  const busy = () => ({
    holds: processes.localSnapshot(20),
    background: inflightWork.snapshot().slice(0, 20),
    workflowWork: workflowPlatform.workflowWorkRunning(),
    requests: inflightRequests.pending(),
    aboveDrainSizes: retainedAboveDrain(workflowPlatform),
  });
  log.info('server', 'Finishing this process\'s work before exiting', {
    sockets: closed, deadlineMs: Math.max(0, deadline - Date.now()), pools, ...busy(),
  });
  const maxDraining = drain.drainingMax();
  let why = null;
  const outcome = await drain.untilIdle({
    deadline,
    idle: () => processes.localCount() === 0 && inflightWork.size() === 0
      && workflowPlatform.workflowWorkRunning() === 0 && inflightRequests.pending() === 0,
    // Too many newer processes draining, or no successor serving any more
    // (it died: the platform is going down): hand the rest over now.
    superseded: async () => {
      // Still holding connections above its drain sizes when another
      // process of its role starts: the budget has room for one such
      // process per role, in the rollout's surge slot (processes.js
      // startedSinceDrain).
      if (retainedAboveDrain(workflowPlatform) > 0 && (await processes.startedSinceDrain()) > 0) { why = 'retained'; return true; }
      if ((await processes.newerDraining()) >= maxDraining) { why = 'crowded'; return true; }
      if ((await processes.servingOthers()) === 0) { why = 'alone'; return true; }
      return false;
    },
    describe: busy,
  });
  clearInterval(reporting);
  if (outcome.reason === 'idle') {
    log.info('server', 'Finished this process\'s work', { waitedMs: outcome.waitedMs });
  } else {
    const message = outcome.reason === 'deadline' ? 'Drain deadline passed; handing the rest of this process\'s work over'
      : why === 'alone' ? 'No successor is serving any more; handing the rest of this process\'s work over'
        : why === 'retained' ? 'A newer process started while this one still held connections above its drain sizes; handing its work over'
        : 'Newer processes are draining too; handing the rest of this one\'s work over';
    log.warn('server', message, { waitedMs: outcome.waitedMs, maxDraining, ...busy() });
  }
  return outcome;
}

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
