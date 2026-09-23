'use strict';

// Per-app "Add to Home Screen" (#1508): a manifest and an install page for
// every app, so a phone can carry an icon for each platform app it uses.
//
//   GET /app/:slug/manifest.webmanifest   the app's own web app manifest
//   GET /app/:slug/install                the standalone page that links it
//
// Why a page of its own, and not the shell: the browser's install flow reads
// the manifest of the document it is looking at, and the shell's document is
// the platform PWA. Swapping the shell's `<link rel="manifest">` while an app
// is open would change what the platform's own home-screen install points
// at, and Chrome keys installed apps by manifest id / start_url / scope, so
// a per-app manifest under `scope: "/"` would collide with it. This route
// leaves `/`, frontend/src/head.html and public/manifest.webmanifest alone.
//
// Mounted in server.js AFTER authMiddleware — both routes need `req.user` —
// and BEFORE the `app.get('*')` catch-all that would otherwise answer these
// paths with index.html. The auth middleware lets any `/app/<slug>/...` path
// through without a session (isSpaDocumentPath) so the shell can boot into
// its login screen for a deep link; here that arrives as `req.user`
// undefined, and the two routes answer it themselves: the manifest 404s, the
// page renders a sign-in variant that sends the visitor into `/app/<slug>`.
//
// Access is the same gate the iframe token uses — getAppForUser at 'view',
// answering 404 (never 403) when it denies, so a private app is not
// enumerable through its manifest any more than through its API.
//
// The manifest's icon needs a declared size (Chrome counts a PNG towards
// installability only when `sizes` is at least 144x144) and app_icons
// stores bytes with no dimensions, so the route reads the PNG header once
// per icon id and keeps the answer: ids are immutable (app-manifest's
// reconcile mints a fresh id whenever the committed bytes change).

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const {
  pngDimensions, buildManifest, renderInstallPage, renderSignInPage, renderNotFoundPage,
} = require('../services/app-install-manifest');

// Same shape the auth middleware and the client router accept for a clean
// app path. Anything else never reaches the database.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;
const ICON_ID_RE = /^[a-f0-9]{32}$/;
// The IHDR chunk ends at byte 24; a little slack costs nothing.
const ICON_HEAD_BYTES = 32;
const ICON_CACHE_MAX = 1000;

const NO_STORE = 'private, no-store';

function appInstallRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const columns = `${appAccess.ACCESS_COLUMNS}, name, icon_emoji, icon_image_id, manifest_snapshot`;

  /** icon id → { type, dims } for the icons this process has already read. */
  const iconFacts = new Map();

  // The stored content type and, for a PNG, the dimensions off its header.
  // Only the first bytes leave the database. A miss (a row that is gone) is
  // not cached — the app row would be pointing at a deleted icon, which the
  // next reconcile fixes — and a query failure degrades to "unknown", which
  // the manifest renders as `sizes: "any"`.
  async function readIconFacts(id) {
    if (typeof id !== 'string' || !ICON_ID_RE.test(id)) return null;
    if (iconFacts.has(id)) return iconFacts.get(id);
    let rows;
    try {
      ({ rows } = await pool.query(
        'SELECT content_type, substring(data FROM 1 FOR 32) AS head FROM app_icons WHERE id = $1',
        [id]
      ));
    } catch (err) {
      log.warn('app-install', 'Icon header read failed', { id, err: err.message });
      return null;
    }
    if (!rows.length) return null;
    const head = Buffer.isBuffer(rows[0].head) ? rows[0].head.subarray(0, ICON_HEAD_BYTES) : null;
    const facts = {
      type: typeof rows[0].content_type === 'string' ? rows[0].content_type : null,
      dims: head ? pngDimensions(head) : null,
    };
    if (iconFacts.size >= ICON_CACHE_MAX) iconFacts.delete(iconFacts.keys().next().value);
    iconFacts.set(id, facts);
    return facts;
  }

  // The row, or null when the slug is malformed, unknown, or not viewable
  // by this user. Throws only on a database failure.
  async function resolveApp(req, slug) {
    if (!req.user || !SLUG_RE.test(slug)) return null;
    return appAccess.getAppForUser(pool, slug, req.user, 'view', columns);
  }

  function manifestFacts(app) {
    const snapshot = app.manifest_snapshot && typeof app.manifest_snapshot === 'object'
      ? app.manifest_snapshot : null;
    return {
      slug: app.slug,
      name: app.name,
      description: snapshot && typeof snapshot.description === 'string' ? snapshot.description : '',
      icon_emoji: app.icon_emoji || null,
      icon_image_id: app.icon_image_id || null,
    };
  }

  router.get('/app/:slug/manifest.webmanifest', async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    const slug = String(req.params.slug || '');
    let app;
    try {
      app = await resolveApp(req, slug);
    } catch (err) {
      log.error('app-install', 'App resolve failed', { slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
    if (!app) return res.status(404).json({ error: 'App not found' });

    const icon = await readIconFacts(app.icon_image_id);
    const manifest = buildManifest(manifestFacts(app), {
      iconDims: icon ? icon.dims : null,
      iconType: icon ? icon.type : null,
    });
    res.type('application/manifest+json');
    return res.send(JSON.stringify(manifest));
  });

  router.get('/app/:slug/install', async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    res.type('html');
    const slug = String(req.params.slug || '');
    if (!SLUG_RE.test(slug)) return res.status(404).send(renderNotFoundPage());
    if (!req.user) return res.send(renderSignInPage(slug));

    let app;
    try {
      app = await resolveApp(req, slug);
    } catch (err) {
      log.error('app-install', 'App resolve failed', { slug, err: err.message });
      return res.status(500).send(renderNotFoundPage());
    }
    if (!app) return res.status(404).send(renderNotFoundPage());

    // Every stored icon is a raster: app-manifest's reconcile only admits
    // PNG/JPEG/WebP/GIF bytes (SVG is refused because it can script when
    // navigated to), and iOS wants a raster for the apple-touch-icon.
    const iconUrl = typeof app.icon_image_id === 'string' && ICON_ID_RE.test(app.icon_image_id)
      ? `/app-icons/${app.icon_image_id}` : '/apple-touch-icon.png';
    return res.send(renderInstallPage(manifestFacts(app), { iconUrl }));
  });

  return router;
}

module.exports = { appInstallRoutes };
