// test:changed: always (every feature file, for glyphs drawn outside icons.tsx; scripts/test-changed.js)
// The shell's glyphs come from ONE module, and their path data never moves.
//
// #1120 slice 4 pulled 36 inline `<svg>` blocks out of frontend/src/features/**
// and into frontend/@/components/ui/icons.tsx. The conversion is worth almost
// nothing on its own — it is worth something only if the two things that make
// an icon swap dangerous stay pinned:
//
//   1. The path data is the shell's own. shadcn's examples import glyphs from
//      `lucide-react`, and lucide has a same-named counterpart for nearly
//      every icon below drawn on a different grid. Adding that package would
//      restyle thirty-odd buttons in one commit while every diff line still
//      read like a rename.
//   2. Nothing drifts back. One inline `<svg>` re-added beside the module is
//      how a set ends up with two spellings of the same glyph, which is the
//      state this slice found the tree in (five copies of the close X, four of
//      the back chevron).
//
// The strongest strand here is the third test: every `d` in the PRERENDERED
// document has to be a string this module exports. That is what makes "the
// path data is unchanged" checkable rather than asserted — the shipped
// markup is compared against the source of truth, not against a fixture of
// itself.
//
// Run with: node --test tests/shell-icon-set.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { shellMarkup } = require('./lib/shell-markup');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ICONS = read('frontend/@/components/ui/icons.tsx');
// The ONE non-glyph the shell prerenders path data for: the Homeroom logotype,
// in its own primitive. It is not in icons.tsx on purpose — a logotype is not
// an outline on the 24 grid, and its own header explains the split — so the
// strays test below reads it as a second legal home. Only that test does: the
// expected-absent inventory further down stays derived from icons.tsx alone,
// or these eight paths would have to be added to an exact list in the proposal
// that ADDS the primitive and removed again in the one that first draws it.
// Two homes, and a third is not allowed.
const WORDMARK = read('frontend/@/components/ui/wordmark.tsx');
// Document plus the interiors that mount on first reveal: a glyph in the
// settings panes or the anonymous shell is still one the shell ships.
const HTML = shellMarkup();
const PKG = JSON.parse(read('frontend/package.json'));

/** Every single-quoted string in the module that looks like SVG path data. */
function modulePaths() {
  return new Set(ICONS.match(/'M[^'\\\n]*'/g).map((s) => s.slice(1, -1)));
}

/** The same read, over the wordmark primitive — see the note beside WORDMARK. */
function wordmarkPaths() {
  return new Set(WORDMARK.match(/'M[^'\\\n]*'/g).map((s) => s.slice(1, -1)));
}

/** Every `<svg>` opening tag in a source file, brace- and quote-aware. */
function svgTags(src) {
  const out = [];
  for (let at = src.indexOf('<svg'); at !== -1; at = src.indexOf('<svg', at + 1)) {
    out.push(src.slice(at, src.indexOf('>', at) + 1));
  }
  return out;
}

function featureFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  walk('frontend/src');
  return out;
}

test('the set is the shell’s own — no lucide, no icon package at all', () => {
  const deps = { ...(PKG.dependencies || {}), ...(PKG.devDependencies || {}) };
  for (const name of Object.keys(deps)) {
    assert.ok(!/lucide|heroicons|react-icons|@tabler\/icons/.test(name),
      `frontend/package.json depends on ${name} — the shell draws its own glyphs, `
      + 'and a same-named icon from a package is not the same path');
  }
  // The header explains the decision, so only the CODE lines are checked.
  const code = ICONS.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.ok(!code.some((l) => /lucide/.test(l)),
    'icons.tsx imports from lucide — see the header');
});

test('the glyphs live in the module, not inline beside it', () => {
  const offenders = [];
  for (const file of featureFiles()) {
    const src = read(file);
    // A literal `d="M…"` is the tell: an inline glyph with its own path data.
    // `d={…}` is not — the dev board's view switcher picks its path out of a
    // table at render time, and <Glyph> is the escape hatch it uses.
    if (/\sd="M/.test(src)) offenders.push(file);
  }
  // The admin console's own two glyphs — the panel ✕ and a nested screen's
  // back chevron — are the one exception. They are PORTS, not new glyphs, and
  // importing from @/components/ui/icons.tsx is not the alternative:
  // AGENTS.md's density boundary forbids an admin source from reaching into
  // the shell's primitives, and tests/admin-ui-registry.test.js enforces it.
  //
  // These were checkable byte for byte against admin-topochain.js's own
  // _panel() / detail renderer while those existed. #1120 slice 35 retired
  // the last of them — that module renders no markup at all now — so the
  // anchor is structural instead, and it is the one that protects what is
  // left: exactly two paths, each exported as a component, and no other admin
  // source inlining one. A second offender in this list is a copy that will
  // drift, not a third legitimate port.
  const PORTED = 'frontend/src/features/admin/topochain/ui.tsx';
  if (offenders.includes(PORTED)) {
    const src = read(PORTED);
    const ported = src.match(/\sd="(M[^"]*)"/g) || [];
    assert.equal(ported.length, 2,
      `${PORTED} may carry exactly the two ported glyphs — the ✕ and the back chevron`);
    for (const fn of ['CloseButton', 'BackButton']) {
      assert.match(src, new RegExp(`export function ${fn}\\(`),
        `${fn} is exported, so the screens have something to import instead of copying`);
    }
    // And they are actually used through those components, not re-declared.
    const screens = fs.readdirSync(path.join(ROOT, 'frontend/src/features/admin/topochain'))
      .filter((f) => f.endsWith('.tsx') && f !== 'ui.tsx');
    for (const f of screens) {
      const s2 = read(`frontend/src/features/admin/topochain/${f}`);
      assert.ok(!/\sd="M/.test(s2), `${f} imports the glyph rather than inlining it`);
    }
    offenders.splice(offenders.indexOf(PORTED), 1);
  }
  assert.deepEqual(offenders, [],
    'these files inline SVG path data — move the glyph into '
    + 'frontend/@/components/ui/icons.tsx and import it:\n  ' + offenders.join('\n  '));
  // The blanket "no raw <svg>" half is the SHELL's rule. The admin console
  // draws its own data charts and always has — admin-analytics.js,
  // admin-estimator and admin-topochain each emit an <svg> of <rect>s and
  // <line>s — and a bar chart is not a glyph that escaped the module. Those
  // files only became visible here when #1120 started converting console
  // sections to .tsx; the inline-path-data rule above still covers them, which
  // is the half that actually catches a glyph.
  const shellFiles = featureFiles().filter((f) => !f.startsWith('frontend/src/features/admin/'));
  assert.deepEqual(shellFiles.filter((f) => svgTags(read(f)).length > 0), [],
    'a raw <svg> in a feature file is a glyph that escaped the module');
});

test('every path the shell prerenders is one the module exports', () => {
  const shipped = new Set(HTML.match(/\sd="[^"]*"/g).map((s) => s.slice(4, -1)));
  // The glyph set, plus the logotype primitive. Both sources are read as their
  // quoted literals, so this stays what it has always been: the shipped markup
  // compared against the source of truth rather than against a fixture of
  // itself. What it is NOT is a licence for a third home — see WORDMARK above.
  const exported = new Set([...modulePaths(), ...wordmarkPaths()]);
  const strays = [...shipped].filter((d) => !exported.has(d));
  assert.deepEqual(strays, [],
    `${strays.length} path(s) in public/index.html are in neither icons.tsx nor `
    + 'wordmark.tsx. Either a glyph was re-inlined, or a transcription drifted by a '
    + 'character — which is a silent visual change, since the wrong path still '
    + 'draws something.');
  // Was 24 before THE UI OVERHAUL. Five glyphs stopped prerendering when the
  // surfaces that drew them were retired — see the expected-absent list in the
  // next test, which names each one — and two were added with the Improve
  // panel's rows.
  // 21 before the #1367 follow-up removed the notifications disclosure, which
  // was ChevronRightIcon's last prerendered call site (see the expected-absent
  // list in the next test, which records its full history). 24 since the
  // Workshop screen (#workshop) — its menu row and its two-glyph column legend
  // are drawn unconditionally, so four paths moved from that list into here.
  assert.ok(shipped.size >= 24,
    `only ${shipped.size} glyph paths in the prerendered document — the shell ships 24, `
    + 'so something stopped rendering');
});

test('the glyphs that do NOT prerender are the ones that render behind state', () => {
  // Not every export lands in the static document, and that is fine — but it
  // has to be a KNOWN list, or "my new icon is missing from index.html" reads
  // as normal instead of as the hydration bug it usually is.
  const shipped = new Set(HTML.match(/\sd="[^"]*"/g).map((s) => s.slice(4, -1)));
  const absent = [...modulePaths()].filter((d) => !shipped.has(d));
  // The Needs-you feed's rail — ballot (three paths), sparkles, play — and
  // the chevron-up its arrows use, all client-rendered.
  //
  // FOUR PATHS LEFT THIS LIST WITH THE WORKSHOP SCREEN (#workshop), and each
  // is now in the static document because something on it renders
  // unconditionally rather than behind state: BoardIcon (one path) is the
  // Workshop row in the app chip's menu, and HandRaisedIcon (one) and
  // SpeechCheckIcon (two — the bubble and its tick) are the screen's own
  // column legend, which is drawn whether or not the list has loaded. The two
  // count glyphs are the same pair the app's own Workshop tab uses, which is
  // the point: the number on a row and the pane it counts wear one mark.
  const expected = [
    // ── The create dialog is retired ───────────────────────────────────
    //
    // Its "A private community" row drew LockIcon in the static document;
    // the lock still draws behind state (the signed-out landing, the hub's
    // ⋯ menu, a community's card), so it is on this list again.
    'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
    // ── The create dialog's rework took four paths OUT of this list, ──
    // ── and the make screen's More options put them back ─────────────
    //
    // "What are you making?" became rows like "Who is it for?", each with
    // its glyph, and the dialog prerenders every step: AppWindowIcon (two
    // paths) on App, NewspaperIcon on Document and PlayIcon on Video were in
    // the static document. The step went when the dialog became the make
    // screen's More options (tests/create-front-door.test.js), which asks
    // what you are making itself; AppWindowIcon and PlayIcon still draw
    // behind state (the board, an agent chat, the Needs-you rail), and
    // NewspaperIcon nowhere.
    'M4 6a1 1 0 011-1h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V6z',
    'M4 9.5h16',
    'M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z',
    'M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z',
    // ── #2718 moved paths across this line, in both directions ───────
    //
    // OUT OF IT, because the navigation change draws them unconditionally:
    // the tab bar's five glyphs are in the document on every route, the app
    // menu draws a chat bubble and an info circle, and the parked strip draws
    // an ✕. (The Workshop's scope chip drew the grid until #2759 took it off
    // the all-apps screen, and draws it again since #3051 brought it back.)
    //
    // INTO IT, and every one is a row of the app chip's menu that is not
    // there any more. The platform's destinations left that menu for the tab
    // bar and the Profile screen — the cog, the shield, the trophy, the
    // wallet, the staking mark — and their glyphs went with them, because
    // Profile's rows render only once its store has data and nothing draws
    // them in a cold document.
    //
    // That is the whole of the movement, and it is what this list is for: a
    // glyph that stops prerendering because a surface was retired is
    // expected, and one that stops because a component broke is a hydration
    // bug wearing the same clothes.
    // CogIcon's two paths (the gear, and the hub 'M15 12a3…') LEFT this list
    // with #3120: the desktop rail's Settings cog (#platform-rail-settings)
    // sits beside Me at the rail's foot and renders unconditionally, so the
    // cog is in the cold document again.
    'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    'M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z',
    // LockOpenIcon: Getting started's done card, "7 challenges unlocked"
    // (2026-10-01), which shows only once the list is finished.
    'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zM8 11V7a4 4 0 017.75-1.4',
    // LockIcon and UserGroupIcon LEFT this list with communities, stage 3:
    // the create dialog's first step (who it is for) draws them on its
    // "A group" and "A community" rows, and the dialog prerenders every step.
    'M12 20h9',
    // DownloadIcon (#4055): the image viewer's Download and a message's
    // "Download image", both drawn only after a tap.
    'M12 3v12m0 0l-4-4m4 4l4-4M5 13v7h14v-7',
    'M12 3v12m0-12l-4 4m4-4l4 4M5 13v7h14v-7',
    'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z',
    'M12 3v8.25m0 0l-3-3m3 3l3-3',
    // THE PLUS, added by #2718's review. Two surfaces drew it in a cold
    // document and both are gone: the Workshop screen's own + button, and
    // Create New in the app chip's menu. The Workshop's plus went because
    // the top-level screen is a REPORT of what your apps want from you, not
    // a place to start something; the menu's went with the app strip above
    // it. Every plus left in the shell renders behind state.
    'M12 4v16m8-8H4',
    'M12 4.5v15m7.5-7.5h-15',
    'M12 5.5v13',
    'M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z',
    // WarningTriangleIcon left this list with #2716: Settings → Delete
    // account draws it on the initial confirmation-entry button, including
    // when the lazily mounted Settings interior first renders.
    'M13 7l5 5m0 0l-5 5m5-5H6',
    'M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5',
    'M15 18l-6-6 6-6',
    'M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z',
    'M16 11V3H8v8M5 7H3v4a2 2 0 002 2h3M19 7h2v4a2 2 0 01-2 2h-3M8 15a4 4 0 008 0h-8z M12 15v3m-3 3h6',
    'M16.023 9.348h4.992V4.356m-4.992 4.992l3.181-3.183a8.25 8.25 0 00-13.803 3.7M4.031 9.865v4.99m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7',
    'M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-7.322c.983.143 1.954.317 2.916.52a6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0',
    'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
    'M16.5 6.5a2.12 2.12 0 0 1 3 3L9 20l-4 1 1-4z',
    'M17 21v-8H7v8',
    'M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z',
    'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z',
    'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
    'M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859',
    'M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3',
    'M21.4 11.6l-8.5 8.5a6 6 0 01-8.5-8.5l9-9a4 4 0 015.7 5.7l-9 9a2 2 0 01-2.8-2.8l8.4-8.4',
    // PaperclipIcon left this list with #4127: Send feedback's attachment
    // row draws it on the paperclip button in the prerendered dialog.
    'M22 2 11 13',
    'M22 2 15 22l-4-9-9-4z',
    'M3 6h18',
    'M4 20 20 4',
    'M4 4l17 8-17 8 3-8-3-8zm3 8h14',
    'M4 5a8 3 0 1 0 16 0 8 3 0 1 0-16 0',
    // BoardIcon came back to this list with #3287: the app chip's menu row
    // is "Go to community hub" and wears the Communities glyph, so the board
    // mark is drawn only by a project page's Workshop tab, behind state.
    'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z',
    'M4 5v6c0 4 16 4 16 0V5M4 11v6c0 4 16 4 16 0v-6',
    // THE GRID is back on this list with #852. #2759 put it behind state when
    // the all-apps Workshop's scope chip went, and #3051 brought the chip back
    // as "All apps", drawing it unconditionally. #852 moves it into the
    // header at every width, as "Communities ⌄" (#header-scope-switch, drawn
    // once the router says the Communities screen is up), so nothing
    // prerenders the grid again.
    'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z',
    // DescriptionIcon: the Needs-you rail's Description, client-rendered
    // with the rest of that rail.
    'M4 6h16M4 12h16M4 18h10',
    'M4 6h16M4 12h16M4 18h16',
    'M4.5 12.75l6 6 9-13.5',
    'M5 13l4 4L19 7',
    'M5 15l7-7 7 7',
    'M6 3l.75 1.75L8.5 5.5l-1.75.75L6 8l-.75-1.75L3.5 5.5l1.75-.75z',
    'M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z',
    // HashIcon (#2802): a channel's glyph in the desktop rail's Recents,
    // whose rows render only after mount, so it is never in a cold document.
    'M7 20l4-16m2 16l4-16M6 9h14M4 15h14',
    'M7 3v5h8',
    'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2',
    // THE SPEECH BUBBLE, added by #2718's review. It was the leading glyph of
    // the app menu's "Give feedback" row, which is a filled button in the
    // Improve panel again — and that panel renders behind state, so its
    // buttons carry no glyph into a cold document. The bell's own
    // "All messages" row still draws this bubble, but only on the Messages
    // tab, which is likewise a press away.
    'M8 10h.01M12 10h.01M16 10h.01M21 12a8 8 0 01-8 8H7l-4 2 1.3-4A9 9 0 1121 12z',
    'M8.25 15L12 18.75 15.75 15',
    'M8.25 9L12 5.25 15.75 9',
    'M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z',
    'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
    'M9 3.75H6.912a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H15',
    // THE LIGHTBULB, added by #2718's review. It was #improve-btn-glyph's
    // rest state — the Improve row's leading mark, drawn in a cold document
    // because the row shipped hidden rather than absent. The row and the
    // glyph retired with the panel they opened, and the icon is still
    // exported and still drawn: the Workshop toolbar's "+" menu offers
    // "New change" with it, behind that menu's own state.
    'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
    // SparklesIcon came back to this list with #3358: #platform-mark-btn
    // draws the Homeroom mark again (#3318 had swapped it for a sparkle), and
    // every other sparkle (Messages' agent rows, the Workshop rail, a
    // session's header) renders after mount.
    'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z',
    // THE MESSAGE ACTIONS (#2387): the hover bar's smile and reply arrow, the
    // ⋯ menu's thread, copy, link, envelope, flag and struck circle, and the
    // emoji picker's heart and cup tabs. Every one draws only once a row is
    // hovered, pressed or opened, never in a cold document.
    'M15.182 15.182a4.5 4.5 0 0 1-6.364 0',
    'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    'M9 9.75h.01M15 9.75h.01',
    'M9 17l-5-5 5-5',
    'M20 18v-2a4 4 0 0 0-4-4H4',
    'M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155',
    'M9 9h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V9Z',
    'M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4',
    // LinkIcon came back to this list with the UI overhaul: it was the
    // "Invite to community" row's mark in the app chip's menu, and that row
    // left the menu for the hub's Invite (#3362).
    'M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244',
    // THE UI OVERHAUL put three more behind state. ChatIcon's bubble was the
    // menu's "Go to app discussion" row, which left for the hub's channel;
    // the menu's "Show more" under Agent sessions still draws it, after
    // mount. HandRaisedIcon and SpeechCheckIcon's tick were the Communities
    // screen's legend, which went with its tabs: the Needs you row that
    // replaced it draws the speech-check only when a vote waits, from data.
    'M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
    'M10.05 4.575a1.575 1.575 0 10-3.15 0v3m3.15-3v-1.5a1.575 1.575 0 013.15 0v1.5m-3.15 0l.075 5.925m3.075.75V4.575m0 0a1.575 1.575 0 013.15 0V15M6.9 7.575a1.575 1.575 0 10-3.15 0v8.175a6.75 6.75 0 006.75 6.75h2.018a5.25 5.25 0 003.712-1.537l1.732-1.732a5.25 5.25 0 001.538-3.712l.003-2.024a.668.668 0 01.198-.471 1.575 1.575 0 10-2.228-2.228 3.818 3.818 0 00-1.12 2.687M6.9 7.575V12m6.27 4.318A4.49 4.49 0 0116.35 15m.002 0h-.002',
    'M8.6 11.8l2.4 2.4 4.4-4.9',
    'M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75',
    'M3 3v1.5M3 21v-6m0 0 2.77-.693a9 9 0 0 1 6.208.682l.108.054a9 9 0 0 0 6.086.71l3.114-.732a48.524 48.524 0 0 1-.005-10.499l-3.11.732a9 9 0 0 1-6.085-.711l-.108-.054a9 9 0 0 0-6.208-.682L3 4.5M3 15V4.5',
    'M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636',
    'M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z',
    'M17 8h1a4 4 0 1 1 0 8h-1',
    'M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8Z',
    'M7 2v2M11 2v2M15 2v2',
    // THE FULL-WIDTH TOGGLE (#2387 follow-up): arrows out, and arrows in once
    // the list is hidden. Drawn in an open conversation's header, which only
    // renders once one is open.
    'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
    'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
    // CONTINUE WITH APPLE / GOOGLE: the Apple mark and the four parts of
    // Google's G, on the sign-in sheet's first step, which renders only once
    // the sheet is opened and an admin has set the provider up.
    'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701',
    'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z',
    'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z',
    'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z',
    'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z',
  ];
  assert.deepEqual(absent.sort(), expected.sort());
});

test('the three renderers keep the frame attributes each site shipped', () => {
  // fill / stroke / viewBox were identical at all 36 sites, which is why they
  // moved into the factories. The one real difference was where strokeWidth
  // sat — and it is a DOM difference, so a like-for-like conversion keeps it.
  const stroked = ICONS.slice(ICONS.indexOf('function stroked('), ICONS.indexOf('function strokedPath('));
  const strokedPath = ICONS.slice(ICONS.indexOf('function strokedPath('), ICONS.indexOf('function filled('));
  const filled = ICONS.slice(ICONS.indexOf('function filled('), ICONS.indexOf('// ── Navigation'));

  for (const [name, body] of [['stroked', stroked], ['strokedPath', strokedPath]]) {
    assert.match(body, /fill="none"/, `${name} must not fill`);
    assert.match(body, /stroke="currentColor"/, `${name} must inherit its colour`);
    assert.match(body, /viewBox="0 0 24 24"/, `${name} draws on the 24×24 grid`);
    assert.match(body, /strokeLinecap="round"\s*\n?\s*strokeLinejoin="round"/,
      `${name} keeps the rounded caps every site had`);
  }
  assert.match(stroked, /<svg[\s\S]*?strokeWidth=\{strokeWidth\}[\s\S]*?>/,
    'the stroked family carries strokeWidth on the <svg>');
  assert.ok(!/<path[^>]*strokeWidth/.test(stroked),
    'moving strokeWidth onto the path would change the DOM at 29 call sites');
  assert.match(strokedPath, /<path[\s\S]*?strokeWidth="2"/,
    'the strokedPath family carries strokeWidth on the <path> — five sites shipped it there');
  assert.match(filled, /fill="currentColor"/);
  assert.ok(!/stroke=/.test(filled), 'the GitHub mark is solid, not stroked');

  // id and className are rendered before the spread at every renderer: React
  // serialises in prop order, and the prerendered document is compared to the
  // hand-written shell attribute by attribute.
  for (const [name, body] of [['stroked', stroked], ['strokedPath', strokedPath], ['filled', filled]]) {
    const tag = body.slice(body.indexOf('<svg'), body.indexOf('>', body.indexOf('<svg')));
    assert.ok(tag.indexOf('id={id}') < tag.indexOf('className={className}')
      && tag.indexOf('className={className}') < tag.indexOf('{...rest}'),
      `${name} must render id, then className, then the spread`);
  }
});
