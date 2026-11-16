// The declared-check ceiling, stated once for the suites that guard it.
//
// tests/dev-board-fold.test.js pins dapp.json's exact size, and
// tests/proposal-tests-manifest.test.js holds it 20 slots under
// MAX_DECLARED_TESTS (services/app-manifest.js). A second floor guard lived
// in tests/improve-session-spinner.test.js until that suite went with the
// Improve session rows (16 Nov 2026). On
// change 4868 main stood exactly at that floor, the proposal's two checks
// broke all three at once, and their messages disagreed: the exact pin
// printed only `812 !== 811`, one floor guard called raising the cap a
// coupled change, the other said to raise it rather than delete checks. The
// fix turn spent about 45 minutes deciding which to believe and rebuilding
// the merge arithmetic from git. The three now say one thing, from here.
//
// The messages are built only when a guard fails: the merge arithmetic
// reads git, and a passing run should not pay for it.

'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const appManifest = require('../../src/services/app-manifest');

// Slots the manifest keeps clear of MAX_DECLARED_TESTS, so the proposals
// already in review when the count grows do not hit the ceiling mid-review.
const FLOOR = 20;
const ROOT = path.join(__dirname, '..', '..');

// What to do at the floor. The same words in every guard's message, and
// the rule the MAX_DECLARED_TESTS note in services/app-manifest.js states.
const REMEDY = 'Fold first: where a new check can share a route with an existing one, '
  + "add it to that check's expectSelector with :has() instead of declaring another "
  + '(the history above the pinned count in tests/dev-board-fold.test.js shows how). '
  + `If the merged manifest still crosses the ${FLOOR}-slot floor, raise MAX_DECLARED_TESTS `
  + 'in this same proposal and record the step and its arithmetic in the note above it '
  + '(src/services/app-manifest.js); tests/checks-budget.test.js then says whether '
  + 'TESTS_DEADLINE_MS and RUN_TIMEOUT_MS have to move with it. Never delete a check to make room.';

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  }).trim();
}

function declaredAt(rev) {
  try {
    const manifest = JSON.parse(git(['show', `${rev}:dapp.json`]));
    return Array.isArray(manifest.tests) ? manifest.tests.length : null;
  } catch {
    return null;
  }
}

const signed = (n) => (n >= 0 ? `+${n}` : String(n));

// How main and this branch each moved the count since they parted, so the
// merged total does not have to be rebuilt from git history. Best-effort:
// null when there is no main to compare with — the unit-suite container
// fetches the proposal alone at depth 1, so this is for a local re-run.
// The platform's repository is `upstream` in a fork and `origin` in a
// hosted session, so upstream is asked first; the ref's date shows when it
// was last fetched, because a stale one answers for an old main.
function mainArithmetic(declared) {
  for (const ref of ['upstream/main', 'origin/main']) {
    try {
      const tip = git(['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
      const base = git(['merge-base', 'HEAD', tip]);
      const onMain = declaredAt(tip);
      const atBase = declaredAt(base);
      if (onMain === null || atBase === null) continue;
      const date = git(['show', '-s', '--format=%cs', tip]);
      return `${ref} (${tip.slice(0, 8)}, ${date}) declares ${onMain}. This checkout declares ${declared}: `
        + `${signed(declared - atBase)} since it parted from main at ${atBase} (${base.slice(0, 8)}), `
        + `while main moved ${signed(onMain - atBase)}, so merged with that main it holds about `
        + `${declared + onMain - atBase}.`;
    } catch {
      // No git, no such ref, or a shallow clone without the merge base.
    }
  }
  return null;
}

function floorMessage(declared, ceiling) {
  return [
    `dapp.json declares ${declared} checks against MAX_DECLARED_TESTS ${ceiling}: `
      + `${ceiling - declared} slots left, and the manifest keeps ${FLOOR} clear.`,
    mainArithmetic(declared),
    REMEDY,
  ].filter(Boolean).join('\n');
}

function pinMessage(declared, pinned, ceiling) {
  const left = ceiling - declared;
  return [
    `dapp.json declares ${declared} checks; tests/dev-board-fold.test.js pins ${pinned}.`,
    'The count is pinned on purpose: every change to it is recorded, with its reason, '
      + 'in the comment above the assertion, so no check is added or lost without somebody saying why.',
    'If this proposal changes the declared checks, fold what can share a route into an existing '
      + `check's expectSelector with :has() first, then set the pin to the new count and add a line `
      + `to that comment ("${pinned} → ${declared}: ${signed(declared - pinned)} (#…): what the checks cover").`,
    mainArithmetic(declared),
    left >= FLOOR
      ? `At ${declared} the manifest is ${left} slots under MAX_DECLARED_TESTS ${ceiling}, clear of the ${FLOOR}-slot floor.`
      : `At ${declared} it is ${left} slots under MAX_DECLARED_TESTS ${ceiling}, past the ${FLOOR}-slot floor, `
        + `so the floor guard in tests/proposal-tests-manifest.test.js fails too. ${REMEDY}`,
  ].filter(Boolean).join('\n');
}

// dapp.json holds exactly `pinned` checks.
function assertPinned(declared, pinned, ceiling = appManifest.MAX_DECLARED_TESTS) {
  if (declared === pinned) return;
  throw new assert.AssertionError({
    message: pinMessage(declared, pinned, ceiling), actual: declared, expected: pinned, operator: 'strictEqual',
  });
}

// dapp.json keeps FLOOR slots clear of the ceiling.
function assertFloor(declared, ceiling = appManifest.MAX_DECLARED_TESTS) {
  if (declared + FLOOR <= ceiling) return;
  throw new assert.AssertionError({
    message: floorMessage(declared, ceiling), actual: declared, expected: ceiling - FLOOR, operator: '<=',
  });
}

module.exports = { FLOOR, REMEDY, assertPinned, assertFloor, pinMessage, floorMessage };
