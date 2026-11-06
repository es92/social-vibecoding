// "A label over a group" has TWO spellings in this product, and the audit
// (#2383 / request #2447) found six.
//
// ── The two that stay ──────────────────────────────────────────────────
//
//   @/components/ui/field's      SectionHeading  the FORM-SECTION heading:
//                                bold 14px in the primary ink, tight above the
//                                block it names, with an optional blurb under
//                                it. Twenty-five settings sections open with
//                                it.
//   @/components/ui/grouped-list's SectionHeader the CARD-GROUP label: 15px
//                                regular in the secondary ink, floating in the
//                                `px-4` gutter above a card of hairline-
//                                separated rows.
//
// The difference is the SHAPE being labelled, not a preference, which is why
// this file asserts a CHOICE per site rather than one heading everywhere.
//
// ── What it pins ───────────────────────────────────────────────────────
//
// Half A: each converted site emits byte-for-byte what the primitive emits —
// rendered, not grepped, so a copy that drifts back into a hand-written class
// string fails here rather than in dark mode on somebody's phone. Plus: each
// primitive's class strings exist in exactly ONE source file, which is the
// regression this request actually fixed (settings/sections/usernode-ui.tsx
// re-declared both of SectionHeading's strings verbatim).
//
// Half B: the separator recipe. `border-<side> border-zinc-200
// dark:border-zinc-<n>` is spelled ~40 times across the product and `<n>` is
// 800 everywhere but a named, reasoned allowlist. This is deliberately NOT a
// file-wide colour scan: `dark:border-zinc-700` is correct and common for a
// CARD's own edge and for an input's ring (@/components/ui/input.tsx alone has
// six), so the assertion is anchored to the separator SLOT — a directional
// border paired with the `border-zinc-200` light value.
//
// Run with: node --test tests/section-heading-primitives.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement, ROOT } = require('./lib/render-tsx');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const FIELD_PATH = 'frontend/@/components/ui/field.tsx';
const GROUPED_PATH = 'frontend/@/components/ui/grouped-list.tsx';

const { SectionHeading } = loadTsx(FIELD_PATH);
const { SectionHeader } = loadTsx(GROUPED_PATH);

/** What the form-section heading renders, as markup. `blurb` is its children. */
const headingHtml = (props, blurb) => renderToHtml(
  blurb === undefined
    ? createElement(SectionHeading, props)
    : createElement(SectionHeading, props, blurb),
);
/** What the card-group label renders, as markup. */
const headerHtml = (props, label) => renderToHtml(createElement(SectionHeader, props, label));

// ── Half A: the six sites ──────────────────────────────────────────────

test('the challenge detail page’s What counts label IS field’s SectionHeading', () => {
  // What counts sits tight above the block it names, flush on the screen's
  // own surface — no gutter, no card, so not the grouped-list label. (Scoring
  // and the participants line went with the Semi design, 2026-10-16.)
  const Pane = loadTsx('frontend/src/features/leaderboard/challenges-pane.tsx');
  const view = {
    key: '5', amount: null, goal: 'Join block production',
    illustration: null, illustrationTone: null, state: 'progress',
    stateLabel: '180/500 blocks', fill: 0.36, counted: true, cta: null,
    requirements: 'A node reachable all week.',
  };
  const html = renderToHtml(createElement(Pane.DetailPage, { view }));
  assert.ok(html.includes(headingHtml({ title: 'What counts' })),
    '“What counts” no longer renders through SectionHeading');
  assert.doesNotMatch(html, /Scoring|Participants/);
});

test('the Challenges tab’s group labels ARE grouped-list’s SectionHeader', () => {
  // First challenges, Next challenges and Done each label a grid of cards:
  // the label over a card group, small caps, set flush with the grid.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'frontend/src/features/leaderboard/challenges-pane.tsx'), 'utf8');
  assert.match(src, /<SectionHeader className=\{n \? GROUP_HEADING : GROUP_HEADING_FIRST\}>\{g\.heading\}<\/SectionHeader>/);
  assert.match(src, /const GROUP_HEADING = 'px-1 pt-6 pb-2';/, 'only the gutter and the step above it change');
});

test('the Homeroom-app settings section ARE field’s SectionHeading, rule included', () => {
  const { UnSection } = loadTsx('frontend/src/features/settings/sections/usernode-ui.tsx');
  const html = renderToHtml(createElement(
    UnSection,
    { id: 'settings-usernode-demo', title: 'Notifications', description: 'What this app may send you.' },
  ));
  assert.ok(
    html.includes(headingHtml({ title: 'Notifications' }, 'What this app may send you.')),
    'UnSection no longer renders through SectionHeading',
  );
  // A section with no blurb renders no blurb — the same branch the primitive
  // already had, not a second one here.
  const bare = renderToHtml(createElement(UnSection, { title: 'Notifications' }));
  assert.ok(!bare.includes('<p'), 'a description-less section draws no empty blurb');
  // Half B, at this site: the rule above the heading.
  assert.match(html, /border-t border-zinc-200 dark:border-zinc-800/);
});

test('the public-profile controls are a group of the Edit profile sheet, headed like its others', () => {
  // They were a card of their own on Me, opening with SectionHeading. The
  // prototype's Me has no room for them, so they moved into the sheet that
  // edits what the public page shows — and there a section is the sheet's own
  // inset-grouped `Group` (the kit's `.un-group-header` vocabulary), the
  // heading every other section of that sheet uses. Anchored on the source:
  // what matters is that it is that shared heading and no class string of its
  // own.
  const sheet = read('frontend/src/features/profile/profile-edit-sheet.tsx');
  assert.equal(message('profile:edit.public.group'), 'Public page');
  assert.match(sheet, /<Group title=\{t\('profile:edit\.public\.group'\)\}>/,
    'the “Public page” heading is the sheet’s shared Group, not a hand-written <h2>');
  const view = read('frontend/src/features/profile/profile-view.tsx');
  assert.doesNotMatch(view, /className="font-semibold text-base"/,
    'the old hand-written heading class is gone');
  assert.doesNotMatch(view, /title="Public profile"/, 'and Me carries no second copy');
});

test('one site keeps its own treatment, deliberately', () => {
  // NEITHER of these is "a label over a group" drawn by one of the two
  // primitives, and each has its reason.
  //
  // 1. The home screen's area labels (home/panels/ui.tsx). ONE shared
  //    primitive rather than a copied class string, pinned by three declared
  //    dapp.json checks as `h2.home-area-label`. Since the owner's decision of
  //    2 Nov 2026 (audit Y02) its LABEL wears SectionHeader's literals, the
  //    small caps every other screen uses; it stays its own component because
  //    the row carries the area's link beside the label, and its sections
  //    carry their own `px-3` gutter, so the grouped-list label's `px-4`
  //    would indent every home label away from the panel it heads.
  const home = read('frontend/src/features/home/panels/ui.tsx');
  assert.match(home, /<h2 className="home-area-label flex items-center gap-2 pt-4 pb-1\.5 leading-tight">/,
    'the row is unchanged, and carries no type of its own for the link to inherit');
  assert.match(home, /<span className="min-w-0 flex-1 truncate whitespace-nowrap text-xs font-bold uppercase tracking-\[0\.06em\] text-zinc-500 dark:text-zinc-400">\{children\}<\/span>/,
    'the label is SectionHeader\'s small caps');
  const primitive = read('frontend/@/components/ui/grouped-list.tsx');
  assert.match(primitive, /text-xs font-bold uppercase tracking-\[0\.06em\] text-zinc-500 dark:text-zinc-400/,
    'the literals it copies are still the primitive\'s');
  // 2. THE SECOND SITE RETIRED (#2718 review). It was the Improve panel's
  //    `<h2>Improve</h2>` — the PANEL'S TITLE, on one baseline with the
  //    target app's name and the close control, which is a dialog title bar
  //    and not a section label. The panel is gone, its own denser section
  //    labels with it, so the exception has nothing left to except. Recorded
  //    rather than deleted silently: "two sites" was the count this file
  //    argued for, and a reader who finds one needs to know the other did
  //    not simply get converted.
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/improve/improve-panel.tsx')),
    'the second exception retired with its panel, rather than being converted');
});

// ── Half A: one spelling per primitive, product-wide ───────────────────

const SOURCE_DIRS = ['frontend/src', 'frontend/@', 'public/js'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(p, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push({ path: path.relative(ROOT, p), text: fs.readFileSync(p, 'utf8') });
    }
  }
  return out;
}

const SOURCES = SOURCE_DIRS.flatMap((d) => walk(path.join(ROOT, d)));

test('each primitive’s class strings live in exactly one file', () => {
  // This is the check the request was filed for. usernode-ui.tsx held its own
  // verbatim copies of BOTH of SectionHeading's strings, so the one settings
  // section that looks most like the rest of Settings was the one that would
  // stop matching the moment the primitive changed.
  const owned = [
    ['text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1', FIELD_PATH],
    ['text-xs text-zinc-500 dark:text-zinc-500 mb-3', FIELD_PATH],
    ['px-4 pb-2 pt-6 text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400', GROUPED_PATH],
  ];
  for (const [literal, owner] of owned) {
    const holders = SOURCES.filter((s) => s.text.includes(literal)).map((s) => s.path);
    assert.deepEqual(holders, [owner],
      `“${literal}” is ${owner}'s to spell — import the component instead`);
  }
});

// ── Half B: the separator recipe ───────────────────────────────────────

// `border-<side>[-width] border-zinc-200 dark:border-zinc-<n>`: the product's
// separator, spelled identically at every one of its ~40 sites. Anchoring on
// the light value is what keeps this off a card's own edge and off an input's
// ring, both of which are `border-zinc-300 dark:border-zinc-700` and both of
// which are correct.
const SEPARATOR = /border-(?:t|b|l|r|x|y)(?:-\d+)? border-zinc-200 dark:border-zinc-(\d+)/g;

// The only separators that are NOT zinc-800, each with the reason it cannot
// be. Kept as exact needles so a stale entry fails below rather than quietly
// exempting something new.
const EXEMPT = [
  {
    file: 'public/js/build-log.js',
    needles: ['border-b border-zinc-200 dark:border-zinc-700', 'border-t border-zinc-200 dark:border-zinc-700'],
    why: 'the build-log modal card is `dark:bg-zinc-800`, so a zinc-800 rule '
      + 'across its header and footer would be an invisible line',
  },
  {
    file: 'public/js/session-options.js',
    needles: ['border-b border-zinc-200 dark:border-zinc-700', 'border-t border-zinc-200 dark:border-zinc-700'],
    why: 'same card, same surface — `dc-options-card` is `dark:bg-zinc-800`',
  },
  {
    file: 'frontend/src/features/settings/cli-setup-guide.tsx',
    needles: ['border-s border-zinc-200 dark:border-zinc-700'],
    why: 'not a separator: the Copy button’s inline-start edge CONTINUES the '
      + 'enclosing card’s own `border border-zinc-200 dark:border-zinc-700`, and '
      + 'an edge that breaks colour halfway round is the bug, not the fix',
  },
];

test('every separator on the platform surfaces is dark:border-zinc-800', () => {
  const exemptFiles = new Set(EXEMPT.map((e) => e.file));
  const offenders = [];
  let seen = 0;
  for (const src of SOURCES) {
    if (exemptFiles.has(src.path)) continue;
    for (const m of src.text.matchAll(SEPARATOR)) {
      seen += 1;
      if (m[1] !== '800') offenders.push(`${src.path}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [],
    'these rules draw a lighter hairline than the 35+ separators beside them, '
    + 'which is visible in dark mode on the same screen');
  // A guard on the guard: if the recipe is ever respelled, this file stops
  // matching anything and would pass while checking nothing.
  assert.ok(seen > 30, `expected the separator recipe to be widespread, found ${seen}`);
});

test('the five sites this request converted really are converted', () => {
  // Slot-anchored rather than trusting the sweep above: these are the exact
  // rules the audit measured, and a regression in any one of them is a regression
  // in this request.
  const sites = [
    ['frontend/src/features/settings/sections/usernode-ui.tsx', 'mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800', 1],
    ['frontend/src/features/settings/sections/usernode.tsx', 'mt-6 pt-5 border-t border-zinc-200 dark:border-zinc-800', 2],
    ['frontend/src/features/profile/staking-sheet.tsx', 'mt-5 pt-4 border-t border-zinc-200 dark:border-zinc-800', 1],
    ['frontend/src/features/dev-board/card/dev-card.tsx', 'list-none m-0 border-t border-zinc-200 dark:border-zinc-800', 1],
  ];
  for (const [file, needle, count] of sites) {
    const text = read(file);
    assert.equal(text.split(needle).length - 1, count, `${file}: expected ${count}× “${needle}”`);
  }
});

test('the exemptions are all still real', () => {
  // An exemption outlives the reason for it unless something re-checks: each
  // entry has to still match, and the file has to hold no OTHER separator the
  // sweep above never saw.
  for (const e of EXEMPT) {
    const text = read(e.file);
    for (const needle of e.needles) {
      assert.ok(text.includes(needle),
        `${e.file} no longer holds “${needle}” — drop the exemption (${e.why})`);
    }
    const found = [...text.matchAll(SEPARATOR)].map((m) => m[0]);
    for (const hit of found) {
      assert.ok(e.needles.includes(hit) || /dark:border-zinc-800$/.test(hit),
        `${e.file} grew a separator the exemption does not cover: ${hit}`);
    }
  }
});
