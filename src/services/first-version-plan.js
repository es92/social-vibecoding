'use strict';

/**
 * A first version's plan, written at "Make it" (newcomer run four, 12-13
 * October 2026).
 *
 * Until this, a first version's plan waited on the project: its request was
 * filed once the project ran (about 44 seconds after Make it), the bot's
 * triage then read the repository for half a minute to write the plan, and
 * the plan reached its maker as a card in their chat with Homeroom bot,
 * with a Build it button they found minutes later, after the tour. Now ONE
 * model call writes the same plan from the description the moment Make it
 * is pressed, alongside the sketch (services/app-sketch.js) and the setup:
 *
 *   bullets      3 to 5 short lines of what the first version will do
 *   questions    at most two choices, each with 2 to 4 answers, the
 *                suggested one first (homeroom-bot.js planQuestions)
 *   buildNote    what the triage would write for the spec: the screen's
 *                job and primary action, its colours, its signature
 *                element and a rough layout, with its assumptions
 *
 * The made screen (frontend/src/features/first-session/made.tsx) shows the
 * questions with the suggested answers chosen and a Submit button; Submit
 * records the answers here (recordAnswers). When the bot comes to the
 * request, it builds from this plan with no triage turn
 * (homeroom-bot.js planFromEarly): at once when the answers are in, or the
 * plan asks nothing; otherwise the plan waits for its maker as before, and
 * their Submit (or Build it in the chat) goes ahead with it.
 *
 * NEVER A WALL. The call has PLAN_WAIT_MS. A plan that fails, times out or
 * cannot be read is `failed`, and the request is read by the triage exactly
 * as before; so is one somebody asked to change (Change something), which
 * the triage plans again with their words.
 *
 * The model is the current first-version configuration's triage model
 * (services/bot-configs.js; GLM 5.3 Flash), asked through the helper path
 * the sketch uses (llm.js helperMessage, with its Haiku fallback). What it
 * cost is recorded against its maker, as the sketch's is. A GLM answer this
 * module's parse cannot read is no answer (usableAnswer), so Haiku is asked
 * (newcomer run five: GLM's plan was refused in 1.9 seconds and Haiku never
 * asked), and a reply still unreadable is logged by its shape, never its
 * words (replyShape).
 */

const log = require('./logger');
const { withoutEmDashes } = require('./em-dashes');

// The helper path's model (llm.js HELPER_MODEL), and the first versions'
// triage model in every configuration seeded so far (bot-configs.js GLM).
const PLAN_MODEL = 'z-ai/glm-5.3-flash';
// How long the call has before the plan is left to the triage. The helper
// gives GLM 20 seconds (llm.js HELPER_TIME_LIMIT_MS.first_version_plan)
// and Haiku what is left.
const PLAN_WAIT_MS = 45 * 1000;
// A pending plan older than this was left by a process that stopped while
// it was asked: it reads as failed, and nothing waits on it.
const STALE_PENDING_MS = 2 * 60 * 1000;
// How long the bot's read of the request waits for a plan still being
// written, at most, from Make it (whenReady below).
const READ_WAIT_MS = PLAN_WAIT_MS + 5 * 1000;
// The reply: a plan, its choices and a build note. Haiku's ceiling; GLM's is
// lower (llm.js HELPER_OUTPUT_LIMIT.first_version_plan), so a runaway fails
// in seconds.
const PLAN_MAX_TOKENS = 2000;
const BRIEF_MAX = 4000;

// The bounds are GLM's guidance (OpenRouter does not hold a tool call to
// them); Haiku's structured output is sent the schema without them
// (llm.js structuredOutputSchema), and parsePlanReply decides either way.
const PLAN_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    plan: { type: 'array', items: { type: 'string' }, minItems: 3 },
    choices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string' },
          answers: { type: 'array', items: { type: 'string' } },
        },
        required: ['question', 'answers'],
      },
    },
    build_note: { type: 'string', minLength: 40 },
    assumptions: { type: 'array', items: { type: 'string' } },
  },
  required: ['plan', 'choices', 'build_note', 'assumptions'],
});

// The first-version note's rules (homeroom-bot.js FIRST_VERSION_NOTE), for
// a call that reads the description rather than the repository.
const PLAN_SYSTEM = [
  'You plan the first version of a new app on Homeroom, where small groups of people (friends, a club, a household)',
  'make apps together. Its creator just made the project and described what it should do, in their own words. The',
  'app starts from Homeroom\'s starter template: one placeholder screen on Homeroom\'s design kit, with a light and a',
  'dark look that follow the viewer\'s Homeroom theme. A spec writer and a builder work from your plan; its creator',
  'sees it first.',
  '',
  'Respond with ONLY a JSON object, no prose before or after:',
  '{"plan": ["a line"], "choices": [{"question": "a question", "answers": ["the suggested answer", "another"]}],',
  ' "build_note": "a few lines", "assumptions": ["a line"]}',
  '',
  '- plan: 3 to 5 short lines of a few words each, at most 40 characters, saying in the creator\'s own terms what the',
  '  first version will do: what they will see and can do. No file names, code, colours or jargon. Plan a first',
  '  version a person can try: the app the description asks for, kept to its core.',
  // App bench run 196 (14 Oct 2026, Club Votes): "decide things together,
  // like where to meet or what to do next" was planned as yes, no or
  // abstain, the spec kept that scope, and 8 of 15 blind-graded builds
  // failed for it: none could offer a place or a plan to choose between.
  '- Kept to its core, never narrower than its words: it can do each example the description gives. Where people',
  '  choose or decide something ("which day", "which film"), plan the options they pick between, written by whoever',
  '  asks; plain yes or no only where the description asks for that.',
  '- choices: at most 2 decisions you would otherwise make yourself that change what they will see or do, each a',
  '  plain question with 2 to 4 short answers, the one you suggest first. They can pick another; one they leave goes',
  '  with yours. Only a choice they would care about, never the look or the theme. Often there are none: then give',
  '  an empty list.',
  '- Every answer to a question makes the app do something different from each other answer to it: picking another',
  '  answer gets them a different app. Never two answers that say the same thing in other words, or that would be',
  '  built the same way. Read each pair before you give them: where two come to the same thing, keep one, and a',
  '  question left with fewer than 2 real answers is no choice (leave it out).',
  // Newcomer run seven (14 Oct 2026, Club Votes): a line said "Vote yes, no
  // or maybe on each one" beside the question "How should votes be
  // counted?", its creator kept "Simple yes or no, most wins", and the spec,
  // bound by both, built a maybe that only yes and no decide.
  '- A plan line, the build_note and the assumptions never settle a point one of the choices asks: the creator\'s',
  '  answer decides it. Where a choice decides something, the line says what the app does without the answer',
  '  ("Vote on each decision", not "Vote yes, no or maybe on each one"), and the build_note leaves that point to the',
  '  answer.',
  '- build_note: a few plain lines for the spec writer: what the first version does, the screen\'s one job and its',
  '  one primary action, its colours (neutrals, an action colour and any colours the subject itself uses, each',
  '  working in both looks; not the starter\'s default palette), ONE signature element drawn from the app\'s subject',
  '  that no other app would have, and a rough layout. Say that it keeps a light and a dark look that follow the',
  '  viewer\'s Homeroom theme; only an app whose one fixed look is the point, such as a game drawn as its own scene,',
  '  keeps a single look. It is a first sketch: the spec that follows settles the look, the layout and the scope.',
  '- assumptions: one short plain line for each choice you made that the description did not state.',
  '- Sample names, dates and numbers are placeholders, never facts about the group, and never a plan line or a',
  '  choice. When the app involves the people in its group (whose turn it is, who did what, who sees what), plan',
  '  around the project\'s real members, listed under WHO IS IN THIS PROJECT when known, and around new members',
  '  joining later; never around people made up for an example.',
  '- Plain words: no markdown inside strings and no em dashes (use a comma, a colon or a full stop).',
].join('\n');

function oneLine(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * The call's user message: the project's name, its starter when it is a
 * game (services/app-templates.js `bot`), its creator, who is in it, the
 * language to answer in, and the description. Pure.
 */
function planUserPrompt({ name, brief, starter = null, maker = null, members = null, locale = null }) {
  const bot = require('./homeroom-bot');
  const s = starter ? require('./app-templates').botStarter(starter) : null;
  const creator = maker && maker.username ? `@${oneLine(maker.username, 40)}` : null;
  return [
    `APP NAME:\n${oneLine(name, 120)}`,
    s ? [
      `STARTER:\nIt is made from Homeroom's ${s.title}: ${s.bot.what}. It works already, live, for everyone in the project.`,
      `${s.bot.build}`,
      'Plan the creator\'s game built by changing that starter, never by starting over; the plan lines and the choices',
      'describe the creator\'s game, never the starter\'s example.',
    ].join('\n') : null,
    creator ? `THE CREATOR:\n${creator}` : null,
    bot.membersNote(members),
    locale ? `LANGUAGE:\nWrite the plan lines and the choices in the language of the locale \`${oneLine(locale, 20)}\`.` : null,
    `WHAT IT SHOULD DO (the creator's words):\n${String(brief || '').slice(0, BRIEF_MAX)}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * Pure: the reply read as a plan, or why it is none: { plan, why, json,
 * obj }. `json` is how far it got as JSON ('none': no braces, 'invalid',
 * 'not_object', 'object'); `why` is null with a plan, else 'no_json',
 * 'bad_json', 'not_object', 'no_plan' (no plan line survived) or 'no_note'.
 */
function readPlanReply(text) {
  const out = String(text || '');
  const first = out.indexOf('{');
  const last = out.lastIndexOf('}');
  if (first === -1 || last <= first) return { plan: null, why: 'no_json', json: 'none', obj: null };
  let obj;
  try { obj = JSON.parse(out.slice(first, last + 1)); } catch { return { plan: null, why: 'bad_json', json: 'invalid', obj: null }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { plan: null, why: 'not_object', json: 'not_object', obj: null };
  const bot = require('./homeroom-bot');
  const plain = (t) => withoutEmDashes(t);
  const lines = typeof obj.plan === 'string'
    ? obj.plan.split(/\r?\n/).map((line) => line.replace(/^\s*\d+[.)]\s+/, ''))
    : obj.plan;
  const bullets = bot.planBullets(lines).map(plain);
  const questions = bot.planQuestions(obj.choices)
    .map((q) => ({ question: plain(q.question), answers: q.answers.map(plain) }));
  const assumptions = bot.parseAssumptions(obj.assumptions);
  const rawNote = Array.isArray(obj.build_note)
    ? obj.build_note.filter((line) => typeof line === 'string').join('\n')
    : obj.build_note;
  const note = typeof rawNote === 'string' ? rawNote.trim().slice(0, 4000) : '';
  if (!bullets.length || !note) return { plan: null, why: bullets.length ? 'no_note' : 'no_plan', json: 'object', obj };
  return {
    plan: { bullets, questions, buildNote: bot.noteWithAssumptions(note, assumptions), assumptions },
    why: null, json: 'object', obj,
  };
}

/**
 * The reply as a plan: { bullets, questions, buildNote, assumptions }, or
 * null when it has no plan line or no build note. Cut and cleaned as a
 * triage verdict's plan is (homeroom-bot.js planBullets, planQuestions),
 * with no em dashes in anything people read. Pure.
 */
function parsePlanReply(text) {
  return readPlanReply(text).plan;
}

// A reply's shape keeps this many of its top-level keys, each named only
// when its name is a plain word.
const SHAPE_KEYS_MAX = 20;
const SHAPE_KEY_RE = /^[A-Za-z0-9_]{1,40}$/;

/** Pure: a JSON value's type, and its length where it has one (an array's items, a string's characters, an object's keys). */
function valueShape(value) {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const items = [...new Set(value.map((v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)))].sort();
    return { type: 'array', length: value.length, items };
  }
  if (typeof value === 'string') return { type: 'string', length: value.length };
  if (typeof value === 'object') return { type: 'object', length: Object.keys(value).length };
  return { type: typeof value };
}

/**
 * Pure (newcomer run five, 13 Oct 2026): the SHAPE of a reply the plan
 * could not use, for its row (early_plan_reply), never a word of it: its
 * length (`chars`), how far it got as JSON and why it was refused
 * (readPlanReply), its top-level keys with each value's type and length,
 * and from the call itself (`reply`, llm.js helperMessage) the finish
 * reason, how many tool calls it made, the length of the model's own text
 * beside them, and which provider served it. Run five's plan at Make it
 * was refused, and nothing said what had come back.
 */
function replyShape(text, reply = null) {
  const read = readPlanReply(text);
  const keys = read.obj ? Object.keys(read.obj).slice(0, SHAPE_KEYS_MAX)
    .map((key) => ({ key: SHAPE_KEY_RE.test(key) ? key : '?', ...valueShape(read.obj[key]) })) : [];
  const r = reply && typeof reply === 'object' ? reply : {};
  const count = (v) => (Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  const finish = typeof r.finishReason === 'string' && /^[a-z_]{1,32}$/i.test(r.finishReason) ? r.finishReason : null;
  const routed = typeof r.routedProvider === 'string' && /^[\w .-]{1,80}$/.test(r.routedProvider) ? r.routedProvider : null;
  return {
    chars: String(text || '').length,
    json: read.json,
    why: read.why,
    keys,
    ...(read.obj ? { keyCount: Object.keys(read.obj).length } : {}),
    finishReason: finish,
    toolCallCount: count(r.toolCallCount),
    textChars: count(r.textChars),
    routedProvider: routed,
  };
}

/** Pure: whether the helper's answer (an object) is a plan parsePlanReply can read. */
function usableAnswer(answer) {
  return parsePlanReply(JSON.stringify(answer)) !== null;
}

/**
 * The model the plan is asked of: the current first-version
 * configuration's triage model when the helper path can ask it (the helper
 * model), else the helper model, with a note. Never throws.
 */
async function planModel(pool, deps = {}) {
  try {
    const configs = deps.botConfigs || require('./bot-configs');
    const version = await configs.currentVersion(pool);
    const model = version?.recipe?.models?.triage || null;
    if (!model || model === PLAN_MODEL) return PLAN_MODEL;
    log.info('first-version-plan', 'The configuration\'s triage model is not a helper model; asking the helper model', { model });
  } catch (err) {
    log.warn('first-version-plan', 'Could not read the first versions\' configuration', { err: err.message });
  }
  return PLAN_MODEL;
}

const TIMED_OUT = Symbol('timed out');

function within(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** The creator, for the prompt: { username, locale }. Best effort. */
async function makerOf(pool, user) {
  try {
    const { rows } = await pool.query('SELECT username, locale FROM users WHERE id = $1', [user.id]);
    if (rows[0]) return { username: rows[0].username, locale: rows[0].locale || null };
  } catch (err) {
    log.warn('first-version-plan', 'Creator not read', { userId: user?.id, err: err.message });
  }
  return { username: user?.username || null, locale: null };
}

/**
 * The plan itself, from a project's name and description: the model's,
 * within PLAN_WAIT_MS, else none. What it cost is recorded against `user`.
 * Saves nothing. Resolves { plan, model, error }, `plan` null on failure.
 */
async function makePlan(pool, { app, user, brief, deps = {} }) {
  const llm = deps.llm || require('./llm');
  const limits = deps.limits || require('./limits');
  const bot = deps.bot || require('./homeroom-bot');
  let model = await planModel(pool, deps);
  const recordSpend = async (reply) => {
    if (!reply || !reply.usage || !user) return;
    try {
      await limits.recordSpend(pool, user.id, llm.estimateCostCents(reply.usage, reply.model || model), { byok: false });
    } catch (err) {
      log.warn('first-version-plan', 'Spend not recorded', { appId: app?.id, err: err.message });
    }
  };
  try {
    if (typeof llm.isEnabled === 'function' && !llm.isEnabled()) return { plan: null, model: null, error: 'no_model' };
    const maker = await makerOf(pool, user);
    const [members, starter] = await Promise.all([
      bot.projectMembers(pool, app).catch(() => null),
      bot.starterOfApp(pool, app.id).catch(() => null),
    ]);
    const call = llm.generateFirstVersionPlan({
      system: PLAN_SYSTEM,
      user: planUserPrompt({ name: app.name || app.slug, brief, starter, maker, members, locale: maker.locale }),
      model,
      schema: PLAN_SCHEMA,
      validate: usableAnswer,
      maxTokens: PLAN_MAX_TOKENS,
      telemetryContext: { pool, appId: app.id },
    });
    const reply = await within(call, deps.waitMs ?? PLAN_WAIT_MS);
    if (reply === TIMED_OUT) {
      // Paid for all the same, whenever it answers.
      call.then(recordSpend, () => {});
      return { plan: null, model, error: 'timeout' };
    }
    await recordSpend(reply);
    model = reply.model || model;
    const plan = parsePlanReply(reply.text);
    // A reply it cannot use keeps its shape (never its words) for the row.
    return plan ? { plan, model, error: null }
      : { plan: null, model, error: 'unusable_reply', shape: replyShape(reply.text, reply.reply) };
  } catch (err) {
    return { plan: null, model, error: String(err && err.message || 'failed').slice(0, 200) };
  }
}

/**
 * Store what makePlan made: ready with a plan, failed without one, and the
 * shape of a reply it could not use (replyShape).
 */
async function savePlan(pool, appId, { plan, model, error, shape = null }) {
  await pool.query(
    `UPDATE homeroom_bot_first_versions
        SET early_plan_status = $2, early_plan = $3::jsonb, early_plan_at = NOW(), early_plan_error = $4,
            early_plan_reply = $5::jsonb
      WHERE app_id = $1 AND early_plan_status = 'pending'`,
    [appId, plan ? 'ready' : 'failed', plan ? JSON.stringify({ ...plan, model: model || null }) : null, plan ? null : clip(error, 200),
      !plan && shape ? JSON.stringify(shape) : null],
  );
}

function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : null;
}

const pending = new Map();

/**
 * Start a first version's plan, once: claims the row (pending) and asks the
 * model in the background. Resolves whether it was started. Only a first
 * version the bot builds, with nothing asked yet; without a model (a
 * staging preview, a local stack) nothing is asked, and the triage plans it
 * as before. Once the plan is written, its early first look is started from
 * it, drawn in the worker of `bot`'s session for the app (`config` is the
 * server's). Never throws.
 */
async function startEarlyPlan(pool, { app, user, brief, config = null, bot = null }, deps = {}) {
  try {
    const llm = deps.llm || require('./llm');
    if (!app?.id || !user?.id || !brief) return false;
    if (typeof llm.isEnabled === 'function' && !llm.isEnabled()) return false;
    const { rows } = await pool.query(
      `UPDATE homeroom_bot_first_versions SET early_plan_status = 'pending'
        WHERE app_id = $1 AND user_id = $2 AND bot_builds = TRUE AND early_plan_status IS NULL
        RETURNING app_id`,
      [app.id, user.id],
    );
    if (!rows.length) return false;
    const work = makePlan(pool, { app, user, brief, deps })
      .then(async (made) => {
        await savePlan(pool, app.id, made);
        if (made.plan) {
          log.info('first-version-plan', 'A first version\'s plan is ready at Make it', {
            appId: app.id, questions: made.plan.questions.length, model: made.model,
          });
          // Its timeline's first stage (first-version-timeline.js), before
          // there is a run.
          await (deps.timeline || require('./first-version-timeline')).record(pool, {
            appId: app.id, stage: 'plan_written', detail: { source: 'make_it', questions: made.plan.questions.length },
          });
          // Newcomer run six (14 Oct 2026): and its first look, drawn from
          // this plan now, in a call of its own, so it is there by Submit
          // (first-version-early-look.js). Not waited on: whenReady waits
          // for the plan alone.
          void (deps.earlyLook || require('./first-version-early-look')).startEarlyLook(pool, {
            app, user, brief, plan: made.plan, config, bot,
          });
        } else {
          log.warn('first-version-plan', 'No plan at Make it; the triage plans it', {
            appId: app.id, error: made.error, model: made.model, ...(made.shape ? { why: made.shape.why, routedProvider: made.shape.routedProvider } : {}),
          });
        }
        return made;
      })
      .catch((err) => {
        log.warn('first-version-plan', 'The plan at Make it failed', { appId: app.id, err: err.message });
        return savePlan(pool, app.id, { plan: null, model: null, error: err.message }).catch(() => null);
      });
    pending.set(app.id, work);
    work.finally(() => pending.delete(app.id));
    return true;
  } catch (err) {
    log.warn('first-version-plan', 'The plan at Make it was not started', { appId: app?.id, err: err.message });
    return false;
  }
}

/** A first version's row, with its plan and answers, or null. */
async function readEarlyPlan(pool, appId) {
  const { rows } = await pool.query(
    `SELECT app_id, user_id, issue_number, status, created_at, bot_builds,
            early_plan, early_plan_status, early_plan_at, early_plan_error, answers, answered_at
       FROM homeroom_bot_first_versions WHERE app_id = $1`,
    [appId],
  );
  return rows[0] || null;
}

/** 'none', 'pending', 'ready' or 'failed': a pending plan left by a stopped process reads failed. Pure. */
function planStatus(row, now = Date.now()) {
  if (!row || !row.early_plan_status) return 'none';
  if (row.early_plan_status === 'pending') {
    const at = new Date(row.created_at).getTime();
    return Number.isFinite(at) && now - at > STALE_PENDING_MS ? 'failed' : 'pending';
  }
  if (row.early_plan_status === 'ready' && !planOf(row)) return 'failed';
  return row.early_plan_status;
}

/** The plan a row holds, cleaned: { bullets, questions, buildNote, model }, or null. Pure. */
function planOf(row) {
  const p = row && row.early_plan;
  if (!p || typeof p !== 'object' || !Array.isArray(p.bullets) || !p.bullets.length || typeof p.buildNote !== 'string') return null;
  return {
    bullets: p.bullets.filter((b) => typeof b === 'string' && b),
    questions: (Array.isArray(p.questions) ? p.questions : [])
      .filter((q) => q && typeof q.question === 'string' && Array.isArray(q.answers) && q.answers.length >= 2)
      .slice(0, 2)
      .map((q) => ({ question: q.question, answers: q.answers.filter((a) => typeof a === 'string' && a).slice(0, 4) })),
    buildNote: p.buildNote,
    model: typeof p.model === 'string' ? p.model : null,
  };
}

/** Pure: the answers a row holds, as strings, or null when none were recorded. */
function answersOf(row) {
  return row && row.answered_at && Array.isArray(row.answers)
    ? row.answers.map((a) => (typeof a === 'string' ? a : null))
    : null;
}

/**
 * Pure: whether the plan is decided, so the build needs no Build it: a
 * plan that asks nothing, or one whose answers are in.
 */
function decided(row) {
  const plan = planOf(row);
  return !!plan && (!plan.questions.length || !!row.answered_at);
}

/**
 * Pure: the answers to go ahead with, one per question: each an answer it
 * offers, else null (the suggested one, homeroom-bot.js choicesFrom).
 */
function cleanAnswers(questions, answers) {
  const list = Array.isArray(answers) ? answers : [];
  return (Array.isArray(questions) ? questions : []).map((q, i) => {
    const a = typeof list[i] === 'string' ? list[i] : null;
    return a && Array.isArray(q?.answers) && q.answers.includes(a) ? a : null;
  });
}

/**
 * The plan once it is no longer being written, waiting for one in hand here
 * and watching the row for one in another process, until READ_WAIT_MS after
 * Make it at most. Resolves the row (whatever it holds). Never throws.
 */
async function whenReady(pool, appId, { pollMs = 1000, now = Date.now } = {}) {
  try {
    const work = pending.get(appId);
    let row = await readEarlyPlan(pool, appId);
    if (!row || planStatus(row, now()) !== 'pending') return row;
    const deadline = new Date(row.created_at).getTime() + READ_WAIT_MS;
    if (work) {
      let timer;
      await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, deadline - now())); })]);
      clearTimeout(timer);
      row = await readEarlyPlan(pool, appId);
    }
    while (row && planStatus(row, now()) === 'pending' && now() + pollMs <= deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      // eslint-disable-next-line no-await-in-loop
      row = await readEarlyPlan(pool, appId);
    }
    return row;
  } catch (err) {
    log.warn('first-version-plan', 'Could not read a first version\'s plan', { appId, err: err.message });
    return null;
  }
}

/**
 * Its maker's answers, from the made screen's Submit: kept once, the first
 * time (a second Submit changes nothing), each an answer its question
 * offers or null for the suggested one. `questions` are the ones they were
 * shown. Resolves { recorded, answers }: `recorded` false when answers were
 * already in or the row is not theirs.
 */
async function recordAnswers(pool, { appId, userId, questions, answers }) {
  const clean = cleanAnswers(questions, answers);
  const { rows } = await pool.query(
    `UPDATE homeroom_bot_first_versions SET answers = $3::jsonb, answered_at = NOW()
      WHERE app_id = $1 AND user_id = $2 AND bot_builds = TRUE AND answered_at IS NULL
      RETURNING answers`,
    [appId, userId, JSON.stringify(clean)],
  );
  if (rows.length) return { recorded: true, answers: clean };
  const row = await readEarlyPlan(pool, appId);
  return { recorded: false, answers: answersOf(row) || clean };
}

/**
 * The plan was decided some other way (Build it in the chat, or a plan
 * that asked nothing): when, for the build's steps, and the answers it
 * went with. Once. Never throws.
 */
async function noteDecided(pool, { appId, issueNumber, answers = [] }) {
  await pool.query(
    `UPDATE homeroom_bot_first_versions SET answers = COALESCE(answers, $3::jsonb), answered_at = COALESCE(answered_at, NOW())
      WHERE app_id = $1 AND issue_number = $2 AND bot_builds = TRUE`,
    [appId, issueNumber, JSON.stringify(Array.isArray(answers) ? answers : [])],
  ).catch((err) => log.warn('first-version-plan', 'Could not note a decided plan', { appId, err: err.message }));
}

module.exports = {
  PLAN_MODEL,
  PLAN_WAIT_MS,
  READ_WAIT_MS,
  STALE_PENDING_MS,
  PLAN_SCHEMA,
  PLAN_SYSTEM,
  planUserPrompt,
  parsePlanReply,
  usableAnswer,
  replyShape,
  planModel,
  makePlan,
  startEarlyPlan,
  readEarlyPlan,
  planStatus,
  planOf,
  answersOf,
  decided,
  cleanAnswers,
  whenReady,
  recordAnswers,
  noteDecided,
  _pendingForTests: pending,
};
