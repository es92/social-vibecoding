// #1406 / #1408 — two small UI tweaks, of which ONE survives.
//
//   #1406  kept the improve button and the view selector alive on the other
//          platform screens (settings, profile, messages). The Streamlined
//          Concept took the other side of that decision on purpose — a
//          platform screen carries a plain title and an empty right slot,
//          navigation lives in the drawer — so `_publishPlatformChrome`, the
//          header-resident selector and their checks are gone. What survives
//          of #1406 is the navigation guard it fixed in Improve.openApp,
//          asserted below.
//   #1408  Text boxes grow with their content up to a ceiling.
//
// #1407 was here too — centring the title in the space the side groups LEAVE
// rather than on the viewport, which is a different place because the groups
// are lopsided. It was implemented, reviewed on the staging preview and backed
// out: the anchor moving with the right group's width read as the title
// wandering rather than as it being centred. use-header-layout.ts keeps the
// viewport-centred rule it always had — absolute at left:50% when the title's
// natural width clears the wider group on both sides, flex flow otherwise —
// and nothing in this file asserts on it.
//
// Run with: node --test tests/header-and-textbox-tweaks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_JS = read('public/js/app.js');
const IMPROVE_JS = read('frontend/src/features/improve/improve-controller.js');
const GROW_TS = read('frontend/src/lib/use-auto-grow.ts');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const ROW = read('frontend/src/features/messages/message-row.tsx');
const CSS = read('public/css/app.css');

// One method of the App object literal, from its opening line to the `},`
// that closes it at the same indent. Used instead of a character count so a
// comment added inside a method cannot silently push an assertion's subject
// out of the window it is matched against.
const fnBody = (name) => {
  const start = APP_JS.indexOf(`  ${name}() {`);
  assert.ok(start !== -1, `${name} exists in app.js`);
  const end = APP_JS.indexOf('\n  },', start);
  assert.ok(end !== -1, `${name} is closed`);
  return APP_JS.slice(start, end);
};

// ── The half of #1406 the Streamlined Concept superseded ────────────────

test('platform screens do NOT republish a platform target any more', () => {
  // The clear is the whole of the screen-entry chrome now: a plain title, an
  // empty right slot. The republish half (`_publishPlatformChrome`) is gone
  // with the header selector it fed.
  const enter = fnBody('_enterScreenChrome');
  assert.match(enter, /setAppOpen\(false\)/, 'the app target is still cleared');
  assert.doesNotMatch(enter, /_publishPlatformChrome/,
    'no republish — a platform screen carries no improve target');
  assert.ok(APP_JS.indexOf('_publishPlatformChrome() {') === -1,
    'the repeatable half retired with its one caller');
});

test('clicking Home from another screen actually navigates (#1406\'s keeper)', () => {
  // The bug this avoids: #1386 could no-op here because "no app open" meant
  // "already home". The guard is the home screen itself — otherwise the row
  // renders, is clicked, and nothing happens.
  const start = IMPROVE_JS.indexOf('  openApp() {');
  const body = IMPROVE_JS.slice(start, IMPROVE_JS.indexOf('\n  },', start));
  assert.match(body, /_isScreenVisible\('home-screen'\)/);
  assert.match(body, /if \(!onHome\) window\.App\.navigateHome\(\)/);
  assert.doesNotMatch(body, /if \(window\.App\.currentApp\) window\.App\.navigateHome\(\)/,
    'the old "an app is open" guard would strand a click from Settings');
  // A deployment where the helper is missing still navigates rather than
  // silently doing nothing.
  assert.match(body, /typeof window\.App\._isScreenVisible === 'function'/);
});

// ── #1408: text boxes that grow ────────────────────────────────────────

test('the hook collapses before measuring, or the height only ratchets up', () => {
  // Reading scrollHeight without the reset measures against the box the
  // element already has, so a textarea that grew never shrinks again when its
  // text is deleted.
  const autoAt = GROW_TS.indexOf("el.style.height = 'auto'");
  const setAt = GROW_TS.indexOf('el.scrollHeight');
  assert.ok(autoAt !== -1 && setAt !== -1 && autoAt < setAt,
    'collapse to auto, then pin to the content height');
});

test('the ceiling lives in CSS, and the overflow stays reachable', () => {
  // One control, one ceiling. Duplicating the max as a number in JS would give
  // each box two that can disagree.
  assert.doesNotMatch(GROW_TS, /max-?[Hh]eight\s*[:=]\s*\d/,
    'the hook sets no maximum of its own');
  // Setting height past max-height is harmless — the used height is clamped —
  // but the hidden lines have to be scrollable or they are simply lost.
  const composer = CSS.slice(CSS.indexOf('.messages-composer-input {'));
  assert.match(composer.slice(0, 600), /max-height: 140px/);
  assert.match(composer.slice(0, 600), /overflow-y: auto/);
  const edit = CSS.slice(CSS.indexOf('.messages-edit textarea {'));
  assert.match(edit.slice(0, 900), /max-height: \d+px/);
  assert.match(edit.slice(0, 900), /overflow-y: auto/);
});

test('both message text boxes use it, keyed on their own value', () => {
  // The dependency is the controlled value rather than an input listener: by
  // the time the effect runs React has re-rendered, so one measurement covers
  // typing, pasting, a clear on send and a draft restored on mount.
  // #6810: the conversation's own scroller is named too, so a collapse puts
  // it back at its newest line when it was there.
  assert.match(COMPOSER, /useAutoGrow\(inputRef, value, scroller\)/);
  assert.match(ROW, /useAutoGrow\(editRef, editValue\)/);
  assert.equal(message('messages:row.editLabel'), 'Edit message');
  assert.match(ROW, /<textarea ref=\{editRef\} dir="auto" aria-label=\{t\('messages:row\.editLabel'\)\}/,
    'the box follows the direction of what is typed into it');
});

test('a hand-dragged edit box is not undone by the next keystroke', () => {
  // The grow is a floor on convenience, not a ceiling on choice: the edit box
  // keeps `resize: vertical`, so a deliberate drag survives.
  const edit = CSS.slice(CSS.indexOf('.messages-edit textarea {'));
  assert.match(edit.slice(0, 900), /resize: vertical/);
});
