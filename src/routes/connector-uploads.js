'use strict';

const express = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { clientIp } = require('../services/client-ip');
const uploads = require('../services/connector-uploads');
const requestSpecs = require('../services/request-specs');
const { validateVideoUpload, validateScreenshotUpload } = require('./feedback');
const { validateChatUpload } = require('../services/attachments');

// PUT /api/connector-uploads/:uploadId — a coding agent sends one plan, video
// or screenshot for a connector call without retyping it into the call.
// services/connector-uploads.js has the why; this is the door.
//
// prepare_upload prints the exact command:
//
//   curl -sS --max-time 300 -X PUT -H 'Authorization: Bearer svcu_…' \
//     --data-binary @<file> <origin>/api/connector-uploads/<id>
//
// POST is accepted too, since curl sends one when `-X PUT` is dropped.
//
// MOUNTED BEFORE THE JSON PARSER AND BEFORE authMiddleware, like the patch
// upload: the body is the raw file, whatever Content-Type curl puts on it,
// and the caller is a sandbox that holds no Homeroom session. The upload's
// token in the Authorization header is the whole of the authentication.
//
// ORDER IS THE POINT, as it is there. The per-address bucket runs before
// anything is looked up, the token is checked before a single body byte is
// read, and only then is the body buffered, against its kind's limit.
//
// Nothing here logs the token or the body.

const IP_RATE_PER_MINUTE = 30;
const USER_RATE_PER_MINUTE = 10;

function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}

function refuse(res, result) {
  const { status = 400, code, message, limitBytes, limitChars, actualChars } = result;
  return res.status(status).json({
    ok: false,
    error: code,
    message,
    ...(limitBytes ? { limitBytes } : {}),
    ...(limitChars ? { limitChars, actualChars } : {}),
  });
}

// The patch upload's limiter: the shared, Postgres-backed token bucket.
function defaultLimiter(pool) {
  const { consumeSharedTokenBucket } = require('../services/cli-auth');
  return async ({ namespace, subject, ratePerMinute }) => consumeSharedTokenBucket(pool, {
    namespace, subject, ratePerMinute, capacity: ratePerMinute,
  });
}

function tooLarge(kind) {
  const limit = uploads.maxBytesFor(kind);
  return {
    status: 413,
    code: 'upload_too_large',
    message: `That file is over the ${uploads.sizeLabel(limit)} a ${kind} upload can be. Nothing was stored, and `
      + 'the command can still be used.',
    limitBytes: limit,
  };
}

// The file, checked for what its kind says it is. Returns its content type,
// or a refusal in the words the matching inline field would have used.
function checkFile(kind, body) {
  if (!Buffer.isBuffer(body) || !body.length) {
    return {
      ok: false, status: 400, code: 'upload_empty',
      message: 'Nothing was uploaded: the file is empty. Check the path after @ in the command, then run it again.',
    };
  }
  if (body.length > uploads.maxBytesFor(kind)) return { ok: false, ...tooLarge(kind) };
  if (kind === 'plan') {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return { ok: false, status: 400, code: 'invalid_plan', message: 'A plan upload must be UTF-8 text: the HTML or markdown file itself.' };
    }
    const prepared = requestSpecs.prepareSpec(text);
    if (!prepared.ok) return { ...prepared, ok: false, status: 400 };
    return { ok: true, contentType: prepared.format === 'html' ? 'text/html' : 'text/markdown' };
  }
  if (kind === 'design') {
    const verdict = validateChatUpload({ filename: 'design.html', data: body });
    if (!verdict.ok) {
      return { ok: false, status: 400, code: 'invalid_design', message: verdict.error };
    }
    if (verdict.kind !== 'html') {
      return { ok: false, status: 400, code: 'invalid_design', message: 'A design upload must be one HTML file.' };
    }
    return { ok: true, contentType: 'text/html' };
  }
  const verdict = kind === 'video' ? validateVideoUpload(body) : validateScreenshotUpload(body);
  if (!verdict.ok) {
    return { ok: false, status: 400, code: kind === 'video' ? 'invalid_video' : 'invalid_screenshot', message: verdict.error };
  }
  return { ok: true, contentType: verdict.contentType };
}

function connectorUploadRoutes(config, deps = {}) {
  const router = express.Router();
  const pool = deps.pool || getPool(config);
  const limit = deps.limiter || defaultLimiter(pool);
  const staging = () => process.env.USERNODE_ENV === 'staging';

  const bucket = async (res, options) => {
    try {
      const state = await limit(options);
      if (state && state.allowed) return true;
      res.setHeader('Retry-After', String((state && state.retryAfter) || 60));
      res.status(429).json({
        ok: false,
        error: 'rate_limited',
        message: 'Too many uploads. Wait a minute and run the command again.',
      });
      return false;
    } catch {
      res.status(503).json({ ok: false, error: 'temporarily_unavailable', message: 'Try again shortly.' });
      return false;
    }
  };

  // Header-only checks: the address bucket, the token, the owner's bucket.
  const authenticate = async (req, res, next) => {
    // A staging preview runs unreviewed code and its connector is not the
    // one agents use; it takes no uploads, like the patch upload.
    if (staging()) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!(await bucket(res, {
      namespace: 'connector-upload-ip', subject: clientIp(req), ratePerMinute: IP_RATE_PER_MINUTE,
    }))) return undefined;

    const uploadId = uploads.uploadIdOf(req.params.uploadId);
    const token = uploads.tokenFromHeader(req.get('authorization'));
    let auth;
    try {
      auth = await uploads.authenticateUpload(pool, { uploadId, token });
    } catch (err) {
      log.error('connector-upload', 'token lookup failed', { uploadId, err: err.message });
      return res.status(503).json({ ok: false, error: 'temporarily_unavailable', message: 'Try again shortly.' });
    }
    if (!auth.ok) {
      log.warn('connector-upload', 'upload refused', { uploadId, code: auth.code, ip: clientIp(req) });
      return refuse(res, auth);
    }
    if (!(await bucket(res, {
      namespace: 'connector-upload-user', subject: String(auth.userId), ratePerMinute: USER_RATE_PER_MINUTE,
    }))) return undefined;
    req.connectorUpload = auth;
    return next();
  };

  // Raw bytes, any Content-Type, read only once the token checked out, up to
  // the limit of the upload's kind. One byte over is enough to know.
  const rawBody = (req, res, next) => {
    const { kind } = req.connectorUpload;
    express.raw({ type: () => true, limit: uploads.maxBytesFor(kind) + 1 })(req, res, (err) => {
      if (!err) return next();
      if (err.type === 'entity.too.large' || err.status === 413) return refuse(res, tooLarge(kind));
      return refuse(res, { status: 400, code: 'invalid_request', message: 'The upload could not be read.' });
    });
  };

  const store = async (req, res) => {
    const auth = req.connectorUpload;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const checked = checkFile(auth.kind, body);
    if (!checked.ok) {
      log.warn('connector-upload', 'upload refused', { uploadId: auth.uploadId, code: checked.code, bytes: body.length });
      return refuse(res, checked);
    }
    let stored;
    try {
      stored = await uploads.storeUpload(pool, {
        uploadId: auth.uploadId, userId: auth.userId, kind: auth.kind, contentType: checked.contentType, body,
      });
    } catch (err) {
      log.error('connector-upload', 'storing the upload failed', { uploadId: auth.uploadId, err: err.message });
      return res.status(503).json({ ok: false, error: 'temporarily_unavailable', message: 'Try again shortly.' });
    }
    if (!stored.ok) return refuse(res, stored);
    log.info('connector-upload', 'file uploaded', { uploadId: stored.uploadId, kind: stored.kind, bytes: stored.bytes });
    return res.status(201).json({
      ok: true,
      uploadId: stored.uploadId,
      kind: stored.kind,
      bytes: stored.bytes,
      sha256: stored.sha256,
      // Where a video or a screenshot is served, for a plan's text to show.
      ...(stored.path ? { path: stored.path } : {}),
      nextStep: uploads.nextStepFor(stored.kind, stored.uploadId),
    });
  };

  // Literal paths, so the route inventories can read them; uploads.uploadPath
  // builds the same one for the command.
  router.put('/api/connector-uploads/:uploadId', noStore, authenticate, rawBody, store);
  router.post('/api/connector-uploads/:uploadId', noStore, authenticate, rawBody, store);
  return router;
}

module.exports = {
  connectorUploadRoutes,
  checkFile,
  IP_RATE_PER_MINUTE,
  USER_RATE_PER_MINUTE,
};
