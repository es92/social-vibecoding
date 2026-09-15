// Platform waitlist + platform-access grants (onboarding flow alignment).
//
// The waitlist is keyed by EMAIL, not by user (waitlist_signups in
// schema.sql): anyone can join from the public landing page with just an
// email, and an admin can release an email before its owner has an
// account. "Release" (released_at set) means: platform access is granted
// the moment a matching account exists — immediately if one already
// does, or at account creation via linkUserByEmail below.
//
// `users.has_platform_access` gates the SV platform surfaces (home /
// social / build — enforced in src/middleware/auth.js). It does NOT gate
// login-required child apps; any account may mint iframe tokens and use
// apps, per the onboarding doc's state ladder.
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const log = require('./logger');
const { ANSWERS_VERSION } = require('./waitlist-questions');

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 255) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
  return trimmed;
}

// Join the platform waitlist. Idempotent by email: re-joining is a
// silent no-op at the DATABASE level (the original submitted_at is kept).
// Returns { created, moreToken, submittedAt } — created=false means the
// email already had a row, and moreToken is null in that case: the
// stage-2 capability link only goes to the FIRST join (and its email),
// never to whoever types the same address again later.
//
// `created` is no longer only an internal detail. The join endpoint now
// answers the three cases differently (#2201, app owner's decision), so
// this flag plus the existing row's confirmed_at is what picks the
// branch. The capability token is the part that did NOT widen: a
// re-join still gets null, whatever else the response says.
async function joinWaitlist(pool, { email, ip = null, answers = null, inviteCode = null }) {
  const moreToken = crypto.randomBytes(24).toString('hex');
  const stored = answers
    ? { _version: ANSWERS_VERSION, ...answers }
    : null;

  // Resolve the inviter BEFORE the insert, and treat an unresolvable code
  // as no code at all: someone arriving on a stale, mistyped or invented
  // ?ref= link must still be able to join.
  let invitedBy = null;
  if (typeof inviteCode === 'string' && /^[a-z0-9]{10}$/.test(inviteCode)) {
    const { rows } = await pool.query(
      'SELECT id FROM waitlist_signups WHERE invite_code = $1',
      [inviteCode]
    );
    if (rows[0]) invitedBy = rows[0].id;
  }

  // Attribution rides on the INSERT, so ON CONFLICT DO NOTHING already
  // means an existing row can never be re-parented by someone
  // re-submitting with a different code. There is deliberately no
  // separate UPDATE path.
  // RETURNING submitted_at, so a first join can report its own status
  // block without a second round trip. ON CONFLICT DO NOTHING returns no
  // row, which is still exactly how a re-join is detected.
  const { rows } = await pool.query(
    `INSERT INTO waitlist_signups (email, ip, answers, more_token, invited_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO NOTHING
     RETURNING submitted_at`,
    [email, ip, stored ? JSON.stringify(stored) : null, moreToken, invitedBy]
  );
  const created = rows.length > 0;
  return {
    created,
    moreToken: created ? moreToken : null,
    submittedAt: created ? rows[0].submitted_at : null,
  };
}

// The shareable half of a signup's invite link. Minted on first ask and
// stable thereafter — by the second call the link may already be in
// somebody's group chat. Returns null for a signup that does not exist,
// rather than minting a code for nothing.
async function inviteCodeFor(pool, signupId) {
  const { rows } = await pool.query(
    'SELECT invite_code FROM waitlist_signups WHERE id = $1',
    [signupId]
  );
  if (!rows[0]) return null;
  if (rows[0].invite_code) return rows[0].invite_code;

  const code = crypto.randomBytes(8).toString('hex').slice(0, 10);
  // COALESCE so two concurrent asks cannot hand out two different links
  // for the same signup; the first write wins and both callers see it.
  const { rows: updated } = await pool.query(
    `UPDATE waitlist_signups
        SET invite_code = COALESCE(invite_code, $1)
      WHERE id = $2
      RETURNING invite_code`,
    [code, signupId]
  );
  return updated[0] ? updated[0].invite_code : null;
}

// Mask an address for display back to the person who invited it. Enough
// to recognise a friend who joined, never a harvestable list — and never
// something that still looks like a working address when the column holds
// something unexpected.
function maskEmail(email) {
  const [local, domain] = String(email == null ? '' : email).split('@');
  if (!domain || !local) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

// Who this signup brought in, oldest first. The count is the honest
// number; the addresses are masked.
async function invitedBySignup(pool, signupId) {
  const { rows } = await pool.query(
    'SELECT email FROM waitlist_signups WHERE invited_by = $1 ORDER BY submitted_at ASC, id ASC',
    [signupId]
  );
  return { count: rows.length, emails: rows.map((r) => maskEmail(r.email)) };
}

// Look up a signup by its stage-2 capability token. Returns the row
// (id, email, answers) or null.
async function getSignupByMoreToken(pool, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
  const { rows } = await pool.query(
    // submitted_at / confirmed_at / released_at / linked_user_id back the
    // status block the stage-2 screen renders; the other callers of this
    // function read only id and answers, so widening it is additive.
    `SELECT id, email, answers, submitted_at, confirmed_at, released_at, linked_user_id
       FROM waitlist_signups WHERE more_token = $1`,
    [token]
  );
  return rows[0] || null;
}

// Confirm the email address behind a stage-2 capability token — the
// one-click link carried in the join mail. Idempotent: the original
// timestamp is kept, so a forwarded or re-opened link is harmless.
// Returns the row (with confirmed_at) or null when the token doesn't
// resolve, so the caller can 404 an unknown link rather than pretending.
async function confirmSignupByMoreToken(pool, token) {
  const row = await getSignupByMoreToken(pool, token);
  if (!row) return null;
  const { rows } = await pool.query(
    `UPDATE waitlist_signups
        SET confirmed_at = COALESCE(confirmed_at, NOW())
      WHERE id = $1
      RETURNING id, email, confirmed_at`,
    [row.id]
  );
  return rows[0] || null;
}

// How long a verification code lives, and how many wrong guesses it
// survives. Both mirror mobile_otp_codes rather than inventing new
// numbers — somebody reading a code out of their mail is the same person
// in the same hurry either way.
const CODE_TTL_MINUTES = 15;
const MAX_CODE_ATTEMPTS = 5;

// The signup row for an address, or null. The by-token lookup above is a
// capability check; this is the plain one, and it exists for the resend
// endpoint, which has to know three things before it decides what to mail:
// whether the address is on the list at all, whether it is already
// confirmed, and which more_token to carry.
//
// It returns a row rather than a boolean, and WHICH CALLER reads it now
// matters. POST /resend still answers every branch with the same words, so
// nothing from here reaches that response. POST /api/public/waitlist does
// not: #2201 makes the join endpoint report membership and confirmed state
// deliberately, so the columns below back signupStatus() there. Nothing
// here is non-enumerating on its own; the caller decides, and the two
// callers decide differently on purpose.
//
// The column list is the whole state tuple for exactly that reason —
// submitted_at / released_at / linked_user_id are what signupStatus()
// reads, so the join branch needs no second query.
async function getSignupByEmail(pool, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const { rows } = await pool.query(
    `SELECT id, email, submitted_at, confirmed_at, released_at,
            linked_user_id, more_token
       FROM waitlist_signups
      WHERE email = $1
      LIMIT 1`,
    [normalized]
  );
  return rows[0] || null;
}

// How long a just-issued code stays reusable. Mirrors
// OTP_REUSE_WINDOW_SECONDS in services/email-signup.js, which solved this
// exact bug class for the account OTP flow.
//
// The failure it prevents: issueVerificationCode below DELETEs every
// unconsumed code before it INSERTs, and the mail throttle only decides
// afterwards. So two asks a few seconds apart used to destroy the code
// that was already in the inbox AND deliver nothing in its place
// (waitlist_code allows one send per minute per address), leaving a
// reader typing a code the database had already thrown away.
//
// "Reuse" means SKIP, not re-send: only the bcrypt hash is stored, so the
// plaintext cannot be recovered to mail again. Inside the window the
// right move is to leave the live code alone and let the mail that is
// already out do its job.
const CODE_REUSE_WINDOW_SECONDS = 60;

// Is there a live code for this address that a fresh ask should leave
// alone? True only when every part of "the code in their inbox still
// works" holds: unconsumed, unexpired, never guessed at (a wrong attempt
// means they are typing one they have, so minting a new one is what they
// asked for), and minted inside the reuse window above.
async function hasReusableCode(pool, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const { rows } = await pool.query(
    `SELECT 1
       FROM waitlist_verification_codes
      WHERE email = $1
        AND consumed_at IS NULL
        AND attempts = 0
        AND expires_at > NOW()
        AND created_at > NOW() - INTERVAL '${CODE_REUSE_WINDOW_SECONDS} seconds'
      ORDER BY id DESC
      LIMIT 1`,
    [normalized]
  );
  return rows.length > 0;
}

// Mint a six-digit verification code for an email on the waitlist.
// Returns the PLAINTEXT code for the caller to mail; only its bcrypt hash
// is stored. Any unconsumed code for the address is deleted first, so
// exactly one code is ever live and a forwarded older mail is dead.
async function issueVerificationCode(pool, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error('invalid email');
  // randomInt is the uniform generator; % 1000000 over random bytes is
  // not, and this value protects an address someone else typed.
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const hash = await bcrypt.hash(code, 10);
  await pool.query(
    'DELETE FROM waitlist_verification_codes WHERE email = $1 AND consumed_at IS NULL',
    [normalized]
  );
  await pool.query(
    `INSERT INTO waitlist_verification_codes (email, code_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '${CODE_TTL_MINUTES} minutes')`,
    [normalized, hash]
  );
  return code;
}

// Confirm a signup with the code from its join mail. Returns the signup
// row (with more_token, so the caller can hand back the stage-2
// capability) or null.
//
// The RETURNING carries the whole state tuple — submitted_at,
// released_at, linked_user_id — because #1538's "check my status" reads
// its answer straight off this row rather than making a second round
// trip. An already-confirmed row is a normal, expected caller here: the
// COALESCE below keeps its first timestamp and everything else is a
// plain read.
//
// EVERY failure returns the same null — unknown email, malformed code,
// wrong code, expired, already consumed, too many attempts — so this can
// never be used to test whether an address is on the list. That is the
// same non-enumeration contract joinWaitlist keeps.
async function confirmSignupByCode(pool, email, code) {
  const normalized = normalizeEmail(email);
  if (!normalized || typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) return null;

  const { rows } = await pool.query(
    `SELECT id, code_hash, attempts, expires_at
       FROM waitlist_verification_codes
      WHERE email = $1 AND consumed_at IS NULL
      ORDER BY id DESC
      LIMIT 1`,
    [normalized]
  );
  const entry = rows[0];
  if (!entry) return null;
  if (new Date(entry.expires_at) < new Date()) return null;
  if (entry.attempts >= MAX_CODE_ATTEMPTS) return null;

  const matches = await bcrypt.compare(code, entry.code_hash);
  if (!matches) {
    await pool.query(
      'UPDATE waitlist_verification_codes SET attempts = attempts + 1 WHERE id = $1',
      [entry.id]
    );
    return null;
  }

  await pool.query(
    'UPDATE waitlist_verification_codes SET consumed_at = NOW() WHERE id = $1',
    [entry.id]
  );
  // COALESCE, not a plain assignment: the mailed LINK may have confirmed
  // this row already, and the first timestamp is the true one.
  const { rows: signup } = await pool.query(
    `UPDATE waitlist_signups
        SET confirmed_at = COALESCE(confirmed_at, NOW())
      WHERE email = $1
      RETURNING id, email, submitted_at, confirmed_at, released_at,
                linked_user_id, more_token`,
    [normalized]
  );
  return signup[0] || null;
}

// Merge a validated stage-2 payload into the signup's answers. Merging
// is section-wise (mirrors topochain's Participant::mergeAnswers): a
// re-submitted section replaces that section, untouched sections keep
// their previous value, so the form is re-openable and fillable over
// several visits. Returns the merged answers, or null when the token
// doesn't resolve.
async function mergeMoreAnswers(pool, token, patch) {
  const row = await getSignupByMoreToken(pool, token);
  if (!row) return null;
  const current = row.answers && typeof row.answers === 'object' ? row.answers : {};
  const merged = { ...current, ...patch, _version: ANSWERS_VERSION };
  await pool.query(
    `UPDATE waitlist_signups SET answers = $1 WHERE id = $2`,
    [JSON.stringify(merged), row.id]
  );
  return merged;
}

// Record an OAuth-verified social handle (github / x) on the signup.
// Verified handles live under answers.verified so they are distinct
// from the self-reported answers.handles entries.
async function setVerifiedHandle(pool, token, provider, handle) {
  const row = await getSignupByMoreToken(pool, token);
  if (!row) return null;
  const current = row.answers && typeof row.answers === 'object' ? row.answers : {};
  const verified = { ...(current.verified || {}), [provider]: handle };
  const merged = { ...current, verified, _version: ANSWERS_VERSION };
  await pool.query(
    `UPDATE waitlist_signups SET answers = $1 WHERE id = $2`,
    [JSON.stringify(merged), row.id]
  );
  return merged;
}

// Grant platform access to a user (idempotent — re-granting keeps the
// original granted_at). Used by the release paths and by the signup
// surfaces that are invite-equivalent (activation codes, genesis wallet
// registration).
async function grantPlatformAccess(pool, userId) {
  await pool.query(
    `UPDATE users
        SET has_platform_access = TRUE,
            platform_access_granted_at = COALESCE(platform_access_granted_at, NOW())
      WHERE id = $1 AND has_platform_access = FALSE`,
    [userId]
  );
}

// Account-creation linkage: point the email's waitlist row (if any) at
// the new user, and if that row was already released, grant platform
// access on the spot — this is the doc's "released off the waitlist,
// create an account if you haven't already" arrow. Best-effort: a
// failure here must never fail the signup itself.
async function linkUserByEmail(pool, { userId, email }) {
  const normalized = normalizeEmail(email);
  if (!normalized || !userId) return;
  try {
    const { rows } = await pool.query(
      `UPDATE waitlist_signups
          SET linked_user_id = $1
        WHERE email = $2
        RETURNING released_at`,
      [userId, normalized]
    );
    if (rows[0] && rows[0].released_at) {
      await grantPlatformAccess(pool, userId);
      log.info('waitlist', 'Released waitlist email registered — access granted', { userId });
    }
  } catch (err) {
    log.error('waitlist', 'linkUserByEmail failed', { userId, message: err.message });
  }
}

// Admin release of a waitlist row. Sets released_at (idempotent) and, if
// an account is already linked (or one exists with the same email),
// grants it platform access immediately. Returns the updated row or
// null when the id doesn't exist. `newly_released` distinguishes the
// first release from an idempotent re-release so the caller can send
// the "you're in" notification exactly once.
async function releaseWaitlistSignup(pool, signupId) {
  const { rows } = await pool.query(
    `WITH prev AS (
        SELECT released_at FROM waitlist_signups WHERE id = $1
     )
     UPDATE waitlist_signups w
        SET released_at = COALESCE(w.released_at, NOW())
      WHERE w.id = $1
      RETURNING w.id, w.email, w.released_at, w.linked_user_id, w.more_token,
                (SELECT prev.released_at FROM prev) IS NULL AS newly_released`,
    [signupId]
  );
  const row = rows[0];
  if (!row) return null;

  let userId = row.linked_user_id;
  if (!userId) {
    // The account may predate the waitlist row (or linkage was missed) —
    // resolve by email and backfill the link.
    const { rows: userRows } = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [row.email]
    );
    if (userRows[0]) {
      userId = userRows[0].id;
      await pool.query(
        'UPDATE waitlist_signups SET linked_user_id = $1 WHERE id = $2',
        [userId, row.id]
      );
    }
  }
  if (userId) await grantPlatformAccess(pool, userId);
  return { ...row, linked_user_id: userId };
}

module.exports = {
  MAX_CODE_ATTEMPTS,
  CODE_REUSE_WINDOW_SECONDS,
  normalizeEmail,
  joinWaitlist,
  getSignupByMoreToken,
  getSignupByEmail,
  hasReusableCode,
  confirmSignupByMoreToken,
  issueVerificationCode,
  confirmSignupByCode,
  inviteCodeFor,
  invitedBySignup,
  maskEmail,
  mergeMoreAnswers,
  setVerifiedHandle,
  grantPlatformAccess,
  linkUserByEmail,
  releaseWaitlistSignup,
};
