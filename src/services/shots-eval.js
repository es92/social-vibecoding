'use strict';

// Before & after shots EVALS: try the shots agent with another model, prompt
// or time budget on proposals that have already merged, and compare what it
// saves with what the live shots agent saves on the same proposals, in the
// same batch. Driven by an admin through the connector (services/mcp-tools.js,
// routes/shots-evals.js); docs/proposal-visuals/shots-evals.md has the whole
// flow.
//
//   CONFIGURATIONS  shots_eval_configs: immutable, versioned recipes (the
//       model, the system prompt whole or the live one, guidance added after
//       it, the task prompt, the agent's time budget). The live shots agent
//       is no row: it is what the deployment runs now, and every eval runs
//       it as its CONTROL.
//   EVALS           shots_eval_runs: a batch of merged proposals, each shot
//       by the control and by each named configuration, `repeats` times,
//       within a cap. A proposal's revisions and declared changes are
//       frozen at launch from its own published run, so every arm shoots
//       the same thing. The control runs again in the batch rather than
//       reusing the published shots: the copies are made from today's data,
//       so only a control run beside the others compares like with like.
//   TRIALS          shots_eval_trials: one proposal, one arm, one repetition.
//       The shots-eval machine (src/workflow/shots-eval/) grants and runs
//       them through the shots pipeline's own steps (shots-orchestrator.js
//       buildCopies, dispatchAgent, compareScreens, cleanupRun), with their
//       own state and storage, billed to the platform (billFor).
//   PAIRS           shots_eval_pairs: a configuration's trial beside the
//       control's, blind and in a random order, for an admin's pick and for
//       marks on each ready change (does it show its claim; is it
//       misleading). They feed each configuration's win rate against the
//       control and its judged numbers.
//
// Everything a trial saved or wrote (its shots, its skip reasons and notes,
// the agent's last words) and every proposal title and claim is untrusted
// data; the connector wraps it.

const crypto = require('crypto');
const planContract = require('./visible-changes');
const shotsAgent = require('./shots-agent');
const shotsFiles = require('./shots-files');
const { wilson } = require('./bot-configs');

const MODEL_RE = /^claude-[a-z0-9][a-z0-9-]{0,62}$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_LABEL_CHARS = 80;
const MAX_NOTES_CHARS = 1000;
const MAX_SYSTEM_PROMPT_CHARS = 40_000;
const MAX_GUIDANCE_CHARS = 8_000;
const MAX_TASK_PROMPT_CHARS = 4_000;
const MIN_AGENT_MINUTES = 2;
const MAX_AGENT_MINUTES = 20;

const MAX_PROPOSALS = 25;
const MAX_CONFIGS = 4;
const MAX_REPEATS = 3;
const MAX_TRIALS = 75;
const MIN_CAP_USD = 0.5;
const MAX_CAP_USD = 500;
// What one trial is reckoned to cost before there is a history to go by:
// the shots agent's turn on the platform's key. Builds and copies are the
// platform's own and not counted.
const DEFAULT_TRIAL_CENTS = 300;
const ESTIMATE_HISTORY = 50;

const ACTIVE_STATES = Object.freeze(['provisioning', 'exploring', 'reviewing']);
const TERMINAL_STATES = Object.freeze(['verified', 'failed', 'cancelled']);
// A trial that failed for one of these failed because of what its arm did
// (no change shot, a change found broken, the agent's time ran out), so it
// counts in the numbers like a verified one. Any other failure is the
// platform's (a build, a database copy, the worker dying) and is counted
// apart, on every arm alike.
const COUNTED_FAILURES = Object.freeze(['shots_capture_incomplete', 'shots_change_failed', 'shots_agent_timeout']);

const MAX_IMAGES = 16;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_PAIR_IMAGES_PER_SIDE = 8;
const SHOWS = Object.freeze(['yes', 'partly', 'no']);

function httpError(status, error, extra = {}) {
  return { ok: false, status, error, ...extra };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sha12(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex').slice(0, 12);
}

function slugOf(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function newAttemptId() {
  return crypto.randomBytes(16).toString('hex');
}

function cleanText(value, max, field) {
  if (value == null) return { value: null };
  if (typeof value !== 'string') return { error: `${field} is text` };
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text) return { value: null };
  if (text.length > max) return { error: `${field} is at most ${max} characters (it is ${text.length})` };
  return { value: text };
}

// ── Recipes ─────────────────────────────────────────────────────────────

/**
 * A recipe as saved: only what it changes from the live shots agent. Pure.
 * { ok, recipe } or an httpError.
 */
function validateRecipe(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return httpError(400, 'recipe is an object');
  const recipe = {};
  if (raw.model != null && raw.model !== '') {
    const model = String(raw.model).trim();
    if (!MODEL_RE.test(model)) return httpError(400, 'model is a Claude model id, such as claude-sonnet-5-5');
    recipe.model = model;
  }
  for (const [field, max] of [['systemPrompt', MAX_SYSTEM_PROMPT_CHARS], ['guidance', MAX_GUIDANCE_CHARS],
    ['taskPrompt', MAX_TASK_PROMPT_CHARS]]) {
    const cleaned = cleanText(raw[field], max, field);
    if (cleaned.error) return httpError(400, cleaned.error);
    if (cleaned.value) recipe[field] = cleaned.value;
  }
  if (raw.agentMinutes != null) {
    const minutes = Number(raw.agentMinutes);
    if (!Number.isInteger(minutes) || minutes < MIN_AGENT_MINUTES || minutes > MAX_AGENT_MINUTES) {
      return httpError(400, `agentMinutes is a whole number from ${MIN_AGENT_MINUTES} to ${MAX_AGENT_MINUTES}`);
    }
    recipe.agentMinutes = minutes;
  }
  if (!Object.keys(recipe).length) {
    return httpError(400, 'A recipe changes at least one thing from the live shots agent: model, systemPrompt, guidance, taskPrompt or agentMinutes');
  }
  return { ok: true, recipe };
}

/**
 * What a trial runs with: the recipe over the live shots agent (`recipe`
 * null is the live agent itself, the control). `summary` is what the trial
 * records and the connector shows: the model, each prompt's hash and length
 * and whether it is the live one, and the budget. Pure.
 */
function resolveRecipe(config, recipe = null) {
  const r = recipe && typeof recipe === 'object' ? recipe : {};
  const model = r.model || shotsAgent.agentModel(config);
  const baseSystem = r.systemPrompt || shotsAgent.SYSTEM_PROMPT;
  const systemPrompt = r.guidance ? `${baseSystem}\n\n${r.guidance}` : baseSystem;
  const taskPrompt = r.taskPrompt || shotsAgent.TASK_PROMPT;
  const budgetMs = r.agentMinutes ? r.agentMinutes * 60_000 : (Number(config?.shots?.maxAgentMs) || 480_000);
  return {
    model,
    systemPrompt,
    taskPrompt,
    budgetMs,
    summary: {
      live: !recipe,
      model,
      systemPrompt: { live: !r.systemPrompt, sha: sha12(baseSystem), chars: baseSystem.length },
      guidanceChars: r.guidance ? r.guidance.length : 0,
      taskPrompt: { live: !r.taskPrompt, sha: sha12(taskPrompt), chars: taskPrompt.length },
      agentMinutes: Math.round(budgetMs / 6000) / 10,
    },
  };
}

function liveRecipe(config, { prompts = false } = {}) {
  const resolved = resolveRecipe(config, null);
  return {
    model: resolved.model,
    agentMinutes: resolved.summary.agentMinutes,
    systemPrompt: prompts ? shotsAgent.SYSTEM_PROMPT : { sha: resolved.summary.systemPrompt.sha, chars: resolved.summary.systemPrompt.chars },
    taskPrompt: prompts ? shotsAgent.TASK_PROMPT : { sha: resolved.summary.taskPrompt.sha, chars: resolved.summary.taskPrompt.chars },
  };
}

function recipeOut(recipe, { prompts = false } = {}) {
  const r = recipe || {};
  const text = (value) => (value ? (prompts ? value : { sha: sha12(value), chars: value.length }) : null);
  return {
    model: r.model || null,
    systemPrompt: text(r.systemPrompt),
    guidance: text(r.guidance),
    taskPrompt: text(r.taskPrompt),
    agentMinutes: r.agentMinutes || null,
  };
}

function configOut(row, { prompts = false } = {}) {
  return {
    id: Number(row.id),
    key: row.key,
    version: Number(row.version),
    label: row.label,
    recipe: recipeOut(row.recipe, { prompts }),
    notes: row.notes || null,
    createdAt: row.created_at || null,
  };
}

/** The live shots agent and every saved configuration, newest first. */
async function listConfigs(pool, config, { prompts = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id, key, version, label, recipe, notes, created_at
       FROM shots_eval_configs ORDER BY id DESC LIMIT 200`
  );
  return { ok: true, live: liveRecipe(config, { prompts }), configs: rows.map((row) => configOut(row, { prompts })) };
}

/**
 * Save a configuration: the next version of `key`, or of a new key made
 * from the label. A version is never edited.
 */
async function saveConfig(pool, { key = null, label = null, recipe, notes = null, actorId = null } = {}) {
  const v = validateRecipe(recipe);
  if (!v.ok) return v;
  const cleanLabel = label == null ? null : String(label).replace(/\s+/g, ' ').trim();
  if (cleanLabel != null && (!cleanLabel || cleanLabel.length > MAX_LABEL_CHARS)) {
    return httpError(400, `label is 1 to ${MAX_LABEL_CHARS} characters`);
  }
  const k = key ? String(key).trim().toLowerCase() : slugOf(cleanLabel);
  if (!KEY_RE.test(k)) return httpError(400, 'key is 1 to 40 lower-case letters, digits or dashes (or give a label to make one from)');
  const cleanNotes = notes == null ? null : String(notes).trim().slice(0, MAX_NOTES_CHARS) || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('shots_eval_configs'))");
    const { rows: [prev] } = await client.query(
      `SELECT MAX(version)::int AS version, (ARRAY_AGG(label ORDER BY version DESC))[1] AS label
         FROM shots_eval_configs WHERE key = $1`,
      [k]
    );
    const version = (Number(prev?.version) || 0) + 1;
    const finalLabel = cleanLabel || prev?.label || k;
    const { rows: [row] } = await client.query(
      `INSERT INTO shots_eval_configs (key, version, label, recipe, notes, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       RETURNING id, key, version, label, recipe, notes, created_at`,
      [k, version, finalLabel, JSON.stringify(v.recipe), cleanNotes, actorId]
    );
    await client.query('COMMIT');
    return { ok: true, config: configOut(row) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Launching ───────────────────────────────────────────────────────────

/**
 * What one trial is reckoned to cost: the 90th percentile of what the last
 * trials cost, or DEFAULT_TRIAL_CENTS before there are enough of them.
 */
async function estimateTrialCents(pool) {
  const { rows } = await pool.query(
    `SELECT cost_cents::float8 AS cents FROM shots_eval_trials
      WHERE state IN ('verified', 'failed') AND cost_cents > 0
      ORDER BY completed_at DESC NULLS LAST LIMIT $1`,
    [ESTIMATE_HISTORY]
  );
  const costs = rows.map((r) => Number(r.cents)).filter((c) => Number.isFinite(c) && c > 0).sort((a, b) => a - b);
  if (costs.length < 5) return DEFAULT_TRIAL_CENTS;
  return Math.max(1, Math.ceil(costs[Math.min(costs.length - 1, Math.ceil(0.9 * costs.length) - 1)]));
}

// A merged proposal's own published run, as a trial's frozen inputs: its
// exact revisions and the declared changes it was shot from. Refused, with
// why, when there is nothing a trial could shoot.
function proposalInputs(row) {
  if (!row) return { why: 'no such proposal' };
  if (row.status !== 'merged') return { why: 'not merged (an eval shoots merged proposals only)' };
  if (!row.run_id) return { why: 'it has no before/after shots run to take its revisions and declared changes from' };
  if (!/^[0-9a-f]{40}$/.test(String(row.base_sha || '')) || !/^[0-9a-f]{40}$/.test(String(row.head_sha || ''))) {
    return { why: 'its shots run has no exact before and after revisions' };
  }
  const parsed = planContract.safeParseIntent(row.intent);
  const intent = parsed.ok ? parsed.value : null;
  if (!intent) return { why: 'its declared changes do not parse' };
  if (intent.impact === 'none' || !Array.isArray(intent.stories) || !intent.stories.length) {
    return { why: 'it declared no visible change' };
  }
  return { sessionId: Number(row.id), baseSha: row.base_sha, headSha: row.head_sha, intent };
}

async function launch(pool, config, {
  sessionIds = null, sameProposalsAs = null, configIds = [], repeats = 1, capUsd, label = null, actorId = null,
} = {}) {
  const reps = repeats == null ? 1 : Number(repeats);
  if (!Number.isInteger(reps) || reps < 1 || reps > MAX_REPEATS) return httpError(400, `repeats is 1 to ${MAX_REPEATS}`);
  const cap = Number(capUsd);
  if (!Number.isFinite(cap) || cap < MIN_CAP_USD || cap > MAX_CAP_USD) {
    return httpError(400, `capUsd is from $${MIN_CAP_USD} to $${MAX_CAP_USD}`);
  }
  const ids = Array.isArray(configIds) ? configIds.map(Number) : [];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    return httpError(400, 'configIds are distinct configuration ids');
  }
  if (ids.length > MAX_CONFIGS) return httpError(400, `At most ${MAX_CONFIGS} configurations beside the live agent`);
  const cleanLabel = label == null ? null : String(label).replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS) || null;

  let proposals = [];
  if (sameProposalsAs != null) {
    const from = Number(sameProposalsAs);
    if (!Number.isInteger(from) || from <= 0) return httpError(400, 'sameProposalsAs is an eval id');
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (t.session_id) t.session_id, t.base_sha, t.head_sha, t.intent
         FROM shots_eval_trials t
        WHERE t.eval_run_id = $1
        ORDER BY t.session_id, t.id`,
      [from]
    );
    if (!rows.length) return httpError(404, `No eval ${from}, or it has no proposals`);
    const order = await pool.query(
      'SELECT session_id, MIN(position) AS first FROM shots_eval_trials WHERE eval_run_id = $1 GROUP BY session_id ORDER BY MIN(position)',
      [from]
    );
    const byId = new Map(rows.map((r) => [Number(r.session_id), r]));
    proposals = order.rows.map((o) => byId.get(Number(o.session_id))).filter(Boolean).map((r) => ({
      sessionId: Number(r.session_id), baseSha: r.base_sha, headSha: r.head_sha, intent: r.intent,
    }));
  } else {
    const wanted = Array.isArray(sessionIds) ? sessionIds.map(Number) : [];
    if (!wanted.length) return httpError(400, 'Name the proposals: sessionIds (from list_recent_shots), or sameProposalsAs an earlier eval');
    if (wanted.some((id) => !Number.isInteger(id) || id <= 0) || new Set(wanted).size !== wanted.length) {
      return httpError(400, 'sessionIds are distinct proposal ids');
    }
    if (wanted.length > MAX_PROPOSALS) return httpError(400, `At most ${MAX_PROPOSALS} proposals in one eval`);
    const { rows } = await pool.query(
      `SELECT cs.id, cs.status, r.id AS run_id, r.base_sha, r.head_sha, r.intent
         FROM chat_sessions cs
         LEFT JOIN shot_runs r ON r.id = cs.shots_run_id
        WHERE cs.id = ANY($1::int[])`,
      [wanted]
    );
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const refused = [];
    for (const id of wanted) {
      const inputs = proposalInputs(byId.get(id));
      if (inputs.why) refused.push({ sessionId: id, why: inputs.why });
      else proposals.push(inputs);
    }
    if (refused.length) {
      return httpError(400, `Nothing was launched. ${refused.map((r) => `Proposal ${r.sessionId}: ${r.why}.`).join(' ')}`, { refused });
    }
  }

  let configs = [];
  if (ids.length) {
    const { rows } = await pool.query(
      'SELECT id, key, version, label FROM shots_eval_configs WHERE id = ANY($1::int[])',
      [ids]
    );
    const found = new Set(rows.map((r) => Number(r.id)));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) return httpError(404, `No shots configuration ${missing.join(', ')}`);
    configs = ids.map((id) => rows.find((r) => Number(r.id) === id));
  }

  const arms = [null, ...ids];
  const trialCount = proposals.length * arms.length * reps;
  if (trialCount > MAX_TRIALS) {
    return httpError(400, `That is ${trialCount} trials; one eval runs at most ${MAX_TRIALS}. Name fewer proposals, configurations or repeats.`);
  }
  const perTrialCents = await estimateTrialCents(pool);
  const capCents = Math.round(cap * 100);
  if (capCents < perTrialCents) {
    return httpError(400, `A cap of $${cap} is under one trial's estimate ($${(perTrialCents / 100).toFixed(2)}). Nothing was launched.`);
  }
  const estCents = perTrialCents * trialCount;

  const client = await pool.connect();
  let run;
  try {
    await client.query('BEGIN');
    ({ rows: [run] } = await client.query(
      `INSERT INTO shots_eval_runs (label, config_ids, repeats, cap_cents, est_cents, created_by)
       VALUES ($1, $2::int[], $3, $4, $5, $6)
       RETURNING id, label, status, config_ids, repeats, cap_cents, est_cents, created_at`,
      [cleanLabel || `Shots eval of ${proposals.length} proposal${proposals.length === 1 ? '' : 's'}`,
        ids, reps, capCents, estCents, actorId]
    ));
    // A proposal's arms run back to back, so they shoot copies of nearly the
    // same data; a repetition comes after every proposal's first round.
    let position = 0;
    for (let rep = 1; rep <= reps; rep += 1) {
      for (const p of proposals) {
        for (const configId of arms) {
          position += 1;
          await client.query(
            `INSERT INTO shots_eval_trials
               (eval_run_id, session_id, config_id, repetition, position, attempt_id, base_sha, head_sha, intent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            [run.id, p.sessionId, configId, rep, position, newAttemptId(), p.baseSha, p.headSha, JSON.stringify(p.intent)]
          );
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return {
    ok: true,
    eval: {
      id: Number(run.id), label: run.label, status: run.status, repeats: reps,
      proposals: proposals.map((p) => p.sessionId),
      arms: [{ arm: 'control', configId: null, label: 'live shots agent' },
        ...configs.map((c) => ({ arm: `config-${c.id}`, configId: Number(c.id), label: `${c.label} v${c.version}` }))],
      trials: trialCount,
      capUsd: capCents / 100,
      estimateUsd: estCents / 100,
      perTrialUsd: perTrialCents / 100,
    },
  };
}

function platform() {
  return require('../workflow/platform.ts');
}

/** The eval machine looks again (an eval launched). Never throws: its clock looks anyway. */
async function look(deps = {}) {
  try {
    await (deps.platform || platform()).evalLook();
  } catch (err) {
    require('./logger').warn('shots-eval', 'Could not ask the eval machine to look', { err: err.message });
  }
}

// Cancel what has not finished: the eval machine's decision. A trial
// already running is stopped (its work cancelled, its turn stopped by its
// record) and cleaned up; its cost lands when its cleanup is done.
async function cancelRun(pool, runId, deps = {}) {
  const id = Number(runId);
  const out = await (deps.platform || platform()).evalCancel(id, deps.userId);
  if (out.status === 'rejected') {
    if (out.reason === 'not_authorized') return httpError(403, 'Your current permissions do not allow that action');
    return httpError(out.reason === 'no_eval' ? 404 : 409, 'That eval is not running');
  }
  if (out.status === 'faulted') return httpError(503, 'The eval could not be cancelled just now. Try again.');
  const { rows: [n] } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM shots_eval_trials WHERE eval_run_id = $1 AND state = 'cancelled'", [id]);
  return { ok: true, cancelled: Number(n?.n) || 0 };
}

/**
 * The arm a trial runs, resolved against the deployment's own (its
 * configuration's recipe, or the live agent for the control), and its
 * summary kept on the trial's attempt. Resolves what resolveRecipe does.
 */
async function trialRecipe(pool, config, trialId, attemptId) {
  const { rows: [trial] } = await pool.query(
    'SELECT c.recipe FROM shots_eval_trials t LEFT JOIN shots_eval_configs c ON c.id = t.config_id WHERE t.id = $1',
    [Number(trialId)]);
  const resolved = resolveRecipe(config, trial?.recipe || null);
  await pool.query('UPDATE shots_eval_trials SET recipe = $2::jsonb WHERE id = $1 AND attempt_id = $3',
    [Number(trialId), JSON.stringify(resolved.summary), String(attemptId)]);
  return resolved;
}

/**
 * A trial's files, kept (the eval machine's compare step): its attempt's
 * shots, light only (#4459: its dark shots are skipped, so the table's
 * six-column unique needs no theme), on the trial, replacing what an
 * earlier attempt kept. Only while that attempt is the trial's and its
 * shots under way. Resolves how many.
 */
async function storeTrialFiles(pool, trialId, attemptId, slots, { store = require('./media-store').getStore() } = {}) {
  const files = await require('./shots-control').filesFor(pool, attemptId, slots, { withData: false, store });
  const newId = require('./shots-state').newId;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [row] } = await client.query(
      `SELECT id FROM shots_eval_trials WHERE id = $1 AND attempt_id = $2 AND state IN ('exploring', 'reviewing') FOR UPDATE`,
      [Number(trialId), String(attemptId)]);
    if (!row) throw Object.assign(new Error('This trial no longer owns its shots; they were discarded.'), { code: 'stale_shots_operation' });
    await client.query('DELETE FROM shots_eval_artifacts WHERE trial_id = $1', [Number(trialId)]);
    // Dark shots and close-ups (shots-closeups.js) are extras an eval does not judge.
    const kept = files.filter((a) => a?.theme !== 'dark' && a?.variant !== 'closeup');
    for (const a of kept) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO shots_eval_artifacts
           (id, trial_id, story_id, viewport, side, variant, media, content_type,
            width, height, bytes, sha256, focus_rect, object_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
        [newId(), Number(trialId), a.storyId, a.viewport, a.side, a.variant, a.media, a.contentType,
          a.width, a.height, a.bytes, a.sha256, a.focusRect ? JSON.stringify(a.focusRect) : null, a.objectKey]);
    }
    await client.query('COMMIT');
    return kept.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Whether a model call on `sessionId` is a shots eval trial's, and so the
 * platform's to pay, bounded by the eval's cap (routes/anthropic-proxy.js).
 * Read from the session's turn record, whichever process the call reaches
 * and whether or not the process that dispatched it is still alive: a shots
 * turn the eval machine's work owns is the attempt its work names, on any
 * attempt of its trial. Any other turn on the session (the proposal's own
 * shots, a person's) is not. Resolves null, or
 * `{ trialId, overCap(extraCents), noteSpend(cents) }`: the cap read from
 * the eval's spend and what its attempts not yet settled have cost. The
 * calls go on the attempt's costs (workflow/shots-eval/costs.ts: one after
 * its end charges only what it adds).
 */
async function billFor(pool, sessionId) {
  const { rows: [s] } = await pool.query('SELECT active_turn FROM chat_sessions WHERE id = $1', [Number(sessionId)]);
  let turn = s?.active_turn || null;
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { turn = null; } }
  if (!turn || turn.mode !== 'shots' || !turn.owner) return null;
  if (turn.owner.machine !== 'shots-eval') return null;
  const m = /^agent:(\d+):([0-9a-f]{32}):/.exec(String(turn.owner.workKey || ''));
  if (!m) return null;
  const trialId = Number(m[1]);
  const attemptId = m[2];
  const { rows: [t] } = await pool.query(
    `SELECT t.id, r.cap_cents::float8 AS cap,
            (r.spent_cents
             + COALESCE((SELECT SUM(GREATEST(c.proxy_cents, c.reported_cents)) FROM shots_eval_attempt_costs c
                          JOIN shots_eval_trials o ON o.id = c.trial_id
                         WHERE o.eval_run_id = r.id AND c.settled_at IS NULL), 0))::float8 AS spent
       FROM shots_eval_trials t JOIN shots_eval_runs r ON r.id = t.eval_run_id
      WHERE t.id = $1`,
    [trialId]);
  if (!t) return null;
  const capCents = num(t.cap);
  let spentCents = num(t.spent);
  return {
    trialId: Number(t.id),
    overCap: (extraCents = 0) => capCents > 0 && spentCents + (Number(extraCents) || 0) > capCents,
    async noteSpend(costCents) {
      const cents = Number(costCents);
      if (!(Number.isFinite(cents) && cents > 0)) return;
      spentCents += cents;
      await addCost(pool, { trialId: Number(t.id), attemptId, proxyCents: cents });
    },
  };
}

/** What Claude Code reported a dispatch of a trial's attempt cost, on its costs (the eval machine's agent work). */
async function noteReported(pool, trialId, attemptId, cents) {
  await addCost(pool, { trialId: Number(trialId), attemptId: String(attemptId), reportedCents: Number(cents) });
}

// An attempt's costs added to, in a transaction of their own (costs.ts).
async function addCost(pool, p) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await require('../workflow/shots-eval/costs.ts').addCost(client, p);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Reading results ─────────────────────────────────────────────────────

function armOf(row) {
  return row.config_id == null ? 'control' : `config-${Number(row.config_id)}`;
}

function armLabel(row) {
  return row.config_id == null ? 'live shots agent' : `${row.config_label || row.config_key || 'configuration'} v${Number(row.config_version) || 1}`;
}

// How each declared change came out on a trial: from its verdict, or, for
// a trial that ended without one, every change it did not get to.
function changeResults(row) {
  const intent = row.intent || {};
  const stories = Array.isArray(intent.stories) ? intent.stories : [];
  const verdict = row.hard_verdict && Array.isArray(row.hard_verdict.stories) ? row.hard_verdict.stories : [];
  return stories.map((story) => {
    const result = verdict.find((v) => v && v.id === story.id);
    if (!result) {
      return { id: story.id, status: TERMINAL_STATES.includes(row.state) && row.state !== 'cancelled' ? 'skipped' : null, reason: null, note: null };
    }
    return {
      id: story.id,
      status: shotsFiles.resultStatus(result),
      reason: result.reason ? String(result.reason).slice(0, 1000) : null,
      note: result.note ? String(result.note).slice(0, 500) : null,
    };
  });
}

function counted(row) {
  return row.state === 'verified' || (row.state === 'failed' && COUNTED_FAILURES.includes(row.failure_code));
}

function platformFailed(row) {
  return row.state === 'failed' && !COUNTED_FAILURES.includes(row.failure_code);
}

function sumCounts(obj) {
  return obj && typeof obj === 'object' ? Object.values(obj).reduce((s, v) => s + (Number(v) || 0), 0) : 0;
}

function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/** One trial as the connector lists it. */
function trialOut(row) {
  const timings = row.timings || {};
  return {
    trialId: Number(row.id),
    sessionId: Number(row.session_id),
    prNumber: row.pr_number == null ? null : Number(row.pr_number),
    app: row.app_slug || null,
    title: row.pr_title || null,
    arm: armOf(row),
    armLabel: armLabel(row),
    repetition: Number(row.repetition),
    state: row.state,
    changes: changeResults(row),
    costUsd: round2(num(row.cost_cents) / 100),
    agentMinutes: timings.agentExploration != null ? round1(num(timings.agentExploration) / 60000) : null,
    totalMinutes: timings.total != null ? round1(num(timings.total) / 60000) : null,
    toolCalls: sumCounts(row.tool_counts) || null,
    failureCode: row.failure_code || null,
    failureReason: row.failure_reason || null,
    lastWords: row.state === 'failed' && row.last_words ? String(row.last_words).slice(0, 1500) : null,
    platformFailure: platformFailed(row),
  };
}

// One arm's numbers over its counted trials, and its picks and marks.
function armStats(rows, pairs, arm) {
  const mine = rows.filter((r) => armOf(r) === arm);
  const done = mine.filter(counted);
  const changes = { declared: 0, ready: 0, unchanged: 0, skipped: 0, failed: 0 };
  for (const row of done) {
    for (const c of changeResults(row)) {
      changes.declared += 1;
      if (c.status && changes[c.status] != null) changes[c.status] += 1;
      else changes.skipped += 1;
    }
  }
  const costs = done.map((r) => num(r.cost_cents) / 100).filter((c) => c > 0);
  const agentMs = done.map((r) => num(r.timings?.agentExploration)).filter((x) => x > 0);
  const totalMs = done.map((r) => num(r.timings?.total)).filter((x) => x > 0);
  const tools = done.map((r) => sumCounts(r.tool_counts)).filter((x) => x > 0);
  const marks = { judged: 0, yes: 0, partly: 0, no: 0, misleading: 0 };
  let wins = 0; let ties = 0; let losses = 0;
  const excluded = {};
  for (const p of pairs) {
    const side = p.armTrialArm === arm ? 'arm' : (arm === 'control' ? 'control' : null);
    if (!side) continue;
    if (p.status === 'excluded') {
      if (arm !== 'control') excluded[p.excluded_reason || 'excluded'] = (excluded[p.excluded_reason || 'excluded'] || 0) + 1;
      continue;
    }
    if (p.status !== 'picked') continue;
    if (arm !== 'control') {
      if (p.pick === 'tie') ties += 1;
      else if (p.pick === 'arm') wins += 1;
      else losses += 1;
    }
    const sideMarks = p.marks && typeof p.marks === 'object' ? p.marks[side] : null;
    for (const m of Object.values(sideMarks || {})) {
      if (!m || !SHOWS.includes(m.shows)) continue;
      marks.judged += 1;
      marks[m.shows] += 1;
      if (m.misleading === true) marks.misleading += 1;
    }
  }
  const n = wins + ties + losses;
  return {
    arm,
    trials: {
      total: mine.length,
      planned: mine.filter((r) => r.state === 'planned').length,
      running: mine.filter((r) => ACTIVE_STATES.includes(r.state)).length,
      counted: done.length,
      platformFailed: mine.filter(platformFailed).length,
      cancelled: mine.filter((r) => r.state === 'cancelled').length,
    },
    changes,
    readyRate: wilson(changes.ready, changes.declared),
    avgCostUsd: costs.length ? round2(costs.reduce((s, c) => s + c, 0) / costs.length) : null,
    medianAgentMinutes: agentMs.length ? round1(median(agentMs) / 60000) : null,
    medianTotalMinutes: totalMs.length ? round1(median(totalMs) / 60000) : null,
    avgToolCalls: tools.length ? round1(tools.reduce((s, c) => s + c, 0) / tools.length) : null,
    ...(arm === 'control' ? {} : { vsControl: { wins, ties, losses, ...wilson(wins + ties / 2, n), excluded } }),
    marks: { ...marks, showsRate: wilson(marks.yes, marks.judged) },
  };
}

const TRIAL_SELECT = `
  SELECT t.id, t.eval_run_id, t.session_id, t.config_id, t.repetition, t.position, t.state, t.intent,
         t.hard_verdict, t.recipe, t.failure_code, t.failure_reason, t.cost_cents::float8 AS cost_cents,
         t.trace_summary->'timingsMs' AS timings,
         t.trace_summary->'agentActivity'->'toolCounts' AS tool_counts,
         COALESCE(t.trace_summary->'agentFinalResponse'->>'excerpt',
                  t.trace_summary->'agentFinalResponses'->-1->>'excerpt') AS last_words,
         t.started_at, t.completed_at,
         c.key AS config_key, c.version AS config_version, c.label AS config_label,
         cs.pr_number, cs.pr_title, a.slug AS app_slug
    FROM shots_eval_trials t
    LEFT JOIN shots_eval_configs c ON c.id = t.config_id
    JOIN chat_sessions cs ON cs.id = t.session_id
    LEFT JOIN apps a ON a.id = cs.app_id`;

function runOut(run) {
  return {
    id: Number(run.id),
    label: run.label,
    status: run.status,
    repeats: Number(run.repeats),
    configIds: (run.config_ids || []).map(Number),
    capUsd: num(run.cap_cents) / 100,
    estimateUsd: num(run.est_cents) / 100,
    spentUsd: round2(num(run.spent_cents) / 100),
    createdAt: run.created_at || null,
    finishedAt: run.finished_at || null,
  };
}

/** The evals, newest first, each with its progress. */
async function listRuns(pool, { limit = 20 } = {}) {
  const max = Math.max(1, Math.min(50, Number(limit) || 20));
  const { rows } = await pool.query(
    `SELECT r.id, r.label, r.status, r.config_ids, r.repeats, r.cap_cents, r.est_cents,
            r.spent_cents::float8 AS spent_cents, r.created_at, r.finished_at,
            COUNT(t.id)::int AS trials,
            COUNT(t.id) FILTER (WHERE t.state IN ('verified', 'failed'))::int AS finished,
            COUNT(t.id) FILTER (WHERE t.state IN ('provisioning', 'exploring', 'reviewing'))::int AS running,
            COUNT(DISTINCT t.session_id)::int AS proposals,
            (SELECT COUNT(*) FROM shots_eval_pairs p WHERE p.eval_run_id = r.id AND p.status = 'waiting')::int AS pairs_waiting
       FROM shots_eval_runs r
       LEFT JOIN shots_eval_trials t ON t.eval_run_id = r.id
      GROUP BY r.id
      ORDER BY r.id DESC
      LIMIT $1`,
    [max]
  );
  return {
    ok: true,
    evals: rows.map((r) => ({
      ...runOut(r), proposals: r.proposals, trials: r.trials, finished: r.finished, running: r.running,
      pairsWaiting: r.pairs_waiting,
    })),
  };
}

/** One eval: each arm's numbers, then every trial in launch order. */
async function getRun(pool, runId) {
  const id = Number(runId);
  const { rows: [run] } = await pool.query(
    `SELECT id, label, status, config_ids, repeats, cap_cents, est_cents, spent_cents::float8 AS spent_cents,
            created_at, finished_at
       FROM shots_eval_runs WHERE id = $1`,
    [id]
  );
  if (!run) return httpError(404, `No eval ${id}`);
  const { rows } = await pool.query(`${TRIAL_SELECT} WHERE t.eval_run_id = $1 ORDER BY t.position`, [id]);
  const { rows: pairRows } = await pool.query(
    `SELECT p.status, p.excluded_reason, p.pick, p.marks, arm.config_id AS arm_config_id
       FROM shots_eval_pairs p
       JOIN shots_eval_trials arm ON arm.id = p.arm_trial_id
      WHERE p.eval_run_id = $1`,
    [id]
  );
  const pairs = pairRows.map((p) => ({ ...p, armTrialArm: `config-${Number(p.arm_config_id)}` }));
  const configs = new Map();
  for (const row of rows) {
    if (row.config_id != null && !configs.has(Number(row.config_id))) {
      configs.set(Number(row.config_id), { configId: Number(row.config_id), label: armLabel(row), recipe: row.recipe || null });
    }
  }
  const armList = ['control', ...(run.config_ids || []).map((c) => `config-${Number(c)}`)];
  return {
    ok: true,
    eval: runOut(run),
    arms: armList.map((arm) => {
      const configId = arm === 'control' ? null : Number(arm.slice(7));
      const sample = rows.find((r) => armOf(r) === arm && r.recipe);
      return {
        ...armStats(rows, pairs, arm),
        configId,
        label: arm === 'control' ? 'live shots agent' : (configs.get(configId)?.label || `configuration ${configId}`),
        ranWith: sample?.recipe || null,
      };
    }),
    pairs: {
      waiting: pairs.filter((p) => p.status === 'waiting').length,
      picked: pairs.filter((p) => p.status === 'picked').length,
      excluded: pairs.filter((p) => p.status === 'excluded').length,
    },
    trials: rows.map(trialOut),
  };
}

// ── Looking at the shots ────────────────────────────────────────────────

function imageOf(r, caption) {
  const data = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data || '');
  return {
    caption,
    mimeType: r.content_type || 'image/png',
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    data: data.toString('base64'),
    bytes: data.length,
  };
}

/**
 * One proposal's shots in an eval, every arm side by side: for each declared
 * change and screen, each arm's before and after (the published shots
 * first, when asked and there are some). Narrow it with `change`,
 * `viewport`, `side`; `variant` is the whole screen ("context", the
 * default, the same framing on every arm) or the element shot ("focus").
 */
async function proposalShots(pool, runId, {
  sessionId, change = null, viewport = null, side = null, variant = 'context', repetition = 1, published = true,
} = {}) {
  const id = Number(runId);
  const sid = Number(sessionId);
  if (!Number.isInteger(sid) || sid <= 0) return httpError(400, 'sessionId is the proposal to look at');
  if (!['context', 'focus'].includes(variant)) return httpError(400, 'variant is context or focus');
  if (side != null && !['before', 'after'].includes(side)) return httpError(400, 'side is before or after');
  const rep = Number(repetition) || 1;
  const { rows: trials } = await pool.query(
    `${TRIAL_SELECT} WHERE t.eval_run_id = $1 AND t.session_id = $2 AND t.repetition = $3 ORDER BY t.position`,
    [id, sid, rep]
  );
  if (!trials.length) return httpError(404, `Eval ${id} has no trial of proposal ${sid} (repetition ${rep})`);
  const sideCode = side === 'before' ? 'base' : side === 'after' ? 'head' : null;
  const { rows: files } = await pool.query(
    `SELECT trial_id, story_id, viewport, side, variant, content_type, object_key, bytes, width, height
       FROM shots_eval_artifacts
      WHERE trial_id = ANY($1::int[]) AND media = 'png' AND variant = $2
        AND ($3::text IS NULL OR story_id = $3::text)
        AND ($4::text IS NULL OR viewport = $4::text)
        AND ($5::text IS NULL OR side = $5::text)`,
    [trials.map((t) => Number(t.id)), variant, change, viewport, sideCode]
  );
  const arms = trials.map((t) => ({ key: armOf(t), label: armLabel(t), trialId: Number(t.id), changes: changeResults(t), state: t.state }));
  let publishedFiles = [];
  let publishedState = null;
  if (published) {
    const { rows: [s] } = await pool.query(
      'SELECT shots_run_id, shots_state FROM chat_sessions WHERE id = $1',
      [sid]
    );
    publishedState = s?.shots_state || null;
    if (s?.shots_run_id && s.shots_state === 'verified') {
      ({ rows: publishedFiles } = await pool.query(
        `SELECT story_id, viewport, side, variant, content_type, object_key, bytes, width, height
           FROM shot_artifacts
          WHERE run_id = $1 AND media = 'png' AND variant = $2
            AND ($3::text IS NULL OR story_id = $3::text)
            AND ($4::text IS NULL OR viewport = $4::text)
            AND ($5::text IS NULL OR side = $5::text)`,
        [s.shots_run_id, variant, change, viewport, sideCode]
      ));
    }
  }
  // Ordered so one screen's arms sit together: change, screen, arm, then
  // before before after.
  const intent = trials[0].intent || {};
  const storyOrder = new Map((intent.stories || []).map((s, i) => [s.id, i]));
  const armOrder = new Map([['published', -1], ...arms.map((a, i) => [a.trialId, i])]);
  const all = [
    ...publishedFiles.map((f) => ({ ...f, armKey: 'published', armLabel: 'published shots', order: -1 })),
    ...files.map((f) => {
      const arm = arms.find((a) => a.trialId === Number(f.trial_id));
      return { ...f, armKey: arm.key, armLabel: arm.label, order: armOrder.get(arm.trialId) };
    }),
  ].sort((a, b) => (storyOrder.get(a.story_id) ?? 99) - (storyOrder.get(b.story_id) ?? 99)
    || String(a.viewport).localeCompare(String(b.viewport))
    || a.order - b.order
    || (a.side === 'base' ? 0 : 1) - (b.side === 'base' ? 0 : 1));
  const images = [];
  const store = require('./media-store').getStore();
  let total = 0;
  let leftOut = 0;
  for (const f of all) {
    const bytes = Number(f.bytes);
    if (!bytes) continue;
    if (images.length >= MAX_IMAGES || total + bytes > MAX_IMAGE_BYTES) { leftOut += 1; continue; }
    f.data = await require('./media-store').bytes(store, f);
    total += bytes;
    images.push(imageOf(f, `${String(f.story_id).slice(0, 96)} · ${f.viewport} · ${f.armLabel} · ${f.side === 'base' ? 'before' : 'after'}`));
  }
  return {
    ok: true,
    evalId: id,
    sessionId: sid,
    prNumber: trials[0].pr_number == null ? null : Number(trials[0].pr_number),
    title: trials[0].pr_title || null,
    claims: (intent.stories || []).map((s) => ({ id: s.id, claim: s.claim, viewports: (s.viewports || []).map((v) => v.name) })),
    published: published ? { state: publishedState, files: publishedFiles.length } : null,
    arms: arms.map(({ key, label, trialId, changes, state }) => ({ arm: key, label, trialId, state, changes })),
    images,
    leftOut,
  };
}

// ── Blind pairs ─────────────────────────────────────────────────────────

function hasReady(row) {
  return changeResults(row).some((c) => c.status === 'ready');
}

// Why a pair is not offered, or null. Pure.
function exclusionOf(control, arm) {
  if (platformFailed(control) && platformFailed(arm)) return 'platform_failed_both';
  if (platformFailed(control)) return 'platform_failed_control';
  if (platformFailed(arm)) return 'platform_failed_arm';
  if (!hasReady(control) && !hasReady(arm)) return 'neither_ready';
  return null;
}

/**
 * Make the pairs of an eval whose two trials have both finished: each
 * configuration's trial beside the control's of the same proposal and
 * repetition. Idempotent.
 */
async function settlePairs(pool, runId, { random = crypto.randomInt } = {}) {
  const { rows } = await pool.query(
    `SELECT t.id, t.session_id, t.config_id, t.repetition, t.state, t.intent, t.hard_verdict, t.failure_code
       FROM shots_eval_trials t
      WHERE t.eval_run_id = $1 AND t.state IN ('verified', 'failed')
        AND NOT EXISTS (SELECT 1 FROM shots_eval_pairs p WHERE p.arm_trial_id = t.id)`,
    [Number(runId)]
  );
  const { rows: controls } = await pool.query(
    `SELECT t.id, t.session_id, t.config_id, t.repetition, t.state, t.intent, t.hard_verdict, t.failure_code
       FROM shots_eval_trials t
      WHERE t.eval_run_id = $1 AND t.config_id IS NULL AND t.state IN ('verified', 'failed')`,
    [Number(runId)]
  );
  let made = 0;
  for (const arm of rows) {
    if (arm.config_id == null) continue;
    const control = controls.find((c) => Number(c.session_id) === Number(arm.session_id)
      && Number(c.repetition) === Number(arm.repetition));
    if (!control) continue;
    const why = exclusionOf(control, arm);
    const { rowCount } = await pool.query(
      `INSERT INTO shots_eval_pairs (token, eval_run_id, control_trial_id, arm_trial_id, left_is_control, status, excluded_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (control_trial_id, arm_trial_id) DO NOTHING`,
      [crypto.randomBytes(12).toString('base64url'), Number(runId), control.id, arm.id,
        random(2) === 0, why ? 'excluded' : 'waiting', why]
    );
    made += rowCount || 0;
  }
  return made;
}

async function sideView(pool, trial, { images }) {
  const view = { changes: changeResults(trial).map(({ id, status, reason, note }) => ({ id, status, reason, note })), images: [] };
  if (!images) return view;
  const { rows } = await pool.query(
    `SELECT story_id, viewport, side, variant, content_type, object_key, bytes, width, height
       FROM shots_eval_artifacts
      WHERE trial_id = $1 AND media = 'png' AND variant = 'context'
      ORDER BY story_id, viewport, CASE side WHEN 'base' THEN 0 ELSE 1 END
      LIMIT 40`,
    [Number(trial.id)]
  );
  const storyOrder = new Map(((trial.intent || {}).stories || []).map((s, i) => [s.id, i]));
  rows.sort((a, b) => (storyOrder.get(a.story_id) ?? 99) - (storyOrder.get(b.story_id) ?? 99));
  let total = 0;
  const store = require('./media-store').getStore();
  for (const r of rows) {
    const bytes = Number(r.bytes);
    if (!bytes || view.images.length >= MAX_PAIR_IMAGES_PER_SIDE || total + bytes > MAX_IMAGE_BYTES / 2) continue;
    r.data = await require('./media-store').bytes(store, r);
    total += bytes;
    view.images.push(imageOf(r, `${String(r.story_id).slice(0, 96)} · ${r.viewport} · ${r.side === 'base' ? 'before' : 'after'}`));
  }
  return view;
}

/**
 * The next pair waiting for a pick (of one eval, or of any), blind: the
 * proposal's declared changes, then Left and Right, each a trial of it by a
 * different arm, with how each change came out and its whole-screen shots.
 * Nothing says which arm took which side.
 */
async function nextPair(pool, { runId = null, images = true } = {}) {
  const rid = runId == null ? null : Number(runId);
  const { rows: [p] } = await pool.query(
    `SELECT p.id, p.token, p.left_is_control, p.control_trial_id, p.arm_trial_id,
            (SELECT COUNT(*) FROM shots_eval_pairs w WHERE w.status = 'waiting'
               AND ($1::int IS NULL OR w.eval_run_id = $1::int))::int AS waiting
       FROM shots_eval_pairs p
      WHERE p.status = 'waiting' AND ($1::int IS NULL OR p.eval_run_id = $1::int)
      ORDER BY p.id LIMIT 1`,
    [rid]
  );
  if (!p) return { ok: true, pair: null, waiting: 0 };
  const { rows } = await pool.query(`${TRIAL_SELECT} WHERE t.id = ANY($1::int[])`, [[p.control_trial_id, p.arm_trial_id]]);
  const control = rows.find((r) => Number(r.id) === Number(p.control_trial_id));
  const arm = rows.find((r) => Number(r.id) === Number(p.arm_trial_id));
  if (!control || !arm) return httpError(404, 'That pair\'s trials are gone');
  const [controlView, armView] = [await sideView(pool, control, { images }), await sideView(pool, arm, { images })];
  const [left, right] = p.left_is_control ? [controlView, armView] : [armView, controlView];
  const intent = control.intent || {};
  return {
    ok: true,
    waiting: p.waiting,
    pair: {
      pairId: p.token,
      proposal: {
        sessionId: Number(control.session_id),
        title: control.pr_title || null,
        claims: (intent.stories || []).map((s) => ({
          id: s.id, claim: s.claim, persona: s.persona, viewports: (s.viewports || []).map((v) => v.name),
        })),
      },
      left,
      right,
    },
  };
}

/**
 * Record a pick on a blind pair: "left", "right" or "tie", an optional
 * note, and optional marks on the ready changes of each side ({ side, change,
 * shows: yes|partly|no, misleading }). Once per pair.
 */
async function submitPick(pool, { token, pick, note = null, marks = [], userId = null } = {}) {
  if (!['left', 'right', 'tie'].includes(pick)) return httpError(400, 'pick is left, right or tie');
  if (!TOKEN_RE.test(String(token || ''))) return httpError(400, 'Invalid pairId');
  const { rows: [p] } = await pool.query(
    `SELECT p.id, p.status, p.left_is_control, p.eval_run_id, c.intent
       FROM shots_eval_pairs p JOIN shots_eval_trials c ON c.id = p.control_trial_id
      WHERE p.token = $1`,
    [String(token)]
  );
  if (!p) return httpError(404, 'No such pair');
  if (p.status !== 'waiting') return httpError(409, 'That pair was already picked');
  const ids = new Set(((p.intent || {}).stories || []).map((s) => s.id));
  const stored = { control: {}, arm: {} };
  for (const m of Array.isArray(marks) ? marks : []) {
    if (!m || !['left', 'right'].includes(m.side)) return httpError(400, 'Each mark names its side: left or right');
    if (!ids.has(m.change)) return httpError(400, `No declared change ${JSON.stringify(String(m.change || '')).slice(0, 100)} on this proposal`);
    if (!SHOWS.includes(m.shows)) return httpError(400, 'Each mark says whether the shots show the change: yes, partly or no');
    const who = (m.side === 'left') === p.left_is_control ? 'control' : 'arm';
    stored[who][m.change] = { shows: m.shows, misleading: m.misleading === true };
  }
  const winner = pick === 'tie' ? 'tie' : ((pick === 'left') === p.left_is_control ? 'control' : 'arm');
  const { rowCount } = await pool.query(
    `UPDATE shots_eval_pairs
        SET status = 'picked', pick = $2, marks = $3::jsonb, note = $4, picked_by = $5, picked_at = NOW()
      WHERE id = $1 AND status = 'waiting'`,
    [p.id, winner, JSON.stringify(stored), note ? String(note).trim().slice(0, MAX_NOTES_CHARS) || null : null, userId]
  );
  if (!rowCount) return httpError(409, 'That pair was already picked');
  const { rows: [w] } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM shots_eval_pairs WHERE eval_run_id = $1 AND status = 'waiting'",
    [p.eval_run_id]
  );
  return { ok: true, waiting: Number(w?.n) || 0 };
}

module.exports = {
  ACTIVE_STATES,
  TERMINAL_STATES,
  COUNTED_FAILURES,
  DEFAULT_TRIAL_CENTS,
  MAX_PROPOSALS,
  MAX_CONFIGS,
  MAX_TRIALS,
  MAX_CAP_USD,
  MIN_CAP_USD,
  validateRecipe,
  resolveRecipe,
  liveRecipe,
  listConfigs,
  saveConfig,
  estimateTrialCents,
  proposalInputs,
  launch,
  cancelRun,
  look,
  trialRecipe,
  storeTrialFiles,
  billFor,
  noteReported,
  changeResults,
  exclusionOf,
  armStats,
  listRuns,
  getRun,
  proposalShots,
  settlePairs,
  nextPair,
  submitPick,
  newAttemptId,
};
