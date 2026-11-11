'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { sendRange } = require('./byte-range');
const log = require('../services/logger');

// Issue-video serving (#3940) — sibling of /issue-images/:id (see
// src/routes/issue-images.js for the full rationale). Mounted in
// server.js BEFORE authMiddleware: the clip is embedded as a markdown
// link in a GitHub issue body, the in-app topic view plays it inline,
// and the coding agents' `curl` loads it with no special auth. The only
// access control is the unguessable 32-hex id (random 16 bytes,
// generated in routes/feedback.js) — the clip is already public in the
// GitHub issue body anyway.
//
// Rows are immutable (one upload, linked once), so the year-long
// immutable cache header is safe; a GC'd orphan id just 404s for fresh
// fetchers. Unlike the images, this route answers Range requests: a
// video element seeking into a clip sends `bytes=N-`, and answering
// 200-with-the-whole-body makes some players refuse to seek (or stall
// until the whole buffer arrives). A single bytea row is one buffer, so
// the slice is a cheap subarray.
function issueVideoRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/issue-videos/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
    try {
      const { rows } = await pool.query(
        'SELECT content_type, size_bytes, data FROM issue_videos WHERE id = $1',
        [id]
      );
      if (!rows.length || !rows[0].data) return res.status(404).end();
      // #2515: the type here is a STORED value, so a file whose recorded
      // content_type says video/* while its bytes are markup must not be
      // sniffed into HTML on the platform's own origin.
      res.set('Content-Type', rows[0].content_type || 'application/octet-stream');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      return sendRange(req, res, rows[0].data);
    } catch (err) {
      log.error('issue-videos', 'Failed to serve issue video', { id, err: err.message });
      res.status(500).end();
    }
  });

  return router;
}

module.exports = { issueVideoRoutes };
