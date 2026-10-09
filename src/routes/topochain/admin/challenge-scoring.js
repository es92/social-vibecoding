// Topochain admin API — automatic challenge scoring.
//
// Two things an operator needs and had no way to get: the rules that decide
// which challenges are scored automatically, and a way to see what the
// scorer is doing between runs.
//
// The rules are ordinary CRUD over `challenge_scoring_rules`. What a rule
// composes is the CONFIGURATION of a measure the platform implements — which
// measure, which challenge, the target and the points — never the logic
// itself. That boundary is the point: this replaces a system where an admin
// authored the scoring logic (an LLM prompt, or a JSON step-DAG) and nobody
// could review or test what would happen before a season ran on it.
//
// GET returns the whole screen in one response — the measures catalogue, the
// rules with the challenges each one covers and why each is or is not being
// scored right now, and the last few runs. One request rather than four,
// because every part of it is small and they are only ever read together.
//
// The one thing fetched apart is a rule's ANATOMY (what a run of it reads,
// whether a model is called, what stops it paying twice): it depends on the
// numbers in the form as they are being typed, and the rubric it prints is
// the grader's own function called with them, which only the server can do.
//
// Reads are covered by the router-wide adminReadGate in ../admin.js; every
// mutation below carries adminWriteGate like the rest of the admin surface.
'use strict';

const { Router } = require('express');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { adminWriteGate } = require('./auth');
const { toIntId, toBool, toNumber } = require('./util');
const { ok, fail, iso, num } = require('../helpers');
const rules = require('../../../services/topochain/challenge-rules');
const scorer = require('../../../services/topochain/challenge-scorer');
const { anatomy } = require('../../../services/topochain/challenge-anatomy');

const RULES_SQL = `
  SELECT r.*, ct.goal AS template_goal, ct.category AS template_category,
         c.id AS bound_challenge_id, bct.goal AS challenge_goal
    FROM challenge_scoring_rules r
    LEFT JOIN challenge_templates ct ON ct.id = r.challenge_template_id
    LEFT JOIN challenges c ON c.id = r.challenge_id
    LEFT JOIN challenge_templates bct ON bct.id = c.challenge_template_id
   ORDER BY r.id ASC
`;

const RUNS_SQL = `
  SELECT id, started_at, finished_at, trigger, dry_run, credits, summary, error
    FROM challenge_scorer_runs
   ORDER BY started_at DESC
   LIMIT 10
`;

// The live picture per rule: which challenges it covers and, for each, the
// reason it is not being scored right now (or null, meaning it is). This is
// the screen's most useful column — "window has not started" and "no target"
// are the two mistakes an operator actually makes, and without this they
// would show up as silence.
async function ruleStatus(pool, now = Date.now()) {
  const { rows } = await pool.query(scorer.RULE_CHALLENGES_SQL, [scorer.ONBOARDING_LIMIT]);
  const byRule = new Map();
  for (const row of rows) {
    const rule = {
      id: row.rule_id,
      measure: row.measure,
      target: row.rule_target,
      points: row.rule_points,
      enabled: row.rule_enabled,
    };
    const list = byRule.get(Number(row.rule_id)) || [];
    const window = rules.resolveWindow(row, { now });
    list.push({
      challenge_id: Number(row.challenge_id),
      season_event_id: Number(row.season_event_id),
      goal: row.t_goal,
      target: num(rules.effectiveTarget(rule, row)),
      points: num(rules.effectivePoints(rule, row)),
      window_start: iso(window.startMs == null ? null : new Date(window.startMs)),
      window_end: iso(window.endMs == null ? null : new Date(window.endMs)),
      skipped: rules.skipReason(rule, row, { now }),
    });
    byRule.set(Number(row.rule_id), list);
  }
  return byRule;
}

// `defaultMinutes` is the deployment's interval, which a rule with none of
// its own follows. Passed in rather than read here so the formatter stays a
// function of its arguments; the write routes format a row they have just
// stored and leave the derived fields to the next GET.
function formatRule(row, covers, { defaultMinutes = null } = {}) {
  const cadence = { intervalMinutes: row.interval_minutes, lastScoredAt: row.last_scored_at };
  const next = rules.nextDueAt(cadence, { defaultMinutes });
  return {
    id: Number(row.id),
    name: row.name,
    measure: row.measure,
    challenge_template_id: row.challenge_template_id == null ? null : Number(row.challenge_template_id),
    challenge_id: row.challenge_id == null ? null : Number(row.challenge_id),
    bound_to: row.challenge_template_id != null
      ? { kind: 'template', label: row.template_goal || `Template #${row.challenge_template_id}` }
      : { kind: 'challenge', label: row.challenge_goal || `Challenge #${row.challenge_id}` },
    target: num(row.target),
    points: num(row.points),
    enabled: row.enabled === true,
    notes: row.notes || null,
    // The rule's own interval (null follows the default), the one it really
    // runs on (null when the schedule is off), and the two times the screen
    // says back: when it last ran to its end, and when it is next due.
    interval_minutes: row.interval_minutes == null ? null : Number(row.interval_minutes),
    effective_interval_minutes: rules.effectiveInterval(cadence, defaultMinutes),
    last_scored_at: iso(row.last_scored_at),
    next_due_at: next == null ? null : iso(new Date(next)),
    last_pass: row.last_pass || null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    covers: covers || [],
  };
}

function formatRun(row) {
  return {
    id: Number(row.id),
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    trigger: row.trigger,
    dry_run: row.dry_run === true,
    credits: Number(row.credits) || 0,
    summary: row.summary || null,
    error: row.error || null,
  };
}

// Create and update share one validator. `fields` holds only the keys the
// body actually sent, so update can build its SET list from it and create can
// tell "omitted" from "explicitly null".
function parseRuleFields(body, { required }) {
  const details = {};
  const fields = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) {
      details.name = ['The name field is required and must be at most 120 characters.'];
    } else {
      fields.name = name;
    }
  } else if (required) {
    details.name = ['The name field is required.'];
  }

  if (body.measure !== undefined) {
    if (!rules.MEASURES[body.measure]) {
      details.measure = [`The measure must be one of: ${rules.MEASURE_KEYS.join(', ')}.`];
    } else {
      fields.measure = body.measure;
    }
  } else if (required) {
    details.measure = ['The measure field is required.'];
  }

  // Exactly one binding. The DB carries the same rule as a CHECK; this is
  // what turns it into a sentence the operator can read.
  const templateId = body.challenge_template_id === undefined || body.challenge_template_id === null
    || body.challenge_template_id === '' ? null : toIntId(body.challenge_template_id);
  const challengeId = body.challenge_id === undefined || body.challenge_id === null
    || body.challenge_id === '' ? null : toIntId(body.challenge_id);
  const sentTemplate = body.challenge_template_id !== undefined;
  const sentChallenge = body.challenge_id !== undefined;
  if (sentTemplate || sentChallenge || required) {
    if (!templateId && !challengeId) {
      details.challenge_template_id = ['Bind the rule to a challenge template or to one challenge.'];
    } else if (templateId && challengeId) {
      details.challenge_template_id = ['Bind the rule to a template or to one challenge, not both.'];
    } else {
      fields.challenge_template_id = templateId;
      fields.challenge_id = challengeId;
    }
  }

  for (const key of ['target', 'points']) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === '') { fields[key] = null; continue; }
    const n = toNumber(body[key]);
    if (n === undefined || !(n > 0)) {
      details[key] = [`The ${key} field must be a number above 0, or blank to use the challenge's own.`];
    } else {
      fields[key] = n;
    }
  }

  // One of the fixed choices, or blank to follow the default. Not "any
  // number": every choice is a whole number of scheduler beats, so a rule
  // cannot be saved saying one interval and then run on another.
  if (body.interval_minutes !== undefined) {
    if (body.interval_minutes === null || body.interval_minutes === '') {
      fields.interval_minutes = null;
    } else {
      const n = toNumber(body.interval_minutes);
      if (n === undefined || !rules.INTERVAL_CHOICES.includes(n)) {
        details.interval_minutes = [
          `The interval must be one of ${rules.INTERVAL_CHOICES.join(', ')} minutes, or blank to use the default.`,
        ];
      } else {
        fields.interval_minutes = n;
      }
    }
  }

  if (body.enabled !== undefined) {
    const b = toBool(body.enabled);
    if (b === undefined) details.enabled = ['The enabled field must be true or false.'];
    else fields.enabled = b;
  }

  if (body.notes !== undefined) {
    if (body.notes === null || body.notes === '') fields.notes = null;
    else if (typeof body.notes !== 'string' || body.notes.length > 2000) {
      details.notes = ['The notes field must be a string of at most 2000 characters.'];
    } else fields.notes = body.notes;
  }

  return { fields, details };
}

// Postgres refuses a second rule on the same binding (two partial uniques).
// That is a configuration mistake, not a server error, so it comes back as a
// 422 naming the field the operator has to change.
function bindingConflict(err) {
  return err && typeof err.constraint === 'string'
    && err.constraint.startsWith('challenge_scoring_rules_')
    && err.constraint.endsWith('_unique');
}

function challengeScoringAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  router.get('/api/v4/admin/challenge-scoring', async (req, res) => {
    try {
      const now = Date.now();
      const [{ rows: ruleRows }, { rows: runRows }, status] = await Promise.all([
        pool.query(RULES_SQL),
        pool.query(RUNS_SQL),
        ruleStatus(pool, now),
      ]);
      return ok(res, {
        data: {
          // The catalogue the form's Measure picker is built from, so a
          // measure the platform stops implementing disappears from the UI
          // rather than becoming a rule that silently scores nothing.
          measures: rules.MEASURE_KEYS.map((key) => ({
            key,
            label: rules.MEASURES[key].label,
            summary: rules.MEASURES[key].summary,
            // `phrase` and `payout` are what let the form read a rule back as
            // a sentence while it is being written. They travel from here
            // rather than being retyped in the screen, so the sentence cannot
            // drift from the behaviour it describes.
            phrase: rules.MEASURES[key].phrase,
            // The phrase for a target of one, where the plural would not
            // read ("Try an app", #3570). Null where `phrase` already does.
            phrase_one: rules.MEASURES[key].phraseOne || null,
            payout: rules.MEASURES[key].payout,
            target_unit: rules.MEASURES[key].targetUnit,
            needs_target: rules.MEASURES[key].needsTarget === true,
            counted: rules.MEASURES[key].counted === true,
            graded: rules.MEASURES[key].graded === true,
            windowed: rules.MEASURES[key].windowed === true,
          })),
          rules: ruleRows.map((r) => formatRule(r, status.get(Number(r.id)), {
            defaultMinutes: scorer.intervalMinutes(config),
          })),
          runs: runRows.map(formatRun),
          schedule: {
            // The interval a rule follows when it has none of its own; 0 is
            // the whole schedule switched off, whatever a rule asks for.
            interval_minutes: scorer.intervalMinutes(config),
            interval_choices: rules.INTERVAL_CHOICES,
            aggregate_hours: scorer.aggregateHours(config),
            grading_configured: !!(config && config.anthropicApiKey),
          },
        },
      });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/challenge-scoring failed', { message: err.message });
      return fail(res, 500, 'Failed to read the challenge scoring rules.');
    }
  });

  router.post('/api/v4/admin/challenge-scoring/rules', adminWriteGate, async (req, res) => {
    const { fields, details } = parseRuleFields(req.body || {}, { required: true });
    if (Object.keys(details).length) {
      return fail(res, 422, 'The given data was invalid.', { details });
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO challenge_scoring_rules
           (name, measure, challenge_template_id, challenge_id, target, points, enabled, notes, created_by,
            interval_minutes)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE), $8, $9, $10)
         RETURNING *`,
        [fields.name, fields.measure, fields.challenge_template_id, fields.challenge_id,
          fields.target ?? null, fields.points ?? null,
          fields.enabled === undefined ? null : fields.enabled,
          fields.notes ?? null, req.user ? req.user.id : null,
          fields.interval_minutes ?? null]
      );
      return res.status(201).json({ success: true, data: formatRule(rows[0], []) });
    } catch (err) {
      if (bindingConflict(err)) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { challenge_template_id: ['A rule already scores this challenge. Edit that one instead.'] },
        });
      }
      log.error('topochain-admin', 'POST /admin/challenge-scoring/rules failed', { message: err.message });
      return fail(res, 500, 'Failed to create the rule.');
    }
  });

  router.put('/api/v4/admin/challenge-scoring/rules/:id', adminWriteGate, async (req, res) => {
    const id = toIntId(req.params.id);
    if (!id) return fail(res, 404, 'Rule not found.');
    const { fields, details } = parseRuleFields(req.body || {}, { required: false });
    if (Object.keys(details).length) {
      return fail(res, 422, 'The given data was invalid.', { details });
    }
    const keys = Object.keys(fields);
    if (!keys.length) return fail(res, 422, 'The given data was invalid.', { details: { name: ['Nothing to update.'] } });
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    try {
      const { rows } = await pool.query(
        `UPDATE challenge_scoring_rules SET ${set}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, ...keys.map((k) => fields[k])]
      );
      if (!rows.length) return fail(res, 404, 'Rule not found.');
      return ok(res, { data: formatRule(rows[0], []) });
    } catch (err) {
      if (bindingConflict(err)) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { challenge_template_id: ['A rule already scores this challenge. Edit that one instead.'] },
        });
      }
      log.error('topochain-admin', 'PUT /admin/challenge-scoring/rules failed', { message: err.message });
      return fail(res, 500, 'Failed to update the rule.');
    }
  });

  // Deleting a rule stops future scoring and leaves every credit it already
  // wrote in place. Points people have earned are theirs; an operator who
  // wants them gone removes the ledger rows in User activities, deliberately.
  router.delete('/api/v4/admin/challenge-scoring/rules/:id', adminWriteGate, async (req, res) => {
    const id = toIntId(req.params.id);
    if (!id) return fail(res, 404, 'Rule not found.');
    try {
      const { rowCount } = await pool.query('DELETE FROM challenge_scoring_rules WHERE id = $1', [id]);
      if (!rowCount) return fail(res, 404, 'Rule not found.');
      return ok(res, { message: 'Rule deleted. Credits it already wrote are untouched.' });
    } catch (err) {
      log.error('topochain-admin', 'DELETE /admin/challenge-scoring/rules failed', { message: err.message });
      return fail(res, 500, 'Failed to delete the rule.');
    }
  });

  // How a rule scores, for the rule detail. Read-only and pure: a measure and
  // the two numbers in, the steps out. The numbers are the form's own as they
  // stand — typed, or inherited from the challenge — so the rubric shown is
  // the rubric the grader would be sent for exactly that rule.
  router.get('/api/v4/admin/challenge-scoring/anatomy', (req, res) => {
    const measure = typeof req.query.measure === 'string' ? req.query.measure : '';
    if (!rules.MEASURES[measure]) return fail(res, 404, 'No such measure.');
    const number = (v) => { const n = toNumber(v); return n !== undefined && n > 0 ? n : null; };
    return ok(res, { data: anatomy(measure, { points: number(req.query.points), target: number(req.query.target) }) });
  });

  // Run now, and its preview. A dry run does every read and every plan, skips
  // grading (a preview must not spend model calls) and writes nothing — so an
  // operator can see what a rule WOULD pay before letting it.
  //
  // adminWriteGate on both: a dry run writes a `challenge_scorer_runs` row and
  // is a season-affecting operator action either way.
  router.post('/api/v4/admin/challenge-scoring/run', adminWriteGate, async (req, res) => {
    const dryRun = (req.body || {}).dry_run === true;
    try {
      const result = await scorer.runOnce(pool, { trigger: 'admin', dryRun, config });
      return ok(res, {
        data: result,
        message: dryRun
          ? `Preview only: ${result.credits} credit(s) would be written.`
          : `${result.credits} credit(s) written.`,
      });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/challenge-scoring/run failed', { message: err.message });
      return fail(res, 500, 'The scoring run failed.');
    }
  });

  return router;
}

module.exports = { challengeScoringAdminRoutes, parseRuleFields, formatRule };
