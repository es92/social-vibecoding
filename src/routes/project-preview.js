'use strict';

// A shared project link's preview (services/project-preview.js):
//
//   GET /                             the shell for somebody signed out,
//                                     with the front page's own title, link
//                                     preview and canonical in its head, and
//                                     the page in words for a reader that
//                                     runs no JavaScript.
//   GET /app/:slug                    the shell, as `app.get('*')` serves it,
//                                     with the project's link preview in its
//                                     head and its page in words in its
//                                     body: for a public project only.
//   GET /api/public/apps/:slug/cover.png   its 1200 x 630 cover.
//   GET /embed/:slug                  the project inside a post on X, for a
//                                     public project somebody with no
//                                     account can use (services/
//                                     project-embed.js): the page its link's
//                                     player card names. A public path, as
//                                     everybody there is a guest.
//   GET /robots.txt                   the crawl rules: everything, and the
//                                     sitemap; nothing on a staging copy.
//   GET /sitemap.xml                  the front page, the page about
//                                     private communities, and the page of
//                                     every public project worth finding.
//   GET /communities                  the signed-out page about private
//                                     communities, with its own title,
//                                     description and canonical in its head
//                                     (services/communities-page.js).
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
const embed = require('../services/project-embed');
const { applyShellDocumentHeaders, shellAssetCacheControl } = require('../services/static-cache');
const { publicProjectReadLimiter } = require('../middleware/rate-limits');
const { requestOrigin } = require('./community-invites');
const communitiesPage = require('../services/communities-page');
const searchRobots = require('../services/search-robots');
const { platformOrigin } = require('../services/app-identity-env');

const INDEX_PATH = path.join(__dirname, '..', '..', 'public', 'index.html');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
// A project's card and icon, kept for a minute: a link pasted into a busy
// chat is unfurled by every client at once.
const ENTRY_TTL_MS = 60 * 1000;
const ENTRY_MAX = 500;
const COVER_MAX = 200;
// The sitemap, rebuilt at most this often: crawlers read it rarely, and the
// directory query is the landing's own.
const SITEMAP_TTL_MS = 10 * 60 * 1000;

/** A staging copy (a proposal's preview) is never indexed: only production is. */
function isStagingCopy(env = process.env) {
  return env.USERNODE_ENV === 'staging';
}

/**
 * The origin a page is listed under (its canonical, og:url and record, the
 * sitemap's addresses): the platform's CONFIGURED one on production, as the
 * front page and the page about private communities use, so every listed
 * page names the same site whatever Host a request came with. A staging
 * copy, or a server with no configured address, is not listed anywhere and
 * keeps the request's own.
 */
function listedOrigin(req) {
  return (isStagingCopy() ? null : platformOrigin()) || requestOrigin(req);
}

/** The crawl rules for this origin. */
function robotsTxt(origin, { staging = isStagingCopy() } = {}) {
  if (staging) return 'User-agent: *\nDisallow: /\n';
  return ['User-agent: *', 'Allow: /', origin ? `Sitemap: ${origin}/sitemap.xml` : null]
    .filter(Boolean).join('\n') + '\n';
}

/**
 * Whether a public project's page is worth a search engine's time: it says
 * what it is (its own description), or somebody uses it (people active
 * lately). The rest (a test, a diagnostic, an app made and left) stays out
 * of the sitemap; its page still opens for anybody with the link.
 */
function worthListing(app) {
  return !!(app && ((app.description && String(app.description).trim()) || Number(app.active_users) > 0));
}

/** The public projects a search engine is pointed at: the sitemap's list, and the front page's links. */
function listedProjects(apps) {
  return (apps || []).filter((app) => worthListing(app) && SLUG_RE.test(String(app.slug || '')));
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The day a project last changed: its last voted-in change, else when it was made. */
function lastModified(app) {
  const t = Date.parse(app.last_merged_at || app.created_at || '');
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/**
 * The sitemap: the front page, the page about private communities, then
 * each listed project's clean address. The front page lists those projects,
 * so its date is the newest of theirs. `pageDay` is the day the shell
 * document was built (communities-page.js documentDay), the last day the
 * page about private communities changed; without it that entry has no
 * date. Neither is ever "now": a date that moves on every read tells a
 * search engine nothing.
 */
function sitemapXml(origin, apps, { pageDay = null } = {}) {
  const projects = [];
  let newest = null;
  for (const app of listedProjects(apps)) {
    const lastmod = lastModified(app);
    if (lastmod && (!newest || lastmod > newest)) newest = lastmod;
    projects.push(`  <url><loc>${escapeXml(preview.pageUrl(origin, app.slug))}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`);
  }
  const dated = (loc, day) => `  <url><loc>${escapeXml(loc)}</loc>${day ? `<lastmod>${day}</lastmod>` : ''}</url>`;
  const urls = [
    dated(`${origin}/`, newest),
    dated(`${origin}${communitiesPage.COMMUNITIES_PATH}`, /^\d{4}-\d{2}-\d{2}$/.test(String(pageDay || '')) ? pageDay : null),
    ...projects,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

function projectPreviewRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const entries = new Map();
  const covers = new Map();
  let sitemap = null;
  let landingLinks = null;

  // The projects the front page links to for a reader with no JavaScript:
  // the sitemap's own list, name and slug only, read at most as often as the
  // sitemap is. A read that fails leaves the page without its list, never
  // without the page.
  async function landingProjects() {
    if (landingLinks && landingLinks.expiresAt > Date.now()) return landingLinks.apps;
    try {
      const apps = listedProjects(await listPublicApps(pool, { includeWallets: false }))
        .slice(0, preview.LANDING_LINKS_MAX)
        .map((app) => ({ slug: app.slug, name: app.name }));
      landingLinks = { apps, expiresAt: Date.now() + SITEMAP_TTL_MS };
      return apps;
    } catch (err) {
      log.error('project-preview', 'Listing the front page\'s projects failed', { err: err.message });
      return landingLinks ? landingLinks.apps : [];
    }
  }

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
      const cover = preview.canDrawCover(app, iconBytes);
      // An icon the cover cannot be drawn from is the link's picture itself:
      // its size is read off its bytes, so the link can say it.
      const iconSize = !cover && iconBytes ? preview.pictureSize(iconBytes.data) : null;
      entry = { app, icon: iconBytes, cover, iconSize };
    }
    if (entries.size >= ENTRY_MAX) entries.clear();
    entries.set(slug, { entry, expiresAt: Date.now() + ENTRY_TTL_MS });
    return entry;
  }

  // The front page, signed out: the shell with what Homeroom is in its head
  // (request 7166: a pasted link to it showed the bare word "Homeroom" and no
  // picture). A signed-in load, and anything that fails here, goes on to the
  // static shell as before. The page's address is the platform's configured
  // one, on production only, exactly as the Link header's is
  // (search-robots.js shellCanonicalLink): never the Host a request came with.
  // The header is set here too, because the middleware that sets it for the
  // static shell comes after this router.
  router.get('/', (req, res, next) => (req.user ? next('route') : next()), async (req, res, next) => {
    if (!req.accepts('html')) return next();
    try {
      const html = await fs.promises.readFile(INDEX_PATH, 'utf8');
      const configured = platformOrigin();
      const link = searchRobots.shellCanonicalLink({
        method: req.method, path: '/', origin: configured, staging: isStagingCopy(),
      });
      const tags = preview.landingTags({ origin: requestOrigin(req), canonical: link ? configured : null });
      if (link) res.setHeader('Link', link);
      res.setHeader('Cache-Control', shellAssetCacheControl('index.html'));
      applyShellDocumentHeaders(res, INDEX_PATH);
      const content = preview.landingContent(await landingProjects());
      return res.type('html').send(preview.withBody(preview.withHead(html, tags, preview.LANDING_TITLE), content));
    } catch (err) {
      log.error('project-preview', 'Serving the front page failed', { err: err.message });
      return next();
    }
  });

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
      const tags = preview.previewTags(entry.app, requestOrigin(req) || '', {
        cover: entry.cover,
        imageSize: entry.iconSize,
        player: !!embed.embedFor(entry.app, { sign: false }),
        canonical: listedOrigin(req),
      });
      res.setHeader('Cache-Control', shellAssetCacheControl('index.html'));
      applyShellDocumentHeaders(res, INDEX_PATH);
      const page = preview.withPreview(html, tags, entry.app.name || slug);
      return res.type('html').send(preview.withBody(page, preview.projectContent(entry.app)));
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

  // The project inside a post on X. Anything it may not show gets a page
  // saying so, framed like the real one, so the post shows a line and a way
  // to Homeroom rather than the browser's own error.
  router.get('/embed/:slug', publicProjectReadLimiter, async (req, res) => {
    const origin = requestOrigin(req) || '';
    const refuse = () => {
      res.set(embed.embedHeaders(null));
      return res.status(404).type('html').send(embed.refusedPage(origin));
    };
    const slug = String(req.params.slug || '');
    if (!SLUG_RE.test(slug)) return refuse();
    try {
      const entry = await entryFor(slug);
      const frame = entry ? embed.embedFor(entry.app) : null;
      if (!frame) return refuse();
      res.set(embed.embedHeaders(entry.app.url));
      return res.type('html').send(embed.embedPage(entry.app, origin, frame.token));
    } catch (err) {
      log.error('project-preview', 'Serving a project embed failed', { slug, err: err.message });
      return refuse();
    }
  });
  // `/embed/` is a public path (middleware/auth.js), so nothing else under it
  // reaches the shell's catch-all.
  router.get(/^\/embed(?:\/.*)?$/, (req, res) => {
    res.set(embed.embedHeaders(null));
    return res.status(404).type('html').send(embed.refusedPage(requestOrigin(req) || ''));
  });

  // ── For search engines (Evan, 21 Oct 2026: search traffic is wanted) ──
  // Both are public paths (middleware/auth.js), and both name only what the
  // public directory already shows anybody.
  // A private path is marked noindex (server.js's catch-all), never
  // disallowed here: a blocked address is never read, so a search engine
  // would never see that it should drop it.
  router.get('/robots.txt', (req, res) => {
    res.set('Cache-Control', 'public, max-age=3600');
    return res.type('text/plain').send(robotsTxt(listedOrigin(req)));
  });

  router.get('/sitemap.xml', publicProjectReadLimiter, async (req, res) => {
    const origin = listedOrigin(req);
    if (!origin || isStagingCopy()) return res.status(404).end();
    try {
      if (!sitemap || sitemap.origin !== origin || sitemap.expiresAt <= Date.now()) {
        const apps = await listPublicApps(pool, { includeWallets: false });
        // The day this build's document was made; no date when it is not built.
        const built = await fs.promises.stat(INDEX_PATH).catch(() => null);
        const pageDay = built ? communitiesPage.documentDay(built.mtimeMs) : null;
        sitemap = { origin, xml: sitemapXml(origin, apps, { pageDay }), expiresAt: Date.now() + SITEMAP_TTL_MS };
      }
      res.set('Cache-Control', 'public, max-age=600');
      return res.type('application/xml').send(sitemap.xml);
    } catch (err) {
      log.error('project-preview', 'Building the sitemap failed', { err: err.message });
      return res.status(500).end();
    }
  });

  // The page about private communities, for a visitor with no session (a
  // crawler, a link preview): the shell with the page's own title and
  // description in its head, and no `X-Robots-Tag`, so it can be listed.
  // A signed-in load goes to the catch-all, as a project page's does. Its
  // canonical names the platform's CONFIGURED address and only on
  // production; nothing here reads the request's Host.
  router.get(communitiesPage.COMMUNITIES_PATH, (req, res, next) => (req.user ? next('route') : next()), publicProjectReadLimiter, async (req, res, next) => {
    if (!req.accepts('html')) return next();
    try {
      const html = await fs.promises.readFile(INDEX_PATH, 'utf8');
      const origin = isStagingCopy() ? null : platformOrigin();
      res.setHeader('Cache-Control', shellAssetCacheControl('index.html'));
      applyShellDocumentHeaders(res, INDEX_PATH);
      return res.type('html').send(communitiesPage.withCommunitiesHead(html, origin));
    } catch (err) {
      log.error('project-preview', 'Serving the page about private communities failed', { err: err.message });
      return next();
    }
  });

  return router;
}

module.exports = projectPreviewRoutes;
module.exports.robotsTxt = robotsTxt;
module.exports.sitemapXml = sitemapXml;
module.exports.worthListing = worthListing;
module.exports.listedProjects = listedProjects;
