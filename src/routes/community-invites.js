'use strict';

/**
 * Invite links over HTTP (services/community-invites.js has the rules).
 *
 *   POST   /api/apps/:slug/invite-links            make a link
 *   GET    /api/apps/:slug/invite-links            your links: the live ones
 *                                                  and, for the last 30
 *                                                  days, the ones that
 *                                                  ended (every such link,
 *                                                  for someone who manages
 *                                                  the project)
 *   DELETE /api/invite-links/:id                   turn one off
 *   GET    /api/public/invites/:token              the preview, signed out
 *   GET    /api/public/invites/:token/picture      the project's picture, when
 *                                                  it is an after-shot
 *   GET    /api/invite-links/by-token/:token       the preview plus where
 *                                                  the viewer stands on it
 *   POST   /api/invite-links/by-token/:token/redeem  follow it
 *   GET    /api/invite-links/queued                the communities a person
 *                                                  still waiting is queued for
 *   GET    /invite/:token                          the page: the shell, with
 *                                                  a link preview in its head
 *
 * The by-token routes and `queued` are open to a signed-in account without
 * platform access (GATE_OPEN_PATHS in middleware/auth.js): following a link
 * from the waiting room is how somebody still waiting queues a community.
 * Everything else a link does is behind the gate like the rest of the API.
 */

const fs = require('fs');
const path = require('path');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const inviteActivity = require('../services/invite-activity');
const journeyEvents = require('../services/journey-events');
const log = require('../services/logger');
const appAccess = require('../services/app-access');
const invites = require('../services/community-invites');
const emojiTile = require('../services/emoji-tile');
const stagingDemoInvite = require('../services/staging-demo-invite');
const phoneAuth = require('../services/firebase-phone-auth');
const challengeScorer = require('../services/topochain/challenge-scorer');
const testAccounts = require('../services/test-accounts');
const { drainGuard } = require('../services/lifecycle');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const { applyShellDocumentHeaders, shellAssetCacheControl } = require('../services/static-cache');
const {
  inviteLinkCreateLimiter, inviteRedeemLimiter, invitePreviewLimiter,
} = require('../middleware/rate-limits');

const INDEX_PATH = path.join(__dirname, '..', '..', 'public', 'index.html');

function escapeAttr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The link-preview tags for an invite page: what WhatsApp, iMessage, Slack
 * and the rest show when the link is pasted. A live link's card is the
 * project (Evan, 20 Oct 2026): its name as the title, its one line under it
 * (else the note, else who invited you), and its icon as the thumbnail, the
 * image it has or its emoji drawn on its colour (GET /api/public/invites/
 * :token/icon.png). The note is the message the link is sent in, so the
 * card does not say it again, and the icon is the project's, not
 * Homeroom's mark. A dead or unknown link says only that it is a Homeroom
 * invite, so a pasted link discloses no more than preview() does.
 */
function previewTags(preview, origin, token = null) {
  const live = preview && preview.live;
  const project = live ? preview.project || {} : {};
  const name = live ? project.name : null;
  const title = live ? name : 'Homeroom invite';
  const members = live && preview.memberCount
    ? ` ${preview.memberCount} ${preview.memberCount === 1 ? 'person is' : 'people are'} in it.`
    : '';
  const description = !live
    ? 'This invite link is no longer active.'
    : project.description
      || preview.note
      || `${preview.inviter ? `@${preview.inviter} invited you to ${name}.` : `You are invited to ${name}.`}${members}`;
  const image = !live ? null
    : project.iconUrl
      || (project.iconEmoji && token ? `/api/public/invites/${encodeURIComponent(token)}/icon.png` : null);
  const tags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Homeroom">`,
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${escapeAttr(title)}">`,
    `<meta name="twitter:description" content="${escapeAttr(description)}">`,
  ];
  if (image && origin) {
    tags.push(`<meta property="og:image" content="${escapeAttr(origin + image)}">`);
  }
  return tags.join('\n');
}

/** The shell document with `tags` placed in its head. */
function withPreviewTags(html, tags) {
  const at = html.indexOf('</head>');
  if (at === -1) return html;
  return `${html.slice(0, at)}${tags}\n${html.slice(at)}`;
}

// The origin the page was asked for, for the icon's absolute URL (a preview
// image must be absolute). The Host a request arrives with only shapes the
// answer to that same request, so there is nobody else it could mislead.
function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return /^https?$/.test(proto) && /^[A-Za-z0-9.-]+(?::\d+)?$/.test(host) ? `${proto}://${host}` : null;
}

function communityInviteRoutes(config) {
  const router = Router();
  const pool = getPool(config);
  const appColumns = `${appAccess.ACCESS_COLUMNS}, community_id, name, locked`;

  router.post('/api/apps/:slug/invite-links', drainGuard, inviteLinkCreateLimiter, sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', appColumns);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const made = await invites.createInvite(pool, {
        app, user: req.user, days: req.body?.days, maxUses: req.body?.maxUses, note: req.body?.note,
      });
      if (!made.ok) return res.status(made.status).json({ error: made.error });
      log.info('invites', 'Invite link made', { slug: app.slug, by: req.user.username, id: made.link.id });
      return res.status(201).json({ link: made.link });
    } catch (err) {
      log.error('invites', 'Making an invite link failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/apps/:slug/invite-links', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', appColumns);
      if (!app) return res.status(404).json({ error: 'App not found' });
      const [listed, canCreate, joiningRule] = await Promise.all([
        invites.listInvites(pool, { app, user: req.user }),
        invites.canCreate(pool, app, req.user),
        invites.joiningRule(pool, app, req.user.id),
      ]);
      return res.json({
        links: listed.links,
        manages: listed.manages,
        canCreate,
        grant: invites.grantFor(app),
        defaults: { days: invites.DEFAULT_DAYS, maxUses: invites.DEFAULT_USES },
        limits: invites.LIMITS,
        // WP-D: 0 for days or maxUses asks for no limit (until turned off).
        noLimit: invites.NO_LIMIT,
        joiningRule,
      });
    } catch (err) {
      log.error('invites', 'Listing invite links failed', { slug: req.params.slug, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/api/invite-links/:id', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const done = await invites.revokeInvite(pool, { inviteId: req.params.id, user: req.user });
      if (!done.ok) return res.status(done.status).json({ error: done.error });
      return res.json({ ok: true, cancelled: done.cancelled });
    } catch (err) {
      log.error('invites', 'Turning off an invite link failed', { id: req.params.id, err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // WP-E: a live link opened counts once per PERSON (services/invite-
  // activity.js), never by name: by account when they are signed in, on any
  // device, else by browser (an HttpOnly cookie that names nothing). Only a
  // signed-in open tells the link's maker (#4176): somebody who only clicked
  // it has not shown up yet. A signed-out one is remembered and recorded for
  // the admin Journey, and tells nobody. Counted from the page's own reads
  // below, not from the HTML route a link unfurler fetches.
  const countOpen = (req, res, token, viewerId = null) => {
    const seenBefore = inviteActivity.countedBefore(req, token);
    const browser = inviteActivity.ensureBrowser(req, res);
    void inviteActivity.noteOpened(pool, { token, viewerId, browser, seenBefore });
  };

  // Anonymous: under /api/public/, so authMiddleware never resolves a user
  // here, and the answer is the same whoever asks. Its open is a signed-out
  // one: recorded, never told.
  router.get('/api/public/invites/:token', invitePreviewLimiter, async (req, res) => {
    // Staging's demo link (services/staging-demo-invite.js): its pretend
    // preview, counted as no open. Anywhere else it is an unknown token.
    if (stagingDemoInvite.isDemoInvite(req.params.token)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(stagingDemoInvite.demoInvitePreview());
    }
    try {
      const preview = await invites.preview(pool, req.params.token);
      if (preview.live) countOpen(req, res, req.params.token);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(preview.reason === 'unknown' ? 404 : 200).json(preview);
    } catch (err) {
      log.error('invites', 'Invite preview failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The after-shot a live link's page shows (invites.pictureFor). Anonymous
  // like the preview, and only while the link is live: turning it off turns
  // this off too. Whoever holds the link sees the project before joining it.
  router.get('/api/public/invites/:token/picture', invitePreviewLimiter, async (req, res) => {
    try {
      const picture = invites.isToken(req.params.token)
        ? await invites.pictureBytes(pool, req.params.token)
        : null;
      if (!picture) return res.status(404).json({ error: 'No picture' });
      const data = Buffer.isBuffer(picture.data) ? picture.data : Buffer.from(picture.data || '');
      res.set({
        'Content-Type': picture.contentType,
        'Content-Length': String(data.length),
        'Cache-Control': 'private, max-age=300',
        ETag: `"${picture.sha256}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      });
      return res.end(data);
    } catch (err) {
      log.error('invites', 'Invite picture failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The link preview's thumbnail (previewTags): the project's icon as a PNG
  // a chat app will draw. An image icon is its own file; an emoji is drawn
  // on the project's colour (services/emoji-tile.js). An emoji with no
  // picture there is Homeroom's own icon, as the card showed before.
  router.get('/api/public/invites/:token/icon.png', invitePreviewLimiter, async (req, res) => {
    try {
      const icon = invites.isToken(req.params.token)
        ? await invites.previewIcon(pool, req.params.token)
        : null;
      if (!icon || (!icon.imageId && !icon.emoji)) return res.status(404).json({ error: 'No icon' });
      if (icon.imageId) return res.redirect(302, `/app-icons/${encodeURIComponent(icon.imageId)}`);
      const png = emojiTile.tilePng({ emoji: icon.emoji, color: icon.color });
      if (!png) return res.redirect(302, '/apple-touch-icon.png');
      res.set({
        'Content-Type': 'image/png',
        'Content-Length': String(png.length),
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
      });
      return res.end(png);
    } catch (err) {
      log.error('invites', 'Invite icon failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/invite-links/queued', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      return res.json({ queued: await invites.queuedFor(pool, req.user.id) });
    } catch (err) {
      log.error('invites', 'Reading queued invites failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/api/invite-links/by-token/:token', invitePreviewLimiter, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    // Staging's demo link is never followed: signed in, it is a link that
    // does not work, answered without an error status.
    if (stagingDemoInvite.isDemoInvite(req.params.token)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(stagingDemoInvite.demoInviteDead());
    }
    try {
      // `page` (the project's page, for somebody who may open it before
      // joining) follows the community read's own rule for the platform's
      // own project (routes/apps.js GET /api/apps/:slug/community).
      const standing = await invites.standing(pool, req.params.token, req.user, {
        showSelfHosted: !!req.user.isAdmin || !!config.selfAppPublicVoting,
      });
      // Somebody signed in who is not in it yet (invite-activity.noteOpened
      // leaves out the maker and anybody already a member): the open its
      // maker hears about, and, for the admin Journey's invite funnel, a
      // person with the link in hand signed in: already signed in, unless
      // the sign-in that brought them here recorded it first (#4272).
      if (standing.live && !standing.mine) {
        countOpen(req, res, req.params.token, req.user.id);
        void journeyEvents.noteInviteSignedIn(pool, { token: req.params.token, userId: req.user.id });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(standing.reason === 'unknown' ? 404 : 200).json(standing);
    } catch (err) {
      log.error('invites', 'Invite standing failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Only the Homeroom page itself may follow a link for a signed-in visitor
  // (middleware/same-site-browser.js).
  router.post('/api/invite-links/by-token/:token/redeem', drainGuard, inviteRedeemLimiter, sameOriginBrowserOnly, async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    // Staging's demo link grants nothing (services/staging-demo-invite.js).
    if (stagingDemoInvite.isDemoInvite(req.params.token)) {
      return res.status(410).json({ error: 'This invite link is not active.', reason: 'unknown' });
    }
    try {
      // Signed in with the link in hand, for the admin Journey's invite
      // funnel (#4272). The standing read above records it first, but the
      // waiting room follows a link without reading it
      // (features/auth/waiting.tsx). Before following it, while they are not
      // in it yet; once per person per link, so a sign-in that carried the
      // link stays the sign-in it was. Never throws.
      await journeyEvents.noteInviteSignedIn(pool, { token: req.params.token, userId: req.user.id });
      const result = await invites.redeem(pool, {
        token: req.params.token, user: req.user, browser: inviteActivity.browserFrom(req),
        // A private member signs up with a phone (community-invites.js).
        requirePhone: phoneAuth.offered(config),
      });
      // Following a link clears any copy the sign-in carried: it is spent.
      invites.clearInviteCookie(res);
      if (result.reason === 'username_required') {
        return res.status(409).json({ ...require('../services/usernames').USERNAME_REQUIRED, reason: result.reason });
      }
      if (!result.ok) return res.status(result.status).json({ error: 'This invite link is not active.', reason: result.reason });
      // In the community now, so its challenge counts now (#3564). A queued
      // person is not in it yet; the schedule counts them once let in.
      if (result.status === 'joined') await challengeScorer.scoreOnJoin(pool, config);
      // Whether "You're in" tells them what Homeroom is (App._followInvite).
      // An account following a link signed in had its account before the
      // link, except a test account on its first sign-in: made ahead by an
      // admin, it is as new as the sign-up a link opens (test-accounts.js
      // onFirstRun). Read only for a join, which is when it is shown.
      const newAccount = result.status === 'joined' && await testAccounts.onFirstRun(pool, req.user.id);
      return res.json({ ...result, newAccount });
    } catch (err) {
      log.error('invites', 'Following an invite link failed', { err: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // The page. The shell, as `app.get('*')` serves it, with the link preview
  // in its head for whatever unfurls the link; the shell itself routes the
  // path (App.restoreFromHash). The token rides in an HttpOnly cookie too,
  // so signing up or in from here follows it server-side
  // (communityInvites.redeemCarried, in routes/auth.js).
  router.get('/invite/:token', invitePreviewLimiter, async (req, res, next) => {
    if (!req.accepts('html')) return next();
    const token = req.params.token;
    // Staging's demo link: its pretend preview, and no invite cookie, so a
    // sign-in from its page follows nothing.
    const demo = stagingDemoInvite.isDemoInvite(token);
    try {
      const preview = demo
        ? stagingDemoInvite.demoInvitePreview()
        : invites.isToken(token)
          ? await invites.preview(pool, token)
          : { live: false, reason: 'unknown' };
      if (preview.live && !demo) {
        invites.setInviteCookie(req, res, token);
        // The page's two reads (the preview and, signed in, the standing)
        // may start together: both carry this browser, so it counts once.
        inviteActivity.ensureBrowser(req, res);
      }
      const html = await fs.promises.readFile(INDEX_PATH, 'utf8');
      res.setHeader('Cache-Control', 'no-store');
      applyShellDocumentHeaders(res, INDEX_PATH);
      res.type('html').send(withPreviewTags(html, previewTags(preview, requestOrigin(req), demo ? null : token)));
    } catch (err) {
      log.error('invites', 'Serving an invite page failed', { err: err.message });
      if (!res.headersSent) {
        res.setHeader('Cache-Control', shellAssetCacheControl('index.html'));
        return res.sendFile(INDEX_PATH);
      }
    }
    return undefined;
  });

  return router;
}

module.exports = communityInviteRoutes;
module.exports.previewTags = previewTags;
module.exports.withPreviewTags = withPreviewTags;
module.exports.escapeAttr = escapeAttr;
module.exports.requestOrigin = requestOrigin;
