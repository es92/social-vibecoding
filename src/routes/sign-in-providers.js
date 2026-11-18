'use strict';

const { readSessionCookie, protectedCookieName } = require('../services/browser-session-cookies');
const { sessionTokenIsLive } = require('../services/web-session-auth');

/**
 * Apple and Google sign-in (services/sign-in-providers.js has the whole
 * story), and the console screen that sets them up.
 *
 *   GET  /api/auth/oauth/:provider/start     the sheet's button; off to the provider
 *   GET  /api/auth/oauth/:provider/callback  back from it (Google, and Apple below)
 *   POST /api/auth/oauth/apple/callback      Apple's form POST, turned into the GET
 *   POST /api/auth/oauth/finish              the username step, for a new account
 *
 *   POST /api/auth/oauth/:provider/native/start  inside the Homeroom app: a state and a nonce
 *   POST /api/auth/oauth/:provider/native        the ID token the app's own sheet returned
 *   POST /api/auth/oauth/:provider/native/failed what the app's sheet said when it failed, for the log
 *
 *   GET  /api/admin/sign-in-providers                 the console's view
 *   PUT  /api/admin/sign-in-providers/:provider       save one provider
 *   POST /api/admin/sign-in-providers/:provider/check ask the provider about it
 *
 * THE WAY BACK. The callback ends every trip with a redirect to where the
 * person started (Home, or the invite link they were on), and leaves its
 * outcome for the sign-in sheet in a short-lived cookie the page can read
 * (`__Host-hr_oauth_result`, `hr_oauth_result` on plain-HTTP development):
 * nothing when it signed them in, `username` when the account still needs a
 * handle, `error-<code>` when it did not work. No outcome rides in the URL,
 * so nothing about it lands in history or logs.
 *
 * An invite link the person was on is followed exactly as the email code
 * follows it (routes/auth.js otp/verify): by an account the trip just made,
 * or by any account when the trip started from the link's own Join
 * (`follow=1`).
 *
 * INSIDE THE APP there is no trip: the page asks for a state and a nonce,
 * the app's own sheet answers with an ID token, and the page sends it here.
 * The answer is JSON, as the email code's is: { next: 'signed-in', user },
 * { next: 'username' } (the same continuation cookie as above), or
 * { error, code } with the same codes the way back leaves for the sheet.
 */

const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const events = require('../services/events');
const contactPreferences = require('../services/contact-preferences');
const { signUpMetadata } = require('../services/sign-up-from');
const providers = require('../services/sign-in-providers');
const communityInvites = require('../services/community-invites');
const accessLinks = require('../services/access-links');
const phoneAuth = require('../services/firebase-phone-auth');
const challengeScorer = require('../services/topochain/challenge-scorer');
const firstSession = require('../services/first-session');
const managedOpenRouter = require('../services/openrouter-managed-keys');
const waitlist = require('../services/waitlist');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const { oauthSignInLimiter, otpVerifyLimiter } = require('../middleware/rate-limits');
const { createSession, createSessionCookie, roleFields } = require('./auth');

// Read per call, so a cookie's writer and reader always agree.
const secureCookie = () => process.env.NODE_ENV === 'production';
// Bare names. Each cookie is `__Host-<name>` when Secure (browser-session-
// cookies.js protectedCookieName): Path=/ with no Domain, so an app on a
// sibling host cannot plant a binder, a continuation or an outcome. The bare
// name is plain-HTTP development's only, and never read in production.
const BINDER_COOKIE = 'hr_oauth_binder';
const SIGNUP_COOKIE = 'hr_oauth_signup';
// The page reads it (frontend/src/features/auth/landing.tsx
// takeProviderResult), so it is not HttpOnly.
const RESULT_COOKIE = 'hr_oauth_result';
// Long enough for the page to load and read it, short enough to mean "just now".
const RESULT_MAX_AGE_MS = 2 * 60 * 1000;
const RESULT_RE = /^(username|error-[a-z_]{1,40})$/;

function cookieName(name) {
  return protectedCookieName(name, secureCookie());
}

function privateCookieOptions() {
  return { httpOnly: true, secure: secureCookie(), sameSite: 'lax', path: '/' };
}

function privateCookie(res, name, value, maxAgeMs) {
  res.cookie(cookieName(name), value, { ...privateCookieOptions(), maxAge: maxAgeMs });
}

// The same attributes as the write: a browser drops a `__Host-` cookie only
// for a Set-Cookie that is itself Secure, Path=/ and without a Domain.
function clearPrivateCookie(res, name) {
  res.clearCookie(cookieName(name), privateCookieOptions());
}

function readPrivateCookie(req, name) {
  return req.cookies?.[cookieName(name)];
}

/** Back to where the trip started, with the outcome for the sheet. */
function goBack(res, returnTo, result) {
  if (result && RESULT_RE.test(result)) {
    res.cookie(cookieName(RESULT_COOKIE), result, {
      httpOnly: false, secure: secureCookie(), sameSite: 'lax', path: '/', maxAge: RESULT_MAX_AGE_MS,
    });
  }
  res.set('Cache-Control', 'no-store');
  return res.redirect(303, providers.safeReturnTo(returnTo));
}

function errorResult(err) {
  return err instanceof providers.SignInProviderError ? `error-${err.code}` : 'error-failed';
}

function signInProviderRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);

  // The ordinary sign-in routes refuse to mint a session over a live one
  // (routes/auth.js SESSION_MINT_PATHS); these GETs make the same check,
  // with the same meaning of live as the auth middleware (#6619).
  function liveSession(req) {
    return sessionTokenIsLive(pool, readSessionCookie(req));
  }

  // The trip runs on the canonical origin, the one registered with the
  // providers, so the binder cookie, the callback and the session it mints
  // all belong to one host. A start on another host (an alias of the same
  // server) restarts there.
  function onCanonicalHost(req) {
    try {
      return new URL(config.cliAuthOrigin).hostname === req.hostname;
    } catch {
      return false;
    }
  }

  // What every provider sign-in does once it found or made the account.
  async function afterSignIn(req, res, provider, state, result) {
    if (result.created) {
      // What an email code does for an account it makes (email-signup.js
      // verifyCode, routes/auth.js): a released waitlist address is let
      // in, project invites to it are claimed, and the included OpenRouter
      // key is made. Each is best effort and never throws.
      await waitlist.linkUserByEmail(pool, { userId: result.userId, email: result.email, newAccount: true });
      // #6633: with the waitlist switched off, the account just made is let
      // in at once, before its waitlist spot and any invite it carries.
      await waitlist.admitIfOpen(pool, result.userId);
      await require('../services/email-invites').claimEmailInvites(pool, { userId: result.userId, email: result.email });
      await managedOpenRouter.ensureIncludedKey({
        pool, userId: result.userId, config, reason: `signup_${provider}`,
      });
      // The sign-up, as the email code records it (routes/auth.js, #4039),
      // with the button it began from. The callback is a top-level
      // navigation, so the landing's SameSite=Lax cookie is on it, Apple's
      // form POST included once it is redirected to the GET.
      events.record(pool, { type: events.EVENT_TYPES.USER_SIGNED_UP, userId: result.userId, metadata: signUpMetadata(req, { via: provider }) });
      // Made from the story's sheet: asked what to make, not which
      // communities to join (services/first-session.js). Recorded as
      // reached from the story; the question stays owed until it is
      // answered, so the shell this sign-in lands in asks it.
      if (state.started_from === 'story') await firstSession.recordStart(pool, result.userId, 'story');
    }
    // An admin's invite link to Homeroom this browser opened before the
    // trip (/welcome/<code>, services/access-links.js): the account found
    // or made is let in with it, before the waitlist spot below, which an
    // account with access does not get. Never throws.
    await accessLinks.admitCarried(pool, req, res, result.userId);
    // #4083: an account still waiting has its spot on the waitlist, on
    // every provider sign-in, since one can confirm an existing account's
    // address too. A no-op once it has one; never throws.
    await waitlist.ensureAccountSignup(pool, { userId: result.userId });
    const consented = result.created || state.follow_invite === true;
    const invite = consented
      ? await communityInvites.redeemCarried(pool, req, res, result.userId, {
        // A private member has a verified phone or a confirmed email
        // (community-invites.js): the provider vouched for this address.
        requirePhone: phoneAuth.offered(config),
      })
      : await communityInvites.dropCarried(pool, req, res, result.userId);
    if (invite && invite.status === 'joined') await challengeScorer.scoreOnJoin(pool, config);
  }

  router.get('/api/auth/oauth/:provider/start', oauthSignInLimiter, async (req, res) => {
    const provider = req.params.provider;
    const returnTo = providers.safeReturnTo(typeof req.query.return === 'string' ? req.query.return : '/');
    res.set('Referrer-Policy', 'no-referrer');
    if (!providers.isProvider(provider)) return goBack(res, returnTo, 'error-not_offered');
    if (config.cliAuthOrigin && !onCanonicalHost(req)) {
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, `${config.cliAuthOrigin}${req.originalUrl}`);
    }
    try {
      if (await liveSession(req)) return goBack(res, returnTo, 'error-logout_required');
      const { url, binder } = await providers.beginSignIn(pool, config, provider, {
        from: typeof req.query.from === 'string' ? req.query.from : null,
        followInvite: req.query.follow === '1',
        returnTo,
      });
      privateCookie(res, BINDER_COOKIE, binder, providers.STATE_TTL_MS);
      res.set('Cache-Control', 'no-store');
      return res.redirect(302, url);
    } catch (err) {
      if (!(err instanceof providers.SignInProviderError)) {
        log.error('sign-in-providers', 'Start failed', { provider, err: err.message });
      }
      return goBack(res, returnTo, errorResult(err));
    }
  });

  async function callback(req, res, params) {
    const provider = req.params.provider;
    const binder = readPrivateCookie(req, BINDER_COOKIE);
    clearPrivateCookie(res, BINDER_COOKIE);
    res.set('Referrer-Policy', 'no-referrer');
    if (!providers.isProvider(provider)) return goBack(res, '/', 'error-not_offered');
    let state;
    try {
      state = await providers.consumeState(pool, provider, params.state, binder);
    } catch (err) {
      log.error('sign-in-providers', 'State read failed', { provider, err: err.message });
      return goBack(res, '/', 'error-failed');
    }
    if (!state) return goBack(res, '/', 'error-expired');
    if (state.mismatch) return goBack(res, state.return_to, 'error-expired');
    const returnTo = state.return_to;
    if (typeof params.error === 'string' && params.error) {
      // The person said no at the provider (Apple: user_cancelled_authorize).
      const cancelled = params.error === 'access_denied' || params.error === 'user_cancelled_authorize';
      return goBack(res, returnTo, cancelled ? 'error-cancelled' : 'error-provider_refused');
    }
    try {
      if (await liveSession(req)) return goBack(res, returnTo, 'error-logout_required');
      const claims = await providers.exchangeCode(pool, config, provider, { code: params.code, state });
      const result = await providers.signIn(pool, provider, claims, {
        // #5974: the session row names the browser that signed in.
        createSession: (db, userId) => createSession(db, userId, req),
      });
      // Nobody signed in, so an invite link being followed stays carried for
      // the email code or password the sheet points them to next.
      if (result.refuse) return goBack(res, returnTo, `error-${result.refuse}`);
      await afterSignIn(req, res, provider, state, result);
      if (result.next === 'signed-in') {
        createSessionCookie(res, result.session.token, result.session.expiresAt);
        log.info('sign-in-providers', 'Signed in', { provider, userId: result.userId, created: result.created });
        return goBack(res, returnTo, null);
      }
      privateCookie(res, SIGNUP_COOKIE, result.signupToken, providers.SIGNUP_TTL_MS);
      log.info('sign-in-providers', 'Username step pending', { provider, userId: result.userId, created: result.created });
      return goBack(res, returnTo, 'username');
    } catch (err) {
      if (!(err instanceof providers.SignInProviderError)) {
        log.error('sign-in-providers', 'Callback failed', { provider, err: err.message });
      }
      return goBack(res, returnTo, errorResult(err));
    }
  }

  router.get('/api/auth/oauth/:provider/callback', oauthSignInLimiter, (req, res) => callback(req, res, {
    code: typeof req.query.code === 'string' ? req.query.code : null,
    state: typeof req.query.state === 'string' ? req.query.state : null,
    error: typeof req.query.error === 'string' ? req.query.error : null,
  }));

  // Apple answers with a cross-site form POST (response_mode=form_post), and
  // a cross-site POST carries no SameSite=Lax cookie, so the binder is not on
  // this request. The same fields go on to the GET above, a top-level
  // navigation, which carries it.
  router.post(
    '/api/auth/oauth/apple/callback',
    oauthSignInLimiter,
    express.urlencoded({ extended: false, limit: '16kb' }),
    (req, res) => {
      const params = new URLSearchParams();
      for (const key of ['code', 'state', 'error']) {
        const value = req.body?.[key];
        if (typeof value === 'string' && value) params.set(key, value.slice(0, 2048));
      }
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
      return res.redirect(303, `${providers.callbackPath('apple')}?${params.toString()}`);
    }
  );

  // ── Inside the Homeroom app ───────────────────────────────────────────

  function nativeFail(res, err, what, provider) {
    if (err instanceof providers.SignInProviderError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    log.error('sign-in-providers', `${what} failed`, { provider, err: err.message });
    return res.status(500).json({ error: 'Internal server error', code: 'failed' });
  }

  // The live-session refusal is routes/auth.js SESSION_MINT_PATHS', which
  // lists the finish below; a start over a live session is refused here.
  router.post('/api/auth/oauth/:provider/native/start', oauthSignInLimiter, async (req, res) => {
    const provider = req.params.provider;
    res.set('Cache-Control', 'no-store');
    if (!providers.isProvider(provider)) return res.status(404).json({ error: 'Unknown provider.', code: 'not_offered' });
    // The page always says where the sheet was opened from, in a JSON body:
    // a form another site posts cannot start one.
    if (typeof req.body?.from !== 'string') return res.status(400).json({ error: 'Say where the sign-in started.', code: 'invalid_request' });
    try {
      if (await liveSession(req)) {
        return res.status(409).json({ error: 'Sign out before signing in again.', code: 'logout_required' });
      }
      const { state, nonce, binder } = await providers.beginNativeSignIn(pool, config, provider, {
        from: req.body.from,
        followInvite: req.body.follow === true,
      });
      privateCookie(res, BINDER_COOKIE, binder, providers.STATE_TTL_MS);
      return res.json({ state, nonce });
    } catch (err) {
      return nativeFail(res, err, 'Native start', provider);
    }
  });

  router.post('/api/auth/oauth/:provider/native', oauthSignInLimiter, async (req, res) => {
    const provider = req.params.provider;
    const binder = readPrivateCookie(req, BINDER_COOKIE);
    clearPrivateCookie(res, BINDER_COOKIE);
    res.set('Cache-Control', 'no-store');
    if (!providers.isProvider(provider)) return res.status(404).json({ error: 'Unknown provider.', code: 'not_offered' });
    try {
      const state = await providers.consumeState(pool, provider, req.body?.state, binder, { native: true });
      if (!state || state.mismatch) {
        log.warn('sign-in-providers', 'App sign-in refused', { provider, reason: state ? 'started_elsewhere' : 'expired' });
        return res.status(422).json({ error: 'That sign-in took too long, or started somewhere else. Try again.', code: 'expired' });
      }
      const claims = await providers.verifyNativeIdToken(pool, config, provider, req.body?.idToken, state);
      const result = await providers.signIn(pool, provider, claims, {
        // #5974: the session row names the browser that signed in.
        createSession: (db, userId) => createSession(db, userId, req),
      });
      if (result.refuse) {
        log.info('sign-in-providers', 'App sign-in refused', { provider, reason: result.refuse });
        return res.status(422).json({ error: 'Not signed in.', code: result.refuse });
      }
      await afterSignIn(req, res, provider, state, result);
      if (result.next === 'signed-in') {
        createSessionCookie(res, result.session.token, result.session.expiresAt);
        log.info('sign-in-providers', 'Signed in from the app', { provider, userId: result.userId, created: result.created });
        return res.json({
          next: 'signed-in',
          created: result.created,
          user: {
            id: result.user.id,
            username: result.user.username,
            ...roleFields(result.user.isAdmin, result.user.adminReadonly),
          },
        });
      }
      privateCookie(res, SIGNUP_COOKIE, result.signupToken, providers.SIGNUP_TTL_MS);
      log.info('sign-in-providers', 'Username step pending, from the app', { provider, userId: result.userId, created: result.created });
      return res.json({ next: 'username', created: result.created });
    } catch (err) {
      return nativeFail(res, err, 'Native sign-in', provider);
    }
  });

  // The app's own sheet failed before there was an ID token to send (#5960).
  // The sheet on the page shows only its generic line, and the reason (what
  // the provider's SDK said, which an app build carries at the end of its
  // bridge error) was kept on the phone, so nothing told a setup problem
  // from a broken hand-off. The page reports it here, with the state its
  // start was given: the state is spent, so one start is one line in the
  // log at most, and a report without a live one is dropped unread.
  router.post('/api/auth/oauth/:provider/native/failed', oauthSignInLimiter, async (req, res) => {
    const provider = req.params.provider;
    const binder = readPrivateCookie(req, BINDER_COOKIE);
    clearPrivateCookie(res, BINDER_COOKIE);
    res.set('Cache-Control', 'no-store');
    if (!providers.isProvider(provider) || typeof req.body?.state !== 'string') return res.status(204).end();
    try {
      const state = await providers.consumeState(pool, provider, req.body.state, binder, { native: true });
      if (state && !state.mismatch) {
        log.warn('sign-in-providers', 'App sheet failed', { provider, reason: providers.nativeFailureReason(req.body.reason) });
      }
    } catch (err) {
      log.error('sign-in-providers', 'Native failure report failed', { provider, err: err.message });
    }
    return res.status(204).end();
  });

  router.post('/api/auth/oauth/finish', otpVerifyLimiter, async (req, res) => {
    try {
      const done = await providers.completeUsername(pool, {
        signupToken: readPrivateCookie(req, SIGNUP_COOKIE),
        username: typeof req.body?.username === 'string' ? req.body.username : '',
        // #5974: the session row names the browser that signed in.
        createSession: (db, userId) => createSession(db, userId, req),
      });
      clearPrivateCookie(res, SIGNUP_COOKIE);
      createSessionCookie(res, done.session.token, done.session.expiresAt);
      // The username step's "Homeroom news by email" box (#6044), for the
      // address Apple or Google confirmed. Never fails the sign-up.
      await contactPreferences.recordSignupChoices(pool, done.user.id,
        contactPreferences.signupChoicesFrom(req.body), log);
      return res.json({
        user: {
          id: done.user.id,
          username: done.user.username,
          ...roleFields(done.user.isAdmin, done.user.adminReadonly),
        },
      });
    } catch (err) {
      if (err instanceof providers.SignInProviderError) {
        // A username refusal leaves the continuation unspent: fix and resend.
        if (err.code === 'invalid_username' || err.code === 'username_taken') {
          return res.status(422).json({ error: err.message, code: err.code, field: 'username' });
        }
        clearPrivateCookie(res, SIGNUP_COOKIE);
        return res.status(422).json({ error: err.message, code: err.code });
      }
      log.error('sign-in-providers', 'Username step failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Admin → Sign-in providers ─────────────────────────────────────────
  // Read open to view-only admins; saving and the check are full-admin.

  function adminFail(res, err, what) {
    if (err instanceof providers.SignInProviderError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    log.error('sign-in-providers', `${what} failed`, { err: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }

  router.get('/api/admin/sign-in-providers', adminMiddleware, async (_req, res) => {
    try {
      return res.json(await providers.adminView(pool, config));
    } catch (err) {
      return adminFail(res, err, 'Admin read');
    }
  });

  router.put('/api/admin/sign-in-providers/:provider', adminMiddleware, requireAdminWrite, async (req, res) => {
    try {
      const view = await providers.saveProvider(pool, config, req.params.provider, req.body, req.user?.id ?? null);
      log.info('sign-in-providers', 'Provider saved', {
        provider: req.params.provider, adminId: req.user?.id,
        enabled: req.body?.enabled, cleared: req.body?.clear === true,
        secretChanged: typeof req.body?.secret === 'string' && !!req.body.secret.trim(),
      });
      return res.json(view);
    } catch (err) {
      return adminFail(res, err, 'Admin save');
    }
  });

  router.post('/api/admin/sign-in-providers/:provider/check', adminMiddleware, requireAdminWrite, async (req, res) => {
    try {
      return res.json(await providers.checkSetup(pool, config, req.params.provider));
    } catch (err) {
      return adminFail(res, err, 'Admin check');
    }
  });

  return router;
}

module.exports = { signInProviderRoutes, RESULT_COOKIE, BINDER_COOKIE, SIGNUP_COOKIE,
  privateCookie, clearPrivateCookie, readPrivateCookie, goBack };
