'use strict';

// The languages Homeroom's own screens are offered in, and their packs, as
// the translation cache has them now (services/language-cache.js).
//
//   GET /api/languages
//        -> { languages: { tag: own name }, manifest: { tag: { namespace: { url, hash } } } }
//   GET /locales/live/<language>.<namespace>.<sha256>.json
//        -> the pack itself: { key: text }
//
// Public and unauthenticated: the sign-in screens are translated too, and
// both are the shell's own text. The shell asks for the list once it boots
// (frontend/src/lib/i18n/runtime.ts) and checks every pack against the hash
// the list gave, as it checks a pack the build made. A pack's URL is its
// content, so it is cached for a year; the list is asked again each load.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const cache = require('../services/language-cache');

function languageRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/languages', async (_req, res) => {
    try {
      const value = await cache.live(pool);
      res.setHeader('Cache-Control', 'no-cache');
      if (!value) return res.json({ languages: null, manifest: null });
      return res.json({ languages: value.languages, manifest: value.manifest });
    } catch (err) {
      log.warn('language-cache', 'Could not work out the languages offered', { err: err.message });
      return res.status(503).json({ error: 'languages_unavailable' });
    }
  });

  // The path is written out for the route inventory; it is cache.LIVE_PREFIX.
  router.get('/locales/live/:name', async (req, res) => {
    try {
      const bytes = await cache.pack(pool, req.params.name);
      if (!bytes) return res.status(404).end();
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.type('application/json').send(bytes);
    } catch (err) {
      log.warn('language-cache', 'Could not serve a language pack', { err: err.message });
      return res.status(503).end();
    }
  });

  return router;
}

module.exports = { languageRoutes };
