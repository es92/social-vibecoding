'use strict';

const crypto = require('crypto');
const log = require('../services/logger');
const platformJwt = require('../services/platform-jwt');
const { clientIp, isDirectInternalCall } = require('../services/client-ip');

// Authenticates dapp → platform app-storage requests (#752):
// POST/DELETE/GET under /api/app-storage/.
//
// Sibling of app-llm-auth.js — same private-IP gate (app containers are
// on the shared docker network; this endpoint is never needed from the
// public internet) and the same credential pair shape, minus the
// per-(app,user) grant lookup (image storage warrants no consent
// dialog the way LLM spend does):
//
//   x-usernode-app-token   — the app's opaque per-app credential
//       (apps.storage_api_token, random 64-hex injected as
//       USERNODE_STORAGE_TOKEN at production deploy). NOT a JWT:
//       every dapp container holds the shared JWT_SECRET, so a
//       JWT-based app identity would be forgeable by any other app.
//       Staging containers never receive the token (the column is
//       staging:private and the staging deploy path doesn't inject
//       the env var), so unreviewed PR code is rejected here.
//
//   x-usernode-user-token  — the platform-minted iframe JWT the app's
//       frontend already forwards on every request (app-conventions.md
//       "Auth — iframe token injection"); the app's server passes it
//       through. Verified with the shared JWT_SECRET; claims give the
//       user (the uploader recorded on the file row).

// Look up the calling app by its opaque token. The SQL equality match
// finds the candidate row; the timingSafeEqual re-check makes the
// in-process comparison constant-time (belt and braces — same stance
// as app-llm-auth.resolveApp).
async function resolveApp(pool, token) {
  const { rows } = await pool.query(
    'SELECT id, slug, storage_api_token FROM apps WHERE storage_api_token = $1',
    [token]
  );
  const app = rows[0];
  if (!app || !app.storage_api_token) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(app.storage_api_token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: app.id, slug: app.slug };
}

// `userOptional`: the route also answers the app acting for itself (its
// app token alone), as req.appStorage.userId null. A user token that IS
// sent must still verify: a bad one is refused, never ignored.
function appStorageAuth(pool, config, { userOptional = false } = {}) {
  return async function appStorageAuthMiddleware(req, res, next) {
    // #2506: "is the resolved address private" is not the same question as
    // "did this come from inside" — on a trusted-proxy DNS failure clientIp
    // falls back to the ingress's own private address.
    if (!isDirectInternalCall(req)) {
      log.warn('app-storage-auth', 'Rejected non-direct internal call',
        { ip: clientIp(req), path: req.path });
      return res.status(403).json({ ok: false, code: 'forbidden_ip' });
    }

    const appToken = req.headers['x-usernode-app-token'];
    if (!appToken || typeof appToken !== 'string' || !/^[0-9a-f]{64}$/.test(appToken)) {
      return res.status(401).json({ ok: false, code: 'missing_app_token' });
    }

    const userToken = req.headers['x-usernode-user-token'];
    const hasUser = !!userToken && typeof userToken === 'string';
    if (!hasUser && !userOptional) {
      return res.status(401).json({ ok: false, code: 'missing_user_token' });
    }

    if (hasUser && !process.env.IFRAME_JWT_PUBLIC_KEY) {
      log.error('app-storage-auth', 'IFRAME_JWT_PUBLIC_KEY not configured');
      return res.status(500).json({ ok: false, code: 'server_misconfigured' });
    }

    // Resolve the app FIRST — the user token is verified against THIS
    // app's audience below, so the app identity has to be known before
    // the token is trusted.
    let app;
    try {
      app = await resolveApp(pool, appToken);
    } catch (err) {
      log.error('app-storage-auth', 'App token lookup failed', { err: err.message });
      return res.status(500).json({ ok: false, code: 'lookup_failed' });
    }
    if (!app) {
      return res.status(401).json({ ok: false, code: 'bad_app_token' });
    }
    if (!hasUser) {
      req.appStorage = { appId: app.id, appSlug: app.slug, userId: null };
      return next();
    }

    // Verify against the RESOLVED app's audience — closes the same
    // cross-app replay hole described in app-llm-auth.js: app B could
    // otherwise present a user token minted for app A and write files (or
    // burn that user's storage quota) as them.
    let claims;
    try {
      claims = platformJwt.verifyAppIdentityToken(userToken, { appId: app.id });
    } catch (err) {
      // A guest (P15) has no account to store anything under.
      if (platformJwt.orNull(() => platformJwt.verifyGuestToken(userToken, { appId: app.id }))) {
        return res.status(401).json({ ok: false, code: 'account_required', message: 'Make an account to continue.' });
      }
      return res.status(401).json({ ok: false, code: 'bad_user_token', message: err.message });
    }
    // Belt-and-braces on the identity shape (see app-llm-auth.js).
    if (!claims || typeof claims.id !== 'number' || claims.scope) {
      return res.status(403).json({ ok: false, code: 'bad_user_token' });
    }

    try {
      const live = await pool.query('SELECT id FROM users WHERE id = $1', [claims.id]);
      if (!live.rows.length) return res.status(401).json({ ok: false, code: 'bad_user_token' });
    } catch { return res.status(503).json({ ok: false, code: 'lookup_failed' }); }
    req.appStorage = { appId: app.id, appSlug: app.slug, userId: claims.id };
    next();
  };
}

module.exports = { appStorageAuth };
