// Running a session on your own computer — the local-CLI card (#1055),
// and what happened to the menu it used to hang off (#1353).
//
// public/js/session-options.js was the "⋯" beside the dev-chat credit
// meter: a "Session and billing options" menu with an API-key row, a
// hand-back row and a "Change how this is built" row. #1353 removed the
// button, and the menu with it — every row on it had acquired a better
// door — leaving the one thing that had no other home: the card explaining
// how to run this session's turns on your own machine.
//
// So these tests pin three things:
//
//   1. the card interpolates THIS session and escapes what it interpolates
//      — the repo URL is app data;
//   2. the module owns no second copy of the venue vocabulary (that lives
//      in public/js/build-venues.js, and the menu that used to duplicate it
//      is exactly what went);
//   3. nothing in the composer reaches for the retired menu, and each row
//      it carried is still reachable somewhere.
//
// Run with: node --test tests/session-options.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SessionOptions = require('../public/js/session-options.js');

const SETTINGS_SRC = fs.readFileSync(
  path.join(__dirname, '../frontend/src/features/settings/settings.js'), 'utf8'
);
const DEV_CHAT_SRC = fs.readFileSync(
  path.join(__dirname, '../frontend/src/features/dev-chat/dev-chat.js'), 'utf8'
);
const INDEX_SRC = fs.readFileSync(
  path.join(__dirname, '../public/index.html'), 'utf8'
);
const APP_CSS = fs.readFileSync(
  path.join(__dirname, '../public/css/app.css'), 'utf8'
);
const DAPP = require('../dapp.json');

// ── Continue this session vs start new work ─────────────────────────
//
// This section used to live here, driving SessionOptions.items() directly.
// The rows moved into public/js/build-venues.js when the three "somewhere
// else" entries became one door, and the assertions moved with them:
// tests/build-venues.test.js drives the same three-way derivation (#1071)
// against the venue list. What stays here is the seam — this menu must not
// grow a second copy of that copy.

test('the venue copy is not re-implemented in this module', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '../public/js/session-options.js'), 'utf8'
  );
  for (const label of [
    'Claude Code on the web', 'Codex on the web',
    'Your computer · Homeroom session', 'Your computer · your own tools',
  ]) {
    assert.ok(
      !SRC.includes(`'${label}'`) && !SRC.includes(`"${label}"`),
      `session-options.js must read ${label} from build-venues.js, not own a copy`
    );
  }
});

test('webTargetKind is re-exported, and still answers for every session state', () => {
  // Callers and fixtures already read this from SessionOptions. The
  // implementation moved to build-venues.js; the answer must not move.
  const cases = [
    [{ sessionStatus: 'active', hasBranch: true }, 'session'],
    [{ sessionStatus: 'paused', hasBranch: true }, 'session'],
    [{ sessionStatus: 'promoted', hasBranch: true }, 'proposal'],
    [{ sessionStatus: 'promoted', hasBranch: false }, 'proposal'],
    [{ sessionStatus: 'archived', hasBranch: true }, 'new'],
    [{ sessionStatus: 'merging', hasBranch: true }, 'new'],
    [{ sessionStatus: 'merged', hasBranch: true }, 'new'],
    [{ sessionStatus: 'active', hasBranch: false }, 'new'],
    [{ sessionStatus: 'paused', hasBranch: false }, 'new'],
    [{}, 'new'],
  ];
  for (const [state, expected] of cases) {
    assert.equal(
      SessionOptions.webTargetKind(state), expected,
      `${JSON.stringify(state)} → ${expected}`
    );
  }
});

// ── The "run it on your computer" card ──────────────────────────────

test('the commands name this session and this repository', () => {
  const cmds = SessionOptions.commands({
    sessionId: 990405,
    repoUrl: 'https://github.com/acme/widget.git',
  });
  assert.equal(cmds.length, 3);
  assert.match(cmds[0], /^git clone https:\/\/github\.com\/acme\/widget\.git$/);
  assert.match(cmds[1], /social-vibecoding login$/);
  assert.match(cmds[2], /agent run --session 990405$/);
});

test('an unknown repository produces a comment, never a broken command', () => {
  const [first] = SessionOptions.commands({ sessionId: 1 });
  assert.match(first, /^#/, 'a clone line with no URL would be a command that fails');
  assert.doesNotMatch(first, /git clone\s*$/);
});

test('an unknown session id is a placeholder, not "undefined"', () => {
  const cmds = SessionOptions.commands({});
  assert.match(cmds[2], /--session <session-id>$/);
  assert.doesNotMatch(cmds.join('\n'), /undefined|null/);
});

test('the card escapes the repository URL it renders', () => {
  // repo_url is app data — it reaches the browser from the apps table and
  // must never be able to close the <pre> it is rendered into.
  const html = SessionOptions.instructionsHtml({
    sessionId: 7,
    repoUrl: 'https://x/"><script>alert(1)</script>',
  });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert/);
});

test('the card says the session stays put and how to undo the move', () => {
  const html = SessionOptions.instructionsHtml({ sessionId: 990405 });
  assert.match(html, /id="dc-options-commands"/);
  assert.match(html, /same transcript/i);
  assert.match(html, /Hand the turns back/i);
  assert.match(html, /Copy commands/);
});

// ── Wiring ──────────────────────────────────────────────────────────

test('the module is exported both ways', () => {
  // Loaded as a classic script in the browser and required here — the dual
  // export is what lets one file be the single source of truth for both.
  const src = fs.readFileSync(
    path.join(__dirname, '../public/js/session-options.js'), 'utf8'
  );
  assert.match(src, /module\.exports = SessionOptions/);
  assert.match(src, /window\.SessionOptions = SessionOptions/);
});

test('the composer no longer carries the menu, or a button for it (#1353)', () => {
  assert.ok(!DEV_CHAT_SRC.includes('id="dc-budget-options"'), 'the "⋯" is gone');
  assert.ok(!DEV_CHAT_SRC.includes('openSessionOptions'), 'and nothing opens the menu');
  assert.ok(!/SessionOptions\.open\b/.test(DEV_CHAT_SRC),
    'the only entry point left into this module is the card');
  assert.ok(!APP_CSS.includes('.dc-budget-options'), 'its styles went with it');
  assert.ok(!APP_CSS.includes('.dc-options-header'), 'as did the popover header\'s');
  // The card itself is still opened — by the CLI venue, from the sheet.
  assert.match(DEV_CHAT_SRC, /SessionOptions\.openInstructions\(\{/);
  assert.match(DEV_CHAT_SRC, /_sessionOptionsState\(\)/);
});

test('every row the menu carried still has a door', () => {
  // A removed menu is only a cleanup if nothing was reachable ONLY through
  // it. Each of its three rows, and where it lives now.
  const BUILD_VENUES = fs.readFileSync(
    path.join(__dirname, '../public/js/build-venues.js'), 'utf8'
  );
  // "Change how this is built" → the venue dropdown in the session header.
  // The button's MARKUP moved to features/dev-chat/session-header.tsx when
  // that strip converted (a declared check pins it as a direct, last child, so
  // it could not stay a string); what stayed here is every venue the sheet it
  // opens offers.
  assert.ok(Array.isArray(require('../public/js/build-venues').VENUES));
  assert.match(BUILD_VENUES, /function open\(/, 'and the sheet itself');
  const HEADER = fs.readFileSync(
    path.join(__dirname, '../frontend/src/features/dev-chat/session-header.tsx'), 'utf8'
  );
  assert.match(HEADER, /data-venue-change="1"/);
  assert.match(HEADER, /openVenueSheet\?\.\(e\.currentTarget\)/);
  // "Set/Change your API key" → the credits banner's own button, which
  // appears at the moment the allowance actually matters.
  const CREDIT_OPTIONS = fs.readFileSync(
    path.join(__dirname, '../public/js/credit-options.js'), 'utf8'
  );
  assert.match(CREDIT_OPTIONS, /#settings\/api-key/);
  // "Stop running on <machine>" → the runner select's Homeroom option, which
  // is features/dev-chat/composer-chrome.tsx's since #1191.
  const CHROME = fs.readFileSync(
    path.join(__dirname, '../frontend/src/features/dev-chat/composer-chrome.tsx'), 'utf8'
  );
  assert.match(CHROME, /_handBackToUsernode\?\.\(\)/);
  assert.match(CHROME, /id="dc-runner-select"/);
  assert.match(CHROME, /<option value="platform">Homeroom<\/option>/);
  // …and the target id still travels with a hand-off (#1071): without it
  // the prepare call would open new work for a row that said "continue this
  // session". It happens where the sheet dispatches a `flow` pick — read
  // off the shared derivation rather than carried on the row, because
  // #1348's rows are coarse and no longer per-venue.
  assert.match(
    DEV_CHAT_SRC,
    /DevChat\._devFlowFromCredits\(pick\.flow, DevChat\._webHandoffTargetId\(\)\)/
  );
  const target = DEV_CHAT_SRC.match(/_webHandoffTargetId\(\) \{[\s\S]*?\n  \},/);
  assert.ok(target, '_webHandoffTargetId must exist');
  assert.match(target[0], /BuildVenues\.webTargetKind\(state\) !== 'new'/,
    'a hand-off only carries a target when it is continuing something');
  assert.match(target[0], /state\.sessionId/);
});

test('the shell loads the module', () => {
  assert.match(INDEX_SRC, /src="\/js\/session-options\.js"/);
});

test('the card\'s screenshot state is a declared check', () => {
  const paths = DAPP.tests.map((t) => t.path || '');
  assert.ok(paths.some((p) => p.includes('shot=session-options-instructions')),
    'the instructions card has a declared check');
  assert.ok(!paths.some((p) => p.includes('shot=session-options#')),
    'and the retired menu no longer has one');
});

test('all three hand-off states have a declared check (#1071)', () => {
  // One fixture per state, because the difference is entirely in the copy
  // and no single session can show three of them.
  //
  // #1348 made the row a bare noun — "Claude or Codex WebUI" — so the verb
  // that used to carry this ("Continue this session with…" / "Start new
  // work with…") is gone from the label. The distinction itself is NOT:
  // continuing this session, continuing the proposal and starting fresh
  // are different promises, and picking the wrong one costs somebody their
  // branch. It lives in the row's own explanation now, which is what these
  // checks read. Worth knowing: that explanation is the row's tooltip, so
  // on a touch action sheet — which has no tooltips — the sheet no longer
  // distinguishes the three. The launchpad it opens still does.
  const expected = [
    ['990405', 'pushes its work back onto this session'],
    ['990407', 'pushes its work back onto this session'],
    ['990406', 'pushes back onto the same proposal'],
    ['990408', 'comes back as its own proposal'],
  ];
  for (const [sessionId, note] of expected) {
    assert.ok(
      DAPP.tests.some((t) => (t.path || '').includes(`/dev/sessions/${sessionId}`)
        && (t.expectSelector || '').includes(note)),
      `session ${sessionId} has a check pinning "${note}"`
    );
  }
});
