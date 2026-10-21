// Header height parity (#909) — the shell's top bar is the same height on
// every screen.
//
// The two authored top bars — #platform-header (signed-in shell: home, app
// view, leaderboard, profile, settings, admin console) and #landing-header
// (anonymous shell) — are `pt-2 pb-4` around a 28px CONTENT ROW, i.e.
// 52px + env(safe-area-inset-top), everywhere. One app.css rule trims the
// kit's safe-area top padding to match pt-2 for both bars (#2305).
//
// It was `py-3` (52px) until the bottom padding grew. #platform-header also
// carries `-mb-2`, which pulls the screen below it 8px UP into the bar to cut
// the `rounded-b-2xl` notch — so the controls had 12px of padding minus an
// 8px overlap, i.e. four pixels, between them and whatever came next. On the
// routes where that next thing is a raised sheet with a 28px radius and a
// shadow reaching up (inside an app, inside a proposal session) the chip, the
// bell and Improve sat on its lip. `pb-5` restored 12px; #2305 ("the top bar
// steals too much vertical space") settled on `pb-4`, which leaves 8px.
//
// It was 53px until the reskin, when both bars lost the 1px `border-b`
// hairline they had carried: the widget language draws no rule under a top
// bar — the page ground runs to the top of the screen and the controls float
// on it. What this file pins is PARITY and the 28px row, not the constant, so
// the hairline assertion below inverted rather than disappeared: it now
// asserts NEITHER bar has one, which is what catches a rule re-added to one
// shell and not the other.
//
// Neither header declares a height: they're flex rows, so the row is
// max(child heights) and the height silently followed whichever children
// happened to be present on that screen:
//
//   home                 53px  (#header-title's text-lg = 28px line box, +
//                               the hairline both bars carried back then)
//   inside an app        55px  (#app-mode-switch was 30px: py-1 segments
//                               = 24px + p-0.5 = 4px + 1px border × 2)
//   landing, >= 640px    61px  (CTAs were sm:py-2 sm:text-sm = 36px)
//   home, native WebView 45px  (html.in-native-webview USED to hide the
//                               title, leaving only 20px icon buttons; the
//                               title is drawn there now, and the 28px
//                               content-row floor is what holds the height)
//
// So the row is pinned from BOTH directions and this file is what keeps it
// pinned — a "tidy up the header" edit that re-adds vertical padding to a
// header child, or drops a taller control in, fails here instead of shipping
// a bar that jumps as you navigate:
//
//   FLOOR   — the lead back-button wrapper (present in every state of both
//             headers) carries h-7, so the row survives the title being
//             display:none. It stays w-5: the header-layout hook
//             (frontend/src/features/header/use-header-layout.ts) measures it
//             as the title's left side group.
//   CEILING — no child of either header exceeds 28px.
//
// Prose version of the same contract lives in the "Header height invariant"
// block in public/css/app.css.
//
// Static-assertion style (cf. tests/header-status-pane.test.js): read the
// shipped source files and assert the contract is present. There is no
// layout engine here — the measured-height half is a manual check, see the
// spec's verification steps.
//
// Run with: node --test tests/header-height-parity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shellMarkup } = require('./lib/shell-markup');

const root = path.join(__dirname, '..');
const html = shellMarkup();
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8');

// The markup of one <header> element, opening tag through </header>.
function headerSlice(id) {
  const start = html.indexOf(`<header id="${id}"`);
  assert.notEqual(start, -1, `#${id} exists in the shell`);
  const end = html.indexOf('</header>', start);
  assert.notEqual(end, -1, `#${id} is closed`);
  return html.slice(start, end + '</header>'.length);
}

// The opening tag only — used for the shape classes on the header itself.
function openingTag(slice) {
  return slice.slice(0, slice.indexOf('>') + 1);
}

// Markup with <!-- … --> stripped, for scans that would otherwise match a
// class name mentioned in prose (these headers are heavily commented, and
// the comments name the very classes this file bans).
function withoutComments(slice) {
  return slice.replace(/<!--[\s\S]*?-->/g, '');
}

const BARS = [
  { id: 'platform-header', slice: headerSlice('platform-header') },
  { id: 'landing-header', slice: headerSlice('landing-header') },
];

test('both top bars carry the identical shape: pt-2/pb-4, no hairline, safe-area', () => {
  for (const bar of BARS) {
    const tag = openingTag(bar.slice);
    // 8px above and 16px below the content row (#2305). NOT symmetric, and not by
    // accident: `-mb-2` on #platform-header pulls the screen below it 8px up
    // to cut the notch every platform surface reads as its rounded top, and
    // that 8px comes out of the bottom padding. At py-3 the controls had four
    // pixels of clearance, which nobody could see until the thing below was a
    // raised sheet (an app, a proposal session) instead of a transparent
    // screen root. pb-5 buys it back.
    //
    // PARITY, NOT SYMMETRY, is what this file is for: both bars carry the
    // same pair, so both are 52px and the bar does not jump as you sign in.
    assert.match(tag, /\bpt-2\b/,
      `#${bar.id} keeps pt-2 — 8px above the row (#2305)`);
    // #2305 took it to pb-4: 16px, 8px of which the notch spends, still
    // double the clearance whose absence made pb-5 necessary.
    assert.match(tag, /\bpb-4\b/,
      `#${bar.id} keeps pb-4 — 16px below it, 8px of which the notch spends`);
    assert.doesNotMatch(tag, /\bpy-\d/,
      `#${bar.id} states its vertical padding once, as the pt/pb pair`);
    // A bottom border is part of the height (border-box), so it is part of
    // parity — which is why this is asserted at all rather than left alone.
    // The reskin removed the hairline from BOTH bars; re-adding it to one
    // makes that shell a pixel taller than the other, and the bar visibly
    // jumps as you sign in.
    assert.doesNotMatch(tag, /\bborder-b\b/,
      `#${bar.id} draws no rule under it — the page ground runs to the top`);
    // Adds env(safe-area-inset-top) to padding-top (native.css). Both bars
    // must opt in, or the phone status bar overlaps one shell and not the
    // other.
    assert.match(tag, /\bun-safe-top-extend\b/,
      `#${bar.id} keeps the safe-area opt-in`);
    // The row is max(child heights); a py-* on the header itself would be
    // additive, and a hardcoded h-* would fight the safe-area inset.
    assert.doesNotMatch(tag, /\bh-\d/,
      `#${bar.id} does not hardcode its own height — padding + the 28px row is the contract`);
  }
});

test('FLOOR: each bar holds its 28px content row open', () => {
  for (const bar of BARS) {
    // `h-7` on the bar's LEAD GROUP is what holds the row open when
    // #header-title is hidden (native WebView), and `flex items-center`
    // centres whatever is in it inside those 28px. That is the floor, and it
    // is the whole of what parity requires.
    //
    // WIDTH IS NO LONGER PART OF IT, and only on the platform bar. The fixed
    // `w-7` box existed to (a) keep a CENTRED title from shifting as the back
    // anchor came and went and (b) hold either the arrow or the app glyph,
    // which never drew together. #1443 retired the app glyph and made the
    // chip the header's flush-left label, so the box had one occupant and no
    // centring to protect — all it did was reserve an inch of dead space at
    // the top-left of every root screen.
    //
    // The landing bar still has its w-7 box: its title IS centred and its
    // back button still comes and goes, so the reason survives there. Two
    // bars, one floor, and the width rule kept exactly where it still buys
    // something.
    const lead = withoutComments(bar.slice).match(/<div[^>]*class="([^"]*\bh-7\b[^"]*)"/);
    assert.ok(lead, `#${bar.id} still has a lead group carrying the 28px floor`);
    const classes = lead[1].split(/\s+/);
    assert.ok(classes.includes('flex') && classes.includes('items-center'),
      `#${bar.id}'s lead group centres its content in those 28px`);
    assert.ok(classes.includes('shrink-0'),
      `#${bar.id}'s lead group never compresses below the floor`);
    if (bar.id === 'landing-header') {
      assert.ok(classes.includes('w-7'),
        '#landing-header keeps its fixed 28px box — its title is centred');
    }
  }
});

test('CEILING: the Homeroom mark is exactly the 28px row', () => {
  // THE UI OVERHAUL replaced #app-mode-switch with #improve-btn and the
  // invariant transferred WITH it; #2718 retired that pill in turn and it
  // transferred again, to #platform-mark-btn. The chain matters less than what
  // it is a chain OF: whichever control is the tallest thing in the bar when
  // an app opens, its height IS the in-app header height. The switch that
  // started it was 30px for a while (24px segments + 4px p-0.5 + 2px border),
  // which quietly made the in-app header 2px taller than every other screen's
  // — the whole of #909. Pinning each successor to h-7 is what stops that
  // recurring with a differently-shaped control.
  const tag = html.match(/<button id="platform-mark-btn"[\s\S]*?>/)[0];
  assert.match(tag, /\bh-7\b/,
    "the mark is pinned to the header's 28px content row");
  assert.doesNotMatch(tag, /\b(?:sm:)?py-\d/,
    'the mark carries no vertical padding — h-7 owns the height');
  // Artwork beside a chevron, so it must centre its content vertically rather
  // than letting the two children set their own baseline. The tile is 26px
  // inside the 28px row, which is where the 1px of air above and below it
  // comes from.
  assert.match(tag, /\bitems-center\b/,
    'the mark centres its tile and chevron vertically');
  assert.match(tag, /\binline-flex\b/, 'the mark is a flex box');
  // …and SPACES them, though barely: 2px, because the chevron is a disclosure
  // ON the mark rather than a second control beside it. A gap is a horizontal
  // cost only, so the 28px ceiling above is untouched either way.
  assert.match(tag, /\bgap-0\.5\b/,
    'the tile and its chevron are spaced, not fused');
  const tile = html.match(/<img[^>]*class="platform-mark-tile[^"]*"/)[0];
  assert.match(tile, /(?:^|\s)h-\[26px\](?:\s|$)/,
    'the artwork is 26px, so it fits the row with a pixel to spare');
  // #3358: the button draws the Homeroom mark itself, a real asset, and as
  // decoration: the button's aria-label is its name.
  const full = html.match(/<img[^>]*class="platform-mark-tile[^"]*"[^>]*>/)[0];
  assert.match(full, /\bsrc="\/brand\/homeroom-mark\.png"/, 'the mark, not another picture');
  assert.match(full, /\balt=""/, 'decorative: the button is named by its label');
  assert.ok(require('node:fs').existsSync(require('node:path').join(__dirname, '..', 'public', 'brand', 'homeroom-mark.png')),
    'the mark ships with the shell');
});

test('CEILING: the landing bar is the wordmark at 28px, with no anchor and one quiet Sign in', () => {
  const bar = withoutComments(BARS.find((b) => b.id === 'landing-header').slice);

  // THE CTA ROW IS GONE, and with it the only thing that ever broke this
  // ceiling on this bar. It held three anchors — Sign in, Join waitlist and
  // the waiting-room variant — and it broke the 28px row twice over:
  // `sm:py-2 sm:text-sm` made them 36px at `sm` and up (a 61px bar on
  // desktop), and even at `py-1.5` the BORDERED one was 30px to its
  // borderless siblings' 28px, because the 1px border top and bottom is part
  // of the box. Pinning them to `h-7` fixed the height and left the real
  // problem: a stranger's two ways into the product were 28px chips in the
  // top-right corner, read at the moment they knew least about it. Both are
  // full-width pills in the body now, under the sentence that says what this
  // place is — so the ceiling here is kept by there being nothing to size.
  //
  // Asserted as "no anchor" rather than "no #landing-header-ctas": the row
  // could come back under any id, and what must not come back is a control
  // in this bar that carries its own padding.
  assert.deepEqual(bar.match(/<a[\s>]/g) || [], [],
    'the landing bar carries no anchor — both ways in are pills in the body');

  // ONE QUIET SIGN IN CAME BACK (the guest Discover, 21 Oct 2026): a visitor
  // who has an account looks around before signing in, and the bar is where
  // they look for it. It is a BUTTON at the content row's own 28px with no
  // padding of its own, so it cannot grow the bar the way the old chips did,
  // and it sits over the trailing box rather than in the row, so the mark
  // keeps the bar's true centre. Making an account is still the body's pill.
  const signIn = bar.match(/<button[^>]*data-landing-sign-in=""[^>]*>/);
  assert.ok(signIn, 'the bar carries the Sign in button');
  assert.match(signIn[0], /\bh-7\b/, 'exactly the 28px content row');
  assert.doesNotMatch(signIn[0], /\b(?:sm:)?py-\d/, 'no vertical padding of its own');
  assert.match(signIn[0], /\babsolute\b/, 'out of the row, so the title stays centred');

  // What took over the row's other job, saying which product this is: the
  // logotype, drawn at the content row's own height. `h-7` is this bar's
  // ceiling AND the mark's only size, and `w-auto` leaves the width to the
  // drawing's own ratio — so there is no dimension of it that can grow the
  // bar. (The mark swaps to the open app's NAME while the viewer is running;
  // that branch is plain text in an element already pinned to `text-lg`.)
  const title = bar.slice(bar.indexOf('id="landing-header-title"'));
  const mark = title.match(/<svg[^>]*\bclass="([^"]*)"/);
  assert.ok(mark, '#landing-header-title draws the wordmark');
  assert.match(mark[1], /\bh-7\b/, 'the wordmark is exactly the 28px content row');
  assert.match(mark[1], /\bw-auto\b/, 'and takes its width from its own aspect ratio');

  // The bar still answers "Homeroom" to a screen reader. The heading used to
  // spell the word out; a drawing has to be told to.
  assert.match(title.slice(0, 400), /aria-label="Homeroom"/,
    'the mark carries the name the heading used to spell out');
});

test('CEILING: nothing in either bar is taller than the 28px row', () => {
  // A cheap guard against the next tall thing dropped into a header: the
  // only heights that belong in there are h-5 (20px icons), h-7 (the row
  // itself) and the badges' h-[1.1rem] pills.
  for (const bar of BARS) {
    // py-3 lives on the header's own opening tag, not on a child.
    const children = withoutComments(bar.slice.slice(openingTag(bar.slice).length));
    for (const cls of ['h-8', 'h-9', 'h-10', 'h-12', 'py-2', 'py-3', 'py-4']) {
      assert.ok(
        !new RegExp(`\\b(?:sm:|md:|lg:)?${cls}\\b`).test(children),
        `#${bar.id} has no ${cls} child — the content row is 28px`,
      );
    }
    for (const cls of ['text-xl', 'text-2xl', 'text-3xl']) {
      assert.ok(
        !new RegExp(`\\b(?:sm:|md:|lg:)?${cls}\\b`).test(children),
        `#${bar.id} has no ${cls} — a bigger line box would grow the row past 28px`,
      );
    }
  }
});

test('badges still overflow the row rather than being clipped', () => {
  // The notification / dev-console / deploy-dot badges hang outside the
  // 28px row on purpose (-top-1 -right-1). Clipping the header to enforce
  // the height would decapitate them, so the invariant is enforced on the
  // children instead — assert nobody "fixed" it with overflow.
  for (const bar of BARS) {
    assert.doesNotMatch(openingTag(bar.slice), /\boverflow-hidden\b/,
      `#${bar.id} is not clipped — the absolutely-positioned badges overflow it by design`);
  }
  const platform = BARS.find((b) => b.id === 'platform-header').slice;
  assert.match(platform, /id="notifications-badge"[^>]*-top-1/,
    'the bell badge still hangs off the top-right corner');
  assert.match(platform, /id="improve-working-dot"[^>]*-top-1\.5/,
    'and the work dot hangs off the same corner of the mark it moved to when '
    + '#2718 retired the Improve pill (#1610 had already retired the green '
    + 'count that used to sit there)');
});

test('the invariant is documented where the next editor will look', () => {
  assert.match(css, /Header height invariant/,
    'public/css/app.css carries the "Header height invariant" block');
  const block = css.slice(css.indexOf('Header height invariant'));
  const head = block.slice(0, block.indexOf('── Header title centering'));
  assert.match(head, /#platform-header/, 'the block names both bars');
  assert.match(head, /#landing-header/, 'the block names both bars');
  assert.match(head, /28px/, 'the block states the content-row height');
  assert.match(head, /header-layout/,
    'the block warns that the w-5 width is measured by the header-layout code');
  // The stale "Kept at 28px tall" claim on the retired #app-mode-switch was
  // wrong for as long as it existed (it omitted the border), so the rule is
  // that the source comment names the CLASS that pins the height rather than
  // asserting an arithmetic result. #improve-btn inherited both the slot and
  // the rule, and #platform-mark-btn inherited them from it when #2718 retired
  // that pill — see features/header/platform-mark.tsx.
  const markSrc = fs.readFileSync(
    path.join(root, 'frontend/src/features/header/platform-mark.tsx'), 'utf8');
  assert.match(markSrc, /h-7` is the header's 28px content-row ceiling/,
    'the mark comment points at the class that pins its height');
});

test('no JS sets a header height — the contract lives entirely in markup + CSS', () => {
  // The header-layout hook measures WIDTHS to decide the title's centering mode;
  // it must never start writing heights (that would put the invariant in
  // two places, one of them racing first paint).
  // #1079 chunk B ported header-layout.js into the header island as a hook.
  const layoutJs = fs.readFileSync(
    path.join(root, 'frontend/src/features/header/use-header-layout.ts'), 'utf8');
  assert.doesNotMatch(layoutJs, /style\.(?:height|minHeight|paddingTop|paddingBottom)/,
    'the header-layout hook never writes header box metrics');
  const appJs = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  assert.doesNotMatch(appJs, /getElementById\('platform-header'\)\.style/,
    'app.js never writes #platform-header inline styles');
});

// ── The native WebView shows the in-page title ────────────────────────
//
// It was hidden under `html.in-native-webview` because the Flutter shell puts
// the screen name in its own AppBar — a real arrangement, not a guess:
// App.setHeaderTitle posts `titleChanged` to it. On a device that read as a
// screen with no title at all, so the in-page one is drawn there too.
//
// Pinned because the obvious "tidy up" is to restore the hide: the CSS rule
// reads like dead weight next to the AppBar message, and the two halves live
// in different files.

test('no rule hides the header title in the native WebView', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /in-native-webview[^{]*#header-title[^{]*\{[^}]*display:\s*none/,
    'the native WebView must not hide #header-title');
  // The class itself stays — it still gates the safe-area and native
  // performance rules, so this is not "delete the detection".
  assert.match(rules, /html\.un-ios\.in-native-webview/,
    'the native marker class is still load-bearing elsewhere');
});

test('the title is left-aligned on a phone by an explicit rule, not by a native branch', () => {
  // The request was "left justified, leaving space for the home icon, since
  // there wouldn't be room to centre".
  //
  // This test used to assert that the EXISTING measurement already produced
  // that, on the reasoning that a 390px viewport carrying #improve-btn and
  // the hamburger could never satisfy
  //   titleNaturalW <= headerW - 2 * (max(sideGroup) + gap)
  // for a real title. That was wrong twice over, and the preview showed it:
  // "Settings" DID satisfy it, and the formula was over-reporting the room by
  // the header's own `px-4` on each side, so the centred title overlapped the
  // Improve button. Both halves are fixed in use-header-layout.ts and pinned
  // in tests/header-title-centering.test.js, which drives the arithmetic
  // directly on the measurements that failed.
  //
  // What belongs HERE is the part that is about this file's subject — that
  // alignment stays ONE rule for every surface, with no native-webview branch
  // to drift out of sync with the browser one.
  const hook = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src',
    'features', 'header', 'use-header-layout.ts'), 'utf8');
  assert.match(hook, /const CENTER_MIN_WIDTH_PX = 640;/,
    'a phone is left-aligned by a stated breakpoint, not by hoping the maths says so');
  assert.match(hook, /const canCenter = canCenterTitle\(\{/,
    'and the decision goes through the one exported, tested function');
  assert.doesNotMatch(hook, /in-native-webview|isNative/,
    'alignment is one geometric rule for every surface');
});

test('#2305: both bars trim the kit\'s top padding to the inset + 8px, matching pt-2', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
  const rule = css.match(/@supports \(padding: env\(safe-area-inset-top\)\) \{\s*#platform-header\.un-safe-top-extend,\s*#landing-header\.un-safe-top-extend \{([^}]*)\}/);
  assert.ok(rule, 'one rule, for BOTH bars — parity survives the trim');
  assert.match(rule[1], /padding-top: calc\(0\.5rem \+ var\(--un-safe-inset-top, env\(safe-area-inset-top, 0px\)\)\) !important;/);
  // The kit's own class is untouched for every other consumer.
  const kit = fs.readFileSync(path.join(__dirname, '..', 'public', 'usernode-native', 'v1', 'native.css'), 'utf8');
  assert.match(kit, /\.un-safe-top-extend \{\s*padding-top: calc\(0\.75rem \+ var\(--un-safe-inset-top, env\(safe-area-inset-top, 0px\)\)\) !important;/);
});

// #4037: the landing bar stays on the signed-out story. The story is a
// stranger's first screen, so the Homeroom logo is there to say where they
// are (the owner's ruling, after a build that hid the bar while the story was
// up). No rule hides the bar for the story, and its markup is never hidden.
test('the story keeps the landing bar', () => {
  assert.equal((css.match(/#landing-header \{\s*display: none;/g) || []).length, 0,
    'no rule hides #landing-header');
  assert.doesNotMatch(css, /\[data-landing-story\][^{}]*#landing-header/,
    'no rule reaches the bar from the story');
  const bar = BARS.find((b) => b.id === 'landing-header').slice;
  assert.doesNotMatch(openingTag(bar), /\bhidden\b/, 'the bar is not hidden in the markup');
});
