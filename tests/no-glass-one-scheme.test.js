'use strict';

// ONE COLOUR SCHEME, NO BLUR (app.css "No glass, on any platform"). #787 and
// #3104 took the frosted glass off inside the iOS app only, which had the app
// draw the neutral no-blur fallbacks (#ffffff / #f5f5f7) while Safari, the
// PWA, Android and desktop drew warm glass: two colour schemes for one
// product. Now no platform blurs, the planes keep their translucent fills,
// and what content passes behind is solid in the plane colours, the same on
// every platform. These tests pin that there is exactly one scheme.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');

function rgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(text) {
  const m = text.match(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}
function token(block, name) {
  const m = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(m, `--${name} is declared`);
  return m[1].trim();
}
// The block that declares the light plane tokens, and the dark one.
function themeBlocks() {
  const starts = [...css.matchAll(/--dc-sheet-fill:/g)].map((m) => m.index);
  assert.equal(starts.length, 2, 'the plane fill is declared once per theme');
  return starts.map((at) => css.slice(css.lastIndexOf('{', at), css.indexOf('\n}', at)));
}

test('no platform blurs: the frost token is none, declared once', () => {
  const decls = [...css.matchAll(/--dc-frost\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.deepEqual(decls, ['none'], 'one declaration, for everyone, and it is none');
});

test('no surface is swapped for a different colour on any platform', () => {
  assert.doesNotMatch(css, /:where\(html\.un-ios/, 'no iPhone twins are left');
  assert.doesNotMatch(css, /@supports not \(\(backdrop-filter/,
    'no no-backdrop-filter fallback is left to swap a fill for the neutral one');
  assert.doesNotMatch(css, /html\.un-ios(\.in-native-webview)? \{\s*--dc-frost/,
    'the frost is not turned off per platform any more; it is off at the token');
});

test('the solid plane colours are the fills composited over the wallpaper', () => {
  // The wallpaper grounds the planes sit on: light cream, dark night.
  const grounds = [[244, 242, 228], [11, 13, 27]];
  themeBlocks().forEach((block, i) => {
    for (const [fill, solid] of [['dc-sheet-fill', 'dc-sheet-solid'], ['dc-strip-fill', 'dc-strip-solid']]) {
      const [r, g, b, a] = rgba(token(block, fill));
      const want = [r, g, b].map((c, k) => Math.round(c * a + grounds[i][k] * (1 - a)));
      const got = rgb(token(block, solid));
      got.forEach((c, k) => assert.ok(Math.abs(c - want[k]) <= 1,
        `${i ? 'dark' : 'light'} --${solid} ${got} is --${fill} over the ground (${want})`));
    }
  });
});

test('what content scrolls or slides behind is solid, in the plane colour', () => {
  const solid = [
    [/\.dc-lift-panel \{ background-color: var\(--dc-sheet-solid\); \}/, 'the bell and Homeroom menu sheets'],
    [/\.un-sheet, \.un-sheet::after, \.un-panel, \.un-panel::after,[\s\S]*?\{\s*background-color: var\(--dc-sheet-solid\);\s*\}/, 'kit sheets and panels'],
    [/\.un-modal \{ background-color: var\(--dc-sheet\); \}/, 'kit dialogs (a 95% fill, so the opaque sheet)'],
    [/\.un-modal:has\(#feedback-form\) \{ background-color: var\(--dc-sheet-solid\); \}/, 'Send Feedback, in the plane colour like the sheets'],
    [/\.dev-ws-pane-head, \.dev-ws-pane-body \{ background-color: var\(--dc-sheet-solid\); \}/, 'the Workshop pane, head and body together'],
    // The Browse list's card and its empty note, on a phone. Its search and
    // filters sit on the ground above it now and scroll with it, so there is
    // no pinned head for the rows to pass behind.
    [/@media \(max-width: 767px\) \{\s*#browse-screen \.browse-pane-body,\s*#browse-screen \.browse-pane-note \{ background-color: var\(--dc-sheet-solid\); \}/, 'the Browse card, on a phone, with its note'],
  ];
  for (const [re, what] of solid) assert.match(css, re, `${what} is solid`);
});

// THE GLASS LOOK, FAKED, where content passes behind a surface over the
// fixed wallpaper: the tab bar, the parked strip, the header and the
// signed-out landing header. What the glass showed there never changed (the
// tint over the washes), so each paints exactly that once, from one shared
// viewport-sized fixed layer clipped to the surface, with no filter anywhere.
function block(selectorStart) {
  const at = css.indexOf(selectorStart);
  assert.ok(at >= 0, `found ${selectorStart.slice(0, 40)}`);
  return css.slice(at, css.indexOf('}', at) + 1);
}

test('one shared faked layer: the tint over the washes, fixed to the viewport', () => {
  const layer = block('.platform-tabs::before,\n.platform-parked::before,');
  for (const sel of ['#platform-header::before', 'html[data-browser-scroller] #landing-header::before']) {
    assert.ok(layer.includes(sel), `${sel} shares the layer`);
  }
  assert.match(layer, /content: '';\s*position: fixed;\s*inset: 0;\s*z-index: -1;\s*pointer-events: none;/);
  assert.match(layer, /linear-gradient\(var\(--fake-glass-tint, var\(--dc-sheet-fill\)\), var\(--fake-glass-tint, var\(--dc-sheet-fill\)\)\),\s*var\(--home-washes, var\(--dc-sheet-solid\)\);/,
    'the surface\'s glass tint (the pane fill by default) over the washes, solid where a route has none');
});

test('each faked surface is see-through to its layer and clips it', () => {
  assert.match(css, /\n\.platform-tabs \{\s*background-color: transparent;\s*clip-path: inset\(0\);\s*\}/, 'the tab bar');
  assert.match(css, /\n\.platform-parked \{\s*background-color: transparent;\s*clip-path: inset\(0\);\s*\}/, 'the parked strip');
  assert.match(css, /#platform-header \{\s*background-color: transparent;\s*clip-path: inset\(0 round 0 0 1\.25rem 1\.25rem\);\s*\}/,
    'the header, clipped to its own rounded-b-2xl notch (1.25rem, tailwind.config.js)');
  assert.match(block('html[data-browser-scroller] #landing-header {\n  --fake-glass-tint'),
    /--fake-glass-tint: color-mix\(in srgb, var\(--home-ground\) 92%, transparent\);\s*background: transparent;\s*clip-path: inset\(0\);/,
    'the landing header keeps its own 92% ground tint');
  assert.doesNotMatch(css, /(\.platform-tabs|\.platform-parked|#platform-header|#landing-header)[^{]*\{[^}]*backdrop-filter: blur/,
    'no live blur came back with the look');
});

test('a faked bar whose edge is a border redraws it above the layer', () => {
  // The layer paints over its surface's own border, so on a phone the tab
  // bar and the parked strip draw their top hairline again on top.
  const phone = css.slice(css.indexOf('@media (max-width: 767px) {\n  .platform-tabs::after,\n  .platform-parked::after {'));
  assert.match(phone.slice(0, phone.indexOf('}\n}') + 3),
    /position: absolute;\s*top: -1px;\s*left: 0;\s*right: 0;\s*height: 1px;\s*background: var\(--app-sheet-line\);/);
});

test('where nothing passes behind, the plain translucent fill is the glass', () => {
  // The docked desktop rail has the page laid out beside it; the scrolled
  // session header and the Global Chat composer sit in flow beside their
  // scrollers. Only the fixed wallpaper is behind them, so their own
  // translucent fills are exact, borders and shadows included.
  const desk = css.slice(css.indexOf('@media (min-width: 768px) {\n  .platform-tabs {\n    background-color: var(--dc-sheet-fill);'));
  assert.match(desk.slice(0, desk.indexOf('\n}') + 2), /clip-path: none;[\s\S]*?\.platform-tabs::before,\s*\.platform-parked::before \{ content: none; \}[\s\S]*?\.platform-parked \{ clip-path: none; \}/,
    'the docked rail draws its fill, not the fake, and the parked row inside it drops its layer');
  assert.match(block('#dc-session-header.un-scrolled {'), /background-color: var\(--dc-strip-fill\);/);
  assert.doesNotMatch(css, /#dc-session-header\.un-scrolled \{ background-color: var\(--dc-strip(-solid)?\); \}/);
  assert.match(block('.global-chat-composer {\n  display: flex;'), /background: var\(--dc-sheet-fill\);[\s\S]*?box-shadow: 0 -5px 18px/);
  assert.doesNotMatch(css, /\.global-chat-composer \{ background: var\(--dc-sheet(-solid)?\); \}/);
  // The peeked rail floats over the page: solid, unclipped, shadow intact.
  const peek = block('.platform-tabs.platform-tabs-peek {');
  assert.match(peek, /background-color: var\(--dc-sheet-solid\);/);
  assert.match(peek, /box-shadow: 0 8px 32px/);
});

test('the fake and the wallpaper paint the same washes', () => {
  // One token, so the bar's layer lines up with the body's pixel for pixel
  // and cannot drift when the wallpaper changes: every wallpaper variant
  // (light, dark, phone, wide) draws its star and grain over --home-washes.
  const wallpapers = [...css.matchAll(/--home-wallpaper:\s*([\s\S]*?);/g)].map((m) => m[1]);
  assert.equal(wallpapers.length, 4, 'four wallpaper variants');
  for (const w of wallpapers) assert.match(w, /var\(--home-grain\)[^,]*,\s*var\(--home-washes\)$/);
  const washes = [...css.matchAll(/--home-washes:\s*([\s\S]*?);/g)].map((m) => m[1]);
  assert.equal(washes.length, 4, 'each variant defines its washes');
  for (const w of washes) {
    assert.doesNotMatch(w, /home-star|home-grain/, 'no star or grain: a blur erased both');
    assert.match(w, /var\(--home-ground\)$/, 'the ground colour closes the list');
  }
});

test('the planes that only sit on the wallpaper keep their fills', () => {
  for (const sel of ['.dc-lift-strip', '.dc-lift-session', '.dev-ws-strip', '.dev-topic-sheet',
    '.gc-event-box', '.global-chat-result']) {
    const esc = sel.replace(/[.#]/g, (c) => `\\${c}`);
    assert.doesNotMatch(css, new RegExp(`(^|\\n)${esc} \\{ background(-color)?: var\\(--dc-(sheet|strip)(-solid)?\\); \\}`),
      `${sel} is never swapped for an opaque fill`);
  }
});

// WORKSHOP AND PROFILE WEAR THE PLANE COLOUR, like Discover. Their white
// cards read as cutouts on the wallpaper beside Discover's warm pane, so the
// grouped-list primitive has a `plane` tone (--dc-sheet-solid, which follows
// the dark theme) and those two screens ask for it; the default stays white.
test('Workshop and Profile draw their cards in the plane colour', () => {
  const primitive = fs.readFileSync(path.join(root, 'frontend/@/components/ui/grouped-list.tsx'), 'utf8');
  assert.match(primitive, /export const PLANE_FILL = 'bg-\[color:var\(--dc-sheet-solid\)\]';/);
  assert.match(primitive, /tone: \{\s*card: 'bg-white dark:bg-zinc-900',\s*plane: 'bg-\[color:var\(--dc-sheet-solid\)\]',\s*\}/);
  assert.match(primitive, /defaultVariants: \{ tone: 'card' \}/, 'every other list keeps the white card');
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const workshop = read('frontend/src/features/workshop/index.tsx');
  // #workshop-list holds one card per audience section (Communities, Groups,
  // Just you), so the plane tone is on each section's card, not the wrapper.
  assert.match(workshop, /<div id="workshop-list">/);
  assert.match(workshop, /<section data-workshop-section=\{audience\}[\s\S]*?<GroupedList tone="plane">/);
  assert.doesNotMatch(workshop, /<GroupedList(?![^>]*tone="plane")[^>]*>/,
    'every list on the Workshop screen (the app list, the per-app item groups, their skeleton) is a plane list');
  assert.match(read('frontend/src/features/profile/account-panel.tsx'), /<GroupedList className="mx-0" tone="plane">/);
  const friends = read('frontend/src/features/profile/friends-section.tsx');
  for (const id of ['profile-friend-requests', 'profile-friends-list', 'profile-friend-sent']) {
    assert.match(friends, new RegExp(`<GroupedList id="${id}"[^>]*tone="plane">`), `${id} is a plane list`);
  }
  const profile = read('frontend/src/features/profile/profile-view.tsx');
  assert.doesNotMatch(profile, /bg-white/, 'nothing on the profile screen is a white cutout');
  assert.doesNotMatch(friends, /bg-white/);
  assert.doesNotMatch(read('frontend/src/features/profile/public-profile-card.tsx'), /bg-white dark:bg-zinc-900 p-5/);
  assert.doesNotMatch(read('frontend/src/features/friends/friend-search.tsx'), /bg-white/,
    'the friend search results under Friends are the plane colour too');
});
