'use strict';

// #1915: the challenges block's completion-status line ("Finish these to
// unlock the rest of the season.") pads both sides. There is no
// hairline above it any more (the block is a flat column on the page ground);
// the padding is the column's one rhythm: every band, the season progress and
// the body included, opens on `pt-2` and closes on `pb-1.5`, so the note keeps
// the same 14px step from its neighbours. Trimming either side breaks that
// step.
//
// S8 (owner decision, 2026-09-15) MOVED the note: it used to sit between the
// season progress and `.home-panel-body`; it now follows the body, under the
// challenges, because it says what finishing them unlocks. That also keeps the
// declared check's `.home-panel-season + .home-panel-body` adjacency true
// while setup is locked. The dashed "N challenges locked" placeholder carries
// the unlock line itself, so the note is drawn only when that card is not.
// S10 (owner decision, 2026-09-15): the note is the Challenges tab's words, and
// it shows only while setup is locked; once unlocked there is no note at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend/src/features/home/panels/challenges.tsx'), 'utf8');

const NOTE = /<p className="([^"]*)"[^>]*>\s*\{view\.onboardingNote\}/;

test('the onboarding status line has top padding as well as bottom', () => {
  const m = SRC.match(NOTE);
  assert.ok(m, 'the onboarding note renders as a <p> with a static className');
  const classes = m[1].split(/\s+/);
  const top = classes.some((c) => /^(pt|py)-(?!0\b)/.test(c));
  const bottom = classes.some((c) => /^(pb|py)-(?!0\b)/.test(c));
  assert.ok(top, `expected top padding, got "${m[1]}"`);
  assert.ok(bottom, `expected bottom padding, got "${m[1]}"`);
});

// 2026-10-01: while Getting started gates a new account's season, the block
// draws ONE locked card and nothing else (`view.locked`, its own early
// return, above the cards' branch), because the card on top of Home lists
// the First challenges. The note is what a closed gate with nothing to count
// still draws, after the cards. So the cards' branch no longer holds the
// placeholder, and the note has no placeholder to give way to.
const CARDS_BRANCH = SRC.slice(SRC.indexOf('const groups: ChallengeGroupView[]'));

test('the onboarding status line follows the challenges, not the season progress', () => {
  const note = CARDS_BRANCH.search(NOTE);
  // The JSX's own class, not the header comment's mention of it: `hasNote`
  // reads `view.onboardingNote` above the markup.
  const season = CARDS_BRANCH.indexOf('home-panel-season pt-2');
  // The body's class is one of two complete literals (it closes on `pb-1.5`
  // only when a band follows it), so find its first spelling.
  const body = CARDS_BRANCH.search(/['"]home-panel-body /);
  const rows = CARDS_BRANCH.indexOf('home-panel-rows');
  assert.ok(season > 0 && body > season, 'the season progress leads the body');
  assert.ok(rows > body && note > rows, 'the note comes after the body and its cards');
  assert.doesNotMatch(CARDS_BRANCH.slice(season, body), /onboardingNote/,
    'nothing sits between the season progress and the body');
});

test('the locked card is its own branch, alone; the cards\' branch only adds the note', () => {
  assert.doesNotMatch(CARDS_BRANCH, /<LockedChallengesCard/, 'no placeholder under the cards');
  assert.match(CARDS_BRANCH, /const hasNote = !!view\.onboardingNote;/);
  assert.match(CARDS_BRANCH, /\{hasNote \? \(/);
  const locked = SRC.slice(SRC.indexOf('if (view.locked) {'), SRC.indexOf('const groups: ChallengeGroupView[]'));
  assert.match(locked, /<div className="home-panel-rows flex flex-col gap-2\.5">\s*<LockedChallengesCard/,
    'inside the rows list, where the cards it stands in for would be');
  assert.match(locked, /names=\{view\.lockedNames\}/);
  assert.match(locked, /className="home-challenge-locked"/);
  assert.doesNotMatch(locked, /SeasonProgress|PanelFooter|onboardingNote/, 'and nothing else');
});
