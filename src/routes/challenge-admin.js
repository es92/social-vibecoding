'use strict';

// The programme's challenges, for a full platform admin's connector session:
// the challenge tools in services/mcp-tools.js (list_challenge_events,
// get_challenge_event, add_challenge, edit_challenge, save_challenge_template,
// save_challenge_scoring_rule and the rest). They manage what the console's
// Season events, Challenge templates and Challenge scoring screens manage:
// the events, the challenges in each, the templates challenges are stamped
// from, and the rules that credit them automatically.
//
// They live at their own prefix because a connector token can never reach
// /api/v4, where the console's routes are (services/cli-api-policy.js): the
// same reason /api/bot-studio/* does. What earns them a place on the
// connector allowlist is the gate every route puts first, which
// tests/mcp-connector-policy.test.js pins: requireAdminWrite (a full admin,
// never a view-only one), reads included; then, on every write, the
// per-admin limiter and the same-origin browser guard.
//
// Each door is the console's own route, not a copy of it. After its gates it
// hands the request to the same handler the console calls
// (routes/topochain/admin/), at the same path under /api/v4/admin, so a
// connector session and the console validate, write and answer alike, and a
// fix to one is a fix to both. Only the routes listed here are handed on: a
// door that is not listed is never opened by the prefix alone. Deleting a
// whole event (which takes its challenges and everything earned for them)
// stays in the console.

const { Router } = require('express');
const { requireAdminWrite } = require('../middleware/admin');
const { challengeAdminLimiter } = require('../middleware/rate-limits');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const log = require('../services/logger');
const { seasonEventsAdminRoutes } = require('./topochain/admin/season-events');
const { challengeTemplatesAdminRoutes } = require('./topochain/admin/challenge-templates');
const { challengesAdminRoutes } = require('./topochain/admin/challenges');
const { challengeScoringAdminRoutes } = require('./topochain/admin/challenge-scoring');

const PREFIX_RE = /^\/api\/challenge-admin\//i;
const CONSOLE_PREFIX = '/api/v4/admin/';

function challengeAdminRoutes(config) {
  const router = Router();

  // The four console route groups these doors open onto, composed as
  // routes/topochain/admin.js composes them. Each write handler there keeps
  // its own adminWriteGate, which a full admin passes.
  const consoleRoutes = Router();
  consoleRoutes.use(seasonEventsAdminRoutes(config));
  consoleRoutes.use(challengeTemplatesAdminRoutes(config));
  consoleRoutes.use(challengesAdminRoutes(config));
  consoleRoutes.use(challengeScoringAdminRoutes(config));

  // The request goes on at the console's path, query string and all. It is
  // answered there or here, never by a later router: with its address
  // rewritten, a later one could read it as a request for /api/v4/admin.
  const toConsole = (req, res) => {
    req.url = req.url.replace(PREFIX_RE, CONSOLE_PREFIX);
    consoleRoutes(req, res, (err) => {
      if (res.headersSent) return;
      if (err) {
        log.error('challenge-admin', 'Console route failed', { method: req.method, message: err.message });
        res.status(500).json({ success: false, error: 'Internal server error.' });
        return;
      }
      res.status(404).json({ success: false, error: 'Not found.' });
    });
  };

  // Reads: the events, one event and its challenges, the templates an event
  // has not used yet, the templates and their categories, the scoring rules.
  router.get('/api/challenge-admin/season-events', requireAdminWrite, toConsole);
  router.get('/api/challenge-admin/season-events/:seasonEvent', requireAdminWrite, toConsole);
  router.get('/api/challenge-admin/season-events/:seasonEvent/challenges', requireAdminWrite, toConsole);
  router.get('/api/challenge-admin/season-events/:seasonEvent/challenges/available-activity-types', requireAdminWrite, toConsole);
  router.get('/api/challenge-admin/challenge-templates', requireAdminWrite, toConsole);
  router.get('/api/challenge-admin/challenge-templates/categories', requireAdminWrite, toConsole);
  router.get('/api/challenge-admin/challenge-templates/:id', requireAdminWrite, toConsole);
  router.get('/api/challenge-admin/challenge-scoring', requireAdminWrite, toConsole);

  // Events: make one, or change one. Never delete one from here.
  router.post('/api/challenge-admin/season-events', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);
  router.patch('/api/challenge-admin/season-events/:seasonEvent', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);

  // An event's challenges: add, edit, reorder, move to another event, remove.
  router.post('/api/challenge-admin/season-events/:seasonEvent/challenges', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);
  router.patch('/api/challenge-admin/season-events/:seasonEvent/challenges/update-display-orders', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);
  router.put('/api/challenge-admin/season-events/:seasonEvent/challenges/:challenge', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);
  router.patch('/api/challenge-admin/season-events/:seasonEvent/challenges/:challenge/move', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);
  router.delete('/api/challenge-admin/season-events/:seasonEvent/challenges/:challenge', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);

  // Templates: make, change, delete (refused while a challenge uses one).
  router.post('/api/challenge-admin/challenge-templates', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);
  router.patch('/api/challenge-admin/challenge-templates/:id', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);
  router.delete('/api/challenge-admin/challenge-templates/:id', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);

  // Scoring rules: make, change, delete, and run the scorer (or preview it).
  router.post('/api/challenge-admin/challenge-scoring/rules', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);
  router.put('/api/challenge-admin/challenge-scoring/rules/:id', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);
  router.delete('/api/challenge-admin/challenge-scoring/rules/:id', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);
  router.post('/api/challenge-admin/challenge-scoring/run', requireAdminWrite, challengeAdminLimiter, sameOriginBrowserOnly, toConsole);

  return router;
}

module.exports = { challengeAdminRoutes };
