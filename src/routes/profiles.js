'use strict';

// Opt-in public profiles (issue #582).
//
// Profile content itself is owned by the existing customization routes in
// src/routes/profile.js: users.display_name, users.bio and user_avatars.
// This router adds only publication state, an anonymous allowlisted read,
// reports and moderation. Keeping one content record prevents the private
// editor and public page from drifting apart.

const { Router } = require('express');
const { getPool } = require('../db/pool');
const { adminMiddleware, requireAdminWrite } = require('../middleware/admin');
const {
  publicProfileReadLimiter,
  profileWriteLimiter,
  profileReportLimiter,
} = require('../middleware/rate-limits');
const log = require('../services/logger');
const usernames = require('../services/usernames');

const REPORT_REASONS = new Set([
  'impersonation',
  'harassment',
  'spam',
  'unsafe_avatar',
  'other',
]);
const REPORT_STATUSES = new Set(['pending', 'resolved', 'dismissed']);
const NO_STORE = 'private, no-store, max-age=0';

function textField(value, name, max, { multiline = false } = {}) {
  if (value == null || value === '') return { value: null };
  if (typeof value !== 'string') {
    return { error: `${name} must be a string or null` };
  }
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  const controls = multiline
    ? /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/u
    : /[\u0000-\u001F\u007F-\u009F]/u;
  if (controls.test(normalized)) {
    return { error: `${name} contains unsupported control characters` };
  }
  if (Array.from(normalized).length > max) {
    return { error: `${name} must be at most ${max} characters` };
  }
  return { value: normalized || null };
}

function profileUsername(value) {
  const username = String(value || '');
  if (!username || username.length > 255 || /[\u0000-\u001F\u007F]/u.test(username)) {
    return null;
  }
  return username;
}

function publicShape(row) {
  return {
    username: row.username,
    displayName: row.display_name || null,
    bio: row.bio || null,
    avatarUrl: row.avatar_id ? `/avatars/${row.avatar_id}` : null,
    url: `/#profile/${encodeURIComponent(row.username)}`,
  };
}

async function readOwnerProfile(db, userId) {
  const { rows } = await db.query(
    `SELECT u.username, u.display_name, u.bio, u.profile_published,
            u.profile_disabled_at, av.id AS avatar_id
       FROM users u
       LEFT JOIN user_avatars av ON av.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  return rows[0] || null;
}

function ownerShape(row) {
  return {
    profile: publicShape(row),
    published: !!row.profile_published,
    moderationDisabled: !!row.profile_disabled_at,
  };
}

function publicProfileRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  const requireUser = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    return next();
  };

  // Exact lookup only: there is deliberately no profile directory or search
  // endpoint. Missing, unpublished and moderation-disabled profiles return
  // the same response so this surface cannot reveal hidden account state.
  router.get(
    '/api/public/profiles/:username',
    publicProfileReadLimiter,
    async (req, res) => {
      res.set('Cache-Control', NO_STORE);
      const username = profileUsername(req.params.username);
      if (!username) return res.status(404).json({ error: 'Profile not found' });
      try {
        // Resolved through the retired-handle ledger (#1336) so a profile
        // link shared before the owner renamed still lands. `moved` carries
        // the canonical handle and the client rewrites its address; the body
        // is the SAME shape either way, so an old link renders the profile
        // rather than bouncing the reader through a 404 first.
        //
        // Still no 301: this is a JSON API read, and a redirect status would
        // have every caller's fetch() follow it opaquely instead of learning
        // the new handle. Deliberately NOT gated on profile_published — the
        // resolve only maps a name to a person; the publish/disable checks
        // below are what decide whether anything comes back.
        const resolved = await usernames.resolveHandle(pool, username);
        if (!resolved) {
          return res.status(404).json({ error: 'Profile not found' });
        }
        const { rows } = await pool.query(
          `SELECT u.username, u.display_name, u.bio, av.id AS avatar_id
             FROM users u
             LEFT JOIN user_avatars av ON av.user_id = u.id
            WHERE u.id = $1
              AND u.profile_published = TRUE
              AND u.profile_disabled_at IS NULL`,
          [resolved.userId]
        );
        if (!rows.length) {
          return res.status(404).json({ error: 'Profile not found' });
        }
        return res.json({
          profile: publicShape(rows[0]),
          ...(resolved.retired ? { moved: { from: username, to: resolved.username } } : {}),
        });
      } catch (err) {
        log.error('profiles', 'Public profile read failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // Owner state is separate from PATCH /api/me/profile: that existing route
  // remains the single writer for display name and bio, and /api/me/avatar
  // remains the single writer for image bytes.
  router.get('/api/me/public-profile', requireUser, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    try {
      const row = await readOwnerProfile(pool, req.user.id);
      if (!row) return res.status(404).json({ error: 'User not found' });
      return res.json(ownerShape(row));
    } catch (err) {
      log.error('profiles', 'Owner public-profile read failed', {
        userId: req.user.id,
        message: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch(
    '/api/me/public-profile',
    requireUser,
    profileWriteLimiter,
    async (req, res) => {
      res.set('Cache-Control', NO_STORE);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : null;
      if (!body
          || Object.keys(body).length !== 1
          || typeof body.published !== 'boolean') {
        return res.status(400).json({ error: 'Expected only published as a boolean' });
      }
      try {
        const { rowCount } = await pool.query(
          `UPDATE users
              SET profile_published = $1, profile_updated_at = NOW()
            WHERE id = $2`,
          [body.published, req.user.id]
        );
        if (!rowCount) return res.status(404).json({ error: 'User not found' });
        const row = await readOwnerProfile(pool, req.user.id);
        log.info('profiles', 'Public profile publication changed', {
          userId: req.user.id,
          published: body.published,
        });
        return res.json(ownerShape(row));
      } catch (err) {
        log.error('profiles', 'Public profile publication failed', {
          userId: req.user.id,
          message: err.message,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.post(
    '/api/profiles/:username/report',
    requireUser,
    profileReportLimiter,
    async (req, res) => {
      res.set('Cache-Control', NO_STORE);
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
      if (!REPORT_REASONS.has(reason)) {
        return res.status(400).json({ error: 'Invalid report reason' });
      }
      const detail = textField(req.body?.detail, 'detail', 500, { multiline: true });
      if (detail.error) return res.status(400).json({ error: detail.error });
      const username = profileUsername(req.params.username);
      if (!username) return res.status(202).json({ ok: true });
      if (username === req.user.username) {
        return res.status(400).json({ error: 'You cannot report your own profile' });
      }

      let client;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        // FOR UPDATE is intentional. FOR KEY SHARE (used by the original
        // proposal) does not conflict with a non-key moderation UPDATE, so a
        // report could otherwise be inserted immediately after takedown and
        // remain pending forever. Both paths now lock this user row.
        const { rows } = await client.query(
          `SELECT id FROM users
            WHERE username = $1
              AND profile_published = TRUE
              AND profile_disabled_at IS NULL
            FOR UPDATE`,
          [username]
        );
        if (rows.length) {
          await client.query(
            `INSERT INTO profile_reports
               (profile_user_id, reporter_user_id, reason, detail)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (profile_user_id, reporter_user_id)
               WHERE status = 'pending'
             DO NOTHING`,
            [rows[0].id, req.user.id, reason, detail.value]
          );
        }
        await client.query('COMMIT');
        // Generic for missing, unpublished, disabled and duplicate targets.
        return res.status(202).json({ ok: true });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        log.error('profiles', 'Profile report failed', {
          userId: req.user.id,
          message: err.message,
        });
        return res.status(500).json({ error: 'Internal server error' });
      } finally {
        if (client) client.release();
      }
    }
  );

  router.get('/api/admin/profile-reports', adminMiddleware, async (req, res) => {
    res.set('Cache-Control', NO_STORE);
    const status = REPORT_STATUSES.has(req.query.status)
      ? req.query.status
      : 'pending';
    try {
      const { rows } = await pool.query(
        `SELECT pr.id, pr.reason, pr.detail, pr.status, pr.created_at,
                pr.resolved_at, target.username AS profile_username,
                reporter.username AS reporter_username,
                resolver.username AS resolved_by_username
           FROM profile_reports pr
           JOIN users target ON target.id = pr.profile_user_id
           JOIN users reporter ON reporter.id = pr.reporter_user_id
           LEFT JOIN users resolver ON resolver.id = pr.resolved_by
          WHERE pr.status = $1
          ORDER BY pr.created_at ASC, pr.id ASC
          LIMIT 200`,
        [status]
      );
      return res.json({ reports: rows });
    } catch (err) {
      log.error('profiles', 'Profile reports list failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // False-positive reports need a terminal path too; the original proposal
  // defined the dismissed state but provided no route that could reach it.
  router.post(
    '/api/admin/profile-reports/:id/dismiss',
    adminMiddleware,
    requireAdminWrite,
    async (req, res) => {
      res.set('Cache-Control', NO_STORE);
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid report id' });
      }
      try {
        const { rows } = await pool.query(
          `UPDATE profile_reports
              SET status = 'dismissed', resolved_at = NOW(), resolved_by = $1
            WHERE id = $2 AND status = 'pending'
            RETURNING id, status`,
          [req.user.id, id]
        );
        if (!rows.length) {
          return res.status(404).json({ error: 'Pending report not found' });
        }
        return res.json({ report: rows[0] });
      } catch (err) {
        log.error('profiles', 'Profile report dismissal failed', {
          reportId: id,
          message: err.message,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  router.post(
    '/api/admin/profiles/:username/moderation',
    adminMiddleware,
    requireAdminWrite,
    async (req, res) => {
      res.set('Cache-Control', NO_STORE);
      if (typeof req.body?.disabled !== 'boolean') {
        return res.status(400).json({ error: 'disabled must be a boolean' });
      }
      const reason = textField(req.body?.reason, 'reason', 240);
      if (reason.error || (req.body.disabled && !reason.value)) {
        return res.status(400).json({
          error: reason.error || 'reason is required when disabling a profile',
        });
      }
      const username = profileUsername(req.params.username);
      if (!username) return res.status(404).json({ error: 'User not found' });

      let client;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        const { rows } = await client.query(
          'SELECT id, username FROM users WHERE username = $1 FOR UPDATE',
          [username]
        );
        if (!rows.length) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'User not found' });
        }
        const target = rows[0];
        await client.query(
          `UPDATE users
              SET profile_disabled_at = CASE WHEN $1::boolean THEN NOW() ELSE NULL END,
                  profile_disabled_by = CASE WHEN $1::boolean THEN $2::integer ELSE NULL END,
                  profile_disabled_reason = CASE WHEN $1::boolean THEN $3::text ELSE NULL END,
                  profile_updated_at = NOW()
            WHERE id = $4::integer`,
          [req.body.disabled, req.user.id, reason.value, target.id]
        );
        if (req.body.disabled) {
          await client.query(
            `UPDATE profile_reports
                SET status = 'resolved', resolved_at = NOW(), resolved_by = $1
              WHERE profile_user_id = $2 AND status = 'pending'`,
            [req.user.id, target.id]
          );
        }
        await client.query('COMMIT');
        log.info('profiles', 'Profile moderation changed', {
          username: target.username,
          disabled: req.body.disabled,
          by: req.user.username,
        });
        return res.json({
          ok: true,
          username: target.username,
          disabled: req.body.disabled,
        });
      } catch (err) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        log.error('profiles', 'Profile moderation failed', { message: err.message });
        return res.status(500).json({ error: 'Internal server error' });
      } finally {
        if (client) client.release();
      }
    }
  );

  return router;
}

module.exports = {
  publicProfileRoutes,
  publicShape,
  ownerShape,
  textField,
  profileUsername,
};
