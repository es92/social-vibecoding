'use strict';

// Profile customization (issue #982) — the write half of the #profile
// screen plus the read that backs its "Completed challenges" section.
//
//   PATCH  /api/me/profile             display name / bio / github / x
//   POST   /api/me/username            change the @handle (#1336)
//   POST   /api/me/avatar              raw image bytes -> user_avatars
//   DELETE /api/me/avatar              remove the picture
//   GET    /api/me/challenges/completed  the viewer's OWN completions
//
// Every route is me-scoped and 401s without a session, so this router is
// mounted AFTER authMiddleware in server.js. The public read side of an
// avatar is a separate, deliberately unauthenticated router
// (src/routes/avatars.js) — an <img> can't carry a session dance.
//
// ── The username change (#1336) ───────────────────────────────────────
//
// This header used to say a username change was impossible anywhere on
// the platform. It is now POST /api/me/username, and what changed is not
// the constraint — it is that the constraint has somewhere to live.
//
// `users.username` is still the login identifier, still the address of
// the public builder page (#leaderboard/users/<username>), still the
// resolution key for the seeded service identities, and still
// denormalized into `apps.admin_usernames` from repo dapp.json files the
// platform cannot rewrite. Releasing a handle re-points every one of
// those at the next person to register it. So a rename does not release
// it: src/services/usernames.js retires the old handle into
// `username_history` permanently and every handle-keyed resolver reads
// through that ledger. See the block comment on the table in schema.sql.
//
// PATCH /api/me/profile above still does NOT write `username`, and must
// not: the rename needs the current password, a cooldown and a ledger
// write in one transaction, none of which belong in a partial field
// update that also accepts a bio. Two endpoints, two contracts.
//
// Admin-initiated renames remain unimplemented —
// routes/topochain/admin/users.js still restricts its writable set to
// email/telegram/discord/display_name/accept_logs, and moving someone
// else's handle is a moderation action with its own audit needs.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const express = require('express');
const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const { sniffImageType } = require('../services/attachments');
const { profileWriteLimiter, usernameChangeLimiter } = require('../middleware/rate-limits');
const usernames = require('../services/usernames');
const {
  buildChallengeRow,
  DONE_EXPR,
  MY_COUNT_SQL,
  MY_BLOCKS_SQL,
  ALL_CHALLENGE_WHERE,
} = require('./home-panels');
const { TEMPLATE_JOIN_COLUMNS_SQL } = require('./topochain/challenge-view');

// ─── Field limits ──────────────────────────────────────────────────────
//
// `display_name` is VARCHAR(255) in the schema (it predates this feature —
// the topochain merge added it). 40 is the LAYOUT budget, not the storage
// one: the same string renders in the standings row and the profile header,
// and neither truncates at 40 on a phone.
const MAX_DISPLAY_NAME = 40;
const MAX_BIO = 280;
// One leading '@' is stripped before this runs. Deliberately permissive
// enough for both GitHub and X handle rules without trying to be either
// vendor's exact validator — a handle that doesn't exist upstream is a
// dead link, not a security problem.
const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;

// Avatar bytes. The express.raw() limit below must sit ABOVE this so an
// over-size body gets the friendly 400 from validateAvatarUpload rather
// than the parser's opaque 413 — same reasoning as the feedback-screenshot
// route. GIF is rejected on purpose: nothing here decodes frames, and an
// animated avatar is not wanted on a shared surface.
const MAX_AVATAR_BYTES = 1024 * 1024;
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// How many completed challenges the profile section renders. Production's
// whole Season 1 is 34 enabled challenges, so this never bites today; it
// exists so a season that accumulates hundreds can't turn one screen into
// an unbounded response.
const COMPLETED_LIMIT = 60;

// Pure (exported for tests): validate an uploaded avatar body.
// Returns { ok: true, contentType } or { ok: false, error }.
function validateAvatarUpload(data) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    return { ok: false, error: 'Empty upload' };
  }
  if (data.length > MAX_AVATAR_BYTES) {
    return {
      ok: false,
      error: `Image too large (max ${Math.round(MAX_AVATAR_BYTES / 1024)} KB) — try a smaller photo`,
    };
  }
  const contentType = sniffImageType(data);
  if (!AVATAR_TYPES.has(contentType)) {
    return { ok: false, error: 'Profile picture must be a PNG, JPEG or WebP image' };
  }
  return { ok: true, contentType };
}

// Pure (exported for tests): normalize + validate the PATCH body.
// Only keys PRESENT in the body are returned in `fields`, so a partial
// update never blanks a field the client didn't send. An empty string is
// an explicit "clear this" and maps to NULL.
//
// Returns { fields: { column: value }, details: { field: [msg] } }.
// A non-empty `details` means reject the whole request — nothing is saved
// partially, which is what lets the sheet show errors inline and keep the
// user's other edits in the form.
function parseProfileFields(body) {
  const fields = {};
  const details = {};
  const src = (body && typeof body === 'object') ? body : {};

  if ('displayName' in src) {
    const raw = src.displayName;
    if (raw !== null && typeof raw !== 'string') {
      details.displayName = ['Display name must be text.'];
    } else {
      const value = String(raw ?? '').trim();
      if (/[\r\n]/.test(value)) {
        details.displayName = ['Display name cannot contain line breaks.'];
      } else if (value.length > MAX_DISPLAY_NAME) {
        details.displayName = [`Display name must be ${MAX_DISPLAY_NAME} characters or fewer.`];
      } else {
        fields.display_name = value === '' ? null : value;
      }
    }
  }

  if ('bio' in src) {
    const raw = src.bio;
    if (raw !== null && typeof raw !== 'string') {
      details.bio = ['Bio must be text.'];
    } else {
      const value = String(raw ?? '').trim();
      if (value.length > MAX_BIO) {
        details.bio = [`Bio must be ${MAX_BIO} characters or fewer.`];
      } else {
        fields.bio = value === '' ? null : value;
      }
    }
  }

  for (const key of ['github', 'x']) {
    if (!(key in src)) continue;
    const raw = src[key];
    if (raw !== null && typeof raw !== 'string') {
      details[key] = ['Handle must be text.'];
      continue;
    }
    // Strip ONE leading '@' — people paste "@octocat" out of habit.
    const value = String(raw ?? '').trim().replace(/^@/, '');
    if (value === '') {
      fields[key] = null;
    } else if (!HANDLE_RE.test(value)) {
      details[key] = ['That doesn’t look like a valid handle.'];
    } else {
      fields[key] = value;
    }
  }

  return { fields, details };
}

// The profile object echoed by PATCH and embedded in GET /api/auth/me, so
// both surfaces speak one shape and the client can swap `App.user` wholesale.
function shapeProfile(row) {
  return {
    displayName: row?.display_name ?? null,
    bio: row?.bio ?? null,
    avatarUrl: row?.avatar_id ? `/avatars/${row.avatar_id}` : null,
    links: {
      github: row?.github ?? null,
      x: row?.x ?? null,
    },
  };
}

// The season the profile's completed list is scoped to.
//
// DELIBERATELY NOT home-panels' fetchCurrentSeason: that one additionally
// requires `starts_at <= NOW() AND ends_at >= NOW()`, which is right for a
// "what's open right now" widget and wrong here. Production's only season
// (Season 1, is_active = TRUE) ended 2026-06-30, so the strict resolver
// returns null and every profile would show an empty list of completions
// people genuinely earned. This mirrors what the profile screen itself has
// always done client-side: the active season, else the newest one.
//
// AN ACTIVE SEASON WITH NO CHALLENGES IS NOT AN ANSWER (#982). "Newest
// active" alone empties every profile the moment an organiser opens the
// NEXT season, because a season is created before its challenges are:
// production has both Season 1 (58 challenges, ended, still is_active) and
// Pre Season 2 (is_active, zero challenges), so the plain resolver picks
// the empty one and the completions people earned in Season 1 vanish from
// their profile until Season 2's challenges land. So prefer the newest
// active season that has at least one in-scope challenge — the same scope
// the list itself uses (ALL_CHALLENGE_WHERE: a public event, challenge
// organiser-enabled) — and only then fall back to newest-active and
// newest-of-all. Each step is strictly more forgiving than the last, so a
// deployment whose seasons all carry challenges resolves exactly as before.
async function fetchProfileSeason(pool, preferredSeasonId = null) {
  // A staging clone can carry a newer production season than the synthetic
  // 900500 catalogue whose challenge activity migrate.js seeds for the
  // capture identities. Prefer that fixture only when the caller asks for
  // it; production keeps the ordinary latest-active/latest-season rule.
  if (preferredSeasonId != null) {
    const { rows: preferred } = await pool.query(
      `SELECT id, name FROM seasons
        WHERE id = $1 AND internal = FALSE
        LIMIT 1`,
      [preferredSeasonId]
    );
    if (preferred[0]) return preferred[0];
  }
  const { rows: stocked } = await pool.query(
    `SELECT s.id, s.name FROM seasons s
      WHERE s.internal = FALSE AND s.is_active = TRUE
        AND EXISTS (
              SELECT 1 FROM season_events se
                JOIN challenges c ON c.season_event_id = se.id
               WHERE se.season_id = s.id
                 AND se.internal = FALSE AND c.enabled = TRUE
            )
      ORDER BY s.starts_at DESC, s.id DESC LIMIT 1`
  );
  if (stocked[0]) return stocked[0];

  const { rows } = await pool.query(
    `SELECT id, name FROM seasons
      WHERE internal = FALSE AND is_active = TRUE
      ORDER BY starts_at DESC, id DESC LIMIT 1`
  );
  if (rows[0]) return rows[0];
  const { rows: fallback } = await pool.query(
    `SELECT id, name FROM seasons
      WHERE internal = FALSE
      ORDER BY starts_at DESC, id DESC LIMIT 1`
  );
  return fallback[0] || null;
}

function profileRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Shared me-scope gate. These routes are mounted after authMiddleware,
  // which already redirects/401s an anonymous browser — this is the
  // belt-and-braces check every other /api/me/* route also carries.
  const requireUser = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    return next();
  };

  // Re-read the columns the client renders, in one statement, so PATCH and
  // the avatar writes can all echo the post-write truth rather than
  // reconstructing it from the request.
  async function readProfile(userId) {
    const { rows } = await pool.query(
      `SELECT u.display_name, u.bio, u.github, u.x, av.id AS avatar_id
         FROM users u
         LEFT JOIN user_avatars av ON av.user_id = u.id
        WHERE u.id = $1`,
      [userId]
    );
    return shapeProfile(rows[0]);
  }

  // ── PATCH /api/me/profile ────────────────────────────────────────────
  router.patch(
    '/api/me/profile',
    requireUser,
    profileWriteLimiter,
    express.json({ limit: '16kb' }),
    async (req, res) => {
      const { fields, details } = parseProfileFields(req.body);
      if (Object.keys(details).length) {
        return res.status(400).json({ error: 'Some fields need fixing', details });
      }
      const columns = Object.keys(fields);
      if (!columns.length) {
        // Nothing to write (an empty body, or only unknown keys) — not an
        // error; echo current state so the client repaints identically.
        return res.json({ profile: await readProfile(req.user.id) });
      }
      try {
        const setClauses = columns.map((col, i) => `${col} = $${i + 2}`);
        await pool.query(
          `UPDATE users SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1`,
          [req.user.id, ...columns.map((col) => fields[col])]
        );
        log.info('profile', 'Profile updated', {
          userId: req.user.id, fields: columns,
        });
        return res.json({ profile: await readProfile(req.user.id) });
      } catch (err) {
        log.error('profile', 'Profile update failed', {
          userId: req.user.id, err: err.message,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // ── POST /api/me/username ────────────────────────────────────────────
  //
  // Body: { username, currentPassword }. Separate from PATCH /api/me/profile
  // on purpose — see the header. The step order below is a security order,
  // not a readability one:
  //
  //   1. shape         — pure, leaks nothing, costs nothing
  //   2. password      — BEFORE any availability answer, so a stolen session
  //                      without the password cannot walk the namespace
  //                      asking "is @x free?"
  //   3. service ident — a seeded identity may never move
  //   4. cooldown      — before availability for the same reason: a user in
  //                      cooldown gets no probes either
  //   5. availability  — live table AND retired ledger
  //   6. rename        — one transaction
  router.post(
    '/api/me/username',
    requireUser,
    usernameChangeLimiter,
    express.json({ limit: '4kb' }),
    async (req, res) => {
      const { username: requested, currentPassword } = req.body || {};

      const check = usernames.validateUsername(requested);
      if (!check.ok) return res.status(400).json({ error: check.error });
      const next = check.value;

      if (!currentPassword || typeof currentPassword !== 'string') {
        return res.status(400).json({ error: 'Current password is required' });
      }

      try {
        const { rows } = await pool.query(
          'SELECT username, password FROM users WHERE id = $1',
          [req.user.id]
        );
        if (!rows.length) return res.status(404).json({ error: 'User not found' });
        const { username: current, password: hash } = rows[0];

        const valid = await bcrypt.compare(currentPassword, hash);
        if (!valid) {
          return res.status(401).json({ error: 'Current password is incorrect' });
        }

        // Seeded service accounts (usernode-capture and friends) are found
        // BY NAME at runtime, so renaming one breaks a subsystem rather than
        // moving an identity. src/services/visuals.js is the caller that
        // would fail first.
        if (usernames.isServiceIdentity(current)) {
          return res.status(403).json({ error: 'This account cannot be renamed.' });
        }

        // An exact no-op is a success, not an error — the sheet resubmitting
        // an unchanged field should not read as a failure. A CASE-ONLY change
        // falls through: renameUser treats it as a re-case, which retires
        // nothing and burns no cooldown.
        if (current === next) {
          return res.json({ username: current, retired: null, unchanged: true });
        }
        const recase = current.toLowerCase() === next.toLowerCase();

        if (!recase) {
          const cooldown = await usernames.checkCooldown(pool, req.user.id);
          if (!cooldown.ok) {
            return res.status(429).json({ error: cooldown.error, retryAfter: cooldown.retryAfter });
          }
        }

        const free = await usernames.checkAvailability(pool, next, req.user.id);
        if (!free.available) {
          return res.status(409).json({ error: free.error });
        }

        const result = await usernames.renameUser(pool, req.user.id, next);
        if (!result) return res.status(404).json({ error: 'User not found' });

        log.info('profile', 'Username changed', {
          userId: req.user.id, from: current, to: result.username, recase,
        });
        if (!recase) {
          try {
            const events = require('../services/events');
            events.record(pool, {
              type: events.EVENT_TYPES.USERNAME_CHANGED,
              userId: req.user.id,
              metadata: { from: current, to: result.username },
            });
          } catch (err) {
            log.warn('profile', 'Username event record failed', { err: err.message });
          }
        }

        return res.json({ username: result.username, retired: result.retired });
      } catch (err) {
        // The unique indexes on users.username and username_history are the
        // backstop behind the availability check above; a race between two
        // people claiming the same handle lands here.
        if (err.code === '23505') {
          return res.status(409).json({ error: 'That username is taken.' });
        }
        log.error('profile', 'Username change failed', {
          userId: req.user.id, err: err.message,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // ── POST /api/me/avatar ──────────────────────────────────────────────
  // Raw bytes (application/octet-stream) — deliberately sidesteps the
  // global express.json() parser, same reasoning as the feedback
  // screenshot and dev-chat attachment uploads. The 2mb parser ceiling
  // sits above the 1 MB cap so an over-size body reaches
  // validateAvatarUpload and gets a sentence a human can act on.
  router.post(
    '/api/me/avatar',
    requireUser,
    profileWriteLimiter,
    express.raw({ type: 'application/octet-stream', limit: '2mb' }),
    async (req, res) => {
      try {
        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const verdict = validateAvatarUpload(data);
        if (!verdict.ok) return res.status(400).json({ error: verdict.error });

        // Fresh id per upload: the URL is content-addressed and served
        // with a year-long immutable header, so replacing the bytes MUST
        // replace the id or every cache keeps the old picture forever.
        const id = crypto.randomBytes(16).toString('hex');
        const sha256 = crypto.createHash('sha256').update(data).digest('hex');
        await pool.query(
          `INSERT INTO user_avatars (id, user_id, content_type, size_bytes, data, sha256)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id) DO UPDATE
             SET id = EXCLUDED.id,
                 content_type = EXCLUDED.content_type,
                 size_bytes = EXCLUDED.size_bytes,
                 data = EXCLUDED.data,
                 sha256 = EXCLUDED.sha256,
                 created_at = NOW()`,
          [id, req.user.id, verdict.contentType, data.length, data, sha256]
        );
        log.info('profile', 'Avatar uploaded', {
          userId: req.user.id, bytes: data.length, contentType: verdict.contentType,
        });
        return res.json({ avatarUrl: `/avatars/${id}` });
      } catch (err) {
        log.error('profile', 'Avatar upload failed', {
          userId: req.user.id, err: err.message,
        });
        return res.status(500).json({ error: 'Upload failed' });
      }
    }
  );

  // ── DELETE /api/me/avatar ────────────────────────────────────────────
  // Idempotent: deleting when there is nothing to delete is a 200, not a
  // 404 — the client's "Remove photo" should never fail for a user who
  // double-tapped it.
  router.delete(
    '/api/me/avatar',
    requireUser,
    profileWriteLimiter,
    async (req, res) => {
      try {
        await pool.query('DELETE FROM user_avatars WHERE user_id = $1', [req.user.id]);
        log.info('profile', 'Avatar removed', { userId: req.user.id });
        return res.json({ avatarUrl: null });
      } catch (err) {
        log.error('profile', 'Avatar delete failed', {
          userId: req.user.id, err: err.message,
        });
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
  );

  // ── GET /api/me/challenges/completed ─────────────────────────────────
  //
  // The challenges the VIEWER completed — not the ones an organiser marked
  // finished. `challenges.completed` is an organiser flag about the
  // challenge ("this one is over"); the profile screen used to filter on it
  // client-side, which is why every signed-in person saw 28 of production's
  // 34 live challenges listed as their own completions.
  //
  // Done-ness comes from DONE_EXPR — the same rule the home Challenges
  // widget uses — so a numeric challenge at 3 of 8 is correctly NOT done.
  // Scope is ALL_CHALLENGE_WHERE (organiser-finished and out-of-window
  // challenges included): a challenge that is over and that you completed
  // is exactly what belongs in this list.
  router.get('/api/me/challenges/completed', requireUser, async (req, res) => {
    try {
      const season = await fetchProfileSeason(
        pool,
        process.env.USERNODE_ENV === 'staging' ? 900500 : null
      );
      if (!season) {
        return res.json({ season: null, total: 0, done: 0, completed: [] });
      }

      const { rows } = await pool.query(
        `SELECT c.id, c.season_event_id, c.goal, c.task, c.reward,
                c.schedule_start, c.schedule_end,
                c.cta_label, c.cta_link,
                c.metric_type, c.metric_target, c.metric_label,
                c.enabled, c.completed, c.display_order, c.featured, c.featured_order,
                se.name AS event_name,
                ${TEMPLATE_JOIN_COLUMNS_SQL},
                ${MY_COUNT_SQL} AS my_activity_count,
                (SELECT COALESCE(SUM(ua.points), 0) FROM user_activities ua
                  WHERE ua.user_id = $1 AND ua.challenge_id = c.id) AS my_points,
                (SELECT MAX(ua.activity_at) FROM user_activities ua
                  WHERE ua.user_id = $1 AND ua.challenge_id = c.id) AS my_last_activity_at,
                ${MY_BLOCKS_SQL} AS my_blocks,
                ${DONE_EXPR} AS my_done
           FROM challenges c
           JOIN season_events se ON se.id = c.season_event_id
           LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
          WHERE se.season_id = $2 AND ${ALL_CHALLENGE_WHERE} AND (${DONE_EXPR})
          ORDER BY my_last_activity_at DESC NULLS LAST, c.id DESC
          LIMIT $3`,
        [req.user.id, season.id, COMPLETED_LIMIT + 1]
      );

      // Totals over the WHOLE in-scope set so the header's "N of M done"
      // is honest even when the row list is capped.
      const { rows: totalRows } = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE ${DONE_EXPR})::int AS done
           FROM challenges c
           JOIN season_events se ON se.id = c.season_event_id
           LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
          WHERE se.season_id = $2 AND ${ALL_CHALLENGE_WHERE}`,
        [req.user.id, season.id]
      );

      const truncated = rows.length > COMPLETED_LIMIT;
      if (truncated) {
        // Never silently drop rows — a capped list that reads as complete
        // is worse than a shorter one that says so.
        log.info('profile', 'Completed-challenge list truncated', {
          userId: req.user.id, seasonId: season.id, limit: COMPLETED_LIMIT,
        });
      }

      // A challenge whose template row vanished is skipped rather than
      // 500ing the section — the same guard the panel and public.js apply.
      const completed = rows
        .slice(0, COMPLETED_LIMIT)
        .filter((r) => r.t_id != null)
        .map((r) => ({
          ...buildChallengeRow(r),
          season_event_id: Number(r.season_event_id),
          event_name: r.event_name || null,
          activity_count: Number(r.my_activity_count) || 0,
          last_activity_at: r.my_last_activity_at
            ? new Date(r.my_last_activity_at).toISOString()
            : null,
        }));

      return res.json({
        season: { id: Number(season.id), name: season.name },
        total: totalRows[0]?.total ?? 0,
        done: totalRows[0]?.done ?? completed.length,
        completed,
        ...(truncated ? { truncated: true } : {}),
      });
    } catch (err) {
      log.error('profile', 'Completed-challenge read failed', {
        userId: req.user.id, err: err.message,
      });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = {
  profileRoutes,
  // Exported for tests.
  validateAvatarUpload,
  parseProfileFields,
  shapeProfile,
  fetchProfileSeason,
  MAX_DISPLAY_NAME,
  MAX_BIO,
  MAX_AVATAR_BYTES,
  COMPLETED_LIMIT,
};
