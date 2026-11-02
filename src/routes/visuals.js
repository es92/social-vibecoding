'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const galleryDemo = require('../services/gallery-demo');
const mediaStore = require('../services/media-store');
const { rangeFor } = require('../services/check-visual-media');

// Public artifact serving for before/after visuals (#195).
//
// Mounted in server.js BEFORE authMiddleware: GitHub's camo image proxy
// fetches PR-body embeds anonymously, so this route must never redirect
// to login. The only access control is the unguessable 32-hex id (random
// 16 bytes, generated in src/services/visuals.js) — the same artifacts
// are already visible publicly in the PR body on GitHub anyway.
//
// Artifacts are immutable: a re-capture inserts new ids and deletes the
// old rows, so a year-long immutable cache header is safe (a deleted id
// just 404s for fresh fetchers; caches holding it are harmless).
function visualsRoutes(config, { store = mediaStore.getStore(config) } = {}) {
  const router = Router();
  const pool = getPool(config);

  router.get('/visuals/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
    // Staging mock data (#860): the #admin/gallery section's ?demo=1 rows
    // reference reserved artifact ids that exist in no table — the tile
    // renderer always builds /visuals/<id>, so a data-URI can't be threaded
    // through it. Serve the tiny inline placeholder PNGs for exactly those
    // ids. Gated on USERNODE_ENV === 'staging' inside isDemoVisualId, so
    // this is a strict no-op in production.
    const demoBytes = galleryDemo.demoVisualBytes(id);
    if (demoBytes) {
      res.set('Content-Type', demoBytes.contentType);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'no-store');
      return res.send(demoBytes.data);
    }
    try {
      const { rows } = await pool.query(
        `SELECT content_type, object_key, bytes, legacy_etag FROM session_visuals WHERE id = $1`,
        [id]
      );
      if (!rows.length) return res.status(404).end();
      const row = rows[0];
      const contentType = row.content_type || 'application/octet-stream';
      const total = Number(row.bytes);

      // #2515: the type here is a STORED value, so a capture whose recorded
      // content_type says image/* while its bytes are markup must not be
      // sniffed into HTML on the platform's own origin.
      res.set('Content-Type', contentType);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('Accept-Ranges', 'bytes');

      const range = rangeFor(req.headers.range, total);
      if (range === false) {
        res.set('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      if (range) {
        res.status(206);
        res.set('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
        // Express previously hashed the sliced response for its weak ETag.
        // Read ONLY the requested range (at most this route's 8 MB cap),
        // keeping that exact validator without downloading the full video.
        const chunks = [];
        for await (const chunk of await mediaStore.stream(store, row.object_key, range)) chunks.push(Buffer.from(chunk));
        return res.send(Buffer.concat(chunks));
      }
      res.set('ETag', row.legacy_etag);
      res.set('Content-Length', String(total));
      if (req.fresh) {
        res.removeHeader('Content-Type');
        res.removeHeader('Content-Length');
        return res.status(304).end();
      }
      if (req.method === 'HEAD') return res.end();
      return await mediaStore.respond(res, store, row);
    } catch (err) {
      log.error('visuals', 'Failed to serve artifact', { id, err: err.message });
      if (res.headersSent || res.destroyed) return res.destroy();
      for (const header of ['Cache-Control', 'ETag', 'Content-Type', 'Content-Length', 'Content-Range']) res.removeHeader(header);
      res.status(500).end();
    }
  });

  return router;
}

module.exports = { visualsRoutes };
