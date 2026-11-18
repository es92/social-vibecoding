'use strict';

// The communities a person pinned (services/home-pins.js), the account's:
// the Pinned group of the Communities tab's page.
const { Router } = require('express');
const { getPool } = require('../db/pool');
const pins = require('../services/home-pins');
const log = require('../services/logger');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');

function homePinRoutes(config, { pool = getPool(config) } = {}) {
  const router = Router();
  router.use('/api/me/home-pins', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user?.id) return res.status(401).json({ error: 'Sign in to pin communities to Home' });
    next();
  });
  const run = (fn) => async (req, res) => {
    try {
      res.json({ pins: await fn(req) });
    } catch (err) {
      if (err.status) return res.status(err.status).json(err.body || { error: err.message });
      log.error('home-pins', 'Request failed', { message: err.message });
      res.status(500).json({ error: 'Could not update your Home. Try again.' });
    }
  };
  router.get('/api/me/home-pins', run((req) => pins.list(pool, req.user.id)));
  // What the Communities page's cards say under each community's name, pinned
  // or joined: members, what went live this week and who was there
  // (services/home-pins.js).
  router.get('/api/me/home-pins/activity', async (req, res) => {
    try {
      res.json({ activity: await pins.activity(pool, req.user.id) });
    } catch (err) {
      log.error('home-pins', 'Activity read failed', { message: err.message });
      res.status(500).json({ error: 'Could not read your communities. Try again.' });
    }
  });
  router.post('/api/me/home-pins/import', sameOriginBrowserOnly,
    run((req) => pins.importPins(pool, req.user, req.body?.slugs)));
  router.put('/api/me/home-pins', sameOriginBrowserOnly,
    run((req) => pins.reorder(pool, req.user, req.body?.slugs)));
  router.put('/api/me/home-pins/:slug', sameOriginBrowserOnly,
    run((req) => pins.pin(pool, req.user, req.params.slug)));
  router.delete('/api/me/home-pins/:slug', sameOriginBrowserOnly,
    run((req) => pins.unpin(pool, req.user, req.params.slug)));
  return router;
}

module.exports = { homePinRoutes };
