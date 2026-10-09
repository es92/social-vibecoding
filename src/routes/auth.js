const appAllowance = require('../services/app-allowance');
const appLimit = require('../services/app-limit');
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
const firstSession = require('../services/first-session');
const communityInvites = require('../services/community-invites');
const phoneAuth = require('../services/firebase-phone-auth');
const challengeScorer = require('../services/topochain/challenge-scorer');
const events = require('../services/events');
const { validatePassword } = require('../services/password-policy');
const usernames = require('../services/usernames');
const uiTelemetry = require('../services/ui-telemetry');
const { verificationKeyFor } = require('../services/wallet-signing-key');
// One shape for the profile block, shared with PATCH /api/me/profile so
// /api/auth/me and the write echo identical objects (#982).
const { shapeProfile } = require('./profile');
const socialIdentity = require('../services/social-identity');
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
const managedOpenRouter = require('../services/openrouter-managed-keys');
// The platform's own self-hosted app row. The home screen's Improve button is
// about the PLATFORM, and the client has no other way to learn that row's slug
// — GET /api/apps hides self-hosted rows from non-admins on purpose.
const { getPlatformApp } = require('../services/platform-app');
// Deliberately NOT destructured: tests (and the never-throws mail contract)
// swap sendPasswordResetMail on the module object.
const mail = require('../services/mail');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

// The idle lease a freshly-minted browser session starts with. This matches
// SESSION_IDLE_DAYS in middleware/auth.js, which renews active sessions and
// applies the absolute lifetime cap.
const SESSION_DAYS = 90;

// Email password-reset magic link. The 30-minute figure is repeated in the
// password_reset mail template copy (src/services/mail/templates.js).
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

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
  // The username step after an Apple or Google sign-in made the account
  // (routes/sign-in-providers.js). Its callback mints a session too, by GET,
  // and makes the same check itself.
  '/api/auth/oauth/finish',
  // The same sign-in inside the Homeroom app, with the ID token its own
  // sheet returned.
  '/api/auth/oauth/:provider/native',
  // Phone sign-in and sign-up (routes/phone-auth.js). Verifying the code
  // (or an ID token a client SDK earned) signs an established account
  // straight in, so it mints a session; /request only texts a code, like
  // /api/auth/otp/request, and stays outside so a signed-in person can
  // still be walked through a phone verification elsewhere. The username
  // step spends the continuation by minting the real session.
  '/api/auth/phone/verify',
  '/api/auth/phone/finish',
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
      // legacy mixed-case row.
      //
      // Usernames match case-INSENSITIVELY too (QA 2026-09-24 Q11). They
      // were exact-match, while registration, renames and every handle
      // resolver treat `Ada` and `ada` as one name (#2296's trigger refuses
      // the second), and phones capitalise the first letter of the field. So
      // "Username already taken" for QAFLOW2 and "Invalid credentials" for
      // the same letters at sign-in. The candidate list is what makes this
      // safe: a legacy case-variant pair (`Drea`/`drea`, from before #2296)
      // yields two rows and the password decides between them, the exact
      // spelling tried first so it wins a both-verify tie. idx_users_
      // username_lower (schema.sql) serves the lookup.
      const identifier = String(username).trim();
      const candidates = [];
      if (identifier.includes('@')) {
        const { rows } = await pool.query(
          'SELECT id, username, password, is_admin, admin_readonly, is_synthetic FROM users WHERE lower(email) = lower($1)',
          [identifier]
        );
        for (const row of rows) candidates.push({ row, matchedBy: 'email' });
      }
      let usernameMatched = false;
      {
        const { rows } = await pool.query(
          `SELECT id, username, password, is_admin, admin_readonly, is_synthetic FROM users WHERE LOWER(username) = LOWER($1)
            ORDER BY (username = $1) DESC, id ASC`,
          [identifier]
        );
        for (const row of rows) {
          usernameMatched = true;
          if (!candidates.some((c) => c.row.id === row.id)) {
            candidates.push({ row, matchedBy: 'username' });
          }
        }
      }
      // #1861: a rename must not lock anyone out. POST /api/me/username
      // retires the old handle into `username_history` (services/usernames.js)
      // instead of releasing it, and every handle resolver reads through that
      // ledger, but sign-in did not: the name a person had signed in with for
      // months answered "Invalid credentials" the moment they changed it. So
      // when no live account wears the handle, a RETIRED one signs its owner
      // in. Retired handles are globally unique and never re-issued, so this
      // is at most one extra candidate (the compare budget above holds) and
      // the password still decides. Case-insensitive, like the live lookup
      // (QA 2026-09-24 Q11) and like checkAvailability, which is what keeps
      // retired handles unique regardless of case.
      if (!usernameMatched) {
        const { rows: retired } = await pool.query(
          `SELECT u.id, u.username, u.password, u.is_admin, u.admin_readonly, u.is_synthetic
             FROM username_history h
             JOIN users u ON u.id = h.user_id
            WHERE LOWER(h.username) = LOWER($1)
            ORDER BY (h.username = $1) DESC
            LIMIT 1`,
          [identifier]
        );
        const row = retired[0];
        if (row && !candidates.some((c) => c.row.id === row.id)) {
          candidates.push({ row, matchedBy: 'retired_username' });
        }
      }

      if (candidates.length === 0) {
        log.warn('auth', 'Login failed - unknown user', { username });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      let user = null;
      let matchedBy = null;
      for (const candidate of candidates) {
        // A synthetic user (demo mode's partner, routes/demo-mode.js) has no
        // sign-in: its stored password is random and discarded, so this
        // compare could never succeed — and it is not tried, so that holds
        // even if the row somehow had a real hash. Same answer as an
        // unknown name below: the form is not an oracle for which handles
        // are synthetic.
        if (candidate.row.is_synthetic) continue;
        // At most 2 compares (one email match + one username match), so
        // the cost posture behind the login limiters is unchanged. A legacy
        // case-variant pair adds one more; no new pair can be made.
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

      // An invite link this visitor opened before signing in is NOT followed
      // here: an existing account is asked first, by the shell, which comes
      // back to the link as a remembered deep link (App._followInvite). The
      // carried copy is dropped, so nothing follows it later without asking,
      // and the admin Journey counts this as a sign-in the link brought
      // (dropCarried, never throws).
      await communityInvites.dropCarried(pool, req, res, user.id);

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
      // An invite link this visitor opened first is followed as the account
      // the code just CREATED (services/community-invites.js): signing up
      // from the link is the consent, and the new account's community is
      // queued for the day it is let in. An account that already existed
      // follows it only when this sign-in IS the Join its page asked for
      // (`followInvite`, sent by the sheet "Made for you" opens: the person
      // just pressed "Join …" on the link's own page). Anywhere else it is
      // asked by the shell instead, like a password sign-in, so the carried
      // copy is only dropped (and counted as a sign-in it brought). Never
      // throws.
      const consented = verified.created || req.body?.followInvite === true;
      const invite = consented
        ? await communityInvites.redeemCarried(pool, req, res, verified.userId, {
          requirePhone: phoneAuth.offered(config),
        })
        : await communityInvites.dropCarried(pool, req, res, verified.userId);
      // A link that joined this person (a private member's, or anybody's
      // with access) counts for its challenge now, not on the rule's next
      // pass (#3564). A queued one waits for release, and the schedule.
      // While phone sign-in is offered, an email account new to the platform
      // stays queued: a private member signs up with a phone.
      if (invite && invite.status === 'joined') await challengeScorer.scoreOnJoin(pool, config);
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
          ...(invite ? { invite } : {}),
        });
      }
      // #2568: a brand-new account gets its included OpenRouter key here,
      // the moment the row exists. Best effort by construction —
      // ensureIncludedKey never throws — so signing up cannot fail because
      // OpenRouter's management API did; the next new-change screen retries.
      if (verified.created) {
        await managedOpenRouter.ensureIncludedKey({
          pool, userId: verified.userId, config, reason: 'signup_email',
        });
        // The sign-up, as an activation code and a wallet record theirs
        // (#4039): an email code made no user_signed_up before.
        events.record(pool, { type: events.EVENT_TYPES.USER_SIGNED_UP, userId: verified.userId, metadata: { via: 'email' } });
      }
      createSignupCookie(res, verified.signupToken, verified.expiresAt);
      log.info('email-signup', 'Email code verified, password setup pending', {
        userId: verified.userId,
        next: 'set-password',
      });
      // QA 2026-09-24 Q12: say what the next step IS. `created` means this
      // code just made the account (no account used the address), so the
      // screen can say so instead of implying one already existed;
      // `needsUsername` makes it ask for the handle rather than the waiting
      // room introducing one the person never chose; `waitlisted` lets it
      // say plainly, before the waiting room, that new accounts queue. `ok`
      // and `next` are unchanged. Nothing here leaks to somebody who does
      // not hold the mailbox: the code was just proved.
      //
      // #4596: `suggestedUsername` is the handle the field arrives holding,
      // made from the address (usernames.suggestUsernameForEmail) and free
      // when it was read, or null for an empty field; absent for an account
      // that already has its handle. It overturns #3575 for
      // this step on purpose; the person can change it, and set-password
      // still refuses to finish without a handle in the field.
      //
      // A link that just let them in (as a private member, or on its maker's
      // skip) answers `waitlisted`: there is no queue in front of them now.
      // The verifier read it before the link was followed.
      const waitlistedNow = invite && invite.status === 'joined'
        ? false
        : (typeof verified.waitlisted === 'boolean' ? verified.waitlisted : null);
      return res.json({
        ok: true,
        next: 'set-password',
        created: !!verified.created,
        needsUsername: !!verified.needsUsernameChoice,
        ...(verified.needsUsernameChoice ? { suggestedUsername: verified.suggestedUsername || null } : {}),
        waitlisted: waitlistedNow,
        ...(invite ? { invite } : {}),
      });
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
        // The handle the set-password step asks a new account for (QA
        // 2026-09-24 Q12). Required since #3575 for an account that has
        // never chosen one: absent, the service answers `username_required`
        // and nothing is spent. Ignored for an account that already has one.
        username: typeof req.body?.username === 'string' ? req.body.username : null,
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
        // A username refusal leaves the signup session unspent, so the
        // person corrects the field and submits again on the same cookie.
        // `username_required` (#3575) is the same kind of refusal: the
        // field was left empty, and filling it is the fix.
        if (error.code === 'invalid_username' || error.code === 'username_taken'
            || error.code === 'username_required') {
          return res.status(422).json({ error: error.message, code: error.code, field: 'username' });
        }
        clearSignupCookie(res);
        return res.status(422).json({ error: error.message, code: error.code });
      }
      log.error('email-signup', 'Password setup failed', { message: error.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #2522: a lost race for an activation code, signalled by throwing so the
  // transaction rolls back the user row the loser had already inserted.
  // Identity-compared, so it can never collide with a real database error.
  const CODE_TAKEN = Symbol('activation-code-taken');

  router.post('/api/auth/register', registerLimiter, async (req, res) => {
    const { code, username, password } = req.body;

    if (!code?.trim() || !username?.trim() || !password) {
      return res.status(400).json({ error: 'Activation code, username, and password required' });
    }

    // QA 2026-09-24 Q11: the SAME rules the rest of the account surface
    // already enforces. Registration took any non-empty string for either,
    // so a one-character password and `qa flow-3!` both went through, while
    // Change password asks for eight characters and a rename refuses anything
    // but letters, numbers and underscores. The handle rule is not cosmetic:
    // a hyphen breaks @mentions, and #1377's stranded branch names were
    // reached by registering exactly such a name (services/usernames.js).
    // Checked before the code preflight and the cost-12 hash, so a form that
    // is simply filled in wrong costs nothing and says which field to fix.
    // New accounts only: no existing handle or password is re-checked.
    const handle = usernames.validateUsername(username);
    if (!handle.ok) {
      return res.status(400).json({ error: handle.error, field: 'username' });
    }
    const policy = validatePassword(password);
    if (!policy.ok) {
      return res.status(400).json({ error: policy.error, field: 'password' });
    }

    try {
      // #2522: the code is CLAIMED atomically, not checked and then taken.
      //
      // This used to `SELECT ... WHERE used_by IS NULL`, insert the user, and
      // then `UPDATE ... WHERE id = $2` with no guard — three statements, no
      // transaction, and the write did not re-assert the condition the read
      // had relied on. Two requests racing on one code both passed the
      // SELECT, both created an account, and both wrote `used_by`; the last
      // one simply overwrote the first. One invite, several accounts, each
      // with platform access and an included key.
      //
      // The claim is now the UPDATE itself, carrying `AND used_by IS NULL`,
      // so the database decides the winner: exactly one caller sees
      // rowCount 1 and the loser sees 0. Both statements sit in one
      // transaction, so a loser's half-made user is rolled back rather than
      // left orphaned, and the code stays free if the insert fails.
      // A cheap preflight, and ONLY that. It is not the claim and nothing
      // depends on it being still true below — it can go stale in the very
      // window this issue is about. Its job is to keep an unusable code from
      // costing a cost-12 bcrypt: without it every garbage code makes this
      // unauthenticated route burn ~100ms of CPU before refusing, which the
      // per-IP limiter does not bound because it only bites after several
      // such requests and a distributed caller has many addresses.
      const { rows: preflight } = await pool.query(
        'SELECT 1 FROM activation_codes WHERE code = $1 AND used_by IS NULL',
        [code.trim()]
      );
      if (preflight.length === 0) {
        return res.status(400).json({ error: 'Invalid or already used activation code' });
      }

      const hash = await bcrypt.hash(password, 12);
      let userId;
      let codeId;
      try {
        // withTransaction, not a bare pool.connect(): route tests and some
        // embedded deployments hand us a transaction-capable query facade
        // with no pg.Pool#connect, and the helper already handles both (see
        // services/cli-auth.js). Calling connect() directly turned every
        // valid registration into a 500 on those setups.
        ({ userId, codeId } = await withTransaction(pool, async (client) => {
          // needs_communities_choice: an account made with a code is asked
          // which communities to join, like an email sign-up (communities,
          // stage 5; src/services/onboarding.js). getting_started_gate: and,
          // being new, starts on the Getting started list that gates the
          // season, like an email sign-up (src/db/schema.sql).
          const { rows: userRows } = await client.query(
            'INSERT INTO users (username, password, needs_communities_choice, getting_started_gate) VALUES ($1, $2, TRUE, TRUE) RETURNING id',
            [username.trim(), hash]
          );
          const uid = userRows[0].id;
          const claim = await client.query(
            `UPDATE activation_codes SET used_by = $1, used_at = NOW()
              WHERE code = $2 AND used_by IS NULL
              RETURNING id`,
            [uid, code.trim()]
          );
          // THROWN, not returned: the rollback is the point. A loser has
          // already inserted its user inside this transaction, and returning
          // normally would commit that orphan.
          if (claim.rowCount !== 1) throw CODE_TAKEN;
          return { userId: uid, codeId: claim.rows[0].id };
        }));
      } catch (err) {
        if (err === CODE_TAKEN) {
          // Unknown code, or another request took it while we were hashing.
          // Identical message either way: which of the two it was is not
          // something an unauthenticated caller should be able to tell.
          return res.status(400).json({ error: 'Invalid or already used activation code' });
        }
        throw err;
      }

      // An activation code is an admin-minted invite — stronger than a
      // waitlist release — so it carries platform access with it
      // (onboarding flow alignment). Without this, every invited user
      // would land in the waiting room, a regression on the invite flow.
      // Not a release by hand, so no generation 0 comes with it.
      await waitlist.grantPlatformAccess(pool, userId);

      // #2568: the included OpenRouter key, created with the account.
      await managedOpenRouter.ensureIncludedKey({
        pool, userId, config, reason: 'signup_activation_code',
      });

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
        return res.status(409).json({ error: 'Username already taken', field: 'username' });
      }
      log.error('auth', 'Registration error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/logout', sameOriginBrowserOnly, async (req, res) => {
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
      allowance = await appAllowance.read(pool, req.user, { maxApps: await appLimit.effective(pool, config) });
    } catch (err) {
      log.warn('auth', 'App allowance lookup failed', { message: err.message });
    }
    // #2563: has this account still never picked the handle other members
    // see? Read in the same users lookup as the block above — it is one
    // more column on a row this endpoint already fetches.
    //
    // Defaults FALSE, and stays FALSE if the lookup below throws. That is
    // the deliberate failure direction: a gate that cannot be read must let
    // people in, not strand every signed-in member behind a blocking step
    // the client cannot dismiss.
    let needsUsernameChoice = false;
    // A handle made from an invite phone sign-up's name, for private groups
    // only: the shell asks for a username before anything public
    // (frontend/src/features/auth/username-first-run.js askForPublic).
    let usernameProvisional = false;
    // Communities, stage 5 (src/services/onboarding.js): the join screen a
    // new account answers after its username and the terms, and the
    // Getting started card that follows it, for an account made since that
    // card became the First challenges (`getting_started_gate`). Same
    // failure direction as the flag above: unreadable means no blocking step
    // and no card.
    let needsCommunitiesChoice = false;
    let showGettingStarted = false;
    // Has this account finished (or skipped) the welcome tour, on any
    // device? The tour ORs it with its own per-browser flag, so the failure
    // direction here is the one it had before the server kept it: the
    // browser's answer alone.
    let tourDone = false;
    // The first session's question in place of the join screen: an account
    // still due the join screen is asked "What do you want to make?"
    // instead whenever the story landing is on, however it signed in (the
    // story's own sheet, a password, a code, a provider), and on every boot
    // until it answers (services/first-session.js). Not for an account that
    // is already somewhere, a project of its own or a community besides
    // Homeroom: that one is asked the join screen. Only read for an account
    // that is due it; FALSE when the whole lookup fails, which leaves the
    // join screen as it was.
    let storyFirstSession = false;
    // What they told us on the waitlist the app should do, to open that
    // question with (#4040). Only read while the question is theirs to
    // answer, so it stops being sent once it is; null for no waitlist row
    // linked to the account, or no answer in it.
    let waitlistIdea = null;
    // The verified-identity rule (schema.sql identity_needed): a member it
    // holds to it, let in after it was switched on with no phone, GitHub and
    // X, or zkPassport. `identityNeeded` lets the verify sheet ask at a
    // public step (a public vote, making a project public, more AI
    // credits) and Home's "Verify your account" card follow up on it.
    // Unreadable means not held to it.
    let identityNeeded = false;
    try {
      const { rows } = await pool.query(
        `SELECT u.anthropic_key_enc, u.anthropic_key_last4, u.usernode_pubkey,
                u.display_name, u.bio,
                u.needs_username_choice,
                u.needs_communities_choice,
                (u.username_provisional_since IS NOT NULL) AS username_provisional,
                (u.communities_onboarded_at IS NOT NULL
                  AND u.getting_started_closed_at IS NULL
                  AND u.getting_started_gate) AS show_getting_started,
                (u.tour_done_at IS NOT NULL) AS tour_done,
                identity_needed(u.id) AS identity_needed,
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
      // #2568: no allowlist any more — availability is the deployment
      // switch plus whether this account actually holds a usable key.
      openrouterAvailable = config.codexOpenrouterEnabled === true
        && rows[0]?.openrouter_credential_valid === true;
      needsUsernameChoice = rows[0]?.needs_username_choice === true;
      usernameProvisional = rows[0]?.username_provisional === true;
      needsCommunitiesChoice = rows[0]?.needs_communities_choice === true;
      showGettingStarted = rows[0]?.show_getting_started === true;
      tourDone = rows[0]?.tour_done === true;
      // A member let in (not a private member, who waits for that).
      identityNeeded = rows[0]?.identity_needed === true && !!req.user.hasPlatformAccess;
      if (needsCommunitiesChoice) storyFirstSession = await firstSession.asksWhatToMake(pool, req.user.id);
      if (storyFirstSession) waitlistIdea = await firstSession.waitlistIdea(pool, req.user.id);
      const verifiedLinks = await socialIdentity.verifiedProfileLinks(pool, req.user.id);
      profile = shapeProfile(rows[0], verifiedLinks);
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
    // #3624: whether this person builds through the Homeroom bot's DM
    // (everyone with platform access). The create dialog asks for a longer
    // description when it is true. Unreadable means false.
    let homeroomBotDm = false;
    try {
      const settings = await require('../services/homeroom-bot').readSettings(pool);
      homeroomBotDm = !req.user.isSynthetic && require('../services/homeroom-bot-dm').hasBot(settings, req.user);
    } catch {}
    res.json({
      user: {
        id: req.user.id,
        username: req.user.username,
        // Browser-check accounts authenticate normally to exercise protected
        // screens, but their scripted journeys must not enter product UI
        // analytics. The client waits for this server-owned decision.
        // People who objected to being recorded answer false too (#3369).
        uiTelemetryEligible: await uiTelemetry.isRecordable(pool, req.user),
        isAdmin: req.user.isAdmin,
        // View-only admin role (issue #311). `isAdmin` still drives every
        // client read/visibility gate; `canAdminWrite` drives mutating
        // controls (hidden for view-only admins). `role` is the display
        // string the admin panel / banners render.
        canAdminWrite: !!req.user.canAdminWrite,
        role: !req.user.isAdmin ? 'user' : (req.user.adminReadonly ? 'view_admin' : 'admin'),
        homeroomBotDm,
        // Derived per-user app-creation affordance. Kept for the home-screen
        // treatment; the numbers below explain that state in the create
        // dialog. A null used/remaining value means the count query was not
        // available, never a fabricated zero.
        canCreateApps: allowance.canCreateApps,
        appCreationQuota: allowance.quota,
        appQuotaRequestedAt: allowance.requestedAt,
        // QA 2026-09-24 Q33b: the server-wide MAX_APPS cap as this viewer
        // meets it ({ used, limit, remaining, full }), or null when it does
        // not apply to them. Seeds the allowance panel's first paint.
        appServerCapacity: allowance.server || null,
        // Experimental: opt-in AI progress estimate for coding runs
        // (Settings → Experimental). Default OFF.
        aiProgressEstimate: !!req.user.aiProgressEstimate,
        // #1281: opt-in for the session-CLI bridge, the bottom rung of the
        // spec's routing tree. build-venues.js requires this AND the
        // deployment's cliAuthEnabled before offering the `local` venue.
        sessionBridgeEnabled: !!req.user.sessionBridgeEnabled,
        // #2779: new work starts in an agent session for everyone; the
        // per-user flag and its Settings switch are retired. Still reported
        // as true for a shell cached before that, whose entry points read it
        // to choose between an agent session and a classic one the server
        // no longer creates.
        agentSessionsEnabled: true,
        // Platform-level language preference (issue #757): a BCP-47 tag or
        // null when unset. Settings → Language renders from this; apps read
        // it via the iframe JWT `locale` claim and the bridge's
        // usernode.getUserLocale().
        locale: req.user.locale ?? null,
        // Platform-access gate (onboarding flow alignment). FALSE means
        // the account is waiting to be released off the platform
        // waitlist — the waiting room polls this to know when to let
        // the user through. It answers "may use the platform", so a
        // private member says TRUE here too, and `privateMember` says
        // what is different for them (middleware/auth.js isPrivateMember):
        // they join by an invite link before they are let in, and do not
        // make apps of their own until they are.
        hasPlatformAccess: !!req.user.hasPlatformAccess || !!req.user.isAdmin || !!req.user.privateMember,
        privateMember: !!req.user.privateMember,
        usernameProvisional,
        // First-run username gate (#2563). TRUE means this account has
        // never picked the handle other members see — email sign-up gave
        // it a generated one and recorded that the person still has to
        // choose. The web shell presents a blocking "Choose your username"
        // step on arrival; the mobile app can follow the same flag later.
        //
        // A NEW field: `username` above is untouched and still carries
        // whatever the account currently holds, so every existing client
        // renders exactly what it rendered before.
        needsUsernameChoice,
        // Communities, stage 5. TRUE until a new account has answered "What
        // communities do you want to join?" (set by every sign-up path:
        // email, an activation code, a wallet; no existing account ever
        // reads TRUE). The web shell presents that
        // screen after the username and terms steps
        // (frontend/src/features/auth/communities-first-run.js).
        needsCommunitiesChoice,
        // TRUE when the join screen above is to be the first session's
        // "What do you want to make?" instead (the story landing is on, and
        // the account has no project or community yet). Only ever TRUE
        // alongside needsCommunitiesChoice, and stays TRUE until that
        // question is answered, so a reload asks it again.
        storyFirstSession,
        // Only alongside storyFirstSession: the waitlist answer "What should
        // it do?" opens with (frontend/src/features/first-session/make.tsx).
        waitlistIdea,
        // The Getting started card on Home: shown to an account that came
        // through the join screen, until it is closed.
        showGettingStarted,
        // The verified-identity rule holds this member to it (see above).
        identityNeeded,
        // The welcome tour was finished or skipped on this account, on any
        // device (POST /api/me/tour-done; cleared by Reset first run). The
        // tour counts it done when this OR the browser's own flag says so
        // (frontend/src/features/home/tour/tour-done.ts).
        tourDone,
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
      reset.setUTCDate(reset.getUTCDate() + (((8 - reset.getUTCDay()) % 7) || 7));
      reset.setUTCHours(0, 0, 0, 0);
      return res.json({
        limitCents: 5000,
        spentCents: 1360,
        remainingCents: 3640,
        byokCents: 450,
        hasByokKey: true,
        resetsAt: reset.toISOString(),
        lowBalancePct: 80,
        // #1788 stated which window the row's copy follows; #2571 leaves
        // one: the account's single weekly allowance, reset Monday 00:00
        // UTC. The daily figures below are the retained-but-unenforced
        // setting and today's share of the same spend.
        capWindow: 'weekly',
        windowLabel: 'This week',
        resetLabel: 'Monday 00:00 UTC',
        dailyApplies: false,
        dailyLimitCents: 2500,
        dailySpentCents: 480,
        weeklyApplies: true,
        weeklyLimitCents: 5000,
        weeklySpentCents: 1360,
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
      // Thinking off: Haiku 5.5 thinks by default and the thinking counts
      // against max_tokens, so one token would end inside it.
      await test.messages.create({
        model: 'claude-haiku-5-5',
        max_tokens: 1,
        thinking: { type: 'disabled' },
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

  router.delete('/api/me/api-key', sameOriginBrowserOnly, async (req, res) => {
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

  // Platform-level user language preference (issue #757). Wired to the
  // Settings modal's Language dropdown (fires on change). Body
  // { locale: string | null } — null (or "") clears the preference back
  // to "auto — use device language". Non-null values must be BCP-47-ish;
  // casing is normalized (language subtag lowercase, two-letter region
  // subtags uppercase: "pt-br" → "pt-BR"). The stored value feeds the
  // iframe JWT `locale` claim and /api/auth/me.
  router.post('/api/me/locale', sameOriginBrowserOnly, async (req, res) => {
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

  router.post('/api/me/wallet-link', sameOriginBrowserOnly, async (req, res) => {
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

  router.delete('/api/me/wallet-link', sameOriginBrowserOnly, async (req, res) => {
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

  // Wallet sign-in. The entire proof is "this caller controls the key THIS
  // account linked", so the order below is load-bearing (issue #2502):
  //   1. consume the challenge, which is bound to one address and expires;
  //   2. resolve the account from that address, server-side;
  //   3. take the verification key from the account's own stored
  //      usernode_pubkey. A caller-supplied `publicKey` is never forwarded to
  //      the verifier: it is only an assertion about which key signed, and one
  //      that names any other key is refused here;
  //   4. only then ask the node whether the signature is valid.
  // Verifying an arbitrary caller-named key first and resolving the account
  // afterwards is what let a genuine signature by ANY key mint a session for
  // ANY linked address.
  router.post('/api/auth/wallet-verify', walletAuthLimiter, async (req, res) => {
    const { pubkey, publicKey, challenge, signature } = req.body || {};
    if (!pubkey || !challenge || !signature) {
      return res.status(400).json({ error: 'pubkey, challenge, and signature required' });
    }

    const entry = walletChallenges.get(challenge);
    if (!entry || entry.pubkey !== pubkey.trim() || Date.now() > entry.expiresAt) {
      return res.status(401).json({ error: 'Invalid or expired challenge' });
    }
    // Single-use, and consumed before any outbound call so neither a slow
    // verification nor a failed one leaves a replayable challenge behind.
    walletChallenges.delete(challenge);

    let user;
    try {
      const { rows } = await pool.query(
        'SELECT id, username, is_admin, admin_readonly, usernode_pubkey FROM users WHERE usernode_pubkey = $1',
        [pubkey.trim()]
      );
      // usernode_pubkey carries no unique constraint (see the admin wallet
      // handler), so an ambiguous match fails closed instead of silently
      // signing somebody in as rows[0].
      if (rows.length !== 1) {
        if (rows.length > 1) {
          log.warn('wallet-auth', 'Ambiguous wallet address, refusing login', { count: rows.length });
        }
        return res.status(401).json({ error: 'No account linked to this pubkey' });
      }
      user = rows[0];
    } catch (err) {
      log.error('wallet-auth', 'wallet-verify lookup failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }

    const cryptoKey = verificationKeyFor(user.usernode_pubkey, publicKey);
    if (!cryptoKey) {
      log.warn('wallet-auth', 'Signing key is not the key this account linked', { userId: user.id });
      return res.status(401).json({ error: 'Signature verification failed' });
    }

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

    // Resolve the account and its signing key BEFORE the verifier is asked
    // anything, exactly as wallet-verify does above (issue #2502) — this
    // endpoint writes a password, so a signature by a key the account never
    // linked must never reach the verifier as if it were the account's.
    let user;
    try {
      const { rows } = await pool.query(
        'SELECT id, username, is_admin, admin_readonly, usernode_pubkey FROM users WHERE usernode_pubkey = $1',
        [pubkey.trim()]
      );
      if (rows.length !== 1) {
        if (rows.length > 1) {
          log.warn('wallet-auth', 'Ambiguous wallet address, refusing reset', { count: rows.length });
        }
        return res.status(401).json({ error: 'No account linked to this pubkey' });
      }
      user = rows[0];
    } catch (err) {
      log.error('wallet-auth', 'wallet-reset-verify lookup failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }

    const cryptoKey = verificationKeyFor(user.usernode_pubkey, publicKey);
    if (!cryptoKey) {
      log.warn('wallet-auth', 'Reset signing key is not the key this account linked', { userId: user.id });
      return res.status(401).json({ error: 'Signature verification failed' });
    }

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

    // Same binding rule as wallet-verify (issue #2502): the key the verifier
    // checks against comes from this account's stored usernode_pubkey, and a
    // caller-supplied `publicKey` that is not that key is refused outright
    // rather than forwarded.
    const cryptoKey = verificationKeyFor(linkedPubkey, publicKey);
    if (!cryptoKey) {
      log.warn('wallet-auth', 'Change-password signing key is not the key this account linked', { userId: req.user.id });
      return res.status(401).json({ error: 'Signature verification failed' });
    }
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

      // needs_communities_choice: asked which communities to join, like
      // every other new account (communities, stage 5); getting_started_gate:
      // and starts on the Getting started list, like every other new one.
      const { rows } = await pool.query(
        `INSERT INTO users (username, password, usernode_pubkey, wallet_link_token, wallet_link_expires_at,
                            needs_communities_choice, getting_started_gate)
         VALUES ($1, $2, $3, $4, $5, TRUE, TRUE) RETURNING id`,
        [username.trim(), hash, pubkey.trim(), linkToken, linkExpiresAt]
      );
      const userId = rows[0].id;

      // Genesis-ledger registration is invite-equivalent (the genesis
      // allowlist IS the invite) — grant platform access directly, without
      // the generation 0 a release by hand records.
      await waitlist.grantPlatformAccess(pool, userId);

      // #2568: the included OpenRouter key, created with the account.
      await managedOpenRouter.ensureIncludedKey({
        pool, userId, config, reason: 'signup_wallet',
      });

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

// Apple and Google sign-in (routes/sign-in-providers.js) mints the same
// session, with the same cookie, and answers with the same role fields.
module.exports = { authRoutes, createSession, createSessionCookie, roleFields };
