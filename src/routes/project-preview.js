'use strict';

// A shared project link's preview (services/project-preview.js):
//
//   GET /app/:slug                    the shell, as `app.get('*')` serves it,
//                                     with the project's link preview in its
//                                     head: for a public project only.
//   GET /api/public/apps/:slug/cover.png   its 1200 x 630 cover.
//
// Share copies `/app/<slug>` for a public project (features/dialogs/
// share.tsx), which a member's shell opens as the app and anybody else's as
// the project's page. Mounted BEFORE the catch-all, which would answer the
// page with a plain index.html; anything that is not a listed public project
// falls through to it, so a link to a private one discloses nothing.

const fs = require('fs');
const path = require('path');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { listPublicApps } = require('../services/public-app-directory');
const preview = require('../services/project-preview');
const { applyShellDocumentHeaders, shellAssetCacheControl } = require('../services/static-cache');
const { publicProjectReadLimiter } = require('../middleware/rate-limits');
const { requestOrigin } = require('./community-invites');

const INDEX_PATH = path.join(__dirname, '..', '..', 'public', 'index.html');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
// A project's card and icon, kept for a minute: a link pasted into a busy
// chat is unfurled by every client at once.
const ENTRY_TTL_MS = 60 * 1000;
const ENTRY_MAX = 500;
const COVER_MAX = 200;

function projectPreviewRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const entries = new Map();
  const covers = new Map();

  // The public project, its icon's bytes, and whether its cover can be
  // drawn; null for anything the public directory does not list.
  async function entryFor(slug) {
    const hit = entries.get(slug);
    if (hit && hit.expiresAt > Date.now()) return hit.entry;
    // A cheap look first, so a made-up address costs one indexed read.
    const { rows: known } = await pool.query(
      `SELECT 1 FROM apps WHERE slug = $1 AND view_visibility = 'public' AND NOT self_hosted`, [slug]);
    const [app] = known.length ? await listPublicApps(pool, { includeWallets: false, slug }) : [];
    let entry = null;
    if (app) {
      const iconId = app.icon_url ? app.icon_url.split('/').pop() : null;
      const icon = iconId
        ? (await pool.query('SELECT content_type, data FROM app_icons WHERE id = $1', [iconId])).rows[0] || null
        : null;
      const iconBytes = icon ? { contentType: icon.content_type, data: icon.data } : null;
      entry = { app, icon: iconBytes, cover: preview.canDrawCover(app, iconBytes) };
    }
    if (entries.size >= ENTRY_MAX) entries.clear();
    entries.set(slug, { entry, expiresAt: Date.now() + ENTRY_TTL_MS });
    return entry;
  }

  // A signed-in person's own load of the address goes straight to the
  // catch-all: the preview is for whoever unfurls a link, and they carry no
  // session.
  router.get('/app/:slug', (req, res, next) => (req.user ? next('route') : next()), publicProjectReadLimiter, async (req, res, next) => {
    if (!req.accepts('html')) return next();
    const slug = String(req.params.slug || '');
    if (!SLUG_RE.test(slug)) return next();
    try {
      const entry = await entryFor(slug);
      if (!entry) return next();
      const html = await fs.promises.readFile(INDEX_PATH, 'utf8');
      const tags = preview.previewTags(entry.app, requestOrigin(req) || '', { cover: entry.cover });
      res.setHeader('Cache-Control', shellAssetCacheControl('index.html'));
      applyShellDocumentHeaders(res, INDEX_PATH);
      return res.type('html').send(preview.withPreview(html, tags, entry.app.name || slug));
    } catch (err) {
      log.error('project-preview', 'Serving a project page failed', { slug, err: err.message });
      return next();
    }
  });

  router.get('/api/public/apps/:slug/cover.png', publicProjectReadLimiter, async (req, res) => {
    const slug = String(req.params.slug || '');
    if (!SLUG_RE.test(slug)) return res.status(404).end();
    try {
      const entry = await entryFor(slug);
      if (!entry || !entry.cover) return res.status(404).end();
      const key = [slug, entry.app.icon_url || '', entry.app.icon_emoji || '', entry.app.icon_color || ''].join('|');
      let png = covers.get(key);
      if (!png) {
        png = preview.coverPng(entry.app, entry.icon);
        if (!png) return res.status(404).end();
        if (covers.size >= COVER_MAX) covers.clear();
        covers.set(key, png);
      }
      res.set('Content-Type', 'image/png');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(png);
    } catch (err) {
      log.error('project-preview', 'Drawing a cover failed', { slug, err: err.message });
      return res.status(500).end();
    }
  });

  return router;
}

module.exports = projectPreviewRoutes;
