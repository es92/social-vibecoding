'use strict';

// Tests for the restart-recovery quick-reply policy (#786):
// src/services/recovery-pills.js — the deterministic pill sets the boot
// recovery paths attach to their breadcrumbs, the resend-pill rule for a
// Mayor turn that died before replying, and the pure backfill decision the
// boot sweep applies per session.
//
// The sets must also be sanitizer-clean: the module deliberately does NOT
// require routes/sessions.js (that would be a services → routes cycle), so
// the round-trip through sanitizeQuickReplies is asserted here instead.
//
// Run with: node --test tests/restart-recovery-pills.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QR_MAX_REPLIES,
  QR_MAX_REPLY_LEN,
  RECOVERY_PILLS,
  UNANSWERED_BREADCRUMB,
  LEGACY_UNANSWERED_BREADCRUMBS,
  isUnansweredBreadcrumb,
  TURN_UNFINISHED_BREADCRUMB,
  SCOUT_NO_SPEC_BREADCRUMB,
  buildRecoveryQuickReplies,
  classifyMissingPills,
  backfillKindForSession,
} = require('../src/services/recovery-pills.js');
const { sanitizeQuickReplies } = require('../src/routes/sessions.js');

test('every recovery kind builds its documented pill set', () => {
  assert.deepEqual(buildRecoveryQuickReplies('code_done'),
    ['Propose it to the group', 'Make a tweak', 'What did it change?']);
  assert.deepEqual(buildRecoveryQuickReplies('spec_done'),
    ['Build the spec', 'Revise the spec', 'What will this change?']);
  assert.deepEqual(buildRecoveryQuickReplies('push_failed'),
    ['Try that again', 'What went wrong?']);
  assert.deepEqual(buildRecoveryQuickReplies('unrecoverable'),
    ['Try that again', "What's the current state?"]);
  assert.deepEqual(buildRecoveryQuickReplies('unknown_state'),
    ["What's the current state?", 'Make a change']);
});

test('an unknown kind returns null (callers skip persistence)', () => {
  assert.equal(buildRecoveryQuickReplies('nope'), null);
  assert.equal(buildRecoveryQuickReplies(undefined), null);
  assert.equal(buildRecoveryQuickReplies(null), null);
});

test('returned arrays are fresh and mutable (the constants stay frozen)', () => {
  const a = buildRecoveryQuickReplies('code_done');
  const b = buildRecoveryQuickReplies('code_done');
  assert.notEqual(a, b);
  a.push('mutated');
  assert.deepEqual(buildRecoveryQuickReplies('code_done'),
    ['Propose it to the group', 'Make a tweak', 'What did it change?']);
  assert.ok(Object.isFrozen(RECOVERY_PILLS.code_done));
});

test('unanswered: a short message is prepended verbatim as a resend pill', () => {
  const out = buildRecoveryQuickReplies('unanswered', {
    lastUserText: '  Make the leaderboard sort by score  ',
  });
  assert.deepEqual(out, ['Make the leaderboard sort by score', "What's the current state?"]);
});

test('unanswered: a message longer than a pill is dropped, not clipped', () => {
  const long = 'x'.repeat(QR_MAX_REPLY_LEN + 1);
  const out = buildRecoveryQuickReplies('unanswered', { lastUserText: long });
  assert.deepEqual(out, ["What's the current state?"]);

  // Exactly at the cap still fits.
  const exact = 'y'.repeat(QR_MAX_REPLY_LEN);
  assert.deepEqual(buildRecoveryQuickReplies('unanswered', { lastUserText: exact }),
    [exact, "What's the current state?"]);
});

test('unanswered: missing / blank / non-string context degrades to the base set', () => {
  for (const ctx of [undefined, {}, { lastUserText: '' }, { lastUserText: '   ' }, { lastUserText: 42 }]) {
    assert.deepEqual(buildRecoveryQuickReplies('unanswered', ctx),
      ["What's the current state?"]);
  }
});

test('unanswered: a resend pill equal to a base pill is not duplicated', () => {
  const out = buildRecoveryQuickReplies('unanswered', {
    lastUserText: "what's the CURRENT state?",
  });
  assert.deepEqual(out, ["what's the CURRENT state?"]);
});

test('every set round-trips unchanged through the server sanitizer', () => {
  for (const [kind, pills] of Object.entries(RECOVERY_PILLS)) {
    const built = buildRecoveryQuickReplies(kind);
    assert.deepEqual(sanitizeQuickReplies({ replies: built }), built,
      `${kind} must already satisfy sanitizeQuickReplies`);
    assert.ok(pills.length <= QR_MAX_REPLIES, `${kind} within the ${QR_MAX_REPLIES}-pill cap`);
    for (const p of pills) {
      assert.ok(p.length <= QR_MAX_REPLY_LEN, `"${p}" within the ${QR_MAX_REPLY_LEN}-char cap`);
    }
  }
});

test('the unanswered set with a resend pill is also sanitizer-clean', () => {
  const built = buildRecoveryQuickReplies('unanswered', { lastUserText: 'Try the other layout' });
  assert.deepEqual(sanitizeQuickReplies({ replies: built }), built);
  assert.ok(built.length <= QR_MAX_REPLIES);
});

test('breadcrumb strings are non-empty and stable', () => {
  assert.equal(UNANSWERED_BREADCRUMB,
    "I didn't get to reply to that — send your message again.");
  assert.equal(SCOUT_NO_SPEC_BREADCRUMB,
    "The scout didn't produce a spec — please send your request again.");
  assert.equal(TURN_UNFINISHED_BREADCRUMB,
    "That coding turn didn't finish — please send your request again.");
});

// #896: the user-facing breadcrumbs name the situation and the action —
// never the platform restart behind them. A restart is plumbing the user
// can do nothing about; metadata.recovered carries it for operators.
test('no breadcrumb names the restart or the recovery machinery', () => {
  for (const text of [UNANSWERED_BREADCRUMB, SCOUT_NO_SPEC_BREADCRUMB, TURN_UNFINISHED_BREADCRUMB]) {
    assert.doesNotMatch(text, /restart|recover/i, `"${text}" leaks platform plumbing`);
    assert.ok(/again/.test(text), `"${text}" must tell the user what to do next`);
  }
});

// The backfill sweep detects its own prior row by exact string match, so
// renaming the breadcrumb without keeping the old wording around would
// post a duplicate on top of every pre-rename one at the next boot.
test('the unanswered breadcrumb matcher covers earlier wordings', () => {
  assert.ok(isUnansweredBreadcrumb(UNANSWERED_BREADCRUMB));
  assert.ok(LEGACY_UNANSWERED_BREADCRUMBS.length >= 1, 'the pre-#896 wording is remembered');
  for (const legacy of LEGACY_UNANSWERED_BREADCRUMBS) {
    assert.ok(isUnansweredBreadcrumb(legacy), `"${legacy}" must still be recognised`);
  }
  assert.ok(!isUnansweredBreadcrumb('Some unrelated system row'));
  assert.ok(!isUnansweredBreadcrumb(null));
});

// ── classifyMissingPills — the boot backfill decision ─────────────────

test('a row that already has pills is skipped', () => {
  assert.equal(classifyMissingPills({
    lastRow: { role: 'assistant', metadata: { quickReplies: ['Build it'] } },
  }), 'skip');
  // Empty array is not "has pills" — that row still needs a repair.
  assert.equal(classifyMissingPills({
    lastRow: { role: 'assistant', metadata: { quickReplies: [] } },
  }), 'attach_assistant');
});

test('a question turn is skipped — the #32 answer chips take precedence', () => {
  assert.equal(classifyMissingPills({
    lastRow: {
      role: 'assistant',
      metadata: { suggestions: [{ question: 'Which header?', answers: ['The top bar'] }] },
    },
  }), 'skip');
});

test('a bare assistant row gets pills attached', () => {
  assert.equal(classifyMissingPills({ lastRow: { role: 'assistant', metadata: {} } }),
    'attach_assistant');
  assert.equal(classifyMissingPills({ lastRow: { role: 'assistant' } }),
    'attach_assistant');
});

test('a trailing user row means the turn died before replying', () => {
  assert.equal(classifyMissingPills({
    lastRow: { role: 'user', content: 'Make it faster', metadata: {} },
  }), 'breadcrumb_unanswered');
});

test('no candidate row, or a system row, is skipped', () => {
  assert.equal(classifyMissingPills({ lastRow: null }), 'skip');
  assert.equal(classifyMissingPills({}), 'skip');
  assert.equal(classifyMissingPills(), 'skip');
  // The sweep queries user/assistant rows only, but be defensive: a
  // system row must never be the deciding row.
  assert.equal(classifyMissingPills({ lastRow: { role: 'system', metadata: {} } }), 'skip');
});

test('a user row that somehow already carries pills is skipped', () => {
  assert.equal(classifyMissingPills({
    lastRow: { role: 'user', metadata: { quickReplies: ['Try that again'] } },
  }), 'skip');
});

// ── backfillKindForSession — which set a repaired row gets ────────────

test('backfill kind follows the session state: PR > spec > unknown', () => {
  assert.equal(backfillKindForSession({ hasPr: true, hasSpec: true }), 'code_done');
  assert.equal(backfillKindForSession({ hasPr: true, hasSpec: false }), 'code_done');
  assert.equal(backfillKindForSession({ hasPr: false, hasSpec: true }), 'spec_done');
  assert.equal(backfillKindForSession({ hasPr: false, hasSpec: false }), 'unknown_state');
  assert.equal(backfillKindForSession({}), 'unknown_state');
  assert.equal(backfillKindForSession(), 'unknown_state');
});
