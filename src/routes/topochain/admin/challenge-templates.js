// Topochain v4 admin API — D4 challenge templates (SPEC 2534-2589, v1
// `/admin/offchain-activity-types`; Task 12). A `challenge_templates` row
// is a reusable challenge DEFINITION; `challenges` (D6, ./challenges.js)
// instantiates one per season_event. Every mutating route is gated by
// `adminWriteGate`; reads are covered by the router-wide `adminReadGate`
// applied in ../admin.js.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { adminWriteGate } = require('./auth');
const { toIntId, toNumber } = require('./util');
const {
  ok, fail, paginate, meta, ValidationError,
} = require('../helpers');
const { formatTemplate } = require('../challenge-view');

const CTA_TYPE_VALUES = new Set(['url', 'app']);

// The shape of an illustration slug. A slug names either a built-in drawing
// (its file name under /illustrations/challenges/ without the extension) or an
// admin upload (`u-` plus the id of its challenge_illustrations row, served
// from /challenge-illustrations/<id>). Only the SHAPE is checked here, not
// membership: the client registry (frontend/src/lib/challenge-illustrations.ts)
// decides what it draws, so a server that refused unknown slugs would have to
// be released in lockstep with every new drawing. The shape is what keeps the
// value from ever becoming a path or a URL.
const ILLUSTRATION_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ─── Create/update validation (SPEC 2548-2562, 2575-2577) ──────────────
//
// Shared by create (`required = true`: category/goal/task/reward are
// mandatory) and update (`required = false`: every field optional, same
// rules once present). `fields` only contains keys actually present in
// `body`, so update's caller can build a dynamic SET list from it and
// create's caller can tell "field omitted" (falls back to a DB default,
// there is none here beyond NULL) from "field explicitly sent".
function parseTemplateFields(body, { required }) {
  const details = {};
  const fields = {};

  if (body.category !== undefined) {
    if (typeof body.category !== 'string' || body.category.length === 0 || body.category.length > 50) {
      details.category = ['The category field is required and must be a string of at most 50 characters.'];
    } else {
      fields.category = body.category;
    }
  } else if (required) {
    details.category = ['The category field is required.'];
  }

  if (body.goal !== undefined) {
    if (typeof body.goal !== 'string' || body.goal.length === 0 || body.goal.length > 255) {
      details.goal = ['The goal field is required and must be a string of at most 255 characters.'];
    } else {
      fields.goal = body.goal;
    }
  } else if (required) {
    details.goal = ['The goal field is required.'];
  }

  if (body.task !== undefined) {
    if (typeof body.task !== 'string' || body.task.length === 0) {
      details.task = ['The task field is required and must be a string.'];
    } else {
      fields.task = body.task;
    }
  } else if (required) {
    details.task = ['The task field is required.'];
  }

  if (body.reward !== undefined) {
    if (typeof body.reward !== 'string' || body.reward.length === 0 || body.reward.length > 255) {
      details.reward = ['The reward field is required and must be a string of at most 255 characters.'];
    } else {
      fields.reward = body.reward;
    }
  } else if (required) {
    details.reward = ['The reward field is required.'];
  }

  // Nullable free-text fields — present-and-null is a valid "clear it" write.
  for (const key of ['description', 'requirements', 'reward_logic']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    if (typeof body[key] !== 'string') { details[key] = [`The ${key} field must be a string.`]; continue; }
    fields[key] = body[key];
  }

  // schedule_start/schedule_end: nullable dates; schedule_end must be
  // after schedule_start WHENEVER a comparison is possible (both present
  // in the SAME parsed `fields`) — the create-path comparison. The
  // update path's persisted-value fix (SPEC 2577's "same after:
  // schedule_start partial-update pitfall as events") is applied by the
  // ROUTE, not here, since only the route knows the row's existing value.
  for (const key of ['schedule_start', 'schedule_end']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    const d = new Date(body[key]);
    if (Number.isNaN(d.getTime())) { details[key] = [`The ${key} field must be a valid date.`]; continue; }
    fields[key] = d;
  }

  if (body.kind !== undefined) {
    if (body.kind === null) {
      fields.kind = null;
    } else if (typeof body.kind !== 'string' || body.kind.length > 100) {
      details.kind = ['The kind field must be a string of at most 100 characters.'];
    } else {
      fields.kind = body.kind;
    }
  }

  for (const key of ['cta_button', 'cta_label', 'mobile_cta_label']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    if (typeof body[key] !== 'string' || body[key].length > 255) {
      details[key] = [`The ${key} field must be a string of at most 255 characters.`];
      continue;
    }
    fields[key] = body[key];
  }

  for (const key of ['cta_link', 'mobile_cta_link']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    if (typeof body[key] !== 'string') { details[key] = [`The ${key} field must be a string.`]; continue; }
    fields[key] = body[key];
  }

  // v4 addition (SPEC 2565's note): `cta_type`/`mobile_cta_type`/the
  // `mobile_cta_*` trio/the `metric_*` trio exist on the table but the
  // source endpoint never accepted them — v4 does.
  for (const key of ['cta_type', 'mobile_cta_type']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    if (!CTA_TYPE_VALUES.has(body[key])) { details[key] = [`The ${key} field must be one of: url, app.`]; continue; }
    fields[key] = body[key];
  }

  if (body.metric_type !== undefined) {
    if (body.metric_type === null) {
      fields.metric_type = null;
    } else if (typeof body.metric_type !== 'string' || body.metric_type.length > 30) {
      details.metric_type = ['The metric_type field must be a string of at most 30 characters.'];
    } else {
      fields.metric_type = body.metric_type;
    }
  }
  if (body.metric_label !== undefined) {
    if (body.metric_label === null) {
      fields.metric_label = null;
    } else if (typeof body.metric_label !== 'string' || body.metric_label.length > 255) {
      details.metric_label = ['The metric_label field must be a string of at most 255 characters.'];
    } else {
      fields.metric_label = body.metric_label;
    }
  }
  if (body.metric_target !== undefined) {
    if (body.metric_target === null) {
      fields.metric_target = null;
    } else {
      // `toNumber` (code-review finding), not bare `Number()`: the latter
      // silently turns `true`/`[]`/`""` into a "valid" 0 or 1 instead of
      // 422ing.
      const n = toNumber(body.metric_target);
      if (n === undefined) { details.metric_target = ['The metric_target field must be numeric.']; } else { fields.metric_target = n; }
    }
  }

  if (body.illustration !== undefined) {
    if (body.illustration === null) {
      fields.illustration = null;
    } else if (typeof body.illustration !== 'string' || !ILLUSTRATION_SLUG.test(body.illustration)) {
      details.illustration = ['The illustration field must be a slug of lowercase letters, digits and hyphens, at most 64 characters.'];
    } else {
      fields.illustration = body.illustration;
    }
  }

  return { details, fields };
}

function challengeTemplatesAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/challenge-templates/categories (SPEC 2585-2589) ──
  //
  // THE FIX (§4.8 item 7, SPEC 2587's ⚠ "unreachable in source" note —
  // route shadowing): registered BEFORE GET /:id below so "categories"
  // is never swallowed as an `:id` path segment.
  router.get('/api/v4/admin/challenge-templates/categories', async (_req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT DISTINCT category FROM challenge_templates ORDER BY category ASC'
      );
      return ok(res, { data: rows.map((r) => r.category) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/challenge-templates/categories failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/challenge-templates (SPEC 2536-2542) ──────────
  router.get('/api/v4/admin/challenge-templates', async (req, res) => {
    try {
      const { page, perPage } = paginate(req, { defaultPerPage: 20 }); // SPEC 2540
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
      const like = search ? `%${search}%` : null;

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM challenge_templates
          WHERE ($1::text IS NULL OR goal ILIKE $1 OR task ILIKE $1 OR category ILIKE $1 OR kind ILIKE $1)
            AND ($2::text = '' OR category = $2)`,
        [like, category]
      );
      const total = countRows[0].c;

      // The two GETs also select an uploaded illustration's tone, the value the
      // public card payload carries beside the slug (challenge-view.js's
      // t_illustration_tone). A scalar subquery rather than a join: `slug` is
      // UNIQUE, a built-in slug never has a row, and a join would widen
      // `SELECT *`. Written out in each query rather than shared as a fragment
      // so both stay statically checkable by scripts/check-sql.js. The write
      // responses below leave the tone null: they echo the row as written, and
      // the form's gallery already holds every tone from its own list.
      const { rows } = await pool.query(
        `SELECT *, (SELECT ci.tone FROM challenge_illustrations ci
                      WHERE ci.slug = challenge_templates.illustration) AS illustration_tone
           FROM challenge_templates
          WHERE ($1::text IS NULL OR goal ILIKE $1 OR task ILIKE $1 OR category ILIKE $1 OR kind ILIKE $1)
            AND ($2::text = '' OR category = $2)
          ORDER BY category ASC, goal ASC
          LIMIT $3 OFFSET $4`,
        [like, category, perPage, (page - 1) * perPage]
      );

      return ok(res, { data: rows.map(formatTemplate) }, { meta: meta(page, perPage, total) });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-admin', 'GET /admin/challenge-templates failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/challenge-templates (SPEC 2544-2565) ─────────
  router.post('/api/v4/admin/challenge-templates', adminWriteGate, async (req, res) => {
    try {
      const body = req.body || {};
      const { details, fields } = parseTemplateFields(body, { required: true });

      if (fields.schedule_start && fields.schedule_end && !(fields.schedule_end > fields.schedule_start)) {
        details.schedule_end = ['The schedule_end field must be a date after schedule_start.'];
      }

      if (!Object.keys(details).length && fields.kind != null) {
        const { rows: kindRows } = await pool.query('SELECT id FROM challenge_kinds WHERE id = $1', [fields.kind]);
        if (!kindRows.length) details.kind = ['The selected kind is invalid.'];
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const { rows } = await pool.query(
        `INSERT INTO challenge_templates
           (category, goal, task, reward, description, requirements, schedule_start, schedule_end,
            reward_logic, cta_button, cta_label, cta_link, created_at, updated_at, kind, cta_type,
            mobile_cta_type, mobile_cta_label, mobile_cta_link, metric_type, metric_target, metric_label,
            illustration)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW(),$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING *`,
        [
          fields.category, fields.goal, fields.task, fields.reward,
          fields.description ?? null, fields.requirements ?? null,
          fields.schedule_start ?? null, fields.schedule_end ?? null,
          fields.reward_logic ?? null, fields.cta_button ?? null, fields.cta_label ?? null,
          fields.cta_link ?? null, fields.kind ?? null, fields.cta_type ?? null,
          fields.mobile_cta_type ?? null, fields.mobile_cta_label ?? null, fields.mobile_cta_link ?? null,
          fields.metric_type ?? null, fields.metric_target ?? null, fields.metric_label ?? null,
          fields.illustration ?? null,
        ]
      );

      return res.status(201).json({ success: true, data: formatTemplate(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/challenge-templates failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET /api/v4/admin/challenge-templates/:id (SPEC 2567-2569) ───────
  router.get('/api/v4/admin/challenge-templates/:id', async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Challenge template not found.');

      const { rows } = await pool.query(
        `SELECT *, (SELECT ci.tone FROM challenge_illustrations ci
                      WHERE ci.slug = challenge_templates.illustration) AS illustration_tone
           FROM challenge_templates WHERE id = $1`, [id]
      );
      if (!rows.length) return fail(res, 404, 'Challenge template not found.');

      return ok(res, { data: formatTemplate(rows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/challenge-templates/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PUT|PATCH /api/v4/admin/challenge-templates/:id (SPEC 2571-2577) ─
  //
  // THE FIX (SPEC 2577, §4.8 item 7): `schedule_end` sent alone validates
  // `after:schedule_start` against the PERSISTED schedule_start, not a
  // sibling value that may not be in THIS request's body.
  async function updateTemplate(req, res) {
    const id = toIntId(req.params.id);
    if (!id) return fail(res, 404, 'Challenge template not found.');

    try {
      const { rows: existingRows } = await pool.query('SELECT * FROM challenge_templates WHERE id = $1', [id]);
      const existing = existingRows[0];
      if (!existing) return fail(res, 404, 'Challenge template not found.');

      const body = req.body || {};
      const { details, fields } = parseTemplateFields(body, { required: false });

      const effectiveStart = fields.schedule_start !== undefined ? fields.schedule_start : existing.schedule_start;
      const effectiveEnd = fields.schedule_end !== undefined ? fields.schedule_end : existing.schedule_end;
      if ((fields.schedule_start !== undefined || fields.schedule_end !== undefined)
          && effectiveStart && effectiveEnd && !(new Date(effectiveEnd) > new Date(effectiveStart))) {
        details.schedule_end = ['The schedule_end field must be a date after schedule_start.'];
      }

      if (!Object.keys(details).length && fields.kind !== undefined && fields.kind != null) {
        const { rows: kindRows } = await pool.query('SELECT id FROM challenge_kinds WHERE id = $1', [fields.kind]);
        if (!kindRows.length) details.kind = ['The selected kind is invalid.'];
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const columns = Object.keys(fields);
      if (columns.length === 0) return ok(res, { data: formatTemplate(existing) });

      const setClauses = columns.map((col, i) => `${col} = $${i + 2}`);
      const values = columns.map((col) => fields[col]);
      const { rows: updatedRows } = await pool.query(
        `UPDATE challenge_templates SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, ...values]
      );

      return ok(res, { data: formatTemplate(updatedRows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'PUT /admin/challenge-templates/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  }
  router.put('/api/v4/admin/challenge-templates/:id', adminWriteGate, updateTemplate);
  router.patch('/api/v4/admin/challenge-templates/:id', adminWriteGate, updateTemplate);

  // ── DELETE /api/v4/admin/challenge-templates/:id (SPEC 2579-2583) ───
  //
  // THE FIX (SPEC 2583's ⚠ "destructive with no guard" note, §4.8 item
  // 7): the source cascades straight through every `challenges` row using
  // this template (and transitively their `user_activities` history) —
  // v4 refuses instead. `challenges.challenge_template_id` has NO ON
  // DELETE action (schema.sql's own comment on that column) so a caller
  // that somehow bypassed this API would still get a DB-level 23503
  // (foreign_key_violation), not a silent cascade; this check is the
  // primary UX (a clear 409, not a raw driver error).
  router.delete('/api/v4/admin/challenge-templates/:id', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'Challenge template not found.');

      const { rows: existingRows } = await pool.query('SELECT id FROM challenge_templates WHERE id = $1', [id]);
      if (!existingRows.length) return fail(res, 404, 'Challenge template not found.');

      const { rows: refRows } = await pool.query(
        'SELECT COUNT(*)::int AS c FROM challenges WHERE challenge_template_id = $1', [id]
      );
      if (refRows[0].c > 0) {
        return fail(
          res, 409,
          `Cannot delete this challenge template: ${refRows[0].c} challenge(s) still reference it.`,
          { code: 'challenge_template_in_use' }
        );
      }

      await pool.query('DELETE FROM challenge_templates WHERE id = $1', [id]);
      return ok(res, {}, { message: 'Challenge template deleted successfully.' });
    } catch (err) {
      // Defense in depth: a concurrent challenge create between the
      // count-check above and this DELETE would otherwise surface as a
      // raw 23503 — map it to the same 409 rather than a 500.
      if (err && err.code === '23503') {
        return fail(res, 409, 'Cannot delete this challenge template: it is still referenced by one or more challenges.', {
          code: 'challenge_template_in_use',
        });
      }
      log.error('topochain-admin', 'DELETE /admin/challenge-templates/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  return router;
}

module.exports = { challengeTemplatesAdminRoutes };
