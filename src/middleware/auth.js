const { readSessionCookie, setSessionCookie } = require('../services/browser-session-cookies');
const { nativeWebSessionIsLive } = require('../services/web-session-auth');
const { bindStreamSession } = require('../services/http-stream-access');
const { setSessionCacheCookie, stampApiIdentity } = require('../services/browser-api-cache');
const crypto = require('crypto');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { classifyUserAgent } = require('../services/linked-browsers');
const platformJwt = require('../services/platform-jwt');

const PUBLIC_PATHS = [
  // Legacy standalone auth pages, now tiny redirect stubs into the SPA's
  // hash routes (#landing/#login/#signup/#register/#waiting) so old
  // bookmarks, share links, and SW-cached copies keep working. The SPA
  // shell itself ('/') is NOT listed here — it must flow through the
  // middleware (staging iframe-JWT minting rides on '/?token=…'); an
  // anonymous '/' is served by redirectOrReject falling through to
  // static instead of redirecting.
  '/login.html',
  '/register.html',
  '/landing.html',
  '/waiting.html',
  '/api/auth/login',
  '/api/auth/register',
  // Email-code signup uses an HttpOnly continuation and creates the ordinary
  // web session only after password setup; all three steps are pre-login.
  '/api/auth/otp/',
  // The waitlist release mail one-time sign-in link (#4594,
  // services/release-links.js) stands in for that code and is pre-login by
  // the same definition: the page that spends it is signed out, and the link
  // is the only credential. Missing here, every signed-out visitor got 401
  // and the sign-in sheet fell back to emailing a code.
  '/api/auth/release-link',
  '/api/auth/wallet-check',
  '/api/auth/wallet-verify',
  // Self-service wallet password reset is pre-login by definition — the
  // wallet signature is the only credential (issue #282).
  '/api/auth/wallet-reset-verify',
  // Email password reset is pre-login by definition — the emailed magic
  // link is the only credential. Request mints it, confirm redeems it;
  // both are anti-enumeration (see src/routes/auth.js).
  '/api/auth/password-reset/request',
  '/api/auth/password-reset/confirm',
  '/api/auth/wallet-register',
  '/api/auth/wallet-link-login',
  // Apple and Google sign-in (src/routes/sign-in-providers.js): the start,
  // the provider callback and the username step, all pre-login by
  // definition. Each is bound to the browser that started it by its own
  // HttpOnly cookie.
  '/api/auth/oauth/',
  // Phone sign-in and sign-up (src/routes/phone-auth.js): request, verify,
  // the username step and the reCAPTCHA site key, pre-login by definition.
  // The router mounts after this middleware, so without this a signed-out
  // visitor got 401 before its own not_offered gate could answer.
  '/api/auth/phone/',
  // Read-only kudos leaderboard (Top PRs / Top users). Public so the
  // board can be linked/embedded without a session; no private data is
  // exposed (usernames + public PR titles + aggregate counts only).
  '/api/leaderboard/',
  // Read-only public apps + contributors API (src/routes/public-api.js).
  // Public so outside integrations can list the platform's view-public
  // apps and who built them without an account; view-private apps and the
  // self-app are never surfaced. Same privacy tier as the leaderboard.
  '/api/public/',
  // The content-free reports of a page nobody is signed in to (#6002,
  // routes/ui-telemetry.js): the reads the session guard cut off and where
  // an invite page landed. The page sends no cookie, so no session is read.
  '/api/ui-telemetry/anonymous',
  // Waitlist social-connect OAuth round-trip (two-stage waitlist
  // survey). Pre-login by definition — waitlist signers have no account;
  // the unguessable more_token in the OAuth state is the capability.
  '/waitlist/connect/',
  '/health',
  '/css/',
  '/js/',
  // The React shell bundle (public/shell/assets/shell.js). Same public tier
  // as /css/ and /js/, and public for exactly the reason spelled out under
  // /vendor/ below: index.html loads it from its head on EVERY load,
  // including the anonymous landing/login screens, so an anonymous request
  // that redirected to the shell would answer a module script request with an
  // HTML body. The browser rejects that on MIME type, React never hydrates,
  // and the service-worker precache fills with redirects. Static JS only, no
  // data access.
  '/shell/',
  // Language packs for the shell itself (scripts/language-packs.js): static
  // UI text, needed on the sign-in screens too. No data access.
  '/locales/',
  // Build-scoped shell assets (/b/<build sha>/js/app.js and so on): the same
  // files as /js/, /css/, /vendor/ and /shell/ above, addressed per build so
  // a deploy can serve them immutable (src/services/static-cache.js). Public
  // for the same reason as every entry above it: a deployed document loads
  // ALL of its scripts this way, on the anonymous screens too. Static assets
  // only, no data access.
  '/b/',
  // Vendored third-party browser libs (public/vendor/ — marked, DOMPurify,
  // qrcodejs). Same public tier as /css/ and /js/, and public for the same
  // reason: index.html loads them from its <head> on EVERY load including
  // the anonymous landing/login screens, so a redirect-to-root HTML body
  // here would arrive where a script was expected (leaving marked /
  // DOMPurify / QRCode undefined) and would poison the service worker
  // precache with redirects. Static assets only, no data access.
  // NB: keep single quotes out of comments in this array — tests parse
  // every quoted string here as a public prefix (see history.test.js).
  '/vendor/',
  // Self-hosted typefaces (public/fonts, provenance beside each), the same
  // static-only tier as /vendor/: the brand look (one of the experimental
  // looks) draws every screen in Geist, the signed-out ones included.
  '/fonts/',
  '/usernode-bridge.js',
  '/usernode-bridge/',
  // Native-feel UI kit (public/usernode-native/v1/) — centrally hosted for
  // child apps exactly like the bridge, so it must be fetchable anonymously
  // from any dapp origin. Static CSS/JS + demo page only, no data access.
  '/usernode-native/',
  // Pinned Tailwind browser runtime (public/usernode-tailwind/v1/) —
  // centrally hosted for child apps on the same terms as the bridge and the
  // native kit. Every app that swaps off cdn.tailwindcss.com loads this from
  // its own subdomain with no platform session, and a redirect-to-root HTML
  // body would arrive where a script was expected, leaving the whole app
  // unstyled. Static JS only, no data access.
  '/usernode-tailwind/',
  // PWA shell assets (#487). The service-worker script, manifest and
  // icons must be fetchable without a session: the browser requests them
  // from login.html (pre-auth) and during background SW update checks,
  // and a 302-to-login HTML body would fail registration/install. Static
  // branding assets only — same public tier as /css/ and /js/.
  '/sw.js',
  '/manifest.webmanifest',
  '/icons/',
  // The two icons browsers, crawlers and link previews look for at the root
  // by convention, whatever the page links; without these they got a 302 to
  // the root. Whole file names, so the prefix match opens nothing else there.
  '/favicon.ico',
  '/apple-touch-icon.png',
  // What a search engine reads first at the root (routes/project-preview.js):
  // the crawl rules and the sitemap of public project pages. A crawler has no
  // session, and the gate answered both with a 302 to the root. Whole file
  // names again; both list only what the public directory already shows.
  '/robots.txt',
  '/sitemap.xml',
  // A public project inside a post on X (routes/project-preview.js,
  // services/project-embed.js). The page is a frame on x.com, where nobody
  // carries a Homeroom session, so it is the guest view for everybody; the
  // route answers every path under it, and shows only what the public
  // directory already shows anybody. (No apostrophes in this list: tests
  // read its entries as the quoted strings in it.)
  '/embed/',
  // Challenge artwork (public/illustrations/challenges/). The challenge list
  // it decorates is public (/api/v4/), so the pictures must be too: an image
  // request answered with a redirect body draws a broken picture instead of
  // the card fallback. Same public tier as /icons/ above. Static SVG files
  // only, no data access.
  '/illustrations/',
  // The brand assets the signed-out screens draw (public/brand/). The landing
  // is the screen a stranger with no session meets, so its illustration has to
  // be readable by exactly the tier that cannot get past the gate — and the
  // gate answers an image request with a 302 to the root, which draws a broken
  // picture rather than nothing. Caught on staging, where the landing rendered
  // correctly around an empty box. Static image files only, no data access;
  // same public tier as /icons/ and /illustrations/ above.
  '/brand/',
  // Uploaded challenge artwork (routes/topochain/challenge-illustrations.js),
  // public for the same reason as the directory above: it decorates the same
  // public challenge cards. The route mounts BEFORE this middleware, so this
  // entry is belt-and-braces like the report share entry below. Access control
  // is the unguessable 32-hex id, and the bytes are served under a sandbox CSP.
  '/challenge-illustrations/',
  // Images in admin-edited email templates (routes/email-images.js). A mail
  // client loads them with no session; the route mounts BEFORE this
  // middleware, so this entry is belt-and-braces. Access control is the
  // unguessable 32-hex id, and the bytes are served under a sandbox CSP.
  '/email-images/',
  // Public report share links (routes/report-snapshots.js). The route is
  // mounted BEFORE this middleware in server.js, so requests normally
  // never get here — this entry is belt-and-braces so the public contract
  // (the unguessable 32-hex token is the only access control) survives a
  // mount reorder instead of silently becoming a redirect-to-login. An
  // unmatched /reports/ path just falls through to static handling and
  // 404s; no data is reachable without a valid token.
  '/reports/',
];

// ── Platform-access gate (onboarding flow alignment) ─────────────────────
// A session is no longer the whole story: `users.has_platform_access`
// gates the SV platform surfaces (SPA home / social / build). Accounts
// without it (new signups that haven't been released off the waitlist)
// keep a small allowlist and get the waiting room instead of the SPA.
//
// What deliberately stays OPEN to a no-access session:
//   - the SPA shell ('/' + '/index.html') — the waiting room is an
//     in-SPA screen now (auth-screens.js); the client routes a gated
//     session to #waiting and the API 403 below remains the actual
//     security boundary. (/css/, /js/, icons etc. are PUBLIC_PATHS and
//     never reach this gate.)
//   - /api/auth/ — me / logout / change-password: account basics.
//   - /api/iframe-token — login-required CHILD APPS are usable by any
//     account per the onboarding doc's ladder ("uses login-required
//     apps" is a member ability, platform access is not required); app
//     subdomain traffic doesn't pass through this middleware at all
//     (Caddy forward_auth → src/routes/internal.js).
//   - /challenges-api/* and the v4 mobile API are mounted BEFORE this
//     middleware in server.js, so terms review/consent and the mobile
//     bearer-token surface are unaffected by the gate.
// Admins always bypass (belt-and-braces — they're also grandfathered).
const GATE_OPEN_PATHS = [
  // ('/waiting.html' is a PUBLIC_PATHS redirect stub now and never
  // reaches this gate.)
  '/api/auth/',
  '/api/iframe-token',
  // The app-host authorize hop (services/edge-gate.js): opening an app at
  // its own address signs the person in there, and an account without
  // platform access can use login-required apps (the entry above, for the
  // same reason).
  '/__access/authorize',
  // Following an invite link from the waiting room queues its community
  // for the day the account is let in (services/community-invites.js).
  // Only the by-token reads and redeem, and the queued list the waiting
  // room shows and its join (/api/invite-links/queued/join): making and
  // managing links stays behind the gate.
  '/api/invite-links/by-token/',
  '/api/invite-links/queued',
  // An account just made from the signed-out story records that it
  // started there (routes/onboarding.js), before it is let in, so the day
  // it is let in it is asked what to make rather than which communities to
  // join. It writes only that record, on the caller's own account, and
  // answers nothing: the question is asked once they are let in.
  '/api/me/first-session/started',
];

// Documents owned by the platform SPA. Clean app URLs deliberately live in
// the pathname (`/app/<slug>...`) rather than the fragment, so they must reach
// index.html with or without a session. API access remains authenticated by
// the routes themselves; this only lets the browser boot the same shell `/`
// already serves. Keep this narrower than the catch-all so an unrelated typo
// retains the existing redirect-to-root behaviour.
// An invite link (`/invite/<token>`, routes/community-invites.js) is one
// too: a visitor with no account is exactly who it is for. Any one segment
// after /invite/, not only a token's shape (#5263): a link cut short or
// mistyped opens the page that says it does not work, instead of bouncing
// to `/` and the plain landing. The route answers every such path the way
// it answers an unknown token, so this discloses nothing.
// `/communities` is the signed-out page about private communities
// (frontend/src/features/guest/guest-communities.tsx): a link sent to
// somebody who runs a group, who has no account yet.
function isSpaDocumentPath(pathname) {
  return pathname === '/' || pathname === '/index.html'
    || pathname === '/communities'
    || /^\/app\/[a-z0-9][a-z0-9-]{0,254}(?:\/.*)?$/.test(pathname)
    || /^\/invite\/[^/]+$/.test(pathname)
    // An admin's invite link to Homeroom (routes/access-links.js), opened
    // signed out or by an account still waiting: who it is for.
    || /^\/welcome\/[^/]+$/.test(pathname);
}

/**
 * A PRIVATE MEMBER (users.private_member_since in schema.sql): an invite
 * link let them into its community before they were let in. The gate lets
 * them through like an account with access: they use their communities'
 * apps, hubs, chats and Homeroom bot. What they may not do yet is make apps
 * of their own, and that is the app allowance's refusal (services/app-
 * allowance.js), not the gate's. Letting them in ends the tier by itself.
 */
function isPrivateMember(row) {
  return !!row && !row.has_platform_access && !row.is_admin && row.private_member_since != null;
}

// Returns true when it handled the response (caller must return).
function enforcePlatformAccessGate(req, res, user) {
  if (user.hasPlatformAccess || user.isAdmin || user.privateMember) return false;
  if (GATE_OPEN_PATHS.some((p) => req.path.startsWith(p))) return false;
  if (req.path.startsWith('/api/')) {
    res.status(403).json({
      error: 'Your account does not have platform access yet.',
      code: 'platform_access_required',
    });
    return true;
  }
  // The SPA shell serves for a gated session; app.js routes it to the
  // in-SPA waiting room (#waiting). Any other navigation bounces to the
  // shell for the same client-side routing.
  if (isSpaDocumentPath(req.path)) return false;
  res.redirect('/');
  return true;
}

// SELF-HOSTING.md "Self-staging — iframe-auth login flow":
// In a staging container spawned for the self-app (USERNODE_ENV === 'staging'),
// the cloned users table has every prod row but with `password` scrubbed to
// a per-row-unique `__staging_redacted__...` placeholder by
// db-manager.scrubPrivateColumns — so no cloned account can authenticate
// against /api/auth/login. Rather than
// copying password hashes across the prod/staging boundary, we accept the same
// platform-issued JWT every child app already verifies (see app-conventions.md
// "Auth — iframe token injection") and exchange it for a real session row on
// first hit. The trust chain is: parent prod admin authenticates via cookie →
// parent mints a 1h RS256 app-identity JWT via /api/iframe-token →
// app-view.js sets `iframe.src = stagingUrl + '?token=' + jwt` → this
// middleware verifies + mints a local session cookie. Subsequent fetches
// inside the iframe use the cookie like any prod request. That cookie is
// partitioned (SameSite=None; Secure; Partitioned) so the cross-site frame a
// preview is shown in keeps it (browser-session-cookies.js, "A preview of
// Homeroom, in a frame on another site").
//
// Gated entirely on USERNODE_ENV === 'staging'. Production never reads the
// query token, so a stolen iframe-token can't be replayed against prod (it's
// a downgraded credential that only works against staging clones).
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const STAGING_SESSION_DAYS = 7;

// The app row this container is serving, injected by the env builders via
// services/app-identity-env.js. Iframe identity tokens are app-scoped
// (audience `usernode:app:<id>`) since the RSA cutover, so verifying one
// requires knowing which app we are. Absent → every token below fails
// closed (verifyAppIdentityToken rejects a non-integer appId), which is
// the right default: a staging container with no app identity cannot
// safely accept an identity minted for some other app.
const SELF_APP_ID = process.env.USERNODE_APP_ID;

// Browser sessions now follow the mobile session's active-lease model: a
// device that keeps using Homeroom stays signed in, while an abandoned device
// eventually falls out. Mobile renews its 90-day lease when 89 days remain,
// which coalesces activity to at most one write per day; use the same cadence
// here so the two surfaces do not surprise the same person differently.
//
// The fixed cap is the extra browser-cookie safety boundary. A bearer cookie
// that is continuously replayed must still require reauthentication
// eventually, even though ordinary active use slides the idle lease.
const SESSION_IDLE_DAYS = 90;
const SESSION_MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_RENEW_BEFORE_MS = (SESSION_IDLE_DAYS - 1) * DAY_MS;

/**
 * Extend a live browser session's idle lease, without moving it beyond the
 * absolute cap measured from `created_at`.
 *
 * Renewal is best-effort. The request has already authenticated by the time
 * this runs, so a failure to extend must not turn it into an error. The helper
 * is still awaited by the middleware: response cookies have to be written
 * before a downstream handler sends the headers.
 */
async function renewCookieSession(pool, res, token, row) {
  try {
    const now = Date.now();
    const currentExpiry = new Date(row.expires_at).getTime();
    if (!Number.isFinite(currentExpiry)
        || currentExpiry - now > SESSION_RENEW_BEFORE_MS) {
      return null;
    }

    // `created_at` is non-null after the schema migration. If a malformed row
    // somehow lacks it, fail closed on renewal and keep the existing expiry;
    // extending without a trustworthy cap anchor would make the cap cosmetic.
    const parsedCreatedAt = new Date(row.created_at).getTime();
    if (!Number.isFinite(parsedCreatedAt)) return null;
    const createdAt = parsedCreatedAt;
    const ceiling = createdAt + SESSION_MAX_DAYS * DAY_MS;
    const wanted = now + SESSION_IDLE_DAYS * DAY_MS;
    const nextExpiry = Math.min(wanted, ceiling);
    if (nextExpiry <= currentExpiry) return null;

    const expiresAt = new Date(nextExpiry);
    const { rows } = await pool.query(
      `UPDATE sessions
          SET expires_at = $1
        WHERE token = $2 AND expires_at = $3 AND expires_at > NOW()
        RETURNING expires_at`,
      [expiresAt, token, row.expires_at]
    );
    // Logout, revocation, or another request may have changed/deleted the row
    // after authentication. Never issue a cookie unless this exact lease was
    // the one successfully advanced.
    if (rows.length !== 1) return null;

    const persistedExpiry = new Date(rows[0].expires_at);
    setSessionCookie(res, token, persistedExpiry);
    setSessionCacheCookie(res, token, persistedExpiry);
    return persistedExpiry;
  } catch (err) {
    log.warn('auth', 'Session renewal failed', { message: err.message });
    return null;
  }
}

// #5974: Settings › Linked devices says when each browser was last used.
// `sessions.last_seen_at` is written at most once per 15 minutes per
// session: a request whose row was stamped more recently writes nothing, and
// the UPDATE repeats the window so two requests racing on a stale row cost
// one write. Never awaited: the request has authenticated by now, and the
// date is a convenience the response must not wait for or fail on.
const SESSION_SEEN_THROTTLE_MS = 15 * 60 * 1000;

function touchSessionLastSeen(pool, token, row) {
  const seen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : NaN;
  if (Number.isFinite(seen) && Date.now() - seen < SESSION_SEEN_THROTTLE_MS) return;
  Promise.resolve()
    .then(() => pool.query(
      `UPDATE sessions
          SET last_seen_at = NOW()
        WHERE token = $1
          AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '15 minutes')`,
      [token]
    ))
    .catch((err) => log.warn('auth', 'Session last-seen update failed', { message: err.message }));
}

function authMiddleware(config) {
  const pool = getPool(config);

  return async (req, res, next) => {
    if (req.cliAuthenticated && req.user) return next();
    if (PUBLIC_PATHS.some((p) => req.path.startsWith(p))) {
      return next();
    }

    const cookieToken = readSessionCookie(req);

    // Cookie path — identical in prod and staging once a session exists.
    if (cookieToken) {
      try {
        const { rows } = await pool.query(
          `SELECT s.user_id, s.expires_at, s.created_at, s.last_seen_at, u.username, u.is_admin, u.admin_readonly, u.app_quota, u.review_flow_enabled, u.private_member_since, u.locale, u.timezone, u.has_platform_access, u.is_synthetic,
             ${nativeWebSessionIsLive('s')} AS native_session_valid
           FROM sessions s JOIN users u ON s.user_id = u.id
           WHERE s.token = $1`,
          [cookieToken]
        );

        // A synthetic user (demo mode's partner, routes/demo-mode.js) never
        // has a live session: it cannot sign in, and a session row that
        // named it anyway reads as no session at all.
        if (rows.length > 0 && rows[0].native_session_valid !== false
            && !rows[0].is_synthetic
            && new Date(rows[0].expires_at) >= new Date()) {
          // Staging identity switch: a request that carries a VALID iframe
          // JWT for a DIFFERENT user than the cookie session re-mints as
          // the token's user (replacing the cookie) instead of silently
          // keeping the old identity. The parent shell is the token
          // authority — when it hands the preview a fresh token (user
          // switched accounts, or the proposal-checks runner navigating as
          // the view-only admin after the screenshot pass minted a
          // non-admin cookie), the token must win. Cookie-first-always is
          // what downgraded the checks suite's admin token to the
          // screenshot identity and gated every admin-only assertion.
          // Same-user tokens and invalid/foreign tokens keep the existing
          // session untouched; prod never reads tokens at all.
          if (IS_STAGING) {
            const qTok = typeof req.query?.token === 'string' ? req.query.token : null;
            const hTok = req.headers['x-usernode-token'];
            const switchTok = qTok || (typeof hTok === 'string' ? hTok : null);
            if (switchTok) {
              let tokenUserId = null;
              // App-identity (RS256) is the ONLY accepted shape. There is
              // no legacy branch here: the pre-cutover bootstrap shim was
              // deleted once every preview was built by a platform that
              // injects IFRAME_JWT_PUBLIC_KEY + USERNODE_APP_ID, so a
              // token the RS256 path rejects switches nothing.
              const payload = platformJwt.orNull(
                () => platformJwt.verifyAppIdentityToken(switchTok, { appId: SELF_APP_ID })
              );
              if (payload && typeof payload.id === 'number') tokenUserId = payload.id;
              if (tokenUserId != null && tokenUserId !== rows[0].user_id) {
                const minted = await tryMintSessionFromIframeJwt(pool, config, switchTok, res, req);
                if (minted) {
                  req.user = minted;
                  log.debug('auth', 'Staging iframe-JWT switched session identity', {
                    from: rows[0].user_id, to: minted.id,
                  });
                  if (enforcePlatformAccessGate(req, res, req.user)) return;
                  return next();
                }
                // Mint failed (user missing in the clone, etc.) — fall
                // through to the still-valid cookie session.
              }
            }
          }
          req.user = {
            id: rows[0].user_id,
            username: rows[0].username,
            isAdmin: rows[0].is_admin,
            // View-only admin marker + derived write capability (issue
            // #311). `isAdmin` still gates every read/visibility check;
            // `canAdminWrite` is the single gate for privileged mutations
            // (a full admin only — view-only admins get FALSE).
            adminReadonly: !!rows[0].admin_readonly,
            canAdminWrite: !!rows[0].is_admin && !rows[0].admin_readonly,
            // Per-user app-creation quota (see users.app_quota in
            // schema.sql). The POST /api/apps gate compares this to the
            // user's live app count; admins bypass it. The derived
            // `canCreateApps` boolean the client reads is computed in
            // auth/me from this plus a live count.
            appQuota: rows[0].app_quota ?? 0,
            // Platform-level language preference (issue #757): a BCP-47
            // tag or null when unset. Surfaced via /api/auth/me.
            locale: rows[0].locale || null,
            // #6479: the IANA zone this person's times are shown in, or
            // null for Auto (the device's own). Surfaced via /api/auth/me.
            timeZone: rows[0].timezone || null,
            // Platform-access gate (onboarding flow alignment): FALSE for
            // new signups until an admin releases them off the waitlist.
            hasPlatformAccess: !!rows[0].has_platform_access,
            // A private member: an invite link let them into its community
            // before they were let in (users.private_member_since).
            privateMember: isPrivateMember(rows[0]),
          };
          // Placed after the staging identity-switch block: that path replaces
          // the cookie outright, so renewing the credential it is discarding
          // would both waste a write and set competing cookies on one response.
          const renewedExpiry = await renewCookieSession(pool, res, cookieToken, rows[0]);
          touchSessionLastSeen(pool, cookieToken, rows[0]);
          stampApiIdentity(req, res, cookieToken, renewedExpiry || rows[0].expires_at);
          bindStreamSession(req, cookieToken);
          log.debug('auth', 'Session validated', { userId: req.user.id });
          if (enforcePlatformAccessGate(req, res, req.user)) return;
          return next();
        }

        // Stale or unknown cookie — drop it before deciding whether to
        // redirect. In staging we still want to fall through to the
        // iframe-token path; in prod this just becomes the "no auth" case.
        if (rows.length > 0) {
          await pool.query('DELETE FROM sessions WHERE token = $1', [cookieToken]);
        }
        // An old in-flight request may finish after native recovery installed
        // a replacement cookie. A 401 must not clear that newer credential.
        // Explicit logout clears cookies; login/recovery replaces them.
      } catch (err) {
        log.error('auth', 'Session check failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    // Iframe-JWT path — staging only. See block comment above.
    if (IS_STAGING) {
      const queryToken = typeof req.query?.token === 'string' ? req.query.token : null;
      const headerToken = req.headers['x-usernode-token'];
      const jwtToken = queryToken || (typeof headerToken === 'string' ? headerToken : null);
      if (jwtToken) {
        const minted = await tryMintSessionFromIframeJwt(pool, config, jwtToken, res, req);
        if (minted) {
          req.user = minted;
          log.debug('auth', 'Staging iframe-JWT auth succeeded', { userId: minted.id });
          if (enforcePlatformAccessGate(req, res, req.user)) return;
          return next();
        }
      }
    }

    return redirectOrReject(req, res, next);
  };
}

// SEC-06: a reviewer this preview has no row for (an account made after its
// database was copied, or any reviewer once it starts empty) gets one on
// their first verified sign-in: the synthetic handle the platform gives them
// (platform-preview-data-policy.js previewIdentity), no password anyone can
// use, member rights with platform access. Only that handle, for that very
// id, is accepted, so a production handle never lands here; the screenshot
// personas are seeded instead (db/migrate.js).
// The users sequence is moved past the id, so a row this preview makes
// itself never takes it. False when the handle is not a reviewer's.
async function createPreviewReviewer(pool, payload) {
  if (!Number.isSafeInteger(payload.id) || payload.id < 1 || payload.username !== `preview-user-${payload.id}`) return false;
  const { rowCount } = await pool.query(
    `INSERT INTO users (id, username, password, can_create_apps,
       has_platform_access, private_member_since, created_at)
     VALUES ($1, $2, '__staging_redacted__', FALSE, TRUE,
       '2026-01-01T00:00:00Z'::timestamptz, '2026-01-01T00:00:00Z'::timestamptz)
     ON CONFLICT DO NOTHING`,
    [payload.id, payload.username]
  );
  if (rowCount) {
    await pool.query(
      `SELECT setval(q.seq, GREATEST($1::bigint, COALESCE(s.last_value, 0)))
         FROM (SELECT pg_get_serial_sequence('users', 'id') AS seq) q
         JOIN pg_sequences s ON format('%I.%I', s.schemaname, s.sequencename) = q.seq`,
      [payload.id]
    );
    log.info('auth', 'Staging iframe-JWT created the reviewer', { id: payload.id });
  }
  return true;
}

// Verify the parent-issued JWT, look up the matching user in the local
// (cloned) users table, mint a session row + set the cookie. Returns the
// resolved req.user shape on success, null on any failure (caller falls
// through to redirectOrReject).
async function tryMintSessionFromIframeJwt(pool, config, jwtToken, res, req = null) {
  // App-identity (RS256) pinned to THIS clone's app id, and nothing else.
  // Fail-closed with no fallback branch anywhere: the token must carry the
  // right algorithm, issuer, audience and `pur` claim or no session is
  // minted. (A staging-only pre-cutover bootstrap shim lived here for one
  // deploy window while previews were still built by a platform that
  // injected only the old shared secret; it went permanently inert the
  // moment the cutover reached main and has been removed.)
  const payload = platformJwt.orNull(
    () => platformJwt.verifyAppIdentityToken(jwtToken, { appId: SELF_APP_ID })
  );
  if (!payload) {
    log.warn('auth', 'Staging iframe-JWT verification failed');
    return null;
  }

  if (!payload || typeof payload !== 'object' || typeof payload.id !== 'number') {
    log.warn('auth', 'Staging iframe-JWT payload missing required fields');
    return null;
  }

  // The preview knows a reviewer by their production id and synthetic handle
  // (a row made on first sign-in, createPreviewReviewer), and the screenshot
  // personas by their fixed ids, seeded with their fixture roles. Username
  // match is defense-in-depth against a token naming another row's id.
  const findUser = async () => (await pool.query(
    'SELECT id, username, is_admin, admin_readonly, app_quota, private_member_since, locale, timezone, has_platform_access FROM users WHERE id = $1',
    [payload.id]
  )).rows[0];
  let userRow;
  try {
    userRow = await findUser();
    if (!userRow && await createPreviewReviewer(pool, payload)) userRow = await findUser();
  } catch (err) {
    log.error('auth', 'Staging iframe-JWT user lookup failed', { err: err.message });
    return null;
  }

  if (!userRow) {
    log.warn('auth', 'Staging iframe-JWT references unknown user', { id: payload.id });
    return null;
  }
  if (typeof payload.username === 'string' && payload.username !== userRow.username) {
    // Token issued for a user whose username changed since the clone. Refuse
    // — the parent's cookie must re-issue against the current state.
    log.warn('auth', 'Staging iframe-JWT username mismatch', {
      tokenUsername: payload.username, dbUsername: userRow.username,
    });
    return null;
  }

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + STAGING_SESSION_DAYS * 24 * 60 * 60 * 1000);
  try {
    await pool.query(
      'INSERT INTO sessions (token, user_id, expires_at, user_agent_class) VALUES ($1, $2, $3, $4)',
      [sessionToken, userRow.id, expiresAt, classifyUserAgent(req?.headers?.['user-agent'])]
    );
  } catch (err) {
    log.error('auth', 'Staging iframe-JWT session insert failed', { err: err.message });
    return null;
  }

  setSessionCookie(res, sessionToken, expiresAt);
  setSessionCacheCookie(res, sessionToken, expiresAt);
  if (req) bindStreamSession(req, sessionToken);
  res.setHeader?.('Cache-Control', 'private, no-store');

  log.info('auth', 'Staging iframe-JWT minted local session', {
    userId: userRow.id, username: userRow.username,
  });

  return {
    id: userRow.id,
    username: userRow.username,
    isAdmin: userRow.is_admin,
    adminReadonly: !!userRow.admin_readonly,
    canAdminWrite: !!userRow.is_admin && !userRow.admin_readonly,
    appQuota: userRow.app_quota ?? 0,
    locale: userRow.locale || null,
    timeZone: userRow.timezone || null,
    hasPlatformAccess: !!userRow.has_platform_access,
    privateMember: isPrivateMember(userRow),
  };
}

function redirectOrReject(req, res, next) {
  // The native app opens OAuth in the system browser, whose cookie jar may
  // be empty. Only these two account-pinned document navigations may resume
  // after login; ordinary unauthenticated API requests still receive 401.
  const socialIntent = typeof req.query?.intent === 'string'
    && /^(connect|refresh|replace)$/.test(req.query.intent)
    ? req.query.intent
    : null;
  if (req.method === 'GET'
      && /^\/api\/me\/social-identities\/(github|x)\/connect$/.test(req.path)
      && typeof req.query?.account === 'string'
      && /^[1-9][0-9]*$/.test(req.query.account)
      && (req.query.intent === undefined || socialIntent)) {
    const params = new URLSearchParams({ account: req.query.account });
    if (socialIntent) params.set('intent', socialIntent);
    const target = `${req.path}?${params.toString()}`;
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, '/?return_to=' + encodeURIComponent(target) + '#login');
  }
  if (req.path.startsWith('/api/')) {
    // The boot's optional session read (#5678): a device with no saved
    // session asks this way, so a signed-out load is answered "nobody"
    // instead of refused with a request the browser logs as failed. The
    // route (routes/auth.js) is what answers it. Every other
    // unauthenticated API request is still a 401.
    if (req.method === 'GET' && req.path === '/api/auth/me' && req.query?.optional === '1') return next();
    return res.status(401).json({ error: 'Not authenticated' });
  }
  // The app-host authorize hop answers a signed-out visitor itself (back to
  // the app, or to the chromeless view), so it runs without a session.
  if (req.path === '/__access/authorize') return next();
  // Anonymous SPA boot (fold-auth-pages-into-SPA): the shell serves
  // without a session and boots into the in-SPA landing/login screens
  // (auth-screens.js); every data read stays behind the /api/* 401
  // above. Clean app paths are shell documents too. Letting them through
  // preserves the pathname so the client can remember it across login;
  // redirecting to `/` would erase the app the visitor meant to open.
  // Legacy fragment links still enter through `/` and keep working.
  if (isSpaDocumentPath(req.path)) {
    return next();
  }
  return res.redirect('/');
}

module.exports = {
  authMiddleware,
  renewCookieSession,
  SESSION_IDLE_DAYS,
  SESSION_MAX_DAYS,
  SESSION_RENEW_BEFORE_MS,
};
