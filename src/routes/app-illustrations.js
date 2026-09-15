const express = require('express');
const { getPool } = require('../db/pool');
const { getAppForUser, NON_SECRET_APP_COLUMNS } = require('../services/app-access');
const { canManageApp } = require('../services/app-admins');
const { sniffImageType } = require('../services/attachments');
const log = require('../services/logger');
const { attachmentUploadLimiter } = require('../middleware/rate-limits');
const proposals = require('../services/illustration-proposals');

// The card colours an illustration may carry, kept in step with
// frontend/src/features/home/panels/ui.tsx (asserted by
// tests/featured-illustration-tint.test.js, since a .tsx cannot be required
// from here).
//
// TONES are the twelve tone-50 colours the editor offers (`.home-tone-cream`
// … `-gray` in app.css). LEGACY_TINTS are the five hashed tints it offered
// briefly before them; they are still accepted so an illustration saved then
// keeps its colour through a later reframe, and still render, but nothing
// picks a new one.
//
// A card whose illustration carries neither wears the hash of its own slug,
// so a stored value is an OVERRIDE and the absent case is the default rather
// than a missing value. Nothing outside these lists is accepted: the palette
// is the app's own, and an arbitrary colour is exactly what this field is not.
const TONES = ['cream', 'yellow', 'orange', 'coral', 'pink', 'purple',
  'indigo', 'blue', 'teal', 'mint', 'sage', 'gray'];
const LEGACY_TINTS = [1, 2, 3, 4, 5];
const isCardColour = tint => (typeof tint === 'string' ? TONES.includes(tint) : LEGACY_TINTS.includes(tint));

/**
 * Framing, plus the optional card colour that travels with it.
 *
 * The tint is omitted from the result when it was not supplied, which is what
 * makes PATCH's `||` jsonb merge leave an already-saved colour alone rather
 * than writing a null over it.
 */
function parseFraming(body) {
  const { zoom, x, y, tint } = body || {};
  if (![zoom, x, y].every(v => typeof v === 'number' && Number.isFinite(v))
      || zoom < 0.5 || zoom > 3 || x < -100 || x > 100 || y < -100 || y > 100) return null;
  if (tint === undefined || tint === null) return { zoom, x, y };
  return isCardColour(tint) ? { zoom, x, y, tint } : null;
}
function validateImage(data) {
  if (!Buffer.isBuffer(data) || !data.length || data.length > 1024 * 1024) return null;
  const type = sniffImageType(data);
  return ['image/png', 'image/jpeg', 'image/webp'].includes(type) ? type : null;
}
function illustrationImageRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);
  router.get('/app-illustrations/:id', async (req, res) => {
    if (!/^[a-f0-9]{32}$/.test(req.params.id)) return res.status(404).end();
    try {
      // An id names either a published image or one a proposal is still
      // carrying (#2086): the card previews the proposed image from the same
      // URL it will keep once the vote applies it.
      const { rows } = await pool.query(`SELECT content_type, data FROM app_illustrations WHERE id = $1
        UNION ALL SELECT dark_content_type AS content_type, dark_data AS data FROM app_illustrations WHERE dark_id = $1
        UNION ALL SELECT content_type, data FROM app_illustration_proposals WHERE id = $1
        UNION ALL SELECT dark_content_type AS content_type, dark_data AS data FROM app_illustration_proposals WHERE dark_id = $1`,
      [req.params.id]);
      if (!rows.length) return res.status(404).end();
      res.set('Content-Type', rows[0].content_type);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return res.send(rows[0].data);
    } catch (err) { log.error('illustrations', 'Image read failed', { err: err.message }); return res.status(500).end(); }
  });
  return router;
}
// #2086: none of the writes below touch apps.featured_illustration. Each one
// builds the COMPLETE record the app would wear and opens a governance
// proposal carrying it (services/illustration-proposals.js); the record
// lands when the group votes it in. The response therefore returns the
// illustration the app still wears plus the proposal to link to, and a 409
// with the open card when one is already waiting.
function illustrationRoutes(config) {
  const router = express.Router();
  const pool = getPool(config);
  const path = '/api/apps/:slug/featured-illustration';
  router.use(path, async (req, res, next) => {
    try {
      const app = await getAppForUser(pool, req.params.slug, req.user, 'view', NON_SECRET_APP_COLUMNS.join(', '));
      if (!app) return res.status(404).json({ error: 'App not found' });
      if (!(await canManageApp(pool, app, req.user))) return res.status(403).json({ error: 'Only app managers can propose a change to this illustration.' });
      req.illustrationApp = app;
      next();
    } catch (err) { next(err); }
  });
  router.get(path, async (req, res, next) => {
    try {
      const pending = await proposals.findOpenProposal(pool, req.illustrationApp.id);
      res.json({
        illustration: req.illustrationApp.featured_illustration || null,
        pending: pending ? proposals.proposalLink(req.illustrationApp, pending) : null,
      });
    } catch (err) { next(err); }
  });
  const propose = async (req, res, next, proposed, images) => {
    const app = req.illustrationApp;
    try {
      const issue = await proposals.createProposal(pool, { app, user: req.user, proposed, images });
      res.status(201).json({ illustration: app.featured_illustration || null, proposal: proposals.proposalLink(app, issue) });
    } catch (err) {
      if (err instanceof proposals.PendingProposalError) {
        return res.status(409).json({ error: err.message, pending: err.issue ? proposals.proposalLink(app, err.issue) : null });
      }
      next(err);
    }
  };
  router.post(path, attachmentUploadLimiter, express.raw({ type: 'application/octet-stream', limit: '2mb' }), async (req, res, next) => {
    const framing = parseFraming({
      zoom: Number(req.query.zoom), x: Number(req.query.x), y: Number(req.query.y),
      // A query value is always a string, so a tone name arrives ready and a
      // legacy tint has to be coerced back to the number it is stored as —
      // the editor stopped sending those, but a page cached from before it
      // did has not. Absent stays absent, so an upload that chose no colour
      // is not rejected for it.
      tint: typeof req.query.tint === 'string' && /^[0-9]+$/.test(req.query.tint)
        ? Number(req.query.tint) : req.query.tint,
    });
    const contentType = validateImage(req.body);
    if (!framing || !contentType) return res.status(400).json({ error: 'Choose a PNG, JPEG or WebP under 1 MB, a card colour from the set, and valid image framing.' });
    const id = proposals.newImageId();
    // A single upload proposes the light image on its own, as it always did.
    await propose(req, res, next, { url: proposals.imageUrl(id), ...framing },
      { light: { id, contentType, data: req.body } });
  });
  // Both variants and their shared framing travel in one proposal.
  // Raw JSON avoids the shell's smaller general-purpose JSON body limit.
  router.put(path, attachmentUploadLimiter, express.raw({ type: 'application/octet-stream', limit: '3mb' }), async (req, res, next) => {
    let body;
    try { body = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Could not read the illustration pair.' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Could not read the illustration pair.' });
    const framing = parseFraming(body);
    const decode = value => typeof value === 'string' && value.length <= 1398104 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) ? Buffer.from(value, 'base64') : null;
    const light = body.light === undefined ? null : decode(body.light);
    const dark = body.dark === undefined || body.dark === null ? null : decode(body.dark);
    if (!framing || (body.light !== undefined && !validateImage(light)) ||
        (body.dark !== undefined && body.dark !== null && !validateImage(dark))) {
      return res.status(400).json({ error: 'Choose PNG, JPEG or WebP images under 1 MB and valid shared framing.' });
    }
    const current = req.illustrationApp.featured_illustration || null;
    // A dark image or a reframe on its own needs a light image to sit under
    // it, and the only one in hand is the app's current record: a proposal
    // that is still open does not count, and there is at most one anyway.
    if (!light && !current?.url) return res.status(409).json({ error: 'Upload a light image first.' });
    const lightId = light ? proposals.newImageId() : null;
    const darkId = dark ? proposals.newImageId() : null;
    // The same merge the direct write performed: the current record under
    // the new framing, then whichever urls this save replaces. A dark left
    // undefined keeps the current dark image; null drops it.
    const proposed = {
      ...(current || {}),
      ...framing,
      url: light ? proposals.imageUrl(lightId) : current.url,
      darkUrl: body.dark === undefined ? (current?.darkUrl || null) : dark ? proposals.imageUrl(darkId) : null,
    };
    await propose(req, res, next, proposed, {
      light: light ? { id: lightId, contentType: validateImage(light), data: light } : null,
      dark: dark ? { id: darkId, contentType: validateImage(dark), data: dark } : null,
    });
  });
  router.patch(path, async (req, res, next) => {
    const framing = parseFraming(req.body);
    if (!framing) return res.status(400).json({ error: 'Choose valid image framing and a card colour from the set.' });
    const current = req.illustrationApp.featured_illustration || null;
    if (!current) return res.status(409).json({ error: 'The illustration was removed. Upload an image again.' });
    await propose(req, res, next, { ...current, ...framing }, {});
  });
  router.delete(path, async (req, res, next) => {
    // Nothing to remove means nothing to vote on.
    if (!req.illustrationApp.featured_illustration) return res.json({ illustration: null, proposal: null });
    await propose(req, res, next, null, {});
  });
  return router;
}
module.exports = { illustrationRoutes, illustrationImageRoutes, parseFraming, validateImage, TONES, LEGACY_TINTS };
