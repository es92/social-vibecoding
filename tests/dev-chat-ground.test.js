'use strict';

// THE LIFT SITS ON THE PLATFORM'S GROUND, AND ITS GROUNDS CLIMB IN BOTH
// THEMES.
//
// The three-layer lift (`.dc-lift`, `.dc-lift-strip`, `.dc-lift-session`; the
// `dc-` prefix is the retired dev chat's, which it was built for) gives
// Messages, a project's channel and a request's thread sheet their depth.
// It first did that with two opaque planes over the screen: #f5f5f7 on
// #ffffff in light, #131316 on #1c1c1e in dark. The comment it replaced said
// what that cost: "before this the whole screen sat on the bare wallpaper".
// The platform's ground (the cream, the three washes, the star) was covered
// by a flat white or a flat black. So the planes are glass, and the surface
// tokens the cards inside them fill with stay opaque.
//
// And the tokens had to be re-ordered for dark: --bg-secondary and
// --bg-primary ascend in light and DESCEND in dark, so the sheet built on
// them came out as the darkest thing on the screen. The grounds climb now,
// light mode is untouched, and no .dc- surface reads the raw tokens.
//
// Run with: node --test tests/dev-chat-ground.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_CSS = read('public/css/app.css');

const rule = (sel) => {
  const at = APP_CSS.indexOf(`${sel} {`);
  assert.ok(at > 0, `${sel} must exist`);
  return APP_CSS.slice(at, APP_CSS.indexOf('\n}', at));
};
const alphaOf = (decl) => {
  const m = /rgba\([^)]*?,\s*([\d.]+)\s*\)/.exec(decl);
  return m ? parseFloat(m[1]) : 1;
};
// THE BASE PLANES live in the two theme blocks, `:root` and `.dark`, and are
// what every look starts from. The standard look draws its own over them
// (app.css "WHITE CARDS": the pane is the page, a sheet is the kit's card),
// and that block is held by the last test in this file.
const themeBlock = (open) => {
  const at = APP_CSS.indexOf(`\n${open} {`);
  assert.ok(at >= 0, `the ${open} block must exist`);
  return APP_CSS.slice(at, APP_CSS.indexOf('\n}', at));
};
const BASE = [themeBlock(':root'), themeBlock('.dark')];

test('the two lift PLANES are glass; the surface tokens stay opaque', () => {
  // The distinction is the whole design. --dc-sheet is read by many rules as
  // an opaque INSET inside a card (chips, code blocks, the PR card's strip);
  // making that translucent would let every one of them see the card behind
  // it, which is a different change and a wrong one.
  for (const tok of ['--dc-strip:', '--dc-sheet:', '--dc-raised:']) {
    const decls = APP_CSS.match(new RegExp(`${tok}[^;]+;`, 'g')) || [];
    assert.ok(decls.length >= 2, `${tok} must be declared in both themes`);
    for (const d of decls) {
      assert.doesNotMatch(d, /rgba|transparent/,
        `${tok} is a SURFACE value and must stay opaque: ${d.trim()}`);
    }
  }
  for (const tok of ['--dc-strip-fill:', '--dc-sheet-fill:']) {
    for (const block of BASE) {
      const decls = block.match(new RegExp(`${tok}[^;]+;`, 'g')) || [];
      assert.equal(decls.length, 1, `${tok} must be declared once in each theme`);
      assert.match(decls[0], /rgba\(/, `${tok} must be translucent: ${decls[0].trim()}`);
    }
  }
});

test('the sheet is denser than the strip — the ladder still reads', () => {
  // Transparency is not the point on its own: if both planes had the same
  // alpha the lift would flatten into one pane of glass and the session
  // header would stop reading as a layer above the transcript.
  for (const block of BASE) {
    const fills = (block.match(/--dc-(strip|sheet)-fill:[^;]+;/g) || []);
    assert.equal(fills.length, 2);
    const strip = alphaOf(fills.find((f) => f.includes('strip')));
    const sheet = alphaOf(fills.find((f) => f.includes('sheet')));
    assert.ok(sheet > strip, `the sheet must be denser than the strip (${sheet} vs ${strip})`);
  }
});

test('both planes keep their fills and blur nothing, on every platform', () => {
  // The base rules, at the start of a line: the standard look's own rules
  // for the two classes (WHITE CARDS) are scoped and come earlier in the file.
  for (const [sel, fill] of [['\n.dc-lift-strip', '--dc-strip-fill'], ['\n.dc-lift-session', '--dc-sheet-fill']]) {
    const r = rule(sel);
    assert.match(r, new RegExp(`background-color: var\\(${fill}\\)`), `${sel} is its translucent plane`);
    // Still routed through the token, prefixed and not, so turning it back on
    // stays a one-line change.
    assert.match(r, /backdrop-filter: var\(--dc-frost\)/);
    assert.match(r, /-webkit-backdrop-filter: var\(--dc-frost\)/);
  }
  // No blur on any platform, and no fallback that swaps the planes for the
  // neutral #f5f5f7 / #ffffff on some of them: one colour scheme
  // (app.css "No glass, on any platform").
  assert.match(APP_CSS, /--dc-frost: none;/);
  assert.doesNotMatch(APP_CSS, /\.dc-lift-strip \{ background-color: var\(--dc-strip\); \}/);
  assert.doesNotMatch(APP_CSS, /\.dc-lift-session \{ background-color: var\(--dc-sheet\); \}/);
});

test('the lift takes the running app\'s radius, and neither layer clips', () => {
  // The lift is the move a running app makes, repeated per layer: a sheet
  // that rounds its top corners over the layer above (#app-frame-host). The
  // geometry is asked for BY CLASS, so the three cannot drift apart the way
  // hand-copied radii could.
  const lift = APP_CSS.slice(APP_CSS.indexOf('\n.dc-lift {'));
  const frame = APP_CSS.slice(APP_CSS.indexOf('\n#app-frame-host {'));
  const radius = (block) => (block.match(/border-start-start-radius: ([^;]+);/) || [])[1];
  assert.ok(radius(lift), '.dc-lift declares its radius');
  assert.equal(radius(lift), radius(frame),
    'the layers take the running app\'s radius, not one of their own');
  // A sheet's shoulder is the area INSIDE its border box and OUTSIDE its
  // arc, so `overflow: hidden` would remove exactly the thing this is for.
  assert.doesNotMatch(lift.slice(0, lift.indexOf('\n.dc-lift-strip')), /overflow: hidden/);
});

test('--bubble-bg is retired; --accent-ink is not', () => {
  // --bubble-bg existed only because --bg-primary IS the page ground in dark,
  // so a bubble drawn on it vanished. It had no other reader.
  assert.doesNotMatch(APP_CSS, /--bubble-bg\s*:/, 'the token is gone');
  assert.doesNotMatch(APP_CSS, /var\(--bubble-bg\)/, 'and so is every use');

  // --accent-ink STAYS. It is the near-black-on-light-accent pair, and
  // .messages-state button is still a real accent fill: retiring it would
  // take a live button's contrast with it.
  assert.match(APP_CSS, /--accent-ink: #ffffff;/);
  assert.match(APP_CSS, /--accent-ink: #0b0b0c;/);
  assert.match(rule('\n.messages-state button'), /color: var\(--accent-ink\)/);
});

test('the three GROUNDS ascend in both themes; the card only has to differ', () => {
  // The bug: --bg-secondary / --bg-primary ascend in light (#f5f5f7 →
  // #ffffff) and DESCEND in dark (#1c1c1e → #0b0b0c). The lift was built on
  // that pairing, so in dark the sheet came out as the darkest thing on the
  // screen: a near-black hole in the #0b0d1b wallpaper, with the strip above
  // it lighter than both. Measured before the fix: wallpaper (11,13,27) →
  // strip (28,28,30) → sheet (11,11,12).
  //
  // The GROUNDS are what must climb: each layer nearer the reader is lighter
  // than the one behind it, in both themes. A CARD is the other kind of
  // step (on white a grey inset, on near-black a lighter raise), so its
  // direction flips by theme and only its DISTANCE from the sheet is the
  // invariant. Asserting "lighter" on it is what a first draft of this test
  // did, and light mode caught it.
  //
  // What climbs from the PAGE is what the planes paint on it, the `-solid`
  // colours (each plane's fill over the wallpaper's base): the strip is the
  // ground's own colour at a fraction of its alpha, so it never sinks below
  // the page, and the sheet over it is lighter again. The surface values
  // (--dc-strip, --dc-sheet) climb between themselves; neither is painted on
  // the page (the planes take their fills, asserted above). The light page
  // is the export's cream again (#fffeea, 98% luminance), which is lighter
  // than the neutral #f5f5f7 a card's inset takes, so the page is compared
  // with the planes that lie on it, not with that inset value.
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const val = (block, name) => {
    const m = block.match(new RegExp(`${name}: (#[0-9a-f]{6});`));
    assert.ok(m, `${name} must be declared`);
    return m[1];
  };
  const light = APP_CSS.slice(0, APP_CSS.indexOf('\n.dark {'));
  const dark = APP_CSS.slice(APP_CSS.indexOf('\n.dark {'));
  for (const [theme, block, ground] of [
    ['light', light, '#fffeea'],
    ['dark', dark, '#0b0d1b'],
  ]) {
    assert.ok(APP_CSS.includes(`--home-ground: ${ground};`), `${theme}: the wallpaper's ground is ${ground}`);
    const stripPlane = val(block, '--dc-strip-solid');
    const sheetPlane = val(block, '--dc-sheet-solid');
    assert.ok(lum(stripPlane) >= lum(ground),
      `${theme}: the strip (${stripPlane}) must not sink below the page (${ground})`);
    assert.ok(lum(sheetPlane) > lum(stripPlane),
      `${theme}: the sheet (${sheetPlane}) must be nearer the reader than the strip (${stripPlane})`);
    assert.ok(lum(val(block, '--dc-sheet')) > lum(val(block, '--dc-strip')),
      `${theme}: the sheet's surface value must be nearer the reader than the strip's`);
    const sheet = val(block, '--dc-sheet');
    const raised = val(block, '--dc-raised');
    assert.ok(Math.abs(lum(raised) - lum(sheet)) >= 8,
      `${theme}: a card (${raised}) must be visibly off the sheet (${sheet})`);
  }
});

test('light mode is byte-identical: only dark moved', () => {
  // The ladder's light values ARE the tokens the lift shipped with, so a
  // reader who liked light mode sees exactly what they saw.
  const light = APP_CSS.slice(0, APP_CSS.indexOf('\n.dark {'));
  assert.match(light, /--dc-strip: #f5f5f7;/, "--bg-secondary's value");
  assert.match(light, /--dc-sheet: #ffffff;/, "--bg-primary's value");
  assert.match(light, /--dc-raised: #f5f5f7;/, "--bg-secondary's value again");
});

test('no .dc- surface reads the raw surface tokens', () => {
  // The sweep this pins. Moving the sheet in dark left every OTHER card on
  // the lift sitting on the wrong step: a rule on --bg-secondary was flush
  // with the new sheet (both #1c1c1e) and one on --bg-primary was DARKER
  // than it (#0b0b0c), a hole rather than an inset.
  //
  // The swap is light-identical BY CONSTRUCTION, which is the only reason it
  // could be done mechanically: --dc-sheet is --bg-primary's light value and
  // --dc-raised is --bg-secondary's, asserted above.
  const rules = APP_CSS.split('}');
  const offenders = [];
  for (const r of rules) {
    const head = r.slice(0, r.indexOf('{'));
    if (!/\.dc-[a-z0-9-]/.test(head)) continue;
    if (/background(-color)?\s*:\s*var\(--bg-(primary|secondary)\)/.test(r)) {
      offenders.push(head.trim().split('\n').pop().trim());
    }
  }
  assert.deepEqual(offenders, [],
    'a .dc- surface must take the ladder, not the raw token');
});

test('the standard look: the pane is the page and a sheet is the kit\'s card (WHITE CARDS)', () => {
  // 20 Nov 2026: the standard look (html:root, Standard (WIP)
  // too) takes one idea of "Paper, simplified, with brand styling". The pane
  // a screen stands on is the page itself, and a sheet is the white card Home
  // and Communities already draw (the kit's --wip-card-bg and hairline). It
  // is done at the plane tokens, in a block of its own, so the base above
  // stays what the other looks start from.
  const start = APP_CSS.indexOf('── WHITE CARDS (20 Nov 2026)');
  const end = APP_CSS.indexOf('END OF WHITE CARDS.');
  assert.ok(start > 0 && end > start, 'app.css has the block, start to end');
  const block = APP_CSS.slice(APP_CSS.indexOf('*/', start) + 2, APP_CSS.lastIndexOf('/*', end))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const ruleIn = (sel) => {
    const at = block.indexOf(`\n${sel} {`);
    assert.ok(at >= 0, `the block has ${sel}`);
    return block.slice(at, block.indexOf('\n}', at));
  };
  const light = ruleIn('html:root');
  const dark = ruleIn('html:root.dark');
  // The pane is clear; a sheet, and the same colour opaque for what content
  // passes behind or what floats, is the kit's card in both themes.
  assert.match(light, /--dc-strip-fill: transparent;/);
  assert.match(light, /--dc-sheet-fill: var\(--wip-card-bg\);/);
  assert.match(light, /--dc-sheet-solid: var\(--wip-card-bg\);/);
  assert.doesNotMatch(dark, /--dc-(strip|sheet)-/, 'dark reads the same tokens: the kit\'s card is its dark card there');
  // The pane draws no edge and no lift; the sheet wears the kit card's one
  // hairline. Neither blurs: the base rules' --dc-frost is none, and this
  // block adds no filter of its own.
  assert.match(ruleIn('html:root .dc-lift-strip'), /border-top-color: transparent;\s*box-shadow: none;/);
  assert.match(ruleIn('html:root .dc-lift-session'),
    /border-top-color: transparent;\s*box-shadow: inset 0 0 0 1px var\(--wip-card-line\), var\(--wip-card-shadow\);/);
  assert.doesNotMatch(block, /backdrop-filter|blur\(/);
  // Colours are written in the two token rules alone.
  for (const r of block.split('}')) {
    const head = r.slice(0, r.indexOf('{')).trim();
    if (head === 'html:root' || head === 'html:root.dark') continue;
    assert.doesNotMatch(r, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, `${head} writes a colour of its own`);
  }

  // THE CARD IS A COLOUR, NOT A LOOP. The kit's base list declares
  // --wip-card-bg as var(--dc-sheet-solid); this block points
  // --dc-sheet-solid at --wip-card-bg. That holds only because the kit's own
  // token rules, light and dark, end on a colour for it. And a sheet is never
  // darker than the page it lies on: the card is nearer the reader than the
  // wallpaper's ground in both themes, whatever cream that ground is.
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const cardIn = (theme) => {
    const re = new RegExp(`\\nhtml:root${theme === 'dark' ? '\\.dark' : ''} \\{([^}]*)\\}`, 'g');
    const decls = [...APP_CSS.matchAll(re)].map((m) => m[1].match(/--wip-card-bg:\s*([^;]+);/)).filter(Boolean).map((m) => m[1].trim());
    assert.ok(decls.length > 0, `${theme}: the kit declares its card`);
    const last = decls[decls.length - 1];
    assert.match(last, /^#[0-9a-f]{6}$/, `${theme}: the kit's card ends on a colour (${last})`);
    return last;
  };
  const grounds = [...APP_CSS.matchAll(/--home-ground: (#[0-9a-f]{6});/g)].map((m) => m[1]);
  assert.ok(grounds.length >= 2, 'the wallpaper\'s ground, light then dark');
  for (const [theme, ground] of [['light', grounds[0]], ['dark', grounds[1]]]) {
    const card = cardIn(theme);
    assert.ok(lum(card) > lum(ground), `${theme}: the sheet (${card}) must be nearer the reader than the page (${ground})`);
  }

  // On the white card somebody else's bubble is cream, off the card by a
  // visible step; your own keeps its tint (no rule here touches it).
  const bubble = light.match(/--wip-bubble-bg: (#[0-9a-f]{6});/);
  assert.ok(bubble, 'the other side\'s bubble is a colour in light');
  assert.ok(lum(cardIn('light')) - lum(bubble[1]) >= 8, `the bubble (${bubble[1]}) reads on the card`);
  assert.match(ruleIn('html:root .messages-message:not(.messages-message-self) .messages-bubble,\nhtml:root .gc-bubble:not(.gc-bubble-self)'),
    /background-color: var\(--wip-bubble-bg\);/);
  assert.doesNotMatch(block, /messages-message-self \.messages-bubble|\.gc-bubble-self \{/);

  // NOTHING WHITE ON THE WHITE CARD WITHOUT AN EDGE. What was drawn white on
  // the off-white sheet (the reply boxes, the discs, Settings' white cards)
  // takes the kit card's hairline; a row under the pointer or open takes the
  // kit's soft row ground, not the white veil it wore. And a phone's
  // Messages list stands on the card, as the conversation over it does.
  const messages = ruleIn('html:root :is(.messages-layout, .dev-ws-discussion, .side-panel-head, #ai-screen .ai-askbar)');
  assert.match(messages, /--messages-selected: var\(--wip-item-hover\);/);
  assert.match(messages, /--messages-disc-shadow: inset 0 0 0 1px var\(--wip-card-line\);/);
  // One message box (27 Nov 2026): the group chat's own card is gone, and
  // its box is Messages' card, which reads --messages-disc-shadow above.
  assert.match(ruleIn('html:root #settings-root .ui-card.bg-white'),
    /box-shadow: inset 0 0 0 1px var\(--wip-card-line\);/);
  assert.match(ruleIn('html:root .messages-layout.messages-drawer'), /background-color: var\(--wip-card-bg\);/);
});
