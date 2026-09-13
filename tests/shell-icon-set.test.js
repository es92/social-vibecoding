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
// Document plus the interiors that mount on first reveal: a glyph in the
// settings panes or the anonymous shell is still one the shell ships.
const HTML = shellMarkup();
const PKG = JSON.parse(read('frontend/package.json'));

/** Every single-quoted string in the module that looks like SVG path data. */
function modulePaths() {
  return new Set(ICONS.match(/'M[^'\\\n]*'/g).map((s) => s.slice(1, -1)));
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
  const exported = modulePaths();
  const strays = [...shipped].filter((d) => !exported.has(d));
  assert.deepEqual(strays, [],
    `${strays.length} path(s) in public/index.html are not in icons.tsx. Either a glyph `
    + 'was re-inlined, or a transcription drifted by a character — which is a silent '
    + 'visual change, since the wrong path still draws something.');
  // Was 24 before THE UI OVERHAUL. Five glyphs stopped prerendering when the
  // surfaces that drew them were retired — see the expected-absent list in the
  // next test, which names each one — and two were added with the Improve
  // panel's rows.
  // 21 before the #1367 follow-up removed the notifications disclosure, which
  // was ChevronRightIcon's last prerendered call site (see the expected-absent
  // list in the next test, which records its full history).
  assert.ok(shipped.size >= 20,
    `only ${shipped.size} glyph paths in the prerendered document — the shell ships 20, `
    + 'so something stopped rendering');
});

test('the glyphs that do NOT prerender are the ones that render behind state', () => {
  // Not every export lands in the static document, and that is fine — but it
  // has to be a KNOWN list, or "my new icon is missing from index.html" reads
  // as normal instead of as the hydration bug it usually is.
  const shipped = new Set(HTML.match(/\sd="[^"]*"/g).map((s) => s.slice(4, -1)));
  const absent = [...modulePaths()].filter((d) => !shipped.has(d));
  // The Needs-you feed's rail — ballot (three paths), raised hand,
  // sparkles, play — and the chevron-up its arrows use, all client-rendered.
  const expected = [
    'M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z',
    'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z',
    'M4 6a1 1 0 011-1h14a1 1 0 011 1v12a1 1 0 01-1 1H5a1 1 0 01-1-1V6z',
    'M4 9.5h16',
    'M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3',
    'M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
    'M8.6 11.8l2.4 2.4 4.4-4.9',
    'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
    'M5 13l4 4L19 7',
    'M13 7l5 5m0 0l-5 5m5-5H6',
    'M16.023 9.348h4.992V4.356m-4.992 4.992l3.181-3.183a8.25 8.25 0 00-13.803 3.7M4.031 9.865v4.99m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7',
    'M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-7.322c.983.143 1.954.317 2.916.52a6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0',
    'M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z',
    'M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
    'M16.5 6.5a2.12 2.12 0 0 1 3 3L9 20l-4 1 1-4z',
    'M6 3l.75 1.75L8.5 5.5l-1.75.75L6 8l-.75-1.75L3.5 5.5l1.75-.75z',
    'M4 6h16M4 12h16M4 18h16',
    'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z',
    'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    'M15 18l-6-6 6-6',
    'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zm8-1a3 3 0 010 6m4 5v-2a4 4 0 00-3-3.9',
    'M21.4 11.6l-8.5 8.5a6 6 0 01-8.5-8.5l9-9a4 4 0 015.7 5.7l-9 9a2 2 0 01-2.8-2.8l8.4-8.4',
    'M12 3v12m0-12l-4 4m4-4l4 4M5 13v7h14v-7',
    'M4 4l17 8-17 8 3-8-3-8zm3 8h14',
    'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z',
    'M8.25 9L12 5.25 15.75 9',
    'M12 5.5v13',
    'M8.25 15L12 18.75 15.75 15',
    'M12 4.5v15m7.5-7.5h-15',
    'M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z',
    'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.732 0 2.814-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z',
    'M4 20 20 4',
    'M4.5 12.75l6 6 9-13.5',
    'M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z',
    'M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z',
    'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z',
    'M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5',
    'M16 11V3H8v8M5 7H3v4a2 2 0 002 2h3M19 7h2v4a2 2 0 01-2 2h-3M8 15a4 4 0 008 0h-8z M12 15v3m-3 3h6',
    'M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z',
    'M6.32 2.577a49.255 49.255 0 0 1 11.36 0c1.497.174 2.57 1.46 2.57 2.93V21a.75.75 0 0 1-1.085.67L12 18.089l-7.165 3.583A.75.75 0 0 1 3.75 21V5.507c0-1.47 1.073-2.756 2.57-2.93Z',
    'M12 19V5M5 12l7-7 7 7',
    'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48',
    'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z',
    'M17 21v-8H7v8',
    'M7 3v5h8',
    'M22 2 11 13',
    'M22 2 15 22l-4-9-9-4z',
    'M12 20h9',
    'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
    'M3 6h18',
    'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2',
    'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
    'M9 3.75H6.912a2.25 2.25 0 00-2.15 1.588L2.35 13.177a2.25 2.25 0 00-.1.661V18a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 00-2.15-1.588H15',
    'M2.25 13.5h3.86a2.25 2.25 0 012.012 1.244l.256.512a2.25 2.25 0 002.013 1.244h3.218a2.25 2.25 0 002.013-1.244l.256-.512a2.25 2.25 0 012.013-1.244h3.859',
    'M12 3v8.25m0 0l-3-3m3 3l3-3',
    'M10.05 4.575a1.575 1.575 0 10-3.15 0v3m3.15-3v-1.5a1.575 1.575 0 013.15 0v1.5m-3.15 0l.075 5.925m3.075.75V4.575m0 0a1.575 1.575 0 013.15 0V15M6.9 7.575a1.575 1.575 0 10-3.15 0v8.175a6.75 6.75 0 006.75 6.75h2.018a5.25 5.25 0 003.712-1.537l1.732-1.732a5.25 5.25 0 001.538-3.712l.003-2.024a.668.668 0 01.198-.471 1.575 1.575 0 10-2.228-2.228 3.818 3.818 0 00-1.12 2.687M6.9 7.575V12m6.27 4.318A4.49 4.49 0 0116.35 15m.002 0h-.002',
    'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z',
    'M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z',
    'M5 15l7-7 7 7',
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
