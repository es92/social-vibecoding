'use strict';

/**
 * Firebase Phone Auth sign-in and sign-up (services/firebase-phone-auth.js),
 * beside the email code (routes/auth.js) and Apple/Google
 * (routes/sign-in-providers.js):
 *
 *   GET  /api/auth/phone/recaptcha the reCAPTCHA site key a web request
 *                                  answers first (services/firebase-phone-auth.js)
 *   POST /api/auth/phone/request   text a code to a phone number
 *   POST /api/auth/phone/verify    the code, or an ID token a client SDK
 *                                  earned with its own Firebase exchange
 *   POST /api/auth/phone/finish    the username step, for a brand-new account
 *                                  whose verify carried no name
 *
 * and, for an account that is signed in already and has no phone (made by
 * email, say, and waiting), mounted under /api/auth/ so the platform-access
 * gate lets a waiting account reach them, but outside the pre-login
 * /api/auth/phone/ prefix so the session is read:
 *
 *   POST /api/auth/phone-link/request  text a code, as above
 *   POST /api/auth/phone-link/verify   link the number to this account and
 *                                      join the links it is queued on as a
 *                                      private member (community-invites.js)
 *
 * The invite sheet's phone steps call these (sign-in-sheet.tsx `phone`).
 * The answers are shaped exactly like the email code's and the native OAuth
 * endpoints' JSON, so the sheet routes them identically (`next`, `created`,
 * the user block with roleFields).
 *
 * The offer gate is fail-closed: any of the four Firebase values missing
 * (config.js) leaves every endpoint here answering 404 not_offered, and
 * the waitlist options route advertises the flow as absent — unless
 * PHONE_TEST_CODE turns test numbers on, on a stack that is not production,
 * or SHOTS_PHONE_TEST_CODE does on a before & after shots copy
 * (services/firebase-phone-auth.js, TEST NUMBERS).
 *
 * Like the OAuth finish route, verify and finish mint sessions, so they
 * sit in routes/auth.js's SESSION_MINT_PATHS and are refused 409
 * logout_required over a live session before any credential is consumed.
 *
 * Every failure these four endpoints answer (the PhoneAuthError refusals
 * and the unexpected 500s alike) is recorded in phone_auth_failures —
 * timestamp, kind, account, the number's last four digits, this API's code
 * and Firebase's own — and read back in Admin → SMS delivery
 * (routes/admin.js GET /api/admin/sms/failures). The username step
 * (/finish) is account setup after a verification that already succeeded,
 * so its field refusals are not failure-log material.
 */

const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const failureLog = require('../services/phone-failure-log');
const phoneAuth = require('../services/firebase-phone-auth');
const providers = require('../services/sign-in-providers');
const communityInvites = require('../services/community-invites');
const accessLinks = require('../services/access-links');
const challengeScorer = require('../services/topochain/challenge-scorer');
const managedOpenRouter = require('../services/openrouter-managed-keys');
const events = require('../services/events');
const waitlist = require('../services/waitlist');
const contactPreferences = require('../services/contact-preferences');
const { signUpMetadata } = require('../services/sign-up-from');
const {
  otpVerifyLimiter,
  phoneOtpRequestLimiter,
  phoneOtpRequestPhoneLimiter,
  phoneVerifyLimiter,
} = require('../middleware/rate-limits');
const { createSession, createSessionCookie, roleFields } = require('./auth');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const { protectedCookieName } = require('../services/browser-session-cookies');

// Read per call, so a cookie's writer and reader always agree.
const secureCookie = () => process.env.NODE_ENV === 'production';

// The verify leg's sessionInfo → the SAME browser's verify call, the way
// the email code's signup cookie works (routes/auth.js SIGNUP_COOKIE) and
// the way the OAuth round trip's binder does. Each is called by its bare
// name here and is `__Host-<name>` when Secure (browser-session-cookies.js
// protectedCookieName): Path=/ with no Domain, so an app on a sibling host
// cannot plant one. The bare name is plain-HTTP development's only.
function privateCookieOptions() {
  return { httpOnly: true, secure: secureCookie(), sameSite: 'lax', path: '/' };
}

function privateCookie(res, name, value, expiresAt) {
  res.cookie(protectedCookieName(name, secureCookie()), value, { ...privateCookieOptions(), expires: expiresAt });
}

// The same attributes as the write: a browser drops a `__Host-` cookie only
// for a Set-Cookie that is itself Secure, Path=/ and without a Domain.
function clearPrivateCookie(res, name) {
  res.clearCookie(protectedCookieName(name, secureCookie()), privateCookieOptions());
}

function readPrivateCookie(req, name) {
  return req.cookies?.[protectedCookieName(name, secureCookie())];
}

// The number's last four digits for the failure log. Only ever called with
// an E.164 string (normalized by the service, or claims.phoneNumber), so the
// digits are digits — a leading zero among them is ordinary.
function last4Of(phone) {
  return typeof phone === 'string' && /^[0-9]{4}$/.test(phone.slice(-4))
    ? phone.slice(-4) : null;
}

function phoneAuthRoutes(config) {
  const pool = getPool(config);
  const router = express.Router();

  // Every refusal these endpoints answer lands in the failure log as well as
  // the caller's response: kind and account say WHO was doing WHAT, the two
  // codes say WHY, and the message is what the person was told. ctx.kind is
  // set by the four endpoints below; without it (the reCAPTCHA site key read)
  // recordFailure writes nothing. Lives inside phoneAuthRoutes because it
  // writes through that router's own pool.
  async function fail(res, error, what, ctx = {}) {
    // Not a failure: the client earns a reCAPTCHA token for the Firebase
    // backup with this key and asks again (services/firebase-phone-auth.js).
    if (error instanceof phoneAuth.PhoneAuthError && error.code === 'recaptcha_backup') {
      return res.status(409).json({ error: error.message, code: error.code, siteKey: error.siteKey });
    }
    if (error instanceof phoneAuth.PhoneAuthError) {
      await failureLog.recordFailure(pool, {
        kind: ctx.kind,
        userId: ctx.userId,
        phoneLast4: last4Of(ctx.phone),
        errorCode: error.code,
        providerCode: error.providerCode || null,
        message: error.message,
      });
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    log.error('phone-auth', `${what} failed`, { message: error.message });
    await failureLog.recordFailure(pool, {
      kind: ctx.kind,
      userId: ctx.userId,
      phoneLast4: last4Of(ctx.phone),
      errorCode: 'internal',
      providerCode: null,
      message: error.message,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }

  // The offer gate is fail-closed and depends on the SELECTED provider
  // (services/sms/select.js). Its read is cached for ten seconds, but the
  // middleware still awaits it so an admin's saved switch is seen here
  // rather than only after the next boot.
  async function requireOffered(req, res, next) {
    try {
      await require('../services/sms/select').selection(pool);
    } catch { /* selection() never throws; belt and braces */ }
    if (!phoneAuth.offered(config)) {
      return res.status(404).json({ error: 'That sign-in is not set up.', code: 'not_offered' });
    }
    return next();
  }

  // The code-request buckets bound texts, and a test number sends none
  // (services/firebase-phone-auth.js, TEST NUMBERS), so it skips them: a
  // first-run loop on a local stack asks for a code every round.
  function unlessTestNumber(limiter) {
    return (req, res, next) => (phoneAuth.usesTestNumber(config, req.body?.phoneNumber)
      ? next()
      : limiter(req, res, next));
  }

  // The Firebase project's reCAPTCHA site key, for a web client to earn the
  // token the request below carries. Public by nature (it is in every page
  // Firebase's own web SDK serves), so no limiter beyond the service's cache.
  router.get('/api/auth/phone/recaptcha', requireOffered, async (req, res) => {
    try {
      const siteKey = await phoneAuth.recaptchaSiteKey(config);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ siteKey });
    } catch (error) {
      return fail(res, error, 'reCAPTCHA site key');
    }
  });

  // Requesting a code SENDS A TEXT, so this carries the same two buckets
  // the email code's request does: per address (here per phone number) so
  // one person cannot work through a list of victims, and per source so
  // one IP cannot flood many numbers.
  router.post(
    '/api/auth/phone/request',
    requireOffered,
    unlessTestNumber(phoneOtpRequestLimiter),
    unlessTestNumber(phoneOtpRequestPhoneLimiter),
    async (req, res) => {
      try {
        const sent = await phoneAuth.requestCode(
          config,
          req.body?.phoneNumber,
          req.body?.recaptchaToken,
          { pool, canBackUp: req.body?.backup === true }
        );
        return res.json({ ok: true, sessionInfo: sent.sessionInfo });
      } catch (error) {
        return fail(res, error, 'Phone code request', {
          kind: 'code_request',
          phone: phoneAuth.normalizePhone(req.body?.phoneNumber),
        });
      }
    }
  );

  router.post('/api/auth/phone/verify', requireOffered, phoneVerifyLimiter, async (req, res) => {
    // Hoisted so the catch can attach the number once the claims are in
    // hand: before that, a sessionInfo or ID token is opaque to the server.
    let claims = null;
    try {
      // Either leg lands on the same claims: the server-side exchange
      // (sessionInfo + code from this browser's own /request), or an ID
      // token a client's own Firebase SDK earned. Same verifier, same
      // spent-once guard.
      claims = req.body?.idToken
        ? await phoneAuth.verifyIdToken(pool, config, req.body.idToken)
        : await (async () => {
            // The pool spends a test number's one-time admin code.
            const exchanged = await phoneAuth.exchangeCode(
              config,
              req.body?.sessionInfo,
              req.body?.code,
              { pool }
            );
            return phoneAuth.verifyIdToken(pool, config, exchanged.idToken);
          })();
      // #5974: the session row names the browser that signed in.
      const mintSession = (db, userId) => createSession(db, userId, req);
      const result = await phoneAuth.signIn(pool, claims, { createSession: mintSession });

      // #6633: with the waitlist switched off, the account this sign-in just
      // made is let in at once (never an existing one signing in), before
      // any invite it carries is followed. Best effort; never throws.
      if (result.created) await waitlist.admitIfOpen(pool, result.userId);
      // An admin's invite link to Homeroom this browser opened
      // (/welcome/<code>, services/access-links.js): the account the phone
      // made, or one still waiting that it signed in to, is let in with it.
      // Never throws.
      await accessLinks.admitCarried(pool, req, res, result.userId);

      // An invite link this visitor opened first is followed as the account
      // the phone just CREATED, and an existing account follows it only when
      // this sign-in IS the Join its page asked for — the email code's rule,
      // word for word (routes/auth.js, where the long comment lives).
      const consented = result.created || req.body?.followInvite === true;
      const invite = consented
        ? await communityInvites.redeemCarried(pool, req, res, result.userId, { requirePhone: true })
        : await communityInvites.dropCarried(pool, req, res, result.userId);
      if (invite && invite.status === 'joined') await challengeScorer.scoreOnJoin(pool, config);

      if (result.created) {
        // #2568, for the phone-made account the same way: best effort by
        // construction (ensureIncludedKey never throws).
        await managedOpenRouter.ensureIncludedKey({
          pool, userId: result.userId, config, reason: 'signup_phone',
        });
        // The sign-up, as an email code and Apple or Google record it
        // (routes/auth.js, routes/sign-in-providers.js). A phone-made
        // account recorded none before, so the landing's phone way in went
        // uncounted.
        events.record(pool, { type: events.EVENT_TYPES.USER_SIGNED_UP, userId: result.userId, metadata: signUpMetadata(req, { via: 'phone' }) });
        // The phone step's "Homeroom news by text" box (#6044), for the
        // number just verified. Only an account this sign-in CREATED: an
        // existing one signing in is never asked. Never fails the sign-up.
        await contactPreferences.recordSignupChoices(pool, result.userId,
          contactPreferences.signupChoicesFrom(req.body), log);
      }

      // A new account whose sheet sent its name (an invite's Join): finished
      // here, with a provisional handle picked from the name, and no
      // username step. Not for a public community's invite: a public place
      // shows a username the person chose (usernames.js), so that one asks.
      const name = result.next === 'username' && !invite?.public
        ? phoneAuth.cleanName(req.body?.name) : null;
      const named = name
        ? await phoneAuth.finishWithName(pool, { signupToken: result.signupToken, name, createSession: mintSession })
        : null;
      if (named) {
        createSessionCookie(res, named.session.token, named.session.expiresAt);
        log.info('phone-auth', 'Phone sign-up finished with a name', { userId: named.user.id });
        return res.json({
          ok: true,
          next: 'signed-in',
          created: true,
          user: {
            id: named.user.id,
            username: named.user.username,
            ...roleFields(named.user.isAdmin, named.user.adminReadonly),
          },
          ...(invite ? { invite } : {}),
        });
      }

      if (result.next === 'signed-in') {
        createSessionCookie(res, result.session.token, result.session.expiresAt);
        log.info('phone-auth', 'Phone sign-in signed an account in', {
          userId: result.userId,
          created: !!result.created,
        });
        return res.json({
          ok: true,
          next: 'signed-in',
          created: !!result.created,
          user: {
            id: result.user.id,
            username: result.user.username,
            ...roleFields(result.user.isAdmin, result.user.adminReadonly),
          },
          ...(invite ? { invite } : {}),
        });
      }

      // A brand-new account continues to the username step. The
      // continuation rides this HttpOnly cookie, the way the email code's
      // signup cookie does.
      privateCookie(res, 'hr_phone_signup', result.signupToken, result.expiresAt);
      log.info('phone-auth', 'Phone sign-up created an account, username pending', {
        userId: result.userId,
      });
      return res.json({
        ok: true,
        next: 'username',
        created: !!result.created,
        ...(invite ? { invite } : {}),
      });
    } catch (error) {
      return fail(res, error, 'Phone verification', {
        kind: 'verify',
        phone: claims?.phoneNumber,
      });
    }
  });

  router.post('/api/auth/phone/finish', requireOffered, otpVerifyLimiter, async (req, res) => {
    try {
      const done = await providers.completeUsername(pool, {
        signupToken: readPrivateCookie(req, 'hr_phone_signup'),
        username: typeof req.body?.username === 'string' ? req.body.username : '',
        // #5974: the session row names the browser that signed in.
        createSession: (db, userId) => createSession(db, userId, req),
      });
      clearPrivateCookie(res, 'hr_phone_signup');
      createSessionCookie(res, done.session.token, done.session.expiresAt);
      log.info('phone-auth', 'Phone sign-up chose a username', { userId: done.user.id });
      // The username step's "Text me Homeroom news" box (#6044), for the
      // number this sign-up verified. Never fails the sign-up.
      await contactPreferences.recordSignupChoices(pool, done.user.id,
        contactPreferences.signupChoicesFrom(req.body), log);
      return res.json({
        ok: true,
        user: {
          id: done.user.id,
          username: done.user.username,
          ...roleFields(done.user.isAdmin, done.user.adminReadonly),
        },
      });
    } catch (error) {
      if (error instanceof providers.SignInProviderError) {
        // Field refusals keep the continuation, so the person fixes the
        // field and submits again (the email code's and the OAuth finish
        // route's shape); anything else spends it.
        if (error.code === 'invalid_username' || error.code === 'username_taken') {
          return res.status(422).json({ error: error.message, code: error.code, field: 'username' });
        }
        clearPrivateCookie(res, 'hr_phone_signup');
        return res.status(422).json({ error: error.message, code: error.code });
      }
      log.error('phone-auth', 'Username step failed', { message: error.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── A phone for the account signed in ─────────────────────────────────
  // The same two legs, for a session that exists: the number is linked to
  // it instead of signing anybody in, and the links it is queued on are
  // followed again, now as a private member. Same buckets as the pre-login
  // legs; the same-origin check after them (middleware/same-site-browser.js).
  function signedIn(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    return next();
  }

  router.post(
    '/api/auth/phone-link/request',
    requireOffered,
    unlessTestNumber(phoneOtpRequestLimiter),
    unlessTestNumber(phoneOtpRequestPhoneLimiter),
    sameOriginBrowserOnly,
    signedIn,
    async (req, res) => {
      try {
        const sent = await phoneAuth.requestCode(config, req.body?.phoneNumber, req.body?.recaptchaToken, {
          pool, canBackUp: req.body?.backup === true,
        });
        return res.json({ ok: true, sessionInfo: sent.sessionInfo });
      } catch (error) {
        return fail(res, error, 'Phone link code request', {
          kind: 'link_request',
          userId: req.user.id,
          phone: phoneAuth.normalizePhone(req.body?.phoneNumber),
        });
      }
    }
  );

  router.post(
    '/api/auth/phone-link/verify',
    requireOffered,
    phoneVerifyLimiter,
    sameOriginBrowserOnly,
    signedIn,
    async (req, res) => {
      // Hoisted for the catch, as in /verify above: phone_in_use and
      // phone_already_linked are decided after the claims are known, and
      // the number is the first thing an operator asks about those.
      let claims = null;
      try {
        const exchanged = await phoneAuth.exchangeCode(config, req.body?.sessionInfo, req.body?.code, { pool });
        claims = await phoneAuth.verifyIdToken(pool, config, exchanged.idToken);
        const linked = await phoneAuth.linkPhone(pool, claims, req.user.id);
        const joined = await communityInvites.joinQueued(pool, req.user.id);
        if (joined.length) await challengeScorer.scoreOnJoin(pool, config);
        log.info('phone-auth', 'Phone linked to a signed-in account', {
          userId: req.user.id, already: linked.already, joined: joined.length,
        });
        return res.json({ ok: true, joined, privateMember: joined.length > 0 });
      } catch (error) {
        return fail(res, error, 'Phone link', {
          kind: 'link_verify',
          userId: req.user.id,
          phone: claims?.phoneNumber,
        });
      }
    }
  );

  return router;
}

module.exports = { phoneAuthRoutes, privateCookie, clearPrivateCookie, readPrivateCookie };
