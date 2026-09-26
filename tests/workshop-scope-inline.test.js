'use strict';

// #2837: on a large desktop window the app's scope chip joins the tab pill's
// row.
//
// The chip ("(icon) App name ⌄") used to have a row of its own above the
// Workshop's tab pill. On a wide window that row put it alone in the middle
// of the page. The 760px reading column is centred in a lot of space, and on
// By stage and Needs you everything under it spans the width. So the chip
// was a small pill on its own row, lined up with nothing.
//
// It can't go INSIDE the pill's row: the pill (444px) and the grouping ear
// (at least 240px) already fill most of the 760px column. So when the space
// left of the column is wide enough, the chip moves there, on the pill's row,
// its right edge 12px from the pill's left edge. workshop.tsx measures that
// space (`useScopeInline`) and renders `data-ws-scope-inline` on the Workshop
// root. app.css then moves the chip. Nothing else in the row moves.
//
// What is pinned here:
//   1. the fit rule, as numbers;
//   2. the markup the CSS relies on, from a real render of the Workshop;
//   3. the CSS, and that its numbers match the ones the measurement uses;
//   4. that a phone never gets the attribute.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const WORKSHOP_PATH = 'frontend/src/features/dev-board/workshop/workshop.tsx';
const WORKSHOP = read(WORKSHOP_PATH);
const CSS = read('public/css/app.css');

/** Render the app's Workshop (All items), with a published view for `slug`. */
function renderWorkshop(slug) {
  const real = loadTsx('frontend/src/features/dev-board/card/cards-store.ts');
  const view = { ...real.EMPTY_WORKSHOP_VIEW, loading: false, slug, tab: 'all' };
  const store = { get: () => view, subscribe: () => () => {} };
  const mod = loadTsx(WORKSHOP_PATH, {
    stubs: { '../card/cards-store': { ...real, devWorkshopStore: store } },
  });
  return { mod, html: renderToHtml(createElement(mod.DevWorkshop, {})) };
}

test('#2837: the chip goes beside the pill only when the space left of the column holds it', () => {
  const { scopeFitsInline } = loadTsx(WORKSHOP_PATH);
  // Numbers from real layouts, with a 142px "Homeroom" chip. It needs
  // 142 + 12 + 12 = 166px.
  //   1700px window, sidebar folded: gutter about 470px. Fits.
  assert.equal(scopeFitsInline(470, 142), true);
  //   1280px window, sidebar open (224px + 2 x 24px gutters): about 124px. No.
  assert.equal(scopeFitsInline(124, 142), false);
  //   Exactly enough fits, one pixel less does not.
  assert.equal(scopeFitsInline(166, 142), true);
  assert.equal(scopeFitsInline(165, 142), false);
  // A long name is capped at 220px, because it truncates there. So a 400px
  // chip needs 244px, not 424px.
  assert.equal(scopeFitsInline(244, 400), true);
  assert.equal(scopeFitsInline(243, 400), false);
  // A hidden chip (a phone, `display: none`) measures 0 and never fits, so the
  // attribute turns off on the way down from a wide window.
  assert.equal(scopeFitsInline(900, 0), false);
  // And a column flush with the page (a phone, a narrow window) has no gutter.
  assert.equal(scopeFitsInline(0, 142), false);
});

test('#2837: the render the CSS relies on — chip in its wrapper, wrapper right before the tab strip', () => {
  const { html } = renderWorkshop('notes-ab12');
  // FIRST RENDER HAS NO ATTRIBUTE. It comes from a layout effect, which runs
  // before paint in a browser and never under a static render. So the markup
  // is the same at every width, and the chip's own row is the fallback.
  assert.match(html, /^<div class="dev-ws" data-ws-tab="all">/);
  assert.doesNotMatch(html, /data-ws-scope-inline/);
  // `.dev-ws > .dev-ws-scope > button`: the chip is the wrapper's direct child,
  // and the wrapper is `.dev-ws`'s direct child, placed right before the tab
  // strip. With a height of 0 and -10px margin it takes no space, so the
  // strip lands where the wrapper was and the chip's `top: 0` matches it.
  assert.match(html,
    /^<div class="dev-ws" data-ws-tab="all"><div class="dev-ws-scope" data-ws-scope=""><button id="dev-ws-scope-chip" type="button" class="[^"]*\bh-9\b[^"]*"[^>]*>.*?<\/button><\/div><div class="dev-ws-tabs" data-ws-tabs="">/);
  // The ids dapp.json selects on are unchanged.
  assert.match(html, /id="dev-ws-scope-chip"/);
  assert.match(html, /aria-controls="dev-ws-scope-chip-picker"/);
});

test('#2837: no app, no chip, no measurement', () => {
  const { html } = renderWorkshop('');
  assert.doesNotMatch(html, /data-ws-scope/);
  // The hook is only switched on when the Workshop has an app.
  assert.match(WORKSHOP, /const scopeInline = useScopeInline\(hostRef, !!v\.slug\);/);
});

test('#2837: the Workshop root carries the attribute from state, not from a DOM write', () => {
  assert.match(WORKSHOP,
    /className="dev-ws"\n\s+data-ws-tab=\{tab\}\n\s+\{\.\.\.\(scopeInline \? \{ 'data-ws-scope-inline': '' \} : \{\}\)\}/);
  const at = WORKSHOP.indexOf('function useScopeInline(');
  const hook = WORKSHOP.slice(at, WORKSHOP.indexOf('\n}\n', at));
  // Measured before paint, against #dev-body — the content area, which already
  // reflects the sidebar, its folding, and a side panel.
  assert.match(hook, /useLayoutEffect\(\(\) => \{/);
  assert.match(hook, /host\.closest<HTMLElement>\('#dev-body'\)/);
  assert.match(hook, /setInline\(scopeFitsInline\(s\.left - b\.left, c\.width\)\)/);
  // Re-measured when the window or sidebar changes the body, and when the chip's
  // name changes (the apps list arrives after the first render).
  assert.match(hook, /ro\.observe\(body\);/);
  assert.match(hook, /ro\.observe\(chip\);/);
  assert.ok(!/setAttribute|dataset/.test(hook), 'React renders the attribute; the hook only answers');
});

test('#2837: the CSS puts the chip left of the pill, on its row, without moving the pill', () => {
  // The wrapper takes no space and gives back `.dev-ws`'s 10px gap, so the
  // tab strip sits where it sits when there is no chip.
  assert.match(CSS, /\.dev-ws \{ display: flex; flex-direction: column; gap: 10px; \}/,
    'the column gap the -10px margin gives back');
  assert.match(CSS,
    /\.dev-ws\[data-ws-scope-inline\] > \.dev-ws-scope:not\(:has\(> \[role='menu'\]\)\) \{\n  height: 0;\n  margin-bottom: -10px;\n\}/);
  assert.match(CSS, /\.dev-ws\[data-ws-scope-inline\] > \.dev-ws-scope \{ position: relative; \}/);
  // The chip: out of flow, top edge level with the pill's, right edge 12px
  // left of the pill's left edge, and capped at the width the fit rule uses.
  const chip = CSS.match(/\.dev-ws\[data-ws-scope-inline\] > \.dev-ws-scope > button \{([^}]*)\}/);
  assert.ok(chip, 'the inline chip rule exists');
  assert.match(chip[1], /position: absolute;/);
  assert.match(chip[1], /top: 0;/);
  assert.match(chip[1], /right: calc\(100% \+ 12px\);/);
  assert.match(chip[1], /max-width: 220px;/);
  // ONE PAIR OF NUMBERS: the measurement and the stylesheet must agree, or the
  // chip is placed where the measurement said it would not fit.
  assert.match(WORKSHOP, /const SCOPE_INLINE_MAX_PX = 220;/);
  assert.match(WORKSHOP, /const SCOPE_INLINE_GAP_PX = 12;/);
  // The panel still opens in place, level with the chip, capped so it reads
  // as the chip's menu.
  assert.match(CSS, /\.dev-ws\[data-ws-scope-inline\] > \.dev-ws-scope > \[role='menu'\] \{ max-width: 420px; \}/);
  // The chip is 36px tall (`h-9`) because the desktop pill's track is 36px:
  // 32px tabs plus 2px padding on each side. `top: 0` depends on that. The
  // padding is the pill's and the "+"'s own since #2934, which drew the "+"
  // as a circle of its own beside the pill; the track only lines the two up.
  assert.match(CSS, /\.dev-ws-tabtrack \{\n    display: inline-flex; align-items: center; gap: 6px;\n  \}/);
  assert.match(CSS, /\.dev-ws-tablist, \.dev-ws-tabtrack > \.dev-ws-plus \{\n    padding: 2px;/);
  assert.match(CSS, /\.dev-ws-tab \{\n    flex: 0 0 auto; flex-direction: row; gap: 7px;\n    height: 32px;/);
});

test('#2837: the phone layout is untouched', () => {
  // Below 700px the chip is still hidden and the header is the switcher
  // (#2768). The inline rules only apply with the attribute, and a hidden chip
  // never fits.
  assert.match(CSS, /@media \(max-width: 699\.98px\) \{\n  \.dev-ws-scope > button \{ display: none; \}\n  \.dev-ws-scope:not\(:has\(> \[role='menu'\]\)\) \{ display: none; \}\n\}/);
  const inlineRules = CSS.match(/^[^\n]*data-ws-scope-inline[^\n]*$/gm) || [];
  assert.equal(inlineRules.length, 5, 'four rules, and the one comment line that names the attribute');
  for (const line of inlineRules.filter((l) => l.startsWith('.dev-ws['))) {
    assert.ok(line.startsWith('.dev-ws[data-ws-scope-inline] > .dev-ws-scope'),
      `scoped to the chip's wrapper: ${line}`);
  }
});
