const crypto = require('node:crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const log = require('../services/logger');
const { clientIp } = require('../services/client-ip');
const uiTelemetry = require('../services/ui-telemetry');

// Retry-delay phrase for throttle messages: minutes rounded up, with
// anything ≤ 60s collapsing to "in under a minute".
function retryPhrase(seconds) {
  if (seconds <= 60) return 'in under a minute';
  return `in about ${Math.ceil(seconds / 60)} minutes`;
}

// A tiny wrapper that standardizes JSON responses + logs throttled hits.
// Keys auth routes by IP (user is anonymous) and write routes by userId
// when available so a single abusive account can't exhaust the limit for
// everyone behind the same NAT.
//
// `message` is either a plain string or a builder (retryAfterSeconds) =>
// string, so throttle responses can say when a retry will succeed.
// `skipFailedRequests` refunds requests that finish ≥ 400 (validation
// errors and dedupe rejections shouldn't burn the budget). `exemptAdmins`
// skips the limiter entirely for FULL admins — gated on canAdminWrite,
// not isAdmin, so view-only admins stay limited like regular users (same
// gate as the app-quota bypass, issue #311).
// `skipSuccessfulRequests` is the mirror of skipFailedRequests: it refunds
// anything that finishes < 400, so the bucket counts only FAILURES. Right
// where the abuse being bounded is itself a stream of failures (guessing an
// unguessable token) and honest traffic essentially never produces one.
//
// `key` overrides how a request is bucketed — return a string to use it, or
// a falsy value to fall through to the keyByUser / IP default below. That
// fallthrough is load-bearing: the waitlist token bucket keys on the path
// token, and one route in the same family carries no token.
function makeLimiter({ windowMs, max, name, keyByUser = false, message, skipFailedRequests = false, skipSuccessfulRequests = false, exemptAdmins = false, skip = null, key = null, v4Envelope = false }) {
  const options = {
    windowMs,
    max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipFailedRequests,
    skipSuccessfulRequests,
    // `ipKeyGenerator` collapses IPv6 to a subnet prefix so a single client
    // can't bypass the limit by rotating addresses within its /56.
    keyGenerator: (req, res) => {
      if (key) {
        const custom = key(req, res);
        if (custom) return String(custom);
      }
      if (keyByUser && req.user?.id) return `user:${req.user.id}`;
      return ipKeyGenerator(clientIp(req));
    },
    handler: (req, res) => {
      const resetTime = req.rateLimit?.resetTime;
      const retryAfterSeconds = resetTime
        ? Math.max(0, Math.ceil((new Date(resetTime).getTime() - Date.now()) / 1000))
        : Math.ceil(windowMs / 1000);
      log.warn('rate-limit', 'Throttled', {
        name,
        ip: clientIp(req),
        userId: req.user?.id,
        path: req.path,
      });
      // No `code` field here — clients discriminate billing 429s by
      // their code tag (#463), so throttles must stay code-free. That rule
      // holds on the v4 surface too: `v4Envelope` adds the envelope, never
      // a code.
      //
      // The envelope exists because /api/v4 answers every OTHER error
      // through routes/topochain/helpers.js `fail`, which returns
      // `{ success: false, error, ... }`. A throttle on those routes was
      // the one reply on that surface without `success`, so a client
      // reading `body.success` got `undefined` rather than `false`. It is
      // not global because this same helper builds the limiters for the
      // platform's own API, whose clients read the bare shape.
      //
      // TWO WAYS IN, and both are needed:
      //
      //   * THE PATH. Any request under /api/v4 gets it, whichever limiter
      //     answered. That covers a limiter SHARED with non-v4 routes —
      //     `attachmentUploadLimiter` gates POST
      //     /api/v4/admin/challenge-illustrations as well as conversations,
      //     chat, sessions and app illustrations, so a limiter-level flag
      //     could not fix the v4 route without changing the other four.
      //     Deciding per request does. It also means a v4 limiter added
      //     later cannot forget.
      //   * THE FLAG, for the routes that share the envelope but not the
      //     prefix: `/challenges-api/**` reuses the very same topochain
      //     handlers and the same `fail`, so it needs the envelope and a
      //     path test alone would miss it.
      //
      // Still no `code`, either way — see #463 above.
      //
      // `Retry-After` is already set by express-rate-limit and needs
      // nothing here — verified against a live 429 before writing this.
      const envelope = v4Envelope || String(req.path || '').startsWith('/api/v4');
      res.status(429).json({
        ...(envelope ? { success: false } : null),
        error: typeof message === 'function'
          ? message(retryAfterSeconds)
          : (message || 'Too many requests, please slow down'),
        retryAfterSeconds,
      });
    },
  };
  if (exemptAdmins) options.skip = (req) => !!req.user?.canAdminWrite;
  if (skip) {
    // An extra exclusion composes with the explicit admin exemption; it
    // never enables that exemption for a limiter that did not request it.
    const skipAdmin = options.skip;
    options.skip = (req, res) => !!skipAdmin?.(req, res) || !!skip(req, res);
  }
  return rateLimit(options);
}

// ── The auth family ────────────────────────────────────────────────────
//
// This used to be ONE bucket — `authLimiter`, 10 requests / 15 min / IP —
// mounted on twelve endpoints spanning password login, email-code signup,
// password recovery, wallet auth and the mobile wallet claim. Three things
// were wrong with that shape, and they are the same three #1668 fixed for
// the waitlist (#1296):
//
//   - It counted SUCCESSES. A sign-in that worked burned a slot, so one
//     office NAT or carrier CGNAT got ten sign-ins per 15 minutes for
//     everyone behind it.
//   - The remedy shared the bucket with the failure: password-reset could
//     be throttled by the very login failures that made it necessary, and
//     the three-step OTP signup competed with login for the same ten.
//   - It was keyed on the address only. Nothing anywhere bounded guessing
//     against ONE account (there is no lockout table and no edge limiter),
//     so vertical brute force from rotating addresses was unbounded.
//
// So: one limiter per family, failures-only wherever the abuse being
// bounded is itself a stream of failures, and a per-identifier bucket on
// login. The mail-sending routes are the exception that still counts
// successes — a delivered email is the cost being bounded, not a failure.
const AUTH_WINDOW_MS = 15 * 60 * 1000;

// A submitted identifier (a username, an email) as a limiter key. Hashed
// for the same reason waitlistCodeConfirmLimiter hashes its address: keys
// live in memory as plain strings, and a digest buckets exactly without
// holding the address itself. Normalized first, or `Alice` and `alice`
// would be two buckets and the split would be the bypass.
function identifierKey(prefix, value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return null;
  return `${prefix}:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
}

// Login, part 1 of 3: the burst. `windowMs` fuses two independent knobs —
// how patiently failures are counted, and how long a human waits after
// tripping — and the old single 15-minute window set both at once, so
// mistyping your own password cost a quarter of an hour. Splitting them
// lets the penalty be short where the counting stays long: five wrong
// passwords in a minute is answered in about a minute, not fifteen.
const loginBurstLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 5,
  name: 'login-burst',
  skipSuccessfulRequests: true,
  message: (s) => `Too many sign-in attempts. Try again ${retryPhrase(s)}.`,
});

// Login, part 2 of 3: the sustained rate, which is what actually bounds a
// patient attacker. 30 failures/hour is TIGHTER than the 40/hour the old
// 10-per-15-minutes bucket allowed, and honest traffic no longer competes
// for it at all because successes are refunded.
const loginSustainedLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  name: 'login-sustained',
  skipSuccessfulRequests: true,
  message: (s) => `Too many sign-in attempts from this address. Try again ${retryPhrase(s)}.`,
});

// Login, part 3 of 3: per-identifier. The two buckets above bound one
// SOURCE; this one bounds one TARGET, which is the case neither the old
// limiter nor anything else in the stack covered — an attacker rotating
// addresses got a fresh budget with every address.
//
// It counts unknown identifiers exactly like known ones. That is
// deliberate: bucketing only real accounts would make the 429 an
// account-existence oracle, and the whole point of the shared `handler` in
// makeLimiter is that the refusal is byte-identical whichever key fired.
//
// The cost is the standard one, and it is real: somebody who knows a
// username can spend failures to keep that account throttled. Three things
// bound it rather than remove it — the window is 15 minutes and not a
// lockout, an attacker's own address is capped at 30 failures/hour by the
// limiter above (so one address cannot even sustain the grief), and a
// signed-in user cannot reach here at all, because the SESSION_MINT_PATHS
// boundary in routes/auth.js answers a request carrying a live session
// with 409 before any limiter runs.
//
// One honest limit: the key is the identifier as SUBMITTED, not the account
// it resolves to. /api/auth/login accepts a username OR an email for the
// same account (#1269), so somebody holding both spellings gets two buckets
// against one target rather than one. Keying on the resolved account would
// mean running the lookup — two queries and a bcrypt compare — BEFORE the
// throttle, which hands an attacker the work the limiter exists to bound.
// The per-address buckets above still cap the total either way.
const loginIdentityLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 10,
  name: 'login-identity',
  skipSuccessfulRequests: true,
  key: (req) => identifierKey('login', req.body?.username),
  message: (s) => `Too many sign-in attempts for that account. Try again ${retryPhrase(s)}.`,
});

// Activation-code redemption. Codes are admin-minted rather than random
// per request, so this bounds working through a list of them.
const registerLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 10,
  name: 'register',
  skipSuccessfulRequests: true,
  message: (s) => `Too many registration attempts. Try again ${retryPhrase(s)}.`,
});

// Requesting an email code SENDS MAIL, so this is the one auth family
// where a success is the cost and refunding it would be the bug. Two
// buckets, mounted together, in the shape waitlistJoin uses: per address
// so one person cannot work through a list of victims, per recipient so
// one mailbox cannot be flooded from many addresses.
const otpRequestLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 10,
  name: 'otp-request',
  message: (s) => `Too many code requests. Try again ${retryPhrase(s)}.`,
});

const otpRequestEmailLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 5,
  name: 'otp-request-email',
  key: (req) => identifierKey('otp', req.body?.email),
  message: (s) => `A code was just sent to that address. Try again ${retryPhrase(s)}.`,
});

// Verifying a code, and consuming the narrow signup cookie it mints.
// services/email-signup.js already caps attempts at MAX_OTP_ATTEMPTS per
// code in the database, so this only has to bound working through codes;
// 15 leaves an honest fumbler (a mistyped code, a resend, another try)
// far from the ceiling.
// Apple and Google sign-in's start and callback (routes/sign-in-providers.js).
// Its own budget, not the email code's: a person who tries Google, comes
// back, and then asks for a code should not run out of either. Each trip is
// two requests, and the provider's own page is the real rate limit.
const oauthSignInLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 30,
  name: 'oauth-sign-in',
  message: (s) => `Too many sign-in attempts. Try again ${retryPhrase(s)}.`,
});

const otpVerifyLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 15,
  name: 'otp-verify',
  skipSuccessfulRequests: true,
  message: (s) => `Too many code attempts. Try again ${retryPhrase(s)}.`,
});

// The account step's live "✓ Available" (#5255, GET
// /api/auth/username-available): one read per pause in typing, so a
// person trying a few names stays far below it. Per IP, never per signup
// cookie: the cookie is the client's to choose, so a bucket keyed on it
// would be a fresh bucket per request. The route itself answers nobody
// without a live signup session.
const usernameCheckLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 120,
  name: 'username-check',
  message: (s) => `Too many username checks. Try again ${retryPhrase(s)}.`,
});

// The release mail's one-time sign-in link (#4594, POST
// /api/auth/release-link). 256 random bits leave nothing to guess, so the
// budget bounds scanning and lookup work; failures only, so a real
// recipient's one spend never counts.
const releaseLinkLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 10,
  name: 'release-link',
  skipSuccessfulRequests: true,
  message: (s) => `Too many sign-in link attempts. Try again ${retryPhrase(s)}.`,
});

// Phone code requests (routes/phone-auth.js), the email code's pair:
// requesting SENDS A TEXT, so a success is the cost and refunding it would
// be the bug. Per source and per recipient, mounted together, the same
// shape the email request above uses.
const phoneOtpRequestLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 10,
  name: 'phone-otp-request',
  message: (s) => `Too many code requests. Try again ${retryPhrase(s)}.`,
});

const phoneOtpRequestPhoneLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 5,
  name: 'phone-otp-request-phone',
  key: (req) => identifierKey('phone', req.body?.phoneNumber),
  message: (s) => `A code was just sent to that number. Try again ${retryPhrase(s)}.`,
});

// Verifying a phone code, or spending the ID token a client SDK earned.
// Firebase caps attempts per code server-side already, so — like the email
// code's verify — this only has to bound working through codes, and a
// confirmed sign-in is refunded.
const phoneVerifyLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 15,
  name: 'phone-verify',
  skipSuccessfulRequests: true,
  message: (s) => `Too many code attempts. Try again ${retryPhrase(s)}.`,
});

// Password recovery, split from login for the reason the split exists at
// all: the remedy must never be throttled by the failures that caused it.
// Requesting sends mail, so it counts successes and gets the same
// address/recipient pair as the OTP request above.
const passwordResetRequestLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 10,
  name: 'password-reset-request',
  message: (s) => `Too many reset requests. Try again ${retryPhrase(s)}.`,
});

const passwordResetRequestEmailLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 5,
  name: 'password-reset-request-email',
  key: (req) => identifierKey('reset', req.body?.email),
  message: (s) => `A reset link was just sent to that address. Try again ${retryPhrase(s)}.`,
});

// Redeeming a reset token. The token is 32 random bytes, so this bounds
// scanning rather than guessing; failures-only keeps a real recipient's
// redemption from ever approaching it.
const passwordResetConfirmLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 20,
  name: 'password-reset-confirm',
  skipSuccessfulRequests: true,
  message: (s) => `Too many reset attempts. Try again ${retryPhrase(s)}.`,
});

// The wallet family: verify, reset-verify, register and link-login all
// submit a signature over a server-issued ECDSA challenge, so there is
// nothing here to guess and the budget only has to bound the verification
// work. Its own bucket so a wallet user's retries cannot throttle a
// password user behind the same address.
const walletAuthLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 20,
  name: 'wallet-auth',
  skipSuccessfulRequests: true,
  message: (s) => `Too many wallet attempts. Try again ${retryPhrase(s)}.`,
});

// POST /api/v4/mobile/wallet/claim proves ownership of a legacy account
// with a SIX-DIGIT code, which is the one genuinely guessable secret in
// this family, so it stays tight. The route already requires a live web
// session, so it is keyed per user rather than per address — mounted
// AFTER optionalSessionAuth in routes/topochain/mobile.js so req.user is
// populated by the time the key is computed.
const mobileWalletClaimLimiter = makeLimiter({
  windowMs: AUTH_WINDOW_MS,
  max: 10,
  name: 'mobile-wallet-claim',
  // /api/v4 answers every other error with the envelope (#2526 follow-up).
  v4Envelope: true,
  keyByUser: true,
  skipSuccessfulRequests: true,
  message: (s) => `Too many claim attempts. Try again ${retryPhrase(s)}.`,
});

// Wallet pre-check: 60 / min / IP. /api/auth/wallet-check is a read-only
// lookup that fires on every login-page load to decide whether to show
// "Sign in with wallet" vs "Link / register". Reusing the shared auth
// bucket here caused legitimate users (esp. mobile webview refreshes) to
// bounce off after 10 page loads in 15 min and see a misleading "not
// linked" UI. The endpoint can't be used to brute-force credentials —
// verification still goes through wallet-verify with a server-issued
// ECDSA challenge, which IS gated by walletAuthLimiter.
const walletCheckLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'wallet-check',
  message: 'Too many wallet checks, slow down for a minute',
});

// App creation: 5 / hour / user. Each create provisions a container, DB,
// and repo — so expensive.
const appCreateLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  name: 'app-create',
  keyByUser: true,
  message: 'You\'ve created a lot of apps recently. Try again in a bit',
});

// #2519: the two /api/github/* lookups. 30 / hour / user.
//
// Both spend the PLATFORM's GitHub quota, not the caller's: every request is
// an outbound call on the shared bot installation, whose limit is per
// installation and therefore shared by every app's GitHub integration.
// Neither route was bounded at all, so any signed-in account could drain it
// one request at a time and take repo import, PR sync and check reporting
// down with it for everybody.
//
// `verify-access` is the one that matters more. It does not merely read: it
// accepts any pending bot invitation for the repo first, so an unbounded
// caller can drive that side effect repeatedly as well.
//
// FAILURES COUNT HERE — no skipFailedRequests, unlike the write limiters. A
// 404 from GitHub has already cost the quota this protects, so refunding it
// would refund the exact requests being bounded.
//
// 30/hour is far above the interactive use: `verify-access` is the import
// modal's "Check access" BUTTON, clicked a handful of times while setting an
// app up, and nothing debounces into it. `repo-info` has no caller left in
// the product at all.
const githubLookupLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  name: 'github-lookup',
  keyByUser: true,
  message: (s) => `Too many repository lookups. You can try again ${retryPhrase(s)}.`,
});

// #2505: the /explorer-api passthrough. 120 / minute / IP.
//
// Keyed by ADDRESS, not by user, because this endpoint has no user: it is
// mounted ahead of authMiddleware on purpose (see routes/explorer-proxy.js)
// so receipt observation is not redirected to the login page. There is
// nothing else to key on.
//
// Every call makes an outbound request to the explorer, so an unbounded
// endpoint is an unbounded amplifier pointed at a third party as well as a
// way to spend this platform's sockets. 120/minute is far above the real
// traffic — a client observes a receipt a handful of times per submission —
// and far below a useful flood.
//
// Failures count. A refused call has already made the outbound request.
const explorerProxyLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'explorer-proxy',
  message: 'Too many explorer requests, slow down for a minute',
});

// #2526: the heavy topochain mobile reads. 120 / minute / user.
//
// `GET /api/v4/mobile/{me, me/ranking, me/breakdown, event/points,
// leaderboard, challenges, seasons}` each run real aggregate queries against
// the points ledger, and none carried a limiter — unlike their own siblings
// in the same file (`mobileWalletClaimLimiter`) and next door
// (`topochainMobilePushRegistrationLimiter`, mobile-push-registration.js).
// This is per-principal abuse rather than anonymous: the caller holds a valid
// mobile bearer. That makes it a cost bound, not an auth gate.
//
// Five of those seven handlers are ALSO mounted under `/challenges-api/**`
// for the web session, as the same function objects, so both mounts share
// this limiter. One person on a phone and a laptop therefore shares one
// budget, which is the intended reading: the budget belongs to the user, not
// to the device.
//
// NOT `POST /api/v4/mobile/zkpassport/complete`, though it is the other
// unlimited v4 mobile route and looks like it belongs here. It is a write,
// not a read, and it is already idempotent THREE ways (mobile.js): a prior
// completion short-circuits to `already_recorded: true`, a reused zkPassport
// session 409s, and a reused nullifier 409s. So it cannot inflate points —
// the harm this issue is about — and putting it in a 120/min READ budget
// would let a busy leaderboard screen block a once-per-challenge claim.
// Bounding its query cost is a separate limiter with a separate number.
//
// 120/minute is far above a phone's real behaviour — a screen refresh reads a
// handful of these — and far below a loop. Keyed by user, since every one of
// these routes runs behind `mobileTokenAuth` or `optionalSessionAuth` and so
// has a `req.user.id` by the time the limiter runs.
//
// Failures count: a rejected read has already run its query.
const topochainMobileReadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'topochain-mobile-read',
  // /api/v4 answers every other error with the envelope (#2526 follow-up).
  v4Envelope: true,
  keyByUser: true,
  message: (s) => `Too many requests. Try again ${retryPhrase(s)}.`,
});

// #2526: the partner point-award, bounded TWICE. The two limiters answer
// two different questions, and neither alone is enough.
//
// `POST /api/v4/user-activities` is NON-IDEMPOTENT BY CONTRACT — the route's
// own comment cites SPEC 1350 §4.8 "carried quirks": every call inserts a new
// `user_activities` row, so a retried request awards the points twice. That
// is a deliberate, spec'd decision and this does not change it; an
// idempotency key would, and belongs to whoever owns that spec. What it
// changes is that the double-award used to be UNBOUNDED.
//
// (1) PER PARTICIPANT — 60/minute. This is the one that actually bounds the
// harm the issue names. "Point inflation" means driving up ONE participant's
// score, so that is what the bucket is keyed on.
//
// It is keyed here, and not on the caller, because the caller cannot be
// identified and cannot be pinned down:
//
//   - The API KEY is not an identity. `partnerApiKey`
//     (middleware/topochain-auth.js) compares X-API-Key against ONE shared
//     secret — "v1's `api.key` middleware compared X-API-Key against one
//     shared secret with no per-client keys or scopes; v4 keeps that exact
//     comparison". Every partner presents the same string, so a key-derived
//     bucket is one global bucket: any partner's retry storm refuses all of
//     them.
//   - The ADDRESS is forgeable by this exact adversary. In Kubernetes
//     server.js passes `trustDirectPeer: true`, so services/client-ip.js
//     trusts any peer to supply a single X-Forwarded-For — its own TODO says
//     as much ("so a generated app cannot deliberately forge a single
//     forwarding header"). A partner making direct calls can therefore pick
//     its own bucket and rotate through as many as it likes.
//
// Keying on the participant survives both. An attacker who rotates the
// participant identifier to escape the bucket has stopped inflating the
// participant it was targeting, which is the goal it came for.
//
// 60/minute per participant is far above any real award pattern — activities
// are completions, not a stream — and turns "unbounded" into a rate a human
// notices before a leaderboard is meaningless.
//
// KNOWN CEILING, because it would be easy to read this as tighter than it
// is: the bucket is per (identifier_type, identifier) SPELLING, not per
// human. One person reachable as an email, a Telegram handle and a Discord
// handle is three buckets, so the real bound on that person is 3 x 60 = 180
// a minute. It is a small fixed multiplier on a previously unbounded number,
// not a bypass — but it is not the "60 per participant" the name suggests.
//
// Closing it properly needs the key to be the RESOLVED user id, and this
// limiter cannot have it: resolution is the `SELECT id FROM users WHERE
// <column> = $1` inside the route (routes/topochain/partner.js), which runs
// after this middleware. Doing it right means resolving the participant in
// its own middleware ahead of the limiter and having the handler read that
// instead of re-querying — a restructure of a handler whose comments carry
// four documented SPEC judgment calls, and not something to do incidentally
// inside a rate-limit fix. Whoever takes that on: key this on the user id,
// drop identifier_type from the key, and this note goes with it.
// The identifier types the partner route accepts, mirroring
// `IDENTIFIER_COLUMNS` in routes/topochain/partner.js (SPEC 1330-1339's
// `in:email,telegram,discord`). Two copies, because middleware importing a
// route module is the wrong direction — tests/topochain-rate-limits.test.js
// pins that they agree, which is what stops them drifting.
const PARTNER_IDENTIFIER_TYPES = new Set(['email', 'telegram', 'discord']);

const partnerActivityParticipantLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'partner-user-activities-participant',
  // /api/v4 answers every other error with the envelope (#2526 follow-up).
  v4Envelope: true,
  // The key has to be the participant the ROUTE will resolve, not the bytes
  // the caller happened to send, or the bound is bypassable by respelling.
  //
  // Each field is trimmed SEPARATELY. Composing first and trimming the whole
  // thing — which is what identifierKey's own trim does — leaves interior
  // whitespace in place, so `"email:" + " p@x"` and `"email:" + "p@x"` hash
  // to two buckets while the route's own `participant_identifier.trim()`
  // (routes/topochain/partner.js) resolves both to one user. That is not a
  // rounding error: it multiplies the cap by however many spellings the
  // caller cares to use.
  //
  // `identifier_type` is part of the key because the same string can be a
  // valid email and a valid telegram handle — different participants — and
  // the two are separated by a NUL, which neither field can contain
  // meaningfully, so no pair of fields can compose into another pair's key.
  //
  // The type must match EXACTLY, not after trimming or lowercasing, because
  // this bucket can be exhausted and the route's own check
  // (`IDENTIFIER_COLUMNS[identifierType]`, routes/topochain/partner.js) is an
  // exact lookup. Normalising " email" or "EMAIL" into the `email` bucket
  // would let a caller spend a REAL participant's budget on 60 requests the
  // route then 422s — denying that participant their legitimate awards
  // without ever awarding anything. An unrecognised type gets no participant
  // bucket at all; the address bound below still sees it, and the route
  // rejects it a moment later.
  //
  // identifierKey then lowercases. For the identifier that is deliberately
  // STRICTER than the route, whose `WHERE <column> = $1` is case-sensitive:
  // two case variants share one bucket. Over-counting a participant costs a
  // little fairness between two spellings of one address; under-counting is
  // the bypass above. The asymmetry is the whole reason for the direction.
  //
  // Anything not a string yields null. Reading the fields by type rather
  // than interpolating them also means a crafted object cannot run a
  // `toString` inside the key generator.
  key: (req) => {
    const body = req.body;
    if (!body || typeof body !== 'object') return null;
    const type = body.identifier_type;
    if (!PARTNER_IDENTIFIER_TYPES.has(type)) return null;
    const who = typeof body.participant_identifier === 'string'
      ? body.participant_identifier.trim() : '';
    if (!who) return null;
    return identifierKey('partner-activity', `${type}\u0000${who}`);
  },
  // A REJECTED award must not spend the participant's budget. It awards no
  // points, so it is not the inflation this bound exists for — but counted,
  // it would let a caller fire 60 well-typed requests naming a real
  // participant and failing on the season, the challenge or the enrollment,
  // and thereby block that participant's legitimate awards for the minute
  // without ever awarding anything. Denial of service dressed as a limiter.
  //
  // The address bound below deliberately does NOT skip failures: junk still
  // costs the caller its volume budget, so this is not a free channel.
  skipFailedRequests: true,
  message: (s) => `Too many activity submissions for this participant. Try again ${retryPhrase(s)}.`,
});

// (2) PER ADDRESS — 600/minute. This one is NOT a security boundary, and
// the distinction matters enough to state rather than imply.
//
// It bounds the ACCIDENT: a partner integration whose retry loop runs away,
// which is the likeliest way this endpoint actually misbehaves and the one
// that needs no attacker at all. Against that it works, because a buggy
// client does not rotate its own forwarding header.
//
// It does NOT bound a deliberate attacker. In Kubernetes server.js passes
// `trustDirectPeer: true`, so a caller supplies its own single
// X-Forwarded-For and picks this bucket; rotating that header and the
// participant identifier together gives a fresh bucket in both limiters on
// every request. An earlier draft of this comment claimed this limiter
// capped total volume and in-memory bucket growth. It does not, and saying
// so was worse than saying nothing — it reads like a guard.
//
// So what actually holds against a deliberate attacker is limiter (1)
// alone, and only for the participant it is targeting: it cannot inflate
// any single participant past 60/minute however it presents itself, which
// is the harm #2526 names. It CAN still issue unbounded requests in total.
//
// CLOSING THAT NEEDS AN IDENTITY THIS ENDPOINT DOES NOT HAVE. Both possible
// caller keys are dead ends today: the API key is one shared secret (every
// partner sends the same string, so the bucket would be global and any
// partner's storm would refuse all of them), and the address is caller-
// supplied. The fix is per-partner API keys — already recorded as future
// work in the SPEC note quoted above — after which this limiter should key
// on the partner's identity and this comment should be replaced by one that
// can honestly call it a caller bound.
//
// 600/minute is deliberately generous for the accident it does bound: a
// partner legitimately awarding a batch of participants should never meet
// it, and a runaway loop stops at ten a second instead of as fast as the
// socket allows.
const partnerActivityLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 600,
  name: 'partner-user-activities',
  // /api/v4 answers every other error with the envelope (#2526 follow-up).
  v4Envelope: true,
  message: (s) => `Too many activity submissions. Try again ${retryPhrase(s)}.`,
});

// #3654: the Homeroom bot benchmark's grading writes (routes/homeroom-bench.js),
// reached by an admin's Claude session through the connector. A session
// grades one item at a time; 120 a minute per person is far above that and
// stops a loop that went wrong. Admins are NOT exempt: only admins can call
// these at all, so an exemption would switch the limiter off.
const benchGradingLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'bench-grading',
  keyByUser: true,
  message: (s) => `Too many benchmark grades at once. Try again ${retryPhrase(s)}.`,
});

// #3654: launching, cancelling and regrading benchmark runs through the
// connector (routes/homeroom-bench.js /api/bot-bench/runs). A launch spends the
// platform's money up to its cap, so a session that loops on it is stopped
// well before many runs are queued. A refused launch spends nothing, so only
// the ones that went through count. Admins are NOT exempt, for the reason
// given above.
const benchRunLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  name: 'bench-runs',
  keyByUser: true,
  skipFailedRequests: true,
  message: (s) => `Too many benchmark launches, cancels or regrades at once. Try again ${retryPhrase(s)}.`,
});

// The App bench studio's writes through the connector (routes/bench-studio.js):
// a session drives a run by hand (references handed in, a trial run again,
// a build kept or previewed, a pack saved), so they come in bursts a launch
// limit would refuse. A launch through the studio spends money and is held
// to benchRunLimiter as well.
const benchStudioLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'bench-studio',
  keyByUser: true,
  skipFailedRequests: true,
  message: (s) => `Too many benchmark studio changes at once. Try again ${retryPhrase(s)}.`,
});

// The programme's challenges through the admin connector
// (routes/challenge-admin.js /api/challenge-admin): a session setting up a
// week's events adds, edits and reorders challenges and templates in bursts,
// one call each, so the limit is per minute and well above a session working
// through a whole programme. Only writes that went through count. Admins are
// NOT exempt, for the reason given above.
const challengeAdminLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'challenge-admin',
  keyByUser: true,
  skipFailedRequests: true,
  message: (s) => `Too many challenge changes at once. Try again ${retryPhrase(s)}.`,
});

// Test accounts (routes/test-accounts.js /api/test-accounts), reached by a
// full admin's connector session. Each admin gets 10 creates, 10 one-time
// phone sign-ins, 10 test release emails and 10 retires an hour, counted
// apart so retiring
// yesterday's accounts never spends today's creates; the list is a read and
// gets more room. Only requests that went
// through count (the live cap's own refusal is a 429 that spends nothing).
// Admins are NOT exempt, for the reason given above: only full admins can
// call these at all.
function testAccountAction(req) {
  if (req.method === 'GET') return 'list';
  if (/\/phone-sign-ins\/?$/.test(req.path || '')) return 'phone';
  if (/\/release-emails\/?$/.test(req.path || '')) return 'release';
  return /\/retire\/?$/.test(req.path || '') ? 'retire' : 'create';
}
const testAccountLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: (req) => (req.method === 'GET' ? 120 : 10),
  name: 'test-accounts',
  keyByUser: true,
  key: (req) => (req.user?.id ? `user:${req.user.id}:test-accounts:${testAccountAction(req)}` : null),
  skipFailedRequests: true,
  message: (s) => `Too many test-account requests. Try again ${retryPhrase(s)}.`,
});

// Separate from provisioning so asking for slots never consumes a create attempt.
const appAllowanceRequestLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  name: 'app-allowance-request',
  keyByUser: true,
  message: 'Too many allowance requests. Please try again later.',
});

// Issue / rename / visibility proposals: 20 / hour / user. Loose enough
// for normal use but stops spam creation of proposals. Only successful
// creations count, and full admins are exempt.
const issueCreateLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  name: 'issue-create',
  keyByUser: true,
  skipFailedRequests: true,
  exemptAdmins: true,
  message: (s) => `Rate limit reached: up to 20 issues and proposals per hour. You can try again ${retryPhrase(s)}.`,
});

// Invite links (services/community-invites.js). Making one: 20 / hour /
// user, successes only, since each is a way into a project and the per-
// project cap of live links already bounds what is held at once. Following
// one: 30 / 15 min / user, failures counted too, because a stream of
// refused tokens is the thing worth slowing. Reading the public preview:
// 60 / minute / address, since it answers without a session.
const inviteLinkCreateLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  name: 'invite-link-create',
  keyByUser: true,
  skipFailedRequests: true,
  exemptAdmins: true,
  message: (s) => `You have made a lot of invite links. You can try again ${retryPhrase(s)}.`,
});

const inviteRedeemLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  name: 'invite-redeem',
  keyByUser: true,
  message: 'Too many invite links followed, slow down for a few minutes',
});

const invitePreviewLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'invite-preview',
  message: 'Too many invite lookups, slow down for a minute',
});

// An app's emoji drawn as its home-screen icon (/app-icons/emoji/…,
// routes/app-icons.js). Public and drawn on the server, so a client cannot
// run through colours faster than this; a phone asks for one once.
const emojiTileLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'emoji-tile',
  message: 'Too many icons, slow down for a minute',
});

// Close-issue proposals (#522): own 20 / hour / user bucket, so proposing
// to close stale issues can't be starved by issue creation (or vice
// versa) — the shared bucket was why "Propose to close" 429'd for users
// who had merely been filing issues or saving agent files. The route's
// per-issue dedupe already caps open close proposals at one per target.
const closeProposalLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  name: 'close-proposal',
  keyByUser: true,
  skipFailedRequests: true,
  exemptAdmins: true,
  message: (s) => `Rate limit reached: up to 20 close proposals per hour. You can try again ${retryPhrase(s)}.`,
});

// POST /api/apps/:slug/issues serves several proposal kinds — route
// close_issue bodies to their own bucket, everything else (general,
// secret_change) to issue-create. req.body is already parsed here: the
// global express.json() mounts before any router (see server.js). A
// missing/non-JSON body falls through to the default bucket.
function issueKindLimiter(req, res, next) {
  const limiter = req.body?.kind === 'close_issue' ? closeProposalLimiter : issueCreateLimiter;
  return limiter(req, res, next);
}

// Agent instruction/skill file saves (#460): 30 / minute / user, split
// off the issues bucket so an editing session (many saves in a row) can
// never lock the user out of governance actions. Same shape and
// reasoning as attachmentUploadLimiter below: honest editing never
// bites, scripted loops bounce quickly.
const agentFileWriteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 30,
  name: 'agent-file-write',
  keyByUser: true,
  exemptAdmins: true,
  message: (s) => `Rate limit reached: up to 30 file saves per minute. You can try again ${retryPhrase(s)}.`,
});

// Chat: 30 / minute / user. Loose enough that no honest user notices
// during normal back-and-forth, tight enough that scripted abuse
// (looping POSTs to drain the daily LLM cap) bounces off well before
// hitting the daily limit. Per-user keying so a single abusive account
// behind shared NAT can't degrade other users on the same IP.
const chatLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 30,
  name: 'chat',
  keyByUser: true,
  message: 'Too many chat messages. Slow down for a minute.',
});

// Native app/group-chat JSON writes: 60 / minute / user. Browser clients
// normally use the WebSocket path, while CLI/MCP clients use
// POST /api/apps/:slug/messages. Keep this bucket separate from chatLimiter:
// posting native discussion replies must not consume the budget for agent
// turns (which can incur an LLM spend), or vice versa.
const groupChatWriteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'group-chat-write',
  keyByUser: true,
  message: 'Too many discussion messages. Slow down for a minute.',
});

// Platform Messages has separate safety buckets from app group chat. Failed
// consent/membership attempts intentionally count: refunding them would turn
// these endpoints into an unbounded user/conversation enumeration oracle.
const conversationMessageLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'conversation-message',
  keyByUser: true,
  message: 'Too many messages. Slow down for a minute.',
});

const conversationActionLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  name: 'conversation-action',
  keyByUser: true,
  message: 'Too many conversation or invitation changes. Try again later.',
});

// Consent exits must never share a bucket with invitation churn: a user who
// just created or edited many groups must still be able to decline, leave, or
// block immediately.
const conversationSafetyLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 120,
  name: 'conversation-safety',
  keyByUser: true,
  message: 'Too many consent changes. Slow down and try again.',
});

// express-rate-limit increments once per request. Group APIs batch recipients,
// so consume one unit per distinct requested recipient (and one for an empty
// group/direct create) rather than letting a 100-person request cost one.
const conversationInviteWindows = new Map();
function conversationInviteLimiter(req, res, next) {
  const raw = req.body?.kind === 'group' ? req.body?.member_ids : req.body?.user_ids;
  const cost = Math.max(1, Math.min(101, Array.isArray(raw) ? new Set(raw.map(String)).size : 1));
  const key = req.user?.id ? `user:${req.user.id}` : `ip:${clientIp(req)}`;
  const now = Date.now();
  let window = conversationInviteWindows.get(key);
  if (!window || window.resetAt <= now) {
    window = { used: 0, resetAt: now + 60 * 60 * 1000 };
    conversationInviteWindows.set(key, window);
  }
  if (window.used + cost > 100) {
    const retryAfterSeconds = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    log.warn('rate-limit', 'Throttled', {
      name: 'conversation-invite', ip: clientIp(req), userId: req.user?.id, path: req.path,
    });
    res.set('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({
      error: 'Too many conversation invitations. Try again later.',
      retryAfterSeconds,
    });
  }
  window.used += cost;
  return next();
}

const conversationReactionLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'conversation-reaction',
  keyByUser: true,
  message: 'Too many reactions. Slow down for a minute.',
});

// #1280: saving/unsaving a group-chat message. Sized like the reaction
// limiter above — the honest gesture is one tap, but a user skimming a
// backlog may save a dozen in a few seconds, and toggling one message off
// and on again must not feel rate-limited. Per-user keyed for shared-NAT
// fairness.
const messageBookmarkLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'message-bookmark',
  keyByUser: true,
  message: 'Too many saves. Slow down for a minute.',
});

// #4769: saving/unsaving a notification in the drawer. Sized like the
// message-bookmark limiter above — same honest gesture, same skimming
// backlog, own name so the two buckets cannot starve each other.
const notificationBookmarkLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'notification-bookmark',
  keyByUser: true,
  message: 'Too many saves. Slow down for a minute.',
});

// #2387: moving one's own read position in an app's chat (mark read, mark
// unread). The client marks read as a channel opens and as the reader
// reaches the bottom, so a busy session posts this often; it is one indexed
// upsert per call and touches nobody else's state. Sized like the bookmark
// bucket above, with its own name so the two cannot starve each other.
const appChatReadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'app-chat-read',
  keyByUser: true,
  message: 'Too many read updates. Slow down for a minute.',
});

const conversationReportLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: 'conversation-report',
  keyByUser: true,
  message: 'Too many reports. Try again later.',
});

// #2386: every friend write — request, accept, decline, cancel, unfriend.
// The product caps (20 pending, 50 sent a day) live in services/friends.js
// and answer with their own 429 copy; this is only the flood guard over all
// five, set well above what those caps allow so a burst of requests can never
// lock someone out of declining or unfriending.
const friendshipLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 300,
  name: 'friendship',
  keyByUser: true,
  message: 'Too many friend changes. Slow down and try again.',
});

// #556: live title previews for the feedback modal (POST /api/feedback/
// title). Same sizing rationale as chatLimiter — each call is a Haiku
// spend against the daily LLM budget, so this must not become a faster
// drain path. The FE debounces to ~1–3 calls per modal in honest use
// (plus its own per-open cap), so 20/min never bites, while a scripted
// loop bounces quickly. Per-user keyed for shared-NAT fairness.
const feedbackTitleLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 20,
  name: 'feedback-title',
  keyByUser: true,
  message: 'Too many title previews. Slow down for a minute.',
});

// Dev-chat attachment uploads (#450): 30 / minute / user. Each upload is
// a ≤20 MB bytea INSERT; honest use is a handful per message, so 30/min
// never bites, while a scripted loop trying to balloon the DB bounces
// off quickly (per-session totals are additionally capped at 50 MB in
// the route itself). Per-user keyed for shared-NAT fairness.
const attachmentUploadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 30,
  name: 'attachment-upload',
  keyByUser: true,
  message: 'Too many file uploads. Slow down for a minute.',
});

// App file-storage uploads via the shell relay (#752): 20 / minute /
// user. Honest use is a photo or two per action, so 20/min never bites,
// while a scripted loop trying to fill an app's quota bounces quickly
// (per-app and per-user byte caps are additionally enforced in the
// route). Per-user keyed for shared-NAT fairness; matches the 20/min
// the server-side /api/app-storage path applies per (app, user).
const appFileUploadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 20,
  name: 'app-file-upload',
  keyByUser: true,
  message: 'Too many file uploads. Slow down for a minute.',
});

// #683: feedback-modal screenshot uploads. Each is a ≤4 MB bytea INSERT;
// honest use is one per filed issue, so 10 / 10 min never bites, while a
// scripted loop trying to balloon the DB bounces off quickly (orphans are
// additionally GC'd after 24h). Per-user keyed for shared-NAT fairness.
// A spec posted on a request (routes/request-specs.js). Each post stores a
// document of up to 600,000 characters, writes a version, a thread card and a
// GitHub comment, so it is bounded per user like the screenshot uploads: a
// review round is one post, and 20 an hour is many rounds.
const requestSpecLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  name: 'request-spec-post',
  keyByUser: true,
  message: 'Too many plans posted. Try again later this hour.',
});

const issueScreenshotLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  name: 'issue-screenshot-upload',
  keyByUser: true,
  message: 'Too many screenshot uploads. Slow down for a few minutes.',
});

// #3940: feedback-modal video uploads. Each is a ≤50 MB bytea INSERT —
// 50× a screenshot — so the budget is the same 10 / 10 min as the
// screenshot limiter: honest use is one clip per filed issue, and a
// scripted loop trying to balloon the DB bounces off quickly (orphans are
// additionally GC'd after 24h). Per-user keyed for shared-NAT fairness.
const feedbackVideoLimiter = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 10,
  name: 'feedback-video-upload',
  keyByUser: true,
  message: 'Too many video uploads. Slow down for a few minutes.',
});

// #2520: feedback submissions (POST /api/feedback). The route's two
// siblings above were limited from the start and this one was not, so a
// signed-in user could loop it and mint an unbounded stream of real
// GitHub issues on live repos, each one also paying for a Haiku title
// call out of the shared LLM budget.
//
// #2669 raised it from 10/hour to 30. The original sizing argued that "the
// offline outbox that replays queued reports caps itself at 10 entries, so
// 10 / hour clears a full flush and still never bites". The premise is
// right and the conclusion does not follow: the outbox's MAX_ENTRIES is
// exactly 10 (public/js/feedback-queue.js), so a full flush spends the
// ENTIRE hour's budget, and the next report — the one the person is
// typing now, having just come back online — is refused. It cleared the
// flush and then bit immediately, which is how this got reported.
//
// 30 leaves a full flush at a third of the budget, so twenty live reports
// still fit behind it. A scripted loop still bounces, which is the point:
// the bound exists for the outbound GitHub writes and the shared Haiku
// spend, and neither is something thirty an hour threatens.
//
// Every attempt counts, deliberately — unlike issueCreateLimiter this one
// does NOT refund failures. The expensive half of the route (title
// generation) runs before the GitHub call, so a 502 from a repo the bot
// cannot reach has already spent a Haiku call; refunding it would leave
// exactly that loop unbounded. Admins are not exempt for the same reason:
// the cost here is outbound and shared. Per-user keyed for shared-NAT
// fairness.
const FEEDBACK_SUBMITS_PER_HOUR = 30;
const feedbackSubmitLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: FEEDBACK_SUBMITS_PER_HOUR,
  name: 'feedback-submit',
  keyByUser: true,
  // Interpolated rather than written twice: this message is what the
  // person actually reads, and a message that disagrees with the limit is
  // worse than no message at all.
  message: (s) => `Rate limit reached: up to ${FEEDBACK_SUBMITS_PER_HOUR} issue reports per hour.`
    + ` You can try again ${retryPhrase(s)}.`,
});

// Profile customization writes (issue #982): PATCH /api/me/profile plus
// the avatar upload/delete pair share ONE bucket at 20 / minute / user.
// Honest editing is a handful of saves per sitting — even fiddling with a
// display name and re-cropping a photo a few times stays well under it —
// while a scripted loop of ≤1 MB bytea upserts bounces off quickly. Shared
// rather than split because the avatar write is the expensive one and a
// caller who is rate-limited on it has no business hammering the text
// fields either. Per-user keyed for shared-NAT fairness.
const profileWriteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 20,
  name: 'profile-write',
  keyByUser: true,
  message: 'Too many profile updates. Slow down for a minute.',
});

// The waiting room's two optional questions (#5261): POST
// /api/auth/waiting/about, which writes the account's own waitlist row. A
// person answers once, maybe twice; 10 per 15 minutes per user leaves room
// for a change of mind and none for a loop.
const waitlistAnswersLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  name: 'waitlist-answers',
  keyByUser: true,
  message: 'Too many saves. Try again in a few minutes.',
});

// Username changes: 5 / hour / user. The 30-day cooldown in
// src/services/usernames.js is the real policy — this bucket exists for the
// REJECTED attempts the cooldown never reaches. Every call bcrypt-compares
// the current password, so an unthrottled endpoint is both a password
// oracle and 5 rejected-name probes worth of KDF per request. Per-user
// keyed: the caller is always authenticated here.
const usernameChangeLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  name: 'username-change',
  keyByUser: true,
  message: 'Too many username attempts. Try again in a little while.',
});

// The FIRST username choice (#2563): 20 / hour / user. Deliberately looser
// than usernameChangeLimiter above, because the two endpoints defend
// different things. A rename bcrypt-compares the current password on every
// call, so five is already five KDFs and a password oracle; the first
// choice takes no password at all (an email-code account may have none)
// and its rejections are the NORMAL path — somebody at a blocking
// first-run screen will try "ada", "ada_l", "adalovelace" before one is
// free, and a person who cannot get past the gate cannot use the platform.
// Still bounded: the gate closes for good on the first success, so a
// signed-in account gets one run of 20 attempts per hour and no more.
const usernameChooseLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  name: 'username-choose',
  keyByUser: true,
  message: 'Too many username attempts. Try again in a little while.',
});

// Priority / assignee attribute votes: 60 / minute / user. Loose enough
// that switching your pick a few times never bumps it, tight enough to
// stop a scripted vote-spam loop. Per-user keyed for shared-NAT fairness.
const attributeVoteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'attribute-vote',
  keyByUser: true,
  message: 'Too many updates. Slow down for a minute.',
});

// #2525: GOVERNANCE votes — POST /api/sessions/:id/vote and
// POST /api/issues/:id/vote. 30 / minute / user. DELETE
// /api/sessions/:id/vote (taking a vote back, the review flow's Undo)
// shares the bucket: it posts a thread line too, and vote, undo, vote is
// the flip loop by another road.
//
// These had no limiter at all, and unlike the attribute vote above a
// governance vote is not a quiet field update: every CHANGED vote posts a
// `vote` system line into the proposal's own thread (`sendSystemMessage`),
// broadcasts a tally push and notifies. Casting the SAME vote twice is
// already short-circuited as `unchanged`, so the spam shape is a FLIP —
// yes, no, yes, no — and each flip is another line in the thread and
// another notification for everyone reading it.
//
// Tighter than attributeVoteLimiter's 60 because of that thread line, and
// loose enough for the one workflow that is legitimately fast: the
// Workshop's Needs-you deck answers with the Y and N keys, so a reader
// clearing a queue votes quickly. Nobody reads and answers more than 30
// proposals in a minute, so an honest voter never meets this and a scripted
// flipper stops at 30 lines instead of thousands.
//
// One bucket for both routes on purpose: they are the same act with the
// same blast radius, and a user who has cast 30 votes in a minute is not
// being starved of the other kind — they are being asked to slow down.
// Per-user keyed for shared-NAT fairness; failed requests are refunded so a
// 400 or a 404 never costs budget. Admins are NOT exempt: an admin flipping
// a vote floods the same thread as anyone else, and no admin workflow needs
// to vote in bulk.
const governanceVoteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 30,
  name: 'governance-vote',
  keyByUser: true,
  skipFailedRequests: true,
  message: 'Too many votes. Slow down for a minute.',
});

// #613: drag-and-drop reorder of Dev-board cards. Dragging is bursty (a
// tester can reshuffle a column several times in a few seconds), so the
// window is generous but still caps a scripted write loop. Per-user keyed,
// mirroring attributeVoteLimiter.
const boardOrderLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'board-order',
  keyByUser: true,
  message: 'Too many reorder updates. Slow down for a minute.',
});

// Free-form home-grid placement: one PUT per completed drag, and a drag is a
// deliberate gesture rather than a keystroke. Rearranging a home screen is
// bursty — someone tidying their grid can easily land twenty drops in a
// minute, and each also has to survive a breakpoint switch re-persisting.
// Per-user keyed; the layout is per-user by definition.
const homeLayoutLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'home-layout',
  keyByUser: true,
  message: 'Too many layout changes. Slow down for a minute.',
});

// #940: saved dev-chat drafts, now server-backed. One write per deliberate
// save / trash / send, plus a burst when a device that was offline flushes
// its local mirror on reconcile (bounded by MAX_SAVED_DRAFTS = 20 posts +
// its tombstones). 60/min per user clears that flush with room to spare and
// still bounds a runaway client. Per-user keyed, mirroring boardOrderLimiter
// — drafts belong to the account, not to an IP.
// Creating an agent session (#2779): no worker and no model call, so this is
// a bound on litter, not on spend. Generous for a person, low for a script.
const agentSessionCreateLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 60,
  name: 'agent-session-create',
  keyByUser: true,
  message: 'Too many new agent sessions. Try again later.',
});

const draftWriteLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'chat-drafts',
  keyByUser: true,
  message: 'Too many draft updates. Slow down for a minute.',
});

// Platform database export tickets: 3 / 24h / full admin. Each ticket
// authorizes ONE full, unredacted pg_dump of the platform database — every
// password hash, every live session token, every app credential — so the
// budget is deliberately tiny and the window is a whole day.
//
// exemptAdmins IS DELIBERATELY OMITTED AND MUST STAY OMITTED. The option
// skips the limiter for anyone with canAdminWrite (see makeLimiter above),
// which is EXACTLY the population this limiter exists to bound — the route
// is already full-admin-only, so setting it would disable the limit
// entirely. Do not "make it consistent" with its neighbours.
//
// skipFailedRequests refunds anything ≥ 400, so a mistyped confirmation
// password doesn't burn one of the three slots (the denied attempt is
// still written to the db_exports audit table either way). Per-user keyed:
// the budget belongs to the admin, not to their IP.
const dbExportLimiter = makeLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  name: 'db-export',
  keyByUser: true,
  skipFailedRequests: true,
  message: (s) => `Rate limit reached: up to 3 database exports per day. You can try again ${retryPhrase(s)}.`,
});

// Authenticated device-state synchronization. Normal lifecycle traffic is a
// handful of writes; this prevents a stolen bearer from churning encrypted
// registrations and delivery FKs in a tight loop.
const topochainMobilePushRegistrationLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'topochain-mobile-push-registration',
  // /api/v4 answers every other error with the envelope (#2526 follow-up).
  v4Envelope: true,
  keyByUser: true,
  message: 'Too many push registration updates. Slow down for a minute.',
});

const WAITLIST_WINDOW_MS = 15 * 60 * 1000;
const MORE_TOKEN_RE = /^[a-f0-9]{48}$/;

// Public waitlist join, no integration key: 5 / 15 min / IP. Anonymous write
// endpoint on the landing page — tight enough to stop bulk email harvesting
// and spam, loose enough that a genuine visitor retrying a typo never hits
// it. This is the bucket every unkeyed caller lands in, unchanged.
const waitlistJoinAnonLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 5,
  name: 'waitlist-join',
  message: 'Too many signups from this address. Try again in a few minutes.',
});

// A trusted integrator (see services/waitlist-integrator) proxies many
// distinct people through one server address, so the IP bucket above would
// cap an entire agency at five signups per window. Two buckets replace it,
// and BOTH are charged:
//
//   * per end user, when the integrator forwards a usable visitor address —
//     the same 5 / 15 min a direct visitor gets, so a keyed request is never
//     LOOSER for the person making it;
//   * per client, always — a 200 / 15 min ceiling so a leaked key is a
//     bounded faucet rather than an open one.
//
// With no forwarded address there is nothing finer to key on, so the client
// ceiling is the only bound; that is the cost of not forwarding one.
const waitlistJoinClientLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 200,
  name: 'waitlist-join-client',
  key: (req) => `wl:${req.waitlistIntegrator?.label || 'unknown'}`,
  message: 'Too many signups from this integration. Try again in a few minutes.',
});

const waitlistJoinClientUserLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 5,
  name: 'waitlist-join-client-user',
  key: (req) => (req.waitlistEndUserIp
    ? `wl:${req.waitlistIntegrator?.label || 'unknown'}:${req.waitlistEndUserIp}`
    : null),
  message: 'Too many signups from this address. Try again in a few minutes.',
});

// Dispatch on trusted-integrator status, same shape as issueKindLimiter.
// waitlistIntegratorAuth runs earlier in the chain and only ever ATTACHES
// req.waitlistIntegrator, so an absent/expired/wrong key simply falls back
// to the anonymous bucket instead of erroring.
function waitlistJoinLimiter(req, res, next) {
  if (!req.waitlistIntegrator) return waitlistJoinAnonLimiter(req, res, next);
  return waitlistJoinClientLimiter(req, res, (err) => {
    if (err) return next(err);
    if (!req.waitlistEndUserIp) return next();
    return waitlistJoinClientUserLimiter(req, res, next);
  });
}

// Waitlist token routes (confirm link, stage-2 survey read/save): these are
// authenticated by an unguessable 48-hex token, so the bucket only has to
// bound token scanning, not stop a genuine visitor. Kept separate from
// waitlist-join on purpose — one real journey (join, survey save, emailed
// confirm click, survey reload) makes 5+ requests, which used to exhaust the
// 5/15-min join bucket and bounce the user's own confirm link (#1296).
//
// Keyed on the TOKEN, not the address: a shared exit address (an office, a
// carrier NAT, a corporate proxy) put every stage-2 visitor in one 60-request
// bucket, and the #more screen polls while it waits for a confirmation. One
// person's poll could throttle a stranger's. Falls back to the IP key when
// there is no path token, which is how POST /confirm (email + code, no token)
// stays covered by this same limiter.
const waitlistTokenLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 240,
  name: 'waitlist-token',
  key: (req) => (MORE_TOKEN_RE.test(req.params?.token || '') ? `token:${req.params.token}` : null),
  message: 'Too many requests for this link. Try again in a few minutes.',
});

// Per-token keying is not by itself an enumeration defence: a scanner
// presents a DIFFERENT token every request, so it would get a fresh bucket
// each time. This is the half that bounds scanning, and it is the reason the
// two are mounted together on every token route.
//
// skipSuccessfulRequests is what makes 40 a safe number: a scan necessarily
// 404s, while an honest visitor holding a real token essentially never fails,
// so their reads and saves are refunded and never approach the ceiling.
const waitlistTokenScanLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 40,
  name: 'waitlist-token-scan',
  skipSuccessfulRequests: true,
  message: 'Too many waitlist requests from this address. Try again in a few minutes.',
});

// POST /api/public/waitlist/confirm carries an email and a six-digit code
// and no token, so the scan limiter above is its only per-address bound —
// and 40 failures is far too much room for a 6-digit code against one known
// address. Bucket per address instead: 10 attempts / 15 min.
//
// The key is a SHA-256 of the normalized email, never the address itself:
// limiter keys live in memory keyed by string and show up in nothing that is
// logged, and a hash keeps it that way while still bucketing exactly.
const waitlistCodeConfirmLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 10,
  name: 'waitlist-code-confirm',
  key: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) return null;
    return `email:${crypto.createHash('sha256').update(email).digest('hex')}`;
  },
  message: 'Too many code attempts for that address. Try again in a few minutes.',
});

// POST /api/public/waitlist/resend mints a code and mails it, so its bucket
// is guarding an outbound send rather than a guess. Two of them, because the
// two abuses are different shapes:
//
//   * per ADDRESS (5 / 15 min) — the mail-bomb: a distributed caller aiming
//     an unbounded stream of mail at one inbox. Keyed on the address, so it
//     holds no matter where the requests come from. It sits just under the
//     mail throttle's own 5-per-day-per-recipient rule, so the ceiling a
//     determined caller actually meets is the one that bounds the sending.
//   * per IP (10 / 15 min) — the sweep: one caller walking a list of
//     addresses, each of which is under its own limit.
//
// Both are silent as far as the caller can tell: a 429 here is the standard
// limiter body, and it is reached by REQUEST COUNT, never by anything about
// whether the address is on the list. The endpoint itself answers the same
// 200 to every branch.
//
// The key is a SHA-256 of the normalized address, matching
// waitlistCodeConfirmLimiter above — limiter keys live in memory as plain
// strings, and hashing keeps a raw address out of that while still bucketing
// exactly.
const waitlistResendLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 5,
  name: 'waitlist-resend',
  key: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) return null;
    return `email:${crypto.createHash('sha256').update(email).digest('hex')}`;
  },
  message: 'Too many code requests for that address. Try again in a few minutes.',
});

const waitlistResendIpLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 10,
  name: 'waitlist-resend-ip',
  message: 'Too many code requests from this address. Try again in a few minutes.',
});

// POST /api/public/waitlist/status reads where one address stands and writes
// nothing, mails nothing and mints nothing. So what its buckets bound is not
// a send or a guess but an ORACLE: the endpoint answers honestly (the
// disclosure decision recorded on the join route, #2201), which means the
// only thing standing between it and someone walking a list of addresses is
// how many lookups a caller gets.
//
// Two of them, the same pair of shapes the resend route splits on:
//
//   * per IP (10 / 15 min) — the sweep, one caller working through a list.
//     Deliberately the same number as waitlistResendIpLimiter: the abuse is
//     identical in shape, and honest use here is one or two lookups.
//   * per ADDRESS (10 / 15 min) — one address hammered from many places,
//     which a per-IP bucket alone cannot see.
//
// The key is a SHA-256 of the normalized address, matching
// waitlistCodeConfirmLimiter and waitlistResendLimiter — limiter keys live in
// memory as plain strings, and hashing keeps a raw address out of that while
// still bucketing exactly.
const waitlistStatusIpLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 10,
  name: 'waitlist-status-ip',
  message: 'Too many status checks from this address. Try again in a few minutes.',
});

const waitlistStatusLimiter = makeLimiter({
  windowMs: WAITLIST_WINDOW_MS,
  max: 10,
  name: 'waitlist-status',
  key: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) return null;
    return `email:${crypto.createHash('sha256').update(email).digest('hex')}`;
  },
  message: 'Too many status checks for that address. Try again in a few minutes.',
});

// Exact public-profile reads deliberately have no directory/search endpoint;
// this IP bucket additionally bounds brute-force username enumeration.
const publicProfileReadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'public-profile-read',
  message: 'Too many profile lookups. Slow down for a minute.',
});

// A public project's read-only page for somebody with no account
// (GET /api/public/apps/:slug/overview, services/public-project.js). Public
// and a few queries plus a cached GitHub read each, so a scraper cannot walk
// every project faster than this; a person opens a handful a minute.
const publicProjectReadLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'public-project-read',
  message: 'Too many project lookups. Slow down for a minute.',
});

const profileReportLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: 'profile-report',
  keyByUser: true,
  skipFailedRequests: true,
  message: 'Too many profile reports. Try again later.',
});

// Admin "send a test email": 10 / hour / full admin. This is the one
// route where an authenticated operator can aim platform mail at an
// address of their choosing, so it gets its own small budget on top of
// the per-recipient rule in services/mail/rate-limit.js — that one bounds
// how often ONE address can be tested, this one bounds how many addresses
// one admin can work through.
//
// exemptAdmins is deliberately omitted, for the same reason as the export
// limiter above: the route is already full-admin-only, so exempting
// admins would disable the limit entirely. keyByUser, because the budget
// belongs to the operator rather than to the office they sit in.
// skipFailedRequests refunds the 400 a malformed address earns, so
// fixing a typo doesn't cost a slot.
const mailTestLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: 'mail-test',
  keyByUser: true,
  skipFailedRequests: true,
  message: (s) => `Rate limit reached: up to 10 test emails per hour. You can try again ${retryPhrase(s)}.`,
});

// Admin "send a test SMS" (Admin → SMS delivery): each one is a real text
// Firebase bills for, aimed at a number of the operator's choosing. Two
// buckets, the mail test's shape: 5 / hour / full admin bounds how many
// numbers one admin works through, and 1 / minute / number keeps a run of
// clicks from tripping Firebase's own per-number throttle (which would
// lock that number out of real sign-in for a while too). Neither exempts
// admins: the route is full-admin-only, so that would disable them.
// skipFailedRequests refunds the 400 a malformed number earns.
const smsTestLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  name: 'sms-test',
  keyByUser: true,
  skipFailedRequests: true,
  message: (s) => `Rate limit reached: up to 5 test texts per hour. You can try again ${retryPhrase(s)}.`,
});

// Punctuation stripped before hashing, so `+44 7700 900123` and
// `+447700900123` are the one number they are.
const smsTestNumberLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 1,
  name: 'sms-test-number',
  skipFailedRequests: true,
  key: (req) => identifierKey('sms-test',
    typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber.replace(/[^\d+]/g, '') : ''),
  message: (s) => `A test text was just sent to that number. You can try again ${retryPhrase(s)}.`,
});

// AI progress report generation (Reporting tab): each click is a paid LLM
// call debited to the clicking user, and report-ai.js already serializes
// real work per app — this only stops a stuck client from hammering the
// button. Per-user keyed: the spend belongs to the account, not to an IP.
const reportAiLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 4,
  name: 'report-ai',
  keyByUser: true,
  message: 'Please wait a minute before regenerating the report.',
});

// UI-experience telemetry arrives in batches of at most 25 observations.
// Sixty batches a minute leaves ample room for retries and several active
// tabs while bounding authenticated accounts that manufacture traffic. Failed
// validation/refused requests are refunded so a client fixing its payload is
// not locked out. The collector treats a 429 as delivery failure and retries
// later; telemetry never blocks the user journey it describes.
const uiTelemetryLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'ui-telemetry',
  keyByUser: true,
  // The collector discards these fixed browser-check identities, so do not
  // throttle data we intentionally throw away. Every retained human account,
  // including human admins, keeps the exact same per-user limit.
  skip: (req) => !!req.user?.id && !uiTelemetry.isEligibleUser(req.user),
  skipFailedRequests: true,
  message: 'Telemetry is arriving too quickly. It will retry shortly.',
});

// The made screen's moments (services/first-session-moments.js): one small
// POST per thing it showed or was tapped, from a maker's own first session.
// A whole session sends a dozen or two, the tour's cards a few seconds
// apart at the quickest, so 60 a minute per account is far past it and
// short of a client stuck in a loop. Refused requests (a malformed moment,
// a non-member) are refunded. The screen never waits on it: a 429 is a lost
// row, never a stalled tap.
const firstSessionMomentLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 60,
  name: 'first-session-moments',
  keyByUser: true,
  skipFailedRequests: true,
  message: 'Too many at once. Give it a minute.',
});

// The Needs-you deck's ask box (services/workshop-ask.js): 12 / minute /
// user. Every press is an LLM call billed to the asker, and unlike the
// report there is no shared cache to fall back on — each question is its
// own spend. Twelve is well past a person working through a vote queue
// (the deck holds one card at a time and a question takes a while to read)
// and short of a stuck client burning an allowance a keystroke at a time.
// Per-user keyed: the budget being protected is per-user too.
const workshopAskLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 12,
  name: 'workshop-ask',
  keyByUser: true,
  message: 'Too many questions at once. Give it a minute.',
});

// Locking a report writes a multi-hundred-KB row per click; share and
// unshare are cheap but share the same per-user budget so a stuck client
// can't hammer any of the three verbs. Per-user keyed like report-ai.
const reportSnapshotLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 10,
  name: 'report-snapshot',
  keyByUser: true,
  message: 'Please wait a minute before locking or sharing more reports.',
});

// App-directory reads relayed through the shell bridge (#1195): 120 /
// min / user, shared across lookup and search. A typeahead fires per
// keystroke, so the ceiling is generous; keyed per user (not per IP) so
// one office NAT can't throttle a building, and matched to the
// per-(app,user) budget the app-token twin of these endpoints uses in
// routes/app-platform-api.js.
const userDirectoryLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'user-directory',
  keyByUser: true,
  message: 'Too many directory lookups. Please slow down.',
});

// #3660: the cards Homeroom links in a message stand for (POST
// /api/link-cards). A transcript asks once for the links on screen, ten to a
// request, and keeps the answers, so scrolling a busy discussion is a
// handful of requests a minute; the ceiling is for a client gone wrong.
// Per user: every reader asks for their own view.
const linkCardLimiter = makeLimiter({
  windowMs: 60 * 1000,
  max: 120,
  name: 'link-cards',
  keyByUser: true,
  message: 'Too many link previews. Please slow down.',
});

const dictationLimiter = makeLimiter({ windowMs: 60000, max: 12, name: 'dictation', keyByUser: true,
  message: 'Too many recordings. Try again in a minute.' });

module.exports = { dictationLimiter, FEEDBACK_SUBMITS_PER_HOUR, linkCardLimiter, benchGradingLimiter, benchRunLimiter, benchStudioLimiter, challengeAdminLimiter, testAccountLimiter, inviteLinkCreateLimiter, inviteRedeemLimiter, invitePreviewLimiter, emojiTileLimiter, agentSessionCreateLimiter, appAllowanceRequestLimiter, topochainMobileReadLimiter, partnerActivityLimiter, partnerActivityParticipantLimiter, explorerProxyLimiter, githubLookupLimiter, userDirectoryLimiter, dbExportLimiter, loginBurstLimiter, loginSustainedLimiter, loginIdentityLimiter, registerLimiter, otpRequestLimiter, otpRequestEmailLimiter, otpVerifyLimiter, usernameCheckLimiter, releaseLinkLimiter, phoneOtpRequestLimiter, phoneOtpRequestPhoneLimiter, phoneVerifyLimiter, oauthSignInLimiter, passwordResetRequestLimiter, passwordResetRequestEmailLimiter, passwordResetConfirmLimiter, walletAuthLimiter, mobileWalletClaimLimiter, homeLayoutLimiter, draftWriteLimiter, walletCheckLimiter, appCreateLimiter, issueCreateLimiter, closeProposalLimiter, issueKindLimiter, agentFileWriteLimiter, chatLimiter, groupChatWriteLimiter, conversationMessageLimiter, conversationActionLimiter, conversationSafetyLimiter, conversationInviteLimiter, conversationReactionLimiter, conversationReportLimiter, friendshipLimiter, messageBookmarkLimiter, notificationBookmarkLimiter, appChatReadLimiter, attributeVoteLimiter, governanceVoteLimiter, attachmentUploadLimiter, appFileUploadLimiter, feedbackTitleLimiter, feedbackSubmitLimiter, boardOrderLimiter, issueScreenshotLimiter, requestSpecLimiter, feedbackVideoLimiter, profileWriteLimiter, usernameChangeLimiter, usernameChooseLimiter, publicProfileReadLimiter, publicProjectReadLimiter, profileReportLimiter, topochainMobilePushRegistrationLimiter, reportAiLimiter, uiTelemetryLimiter, firstSessionMomentLimiter, workshopAskLimiter, reportSnapshotLimiter, waitlistJoinLimiter, waitlistJoinAnonLimiter, waitlistJoinClientLimiter, waitlistJoinClientUserLimiter, waitlistTokenLimiter, waitlistTokenScanLimiter, waitlistCodeConfirmLimiter, waitlistResendLimiter, waitlistResendIpLimiter, waitlistStatusLimiter, waitlistStatusIpLimiter, waitlistAnswersLimiter, smsTestLimiter, smsTestNumberLimiter, mailTestLimiter };
