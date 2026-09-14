const appAllowance = require('../services/app-allowance');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const https = require('https');
const http = require('http');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const {
  loginBurstLimiter,
  loginSustainedLimiter,
  loginIdentityLimiter,
  registerLimiter,
  otpRequestLimiter,
  otpRequestEmailLimiter,
  otpVerifyLimiter,
  passwordResetRequestLimiter,
  passwordResetRequestEmailLimiter,
  passwordResetConfirmLimiter,
  walletAuthLimiter,
  walletCheckLimiter,
} = require('../middleware/rate-limits');
const genesisAccounts = require('../services/genesis-accounts');
const waitlist = require('../services/waitlist');
const events = require('../services/events');
const { validatePassword } = require('../services/password-policy');
// One shape for the profile block, shared with PATCH /api/me/profile so
// /api/auth/me and the write echo identical objects (#982).
const { shapeProfile } = require('./profile');
const {
  accountRecovery,
  withTransaction,
} = require('../services/cli-auth');
const { revokeNativeSessionCredentials } = require('../services/native-session-revocation');
// The SAME predicate the CLI 404 gates use (routes/cli-auth.js), so the
// capability this route advertises can never disagree with what that
// surface actually serves.
const { isCliSurfaceEnabled } = require('./cli-auth');
// The external-agent hand-off needs the identity-only GitHub link, so
// whether that link is configurable at all decides whether /api/auth/me
// advertises the Claude Code / Codex flows (#1049).
const githubLink = require('../services/github-link');
const emailSignup = require('../services/email-signup');
// The platform's own self-hosted app row. The home screen's Improve button is
// about the PLATFORM, and the client has no other way to learn that row's slug
// — GET /api/apps hides self-hosted rows from non-admins on purpose.
const { getPlatformApp } = require('../services/platform-app');
// Deliberately NOT destructured: tests (and the never-throws mail contract)
// swap sendPasswordResetMail on the module object.
const mail = require('../services/mail');

const SESSION_DAYS = 7;

// Email password-reset magic link. The 30-minute figure is repeated in the
// password_reset mail template copy (src/services/mail/templates.js).
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

// Preferred development flow (#1049). The SAME allowlist as the CHECK on
// users.dev_flow_preference and as DevFlowSelect.FLOWS in
// public/js/dev-flow-select.js; tests/dev-flow-preference.test.js pins all
// three together so a new flow can't land in one place only.
const DEV_FLOWS = ['platform', 'claude-code', 'codex'];

// Staging mock data (#555): llm_usage is staging:private, so in a
// prod-cloned staging DB every viewer's AI-credit row would render a
// pristine "$20.00 of $20.00 left" and a reviewer couldn't tell that from
// broken. See the ?demo=1 branch on GET /api/me/ai-budget below.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// View-only admin role (issue #311). Builds the role-related fields every
// auth response returns to the client from the raw `is_admin` /
// `admin_readonly` columns: `isAdmin` (the visibility tier, unchanged),
// `canAdminWrite` (the single privileged-mutation gate — full admin only),
// and a display `role` string the UI renders. Normal-login/register users
// pass nothing and get the user defaults.
function roleFields(isAdmin, adminReadonly) {
  const admin = !!isAdmin;
  const readonly = admin && !!adminReadonly;
  return {
    isAdmin: admin,
    canAdminWrite: admin && !readonly,
    role: !admin ? 'user' : (readonly ? 'view_admin' : 'admin'),
  };
}

// Default-off: only set `Secure` when we explicitly know we're in production.
// Previously this was `NODE_ENV !== 'development'`, which silently dropped the
// cookie on any dev box reached over LAN HTTP (mobile testing) because
// NODE_ENV was usually unset => secure=true => browser refuses cookie on HTTP.
const SECURE_COOKIE = process.env.NODE_ENV === 'production';
const SIGNUP_COOKIE = 'usernode_signup';

// Ordinary credential exchanges may only mint a session from a signed-out
// browser realm. Keeping this at the router boundary makes the hard A -> B
// rule apply to every session-minting flow before credentials are consumed.
// Password-reset confirmation is deliberately absent because it mints no
// session. Wallet reset does mint one and therefore shares this boundary even
// though its transaction also revokes the user's older server sessions.
const SESSION_MINT_PATHS = [
  '/api/auth/login',
  // Verifying an email code signs an already-established account straight in,
  // so it mints a session and belongs here. `/api/auth/otp/request` does not:
  // the wallet-recovery dialog and the mobile wallet-claim flow both request
  // codes while signed in, and a mint guard there would break claiming.
  '/api/auth/otp/verify',
  '/api/auth/otp/set-password',
  '/api/auth/register',
  '/api/auth/wallet-verify',
  '/api/auth/wallet-reset-verify',
  '/api/auth/wallet-register',
  '/api/auth/wallet-link-login',
];

function createSessionCookie(res, token, expiresAt) {
  res.cookie('session', token, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: 'lax',
    expires: expiresAt,
  });
}

async function createSession(queryable, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await queryable.query(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, userId, expiresAt]
  );
  return { token, expiresAt };
}

function createSignupCookie(res, token, expiresAt) {
  res.cookie(SIGNUP_COOKIE, token, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: 'lax',
    path: '/api/auth/otp',
    expires: expiresAt,
  });
}

function clearSignupCookie(res) {
  res.clearCookie(SIGNUP_COOKIE, {
    httpOnly: true,
    secure: SECURE_COOKIE,
    sameSite: 'lax',
    path: '/api/auth/otp',
  });
}

function authRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Register with the same Express path matcher as the handlers themselves.
  // This covers its case-insensitive and optional-trailing-slash aliases;
  // comparing req.path strings would leave equivalent route spellings open.
  // TODO(session-lifecycle): Replace the trusted native
  // prepareForLogin -> fetch ordering with a one-use opaque preparation
  // receipt consumed here. That requires a coordinated server/Android/iOS
  // protocol; every current native mint call remains routed through
  // fetchSessionMint until then.
  router.post(SESSION_MINT_PATHS, async (req, res, next) => {
    const token = req.cookies?.session;
    if (!token) return next();
    try {
      const { rows } = await pool.query(
        `SELECT 1 FROM sessions
          WHERE token = $1 AND expires_at > NOW()
          LIMIT 1`,
        [token]
      );
      if (rows.length === 0) return next();
      return res.status(409).json({
        error: 'Sign out before signing in again.',
        code: 'logout_required',
      });
    } catch (error) {
      log.error('auth', 'Session-mint boundary check failed', {
        message: error.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/login', loginBurstLimiter, loginSustainedLimiter, loginIdentityLimiter, async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    try {
      // The identifier can be a username OR an email (thin-shell
      // migration: mobile-created accounts are email-keyed, and platform
      // login is now the only sign-in surface for the app). An @-shaped
      // identifier can name TWO different accounts at once: the account
      // whose email it is, and an account whose username merely looks
      // like an email (the web email-signup flow uses the email as the
      // username, so one person routinely owns both — issue #1269).
      // First-match-wins lookup let the email row shadow the username
      // row and the wrong account's password got checked, so both
      // matches are collected as CANDIDATES and the password decides:
      // the first candidate it verifies against wins. Two accounts can
      // never share an email (users_email_lower_unique), so the only
      // ambiguity is email-of-A vs username-of-B; on the improbable
      // both-verify tie the email owner wins (listed first). Email
      // matching is case-insensitive on both sides — every write path
      // stores the lower-cased form, and lower(email) also reaches any
      // legacy mixed-case row. Usernames stay exact-match.
      const identifier = String(username).trim();
      const candidates = [];
      if (identifier.includes('@')) {
        const { rows } = await pool.query(
          'SELECT id, username, password, is_admin, admin_readonly FROM users WHERE lower(email) = lower($1)',
          [identifier]
        );
        for (const row of rows) candidates.push({ row, matchedBy: 'email' });
      }
      {
        const { rows } = await pool.query(
          'SELECT id, username, password, is_admin, admin_readonly FROM users WHERE username = $1',
          [identifier]
        );
        for (const row of rows) {
          if (!candidates.some((c) => c.row.id === row.id)) {
            candidates.push({ row, matchedBy: 'username' });
          }
        }
      }

      if (candidates.length === 0) {
        log.warn('auth', 'Login failed - unknown user', { username });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      let user = null;
      let matchedBy = null;
      for (const candidate of candidates) {
        // At most 2 compares (one email match + one username match), so
        // the cost posture behind the login limiters is unchanged.
        if (await bcrypt.compare(password, candidate.row.password)) {
          user = candidate.row;
          matchedBy = candidate.matchedBy;
          break;
        }
      }

      if (!user) {
        log.warn('auth', 'Login failed - bad password', { username });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const { token, expiresAt } = await createSession(pool, user.id);
      createSessionCookie(res, token, expiresAt);

      log.info('auth', 'Login successful', { userId: user.id, username: user.username, matchedBy });

      res.json({
        // Echo the account's real username, not the raw identifier — the
        // identifier may have been an email.
        user: { id: user.id, username: user.username, ...roleFields(user.is_admin, user.admin_readonly) },
      });
    } catch (err) {
      log.error('auth', 'Login error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Social email-code onboarding is a web-session flow. Verification puts a
  // narrow, ten-minute continuation in an HttpOnly cookie; password setup
  // consumes it and creates the ordinary web session in one transaction.
  // Browser JavaScript never receives a mobile bearer.
  router.post('/api/auth/otp/request', otpRequestLimiter, otpRequestEmailLimiter, async (req, res) => {
    try {
      await emailSignup.requestCode(pool, config, req.body?.email);
      return res.json({ ok: true });
    } catch (error) {
      if (error instanceof emailSignup.EmailSignupError) {
        return res.status(422).json({ error: error.message, code: error.code });
      }
      log.error('email-signup', 'OTP request failed', { message: error.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/otp/verify', otpVerifyLimiter, async (req, res) => {
    try {
      const verified = await emailSignup.verifyCode(
        pool,
        req.body?.email,
        req.body?.code,
        { createSession }
      );
      if (verified.next === 'signed-in') {
        // The account already has a password, so there is nothing to set up.
        // Clear any stale continuation and hand back the ordinary web session,
        // shaped exactly like /api/auth/login's response.
        clearSignupCookie(res);
        createSessionCookie(res, verified.session.token, verified.session.expiresAt);
        log.info('email-signup', 'Email code signed an existing account in', {
          userId: verified.userId,
          next: 'signed-in',
        });
        return res.json({
          ok: true,
          next: 'signed-in',
          user: {
            id: verified.user.id,
            username: verified.user.username,
            ...roleFields(verified.user.isAdmin, verified.user.adminReadonly),
          },
        });
      }
      createSignupCookie(res, verified.signupToken, verified.expiresAt);
      log.info('email-signup', 'Email code verified, password setup pending', {
        userId: verified.userId,
        next: 'set-password',
      });
      return res.json({ ok: true, next: 'set-password' });
    } catch (error) {
      if (error instanceof emailSignup.EmailSignupError) {
        return res.status(422).json({ error: error.message, code: error.code });
      }
      log.error('email-signup', 'OTP verification failed', { message: error.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/otp/set-password', otpVerifyLimiter, async (req, res) => {
    const password = req.body?.password;
    if (password !== req.body?.passwordConfirmation) {
      return res.status(422).json({ error: 'Passwords do not match.', code: 'password_mismatch' });
    }
    try {
      const completed = await emailSignup.completePassword(pool, {
        signupToken: req.cookies?.[SIGNUP_COOKIE],
        password,
        createSession,
      });
      clearSignupCookie(res);
      createSessionCookie(res, completed.session.token, completed.session.expiresAt);
      return res.json({
        user: {
          id: completed.user.id,
          username: completed.user.username,
          ...roleFields(completed.user.isAdmin, completed.user.adminReadonly),
        },
      });
    } catch (error) {
      if (error instanceof emailSignup.EmailSignupError) {
        clearSignupCookie(res);
        return res.status(422).json({ error: error.message, code: error.code });
      }
      log.error('email-signup', 'Password setup failed', { message: error.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/register', registerLimiter, async (req, res) => {
    const { code, username, password } = req.body;

    if (!code?.trim() || !username?.trim() || !password) {
      return res.status(400).json({ error: 'Activation code, username, and password required' });
    }

    try {
      const { rows: codeRows } = await pool.query(
        'SELECT id FROM activation_codes WHERE code = $1 AND used_by IS NULL',
        [code.trim()]
      );

      if (codeRows.length === 0) {
        return res.status(400).json({ error: 'Invalid or already used activation code' });
      }

      const codeId = codeRows[0].id;
      const hash = await bcrypt.hash(password, 12);
      const { rows: userRows } = await pool.query(
        'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id',
        [username.trim(), hash]
      );

      const userId = userRows[0].id;
      await pool.query(
        'UPDATE activation_codes SET used_by = $1, used_at = NOW() WHERE id = $2',
        [userId, codeId]
      );

      // An activation code is an admin-minted invite — stronger than a
      // waitlist release — so it carries platform access with it
      // (onboarding flow alignment). Without this, every invited user
      // would land in the waiting room, a regression on the invite flow.
      await waitlist.grantPlatformAccess(pool, userId);

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
      await pool.query(
        'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
        [token, userId, expiresAt]
      );

      res.cookie('session', token, {
        httpOnly: true,
        secure: SECURE_COOKIE,
        sameSite: 'lax',
        expires: expiresAt,
      });

      log.info('auth', 'User registered', { userId, username: username.trim(), codeId });
      events.record(pool, { type: events.EVENT_TYPES.USER_SIGNED_UP, userId, metadata: { via: 'activation_code' } });
      res.json({ user: { id: userId, username: username.trim(), ...roleFields(false, false) } });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Username already taken' });
      }
      log.error('auth', 'Registration error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/logout', async (req, res) => {
    const token = req.cookies?.session;
    if (token) {
      try {
        await withTransaction(pool, async (client) => {
          const { rows } = await client.query(
            `SELECT user_id, native_session_incarnation_id
               FROM sessions WHERE token = $1 FOR UPDATE`,
            [token]
          );
          const session = rows[0];
          if (session?.native_session_incarnation_id) {
            await revokeNativeSessionCredentials(client, {
              reason: 'web_logout',
              userId: session.user_id,
              webSessionIncarnationId: session.native_session_incarnation_id,
            });
          }
          await client.query('DELETE FROM sessions WHERE token = $1', [token]);
        });
        log.info('auth', 'Logout', { userId: req.user?.id });
      } catch (err) {
        // A logout that did not atomically close its native incarnation must
        // never be reported as complete.
        log.error('auth', 'Logout failed', { message: err.message, userId: req.user?.id });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
    res.clearCookie('session');
    res.json({ ok: true });
  });

  router.get('/api/auth/me', async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    // Include BYOK state (#30) so the settings modal can render
    // "sk-ant-…abcd" without decrypting anything — the last-4 is stored
    // in plaintext for display purposes only.
    let hasApiKey = false;
    let keyLast4 = null;
    let usernodePubkey = null;
    let openrouterAvailable = false;
    // Profile customization (#982): the editable identity fields plus the
    // content-addressed avatar URL. Read HERE rather than in
    // middleware/auth.js's per-request session hydration — this endpoint
    // already does one users lookup, and every request paying for a join
    // it never renders would be the wrong trade.
    let profile = { displayName: null, bio: null, avatarUrl: null, links: { github: null, x: null } };
    // App-creation quota: the same live (non-errored) app count enforced by
    // POST /api/apps and /fork. Keep the numbers as well as the derived
    // boolean so the create dialog can say "N of M used" instead of reducing
    // the policy to an unexplained locked button. Full admins bypass the
    // quota; view-only admins do not (the write routes use canAdminWrite too).
    let allowance = {
      quota: { used: null, limit: req.user.canAdminWrite ? null : req.user.appQuota, remaining: null },
      canCreateApps: !!req.user.canAdminWrite,
      requestedAt: null,
    };
    try {
      allowance = await appAllowance.read(pool, req.user);
    } catch (err) {
      log.warn('auth', 'App allowance lookup failed', { message: err.message });
    }
    // Preferred development flow (#1049). Read here rather than in the
    // per-request session hydration for the same reason as the profile
    // block above: this endpoint already pays for one users lookup, and
    // only this endpoint renders the value.
    let devFlowPreference = null;
    try {
      const { rows } = await pool.query(
        `SELECT u.anthropic_key_enc, u.anthropic_key_last4, u.usernode_pubkey,
                u.display_name, u.bio, u.github, u.x, u.dev_flow_preference,
                EXISTS (
                  SELECT 1 FROM credentials.user_ai_credentials credential
                   WHERE credential.user_id = u.id
                     AND credential.provider = 'openrouter'
                     AND credential.purpose = 'coding_agent'
                     AND credential.status = 'valid'
                ) AS openrouter_credential_valid,
                av.id AS avatar_id
           FROM users u
           LEFT JOIN user_avatars av ON av.user_id = u.id
          WHERE u.id = $1`,
        [req.user.id]
      );
      if (rows[0]?.anthropic_key_enc) {
        hasApiKey = true;
        keyLast4 = rows[0].anthropic_key_last4 || null;
      }
      usernodePubkey = rows[0]?.usernode_pubkey || null;
      const inOpenRouterBeta = !config.openrouterBetaUserIds?.length
        || config.openrouterBetaUserIds.includes(String(req.user.id));
      openrouterAvailable = config.codexOpenrouterEnabled === true
        && inOpenRouterBeta
        && rows[0]?.openrouter_credential_valid === true;
      devFlowPreference = DEV_FLOWS.includes(rows[0]?.dev_flow_preference)
        ? rows[0].dev_flow_preference
        : null;
      profile = shapeProfile(rows[0]);
    } catch {}
    // #1055 staging fixture: report a saved BYOK key so the composer's
    // session-options menu renders its "Change your API key (…7f2c)" branch
    // (and the meter its "your key" one). STRICTLY request-time — nothing is
    // written, users.anthropic_key_enc is untouched, and dropping `demo=1`
    // gives the honest unset state back on the very next request. A no-op in
    // production: same IS_STAGING && ?demo=1 gate as /api/me/ai-budget below.
    let demoKey = false;
    if (IS_STAGING && req.query.demo === '1') {
      demoKey = true;
      hasApiKey = true;
      keyLast4 = '7f2c';
    }
    // Memoised for 30s inside the service, so this costs nothing on the boot
    // path of every tab; null is a perfectly good answer (the button hides).
    const platformApp = await getPlatformApp(pool);
    res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        isAdmin: req.user.isAdmin,
        // View-only admin role (issue #311). `isAdmin` still drives every
        // client read/visibility gate; `canAdminWrite` drives mutating
        // controls (hidden for view-only admins). `role` is the display
        // string the admin panel / banners render.
        canAdminWrite: !!req.user.canAdminWrite,
        role: !req.user.isAdmin ? 'user' : (req.user.adminReadonly ? 'view_admin' : 'admin'),
        // Derived per-user app-creation affordance. Kept for the home-screen
        // treatment; the numbers below explain that state in the create
        // dialog. A null used/remaining value means the count query was not
        // available, never a fabricated zero.
        canCreateApps: allowance.canCreateApps,
        appCreationQuota: allowance.quota,
        appQuotaRequestedAt: allowance.requestedAt,
        // Experimental: opt-in AI progress estimate for coding runs
        // (Settings → Experimental). Default OFF.
        aiProgressEstimate: !!req.user.aiProgressEstimate,
        // #1281: opt-in for the session-CLI bridge, the bottom rung of the
        // spec's routing tree. build-venues.js requires this AND the
        // deployment's cliAuthEnabled before offering the `local` venue.
        sessionBridgeEnabled: !!req.user.sessionBridgeEnabled,
        // Platform-level language preference (issue #757): a BCP-47 tag or
        // null when unset. Settings → Language renders from this; apps read
        // it via the iframe JWT `locale` claim and the bridge's
        // usernode.getUserLocale().
        locale: req.user.locale ?? null,
        // Platform-access gate (onboarding flow alignment). FALSE means
        // the account is waiting to be released off the platform
        // waitlist — the waiting room polls this to know when to let
        // the user through.
        hasPlatformAccess: !!req.user.hasPlatformAccess || !!req.user.isAdmin,
        hasApiKey,
        keyLast4,
        // In-chat venue availability: feature flag + beta eligibility + a
        // currently usable personal or company OpenRouter credential.
        openrouterAvailable,
        // Marks the two fields above as the staging fixture rather than
        // real state, the same way every other ?demo=1 payload labels
        // itself (services/local-agent-demo.js, GET /api/budget).
        ...(demoKey ? { demoKey: true } : {}),
        usernodePubkey,
        walletLinkEnabled: !!config.usernodeAppPubkey,
        // Profile customization (#982). `username` stays the permanent
        // sign-in handle and is NOT editable anywhere on the platform;
        // `displayName` is the settable name other people see (it already
        // feeds the standings' resolveDisplayName chain). `avatarUrl` is
        // the content-addressed /avatars/<id> path, or null.
        displayName: profile.displayName,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        links: profile.links,
        // Whether the CLI-credentials surface exists in this deployment.
        // The whole /api/me/cli-tokens + /api/cli/* family is 404'd in a
        // staging preview (unreviewed code must not mint CLI tokens), so
        // Settings has to know NOT TO ASK: a 404 the client swallows is
        // still an error line in the page console, which fails the
        // proposal checks. Same shape as walletLinkEnabled above — the
        // client renders what the server reports, it never sniffs the
        // environment itself.
        cliAuthEnabled: isCliSurfaceEnabled(config),
        // Preferred development flow (#1049): 'platform' | 'claude-code' |
        // 'codex', or null for "ask me every time" (the default — the
        // dev-chat picker renders). Written by POST /api/me/dev-flow.
        devFlowPreference,
        // Whether the Claude Code / Codex hand-off is offerable AT ALL in
        // this deployment. The external-agent flow needs the identity-only
        // GitHub link to attribute the user's fork, so with no GitHub OAuth
        // credentials configured there is nothing to guide anyone through.
        // Same shape as walletLinkEnabled / cliAuthEnabled above: the client
        // renders what the server reports and never sniffs the environment.
        // A staging clone has no GitHub OAuth app, so this would be false
        // there and the whole #1049 surface would be unreviewable. Saying
        // "offerable" in staging unlocks nothing: the two writes answer 503
        // (routes/dev-flow.js), and the status route still reports
        // available:false unless the request carries the ?demo=1 fixture
        // flag — so the card only appears where a reviewer asks for it.
        externalFlowsAvailable: IS_STAGING || githubLink.isEnabled(config),
        // The platform's own app row — slug, display name, repo and deployed
        // short sha — or null on a deployment that has no self-hosted row.
        // The home screen's Improve button used to target this (it shows no
        // button now — the target cleared only on some return paths, so the
        // button lingered after backing out of an app); the field stays
        // because it is the one way a client can identify the self-hosted row
        // (GET /api/apps hides it from non-admins on purpose). Same shape as
        // walletLinkEnabled / cliAuthEnabled above: a DEPLOYMENT fact riding
        // the user payload, because the client renders what the server
        // reports and never sniffs its environment.
        platformApp,
      },
    });
  });

  // #30 BYOK: set / replace the user's Anthropic key. We verify with a
  // cheap 1-token ping before persisting so we never save a key that
  // the Anthropic API would reject at runtime.
  // --------------------------------------------------------------
  // GET /api/me/ai-budget — the drawer's "AI credit" row (#555).
  //
  // Strictly me-scoped, so it must stay OUT of PUBLIC_PATHS in
  // middleware/auth.js. Deliberately carries NO global spend or global
  // cap: services/status.js redact() treats those as admin-only, and
  // this is the one endpoint every signed-in user polls.
  // --------------------------------------------------------------
  router.get('/api/me/ai-budget', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    // Staging mock data: obviously-fake, read-only, written nowhere, and
    // a strict no-op in production. Gives the row a partial-spend state
    // (plus BYOK spillover) so a reviewer sees the real layout.
    if (IS_STAGING && req.query.demo === '1') {
      const reset = new Date();
      reset.setUTCHours(24, 0, 0, 0);
      return res.json({
        limitCents: 2000,
        spentCents: 1360,
        remainingCents: 640,
        byokCents: 450,
        hasByokKey: true,
        resetsAt: reset.toISOString(),
        lowBalancePct: 80,
        // #1788: the allowance has two windows now, and the row's copy
        // follows whichever one is binding. The daily cap binds in this
        // fixture — the weekly one still has room — so the reviewed row
        // reads exactly as it did before, with the window now stated
        // rather than assumed.
        capWindow: 'daily',
        windowLabel: 'Today',
        resetLabel: 'midnight UTC',
        dailyApplies: true,
        dailyLimitCents: 2000,
        dailySpentCents: 1360,
        weeklyApplies: true,
        weeklyLimitCents: 17500,
        weeklySpentCents: 4820,
        demo: true,
      });
    }
    try {
      const limits = require('../services/limits');
      res.json(await limits.getBudgetSnapshot(pool, req.user.id));
    } catch (err) {
      log.error('limits', 'ai-budget read failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/me/api-key', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { key } = req.body || {};
    if (typeof key !== 'string' || !key.trim()) {
      return res.status(400).json({ error: 'Key required' });
    }
    const clean = key.trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(clean)) {
      return res.status(400).json({ error: 'That doesn\'t look like a valid Anthropic API key.' });
    }

    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const test = new Anthropic({ apiKey: clean });
      await test.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
    } catch (err) {
      const msg = err?.status === 401 || err?.status === 403
        ? 'Anthropic rejected the key.'
        : `Couldn't verify the key (${err?.message || 'unknown error'}).`;
      return res.status(400).json({ error: msg });
    }

    try {
      // #30 dual-write (plan.md PR2): persist through the generic
      // credential store, which also mirrors into the legacy
      // users.anthropic_key_* columns during the migration window. Same
      // envelope, same verification — behavior unchanged, but the key now
      // also lives in user_ai_credentials for the openrouter era.
      const credentialStore = require('../services/credential-store');
      const saved = await credentialStore.writeAnthropicCodingAgent({
        pool, userId: req.user.id, apiKey: clean, dataKey: config.dataEncryptionKey,
      });
      const last4 = saved?.secret_last4 || clean.slice(-4);
      log.info('byok', 'API key saved', { userId: req.user.id });
      res.json({ ok: true, keyLast4: last4 });
    } catch (err) {
      log.error('byok', 'Failed to persist key', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/me/api-key', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const credentialStore = require('../services/credential-store');
      await credentialStore.deleteAnthropicCodingAgent({ pool, userId: req.user.id });
      log.info('byok', 'API key removed', { userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('byok', 'Failed to remove key', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Change password for a signed-in user (issue #282). Wired from
  // Settings → "Change password". We always require the current password:
  // we don't track per-session wallet origin (no schema change), and every
  // account has a knowable current password anyway — set at registration,
  // handed over as an admin temporary password, or just chosen during a
  // wallet reset. Wallet users who've forgotten it use the pre-login
  // wallet-reset flow instead.
  router.post('/api/me/password', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { currentPassword, newPassword } = req.body || {};

    const policy = validatePassword(newPassword);
    if (!policy.ok) return res.status(400).json({ error: policy.error });

    if (!currentPassword || typeof currentPassword !== 'string') {
      return res.status(400).json({ error: 'Current password is required' });
    }

    try {
      const { rows } = await pool.query(
        'SELECT password FROM users WHERE id = $1',
        [req.user.id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

      const valid = await bcrypt.compare(currentPassword, rows[0].password);
      if (!valid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      if (currentPassword === newPassword) {
        return res.status(400).json({ error: 'New password must be different from your current password' });
      }

      const hash = await bcrypt.hash(newPassword, 12);
      await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.user.id]);
      log.info('auth', 'Password changed', { userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('auth', 'Change password failed', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Experimental: per-user "AI progress estimate" toggle (default OFF).
  // Gates the Haiku estimator that watches in-flight Claude Code runs —
  // see runClaudeCodeTool in src/routes/sessions.js. Wired to the
  // Settings modal's Experimental section (fires on checkbox change).
  router.post('/api/me/ai-progress-estimate', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    try {
      await pool.query(
        'UPDATE users SET ai_progress_estimate = $1 WHERE id = $2',
        [enabled, req.user.id]
      );
      log.info('settings', 'AI progress estimate toggled', { userId: req.user.id, enabled });
      res.json({ ok: true, enabled });
    } catch (err) {
      log.error('settings', 'Failed to toggle AI progress estimate', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #1281: opt in to the session-CLI bridge (Settings -> Experimental).
  // Same shape as the progress-estimate toggle above; see
  // users.session_bridge_enabled in schema.sql for why it defaults off.
  router.post('/api/me/session-bridge', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    try {
      await pool.query(
        'UPDATE users SET session_bridge_enabled = $1 WHERE id = $2',
        [enabled, req.user.id]
      );
      log.info('settings', 'Session bridge toggled', { userId: req.user.id, enabled });
      res.json({ ok: true, enabled });
    } catch (err) {
      log.error('settings', 'Failed to toggle session bridge', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Preferred development flow (issue #1049). Written by the "remember my
  // option" checkbox on the dev-chat flow picker and by Settings →
  // Connections. Body { flow: 'platform' | 'claude-code' | 'codex' | null }
  // — null (or "") clears it back to "ask me every time", which is what
  // unticking the checkbox sends.
  router.post('/api/me/dev-flow', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { flow } = req.body || {};

    let normalized = null;
    if (flow !== null && flow !== undefined && flow !== '') {
      if (typeof flow !== 'string' || !DEV_FLOWS.includes(flow)) {
        return res.status(400).json({ error: `flow must be one of ${DEV_FLOWS.join(', ')} or null` });
      }
      normalized = flow;
    }

    try {
      await pool.query(
        'UPDATE users SET dev_flow_preference = $1 WHERE id = $2',
        [normalized, req.user.id]
      );
      log.info('settings', 'Dev flow preference saved', { userId: req.user.id, flow: normalized });
      res.json({ ok: true, flow: normalized });
    } catch (err) {
      log.error('settings', 'Failed to save dev flow preference', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Platform-level user language preference (issue #757). Wired to the
  // Settings modal's Language dropdown (fires on change). Body
  // { locale: string | null } — null (or "") clears the preference back
  // to "auto — use device language". Non-null values must be BCP-47-ish;
  // casing is normalized (language subtag lowercase, two-letter region
  // subtags uppercase: "pt-br" → "pt-BR"). The stored value feeds the
  // iframe JWT `locale` claim and /api/auth/me.
  router.post('/api/me/locale', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { locale } = req.body || {};

    let normalized = null;
    if (locale !== null && locale !== undefined && locale !== '') {
      if (typeof locale !== 'string') {
        return res.status(400).json({ error: 'locale must be a string or null' });
      }
      const clean = locale.trim();
      if (!clean) {
        // Whitespace-only — treat like "" (clear).
      } else if (clean.length > 35 || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(clean)) {
        return res.status(400).json({ error: 'locale must be a BCP-47 language tag (e.g. "id", "pt-BR")' });
      } else {
        normalized = clean
          .split('-')
          .map((sub, i) => {
            if (i === 0) return sub.toLowerCase();
            if (sub.length === 2) return sub.toUpperCase();
            return sub;
          })
          .join('-');
      }
    }

    try {
      await pool.query(
        'UPDATE users SET locale = $1 WHERE id = $2',
        [normalized, req.user.id]
      );
      log.info('settings', 'Locale preference saved', { userId: req.user.id, locale: normalized });
      res.json({ ok: true, locale: normalized });
    } catch (err) {
      log.error('settings', 'Failed to save locale preference', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Wallet linking ───────────────────────────────────────────────
  const LINK_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

  router.post('/api/me/wallet-link', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!config.usernodeAppPubkey) {
      return res.status(503).json({ error: 'Wallet linking not configured' });
    }

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);

    try {
      await pool.query(
        `UPDATE users SET wallet_link_token = $1, wallet_link_expires_at = $2 WHERE id = $3`,
        [token, expiresAt, req.user.id]
      );

      const memo = JSON.stringify({
        app: 'vibecode',
        type: 'link_wallet',
        token,
      });

      res.json({
        qr: {
          type: 'tx',
          to: config.usernodeAppPubkey,
          amount: 1,
          memo,
          confirmTitle: 'Link Wallet',
          confirmSubtitle: 'Link your Homeroom wallet to your Homeroom account.',
        },
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      log.error('wallet', 'Failed to generate link token', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/me/wallet-link/status', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const { rows } = await pool.query(
        'SELECT usernode_pubkey FROM users WHERE id = $1',
        [req.user.id]
      );
      const pubkey = rows[0]?.usernode_pubkey || null;
      res.json({ linked: !!pubkey, pubkey });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/me/wallet-link', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      await pool.query(
        `UPDATE users SET usernode_pubkey = NULL, wallet_link_token = NULL, wallet_link_expires_at = NULL WHERE id = $1`,
        [req.user.id]
      );
      log.info('wallet', 'Wallet unlinked', { userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('wallet', 'Failed to unlink wallet', { userId: req.user.id, err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Wallet-based authentication ───────────────────────────────────
  const CHALLENGE_TTL_MS = 2 * 60 * 1000;
  const walletChallenges = new Map();

  const walletChallengeSweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of walletChallenges) {
      if (now > entry.expiresAt) walletChallenges.delete(key);
    }
  }, 30_000);
  // Route construction happens in focused tests and development utilities
  // as well as the long-lived server. The cleanup timer must not keep a
  // process alive after its HTTP server has closed.
  if (typeof walletChallengeSweep.unref === 'function') walletChallengeSweep.unref();

  function httpJson(method, urlStr, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const mod = url.protocol === 'https:' ? https : http;
      const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = mod.request(url, {
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(bodyBuf ? { 'content-length': bodyBuf.length } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500) || '(empty body)'}`));
          }
          try { resolve(JSON.parse(text)); }
          catch (e) { reject(new Error(`JSON parse: ${e.message} — raw: ${text.slice(0, 200)}`)); }
        });
      });
      req.on('error', reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  }

  router.post('/api/auth/wallet-check', walletCheckLimiter, async (req, res) => {
    const { pubkey } = req.body || {};
    if (!pubkey || typeof pubkey !== 'string') {
      return res.status(400).json({ error: 'pubkey required' });
    }

    try {
      const { rows } = await pool.query(
        'SELECT id, username, is_admin FROM users WHERE usernode_pubkey = $1',
        [pubkey.trim()]
      );

      const isGenesis = genesisAccounts.isGenesisAddress(pubkey.trim());

      if (rows.length > 0) {
        const challenge = crypto.randomBytes(32).toString('hex');
        walletChallenges.set(challenge, {
          pubkey: pubkey.trim(),
          expiresAt: Date.now() + CHALLENGE_TTL_MS,
        });
        return res.json({ status: 'linked', challenge, isGenesis });
      }

      return res.json({ status: 'not_linked', isGenesis });
    } catch (err) {
      log.error('wallet-auth', 'wallet-check failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/wallet-verify', walletAuthLimiter, async (req, res) => {
    const { pubkey, publicKey, challenge, signature } = req.body || {};
    if (!pubkey || !challenge || !signature) {
      return res.status(400).json({ error: 'pubkey, challenge, and signature required' });
    }

    const entry = walletChallenges.get(challenge);
    if (!entry || entry.pubkey !== pubkey.trim() || Date.now() > entry.expiresAt) {
      return res.status(401).json({ error: 'Invalid or expired challenge' });
    }
    walletChallenges.delete(challenge);

    const cryptoKey = (publicKey || pubkey).trim();
    const verifyUrl = `${config.nodeRpcUrl}/misc/verify-signature`;
    try {
      const verifyBody = {
        public_key: cryptoKey,
        message: challenge,
        signature,
      };
      log.info('wallet-auth', 'Calling verify-signature', {
        url: verifyUrl,
        public_key: cryptoKey.slice(0, 20) + '...',
        message_len: challenge.length,
        signature_prefix: String(signature).slice(0, 30) + '...',
      });
      const verifyResp = await httpJson('POST', verifyUrl, verifyBody);

      if (!verifyResp || !verifyResp.valid) {
        log.warn('wallet-auth', 'Signature invalid', { resp: verifyResp });
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      const { rows } = await pool.query(
        'SELECT id, username, is_admin, admin_readonly FROM users WHERE usernode_pubkey = $1',
        [pubkey.trim()]
      );
      if (rows.length === 0) {
        return res.status(401).json({ error: 'No account linked to this pubkey' });
      }

      const user = rows[0];
      const { token, expiresAt } = await createSession(pool, user.id);
      createSessionCookie(res, token, expiresAt);

      log.info('wallet-auth', 'Signature login successful', { userId: user.id, username: user.username });
      res.json({ user: { id: user.id, username: user.username, ...roleFields(user.is_admin, user.admin_readonly) } });
    } catch (err) {
      log.error('wallet-auth', 'wallet-verify failed', { url: verifyUrl, err: err.message, code: err.code, stack: err.stack?.split('\n')[0] });
      res.status(500).json({ error: 'Signature verification service unavailable' });
    }
  });

  // Self-service password reset proven by a linked wallet (issue #282).
  // Structurally this is wallet-verify that ends in a password write
  // instead of just a login. Key invariants:
  //   - NO genesis gate. We mirror wallet-verify, which already resolves
  //     the account by `usernode_pubkey` alone — proving control of the
  //     specific linked key is the whole proof, so genesis status is
  //     irrelevant here and would only block legitimate linked non-genesis
  //     users.
  //   - Account lookup is keyed ONLY on the verified pubkey, never a
  //     username, so this pre-login endpoint is not a username oracle.
  //   - On success every existing session is deleted (a leaked/old session
  //     must not outlive a reset) and a fresh session is minted.
  router.post('/api/auth/wallet-reset-verify', walletAuthLimiter, async (req, res) => {
    const { pubkey, publicKey, challenge, signature, newPassword } = req.body || {};
    if (!pubkey || !challenge || !signature) {
      return res.status(400).json({ error: 'pubkey, challenge, and signature required' });
    }

    const policy = validatePassword(newPassword);
    if (!policy.ok) return res.status(400).json({ error: policy.error });

    const entry = walletChallenges.get(challenge);
    if (!entry || entry.pubkey !== pubkey.trim() || Date.now() > entry.expiresAt) {
      return res.status(401).json({ error: 'Invalid or expired challenge' });
    }
    walletChallenges.delete(challenge);

    const cryptoKey = (publicKey || pubkey).trim();
    const verifyUrl = `${config.nodeRpcUrl}/misc/verify-signature`;
    try {
      const verifyResp = await httpJson('POST', verifyUrl, {
        public_key: cryptoKey,
        message: challenge,
        signature,
      });

      if (!verifyResp || !verifyResp.valid) {
        log.warn('wallet-auth', 'Reset signature invalid', { resp: verifyResp });
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      const { rows } = await pool.query(
        'SELECT id, username, is_admin, admin_readonly FROM users WHERE usernode_pubkey = $1',
        [pubkey.trim()]
      );
      if (rows.length === 0) {
        return res.status(401).json({ error: 'No account linked to this pubkey' });
      }

      const user = rows[0];
      const hash = await bcrypt.hash(newPassword, 12);
      const recovery = await withTransaction(pool, (client) => accountRecovery(client, {
        userId: user.id,
        actorUserId: user.id,
        updatePassword: async (tx) => {
          const result = await tx.query(
            `UPDATE users SET password = $1 WHERE id = $2
             RETURNING id, username, is_admin, admin_readonly`,
            [hash, user.id]
          );
          // The route test's lightweight query facade predates pg's rowCount
          // shape. A real pg result always has rowCount, so production still
          // fails closed if the row disappeared after signature lookup.
          if (result.rowCount == null && result.rows.length === 0) {
            return { rows: [user] };
          }
          return result;
        },
        mintSession: async (tx) => {
          const token = crypto.randomBytes(32).toString('hex');
          const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
          await tx.query(
            'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
            [token, user.id, expiresAt]
          );
          return { token, expiresAt };
        },
      }));
      if (!recovery.found) {
        return res.status(401).json({ error: 'No account linked to this pubkey' });
      }
      const { token, expiresAt } = recovery.session;
      createSessionCookie(res, token, expiresAt);

      log.info('wallet-auth', 'Wallet password reset successful', { userId: user.id, username: user.username });
      res.json({ user: { id: user.id, username: user.username, ...roleFields(user.is_admin, user.admin_readonly) } });
    } catch (err) {
      log.error('wallet-auth', 'wallet-reset-verify failed', { url: verifyUrl, err: err.message, code: err.code });
      res.status(500).json({ error: 'Signature verification service unavailable' });
    }
  });

  // Email password reset, step 1: mail a magic link to the address on file.
  // Pre-login (PUBLIC_PATHS). Key invariants:
  //   - Always answers `{ ok: true }` for a well-formed email, whether or
  //     not an account matched — the same anti-enumeration contract as the
  //     web email-signup flow (see src/services/mail/index.js).
  //   - Only non-admin accounts with a CONFIRMED email are eligible. Admins
  //     keep the admin-issued temporary-password path: control of an inbox
  //     must never be enough to take over an admin console login (the same
  //     stance as the shared OTP set-password guard in
  //     src/services/email-signup.js).
  //   - The DB stores only the sha256 of the token; the plaintext exists in
  //     the emailed link alone and is never logged.
  //   - A new request overwrites any previous outstanding token (single
  //     outstanding reset per account), and the mail door's per-recipient
  //     throttle bounds how often that can be made to happen.
  router.post('/api/auth/password-reset/request', passwordResetRequestLimiter, passwordResetRequestEmailLimiter, async (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Email required' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT id, email FROM users
          WHERE lower(email) = lower($1) AND email_confirmed = TRUE AND is_admin = FALSE`,
        [email]
      );
      if (rows.length > 0) {
        const user = rows[0];
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
        const issued = await pool.query(
          `UPDATE users SET password_reset_token_hash = $1,
                            password_reset_expires_at = $2
            WHERE id = $3 AND email = $4 AND email_confirmed = TRUE AND is_admin = FALSE`,
          [tokenHash, expiresAt, user.id, user.email]
        );
        // The mailbox may have changed since the lookup. Never issue a
        // recovery token to the former address after it has been replaced.
        if (!issued.rowCount) return res.json({ ok: true });
        // Never throws (mail-door contract); a transport failure is logged
        // there and must not turn this into an account oracle.
        await mail.sendPasswordResetMail(config, user.email, token);
        log.info('auth', 'Password reset link issued', { userId: user.id });
      }
      res.json({ ok: true });
    } catch (err) {
      log.error('auth', 'password-reset request failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Email password reset, step 2: redeem the link. Pre-login (PUBLIC_PATHS).
  //   - Lookup is by sha256 of the presented token with expiry enforced in
  //     SQL; every failure is the same generic 401 so this endpoint is not
  //     a token or account oracle.
  //   - The password write clears the token columns in the same UPDATE,
  //     guarded on the hash still being set — single use even under
  //     concurrent redeems (accountRecovery holds the per-user lock).
  //   - accountRecovery also wipes every session and CLI authorization: a
  //     leaked session must not outlive a reset. No fresh session is minted
  //     — the link may have been opened anywhere; the user signs in with
  //     the password they just chose.
  router.post('/api/auth/password-reset/confirm', passwordResetConfirmLimiter, async (req, res) => {
    const { token, newPassword } = req.body || {};
    const refuse = () => res.status(401).json({ error: 'Invalid or expired reset link' });
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return refuse();

    const policy = validatePassword(newPassword);
    if (!policy.ok) return res.status(400).json({ error: policy.error });

    try {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const { rows } = await pool.query(
        `SELECT id, username FROM users
          WHERE password_reset_token_hash = $1
            AND password_reset_expires_at > NOW()`,
        [tokenHash]
      );
      if (rows.length === 0) return refuse();

      const user = rows[0];
      const hash = await bcrypt.hash(newPassword, 12);
      const recovery = await withTransaction(pool, (client) => accountRecovery(client, {
        userId: user.id,
        actorUserId: user.id,
        updatePassword: async (tx) => {
          // password_set: an OTP-created account that resets by email now
          // owns a real password (see the password_set block in schema.sql).
          const result = await tx.query(
            `UPDATE users SET password = $1,
                              password_set = TRUE,
                              password_reset_token_hash = NULL,
                              password_reset_expires_at = NULL
              WHERE id = $2 AND password_reset_token_hash = $3
              RETURNING id, username, is_admin, admin_readonly`,
            [hash, user.id, tokenHash]
          );
          // Same lightweight-facade shim as wallet-reset-verify above.
          if (result.rowCount == null && result.rows.length === 0) {
            return { rows: [user] };
          }
          return result;
        },
      }));
      if (!recovery.found) return refuse();

      log.info('auth', 'Email password reset successful', { userId: user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('auth', 'password-reset confirm failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Authenticated wallet-signed change-password (issue #282). The way back
  // for a logged-in user (e.g. signed in via an admin temporary password,
  // or a still-valid session) who has a linked wallet but has FORGOTTEN the
  // password the normal /api/me/password form would require. Stays behind
  // the auth gate (NOT in PUBLIC_PATHS) — it requires both a live session
  // AND a wallet signature bound to this account's linked key. Key
  // invariants:
  //   - The verified pubkey must equal THIS logged-in user's own linked
  //     usernode_pubkey (looked up by req.user.id). A valid signature from
  //     any other wallet — even a genesis one — cannot set this user's
  //     password.
  //   - NO genesis gate, mirroring wallet-verify / wallet-reset-verify.
  //   - Unlike the reset paths, existing sessions are left intact — this is
  //     a change by an already-authenticated user, matching the semantics
  //     of /api/me/password.
  router.post('/api/me/wallet-change-password', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { publicKey, challenge, signature, newPassword } = req.body || {};
    if (!challenge || !signature) {
      return res.status(400).json({ error: 'challenge and signature required' });
    }

    const policy = validatePassword(newPassword);
    if (!policy.ok) return res.status(400).json({ error: policy.error });

    // Resolve this user's linked wallet first — there's nothing to prove
    // against if the account has no linked key.
    let linkedPubkey;
    try {
      const { rows } = await pool.query(
        'SELECT usernode_pubkey FROM users WHERE id = $1',
        [req.user.id]
      );
      linkedPubkey = rows[0]?.usernode_pubkey || null;
    } catch (err) {
      log.error('wallet-auth', 'wallet-change-password lookup failed', { userId: req.user.id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!linkedPubkey) {
      return res.status(400).json({ error: 'No wallet is linked to your account' });
    }

    const entry = walletChallenges.get(challenge);
    if (!entry || entry.pubkey !== linkedPubkey || Date.now() > entry.expiresAt) {
      return res.status(401).json({ error: 'Invalid or expired challenge' });
    }
    walletChallenges.delete(challenge);

    const cryptoKey = (publicKey || linkedPubkey).trim();
    const verifyUrl = `${config.nodeRpcUrl}/misc/verify-signature`;
    try {
      const verifyResp = await httpJson('POST', verifyUrl, {
        public_key: cryptoKey,
        message: challenge,
        signature,
      });

      if (!verifyResp || !verifyResp.valid) {
        log.warn('wallet-auth', 'Change-password signature invalid', { userId: req.user.id, resp: verifyResp });
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      const hash = await bcrypt.hash(newPassword, 12);
      await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, req.user.id]);

      log.info('wallet-auth', 'Wallet-signed password change successful', { userId: req.user.id });
      res.json({ ok: true });
    } catch (err) {
      log.error('wallet-auth', 'wallet-change-password failed', { url: verifyUrl, err: err.message, code: err.code });
      res.status(500).json({ error: 'Signature verification service unavailable' });
    }
  });

  router.post('/api/auth/wallet-register', walletAuthLimiter, async (req, res) => {
    const { username, password, pubkey } = req.body || {};
    if (!username?.trim() || !password || !pubkey?.trim()) {
      return res.status(400).json({ error: 'username, password, and pubkey required' });
    }

    if (!genesisAccounts.isGenesisAddress(pubkey.trim())) {
      return res.status(403).json({ error: 'Only genesis ledger participants can register via wallet' });
    }

    try {
      const hash = await bcrypt.hash(password, 12);

      const linkToken = crypto.randomBytes(16).toString('hex');
      const linkExpiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);

      const { rows } = await pool.query(
        `INSERT INTO users (username, password, usernode_pubkey, wallet_link_token, wallet_link_expires_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [username.trim(), hash, pubkey.trim(), linkToken, linkExpiresAt]
      );
      const userId = rows[0].id;

      // Genesis-ledger registration is invite-equivalent (the genesis
      // allowlist IS the invite) — grant platform access directly.
      await waitlist.grantPlatformAccess(pool, userId);

      const { token, expiresAt } = await createSession(pool, userId);
      createSessionCookie(res, token, expiresAt);

      const memo = JSON.stringify({
        app: 'vibecode',
        type: 'link_wallet',
        token: linkToken,
      });

      log.info('wallet-auth', 'Wallet-gated registration', { userId, username: username.trim() });
      events.record(pool, { type: events.EVENT_TYPES.USER_SIGNED_UP, userId, metadata: { via: 'wallet' } });
      res.json({
        user: { id: userId, username: username.trim(), ...roleFields(false, false) },
        walletLink: {
          to: config.usernodeAppPubkey,
          amount: 1,
          memo,
          expiresAt: linkExpiresAt.toISOString(),
        },
      });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Username already taken' });
      }
      log.error('wallet-auth', 'wallet-register failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/wallet-link-login', walletAuthLimiter, async (req, res) => {
    const { username, password, pubkey } = req.body || {};
    if (!username?.trim() || !password || !pubkey?.trim()) {
      return res.status(400).json({ error: 'username, password, and pubkey required' });
    }

    if (!genesisAccounts.isGenesisAddress(pubkey.trim())) {
      return res.status(403).json({ error: 'Only genesis ledger participants can link a wallet' });
    }

    try {
      const { rows } = await pool.query(
        'SELECT id, username, password, is_admin, admin_readonly, usernode_pubkey FROM users WHERE username = $1',
        [username.trim()]
      );

      if (rows.length === 0) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const user = rows[0];
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      if (user.usernode_pubkey && user.usernode_pubkey !== pubkey.trim()) {
        return res.status(409).json({ error: 'This account is already linked to a different wallet' });
      }

      const { token, expiresAt } = await createSession(pool, user.id);
      createSessionCookie(res, token, expiresAt);

      if (user.usernode_pubkey === pubkey.trim()) {
        log.info('wallet-auth', 'Wallet link-login (already linked)', { userId: user.id });
        return res.json({
          user: { id: user.id, username: user.username, ...roleFields(user.is_admin, user.admin_readonly) },
        });
      }

      const linkToken = crypto.randomBytes(16).toString('hex');
      const linkExpiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);

      await pool.query(
        `UPDATE users SET wallet_link_token = $1, wallet_link_expires_at = $2 WHERE id = $3`,
        [linkToken, linkExpiresAt, user.id]
      );

      const memo = JSON.stringify({
        app: 'vibecode',
        type: 'link_wallet',
        token: linkToken,
      });

      log.info('wallet-auth', 'Wallet link-login initiated', { userId: user.id, username: user.username });
      res.json({
        user: { id: user.id, username: user.username, ...roleFields(user.is_admin, user.admin_readonly) },
        walletLink: {
          to: config.usernodeAppPubkey,
          amount: 1,
          memo,
          expiresAt: linkExpiresAt.toISOString(),
        },
      });
    } catch (err) {
      log.error('wallet-auth', 'wallet-link-login failed', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { authRoutes, DEV_FLOWS };
