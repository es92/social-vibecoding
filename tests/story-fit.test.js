// The signed-out story fits its screen (frontend/src/features/auth/story.tsx).
//
// Evan, 10 Oct 2026, iPhone Safari: Get started fell below the fold, under
// the toolbar, and the foot that #4682 pinned over the story looked wrong.
// The owner's ruling, from a comparison at four iPhone sizes: unpin it and
// shrink the story instead, in this order and only as far as the screen
// needs: the picture, the spacing, the headline, then two examples instead
// of three. A screen that already fits keeps the story as it was.
//
// Run with: node --test tests/story-fit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderComponent } = require('./lib/render-tsx');

const STORY = 'frontend/src/features/auth/story.tsx';
const SOURCE = fs.readFileSync(path.join(__dirname, '..', STORY), 'utf8');

test('each step adds to the last, in the owner\'s order', () => {
  const { fitStyle, FIT_STEPS } = loadTsx(STORY);
  assert.equal(FIT_STEPS, 4);
  // Step 0 is the story as it was, so a screen it fits sees no change.
  assert.deepEqual(fitStyle(0), {
    picture: 'w-[200px]',
    group: 'py-6',
    label: 'mt-4',
    examples: 'mt-7',
    row: 'py-2.5',
    foot: 'pt-6',
    headline: 'text-[28px] leading-[33px]',
    count: 3,
  });
  const changed = (n) => Object.keys(fitStyle(n)).filter((k) => fitStyle(n)[k] !== fitStyle(n - 1)[k]);
  assert.deepEqual(changed(1), ['picture'], '1: the people');
  assert.deepEqual(changed(2), ['group', 'label', 'examples', 'row', 'foot'], '2: the spacing');
  assert.deepEqual(changed(3), ['headline'], '3: the headline');
  assert.deepEqual(changed(4), ['count'], '4: two examples');
  assert.deepEqual(fitStyle(4), {
    picture: 'w-[136px]',
    group: 'py-2',
    label: 'mt-3',
    examples: 'mt-[18px]',
    row: 'py-2',
    foot: 'pt-4',
    headline: 'text-[23px] leading-[28px]',
    count: 2,
  });
  // Every class is a whole literal in the source, where Tailwind finds it.
  for (let n = 0; n <= FIT_STEPS; n += 1) {
    for (const [k, v] of Object.entries(fitStyle(n))) {
      if (k !== 'count') assert.ok(SOURCE.includes(`'${v}'`), `${v} is written out`);
    }
  }
});

test('the first render is step 0, with all three examples and nothing pinned', () => {
  const html = renderComponent(STORY, 'Story', { primaryClass: 'pill', onStart() {} });
  assert.match(html, /<img[^>]*class="mx-auto block h-auto w-\[200px\] max-w-full"/);
  assert.match(html, /<h1 class="mt-2 text-\[28px\] leading-\[33px\] font-extrabold text-balance">/);
  assert.equal((html.match(/<li /g) || []).length, 3);
  assert.doesNotMatch(html, /sticky/);
  assert.match(html, /<div class="w-full max-w-sm md:max-w-lg mx-auto md:mb-auto flex flex-col gap-3 pt-6 pb-3"><a href="#signup" data-landing-story-start=""/);
  // #5251: from md the foot follows the examples instead of the foot of the
  // screen, so on a desktop the button is not left far below them.
  assert.match(html, /<div class="my-auto md:mb-0 flex flex-col items-center py-6">/);
});

test('it steps before the browser paints, while the foot ends below the foot of the screen', () => {
  // A layout effect, so the steps are never seen; measured only once the
  // story is laid out (a hidden screen has no height).
  assert.match(SOURCE, /useLayoutEffect\(\(\) => \{\s+const story = storyRef\.current;\s+const foot = footRef\.current;\s+if \(!story \|\| !foot \|\| !story\.offsetHeight\) return;/);
  // The foot as it would sit with the page at its top, against the foot of
  // the screen.
  assert.match(SOURCE, /const scrolled = window\.scrollY \+ \(story\.closest\('#auth-landing-scroll'\)\?\.scrollTop \|\| 0\);\s+const next = nextStep\(fit, foot\.getBoundingClientRect\(\)\.bottom \+ scrolled, screenFoot\(\)\);\s+if \(next === null\) f\.settled = true;\s+else setFit\(next\);/);
  assert.match(SOURCE, /<div ref=\{footRef\} className=\{`w-full max-w-sm md:max-w-lg mx-auto md:mb-auto flex flex-col gap-3 \$\{s\.foot\} pb-3`\}>/);
  // The foot of the screen is where a fixed box ends, less the home
  // indicator: in iPhone Safari, just above the toolbar.
  assert.match(SOURCE, /probe\.style\.cssText = 'position:fixed;left:0;top:0;width:1px;bottom:env\(safe-area-inset-bottom,0px\);visibility:hidden;pointer-events:none';\s+document\.body\.appendChild\(probe\);\s+const foot = probe\.getBoundingClientRect\(\)\.bottom;\s+probe\.remove\(\);/);
  // Not the box the page lays the story out in, nor Safari's viewport units.
  assert.doesNotMatch(SOURCE, /settledStep|getComputedStyle/);
  // A turned phone or a resized window starts again from full size; Safari's
  // toolbar coming and going does not.
  assert.match(SOURCE, /const TOOLBAR_SLACK = 120;/);
  assert.match(SOURCE, /if \(window\.innerWidth === f\.width && Math\.abs\(window\.innerHeight - f\.height\) < TOOLBAR_SLACK\) return;\s+fitting\.current = null;\s+setFit\(0\);/);
  // The two examples left are the first two of the front three: the tier
  // list and the game.
  assert.match(SOURCE, /FRONT\.slice\(0, s\.count\)\.map/);
});

// Evan, 10 Oct 2026, iPhone 13 mini in Safari, through #4691 and #4695: the
// fit dropped the third example with about 100px empty above the toolbar.
// Measured off his screenshots (page coordinates, the page's top under the
// status bar at 0): at step 4 the foot ends at 536; the third row is 60px
// and the larger headline 43px; and a fixed box (the sign-in sheet's dim,
// the make screen that cut Make it in half) ends at 608.5, 16px above the
// toolbar.
test('on that phone it stops at step 3, with three examples', () => {
  const { nextStep, FIT_STEPS } = loadTsx(STORY);
  const screen = 608.5;
  const footAt = { 2: 536 + 60 + 43, 3: 536 + 60, 4: 536 };
  assert.equal(nextStep(2, footAt[2], screen), 3, 'the larger headline does not fit');
  assert.equal(nextStep(3, footAt[3], screen), null, 'three examples do');
  // Past the last step there is nothing more to take: the page scrolls.
  assert.equal(nextStep(FIT_STEPS, 900, screen), null);
  assert.equal(nextStep(0, 500, 800), null, 'a screen it fits keeps step 0');
  assert.equal(nextStep(0, 800.4, 800), null, 'half a pixel over still fits');
});

// Evan, 10 Oct 2026: from a "You're in" mail's link the welcome page greets
// the address, "Welcome to Homeroom" with the email on its own line under it,
// and the story fits again with that line in it.
test('a "You\'re in" link\'s address is greeted under the welcome', () => {
  const plain = renderComponent(STORY, 'Story', { primaryClass: 'pill', onStart() {}, onSignIn() {} });
  assert.doesNotMatch(plain, /data-landing-story-email/);
  const html = renderComponent(STORY, 'Story', { primaryClass: 'pill', welcomeEmail: 'ada@example.com', onStart() {}, onSignIn() {} });
  assert.match(html, />Welcome to Homeroom<\/div><div data-landing-story-email="" class="[^"]*">ada@example\.com<\/div>/);
  assert.match(SOURCE, /if \(fittedFor\.current !== welcomeEmail\) \{\s+fittedFor\.current = welcomeEmail;\s+fitting\.current = null;\s+if \(fit !== 0\) \{ setFit\(0\); return; \}\s+\}/);
  // The landing looks the address up from the link's token, through the
  // sign-in screen's own lookup, which also says whether the account is
  // still new (tests/release-link-straight-flow.test.js).
  const landing = fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/auth/landing.tsx'), 'utf8');
  assert.match(landing, /if \(!release \|\| release\.route !== 'signup' \|\| !release\.token\) return undefined;/);
  assert.match(landing, /void Promise\.all\(\[releaseAccountFromToken\(token\), straightLink\(link\) \? waitlistOptions\(\) : null\]\)\.then\(async \(\[account, options\]\) => \{\s+if \(!live\) return;\s+setReleaseEmail\(account\?\.email \?\? null\);/);
  // The story heads the guest Discover in its short version, greeting the
  // address the same way (tests/guest-discover.test.js renders it).
  assert.match(landing, /<Story\s+compact\s+primaryClass=\{PRIMARY_PILL\}\s+welcomeEmail=\{releaseEmail\}/);
});
