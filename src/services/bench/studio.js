'use strict';

// The App bench STUDIO: the Homeroom bot benchmark's taste eval, driven from
// an admin's connector conversation (services/mcp-tools.js "App bench
// studio") or the console (frontend/src/features/admin/admin-bench-studio.tsx).
//
// A studio run takes a few briefs, as a creator would write them, and builds
// each one's first version the way a new project's first version is built
// today (services/bench/runner.js firstVersionStage): on one or more models,
// each with or without a CONTEXT PACK (services/bench/packs.js), in
// parallel. Beside them, REFERENCE builds: apps a Claude Code session built
// from the same first commit and pack (the target the bot is measured
// against), handed in as a branch or a patch and captured the same way.
// Everything lands in a gallery, and any build can be put up as a preview
// for a day.
//
// Where it lives:
//
//   * One HOST app (bench_studio_hosts): a private project the benchmark
//     user makes through the ordinary create path the first time the studio
//     is used. Its repository carries every studio branch; its own database
//     is empty, so a preview of a studio build clones nothing anybody wrote.
//     The live bot never acts on it (it has no requests), and a benchmark
//     session on it may read the platform's conventions, as a new app's
//     first version does (services/worker.js mintHomeroomReadGrant).
//   * One SUITE, "App bench studio" (rotating, never frozen): a task per
//     distinct brief (tags.studio_key), so a brief launched again is the
//     same task and its builds line up across runs in the gallery.
//   * A studio run is a bench run of kind `studio`: its trials are the
//     lane's like any others (services/bench/lane.js), so the cap, the
//     concurrency, restart recovery and blind grading all hold. A reference
//     build is a trial of the same task whose model is `reference:<label>`.
//
// Watching is OPEN: the studio shows which model made what, because the
// person driving it is choosing what to change. Blind grading still works,
// from a session that never watched (the charter says so); the per-trial
// reads of a run that is NOT a studio run are refused while its trials wait
// for the judge (trialRows), so the classic benchmark stays blind.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('../logger');
const packs = require('./packs');
const scaffold = require('./scaffold');
const speed = require('./speed');
const stageCosts = require('../stage-costs');

const SUITE_NAME = 'App bench studio';
const HOST_KEY = 'default';
const HOST_NAME = 'App bench';
const STARTER_FILE = path.join(__dirname, 'suites', 'app-bench-starter.json');
const TODAY = 'today';
const REFERENCE_PREFIX = 'reference:';
const MAX_BRIEFS = 12;
const MAX_MODELS = 5;
const MAX_PACKS = 4;
const MAX_REFERENCES = 5;
const MAX_REPEATS = 3;
const MAX_CONCURRENCY = 6;
const MIN_CAP_USD = 0.5;
const MAX_CAP_USD = 1000;
const MAX_LIVE_PREVIEWS = 4;
const PREVIEW_HOURS = 24;
const PREVIEW_STUCK_MINUTES = 45;
const PREVIEW_SWEEP_MS = 10 * 60 * 1000;
const HOST_WAIT_MS = 90 * 1000;
const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_NOTE_CHARS = 500;
const ACTIVITY_CHARS = 200;
const GALLERY_TRIALS_PER_BRIEF = 30;
// A trial's spec as get_bench_trial gives it: whole, up to this. An HTML
// spec's markdown copy carries its drawn screens' markup, and a first
// version's can draw two full screens (~30-60K characters in all); it was
// clipped at 12,000, which cut off everything after the opening section.
const TRIAL_SPEC_CHARS = 120000;

let lastPreviewSweepAt = 0;

function httpError(status, error, extra = {}) {
  return { ok: false, status, error, ...extra };
}

function token() {
  return crypto.randomBytes(12).toString('base64url');
}

function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, ms); if (typeof t.unref === 'function') t.unref(); });
}

function clip(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function iso(v) {
  return v ? new Date(v).toISOString() : null;
}

// ── The host app ─────────────────────────────────────────────────────────

/** Whether an app is the studio's host (a benchmark session on it may read the conventions). */
async function isHostApp(pool, appId) {
  if (appId == null) return false;
  const { rows } = await pool.query('SELECT 1 FROM bench_studio_hosts WHERE app_id = $1', [Number(appId)]);
  return rows.length > 0;
}

async function hostRow(pool) {
  const { rows } = await pool.query(
    `SELECT a.id, a.slug, a.name, a.repo_url, a.status, a.self_hosted
       FROM bench_studio_hosts h JOIN apps a ON a.id = h.app_id
      WHERE h.key = $1`,
    [HOST_KEY],
  );
  return rows[0] || null;
}

/**
 * The studio's host app, made the first time it is needed: a private
 * project of the benchmark user's, created through app creation's own path
 * (services/app-creator.js createApp: its database, its repository, its
 * first deploy). Waits for its repository, which creation makes within
 * seconds; never for its deploy. Resolves { ok, app } or a refusal.
 */
async function ensureHost(pool, config, { deps = {}, waitMs = HOST_WAIT_MS, pollMs = 2000 } = {}) {
  let host = await hostRow(pool);
  if (!host) {
    const runner = require('./runner');
    const user = deps.user || await runner.ensureBenchUser(pool, config);
    const client = await pool.connect();
    let created = null;
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('bench_studio_host'))");
      const { rows: [have] } = await client.query('SELECT app_id FROM bench_studio_hosts WHERE key = $1 AND app_id IS NOT NULL', [HOST_KEY]);
      if (!have) {
        const slug = `app-bench-${crypto.randomBytes(3).toString('hex')}`;
        // The create route's own insert (routes/apps.js POST /api/apps):
        // the row and its creator's membership together, private to them.
        const { rows: [app] } = await client.query(
          `WITH new_app AS (
             INSERT INTO apps (name, slug, created_by, status, collab_visibility, view_visibility)
             VALUES ($1, $2, $3, 'creating', 'private', 'private')
             RETURNING *
           ), membership AS (
             INSERT INTO app_collaborators (app_id, user_id, status, accepted_at)
             SELECT id, $3, 'member', NOW() FROM new_app
             ON CONFLICT (app_id, user_id) DO NOTHING
           )
           SELECT * FROM new_app`,
          [HOST_NAME, slug, user.id],
        );
        await client.query(
          `INSERT INTO bench_studio_hosts (key, app_id) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET app_id = EXCLUDED.app_id`,
          [HOST_KEY, app.id],
        );
        created = app;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (created) {
      const createApp = deps.createApp || require('../app-creator').createApp;
      Promise.resolve().then(() => createApp(config, created)).catch(async (err) => {
        log.error('bench', 'The studio host app could not be made', { appId: created.id, err: err.message });
        await pool.query("UPDATE apps SET status = 'error' WHERE id = $1 AND status = 'creating'", [created.id]).catch(() => {});
      });
      log.info('bench', 'Studio host app being made', { appId: created.id, slug: created.slug });
    }
    host = await hostRow(pool);
  }
  const deadline = Date.now() + waitMs;
  while (host && !host.repo_url && host.status === 'creating' && Date.now() + pollMs <= deadline) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMs);
    // eslint-disable-next-line no-await-in-loop
    host = await hostRow(pool);
  }
  if (!host) return httpError(500, 'The studio\'s host app is missing');
  if (!host.repo_url) {
    return host.status === 'creating'
      ? httpError(409, 'The studio\'s host app is still being made. Try again in a minute.', { code: 'host_not_ready' })
      : httpError(409, `The studio's host app could not be made (${host.status}). An admin can retry it from its page.`, { code: 'host_failed' });
  }
  return { ok: true, app: host };
}

// ── The suite, and a task per brief ──────────────────────────────────────

async function ensureSuite(pool, { actorId = null } = {}) {
  const { rows: [s] } = await pool.query(
    'SELECT id, frozen_at FROM bench_suites WHERE name = $1 ORDER BY version DESC LIMIT 1',
    [SUITE_NAME],
  );
  if (s && !s.frozen_at) return s.id;
  const suites = require('./suites');
  const made = await suites.createSuite(pool, {
    name: SUITE_NAME, kind: 'rotating', actorId,
    notes: 'The App bench studio\'s briefs, one task per brief, made as they are launched (services/bench/studio.js). Never frozen.',
  });
  if (!made.ok) throw new Error(made.error);
  return made.suite.id;
}

/** The checked-in starter briefs (suites/app-bench-starter.json). */
function starterBriefs(file = STARTER_FILE) {
  const def = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (def.briefs || []).map((b) => ({
    ref: String(b.ref), appName: String(b.name), brief: String(b.brief), ...(b.template ? { template: String(b.template) } : {}),
  }));
}

/**
 * The briefs a launch names, checked: the starter set (`briefSet:
 * "starter"`, optionally narrowed by `refs`), and/or `briefs`, each
 * { name, brief, ref?, template? }, { ref, template? } (a starter brief) or
 * { taskId } (an existing taste task's brief, name and template).
 *
 * `template` is the starter the first commit is scaffolded from
 * (services/app-templates.js), `empty` when absent, as a new project's is.
 * The same brief from a game starter and from `empty` is two tasks, so a
 * run can build both side by side.
 */
async function resolveBriefs(pool, body = {}) {
  const taste = require('./taste');
  const snapshots = require('../homeroom-bot-snapshots');
  const starter = starterBriefs();
  const items = [];
  if (body.briefSet != null) {
    if (body.briefSet !== 'starter') return httpError(400, 'briefSet can only be "starter"');
    const refs = Array.isArray(body.refs) && body.refs.length ? new Set(body.refs.map(String)) : null;
    for (const b of starter) if (!refs || refs.has(b.ref)) items.push(b);
  }
  for (const raw of Array.isArray(body.briefs) ? body.briefs : []) {
    if (raw && raw.taskId != null) {
      const suites = require('./suites');
      const task = await suites.taskRow(pool, { taskId: Number(raw.taskId) });
      if (!task || !taste.isTasteStage(task.stage)) return httpError(404, `No taste task ${raw.taskId}`);
      const input = taste.inputOf(await snapshots.readSnapshot(pool, task.snapshot_id));
      items.push({ ref: task.tags?.taste_ref || null, appName: input.appName, brief: input.brief, template: input.template });
    } else if (raw && raw.ref && !raw.brief) {
      const b = starter.find((s) => s.ref === String(raw.ref));
      if (!b) return httpError(404, `No starter brief "${raw.ref}"`);
      items.push(raw.template != null ? { ...b, template: raw.template } : b);
    } else {
      items.push({
        ref: raw?.ref ? String(raw.ref).slice(0, 80) : null, appName: raw?.name ?? raw?.appName, brief: raw?.brief, template: raw?.template,
      });
    }
  }
  if (!items.length) return httpError(400, 'Name at least one brief, or briefSet "starter"');
  if (items.length > MAX_BRIEFS) return httpError(400, `At most ${MAX_BRIEFS} briefs in one launch`);
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const v = taste.validateInput('first_version', { appName: item.appName, brief: item.brief, template: item.template });
    if (!v.ok) return v;
    const key = studioKey(v.input.appName, v.input.brief, v.input.template);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref: item.ref || null, appName: v.input.appName, brief: v.input.brief, template: v.input.template, key });
  }
  return { ok: true, items: out };
}

/**
 * The key a brief's task is found by: the same name, brief and starter, the
 * same task. The default starter adds nothing, so a brief's task from before
 * starters were named is still found. Pure.
 */
function studioKey(appName, brief, template = null) {
  const appTemplates = require('../app-templates');
  const starter = template && template !== appTemplates.DEFAULT_TEMPLATE ? `\n${template}` : '';
  return crypto.createHash('sha256').update(`${appName}\n${brief}${starter}`).digest('hex').slice(0, 32);
}

async function taskFor(pool, { suiteId, host, item }) {
  const { rows: [have] } = await pool.query(
    `SELECT id, tags FROM bench_tasks
      WHERE suite_id = $1 AND stage = 'first_version' AND tags->>'studio_key' = $2
      ORDER BY id LIMIT 1`,
    [suiteId, item.key],
  );
  if (have) return { ok: true, task: have };
  const taste = require('./taste');
  const out = await taste.addTask(pool, {
    suiteId, kind: 'first_version', appSlug: host.slug, appName: item.appName, brief: item.brief, template: item.template, ref: item.ref,
  });
  if (!out.ok) return out;
  await pool.query(
    "UPDATE bench_tasks SET tags = tags || jsonb_build_object('studio_key', $2::text) WHERE id = $1",
    [out.task.id, item.key],
  );
  return { ok: true, task: out.task };
}

// ── Launching ────────────────────────────────────────────────────────────

/** A studio launch's settings, checked. Pure. */
function validateLaunch(body = {}) {
  const bot = require('../homeroom-bot');
  const models = [...new Set((Array.isArray(body.models) ? body.models : [TODAY]).map((m) => String(m || '').trim()).filter(Boolean))];
  if (!models.length) return httpError(400, 'Pick at least one model, or "today"');
  if (models.length > MAX_MODELS) return httpError(400, `At most ${MAX_MODELS} models in one studio run`);
  // `config:<id>` builds by a Homeroom bot configuration version
  // (services/bot-configs.js): its models, reviewer and pack.
  const bad = models.find((m) => m !== TODAY && !/^config:\d{1,9}$/.test(m) && !bot.MODEL_ID_RE.test(m));
  if (bad) return httpError(400, `${bad} is not an OpenRouter model id (or "today", or "config:<version id>")`);
  const packIds = body.contextPackIds == null ? [0] : [...new Set((Array.isArray(body.contextPackIds) ? body.contextPackIds : []).map(Number))];
  if (!packIds.length || packIds.length > MAX_PACKS || packIds.some((n) => !Number.isInteger(n) || n < 0)) {
    return httpError(400, `contextPackIds is 1 to ${MAX_PACKS} pack ids, 0 for no pack`);
  }
  const references = body.references == null ? 0 : Number(body.references);
  if (!Number.isInteger(references) || references < 0 || references > MAX_REFERENCES) {
    return httpError(400, `references is 0 to ${MAX_REFERENCES} per brief`);
  }
  const repeats = body.repeats == null ? 1 : Number(body.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) return httpError(400, `repeats is 1 to ${MAX_REPEATS}`);
  const capUsd = Number(body.capUsd);
  if (body.capUsd == null || !Number.isFinite(capUsd) || capUsd < MIN_CAP_USD || capUsd > MAX_CAP_USD) {
    return httpError(400, `Name the cap: capUsd from $${MIN_CAP_USD} to $${MAX_CAP_USD}`);
  }
  let concurrency = null;
  if (body.concurrency != null) {
    concurrency = Number(body.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
      return httpError(400, `concurrency is 1 to ${MAX_CONCURRENCY}`);
    }
  }
  return {
    ok: true, models, packIds, references, repeats, capUsd: Math.round(capUsd * 100) / 100, concurrency,
    note: body.note ? String(body.note).slice(0, MAX_NOTE_CHARS) : null,
  };
}

/**
 * Launch a studio run: every brief, on every model, with every pack (0: none),
 * `repeats` times, within the cap. Its trials wait for the lane; the first
 * to need a brief's first commit makes it (services/bench/scaffold.js).
 * Resolves the run, its trials, the estimate and, per brief and pack, what
 * get the reference order for it.
 */
async function launch(pool, config, body = {}, { actorId = null, deps = {} } = {}) {
  const v = validateLaunch(body);
  if (!v.ok) return v;
  // A configuration arm (`config:<id>`): its recipe, read before anything is
  // made, and what it is priced by (each stage at its own model's price, its
  // reviewer's rounds included).
  const recipes = new Map();
  for (const m of v.models) {
    const botConfigs = require('../bot-configs');
    const id = botConfigs.configIdOfModel(m);
    if (id == null) continue;
    // eslint-disable-next-line no-await-in-loop
    const version = await botConfigs.versionById(pool, id);
    const recipe = version ? botConfigs.recipeOf(version.recipe) : null;
    if (!recipe) return httpError(404, `No configuration version ${id} with a recipe that still validates`);
    recipes.set(m, recipe);
  }
  const briefs = await resolveBriefs(pool, body);
  if (!briefs.ok) return briefs;
  const loaded = await packs.loadForLaunch(pool, v.packIds);
  if (!loaded.ok) return loaded;
  const host = await ensureHost(pool, config, { deps });
  if (!host.ok) return host;
  const suiteId = await ensureSuite(pool, { actorId });
  const tasks = [];
  for (const item of briefs.items) {
    // eslint-disable-next-line no-await-in-loop
    const t = await taskFor(pool, { suiteId, host: host.app, item });
    if (!t.ok) return t;
    tasks.push({ ...item, taskId: t.task.id });
  }
  const bot = require('../homeroom-bot');
  const catalog = require('./catalog');
  const settings = await bot.readSettings(pool);
  const priced = (m) => (m === TODAY ? bot.stageModel(settings, config, 'build') : m);
  const models = await catalog.listModels(pool, [
    ...v.models.filter((m) => !recipes.has(m)).map(priced).filter(Boolean),
    ...[...recipes.values()].flatMap((r) => catalog.recipeModelIds(r)),
  ]);
  const plan = { task: [], model: [], attempt: [], status: [], error: [], est: [], token: [], pack: [] };
  let estimate = 0;
  for (const t of tasks) {
    for (const m of v.models) {
      const recipe = recipes.get(m) || null;
      const info = catalog.modelInfo(models, recipe ? recipe.models.build : (priced(m) || m));
      const reason = m === TODAY || recipe ? null : catalog.notApplicableReason(info, 'first_version', t.brief.length);
      const est = Math.round((recipe
        ? catalog.estimateRecipeCost(models, recipe)
        : catalog.estimateTrialCost(info, 'first_version', [])) * 10000) / 10000;
      for (const packId of v.packIds) {
        for (let attempt = 1; attempt <= v.repeats; attempt += 1) {
          plan.task.push(t.taskId);
          plan.model.push(m);
          plan.attempt.push(attempt);
          plan.status.push(reason ? 'not_applicable' : 'pending');
          plan.error.push(reason);
          plan.est.push(est);
          plan.token.push(token());
          plan.pack.push(packId || null);
          if (!reason) estimate += est;
        }
      }
    }
  }
  const runnable = plan.status.filter((s) => s === 'pending').length;
  const concurrency = v.concurrency || Math.max(1, Math.min(MAX_CONCURRENCY, runnable));
  const client = await pool.connect();
  let run;
  try {
    await client.query('BEGIN');
    ({ rows: [run] } = await client.query(
      `INSERT INTO bench_runs (suite_id, models, baseline_model, stages, repeats, cap_usd, concurrency, note, started_by,
                               kind, context_pack_ids, references_per_brief)
       VALUES ($1, $2::text[], $3, ARRAY['first_version'], $4, $5, $6, $7, $8, 'studio', $9::int[], $10)
       RETURNING *`,
      [suiteId, v.models, v.models[0], v.repeats, v.capUsd, concurrency, v.note, actorId, v.packIds, v.references],
    ));
    await client.query(
      `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, error, est_cost_usd, item_token, context_pack_id, finished_at)
       SELECT $1, t, m, a, s, e, est, tok, pk, CASE WHEN s = 'not_applicable' THEN NOW() ELSE NULL END
         FROM UNNEST($2::int[], $3::text[], $4::int[], $5::text[], $6::text[], $7::numeric[], $8::text[], $9::int[])
              AS p(t, m, a, s, e, est, tok, pk)`,
      [run.id, plan.task, plan.model, plan.attempt, plan.status, plan.error, plan.est, plan.token, plan.pack],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await packs.markUsed(pool, v.packIds);
  require('./lane').wake();
  log.info('bench', 'Studio run launched', { runId: run.id, briefs: tasks.length, models: v.models, packs: v.packIds, trials: plan.task.length });
  return {
    ok: true,
    run: { id: run.id, status: run.status, capUsd: Number(run.cap_usd), concurrency, models: v.models, contextPackIds: v.packIds, repeats: v.repeats },
    trials: plan.task.length,
    notApplicable: plan.status.filter((s) => s === 'not_applicable').length,
    estimateUsd: Math.round(estimate * 100) / 100,
    briefs: tasks.map((t) => ({ taskId: t.taskId, ref: t.ref, appName: t.appName, template: t.template })),
    references: v.references,
    host: { slug: host.app.slug, repoUrl: host.app.repo_url },
  };
}

// ── Watching a run ───────────────────────────────────────────────────────

/** A trial's arm in words: its model, pack and reference label. Pure. */
function armOf(row) {
  const pack = row.context_pack_id ? { id: row.context_pack_id, name: row.pack_name || null, version: row.pack_version || null } : null;
  if (row.reference_label) return { kind: 'reference', model: null, reference: row.reference_label, pack };
  return { kind: 'platform', model: row.model, reference: null, pack };
}

/** An arm as one line: "z-ai/glm-5.3-flash + warm v2", "reference ref-v1". Pure. */
function armLabel(arm) {
  const base = arm.kind === 'reference' ? `reference ${arm.reference}` : arm.model;
  return arm.pack ? `${base} + ${arm.pack.name || `pack ${arm.pack.id}`}${arm.pack.version ? ` v${arm.pack.version}` : ''}` : base;
}

function repoOf(repoUrl) {
  return require('../homeroom-bot').parseRepo(repoUrl);
}

/** Where a trial's code is on GitHub, while its branch is there. Pure. */
function codeLinks(row) {
  const repo = repoOf(row.repo_url);
  if (!repo || !row.build_branch || row.branch_deleted_at) return null;
  const base = `https://github.com/${repo.owner}/${repo.repo}`;
  const head = row.build_sha || row.capture_sha || null;
  return {
    branch: row.build_branch,
    sha: head,
    treeUrl: `${base}/tree/${encodeURIComponent(row.build_branch).replace(/%2F/g, '/')}`,
    compareUrl: row.base_sha && head ? `${base}/compare/${row.base_sha}...${head}` : null,
    kept: !!row.kept_at,
  };
}

async function previewsFor(pool, trialIds) {
  if (!trialIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (bp.trial_id) bp.id, bp.trial_id, bp.session_id, bp.status, bp.error, bp.expires_at, bp.created_at,
            cs.staging_url, a.slug AS app_slug
       FROM bench_previews bp
       LEFT JOIN chat_sessions cs ON cs.id = bp.session_id
       LEFT JOIN apps a ON a.id = cs.app_id
      WHERE bp.trial_id = ANY($1::int[])
      ORDER BY bp.trial_id, bp.id DESC`,
    [trialIds],
  );
  return new Map(rows.map((r) => [Number(r.trial_id), previewOut(r)]));
}

/** A preview as the studio shows it. `path` opens it in the platform (the change's page). Pure. */
function previewOut(r) {
  if (!r) return null;
  const { changeHashPath } = require('../change-destination');
  const live = r.status === 'live' && !!r.staging_url && new Date(r.expires_at).getTime() > Date.now();
  return {
    id: Number(r.id),
    status: r.status === 'live' && !live ? 'ended' : r.status,
    url: live ? r.staging_url : null,
    path: live && r.app_slug && r.session_id ? changeHashPath(r.app_slug, r.session_id) : null,
    expiresAt: iso(r.expires_at),
    error: r.error ? clip(r.error, 300) : null,
  };
}

const TRIAL_SQL = `SELECT tr.id, tr.run_id, tr.task_id, tr.model, tr.attempt, tr.status, tr.context_pack_id, tr.reference_label,
            tr.progress, tr.cost_usd::float8 AS cost_usd, tr.est_cost_usd::float8 AS est_cost_usd, tr.error,
            tr.created_at, tr.started_at, tr.finished_at, tr.duration_ms,
            tr.prior_ms::float8 AS prior_ms, tr.first_started_at, (tr.checkpoint->>'handBacks')::int AS hand_backs,
            tr.build_branch, tr.build_sha, tr.base_sha, tr.capture_sha, tr.build_commits, tr.branch_deleted_at, tr.kept_at,
            tr.capture, tr.parsed, tr.deterministic,
            tk.tags, sn.extra->>'appName' AS app_name, a.slug AS app_slug, a.repo_url,
            p.name AS pack_name, p.version AS pack_version
       FROM bench_trials tr
       JOIN bench_tasks tk ON tk.id = tr.task_id
       LEFT JOIN homeroom_bot_run_snapshots sn ON sn.id = tk.snapshot_id
       LEFT JOIN apps a ON a.id = tk.app_id
       LEFT JOIN bench_context_packs p ON p.id = tr.context_pack_id`;

async function gradesFor(pool, trialIds) {
  if (!trialIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT id, trial_id, grader, verdict, critique, criteria, created_at
       FROM bench_grades WHERE trial_id = ANY($1::int[])
      ORDER BY created_at DESC, id DESC`,
    [trialIds],
  );
  const out = new Map();
  for (const g of rows) {
    if (!out.has(g.trial_id)) out.set(g.trial_id, []);
    out.get(g.trial_id).push(g);
  }
  return out;
}

/** The grade that counts (a person's over the judge's) and the trial's final verdict. Pure. */
function verdictOf(row, grades = []) {
  const graders = require('./graders');
  const final = graders.finalVerdict({ status: row.status, deterministic: row.deterministic, grades });
  const human = grades.find((g) => g.grader === 'human');
  const opus = grades.find((g) => g.grader === 'opus');
  const counted = human || opus || null;
  const answered = Object.values(counted?.criteria || {}).filter((x) => typeof x === 'boolean');
  return {
    final,
    critique: counted?.critique ? clip(counted.critique, 2000) : null,
    gradedBy: counted ? counted.grader : null,
    criteria: answered.length ? { held: answered.filter(Boolean).length, of: answered.length } : null,
    criteriaById: counted && counted.criteria && Object.keys(counted.criteria).length ? counted.criteria : null,
    notes: Array.isArray(row.deterministic?.notes) ? row.deterministic.notes.slice(0, 3).map((n) => clip(n, 200)) : [],
  };
}

/**
 * A first version's review as one trial shows it (services/bot-review.js
 * runReviewLoop's state, slimmed): the reviewer, the first build as round 0
 * captured it, then each round's verdict, its issues (id, severity, screen,
 * problem, fix), the earlier issues it called fixed, what its reviewer call
 * and its fix turn cost and took and the commit the fix made, and why the
 * review stopped. Null without one. Pure.
 */
function reviewRecord(review) {
  if (!review || typeof review !== 'object') return null;
  const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const r0 = review.round0 || null;
  return {
    reviewer: review.reviewer ? {
      model: review.reviewer.model || null, maxRounds: n(review.reviewer.maxRounds), budgetMinutes: n(review.reviewer.budgetMinutes),
    } : null,
    state: review.state || null,
    round0: r0 ? {
      sha: r0.sha || null, commits: n(r0.commits), booted: r0.capture ? r0.capture.booted === true : null,
      captureError: r0.captureError ? clip(r0.captureError, 300) : null, costUsd: n(r0.costUsd), activeMs: n(r0.activeMs),
    } : null,
    rounds: (Array.isArray(review.rounds) ? review.rounds : []).slice(0, 10).map((r) => ({
      round: n(r?.round),
      sha: r?.sha || null,
      booted: typeof r?.booted === 'boolean' ? r.booted : null,
      verdict: r?.verdict || null,
      reviewedBy: r?.reviewedBy || null,
      issues: (Array.isArray(r?.issues) ? r.issues : []).slice(0, 20).map((i) => ({
        id: clip(i?.id, 80), severity: i?.severity || null, screen: clip(i?.screen, 200),
        problem: clip(i?.problem, 1000), fix: clip(i?.fix, 1000),
      })),
      previousFixed: (Array.isArray(r?.previousFixed) ? r.previousFixed : []).slice(0, 20).map((x) => clip(x, 80)),
      reviewer: { costUsd: n(r?.reviewerCostUsd), ms: n(r?.reviewerMs), error: r?.reviewerError ? clip(r.reviewerError, 300) : null },
      fix: r?.fix ? {
        ok: !!r.fix.ok, costUsd: n(r.fix.costUsd), ms: n(r.fix.ms), sha: r.fix.sha || null, commits: n(r.fix.commits),
        error: r.fix.error ? clip(r.fix.error, 300) : null,
      } : null,
    })),
    stop: review.stop || null,
    stopDetail: review.stopDetail ? clip(review.stopDetail, 300) : null,
    finalSha: review.finalSha || null,
    rolledBack: review.rolledBack ? { from: review.rolledBack.from || null, to: review.rolledBack.to || null, why: review.rolledBack.why || null } : null,
    costUsd: n(review.costUsd),
  };
}

/**
 * A trial row as the watch and the gallery show it. Pure but for the preview,
 * grades and build turns passed in. Only a read handed `buildTurns`
 * (speed.buildTurnsFor's rows) carries buildSpeed: one that did not ask the
 * ledger leaves it out rather than calling a timed build untimed.
 */
function trialOut(row, { preview = null, grades = [], buildTurns = null } = {}) {
  const { pickShots } = require('./capture');
  const p = row.progress || {};
  const parsed = row.parsed || {};
  const arm = armOf(row);
  const shots = row.capture ? pickShots(row.capture).chosen.map((sh) => ({ caption: sh.caption, artifactId: sh.artifactId })) : [];
  const started = row.started_at ? new Date(row.started_at).getTime() : null;
  const ended = row.finished_at ? new Date(row.finished_at).getTime() : null;
  // A first version a restart handed back (services/bench/lane.js "After a
  // restart") ran over several claims: its elapsed time is theirs together,
  // the wait in the queue between them left out.
  const priorMs = Number(row.prior_ms) || 0;
  const handBacks = Number(row.hand_backs) || 0;
  const firstStarted = row.first_started_at ? new Date(row.first_started_at).getTime() : null;
  const buildSpeed = Array.isArray(buildTurns) ? speed.buildSpeedOf(buildTurns, row) : undefined;
  const planSpeed = Array.isArray(buildTurns) ? speed.planSpeedOf(buildTurns, row) : undefined;
  return {
    trialId: Number(row.id),
    runId: Number(row.run_id),
    taskId: Number(row.task_id),
    ref: row.tags?.taste_ref || null,
    appName: row.app_name || row.app_slug || null,
    arm,
    armLabel: armLabel(arm),
    attempt: Number(row.attempt),
    status: row.status,
    step: row.status === 'running' ? (p.step || null) : null,
    stepAt: p.stepAt || null,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    elapsedMs: started ? priorMs + Math.max(0, (ended || Date.now()) - started) : (priorMs || null),
    // How often a restart handed it back, and the wall clock from its first claim.
    resumed: handBacks > 0
      ? { restarts: handBacks, wallMs: firstStarted ? Math.max(0, (ended || Date.now()) - firstStarted) : null }
      : null,
    costUsd: Number.isFinite(row.cost_usd) ? row.cost_usd : null,
    // What that cost was made of, stage by stage and model by model, adding
    // up to it (services/stage-costs.js): null for a trial that recorded no
    // stages (one from before they were, a triage-only task).
    costBreakdown: parsed.costParts ? stageCosts.breakdown(Number.isFinite(row.cost_usd) ? row.cost_usd : null, parsed.costParts) : null,
    // What its build took (its build turn and any nudge, as the turn ledger
    // recorded them) and what its review found, as numbers an arm's medians
    // are taken over (services/bench/speed.js).
    ...(buildSpeed !== undefined ? { buildSpeed } : {}),
    // Its plan step (the spec turn) the same way, beside it.
    ...(planSpeed !== undefined ? { planSpeed } : {}),
    reviewOutcome: speed.reviewOutcomeOf(parsed.review, { buildStartedAt: buildSpeed?.startedAt || null }),
    activity: Array.isArray(p.lines) ? p.lines.map((l) => clip(l, ACTIVITY_CHARS)) : [],
    skills: parsed.skills || p.skills || { invoked: [], read: [] },
    // Whether its build could look at its own screens: what its prompt told
    // it, what its model was handed, and the screenshots, text snapshots and
    // page loads it took (runner.buildStage, progress.lookIn). Live from the
    // watch while it runs.
    sight: parsed.sight || (p.looks ? { told: null, passed: null, ...p.looks } : null),
    triage: parsed.triage ? { verdict: parsed.triage.verdict || null, question: parsed.triage.question ? clip(parsed.triage.question, 300) : null } : null,
    built: parsed.built === true,
    booted: row.capture ? row.capture.booted === true : null,
    shots,
    code: codeLinks(row),
    preview,
    error: row.error ? clip(row.error, 300) : null,
    updatedAt: p.updatedAt || iso(row.finished_at) || iso(row.started_at) || iso(row.created_at),
    ...verdictOf(row, grades),
  };
}

async function runRow(pool, runId) {
  const { rows: [run] } = await pool.query(
    `SELECT r.*, r.cap_usd::float8 AS cap, r.spent_usd::float8 AS spent, s.name AS suite_name
       FROM bench_runs r JOIN bench_suites s ON s.id = r.suite_id WHERE r.id = $1`,
    [Number(runId)],
  );
  return run || null;
}

/**
 * A run as it moves: every trial's arm, step, time, spend, last activity
 * lines, skills, newest screenshots, code and preview, its build's speed and
 * its review's outcome; and per arm, the medians of those over its trials
 * that ended (`arms`, speed.armSpeed), always over every trial. With `since`
 * (an ISO time), only the trials that changed after it, and the cursor to
 * pass next time. A studio run's view; any run can be watched. The build
 * turns of all its trials are one query, however many there are.
 */
async function watchRun(pool, runId, { since = null } = {}) {
  const run = await runRow(pool, runId);
  if (!run) return httpError(404, 'No such run');
  const now = new Date().toISOString();
  const { rows } = await pool.query(`${TRIAL_SQL} WHERE tr.run_id = $1 ORDER BY tr.task_id, tr.id`, [Number(runId)]);
  const ids = rows.map((r) => Number(r.id));
  const [previews, grades, buildTurns] = await Promise.all([previewsFor(pool, ids), gradesFor(pool, ids), speed.buildTurnsFor(pool, rows)]);
  const all = rows.map((r) => trialOut(r, { preview: previews.get(Number(r.id)) || null, grades: grades.get(Number(r.id)) || [], buildTurns }));
  const sinceMs = since ? Date.parse(since) : NaN;
  const trials = Number.isFinite(sinceMs)
    ? all.filter((t) => Date.parse(t.updatedAt || 0) > sinceMs || (t.preview && t.preview.status === 'building'))
    : all;
  const counts = {};
  for (const t of all) counts[t.status] = (counts[t.status] || 0) + 1;
  const { rows: firsts } = await pool.query(
    `SELECT task_id, context_pack_id, status, sha, branch, error FROM bench_scaffolds WHERE run_id = $1 ORDER BY id`,
    [Number(runId)],
  );
  return {
    ok: true,
    run: {
      id: Number(run.id), kind: run.kind, status: run.status, suite: run.suite_name, models: run.models,
      contextPackIds: run.context_pack_ids || [], referencesPerBrief: Number(run.references_per_brief) || 0,
      capUsd: run.cap, spentUsd: run.spent, concurrency: run.concurrency,
      createdAt: iso(run.created_at), startedAt: iso(run.started_at), finishedAt: iso(run.finished_at),
    },
    counts,
    arms: speed.armSpeed(all),
    firstCommits: firsts.map((f) => ({
      taskId: Number(f.task_id), packId: f.context_pack_id ? Number(f.context_pack_id) : 0, status: f.status,
      sha: f.sha || null, branch: f.branch || null, error: f.error ? clip(f.error, 200) : null,
    })),
    trials,
    changedOnly: Number.isFinite(sinceMs),
    cursor: now,
  };
}

// ── References ───────────────────────────────────────────────────────────

const CAPTURE_CONTRACT = [
  'How every build of this brief is judged, yours included: the platform boots the app as it boots every first version',
  'for its screenshots. `npm ci` (or `npm install`), then the platform\'s in-loop runner in staging mode',
  '(USERNODE_ENV=staging) on a fresh, empty database, with one throwaway viewer signed in. It takes 16 screenshots:',
  '390x844 and 1280x800, light and dark (`?un-theme=light|dark`), and four states: populated (the app\'s staging seed',
  'plus `?demo=1`), empty (every table truncated), error (GET /api/* answering 500) and loading (GET /api/* held two',
  'seconds). Then, on the populated screen, it taps the screen\'s primary action once (its one `.btn-primary`, else a',
  'form\'s submit button, else the button in the accent colour) and takes up to three more: phone light and dark,',
  'desktop light. It also counts console errors, overflow at 360px, tap targets under 44px, text below WCAG AA and cards',
  'nested in cards, and lints the client source for emoji used as icons, uppercase tracked eyebrows, one-off text',
  'sizes and stray hex colours. A judge then grades the screenshots, blind, against the brief.',
].join('\n');

const HAND_BACK = [
  'Build the app the brief describes, as a careful senior engineer and product designer would build its FIRST',
  'VERSION, starting from the commit above and nothing else. Read its CLAUDE.md first, and the pack\'s guidance and',
  'files if there is a pack: they are what the bot was given. Nobody will answer questions: make sensible choices.',
  'Keep the starter\'s server, dapp.json and the platform\'s centrally hosted assets (never vendor them), and seed the',
  'staging data a reviewer needs. Commit on top of the start commit; never rewrite or squash it. Then hand it back',
  'with submit_bench_reference: a branch pushed to a repository your linked GitHub account owns (any name), or a patch',
  '(`git format-patch <start sha>..HEAD --stdout`, at most 256 KB). Give it a label (ref-v1, ref-v2, …) so later',
  'versions sit beside it.',
].join('\n');

/**
 * What a reference build is given for one brief and pack of a run: the
 * brief, the commit to start from (made now if no trial has made it yet,
 * in which case come back shortly), the pack's guidance and files, how it
 * is judged and how to hand it back, and the references already in.
 */
async function referenceOrder(pool, config, { runId, taskId, packId = 0, deps = {} } = {}) {
  const run = await runRow(pool, runId);
  if (!run) return httpError(404, 'No such run');
  if (run.kind !== 'studio') return httpError(409, 'References are for studio runs');
  const pid = Number(packId) || 0;
  if (!(run.context_pack_ids || [0]).map(Number).includes(pid)) return httpError(400, `The run was not launched with pack ${pid}`);
  const { rows: [task] } = await pool.query(
    `SELECT t.id, t.snapshot_id, t.tags, a.repo_url
       FROM bench_tasks t JOIN apps a ON a.id = t.app_id
      WHERE t.id = $1 AND EXISTS (SELECT 1 FROM bench_trials tr WHERE tr.run_id = $2 AND tr.task_id = t.id)`,
    [Number(taskId), Number(runId)],
  );
  if (!task) return httpError(404, 'That brief is not in the run');
  const taste = require('./taste');
  const snapshots = require('../homeroom-bot-snapshots');
  const input = taste.inputOf(await snapshots.readSnapshot(pool, task.snapshot_id));
  const repo = repoOf(task.repo_url);
  if (!repo) return httpError(409, 'The run\'s app has no repository');
  const pack = pid ? await packs.packRow(pool, pid) : null;
  const ready = await scaffold.readyFor(pool, { runId, taskId, packId: pid || null });
  if (!ready) {
    // Made now, in the background, as the run's first trial on it would.
    const runner = require('./runner');
    const github = runner.guardedGithub(deps.github || require('../github'));
    Promise.resolve().then(async () => {
      const user = await runner.ensureBenchUser(pool, config);
      await scaffold.ensure(pool, { runId: Number(runId), taskId: Number(taskId), pack, input, repo, github, user, deps });
    }).catch((err) => log.warn('bench', 'Could not make a first commit for a reference order', { runId, taskId, err: err.message }));
    return { ok: true, ready: false, retryAfterSeconds: 20 };
  }
  const { rows: refs } = await pool.query(
    `SELECT id, reference_label, attempt, status, capture_sha, finished_at
       FROM bench_trials
      WHERE run_id = $1 AND task_id = $2 AND reference_label IS NOT NULL AND COALESCE(context_pack_id, 0) = $3
      ORDER BY id`,
    [Number(runId), Number(taskId), pid],
  );
  const card = scaffold.requestCard(ready.sketch);
  return {
    ok: true,
    ready: true,
    order: {
      runId: Number(runId),
      taskId: Number(taskId),
      packId: pid,
      ref: task.tags?.taste_ref || null,
      appName: input.appName,
      brief: input.brief,
      sketch: card ? { emoji: card.emoji || null, tagline: card.tagline || null, points: card.points || [] } : null,
      start: {
        repoUrl: `https://github.com/${repo.owner}/${repo.repo}`,
        cloneUrl: `https://github.com/${repo.owner}/${repo.repo}.git`,
        branch: ready.branch,
        sha: ready.sha,
      },
      pack: pack ? {
        id: pack.id, name: pack.name, version: pack.version,
        guidance: Object.fromEntries(packs.STAGES.map((st) => [st, packs.guidanceFor(pack, st) || null])),
        files: packs.filesOf(pack).map((f) => f.path),
      } : null,
      references: refs.map((r) => ({ trialId: Number(r.id), label: r.reference_label, status: r.status, sha: r.capture_sha || null })),
      howItIsJudged: CAPTURE_CONTRACT,
      handBack: HAND_BACK,
    },
  };
}

/** How many commits an mbox patch carries (1 for a plain diff). Pure. */
function patchCommits(patch) {
  const n = (String(patch || '').match(/^From [0-9a-f]{40} /gm) || []).length;
  return Math.max(1, n);
}

/**
 * Copy a branch from a repository the user owns into the host repository as
 * the reference trial's branch, after checking it is built on the start
 * commit. Unauthenticated read of the user's repository; the platform's own
 * credential for the push, as the connector's mirror does
 * (services/external-agent-head.js).
 */
async function copyUserBranch({ owner, repo, forkOwner, forkRepo, branch, baseSha, targetBranch, head }) {
  const credential = await head.resolveWriteCredential(owner);
  let out = null;
  try {
    await head.withScratchRepo('bench-ref', async ({ git }) => {
      await git(['fetch', '--no-tags', '--depth', '500', head.sourceCloneUrl(forkOwner, forkRepo), branch]);
      const { stdout: sha } = await git(['rev-parse', 'FETCH_HEAD']);
      const headSha = String(sha).trim().toLowerCase();
      try {
        await git(['merge-base', '--is-ancestor', baseSha, headSha]);
      } catch {
        const e = new Error('base_mismatch');
        e.code = 'base_mismatch';
        throw e;
      }
      const { stdout: count } = await git(['rev-list', '--count', `${baseSha}..${headSha}`]);
      if (!(Number(count) > 0)) {
        const e = new Error('no_commits');
        e.code = 'no_commits';
        throw e;
      }
      await git(['push', head.authenticatedRemote(credential.token, owner, repo), `${headSha}:refs/heads/${targetBranch}`]);
      out = { headSha, commits: Number(count) };
    });
  } catch (err) {
    if (err.code === 'base_mismatch') return httpError(409, `${branch} is not built on the start commit ${baseSha}. Start from that commit (fetch it from the order's branch) and push again.`, { code: 'base_mismatch' });
    if (err.code === 'no_commits') return httpError(409, `${branch} has no commits on top of the start commit.`, { code: 'no_commits' });
    log.warn('bench', 'Could not copy a reference branch', { forkOwner, forkRepo, err: head.redactToken(err.message, credential.token) });
    return httpError(502, 'Homeroom could not copy that branch just now. Try again shortly.', { code: 'platform_unavailable' });
  }
  return { ok: true, ...out };
}

/**
 * Hand in a reference build for one brief and pack of a studio run: a
 * branch on a repository the user's linked GitHub account owns, or a patch.
 * It becomes a trial of its own (`reference:<label>`), copied into the host
 * repository on that trial's branch and captured by the lane like any other
 * build, at no model cost. Resolves { ok, trialId, label, sha, commits }.
 */
async function submitReference(pool, config, {
  runId, taskId, packId = 0, label, patch = null, repo: repoName = null, branch = null, user, deps = {},
} = {}) {
  const lbl = String(label || '').trim().toLowerCase();
  if (!LABEL_RE.test(lbl)) return httpError(400, 'label is 1 to 40 lower-case letters, digits, dots, dashes or underscores (ref-v1)');
  if (!!patch === !!branch) return httpError(400, 'Send exactly one of patch or branch');
  const order = await referenceOrder(pool, config, { runId, taskId, packId, deps });
  if (!order.ok) return order;
  if (!order.ready) return httpError(409, 'The start commit is still being made. Ask for the order again in a few seconds.', { code: 'not_ready' });
  const run = await runRow(pool, runId);
  if (run.status === 'cancelled') return httpError(409, 'The run was cancelled');
  const host = repoOf(order.order.start.repoUrl);
  const baseSha = order.order.start.sha;
  const pid = order.order.packId;
  const model = `${REFERENCE_PREFIX}${lbl}`;
  const { rows: [trial] } = await pool.query(
    `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token, est_cost_usd, context_pack_id, reference_label, base_sha)
     SELECT $1, $2, $3, COALESCE(MAX(attempt), 0) + 1, 'awaiting', $4, 0, $5, $6, $7
       FROM bench_trials WHERE run_id = $1 AND task_id = $2 AND model = $3 AND COALESCE(context_pack_id, 0) = COALESCE($5::int, 0)
     RETURNING id, attempt`,
    [Number(runId), Number(taskId), model, token(), pid || null, lbl, baseSha],
  );
  const runner = require('./runner');
  const target = runner.branchFor({ run_id: runId, id: trial.id });
  const drop = () => pool.query("DELETE FROM bench_trials WHERE id = $1 AND status = 'awaiting'", [trial.id]).catch(() => {});
  let copied;
  if (patch) {
    const applied = await (deps.applyPatch || require('../external-agent-patch').applyPatch)({
      owner: host.owner, repo: host.repo, patch, baseSha, userId: user?.id, taskId: trial.id,
    });
    if (!applied.ok) { await drop(); return httpError(applied.code === 'platform_unavailable' ? 502 : 400, applied.message, { code: applied.code, detail: applied.detail || null }); }
    try {
      const github = runner.guardedGithub(deps.github || require('../github'));
      await github.ensureBranchAtSha(host.owner, host.repo, target, applied.headSha);
    } catch (err) {
      await drop();
      return httpError(502, `Homeroom could not keep the patched commit: ${err.message}`, { code: 'platform_unavailable' });
    } finally {
      if (applied.cleanup) await Promise.resolve(applied.cleanup()).catch(() => {});
    }
    copied = { headSha: applied.headSha, commits: patchCommits(patch) };
  } else {
    const githubLink = deps.githubLink || require('../github-link');
    const link = await githubLink.linkStatus(pool, user?.id);
    if (!link || !link.linked || !link.login) { await drop(); return httpError(409, 'Link a GitHub account in Settings to hand in a branch, or send a patch', { code: 'github_not_linked' }); }
    const name = String(repoName || '').trim();
    const [first, second] = name.includes('/') ? name.split('/') : [null, name];
    const forkOwner = link.login;
    if (first && first.toLowerCase() !== forkOwner.toLowerCase()) {
      await drop();
      return httpError(400, `The repository must be your own (${forkOwner}/…): Homeroom only takes a reference from your linked GitHub account`, { code: 'fork_mismatch' });
    }
    const head = deps.head || require('../external-agent-head');
    const githubPublic = deps.githubPublic || require('../external-agent-tasks').githubPublic;
    const verified = await head.verifyForkBranch({ githubPublic, forkOwner, forkRepo: second, branch, expectedLogin: link.login });
    if (!verified.ok) { await drop(); return httpError(verified.code === 'platform_unavailable' ? 502 : 400, verified.message, { code: verified.code }); }
    const out = await (deps.copyUserBranch || copyUserBranch)({
      owner: host.owner, repo: host.repo, forkOwner, forkRepo: second, branch, baseSha, targetBranch: target, head,
    });
    if (!out.ok) { await drop(); return out; }
    copied = out;
  }
  const { rows: [ready] } = await pool.query(
    `UPDATE bench_trials SET status = 'pending', capture_sha = $2, build_commits = $3, build_branch = $4
      WHERE id = $1 AND status = 'awaiting' RETURNING id`,
    [trial.id, copied.headSha, copied.commits, target],
  );
  if (!ready) return httpError(409, 'The reference was cancelled while it was copied');
  await require('./lane').reopenRun(pool, runId);
  log.info('bench', 'Reference build handed in', { runId, taskId, trialId: trial.id, label: lbl, via: patch ? 'patch' : 'branch' });
  return { ok: true, trialId: Number(trial.id), label: lbl, model, attempt: Number(trial.attempt), sha: copied.headSha, commits: copied.commits, branch: target };
}

// ── One trial: re-run, keep, read ────────────────────────────────────────

/**
 * Run one trial again, as a new attempt of the same arm (a reference is
 * captured again at the same commit). Its run opens again if it had ended.
 */
async function rerunTrial(pool, trialId) {
  const { rows: [t] } = await pool.query(
    `SELECT tr.*, r.status AS run_status FROM bench_trials tr JOIN bench_runs r ON r.id = tr.run_id WHERE tr.id = $1`,
    [Number(trialId)],
  );
  if (!t) return httpError(404, 'No such trial');
  if (t.run_status === 'cancelled') return httpError(409, 'Its run was cancelled');
  if (['pending', 'running', 'awaiting'].includes(t.status)) return httpError(409, 'That trial is still under way');
  if (t.reference_label && !t.capture_sha) return httpError(409, 'That reference has no commit to capture');
  const { rows: [made] } = await pool.query(
    `INSERT INTO bench_trials (run_id, task_id, model, attempt, status, item_token, est_cost_usd, context_pack_id,
                               reference_label, capture_sha, base_sha, build_commits)
     SELECT $1, $2, $3, COALESCE(MAX(attempt), 0) + 1, 'pending', $4, $5, $6, $7, $8, $9, $10
       FROM bench_trials WHERE run_id = $1 AND task_id = $2 AND model = $3 AND COALESCE(context_pack_id, 0) = COALESCE($6::int, 0)
     RETURNING id, attempt`,
    [t.run_id, t.task_id, t.model, token(), t.est_cost_usd, t.context_pack_id, t.reference_label,
      t.reference_label ? t.capture_sha : null, t.reference_label ? t.base_sha : null, t.reference_label ? t.build_commits : null],
  );
  await require('./lane').reopenRun(pool, t.run_id);
  return { ok: true, trialId: Number(made.id), attempt: Number(made.attempt), runId: Number(t.run_id) };
}

/** Keep a trial's branch past the sweep (or let it go again). */
async function keepTrial(pool, trialId, keep = true) {
  const { rows: [t] } = await pool.query(
    `UPDATE bench_trials SET kept_at = CASE WHEN $2::boolean THEN COALESCE(kept_at, NOW()) ELSE NULL END
      WHERE id = $1 AND build_branch IS NOT NULL
      RETURNING id, kept_at, branch_deleted_at`,
    [Number(trialId), !!keep],
  );
  if (!t) return httpError(404, 'No such trial, or it has no branch to keep');
  if (keep && t.branch_deleted_at) return httpError(409, 'Its branch is already gone: a build is kept only before the seven-day sweep');
  return { ok: true, trialId: Number(t.id), kept: !!t.kept_at };
}

/**
 * Every trial of a run, one row each, for the connector and the console:
 * arm, status, verdict, criteria held, cost, time, skills. For a run that
 * is not a studio run, refused while any of its trials waits for the judge,
 * so reading results can never colour a blind grade.
 */
async function trialRows(pool, runId) {
  const run = await runRow(pool, runId);
  if (!run) return httpError(404, 'No such run');
  const { rows } = await pool.query(`${TRIAL_SQL} WHERE tr.run_id = $1 ORDER BY tr.task_id, tr.id`, [Number(runId)]);
  const ids = rows.map((r) => Number(r.id));
  const grades = await gradesFor(pool, ids);
  const out = rows.map((r) => trialOut(r, { grades: grades.get(Number(r.id)) || [] }));
  const waiting = out.filter((t) => t.final === 'pending').length;
  if (run.kind !== 'studio' && waiting) {
    return httpError(409, `${waiting} trials of this run still wait for the judge: grade them blind first (list_bench_grading_queue)`, { code: 'judge_pending' });
  }
  const stageOf = new Map((await pool.query(
    'SELECT tr.id, tk.stage, tk.issue_number FROM bench_trials tr JOIN bench_tasks tk ON tk.id = tr.task_id WHERE tr.run_id = $1',
    [Number(runId)],
  )).rows.map((r) => [Number(r.id), r]));
  return {
    ok: true,
    run: { id: Number(run.id), kind: run.kind, status: run.status, suite: run.suite_name },
    trials: out.map((t) => ({
      trialId: t.trialId, taskId: t.taskId, stage: stageOf.get(t.trialId)?.stage || null,
      issueNumber: stageOf.get(t.trialId)?.issue_number ?? null, ref: t.ref, appName: t.appName,
      arm: t.armLabel, attempt: t.attempt, status: t.status, final: t.final, criteria: t.criteria,
      costUsd: t.costUsd, elapsedMs: t.elapsedMs, built: t.built, booted: t.booted, skills: t.skills, sight: t.sight,
      error: t.error ? require('./report').reasonText(t.error) : null,
    })),
  };
}

// ── A trial's transcript ─────────────────────────────────────────────────

const TRANSCRIPT_PAGE = 500;

/**
 * A trial's steps as its transcript recorded them (bench_trial_lines): each
 * step it reached, in order, with when it began (its `step` row, or its
 * first line), when its last line came, how long that was and how many lines
 * it reported. A step reached again (a claim after a restart) is a second
 * entry. Null for a trial with no transcript (one from before 13 Oct 2026).
 */
async function timelineOf(pool, trialId) {
  const { rows } = await pool.query(
    `SELECT step, kind, at, replayed FROM bench_trial_lines WHERE trial_id = $1 ORDER BY id`,
    [Number(trialId)],
  );
  if (!rows.length) return null;
  const out = [];
  let cur = null;
  for (const r of rows) {
    const step = r.step || null;
    if (!cur || r.kind === 'step' || step !== cur.step) {
      cur = { step, from: iso(r.at), to: iso(r.at), lines: 0, replayed: 0 };
      out.push(cur);
    }
    cur.to = iso(r.at);
    if (r.kind === 'line') {
      cur.lines += 1;
      if (r.replayed) cur.replayed += 1;
    }
  }
  return out.map((e, i) => {
    // A step runs until the next one begins; the last, until its last line.
    const end = out[i + 1] ? out[i + 1].from : e.to;
    return { ...e, to: end, ms: Math.max(0, Date.parse(end) - Date.parse(e.from)) };
  });
}

/**
 * A page of a trial's transcript, oldest first: up to `limit` lines (500 at
 * most) after the cursor `after` (a line's id), of one `step` when given,
 * each { id, at, step, kind, line, replayed }; `next` is the cursor for the
 * page after, null at the end; `total` the trial's lines in all.
 */
async function transcriptOf(pool, trialId, { step = null, after = null, limit = TRANSCRIPT_PAGE } = {}) {
  const { rows: [trial] } = await pool.query('SELECT id FROM bench_trials WHERE id = $1', [Number(trialId)]);
  if (!trial) return httpError(404, 'No such trial');
  const n = Math.min(Math.max(Number(limit) || TRANSCRIPT_PAGE, 1), TRANSCRIPT_PAGE);
  const from = Number.isSafeInteger(Number(after)) && Number(after) > 0 ? Number(after) : 0;
  const stepName = typeof step === 'string' && /^[a-z_]{1,16}$/.test(step) ? step : null;
  // Ordered by the column, a number: by the output's text `id` it put
  // 1000 before 999, and a page's cursor skipped the lines between.
  const { rows } = await pool.query(
    `SELECT id::text AS id, at, step, kind, line, replayed FROM bench_trial_lines
      WHERE trial_id = $1 AND id > $2::bigint AND ($3::text IS NULL OR step = $3::text)
      ORDER BY bench_trial_lines.id LIMIT $4`,
    [Number(trialId), from, stepName, n + 1],
  );
  const { rows: [count] } = await pool.query('SELECT COUNT(*)::int AS n FROM bench_trial_lines WHERE trial_id = $1', [Number(trialId)]);
  const page = rows.slice(0, n);
  return {
    ok: true,
    trialId: Number(trialId),
    step: stepName,
    total: Number(count?.n) || 0,
    lines: page.map((r) => ({ id: Number(r.id), at: iso(r.at), step: r.step || null, kind: r.kind, line: r.line, replayed: !!r.replayed })),
    next: rows.length > n ? Number(page[page.length - 1].id) : null,
  };
}

/**
 * One trial in full: its brief, arm, what the triage said and planned, its
 * spec (whole up to TRIAL_SPEC_CHARS, and its drawn screens' sizes), what
 * each stage cost (trialOut's costBreakdown), a first version's review
 * round by round (reviewRecord), its build's speed and its review's outcome
 * (trialOut's buildSpeed and reviewOutcome), files changed, the automatic
 * checks, the grade and critique, its code and preview, and its screenshots
 * (with `images`, as base64 PNGs, at most 8 MB). Refused like trialRows for a
 * trial of a run that is not a studio run while it waits for the judge.
 */
async function trialDetail(pool, trialId, { images = false } = {}) {
  const { rows: [row] } = await pool.query(
    `SELECT tr.id, tr.run_id, tr.task_id, tr.model, tr.attempt, tr.status, tr.context_pack_id, tr.reference_label,
            tr.progress, tr.cost_usd::float8 AS cost_usd, tr.est_cost_usd::float8 AS est_cost_usd, tr.error,
            tr.created_at, tr.started_at, tr.finished_at, tr.duration_ms,
            tr.prior_ms::float8 AS prior_ms, tr.first_started_at, (tr.checkpoint->>'handBacks')::int AS hand_backs,
            tr.build_branch, tr.build_sha, tr.base_sha, tr.capture_sha, tr.build_commits, tr.branch_deleted_at, tr.kept_at,
            tr.capture, tr.parsed, tr.deterministic, tr.changed_files,
            tk.tags, tk.stage, tk.snapshot_id, sn.extra->>'appName' AS app_name, a.slug AS app_slug, a.repo_url,
            p.name AS pack_name, p.version AS pack_version, r.kind AS run_kind
       FROM bench_trials tr
       JOIN bench_runs r ON r.id = tr.run_id
       JOIN bench_tasks tk ON tk.id = tr.task_id
       LEFT JOIN homeroom_bot_run_snapshots sn ON sn.id = tk.snapshot_id
       LEFT JOIN apps a ON a.id = tk.app_id
       LEFT JOIN bench_context_packs p ON p.id = tr.context_pack_id
      WHERE tr.id = $1`,
    [Number(trialId)],
  );
  if (!row) return httpError(404, 'No such trial');
  const grades = (await gradesFor(pool, [Number(row.id)])).get(Number(row.id)) || [];
  const buildTurns = await speed.buildTurnsFor(pool, [row]);
  const t = trialOut(row, { preview: (await previewsFor(pool, [Number(row.id)])).get(Number(row.id)) || null, grades, buildTurns });
  if (row.run_kind !== 'studio' && t.final === 'pending') {
    return httpError(409, 'This trial waits for the judge: grade it blind first (list_bench_grading_queue)', { code: 'judge_pending' });
  }
  const taste = require('./taste');
  const snapshots = require('../homeroom-bot-snapshots');
  const capture = require('./capture');
  const grading = require('./grading');
  const input = taste.isTasteStage(row.stage) ? taste.inputOf(await snapshots.readSnapshot(pool, row.snapshot_id)) : null;
  const parsed = row.parsed || {};
  const out = {
    ...t,
    stage: row.stage,
    brief: input ? input.brief : null,
    models: parsed.models || null,
    sketch: parsed.sketch || null,
    plan: parsed.plan ? {
      bullets: (parsed.plan.bullets || []).slice(0, 12).map((b) => clip(b, 300)),
      chosen: (parsed.plan.chosen || []).slice(0, 8),
    } : null,
    triage: parsed.triage ? {
      verdict: parsed.triage.verdict || null, buildNote: parsed.triage.buildNote ? clip(parsed.triage.buildNote, 4000) : null,
      question: parsed.triage.question ? clip(parsed.triage.question, 600) : null,
      assumptions: (parsed.triage.assumptions || []).slice(0, 10).map((a) => clip(a, 300)),
    } : null,
    spec: parsed.spec ? clip(parsed.spec, TRIAL_SPEC_CHARS) : null,
    specChars: parsed.spec ? String(parsed.spec).length : null,
    specNote: parsed.specNote ? clip(parsed.specNote, 600) : null,
    // Each drawn screen's size, characters, inline SVGs and SVG shapes, and
    // whether it ran past twice its budget (spec-html.js screenStats).
    specScreens: Array.isArray(parsed.specScreens) ? parsed.specScreens.slice(0, 6) : null,
    // A reviewed first version's rounds (services/bot-review.js).
    review: reviewRecord(parsed.review),
    blocked: parsed.blocked ? clip(parsed.blocked, 600) : null,
    changedFiles: Array.isArray(row.changed_files?.files) ? row.changed_files.files.slice(0, 200).map((f) => f.filename || f) : null,
    checks: row.capture ? grading.tasteSignals(row.capture) : null,
    bootError: row.capture && row.capture.booted === false ? clip(row.capture.error || 'did not boot', 400) : null,
    // Its steps as its transcript recorded them, and how many lines that
    // holds (transcriptOf pages through them).
    timeline: await timelineOf(pool, row.id),
    transcriptLines: Number((await pool.query('SELECT COUNT(*)::int AS n FROM bench_trial_lines WHERE trial_id = $1', [Number(row.id)])).rows[0]?.n) || 0,
  };
  if (images && row.capture) {
    const picked = capture.pickShots(row.capture).chosen;
    const stored = await capture.readArtifacts(pool, row.id, picked.map((sh) => sh.artifactId));
    const byId = new Map(stored.map((r) => [r.id, r]));
    let total = 0;
    out.images = [];
    for (const sh of picked) {
      const a = byId.get(sh.artifactId);
      const data = a && (Buffer.isBuffer(a.data) ? a.data : Buffer.from(a.data || ''));
      if (!data || !data.length || total + data.length > 8 * 1024 * 1024) continue;
      total += data.length;
      out.images.push({ caption: sh.caption, mimeType: a.content_type || 'image/png', data: data.toString('base64') });
    }
  }
  return { ok: true, trial: out };
}

// ── Previews ─────────────────────────────────────────────────────────────

/**
 * Put a studio build (a trial's or a reference's) up as a preview for a
 * day: a session on the host app at the build's commit, built by the
 * platform's own preview path (services/staging.js), whose database is a
 * clone of the host app's own, empty one. At most MAX_LIVE_PREVIEWS at once.
 * The admin who asks is made a member of the host app, so the preview opens
 * for them. Resolves the preview at once; it builds in the background.
 */
async function deployPreview(pool, config, { trialId, user, deps = {} } = {}) {
  const { rows: [t] } = await pool.query(
    `SELECT tr.id, tr.status, tr.build_sha, tr.build_branch, tr.branch_deleted_at,
            a.id AS app_id, a.slug, a.name, a.repo_url, a.self_hosted
       FROM bench_trials tr JOIN bench_tasks tk ON tk.id = tr.task_id JOIN apps a ON a.id = tk.app_id
      WHERE tr.id = $1`,
    [Number(trialId)],
  );
  if (!t) return httpError(404, 'No such trial');
  if (!(await isHostApp(pool, t.app_id))) {
    return httpError(409, 'Only a studio build can be previewed: its database is the studio\'s own empty one, never an app\'s real data');
  }
  if (t.status !== 'ok' || !t.build_sha || !t.build_branch) return httpError(409, 'That trial has no build to preview');
  if (t.branch_deleted_at) return httpError(409, 'Its branch is gone: a build is kept seven days unless it was kept');
  const { rows: [open] } = await pool.query(
    `SELECT bp.*, cs.staging_url, a.slug AS app_slug FROM bench_previews bp
       LEFT JOIN chat_sessions cs ON cs.id = bp.session_id LEFT JOIN apps a ON a.id = cs.app_id
      WHERE bp.trial_id = $1 AND bp.status IN ('building', 'live') AND bp.expires_at > NOW()
      ORDER BY bp.id DESC LIMIT 1`,
    [t.id],
  );
  if (open) return { ok: true, preview: previewOut(open), reused: true };
  const { rows: [{ n }] } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM bench_previews WHERE status IN ('building', 'live') AND expires_at > NOW()",
  );
  if (n >= MAX_LIVE_PREVIEWS) return httpError(409, `${n} previews are up already, the most at once. One ends within a day, or ask for fewer.`, { code: 'preview_cap' });
  const runner = require('./runner');
  const bench = deps.user || await runner.ensureBenchUser(pool, config);
  if (user && user.id) {
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, accepted_at) VALUES ($1, $2, 'member', NOW())
       ON CONFLICT (app_id, user_id) DO NOTHING`,
      [t.app_id, user.id],
    );
  }
  const { rows: [session] } = await pool.query(
    `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, linked_issues, session_title)
     VALUES ($1, $2, $3, 'paused', TRUE, '{}', $4)
     RETURNING *`,
    [t.app_id, bench.id, t.build_branch, `App bench preview: trial ${t.id}`],
  );
  const { rows: [preview] } = await pool.query(
    `INSERT INTO bench_previews (trial_id, session_id, requested_by, expires_at)
     VALUES ($1, $2, $3, NOW() + make_interval(hours => $4)) RETURNING *`,
    [t.id, session.id, user?.id || null, PREVIEW_HOURS],
  );
  const staging = deps.staging || require('../staging');
  const app = { id: t.app_id, slug: t.slug, name: t.name, repo_url: t.repo_url, self_hosted: t.self_hosted };
  Promise.resolve()
    .then(() => staging.buildAndDeployStaging(config, { ...session, app_slug: t.slug }, app, t.build_sha))
    .then(() => pool.query("UPDATE bench_previews SET status = 'live' WHERE id = $1 AND status = 'building'", [preview.id]))
    .catch((err) => pool.query(
      "UPDATE bench_previews SET status = 'failed', error = $2 WHERE id = $1 AND status = 'building'",
      [preview.id, String(err && err.message || 'failed').slice(0, 500)],
    ).catch(() => {}));
  log.info('bench', 'Studio preview requested', { trialId: t.id, previewId: preview.id, sessionId: session.id });
  return { ok: true, preview: previewOut({ ...preview, app_slug: t.slug, staging_url: null }) };
}

/**
 * Previews over time (on the leader, from the lane's pass): a live one is
 * kept from the platform's idle collection until it is a day old, then
 * taken down and its session archived; one left building by a process that
 * is gone fails. Throttled; never throws.
 */
async function sweepPreviews(pool, deps = {}, now = Date.now()) {
  if (now - lastPreviewSweepAt < PREVIEW_SWEEP_MS && !deps.force) return 0;
  lastPreviewSweepAt = now;
  let ended = 0;
  try {
    await pool.query(
      `UPDATE chat_sessions SET last_activity_at = NOW()
        WHERE id IN (SELECT session_id FROM bench_previews WHERE status IN ('building', 'live') AND expires_at > NOW())`,
    );
    await pool.query(
      `UPDATE bench_previews bp SET status = 'failed', error = 'the preview stopped building (the platform restarted)'
        FROM chat_sessions cs
       WHERE cs.id = bp.session_id AND bp.status = 'building' AND cs.staging_url IS NULL
         AND bp.created_at < NOW() - make_interval(mins => $1)`,
      [PREVIEW_STUCK_MINUTES],
    );
    const { rows } = await pool.query(
      `SELECT id, session_id FROM bench_previews
        WHERE status IN ('building', 'live', 'failed') AND ended_at IS NULL AND expires_at <= NOW()
        ORDER BY id LIMIT 20`,
    );
    const lifecycle = deps.sessionLifecycle || require('../session-lifecycle');
    for (const r of rows) {
      if (r.session_id) {
        // eslint-disable-next-line no-await-in-loop
        await lifecycle.teardownStagingForSession({ pool, sessionId: r.session_id, reason: 'bench-preview-expired' })
          .catch((err) => log.warn('bench', 'Could not take a studio preview down', { previewId: r.id, err: err.message }));
        // eslint-disable-next-line no-await-in-loop
        await pool.query(
          `UPDATE chat_sessions SET status = 'archived', archived_at = NOW() WHERE id = $1 AND status IN ('active', 'paused')`,
          [r.session_id],
        ).catch(() => {});
      }
      // eslint-disable-next-line no-await-in-loop
      await pool.query("UPDATE bench_previews SET status = 'ended', ended_at = NOW() WHERE id = $1", [r.id]);
      ended += 1;
    }
  } catch (err) {
    log.warn('bench', 'Studio preview sweep failed', { err: err.message });
  }
  return ended;
}

// ── The gallery ──────────────────────────────────────────────────────────

/**
 * Every studio brief with its builds across runs, newest first: each a
 * trial with its arm, verdict, critique, criteria held, screenshots, code
 * and preview. `taskId` narrows it to one brief.
 */
async function gallery(pool, { taskId = null, limit = 20 } = {}) {
  const taste = require('./taste');
  const snapshots = require('../homeroom-bot-snapshots');
  const { rows: tasks } = await pool.query(
    `SELECT t.id, t.snapshot_id, t.tags, t.created_at
       FROM bench_tasks t JOIN bench_suites s ON s.id = t.suite_id
      WHERE s.name = $1 AND t.stage = 'first_version' AND ($2::int IS NULL OR t.id = $2::int)
      ORDER BY t.id DESC
      LIMIT $3`,
    [SUITE_NAME, taskId == null ? null : Number(taskId), Math.min(Math.max(Number(limit) || 20, 1), 50)],
  );
  const ids = tasks.map((t) => Number(t.id));
  const { rows } = ids.length ? await pool.query(
    `${TRIAL_SQL}
       JOIN bench_runs r ON r.id = tr.run_id
      WHERE tr.task_id = ANY($1::int[]) AND r.kind = 'studio' AND tr.status NOT IN ('not_applicable', 'skipped_cap', 'awaiting')
      ORDER BY tr.task_id, tr.id DESC`,
    [ids],
  ) : { rows: [] };
  const trialIds = rows.map((r) => Number(r.id));
  const [previews, grades] = await Promise.all([previewsFor(pool, trialIds), gradesFor(pool, trialIds)]);
  const byTask = new Map();
  for (const r of rows) {
    const list = byTask.get(Number(r.task_id)) || [];
    if (list.length < GALLERY_TRIALS_PER_BRIEF) {
      list.push(trialOut(r, { preview: previews.get(Number(r.id)) || null, grades: grades.get(Number(r.id)) || [] }));
    }
    byTask.set(Number(r.task_id), list);
  }
  const briefs = [];
  for (const t of tasks) {
    // eslint-disable-next-line no-await-in-loop
    const input = taste.inputOf(await snapshots.readSnapshot(pool, t.snapshot_id));
    briefs.push({
      taskId: Number(t.id), ref: t.tags?.taste_ref || null, appName: input.appName, brief: clip(input.brief, 1200),
      builds: byTask.get(Number(t.id)) || [],
    });
  }
  return { ok: true, briefs };
}

/** The studio's runs, newest first, with their trial counts. */
async function listStudioRuns(pool, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT r.id, r.status, r.models, r.context_pack_ids, r.references_per_brief, r.cap_usd::float8 AS cap_usd,
            r.spent_usd::float8 AS spent_usd, r.note, r.created_at, r.finished_at, u.username AS started_by,
            COALESCE(c.counts, '{}'::jsonb) AS counts
       FROM bench_runs r
       LEFT JOIN users u ON u.id = r.started_by
       LEFT JOIN LATERAL (
         SELECT jsonb_object_agg(status, n) AS counts
           FROM (SELECT status, COUNT(*)::int AS n FROM bench_trials WHERE run_id = r.id GROUP BY status) x
       ) c ON TRUE
      WHERE r.kind = 'studio'
      ORDER BY r.id DESC
      LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 20, 1), 100)],
  );
  return rows.map((r) => ({
    id: Number(r.id), status: r.status, models: r.models, contextPackIds: r.context_pack_ids || [],
    referencesPerBrief: Number(r.references_per_brief) || 0, capUsd: r.cap_usd, spentUsd: r.spent_usd,
    note: r.note, startedBy: r.started_by, createdAt: iso(r.created_at), finishedAt: iso(r.finished_at), counts: r.counts || {},
  }));
}

module.exports = {
  timelineOf,
  transcriptOf,
  SUITE_NAME,
  HOST_KEY,
  TODAY,
  REFERENCE_PREFIX,
  MAX_BRIEFS,
  MAX_MODELS,
  MAX_PACKS,
  MAX_REFERENCES,
  MAX_CONCURRENCY,
  MAX_LIVE_PREVIEWS,
  PREVIEW_HOURS,
  TRIAL_SPEC_CHARS,
  CAPTURE_CONTRACT,
  HAND_BACK,
  isHostApp,
  hostRow,
  ensureHost,
  ensureSuite,
  starterBriefs,
  resolveBriefs,
  studioKey,
  validateLaunch,
  launch,
  armOf,
  armLabel,
  codeLinks,
  previewOut,
  verdictOf,
  reviewRecord,
  trialOut,
  watchRun,
  referenceOrder,
  patchCommits,
  copyUserBranch,
  submitReference,
  rerunTrial,
  keepTrial,
  trialRows,
  trialDetail,
  deployPreview,
  sweepPreviews,
  gallery,
  listStudioRuns,
  _resetForTests() { lastPreviewSweepAt = 0; },
};
