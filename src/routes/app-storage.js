'use strict';

const express = require('express');
const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { getPool } = require('../db/pool');
const { appStorageAuth } = require('../middleware/app-storage-auth');
const appFiles = require('../services/app-files');
const { sendAppFile } = require('./app-files');
const log = require('../services/logger');

// Dapp → platform app-storage API (#752). App containers call these
// with their per-app token (USERNODE_STORAGE_TOKEN) plus the user's
// iframe JWT — the exact app-llm-proxy credential pattern. With the app
// token alone the app acts for itself: it stores files it keeps
// (`?owner=app`: narration, generated text and data, counted against the
// app's allowance and no person's), lists and reads its files, deletes
// them and reads its usage. A person's upload still needs their token. Mounted in
// server.js BEFORE authMiddleware because callers are app containers,
// not browser sessions; the middleware's private-IP gate keeps it off
// the public internet.
//
// Upload body convention: raw application/octet-stream with ?filename=
// and ?visibility= query params (the platform's raw-body-not-multer
// upload convention — see services/attachments.js). One file per POST.
//
// `deps.store` is injectable for tests; defaults to the module-level
// MinIO wrapper.
function appStorageRoutes(config, deps = {}) {
  const router = Router();
  const pool = getPool(config);
  const store = deps.store !== undefined ? deps.store : appFiles.getStore(config);
  const auth = appStorageAuth(pool, config, { userOptional: true });

  const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `app:${req.appStorage?.appId || 'anon'}:user:${req.appStorage?.userId || 'anon'}`,
    handler: (req, res) => {
      log.warn('app-storage', 'Rate-limited', {
        appId: req.appStorage?.appId, userId: req.appStorage?.userId,
      });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  // An app storing its own files is a server copying a catalogue, not a
  // person clicking: a much higher rate, per app. The allowance, not the
  // rate, bounds what it can store.
  const appUploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `app:${req.appStorage?.appId || 'anon'}:own`,
    handler: (req, res) => {
      log.warn('app-storage', 'Rate-limited (app files)', { appId: req.appStorage?.appId });
      res.status(429).json({ ok: false, code: 'rate_limited' });
    },
  });

  // `?owner=app` stores a file the app keeps; anything else is a person's
  // upload and needs their token, as it always did.
  const uploadOwner = (req, res, next) => {
    const raw = req.query.owner;
    if (raw !== undefined && raw !== 'app' && raw !== 'user') {
      return res.status(400).json({ ok: false, code: 'invalid_owner', error: 'owner must be "app" or "user"' });
    }
    req.uploadOwner = raw === 'app' ? 'app' : 'user';
    if (req.uploadOwner === 'user' && req.appStorage.userId == null) {
      return res.status(401).json({ ok: false, code: 'missing_user_token' });
    }
    return (req.uploadOwner === 'app' ? appUploadLimiter : uploadLimiter)(req, res, next);
  };

  // Limit must exceed MAX_VIDEO_FILE_BYTES (the largest per-kind cap) so
  // the service's own size check (with its structured file_too_large code)
  // fires before the parser's.
  const rawBody = express.raw({ type: 'application/octet-stream', limit: appFiles.UPLOAD_BODY_LIMIT });

  router.post('/api/app-storage/files', auth, uploadOwner, rawBody, async (req, res) => {
    try {
      const { appId, userId } = req.appStorage;
      const result = await appFiles.storeAppFile(pool, store, {
        appId,
        userId: req.uploadOwner === 'app' ? null : userId,
        owner: req.uploadOwner,
        filename: String(req.query.filename || '').trim(),
        visibility: req.query.visibility,
        staging: false, // production containers only — staging never holds the token
        data: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      });
      if (!result.ok) {
        return res.status(result.status).json({ ok: false, code: result.code, error: result.error });
      }
      return res.json({ ok: true, ...result.file });
    } catch (err) {
      // express.raw over-limit bodies raise PayloadTooLargeError before
      // the handler runs; anything landing here is a genuine failure.
      log.error('app-storage', 'Upload failed', { appId: req.appStorage?.appId, err: err.message });
      return res.status(500).json({ ok: false, code: 'upload_failed', error: 'Upload failed' });
    }
  });

  // Takedown path: the calling app may delete ANY of its own files
  // (not just the requesting user's — moderation needs that). A user
  // token, when sent, identifies who initiated the request, for the log.
  router.delete('/api/app-storage/files/:id', auth, async (req, res) => {
    try {
      const { appId, userId } = req.appStorage;
      const result = await appFiles.deleteAppFile(pool, store, {
        appId, fileId: String(req.params.id || ''),
      });
      if (!result.ok) {
        return res.status(result.status).json({ ok: false, code: result.code, error: result.error });
      }
      log.info('app-storage', 'File deleted via app API', {
        appId, fileId: req.params.id, requestedBy: userId,
      });
      return res.json({ ok: true });
    } catch (err) {
      log.error('app-storage', 'Delete failed', { appId: req.appStorage?.appId, err: err.message });
      return res.status(500).json({ ok: false, code: 'delete_failed', error: 'Delete failed' });
    }
  });

  // The app's own production files, a page at a time by id
  // (`?after=<id>&limit=<1..1000>`), with each file's size and SHA-256:
  // what an app needs to check a copy, or resume one. `?owner=app|user`
  // narrows the list.
  router.get('/api/app-storage/files', auth, async (req, res) => {
    const owner = req.query.owner === undefined ? null : String(req.query.owner);
    if (owner !== null && owner !== 'app' && owner !== 'user') {
      return res.status(400).json({ ok: false, code: 'invalid_owner', error: 'owner must be "app" or "user"' });
    }
    const after = req.query.after === undefined ? null : String(req.query.after);
    if (after !== null && !/^[a-f0-9]{32}$/.test(after)) {
      return res.status(400).json({ ok: false, code: 'invalid_cursor', error: 'after must be a file id' });
    }
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > appFiles.MAX_LIST_LIMIT) {
      return res.status(400).json({
        ok: false, code: 'invalid_limit', error: `limit must be an integer from 1 to ${appFiles.MAX_LIST_LIMIT}`,
      });
    }
    try {
      const page = await appFiles.listAppFiles(pool, { appId: req.appStorage.appId, owner, after, limit });
      return res.json({ ok: true, ...page });
    } catch (err) {
      log.error('app-storage', 'List failed', { appId: req.appStorage?.appId, err: err.message });
      return res.status(500).json({ ok: false, code: 'list_failed', error: 'List failed' });
    }
  });

  // One of the app's own files, private ones included, read by its
  // server; a `Range` header reads part of it.
  router.get('/api/app-storage/files/:id', auth, async (req, res) => {
    try {
      const file = await appFiles.findAppFile(pool, { appId: req.appStorage.appId, fileId: req.params.id });
      if (!file) return res.status(404).json({ ok: false, code: 'not_found', error: 'File not found' });
      if (!store) {
        return res.status(503).json({ ok: false, code: 'storage_unavailable', error: 'File storage is unavailable right now' });
      }
      return await sendAppFile(req, res, store, file, 'private, no-store', {
        onMissing: () => res.status(404).json({ ok: false, code: 'not_found', error: 'File not found' }),
      });
    } catch (err) {
      log.error('app-storage', 'Read failed', { appId: req.appStorage?.appId, err: err.message });
      if (res.headersSent) return res.destroy();
      return res.status(500).json({ ok: false, code: 'read_failed', error: 'Read failed' });
    }
  });

  router.get('/api/app-storage/usage', auth, async (req, res) => {
    try {
      const { appId, userId } = req.appStorage;
      return res.json({ ok: true, ...(await appFiles.usageReport(pool, appId, userId)) });
    } catch (err) {
      log.error('app-storage', 'Usage read failed', { appId: req.appStorage?.appId, err: err.message });
      return res.status(500).json({ ok: false, code: 'usage_failed', error: 'Usage read failed' });
    }
  });

  return router;
}

module.exports = appStorageRoutes;
