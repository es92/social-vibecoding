'use strict';

// The This week page's data (#6371): GET /api/me/weekly-digest.
//
// One read, for the signed-in person: every project they are in that had
// something this week, its changes that went live (newest first) and its
// open votes, each capped at weeklyDigest.PAGE_LISTED with a total. The
// page itself is frontend/src/features/weekly-digest/ (#week), opened by
// the Friday row "Your weekly digest is ready".
//
// `?demo=1` on staging answers a fixed, obviously fake week, the sibling of
// routes/ai-work.js's demoWork(): a fresh clone has no sessions for the
// fixture account, and the page's shots need a week to show.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const weeklyDigest = require('../services/weekly-digest');
const log = require('../services/logger');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A fixed week for the page's declared checks and before/after shots. */
function demoWeek(now = new Date()) {
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const day = (days) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const merged = (id, number, title, days) => ({
    sessionId: id, prNumber: number, title, mergedAt: day(days),
  });
  const open = (id, number, title, myVote = false) => ({
    sessionId: id, prNumber: number, title, myVote,
  });
  const projects = [
    {
      slug: 'staging-demo-your-app',
      name: 'Staging demo app',
      merged: [
        merged(-9401, 9401, 'Staging demo: a weekly digest on one page', 1),
        merged(-9402, 9402, 'Staging demo: a pause button', 3),
        merged(-9403, 9403, 'Staging demo: export to a spreadsheet', 5),
      ],
      mergedTotal: 12,
      open: [
        open(-9404, 9404, 'Staging demo: a reminder email'),
        open(-9405, 9405, 'Staging demo: tag filter', true),
      ],
      openTotal: 3,
    },
    {
      slug: 'staging-demo-emoji-icon',
      name: 'Staging demo emoji icon',
      merged: [merged(-9411, 9411, 'Staging demo: a high score board', 2)],
      mergedTotal: 4,
      open: [open(-9412, 9412, 'Staging demo: two-player mode')],
      openTotal: 1,
    },
    {
      slug: 'staging-demo-long-name',
      name: 'Staging demo photo album and journal',
      merged: [merged(-9421, 9421, 'Staging demo: a page for each month', 4)],
      mergedTotal: 2,
      open: [],
      openTotal: 0,
    },
  ];
  return {
    since,
    until: now.toISOString(),
    projects,
    mergedTotal: projects.reduce((sum, p) => sum + p.mergedTotal, 0),
    projectCount: projects.length,
  };
}

function weeklyDigestRoutes(config, { pool = getPool(config) } = {}) {
  const router = Router();
  router.get('/api/me/weekly-digest', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.user?.id) return res.status(401).json({ error: 'Sign in to see your week' });
    if (IS_STAGING && req.query.demo === '1') return res.json(demoWeek());
    try {
      res.json(await weeklyDigest.forUser(pool, req.user.id));
    } catch (err) {
      log.error('weekly-digest', 'Read failed', { message: err.message });
      res.status(500).json({ error: 'Could not load your week. Try again.' });
    }
  });
  return router;
}

module.exports = { weeklyDigestRoutes, demoWeek };
