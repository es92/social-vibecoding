// Check my status, on the screen (#1538).
//
// Anyone can now read where they stand from a device that never joined: enter
// the address, get a six-digit code by mail, type it in. The reply carries the
// row's state and the confirm panel prints it instead of the one fixed
// sentence it used to print.
//
// This file pins the parts a runtime check cannot reach on its own: that the
// panel reads off the response rather than hardcoding an outcome, that the
// three-state vocabulary has exactly one definition, that the states a
// screenshot needs are reachable by URL, and that a staging preview has the
// data to show them.
//
// Source-text assertions, same idiom as tests/waitlist-copy-length.test.js:
// these are contracts about how the screen is WRITTEN, and the declared
// checks in dapp.json cover what it renders.
//
// Run with: node --test tests/waitlist-status-panel.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WAITLIST = read('frontend/src/features/auth/waitlist.tsx');
const MORE = read('frontend/src/features/auth/more.tsx');
const SHARED = read('frontend/src/features/auth/waitlist-shared.tsx');
const LANDING = read('frontend/src/features/auth/landing.tsx');
const APP = read('public/js/app.js');
const MIGRATE = read('src/db/migrate.js');
const DAPP = JSON.parse(read('dapp.json'));

// ─── One definition of the three states ──────────────────────────────

test('the queue pill is defined once and rendered by both screens', () => {
  // The stage-2 survey had this table to itself. Duplicating it for the
  // confirm panel is how the same row starts being described two different
  // ways, so it moved into the shared module and both screens import it.
  assert.match(SHARED, /export const QUEUE_PILL = \{/);
  assert.match(SHARED, /export function StatusPill\(\{\s*id,\s*status,/);
  assert.match(SHARED, /export interface WaitlistStatus \{/);

  for (const [name, src] of [['waitlist.tsx', WAITLIST], ['more.tsx', MORE]]) {
    assert.doesNotMatch(src, /const QUEUE_PILL/, `${name} redefines the pill table`);
    assert.doesNotMatch(src, /function StatusPill/, `${name} redefines the pill`);
    assert.match(src, /StatusPill/, `${name} does not render the shared pill`);
  }
  // The id is a prop precisely because there are two hosts now.
  assert.match(MORE, /<StatusPill id="more-status-pill"/);
  assert.match(WAITLIST, /<StatusPill\s*\n\s*id="waitlist-status-pill"/);
});

test('the pill drops its note where the panel already says it', () => {
  // The note is the survey screen's only guidance, so it stays on there. On
  // check-my-status it would restate the body copy a line later, and for an
  // admitted reader it would point at a mail instead of the button beside it.
  assert.match(WAITLIST, /id="waitlist-status-pill"\s*\n\s*status=\{status\}\s*\n\s*note=\{false\}/);
  assert.doesNotMatch(MORE, /note=\{false\}/, 'the survey screen lost its guidance');
  assert.match(SHARED, /note: showNote = true,/, 'the note is opt-out, not opt-in');
});

test('every pill tint is a whole class literal', () => {
  // Tailwind's extractor is a regex over source text, so a tint assembled at
  // runtime is a tint that never gets compiled and a pill with no colour.
  const table = SHARED.slice(SHARED.indexOf('export const QUEUE_PILL'));
  const body = table.slice(0, table.indexOf('} as const;'));
  assert.doesNotMatch(body, /`/, 'a template literal in a class string');
  assert.doesNotMatch(body, /\+\s*$/m, 'a concatenated class string');
  for (const state of ['pending', 'confirmed', 'admitted']) {
    assert.ok(body.includes(`${state}: {`), `${state} is missing from the table`);
  }
});

// ─── The panel reads the row, it does not assume one ─────────────────

test('the confirmed panel branches on the response, not on a constant', () => {
  const panel = WAITLIST.slice(WAITLIST.indexOf('id="waitlist-confirmed"'));
  const body = panel.slice(0, panel.indexOf('id="waitlist-more-offer"'));
  // Body copy and the action move with the row. (The celebrating headline
  // went with the join form, #5261: every arrival here is a read-back.)
  assert.match(body, /admitted\s*\n\s*\? \(status\?\.has_account/);
  assert.doesNotMatch(body, /id="waitlist-confirmed-headline"/);
  assert.match(body, /status\?\.has_account/);
  assert.match(body, /id="waitlist-status-pill"/);
  assert.match(body, /id="waitlist-status-since"/);
  assert.match(body, /id="waitlist-status-action"/);
});

test('the status comes off the confirm response in one round trip', () => {
  // The route hands the block back with the confirmation, so the screen
  // never makes a second read that could answer differently.
  assert.match(WAITLIST, /const next: WaitlistStatus \| null = \(data && data\.status\) \|\| null;/);
  assert.match(WAITLIST, /setStatus\(next\);/);
  // And the stage-2 offer retires the moment there is nothing left to
  // improve: it is an offer to move up a queue an admitted row has left.
  assert.match(WAITLIST, /setOffer\(!next\?\.admitted\);/);
  assert.match(WAITLIST, /hiddenFirst\(\s*!offer \|\| admitted,/);
});

test('the panel offers a date, never a queue position', () => {
  // services/waitlist-signals.js computes no rank on purpose. A position is a
  // promise, and it can go backwards.
  assert.match(WAITLIST, /function formatJoinedOn\(/);
  assert.match(WAITLIST, /t\('auth:waitlist\.status\.since', \{ date: joinedOn \}\)/);
  assert.equal(message('auth:waitlist.status.since', { date: '3 October 2026' }), 'On the list since 3 October 2026');
  const panel = WAITLIST.slice(WAITLIST.indexOf('id="waitlist-confirmed"'));
  // Comments in here explain WHY there is no rank, so scan what renders:
  // block comments out, then the remaining source.
  const body = panel.slice(0, panel.indexOf('id="waitlist-more-offer"'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const word of ['position', 'in line', 'ahead of', 'you are #']) {
    assert.doesNotMatch(body.toLowerCase(), new RegExp(word),
      `the panel implies a rank via "${word}"`);
    // The panel's words are catalog entries now: the same goes for them.
    for (const id of body.match(/auth:waitlist\.status\.[A-Za-z.]+/g) || []) {
      assert.doesNotMatch(message(id).toLowerCase(), new RegExp(word), `${id} implies a rank via "${word}"`);
    }
  }
});

test('a malformed or missing joined_at collapses instead of printing junk', () => {
  const fn = WAITLIST.slice(WAITLIST.indexOf('function formatJoinedOn('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /if \(!iso\) return '';/);
  assert.match(body, /Number\.isNaN\(at\.getTime\(\)\)/);
  // toLocaleDateString can throw on a bad options bag in old engines, and a
  // boot path is the worst place to learn that.
  assert.match(body, /catch \{/);
});

// ─── Hydration: every new node ships in the prerender ────────────────

test('the new nodes are always in the markup, hidden until there is an answer', () => {
  // An island's first render must emit exactly the prerendered shape.
  // Rendering the pill's contents any earlier is a hydration mismatch, and a
  // mismatch console.errors, which fails proposal checks on every route.
  for (const id of ['waitlist-status-since', 'waitlist-status-action']) {
    const at = WAITLIST.indexOf(`id="${id}"`);
    assert.ok(at > 0, `${id} is missing`);
    const decl = WAITLIST.slice(at, at + 400);
    assert.match(decl, /hiddenFirst\(/, `${id} is rendered conditionally, not hidden`);
  }
  // The pill's own host is unconditional; StatusPill hides itself.
  assert.match(SHARED, /until there is something to say/);
});

// ─── Ways in ─────────────────────────────────────────────────────────

test('the landing card offers the way in, and only to a visitor', () => {
  const at = LANDING.indexOf('id="landing-status-link"');
  assert.ok(at > 0, 'the landing link is missing');
  const block = LANDING.slice(Math.max(0, at - 400), at + 400);
  assert.match(block, /hiddenLast\(\s*session,/, 'a signed-in visitor is shown it anyway');
  assert.match(block, /href="#waitlist\?confirm=1"/);
  assert.match(block, /<RichMessage id="auth:landing\.alreadyJoined"/);
  assert.match(message('auth:landing.alreadyJoined'), /Check your status/);
});

test('the confirm step is reachable without a join, on any device', () => {
  // `#waitlist?confirm=1` opens the address step, which is exactly what
  // someone arriving from a mail on a second device needs; since #5261 the
  // screen is only this errand, and the router sends a bare #waitlist to
  // Continue instead.
  assert.match(APP, /authRoute === 'waitlist' && !\/\(\?:\^\|&\)confirm=1/);
  assert.match(WAITLIST, /id="waitlist-confirm-email"/);
});

test('the admitted state is reachable by URL for a screenshot', () => {
  // The before/after shots and the "Test this change" button can only
  // navigate. Admitted is the one settled state no other route can paint,
  // because it needs a released_at behind it.
  assert.match(WAITLIST, /shot === 'waitlist-admitted'/);
  assert.match(APP, /shot !== 'waitlist-admitted'/, 'the shot is not allowlisted in app.js');
  assert.match(APP, /shot === 'waitlist-admitted'/, 'the hash is not normalised to #waitlist');
  // Deterministic: a fixed joined_at, so two shots of the same path compare.
  const block = WAITLIST.slice(WAITLIST.indexOf("if (shot === 'waitlist-admitted') {"));
  assert.match(block.slice(0, 500), /joined_at: '2026-03-14T10:00:00\.000Z'/);
});

test('the declared checks cover the states the panel can be in', () => {
  const paths = new Set(DAPP.tests.map((t) => t.path));
  assert.ok(paths.has('/?shot=waitlist-admitted'), 'the admitted state is unchecked');
  const admitted = DAPP.tests.filter((t) => t.path === '/?shot=waitlist-admitted');
  const selectors = admitted.map((t) => t.expectSelector).join(' ');
  for (const id of ['waitlist-status-pill', 'waitlist-status-action', 'waitlist-status-since']) {
    assert.match(selectors, new RegExp(id), `#${id} is not asserted on`);
  }
  // The offer must be gone in that state, and a check says so.
  assert.match(selectors, /#waitlist-more-offer\.hidden/);
  // And the landing way in is checked too, or it can vanish silently. The
  // landing's default is the first session's story now
  // (services/first-session.js), where somebody already on the list signs
  // in from the story's sheet with their address (its sign-up buttons, #5251);
  // the "Check your status" line is the waitlist landing's, drawn only when
  // the story is switched off, and a declared check reads rendered text, so
  // it checks the story's.
  assert.ok(DAPP.tests.some((t) => (t.expectSelector || '').includes('data-sign-up-method')),
    'the landing entry point is unchecked');

  // #2201's confirmed re-join came through the join form, retired by #5261;
  // its shot went with it, and its checks were rewritten in place.
  assert.ok(!paths.has('/?shot=waitlist-rejoined'));
});

// ─── Staging has something to show ───────────────────────────────────

test('staging seeds a known code for the two confirmed demo addresses', () => {
  // Both addresses end in .invalid, so the mail this flow sends can never be
  // delivered. Without a seeded code the confirmed and admitted panels are
  // unreachable in a preview.
  const seed = MIGRATE.slice(MIGRATE.indexOf('async function seedStagingPlatformMail'));
  const body = seed.slice(0, seed.indexOf('\n}\n'));
  assert.match(body, /INSERT INTO waitlist_verification_codes/);
  assert.match(body, /const DEMO_STATUS_CODE = '000000';/);
  // Hashed, never stored in the clear: the seed goes through the same column
  // the real mint writes, so the real bcrypt.compare still runs.
  assert.match(body, /bcrypt\.hash\(DEMO_STATUS_CODE, 10\)/);
  // Idempotent by the same one-live-code-per-address rule issueVerificationCode
  // rests on, so a rebuilt container does not accumulate rows.
  assert.match(body, /WHERE NOT EXISTS \([\s\S]*?consumed_at IS NULL/);
  // Fake identities only, never whoever opened the preview.
  assert.match(body, /staging-demo-waitlist-confirmed@example\.invalid/);
  assert.match(body, /staging-demo-waitlist-admitted@example\.invalid/);
  assert.doesNotMatch(body, /req\.user/);
});

test('staging seeds the two delivery states #2201 turns on', () => {
  // The change is entirely about what the mail layer decides, and a preview
  // of it is blank without rows to decide against: platform_mail_deliveries
  // is staging-private, so a fresh container starts with an empty history
  // and every send looks like a first one.
  const seed = MIGRATE.slice(MIGRATE.indexOf('async function seedStagingPlatformMail'));
  const body = seed.slice(0, seed.indexOf('\n}\n'));

  // Capped: enough counted waitlist_code rows inside the window that the
  // next ask is refused by the DAILY ceiling rather than by the 60s gap —
  // which is the half of the change a reviewer cannot otherwise see.
  assert.match(body, /staging-demo-waitlist-capped@example\.invalid/);
  assert.match(body, /mailRateLimit\.RULES\.waitlist_code\.perWindow/,
    'the fixture hardcodes the cap instead of reading it');
  assert.match(body, /generate_series\(1, \$2::int\)/, 'the shortfall is not seeded in bulk');

  // Fresh: one unconsumed, unexpired, unguessed code minted seconds ago, so
  // hasReusableCode answers true and the next ask mints nothing.
  assert.match(body, /staging-demo-waitlist-fresh@example\.invalid/);
  assert.match(body, /attempts = 0/, 'a guessed-at code is not reusable');

  // Both are .invalid, like every other fixture here, so the mail this flow
  // sends can never leave the building.
  assert.doesNotMatch(body, /staging-demo-waitlist-[a-z]+@(?!example\.invalid)/);
});

test('the two delivery fixtures survive a redeploy without drifting', () => {
  // Staging containers rebuild on every push, so these run again on each
  // boot. Neither may accumulate rows, and neither may go stale: the capped
  // one tops the window up to the ceiling (which also heals it as rows age
  // out of the 24 hours), and the fresh one RE-ARMS its existing row rather
  // than stacking a second, because issueVerificationCode's one-live-code
  // rule forbids two and the 60-second window expires a minute after boot.
  const seed = MIGRATE.slice(MIGRATE.indexOf('async function seedStagingPlatformMail'));
  const body = seed.slice(0, seed.indexOf('\n}\n'));
  assert.match(body, /Math\.max\(0, codeCap - /, 'the capped fixture is not a shortfall top-up');
  assert.match(body, /UPDATE waitlist_verification_codes[\s\S]*?SET created_at = NOW\(\)/,
    'the fresh fixture does not re-arm its window');
  assert.match(body, /consumed_at IS NULL/);
});

test('the seed cannot run outside staging and cannot break a boot', () => {
  const seed = MIGRATE.slice(MIGRATE.indexOf('async function seedStagingPlatformMail'));
  const body = seed.slice(0, seed.indexOf('\n}\n'));
  // Same contract as every other fixture in this file: wrapped in the
  // try/catch that downgrades a failure to a warning.
  assert.match(body, /log\.warn\('migrate', 'Staging platform-mail seed skipped'/);
  // Every fixture in this file gates itself on the first line rather than
  // trusting its caller, and this one is no exception.
  assert.match(seed.slice(0, 200), /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/);
});

test('both halves of the split are photographable, and declared', () => {
  // The status shot is a WAITING signup read back, not a released one: that
  // is the state most people checking their status are in, and no other
  // route paints it.
  assert.match(APP, /shot !== 'waitlist-status'/);
  const block = WAITLIST.slice(WAITLIST.indexOf("if (shot === 'waitlist-status') {"));
  const body = block.slice(0, block.indexOf('\n    }'));
  assert.match(body, /setConfirmed\(true\)/);
  assert.match(body, /setOffer\(true\)/);
  assert.match(body, /state: 'confirmed'/);
  assert.match(body, /joined_at: '/, 'a fixed date, so the two shots are comparable');

  const paths = DAPP.tests.filter((t) => t.path === '/?shot=waitlist-status');
  assert.ok(paths.length >= 2, 'the status shot carries checks of its own');
  assert.ok(DAPP.tests.some((t) => t.path === '/?shot=waitlist-admitted'));
});
