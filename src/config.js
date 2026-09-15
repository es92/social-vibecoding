const crypto = require('crypto');
const { bech32m } = require('bech32');
const platformJwt = require('./services/platform-jwt');
const { PRODUCTION_ORIGIN } = require('./services/cli-auth-constants');
const {
  DEFAULT_MARKETING_BASE_URL,
  normalizeBaseUrl,
} = require('./services/marketing-links');

const REQUIRED = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
];

// Key separation (retiring the shared JWT_SECRET). The platform now
// holds four independent keys instead of one secret doing five jobs:
//
//   DATA_ENCRYPTION_KEY     KDF input for AES-256-GCM at rest (BYOK keys,
//                           app secrets). Set to the EXACT value the old
//                           JWT_SECRET had — it is not a rotation, so no
//                           stored ciphertext has to be re-encrypted.
//   IFRAME_JWT_PRIVATE_KEY  RSA-2048 PKCS#8 PEM. Signs app-scoped user
//   IFRAME_JWT_PUBLIC_KEY   identities; only the PUBLIC half is ever put
//                           in a child container.
//   WORKER_JWT_SECRET       HMAC key for worker → internal-API tokens.
//   EDGE_JWT_SECRET         HMAC key for private-app edge grants and the
//                           scoped __usernode_access cookie.
//
// Required in production only. The platform also runs inside its own
// staging clone (self-hosted app row), where none of these are injected
// — see stagingDataKey() below.
const REQUIRED_PROD = [
  'DATA_ENCRYPTION_KEY',
  'IFRAME_JWT_PRIVATE_KEY',
  'IFRAME_JWT_PUBLIC_KEY',
  'WORKER_JWT_SECRET',
  'EDGE_JWT_SECRET',
];

// Canonical lifecycle deployment data. Kept separate from REQUIRED_PROD:
// that list is also the key-separation deny-list for child containers, while
// these values are operational configuration rather than host secrets as a
// class (only the partner key is private).
const REQUIRED_LIFECYCLE_PROD = [
  'NODE_RPC_URL',
  'TOPOCHAIN_PARTNER_API_KEY',
  'NATIVE_SESSION_V2_TESTNET_CHAIN_ID',
];

// HMAC keys below this are a self-hosting footgun, not a boot failure —
// say so loudly and honor the configured value.
const MIN_HMAC_BYTES = 32;

const IS_STAGING = () => process.env.USERNODE_ENV === 'staging';

// The platform's own staging clone runs platform code with no platform
// keys. It still needs A data key: migrate.js seeds an encrypted fixture
// so the self-app preview's "Environment variables" vote panel renders.
//
// This constant is deliberately committed, deterministic (stable across
// container restarts, so the fixture survives a rebuild) and visibly not
// a credential. Because it differs from production's key, prod
// ciphertext is structurally undecryptable in a preview — and the real
// DATA_ENCRYPTION_KEY is never placed in any child environment.
function stagingDataKey() {
  return crypto.createHash('sha256')
    .update('usernode-staging-data-key-not-for-prod')
    .digest('hex');
}

// The platform appears as one row in `apps` with self_hosted=TRUE
// (Phase 2f boot seed). These two values pin the row's identity:
//   - SELF_APP_SLUG     — the apps.slug column; subdomain prefix for
//                         any future staging clone of the platform.
//   - SELF_APP_DB_NAME  — the per-app database that backs it. Same
//                         convention as child apps (`app_<slug>` with
//                         non-alphanumerics replaced by `_`), derived
//                         once and frozen so docker-compose.yml and
//                         the seed agree.
//
// The hex suffix exists only to avoid colliding with a hypothetical
// child app whose user-chosen slug happens to be 'usernode'. It was
// generated once via `crypto.randomBytes(3).toString('hex')` and is
// committed to history; never read from env, never overridable.
//
// See SELF-HOSTING.md sub-step 2d for the rename procedure.
const SELF_APP_SLUG = 'usernode-2d5619';
const SELF_APP_DB_NAME = 'app_usernode_2d5619';

function mask(val) {
  if (!val) return '(not set)';
  if (val.length <= 8) return '****';
  return val.slice(0, 4) + '...' + val.slice(-4);
}

function canonicalCliOrigin(value, { allowLoopbackHttp = false } = {}) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '' && url.pathname !== '/') return null;
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(value) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

// Canonicalize the OpenRouter API base URL (review #2 / plan 4.1). Only an
// HTTPS origin (no credentials/query/fragment) is valid, with an optional
// path suffix (trailing slashes stripped). Insecure HTTP is permitted ONLY
// for loopback hosts when both local-dev conditions are true (USERNODE_LOCAL_DEV
// set AND OPENROUTER_ALLOW_INSECURE_BASE=true). Remote HTTP is always rejected.
// Returns null for anything invalid.
function canonicalOpenRouterApiBase(value, source) {
  if (typeof value !== 'string' || value.length === 0) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const allowLoopbackHttp = !!source
    && source.isLocalDev
    && source.allowInsecureBase === 'true';
  const secure = url.protocol === 'https:';
  const permittedLocalHttp = allowLoopbackHttp && loopback && url.protocol === 'http:';
  if (!secure && !permittedLocalHttp) return null;
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

// Protocol 2 is a closed deployment capability, not a caller-selectable
// network switch. Rust's canonical ChainId is a lower-case bech32m string
// with HRP `utc` and exactly 32 payload bytes (crates/core/src/chain_id.rs).
// Returning null lets the staging self-preview omit native infrastructure.
// Canonical deployments treat null as a boot error below: the chain identity
// is required protocol data, never an enable/disable switch.
// TODO(native-session-v3): authenticate network/genesis provenance. Protocol
// 2 treats this operator config as consistency only and keeps ordinary
// configured-origin HTTPS/TLS as the server-authenticity boundary.
function canonicalNativeSessionV2Network(value) {
  if (typeof value !== 'string' || !value || value !== value.toLowerCase()) return null;
  try {
    const decoded = bech32m.decode(value, 1023);
    const bytes = Buffer.from(bech32m.fromWords(decoded.words));
    if (decoded.prefix !== 'utc' || bytes.length !== 32) return null;
    if (bech32m.encode('utc', bech32m.toWords(bytes), 1023) !== value) return null;
    return { id: 'testnet', chainId: value };
  } catch {
    return null;
  }
}

function load() {
  const staging = IS_STAGING();
  const appRuntime = process.env.APP_RUNTIME || 'docker';

  // Migration shim: a .env written before key separation carries only
  // JWT_SECRET. Accept it as the data key (it IS the same value) rather
  // than refusing to boot, but name the successor loudly. This is a
  // rename of one env var, NOT a verification fallback — no token
  // authority reads it.
  if (!process.env.DATA_ENCRYPTION_KEY && process.env.JWT_SECRET && !staging) {
    console.log('[config] [warn] DATA_ENCRYPTION_KEY is unset — falling back to the legacy JWT_SECRET value. Rename it in .env; JWT_SECRET is no longer a signing key.');
    process.env.DATA_ENCRYPTION_KEY = process.env.JWT_SECRET;
  }

  const required = staging
    ? REQUIRED
    : REQUIRED.concat(REQUIRED_PROD, REQUIRED_LIFECYCLE_PROD);
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[config] Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Identity-backed credits are an operator-controlled rollout. Keeping
  // `legacy` as the default makes this migration deploy-safe: schema,
  // linking and UI can land before anyone loses their existing allowance.
  // An unknown value is a boot error rather than silently granting credits
  // under an unintended policy.
  const identityCreditPolicy = process.env.IDENTITY_CREDIT_POLICY || 'legacy';
  if (!['legacy', 'tiered'].includes(identityCreditPolicy)) {
    console.error('[config] IDENTITY_CREDIT_POLICY must be either legacy or tiered');
    process.exit(1);
  }

  // The platform's own staging clone is injected the production PUBLIC key
  // (so it can verify the parent's token) but no private one — yet it also
  // acts as a parent shell itself: every app view it renders fetches
  // /api/iframe-token for the embedded child. Without a signing key that
  // endpoint answers 503 and every framed route logs a console error,
  // failing the console-error baseline check. So a preview mints its own
  // ephemeral SIGNING pair and then runs the IDENTICAL sign/verify path as
  // production, trusting two issuers instead of one. Runs before anything
  // can sign. See the block comment above
  // platformJwt.generateStagingIframeKeyPair() for why this is not a shim,
  // and why it must not gate on the public half or write to process.env.
  let stagingKeys = { generated: false };
  if (staging) {
    try {
      stagingKeys = platformJwt.generateStagingIframeKeyPair();
    } catch (err) {
      // Never fatal: a preview that cannot self-sign is worse off than
      // one that 503s on app views, but it is still reviewable.
      console.log(`[config] [warn] could not self-sign an iframe key pair: ${err.message}`);
    }
  }

  const cliLocalMode = !staging && process.env.USERNODE_LOCAL_DEV === '1';

  // Canonical OpenRouter API base (review #2 / plan 4.2): resolve once here
  // and FAIL BOOT on an invalid explicit value, so no credential is ever
  // sent to a non-canonical endpoint. Remote HTTP is rejected even with the
  // insecure flag; loopback HTTP needs both local-dev conditions.
  const openrouterApiBase = canonicalOpenRouterApiBase(
    process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1',
    { isLocalDev: cliLocalMode, allowInsecureBase: process.env.OPENROUTER_ALLOW_INSECURE_BASE },
  );
  if (!openrouterApiBase) {
    console.error('[config] OPENROUTER_API_BASE must be an HTTPS URL without credentials, query parameters, or a fragment.');
    process.exit(1);
  }
  // #2119: a company-funded OpenRouter child key carries the user's platform
  // weekly allowance (services/limits.js), not a per-key amount from env, so
  // OPENROUTER_MANAGED_DAILY_LIMIT_USD is no longer read here. The deploy
  // still writes it; the value is inert.

  const nativeSessionV2Network = canonicalNativeSessionV2Network(
    process.env.NATIVE_SESSION_V2_TESTNET_CHAIN_ID
  );
  if (!staging && !nativeSessionV2Network) {
    console.error('[config] NATIVE_SESSION_V2_TESTNET_CHAIN_ID must be a canonical Rust ChainId.');
    process.exit(1);
  }
  const openrouterManagedRequireVerifiedIdentityValue =
    process.env.OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY || 'false';
  if (!['true', 'false'].includes(openrouterManagedRequireVerifiedIdentityValue)) {
    console.error('[config] OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY must be either true or false.');
    process.exit(1);
  }
  const openrouterManagedRequireVerifiedIdentity =
    openrouterManagedRequireVerifiedIdentityValue === 'true';
  let cliAuthOrigin = null;
  let cliAuthEnabled = !staging;
  if (cliAuthEnabled && cliLocalMode) {
    cliAuthOrigin = canonicalCliOrigin(
      process.env.CLI_CANONICAL_ORIGIN || `http://localhost:${process.env.PORT || '3000'}`,
      { allowLoopbackHttp: true }
    );
    if (cliAuthOrigin && !isLoopbackOrigin(cliAuthOrigin)) cliAuthOrigin = null;
  } else if (cliAuthEnabled) {
    cliAuthOrigin = canonicalCliOrigin(process.env.CLI_CANONICAL_ORIGIN);
    if (cliAuthOrigin !== PRODUCTION_ORIGIN) cliAuthOrigin = null;
  }
  if (cliAuthEnabled && !cliAuthOrigin) {
    console.error('[config] CLI authentication requires a valid CLI_CANONICAL_ORIGIN; production must use the compiled production origin');
    process.exit(1);
  }

  const config = {
    // Deployment environment tag (plan Global Constraints #6, topochain
    // mailer): drives ONE behavior today — src/services/topochain/
    // mailer.js logs the OTP code at dev/staging convenience only when
    // `env !== 'production'`. Not in REQUIRED: defaults to 'development'
    // so a bare checkout without NODE_ENV set behaves like local dev.
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    databaseUrl: process.env.DATABASE_URL,
    sessionSecret: process.env.SESSION_SECRET,
    cliAuthEnabled,
    cliAuthOrigin,
    cliAuthLocalMode: cliLocalMode,
    cliDeviceCreateRatePerMinute: parseInt(process.env.CLI_DEVICE_CREATE_RATE_PER_MINUTE || '10', 10),
    cliDeviceCreateBurst: parseInt(process.env.CLI_DEVICE_CREATE_BURST || '20', 10),
    cliDeviceLivePerIp: parseInt(process.env.CLI_DEVICE_LIVE_PER_IP || '10', 10),
    cliDeviceLiveGlobal: parseInt(process.env.CLI_DEVICE_LIVE_GLOBAL || '10000', 10),
    // Docker deployments trust only this resolved reverse-proxy peer for the
    // client address used by security gates and rate limits. Kubernetes uses
    // the Cilium ingress identity enforced by NetworkPolicy instead.
    trustedProxyHost: process.env.TRUSTED_PROXY_HOST
      || (!cliLocalMode && !staging && appRuntime === 'docker' ? 'caddy' : ''),
    adminUsername: process.env.ADMIN_USERNAME,
    adminPassword: process.env.ADMIN_PASSWORD,
    // KDF input for services/secrets.js (AES-256-GCM at rest). Never
    // injected into a child container, never used to sign anything.
    dataEncryptionKey: staging ? stagingDataKey() : process.env.DATA_ENCRYPTION_KEY,
    // Required protocol-2 deployment binding outside the self-app staging
    // preview. There is one supported network mapping and no caller input.
    nativeSessionV2Network,
    // Signing keys. Read straight from env by services/platform-jwt.js
    // at call time; mirrored here for the boot log and for the container
    // env builders that need the PUBLIC half.
    iframeJwtPublicKey: (process.env.IFRAME_JWT_PUBLIC_KEY || '').replace(/\\n/g, '\n'),
    workerJwtSecret: process.env.WORKER_JWT_SECRET || '',
    edgeJwtSecret: process.env.EDGE_JWT_SECRET || '',
    // OpenRouter + Codex backend. OpenRouter is the preferred backend once a
    // user has a usable key; Claude remains the safe fallback for accounts
    // that have not configured or claimed one.
    codexOpenrouterEnabled: String(process.env.CODEX_OPENROUTER_ENABLED || 'true') === 'true',
    // #717: collection-only emergency switch. Reporting remains readable so
    // operators can inspect already-recorded aggregates after disabling new
    // writes. This never changes provider/model/routing behaviour.
    llmTelemetryEnabled: String(process.env.LLM_TELEMETRY_ENABLED || 'true') === 'true',
    openrouterBetaUserIds: (process.env.CODEX_OPENROUTER_BETA_USER_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    openrouterDefaultCodexModel: process.env.OPENROUTER_DEFAULT_CODEX_MODEL || 'z-ai/glm-5.3-flash',
    // Curated badges in the model picker. Exact ids keep the recommendation
    // deliberate: adding a provider prefix here would label dozens of old,
    // batch, and specialist variants and make the badge meaningless.
    openrouterRecommendedModels: (() => {
      const configured = process.env.OPENROUTER_RECOMMENDED_MODELS === undefined
        ? [
          'deepseek/deepseek-v4.1-flash',
          'z-ai/glm-5.3-flash',
          'openai/gpt-6-astra',
          'moonshotai/kimi-k3',
          'anthropic/claude-opus-5',
        ].join(',')
        : String(process.env.OPENROUTER_RECOMMENDED_MODELS);
      if (configured.trim().toLowerCase() === 'none') return [];
      return configured.split(',').map((s) => s.trim()).filter(Boolean);
    })(),
    openrouterApiBase,
    openrouterAllowInsecureBase: String(process.env.OPENROUTER_ALLOW_INSECURE_BASE || 'false') === 'true',
    openrouterOrigin: process.env.OPENROUTER_ORIGIN || 'https://usernode.dev',
    // Management credentials stay in the platform process only. They create
    // and administer limited child keys; unlike child keys, a management key
    // cannot be used for model inference.
    openrouterManagementApiKey: process.env.OPENROUTER_MANAGEMENT_API_KEY || '',
    openrouterManagedWorkspaceId: process.env.OPENROUTER_MANAGED_WORKSPACE_ID || '',
    // Default-open claim policy. Operators may opt into requiring a linked
    // GitHub or X identity before the one lifetime managed key is reserved.
    openrouterManagedRequireVerifiedIdentity,
    // The former single shared JWT_SECRET is GONE. All four token
    // authorities (app identity RS256, worker, edge grant, edge cookie)
    // read their own key from env via services/platform-jwt.js, and a
    // token signed with the old shared value verifies nowhere. Child
    // containers still receive a JWT_SECRET env var, but it carries the
    // RSA PUBLIC key — see services/app-identity-env.js.
    githubAppId: process.env.GITHUB_APP_ID || '',
    githubPrivateKey: (process.env.GITHUB_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    // #555: Anthropic ADMIN API key (`sk-ant-admin…`) — a different
    // credential from the message key above, and used for exactly one
    // read: GET /v1/organizations/cost_report, which backs the drawer's
    // "Anthropic credits" row. Optional; unset degrades that row to an
    // estimate derived from the platform's own spend ledgers. Never
    // returned by any endpoint — see services/anthropic-credits.js.
    anthropicAdminKey: process.env.ANTHROPIC_ADMIN_KEY || '',
    // Waitlist social-connect OAuth apps (two-stage waitlist survey).
    // Plain OAuth apps — unrelated to the GitHub App above (which is the
    // repo-hosting integration). Optional: without credentials the
    // connect buttons for that provider degrade to plain text inputs on
    // the stage-2 form (src/routes/waitlist-connect.js).
    waitlistGithubClientId: process.env.WAITLIST_GITHUB_CLIENT_ID || '',
    waitlistGithubClientSecret: process.env.WAITLIST_GITHUB_CLIENT_SECRET || '',
    waitlistXClientId: process.env.WAITLIST_X_CLIENT_ID || '',
    waitlistXClientSecret: process.env.WAITLIST_X_CLIENT_SECRET || '',
    waitlistLinkedinClientId: process.env.WAITLIST_LINKEDIN_CLIENT_ID || '',
    waitlistLinkedinClientSecret: process.env.WAITLIST_LINKEDIN_CLIENT_SECRET || '',
    // "Follow along" targets for the stage-2 form. Profile addresses,
    // not credentials: they render a link and nothing more. Unset means
    // that network's link is not rendered, which is the only honest
    // default — see the platform_env descriptions for why a follow
    // through one of them cannot be verified.
    waitlistFollowXUrl: process.env.WAITLIST_FOLLOW_X_URL || '',
    waitlistFollowLinkedinUrl: process.env.WAITLIST_FOLLOW_LINKEDIN_URL || '',
    waitlistFollowInstagramUrl: process.env.WAITLIST_FOLLOW_INSTAGRAM_URL || '',
    // Optional shared secrets for partners who proxy waitlist signups
    // server-to-server, so their whole audience does not share one IP
    // budget. Comma-separated `label:secret` pairs; the label names the
    // caller in throttle logs and in its own rate-limit bucket. Unset
    // means the feature is off and every caller is anonymous — it must
    // never make the public join endpoint fail. See
    // src/services/waitlist-integrator.js.
    waitlistIntegrationKeys: process.env.WAITLIST_INTEGRATION_KEYS || '',
    // Account-linking OAuth is separate from the waitlist. GitHub requires
    // a dedicated OAuth app because an OAuth app has one callback URL. X can
    // reuse the waitlist client when its app has both callbacks registered.
    githubLinkClientId: process.env.GITHUB_LINK_CLIENT_ID || '',
    githubLinkClientSecret: process.env.GITHUB_LINK_CLIENT_SECRET || '',
    xLinkClientId: process.env.X_LINK_CLIENT_ID || '',
    xLinkClientSecret: process.env.X_LINK_CLIENT_SECRET || '',
    identityCreditPolicy,
    // Overrides the OAuth redirect_uri origin (staging); defaults to the
    // production origin in production, localhost in dev.
    waitlistOauthOrigin: process.env.WAITLIST_OAUTH_ORIGIN || '',
    // Origin of the public marketing site, which owns the /waitlist page a
    // shared invite link now lands on. Deliberately NOT the app's own
    // origin: the app renders #waitlist for people already inside the
    // shell, while a link pasted into a group chat should open the page
    // that explains what this is. Trailing slashes are stripped so the
    // builder can concatenate a path without doubling the separator.
    marketingBaseUrl: normalizeBaseUrl(
      process.env.MARKETING_BASE_URL,
      DEFAULT_MARKETING_BASE_URL
    ),
    logLevel: process.env.LOG_LEVEL || 'INFO',
    // Hard cap on non-errored apps per server. Protects against runaway
    // container / DB creation chewing through host resources. Admins bypass
    // the cap; errored rows don't count (they hold ~no resources and users
    // can delete them to free a slot). See src/routes/apps.js.
    maxApps: parseInt(process.env.MAX_APPS || '50', 10),
    // Concurrency caps on dev sessions. A "session" holds (or can lazily
    // spawn) a warm worker container + optional staging container, so
    // these bound host resource fan-out. Previously hardcoded literals in
    // src/routes/sessions.js; lifted here so prod can tune them via env
    // without a code deploy. See the scaling notes in README / SPEC.
    //   - maxGlobalSessions: platform-wide active+promoted coding-worker
    //     ceiling. Externally produced imported PRs own no worker and are
    //     excluded from it.
    //   - maxUserSessions:   per-user ceiling on 'active'-status sessions
    //     only (#193). Promoted sessions are exempt: they're un-pausable
    //     while their PR is up for a merge vote, so counting them would
    //     leave the user no way to free a slot by pausing.
    //   - maxUserPromotedSessions: per-user ceiling on concurrently
    //     promoted PRs, checked at promote time. Promoted sessions don't
    //     count toward maxUserSessions, so this is the bound that keeps
    //     one user from papering the vote panel (and holding N staging
    //     previews) with open PRs.
    //   - maxAdminUserSessions / maxAdminUserPromotedSessions: the same
    //     two per-user ceilings, RAISED for full platform admins only
    //     (gated on canAdminWrite — view-only admins and per-app admins
    //     stay on the base caps, matching the app-quota bypass in
    //     routes/apps.js). A raised cap, not a bypass: admins are still
    //     bounded, and maxGlobalSessions applies to everyone. Resolved
    //     per-requester by services/session-caps.js — never read these
    //     directly at a call site.
    maxGlobalSessions: parseInt(process.env.MAX_GLOBAL_SESSIONS || '25', 10),
    maxUserSessions: parseInt(process.env.MAX_USER_SESSIONS || '3', 10),
    maxUserPromotedSessions: parseInt(process.env.MAX_USER_PROMOTED_SESSIONS || '5', 10),
    maxAdminUserSessions: parseInt(process.env.MAX_ADMIN_USER_SESSIONS || '5', 10),
    maxAdminUserPromotedSessions: parseInt(process.env.MAX_ADMIN_USER_PROMOTED_SESSIONS || '8', 10),
    // Per-session worker container resource limits, passed to `docker run`
    // by src/services/worker.js. Defaults preserve historical behavior;
    // shrink them in prod to fit more concurrent warm workers on one box.
    workerMemory: process.env.WORKER_MEMORY || '2g',
    workerCpus: process.env.WORKER_CPUS || '2',
    // Runtime selection is explicit and intentionally defaults to the
    // existing single-server Docker implementation. Kubernetes never
    // silently falls back to Docker: an incomplete cluster configuration
    // fails the requested operation instead of mutating a different host.
    appRuntime,
    workerRuntime: process.env.WORKER_RUNTIME || appRuntime,
    captureRuntime: process.env.CAPTURE_RUNTIME || appRuntime,
    kubernetes: {
      platformNamespace: process.env.PLATFORM_NAMESPACE || 'social-platform',
      platformDeployment: process.env.PLATFORM_DEPLOYMENT || 'social-vibecoding',
      buildNamespace: process.env.BUILD_NAMESPACE || 'social-builds',
      successfulBuildRetentionHours: Number(process.env.KPACK_SUCCESS_RETENTION_HOURS || '48'),
      appNamespace: process.env.APP_NAMESPACE || 'social-apps',
      // Both identify the CNPG writer that hosts preview database clones.
      previewDatabaseNamespace: process.env.PREVIEW_DATABASE_NAMESPACE || '',
      previewDatabaseCluster: process.env.PREVIEW_DATABASE_CLUSTER || '',
      workerNamespace: process.env.WORKER_NAMESPACE || 'social-workers',
      buildServiceAccount: process.env.BUILD_SERVICE_ACCOUNT || 'social-kpack-builder',
      generatedAppServiceAccount: process.env.GENERATED_APP_SERVICE_ACCOUNT || 'social-generated-app',
      workerServiceAccount: process.env.WORKER_SERVICE_ACCOUNT || 'social-worker',
      repositoryPrefix: (process.env.REGISTRY_REPOSITORY_PREFIX || '').replace(/\/$/, ''),
      cacheRepositoryPrefix: (process.env.CACHE_REPOSITORY_PREFIX || '').replace(/\/$/, ''),
      builderImage: process.env.BUILDER_IMAGE || '',
      nodeVersion: process.env.BP_NODE_VERSION || '22.*',
      activeDeadlineSeconds: parseInt(process.env.ACTIVE_DEADLINE_SECONDS || '1800', 10),
      ingressClassName: process.env.INGRESS_CLASS_NAME || 'cilium',
      clusterIssuer: process.env.CLUSTER_ISSUER || 'letsencrypt-public',
      appTlsSecretName: process.env.APP_TLS_SECRET_NAME || 'social-apps-wildcard-tls',
      appDomain: process.env.USERNODE_APPS_DOMAIN || process.env.USERNODE_DOMAIN || 'apps.example.invalid',
      platformDomain: process.env.USERNODE_DOMAIN || 'apps.example.invalid',
      workerImage: process.env.KUBERNETES_WORKER_IMAGE || '',
      captureImage: process.env.KUBERNETES_CAPTURE_IMAGE || '',
      workerStorageClass: process.env.WORKER_STORAGE_CLASS || '',
      workerStorageSize: process.env.WORKER_STORAGE_SIZE || '5Gi',
      // Which builder produces app images (see services/kubernetes-buildkit.js
      // for the trade). `kpack`: every build is a kpack Build (today's
      // behaviour). `auto`: a source tree that carries one of the Dockerfile
      // candidates is built by a BuildKit Job, anything else by kpack.
      // `buildkit`: same, but a tree without a Dockerfile is a build error.
      buildEngine: process.env.BUILD_ENGINE || 'kpack',
      buildkitNamespace: process.env.BUILDKIT_NAMESPACE || 'social-buildkit',
      buildkitServiceAccount: process.env.BUILDKIT_SERVICE_ACCOUNT || 'social-buildkit-builder',
      // Immutable digest of the rootless BuildKit image the Job runs
      // (moby/buildkit:<version>-rootless@sha256:...).
      buildkitImage: process.env.BUILDKIT_IMAGE || '',
      // `rootless` (default): buildkitd under RootlessKit as uid 1000, no
      // capabilities, seccomp/AppArmor unconfined; needs the node to allow
      // unprivileged user namespaces (user.max_user_namespaces > 0).
      // `privileged`: buildkitd as root in a privileged container, no user
      // namespaces involved, for clusters that cannot enable them.
      buildkitMode: process.env.BUILDKIT_MODE || 'rootless',
      // Name of a kubernetes.io/dockerconfigjson Secret in the BuildKit
      // namespace with push credentials for the image and cache
      // repositories. Empty means the registry accepts anonymous pushes
      // (an in-cluster registry).
      buildkitRegistrySecret: process.env.BUILDKIT_REGISTRY_SECRET || '',
      // The image and cache registries speak plain HTTP (in-cluster, no TLS).
      buildkitInsecureRegistry: process.env.BUILDKIT_INSECURE_REGISTRY === '1',
      // Dockerfile candidates, in order of preference, relative to the source
      // root. The platform's own tree has both a compose-era `Dockerfile` and
      // the `Dockerfile.kubernetes` production recipe; previews should be the
      // production recipe.
      buildkitDockerfiles: (process.env.BUILDKIT_DOCKERFILES || 'Dockerfile.kubernetes,Dockerfile')
        .split(',').map((name) => name.trim()).filter(Boolean),
      buildkitSuccessRetentionHours: Number(process.env.BUILDKIT_SUCCESS_RETENTION_HOURS
        || process.env.KPACK_SUCCESS_RETENTION_HOURS || '48'),
    },
    // Postgres connection pool size (pg `Pool.max`). pg's built-in default
    // is 10, which can bottleneck under many concurrent SSE turns + staging
    // DB work. Tunable via env so prod can widen it without a code change.
    //
    // #1771: a STAGING PREVIEW gets its own, much smaller ceiling. Every
    // preview is a separate clone on the SAME Postgres server as production,
    // and that server's max_connections is the stock 100 — so the fleet, not
    // any one process, is what the budget has to fit. A preview serves one
    // reviewer and one capture run; capture drives 8 concurrent pages
    // (capture/capture.js `concurrency`), so 8 is the number of connections
    // it can actually use at once, and anything above that is a ceiling it
    // would only reach by holding connections it is not using.
    //
    // This is read from the preview's OWN env rather than injected by
    // services/staging-env.js on purpose: adding a key there moves the env
    // fingerprint, which marks all ~20 live previews stale and rebuilds the
    // fleet — twenty image builds and twenty database clones, which is the
    // very load this issue is about.
    dbPoolMax: IS_STAGING()
      ? parseInt(process.env.STAGING_DB_POOL_MAX || '8', 10)
      : parseInt(process.env.DB_POOL_MAX || '10', 10),
    // Session auto-pause: a DB-driven sweeper (server.js) flips idle
    // 'active' sessions to 'paused' so they stop counting against the
    // session caps. Now that pause is cheap (it no longer tears down
    // staging — see session-lifecycle.js) and activity is kept fresh by
    // the dev-chat heartbeat while the tab is open, this is tuned to
    // line up with the worker idle-eviction timescale (~5 min). A
    // session pauses ~5 min after the user actually leaves (tab closed/
    // backgrounded → no more heartbeats). Set to 0 to disable.
    sessionAutopauseIdleMs: parseInt(process.env.SESSION_AUTOPAUSE_IDLE_MS || String(5 * 60 * 1000), 10),
    // Staging preview GC: pause no longer tears staging down, so this
    // sweeper reclaims the staging container + cloned DB from sessions
    // that have gone cold for this long (promoted/merging sessions are
    // exempt — their preview backs group voting). Much longer than the
    // pause timer so reopening a recently-paused session keeps a warm
    // preview. Default 6h; set to 0 to disable staging GC.
    stagingIdleTeardownMs: parseInt(process.env.STAGING_IDLE_TEARDOWN_MS || String(6 * 60 * 60 * 1000), 10),
    // How often the session sweeper scans for idle sessions.
    sessionSweepIntervalMs: parseInt(process.env.SESSION_SWEEP_INTERVAL_MS || '60000', 10),
    // Production app-container watchdog (services/app-heal.js, #426):
    // sweeps every appHealIntervalMs for status='running' apps whose
    // `usernode-app-<slug>` container is stopped or missing and restarts
    // (or rebuilds) them automatically. 0 disables the sweep entirely.
    // appHealCooldownMs bounds retry churn per app — a persistently
    // failing heal (crash-loop on bad code, missing required secret)
    // isn't retried more often than this.
    appHealIntervalMs: parseInt(process.env.APP_HEAL_INTERVAL_MS || '60000', 10),
    appHealCooldownMs: parseInt(process.env.APP_HEAL_COOLDOWN_MS || String(10 * 60 * 1000), 10),
    // When a user at their session cap reopens/resumes a paused session,
    // auto-pause their least-recently-active session to make room instead
    // of refusing with a 429. Set SESSION_LRU_ON_RESUME=false to keep the
    // old hard-cap behavior.
    sessionLruOnResume: process.env.SESSION_LRU_ON_RESUME !== 'false',
    // Stale-promoted-PR policy. A PR proposed to the group ('promoted')
    // is otherwise sticky — it never auto-pauses and holds a cap slot
    // forever. This sweeper warns the author after prStaleNotifyMs of no
    // voting interest, then auto-archives prStaleGraceMs later if still
    // untouched. Set prStaleNotifyMs=0 to disable the whole policy.
    prStaleNotifyMs: parseInt(process.env.PR_STALE_NOTIFY_MS || String(7 * 24 * 60 * 60 * 1000), 10),
    prStaleGraceMs: parseInt(process.env.PR_STALE_GRACE_MS || String(3 * 24 * 60 * 60 * 1000), 10),
    // Reversible-archive retention. Archive keeps the CC volume + branch
    // so /unarchive can restore a session; this is how long before a hard
    // GC destroys the CC volume (memory). The row + branch survive, so
    // unarchive still works afterward but Claude starts fresh. Set to 0
    // to keep CC volumes forever (no hard GC).
    archivedRetentionMs: parseInt(process.env.ARCHIVED_RETENTION_MS || String(30 * 24 * 60 * 60 * 1000), 10),
    // How often the stale-PR / archived-GC sweeper runs. These actions
    // are day-scale, so it polls infrequently. Default 1h.
    staleSweepIntervalMs: parseInt(process.env.STALE_SWEEP_INTERVAL_MS || String(60 * 60 * 1000), 10),
    // The Workshop theme sweep (services/workshop-themes.js): re-checks every
    // app opened in the last week, re-drafting themes at most daily.
    workshopSweepIntervalMs: parseInt(process.env.WORKSHOP_THEMES_SWEEP_INTERVAL_MS || String(60 * 60 * 1000), 10),
    // #1010: how often the FAST governance-apply ticker runs. The hourly
    // sweeper above also applies window-elapsed governance proposals, but an
    // hour of dead air after a close proposal's countdown reaches zero is
    // exactly the "did my vote do anything?" confusion this ticker removes —
    // and it is what makes the client's derived "Closing issue…" spinner
    // honest rather than a promise nothing keeps. Deliberately gate-first and
    // DB-only (no GitHub traffic for rows that aren't ready), and on its own
    // knob so it can't be silently disabled along with the stale-PR sweeper.
    // Default 60s; set to 0 to disable (the hourly catch-all still runs).
    governanceApplyTickMs: parseInt(process.env.GOVERNANCE_APPLY_TICK_MS || String(60 * 1000), 10),
    // Demand-driven global-cap eviction. When a new session is needed but
    // the platform is at maxGlobalSessions, we pause the globally least-
    // recently-active session that has been idle longer than this grace
    // window (and isn't mid-turn), freeing a slot immediately instead of
    // making the new user wait for the slow 2h auto-pause. The grace
    // window protects anyone who's actually working — only sessions idle
    // past it are eligible. If nothing qualifies, the request 429s.
    // Default 15 min; set to 0 to disable pressure-eviction (back to a
    // hard 429 at the global cap).
    sessionPressureGraceMs: parseInt(process.env.SESSION_PRESSURE_GRACE_MS || String(15 * 60 * 1000), 10),
    usernodeAppPubkey: process.env.USERNODE_APP_PUBKEY || '',
    // Default points at the sidecar usernode container that
    // docker-compose.yml runs alongside the platform (service name
    // `usernode-node`). Production injects NODE_RPC_URL explicitly so
    // this default only matters for local dev and ad-hoc runs; pointing
    // it at the sidecar pattern (rather than a public host that may
    // come and go) keeps the failure mode obvious — "no node reachable
    // at <name>" is clearly a setup issue, not a transient outage.
    nodeRpcUrl: process.env.NODE_RPC_URL || (staging ? 'http://usernode-node:3000' : ''),
    // App file storage (#752): the MinIO object-store sidecar
    // (docker-compose service `usernode-minio`, internal
    // `usernode-storage` network — reachable only from the platform).
    // All three unset is a supported state: uploads return a clear
    // storage_unavailable error and everything else works, so local
    // dev / forks without the sidecar don't crash. Credentials ride
    // the .env file (same handling as USERNODE_DB_PASSWORD).
    storageEndpoint: process.env.MINIO_ENDPOINT || '',
    storageAccessKey: process.env.MINIO_ROOT_USER || '',
    storageSecretKey: process.env.MINIO_ROOT_PASSWORD || '',
    storageBucket: process.env.STORAGE_BUCKET || 'usernode-app-files',
    // GitHub URL of the platform's own repo. Read by feedback (file
    // issues here), the import-flow guard (refuse to import the self-
    // repo as a child app), and the self-app boot seed (Phase 2f).
    // Default targets the canonical Usernode-Labs repo; forks self-
    // hosting under their own org just need to override this in .env.
    platformRepoUrl: (
      process.env.USERNODE_PLATFORM_REPO
      || process.env.USERNODE_REPO_URL
      || 'https://github.com/Usernode-Labs/social-vibecoding'
    ).replace(/\/$/, ''),
    selfAppSlug: SELF_APP_SLUG,
    selfAppDbName: SELF_APP_DB_NAME,
    // The platform's own DNS name on the shared docker network. Child
    // apps run as `usernode-app-<slug>`, but the platform itself runs as
    // the blue-green pair usernode-blue/-green, BOTH carrying the
    // `usernode` network alias (docker-compose.yml) — so this default
    // resolves to whichever color(s) are up. The before/after capture
    // pipeline (services/visuals.js) needs this to shoot a real "before"
    // of the production platform for self-app sessions. Overridable for
    // forks whose compose names differ.
    selfAppContainer: process.env.SELF_APP_CONTAINER || 'usernode',
    // SELF-HOSTING.md Phase 4: in-app vote-to-merge for the self-
    // app. ON by default — all authenticated users can see the self-
    // app row, list its promoted PRs, and cast votes via the existing
    // PR voting UI. Set SELF_APP_PUBLIC_VOTING=false to restrict
    // visibility back to admins only. All the other self-hosting
    // protections (2g rebuild skip, 2h's unwritable credential keys,
    // 2i Mayor refuse-list, 2k import block) stay in place; this flag
    // is purely about audience. Note it also gates who may PROPOSE a
    // platform-variable change: the proposal rides the secrets panel,
    // and turning this off puts that panel back behind admin-only
    // visibility.
    selfAppPublicVoting: process.env.SELF_APP_PUBLIC_VOTING !== 'false',
    // Topochain partner and managed-policy API shared secret, compared
    // against X-API-Key (src/middleware/topochain-auth.js#partnerApiKey).
    // Canonical production requires it above; self-app staging may omit it
    // and receives the existing fail-closed 500 on authenticated routes.
    topochainPartnerApiKey: process.env.TOPOCHAIN_PARTNER_API_KEY || '',
    // Topochain ingest write gate: the shared secret compared against the
    // X-Ingest-Key header on POST /api/v4/slot-outcomes and /epoch-stats
    // (src/middleware/topochain-auth.js#ingestApiKey). The spec carried
    // "Auth: none" from v2, where these endpoints sat behind a network
    // boundary; here they are internet-reachable, so writes require this
    // key. Deliberately separate from TOPOCHAIN_PARTNER_API_KEY (the two
    // credentials rotate independently) and OPTIONAL like it — unset
    // doesn't block boot, it makes every ingest write 500 with "Ingest
    // key authentication not configured." The only known caller is the
    // observability-hub-receiver (usernode repo), configured with this
    // header at its v4 cutover.
    topochainIngestApiKey: process.env.TOPOCHAIN_INGEST_API_KEY || '',
    // Topochain zkPassport bridge (plan Task 10; SPEC §4.5 POST
    // /mobile/zkpassport/complete, lines 2092-2141): the external service
    // that actually verifies a zkPassport proof. Deliberately OPTIONAL and
    // NOT required — an unset URL doesn't block boot, it makes every
    // zkpassport/complete
    // call 500 "The zkPassport bridge is not configured." (SPEC's own
    // error table row for this exact condition) until an operator sets
    // TOPOCHAIN_ZK_BRIDGE_URL. See src/services/topochain/zk-bridge.js.
    topochainZkBridgeUrl: process.env.TOPOCHAIN_ZK_BRIDGE_URL || '',
    // Mobile activity push defaults off. PUSH_ENV is a trusted server
    // partition and is never accepted from a mobile request.
    mobilePushEnabled: process.env.MOBILE_PUSH_ENABLED === 'true',
    mobilePushEnvironment: process.env.PUSH_ENV || '',
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID || '',
    firebaseServiceAccountJsonB64: process.env.FIREBASE_SERVICE_ACCOUNT_JSON_B64 || '',
    // Platform outbound mail (login codes, waitlist confirmations,
    // waitlist release notices). src/services/mail/select.js picks the
    // transport once, here, from platform_env: Gmail API, a generic HTTP
    // mail API, or the log transport — and ALWAYS the log transport in a
    // staging preview, which is a clone of production data and must never
    // mail real people from an unvoted branch.
    //
    // `mailTransport` is null when nothing can send, which is what makes
    // the mailer's loud "NOT delivered" error fire instead of a boot
    // failure: every key below is OPTIONAL and NOT in REQUIRED, because a
    // deploy without mail configured must still come up.
    ...(() => {
      const chosen = require('./services/mail/select').chooseTransport(process.env);
      return {
        mailTransport: chosen.transport,
        mailProvider: chosen.provider,
        mailFrom: chosen.from,
        mailStagingLogOnly: chosen.stagingLogOnly,
        mailMaxPerHour: Number(process.env.PLATFORM_MAIL_MAX_PER_HOUR) || 0,
        // The original hook name. Kept as an alias so any caller (or test)
        // that still reads `config.topochainMailTransport` keeps working.
        topochainMailTransport: chosen.transport,
      };
    })(),
  };

  for (const [name, value] of [
    ['APP_RUNTIME', config.appRuntime],
    ['WORKER_RUNTIME', config.workerRuntime],
    ['CAPTURE_RUNTIME', config.captureRuntime],
  ]) {
    if (!['docker', 'kubernetes'].includes(value)) {
      console.error(`[config] ${name} must be either "docker" or "kubernetes" (received ${JSON.stringify(value)})`);
      process.exit(1);
    }
  }

  console.log('[config] Loaded:');
  console.log(`  NODE_ENV=${config.env}`);
  console.log(`  DATABASE_URL=${mask(config.databaseUrl)}`);
  console.log(`  DATA_ENCRYPTION_KEY=${mask(config.dataEncryptionKey)}${staging ? ' (staging constant — cannot decrypt production ciphertext)' : ''}`);
  console.log(`  WORKER_JWT_SECRET=${mask(config.workerJwtSecret)}`);
  console.log(`  EDGE_JWT_SECRET=${mask(config.edgeJwtSecret)}`);
  console.log(`  IFRAME_JWT_PUBLIC_KEY=${config.iframeJwtPublicKey ? `(set, ${config.iframeJwtPublicKey.length} bytes)` : '(not set)'}`);
  if (stagingKeys.generated) {
    // The clone keeps the injected public key for verifying the production
    // parent's tokens and signs its own with this pair — two issuers, both
    // fully pinned. See platformJwt.iframeVerifyKeys().
    console.log(`  IFRAME_JWT signing key=staging self-signed (RSA-${stagingKeys.bits}, ephemeral; verifies ${platformJwt.iframeVerifyKeys().length} keys)`);
  }
  // Short HMAC keys stay a warning, not an exit — a fork running a
  // 24-byte key should get a loud line, not a platform that won't start.
  for (const name of ['WORKER_JWT_SECRET', 'EDGE_JWT_SECRET']) {
    const val = process.env[name] || '';
    if (val && Buffer.byteLength(val) < MIN_HMAC_BYTES) {
      console.log(`  [warn] ${name} is ${Buffer.byteLength(val)} bytes — ${MIN_HMAC_BYTES} or more recommended (openssl rand -hex 32)`);
    }
  }
  // A mismatched RSA pair mints tokens no container can verify, and the
  // symptom is "every app login silently fails". Fail at boot instead.
  if (process.env.IFRAME_JWT_PRIVATE_KEY && process.env.IFRAME_JWT_PUBLIC_KEY) {
    try {
      const { bits } = platformJwt.assertIframeKeyPair();
      console.log(`  IFRAME_JWT key pair=ok (RSA-${bits}, RS256)`);
    } catch (err) {
      console.error(`[config] IFRAME_JWT key pair is unusable: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(`  GITHUB_APP_ID=${config.githubAppId || '(not set)'}`);
  console.log(`  ANTHROPIC_API_KEY=${mask(config.anthropicApiKey)}`);
  console.log(`  ANTHROPIC_ADMIN_KEY=${mask(config.anthropicAdminKey)}`);
  console.log(`  OPENROUTER_MANAGEMENT_API_KEY=${mask(config.openrouterManagementApiKey)}`);
  console.log(`  OPENROUTER_MANAGED_WORKSPACE_ID=${config.openrouterManagedWorkspaceId || '(default workspace)'}`);
  console.log(`  OPENROUTER_MANAGED_REQUIRE_VERIFIED_IDENTITY=${config.openrouterManagedRequireVerifiedIdentity}`);
  console.log(`  OPENROUTER_DEFAULT_CODEX_MODEL=${config.openrouterDefaultCodexModel}`);
  console.log(`  OPENROUTER_RECOMMENDED_MODELS=${config.openrouterRecommendedModels.join(',') || '(none)'}`);
  console.log(`  IDENTITY_CREDIT_POLICY=${config.identityCreditPolicy}`);
  console.log(`  GITHUB_LINK=${config.githubLinkClientId && config.githubLinkClientSecret ? '(enabled)' : '(disabled)'}`);
  console.log(`  X_LINK=${(config.xLinkClientId && config.xLinkClientSecret) || (config.waitlistXClientId && config.waitlistXClientSecret) ? '(enabled)' : '(disabled)'}`);
  console.log(`  WAITLIST_CONNECT=github:${config.waitlistGithubClientId && config.waitlistGithubClientSecret ? 'on' : 'off'} x:${config.waitlistXClientId && config.waitlistXClientSecret ? 'on' : 'off'} linkedin:${config.waitlistLinkedinClientId && config.waitlistLinkedinClientSecret ? 'on' : 'off'}`);
  console.log(`  WAITLIST_FOLLOW=x:${config.waitlistFollowXUrl ? 'set' : 'unset'} linkedin:${config.waitlistFollowLinkedinUrl ? 'set' : 'unset'} instagram:${config.waitlistFollowInstagramUrl ? 'set' : 'unset'}`);
  console.log(`  MARKETING_BASE_URL=${config.marketingBaseUrl}${process.env.MARKETING_BASE_URL ? '' : ' (default)'}`);
  console.log(`  WAITLIST_INTEGRATION_KEYS=${(() => { const n = require('./services/waitlist-integrator').parseIntegrationKeys(config.waitlistIntegrationKeys).length; return n ? `(${n} configured)` : '(not set)'; })()}`);
  console.log(`  LOG_LEVEL=${config.logLevel}`);
  console.log(`  CLI_AUTH=${config.cliAuthEnabled ? config.cliAuthOrigin : '(disabled in staging)'}`);
  console.log(`  MAX_APPS=${config.maxApps}`);
  console.log(`  MAX_GLOBAL_SESSIONS=${config.maxGlobalSessions}`);
  console.log(`  MAX_USER_SESSIONS=${config.maxUserSessions}`);
  console.log(`  MAX_USER_PROMOTED_SESSIONS=${config.maxUserPromotedSessions}`);
  console.log(`  MAX_ADMIN_USER_SESSIONS=${config.maxAdminUserSessions}`);
  console.log(`  MAX_ADMIN_USER_PROMOTED_SESSIONS=${config.maxAdminUserPromotedSessions}`);
  // An admin cap BELOW its base counterpart is almost certainly an
  // operator typo (it would make full admins worse off than regular
  // users). Honor the configured number literally — the boot log stays
  // the single source of truth — but say so loudly.
  if (config.maxAdminUserSessions < config.maxUserSessions) {
    console.log(`  [warn] MAX_ADMIN_USER_SESSIONS (${config.maxAdminUserSessions}) is below MAX_USER_SESSIONS (${config.maxUserSessions}) — admins get a LOWER session cap than regular users`);
  }
  if (config.maxAdminUserPromotedSessions < config.maxUserPromotedSessions) {
    console.log(`  [warn] MAX_ADMIN_USER_PROMOTED_SESSIONS (${config.maxAdminUserPromotedSessions}) is below MAX_USER_PROMOTED_SESSIONS (${config.maxUserPromotedSessions}) — admins get a LOWER proposal cap than regular users`);
  }
  console.log(`  WORKER_MEMORY=${config.workerMemory} WORKER_CPUS=${config.workerCpus}`);
  console.log(`  APP_RUNTIME=${config.appRuntime} WORKER_RUNTIME=${config.workerRuntime} CAPTURE_RUNTIME=${config.captureRuntime}`);
  console.log(`  DB_POOL_MAX=${config.dbPoolMax}`);
  console.log(`  SESSION_AUTOPAUSE_IDLE_MS=${config.sessionAutopauseIdleMs}${config.sessionAutopauseIdleMs === 0 ? ' (disabled)' : ''}`);
  console.log(`  STAGING_IDLE_TEARDOWN_MS=${config.stagingIdleTeardownMs}${config.stagingIdleTeardownMs === 0 ? ' (disabled)' : ''}`);
  console.log(`  SESSION_SWEEP_INTERVAL_MS=${config.sessionSweepIntervalMs}`);
  console.log(`  APP_HEAL_INTERVAL_MS=${config.appHealIntervalMs}${config.appHealIntervalMs === 0 ? ' (disabled)' : ''} APP_HEAL_COOLDOWN_MS=${config.appHealCooldownMs}`);
  console.log(`  SESSION_LRU_ON_RESUME=${config.sessionLruOnResume}`);
  console.log(`  SESSION_PRESSURE_GRACE_MS=${config.sessionPressureGraceMs}${config.sessionPressureGraceMs === 0 ? ' (disabled)' : ''}`);
  console.log(`  PR_STALE_NOTIFY_MS=${config.prStaleNotifyMs}${config.prStaleNotifyMs === 0 ? ' (disabled)' : ''} PR_STALE_GRACE_MS=${config.prStaleGraceMs}`);
  console.log(`  ARCHIVED_RETENTION_MS=${config.archivedRetentionMs}${config.archivedRetentionMs === 0 ? ' (keep forever)' : ''}`);
  console.log(`  USERNODE_APP_PUBKEY=${config.usernodeAppPubkey || '(not set — wallet linking disabled)'}`);
  console.log(`  NODE_RPC_URL=${config.nodeRpcUrl}`);
  console.log(`  USERNODE_PLATFORM_REPO=${config.platformRepoUrl}`);
  console.log(`  SELF_APP_SLUG=${config.selfAppSlug} (db=${config.selfAppDbName})`);
  console.log(`  SELF_APP_CONTAINER=${config.selfAppContainer}`);
  console.log(`  SELF_APP_PUBLIC_VOTING=${config.selfAppPublicVoting} (Phase 4: ${config.selfAppPublicVoting ? 'enabled — all users can see + vote on self-app PRs' : 'disabled — self-app is admin-only'})`);
  console.log(`  TOPOCHAIN_PARTNER_API_KEY=${config.topochainPartnerApiKey ? mask(config.topochainPartnerApiKey) : '(not set — partner API returns 500)'}`);
  console.log(`  TOPOCHAIN_INGEST_API_KEY=${config.topochainIngestApiKey ? mask(config.topochainIngestApiKey) : '(not set — ingest writes return 500)'}`);
  console.log(`  TOPOCHAIN_ZK_BRIDGE_URL=${config.topochainZkBridgeUrl || '(not set — zkpassport/complete returns 500)'}`);
  console.log(`  NATIVE_SESSION_PROTOCOL=${config.nativeSessionV2Network
    ? `testnet/${config.nativeSessionV2Network.chainId}`
    : 'unavailable in self-app staging'}`);
  console.log(`  MOBILE_PUSH=${config.mobilePushEnabled ? 'enabled' : 'disabled'} PUSH_ENV=${config.mobilePushEnvironment || '(not set)'}`);
  console.log(`  FIREBASE_PROJECT_ID=${config.firebaseProjectId || '(not set)'}`);
  console.log(`  FIREBASE_SERVICE_ACCOUNT=${config.firebaseServiceAccountJsonB64 ? '(set)' : '(not set)'}`);
  console.log(`  PLATFORM_MAIL=${config.mailTransport
    ? `${config.mailProvider}${config.mailStagingLogOnly ? ' (staging — rendered to the log, never delivered)' : ''} from=${config.mailFrom}`
    : '(no provider configured — OTP login codes and waitlist confirmations are NOT delivered)'}`);

  return config;
}

// #687 (PR-import): the imported-PR flow (candidates/preview/import routes,
// sync poller, exact-SHA merge) talks to the in-memory mock GitHub source
// (services/github-mock.js) in STAGING previews and the real github.js
// client everywhere else. Staging previews of the platform have no GitHub
// credentials (the GITHUB_* secrets are private and don't propagate), so
// the mock is what makes the import → head-change → merge-409 flow
// exercisable there — a sanctioned "suppress real outbound side effects at
// one boundary" swap: only the client selection differs, the surrounding
// code path is identical. Read directly from env so it's stable regardless
// of whether a caller holds the loaded config object.
function usesMockGithubForImports() {
  return process.env.USERNODE_ENV === 'staging';
}

// #1771: cluster maintenance is not a staging preview's job.
//
// server.becomeLeader() is where every fleet-wide duty lives — role
// bootstraps, container cleanup, backfills, the pollers, and nine sweepers.
// It is gated to ONE leader so the two blue-green colors never double-run
// it. A preview is neither color: it is a throwaway clone with its own
// database, so it wins its own advisory lock instantly and runs the whole
// suite against a copy of production's rows.
//
// It cannot do any of that work. A preview has no docker socket (no worker
// to evict, no container to reap), no GitHub credentials (services/
// github-mock.js stands in), and no fleet. What it does have is a timer
// pool that queries every few seconds forever, which is why previews last
// touched a week ago were measured holding six warm Postgres connections
// each — twenty of them, on a server whose max_connections is 100. The pool
// never sheds them because idleTimeoutMillis only fires on a connection
// nobody reuses, and the sweepers keep reusing them.
//
// So a preview does not stand for election at all. Everything a reviewer
// or a declared check touches is request-driven and unaffected; the
// leader-scoped extras (the prod-debug SQL role) already degrade to a clean
// 503, which is the same thing a follower color does during a rollout.
//
// The escape hatch is for a preview that is deliberately reviewing a change
// TO this machinery.
function runsClusterMaintenance() {
  if (process.env.USERNODE_ENV !== 'staging') return true;
  return process.env.STAGING_CLUSTER_MAINTENANCE === '1';
}

module.exports = {
  load,
  usesMockGithubForImports,
  runsClusterMaintenance,
  canonicalCliOrigin,
  canonicalOpenRouterApiBase,
  canonicalNativeSessionV2Network,
  isLoopbackOrigin,
};
