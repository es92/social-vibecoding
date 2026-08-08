'use strict';

// Guaranteed quick-reply pills (#894).
//
// Background: the dev-chat pill bar renders from the newest message
// carrying metadata.quickReplies, and those pills came ONLY from the
// Mayor's optional suggest_replies tool. Production turns skip it
// routinely (a chat reply with `toolUses: 0`, a wrap-up that ends
// `end_turn`), and several turn-end paths — worker-busy, stop-during-run,
// refusal, provider error — never reach a pill-bearing persist at all. The
// bar then stays empty until the user types something themselves, which is
// the reported symptom ("suggested dev chat options have kind of stopped
// showing up").
//
// Three layers now guarantee the pills, and this file covers all three:
//   1. the deterministic policy in services/recovery-pills.js;
//   2. the server substituting it at every turn-end path in routes/sessions.js;
//   3. the client's last-resort default for rows that predate the guarantee.
//
// Layers 2 and 3 are source-invariant tests (repo convention for
// closure-internal logic): they read the source and assert the wiring
// rather than booting a server or a browser.
//
// Run with: node --test tests/quick-reply-fallback.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const recoveryPills = require('../src/services/recovery-pills.js');
const { sanitizeQuickReplies } = require('../src/routes/sessions.js');

const {
  RECOVERY_PILLS,
  QR_MAX_REPLIES,
  QR_MAX_REPLY_LEN,
  fallbackKindForTurn,
  turnFallbackQuickReplies,
} = recoveryPills;

const SESSIONS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'sessions.js'),
  'utf8'
);
const DEVCHAT_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

// ── 1. The policy ────────────────────────────────────────────────────

test('new pill kinds exist with the wording the spec fixed', () => {
  assert.deepEqual([...RECOVERY_PILLS.chat_generic],
    ['Make a change', 'What issues are open right now?', "What's the current state?"]);
  assert.deepEqual([...RECOVERY_PILLS.build_running],
    ["How's it going?", 'Stop this build']);
  assert.deepEqual([...RECOVERY_PILLS.turn_failed],
    ['Try that again', 'What went wrong?']);
});

test('every pill set round-trips through the route sanitizer unchanged', () => {
  // recovery-pills.js deliberately does NOT require routes/sessions.js
  // (services → routes cycle), so the sanitizer contract is asserted here
  // instead: <= 3 entries, <= 80 chars, no case-insensitive dupes.
  for (const [kind, pills] of Object.entries(RECOVERY_PILLS)) {
    const arr = [...pills];
    assert.ok(arr.length > 0 && arr.length <= QR_MAX_REPLIES, `${kind}: 1..${QR_MAX_REPLIES} entries`);
    for (const p of arr) {
      assert.ok(p.length <= QR_MAX_REPLY_LEN, `${kind}: "${p}" fits ${QR_MAX_REPLY_LEN} chars`);
    }
    assert.deepEqual(sanitizeQuickReplies({ replies: arr }), arr,
      `${kind} survives sanitizeQuickReplies unchanged`);
  }
});

test('fallbackKindForTurn: dispatch outcomes ignore session state', () => {
  for (const state of [{}, { hasPr: true }, { hasSpec: true }, { hasPr: true, hasSpec: true }]) {
    assert.equal(fallbackKindForTurn({ outcome: 'build_done', ...state }), 'code_done');
    assert.equal(fallbackKindForTurn({ outcome: 'spec_done', ...state }), 'spec_done');
    assert.equal(fallbackKindForTurn({ outcome: 'failed', ...state }), 'turn_failed');
    assert.equal(fallbackKindForTurn({ outcome: 'stopped', ...state }), 'turn_failed');
    assert.equal(fallbackKindForTurn({ outcome: 'worker_busy', ...state }), 'build_running');
  }
});

test('fallbackKindForTurn: a chat turn derives its kind from session state', () => {
  // A PR means a build landed; else a spec means scout work landed; else
  // nothing has happened yet and we offer the ways in.
  assert.equal(fallbackKindForTurn({ outcome: 'chat', hasPr: true, hasSpec: true }), 'code_done');
  assert.equal(fallbackKindForTurn({ outcome: 'chat', hasPr: true, hasSpec: false }), 'code_done');
  assert.equal(fallbackKindForTurn({ outcome: 'chat', hasPr: false, hasSpec: true }), 'spec_done');
  assert.equal(fallbackKindForTurn({ outcome: 'chat', hasPr: false, hasSpec: false }), 'chat_generic');
});

test('fallbackKindForTurn: unknown/absent outcome degrades to the boot-sweep choice', () => {
  assert.equal(fallbackKindForTurn(), 'unknown_state');
  assert.equal(fallbackKindForTurn({}), 'unknown_state');
  assert.equal(fallbackKindForTurn({ outcome: 'nonsense' }), 'unknown_state');
  assert.equal(fallbackKindForTurn({ outcome: 'nonsense', hasPr: true }), 'code_done');
  assert.equal(fallbackKindForTurn({ outcome: 'nonsense', hasSpec: true }), 'spec_done');
});

test('turnFallbackQuickReplies materialises a fresh, non-empty array', () => {
  const a = turnFallbackQuickReplies({ outcome: 'build_done' });
  const b = turnFallbackQuickReplies({ outcome: 'build_done' });
  assert.deepEqual(a, ['Propose it to the group', 'Make a tweak', 'What did it change?']);
  assert.notEqual(a, b, 'each call returns its own array (callers JSON.stringify it)');
  a.push('mutated');
  assert.equal(b.length, 3, 'mutating one result must not affect the frozen source set');

  // Every outcome the chat handler passes must produce pills — the whole
  // point is that no path can end with nothing.
  for (const outcome of ['chat', 'build_done', 'spec_done', 'failed', 'stopped', 'worker_busy']) {
    const pills = turnFallbackQuickReplies({ outcome });
    assert.ok(Array.isArray(pills) && pills.length, `${outcome} yields pills`);
  }
});

// ── 2. Server wiring ─────────────────────────────────────────────────

test('the chat handler imports the fallback policy', () => {
  assert.match(SESSIONS_SRC, /turnFallbackQuickReplies,[\s\S]{0,300}?}\s*=\s*require\('\.\.\/services\/recovery-pills'\)/,
    'sessions.js must import turnFallbackQuickReplies from the policy module rather than inlining pill strings');
});

// #1001 replaced the phase-1 / phase-2 substitutions below with the
// resolveTurnPills ladder, which asks the Mayor for its OWN pills before
// reaching for any fixed set. These tests moved with the call sites: they
// still pin "the fixed set is reached through the shared policy, never
// inlined", but the shape they pin is now the ladder.
test('phase-1 routes its pills through the resolution ladder', () => {
  const m = SESSIONS_SRC.match(/pills1 = await resolvePills\('chat', \{([\s\S]{0,400}?)\}\);/);
  assert.ok(m, 'found the phase-1 pill resolution');
  assert.match(m[1], /modelPills: quickReplies/,
    "the Mayor's own set is offered as rung 1");
  assert.match(m[1], /model: servedModel1/,
    'the enforcement call runs on the model that actually served this turn');
  assert.match(m[1], /replyText: mayorText1/,
    'the enforcement context carries the reply the pills sit under');
  // The clarifying-question exclusion is the one case that must produce NO
  // pills and make NO extra model call.
  assert.match(SESSIONS_SRC, /const chipsOwnTurn = Array\.isArray\(suggestions\) && suggestions\.length > 0;/,
    'answer chips still suppress the pill row entirely');
  assert.match(SESSIONS_SRC, /if \(!chipsOwnTurn\) \{/,
    'the resolution is skipped outright on a clarifying-question turn');
});

test('phase-1 streams the reply text before doing any pill work', () => {
  // The whole latency argument for enforcement rests on this ordering: the
  // user reads the reply while the pill call is still in flight.
  const body = SESSIONS_SRC.slice(SESSIONS_SRC.indexOf('if (mayorText1.trim()) {'));
  const reasoningAt = body.indexOf("send('mayor_reasoning', { text: mayorText1 })");
  const resolveAt = body.indexOf('await resolvePills(');
  assert.ok(reasoningAt >= 0 && resolveAt >= 0, 'found both the emit and the resolution');
  assert.ok(reasoningAt < resolveAt,
    'mayor_reasoning must be emitted BEFORE the pill ladder runs');
});

test('phase-1 persists and broadcasts the resolved set, not the raw one', () => {
  // The row metadata and the live 'quick_replies' event must both use the
  // resolved value, or the pills exist in exactly one of DB / open UI.
  assert.match(SESSIONS_SRC, /\.\.\.quickReplyMeta\(pills1, \{ preamble: willDispatch \}\)/,
    'the phase-1 assistant row persists the resolved set plus its telemetry');
  assert.match(SESSIONS_SRC, /if \(pills1 && pills1\.replies\) send\('quick_replies', \{ replies: pills1\.replies \}\)/,
    'the phase-1 SSE/WS event carries the resolved replies');
});

test('the phase-2 wrap-up resolves by dispatch outcome', () => {
  const m = SESSIONS_SRC.match(/const wrapUpOutcome = ([\s\S]{0,200}?);/);
  assert.ok(m, 'found the phase-2 outcome mapping');
  const arg = m[1];
  assert.match(arg, /toolResult\.isError\s*\n?\s*\?\s*'failed'/, 'a failed dispatch gets the retry pills');
  assert.match(arg, /toolKind === 'scout' \? 'spec_done'/, 'a scout wrap-up gets the spec pills');
  assert.match(arg, /'build_done'/, 'a build wrap-up gets the post-build pills');

  const r = SESSIONS_SRC.match(/const wrapUpResolved = await resolvePills\(wrapUpOutcome, \{([\s\S]{0,400}?)\}\);/);
  assert.ok(r, 'the wrap-up routes through the ladder');
  assert.match(r[1], /modelPills: quickReplies2/, "the wrap-up's own tool call is rung 1");
  assert.match(r[1], /replyText: mayorText2/, 'the enforcement context carries the wrap-up text');
  assert.match(SESSIONS_SRC, /JSON\.stringify\(quickReplyMeta\(wrapUpResolved\)\)/,
    'the wrap-up row persists the resolved set plus its telemetry');
  assert.match(SESSIONS_SRC, /if \(wrapUpPills\) send\('quick_replies', \{ replies: wrapUpPills \}\)/,
    'the wrap-up SSE/WS event carries wrapUpPills');
});

test('every status-only turn end carries pills on its status row', () => {
  // These paths never persist an assistant row, so the status line is the
  // only thing the client's backward scan can find.
  const sites = [
    [/Claude Code is already running for this session[\s\S]{0,200}?turnPills\('worker_busy'\)/,
      'worker-busy race'],
    [/refusalText\(selectedModel, refusalCategory\)[\s\S]{0,300}?turnPills\('failed'\)/,
      'whole-chain model refusal'],
    [/This turn failed: \$\{friendly\}[\s\S]{0,300}?turnPills\('failed'\)/,
      'provider/turn error catch'],
    [/Scout stopped\$\{byStr\}[\s\S]{0,300}?turnFallbackQuickReplies\(\{ outcome: 'stopped' \}\)/,
      'scout stopped mid-run'],
    [/Claude Code stopped\$\{byStr\}[\s\S]{0,300}?turnFallbackQuickReplies\(\{ outcome: 'stopped' \}\)/,
      'build stopped mid-run'],
  ];
  for (const [re, label] of sites) {
    assert.match(SESSIONS_SRC, re, `${label}: its status row must carry quickReplies`);
  }
  // Both Mayor-phase stops (phase-1 and the data-summary re-prompt).
  const mayorStops = SESSIONS_SRC.match(/sendStatus\(`Stopped\$\{byStr\}\.`, \{ quickReplies: turnPills\('stopped'\) \}\)/g);
  assert.equal(mayorStops && mayorStops.length, 2,
    'both `Stopped by @…` status rows in the Mayor phases carry pills');
});

test('the turn-state helper reads PR/spec state at call time', () => {
  // session.pr_number is mutated in place by applyPrMetadata and the spec
  // is reloaded before phase 2 — a snapshot taken at turn start would give
  // a just-built session the pre-build pill set.
  assert.match(SESSIONS_SRC, /const turnPills = \(outcome\) => turnFallbackQuickReplies\(\{[\s\S]{0,200}?hasPr: session\.pr_number != null/,
    'turnPills reads session.pr_number when called');
  const specRefreshes = SESSIONS_SRC.match(/turnHasSpec = !!\(currentSpec \|\| ''\)\.trim\(\);/g);
  assert.equal(specRefreshes && specRefreshes.length, 2,
    'turnHasSpec is refreshed both at turn start and before the phase-2 wrap-up');
});

test('the Mayor prompt requires suggest_replies rather than suggesting it', () => {
  assert.match(SESSIONS_SRC, /Every message you send MUST call the suggest_replies tool/,
    'the SUGGESTED QUICK REPLIES block states the requirement');
  assert.match(SESSIONS_SRC, /ALWAYS call suggest_replies alongside your reply/,
    'GENERAL RULES cross-references it, where the one-tool limit is stated');
});

// ── 2b. #1001: the prompt must not teach by literal example ──────────
//
// Half of all production pill sets were byte-identical to the example
// triples the prompt and the tool description used to list. These two tests
// are what stop that from being reintroduced by a future prompt edit: (a)
// the literal triples are gone from the prompt surfaces, and (b) every
// static string the platform ships is on the banned list, so a model that
// echoes ANY of them is detected as generic rather than trusted.

test('no prompt surface lists a boilerplate pill triple verbatim', () => {
  // The Mayor system prompt + the tool description are the two surfaces the
  // model reads. QUICK_REPLY_RULES_TEXT deliberately DOES name these
  // strings — as forbidden output — so the check is scoped to the prompt
  // text in sessions.js and excludes the rules constant itself.
  const forbidden = [
    ['Preview the change', 'Propose it to the group', 'Make another tweak'],
    // #1046: both the current spec triple and its pre-#1046 wording — the
    // prompt must not offer either as a run to copy, even though the
    // build pill alone IS a required literal now (see the next test).
    ['Build the spec', 'Revise the spec', 'What will this change?'],
    ['Build it', 'Revise the spec', 'What will this change?'],
    ['Propose it to the group', 'Make a tweak', 'What did it change?'],
    ["How's it going?", 'Stop this build'],
  ];
  for (const triple of forbidden) {
    // The old shape was `e.g. "A", "B", "C".` on one line — a quoted,
    // comma-separated run of the exact strings. Match that shape only, so a
    // prose mention ("do not send 'Build it' verbatim") stays legal.
    const run = triple.map((s) => `"${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).join(', ');
    assert.doesNotMatch(SESSIONS_SRC, new RegExp(`e\\.g\\.\\s*${run}`),
      `the prompt must not offer ${JSON.stringify(triple)} as an example to copy`);
  }
});

test('QUICK_REPLY_RULES_TEXT is shared, not duplicated', () => {
  const LLM_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'llm.js'), 'utf8'
  );
  // One definition...
  const defs = recoveryPills.QUICK_REPLY_RULES_TEXT;
  assert.ok(defs && defs.length > 200, 'the rules constant carries real guidance');
  assert.match(defs, /COMPOSITION RULE/, 'it states the at-most-one-generic rule');
  assert.match(defs, /NEVER emit/, 'it names the boilerplate sets as forbidden output');
  assert.match(defs, /SAME LANGUAGE/,
    'it tells the model to match the conversation language, not default to English');

  // ...interpolated into all four surfaces.
  assert.match(SESSIONS_SRC, /\+ QUICK_REPLY_RULES_TEXT,/,
    'SUGGEST_REPLIES_TOOL.description appends the shared rules');
  assert.match(SESSIONS_SRC, /\$\{QUICK_REPLY_RULES_TEXT\}/,
    'the Mayor system prompt interpolates the shared rules');
  const ruleUses = SESSIONS_SRC.match(/rules: QUICK_REPLY_RULES_TEXT,/g);
  assert.equal(ruleUses && ruleUses.length, 2,
    'both the forced call and the Haiku backstop are handed the same rules');
  assert.match(LLM_SRC, /\$\{rules \|\| ''\}/,
    'llm.js renders the rules it is handed rather than carrying its own copy');
});

// ── 2c. #1046: the post-spec build pill names the WHOLE spec ─────────
//
// The composition rule, read literally, asked for a concrete subject in
// every pill — and production obliged with "Build the collapsible left
// sidebar" / "Build the seasons API and CRUD" on specs that covered far
// more than the component named. The rule now carves the build pill out
// as a required literal occupying the one generic slot. These tests pin
// both halves so a later prompt edit can't quietly undo either.

test('the rules require a whole-spec build pill, not a component name', () => {
  const defs = recoveryPills.QUICK_REPLY_RULES_TEXT;
  assert.match(defs, /POST-SPEC BUILD PILL/,
    'the rules carve the post-spec build pill out as its own clause');
  assert.match(defs, /Build the spec/,
    'the required literal is stated');
  assert.match(defs, /WHOLE spec/,
    'the clause says the pill refers to the whole spec');
  assert.match(defs, /Do NOT name a single component/,
    'naming one component as the build target is explicitly forbidden');
  // The carve-out must not cancel the specificity pressure on the rest.
  assert.match(defs, /remaining 1-2 pills must still name something specific/,
    'the other pills still have to be specific to this spec');
  // ...and the whole-set ban must not read as a ban on the pill itself.
  assert.match(defs, /"Build the spec" is meant to be sent verbatim/,
    'the set-level ban is reconciled with the required literal');
});

test('the Mayor prompt\'s post-spec guidance says the whole spec', () => {
  const bullet = SESSIONS_SRC.match(/^- After a spec \(dispatch_scout\):.*$/m);
  assert.ok(bullet, 'found the post-spec situational guidance bullet');
  assert.match(bullet[0], /WHOLE spec/,
    'the situational list agrees with the shared rule');
  assert.doesNotMatch(bullet[0], /building it,/,
    'the pre-#1046 "building it" wording is gone');
});

test('a whole-spec build pill still passes only alongside specific pills', () => {
  const { isGenericPillSet } = recoveryPills;
  assert.equal(
    isGenericPillSet(['Build the spec', 'Drop the crop step from the plan',
      'What does this add to the database?']),
    false,
    'the intended shape — required literal plus two specific pills — is accepted');
  assert.equal(
    isGenericPillSet(['Build the spec', 'Revise the spec', 'What will this change?']),
    true,
    'an all-boilerplate set still escalates, the literal notwithstanding');
  // The near-variants must not be a loophole around that.
  assert.equal(
    isGenericPillSet(['Build the whole spec', 'Build the spec as written']),
    true,
    'rephrasing the required literal does not make a set specific');
});

test('BANNED_GENERIC_PILLS covers every static pill the platform ships', () => {
  const { BANNED_GENERIC_PILLS, normalizePill, RECOVERY_PILLS: SETS } = recoveryPills;

  // Server policy sets.
  for (const [kind, pills] of Object.entries(SETS)) {
    for (const pill of pills) {
      assert.ok(BANNED_GENERIC_PILLS.has(normalizePill(pill)),
        `RECOVERY_PILLS.${kind} pill ${JSON.stringify(pill)} must be on the banned list`);
    }
  }
  // Client starter set (parsed out of the browser source — it can't be
  // required, which is exactly why drift needs asserting).
  const starters = DEVCHAT_SRC.match(/STARTER_QUICK_REPLIES:\s*\[([\s\S]*?)\],/);
  assert.ok(starters, 'found STARTER_QUICK_REPLIES');
  for (const m of starters[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
    const pill = m[1].replace(/\\'/g, "'");
    assert.ok(BANNED_GENERIC_PILLS.has(normalizePill(pill)),
      `starter pill ${JSON.stringify(pill)} must be on the banned list`);
  }
  // Fork follow-up set.
  const { FORK_FOLLOWUP_REPLIES } = require('../src/services/transcript-share.js');
  for (const pill of FORK_FOLLOWUP_REPLIES) {
    assert.ok(BANNED_GENERIC_PILLS.has(normalizePill(pill)),
      `fork follow-up pill ${JSON.stringify(pill)} must be on the banned list`);
  }
});

test('every model-backed call site goes through the ladder', () => {
  const sites = [
    [/pills1 = await resolvePills\('chat'/, 'phase-1 reply and dispatch preamble'],
    [/const wrapUpResolved = await resolvePills\(wrapUpOutcome/, 'phase-2 wrap-up'],
    [/phase: 'recovered-wrapup'/, 'restart-recovered wrap-up'],
    [/phase: 'clone-followup'/, 'auto-session clone follow-up'],
    [/phase: 'fork-followup'/, 'shared-chat fork follow-up'],
  ];
  for (const [re, label] of sites) {
    assert.match(SESSIONS_SRC, re, `${label} must resolve pills through resolveTurnPills`);
  }
  // Exactly one retry, ever — the ladder must not loop.
  assert.match(SESSIONS_SRC, /There is no second retry\./,
    'the no-second-retry rule is stated at the enforcement site');
});

test('headless wrap-up rows carry pills', () => {
  // The single biggest no-pills hole measured in production: every headless
  // final row wrote no metadata at all.
  assert.match(SESSIONS_SRC, /function headlessWrapUpMeta\(outcome/,
    'a helper exists for headless final-row metadata');
  const uses = SESSIONS_SRC.match(/headlessWrapUpMeta\(/g);
  assert.ok(uses && uses.length >= 5,
    'the helper is defined and applied at every headless final-row persist');
  const { headlessWrapUpMeta } = require('../src/routes/sessions.js');
  // The question outcome stays pill-free (its chips own the turn), and so
  // does any outcome whose row already carries answer chips.
  assert.deepEqual(headlessWrapUpMeta('question'), {},
    'a question outcome persists no pills');
  assert.deepEqual(
    headlessWrapUpMeta('spec', { suggestions: [{ question: 'Which?', answers: ['a'] }] }),
    { suggestions: [{ question: 'Which?', answers: ['a'] }] },
    'answer chips suppress the pill row here too');
  assert.equal(headlessWrapUpMeta('spec').quickRepliesKind, 'spec_done');
  assert.equal(headlessWrapUpMeta('code').quickRepliesKind, 'code_done');
  assert.equal(headlessWrapUpMeta('spec_code').quickRepliesKind, 'code_done');
  assert.equal(headlessWrapUpMeta('failed').quickRepliesKind, 'turn_failed');
  assert.equal(headlessWrapUpMeta('spec').quickRepliesSource, 'static',
    'a headless row is honestly recorded as the static set, not as authored');
});

// ── 3. Client wiring ─────────────────────────────────────────────────

function sliceBetween(src, startMarker, endMarker, label) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `found ${label} start marker: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end > start, `found ${label} end marker: ${endMarker}`);
  return src.slice(start, end);
}

const currentQuickRepliesBody = sliceBetween(
  DEVCHAT_SRC, '_currentQuickReplies() {', '_renderQuickReplies() {', 'DevChat._currentQuickReplies'
);

test('the client falls back instead of returning null when no row has pills', () => {
  assert.match(currentQuickRepliesBody, /return DevChat\._fallbackQuickReplies\(\);/,
    'the no-pills path must end in the fallback, not `return null`');
  // The pre-existing gates must survive: hidden mid-turn, hidden on a
  // non-interactive session, and a found set always wins.
  assert.match(currentQuickRepliesBody, /if \(DevChat\.isStreaming\) return null;/,
    'still hidden while a turn streams');
  assert.match(currentQuickRepliesBody, /status === 'active' \|\| session\.status === 'promoted'/,
    'still hidden on a read-only/finished session');
  assert.match(currentQuickRepliesBody, /if \(!sawNonSystem\) return DevChat\._starterQuickReplies\(\);/,
    'a brand-new session still gets the starter set (#1001: issue-aware when known)');
});

test('the client fallback is gated to a pill-less assistant reply', () => {
  // Behaviour is exercised for real in tests/quick-replies-delivery.test.js
  // (which evals this function against fake timelines); these two guards
  // are pinned here because dropping either silently changes when the bar
  // is allowed to be empty.
  assert.match(currentQuickRepliesBody,
    /if \(!lastConvoRow \|\| lastConvoRow\.role !== 'assistant'\) return null;/,
    'a sent user row must still clear the bar (#786)');
  assert.match(currentQuickRepliesBody,
    /if \(Array\.isArray\(lastConvoRow\.suggestions\) && lastConvoRow\.suggestions\.length\) return null;/,
    'an assistant row carrying #32 answer chips must keep the above-box row empty');
});

test('client fallback strings match the server policy exactly', () => {
  // Two copies of the same wording (the browser cannot require the Node
  // module), so drift is the real hazard — assert them equal rather than
  // eyeballing them.
  const m = DEVCHAT_SRC.match(/FALLBACK_QUICK_REPLIES:\s*(\{[\s\S]*?\n  \}),/);
  assert.ok(m, 'found DevChat.FALLBACK_QUICK_REPLIES');
  // eslint-disable-next-line no-eval
  const clientSets = eval(`(${m[1]})`);

  for (const kind of ['code_done', 'spec_done', 'chat_generic']) {
    assert.deepEqual(clientSets[kind], [...RECOVERY_PILLS[kind]],
      `client ${kind} pills must match RECOVERY_PILLS.${kind}`);
  }
  assert.deepEqual(Object.keys(clientSets).sort(), ['chat_generic', 'code_done', 'spec_done'],
    'the client mirrors exactly the three state-derived sets it can choose between');
});

test('the client picks its fallback set the same way the server does', () => {
  const body = sliceBetween(
    DEVCHAT_SRC, '_fallbackQuickReplies() {', '\n  },', 'DevChat._fallbackQuickReplies'
  );
  assert.match(body, /pr_number != null[\s\S]{0,120}?code_done/,
    'a PR means the build landed → post-build pills');
  assert.match(body, /hasSpec[\s\S]{0,120}?spec_done/,
    'a spec means scout work landed → spec pills');
  assert.match(body, /return DevChat\.FALLBACK_QUICK_REPLIES\.chat_generic;/,
    'neither → the generic ways-in set');
});

// #1001: the starter set is the ONE pill row that is legitimately generic —
// a fresh session has no conversation to be specific about. But a session
// started from an issue already knows what it is for.
test('starters lead with the issue when the session was started from one', () => {
  const body = sliceBetween(
    DEVCHAT_SRC, '_starterQuickReplies() {', '\n  },', 'DevChat._starterQuickReplies'
  );
  const compiled = new Function('DevChat', body.slice(body.indexOf('{') + 1, body.lastIndexOf('}')));
  const run = (session) => compiled({
    currentSession: session,
    STARTER_QUICK_REPLIES: ['What issues are open right now?', 'Change the colors', 'Add a new feature'],
    _starterQuickReplies: () => compiled({ currentSession: session }),
  });

  assert.deepEqual(run({ id: 1, created_from_issue_number: 1001 }),
    ['What does issue #1001 ask for?', 'Change the colors', 'Add a new feature'],
    'the open-issues question is replaced by one naming THIS issue');

  // Every shape that means "we do not know an issue" keeps the plain set.
  for (const session of [
    { id: 1 },
    { id: 1, created_from_issue_number: null },
    { id: 1, created_from_issue_number: 'nope' },
    null,
  ]) {
    assert.deepEqual(run(session),
      ['What issues are open right now?', 'Change the colors', 'Add a new feature'],
      `plain starters for ${JSON.stringify(session)}`);
  }
});

test('the session list serializes created_from_issue_number', () => {
  // Without it the client cannot name the issue; the column already existed
  // (#287) and simply was not sent.
  assert.match(SESSIONS_SRC, /created_from_issue_number,\n\s+\(spec_md IS NOT NULL/,
    'the dev-chat session list SELECT carries the issue number');
});

// ── 4. Staging fixtures ──────────────────────────────────────────────

test('staging seeds cover each fallback shape', () => {
  const MIGRATE_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db', 'migrate.js'),
    'utf8'
  );
  assert.match(MIGRATE_SRC, /await seedStagingQuickReplyFallback\(pool, config\);/,
    'the seed runs on boot');
  for (const branch of [
    'staging-fixture/fallback-after-build',
    'staging-fixture/fallback-after-spec',
    'staging-fixture/fallback-plain-chat',
    'staging-fixture/fallback-suppressed-by-chips',
    // #1001: the other side of the before/after — pills the assistant
    // authored, the enforced variant, and the preamble-vs-wrap-up
    // supersession rule.
    'staging-fixture/pills-assistant-authored',
    'staging-fixture/pills-after-forced-retry',
    'staging-fixture/pills-dispatch-preamble',
  ]) {
    assert.ok(MIGRATE_SRC.includes(branch), `fixture seeded: ${branch}`);
  }
  // The #1001 fixtures must demonstrate the change, so their pills have to
  // be specific — a fixture carrying boilerplate would show the old
  // behaviour while claiming to show the new one.
  const authored = MIGRATE_SRC.slice(
    MIGRATE_SRC.indexOf('staging-fixture/pills-assistant-authored'),
    MIGRATE_SRC.indexOf('staging-fixture/pills-after-forced-retry')
  );
  const set = authored.match(/quickReplies: \[([^\]]*)\]/);
  assert.ok(set, 'the authored fixture carries a pill set');
  const pills = [...set[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
  assert.equal(recoveryPills.isGenericPillSet(pills), false,
    `the assistant-authored fixture must not be boilerplate: ${JSON.stringify(pills)}`);
  // And each of the four sources must appear somewhere in the seeds, so a
  // reviewer can see every telemetry value rendering identically.
  for (const source of ['model', 'enforced', 'static']) {
    assert.ok(MIGRATE_SRC.includes(`quickRepliesSource: '${source}'`),
      `a fixture demonstrates the '${source}' source`);
  }
  assert.ok(MIGRATE_SRC.includes('quickRepliesPreamble: true'),
    'a fixture demonstrates a superseded dispatch-preamble row');
  // The fixtures must survive BOTH boot-time healers, or they demonstrate
  // the healer instead of the fallback: 'promoted' dodges the auto-pause
  // sweeper (a paused session hides the bar entirely) and the 30-day age
  // puts them outside restoreMissingQuickReplies' 7-day window.
  assert.match(MIGRATE_SRC, /VALUES\s*\n\s*\(\$1, \$2, \$3, \$4, \$5, \$6, 'promoted', \$7, FALSE,\s*\n\s*NOW\(\) - INTERVAL '30 days'/,
    "fallback fixtures are seeded 'promoted' and 30 days old on purpose");
});

test('dapp.json checks the pill bar on the seeded fixture routes', () => {
  // Fixed session ids (the route embeds one) are what make these routes
  // stable across staging rebuilds.
  const dapp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8'));
  const MIGRATE_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'db', 'migrate.js'),
    'utf8'
  );
  for (const id of [900801, 900802, 900803, 900805, 900806, 900807]) {
    assert.ok(MIGRATE_SRC.includes(`id: ${id},`), `fixture ${id} has a fixed id in the seed`);
    const t = (dapp.tests || []).find((x) => x.path && x.path.includes(`/sessions/${id}`));
    assert.ok(t, `dapp.json has a proposal check for session ${id}`);
    assert.equal(t.expectSelector, '#dc-quick-replies.dc-quick-replies-active .dc-quick-pill',
      `check ${id} asserts the pill bar actually rendered pills`);
  }
  // #1001: the preamble fixture's check must assert the WRAP-UP's pill, not
  // the preamble's — that is the supersession rule it exists to demonstrate.
  const preambleCheck = (dapp.tests || []).find((x) => x.path && x.path.includes('/sessions/900807'));
  assert.equal(preambleCheck.expectText, 'Preview the half-height rows',
    'the newest pill-bearing row wins, so the wrap-up pill is what renders');
});
