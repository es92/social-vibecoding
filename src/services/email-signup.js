'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const log = require('./logger');
const mail = require('./mail');
const usernames = require('./usernames');
const waitlist = require('./waitlist');

const OTP_TTL_MS = 10 * 60 * 1000;
const SIGNUP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const OTP_CLEANUP_LIMIT = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class EmailSignupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EmailSignupError';
    this.code = code;
  }
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email && email.length <= 255 && EMAIL_RE.test(email) ? email : null;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function cleanupExpiredState(pool) {
  try {
    await pool.query(
      `DELETE FROM mobile_otp_codes
        WHERE id IN (
          SELECT id FROM mobile_otp_codes
           WHERE expires_at < NOW() - INTERVAL '24 hours'
           LIMIT ${OTP_CLEANUP_LIMIT}
        )`
    );
    await pool.query(
      `DELETE FROM web_signup_sessions
        WHERE token_hash IN (
          SELECT token_hash FROM web_signup_sessions
           WHERE expires_at < NOW()
           LIMIT ${OTP_CLEANUP_LIMIT}
        )`
    );
  } catch (error) {
    log.warn('email-signup', 'Expired signup cleanup skipped', { message: error.message });
  }
  await mail.pruneDeliveries(pool);
}

// The mail layer suppresses a second `otp` message to the same address inside
// RULES.otp.minGapMs (src/services/mail/rate-limit.js). Minting a fresh code
// in that window used to delete the working one and then mail nothing, so a
// double-tap left the recipient holding a code the server had already thrown
// away. Inside the gap we keep the code that was actually delivered instead:
// still unused, still unexpired, so the mail already in their inbox works.
const OTP_REUSE_WINDOW_SECONDS = 60;

async function requestCode(pool, config, rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!email) throw new EmailSignupError('invalid_email', 'Enter a valid email address.');

  const reused = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id,
              (attempts = 0
               AND expires_at > NOW()
               AND created_at > NOW() - INTERVAL '${OTP_REUSE_WINDOW_SECONDS} seconds')
                AS reusable
         FROM mobile_otp_codes
        WHERE email = $1 AND consumed_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
          FOR UPDATE`,
      [email]
    );
    if (rows[0] && rows[0].reusable) return true;
    // Outside the window, expired, or already guessed at: replace it.
    await client.query(
      'DELETE FROM mobile_otp_codes WHERE email = $1 AND consumed_at IS NULL',
      [email]
    );
    return false;
  });
  if (reused) return email;

  await cleanupExpiredState(pool);

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  await pool.query(
    `INSERT INTO mobile_otp_codes
       (email, code_hash, attempts, expires_at, created_at, updated_at)
     VALUES ($1, $2, 0, $3, NOW(), NOW())`,
    [email, codeHash, expiresAt]
  );
  await mail.sendOtpMail(config, email, code);
  return email;
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

// Refusals that mean "the code was right, but a code cannot sign this account
// in". They are distinct from `invalid_or_expired_code` so the sign-in screen
// can route the person to the password form instead of implying they mistyped.
const PASSWORD_REQUIRED_MESSAGE =
  'This account signs in with a password. Enter it below to continue.';
const ADMIN_PASSWORD_REQUIRED_MESSAGE =
  'This admin account signs in with a password. Enter it below to continue.';

// How many times a colliding placeholder is replaced before the insert
// gives up and lets the error through.
const USERNAME_INSERT_ATTEMPTS = 3;

/**
 * Create the account an email code just proved the mailbox for (#2563).
 *
 * `username` is an opaque PLACEHOLDER (`member_<hex>`), never the address
 * and, since #3575, never a name derived from it either: the person types
 * their own at the set-password step, which will not finish without one
 * (completePassword below). `needs_username_choice` is TRUE, which is what
 * makes that step ask. `needs_communities_choice` is TRUE for the same
 * reason one step later: a new account is asked which communities to join
 * before its first Home (communities, stage 5; src/services/onboarding.js).
 * `getting_started_gate` is TRUE because it is a NEW account: its Getting
 * started card is the season's First challenges, and the rest of the season
 * waits on them (the note beside the column in src/db/schema.sql).
 *
 * The retry loop is a backstop for a 72-bit placeholder colliding, which
 * should never happen; it was load-bearing when the first candidate was a
 * derived suggestion two simultaneous `ada@` sign-ups could both be handed.
 * SAVEPOINT, because a failed statement poisons the whole transaction
 * otherwise and this one still has the consumed OTP in it. A collision on
 * the EMAIL index is a different race with a different answer — a new
 * username would not resolve it — so it is re-thrown.
 */
async function insertEmailUser(client, email, passwordHash) {
  let candidate = usernames.placeholderUsername();

  for (let attempt = 0; ; attempt += 1) {
    await client.query('SAVEPOINT email_signup_username');
    try {
      const { rows } = await client.query(
        `INSERT INTO users
           (username, password, email, email_confirmed, email_confirmed_at,
            password_set, is_admin, needs_username_choice, needs_communities_choice,
            getting_started_gate)
         VALUES ($1, $2, $3, TRUE, NOW(), FALSE, FALSE, TRUE, TRUE, TRUE)
         RETURNING id, username, is_admin, password_set, needs_username_choice`,
        [candidate, passwordHash, email]
      );
      await client.query('RELEASE SAVEPOINT email_signup_username');
      return rows[0];
    } catch (error) {
      const emailCollision = typeof error.constraint === 'string'
        && error.constraint.includes('email');
      if (error.code !== '23505' || emailCollision
          || attempt >= USERNAME_INSERT_ATTEMPTS) {
        throw error;
      }
      await client.query('ROLLBACK TO SAVEPOINT email_signup_username');
      log.warn('email-signup', 'Placeholder username was taken; retrying', {
        attempt: attempt + 1,
      });
      candidate = usernames.placeholderUsername();
    }
  }
}

async function verifyCode(pool, rawEmail, rawCode, { createSession } = {}) {
  const email = normalizeEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!email || !code) {
    throw new EmailSignupError('invalid_or_expired_code', 'Invalid or expired code.');
  }

  const result = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `SELECT id, code_hash, attempts, expires_at
         FROM mobile_otp_codes
        WHERE email = $1 AND consumed_at IS NULL
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [email]
    );
    const otp = rows[0];
    if (!otp || new Date(otp.expires_at) < new Date() || otp.attempts >= MAX_OTP_ATTEMPTS) {
      return { invalid: true };
    }

    if (!await bcrypt.compare(code, otp.code_hash)) {
      await client.query(
        'UPDATE mobile_otp_codes SET attempts = attempts + 1, updated_at = NOW() WHERE id = $1',
        [otp.id]
      );
      return { invalid: true };
    }

    await client.query(
      'UPDATE mobile_otp_codes SET consumed_at = NOW(), updated_at = NOW() WHERE id = $1',
      [otp.id]
    );

    const { rows: existingRows } = await client.query(
      `SELECT id, username, is_admin, admin_readonly, password_set, email_confirmed,
              needs_username_choice
         FROM users
        WHERE lower(email) = lower($1)
        FOR UPDATE`,
      [email]
    );
    let user = existingRows[0] || null;

    // The code is already consumed at this point, on every branch below. A
    // correct code must never be replayable, and neither refusal is
    // retry-able with the same code anyway.
    if (user && user.is_admin) return { refuse: 'admin_password_required' };
    if (user && user.password_set && !user.email_confirmed) {
      return { refuse: 'password_required' };
    }

    // An account with a password and a confirmed email address is signed
    // straight in: whoever reads that mailbox can already take the account
    // over through "Forgot password?", so this grants no new capability.
    if (user && user.password_set) {
      if (typeof createSession !== 'function') {
        // Programming error: throwing rolls the transaction back, so the code
        // stays unconsumed and the person can retry it.
        throw new Error('verifyCode requires createSession to sign an existing account in');
      }
      const session = await createSession(client, user.id);
      return {
        next: 'signed-in',
        session,
        userId: user.id,
        user: {
          id: user.id,
          username: user.username,
          isAdmin: !!user.is_admin,
          adminReadonly: !!user.admin_readonly,
        },
      };
    }

    let created = false;
    if (!user) {
      const unusablePasswordHash = await bcrypt.hash(
        crypto.randomBytes(32).toString('hex'),
        12
      );
      // #2563: the address is NOT the handle. It used to be — `VALUES
      // ($1, …)` with `email` in both slots — so every member who signed
      // up by email code wore their own address in front of everyone else
      // on the platform. What goes in now is an opaque placeholder (#3575:
      // not a name derived from the local part either), and the row is
      // marked `needs_username_choice`, so the set-password step asks for
      // the handle and refuses to finish without one.
      //
      // The flag, not the string, is what drives the ask: the server
      // knows this account has never chosen, and no client has to infer it
      // from what the name looks like.
      user = await insertEmailUser(client, email, unusablePasswordHash);
      created = true;
    } else if (!user.email_confirmed) {
      // Reading the code proves the mailbox. Stamping it here stops
      // password-less rows from ageing into the refusal branch above, and
      // unlocks "Forgot password?" for them.
      await client.query(
        `UPDATE users
            SET email_confirmed = TRUE, email_confirmed_at = NOW()
          WHERE id = $1`,
        [user.id]
      );
    }

    const signupToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SIGNUP_TTL_MS);
    await client.query(
      `INSERT INTO web_signup_sessions (token_hash, user_id, expires_at, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET token_hash = EXCLUDED.token_hash,
             expires_at = EXCLUDED.expires_at,
             created_at = NOW()`,
      [tokenHash(signupToken), user.id, expiresAt]
    );
    return {
      next: 'set-password',
      signupToken,
      expiresAt,
      userId: user.id,
      created,
      // QA 2026-09-24 Q12: the account still owes a choice of handle, so the
      // password step asks for it rather than the person meeting a name
      // they never chose in the waiting room. #4596: the field arrives
      // holding a suggestion from the address (`suggestedUsername`, below),
      // which the person can change; set-password still takes only what
      // the field sends.
      needsUsernameChoice: user.needs_username_choice === true,
    };
  });

  if (result.invalid) {
    throw new EmailSignupError('invalid_or_expired_code', 'Invalid or expired code.');
  }
  if (result.refuse === 'password_required') {
    throw new EmailSignupError('password_required', PASSWORD_REQUIRED_MESSAGE);
  }
  if (result.refuse === 'admin_password_required') {
    throw new EmailSignupError('admin_password_required', ADMIN_PASSWORD_REQUIRED_MESSAGE);
  }
  if (result.created) {
    await waitlist.linkUserByEmail(pool, { userId: result.userId, email });
  }
  // #4083: an account the code proved and nothing let in has a waitlist
  // spot of its own, so an admin can find it there and let it in.
  if (result.next === 'set-password') {
    await waitlist.ensureAccountSignup(pool, { userId: result.userId });
  }
  // The code proved this mailbox, on a new account or an unconfirmed one:
  // any project invites waiting on the address become this account's.
  // Best-effort, and it never throws.
  if (result.next === 'set-password') {
    await require('./email-invites').claimEmailInvites(pool, { userId: result.userId, email });
  }
  if (result.next === 'set-password') {
    result.waitlisted = await isWaitlisted(pool, result.userId);
  }
  if (result.next === 'set-password' && result.needsUsernameChoice) {
    result.suggestedUsername = await suggestedUsername(pool, email, result.userId);
  }
  return result;
}

/**
 * The handle the set-password step's username field arrives holding
 * (#4596, usernames.suggestUsernameForEmail). Best effort: a failed read
 * answers null, an empty field, rather than failing the code that worked.
 */
async function suggestedUsername(pool, email, userId) {
  try {
    return await usernames.suggestUsernameForEmail(pool, email, userId);
  } catch (error) {
    log.warn('email-signup', 'Username suggestion failed', { message: error.message });
    return null;
  }
}

/**
 * Will this account land in the waiting room? Read AFTER linkUserByEmail,
 * which grants access on the spot to an address the waitlist already
 * released. Best effort: a failed read answers null ("cannot tell"), and the
 * client then says nothing either way rather than something untrue.
 */
async function isWaitlisted(pool, userId) {
  try {
    const { rows } = await pool.query(
      'SELECT has_platform_access, is_admin FROM users WHERE id = $1',
      [userId]
    );
    if (!rows.length) return null;
    return !(rows[0].has_platform_access || rows[0].is_admin);
  } catch (error) {
    log.warn('email-signup', 'Waitlist state read failed', { message: error.message });
    return null;
  }
}

/**
 * Set the password and the first handle, then sign in.
 *
 * `username` is REQUIRED for an account that has never chosen one (#3575)
 * and ignored for an account that has. QA 2026-09-24 Q12 made the
 * set-password step ask a new account for its handle, prefilled with a
 * suggestion derived from the address, but left the field optional: a
 * caller that sent none finished sign-up under that suggestion, and the
 * first-run gate asked only later, at release. "Do not just generate a
 * username from their email. They should have to manually set a username"
 * is a rule about the SERVER, not about one form, so the refusal is here: a
 * new email account cannot get a session until it has typed a handle. It
 * takes the same path POST /api/me/username/choose does (validateUsername,
 * checkAvailability, chooseFirstUsername's `needs_username_choice` guard).
 *
 * Every username refusal — missing, malformed or taken — is raised BEFORE
 * the signup session is spent, so the person fixes the field and submits
 * again with the same cookie.
 */
async function completePassword(pool, { signupToken, password, username = null, createSession }) {
  if (typeof signupToken !== 'string' || !/^[a-f0-9]{64}$/.test(signupToken)) {
    throw new EmailSignupError('invalid_signup_session', 'Your signup session expired. Request a new code.');
  }
  let chosen = null;
  if (username != null && username !== '') {
    const check = usernames.validateUsername(username);
    if (!check.ok) throw new EmailSignupError('invalid_username', check.error);
    chosen = check.value;
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new EmailSignupError('invalid_password', 'Password must be at least 8 characters.');
  }
  const passwordHash = await bcrypt.hash(password, 12);

  let result;
  try {
    result = await withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `SELECT w.user_id, w.expires_at, u.username, u.is_admin,
                u.admin_readonly, u.password_set, u.needs_username_choice
           FROM web_signup_sessions w
           JOIN users u ON u.id = w.user_id
          WHERE w.token_hash = $1
          FOR UPDATE OF w, u`,
        [tokenHash(signupToken)]
      );
      const signup = rows[0];
      if (!signup || new Date(signup.expires_at) < new Date()) {
        return { invalid: true };
      }

      // #3575: an account that has never chosen a handle does not finish
      // sign-up without one. Returned, not thrown, like the taken case
      // below: nothing has been written, so the signup session survives
      // for the submit that carries a name.
      if (!chosen && signup.needs_username_choice === true) {
        return { usernameRequired: true };
      }
      const choosing = chosen && signup.needs_username_choice === true;
      if (choosing) {
        const free = await usernames.checkAvailability(client, chosen, signup.user_id);
        // Returned, not thrown: nothing has been written, so COMMIT is a
        // no-op and the signup session survives for the corrected submit.
        if (!free.available) return { usernameTaken: free.error };
      }

      await client.query('DELETE FROM web_signup_sessions WHERE token_hash = $1', [tokenHash(signupToken)]);
      if (signup.is_admin || signup.password_set) return { invalid: true };

      await client.query(
        'UPDATE users SET password = $1, password_set = TRUE WHERE id = $2',
        [passwordHash, signup.user_id]
      );
      let handle = signup.username;
      if (choosing) {
        const taken = await usernames.chooseFirstUsername(client, signup.user_id, chosen);
        if (taken) handle = taken.username;
      }
      const session = await createSession(client, signup.user_id);
      return {
        session,
        user: {
          id: signup.user_id,
          username: handle,
          isAdmin: !!signup.is_admin,
          adminReadonly: !!signup.admin_readonly,
        },
      };
    });
  } catch (error) {
    // The unique index and the two BEFORE triggers (case-variant, retired)
    // are the backstop behind checkAvailability: somebody took the name in
    // the gap. The whole transaction rolled back, signup session included.
    if (chosen && error && error.code === '23505') {
      throw new EmailSignupError('username_taken', 'That username is taken.');
    }
    throw error;
  }

  if (result.usernameRequired) {
    // The sentence validateUsername gives an empty field, so the step reads
    // the same whether the browser or the server caught it.
    throw new EmailSignupError('username_required', usernames.validateUsername('').error);
  }
  if (result.usernameTaken) {
    throw new EmailSignupError('username_taken', result.usernameTaken);
  }
  if (result.invalid) {
    throw new EmailSignupError('invalid_signup_session', 'Your signup session expired. Request a new code.');
  }
  return result;
}

module.exports = {
  EmailSignupError,
  OTP_TTL_MS,
  SIGNUP_TTL_MS,
  // Shared with Apple and Google sign-in (services/sign-in-providers.js),
  // which makes the same account for an address the provider vouched for.
  insertEmailUser,
  normalizeEmail,
  requestCode,
  verifyCode,
  completePassword,
};
