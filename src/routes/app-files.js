'use strict';

const express = require('express');
const { pipeline } = require('stream');
const { Router } = require('express');
const { currentAppBridge } = require('../middleware/app-bridge');
const { getPool } = require('../db/pool');
const appAccess = require('../services/app-access');
const platformJwt = require('../services/platform-jwt');
const appFiles = require('../services/app-files');
const { appFileUploadLimiter } = require('../middleware/rate-limits');
const { parseRange } = require('../services/byte-range');
const log = require('../services/logger');

// App file storage (#752) — the browser-facing halves. Two routers:
//
//   appFileServeRoutes  — GET /app-files/:id, mounted in server.js
//       BEFORE authMiddleware (sibling of /app-icons/:id and
//       /issue-images/:id): app pages load these with plain <img> tags
//       from their own subdomains, so there is no auth dance to do.
//       For visibility='public' rows the unguessable 32-hex id is the
//       access control; visibility='private' rows additionally require
//       a valid platform user JWT via ?token= (the iframe token the
//       app's frontend already holds). Bytes stream from the MinIO
//       sidecar — this route never buffers whole files.
//
//   appFileShellRoutes  — /api/apps/:slug/files*, mounted behind
//       authMiddleware (session cookie). Called ONLY by the platform
//       shell's bridge relay (public/js/app-view.js
//       handleStorageBridgeMessage) on behalf of usernode.uploadFile()
//       / deleteFile() / getStorageUsage() in the app iframe.
//
// `deps.store` is injectable for tests; defaults to the module-level
// MinIO wrapper.

// The iframe-token shape check, matching app-storage-auth: a plain user
// identity (numeric id, no infrastructure scope). Self-contained on
// purpose — this route is pre-auth, so no middleware attached req.user.
//
// Scoped to the OWNING app's audience since the RSA cutover: a token
// minted for app A no longer unlocks app B's private files, which is the
// same cross-app replay hole app-llm-auth/app-storage-auth closed.
function verifyUserToken(raw, appId, staging) {
  if (!raw || typeof raw !== 'string') return null;
  const claims = platformJwt.orNull(
    () => platformJwt.verifyAppIdentityToken(raw, { appId, allowPreview: staging === true })
  );
  if (!claims || typeof claims.id !== 'number' || claims.scope) return null;
  return claims;
}

// Sends one stored file: whole, or the single byte range a `Range`
// header asks for (audio and video seek; Safari asks for pieces). The
// object store reads only that range. `file` is its app_files row; access
// is the caller's to check first. `onMissing` answers a row whose object is
// gone (a bare 404 unless the caller speaks JSON).
async function sendAppFile(req, res, store, file, cacheControl, { onMissing = null } = {}) {
  const size = Number(file.size_bytes);
  const range = Number.isSafeInteger(size) && size > 0 ? parseRange(req.headers.range, size) : null;
  const safeName = String(file.filename || 'file').replace(/["\\\r\n]/g, '_');
  // Media renders on the page; everything else (PDFs, text kinds, an
  // unknown stored type) downloads, so nothing but media can act as a
  // document on the platform's own origin.
  const disposition = appFiles.isInlineType(file.content_type) ? 'inline' : 'attachment';
  res.set({
    'Content-Type': file.content_type || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${disposition}; filename="${safeName}"`,
    // no-transform: a compressed body would no longer match the byte
    // offsets of Content-Range, nor the stored bytes' digest in the ETag.
    'Cache-Control': `${cacheControl}, no-transform`,
    'Accept-Ranges': 'bytes',
  });
  if (file.sha256) res.set('ETag', `"${file.sha256}"`);
  if (range === false) {
    res.set('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }

  let stream;
  try {
    stream = await store.getFileStream(file.app_id, file.id, range);
  } catch (err) {
    // Row-without-object (partial restore, failed delete retry):
    // degrade to 404 for fresh fetchers, loudly in the log.
    log.warn('app-files', 'Object missing for metadata row', { id: file.id, err: err.message });
    for (const header of ['Content-Type', 'Cache-Control', 'ETag', 'Content-Disposition', 'Accept-Ranges']) {
      res.removeHeader(header);
    }
    return onMissing ? onMissing() : res.status(404).end();
  }
  if (range) {
    res.status(206);
    res.set({
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': String(range.end - range.start + 1),
    });
  } else if (Number.isSafeInteger(size) && size > 0) {
    res.set('Content-Length', String(size));
  }
  // pipeline, not pipe: a client that goes away (every seek abandons a
  // range) destroys the object-store stream too, and a store error after
  // the headers destroys the response, so the client is not left waiting
  // for the rest of a Content-Length that will never come.
  pipeline(stream, res, (err) => {
    if (!err || err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    log.warn('app-files', 'Stream error while serving', { id: file.id, err: err.message });
    if (!res.headersSent) res.status(404).end();
    else res.destroy(err);
  });
  return undefined;
}

function appFileServeRoutes(config, deps = {}) {
  const router = Router();
  const pool = getPool(config);
  const store = deps.store !== undefined ? deps.store : appFiles.getStore(config);

  router.get('/app-files/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
    try {
      const { rows } = await pool.query(
        'SELECT id, app_id, filename, content_type, size_bytes, visibility, staging, sha256 FROM app_files WHERE id = $1',
        [id]
      );
      if (!rows.length) return res.status(404).end();
      const file = rows[0];

      if (file.visibility === 'private') {
        // Private files require a valid platform user JWT minted for THIS
        // app — apps append their iframe token to the URL. 404 (not 401)
        // keeps private ids non-enumerable, same stance as everything else.
        if (!verifyUserToken(req.query.token, file.app_id, file.staging)) return res.status(404).end();
      }
      if (!store) {
        log.warn('app-files', 'Serve requested but storage unconfigured', { id });
        return res.status(503).end();
      }

      const cacheControl = file.visibility === 'private'
        // Private URLs carry the ?token= in the cache key and the token
        // rotates hourly, so keep their TTL short.
        ? 'private, max-age=3600'
        // Rows are immutable (no overwrite API): a deleted id 404s for
        // fresh fetchers, so the year-long immutable header is safe.
        : 'public, max-age=31536000, immutable';
      return await sendAppFile(req, res, store, file, cacheControl);
    } catch (err) {
      log.error('app-files', 'Failed to serve app file', { id, err: err.message });
      res.status(500).end();
    }
  });

  return router;
}

function appFileShellRoutes(config, deps = {}) {
  const router = Router();
  const pool = getPool(config);
  const store = deps.store !== undefined ? deps.store : appFiles.getStore(config);

  // Old parent tabs did not bind storage calls to the preview environment.
  // Refuse that relay before any lookup or mutation; a refresh loads the
  // guarded parent. This protocol header grants no user/app authority.
  router.use('/api/apps/:slug/files', currentAppBridge);

  // Limit must exceed MAX_VIDEO_FILE_BYTES (the largest per-kind cap) so
  // the service's structured file_too_large error fires before the
  // parser's PayloadTooLarge.
  const rawBody = express.raw({ type: 'application/octet-stream', limit: appFiles.UPLOAD_BODY_LIMIT });

  // Upload on behalf of the app iframe. Uploading requires the same
  // access as using the app ('view'); 404 on deny so private apps
  // aren't enumerable. `?staging=1` is set by the shell when the relay
  // message came from the staging preview iframe — those rows are
  // stamped and GC'd after 7 days (see services/app-files.js).
  router.post('/api/apps/:slug/files', appFileUploadLimiter, rawBody, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const result = await appFiles.storeAppFile(pool, store, {
        appId: app.id,
        userId: req.user.id,
        filename: String(req.query.filename || '').trim(),
        visibility: req.query.visibility,
        staging: req.query.staging === '1',
        data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      });
      if (!result.ok) {
        return res.status(result.status).json({ code: result.code, error: result.error });
      }
      return res.json(result.file);
    } catch (err) {
      log.error('app-files', 'Shell upload failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Upload failed' });
    }
  });

  // Bridge deletions are uploader-only: an app frontend may remove the
  // current user's own files, never someone else's (app-wide takedowns
  // go through the server-side API with the app token).
  router.delete('/api/apps/:slug/files/:fileId', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });

      const result = await appFiles.deleteAppFile(pool, store, {
        appId: app.id,
        fileId: String(req.params.fileId || ''),
        requireUserId: req.user.id,
        staging: req.query.staging === '1',
      });
      if (!result.ok) {
        return res.status(result.status).json({ code: result.code, error: result.error });
      }
      return res.json({ ok: true });
    } catch (err) {
      log.error('app-files', 'Shell delete failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Delete failed' });
    }
  });

  router.get('/api/apps/:slug/files/usage', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'view', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      return res.json(await appFiles.usageReport(pool, app.id, req.user.id, { staging: req.query.staging === '1' }));
    } catch (err) {
      log.error('app-files', 'Shell usage read failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Usage read failed' });
    }
  });

  return router;
}

module.exports = { appFileServeRoutes, appFileShellRoutes, sendAppFile };
