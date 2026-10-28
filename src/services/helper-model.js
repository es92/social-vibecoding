'use strict';

// The model the platform's helper calls ask first (llm.js helperMessage and
// services/small-change.js): the short housekeeping calls behind titles,
// the one-line description, the sketch card, the plan at Make it, chat
// reads, quick replies, the progress guess, report summaries, the Workshop
// ask box, the content review and challenge grades. Haiku stays behind it.
//
// It was GLM 5.3 Flash, fixed in code. It is now an admin setting too,
// stored in platform_settings and edited from Admin → Homeroom bot →
// Settings → Models, read here through a short cache so every server
// follows a save within CACHE_TTL_MS with no deploy. Blank is BUILT_IN.
//
// Measured 19 Oct 2026 on the helpers' own prompts, schemas, ceilings and
// time limits (38 made-up inputs): DeepSeek V4.1 Flash 1017 with its thinking
// off answered all 76 calls of two runs, each within its limit, the plan at
// Make it in 1.7 s at the median against GLM's 4.6 s, quick replies in 0.6 s
// against 0.7 s, and the content review got the same 8 of 8 verdicts. With
// its thinking on, 1017 gave no usable plan in 15 calls (14 cut off at the
// 1,200-token ceiling), and at 'minimal' under a 4,096 ceiling it still
// thought for about 1,600 tokens at the median and took 12 s. So a model
// other than GLM is asked with its thinking off (thinkingFor), as the Haiku
// fallback already is.

const log = require('./logger');
const { MODEL_ID_RE } = require('./default-model');

const KEY = 'helper_model';
const BUILT_IN = 'z-ai/glm-5.3-flash';
const CACHE_TTL_MS = 10 * 1000;

let cache = null;

function parseStored(raw) {
  const id = String(raw == null ? '' : raw).trim();
  return MODEL_ID_RE.test(id) ? id : null;
}

/**
 * The helper model in force: the admin's setting, else BUILT_IN. Read on
 * `pool` when given (a caller that has one), else on the app's pool from
 * `config`; with neither, BUILT_IN. Never throws: a read that fails keeps
 * the built-in model, so helpers keep answering.
 */
async function current(config, { pool = null } = {}) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.model;
  let model = BUILT_IN;
  try {
    const db = pool || (config && config.databaseUrl ? require('../db/pool').getPool(config) : null);
    if (db) {
      const { rows } = await db.query('SELECT value FROM platform_settings WHERE key = $1', [KEY]);
      model = parseStored(rows && rows[0] && rows[0].value) || BUILT_IN;
    }
  } catch (err) {
    log.warn('helper-model', 'Helper model setting read failed; using the built-in model', { err: err.message });
  }
  cache = { model, at: Date.now() };
  return model;
}

/**
 * The reasoning a helper call sends with `model`: 'low' for GLM, as it
 * always was (it thinks for a few dozen tokens there), else 'none', its
 * thinking off (services/openrouter.js sends `{ enabled: false }`). Pure.
 */
function thinkingFor(model) {
  return /^~?z-ai\/glm-/i.test(String(model || '')) ? 'low' : 'none';
}

function invalidate() {
  cache = null;
}

module.exports = { KEY, BUILT_IN, CACHE_TTL_MS, parseStored, current, thinkingFor, invalidate };
