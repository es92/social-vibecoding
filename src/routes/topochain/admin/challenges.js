// Topochain v4 admin API — D6 challenges (SPEC 2644-2745, v1 `/admin/
// phases/{phase}/activities`; Task 12). Season -> Event -> Challenge:
// this is the Challenge level, always nested under one season_event.
// Every mutating route is gated by `adminWriteGate`; reads are covered by
// the router-wide `adminReadGate` applied in ../admin.js.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { adminWriteGate } = require('./auth');
const {
  toIntId, toBool, toNumber,
} = require('./util');
const { ok, fail } = require('../helpers');
const {
  TEMPLATE_JOIN_COLUMNS_SQL, buildChallengeListItem, formatTemplate, buildChallengeRawWithTemplate,
} = require('../challenge-view');

const CTA_TYPE_VALUES = new Set(['url', 'app']);

// The admin list's item: the public shape (challenge-view.js), plus the two
// things only an admin sets that the public list leaves out: where the
// challenge sits in its event's order, and whether it is featured. Without
// the order, the console's edit form read every challenge's as 0 and a save
// moved it to the top; the admin connector's tools read both here too
// (routes/challenge-admin.js).
function adminListItem(r) {
  return {
    ...buildChallengeListItem(r),
    display_order: Number(r.display_order) || 0,
    featured: r.featured === true,
    featured_order: r.featured_order != null ? Number(r.featured_order) : null,
  };
}

// One challenges<->challenge_templates JOIN, reused by every route below
// that needs "the raw row with its activity_type" (create/update/toggle/
// move/reorder — SPEC 2680/2690's fresh()-bug fix) or the public-shaped
// list (index — SPEC 2672). `c.*` (not a hand-picked column list) so a
// future column addition to `challenges` shows up here for free.
const CHALLENGE_JOIN_SELECT = `SELECT c.*, ${TEMPLATE_JOIN_COLUMNS_SQL}
   FROM challenges c
   LEFT JOIN challenge_templates ct ON ct.id = c.challenge_template_id`;

// ─── Create/update validation (SPEC 2649-2664) ─────────────────────────
//
// EVERY shared write field is optional on both create and update (SPEC's
// own table marks them all "optional" — a challenge only needs to
// override what it wants to differ from its template); the one field
// that's actually required on create is `challenge_template_id`, checked
// separately by the route (it isn't part of this "shared fields" set).
function parseChallengeFields(body) {
  const details = {};
  const fields = {};

  if (body.kind !== undefined) {
    if (body.kind === null) {
      fields.kind = null;
    } else if (typeof body.kind !== 'string' || body.kind.length > 100) {
      details.kind = ['The kind field must be a string of at most 100 characters.'];
    } else {
      fields.kind = body.kind;
    }
  }

  for (const key of ['goal', 'reward']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    if (typeof body[key] !== 'string' || body[key].length > 255) {
      details[key] = [`The ${key} field must be a string of at most 255 characters.`];
      continue;
    }
    fields[key] = body[key];
  }

  for (const key of ['task', 'description', 'requirements', 'reward_logic']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    if (typeof body[key] !== 'string') { details[key] = [`The ${key} field must be a string.`]; continue; }
    fields[key] = body[key];
  }

  for (const key of ['schedule_start', 'schedule_end']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    const d = new Date(body[key]);
    if (Number.isNaN(d.getTime())) { details[key] = [`The ${key} field must be a valid date.`]; continue; }
    fields[key] = d;
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

  for (const key of ['cta_type', 'mobile_cta_type']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    if (!CTA_TYPE_VALUES.has(body[key])) { details[key] = [`The ${key} field must be one of: url, app.`]; continue; }
    fields[key] = body[key];
  }

  for (const key of ['enabled', 'completed', 'featured']) {
    if (body[key] === undefined) continue;
    const b = toBool(body[key]);
    if (b === undefined) { details[key] = [`The ${key} field must be a boolean.`]; continue; }
    fields[key] = b;
  }

  if (body.display_order !== undefined) {
    // `toNumber` (code-review finding), not bare `Number()`: the latter
    // silently turns `true`/`[]` into a "valid" integer instead of 422ing.
    const n = toNumber(body.display_order);
    if (n === undefined || !Number.isInteger(n) || n < 0) details.display_order = ['The display_order field must be an integer >= 0.'];
    else fields.display_order = n;
  }

  // v4 additions (SPEC 2664's ⚠ note): `metric_type`/`metric_target`/
  // `metric_label`/`featured`/`featured_order` are stored on the table
  // but accepted by neither the source create nor update validator — v4
  // accepts all of them (featured is handled in the boolean loop above).
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
      const n = toNumber(body.metric_target);
      if (n === undefined) { details.metric_target = ['The metric_target field must be numeric.']; } else { fields.metric_target = n; }
    }
  }
  if (body.featured_order !== undefined) {
    if (body.featured_order === null) {
      fields.featured_order = null;
    } else {
      const n = toNumber(body.featured_order);
      if (n === undefined || !Number.isInteger(n) || n < 0) details.featured_order = ['The featured_order field must be an integer >= 0.'];
      else fields.featured_order = n;
    }
  }

  return { details, fields };
}

function challengesAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Shared event lookup: 404 "Event not found." if :seasonEvent doesn't
  // exist at all (distinct from the ownership 404 below, which fires
  // when the EVENT exists but a given :activity belongs to a DIFFERENT
  // one).
  async function loadEvent(client, seasonEventId) {
    if (!seasonEventId) return null;
    const { rows } = await client.query('SELECT id, season_id FROM season_events WHERE id = $1', [seasonEventId]);
    return rows[0] || null;
  }

  // Shared challenge lookup, JOINed with its template, scoped to one
  // event. THE FIX (SPEC 2646, task-12 brief "event vocabulary"): a
  // challenge that exists but belongs to a DIFFERENT event 404s with a
  // renamed message ("Activity does not belong to this phase." in the
  // source -> "Challenge does not belong to this event." here, following
  // the same phase->event / activity->challenge rename this whole D-group
  // already applies to its URL path and every other message).
  async function loadOwnedChallenge(client, seasonEventId, challengeId) {
    if (!challengeId) return { error: 'not_found' };
    const { rows } = await client.query(`${CHALLENGE_JOIN_SELECT} WHERE c.id = $1`, [challengeId]);
    const row = rows[0];
    if (!row) return { error: 'not_found' };
    if (Number(row.season_event_id) !== Number(seasonEventId)) return { error: 'wrong_event' };
    return { row };
  }

  function challengeNotFound(res) {
    return fail(res, 404, 'Challenge not found.');
  }
  function challengeWrongEvent(res) {
    return fail(res, 404, 'Challenge does not belong to this event.');
  }

  // ── GET .../challenges (SPEC 2666-2672) ──────────────────────────────
  router.get('/api/v4/admin/season-events/:seasonEvent/challenges', async (req, res) => {
    try {
      const seasonEventId = toIntId(req.params.seasonEvent);
      if (!seasonEventId) return fail(res, 404, 'Event not found.');
      const event = await loadEvent(pool, seasonEventId);
      if (!event) return fail(res, 404, 'Event not found.');

      // No filtering/pagination (SPEC 2670: "path parameter only") and,
      // unlike the PUBLIC endpoint (public.js), no `enabled = TRUE`
      // filter — an admin managing an event needs to see disabled
      // challenges too, in order to re-enable them.
      const { rows } = await pool.query(
        `${CHALLENGE_JOIN_SELECT} WHERE c.season_event_id = $1 ORDER BY c.display_order ASC, c.id ASC`,
        [seasonEventId]
      );
      const data = rows.filter((r) => r.t_id != null).map(adminListItem);

      return ok(res, { data });
    } catch (err) {
      log.error('topochain-admin', 'GET .../challenges failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── GET .../challenges/available-activity-types (SPEC 2741-2745) ────
  //
  // Registered BEFORE the /:activity routes below (same route-shadowing
  // discipline as D4's /categories) — "available-activity-types" must
  // never be swallowed as an `:activity` id.
  router.get('/api/v4/admin/season-events/:seasonEvent/challenges/available-activity-types', async (req, res) => {
    try {
      const seasonEventId = toIntId(req.params.seasonEvent);
      if (!seasonEventId) return fail(res, 404, 'Event not found.');
      const event = await loadEvent(pool, seasonEventId);
      if (!event) return fail(res, 404, 'Event not found.');

      const { rows } = await pool.query(
        `SELECT * FROM challenge_templates
          WHERE id NOT IN (SELECT challenge_template_id FROM challenges WHERE season_event_id = $1)
          ORDER BY category ASC, goal ASC`,
        [seasonEventId]
      );

      return ok(res, { data: rows.map(formatTemplate) });
    } catch (err) {
      log.error('topochain-admin', 'GET .../available-activity-types failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST .../challenges (SPEC 2674-2682) ─────────────────────────────
  router.post('/api/v4/admin/season-events/:seasonEvent/challenges', adminWriteGate, async (req, res) => {
    try {
      const seasonEventId = toIntId(req.params.seasonEvent);
      if (!seasonEventId) return fail(res, 404, 'Event not found.');
      const event = await loadEvent(pool, seasonEventId);
      if (!event) return fail(res, 404, 'Event not found.');

      const body = req.body || {};
      const { details, fields } = parseChallengeFields(body);

      const templateId = toIntId(body.challenge_template_id);
      if (!templateId) details.challenge_template_id = ['The challenge_template_id field is required.'];

      if (fields.schedule_start && fields.schedule_end && !(fields.schedule_end > fields.schedule_start)) {
        details.schedule_end = ['The schedule_end field must be a date after schedule_start.'];
      }

      if (!Object.keys(details).length && fields.kind != null) {
        const { rows: kindRows } = await pool.query('SELECT id FROM challenge_kinds WHERE id = $1', [fields.kind]);
        if (!kindRows.length) details.kind = ['The selected kind is invalid.'];
      }

      if (!Object.keys(details).length && templateId) {
        const { rows: templateRows } = await pool.query('SELECT id FROM challenge_templates WHERE id = $1', [templateId]);
        if (!templateRows.length) details.challenge_template_id = ['The selected challenge_template_id is invalid.'];
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      // SPEC 2682: "no uniqueness guard, so the same activity type can be
      // added to an event twice" — a source quirk deliberately carried
      // over (§4.8 item 8's "carried quirks" category is not exhaustive
      // in the brief, but nothing in D6's fix list asks for a uniqueness
      // guard here, so none is added).
      const { rows: insertRows } = await pool.query(
        `INSERT INTO challenges
           (season_event_id, challenge_template_id, goal, task, reward, description, requirements,
            schedule_start, schedule_end, reward_logic, cta_button, cta_label, cta_link,
            created_at, updated_at, enabled, display_order, completed, kind, cta_type,
            mobile_cta_type, mobile_cta_label, mobile_cta_link, metric_type, metric_target,
            metric_label, featured, featured_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW(),$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         RETURNING id`,
        [
          seasonEventId, templateId, fields.goal ?? null, fields.task ?? null, fields.reward ?? null,
          fields.description ?? null, fields.requirements ?? null, fields.schedule_start ?? null,
          fields.schedule_end ?? null, fields.reward_logic ?? null, fields.cta_button ?? null,
          fields.cta_label ?? null, fields.cta_link ?? null, fields.enabled ?? true,
          fields.display_order ?? 0, fields.completed ?? false, fields.kind ?? null,
          fields.cta_type ?? null, fields.mobile_cta_type ?? null, fields.mobile_cta_label ?? null,
          fields.mobile_cta_link ?? null, fields.metric_type ?? null, fields.metric_target ?? null,
          fields.metric_label ?? null, fields.featured ?? false, fields.featured_order ?? null,
        ]
      );

      const { rows: joinedRows } = await pool.query(`${CHALLENGE_JOIN_SELECT} WHERE c.id = $1`, [insertRows[0].id]);
      return res.status(201).json({ success: true, data: buildChallengeRawWithTemplate(joinedRows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'POST .../challenges failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PATCH .../challenges/update-display-orders (SPEC 2731-2739) ─────
  //
  // THE FIX (SPEC 2739's ⚠ "ids belonging to another event are silently
  // skipped, and there is no transaction" note, §4.8 item 7): every id is
  // validated to belong to THIS event up front (offenders are listed in
  // one 422, not silently dropped), and the whole reorder applies inside
  // one transaction.
  router.patch('/api/v4/admin/season-events/:seasonEvent/challenges/update-display-orders', adminWriteGate, async (req, res) => {
    const client = await pool.connect();
    try {
      const seasonEventId = toIntId(req.params.seasonEvent);
      if (!seasonEventId) return fail(res, 404, 'Event not found.');
      const event = await loadEvent(client, seasonEventId);
      if (!event) return fail(res, 404, 'Event not found.');

      const body = req.body || {};
      // v4 addition: the request array is named `challenges` here (the
      // source's `activities`, renamed per this D-group's activity ->
      // challenge convention — the same rename already applied to the
      // URL path itself and to every ownership/not-found message below).
      const items = Array.isArray(body.challenges) ? body.challenges : null;
      if (!items || items.length < 1) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { challenges: ['The challenges field is required and must have at least 1 item.'] },
        });
      }

      const parsed = [];
      const details = {};
      for (let i = 0; i < items.length; i++) {
        const item = items[i] || {};
        const id = toIntId(item.id);
        const order = toNumber(item.display_order);
        if (!id) { details[`challenges.${i}.id`] = ['The id field is required and must be a valid challenge id.']; continue; }
        if (order === undefined || !Number.isInteger(order) || order < 0) {
          details[`challenges.${i}.display_order`] = ['The display_order field must be an integer >= 0.'];
          continue;
        }
        parsed.push({ id, order });
      }
      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const ids = parsed.map((p) => p.id);
      const { rows: ownedRows } = await client.query(
        'SELECT id FROM challenges WHERE id = ANY($1) AND season_event_id = $2', [ids, seasonEventId]
      );
      const ownedIds = new Set(ownedRows.map((r) => Number(r.id)));
      const offenders = ids.filter((id) => !ownedIds.has(id));
      if (offenders.length) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { challenges: [`The following challenge id(s) do not belong to this event: ${offenders.join(', ')}.`] },
        });
      }

      await client.query('BEGIN');
      try {
        for (const item of parsed) {
          await client.query(
            'UPDATE challenges SET display_order = $1, updated_at = NOW() WHERE id = $2 AND season_event_id = $3',
            [item.order, item.id, seasonEventId]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }

      const { rows } = await client.query(
        `${CHALLENGE_JOIN_SELECT} WHERE c.season_event_id = $1 ORDER BY c.display_order ASC, c.id ASC`,
        [seasonEventId]
      );
      const data = rows.filter((r) => r.t_id != null).map(adminListItem);

      return ok(res, { data }, { message: 'Display orders updated successfully.' });
    } catch (err) {
      log.error('topochain-admin', 'PATCH .../update-display-orders failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    } finally {
      client.release();
    }
  });

  // ── PUT .../challenges/:activity (SPEC 2684-2690) ────────────────────
  //
  // PUT only (SPEC 2686: "PUT only, no PATCH in source") — the challenge-
  // specific PATCH verbs below (toggle-enabled/toggle-completed/move) are
  // distinct sibling endpoints, not this one under another method.
  //
  // THE FIX (SPEC 2690's ⚠ "activity_type is missing... the refreshed
  // model drops the loaded relation" note, §4.8 item 7): the response is
  // built from a FRESH post-update JOIN (buildChallengeRawWithTemplate),
  // never off a stale in-memory object, so `activity_type` is always
  // present.
  router.put('/api/v4/admin/season-events/:seasonEvent/challenges/:activity', adminWriteGate, async (req, res) => {
    try {
      const seasonEventId = toIntId(req.params.seasonEvent);
      const activityId = toIntId(req.params.activity);
      if (!seasonEventId) return fail(res, 404, 'Event not found.');
      const event = await loadEvent(pool, seasonEventId);
      if (!event) return fail(res, 404, 'Event not found.');

      const existing = await loadOwnedChallenge(pool, seasonEventId, activityId);
      if (existing.error === 'not_found') return challengeNotFound(res);
      if (existing.error === 'wrong_event') return challengeWrongEvent(res);

      const body = req.body || {};
      // `challenge_template_id` cannot be changed here (SPEC 2688: "the
      // activity type cannot be changed") — silently ignored rather than
      // 422ing, matching the source's own "the field simply isn't
      // writable" behavior (not a validation error condition).
      const { details, fields } = parseChallengeFields(body);

      const effectiveStart = fields.schedule_start !== undefined ? fields.schedule_start : existing.row.schedule_start;
      const effectiveEnd = fields.schedule_end !== undefined ? fields.schedule_end : existing.row.schedule_end;
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
      if (columns.length > 0) {
        const setClauses = columns.map((col, i) => `${col} = $${i + 2}`);
        const values = columns.map((col) => fields[col]);
        await pool.query(
          `UPDATE challenges SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1`,
          [activityId, ...values]
        );
      }

      const { rows: freshRows } = await pool.query(`${CHALLENGE_JOIN_SELECT} WHERE c.id = $1`, [activityId]);
      return ok(res, { data: buildChallengeRawWithTemplate(freshRows[0]) });
    } catch (err) {
      log.error('topochain-admin', 'PUT .../challenges/:activity failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── DELETE .../challenges/:activity (SPEC 2692-2696) ─────────────────
  router.delete('/api/v4/admin/season-events/:seasonEvent/challenges/:activity', adminWriteGate, async (req, res) => {
    try {
      const seasonEventId = toIntId(req.params.seasonEvent);
      const activityId = toIntId(req.params.activity);
      if (!seasonEventId) return fail(res, 404, 'Event not found.');
      const event = await loadEvent(pool, seasonEventId);
      if (!event) return fail(res, 404, 'Event not found.');

      const existing = await loadOwnedChallenge(pool, seasonEventId, activityId);
      if (existing.error === 'not_found') return challengeNotFound(res);
      if (existing.error === 'wrong_event') return challengeWrongEvent(res);

      // Cascades to `user_activities` (ON DELETE CASCADE, schema.sql) —
      // SPEC 2696's "cascades to the activities awarded for that
      // challenge" note.
      await pool.query('DELETE FROM challenges WHERE id = $1', [activityId]);
      return ok(res, {}, { message: 'Challenge removed from event successfully.' });
    } catch (err) {
      log.error('topochain-admin', 'DELETE .../challenges/:activity failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PATCH .../challenges/:activity/toggle-enabled (SPEC 2698-2702) ──
  router.patch('/api/v4/admin/season-events/:seasonEvent/challenges/:activity/toggle-enabled', adminWriteGate, async (req, res) => {
    try {
      const seasonEventId = toIntId(req.params.seasonEvent);
      const activityId = toIntId(req.params.activity);
      if (!seasonEventId) return fail(res, 404, 'Event not found.');
      const event = await loadEvent(pool, seasonEventId);
      if (!event) return fail(res, 404, 'Event not found.');

      const existing = await loadOwnedChallenge(pool, seasonEventId, activityId);
      if (existing.error === 'not_found') return challengeNotFound(res);
      if (existing.error === 'wrong_event') return challengeWrongEvent(res);

      const nextEnabled = !existing.row.enabled;
      await pool.query('UPDATE challenges SET enabled = $1, updated_at = NOW() WHERE id = $2', [nextEnabled, activityId]);

      const { rows: freshRows } = await pool.query(`${CHALLENGE_JOIN_SELECT} WHERE c.id = $1`, [activityId]);
      return ok(res, { data: buildChallengeRawWithTemplate(freshRows[0]) }, {
        message: `Challenge ${nextEnabled ? 'enabled' : 'disabled'} successfully.`,
      });
    } catch (err) {
      log.error('topochain-admin', 'PATCH .../toggle-enabled failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PATCH .../challenges/:activity/toggle-completed (SPEC 2704-2708) ─
  router.patch('/api/v4/admin/season-events/:seasonEvent/challenges/:activity/toggle-completed', adminWriteGate, async (req, res) => {
    try {
      const seasonEventId = toIntId(req.params.seasonEvent);
      const activityId = toIntId(req.params.activity);
      if (!seasonEventId) return fail(res, 404, 'Event not found.');
      const event = await loadEvent(pool, seasonEventId);
      if (!event) return fail(res, 404, 'Event not found.');

      const existing = await loadOwnedChallenge(pool, seasonEventId, activityId);
      if (existing.error === 'not_found') return challengeNotFound(res);
      if (existing.error === 'wrong_event') return challengeWrongEvent(res);

      const nextCompleted = !existing.row.completed;
      await pool.query('UPDATE challenges SET completed = $1, updated_at = NOW() WHERE id = $2', [nextCompleted, activityId]);

      const { rows: freshRows } = await pool.query(`${CHALLENGE_JOIN_SELECT} WHERE c.id = $1`, [activityId]);
      return ok(res, { data: buildChallengeRawWithTemplate(freshRows[0]) }, {
        message: `Challenge marked as ${nextCompleted ? 'completed' : 'not completed'}.`,
      });
    } catch (err) {
      log.error('topochain-admin', 'PATCH .../toggle-completed failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PATCH .../challenges/:activity/move (SPEC 2710-2729) ─────────────
  //
  // THE FIX (SPEC 2729's ⚠ "re-points zkPassport completions but NOT the
  // awarded activities" note, §4.8 item 7): `user_activities` rows earned
  // for this challenge are re-pointed to the target event too, inside the
  // SAME transaction as the challenge's own move, and the count is
  // reported back in `meta.user_activities_repointed`.
  //
  // JUDGMENT CALL (documented, ambiguous in SPEC): the confirmation
  // message's literal source wording is "Challenge moved from phase 1 to
  // phase 2." — read here as describing two EVENTS (this whole D-group
  // already renames phase -> event in its path, ownership 404, and every
  // other message), not two literal phase names, so it becomes "Challenge
  // moved from event <fromId> to event <toId>." rather than being kept
  // verbatim with "phase" wording.
  router.patch('/api/v4/admin/season-events/:seasonEvent/challenges/:activity/move', adminWriteGate, async (req, res) => {
    const client = await pool.connect();
    try {
      const seasonEventId = toIntId(req.params.seasonEvent);
      const activityId = toIntId(req.params.activity);
      if (!seasonEventId) return fail(res, 404, 'Event not found.');
      const event = await loadEvent(client, seasonEventId);
      if (!event) return fail(res, 404, 'Event not found.');

      const existing = await loadOwnedChallenge(client, seasonEventId, activityId);
      if (existing.error === 'not_found') return challengeNotFound(res);
      if (existing.error === 'wrong_event') return challengeWrongEvent(res);

      const body = req.body || {};
      const targetSeasonEventId = toIntId(body.target_season_event_id);
      if (!targetSeasonEventId) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { target_season_event_id: ['The target_season_event_id field is required.'] },
        });
      }
      const targetEvent = await loadEvent(client, targetSeasonEventId);
      if (!targetEvent) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { target_season_event_id: ['The selected target_season_event_id is invalid.'] },
        });
      }
      if (targetSeasonEventId === seasonEventId) {
        return fail(res, 422, 'Target event is the same as the current event.');
      }

      await client.query('BEGIN');
      try {
        await client.query(
          'UPDATE challenges SET season_event_id = $1, updated_at = NOW() WHERE id = $2',
          [targetSeasonEventId, activityId]
        );
        const { rows: repointedRows } = await client.query(
          'UPDATE user_activities SET season_event_id = $1, updated_at = NOW() WHERE challenge_id = $2 RETURNING id',
          [targetSeasonEventId, activityId]
        );
        await client.query('COMMIT');

        const { rows: freshRows } = await client.query(`${CHALLENGE_JOIN_SELECT} WHERE c.id = $1`, [activityId]);
        return ok(res, { data: buildChallengeRawWithTemplate(freshRows[0]) }, {
          meta: {
            from_season_event_id: seasonEventId,
            to_season_event_id: targetSeasonEventId,
            user_activities_repointed: repointedRows.length,
          },
          message: `Challenge moved from event ${seasonEventId} to event ${targetSeasonEventId}.`,
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } catch (err) {
      log.error('topochain-admin', 'PATCH .../move failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = { challengesAdminRoutes };
