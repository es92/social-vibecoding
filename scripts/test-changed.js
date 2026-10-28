#!/usr/bin/env node
'use strict';

// Run the suites that pin the files you changed, and only those.
//
//   npm run test:changed -- --base <commit>      diff against that commit
//   npm run test:changed -- --files a.js,b.tsx   name the changed files yourself
//   npm run test:changed -- --list               print the mapping, run nothing
//
// ── Why this exists ─────────────────────────────────────────────────────
//
// Homeroom runs the whole unit suite and every declared check against a
// commit when it is submitted, in a clean container. A local run of all
// 19,000+ tests duplicates that, minutes at a time, and it is not what a
// change needs before submission: that is to know, quickly, whether the
// files it touched still satisfy the suites that read them. AGENTS.md
// carries the rule; this is the mechanism.
//
// ── How a change maps to suites ─────────────────────────────────────────
//
// The suites in tests/ read the sources they pin BY PATH, in four spellings:
//
//   read('public/js/app.js')                        the whole path
//   require('../src/services/github')               the path, no extension
//   path.join(root, 'src/services/github.js')       the whole path again
//   path.join(__dirname, '..', 'src', 'services', 'github.js')   as segments
//
// So a changed file selects every suite whose text names it in any of those
// spellings: the whole path with and without its extension, every suffix of
// two or more segments (`services/github`, for a suite that reaches it from
// another root), and last the bare file name with its extension. A changed
// suite selects itself. For a module under frontend/ or src/, the files that
// IMPORT it (one level, by relative or `@/` specifier) are mapped too, so a
// primitive's change runs the suites of the screens drawn with it. Modules
// under public/js/ talk through globals, not imports, so a change there runs
// the suites naming the module and nothing more — when one of those is
// shared, run `npm test`.
//
// ── The guards that no change names ─────────────────────────────────────
//
// A few suites are rules over a whole tree rather than pins on a file: no
// raw <svg> in a feature file, no unpaired zinc-400 ink, no em dash in copy,
// the admin console's registry, and the like. They walk a directory, so
// they name no file and the mapping above never selects them, and a change
// that breaks one found out only when Homeroom ran everything. Such a suite
// opts in with a line of its own, at the start of a line:
//
//   // test:changed: always (<what it walks>)
//
// and every run with a change adds it. Keep it to fast guards: the ones
// marked today take about five seconds together.
//
// ── The files a suite reaches only through a chain ──────────────────────
//
// A suite can depend on a file it never names and that nothing it requires
// imports directly. The Mayor turn golden pins, by sha, the Mayor's system
// prompt and the coding agent's, and both are built from the markdown in
// src/prompts/: the suite requires routes/sessions.js, which requires
// services/mayor/prompt.js, which requires services/prompts.js, which reads
// the file. The importer mapping stops one level up and a .md file imports
// nothing, so a paragraph added to app-conventions.md ran fifteen suites and
// not the golden it broke (#4267). Such a suite names what it depends on in
// a line of its own, at the start of a line:
//
//   // test:changed: when <path> [<path> ...] (<why>)
//
// A path covers that file, or every file under that directory, and a change
// to any of them selects the suite. Declare the directory a module reads
// from rather than today's files in it, so a new file is covered too.
//
// The command is the `test` script from package.json with the selected
// files in place of its glob, so the two cannot drift: same preload, same
// flags, same timeout.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = 'tests';
const SUITE_GLOB = 'tests/*.test.js';
// Where importers are looked for. Bare specifiers (packages) never resolve
// here, and public/js/ is excluded on purpose (see the header).
const IMPORT_ROOTS = ['frontend/src', 'frontend/@', 'src'];
const SOURCE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx'];
// The remotes a checkout tends to have, most authoritative first. The work
// order's base commit beats every one of them — pass it as --base.
const DEFAULT_BASES = ['canonical/main', 'upstream/main', 'origin/main'];

function parseArgs(argv) {
  const opts = { base: null, files: null, list: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') opts.list = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--base') opts.base = argv[++i] || null;
    else if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length);
    else if (arg === '--files') opts.files = splitList(argv[++i]);
    else if (arg.startsWith('--files=')) opts.files = splitList(arg.slice('--files='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function splitList(value) {
  return String(value || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function refExists(ref) {
  try { git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return true; } catch { return false; }
}

// Which commit the diff is against: --base, else TEST_CHANGED_BASE, else the
// first remote main this checkout has. The merge-base with HEAD is what is
// diffed, so a base that has moved on (a fork's stale main, a commit main has
// since passed) does not turn the rest of the world into "your change".
function resolveBase(requested) {
  const wanted = requested || process.env.TEST_CHANGED_BASE || null;
  if (wanted) {
    if (!refExists(wanted)) throw new Error(`--base ${wanted} is not a commit in this checkout; fetch it first`);
    return { ref: wanted, source: requested ? '--base' : 'TEST_CHANGED_BASE' };
  }
  const found = DEFAULT_BASES.find(refExists);
  if (!found) throw new Error('no --base given and no canonical/upstream/origin main to diff against');
  return { ref: found, source: 'default' };
}

// Every path the working tree differs in from the merge-base: committed on
// this branch, staged, unstaged, and untracked alike. Deleted files stay in
// the list — a suite that still reads one is exactly a suite to run.
function changedFiles(baseRef) {
  let mergeBase = baseRef;
  try { mergeBase = git(['merge-base', baseRef, 'HEAD']).trim() || baseRef; } catch { /* keep the ref */ }
  const diffed = git(['diff', '--name-only', mergeBase, '--']).split('\n');
  const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
  const files = [...new Set([...diffed, ...untracked].map((f) => f.trim()).filter(Boolean))].sort();
  return { mergeBase, files };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The regexes that recognise `file` in a suite's text, most specific first.
// A path is bounded by anything that cannot be part of one, so `foo.js`
// never matches `foo.json` or `my-foo.js`, and the extensionless spelling is
// not followed by more path (`services/foo` is not `services/foo-bar` or
// `services/foo/index`).
function namePatterns(file) {
  const ext = path.posix.extname(file);
  const bare = ext ? file.slice(0, -ext.length) : file;
  const segments = file.split('/');
  const out = [];
  const left = '(?<![\\w.@-])';
  const rightExt = '(?![\\w.-])';
  const rightBare = '(?![\\w.\\-/])';
  for (let k = segments.length; k >= 2; k -= 1) {
    const suffix = segments.slice(segments.length - k);
    const suffixBare = bare.split('/').slice(segments.length - k);
    out.push(new RegExp(left + escapeRe(suffix.join('/')) + rightExt));
    if (ext) out.push(new RegExp(left + escapeRe(suffixBare.join('/')) + rightBare));
    // path.join(__dirname, '..', 'src', 'services', 'github.js')
    for (const q of ["'", '"']) {
      out.push(new RegExp(escapeRe(suffix.map((s) => q + s + q).join(', '))));
      if (ext) out.push(new RegExp(escapeRe(suffixBare.map((s) => q + s + q).join(', ')) + '(?!\\.)'));
    }
  }
  out.push(new RegExp(left + escapeRe(segments[segments.length - 1]) + rightExt));
  return out;
}

function isSuite(file) {
  return /^tests\/[^/]+\.test\.js$/.test(file);
}

function listSuites() {
  return fs.readdirSync(path.join(ROOT, TESTS_DIR))
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => `${TESTS_DIR}/${f}`);
}

function readSuites(suites) {
  const texts = new Map();
  for (const suite of suites) {
    try { texts.set(suite, fs.readFileSync(path.join(ROOT, suite), 'utf8')); } catch { texts.set(suite, ''); }
  }
  return texts;
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (SOURCE_EXTS.includes(path.posix.extname(entry.name))) out.push(rel);
  }
  return out;
}

function stripExt(file) {
  const ext = path.posix.extname(file);
  return SOURCE_EXTS.includes(ext) ? file.slice(0, -ext.length) : file;
}

// The specifiers a source file imports, resolved to repo-relative paths
// without extension: `@/x` is frontend/@/x (frontend/tsconfig.json's alias),
// `./x` and `../x` resolve against the importer, bare names are packages.
function importedPaths(importer, text) {
  const out = new Set();
  const re = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(text))) {
    const spec = m[1];
    let resolved = null;
    if (spec.startsWith('@/')) resolved = `frontend/@/${spec.slice(2)}`;
    else if (spec.startsWith('./') || spec.startsWith('../')) resolved = path.posix.normalize(path.posix.join(path.posix.dirname(importer), spec));
    if (resolved && !resolved.startsWith('../')) out.add(stripExt(resolved));
  }
  return out;
}

// One level of importers for each changed module under IMPORT_ROOTS: the
// screens a primitive is drawn with, the routes a service is wired into.
function importersOf(changed, sourceFiles, readSource) {
  const targets = new Map();
  for (const file of changed) {
    if (!IMPORT_ROOTS.some((root) => file.startsWith(`${root}/`))) continue;
    const bare = stripExt(file);
    targets.set(bare, file);
    if (path.posix.basename(bare) === 'index') targets.set(path.posix.dirname(bare), file);
  }
  const result = new Map();
  if (!targets.size) return result;
  for (const source of sourceFiles) {
    if (changed.includes(source)) continue;
    const imports = importedPaths(source, readSource(source));
    for (const [bare, file] of targets) {
      if (imports.has(bare)) {
        if (!result.has(source)) result.set(source, []);
        result.get(source).push(file);
      }
    }
  }
  return result;
}

// The paths a suite declares it depends on (see the header), repo-relative
// and without a trailing slash: `// test:changed: when src/prompts/ (why)`.
const WHEN_MARKER = /^\/\/ test:changed: when ([^(\n]*)/gm;
function declaredPaths(text) {
  const out = [];
  for (const m of String(text).matchAll(WHEN_MARKER)) {
    for (const p of splitList(m[1])) out.push(path.posix.normalize(p).replace(/\/+$/, ''));
  }
  return out;
}

// A declared path covers that file and everything under it.
function covers(declared, file) {
  return file === declared || file.startsWith(`${declared}/`);
}

// The mapping: which suites each changed file (and each importer) selects,
// by name or by a suite's declaration; `declared` lists the latter.
function selectSuites(changed, suiteTexts, importers = new Map()) {
  const bySuite = new Map();
  const byFile = new Map();
  const declarations = new Map([...suiteTexts].map(([suite, text]) => [suite, declaredPaths(text)]));
  const consider = [...changed.map((f) => [f, null]), ...[...importers].map(([f, via]) => [f, via])];
  for (const [file, via] of consider) {
    const hits = [];
    const declared = [];
    if (isSuite(file) && suiteTexts.has(file)) hits.push(file);
    else {
      const patterns = namePatterns(file);
      for (const [suite, text] of suiteTexts) {
        if (patterns.some((re) => re.test(text))) hits.push(suite);
        else if (declarations.get(suite).some((p) => covers(p, file))) { hits.push(suite); declared.push(suite); }
      }
    }
    byFile.set(file, { suites: hits, via, declared });
    for (const suite of hits) {
      if (!bySuite.has(suite)) bySuite.set(suite, []);
      bySuite.get(suite).push(file);
    }
  }
  const unmatched = changed.filter((f) => !byFile.get(f).suites.length);
  return { suites: [...bySuite.keys()].sort(), byFile, unmatched };
}

// The suites that run on every change, whatever it touched (see the header).
const ALWAYS_MARKER = /^\/\/ test:changed: always\b/m;
function alwaysSuites(suiteTexts) {
  return [...suiteTexts].filter(([, text]) => ALWAYS_MARKER.test(text)).map(([suite]) => suite).sort();
}

// The `test` script with the selected suites in place of its glob.
function testCommand(packageJson, suites) {
  const script = packageJson && packageJson.scripts && packageJson.scripts.test;
  if (typeof script !== 'string' || !script.endsWith(` ${SUITE_GLOB}`)) {
    throw new Error(`package.json's test script must end with " ${SUITE_GLOB}" for test:changed to reuse it`);
  }
  return [...script.slice(0, -SUITE_GLOB.length).trim().split(/\s+/), ...suites];
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    return 0;
  }
  let changed;
  let heading;
  if (opts.files) {
    changed = [...new Set(opts.files.map((f) => path.posix.normalize(f)))].sort();
    heading = `test:changed: ${changed.length} file(s) named with --files`;
  } else {
    const base = resolveBase(opts.base);
    const found = changedFiles(base.ref);
    changed = found.files;
    heading = `test:changed: ${changed.length} file(s) differ from ${base.ref}`
      + (base.source === 'default' ? ' (no --base given: pass the work order\'s base commit for an exact answer)' : '')
      + ` at ${found.mergeBase.slice(0, 12)}`;
  }
  process.stdout.write(`${heading}\n`);
  if (!changed.length) return 0;

  const suites = listSuites();
  const suiteTexts = readSuites(suites);
  const sourceFiles = IMPORT_ROOTS.flatMap((root) => walk(root, []));
  const importers = importersOf(changed, sourceFiles, (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } });
  const selection = selectSuites(changed, suiteTexts, importers);

  const count = ({ suites: hits, declared }) => `${hits.length} suite${hits.length === 1 ? '' : 's'}`
    + (declared.length ? ` (incl. ${declared.join(', ')}, which declare${declared.length === 1 ? 's' : ''} it)` : '');
  for (const file of changed) {
    process.stdout.write(`  ${file} → ${count(selection.byFile.get(file))}\n`);
  }
  for (const [file, entry] of selection.byFile) {
    if (!entry.via) continue;
    process.stdout.write(`  ${file} → ${count(entry)} (imports ${entry.via.join(', ')})\n`);
  }
  if (selection.unmatched.length) {
    process.stdout.write('  No suite names these files. If one of them is shared code, run `npm test`;\n'
      + '  if it is a screen, the test that should pin it does not exist yet:\n');
    for (const file of selection.unmatched) process.stdout.write(`    ${file}\n`);
  }
  const guards = alwaysSuites(suiteTexts).filter((suite) => !selection.suites.includes(suite));
  if (guards.length) {
    process.stdout.write(`  + ${guards.length} tree-wide guard suite${guards.length === 1 ? '' : 's'}, run on every change:\n`);
    for (const suite of guards) process.stdout.write(`    ${suite}\n`);
  }
  const selected = [...selection.suites, ...guards].sort();
  if (!selected.length) {
    process.stdout.write('test:changed: nothing to run — no suite reads any of the changed files.\n');
    return 0;
  }
  const command = testCommand(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')), selected);
  process.stdout.write(`Running ${selected.length} of ${suites.length} suites:\n  ${command.join(' ')}\n`);
  if (opts.list) return 0;
  const [bin, ...args] = command;
  const run = spawnSync(bin === 'node' ? process.execPath : bin, args, { cwd: ROOT, stdio: 'inherit' });
  return run.status == null ? 1 : run.status;
}

module.exports = {
  parseArgs, namePatterns, selectSuites, alwaysSuites, declaredPaths, importersOf, importedPaths, testCommand, changedFiles, resolveBase, main,
  SUITE_GLOB, IMPORT_ROOTS, DEFAULT_BASES,
};

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`test:changed: ${err.message}\n`);
    process.exitCode = 1;
  }
}
