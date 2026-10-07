'use strict';

// The first session's card of the idea (frontend/src/features/first-session/
// sketch-card.tsx), on the made screen and on an invite.
//
// 5 October 2026, on Evan's phone: the sketch was a framed mock of the app's
// main screen that scrolled inside the made screen, after grey bars and
// "Sketching <name> from your description…". It read as the app itself, not
// something being made, and the project's tile was a plain letter. Pinned:
//
//   - a FIXED size with nothing that scrolls: each region has its height,
//     the tagline and points are clamped, and only the points that fit four
//     lines are drawn;
//   - CLEARLY BEING MADE: a pill that says so, construction stripes until
//     version one is ready, open dashed rings on the points;
//   - SKETCHING is the same frame with the name in place and a band of light
//     over the lines to come: transform and opacity only, off with reduced
//     motion, and no stack of grey blocks;
//   - its EMOJI is the icon the made screen shows, and the invite sheet's.
//
// Run with: node --test tests/first-session-sketch-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const SRC = read(`${DIR}/sketch-card.tsx`);

const MADE = { slug: 'plant-pal', name: 'Plant Pal', emoji: null, description: null, example: null, conversationId: 12 };
const CARD = { emoji: '🪴', tagline: 'Never forget to water the flat\'s plants', points: ['See which plants need water today', 'Mark one as watered', 'Take turns with your flatmates'] };

const mod = loadTsx(`${DIR}/sketch-card.tsx`);

function sketchCard(props) {
  return renderToHtml(createElement(mod.SketchCard, {
    made: MADE, line: 'Step 2 of 7: Read the description', note: 'Homeroom is making your app. It will message you when the first version is ready to try, or if it has any questions.',
    busy: true, botBuilds: true, built: false, ...props,
  }));
}

test('the card in an answer is read strictly, and the made screen draws it while it comes and once it is here', () => {
  assert.deepEqual(mod.sketchCardOf({ status: 'ready', card: CARD }), CARD);
  assert.deepEqual(mod.sketchCardOf({ card: { ...CARD, points: ['a', 7, '', 'b', 'c', 'd', 'e'] } }).points, ['a', 'b', 'c', 'd']);
  for (const bad of [null, {}, { card: null }, { card: { emoji: '', tagline: 'x' } }, { card: { emoji: '🪴' } }, { card: 'card' }]) {
    assert.equal(mod.sketchCardOf(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(['loading', 'pending', 'ready', 'none', 'failed'].map(mod.showsCard), [true, true, true, false, false]);
  assert.deepEqual(['sketching', 'making', 'ready', 'idea', 'plain'].map(mod.pillLabel), ['Sketching the idea', 'Being made', 'Ready to try', 'Not built yet', '']);
});

test('only the points that fit four lines are drawn, the first always', () => {
  const short = ['One', 'Two', 'Three', 'Four', 'Five'];
  assert.deepEqual(mod.fitPoints(short), ['One', 'Two', 'Three', 'Four']);
  const long = 'x'.repeat(50);
  assert.deepEqual(mod.fitPoints([long, 'Two', 'Three', 'Four']), [long, 'Two', 'Three'], 'a long one takes two lines');
  assert.deepEqual(mod.fitPoints([long, long, 'Three']), [long, long]);
  assert.deepEqual(mod.fitPoints(['x'.repeat(200)]), ['x'.repeat(200)], 'the first, clamped');
  assert.deepEqual(mod.fitPoints([]), []);
});

test('while it is sketched: the same frame, the name in place, a band of light over the lines to come', () => {
  const html = sketchCard({ sketch: { state: 'loading', card: null } });
  assert.match(html, /data-first-session-sketch="loading"/);
  assert.match(html, /data-featured-card="sketching"/);
  assert.match(html, /<h1 id="first-session-made-title" class="truncate text-\[20px\] font-bold leading-6">Plant Pal<\/h1>/);
  assert.match(html, /role="status" class="sr-only">Sketching Plant Pal from your description…<\/p>/);
  assert.match(html, /data-featured-card-stage="sketching"[^>]*>(?:<span[^>]*><\/span>)?Sketching the idea<\/span>/);
  assert.match(html, /motion-safe:animate-card-sweep/);
  assert.match(html, /pointer-events-none absolute inset-0 overflow-hidden motion-reduce:hidden/);
  assert.match(html, /data-first-session-build="">Step 2 of 7: Read the description<\/span>/);
  assert.match(html, /Homeroom is making your app\. It will message you when the first version is ready to try, or if it has any questions\./);
  // No stack of grey blocks, no frame, no words yet.
  assert.doesNotMatch(html, /animate-pulse rounded-(?:md|lg|xl) bg-zinc-200|<iframe|data-featured-card-words/);
  // The example's emoji, when one was picked, is already the icon.
  assert.match(sketchCard({ made: { ...MADE, emoji: '🏃' }, sketch: { state: 'pending', card: null } }), /<span class="transition-\[opacity,transform\][^"]*">🏃<\/span>/);
});

test('once it is here: the idea\'s emoji, tagline and points, clearly being made', () => {
  const html = sketchCard({ sketch: { state: 'ready', card: CARD } });
  assert.match(html, /data-first-session-sketch="ready"/);
  assert.match(html, /data-featured-card="ready"/);
  assert.match(html, />🪴<\/span>/);
  assert.match(html, /<p class="mt-1 line-clamp-2 h-10 text-\[15px\] leading-5 text-zinc-500 dark:text-zinc-400">Never forget to water the flat&#x27;s plants<\/p>/);
  for (const point of CARD.points) assert.match(html, new RegExp(`<span class="line-clamp-2 min-w-0">${point}</span>`));
  assert.equal((html.match(/rounded-full border-\[1\.5px\] border-dashed/g) || []).length, 3, 'an open ring for each point: not built yet');
  assert.match(html, />Being made<\/span>/);
  assert.match(html, /repeating-linear-gradient\(135deg/, 'under construction');
  assert.doesNotMatch(html, /Sketching|animate-card-sweep|role="status"/);
  // Version one ready: no stripes, and it says so.
  const built = sketchCard({ sketch: { state: 'ready', card: CARD }, built: true, busy: false });
  assert.match(built, />Ready to try<\/span>/);
  assert.doesNotMatch(built, /repeating-linear-gradient|status-dot/);
  // Nobody is building it yet.
  assert.match(sketchCard({ sketch: { state: 'ready', card: CARD }, botBuilds: false }), />Not built yet<\/span>/);
});

test('a fixed size, and nothing in it scrolls', () => {
  const html = sketchCard({ sketch: { state: 'ready', card: { ...CARD, tagline: 'word '.repeat(40), points: ['x'.repeat(70), 'y'.repeat(70), 'z'.repeat(70)] } } });
  for (const height of ['h-[148px]', 'h-[204px]', 'h-[42px]']) assert.ok(html.includes(height), height);
  assert.match(html, /class="relative overflow-hidden rounded-\[20px\] bg-white/);
  assert.equal((html.match(/line-clamp-2 min-w-0/g) || []).length, 2, 'two long points fill the four lines');
  assert.doesNotMatch(SRC, /overflow-(?:y-)?(?:auto|scroll)|<iframe/);
  // Motion is transform and opacity only, with none under reduced motion.
  assert.doesNotMatch(SRC, /transition-all|transition-\[(?![^\]]*opacity)[^\]]*\]|animate-pulse rounded-(?:md|lg|xl)/);
  for (const m of SRC.matchAll(/transition-\[([^\]]+)\]/g)) assert.equal(m[1], 'opacity,transform');
  assert.equal((SRC.match(/motion-reduce:transition-none/g) || []).length, 3);
  const config = read('tailwind.config.js');
  assert.match(config, /'card-sweep': \{ from: \{ transform: 'translateX\(-100%\)' \}, to: \{ transform: 'translateX\(250%\)' \} \},/);
  assert.match(config, /animation: \{ 'card-sweep': 'card-sweep 1\.8s ease-in-out infinite' \},/);
});

test('the made screen draws the card, its emoji is the screen\'s icon, and nothing is framed', () => {
  const made = read(`${DIR}/made.tsx`);
  assert.match(made, /import \{ SketchCard, showsCard, useSketch \} from '\.\/sketch-card';/);
  assert.match(made, /\{card \? \(\n\s+<SketchCard made=\{made\} sketch=\{sketch\} line=\{line\} note=\{note\} busy=\{busy\} botBuilds=\{botBuilds && !stalled\} built=\{!making \|\| !!\(fv && fv\.ready\)\} \/>/);
  assert.match(made, /const tile = sketch\.card\?\.emoji \|\| made\.emoji \|\| made\.name\.slice\(0, 1\);/);
  assert.match(made, /made=\{sketch\.card \? \{ \.\.\.made, emoji: sketch\.card\.emoji \} : made\}/, 'the invite sheet shows it too');
  assert.doesNotMatch(made, /<iframe|sketch\.html|sketchCaption/);
  // Rendered with nothing read yet: the card being sketched, not the letter tile.
  const { MadeScreen } = loadTsx(`${DIR}/made.tsx`);
  const html = renderToHtml(createElement(MadeScreen, { made: MADE, me: 'Maya', onContinue() {}, onOpenChat() {} }));
  assert.match(html, /data-featured-card="sketching"/);
  assert.match(html, /data-first-session-build="">Setting it up…<\/span>/);
  // The poll asks past the service worker's cache.
  assert.match(SRC, /fetch\(`\/api\/apps\/\$\{encodeURIComponent\(slug\)\}\/sketch`, \{ credentials: 'same-origin', cache: 'no-store' \}\)/);
});

test('an invite to a project still being built shows the same card, drawn from its words', () => {
  const { MadeForYou } = loadTsx('frontend/src/features/auth/invite-card.tsx');
  const preview = {
    live: true, reason: null, inviter: 'maya', inviterName: 'Maya', inviterMadeIt: true, building: true, note: null, memberCount: 1,
    project: { name: 'Plant Pal', iconEmoji: '🪴', iconUrl: null, description: null, picture: { kind: 'sketch', url: null, darkUrl: null, card: CARD } },
  };
  const html = renderToHtml(createElement(MadeForYou, { preview, primaryClass: 'x', onJoin() {} }));
  assert.match(html, /data-landing-invite-picture="sketch"/);
  assert.match(html, /data-featured-card="ready"/);
  assert.match(html, /Never forget to water the flat&#x27;s plants/);
  assert.match(html, />Being made<\/span>/);
  assert.doesNotMatch(html, /<iframe|first-session-made-title/);
  // Once it is not being made, the card says nothing about it: no pill, no stripes.
  const plain = renderToHtml(createElement(MadeForYou, { preview: { ...preview, building: false }, primaryClass: 'x', onJoin() {} }));
  assert.match(plain, /data-featured-card="ready"/);
  assert.doesNotMatch(plain, /data-featured-card-stage|repeating-linear-gradient/);
  // A picture without a usable card is the plain tile.
  const none = renderToHtml(createElement(MadeForYou, { preview: { ...preview, project: { ...preview.project, picture: { kind: 'sketch', card: null } } }, primaryClass: 'x', onJoin() {} }));
  assert.match(none, /data-landing-invite-picture="tile"/);
});
