// Topochain v4 admin API — D3 user-activities (SPEC 2407-2532, v1
// `/admin/activities`; Task 11). Every mutating route is gated by
// `adminWriteGate`; reads are covered by the router-wide `adminReadGate`
// applied in ../admin.js.
//
// ⚠ ROUTE-SHADOWING FIX (SPEC 883-895 rule 7, 2197's note): the source's
// `GET /activities/totals` 404s because Laravel's resource routes
// (`GET /activities/{activity}`) are registered first and swallow it —
// `{activity}` happily binds to the literal string "totals". Below,
// `/totals` and `/import` are BOTH registered before `/:id` for exactly
// this reason (`/import` isn't itself ambiguous — it's POST-only and
// there's no POST `/:id` route — but keeping it alongside `/totals`,
// ahead of every `/:id` route, keeps this file's ordering simple to
// audit at a glance rather than relying on the HTTP method to save it).
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { adminWriteGate } = require('./auth');
const { toIntId, toDate } = require('./util');
const { computeOffchainColumns, resolveOffchainWeight } = require('../../../services/topochain/scoring');
const {
  ok, fail, iso, num, paginate, meta, ValidationError,
} = require('../helpers');

// ─── Allowed activity_type values (SPEC 2409) ──────────────────────────
//
// "The three legacy constants plus every distinct activity-type
// category" — the legacy three are fixed; the category set is dynamic
// (challenge_templates.category), so this re-queries it rather than
// caching, since an admin can add a new template/category at any time
// (Task 12) and this list must stay current.
const LEGACY_ACTIVITY_TYPES = ['bug_report', 'inviting_new_participant', 'community_contribution'];

async function allowedActivityTypes(queryable) {
  const { rows } = await queryable.query('SELECT DISTINCT category FROM challenge_templates');
  return new Set([...LEGACY_ACTIVITY_TYPES, ...rows.map((r) => r.category)]);
}

// ─── Row shaping ────────────────────────────────────────────────────────
//
// One SELECT (and one row shape) reused by list/show/create/update:
// SPEC only requires user+event+added_by_user on list/show and
// user+event+challenge on create/update, but returning all four
// projections everywhere is a strict superset — no caller loses a field
// it expected, and it avoids maintaining two parallel row shapes for
// what is, underneath, the exact same query.
const ACTIVITY_SELECT = `
  SELECT ua.*,
         u.email AS u_email, u.telegram AS u_telegram, u.discord AS u_discord, u.display_name AS u_display_name,
         se.name AS event_name,
         ab.username AS added_by_username,
         c.id AS c_id, ct.category AS c_category, ct.goal AS c_goal, ct.task AS c_task
    FROM user_activities ua
    JOIN users u ON u.id = ua.user_id
    JOIN season_events se ON se.id = ua.season_event_id
    LEFT JOIN users ab ON ab.id = ua.added_by
    LEFT JOIN challenges c ON c.id = ua.challenge_id
    LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
`;

function formatActivityRow(r) {
  return {
    id: Number(r.id),
    user_id: Number(r.user_id),
    season_event_id: Number(r.season_event_id),
    challenge_id: r.challenge_id != null ? Number(r.challenge_id) : null,
    activity_type: r.activity_type,
    points: num(r.points) ?? 0,
    description: r.description,
    metadata: r.metadata,
    activity_at: iso(r.activity_at),
    added_by: r.added_by != null ? Number(r.added_by) : null,
    source: r.source,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    user: {
      id: Number(r.user_id), email: r.u_email, telegram: r.u_telegram, discord: r.u_discord, display_name: r.u_display_name,
    },
    event: { id: Number(r.season_event_id), name: r.event_name },
    added_by_user: r.added_by != null ? { id: Number(r.added_by), name: r.added_by_username } : null,
    challenge: r.c_id != null ? {
      id: Number(r.c_id), category: r.c_category, goal: r.c_goal, task: r.c_task,
    } : null,
  };
}

// Fetches a challenge + its template category, used by create/update/
// import to check "does this challenge belong to this event" and to
// resolve the stored activity_type.
async function loadChallenge(queryable, challengeId) {
  const { rows } = await queryable.query(
    `SELECT c.id, c.season_event_id, ct.category
       FROM challenges c LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id
      WHERE c.id = $1`,
    [challengeId]
  );
  return rows[0] || null;
}

function userActivitiesAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/user-activities (SPEC 2413-2419) ───────────────
  router.get('/api/v4/admin/user-activities', async (req, res) => {
    try {
      const { page, perPage } = paginate(req, { defaultPerPage: 20 });
      const seasonEventId = toIntId(req.query.season_event_id);
      const userId = toIntId(req.query.user_id);
      const activityType = typeof req.query.activity_type === 'string' ? req.query.activity_type : null;

      const clauses = [];
      const params = [];
      if (seasonEventId) { params.push(seasonEventId); clauses.push(`ua.season_event_id = $${params.length}`); }
      if (userId) { params.push(userId); clauses.push(`ua.user_id = $${params.length}`); }
      if (activityType) { params.push(activityType); clauses.push(`ua.activity_type = $${params.length}`); }
      const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM user_activities ua ${whereClause}`, params
      );
      const total = countRows[0].c;

      const dataParams = [...params, perPage, (page - 1) * perPage];
      const { rows } = await pool.query(
        `${ACTIVITY_SELECT} ${whereClause}
          ORDER BY ua.activity_at DESC, ua.id DESC
          LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
        dataParams
      );

      return ok(res, { data: rows.map(formatActivityRow) }, { meta: meta(page, perPage, total) });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-admin', 'GET /admin/user-activities failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/user-activities (SPEC 2421-2440) ──────────────
  router.post('/api/v4/admin/user-activities', adminWriteGate, async (req, res) => {
    try {
      const body = req.body || {};
      const details = {};

      const userId = toIntId(body.user_id); // v4 rename: participant_id -> user_id
      if (!userId) details.user_id = ['The user_id field is required and must exist.'];

      const seasonEventId = toIntId(body.season_event_id);
      if (!seasonEventId) details.season_event_id = ['The season_event_id field is required and must exist.'];

      const challengeId = toIntId(body.challenge_id);
      if (!challengeId) details.challenge_id = ['The challenge_id field is required and must exist.'];

      const activityType = body.activity_type;
      if (typeof activityType !== 'string' || activityType.length === 0) {
        details.activity_type = ['The activity_type field is required.'];
      }

      const points = Number(body.points);
      if (body.points === undefined || body.points === null || body.points === '' || Number.isNaN(points)) {
        details.points = ['The points field is required and must be numeric.'];
      }

      const activityAt = toDate(body.activity_at);
      if (activityAt === undefined || activityAt === null) {
        details.activity_at = ['The activity_at field is required and must be a valid date.'];
      }

      const description = body.description == null ? null : String(body.description);

      let metadata = null;
      if (body.metadata !== undefined && body.metadata !== null) {
        if (typeof body.metadata !== 'object') details.metadata = ['The metadata field must be an object.'];
        else metadata = body.metadata;
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const allowed = await allowedActivityTypes(pool);
      if (!allowed.has(activityType)) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { activity_type: ['The selected activity_type is invalid.'] },
        });
      }

      const { rows: userRows } = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
      if (!userRows.length) {
        return fail(res, 422, 'The given data was invalid.', { details: { user_id: ['The selected user_id is invalid.'] } });
      }

      const { rows: eventRows } = await pool.query('SELECT id FROM season_events WHERE id = $1', [seasonEventId]);
      if (!eventRows.length) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_event_id: ['The selected season_event_id is invalid.'] },
        });
      }

      // SPEC 2440: 422 (bare, no `details`) when the challenge belongs to
      // another event — renamed "phase" -> "event" per Global Constraints
      // #10, and unified into the v4 error envelope's `error` key (source
      // used a `message` key here; §4.8 rule 3 collapses every error
      // shape into one).
      const challenge = await loadChallenge(pool, challengeId);
      if (!challenge || Number(challenge.season_event_id) !== seasonEventId) {
        return fail(res, 422, 'Selected activity type is not available for the specified event.');
      }

      // SPEC 2440's note: the stored activity_type is OVERWRITTEN from
      // the challenge's template category (the submitted value is only a
      // guard-rail input validated above, never what's actually stored,
      // except in the unreachable case the template join is empty).
      const storedType = challenge.category || activityType;

      const { rows: insertRows } = await pool.query(
        `INSERT INTO user_activities
           (user_id, season_event_id, activity_type, points, description, metadata, activity_at, added_by, source, challenge_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'admin_ui', $9, NOW(), NOW())
         RETURNING id`,
        [userId, seasonEventId, storedType, points, description, metadata ? JSON.stringify(metadata) : null,
          activityAt, req.user.id, challengeId]
      );

      const { rows } = await pool.query(`${ACTIVITY_SELECT} WHERE ua.id = $1`, [insertRows[0].id]);
      return res.status(201).json({ success: true, data: formatActivityRow(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/user-activities failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/user-activities/import (SPEC 2465-2483) ───────
  router.post('/api/v4/admin/user-activities/import', adminWriteGate, async (req, res) => {
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const activities = Array.isArray(body.activities) ? body.activities : null;
      if (!activities || activities.length === 0) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { activities: ['The activities field is required and must have at least 1 item.'] },
        });
      }

      const allowed = await allowedActivityTypes(client);
      const errors = [];
      let importedCount = 0;

      // THE FIX (SPEC 2483's ⚠ "no transaction, no per-row errors" note):
      // one BEGIN/COMMIT for the whole batch (a DB failure rolls back
      // everything imported so far this call); a per-ROW validation
      // failure is NOT a DB failure — it's recorded in `errors` and the
      // loop moves on within the same transaction, same shape as the CSV
      // user import above.
      await client.query('BEGIN');
      try {
        for (let i = 0; i < activities.length; i++) {
          const row = activities[i] || {};
          const rowNum = i + 1;

          const userId = toIntId(row.user_id);
          const seasonEventId = toIntId(row.season_event_id);
          // THE FIX (SPEC 2483's ⚠ "doesn't accept a challenge id" note):
          // v4 accepts (and requires) `challenge_id` per row.
          const challengeId = toIntId(row.challenge_id);
          const activityType = row.activity_type;
          const points = Number(row.points);
          const activityAt = toDate(row.activity_at);
          const description = row.description == null ? null : String(row.description);

          if (!userId) { errors.push(`Row ${rowNum}: user_id is required and must exist.`); continue; }
          if (!seasonEventId) { errors.push(`Row ${rowNum}: season_event_id is required and must exist.`); continue; }
          if (!challengeId) { errors.push(`Row ${rowNum}: challenge_id is required and must exist.`); continue; }
          // THE FIX (SPEC 2472's ⚠ "hard-coded to the three legacy values"
          // note): aligned with create's full allowed-type list.
          if (typeof activityType !== 'string' || !allowed.has(activityType)) {
            errors.push(`Row ${rowNum}: activity_type must be one of the allowed values.`); continue;
          }
          if (row.points === undefined || row.points === null || row.points === '' || Number.isNaN(points)) {
            errors.push(`Row ${rowNum}: points must be numeric.`); continue;
          }
          if (activityAt === undefined || activityAt === null) {
            errors.push(`Row ${rowNum}: activity_at must be a valid date.`); continue;
          }

          const { rows: userRows } = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
          if (!userRows.length) { errors.push(`Row ${rowNum}: user_id does not exist.`); continue; }

          const { rows: eventRows } = await client.query('SELECT id FROM season_events WHERE id = $1', [seasonEventId]);
          if (!eventRows.length) { errors.push(`Row ${rowNum}: season_event_id does not exist.`); continue; }

          const challenge = await loadChallenge(client, challengeId);
          if (!challenge || Number(challenge.season_event_id) !== seasonEventId) {
            errors.push(`Row ${rowNum}: challenge_id does not belong to the specified event.`); continue;
          }

          const storedType = challenge.category || activityType;
          await client.query(
            `INSERT INTO user_activities
               (user_id, season_event_id, activity_type, points, description, activity_at, added_by, source, challenge_id, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'admin_ui', $8, NOW(), NOW())`,
            [userId, seasonEventId, storedType, points, description, activityAt, req.user.id, challengeId]
          );
          importedCount += 1;
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }

      return res.status(201).json({ success: true, data: { imported_count: importedCount, errors } });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/user-activities/import failed', { message: err.message });
      return fail(res, 500, 'Import failed.');
    } finally {
      client.release();
    }
  });

  // ── GET /api/v4/admin/user-activities/totals (SPEC 2485-2508) ────────
  //
  // Aggregated entirely in SQL (the source's note: it loads every
  // matching row into memory to aggregate). The per-(user,type) query
  // below returns one row per (user, distinct activity_type touched) —
  // orders of magnitude smaller than the raw activity count — and the
  // small JS reduce over THAT is the only in-memory step.
  router.get('/api/v4/admin/user-activities/totals', async (req, res) => {
    try {
      const seasonEventId = toIntId(req.query.season_event_id);
      const whereClause = seasonEventId ? 'WHERE season_event_id = $1' : '';
      const params = seasonEventId ? [seasonEventId] : [];

      const { rows: typeRows } = await pool.query(
        `SELECT activity_type, COUNT(*)::int AS count, COALESCE(SUM(points), 0) AS total_points,
                COUNT(DISTINCT user_id)::int AS unique_users
           FROM user_activities ${whereClause}
          GROUP BY activity_type ORDER BY activity_type`,
        params
      );

      const { rows: grandRows } = await pool.query(
        `SELECT COALESCE(SUM(points), 0) AS total_points, COUNT(*)::int AS total_activities,
                COUNT(DISTINCT user_id)::int AS unique_users
           FROM user_activities ${whereClause}`,
        params
      );

      const { rows: perUserTypeRows } = await pool.query(
        `SELECT user_id, activity_type, COUNT(*)::int AS count, COALESCE(SUM(points), 0) AS total_points
           FROM user_activities ${whereClause}
          GROUP BY user_id, activity_type`,
        params
      );

      const byUser = new Map();
      for (const r of perUserTypeRows) {
        const uid = Number(r.user_id);
        if (!byUser.has(uid)) byUser.set(uid, { total_points: 0, total_activities: 0, by_type: {} });
        const entry = byUser.get(uid);
        const pts = num(r.total_points) ?? 0;
        entry.total_points += pts;
        entry.total_activities += r.count;
        entry.by_type[r.activity_type] = { count: r.count, total_points: pts };
      }

      const userIds = [...byUser.keys()];
      let usersById = new Map();
      if (userIds.length) {
        const { rows } = await pool.query(
          'SELECT id, email, telegram, discord, display_name FROM users WHERE id = ANY($1)', [userIds]
        );
        usersById = new Map(rows.map((r) => [Number(r.id), r]));
      }

      const userTotals = userIds
        .map((uid) => {
          const entry = byUser.get(uid);
          const u = usersById.get(uid);
          return {
            user: u
              ? { id: uid, email: u.email, telegram: u.telegram, discord: u.discord, display_name: u.display_name }
              : { id: uid },
            total_points: entry.total_points,
            total_activities: entry.total_activities,
            by_type: entry.by_type,
          };
        })
        .sort((a, b) => b.total_points - a.total_points);

      const typeTotals = typeRows.map((r) => ({
        activity_type: r.activity_type,
        count: r.count,
        total_points: num(r.total_points) ?? 0,
        unique_users: r.unique_users,
      }));

      const grand = grandRows[0];
      return ok(res, {
        data: {
          user_totals: userTotals,
          type_totals: typeTotals,
          grand_total: {
            total_points: num(grand.total_points) ?? 0,
            total_activities: grand.total_activities,
            unique_users: grand.unique_users,
          },
        },
      });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/user-activities/totals failed', { message: err.message });
      return fail(res, 500, 'Failed to load activity totals.');
    }
  });

  // ── POST /api/v4/admin/user-activities/refresh-totals (SPEC 2510-2532) ─
  //
  // JUDGMENT CALL (per the task brief, since SPEC 2532 doesn't spell out
  // which snapshot columns count as "offchain-derived"): interpreted as
  // `extra_points` PLUS six of the seven bonus INTEGER columns on
  // `leaderboard_snapshots` — `bug_report_points`,
  // `inviting_new_participant_points`, `community_contribution_points`
  // (the three legacy activity-type columns) and `first_block_points`,
  // `top_3_points`, `success_50_percent_points` (three more named after
  // categories a challenge_templates row can carry). `produced_half_
  // blocks_points` is DELIBERATELY excluded — the schema comment on
  // `leaderboard_snapshots` (schema.sql) frames `extra_points` as "points
  // awarded outside block production", and produced-half-blocks is a
  // block-production metric like `event_total_produced_blocks`, not an
  // off-chain one; nothing here recomputes it.
  //
  // Recomputation, exactly: for each user with any `user_activities` row
  // in this event, SUM(points) grouped by activity_type gives that user's
  // raw per-type totals; each of the six named columns is
  // `round(raw_total_for_that_type * offchain_weight)` (the columns are
  // INTEGER); `extra_points` is `round(SUM(raw totals across every
  // activity_type) * offchain_weight, 2)` (NUMERIC(15,2)) — i.e. the same
  // per-type sums, all six-plus-others combined and weighted once more as
  // the overall aggregate the schema comment describes.
  router.post('/api/v4/admin/user-activities/refresh-totals', adminWriteGate, async (req, res) => {
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const seasonEventId = toIntId(body.season_event_id);
      if (!seasonEventId) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_event_id: ['The season_event_id field is required.'] },
        });
      }

      const { rows: eventRows } = await client.query(
        'SELECT id, name, ends_at, scoring_formula FROM season_events WHERE id = $1', [seasonEventId]
      );
      const event = eventRows[0];
      if (!event) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_event_id: ['The selected season_event_id is invalid.'] },
        });
      }

      if (new Date(event.ends_at) > new Date()) {
        return fail(res, 400, 'Refresh totals is only available for ended events. Active events are managed automatically.');
      }

      const offchainWeight = resolveOffchainWeight(event.scoring_formula);

      const { rows: sumRows } = await client.query(
        `SELECT user_id, activity_type, COALESCE(SUM(points), 0) AS total_points
           FROM user_activities WHERE season_event_id = $1
          GROUP BY user_id, activity_type`,
        [seasonEventId]
      );

      const perUser = new Map();
      for (const r of sumRows) {
        const uid = Number(r.user_id);
        if (!perUser.has(uid)) perUser.set(uid, {});
        perUser.get(uid)[r.activity_type] = Number(r.total_points) || 0;
      }

      // THE FIX (code-review finding): every snapshot rewrite for this
      // event happens inside ONE transaction — a mid-loop failure (e.g.
      // a bad connection on user 300 of 500) now rolls back every rewrite
      // this call already made instead of leaving the event's snapshots
      // partially recomputed (some at the new scale, some still stale).
      let updatedCount = 0;
      await client.query('BEGIN');
      try {
        for (const [userId, byType] of perUser.entries()) {
          // Shared with the snapshot builder (scoring.js) so this route
          // and buildSnapshots can never disagree on the offchain scale.
          const offchain = computeOffchainColumns(byType, offchainWeight);

          // Only the LATEST snapshot per user for this event is rewritten
          // — the current, displayed one — matching the "latest snapshot
          // per user" idiom used everywhere else in this migration
          // (public.js, standings.js).
          const { rowCount } = await client.query(
            `UPDATE leaderboard_snapshots ls
                SET extra_points = $3, bug_report_points = $4, inviting_new_participant_points = $5,
                    community_contribution_points = $6, first_block_points = $7, top_3_points = $8,
                    success_50_percent_points = $9, updated_at = NOW()
               FROM (
                 SELECT DISTINCT ON (user_id) id FROM leaderboard_snapshots
                  WHERE season_event_id = $1 AND user_id = $2
                  ORDER BY user_id, snapshot_at DESC, id DESC
               ) latest
              WHERE ls.id = latest.id`,
            [seasonEventId, userId, offchain.extra_points, offchain.bug_report_points,
              offchain.inviting_new_participant_points, offchain.community_contribution_points,
              offchain.first_block_points, offchain.top_3_points, offchain.success_50_percent_points]
          );
          if (rowCount > 0) updatedCount += 1;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }

      return ok(res, {
        data: {
          updated_count: updatedCount,
          event_name: event.name,
          recalculated_at: iso(new Date()),
        },
        message: `Activity totals refreshed for ${updatedCount} users`,
      });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/user-activities/refresh-totals failed', { message: err.message });
      return fail(res, 500, 'Failed to refresh activity totals.');
    } finally {
      client.release();
    }
  });

  // ── GET /api/v4/admin/user-activities/:id (SPEC 2452) ────────────────
  router.get('/api/v4/admin/user-activities/:id', async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Activity not found.');

      const { rows } = await pool.query(`${ACTIVITY_SELECT} WHERE ua.id = $1`, [id]);
      if (!rows.length) return fail(res, 404, 'Activity not found.');

      return ok(res, { data: formatActivityRow(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/user-activities/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PUT|PATCH /api/v4/admin/user-activities/:id (SPEC 2454-2463) ─────
  //
  // THE FIX (SPEC 2463's ⚠): the event/challenge consistency check runs
  // UNCONDITIONALLY here — the source only checked it when a new
  // challenge id AND a new event id were BOTH supplied in the same
  // request, so an activity could be silently moved to another event by
  // sending `phase_id` alone. This always re-derives the EFFECTIVE
  // (possibly unchanged) event/challenge pair and validates it, no
  // matter which fields the caller actually touched.
  async function updateActivity(req, res) {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Activity not found.');

      const { rows: existingRows } = await pool.query('SELECT * FROM user_activities WHERE id = $1', [id]);
      const existing = existingRows[0];
      if (!existing) return fail(res, 404, 'Activity not found.');

      const body = req.body || {};
      const details = {};
      const fields = {};

      if (body.user_id !== undefined) {
        const v = toIntId(body.user_id);
        if (!v) details.user_id = ['The user_id field must be a valid id.'];
        else fields.user_id = v;
      }
      if (body.season_event_id !== undefined) {
        const v = toIntId(body.season_event_id);
        if (!v) details.season_event_id = ['The season_event_id field must be a valid id.'];
        else fields.season_event_id = v;
      }
      if (body.challenge_id !== undefined) {
        const v = toIntId(body.challenge_id);
        if (!v) details.challenge_id = ['The challenge_id field must be a valid id.'];
        else fields.challenge_id = v;
      }
      if (body.activity_type !== undefined) {
        if (typeof body.activity_type !== 'string' || body.activity_type.length === 0) {
          details.activity_type = ['The activity_type field must be a string.'];
        } else {
          fields.activity_type = body.activity_type;
        }
      }
      if (body.points !== undefined) {
        const n = Number(body.points);
        if (body.points === null || body.points === '' || Number.isNaN(n)) {
          details.points = ['The points field must be numeric.'];
        } else {
          fields.points = n;
        }
      }
      if (body.activity_at !== undefined) {
        const d = toDate(body.activity_at);
        if (d == null) details.activity_at = ['The activity_at field must be a valid date.'];
        else fields.activity_at = d;
      }
      if (body.description !== undefined) fields.description = body.description == null ? null : String(body.description);
      if (body.metadata !== undefined) {
        if (body.metadata === null) fields.metadata = null;
        else if (typeof body.metadata !== 'object') details.metadata = ['The metadata field must be an object.'];
        else fields.metadata = body.metadata;
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      if (fields.user_id !== undefined) {
        const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [fields.user_id]);
        if (!rows.length) {
          return fail(res, 422, 'The given data was invalid.', { details: { user_id: ['The selected user_id is invalid.'] } });
        }
      }
      if (fields.season_event_id !== undefined) {
        const { rows } = await pool.query('SELECT id FROM season_events WHERE id = $1', [fields.season_event_id]);
        if (!rows.length) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_event_id: ['The selected season_event_id is invalid.'] },
          });
        }
      }

      // THE FIX: always re-derive and validate the effective pair.
      const effectiveEventId = fields.season_event_id ?? Number(existing.season_event_id);
      const effectiveChallengeId = fields.challenge_id ?? Number(existing.challenge_id);

      const challenge = await loadChallenge(pool, effectiveChallengeId);
      if (!challenge || Number(challenge.season_event_id) !== effectiveEventId) {
        return fail(res, 422, 'Selected activity type is not available for the specified event.');
      }
      // Stored activity_type always re-derived from the (possibly new)
      // challenge's category, same rule as create.
      fields.activity_type = challenge.category || fields.activity_type || existing.activity_type;

      const columns = Object.keys(fields);
      const setClauses = columns.map((col, i) => `${col} = $${i + 2}`);
      const values = columns.map((col) => (col === 'metadata' ? (fields[col] ? JSON.stringify(fields[col]) : null) : fields[col]));
      await pool.query(
        `UPDATE user_activities SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1`,
        [id, ...values]
      );

      const { rows } = await pool.query(`${ACTIVITY_SELECT} WHERE ua.id = $1`, [id]);
      return ok(res, { data: formatActivityRow(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'PUT /admin/user-activities/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  }
  router.put('/api/v4/admin/user-activities/:id', adminWriteGate, updateActivity);
  router.patch('/api/v4/admin/user-activities/:id', adminWriteGate, updateActivity);

  // ── DELETE /api/v4/admin/user-activities/:id (SPEC 2465) ─────────────
  router.delete('/api/v4/admin/user-activities/:id', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Activity not found.');

      const { rows } = await pool.query('DELETE FROM user_activities WHERE id = $1 RETURNING id', [id]);
      if (!rows.length) return fail(res, 404, 'Activity not found.');

      return ok(res, {}, { message: 'Activity deleted successfully.' });
    } catch (err) {
      log.error('topochain-admin', 'DELETE /admin/user-activities/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { userActivitiesAdminRoutes, formatActivityRow, ACTIVITY_SELECT };
