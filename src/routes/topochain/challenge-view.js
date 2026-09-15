// Topochain v4 — shared challenge_templates / challenges row-shaping
// (Task 12; SPEC 2534-2745 D4/D6, public.js's own GET /season-events/
// {event}/challenges at SPEC 1161-1204).
//
// WHY THIS FILE EXISTS: the admin D6 group (admin/challenges.js) must
// return "the same mapped structure as the public challenges endpoint"
// (SPEC 2672) for its index route, AND "the raw challenge row with its
// activity_type" (SPEC 2680/2690) for create/update/toggle/move/reorder.
// Both shapes need the identical challenges⋈challenge_templates JOIN and
// the identical challenge_templates projection. Task 5 (public.js) wrote
// this mapping first; rather than let admin/challenges.js grow a second,
// inevitably-drifting copy, the mapping is lifted out here and BOTH
// public.js and admin/challenges.js (plus admin/challenge-templates.js,
// which needs the bare template projection for its own CRUD responses
// and for D6's GET .../available-activity-types) import from this one
// module. Nothing here talks to Express or `res` — pure row -> JSON shape
// functions plus the SQL fragments the callers' own queries interpolate.
'use strict';

const { iso, num } = require('./helpers');

// ─── challenge_templates projection ────────────────────────────────────

// Every challenge_templates column this v4 surface exposes, in table
// order (schema.sql). `formatTemplate` reads these as PLAIN (unprefixed)
// column names, so it works directly on a raw `SELECT * FROM
// challenge_templates` row (D4's own CRUD, D6's available-activity-types).
function formatTemplate(row) {
  return {
    id: Number(row.id),
    category: row.category,
    goal: row.goal,
    task: row.task,
    reward: row.reward,
    description: row.description,
    requirements: row.requirements,
    schedule_start: iso(row.schedule_start),
    schedule_end: iso(row.schedule_end),
    reward_logic: row.reward_logic,
    cta_button: row.cta_button,
    cta_label: row.cta_label,
    cta_link: row.cta_link,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    kind: row.kind,
    cta_type: row.cta_type,
    mobile_cta_type: row.mobile_cta_type,
    mobile_cta_label: row.mobile_cta_label,
    mobile_cta_link: row.mobile_cta_link,
    metric_type: row.metric_type,
    metric_target: num(row.metric_target),
    metric_label: row.metric_label,
    // A built-in or uploaded illustration slug, or null. `?? null` because a row read before the
    // column existed (or a caller that selects an explicit list) has no key.
    illustration: row.illustration ?? null,
    // The tone of an UPLOADED illustration (challenge_illustrations.tone),
    // selected beside the row by D4's own GETs or by the joined fragment below
    // (t_illustration_tone). Null for a built-in slug, whose tone lives in the
    // client registry, for no illustration, and for a query that did not
    // select it.
    illustration_tone: row.illustration_tone ?? null,
  };
}

// The `ct.<col> AS t_<col>` fragment for a `challenges c LEFT JOIN
// challenge_templates ct ON ct.id = c.challenge_template_id` query — the
// `t_` prefix keeps every template column from colliding with the
// challenge row's own same-named columns (kind, cta_type, description,
// ... both tables carry these) in the same result row.
const TEMPLATE_JOIN_COLUMNS_SQL = `
                ct.id AS t_id, ct.category AS t_category, ct.goal AS t_goal, ct.task AS t_task,
                ct.reward AS t_reward, ct.description AS t_description,
                ct.requirements AS t_requirements, ct.schedule_start AS t_schedule_start,
                ct.schedule_end AS t_schedule_end, ct.reward_logic AS t_reward_logic,
                ct.cta_button AS t_cta_button, ct.cta_label AS t_cta_label, ct.cta_link AS t_cta_link,
                ct.created_at AS t_created_at, ct.updated_at AS t_updated_at, ct.kind AS t_kind,
                ct.cta_type AS t_cta_type, ct.mobile_cta_type AS t_mobile_cta_type,
                ct.mobile_cta_label AS t_mobile_cta_label, ct.mobile_cta_link AS t_mobile_cta_link,
                ct.metric_type AS t_metric_type, ct.metric_target AS t_metric_target,
                ct.metric_label AS t_metric_label, ct.illustration AS t_illustration,
                (SELECT ci.tone FROM challenge_illustrations ci
                  WHERE ci.slug = ct.illustration) AS t_illustration_tone`.trim();

// `r` is one joined row (`t_*` aliases present) -> the same shape
// `formatTemplate` returns, without a second DB round trip.
function templateProjectionFromJoinedRow(r) {
  return formatTemplate({
    id: r.t_id,
    category: r.t_category,
    goal: r.t_goal,
    task: r.t_task,
    reward: r.t_reward,
    description: r.t_description,
    requirements: r.t_requirements,
    schedule_start: r.t_schedule_start,
    schedule_end: r.t_schedule_end,
    reward_logic: r.t_reward_logic,
    cta_button: r.t_cta_button,
    cta_label: r.t_cta_label,
    cta_link: r.t_cta_link,
    created_at: r.t_created_at,
    updated_at: r.t_updated_at,
    kind: r.t_kind,
    cta_type: r.t_cta_type,
    mobile_cta_type: r.t_mobile_cta_type,
    mobile_cta_label: r.t_mobile_cta_label,
    mobile_cta_link: r.t_mobile_cta_link,
    metric_type: r.t_metric_type,
    metric_target: r.t_metric_target,
    metric_label: r.t_metric_label,
    illustration: r.t_illustration,
    illustration_tone: r.t_illustration_tone,
  });
}

// ─── public challenge-list mapping (SPEC 1161-1204) ────────────────────

// The 11 fields `challenges` can override onto `challenge_templates`
// (SPEC 1176-1179, 1203): kind/cta_type/mobile_cta_*/metric_*/
// display_order/completed/featured are deliberately excluded from this
// override set — for THIS mapped shape they come straight off the
// template (via `activity_type`/`t_*`), never the challenge row, even
// though v4 also lets admin set them directly on the challenge row
// itself (SPEC 2664's v4 fix, used by the "raw row" shape below, not
// this one).
const OVERRIDE_KEYS = [
  'goal', 'task', 'reward', 'description', 'requirements',
  'schedule_start', 'schedule_end', 'reward_logic',
  'cta_button', 'cta_label', 'cta_link',
];
const DATE_OVERRIDE_KEYS = new Set(['schedule_start', 'schedule_end']);

// `r` is one joined challenges+challenge_templates row (challenge columns
// unprefixed, template columns `t_`-prefixed per TEMPLATE_JOIN_COLUMNS_SQL).
function buildOverridesAndEffective(r) {
  const overrides = {};
  const effective = {};
  for (const key of OVERRIDE_KEYS) {
    const challengeVal = r[key];
    const templateVal = r[`t_${key}`];
    const isDate = DATE_OVERRIDE_KEYS.has(key);
    overrides[key] = isDate ? iso(challengeVal) : (challengeVal ?? null);
    const effRaw = challengeVal != null ? challengeVal : templateVal;
    effective[key] = isDate ? iso(effRaw) : (effRaw ?? null);
  }
  overrides.enabled = r.enabled;
  effective.enabled = r.enabled;
  return { overrides, effective };
}

// The public GET /season-events/{event}/challenges list-item shape:
// `overrides`, `effective`, `card_preview`, `detail_modal`, plus the
// template under `activity_type`. Shared verbatim by admin/challenges.js's
// own index route (SPEC 2672: "the same mapped structure").
//
// `completed` is the ORGANISER's "this challenge is over" flag on the
// challenges row — never a per-user completion (the per-user signal is
// user_activities; see src/routes/home-panels.js's DONE_SQL). It is
// published here so the public challenge grid can group and count finished
// challenges for EVERY viewer, signed in or not: before this, the web
// grid's "Completed" chip came only from the session-authed
// /challenges-api personalization pass, so an anonymous visitor saw no
// completion state at all. Coerced with `=== true` rather than passed
// through, because not every caller's row carries the column and an
// `undefined` in the payload would make the client's grouping ambiguous.
function buildChallengeListItem(r) {
  const template = templateProjectionFromJoinedRow(r);
  const { overrides, effective } = buildOverridesAndEffective(r);
  return {
    id: Number(r.id),
    season_event_id: Number(r.season_event_id),
    challenge_template_id: Number(r.challenge_template_id),
    enabled: r.enabled,
    completed: r.completed === true,
    activity_type: template,
    overrides,
    effective,
    card_preview: {
      label: (r.t_category || '').toUpperCase(),
      goal: effective.goal,
      task: effective.task,
      reward: effective.reward,
      // #1914: the kind's icon, when the caller's query joined it. Home's
      // panel has always had one; the public challenge list did not, so the
      // Challenges screen drew an empty tile for every card. Callers that do
      // not select `kind_icon` (the admin index routes) simply get null.
      icon: r.kind_icon || null,
      // The TEMPLATE's artwork slug, never overridden: a challenge row has no
      // illustration of its own, so it is not in OVERRIDE_KEYS. Null when the
      // template has none, and when the challenge has no template at all.
      illustration: r.t_illustration ?? null,
      // An uploaded illustration's tone, from the same template. The client
      // honours it only for an uploaded slug and only when it is one of its
      // twelve tones; a built-in slug keeps the tone its registry gives it.
      illustration_tone: r.t_illustration_tone ?? null,
    },
    detail_modal: {
      description: effective.description,
      requirements: effective.requirements,
      reward_logic: effective.reward_logic,
      cta_button: effective.cta_button,
      cta_type: r.t_cta_type,
      cta_label: effective.cta_label,
      cta_link: effective.cta_link,
      mobile_cta_type: r.t_mobile_cta_type,
      mobile_cta_label: r.t_mobile_cta_label,
      mobile_cta_link: r.t_mobile_cta_link,
    },
  };
}

// ─── admin "raw challenge row" mapping (SPEC 2680/2690/2694 …) ─────────

// Every `challenges` column (schema.sql order), read as PLAIN (unprefixed)
// names — works on a joined row too, since the challenge columns in that
// query are selected unprefixed (only the template side gets `t_`).
function formatChallengeRaw(r) {
  return {
    id: Number(r.id),
    season_event_id: Number(r.season_event_id),
    challenge_template_id: Number(r.challenge_template_id),
    goal: r.goal,
    task: r.task,
    reward: r.reward,
    description: r.description,
    requirements: r.requirements,
    schedule_start: iso(r.schedule_start),
    schedule_end: iso(r.schedule_end),
    reward_logic: r.reward_logic,
    cta_button: r.cta_button,
    cta_label: r.cta_label,
    cta_link: r.cta_link,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    enabled: r.enabled,
    display_order: Number(r.display_order),
    completed: r.completed,
    kind: r.kind,
    cta_type: r.cta_type,
    mobile_cta_type: r.mobile_cta_type,
    mobile_cta_label: r.mobile_cta_label,
    mobile_cta_link: r.mobile_cta_link,
    metric_type: r.metric_type,
    metric_target: num(r.metric_target),
    metric_label: r.metric_label,
    featured: r.featured,
    featured_order: r.featured_order != null ? Number(r.featured_order) : null,
  };
}

// THE FIX (SPEC 2690's ⚠ "activity_type is missing from this response
// because the refreshed model drops the loaded relation" — the
// `fresh()`-bug §4.8 item 7 calls out by name): every admin D6 write
// response (create/update/toggle-enabled/toggle-completed/move/
// update-display-orders) uses THIS, built off one JOINed row, so
// `activity_type` is always present.
function buildChallengeRawWithTemplate(joinedRow) {
  return { ...formatChallengeRaw(joinedRow), activity_type: templateProjectionFromJoinedRow(joinedRow) };
}

module.exports = {
  formatTemplate,
  TEMPLATE_JOIN_COLUMNS_SQL,
  templateProjectionFromJoinedRow,
  buildChallengeListItem,
  formatChallengeRaw,
  buildChallengeRawWithTemplate,
};
