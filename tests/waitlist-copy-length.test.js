// The waitlist screens say the same things in less reading (#1541).
//
// The report was "text heavy - too much reading" on the waitlist and the
// want-in-sooner screens. Stage 1 opened with two paragraphs of around
// seventy-five words carrying four separate claims — what the place is, who
// built the apps, what the chain and the share mean, and how access opens —
// and a reader scanning for "what is this, and what does joining cost me" had
// to take all four as prose.
//
// Nothing was dropped. The claims are pinned individually below, precisely so
// that "cut the copy" cannot quietly become "cut the facts" in a later pass.
//
// Run with: node --test tests/waitlist-copy-length.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WAITLIST = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/auth/waitlist.tsx'), 'utf8');
const MORE = fs.readFileSync(
  path.join(ROOT, 'frontend/src/features/auth/more.tsx'), 'utf8');

/** Collapse JSX source whitespace so a wrapped sentence still matches. */
function flat(text) {
  return text.replace(/\s+/g, ' ');
}

/** The rendered words of a JSX text run, comments and markup excluded. */
function wordsIn(text) {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&rsquo;/g, "'")
    .split(/\s+/)
    .filter(Boolean).length;
}

test('stage 1 leads with one sentence, then a list', () => {
  const pitch = WAITLIST.slice(
    WAITLIST.indexOf('Describe the app you want'),
    WAITLIST.indexOf('Just your email to join.'));
  assert.match(pitch, /<ul/, 'the three supporting claims are a list now');
  const items = pitch.match(/<li>/g) || [];
  assert.equal(items.length, 3);
  assert.ok(wordsIn(pitch) < 70,
    `the pitch should be well under the original ~75 words, saw ${wordsIn(pitch)}`);
});

test('and keeps every claim it used to make', () => {
  for (const claim of [
    /Describe the app you want in chat, an AI builds it, and the group votes the changes in\./,
    /built here, by the people who use it/,
    /run on the Homeroom chain, and contributors own a share of what they build/,
    /Access opens in batches/,
    /public apps are open to everyone now/,
    /Just your email to join\./,
  ]) {
    assert.match(flat(WAITLIST), claim);
  }
});

test('the heading and the step line are untouched: checks pin them', () => {
  // "Enter your confirmation code" and "Registered with" are declared-check
  // text on ?shot= routes, and the whole pitch hides on `joined` as before.
  assert.match(WAITLIST, /Join the waitlist/);
  assert.match(WAITLIST, /hiddenLast\(joined, 'mt-3 text-sm font-medium/);
});

test('want-in-sooner drops the sentence that said it twice', () => {
  const intro = MORE.slice(
    MORE.indexOf('Four questions, about three minutes'),
    MORE.indexOf('id="more-invalid"'));
  assert.ok(wordsIn(intro) < 40, `saw ${wordsIn(intro)} words`);
  // What it must still say.
  assert.match(flat(intro), /what we read when we pick the next group/);
  assert.match(flat(intro), /come back and add to them any time/);
  // The retired half restated the first clause, and "every one is optional"
  // is the label above the heading already. Asserted on the RENDERED intro
  // rather than the file: the change's own doc comment quotes the sentence it
  // removed, which is exactly the sort of prose a whole-file grep trips on.
  assert.doesNotMatch(flat(intro), /worth more than the order/);
  assert.doesNotMatch(flat(intro), /Every one is optional/);
  assert.match(MORE, /Optional \(moves you up the list\)/,
    'the optional label is still there, which is why the sentence could go');
});

test('the "Want in sooner?" heading survives, because a check asserts it', () => {
  assert.match(MORE, /Want in sooner\?/);
});
