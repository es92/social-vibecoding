// Tests for the experimental AI progress estimate (#50 follow-up).
//
// Two layers:
//   1. Unit tests for llm.sanitizeEstimate — the pure clamp applied to
//      every Haiku estimate before it reaches the dev-chat summary line.
//      src/services/llm.js is plain CommonJS, so we require the real
//      function (init() need not be called).
//   2. Source guards — the feature spans schema, auth middleware, the
//      /me payload + toggle endpoint, the estimator wiring in sessions.js,
//      the cc_estimate handling in dev-chat.js, and the Settings markup.
//      Each guard pins the contract so a refactor can't silently drop a
//      link in the chain while the unit-tested helper stays green.
//
// Run with: node --test tests/ai-progress-estimate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const llm = require('../src/services/llm.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── 1. sanitizeEstimate unit tests ──────────────────────────────────────

test('sanitizeEstimate: trims and passes through a normal phrase', () => {
  assert.equal(
    llm.sanitizeEstimate('  maybe two-thirds done — a few minutes left  '),
    'maybe two-thirds done — a few minutes left'
  );
});

test('sanitizeEstimate: collapses newlines and internal whitespace runs', () => {
  assert.equal(
    llm.sanitizeEstimate('probably\nhalfway —\n\n  a while to go'),
    'probably halfway — a while to go'
  );
});

test('sanitizeEstimate: hard-caps at 90 chars with an ellipsis', () => {
  const long = 'x'.repeat(200);
  const out = llm.sanitizeEstimate(long);
  assert.ok(out.length <= 90, `expected <= 90 chars, got ${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('sanitizeEstimate: 90-char input is untouched', () => {
  const exact = 'y'.repeat(90);
  assert.equal(llm.sanitizeEstimate(exact), exact);
});

test('sanitizeEstimate: nullish and non-string inputs become empty string', () => {
  assert.equal(llm.sanitizeEstimate(null), '');
  assert.equal(llm.sanitizeEstimate(undefined), '');
  assert.equal(llm.sanitizeEstimate('   '), '');
});

test('llm exports estimateRunProgress alongside sanitizeEstimate', () => {
  assert.equal(typeof llm.estimateRunProgress, 'function');
  assert.equal(typeof llm.sanitizeEstimate, 'function');
});

// ── 1b. sanitizeRemainingSeconds unit tests (#50 follow-up) ──────────────

test('llm exports sanitizeRemainingSeconds', () => {
  assert.equal(typeof llm.sanitizeRemainingSeconds, 'function');
});

test('sanitizeRemainingSeconds: passes through an in-range integer', () => {
  assert.equal(llm.sanitizeRemainingSeconds(180), 180);
  assert.equal(llm.sanitizeRemainingSeconds(0), 0);
});

test('sanitizeRemainingSeconds: coerces a float to an integer', () => {
  assert.equal(llm.sanitizeRemainingSeconds(180.9), 180);
  assert.equal(llm.sanitizeRemainingSeconds('240'), 240);
});

test('sanitizeRemainingSeconds: negative / NaN / Infinity / null become null', () => {
  assert.equal(llm.sanitizeRemainingSeconds(-1), null);
  assert.equal(llm.sanitizeRemainingSeconds(NaN), null);
  assert.equal(llm.sanitizeRemainingSeconds(Infinity), null);
  assert.equal(llm.sanitizeRemainingSeconds(-Infinity), null);
  assert.equal(llm.sanitizeRemainingSeconds(null), null);
  assert.equal(llm.sanitizeRemainingSeconds(undefined), null);
  assert.equal(llm.sanitizeRemainingSeconds('not a number'), null);
});

test('sanitizeRemainingSeconds: clamps above the 7200s ceiling', () => {
  assert.equal(llm.sanitizeRemainingSeconds(10000), 7200);
  assert.equal(llm.sanitizeRemainingSeconds(7200), 7200);
  assert.equal(llm.sanitizeRemainingSeconds(7201), 7200);
});

test('estimateRunProgress requests a numeric remaining-time guess', () => {
  const src = read('src/services/llm.js');
  const fnStart = src.indexOf('async function estimateRunProgress');
  const fnBody = src.slice(fnStart, src.indexOf('module.exports'));
  // The system prompt now asks for remaining_seconds alongside the phrase,
  // and the parsed result carries an additive remainingSeconds field.
  assert.match(fnBody, /remaining_seconds/, 'system prompt must request a numeric remaining-time value');
  assert.match(fnBody, /remainingSeconds/, 'estimateRunProgress must return a remainingSeconds field');
  assert.match(fnBody, /sanitizeRemainingSeconds/, 'the numeric guess must pass through the sanitizer');
});

// ── 2. Source guards ────────────────────────────────────────────────────

test('schema adds the ai_progress_estimate column (default FALSE)', () => {
  const schema = read('src/db/schema.sql');
  assert.match(
    schema,
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_progress_estimate BOOLEAN NOT NULL DEFAULT FALSE/
  );
});

test('auth middleware selects the column and exposes aiProgressEstimate', () => {
  const mw = read('src/middleware/auth.js');
  assert.match(mw, /ai_progress_estimate/, 'session SELECT must include the column');
  assert.match(mw, /aiProgressEstimate/, 'req.user must carry the flag');
});

test('auth routes return the flag from /me and define the toggle endpoint', () => {
  const routes = read('src/routes/auth.js');
  assert.match(routes, /aiProgressEstimate/, '/api/auth/me must include the flag');
  assert.match(routes, /\/api\/me\/ai-progress-estimate/, 'toggle endpoint must exist');
  assert.match(routes, /SET ai_progress_estimate/, 'toggle endpoint must persist the column');
});

test('sessions route gates the estimator on the flag and emits cc_estimate', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /aiProgressEstimate/, 'estimator must be gated on the per-user flag');
  assert.match(sessions, /send\('cc_estimate'/, 'estimator must emit cc_estimate');
  assert.match(sessions, /estimateRunProgress/, 'estimator must call llm.estimateRunProgress');
  assert.match(
    sessions,
    /workerProgress\.setEstimate/,
    'latest estimate must be stashed for the /status polling fallback'
  );
});

test('estimateRunProgress uses Haiku', () => {
  const src = read('src/services/llm.js');
  const fnStart = src.indexOf('async function estimateRunProgress');
  assert.ok(fnStart !== -1, 'estimateRunProgress must exist in llm.js');
  const fnBody = src.slice(fnStart, src.indexOf('module.exports'));
  assert.match(fnBody, /claude-haiku-4-5/, 'estimator must use the Haiku model');
});

test('dev-chat handles cc_estimate in both event switches', () => {
  const devChat = read('public/js/dev-chat.js');
  const matches = devChat.match(/case 'cc_estimate':/g) || [];
  assert.ok(
    matches.length >= 2,
    `expected cc_estimate in both the POST-SSE and external handlers, found ${matches.length}`
  );
  assert.match(devChat, /_applyEstimate/, 'handlers must funnel through _applyEstimate');
  assert.match(devChat, /dc-cc-estimate/, 'running summary must render the estimate span');
});

test('schema adds the progress_estimates accuracy table (private)', () => {
  const schema = read('src/db/schema.sql');
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS progress_estimates/,
    'schema must create the progress_estimates table'
  );
  assert.match(
    schema,
    /progress_message_id\s+INTEGER REFERENCES chat_session_messages/,
    'progress_estimates must anchor on progress_message_id'
  );
  assert.match(
    schema,
    /COMMENT ON TABLE progress_estimates IS 'staging:private'/,
    'progress_estimates must be marked staging:private'
  );
});

test('sessions route persists each estimate and backfills the actual outcome', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(
    sessions,
    /INSERT INTO progress_estimates/,
    'estimator success path must INSERT into progress_estimates'
  );
  assert.match(
    sessions,
    /UPDATE progress_estimates/,
    'terminal choke point must backfill the actual outcome'
  );
  assert.match(
    sessions,
    /actual_remaining_ms = \$1 - elapsed_ms/,
    'backfill must store per-tick ground-truth remaining'
  );
  assert.match(
    sessions,
    /predicted_remaining_seconds/,
    'the predicted numeric remaining-seconds must be persisted'
  );
});

test('dev-chat renders a live count-down for the remaining-time guess (#359)', () => {
  const devChat = read('public/js/dev-chat.js');
  // The numeric guess is now an absolute target end-timestamp the shared 1s
  // ticker counts down from, rendered as a data-countdown-to child span.
  assert.match(devChat, /_countdownTo\s*=\s*DevChat\._countdownTarget/,
    'apply/hydrate/pending must anchor _countdownTo from remainingSeconds');
  assert.match(devChat, /data-countdown-to="\$\{countdownTo\}"/,
    'the estimate span must render a data-countdown-to child span');
  assert.match(devChat, /class="dc-cc-countdown"/,
    'the count-down lives in its own .dc-cc-countdown span');
  // Both ticker hooks must know about the count-down span so the single
  // shared DevChat._elapsedTimer drives it.
  assert.match(devChat, /\[data-countdown-to\]/,
    '_syncElapsedTicker / _tickElapsed must reference data-countdown-to');
  assert.match(devChat, /formatCountdown/,
    'the count-down text must come from formatCountdown');
  // #891 added a third `opts` argument (estimatedAt + cleared); the
  // remainingSeconds pass-through this guard exists for is unchanged.
  assert.match(
    devChat,
    /_applyEstimate\(data\.text, data\.remainingSeconds, \{/,
    'cc_estimate handlers must pass remainingSeconds through'
  );
});

test('dev-chat clears the count-down anchor when a step finishes (#359)', () => {
  const devChat = read('public/js/dev-chat.js');
  const fnStart = devChat.indexOf('_deactivateLastStatus() {');
  assert.ok(fnStart !== -1, '_deactivateLastStatus must exist');
  const fnBody = devChat.slice(fnStart, fnStart + 1400);
  assert.match(fnBody, /delete m\._estimate/, 'finished step must drop the guess');
  assert.match(fnBody, /delete m\._countdownTo/,
    'finished step must also drop the count-down anchor');
});

test('cc_estimate SSE payload carries remainingSeconds', () => {
  const sessions = read('src/routes/sessions.js');
  // #891 broke the payload across lines to add estimatedAt; #892 renamed the
  // phrase to `shownText` (the completion-claim gate may rewrite it) and
  // added the post-guard displayed value beside it. The invariant this guard
  // exists for is unchanged: the RAW model number ships on the payload.
  assert.match(
    sessions,
    /send\('cc_estimate', \{\s*\n?\s*text: shownText, remainingSeconds/,
    'SSE payload must include the raw remainingSeconds'
  );
  assert.match(
    sessions,
    /displayedRemainingSeconds: guard\.displayedRemainingSeconds/,
    'SSE payload must also carry the post-guard displayed value'
  );
});

test('settings modal has the experimental toggle wired to the endpoint', () => {
  const html = read('public/index.html');
  assert.match(html, /id="ai-progress-estimate"/, 'settings modal must have the checkbox');
  const settings = read('public/js/settings.js');
  assert.match(settings, /\/api\/me\/ai-progress-estimate/, 'settings.js must POST the toggle');
});

test('/status response carries the estimate for the polling fallback', () => {
  const sessions = read('src/routes/sessions.js');
  // Matched key-by-key rather than as one fixed run, so adding a sibling
  // key to the payload (e.g. `stopping`, #889) doesn't fail this — the
  // invariant is that `estimate` ships alongside the polling basics, not
  // the order they're written in. The window was 200 until #907 added
  // runner/runnerLabel/localAgent and pushed the object past it; widened
  // rather than trimmed, since the length was never the point.
  const payload = sessions.match(/res\.json\(\{\s*\n?\s*busy,[\s\S]{0,400}?\}\);/);
  assert.ok(payload, 'found the /status res.json payload');
  for (const key of ['busy', 'progress', 'phase', 'estimate']) {
    assert.match(payload[0], new RegExp(`\\b${key}\\b`), `/status payload must include ${key}`);
  }
});

// ── 3. Mobile visibility (#286) ─────────────────────────────────────────

// Slice out the body of the first `@media (max-width: 640px)` block by
// brace-matching, so we can assert what it does (and doesn't) hide.
function narrowMediaBlock(css) {
  const marker = '@media (max-width: 640px)';
  const at = css.indexOf(marker);
  assert.ok(at !== -1, 'a max-width:640px media query must exist');
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces in 640px media query');
}

test('mobile (#286): the 640px block no longer hides .dc-cc-estimate', () => {
  const block = narrowMediaBlock(read('public/css/app.css'));
  // The activity snippet stays hidden on narrow screens...
  assert.match(block, /\.dc-cc-current\s*\{\s*display:\s*none/,
    '.dc-cc-current must remain hidden on narrow viewports');
  // ...but the AI progress estimate must NOT be display:none anymore.
  assert.doesNotMatch(block, /\.dc-cc-estimate\s*\{\s*display:\s*none/,
    '.dc-cc-estimate must not be hidden in the 640px block');
  // And it should wrap onto its own full-width row instead.
  assert.match(block, /\.dc-cc-estimate\s*\{[^}]*flex-basis:\s*100%/,
    '.dc-cc-estimate must span its own full-width row on mobile');
});

test('mobile (#286): dev-chat hydrates _estimate from persisted metadata', () => {
  const devChat = read('public/js/dev-chat.js');
  assert.match(devChat, /m\.metadata\.estimate/,
    'load mapping must read metadata.estimate');
  assert.match(devChat, /m\._estimate\s*=/,
    'metadata.estimate must hydrate m._estimate');
  assert.match(devChat, /m\._estimateRemaining\s*=/,
    'metadata.estimate must hydrate m._estimateRemaining');
});

test('mobile (#286): staging seeds an active running line with an estimate', () => {
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /seedStagingCcEstimateRun/,
    'a CC-estimate staging fixture must be defined and called');
  const fnStart = migrate.indexOf('async function seedStagingCcEstimateRun');
  assert.ok(fnStart !== -1, 'seedStagingCcEstimateRun must exist');
  const fnBody = migrate.slice(fnStart, migrate.indexOf('async function', fnStart + 1));
  assert.match(fnBody, /USERNODE_ENV !== 'staging'/, 'fixture must be staging-gated');
  assert.match(fnBody, /\[staging fixture\]/, 'seeded rows must carry the staging prefix');
  assert.match(fnBody, /estimate:\s*\{\s*text:/, 'fixture must persist estimate metadata');
  assert.match(fnBody, /Claude Code is running/, 'fixture must seed an active running line');
});

test('#906: staging seeds estimator-OFF runs at both side-slot states', () => {
  // The fixture above always carries metadata.estimate, so it only ever
  // exercises the estimator-ON path. The estimator-OFF path — an empty slot
  // below ten minutes, the long-run note above it — is what nearly every
  // user sees, and neither state is reachable on demand without seeding.
  const migrate = read('src/db/migrate.js');
  assert.match(migrate, /await seedStagingCcCohortRuns\(pool, config\);/,
    'the cohort fixture must actually be invoked from runMigrations');
  const fnStart = migrate.indexOf('async function seedStagingCcCohortRuns');
  assert.ok(fnStart !== -1, 'seedStagingCcCohortRuns must exist');
  const fnBody = migrate.slice(fnStart, migrate.indexOf('async function', fnStart + 1));
  assert.match(fnBody, /USERNODE_ENV !== 'staging'/, 'fixture must be staging-gated');
  assert.match(fnBody, /\[staging fixture\]/, 'seeded rows must carry the staging prefix');
  assert.match(fnBody, /Claude Code is running/, 'fixture must seed active running lines');
  assert.match(fnBody, /SELECT id FROM chat_sessions WHERE app_id = \$1 AND branch_name = \$2/,
    'fixture must be idempotent on its branch names');
  assert.ok(!/estimate:\s*\{/.test(fnBody),
    'the cohort fixture must NOT seed estimate metadata — that is the point');
  // The two elapsed ages that straddle the ten-minute threshold.
  assert.match(fnBody, /minutesAgo: 5\b/, 'one run must sit below ten minutes');
  assert.match(fnBody, /minutesAgo: 12\b/, 'one run must sit above ten minutes');
  // The dev-chat route embeds the session id, so the ids must be FIXED or the
  // dapp.json tests below would break on every staging rebuild.
  assert.match(fnBody, /id: 900810\b/);
  assert.match(fnBody, /id: 900811\b/);
  // An assistant reply is load-bearing: without one, the boot-time
  // unanswered-turn sweep appends a breadcrumb system row that is NEWER than
  // the running line and therefore steals the client's `_active` flag — the
  // fixture then renders as a finished run with no side slot at all.
  assert.match(fnBody, /role: 'assistant'/,
    'each fixture run needs an assistant reply or the unanswered sweep breaks it');

  // The fixture rows are only useful if the routes are checks-gated.
  const tests = require('../dapp.json').tests || [];
  for (const id of [900810, 900811]) {
    const t = tests.find((x) => x.path.includes(`/sessions/${id}`));
    assert.ok(t, `dapp.json must declare a test for the ${id} fixture route`);
    assert.equal(t.expectSelector, '.dc-cc-attached-summary .dc-cc-cohort',
      `${id}: the test must assert the side slot actually renders`);
  }
  assert.match(
    tests.find((x) => x.path.includes('/sessions/900811')).expectText,
    /running longer than most/,
    'the past-ten-minutes route must assert the long-run note is still there'
  );
});

test('#906: /status reports the cohort fixtures as busy in staging only', () => {
  // `_active` — and therefore the side slot itself — is applied by the client
  // only when /status says busy, and busy comes from in-memory worker
  // registries a DB seed cannot reach. This is data/state gating (same code
  // path, same payload shape, seeded rows only) and a strict no-op in
  // production.
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return null;/,
    'the fixture-busy lookup must be staging-gated');
  assert.match(sessions, /branch_name LIKE 'staging-fixture\/cc-cohort-%'/,
    'it must match only the seeded cohort fixture branches');
  assert.match(sessions, /if \(fixtures && fixtures\.has\(sessionId\)\) busy = true;/,
    'a seeded fixture session must report busy so the row renders live');
  // It must never be able to mask a genuinely idle non-fixture session.
  assert.match(sessions, /let busy = isSessionBusy\(sessionId\);/,
    'the shared worker/operation registry must still be the primary source');
});

// ── 4. Reliability for long runs (#323) ─────────────────────────────────
//
// The estimator must keep producing guesses for the whole life of a long
// run: a few transient failures must not disable it for good, the flat
// 20-emit cap must be gone, the first guess must be able to fire before any
// progress line lands, and the countdown must refresh on a wall-clock
// cadence so it never freezes during a quiet phase. These pin the inline
// estimator contract in sessions.js (it's a closure inside the route
// handler, so source guards are the practical seam).

// Slice out the estimator block: from the toggle gate down to the 60s tick.
function estimatorBlock() {
  const src = read('src/routes/sessions.js');
  const at = src.indexOf('const estimatorEnabled = !headless');
  assert.ok(at !== -1, 'estimatorEnabled gate must exist');
  const end = src.indexOf('}, 60_000);', at);
  assert.ok(end !== -1, 'estimator 60s tick must exist');
  return src.slice(at, end + 20);
}

test('#323: estimator no longer permanently dies after a flat failure/emit count', () => {
  const block = estimatorBlock();
  // The old hard kill — `estimateFailures >= 3 || estimateSuccesses >= 20`
  // followed by clearInterval — must be gone.
  assert.doesNotMatch(block, /estimateFailures\s*>=\s*3/,
    'the permanent 3-failure clearInterval must be removed');
  assert.doesNotMatch(block, /estimateSuccesses\s*>=\s*20/,
    'the flat 20-emit hard stop must be removed');
});

test('#323: estimator backs off on failure and resets the counter on success', () => {
  const block = estimatorBlock();
  // Backoff: failures increment a counter that skips a bounded number of
  // ticks rather than tearing down the interval.
  assert.match(block, /consecutiveFailures\+\+/, 'failures must increment a backoff counter');
  assert.match(block, /ticksToSkip\s*=\s*Math\.min\(consecutiveFailures,\s*5\)/,
    'failure backoff must skip up to 5 ticks');
  assert.match(block, /if\s*\(ticksToSkip\s*>\s*0\)\s*\{\s*ticksToSkip--;\s*return;\s*\}/,
    'the tick must wait out the backoff window');
  // Recovery: a success zeroes the failure counter so the run self-heals.
  assert.match(block, /consecutiveFailures\s*=\s*0/, 'a success must reset the failure counter');
});

test('#323: emits are bounded only by a generous runaway ceiling', () => {
  const block = estimatorBlock();
  assert.match(block, /MAX_ESTIMATES\s*=\s*60/, 'the runaway backstop must be a generous ceiling');
  assert.match(block, /estimateSuccesses\s*>=\s*MAX_ESTIMATES/,
    'the ceiling must gate only as a runaway backstop');
});

test('#323: first estimate can fire before any progress line lands', () => {
  const block = estimatorBlock();
  // lastEstimateAtMs == null (no successful emit yet) forces a run even with
  // zero lines — the old `lines === linesAtLastEstimate` early-return is gone.
  assert.match(block, /lastEstimateAtMs\s*==\s*null\)\s*shouldRun\s*=\s*true/,
    'the first tick must run even with no new progress lines');
  assert.doesNotMatch(block, /if\s*\(liveProgressLines\.length === linesAtLastEstimate\)\s*return;/,
    'the unconditional idle early-return must be removed');
});

test('#323: the countdown refreshes on a wall-clock cadence when idle', () => {
  const block = estimatorBlock();
  assert.match(block, /IDLE_REFRESH_MS/, 'an idle-refresh wall-clock threshold must exist');
  assert.match(block, /sinceLastMs\s*>=\s*IDLE_REFRESH_MS/,
    'an idle tick must re-ask once enough wall-clock has passed');
  // ...but a brand-new estimate is still skipped when nothing changed and it
  // was just asked (cost containment): the idle branch is the *else* of
  // hasNewLines, not an unconditional re-ask.
  assert.match(block, /else if\s*\(hasNewLines\)\s*shouldRun\s*=\s*true/,
    'new progress lines must still trigger an immediate estimate');
});

test('#323: cadence widens with elapsed time instead of stopping', () => {
  const block = estimatorBlock();
  assert.match(block, /WIDEN_AFTER_MS\s*=\s*15\s*\*\s*60_000/, 'cadence must widen after ~15 min');
  assert.match(block, /WIDE_SPACING_MS/, 'late-run minimum spacing must be defined');
  assert.match(block, /sinceLastMs\s*<\s*minSpacingMs\)\s*shouldRun\s*=\s*false/,
    'the widened spacing must throttle (not stop) late-run estimates');
});

test('#323: estimator logs start, backoff, and the silent-disable case', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /AI progress estimator started/, 'estimator creation must be logged');
  assert.match(sessions, /backing off/, 'failure backoff must be logged');
  assert.match(sessions, /AI progress estimate skipped: no LLM key available/,
    'the toggle-on-but-no-key case must be logged for diagnosis');
});

test('#323: estimateRunProgress requests schema-constrained structured output', () => {
  const src = read('src/services/llm.js');
  const fnStart = src.indexOf('async function estimateRunProgress');
  const fnBody = src.slice(fnStart, src.indexOf('module.exports'));
  // The messages.create call must force Haiku to emit valid schema-matching
  // JSON via output_config.format, eliminating the parse-failure class at the
  // source. The bound schema (ESTIMATE_SCHEMA) must cover both keys the parser
  // reads — estimate + remaining_seconds.
  assert.match(fnBody, /output_config/, 'estimate call must pass output_config');
  assert.match(fnBody, /json_schema/, 'output_config.format must be a json_schema');
  assert.match(fnBody, /ESTIMATE_SCHEMA/, 'the bound schema must be passed to the call');

  // ESTIMATE_SCHEMA is a top-level object with additionalProperties:false whose
  // required keys are estimate (string) and remaining_seconds (nullable int).
  const schemaStart = src.indexOf('const ESTIMATE_SCHEMA');
  assert.ok(schemaStart !== -1, 'ESTIMATE_SCHEMA must be defined');
  const schemaBlock = src.slice(schemaStart, src.indexOf('estimateRunProgress', schemaStart));
  assert.match(schemaBlock, /additionalProperties:\s*false/, 'schema must forbid extra keys');
  assert.match(schemaBlock, /estimate:\s*\{\s*type:\s*'string'\s*\}/, 'schema must declare estimate as a string');
  assert.match(schemaBlock, /remaining_seconds:\s*\{\s*type:\s*\['integer',\s*'null'\]\s*\}/,
    'schema must declare remaining_seconds as a nullable integer');
  assert.match(schemaBlock, /required:\s*\['estimate',\s*'remaining_seconds'\]/,
    'both keys must be required');
});

test('#323: estimateRunProgress tolerates code fences and smart quotes', () => {
  const src = read('src/services/llm.js');
  const fnStart = src.indexOf('async function estimateRunProgress');
  const fnBody = src.slice(fnStart, src.indexOf('module.exports'));
  // Defensive fallback (now that structured outputs is the primary path):
  // strips ```json fences and normalises curly quotes before JSON.parse so an
  // off-schema response (refusal / truncation / older model) decorated with a
  // fence or smart quotes still parses rather than counting as a failure.
  assert.match(fnBody, /replace\(\/```/, 'must strip code fences before parsing');
  assert.match(fnBody, /[“”]/, 'must normalise smart double quotes');
  assert.match(fnBody, /[‘’]/, 'must normalise smart single quotes');
});

test('#323: _applyEstimate stashes a pending estimate instead of dropping it', () => {
  const devChat = read('public/js/dev-chat.js');
  // No active line yet → stash, don't silently return.
  assert.match(devChat, /_pendingEstimate\s*=\s*\{\s*text:\s*clean/,
    '_applyEstimate must stash the estimate when no active line exists');
  // renderMessages drains the pending estimate onto the active line.
  assert.match(devChat, /DevChat\._pendingEstimate\)/, 'renderMessages must drain a pending estimate');
  // Patch is scoped to THIS run's DOM node by persist-id, not the last span.
  assert.match(devChat, /data-persist-id="\$\{pid\}"\]\s*\.dc-cc-estimate/,
    'in-place patch must target the active run by persist-id');
});

// ── 5. Terminal-state teardown (#891) ───────────────────────────────────
//
// The reported bug: after the coding agent finished, the estimator kept
// running and the card kept reading "nearly done, just wrapping up". Four
// compounding defects, each pinned below:
//   1. the in-memory estimate was served by /status for the whole wrap-up,
//   2. _applyEstimate re-targeted the finished card via a DOM fallback and
//      re-anchored its count-down on every 3s poll,
//   3. an in-flight Haiku call resolving after teardown still emitted,
//   4. _pendingEstimate survived the turn and could drain onto the next one.

test('#891: worker-progress exports clearEstimate and stamps estimatedAt', () => {
  const wp = require('../src/services/worker-progress.js');
  assert.equal(typeof wp.clearEstimate, 'function', 'clearEstimate must be exported');

  // clearEstimate must NOT create an entry — setEstimate(id, null) would,
  // via its `!prev` branch, and /status would then report a phantom worker.
  wp.clearEstimate(987654321);
  assert.equal(wp.get(987654321), null, 'clearEstimate must not create an entry');

  // A real estimate carries an absolute estimatedAt so the client can anchor
  // the count-down on when the guess was MADE, not when it arrived.
  const before = Date.now();
  wp.setEstimate(987654321, { text: 'nearly done', remainingSeconds: 90 });
  const stored = wp.get(987654321);
  assert.ok(stored && stored.estimate, 'setEstimate must store an estimate');
  assert.equal(stored.estimate.text, 'nearly done');
  assert.equal(stored.estimate.remainingSeconds, 90);
  assert.ok(Number.isFinite(stored.estimate.estimatedAt), 'estimate must carry estimatedAt');
  assert.ok(stored.estimate.estimatedAt >= before, 'estimatedAt must be a real timestamp');

  // Clearing drops the guess but keeps the progress entry itself alive —
  // the run is still going (commit/push/PR), just no longer estimated.
  wp.clearEstimate(987654321);
  assert.equal(wp.get(987654321).estimate, null, 'clearEstimate must null the estimate');
  wp.clear(987654321);
});

test('#891: sessions defines one idempotent stopEstimator', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /const stopEstimator = \(reason\) => \{/,
    'a single stopEstimator closure must exist');
  const fnStart = sessions.indexOf('const stopEstimator = (reason) => {');
  const fnBody = sessions.slice(fnStart, fnStart + 900);
  assert.match(fnBody, /if \(estimatorDone\) return;/, 'stopEstimator must be idempotent');
  assert.match(fnBody, /estimatorDone = true/, 'it must latch the torn-down flag');
  assert.match(fnBody, /clearInterval\(estimator\)/, 'it must clear the interval');
  assert.match(fnBody, /workerProgress\.clearEstimate\(session\.id\)/,
    'it must drop the in-memory estimate so /status stops serving it');
  assert.match(fnBody, /send\('cc_estimate', \{ text: null, remainingSeconds: null, cleared: true \}\)/,
    'it must emit a cleared cc_estimate so live clients blank the span');
});

test('#891: stopEstimator is wired to terminal markers, turn end and stop', () => {
  const sessions = read('src/routes/sessions.js');
  // (a) the earliest signal — reusing the watchdog's marker list rather than
  // re-declaring '[done]' / '[push_failed]' / '[interrupted]' here.
  assert.match(sessions, /turnWatchdog\.TERMINAL_PROGRESS_LINES\.includes\(String\(text\)\.trim\(\)\)/,
    'the onProgress hook must detect terminal phase markers');
  assert.match(sessions, /stopEstimator\('terminal_marker'\)/,
    'a terminal marker must tear the estimator down');
  // (b) belt-and-braces for a markerless turn, and (c) the user-stop path.
  assert.match(sessions, /stopEstimator\('turn_end'\)/,
    'the dispatch finally must tear the estimator down');
  assert.match(sessions, /stopEstimator\('stopped'\)/,
    'the user-stop path must tear the estimator down');
  // The bare clearInterval it replaced must be gone from the finally.
  assert.doesNotMatch(sessions, /if \(estimator\) clearInterval\(estimator\);/,
    'the finally must go through stopEstimator, not a bare clearInterval');
});

test('#891: a tick resolving after teardown emits nothing and records nothing', () => {
  const sessions = read('src/routes/sessions.js');
  // The single guard fronting emit + stash + INSERT.
  assert.match(sessions, /if \(!estimatorDone && !\(stopHandle && stopHandle\.stopped\)\) \{/,
    'the .then must drop everything when the estimator is torn down');
  const guardAt = sessions.indexOf('if (!estimatorDone && !(stopHandle && stopHandle.stopped)) {');
  assert.ok(guardAt !== -1);
  // #892 grew this block (the monotonicity guard and the completion-claim
  // gate now live inside it), so the window has to grow with it.
  const guarded = sessions.slice(guardAt, guardAt + 4000);
  assert.match(guarded, /send\('cc_estimate'/, 'the emit must sit inside the guard');
  assert.match(guarded, /workerProgress\.setEstimate/, 'the in-memory stash must sit inside the guard');
  assert.match(guarded, /INSERT INTO progress_estimates/,
    'the accuracy INSERT must sit inside the guard — the backfill has already run');
  // The spend debit stays OUTSIDE: those tokens were genuinely spent.
  const afterGuard = sessions.slice(guardAt);
  const spendAt = afterGuard.indexOf('limits.recordSpend');
  const insertAt = afterGuard.indexOf('INSERT INTO progress_estimates');
  assert.ok(spendAt > insertAt, 'recordSpend must remain outside the drop guard');
  // The interval body bails too, so a queued tick can't fire post-teardown.
  assert.match(sessions, /if \(estimatorDone\) return;/,
    'the interval body must bail once torn down');
});

test('#891: the estimator emit and /status carry estimatedAt', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /estimatedAt: lastEstimateAtMs/,
    'the SSE payload must carry when the guess was made');
  assert.match(sessions, /workerProgress\.setEstimate\(session\.id, \{\s*\n?\s*text: shownText, remainingSeconds, estimatedAt: lastEstimateAtMs/,
    'the in-memory stash must carry estimatedAt for the /status poll');
});

test('#891: _applyEstimate clears instead of swallowing an empty estimate', () => {
  const devChat = read('public/js/dev-chat.js');
  assert.match(devChat, /_clearEstimate\(\)\s*\{/, 'a _clearEstimate helper must exist');
  const fnStart = devChat.indexOf('_applyEstimate(text, remainingSeconds, opts) {');
  assert.ok(fnStart !== -1, '_applyEstimate must take an opts argument');
  const fnBody = devChat.slice(fnStart, devChat.indexOf('\n  },', fnStart));
  assert.match(fnBody, /if \(!clean \|\| o\.cleared\) \{ DevChat\._clearEstimate\(\); return; \}/,
    'an empty/cleared estimate must clear rather than silently return');
  // The DOM fallback that painted the guess onto the finished card is gone.
  assert.doesNotMatch(fnBody, /querySelectorAll\('#dc-messages \.dc-cc-estimate'\)/,
    'the "last span on the page" fallback must be removed');
  // Guesses may only attach to a LIVE coding run.
  assert.match(fnBody, /DevChat\._isLiveCcRun\(DevChat\.messages\[i\]\)/,
    'the target must be a live CC run row, not any active status row');
  // A wrap-up status row active → drop, don't stash.
  assert.match(fnBody, /if \(anyActive\) \{ DevChat\._clearEstimate\(\); return; \}/,
    'an active non-CC row means the run is over — clear, do not stash');
});

test('#891: the count-down anchors on estimatedAt and ignores re-deliveries', () => {
  const devChat = read('public/js/dev-chat.js');
  // Absolute anchor rather than "now + remaining".
  assert.match(devChat, /_countdownTarget\(remainingSeconds, estimatedAt\)/,
    '_countdownTarget must accept the server timestamp');
  const fnStart = devChat.indexOf('_countdownTarget(remainingSeconds, estimatedAt) {');
  const fnBody = devChat.slice(fnStart, devChat.indexOf('\n  },', fnStart));
  assert.match(fnBody, /base \+ n \* 1000/, 'the target must be anchored on estimatedAt');
  assert.doesNotMatch(fnBody, /return Date\.now\(\) \+ n \* 1000/,
    'the target must not re-anchor to arrival time');
  // Same guess delivered twice (SSE + the 3s poll) must not re-anchor.
  assert.match(devChat, /estimatedAt <= DevChat\._lastEstimateAt/,
    'a non-newer estimate must be ignored so the count-down keeps moving');
});

test('#891: the /status poll forwards a null estimate so it can clear', () => {
  const devChat = read('public/js/dev-chat.js');
  assert.match(devChat, /estimate \? estimate\.text : null/,
    'the poll must forward a null estimate rather than skipping it');
  assert.match(devChat, /estimatedAt: estimate \? estimate\.estimatedAt : null/,
    'the poll must forward estimatedAt');
  // All three live event paths pass the new fields through.
  const app = read('public/js/app.js');
  for (const [name, src] of [['dev-chat.js', devChat], ['app.js', app]]) {
    assert.match(src, /estimatedAt: data\.estimatedAt, cleared: data\.cleared/,
      `${name} cc_estimate handler must forward estimatedAt + cleared`);
  }
  const handlers = devChat.match(/estimatedAt: data\.estimatedAt, cleared: data\.cleared/g) || [];
  assert.ok(handlers.length >= 2,
    `both dev-chat cc_estimate handlers must forward the fields, found ${handlers.length}`);
});

test('#891: a stale guess cannot survive the turn or reach the next one', () => {
  const devChat = read('public/js/dev-chat.js');
  // _deactivateLastStatus drops the remaining-seconds + the pending stash.
  const deactStart = devChat.indexOf('_deactivateLastStatus() {');
  const deactBody = devChat.slice(deactStart, deactStart + 1800);
  assert.match(deactBody, /delete m\._estimate;/, 'finished step must drop the guess');
  assert.match(deactBody, /delete m\._estimateRemaining;/, 'it must drop the remaining-seconds too');
  assert.match(deactBody, /delete m\._countdownTo;/, 'it must drop the count-down anchor');
  assert.match(deactBody, /DevChat\._pendingEstimate = null;/,
    'it must drop an undrained pending estimate');
  // _finishStreaming does the same at turn end.
  const finStart = devChat.indexOf('_finishStreaming() {');
  const finBody = devChat.slice(finStart, finStart + 900);
  assert.match(finBody, /DevChat\._pendingEstimate = null;/,
    'turn end must drop an undrained pending estimate');
  assert.match(finBody, /DevChat\._lastEstimateAt = null;/,
    'turn end must reset the applied-estimate stamp');
  // The pending drain targets a live CC run, not any active row.
  assert.match(devChat, /if \(DevChat\._isLiveCcRun\(m\)\) \{\n\s*m\._estimate = DevChat\._pendingEstimate\.text;/,
    'renderMessages must drain a pending estimate onto a live CC run only');
});

// ── 3. #892: empirical priors, the prompt, and the monotonicity guard ────
//
// The v1 estimator's numeric guess failed every graduation bar, but the
// failure was a SCALE error inherited from its own prompt ("bias toward the
// 2-10 minute window"), not an absence of signal — within an elapsed bucket
// its ranking correlated 0.40-0.56 with the truth while step counts managed
// 0.01. v2 replaces that instruction with the measured distribution, fed in
// as prompt INPUT. These tests pin the three things most likely to be
// quietly broken later: that the priors stay refreshable, that no
// output-side multiplier creeps in, and that the guard always yields a
// positive number of seconds.

const estimateGuard = require('../src/services/estimate-guard.js');

test('#892: RUN_LENGTH_PRIORS covers every elapsed bucket with sane quantiles', () => {
  const priors = llm.RUN_LENGTH_PRIORS;
  assert.ok(priors && Array.isArray(priors.buckets), 'the priors table must be exported');
  assert.equal(priors.buckets.length, 5, 'all five measured elapsed buckets must be present');
  assert.deepEqual(
    priors.buckets.map((b) => b.key),
    ['<2m', '2-5m', '5-10m', '10-20m', '20m+'],
    'bucket keys must match the labels the dashboard SQL emits'
  );
  for (const b of priors.buckets) {
    assert.ok(b.p25 <= b.p50, `${b.key}: p25 must not exceed p50`);
    assert.ok(b.p50 <= b.p75, `${b.key}: p50 must not exceed p75`);
    assert.ok(b.p75 <= b.p90, `${b.key}: p75 must not exceed p90`);
    assert.ok(b.n > 0, `${b.key}: must record how many guesses it was measured over`);
  }
  // Bucket bounds must tile the line with no gap and no overlap.
  let prevMax = 0;
  for (const b of priors.buckets) {
    assert.equal(b.minS, prevMax, `${b.key}: bucket bounds must be contiguous`);
    prevMax = b.maxS == null ? Infinity : b.maxS;
  }
  assert.equal(prevMax, Infinity, 'the last bucket must be open-ended');

  const pop = priors.population;
  assert.ok(pop.p50TotalS < pop.p90TotalS && pop.p90TotalS < pop.p99TotalS,
    'population quantiles must be ordered');
  assert.ok(pop.maxTotalS >= pop.p99TotalS, 'the observed max must not be below p99');
});

test('#892: RUN_LENGTH_PRIORS_SNAPSHOT records where the numbers came from', () => {
  const snap = llm.RUN_LENGTH_PRIORS_SNAPSHOT;
  for (const k of ['generatedOn', 'windowStart', 'scoredTicks', 'runs', 'users']) {
    assert.ok(snap[k] != null, `the snapshot must record ${k}`);
  }
  assert.match(snap.generatedOn, /^\d{4}-\d{2}-\d{2}$/, 'generatedOn must be an absolute date');
  assert.match(snap.windowStart, /^\d{4}-\d{2}-\d{2}$/, 'windowStart must be an absolute date');
});

test('#892: the refresh SQL is committed beside the priors', () => {
  // The priors are a committed constant precisely SO a refresh is a
  // reviewable act — but that only works if the query is right there. A
  // silent deletion would make them unrefreshable in practice, which is how
  // a "temporary" snapshot becomes permanent.
  const src = read('src/services/llm.js');
  assert.match(src, /REFRESH SQL \(verbatim/, 'the refresh procedure must be committed');
  assert.match(src, /percentile_cont\(0\.25\)/, 'the per-bucket quantile query must be present');
  assert.match(src, /percentile_cont\(0\.90\)/, 'the p90 the prompt quotes must be derivable');
  assert.match(src, /the SCORED predicate/, 'the refresh query must use the same scored predicate');
  assert.match(src, /Population facts \(one row per RUN/,
    'the population-quantile query must be present too');
});

test('#892: the prompt is RENDERED from the priors, not hand-copied', () => {
  // If the numbers were duplicated as literals in the prompt string, a
  // refresh would update the table and leave the model reading stale values.
  const base = llm.renderPriorsGuidance(llm.RUN_LENGTH_PRIORS);
  assert.match(base, /usually about 124s remain/, 'the committed p50 must reach the guidance');
  const mutated = llm.renderPriorsGuidance({
    buckets: [{ key: '<2m', minS: 0, maxS: 120, n: 10, p25: 1, p50: 999, p75: 1000, p90: 1001 }],
    population: llm.RUN_LENGTH_PRIORS.population,
  });
  assert.match(mutated, /usually about 999s remain/, 'the guidance must follow the constant');
  assert.doesNotMatch(mutated, /usually about 124s remain/, 'no literal may survive the mutation');
});

test('#892: the system prompt drops the flattening instruction and states the corrections', () => {
  const src = read('src/services/llm.js');
  const promptAt = src.indexOf('const system = `You are watching the live progress log');
  assert.ok(promptAt > 0, 'the estimator system prompt must exist');
  const prompt = src.slice(promptAt, src.indexOf('`;', promptAt));
  // The two strings that flattened v1's output into six values.
  assert.doesNotMatch(prompt, /2-10 minute/, 'the "typical 2-10 minutes" framing must be gone');
  assert.doesNotMatch(prompt, /120-600/, 'the "bias toward 120-600 seconds" instruction must be gone');
  // The measured guidance that replaces it.
  assert.match(prompt, /renderPriorsGuidance\(RUN_LENGTH_PRIORS\)/,
    'the per-bucket case guidance must be interpolated from the constant');
  assert.match(prompt, /overshoot by about 2x/, 'the early-overshoot correction must be stated');
  assert.match(prompt, /undershoot by about 2\.6x/, 'the late-undershoot correction must be stated');
  assert.match(prompt, /another SIX minutes to go, not two/,
    'the concrete ten-minutes-in case must be spelled out');
  assert.match(prompt, /DO NOT ANCHOR/, 'the anti-anchoring instruction must be present');
  assert.match(prompt, /ALWAYS GIVE A NUMBER/,
    'the always-answer instruction must be present — the UI always shows a time');
  assert.match(prompt, /\[commit\] or \[push\] marker/,
    'the decisive late phase signal must be surfaced');
});

test('#892: the user message carries the new inputs, and the previous guess only when it exists', () => {
  const src = read('src/services/llm.js');
  assert.match(src, /LAST PHASE MARKER: /, 'the phase marker must reach the model');
  assert.match(src, /DISTINCT FILES TOUCHED: /, 'the file count must reach the model');
  assert.match(src, /YOUR PREVIOUS GUESS FOR THIS RUN: /, 'the previous guess must reach the model');
  // The previous-guess line is built conditionally and interpolated as a
  // single `prevLine`, so the first tick omits it entirely.
  assert.match(src, /const prevLine = \(prevRs != null && Number\.isFinite\(prevRs\)\)/,
    'the previous-guess line must be conditional');
  assert.match(src, /: '';/, 'with no previous guess the line must collapse to nothing');
});

test('#892: estimateRunProgress reports its prompt generation', () => {
  assert.equal(llm.PROMPT_VERSION, 2, 'the recalibrated prompt is generation 2');
  const src = read('src/services/llm.js');
  assert.match(src, /promptVersion: PROMPT_VERSION,/,
    'every call must report which prompt produced it, so v1 and v2 can be scored apart');
});

test('#892: NO output-side calibration between the model and what is recorded', () => {
  // This is the invariant the whole design rests on. A multiplier fitted to
  // one model silently distorts the estimate as soon as the model or its
  // inputs improve — and the distortion would be invisible on the dashboard,
  // which would blame the model. Calibration lives in the prompt, full stop.
  const src = read('src/services/llm.js');
  const fnAt = src.indexOf('async function estimateRunProgress(');
  const fn = src.slice(fnAt, src.indexOf('\n// Parse + sanitize the model', fnAt));
  assert.ok(fn.length > 500, 'the function body must be located');
  assert.match(fn, /const remainingSeconds = sanitizeRemainingSeconds\(parsed\.remaining_seconds\);/,
    'the returned value must be the sanitized raw model output, nothing else');
  // Nothing may sit between the sanitize and the return.
  const declAt = fn.indexOf('const remainingSeconds = sanitizeRemainingSeconds');
  const after = fn.slice(fn.indexOf(';', declAt));
  assert.doesNotMatch(after, /remainingSeconds\s*[*/]/, 'no scaling of the model value');
  assert.doesNotMatch(after, /remainingSeconds\s*=/, 'no reassignment of the model value');
  assert.doesNotMatch(fn, /RUN_LENGTH_PRIORS\.buckets\.find/,
    'the priors must not be used as an output-side lookup');

  // sanitizeRemainingSeconds itself must stay a pure clamp across the whole
  // range the priors describe — no bucket-dependent behaviour.
  for (const v of [0, 30, 45, 124, 207, 400, 600, 1200, 2290, 7200, 99999]) {
    assert.equal(llm.sanitizeRemainingSeconds(v), Math.min(7200, v),
      `sanitizeRemainingSeconds must clamp only, at ${v}`);
  }
});

test('#892: the estimator passes the new inputs and the previous guess through', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /lastPhase: phaseAtStart,/, 'the tracked phase must be passed to the model');
  assert.match(sessions, /distinctFiles,/, 'the distinct-file count must be passed to the model');
  assert.match(sessions, /previousGuess: previousRemainingSeconds == null \? null : \{/,
    'the previous guess must be passed, and omitted on the first tick');
  // The phase tracker must read every progress line, not just the estimator's.
  assert.match(sessions, /const phaseMatch = String\(text\)\.trim\(\)\.match\(\/\^\\\[\(\[\^\\\]\]\+\)\\\]\$\/\);/,
    'onProgress must extract the phase marker');
});

test('#892: an expired projection overrides the widened late-run cadence', () => {
  // The 30s floor is only honest for as long as it takes to get a fresh
  // guess. Without this override the widened 150s spacing would hold the
  // floored readout for two and a half minutes.
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /const projectionExpired = projectedFinishAt != null && now >= projectedFinishAt;/,
    'the expiry condition must be computed');
  assert.match(sessions, /else if \(projectionExpired\) shouldRun = true;/,
    'an expired projection must run the tick');
  const decisionAt = sessions.indexOf('let shouldRun;');
  const decision = sessions.slice(decisionAt, decisionAt + 400);
  assert.ok(
    decision.indexOf('projectionExpired') < decision.indexOf('sinceLastMs < minSpacingMs'),
    'the expiry override must be checked BEFORE the widened-spacing skip'
  );
  // The other guards still front it — this is a cadence override, not a
  // licence to spam the model.
  assert.match(sessions, /if \(estimateInFlight\) return;/, 'one call in flight at a time still holds');
  assert.match(sessions, /if \(ticksToSkip > 0\) \{ ticksToSkip--; return; \}/,
    'the failure backoff still holds');
});

// ── 3b. The monotonicity guard ──────────────────────────────────────────

const GUARD_BASE = { now: 1_000_000, estimatedAt: 1_000_000 };

test('#892 guard: an earlier candidate is always accepted', () => {
  const r = estimateGuard.applyMonotonicityGuard({
    ...GUARD_BASE,
    projectedFinishAt: 1_000_000 + 600_000,   // 10 min out
    previousRemainingSeconds: 600,
    remainingSeconds: 120,                    // now says 2 min
  });
  assert.equal(r.displayedRemainingSeconds, 120);
  assert.equal(r.clamped, false);
  assert.equal(r.slipReason, null);
});

test('#892 guard: a later candidate with no cause holds the previous projection', () => {
  const r = estimateGuard.applyMonotonicityGuard({
    ...GUARD_BASE,
    projectedFinishAt: 1_000_000 + 240_000,   // 4 min out, not yet expired
    previousRemainingSeconds: 240,
    remainingSeconds: 300,                    // the treadmill: +1 min again
  });
  assert.equal(r.clamped, true, 'an uncaused extension must be held');
  assert.equal(r.displayedRemainingSeconds, 240, 'the held projection is what is shown');
  assert.equal(r.slipReason, null);
});

test('#892 guard: a trivial wobble is accepted rather than counted as an extension', () => {
  const r = estimateGuard.applyMonotonicityGuard({
    ...GUARD_BASE,
    projectedFinishAt: 1_000_000 + 240_000,
    previousRemainingSeconds: 240,
    remainingSeconds: 260,                    // +20s, inside the 30s grace
  });
  assert.equal(r.clamped, false);
  assert.equal(r.slipReason, null);
  assert.equal(r.displayedRemainingSeconds, 260);
});

test('#892 guard: each of the three causes accepts the candidate and names itself', () => {
  // (a) the projection already ran out and the run continues
  const expired = estimateGuard.applyMonotonicityGuard({
    now: 1_500_000, estimatedAt: 1_500_000,
    projectedFinishAt: 1_400_000,             // already in the past
    previousRemainingSeconds: 60,
    remainingSeconds: 300,
  });
  assert.equal(expired.slipReason, 'expired');
  assert.equal(expired.displayedRemainingSeconds, 300);

  // (b) a new stage marker landed
  const newPhase = estimateGuard.applyMonotonicityGuard({
    ...GUARD_BASE,
    projectedFinishAt: 1_000_000 + 120_000,
    previousRemainingSeconds: 120,
    remainingSeconds: 400,
    newPhaseSinceLast: true,
  });
  assert.equal(newPhase.slipReason, 'new_phase');
  assert.equal(newPhase.displayedRemainingSeconds, 400);

  // (c) the model at least doubled its own previous guess
  const revision = estimateGuard.applyMonotonicityGuard({
    ...GUARD_BASE,
    projectedFinishAt: 1_000_000 + 120_000,
    previousRemainingSeconds: 120,
    remainingSeconds: 300,                    // >= 2x 120
  });
  assert.equal(revision.slipReason, 'revision');
  assert.equal(revision.displayedRemainingSeconds, 300);
});

test('#892 guard: ALWAYS yields a positive number of seconds', () => {
  // The core invariant. Property-checked over the awkward inputs: a zero
  // candidate, a null candidate, an already-expired projection, and a long
  // run of consecutive extensions.
  const cases = [];
  for (const remainingSeconds of [null, undefined, 0, 1, 30, 120, 7200, -5, NaN]) {
    for (const projectedFinishAt of [null, 900_000, 1_000_000, 1_000_500, 2_000_000]) {
      for (const previousRemainingSeconds of [null, 0, 60, 600]) {
        for (const newPhaseSinceLast of [false, true]) {
          cases.push({
            ...GUARD_BASE, remainingSeconds, projectedFinishAt,
            previousRemainingSeconds, newPhaseSinceLast,
          });
        }
      }
    }
  }
  for (const c of cases) {
    const r = estimateGuard.applyMonotonicityGuard(c);
    assert.ok(Number.isFinite(r.displayedRemainingSeconds),
      `non-finite output for ${JSON.stringify(c)}`);
    assert.ok(r.displayedRemainingSeconds >= estimateGuard.MIN_DISPLAY_REMAINING_S,
      `output below the floor for ${JSON.stringify(c)}: ${r.displayedRemainingSeconds}`);
    assert.ok(r.projectedFinishAt > c.now,
      `projection must be in the future for ${JSON.stringify(c)}`);
    assert.equal(typeof r.clamped, 'boolean');
    assert.ok(r.slipReason === null || typeof r.slipReason === 'string');
  }
});

test('#892 guard: the floor binds and re-anchors the projection', () => {
  const r = estimateGuard.applyMonotonicityGuard({
    now: 1_000_000, estimatedAt: 1_000_000,
    projectedFinishAt: 990_000,               // ran out 10s ago
    previousRemainingSeconds: 60,
    remainingSeconds: null,                   // and the model declined a number
  });
  assert.equal(r.displayedRemainingSeconds, estimateGuard.MIN_DISPLAY_REMAINING_S);
  assert.equal(r.floored, true);
  // Re-anchored, so the client counts down from the floor rather than from
  // a target already in the past.
  assert.equal(r.projectedFinishAt, 1_000_000 + 30_000);
});

test('#892 guard: no bail-out — twenty consecutive extensions each yield a number', () => {
  // A run that keeps outliving its estimate keeps getting extended. There is
  // deliberately no counter that gives up and switches to an open-ended
  // state; the extension rate is observable on the dashboard instead.
  let projectedFinishAt = null;
  let previousRemainingSeconds = null;
  let now = 1_000_000;
  for (let i = 0; i < 20; i++) {
    const r = estimateGuard.applyMonotonicityGuard({
      projectedFinishAt, previousRemainingSeconds,
      remainingSeconds: 120,
      estimatedAt: now, now,
    });
    assert.ok(r.displayedRemainingSeconds > 0, `tick ${i} produced no number`);
    projectedFinishAt = r.projectedFinishAt;
    previousRemainingSeconds = 120;
    now += 180_000;   // each tick arrives after the projection expired
  }
});

test('#892 guard: only ever the candidate, the held projection, or the floor', () => {
  // It must never derive a THIRD number — no scaling, no blending. That
  // would be output-side calibration wearing a display-rule costume.
  for (let raw = 0; raw <= 900; raw += 7) {
    for (const held of [null, 1_000_000 + 60_000, 1_000_000 + 600_000, 999_000]) {
      const r = estimateGuard.applyMonotonicityGuard({
        ...GUARD_BASE, remainingSeconds: raw, projectedFinishAt: held,
        previousRemainingSeconds: 100,
      });
      const heldRemaining = held == null ? null : Math.round((held - GUARD_BASE.now) / 1000);
      const allowed = [raw, heldRemaining, estimateGuard.MIN_DISPLAY_REMAINING_S]
        .filter((v) => v != null);
      assert.ok(allowed.includes(r.displayedRemainingSeconds),
        `derived a third value (raw=${raw}, held=${heldRemaining}) -> ${r.displayedRemainingSeconds}`);
    }
  }
});

test('#892: the RAW model value is what gets recorded, never the guarded one', () => {
  const sessions = read('src/routes/sessions.js');
  const insertAt = sessions.indexOf('INSERT INTO progress_estimates');
  const insert = sessions.slice(insertAt, insertAt + 1600);
  // predicted_remaining_seconds is bound to the raw `remainingSeconds`;
  // the post-guard value goes to its own column.
  assert.match(insert, /text, remainingSeconds,/,
    'the raw phrase and raw number must be the values bound to the model columns');
  assert.match(insert, /guard\.displayedRemainingSeconds,/,
    'the post-guard value must go to displayed_remaining_seconds');
  assert.match(insert, /predicted_remaining_seconds,/);
  assert.match(insert, /displayed_remaining_seconds,/);
  assert.match(insert, /prompt_version,/, 'the prompt generation must be recorded');
});

test('#892: no overrun flag anywhere in the estimate path', () => {
  // The countdown always shows a number, so there is no open-ended state to
  // signal. A reintroduced flag would mean the copy came back with it.
  // Matched as a FIELD, not as a word — the comments explaining why there is
  // no overrun state legitimately use the term.
  const asField = /(^|[^A-Za-z])overrun\s*[:=]|\.overrun\b|['"`]overrun['"`]/im;
  for (const rel of [
    'src/services/estimate-guard.js',
    'src/routes/sessions.js',
    'public/js/dev-chat.js',
    'public/js/cc-progress-summary.js',
    'src/services/worker-progress.js',
    'src/services/analytics-demo.js',
  ]) {
    assert.doesNotMatch(read(rel), asField, `${rel} must carry no overrun field`);
  }
});

test('#892: the countdown copy never says "due now" or "taking longer"', () => {
  // Matched as RENDERED copy (a quoted string), not as prose — the comments
  // describing what was retired legitimately name it.
  const asCopy = (phrase) => new RegExp(`['"\`][^'"\`\\n]*${phrase}[^'"\`\\n]*['"\`]`, 'i');
  for (const rel of ['public/js/cc-progress-summary.js', 'public/js/dev-chat.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, asCopy('due now'),
      `${rel} must not render the retired "due now" freeze`);
    // Specifically the overrun copy the countdown would have used. An
    // unrelated "(taking longer than usual)" row suffix elsewhere in
    // dev-chat is a different feature and stays.
    assert.doesNotMatch(src, asCopy('taking longer than expected'),
      `${rel} must not render an open-ended overrun message`);
  }
  // And the helper that owns the copy must produce the numeric form instead.
  const summary = require('../public/js/cc-progress-summary.js');
  assert.equal(summary.formatCountdown(0, 1_000_000), ' · under a minute left');
});

// ── 3c. Completion-claim suppression ────────────────────────────────────

test('#892: isCompletionClaim matches the measured phrase family', () => {
  // Real recorded v1 output that fired with 20+ minutes still to run.
  const claims = [
    'nearly done — just wrapping up tests',
    'nearly done — wrapping up final tuning validation',
    'almost done, final checks',
    'just finishing the last edits',
    'wrapping up',
    'nearly finished',
    'NEARLY DONE',
    'final touches on the styling',
  ];
  for (const c of claims) {
    assert.ok(llm.isCompletionClaim(c), `should match: ${c}`);
  }
});

test('#892: isCompletionClaim does not fire on neutral activity text', () => {
  const neutral = [
    'still working through file updates',
    'running the test suite',
    'maybe halfway through — several minutes left',
    'still early, reading the codebase',
    'reading the auth middleware',
    'probably past halfway — substantial work remaining',
    '',
    null,
    undefined,
  ];
  for (const n of neutral) {
    assert.ok(!llm.isCompletionClaim(n), `should NOT match: ${JSON.stringify(n)}`);
  }
});

test('#892: suppression is gated on the phase and leaves the recorded text raw', () => {
  const sessions = read('src/routes/sessions.js');
  assert.match(sessions, /const claimEarned = \['commit', 'push', 'done', 'push_failed'\]\.includes\(phaseHead\);/,
    'a completion claim is only earned once the run actually reached those stages');
  assert.match(sessions, /const suppressed = llm\.isCompletionClaim\(text\) && !claimEarned;/,
    'suppression must combine the phrase match with the phase gate');
  // The phrase is rewritten; the NUMBER is untouched.
  assert.match(sessions, /const shownText = suppressed/, 'only the phrase is rewritten');
  assert.doesNotMatch(sessions, /suppressed \? null : remainingSeconds/,
    'suppression must never touch the countdown value');
  // And the raw model text still reaches the dataset.
  const insertAt = sessions.indexOf('INSERT INTO progress_estimates');
  const insert = sessions.slice(insertAt, insertAt + 1600);
  assert.match(insert, /estimate_text_shown, suppressed,/,
    'the shown text and the suppression flag are recorded separately from the raw text');
});

test('#892 guard: absence is distinguished from zero', () => {
  // Number(null) is 0 and Number('') is 0, so a naive coercion turns "no
  // projection yet" into "a projection that expired in 1970" (the first
  // guess of every run would be logged as an `expired` extension) and "the
  // model declined a number" into "the model said zero seconds" (the
  // countdown would floor instead of continuing to run the projection down).
  const first = estimateGuard.applyMonotonicityGuard({
    projectedFinishAt: null, previousRemainingSeconds: null,
    remainingSeconds: 240, estimatedAt: 1_000_000, now: 1_000_000,
  });
  assert.equal(first.slipReason, null, 'the first guess of a run is not an extension');
  assert.equal(first.clamped, false);
  assert.equal(first.displayedRemainingSeconds, 240);

  const declined = estimateGuard.applyMonotonicityGuard({
    projectedFinishAt: 1_000_000 + 90_000,   // 90s of projection left
    previousRemainingSeconds: 120,
    remainingSeconds: null,                   // the model gave no number
    estimatedAt: 1_000_000, now: 1_000_000,
  });
  assert.equal(declined.displayedRemainingSeconds, 90,
    'a declined number keeps running the existing projection down, not to the floor');
  assert.equal(declined.floored, false);

  // An explicit zero IS a real answer and must floor, not be ignored.
  const zero = estimateGuard.applyMonotonicityGuard({
    projectedFinishAt: 1_000_000 + 90_000,
    previousRemainingSeconds: 120,
    remainingSeconds: 0,
    estimatedAt: 1_000_000, now: 1_000_000,
  });
  assert.equal(zero.displayedRemainingSeconds, estimateGuard.MIN_DISPLAY_REMAINING_S);
  assert.equal(zero.floored, true);
});
