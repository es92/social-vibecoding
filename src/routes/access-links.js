'use strict';

/**
 * Admin invite links to Homeroom itself over HTTP (services/access-links.js
 * has the rules; Admin › Activation codes makes them, routes/admin.js).
 *
 *   GET  /welcome/:code                   the page: the shell, with a link
 *                                         preview in its head, and the code
 *                                         in an HttpOnly cookie for the
 *                                         sign-in that follows
 *   GET  /api/public/access-links/:code   whether it still lets somebody in,
 *                                         signed out
 *   POST /api/auth/access-link            an account signed in and still
 *                                         waiting uses a link it opened
 *
 * The POST sits under /api/auth/, which the platform-access gate leaves
 * open (GATE_OPEN_PATHS in middleware/auth.js): an account without access
 * is exactly who it is for.
 */

const fs = require('fs');
const path = require('path');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const accessLinks = require('../services/access-links');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const { applyShellDocumentHeaders, shellAssetCacheControl } = require('../services/static-cache');
const { inviteRedeemLimiter, invitePreviewLimiter } = require('../middleware/rate-limits');
const { withPreviewTags, escapeAttr } = require('./community-invites');

const INDEX_PATH = path.join(__dirname, '..', '..', 'public', 'index.html');

/**
 * What a pasted link unfurls to. It says only that it is an invitation to
 * Homeroom: nothing about who it is for, and nothing more for a dead one
 * than that it no longer works.
 */
function previewTags(live) {
  const title = live ? 'You\'re invited to Homeroom' : 'Homeroom invite';
  const description = live
    ? 'Make your account and start right away. This link skips the waitlist.'
    : 'This invite link has already been used.';
  return [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Homeroom">',
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${escapeAttr(title)}">`,
    `<meta name="twitter:description" content="${escapeAttr(description)}">`,
  ].join('\n');
}

function accessLinkRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/public/access-links/:code', invitePreviewLimiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      return res.json(await accessLinks.preview(pool, req.params.code));
    } catch (err) {
      log.error('access-links', 'Reading an admin invite link failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/api/auth/access-link', inviteRedeemLimiter, sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    // A copy the page's GET left behind is used now, by this call.
    accessLinks.clearAccessCookie(req, res);
    const result = await accessLinks.admitWith(pool, code, req.user.id);
    if (result.status === 'let_in' || result.status === 'already_in') {
      return res.json({ ok: true, status: result.status });
    }
    if (result.status === 'failed') return res.status(500).json({ error: 'Internal server error' });
    return res.status(410).json({
      error: result.status === 'used'
        ? 'This invite link has already been used.'
        : 'This invite link does not work.',
      reason: result.status,
    });
  });

  // The page. The shell, as `app.get('*')` serves it, with the link preview
  // in its head; the shell itself routes the path (the landing's sign-up
  // sheet, features/auth/landing.tsx). A live code also rides in an
  // HttpOnly cookie, so the sign-in that follows spends it server-side.
  // Nothing is spent here: a link checker GETs this page too.
  router.get('/welcome/:code', invitePreviewLimiter, async (req, res, next) => {
    if (!req.accepts('html')) return next();
    const code = req.params.code;
    try {
      const preview = await accessLinks.preview(pool, code);
      // Not for a viewer who is in already (an admin trying the link, say):
      // the copy would wait in this browser for whoever signs up on it next.
      const inAlready = !!(req.user && (req.user.hasPlatformAccess || req.user.isAdmin));
      if (preview.live && !inAlready) accessLinks.setAccessCookie(req, res, code);
      const html = await fs.promises.readFile(INDEX_PATH, 'utf8');
      res.setHeader('Cache-Control', 'no-store');
      applyShellDocumentHeaders(res, INDEX_PATH);
      res.type('html').send(withPreviewTags(html, previewTags(preview.live)));
    } catch (err) {
      log.error('access-links', 'Serving an admin invite link page failed', { err: err.message });
      if (!res.headersSent) {
        res.setHeader('Cache-Control', shellAssetCacheControl('index.html'));
        return res.sendFile(INDEX_PATH);
      }
    }
    return undefined;
  });

  return router;
}

module.exports = accessLinkRoutes;
module.exports.previewTags = previewTags;
