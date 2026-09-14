'use strict';

// Where the venue answer is SHOWN.
//
// tests/build-venues.test.js pins the list and its gating; this file pins
// the three surfaces that put the answer in front of somebody:
//
//   1. the dropdown at the top right of the session header (#1348), which
//      states the venue on first paint and carries the only control that
//      changes it;
//   2. the chip on a session card in the dev feed, so the answer is
//      readable from the list without opening the chat;
//   3. the fallback note, for the one case where the venue you got is not
//      the venue you asked for.
//
// The failure this guards is not "the wrong label rendered" — it is the
// pre-#1086 state, where nothing rendered at all. A session's venue was
// decided by resolveDefaultAgentPreference on the server, silently, and
// the only way to find out what had been chosen was to read the billing
// note under a dropdown that was about something else. So most assertions
// here are about PRESENCE and about the paths that must not be able to
// swallow it.
//
// Run with: node --test tests/venue-surfaces.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const DEV_CHAT_SRC = read('frontend/src/features/dev-chat/dev-chat.js');
// #1348's button is JSX since the session header converted — see the note at
// the first test below.
const HEADER_TSX = read('frontend/src/features/dev-chat/session-header.tsx');
const APP_VIEW_SRC = read('public/js/app-view.js');
const SESSIONS_SRC = read('src/routes/sessions.js');
const APP_CSS = read('public/css/app.css');

// Same loader as tests/venue-labels.test.js: a classic script against a
// bare `window`, which is the realm this module actually runs in.
function loadBuildVenues() {
  const sandbox = { window: {}, module: { exports: {} }, document: undefined };
  sandbox.self = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/build-venues.js'), sandbox, {
    filename: 'public/js/build-venues.js',
  });
  return sandbox.window.BuildVenues || sandbox.module.exports;
}

const BV = loadBuildVenues();

// ── 1. The dropdown in the session header ────────────────────────────

// The button was `BuildVenues.selectorHtml`'s string until the session header
// converted; it is JSX in features/dev-chat/session-header.tsx now, built from
// the `venue()` spec that builder read. What has to hold is unchanged, so the
// assertions moved rather than went: the venue LOOKUP is still this module's
// and is asserted here, and the markup it produces is asserted against the
// component in tests/dev-session-header.test.js.

test('every venue resolves to a control this module can name', () => {
  // Every venue must produce a control. A venue that resolved to nothing
  // would put the session back exactly where it was before #1086: no
  // statement, and no door to the sheet either, since the change button IS
  // the statement.
  for (const v of BV.VENUES) {
    const spec = BV.venue(v.id);
    assert.ok(spec, `${v.id} resolves`);
    assert.equal(spec.id, v.id);
    assert.ok(spec.label, `${v.id} names itself`);
    assert.ok(spec.blurb, `${v.id} explains itself, which is the button's tooltip`);
  }
});

test('an unknown venue id resolves to nothing rather than a half sentence', () => {
  // `current` is derived from session columns, which are server data. A
  // value this list does not know about must not produce an empty chip.
  assert.equal(BV.venue('nonsense'), null);
  assert.equal(BV.venue('constructor'), null,
    'including the prototype-chain members a bare lookup would answer');
  // …and the component draws nothing for a null spec.
  assert.match(HEADER_TSX, /s\.venue \? <VenueSelect/);
});

test('the selector is painted in the session header, top right (#1348)', () => {
  // Not in the composer's bottom bar, where it was one caption among the
  // meter, the runner and the budget menu — the arrangement that made the
  // venue invisible. And after the status pill, so it lands on the right.
  const VIEW_TSX = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'view.tsx'), 'utf8');
  const header = VIEW_TSX.indexOf('id="dc-session-header"');
  const body = VIEW_TSX.indexOf('className="dc-session-body');
  assert.ok(header !== -1, 'the session header row is addressable');
  assert.ok(header < body, 'and it opens before the chat body does');
  // The strip's ORDER is the component's. The venue button was its last
  // child until the doing<->seeing switch came down from the platform
  // header — that switch is the strip's right edge now, and the venue sits
  // immediately before it, so both still land right of the change's name.
  // (The lifecycle pill moved up into the platform header with the
  // Streamlined Concept; the strip's own state word is #dc-mode-chip, which
  // is the switch's active segment.)
  const select = HEADER_TSX.indexOf('<VenueSelect venue=');
  const sw = HEADER_TSX.indexOf('<ModeSwitch');
  const title = HEADER_TSX.indexOf('{s.title}');
  assert.ok(select !== -1 && sw !== -1, 'both are painted');
  assert.ok(title < select && select < sw,
    'name, then venue, then the switch on the right edge');
  assert.match(HEADER_TSX, /id="dc-mode-chip"/, 'the state word survives, on the switch');
  assert.match(DEV_CHAT_SRC, /BuildVenues\.sessionVenue\(/,
    'resolved through the shared module, not retyped');
});

test('the selector survives the launchpad swap that hides the composer', () => {
  // #1281 hides #dc-composer-controls for the three hand-off venues. A
  // venue control inside it would be hidden by exactly the state it exists
  // to undo, stranding the session in its launchpad.
  // The control is in the HEADER's subtree; the swap is inside the composer,
  // which is a different component in a different file — so "outside the
  // swap" is structural rather than positional.
  const VIEW_TSX = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'view.tsx'), 'utf8');
  assert.match(VIEW_TSX, /id="dc-session-header"/);
  const COMPOSER_TSX = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'composer.tsx'), 'utf8');
  assert.ok(COMPOSER_TSX.includes('id="dc-composer-controls"'), 'the swap is the composer\'s');
  assert.doesNotMatch(COMPOSER_TSX, /dc-venue-select/,
    'and the selector is not inside the thing it exists to undo');
  assert.match(HEADER_TSX, /<VenueSelect/, 'it is in the header strip');
});

test('the selector is painted from the session row, so first paint is right', () => {
  // Not from a status poll: a session whose venue only appeared after a
  // round trip would show the wrong venue for as long as that took, which
  // is precisely the moment someone is deciding whether to type.
  const fn = DEV_CHAT_SRC.slice(
    DEV_CHAT_SRC.indexOf('_currentVenueId() {'),
    DEV_CHAT_SRC.indexOf('\n  },', DEV_CHAT_SRC.indexOf('_currentVenueId() {'))
  );
  assert.ok(fn.length > 0, '_currentVenueId must exist');
  assert.match(fn, /BuildVenues\.currentVenue\(/,
    'the precedence chain lives in one place, not here');
});

test('the change control is disabled mid-turn, in both places that paint it', () => {
  // The old #dc-agent-select carried this guard: switching venue while a
  // turn is streaming would leave the reply arriving from somewhere the
  // line no longer names. Two sites set it — the render and the streaming
  // sync — and a guard on only one of them is a guard that opens itself
  // on the next repaint.
  // The RENDER's site is the model now — `_headerVenue` resolves `disabled`
  // from the same flag, and the component renders it — so the two sites are
  // one derivation and one in-place write rather than two in-place writes.
  assert.match(DEV_CHAT_SRC, /disabled: DevChat\._chatBusyForPaint\(\)/,
    'the render resolves it from the streaming paint seam');
  assert.match(HEADER_TSX, /disabled=\{venue\.disabled\}/,
    'and the component is the only thing that writes it on the render path');
  assert.match(HEADER_TSX, /data-venue-busy=\{venue\.disabled \? '1' : undefined\}/,
    'the disabled state has a stable visible-check hook');
  assert.match(HEADER_TSX, /<LockIcon[\s\S]*Thinking…/,
    'the disabled state explains itself without relying on a mouse cursor');
  const sites = DEV_CHAT_SRC.match(
    /getElementById\('dc-venue-select'\)/g
  ) || [];
  assert.ok(sites.length >= 1,
    `the streaming sync still finds the button by id (got ${sites.length})`);
  assert.match(DEV_CHAT_SRC, /_setStreamingUI[\s\S]*?DevChat\._repaintSessionHeader\(\)/,
    'and the streaming sync republishes the strip rather than writing the '
    + 'attribute React would overwrite on its next paint');
  assert.doesNotMatch(DEV_CHAT_SRC, /venueChange\.disabled/,
    'no second writer on a node the component renders');
});

test('each in-chat provider gets its own model control, and other venues get none', () => {
  // Claude and OpenRouter do not share a selector: the former picks the
  // platform chat model, while an OpenRouter session pins one catalog model
  // to chat and coding. Local / web / imported venues render neither.
  // #1078: each control is a NULLABLE field of the composer's model, which
  // is the same provider split expressed where it can be read as data —
  // and it is what removes the null-guard this test used to look for: an
  // absent control is `null` in the model, not a getElementById that has to
  // be checked before an addEventListener.
  assert.match(DEV_CHAT_SRC, /if \(DevChat\._currentVenueId\(\) !== 'usernode-claude'\) return null;/,
    'the Claude picker is provider-specific');
  assert.match(DEV_CHAT_SRC, /if \(DevChat\._currentVenueId\(\) !== 'usernode-openrouter'\) return null;/,
    'the OpenRouter row is provider-specific');
  const COMPOSER_TSX = fs.readFileSync(
    path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'composer.tsx'), 'utf8');
  assert.match(COMPOSER_TSX, /id="dc-openrouter-model"/,
    'the pinned OpenRouter model is visible');
  assert.match(COMPOSER_TSX, /id="dc-openrouter-model-change"/,
    'the OpenRouter catalog can be reopened directly');
  assert.match(
    DEV_CHAT_SRC,
    /_switchCurrentCodingAgent\(null, \{ fixedBackend: 'codex_openrouter' \}\)/,
    'changing the model keeps the chooser locked to OpenRouter',
  );
});

// ── 2. The chip on a session card ────────────────────────────────────

test('the card chip names the venue and carries the blurb as its title', () => {
  const chip = BV.chipHtml('usernode-openrouter');
  assert.match(chip, /class="dc-venue-chip"/);
  assert.ok(chip.includes('Homeroom · OpenRouter'));
  assert.match(chip, /title="/, 'the blurb is the hover explanation');
  assert.equal(BV.chipHtml('nonsense'), '', 'an unknown id renders no chip');
});

test('an imported proposal gets no chip, because it has no venue to be in', () => {
  // own-tools-pr is the one venue with no chat and no session — the work
  // already happened somewhere Homeroom never saw. A chip saying "Your
  // computer · your own tools" on a card with no session behind it would
  // read as a place you could go.
  // The chip's MARKUP is card/dev-card.tsx's `venue` badge since #1367's
  // card chunk; the resolution — which is what this test is about — is
  // `_sessionVenueChipSpec`.
  const fnStart = APP_VIEW_SRC.indexOf('_sessionVenueChipSpec(s) {');
  assert.ok(fnStart !== -1, '_sessionVenueChipSpec must exist');
  const fn = APP_VIEW_SRC.slice(fnStart, APP_VIEW_SRC.indexOf('\n  },', fnStart));
  assert.match(fn, /s\.source === 'imported'/, 'imported rows are excluded');
  assert.match(fn, /\bBV\.sessionVenue\(/, 'and the rest resolve through the shared chain');
  assert.match(fn, /externalAgent: s\.external_agent/,
    'external_agent travels, or a handed-off session reads as a Homeroom one');
});

test('the session list SELECT carries what the chip needs', () => {
  // A chip derived from `agent_backend` alone cannot tell an imported row
  // from a Homeroom · Claude one: an imported row has a DEFAULTED backend
  // that no turn ever ran through. `source` and `external_agent` are the
  // two columns that make the difference expressible.
  const list = SESSIONS_SRC.slice(SESSIONS_SRC.indexOf('SELECT id, branch_name, pr_number'));
  const select = list.slice(0, list.indexOf('FROM chat_sessions'));
  for (const col of ['agent_backend', 'agent_model', 'source', 'external_agent']) {
    assert.ok(select.includes(col), `the list SELECT carries ${col}`);
  }
});

// ── 3. The fallback note ─────────────────────────────────────────────

test('every server fallback reason becomes a sentence', () => {
  // Only deliberate feature-policy decisions fall back now. Credential,
  // provisioning, and catalog failures stop visibly instead of changing
  // providers; the remaining policy reasons still need user-facing copy.
  const fn = SESSIONS_SRC.slice(
    SESSIONS_SRC.indexOf('async function resolveDefaultAgentPreference('),
    SESSIONS_SRC.indexOf('\n}', SESSIONS_SRC.indexOf('async function resolveDefaultAgentPreference('))
  );
  const reasons = new Set();
  for (const m of fn.matchAll(/claudeFallback\('([a-z_]+)'\)/g)) reasons.add(m[1]);
  assert.deepEqual([...reasons].sort(), ['flag_off', 'not_in_beta']);
  for (const reason of reasons) {
    const note = BV.fallbackNote(reason);
    assert.ok(note.length > 0, `reason '${reason}' has no user-facing copy`);
    assert.ok(note.includes('Homeroom · Claude'),
      `reason '${reason}' must name the venue it fell back TO`);
  }
});

test('a reason the client does not know about stays silent', () => {
  // The reason arrives on the 201 body, so it is server data. A bare
  // property lookup would answer `toString` with a function and render it
  // into the note.
  assert.equal(BV.fallbackNote('brand_new_reason'), '');
  assert.equal(BV.fallbackNote('toString'), '');
  assert.equal(BV.fallbackNote(null), '');
});

test('the client keeps the reason across the navigation into the session', () => {
  // The 201 arrives in createSession; the line that reports it is painted
  // after a tab switch, in a different call stack. Stashing it on DevChat
  // is what carries it across — and clearing it on paint is what stops it
  // reappearing on every later re-render of the same session.
  assert.match(DEV_CHAT_SRC, /DevChat\._venueFallbackReason = data\.agentFallbackReason/);
  assert.match(DEV_CHAT_SRC, /DevChat\._venueFallbackReason \|\| DevChat\._shotVenueFallbackReason\(\)/,
    'the stash is what the note reads');
  assert.match(DEV_CHAT_SRC, /BuildVenues\.noteHtml\(\{/,
    'and it renders through the shared module');
  assert.match(DEV_CHAT_SRC, /DevChat\._venueFallbackReason = null;/,
    'cleared once painted');
});

test('the note is reviewable on staging without a failing credential', () => {
  // The reason is a creation-moment fact and is deliberately not stored, so
  // a seeded fixture row cannot produce one — every other venue state is a
  // column, this one is not. `?shot=venue-fallback` is the only way the
  // copy gets reviewed, and it must fall through the SAME fallbackNote
  // lookup, or a guessed reason would render an invented sentence.
  const fnStart = DEV_CHAT_SRC.indexOf('_shotVenueFallbackReason() {');
  assert.ok(fnStart !== -1, '_shotVenueFallbackReason must exist');
  const fn = DEV_CHAT_SRC.slice(fnStart, DEV_CHAT_SRC.indexOf('\n  },', fnStart));
  assert.match(fn, /shot !== 'venue-fallback'/, 'gated on the shot name');
  const fallback = fn.match(/return reason \|\| '([a-z_]+)'/);
  assert.ok(fallback, 'it names a default reason');
  assert.ok(BV.fallbackNote(fallback[1]).length > 0,
    `the default reason '${fallback?.[1]}' renders no copy`);
});

test('the headless routes report their fallback too', () => {
  // Three server paths resolve a default (new session, headless, clone);
  // all three already attach agentFallbackReason, and the client has a
  // reporter for the two that do not paint a composer line.
  const attached = SESSIONS_SRC.match(
    /\.\.\.\(pref\.fallbackReason \? \{ agentFallbackReason: pref\.fallbackReason \} : \{\}\)/g
  ) || [];
  assert.ok(attached.length >= 3,
    `every resolver call site reports its fallback (got ${attached.length})`);
  const fnStart = APP_VIEW_SRC.indexOf('_reportVenueFallback(reason) {');
  assert.ok(fnStart !== -1, '_reportVenueFallback must exist');
  const fn = APP_VIEW_SRC.slice(fnStart, APP_VIEW_SRC.indexOf('\n  },', fnStart));
  assert.match(fn, /BuildVenues\.fallbackNote\(reason\)/);
  assert.match(fn, /PlatformUI\.toast\(note\)/, 'and it is said out loud, not logged');
});

// ── 4. Styles ────────────────────────────────────────────────────────

test('every class these surfaces render has a rule', () => {
  // The shell's Tailwind is compiled and these are hand-written classes in
  // app.css; one that is not there simply has no styles, and the venue
  // control would render as an unstyled run of text in the header.
  for (const cls of [
    'dc-venue-slot', 'dc-venue-select', 'dc-venue-name',
    'dc-venue-caret', 'dc-venue-note', 'dc-venue-detail', 'dc-venue-chip',
    'dc-openrouter-model', 'dc-openrouter-model-change',
  ]) {
    assert.ok(new RegExp('\\.' + cls + '[\\s,:{]').test(APP_CSS),
      `.${cls} has no rule in app.css`);
  }
});


test('session card and header display the same native provider after reload', () => {
  const extract = (source, signature) => {
    const start = source.indexOf(signature);
    const end = source.indexOf('\n  },', start);
    return source.slice(start + signature.length, end);
  };
  const card = new Function('s', 'window', extract(APP_VIEW_SRC, '_sessionVenueChipSpec(s) {'));
  const header = new Function('session', 'window', 'BuildVenues', 'DevChat',
    extract(DEV_CHAT_SRC, '_headerVenue(session) {'));
  for (const [agent, label] of [['codex', 'Codex'], ['claude-code', 'Claude Code'], [null, 'External agent']]) {
    const session = { source: 'cli_handoff', external_agent: agent, agent_backend: 'claude_code' };
    const window = { BuildVenues: BV };
    assert.equal(card(session, window).label, label);
    assert.equal(header(session, window, BV, {
      _currentVenueId: () => 'local', _chatBusyForPaint: () => false, _localAgent: null,
    }).label, label);
  }
});


test('all session lists serialize the identity needed by provider badges', () => {
  for (const route of ['/api/me/active-sessions', '/api/apps/:slug/sessions', '/api/apps/:slug/shared-sessions']) {
    const start = SESSIONS_SRC.indexOf("router.get('" + route + "'");
    assert.ok(start >= 0, route);
    const select = SESSIONS_SRC.indexOf('`SELECT', start);
    const query = SESSIONS_SRC.slice(select, SESSIONS_SRC.indexOf('FROM chat_sessions', select));
    for (const field of ['source', 'external_agent', 'build_venue', 'agent_backend']) {
      assert.ok(query.includes(field), route + ' includes ' + field);
    }
  }
});
