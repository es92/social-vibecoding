// Challenge illustrations an admin adds from the template form's gallery,
// beside the nine built-in drawings under public/illustrations/challenges/.
// Two routers, mounted in two places:
//
//   challengeIllustrationImageRoutes   GET /challenge-illustrations/:id, the
//     bytes. Mounted before authMiddleware in server.js next to
//     illustrationImageRoutes, and listed in PUBLIC_PATHS, because the
//     challenge cards that draw it are public: an image request answered with
//     a redirect body draws a broken picture. Access control is the
//     unguessable 32-hex id, exactly as for /app-illustrations/.
//   challengeIllustrationsAdminRoutes  list, upload and archive. Composed into
//     ./admin.js, so the router-wide adminReadGate covers the list and every
//     write carries adminWriteGate on top.
//
// A template stores the slug `u-<id>`, never a URL: the client derives the
// image path from a slug that matched its own pattern
// (frontend/src/lib/challenge-illustrations.ts), and reads the tone that
// travels beside it in the payload (challenge-view.js, home-panels.js).
//
// Nothing is ever deleted. Archiving hides a row from the gallery while every
// template that already names it keeps drawing it, which is why the image route
// serves archived rows too.
//
// SVG is the upload that can carry script, so it is held three ways at once:
// the upload is REJECTED unless every element and attribute is on the
// allowlist in src/services/svg-safety.js (nothing is rewritten, so the bytes
// stored are the bytes that were checked); the image route sends a CSP with
// `default-src 'none'` and `sandbox`, so even a file opened directly as a page
// runs nothing and loads nothing; and the cards draw it through <img>, which
// never runs script at all.
'use strict';

const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../../db/pool');
const log = require('../../services/logger');
const { sniffImageType } = require('../../services/attachments');
const { validateSvg } = require('../../services/svg-safety');
const { attachmentUploadLimiter } = require('../../middleware/rate-limits');
// The same twelve harmonic tones the featured illustration editor offers; the
// client registry mirrors them and tests/challenge-illustrations.test.js pins
// the copies together.
const { TONES } = require('../app-illustrations');
const { adminWriteGate } = require('./admin/auth');
const { ok, fail, iso } = require('./helpers');

const MAX_RASTER_BYTES = 1024 * 1024;
const MAX_LABEL_CHARS = 80;
const FILE_ID = /^[a-f0-9]{32}$/;
const UPLOADED_SLUG = /^u-[a-f0-9]{32}$/;

// Served on every image response. `sandbox` puts a directly opened file in an
// opaque origin with scripts disabled; `default-src 'none'` stops it loading
// anything, while inline styles stay allowed so a drawing still paints.
const IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const MESSAGES = {
  label: 'Give the illustration a name of 1 to 80 characters.',
  tone: 'Pick one of the twelve tones for the illustration.',
  format: 'Choose a PNG, WebP or SVG file.',
  tooLarge: 'PNG and WebP files must be 1 MB or smaller, and SVG files 256 KB or smaller.',
  archived: 'Send archived as true or false.',
  notFound: 'Illustration not found.',
};

// The row as the gallery reads it. `src` is derived from the id rather than
// stored, for the same reason the client derives it from the slug.
function formatIllustration(row) {
  return {
    slug: row.slug,
    label: row.label,
    tone: row.tone,
    src: `/challenge-illustrations/${row.id}`,
    archived: row.archived === true,
    created_at: iso(row.created_at),
  };
}

// Trimmed, 1-80 characters as Postgres counts them (code points, hence the
// spread), and no control characters. Null when any of that fails. A repeated
// `?label=` arrives as an array and is refused with the rest.
function parseLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (!label || [...label].length > MAX_LABEL_CHARS) return null;
  if (/[\u0000-\u001f\u007f]/.test(label)) return null;
  return label;
}

// Raster formats are recognised by their magic bytes. Anything whose first
// non-blank character is `<` is treated as an SVG attempt, so an HTML page or a
// stray XML file is told precisely why it was refused instead of hearing only
// "wrong format".
function classifyUpload(data) {
  if (!Buffer.isBuffer(data) || data.length === 0) return { error: MESSAGES.format };
  const sniffed = sniffImageType(data);
  if (sniffed === 'image/png' || sniffed === 'image/webp') {
    if (data.length > MAX_RASTER_BYTES) return { error: MESSAGES.tooLarge };
    return { contentType: sniffed };
  }
  if (!sniffed && /^\ufeff?[ \t\r\n]*</.test(data.subarray(0, 1024).toString('utf8'))) {
    const verdict = validateSvg(data);
    if (!verdict.ok) return { error: `This SVG was refused. ${verdict.reason}` };
    return { contentType: 'image/svg+xml' };
  }
  return { error: MESSAGES.format };
}

// express.raw, with its size refusal turned into the same 400 envelope as
// every other upload refusal instead of the default 413 error page.
const rawBody = express.raw({ type: 'application/octet-stream', limit: '1mb' });
function readUpload(req, res, next) {
  rawBody(req, res, (err) => {
    if (err && err.type === 'entity.too.large') return fail(res, 400, MESSAGES.tooLarge);
    return next(err);
  });
}

function challengeIllustrationImageRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);
  router.get('/challenge-illustrations/:id', async (req, res) => {
    if (!FILE_ID.test(req.params.id)) return res.status(404).end();
    try {
      const { rows } = await pool.query(
        'SELECT content_type, data FROM challenge_illustrations WHERE id = $1', [req.params.id]
      );
      if (!rows.length) return res.status(404).end();
      res.set('Content-Type', rows[0].content_type);
      res.set('X-Content-Type-Options', 'nosniff');
      // Immutable: an id is minted per upload and its bytes never change.
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('Content-Security-Policy', IMAGE_CSP);
      res.set('Content-Disposition', 'inline');
      return res.send(rows[0].data);
    } catch (err) {
      log.error('challenge-illustrations', 'Image read failed', { message: err.message });
      return res.status(500).end();
    }
  });
  return router;
}

function challengeIllustrationsAdminRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/challenge-illustrations ─────────────────────────
  // Every upload, newest first, archived ones included: the gallery hides
  // those itself, but still needs one to draw a template that names it.
  router.get('/api/v4/admin/challenge-illustrations', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, slug, label, tone, archived, created_at FROM challenge_illustrations
          ORDER BY created_at DESC, id DESC`
      );
      return ok(res, { data: rows.map(formatIllustration) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/challenge-illustrations failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/challenge-illustrations?label=&tone= ───────────
  // The body is the file itself. The write gate runs before the rate limiter
  // and the body read, so a view-only admin is refused without either.
  router.post('/api/v4/admin/challenge-illustrations', adminWriteGate, attachmentUploadLimiter, readUpload, async (req, res) => {
    const label = parseLabel(req.query.label);
    if (label === null) return fail(res, 400, MESSAGES.label);
    if (typeof req.query.tone !== 'string' || !TONES.includes(req.query.tone)) return fail(res, 400, MESSAGES.tone);
    const upload = classifyUpload(req.body);
    if (upload.error) return fail(res, 400, upload.error);

    const id = crypto.randomBytes(16).toString('hex');
    try {
      const { rows } = await pool.query(
        `INSERT INTO challenge_illustrations (id, slug, label, tone, content_type, data, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, slug, label, tone, archived, created_at`,
        [id, `u-${id}`, label, req.query.tone, upload.contentType, req.body, req.user?.id ?? null]
      );
      return ok(res.status(201), { data: formatIllustration(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/challenge-illustrations failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PATCH /api/v4/admin/challenge-illustrations/:slug ─────────────────
  // Archive or restore. There is deliberately no DELETE: a template that
  // names the slug has to keep drawing it.
  router.patch('/api/v4/admin/challenge-illustrations/:slug', adminWriteGate, async (req, res) => {
    if (!UPLOADED_SLUG.test(req.params.slug)) return fail(res, 404, MESSAGES.notFound);
    const archived = req.body && req.body.archived;
    if (typeof archived !== 'boolean') return fail(res, 400, MESSAGES.archived);
    try {
      const { rows } = await pool.query(
        `UPDATE challenge_illustrations SET archived = $2 WHERE slug = $1
         RETURNING id, slug, label, tone, archived, created_at`,
        [req.params.slug, archived]
      );
      if (!rows.length) return fail(res, 404, MESSAGES.notFound);
      return ok(res, { data: formatIllustration(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'PATCH /admin/challenge-illustrations/:slug failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = {
  challengeIllustrationImageRoutes,
  challengeIllustrationsAdminRoutes,
  classifyUpload,
  parseLabel,
};
