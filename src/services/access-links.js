'use strict';

/**
 * Admin invite links to Homeroom itself: an activation code, sent as a link.
 *
 * An admin makes one per person in Admin › Activation codes
 * (routes/admin.js) and sends `/welcome/<code>`. The person who opens it
 * signs up the usual way (an email code, a phone, Apple or Google), and the
 * account that comes out of it is let in at once: no waitlist, and no
 * project attached. It is the admin's tool for somebody who should try
 * Homeroom now, a creator deciding whether to take part in a campaign, say,
 * where a project's invite link (services/community-invites.js) would bring
 * them into one project and leave them waiting for the platform.
 *
 * One link is one account. The code is spent by the account it lets in
 * (`activation_codes.used_by`), claimed with the same guarded UPDATE the
 * register form uses (routes/auth.js /api/auth/register), so two sign-ups
 * racing on one link cannot both get in. An account that already has
 * access spends nothing: the link stays free for the person it was meant
 * for.
 *
 * The page leaves the code in an HttpOnly cookie (`hr_access`), the way an
 * invite page leaves its token (community-invites.js INVITE_COOKIE), so the
 * sign-in that follows lets the account in server-side whatever the browser
 * did in between: the sheet's email code, a provider's round trip, a phone.
 * Opening the page spends nothing. A link checker or an unfurler that GETs
 * it has no account to let in, and the code is spent only by a sign-in.
 *
 * The older `#register/<code>` form still takes a code by hand.
 */

const log = require('./logger');
const { protectedCookieName, requestCookieSecure } = require('./browser-session-cookies');

// The codes Admin › Activation codes makes are 12 hex characters
// (routes/admin.js); the column holds up to 32. Anything else is no code,
// told so without a query.
const CODE_RE = /^[A-Za-z0-9_-]{6,32}$/;

const ACCESS_COOKIE = 'hr_access';
const ACCESS_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// What the admin types beside a link: who it is for. Never shown to the
// person who opens it.
const NOTE_MAX = 200;

function isCode(value) {
  return typeof value === 'string' && CODE_RE.test(value);
}

/** The path an admin sends. */
function linkPath(code) {
  return `/welcome/${encodeURIComponent(code)}`;
}

function cleanNote(value) {
  if (typeof value !== 'string') return null;
  const note = value.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  return note || null;
}

/**
 * What the page may say about a link before anybody signs in: whether it
 * still lets somebody in. Nothing else: not who it is for, not who made it,
 * not who used it.
 */
async function preview(pool, code) {
  if (!isCode(code)) return { live: false, reason: 'unknown' };
  const { rows } = await pool.query(
    'SELECT used_by IS NOT NULL OR used_at IS NOT NULL AS used FROM activation_codes WHERE code = $1',
    [code]
  );
  if (!rows[0]) return { live: false, reason: 'unknown' };
  if (rows[0].used) return { live: false, reason: 'used' };
  return { live: true, reason: null };
}

/**
 * Let account `userId` in with `code`. Answers what happened:
 *
 *   'let_in'      the code was free and is this account's now; it has access
 *   'already_in'  the account had access already (or is an admin); the code
 *                 is left as it was
 *   'used'        another account spent it first
 *   'unknown'     no such code, or no such account
 *
 * The claim and the grant are one transaction: the grant's UPDATE is the
 * one a release by hand runs (waitlist.grantPlatformAccess), so what that
 * sets off (Homeroom's community, queued invites, the welcome message)
 * happens here too, and it is not a release by hand: no generation-0
 * invite skips.
 */
async function admit(pool, { code, userId }) {
  if (!isCode(code) || !userId) return { status: 'unknown' };
  const { withTransaction } = require('./cli-auth');
  const waitlist = require('./waitlist');
  return withTransaction(pool, async (client) => {
    const { rows: users } = await client.query(
      'SELECT has_platform_access, is_admin FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (!users[0]) return { status: 'unknown' };
    if (users[0].has_platform_access || users[0].is_admin) return { status: 'already_in' };
    const claim = await client.query(
      `UPDATE activation_codes SET used_by = $1, used_at = NOW()
        WHERE code = $2 AND used_by IS NULL AND used_at IS NULL
        RETURNING id`,
      [userId, code]
    );
    if (claim.rowCount !== 1) {
      const { rows } = await client.query('SELECT 1 FROM activation_codes WHERE code = $1', [code]);
      return { status: rows[0] ? 'used' : 'unknown' };
    }
    await waitlist.grantPlatformAccess(client, userId);
    return { status: 'let_in', codeId: claim.rows[0].id };
  });
}

// ── Carrying a link through sign-in ────────────────────────────────────
//
// Secure (always in production, else over HTTPS) the cookie is
// `__Host-hr_access`, Path=/ with no Domain, so an app on a sibling host
// cannot plant a code for a sign-in to spend, exactly as the invite cookie.

function accessCookieOptions(req) {
  return { httpOnly: true, sameSite: 'lax', secure: requestCookieSecure(req), path: '/' };
}

function accessCookieName(req) {
  return protectedCookieName(ACCESS_COOKIE, requestCookieSecure(req));
}

function setAccessCookie(req, res, code) {
  res.cookie(accessCookieName(req), code, { ...accessCookieOptions(req), maxAge: ACCESS_COOKIE_MAX_AGE_MS });
}

function clearAccessCookie(req, res) {
  res.clearCookie(accessCookieName(req), accessCookieOptions(req));
}

/** The code this request's browser carries through sign-in, if any. */
function carriedCode(req) {
  const code = req.cookies?.[accessCookieName(req)];
  return isCode(code) ? code : null;
}

/**
 * Let the account a sign-in found or made in with the link its browser
 * carried, if any, and clear the cookie: a sign-in uses it once, whatever
 * the answer. Never throws: signing in must not fail because a link did.
 * Resolves the `admit` answer, or null when nothing was carried.
 */
async function admitCarried(pool, req, res, userId) {
  const raw = req.cookies?.[accessCookieName(req)];
  if (raw === undefined) return null;
  clearAccessCookie(req, res);
  if (!isCode(raw) || !userId) return null;
  return admitWith(pool, raw, userId);
}

/**
 * `admit`, logged and recorded, never throwing. For a caller that has the
 * code in hand: the carried cookie (admitCarried), or the page itself when
 * an account that is signed in and still waiting opens a link
 * (POST /api/auth/access-link).
 */
async function admitWith(pool, code, userId) {
  try {
    const result = await admit(pool, { code, userId });
    if (result.status === 'let_in') {
      log.info('access-links', 'Admin invite link let an account in', { userId, codeId: result.codeId });
      const events = require('./events');
      // Awaited, and it never throws: Admin › Journey reads it with the grant.
      await events.record(pool, { type: events.EVENT_TYPES.ACCESS_LINK_LET_IN, userId, metadata: { codeId: result.codeId } });
    } else if (result.status === 'used') {
      log.info('access-links', 'Admin invite link was already used', { userId });
    }
    return result;
  } catch (err) {
    log.warn('access-links', 'Letting an account in with an admin invite link failed', { userId, err: err.message });
    return { status: 'failed' };
  }
}

module.exports = {
  ACCESS_COOKIE,
  NOTE_MAX,
  isCode,
  linkPath,
  cleanNote,
  preview,
  admit,
  admitWith,
  admitCarried,
  carriedCode,
  accessCookieName,
  setAccessCookie,
  clearAccessCookie,
};
