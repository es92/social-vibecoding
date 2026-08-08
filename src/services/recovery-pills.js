'use strict';

// Quick-reply pill policy (#786 restart recovery, #894 per-turn fallback).
//
// Background: the dev-chat pill bar above the composer renders from the
// newest message that carries metadata.quickReplies. Those pills are
// produced by the Mayor's suggest_replies tool — and on a dispatch turn
// they come ONLY from the phase-2 post-build wrap-up (resolveQuickReplies
// in routes/sessions.js deliberately drops a phase-1 call when a dispatch
// co-occurs). A platform restart mid-turn recovers the coding work but
// never re-runs that wrap-up, so the turn ends with recovery breadcrumbs
// (role 'system') and no pills anywhere: the bar goes empty and stays
// empty until the user types something themselves.
//
// #894 widened the same hole to ORDINARY turns: suggest_replies is an
// optional tool and production Mayor turns frequently skip it (a chat
// reply with `toolUses: 0`, a wrap-up that ends `end_turn`), and several
// turn-end paths — worker-busy, stop-during-run, refusal, turn error —
// never reach a pill-bearing persist at all. So this module now also
// holds the per-turn fallback policy the chat handler applies whenever a
// turn would otherwise end with no pills anywhere.
//
// This module holds the deterministic replacement — no LLM call on the
// boot path (no request context, no user key selection, no billing
// attribution; see the resumeDetachedTurnInner comment about phase-2
// narration deliberately not being resumed). Same precedent as the static
// buildHeadlessFollowUpQuickReplies sets in routes/sessions.js.
//
// Pure by design (no docker, no pg) so the policy is unit-testable —
// same pattern as turn-watchdog.js. It deliberately does NOT require
// routes/sessions.js for sanitizeQuickReplies (that would be a
// services → routes cycle); instead every set below already satisfies
// the sanitizer's contract (<= 3 entries, <= 80 chars, no dupes) and
// tests assert that by round-tripping through it.

// Mirror of QR_MAX_REPLIES / QR_MAX_REPLY_LEN in routes/sessions.js.
const QR_MAX_REPLIES = 3;
const QR_MAX_REPLY_LEN = 80;

// Pills per recovery kind. Wording is first-person and sendable because
// tapping a pill PREFILLS the composer (it never triggers an action).
//
//   code_done      — a build turn was recovered: commit pushed, PR opened,
//                    staging rebuilt. Mirrors the 'code' set in
//                    buildHeadlessFollowUpQuickReplies.
//   spec_done      — a scout turn was recovered and left a spec.
//   push_failed    — the recovered build committed but the push failed.
//   unrecoverable  — the turn could not be resumed at all (worker gone,
//                    journal unreadable, watchdog reap).
//   unanswered     — the Mayor turn died before persisting any reply; the
//                    user's own message is prepended as a resend pill by
//                    buildRecoveryQuickReplies.
//   unknown_state  — backfill fallback when the session's state doesn't
//                    identify a PR or a spec.
//
// #894 per-turn fallback kinds (see fallbackKindForTurn):
//
//   chat_generic   — a plain chat reply in a session with neither a spec
//                    nor a PR yet: nothing has happened to follow up on,
//                    so offer the ways in.
//   build_running  — the user sent a message while a worker was already
//                    busy; the only useful next messages are about the
//                    run in flight.
//   turn_failed    — the turn ended badly (dispatch error, user stop,
//                    model refusal, provider error). Same wording as
//                    push_failed, kept as its own key so the recovery
//                    caller's semantics stay readable at the call site.
const RECOVERY_PILLS = Object.freeze({
  code_done: Object.freeze(['Propose it to the group', 'Make a tweak', 'What did it change?']),
  // #1046: the build pill says "Build the spec", not "Build it" — the
  // whole plan gets built, and the wording has to say so. Same string the
  // model is told to use, so the row reads identically whichever rung
  // filled it.
  spec_done: Object.freeze(['Build the spec', 'Revise the spec', 'What will this change?']),
  push_failed: Object.freeze(['Try that again', 'What went wrong?']),
  unrecoverable: Object.freeze(['Try that again', "What's the current state?"]),
  unanswered: Object.freeze(["What's the current state?"]),
  unknown_state: Object.freeze(["What's the current state?", 'Make a change']),
  chat_generic: Object.freeze(['Make a change', 'What issues are open right now?', "What's the current state?"]),
  build_running: Object.freeze(["How's it going?", 'Stop this build']),
  turn_failed: Object.freeze(['Try that again', 'What went wrong?']),
});

// #1001 — the ONE source of truth for how a good pill set is composed.
//
// Interpolated verbatim into all FOUR surfaces that ask a model for
// pills, so they cannot drift apart:
//   1. the Mayor system prompt's SUGGESTED QUICK REPLIES block
//      (getMayorSystemPrompt in routes/sessions.js);
//   2. SUGGEST_REPLIES_TOOL.description (a tool description IS prompt);
//   3. the forced pills-only enforcement call (llm.requireQuickReplies);
//   4. the Haiku contextual backstop (llm.generateQuickReplies).
//
// Why this text reads the way it does: production measurement on 30 days
// of live sessions found HALF of all rendered pill sets were byte-identical
// to the illustrative examples the old prompt listed ("Preview the change" /
// "Propose it to the group" / "Make another tweak" alone accounted for 101
// sessions). Teaching by literal example taught literal copying. So this
// constant states the COMPOSITION RULE and names the copied strings as
// forbidden output rather than offering a triple to imitate.
//
// #1046 — the ONE deliberate exception to "these are shapes, not strings".
// The composition rule, read literally, told the model to name a concrete
// subject in EVERY pill including the build one, and production shows it
// obeying: "Build the collapsible left sidebar", "Build the seasons API
// and CRUD", "Build the shared _showExplorePill predicate as specced".
// Each of those specs covered far more than the component named, so the
// pill reads as "build only that part" for a tap that builds the whole
// plan. The POST-SPEC BUILD PILL is therefore pinned to a literal string
// ("Build the spec") and occupies the one generic slot the rule already
// allows — the arithmetic is unchanged, only which pill fills the slot on
// a post-spec turn. The other 1-2 pills must still be specific, so the
// anti-parroting pressure stays exactly where it was.
//
// Lives here (a pure, dependency-free service) rather than in the route so
// both llm.js and routes/sessions.js can read it without a services→routes
// cycle.
const QUICK_REPLY_RULES_TEXT = `Each pill must be a complete first-person message the user could send verbatim, under 80 characters. 2-3 of them, most likely first.

COMPOSITION RULE — at most ONE pill may be a generic platform action ("Propose it to the group", "Build the spec", "Preview the change"). EVERY other pill must name the concrete subject of THIS turn: the feature, screen, component, issue number, or the specific thing just built, planned or discussed. A set where every pill would fit any conversation is a failed set.
Good, because they name the subject: after a build that made a leaderboard default to Season 1 — "Preview the Season 1 default" / "Propose it to the group" / "Also fix the sub-event tabs". Note only the middle one is generic.
These are shapes, not strings — never send these words verbatim.

POST-SPEC BUILD PILL — the ONE exception to that, and the one place a literal string is required. When this turn just drafted or revised a spec and nothing has been built from it yet, the FIRST pill must refer to the WHOLE spec: write it as Build the spec (or exactly that meaning in the conversation's language). Do NOT name a single component, screen, file or feature as the build target — a pill like "Build the sidebar" or "Build the avatar flow as specced" reads as "build only that part", when the tap builds everything the spec describes. This pill IS the set's one generic slot, so the remaining 1-2 pills must still name something specific about THIS spec. A pill may additionally offer a NARROWER build, but only if it says so out loud ("Build only the read-only slice first", "Build slice 1 only — the retry path"); it is an extra option, never a replacement for the whole-spec pill.

NEVER emit any of these exact sets, or a set made only of these phrases: "Preview the change" / "Propose it to the group" / "Make another tweak"; "Build the spec" / "Revise the spec" / "What will this change?"; "Build it" / "Revise the spec" / "What will this change?"; "Propose it to the group" / "Make a tweak" / "What did it change?"; "Make a change" / "What issues are open right now?" / "What's the current state?"; "Try that again" / "What went wrong?". That ban is on the whole SET, not on the required build pill — "Build the spec" is meant to be sent verbatim; what is forbidden is a set in which NOTHING is specific to this conversation.
If you cannot make a pill specific, emit TWO pills instead of three — a short specific set beats a padded generic one.
Write the pills in the SAME LANGUAGE the conversation is in, not always English.`;

// The breadcrumb text for a Mayor turn that died before it could persist
// any reply. Exported so the backfill sweep and its tests agree on the
// exact string (the sweep also uses it to detect its own prior row).
//
// #896: the wording no longer names the restart. A restart is platform
// plumbing the user can do nothing about; what matters to them is that
// the message needs resending. The restart itself stays in the logs and
// in metadata.recovered on the row.
const UNANSWERED_BREADCRUMB =
  "I didn't get to reply to that — send your message again.";

// Earlier wordings of UNANSWERED_BREADCRUMB. The backfill sweep's
// idempotence check compares the session's newest system row against the
// breadcrumb it would post; without the historical strings a boot after
// this rename would post a second breadcrumb on top of a pre-rename one.
const LEGACY_UNANSWERED_BREADCRUMBS = Object.freeze([
  'The platform restarted before I could reply — send your message again.',
]);

// True when `content` is this breadcrumb under its current OR any earlier
// wording — the sweep's "did I already post this?" test.
function isUnansweredBreadcrumb(content) {
  if (typeof content !== 'string') return false;
  return content === UNANSWERED_BREADCRUMB
    || LEGACY_UNANSWERED_BREADCRUMBS.includes(content);
}

// The breadcrumb text for a recovered scout turn whose journal replay
// produced no spec text (previously emit-only, so it vanished on reload).
const SCOUT_NO_SPEC_BREADCRUMB =
  "The scout didn't produce a spec — please send your request again.";

// The breadcrumb text for a coding turn that could not be resumed at all.
// One string for every unresumable shape (worker gone, journal unreadable,
// mid-exec kill, watchdog reap) — the shapes differ only to an operator,
// and metadata.recoveredReason keeps them apart in SQL.
const TURN_UNFINISHED_BREADCRUMB =
  "That coding turn didn't finish — please send your request again.";

// The breadcrumb for a turn that couldn't be resumed BUT whose code
// already landed: the agent committed and the branch is on GitHub, only
// the platform-side wrap-up (preview, cards) was lost. Asking for a
// resend here — which TURN_UNFINISHED_BREADCRUMB does — tells the user to
// redo work that is already safely pushed, and invites a duplicate run
// (session 2954's "continue" cost a full second build turn that produced
// no new commit). So this wording reports what landed and what is being
// repaired instead.
//
// `prNumber` is optional: a tail can die after the push but before the PR
// exists, and naming a PR that isn't there would be worse than vague.
// Per #896 the platform restart itself stays out of the wording — the
// user can't act on it — and lives in metadata.recovered / the logs.
function buildCodeLandedBreadcrumb({ prNumber = null, rebuildingPreview = true } = {}) {
  const where = prNumber ? `pushed to PR #${prNumber}` : 'pushed to your branch';
  return rebuildingPreview
    ? `Your changes are committed and ${where} — rebuilding the preview now.`
    : `Your changes are committed and ${where}.`;
}

// Every wording buildCodeLandedBreadcrumb can produce, as a matcher —
// the boot backfill's "did I already post this?" test needs to recognise
// its own row, and it has no access to the prNumber that shaped it.
function isCodeLandedBreadcrumb(content) {
  if (typeof content !== 'string') return false;
  return /^Your changes are committed and pushed to (PR #\d+|your branch)( — rebuilding the preview now)?\.$/
    .test(content);
}

// Build the pill list for one recovery kind.
//
//   kind — a RECOVERY_PILLS key.
//   ctx  — { lastUserText } for the 'unanswered' kind: the text of the
//          user message that never got a reply. Prepended verbatim as a
//          resend pill ONLY when it fits a pill (<= QR_MAX_REPLY_LEN
//          after trimming) — a clipped message would be a misleading
//          thing to hand back for one-tap resending.
//
// Returns a fresh mutable array, or null for an unknown kind (callers
// skip persistence on null, degrading to today's "no pills").
function buildRecoveryQuickReplies(kind, ctx = {}) {
  const base = RECOVERY_PILLS[kind];
  if (!base) return null;
  const out = [];
  if (kind === 'unanswered') {
    const raw = ctx && typeof ctx.lastUserText === 'string' ? ctx.lastUserText.trim() : '';
    if (raw && raw.length <= QR_MAX_REPLY_LEN) out.push(raw);
  }
  for (const pill of base) {
    if (out.length >= QR_MAX_REPLIES) break;
    // Case-insensitive dedupe against the resend pill, mirroring
    // sanitizeQuickReplies so the result is already sanitizer-clean.
    if (out.some((p) => p.toLowerCase() === pill.toLowerCase())) continue;
    out.push(pill);
  }
  return out.length ? out : null;
}

// Decide what the boot-time backfill sweep should do for one session,
// given the newest message row whose role is 'user' or 'assistant'
// (system breadcrumbs are transparent to the client's pill resolution,
// so they are not the deciding row).
//
//   lastRow — { role, metadata } or null (session with no such row).
//
// Returns:
//   'skip'                   — nothing to repair.
//   'attach_assistant'       — attach derived pills to that assistant row.
//   'breadcrumb_unanswered'  — the turn died before replying; post the
//                              breadcrumb + resend pills.
//
// #1001 interaction — a DISPATCH PREAMBLE row now carries the Mayor's own
// pills (routes/sessions.js persists them and lets the newer phase-2 row
// supersede them by recency), so a turn that died mid-dispatch reaches this
// sweep with a pill-bearing assistant row and gets 'skip' where it used to
// get 'attach_assistant'. That is CORRECT, not a regression: server.js's
// recovery paths post their breadcrumbs as NEWER `system` rows that carry
// their own pills, and the client's backward scan finds those first. Don't
// "fix" this by ignoring preamble pills here — it would replace a
// conversation-specific set with a state-derived one.
function classifyMissingPills({ lastRow } = {}) {
  if (!lastRow || !lastRow.role) return 'skip';
  const meta = lastRow.metadata || {};
  const pills = meta.quickReplies;
  if (Array.isArray(pills) && pills.length) return 'skip';
  if (lastRow.role === 'assistant') {
    // The #32 inline answer chips take precedence over the above-box
    // pills — same rule resolveQuickReplies enforces server-side.
    if (Array.isArray(meta.suggestions) && meta.suggestions.length) return 'skip';
    return 'attach_assistant';
  }
  if (lastRow.role === 'user') return 'breadcrumb_unanswered';
  return 'skip';
}

// Which pill set a backfilled assistant row should get, from the
// session's own state: a PR means the build landed, otherwise a spec
// means scout work landed, otherwise we don't know what happened.
function backfillKindForSession({ hasPr, hasSpec } = {}) {
  if (hasPr) return 'code_done';
  if (hasSpec) return 'spec_done';
  return 'unknown_state';
}

// #894: which pill set a LIVE turn should fall back to when the Mayor
// didn't emit suggest_replies (or the turn ended on a path that never
// reaches a model wrap-up at all).
//
//   outcome — how the turn ended:
//     'chat'        — a plain reply, no dispatch (phase-1 persist).
//     'build_done'  — a dispatch_claude_code wrap-up (phase-2 persist).
//     'spec_done'   — a dispatch_scout wrap-up (phase-2 persist).
//     'failed'      — the dispatched tool reported an error, the model
//                     refused, or the turn threw.
//     'stopped'     — the user stopped the run mid-flight.
//     'worker_busy' — the message arrived while a worker was running.
//   hasPr / hasSpec — session state, used only for the 'chat' outcome
//                     (the dispatch outcomes already know what landed).
//
// Returns a RECOVERY_PILLS key; unknown outcomes degrade to the same
// state-derived choice the boot backfill makes.
function fallbackKindForTurn({ outcome, hasPr, hasSpec } = {}) {
  switch (outcome) {
    case 'build_done': return 'code_done';
    case 'spec_done': return 'spec_done';
    case 'failed':
    case 'stopped': return 'turn_failed';
    case 'worker_busy': return 'build_running';
    case 'chat':
      if (hasPr) return 'code_done';
      if (hasSpec) return 'spec_done';
      return 'chat_generic';
    default:
      return backfillKindForSession({ hasPr, hasSpec });
  }
}

// Convenience wrapper for the chat handler: resolve the kind AND
// materialise the pills in one call, so every turn-end site is a
// one-liner. Returns a fresh array (never null for a known outcome —
// every set above is non-empty).
function turnFallbackQuickReplies(ctx = {}) {
  return buildRecoveryQuickReplies(fallbackKindForTurn(ctx));
}

// ── #1001 genericness detection ──────────────────────────────────────
//
// Normalise a pill for comparison: lowercase, collapse whitespace, drop
// trailing sentence punctuation. "What's the current state?" and
// "what's the current state" must compare equal, because a model that
// re-punctuates the boilerplate has still emitted boilerplate.
function normalizePill(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?.!,;:]+$/, '')
    .trim();
}

// Every phrase that carries no information about the conversation.
//
// Deliberately a SUPERSET of the platform's own static wording — every
// string in RECOVERY_PILLS above, every client STARTER_QUICK_REPLIES
// entry (public/js/dev-chat.js), every FORK_FOLLOWUP_REPLIES entry
// (services/transcript-share.js) — plus the phrasings production showed
// the model parroting out of the old prompt examples. Those two client/
// service lists cannot be required from here (one is browser code, and
// keeping this module dependency-free is the point), so
// tests/quick-reply-fallback.test.js asserts the superset property
// instead: adding a static pill anywhere without adding it here fails.
//
// This is a HEURISTIC, not a truth: "Propose it to the group" really is
// the right first pill after a build. That is exactly why
// isGenericPillSet below only rejects a set where NOTHING is specific.
const BANNED_GENERIC_PILLS = Object.freeze(new Set([
  // RECOVERY_PILLS, every kind.
  'propose it to the group', 'make a tweak', 'what did it change',
  'build the spec', 'revise the spec', 'what will this change',
  'try that again', 'what went wrong',
  "what's the current state", 'make a change',
  "how's it going", 'stop this build',
  // Client STARTER_QUICK_REPLIES.
  'what issues are open right now', 'change the colors',
  'add a new feature', "fix something that's broken",
  // FORK_FOLLOWUP_REPLIES.
  'explain where this got to', 'continue this work',
  'take it a different way',
  // Parroted out of the pre-#1001 prompt examples, observed in production.
  'preview the change', 'make another tweak', 'preview the staging build',
  'make another adjustment', 'what will this change do',
  'what happens next', 'make a change to the app',
  // #1046: 'build it' is no longer shipped anywhere (spec_done now says
  // "Build the spec"), but it stays here — the model still parrots it out
  // of transcript history, and this list is a detection heuristic, not an
  // inventory. The near-variants keep three rephrasings of the required
  // build pill from passing as a "specific" set.
  'build it', 'build the whole spec', 'build the spec as written',
].map(normalizePill)));

// True when a pill set is entirely boilerplate — i.e. NOT ONE entry names
// anything about this conversation. A mixed set (one generic action plus
// at least one specific pill) passes: that is the shape the composition
// rule in QUICK_REPLY_RULES_TEXT actually asks for.
//
// An empty/absent set is NOT "generic" — it is "missing", which callers
// already handle as its own case.
function isGenericPillSet(replies) {
  if (!Array.isArray(replies) || !replies.length) return false;
  return replies.every((r) => BANNED_GENERIC_PILLS.has(normalizePill(r)));
}

module.exports = {
  QR_MAX_REPLIES,
  QR_MAX_REPLY_LEN,
  RECOVERY_PILLS,
  QUICK_REPLY_RULES_TEXT,
  BANNED_GENERIC_PILLS,
  normalizePill,
  isGenericPillSet,
  UNANSWERED_BREADCRUMB,
  LEGACY_UNANSWERED_BREADCRUMBS,
  isUnansweredBreadcrumb,
  SCOUT_NO_SPEC_BREADCRUMB,
  TURN_UNFINISHED_BREADCRUMB,
  buildCodeLandedBreadcrumb,
  isCodeLandedBreadcrumb,
  buildRecoveryQuickReplies,
  classifyMissingPills,
  backfillKindForSession,
  fallbackKindForTurn,
  turnFallbackQuickReplies,
};
