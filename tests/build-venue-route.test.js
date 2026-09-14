// chat_sessions.build_venue — the session's chosen build venue (#1281).
//
// #1086 introduced the six-venue vocabulary and said, correctly for that
// change, that a venue id is a PRESENTATION key that never travels to the
// server: every venue was already expressible through a column that
// existed. #1281 breaks that tie, because it needs a state none of those
// columns can express — a session whose owner has DECIDED to build it
// somewhere else and has not done it yet. `external_agent` is stamped at
// submission, so it is null for exactly the period the launchpad is on
// screen, and deriving from it reverts a hand-off session to
// "Homeroom · Claude" on the next reload, taking its launchpad with it.
//
// So one column stores a venue id verbatim, and the id list now has THREE
// copies that must agree:
//
//   1. VENUES in public/js/build-venues.js — the authoritative list
//   2. BUILD_VENUES in src/routes/sessions.js — the route's domain
//   3. the CHECK on chat_sessions.build_venue in src/db/schema.sql
//
// A venue that lands in one but not the others is a row the browser offers
// and the server rejects, or worse, one the server accepts and no client
// can render. That agreement is the first thing this file pins; the rest
// covers the precedence rule that makes the stored value safe to trust,
// and the route's own guards.
//
// Run with: node --test tests/build-venue-route.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BuildVenues = require('../public/js/build-venues.js');
const { BUILD_VENUES } = require('../src/routes/sessions');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SCHEMA = read('src/db/schema.sql');
const SESSIONS_SRC = read('src/routes/sessions.js');
const DEV_CHAT_SRC = read('frontend/src/features/dev-chat/dev-chat.js');

// ── 1. The three copies ─────────────────────────────────────────────────

test('the route domain is exactly the browser list', () => {
  assert.deepEqual(
    [...BUILD_VENUES].sort(),
    BuildVenues.VENUES.map((v) => v.id).sort(),
    'BUILD_VENUES in src/routes/sessions.js must match VENUES in build-venues.js',
  );
});

test('the CHECK constraint carries the same six ids', () => {
  const check = SCHEMA.match(/chat_sessions_build_venue_chk[\s\S]{0,600}?\)\);/);
  assert.ok(check, 'the constraint must exist — it is the last line of defence');
  const inCheck = [...check[0].matchAll(/'([a-z-]+)'/g)].map((m) => m[1])
    .filter((id) => id !== 'chat_sessions_build_venue_chk');
  assert.deepEqual([...inCheck].sort(), [...BUILD_VENUES].sort());
  // NULL has to stay legal: it is what "nobody has chosen" means, and it is
  // the state every pre-#1281 row is in, which is why there is no backfill.
  assert.match(check[0], /build_venue IS NULL/);
});

test('the column is nullable and needs no backfill', () => {
  assert.match(
    SCHEMA,
    /ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS build_venue TEXT;/,
    'idempotent add, no NOT NULL, no DEFAULT — see the platform schema rule',
  );
  assert.doesNotMatch(
    SCHEMA,
    /UPDATE chat_sessions[\s\S]{0,200}SET build_venue/,
    'a backfill would spend a write per session to store what the derivation '
    + 'already produces correctly',
  );
});

// ── 2. Precedence: what the stored value may and may not override ───────

test('a stored venue outranks the derived ones but not the structural facts', () => {
  const at = (state) => BuildVenues.currentVenue(state);

  // The whole point: a hand-off chosen but not yet submitted.
  assert.equal(at({ buildVenue: 'web-claude-code' }), 'web-claude-code');
  assert.equal(at({ buildVenue: 'web-codex' }), 'web-codex');
  assert.equal(at({ buildVenue: 'own-tools-pr' }), 'own-tools-pr');

  // It beats the columns it exists to speak over.
  assert.equal(
    at({ buildVenue: 'web-codex', agentBackend: 'codex_openrouter' }),
    'web-codex',
    'the stored choice wins over the backend the session was created with',
  );

  // An imported proposal has no Homeroom chat and never will — structural,
  // so nothing overrides it.
  assert.equal(at({ buildVenue: 'usernode-claude', source: 'imported' }), 'own-tools-pr');
  // A live lease describes what IS happening, which outranks a preference
  // about what should.
  assert.equal(at({ buildVenue: 'web-codex', localAgent: { leaseId: 1 } }), 'local');
});

test('an unrecognised stored value degrades to the derivation, never to itself', () => {
  // The column has a CHECK, but a row written by an older or newer
  // deployment must not paint a venue this build has never heard of.
  for (const bogus of ['web-gemini', 'nonsense', '', 'constructor', '__proto__', 'toString']) {
    assert.equal(
      BuildVenues.currentVenue({ buildVenue: bogus, agentBackend: 'codex_openrouter' }),
      'usernode-openrouter',
      `${bogus} must fall through to the derived venue`,
    );
  }
  // And with nothing to derive from, the default — not a crash.
  assert.equal(BuildVenues.currentVenue({ buildVenue: 'toString' }), 'usernode-claude');
});

// ── 3. The route's guards ───────────────────────────────────────────────

const ROUTE = SESSIONS_SRC.match(
  /router\.post\('\/api\/sessions\/:id\/build-venue'[\s\S]*?\n  \}\);/,
);

test('the route exists and validates against the shared domain', () => {
  assert.ok(ROUTE, 'POST /api/sessions/:id/build-venue must be mounted');
  const body = ROUTE[0];
  assert.match(body, /BUILD_VENUES\.includes\(venue\)/,
    'the allowlist is the shared constant, not a retyped literal');
  assert.match(body, /venue !== null/, 'clearing back to the derivation stays legal');
  assert.match(body, /status\(400\)/, 'an unknown venue is refused before the write');
});

test('the write is owner-scoped and refuses a closed session', () => {
  const body = ROUTE[0];
  assert.match(body, /UPDATE chat_sessions/);
  assert.match(body, /WHERE id = \$1 AND user_id = \$2/,
    'a session is only ever retargeted by its owner');
  assert.match(body, /status NOT IN \('archived', 'merged'\)/,
    'an archived or merged session is frozen');
  assert.match(body, /status\(404\)/,
    'not-yours and closed collapse to the same answer, so neither leaks the other');
  assert.match(body, /RETURNING \*/, 'the caller folds the new value back in');
});

test('switching the agent backend does NOT go through this route', () => {
  // reset-agent-context throws away the agent thread and evicts the warm
  // worker, by design. Choosing to build somewhere else must do neither —
  // the transcript, the branch and the proposal all stay as they are, which
  // is exactly what the venue sheet promises when it says an in-chat venue
  // "keeps this chat, this branch and this proposal".
  const body = ROUTE[0];
  assert.doesNotMatch(body, /agent_thread_id|agent_config_version|evictWorker/);
});

// ── 4. The client half of the contract ──────────────────────────────────

test('the browser stores a hand-off and CLEARS on the way back in-chat', () => {
  // Storing an in-chat venue would be a second, staler answer to a question
  // agent_backend already answers — and would mask a later switch made from
  // anywhere else.
  // #1348: the in-chat answer is the coarse On-Platform row, and its
  // `venue` is null because the SERVER resolves which of the two backends
  // it means. That null is the branch, and it still clears the column.
  assert.match(
    DEV_CHAT_SRC,
    /row\.venue === null[\s\S]{0,900}_persistBuildVenue\(null\)/,
    'coming back in-chat clears the stored venue',
  );
  assert.match(
    DEV_CHAT_SRC,
    /row\.venue === null[\s\S]{0,2000}_switchToLastUsedPlatformAgent\(\)/,
    'and switches to the backend the user ran last, resolved server-side',
  );
  for (const kind of ['flow', 'import']) {
    assert.match(
      DEV_CHAT_SRC,
      new RegExp(`pick\\.kind === '${kind}'[\\s\\S]{0,900}_persistBuildVenue\\(pick\\.venue\\)`),
      `picking a ${kind} venue stores it`,
    );
  }
});

test('a venue pick that works is silent — in all four states (#1348 follow-up)', () => {
  // Three of the four rows changed the session without a word, because the
  // screen is the announcement: the composer swaps for a launchpad or back,
  // and the header dropdown names the venue. On-Platform alone popped
  // "This session now uses Homeroom · Claude." over that, so the same act
  // reported itself in one state out of four.
  const onPick = DEV_CHAT_SRC.match(/onPick: \(row\) => \{[\s\S]*?\n      \},\n      onUnavailable/);
  assert.ok(onPick, 'the sheet must have a pick handler');
  assert.doesNotMatch(onPick[0], /PlatformUI\.toast/,
    'no branch of the pick announces itself');

  const fn = DEV_CHAT_SRC.match(/async _switchToLastUsedPlatformAgent\(\)[\s\S]*?\n {2}\},/);
  assert.ok(fn, '_switchToLastUsedPlatformAgent must exist');
  assert.doesNotMatch(fn[0], /toast\(`This session now uses/,
    'nor does the switch it dispatches');

  // A FAILURE still speaks, in both directions, because a switch that did
  // not happen changes nothing on screen — there is no other signal.
  assert.match(fn[0], /toast\(data\.error \|\| 'Could not switch to the platform agent\.'\)/);
  assert.match(fn[0], /toast\('Network error while switching coding agents\.'\)/);
  // As does a row the sheet is refusing.
  assert.match(DEV_CHAT_SRC, /onUnavailable: \(row\) => PlatformUI\.toast\(row\.reason\)/);
  // And the two things that DO report the outcome are still wired: the
  // reset's own transcript message, and the fallback sentence for a stored
  // preference that no longer validates.
  assert.match(fn[0], /if \(data\.message\) DevChat\.messages\.push\(data\.message\)/);
  assert.match(fn[0], /DevChat\._venueFallbackReason = data\.agentFallbackReason/);
});

test('a failed store is swallowed, because the repaint already happened', () => {
  const fn = DEV_CHAT_SRC.match(/async _persistBuildVenue\([\s\S]*?\n  \},/);
  assert.ok(fn, '_persistBuildVenue must exist');
  assert.match(fn[0], /catch/, 'a lost choice degrades to the derivation, not to an error');
  // Only the venue column is folded back in: the response is the whole row,
  // and a session the user has been typing into must not have its live
  // fields replaced by a snapshot taken before the last keystroke.
  assert.match(fn[0], /build_venue = data\.session\.build_venue/);
  assert.doesNotMatch(fn[0], /Object\.assign\(DevChat\.currentSession/);
});

test('the stored venue is what brings the launchpad back after a reload', () => {
  // _devFlow.mode is in-memory and goes with the tab. If the surface were
  // derived from that alone, reopening a hand-off session would show a
  // composer for a venue that never runs a turn here.
  //
  // Since #1353 there is ONE derivation to check rather than two: the
  // walkthrough, the launchpad and the header dropdown all resolve through
  // _currentVenueId(), which is where the column is read. That collapse is
  // the fix — see tests/venue-surface-sync.test.js — so the assertion
  // follows it rather than pinning a second reader that must not exist.
  assert.match(
    DEV_CHAT_SRC,
    /buildVenue: s\.build_venue/,
    'the venue the whole chat view paints from reads the stored column',
  );
  const target = DEV_CHAT_SRC.match(/_devFlowTarget\(\) \{[\s\S]*?\n  \},/);
  assert.ok(target, '_devFlowTarget must exist');
  assert.match(target[0], /DevChat\._currentVenueId\(\)/,
    'and the walkthrough asks that one derivation, not the columns again');
  const launchpad = DEV_CHAT_SRC.match(/_launchpadVenue\(\) \{[\s\S]*?\n  \},/);
  assert.ok(launchpad, '_launchpadVenue must exist');
  assert.match(launchpad[0], /DevChat\._currentVenueId\(\)/);
  assert.doesNotMatch(launchpad[0], /_devFlowTarget/,
    'a second source here is exactly what let the screen and the header '
      + 'disagree about the same session',
  );
});

// ── #1348: picking On-Platform actually returns to the chat ─────────
//
// It did not. Two independent requests run on that pick — POST
// /build-venue clearing the column, and POST /reset-agent-context
// switching the backend — and the repaint hangs off the SECOND one. So
// the column was still 'own-tools-pr' (or a web venue) when the render
// asked, _launchpadVenue() answered it, and the launchpad stayed on screen
// after the user had chosen to leave it.

test('picking On-Platform clears the venue locally, before anything repaints', () => {
  // _persistBuildVenue only folds the column back in when its response
  // lands, and nothing repaints when it does — so the local write is what
  // the render actually reads.
  const branch = DEV_CHAT_SRC.match(/if \(row\.venue === null\) \{[\s\S]*?\n {8}\}/);
  assert.ok(branch, 'the On-Platform branch must exist');
  const local = branch[0].indexOf('DevChat.currentSession.build_venue = null');
  const persist = branch[0].indexOf('_persistBuildVenue(null)');
  assert.ok(local > -1, 'the venue must be cleared on the local session object');
  assert.ok(persist > -1, 'and still persisted');
  assert.ok(local < persist, 'locally FIRST — the repaint does not wait for the round trip');
});

test('the switch response cannot put the venue it is leaving back', () => {
  // reset-agent-context answers with a whole session row read on the
  // server. The venue clear is in flight on another route, so that row can
  // still carry the launchpad venue — and assigning it wholesale would put
  // the launchpad back a moment after the pick removed it.
  const fn = DEV_CHAT_SRC.match(/async _switchToLastUsedPlatformAgent\(\)[\s\S]*?\n {2}\},/);
  assert.ok(fn, '_switchToLastUsedPlatformAgent must exist');
  assert.match(fn[0], /const \{ build_venue: \w+, \.\.\.agentFields \} = data\.session \|\| \{\}/,
    'build_venue must be split off the response');
  assert.doesNotMatch(fn[0], /Object\.assign\(DevChat\.currentSession, data\.session/,
    'the whole row must never be assigned');
  assert.doesNotMatch(fn[0], /Object\.assign\(cached, data\.session/,
    'nor onto the cached copy, which the session list renders from');
  assert.equal((fn[0].match(/Object\.assign\([^)]*agentFields\)/g) || []).length, 2,
    'both the live session and the cached one take the agent columns');
});
