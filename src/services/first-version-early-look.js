'use strict';

/**
 * A first version's EARLY first look (newcomer run six, 14 October 2026).
 *
 * Run six's maker answered the plan at Make it and pressed Submit about 40
 * seconds in, then went through the 76-second tour; the first look came only
 * when the build's spec saved its main screen, 2.5 to 3 minutes after Submit,
 * so the tour's last card and the invite ask had no picture. Asking the spec
 * to save its main screen first (#4994) did not bring it forward in practice.
 * So the first look is now drawn on its own, from the plan, the moment the
 * plan at Make it is written (first-version-plan.js runEarlyPlan, as the
 * project's app-creation work: app.plan, then app.earlyLook):
 *
 *   THE DRAWING  one short model call (LOOK_MODEL at LOOK_EFFORT, through
 *                llm.js generateFirstLook, so its llm_invocation telemetry
 *                is the helpers') draws the app's main screen as ONE
 *                <template data-screen>, the element the spec saves with
 *                `usernode-screen 1`, under the spec's own drawing rules
 *                (prompts.js FIRST_VERSION_SCREENS_BRIEF), the starter's
 *                design kit (template.js DESIGN_KIT_CSS) and the design
 *                skill the spec and the build read (design-skill.js). The
 *                plan's questions are not answered yet, so their suggested
 *                answers stand in. What it cost is its maker's, as the plan's.
 *   THE PICTURE  drawn the one way a first look is drawn
 *                (first-version-screens.js drawScreenPng: the native kit's
 *                stylesheet, scripts off, no network, 390x844) in a worker:
 *                the app's bot session's (homeroom-bot.js ensureBotSession),
 *                the one its triage would have read the request in before
 *                the plan at Make it made that read unnecessary. It is
 *                started while the model draws, once the project's
 *                repository exists.
 *   KEPT         by project (first_version_early_looks), since there is no
 *                run yet, with `first_look_saved` { from: 'early' } on the
 *                first version's timeline (first-version-timeline.js).
 *   SHOWN        as the first look (first-version-screens.js showcaseOf and
 *                readScreen fall back to it: shownFor, pictureFor) until the
 *                run has one of its own, and only while the run is the one
 *                built from this plan (forRun). The spec's own first look
 *                replaces it the moment it is saved, as before. From the
 *                moment it is drawn until its picture is saved, the drawn
 *                screen itself stands in (screenFor), served as an inert
 *                document (first-version-screens.js readDrawnDocument).
 *   KEPT TO      the build's spec starts its main screen from it (forSpec,
 *                homeroom-bot-live.js EARLY_LOOK_LINES), so the app keeps
 *                the promise the picture made.
 *
 * NEVER A WALL. A drawing that fails, times out, cannot be read or cannot
 * be pictured is `failed` with a short code in `error`, logged, and nothing
 * waits on it: the spec draws its first look as before. The spec waits for
 * a drawing still being made at most SPEC_WAIT_MS.
 *
 * HOMEROOM_BOT_EARLY_FIRST_LOOK=0 turns it off (nothing drawn, shown or
 * handed to a spec); HOMEROOM_BOT_EARLY_FIRST_LOOK_MODEL names another
 * Claude model for the drawing.
 */

const log = require('./logger');

// Claude Sonnet 5.5 at low effort: its drawing sets the look the spec (Opus
// 5.5) then refines and the build makes, so it needs the spec's quality of
// design, and it must be in within about a minute. Sonnet writes a screen of
// about 10,000 characters (3,000 tokens or so) well inside MODEL_WAIT_MS at
// low effort; Opus would take about twice as long, and GLM 5.3 Flash and
// Haiku 5.5, though quicker, draw a plainer screen than the spec would.
const LOOK_MODEL = 'claude-sonnet-5-5';
const LOOK_EFFORT = 'low';
// Room for a screen of SCREEN_BUDGET characters and the little thinking low
// effort does; a runaway ends at the cap, as `cut_off`.
const LOOK_MAX_TOKENS = 16000;
const SCREEN_BUDGET = 10000;
// A screen longer than this is not one (the spec's own are measured
// against 20,000, spec-html.js SCREEN_CHAR_BUDGET).
const SCREEN_MAX_CHARS = 40 * 1000;
// How long the drawing has; the whole first look, picture included, has
// LOOK_DEADLINE_MS from the start. By then the spec's own is on its way.
const MODEL_WAIT_MS = 70 * 1000;
const LOOK_DEADLINE_MS = 3 * 60 * 1000;
const REPO_POLL_MS = 2000;
// How long the build's spec waits for a drawing still being made.
const SPEC_WAIT_MS = 30 * 1000;
const SPEC_POLL_MS = 1000;
const BRIEF_MAX = 4000;
const MODEL_RE = /^claude-[a-z0-9][a-z0-9-]{0,62}$/;

/** Whether early first looks are on (HOMEROOM_BOT_EARLY_FIRST_LOOK=0 turns them off). Pure. */
function enabled(env = process.env) {
  return String(env.HOMEROOM_BOT_EARLY_FIRST_LOOK ?? '').trim() !== '0';
}

/** The model the drawing is asked of: LOOK_MODEL, or a Claude model the env names. Pure. */
function lookModel(env = process.env) {
  const named = String(env.HOMEROOM_BOT_EARLY_FIRST_LOOK_MODEL ?? '').trim();
  return MODEL_RE.test(named) ? named : LOOK_MODEL;
}

function oneLine(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function screens() {
  return require('./first-version-screens');
}

// ── The prompt ───────────────────────────────────────────────────────────

const LOOK_RULES = [
  'You draw the FIRST LOOK at a new app on Homeroom, where small groups of people (friends, a club, a household) make',
  'apps together. Its creator has just described it, and a plan was written from that. They see your drawing within a',
  'minute, while the app is built, as the picture of what they are getting, and the build then makes this screen. So',
  'draw the app a careful product designer would ship, not a wireframe: real content, a clear hierarchy and the',
  'subject\'s own details.',
  '',
  'Draw ONE screen: the main screen of the finished first version on a phone, 390 pixels wide, as it looks once its',
  'group has used it for a while. Respond with ONLY that screen, one element, with nothing before or after it and no',
  'code fence:',
  '',
  '<template data-screen data-size="phone" data-height="H">',
  '  <style>...</style>',
  '  <div data-side="after" data-change="1">...the whole screen...</div>',
  '</template>',
  '',
  '- H is the screen\'s real scroll length in pixels, from 844 to 1400. The picture shows its top 844 pixels, so the',
  '  app\'s header, its signature element and its first rows are there.',
  '- The screen has no stylesheet of the app\'s: write plain CSS in its one <style> block for everything you use, the',
  '  kit\'s component class names included (btn-primary, btn-secondary, field, list, list-row, card, section-label).',
  '  Define the colours as CSS custom properties named after the kit\'s tokens and written as the kit writes them,',
  '  "R G B" values used as rgb(var(--accent)): --ground, --surface, --raised, --fg, --muted, --line, --accent and',
  '  --on-accent, plus a token for any colour the subject needs. Set them on the outer div, which also gets the',
  '  ground as its background and H as its min-height.',
  '- The light look only. System typefaces only (such as ui-rounded, ui-serif, ui-monospace or system-ui, each with a',
  '  fallback stack): no web fonts.',
  '- Its content is realistic and varied: the viewer\'s own things as well as other people\'s, filling the screen. The',
  '  viewer is "You"; anybody else has a plain first name. Dates, times and numbers are plausible. No "Sample data"',
  '  label, no placeholder text and nothing about the drawing itself: every word on it is the app\'s own.',
  // Newcomer run seven (14 Oct 2026): Club Votes, whose description never
  // mentioned chess, was drawn titled "Harbour Road Chess Club".
  // Newcomer run eight (14 Oct 2026): told it "uses APP NAME exactly", the
  // same project's look printed the words APP NAME above its title. So the
  // rule points at the name, the user message spells it out
  // (lookUserPrompt), and a label drawn anyway becomes the name (namedScreen).
  '- Wherever the screen names the app, its group or its place (a header, a title, the line above a title), it uses',
  '  the app\'s name, given in the user message, exactly: never invent a name for the club, team, group, household or',
  '  place. Sample people, posts and numbers are still made up.',
  '- Where the plan asks its creator a question, draw its suggested answer, the first: they have not answered yet.',
  '- The plan\'s build note is a first sketch: keep its screen\'s job, its primary action, its colours and its',
  '  signature element unless you can name a defect, and draw everything else as you judge best.',
  '- Nothing that runs or loads: no script, no event handler attribute, no link to another site, no image by URL.',
  '- Plain words, and no em dashes (use a comma, a colon or a full stop).',
].join('\n');

// The type scale the starter's tailwind.config.js sets (template.js).
const TYPE_SCALE = 'Its type scale is four sizes, and nothing in between: title 28px bold (line 36px), heading 20px '
  + 'semibold (28px), body 16px (24px), small 14px (20px).';

let systemCache = null;

/**
 * The drawing's system prompt: the rules above, the spec's own drawing
 * rules for a first version's screens at this screen's budget, the
 * starter's design kit, and the design skill. Built once. Pure but for
 * reading the platform's own files.
 */
function lookSystem() {
  if (systemCache) return systemCache;
  const brief = require('./prompts').FIRST_VERSION_SCREENS_BRIEF;
  const at = brief.indexOf('Draw at the app\'s REAL fidelity');
  const fidelity = at >= 0
    ? brief.slice(at).replace(/stays within about [\d,]+ characters/, `stays within about ${SCREEN_BUDGET.toLocaleString('en-US')} characters`)
    : '';
  const skill = (require('./design-skill').skillFiles().find((f) => /SKILL\.md$/.test(f.path)) || {}).content || '';
  const skillBody = skill.replace(/^---[\s\S]*?\n---\s*\n/, '').trim();
  systemCache = [
    LOOK_RULES,
    fidelity ? `\n${fidelity}` : null,
    '',
    'THE DESIGN KIT the app is built on, its stylesheet as the app has it (in Tailwind: write the plain CSS each part',
    `needs). ${TYPE_SCALE}`,
    String(require('./template').DESIGN_KIT_CSS || '').trim(),
    skillBody ? '' : null,
    skillBody ? 'THE DESIGN SKILL the spec and the build follow, for the choices you make here (what it says about files is theirs):' : null,
    skillBody || null,
  ].filter((part) => part != null).join('\n');
  return systemCache;
}

/**
 * The drawing's user message: the project's name and where to write it,
 * its game starter, the language to write in, the plan (its lines, its
 * questions with the suggested answers, its build note) and the
 * description. Pure.
 */
function lookUserPrompt({ name, brief, plan, starter = null, locale = null }) {
  const s = starter ? require('./app-templates').botStarter(starter) : null;
  const questions = Array.isArray(plan?.questions) ? plan.questions : [];
  const named = oneLine(name, 120);
  return [
    `THE APP'S NAME:\n${named}\nWherever the screen names the app, its group or its place, write "${named}": never the `
      + 'heading above, and never a name you invent.',
    s ? [
      `STARTER:\nIt is made from Homeroom's ${s.title}: ${s.bot.what}. ${s.bot.build}`,
      'Draw the creator\'s game as that starter becomes once it is changed into it, never the starter\'s own example.',
    ].join('\n') : null,
    locale ? `LANGUAGE:\nWrite every word on the screen in the language of the locale \`${oneLine(locale, 20)}\`.` : null,
    `THE PLAN (what the first version will do):\n${(plan?.bullets || []).map((b) => `- ${oneLine(b, 200)}`).join('\n')}`,
    questions.length ? [
      'ITS QUESTIONS, NOT ANSWERED YET (draw the suggested answer, the first):',
      ...questions.map((q) => `- ${oneLine(q.question, 300)} Suggested: ${oneLine(q.answers[0], 120)}.`
        + `${q.answers.length > 1 ? ` The others: ${q.answers.slice(1).map((a) => oneLine(a, 120)).join('; ')}.` : ''}`),
    ].join('\n') : null,
    `THE BUILD NOTE (for the spec writer: the screen's job, its primary action, colours, signature element and layout):\n${String(plan?.buildNote || '').slice(0, 4000)}`,
    `WHAT IT SHOULD DO (the creator's words):\n${String(brief || '').slice(0, BRIEF_MAX)}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * The screen a reply holds: its one <template data-screen> element, whole,
 * when it is one the first look can be drawn from and no longer than
 * SCREEN_MAX_CHARS; else null. Pure.
 */
function screenOf(text) {
  const fvs = screens();
  const screen = fvs.savedTemplateOf(text);
  if (!screen || screen.length > SCREEN_MAX_CHARS) return null;
  return fvs.mainScreenOf(fvs.screenDocument(screen)) ? screen : null;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A text that is the words APP NAME and nothing else, in any case.
const NAME_LABEL_RE = />(\s*)app\s+name(\s*)</gi;

/**
 * `screen` with every text that is only the words APP NAME (any case,
 * trimmed) written as the app's `name`, escaped; every other text as drawn
 * (newcomer run eight printed the label above its title). Pure.
 */
function namedScreen(screen, name) {
  const named = oneLine(name, 120);
  if (typeof screen !== 'string' || !named) return screen;
  return screen.replace(NAME_LABEL_RE, (_, before, after) => `>${before}${escapeHtml(named)}${after}<`);
}

// ── Drawing it ───────────────────────────────────────────────────────────

const TIMED_OUT = Symbol('timed out');

function within(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms)); }),
  ]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function failure(code, message = null) {
  return Object.assign(new Error(message || code), { code });
}

/** The maker's language preference, or null. Never throws. */
async function localeOf(pool, user) {
  try {
    const { rows } = await pool.query('SELECT locale FROM users WHERE id = $1', [user.id]);
    return rows[0]?.locale || null;
  } catch {
    return null;
  }
}

/**
 * The screen itself, from the plan: the model's, within MODEL_WAIT_MS, else
 * none. What it cost is recorded against `user`. Saves nothing. Resolves
 * { screen, model, error }, `screen` null on failure with a short code.
 */
async function drawScreen(pool, { app, user, brief, plan }, deps = {}) {
  const llm = deps.llm || require('./llm');
  const limits = deps.limits || require('./limits');
  const model = lookModel(deps.env || process.env);
  const recordSpend = async (reply) => {
    if (!reply || !reply.usage || !user) return;
    try {
      await limits.recordSpend(pool, user.id, llm.estimateCostCents(reply.usage, reply.model || model), { byok: false });
    } catch (err) {
      log.warn('first-version-early-look', 'Spend not recorded', { appId: app?.id, err: err.message });
    }
  };
  try {
    if (typeof llm.isEnabled === 'function' && !llm.isEnabled()) return { screen: null, model: null, error: 'no_model' };
    const waitMs = deps.modelWaitMs ?? MODEL_WAIT_MS;
    const name = app.name || app.slug;
    const [starter, locale] = await Promise.all([
      (deps.bot || require('./homeroom-bot')).starterOfApp(pool, app.id).catch(() => null),
      localeOf(pool, user),
    ]);
    const call = llm.generateFirstLook({
      system: lookSystem(),
      user: lookUserPrompt({ name, brief, plan, starter, locale }),
      model,
      effort: LOOK_EFFORT,
      maxTokens: LOOK_MAX_TOKENS,
      timeoutMs: waitMs,
      telemetryContext: { pool, appId: app.id },
    });
    const reply = await within(call, waitMs);
    if (reply === TIMED_OUT) {
      // Paid for all the same, whenever it answers.
      call.then(recordSpend, () => {});
      return { screen: null, model, error: 'timeout' };
    }
    await recordSpend(reply);
    const screen = screenOf(reply && reply.text);
    if (screen) return { screen: namedScreen(screen, name), model: reply.model || model, error: null };
    return { screen: null, model: reply?.model || model, error: reply?.stopReason === 'max_tokens' ? 'cut_off' : 'unusable_reply' };
  } catch (err) {
    log.warn('first-version-early-look', 'The drawing failed', { appId: app?.id, err: err.message });
    return { screen: null, model, error: 'failed' };
  }
}

/**
 * The worker the picture is drawn in: the app's bot session's (the one its
 * triage reads requests in), started once the project's repository exists
 * (app-creator.js sets repo_url after its first commit is pushed), on
 * scratch storage as the triage's is; not once `stopped()` says the drawing
 * failed. Resolves the container's name; throws an error with a short `code`.
 */
async function prepareWorker(pool, { app, config, bot, deadline, stopped = () => false }, deps = {}) {
  const now = deps.now || Date.now;
  const worker = deps.worker || require('./worker');
  const hb = deps.bot || require('./homeroom-bot');
  const pollMs = deps.repoPollMs ?? REPO_POLL_MS;
  let row = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await pool.query(
      'SELECT id, slug, name, repo_url, self_hosted, status FROM apps WHERE id = $1', [Number(app.id)],
    );
    row = rows[0] || null;
    if (!row) throw failure('no_app');
    if (stopped()) throw failure('stopped');
    if (row.repo_url) break;
    if (row.status === 'error' || now() + pollMs > deadline) throw failure('no_repo');
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMs);
  }
  const repo = hb.parseRepo(row.repo_url);
  if (!repo) throw failure('no_repo');
  const session = await hb.ensureBotSession(pool, config || {}, bot, row);
  await worker.ensureWorkerImage();
  // A drawing that already failed needs no worker.
  if (stopped()) throw failure('stopped');
  return worker.ensureWorker(session.id, {
    repoOwner: repo.owner, repoName: repo.repo, branchName: session.branch_name,
    temporary: true, onProgress: () => {},
  });
}

async function claim(pool, appId) {
  const { rows } = await pool.query(
    `INSERT INTO first_version_early_looks (app_id, status) VALUES ($1, 'pending')
     ON CONFLICT (app_id) DO NOTHING
     RETURNING app_id`,
    [Number(appId)],
  );
  return rows.length > 0;
}

async function saveDrawn(pool, appId, { screen, model }) {
  await pool.query(
    `UPDATE first_version_early_looks SET status = 'drawn', screen = $2, model = $3, drawn_at = NOW()
      WHERE app_id = $1 AND status = 'pending'`,
    [Number(appId), screen, model || null],
  );
}

async function saveReady(pool, appId, png) {
  const data = Buffer.isBuffer(png.data) ? png.data : Buffer.from(png.data || '');
  const { rows } = await pool.query(
    `UPDATE first_version_early_looks
        SET status = 'ready', png = $2, width = $3, height = $4, bytes = $5, error = NULL, saved_at = NOW()
      WHERE app_id = $1 AND status = 'drawn'
      RETURNING saved_at`,
    [Number(appId), data, Number(png.width) || null, Number(png.height) || null, data.length],
  );
  return rows.length > 0;
}

async function saveFailed(pool, appId, error, model = null) {
  await pool.query(
    `UPDATE first_version_early_looks SET status = 'failed', error = $2, model = COALESCE(model, $3)
      WHERE app_id = $1 AND status IN ('pending', 'drawn')`,
    [Number(appId), String(error || 'failed').slice(0, 200), model || null],
  );
}

/**
 * Draw the early first look and keep it: the screen from the model while
 * the worker starts, then its picture in that worker. Resolves
 * { ok, error }; never throws.
 */
async function drawEarlyLook(pool, { app, user, brief, plan, config, bot }, deps = {}) {
  const now = deps.now || Date.now;
  const started = now();
  const deadline = started + (deps.deadlineMs ?? LOOK_DEADLINE_MS);
  const worker = deps.worker || require('./worker');
  const fail = async (error, extra = {}) => {
    await saveFailed(pool, app.id, error, extra.model).catch(() => null);
    log.warn('first-version-early-look', 'No early first look; the spec draws it', {
      appId: app.id, error, ms: now() - started, ...extra,
    });
    return { ok: false, error };
  };
  // Started while the model draws: the first commit is usually pushed and
  // the worker up by the time the screen is in.
  let gaveUp = false;
  const ready = prepareWorker(pool, { app, config, bot, deadline, stopped: () => gaveUp }, deps);
  ready.catch(() => {});
  const drawn = await drawScreen(pool, { app, user, brief, plan }, deps);
  if (!drawn.screen) {
    gaveUp = true;
    return fail(drawn.error || 'failed', { model: drawn.model });
  }
  await saveDrawn(pool, app.id, drawn);
  const drawMs = now() - started;
  let containerName;
  try {
    containerName = await within(ready, deadline - now());
  } catch (err) {
    return fail(err.code || 'worker', { model: drawn.model, err: String(err.message || '').slice(0, 200) });
  }
  if (containerName === TIMED_OUT || !containerName) return fail('worker_timeout', { model: drawn.model });
  const png = await screens().drawScreenPng({
    worker, containerName, specHtml: screens().screenDocument(drawn.screen),
    timeoutMs: Math.max(15 * 1000, Math.min(90 * 1000, deadline - now())),
  }).catch((err) => {
    log.warn('first-version-early-look', 'The early first look could not be pictured', { appId: app.id, err: err.message });
    return null;
  });
  if (!png) return fail('no_picture', { model: drawn.model });
  if (!(await saveReady(pool, app.id, png))) return { ok: false, error: 'superseded' };
  const ms = now() - started;
  log.info('first-version-early-look', 'A first version\'s early first look is saved', {
    appId: app.id, model: drawn.model, drawMs, ms, chars: drawn.screen.length,
  });
  await (deps.timeline || require('./first-version-timeline')).record(pool, {
    appId: app.id, stage: 'first_look_saved', detail: { from: 'early', drawMs, ms },
  });
  return { ok: true, error: null };
}

/**
 * A first version's early first look, from its plan at Make it: the
 * app-creation machine's app.earlyLook, owed once its plan is written
 * (first-version-plan.js runEarlyPlan). Claims its row (pending) and draws
 * it, in the worker of the bot's session for the app (`config` is the
 * process's). Not without the switch, a model, a plan or the bot. A claim an
 * earlier try of the same work made (`steps`, the item's) is drawn again.
 * Resolves { ok, error } or { skipped }.
 */
async function runEarlyLook(pool, { appId, config = null, steps = null }, deps = {}) {
  if (!enabled(deps.env || process.env)) return { skipped: 'off' };
  const llm = deps.llm || require('./llm');
  if (typeof llm.isEnabled === 'function' && !llm.isEnabled()) return { skipped: 'no_model' };
  const fvPlan = require('./first-version-plan');
  const { rows: [row] } = await pool.query(
    `SELECT f.user_id, f.brief, f.early_plan, f.early_plan_status, a.id, a.name, a.slug
       FROM homeroom_bot_first_versions f JOIN apps a ON a.id = f.app_id
      WHERE f.app_id = $1`,
    [Number(appId)],
  );
  const plan = row && row.early_plan_status === 'ready' ? fvPlan.planOf(row) : null;
  if (!plan) return { skipped: 'no_plan' };
  const bot = deps.botUser || await require('./homeroom-bot').ensureBotUser(pool, config || {});
  if (!bot?.id) return { skipped: 'no_bot' };
  const claimOnce = () => claim(pool, row.id);
  if (!(steps ? await steps.once('claim', claimOnce) : await claimOnce())) return { skipped: 'claimed' };
  const app = { id: row.id, name: row.name, slug: row.slug };
  return drawEarlyLook(pool, { app, user: { id: row.user_id }, brief: row.brief, plan, config, bot }, deps)
    .catch(async (err) => {
      log.warn('first-version-early-look', 'The early first look failed', { appId: app.id, err: err.message });
      await saveFailed(pool, app.id, 'failed');
      return { ok: false, error: 'failed' };
    });
}

// ── Reading it ───────────────────────────────────────────────────────────

/**
 * Pure: whether the early first look belongs to `run` (the first version's
 * newest ready run, or null before there is one): before a run, yes; with
 * one, only when it is built from the plan the look was drawn from, its
 * build note that plan's (Build it adds what its creator approved after it).
 * A plan its creator asked to change is planned again, and its run is not.
 */
function forRun(run, planNote) {
  if (!run) return true;
  const note = typeof planNote === 'string' ? planNote : '';
  return !!note && String(run.build_note || '').startsWith(note);
}

const SHOWN_SQL = `SELECT l.status, l.saved_at, l.drawn_at, l.png IS NOT NULL AS has_png, l.screen IS NOT NULL AS has_screen,
       f.early_plan->>'buildNote' AS plan_note
  FROM first_version_early_looks l
  LEFT JOIN homeroom_bot_first_versions f ON f.app_id = l.app_id
 WHERE l.app_id = $1`;

const PICTURE_SQL = `SELECT l.status, l.png, f.early_plan->>'buildNote' AS plan_note
  FROM first_version_early_looks l
  LEFT JOIN homeroom_bot_first_versions f ON f.app_id = l.app_id
 WHERE l.app_id = $1`;

const SPEC_SQL = `SELECT l.status, l.screen, l.created_at, f.early_plan->>'buildNote' AS plan_note
  FROM first_version_early_looks l
  LEFT JOIN homeroom_bot_first_versions f ON f.app_id = l.app_id
 WHERE l.app_id = $1`;

/**
 * The early first look the App tab shows for `run` in place of its own
 * (first-version-screens.js showcaseOf): { at, drawn }, once it is saved
 * (`drawn` false, `at` when), and before that from the moment it is drawn
 * (`drawn` true, `at` when it was drawn).
 *
 * 15 Oct 2026, newcomer run nine: the worker its picture is drawn in took
 * about 30 seconds longer than usual to start, so the picture was saved 48
 * seconds after Make it, and the made screen showed an empty phone for 11
 * seconds after Submit while the screen, drawn in under 20, waited for it.
 * The picture is 20 seconds at best. So the drawn screen itself is shown
 * until then (screenFor), in a frame that runs and loads nothing.
 */
async function shownFor(pool, appId, run = null) {
  if (!enabled()) return null;
  const { rows: [row] } = await pool.query(SHOWN_SQL, [Number(appId)]);
  if (!row || !forRun(run, row.plan_note)) return null;
  if (row.status === 'ready' && row.has_png) return { at: row.saved_at || null, drawn: false };
  if (row.status === 'drawn' && row.has_screen) return { at: row.drawn_at || null, drawn: true };
  return null;
}

const SCREEN_SQL = `SELECT l.status, l.screen, f.early_plan->>'buildNote' AS plan_note
  FROM first_version_early_looks l
  LEFT JOIN homeroom_bot_first_versions f ON f.app_id = l.app_id
 WHERE l.app_id = $1`;

/**
 * Its drawn screen, the <template> the picture is drawn from, while shownFor
 * offers it (drawn) and once it is pictured (ready, so a frame asked for as
 * the picture is saved still has it); else null. One that failed is not
 * shown: the spec draws its own (forSpec).
 */
async function screenFor(pool, appId, run = null) {
  if (!enabled()) return null;
  const { rows: [row] } = await pool.query(SCREEN_SQL, [Number(appId)]);
  if (!row || !row.screen || (row.status !== 'drawn' && row.status !== 'ready') || !forRun(run, row.plan_note)) return null;
  return String(row.screen);
}

/** Its picture, as readScreen answers: { content_type, data }, or null. */
async function pictureFor(pool, appId, run = null) {
  if (!enabled()) return null;
  const { rows: [row] } = await pool.query(PICTURE_SQL, [Number(appId)]);
  if (!row || row.status !== 'ready' || !row.png || !forRun(run, row.plan_note)) return null;
  return { content_type: 'image/png', data: row.png };
}

/**
 * The screen a first version's spec starts its main screen from
 * (homeroom-bot.js buildLive, homeroom-bot-live.js EARLY_LOOK_LINES): the
 * early first look's <template>, drawn from the plan the build goes ahead
 * with (`buildNote`, forRun). One still being drawn is waited for, at most
 * `waitMs`, and only while it can still come in. Null for none. Never throws.
 */
async function forSpec(pool, { appId, buildNote, waitMs = SPEC_WAIT_MS, pollMs = SPEC_POLL_MS, now = Date.now } = {}) {
  try {
    if (!enabled() || !appId) return null;
    const until = now() + waitMs;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { rows: [row] } = await pool.query(SPEC_SQL, [Number(appId)]);
      if (!row || !forRun({ build_note: buildNote }, row.plan_note)) return null;
      if ((row.status === 'drawn' || row.status === 'ready') && row.screen) return String(row.screen);
      const started = new Date(row.created_at).getTime();
      const stillComing = row.status === 'pending' && Number.isFinite(started) && now() - started < LOOK_DEADLINE_MS;
      if (!stillComing || now() + pollMs > until) return null;
      // eslint-disable-next-line no-await-in-loop
      await sleep(pollMs);
    }
  } catch (err) {
    log.warn('first-version-early-look', 'Could not read the early first look for the spec', { appId, err: err.message });
    return null;
  }
}

module.exports = {
  LOOK_MODEL,
  LOOK_EFFORT,
  LOOK_MAX_TOKENS,
  SCREEN_BUDGET,
  SCREEN_MAX_CHARS,
  MODEL_WAIT_MS,
  LOOK_DEADLINE_MS,
  SPEC_WAIT_MS,
  enabled,
  lookModel,
  lookSystem,
  lookUserPrompt,
  screenOf,
  namedScreen,
  drawScreen,
  prepareWorker,
  drawEarlyLook,
  runEarlyLook,
  forRun,
  shownFor,
  pictureFor,
  screenFor,
  forSpec,
};
