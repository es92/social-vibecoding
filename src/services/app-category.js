'use strict';

// What kind of app a project is, for the directory's "kind" chips (#6585).
//
// A group may say in its own dapp.json (the `category` line, #3962). Most
// projects never did, or still carry the template's starting `other`, so the
// directory could only say "Other" about a mix of games, tools and learning
// apps. This works a kind out from the project's name and description with
// the platform's helper model, keeps the answer beside the description it was
// worked out from, and the directory reads it (public-app-directory.js
// directoryCategory) only when the project has not chosen one. A chosen kind
// always wins, including one set later by proposal.
//
// The answer changes nothing in the project's repository: its dapp.json
// still says what its group chose, or nothing.

const llm = require('./llm');
const log = require('./logger');
const { APP_CATEGORIES } = require('./app-categories');
const { HIDDEN_APP_STATUSES } = require('./public-app-directory');
const { FLAGGED_STATES } = require('./discovery-curation');

// How many projects one sweep works out before it returns. The clock runs it
// every ten minutes (workflow/clock/services.ts), so about 150 eligible apps
// fill in within an hour and then only changed descriptions are reworked.
const BATCH = 25;

// A new project waits at most this long at Make it; failing that it starts
// as Other and the sweep sorts it later.
const NEW_PROJECT_WAIT_MS = 6000;

// How long a failed call waits before it is tried again (the row stores a
// NULL category, and only an old NULL is eligible).
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

// The keys a group can choose, in the chips' order, less `other` (which
// means "not chosen").
const CHOSEN_KEYS = APP_CATEGORIES.filter((key) => key !== 'other');

// The one-line meaning each key has, for the model. The same words appear on
// the chip labels (frontend/locales/en/auth.json guest.category.*).
const MEANINGS = {
  games: 'a game people play together',
  social: 'a place for people to talk, share or meet each other',
  tools: 'a small utility that gets a job done: a list, a calculator, a tracker, a planner',
  learning: 'practising or studying something: a language, music, exam questions, a skill',
  creative: 'making something: drawing, writing, music, images',
  money: 'budgets, trading, splitting bills, a till',
  health: 'gym logs, runs, habits',
  food: 'recipes, baking, coffee, planning a meal together',
  other: 'only when it fits none of the other kinds',
};

const SYSTEM_PROMPT = [
  'You sort a small software project into one kind. Read the project\'s name and description and answer with exactly one key from this list, and nothing else:',
  ...APP_CATEGORIES.map((key) => `- ${key}: ${MEANINGS[key]}`),
  'Answer `other` only when the project fits none of the other kinds.',
].join('\n');

const CATEGORY_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    category: { type: 'string', enum: [...APP_CATEGORIES] },
  },
  required: ['category'],
});

// A manifest's `category` as a key, without the reader's warning: anything
// unknown or absent says nothing.
function keyOf(raw) {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return APP_CATEGORIES.includes(key) ? key : null;
}

// Whether a dapp.json kind is a choice: a real key other than `other`. A
// missing or unknown line, and the template's starting `other`, are not.
function isChosen(raw) {
  const key = keyOf(raw);
  return key != null && key !== 'other';
}

function userPrompt(name, description) {
  const text = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : '';
  return `Name: ${String(name || '').trim()}\nDescription: ${text || '(none)'}`;
}

// One helper call. A usable key is returned; an answer that is not one of
// the keys (or no answer at all) reads as `other`, because the model did
// answer and did not place the project. THROWS when no model answered, so
// the sweep can record a failure and try again later.
async function infer({ name, description, telemetryContext }) {
  const reply = await llm.inferAppCategory({
    system: SYSTEM_PROMPT,
    user: userPrompt(name, description),
    schema: CATEGORY_SCHEMA,
    maxTokens: 60,
    telemetryContext,
  });
  const answer = llm.helperTextAnswer(reply && reply.text);
  const key = keyOf(answer && answer.category);
  return key || 'other';
}

// The projects the sweep owes an answer: a public directory app whose
// dapp.json kind is not chosen, and that has no stored answer yet, an answer
// worked out from a different description, or a failed answer old enough to
// retry. The WHERE clause is the directory's own (public-app-directory.js
// listPublicApps), less the per-slug exception a sweep does not need.
async function candidates(pool, limit) {
  const chosen = CHOSEN_KEYS;
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.slug,
            COALESCE(a.manifest_snapshot->>'description', '') AS description,
            a.manifest_snapshot->>'category' AS category,
            ic.category AS inferred_category,
            ic.source_description AS inferred_source
       FROM apps a
       LEFT JOIN app_inferred_categories ic ON ic.app_id = a.id
      WHERE NOT a.self_hosted
        AND a.moderation_suspended_at IS NULL
        AND a.view_visibility = 'public'
        AND a.status <> ALL($1::text[])
        AND a.directory_review_status <> ALL($2::text[])
        AND lower(btrim(COALESCE(a.manifest_snapshot->>'category', ''))) <> ALL($3::text[])
        AND (
          ic.app_id IS NULL
          OR ic.source_description <> COALESCE(a.manifest_snapshot->>'description', '')
          OR (ic.category IS NULL AND ic.inferred_at < NOW() - make_interval(secs => $4))
        )
      ORDER BY ic.inferred_at NULLS FIRST, a.id
      LIMIT $5`,
    [HIDDEN_APP_STATUSES, FLAGGED_STATES, chosen, RETRY_AFTER_MS / 1000, limit]
  );
  return rows.filter((row) => !isChosen(row.category)).slice(0, limit);
}

async function store(pool, appId, category, description, model) {
  await pool.query(
    `INSERT INTO app_inferred_categories (app_id, category, source_description, model, inferred_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (app_id) DO UPDATE
       SET category = EXCLUDED.category,
           source_description = EXCLUDED.source_description,
           model = EXCLUDED.model,
           inferred_at = NOW()`,
    [appId, category, description || '', model || null]
  );
}

// Work out the kind of up to BATCH projects that need one. Returns
// { inferred, failed }. A failed call stores a NULL category, which counts as
// no answer and waits a day before it is tried again.
async function sweep(pool) {
  const rows = await candidates(pool, BATCH);
  let inferred = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const category = await infer({
        name: row.name,
        description: row.description,
        telemetryContext: { pool, appId: row.id, component: 'app_category' },
      });
      await store(pool, row.id, category, row.description, null);
      inferred++;
    } catch (err) {
      failed++;
      log.warn('app-category', 'Could not work out a project\'s kind', {
        appId: row.id, slug: row.slug, err: err.message,
      });
      await store(pool, row.id, null, row.description, null).catch((writeErr) => {
        log.warn('app-category', 'Could not record the failed kind', { appId: row.id, err: writeErr.message });
      });
    }
  }
  return { inferred, failed };
}

// The kind a project about to be made should start with. A stored answer
// worked out from the same description is reused, so a resumed setup writes
// the same files; otherwise the helper is asked within NEW_PROJECT_WAIT_MS.
// Never throws: any failure or timeout is Other, and the sweep tries later.
async function forNewProject(pool, row, description, { waitMs = NEW_PROJECT_WAIT_MS } = {}) {
  const text = typeof description === 'string' ? description : '';
  try {
    const { rows } = await pool.query(
      'SELECT category, source_description FROM app_inferred_categories WHERE app_id = $1',
      [row.id]
    );
    const stored = rows[0];
    if (stored && stored.source_description === text && keyOf(stored.category)) return keyOf(stored.category);
    const call = infer({
      name: row.name,
      description: text,
      telemetryContext: { pool, appId: row.id, component: 'app_category' },
    });
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), waitMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    let category = null;
    try {
      category = await Promise.race([call, timeout]);
    } finally {
      clearTimeout(timer);
    }
    // The call was paid for all the same: record whatever it answers.
    if (category == null) {
      call.then((late) => store(pool, row.id, late, text, null)).catch(() => {});
      return 'other';
    }
    await store(pool, row.id, category, text, null).catch((err) => {
      log.warn('app-category', 'Could not store a new project\'s kind', { appId: row.id, err: err.message });
    });
    return category;
  } catch (err) {
    log.warn('app-category', 'Could not work out a new project\'s kind', { appId: row.id, err: err.message });
    return 'other';
  }
}

module.exports = {
  isChosen, keyOf, infer, sweep, forNewProject, candidates,
  CHOSEN_KEYS, BATCH, NEW_PROJECT_WAIT_MS, SYSTEM_PROMPT, CATEGORY_SCHEMA,
};
