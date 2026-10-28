// scripts/test-changed.js — the suites that pin what you changed, and only
// those (AGENTS.md, "Run the suites that pin what you changed").
//
// ── What this pins ─────────────────────────────────────────────────────
//
// Suites here read their sources BY PATH, in four spellings, so a changed
// file selects the suites whose text names it in any of them; a module's
// importers (one level, under frontend/ and src/) are mapped too; a suite
// that reaches a file only through a longer chain names it with its own
// `test:changed: when` line (the Mayor golden and src/prompts/, #4267); and
// the command is the `test` script with the selected files in place of its
// glob, so the preload, the flags and the timeout cannot drift. The `test`
// script itself carries the per-test timeout that turns a hang into a
// failure, and package.json exposes the script the work order names.
//
// Run with: node --test tests/test-changed.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const tc = require('../scripts/test-changed');

const matches = (file, text) => tc.namePatterns(file).some((re) => re.test(text));

// ── Naming a file, in every spelling a suite uses ──────────────────────

test('a changed file is recognised in each spelling the suites use', () => {
  const file = 'src/services/github.js';
  for (const text of [
    "const src = read('src/services/github.js');",
    "const github = require('../src/services/github');",
    "fs.readFileSync(path.join(root, 'src/services/github.js'), 'utf8')",
    "path.join(__dirname, '..', 'src', 'services', 'github.js')",
    "path.join(__dirname, '..', 'src', 'services', 'github')",
    'import github from "../src/services/github";',
    "// a comment that names services/github.js by its tail",
    "read('./github.js')",
  ]) assert.ok(matches(file, text), text);
});

test('a name is bounded: a longer name, another extension or a directory of that name is not it', () => {
  const file = 'src/services/github.js';
  for (const text of [
    "require('../src/services/github-app')",
    "read('src/services/github.json')",
    "read('src/services/github/index.js')",
    "read('src/services/xgithub.js')",
    "read('src/services/my-github.js')",
    "path.join(__dirname, '..', 'src', 'services', 'github.json')",
  ]) assert.ok(!matches(file, text), text);
});

test('a frontend module is found through the @ alias and by its whole path', () => {
  const file = 'frontend/@/components/ui/chat.tsx';
  assert.ok(matches(file, "import { ChatMessageRow } from '@/components/ui/chat';"));
  assert.ok(matches(file, "loadTsx('frontend/@/components/ui/chat.tsx')"));
  assert.ok(!matches(file, "loadTsx('frontend/@/components/ui/chat-input.tsx')"));
});

// ── The mapping ────────────────────────────────────────────────────────

const suiteTexts = new Map([
  ['tests/github.test.js', "const github = require('../src/services/github');"],
  ['tests/routes.test.js', "read('src/routes/issues.js'); read('src/services/github.js');"],
  ['tests/chat.test.js', "loadTsx('frontend/src/features/group-chat/transcript.tsx')"],
  ['tests/unrelated.test.js', "read('public/js/app.js')"],
]);

test('each changed file selects the suites that name it; a changed suite selects itself', () => {
  const sel = tc.selectSuites(['src/services/github.js', 'tests/unrelated.test.js'], suiteTexts);
  assert.deepEqual(sel.suites, ['tests/github.test.js', 'tests/routes.test.js', 'tests/unrelated.test.js']);
  assert.deepEqual(sel.byFile.get('src/services/github.js').suites, ['tests/github.test.js', 'tests/routes.test.js']);
  assert.deepEqual(sel.byFile.get('tests/unrelated.test.js').suites, ['tests/unrelated.test.js']);
  assert.deepEqual(sel.unmatched, []);
});

test('a changed file no suite names is reported, not silently dropped', () => {
  const sel = tc.selectSuites(['docs/new-note.md', 'src/services/github.js'], suiteTexts);
  assert.deepEqual(sel.unmatched, ['docs/new-note.md']);
  assert.deepEqual(sel.suites, ['tests/github.test.js', 'tests/routes.test.js']);
});

test('an importer of a changed module brings its own suites, marked with what it imports', () => {
  const importers = new Map([['frontend/src/features/group-chat/transcript.tsx', ['frontend/@/components/ui/chat.tsx']]]);
  const sel = tc.selectSuites(['frontend/@/components/ui/chat.tsx'], suiteTexts, importers);
  assert.deepEqual(sel.suites, ['tests/chat.test.js']);
  assert.deepEqual(sel.byFile.get('frontend/src/features/group-chat/transcript.tsx').via, ['frontend/@/components/ui/chat.tsx']);
  // The primitive itself is named by no suite in this fixture — that is
  // still reported, because the importers' suites are not the same thing.
  assert.deepEqual(sel.unmatched, ['frontend/@/components/ui/chat.tsx']);
});

// ── Importers ──────────────────────────────────────────────────────────

test('import specifiers resolve against the importer, the @ alias against frontend/@, and packages not at all', () => {
  const found = tc.importedPaths('frontend/src/features/group-chat/transcript.tsx', [
    "import { ChatMessageRow } from '@/components/ui/chat';",
    "import { EventRow } from './proposal-event';",
    "import type { TranscriptMessage } from './transcript-store';",
    "import { swatchFor } from '../../lib/swatch.ts';",
    "import { useState } from 'react';",
    "const x = require('../../../../src/services/github');",
    "await import('./lazy')",
  ].join('\n'));
  assert.deepEqual([...found].sort(), [
    'frontend/@/components/ui/chat',
    'frontend/src/features/group-chat/lazy',
    'frontend/src/features/group-chat/proposal-event',
    'frontend/src/features/group-chat/transcript-store',
    'frontend/src/lib/swatch',
    'src/services/github',
  ]);
});

test('importers are found one level deep, for modules under frontend/ and src/ only', () => {
  const sources = {
    'frontend/src/features/group-chat/transcript.tsx': "import { ChatMessageRow } from '@/components/ui/chat';",
    'frontend/src/features/group-chat/mount.ts': "import { TranscriptRows } from './transcript';",
    'frontend/src/features/dialogs/index.tsx': "export * from './app-settings';",
    'frontend/src/features/dialogs/use-dialog.ts': "import { dialogs } from './index';",
    'src/routes/issues.js': "const github = require('../services/github');",
    'public/js/app-view.js': '// reaches GroupChat through a global',
  };
  const read = (f) => sources[f] || '';
  const files = Object.keys(sources);
  const importers = tc.importersOf(['frontend/@/components/ui/chat.tsx'], files, read);
  assert.deepEqual([...importers], [['frontend/src/features/group-chat/transcript.tsx', ['frontend/@/components/ui/chat.tsx']]],
    'transcript imports the primitive; mount imports transcript, which is a second level and stays out');
  const viaIndex = tc.importersOf(['frontend/src/features/dialogs/app-settings.tsx', 'frontend/src/features/dialogs/index.tsx'], files, read);
  assert.deepEqual([...viaIndex.keys()], ['frontend/src/features/dialogs/use-dialog.ts'], 'a directory import reaches its index module');
  const server = tc.importersOf(['src/services/github.js'], files, read);
  assert.deepEqual([...server.keys()], ['src/routes/issues.js']);
  assert.equal(tc.importersOf(['public/js/group-chat.js'], files, read).size, 0, 'public/js talks through globals: no import to follow');
});

// ── The command, and the scripts it comes from ─────────────────────────

test('the command is the test script with the selected suites in place of its glob', () => {
  const pkg = { scripts: { test: 'node --require ./tests/lib/test-net.js --test --test-force-exit --test-timeout=180000 tests/*.test.js' } };
  assert.deepEqual(tc.testCommand(pkg, ['tests/a.test.js', 'tests/b.test.js']), [
    'node', '--require', './tests/lib/test-net.js', '--test', '--test-force-exit', '--test-timeout=180000', 'tests/a.test.js', 'tests/b.test.js',
  ]);
  assert.throws(() => tc.testCommand({ scripts: { test: 'jest' } }, ['tests/a.test.js']), /must end with " tests\/\*\.test\.js"/);
});

test('package.json runs the suite with a per-test timeout and exposes test:changed behind the shell ensure step', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts.test.endsWith(` ${tc.SUITE_GLOB}`), 'test:changed reuses the test script, so its glob must stay last');
  // Bounds every test AND every file as a whole (node applies it to the
  // file's own test too); the slowest file takes about twelve seconds, so
  // three minutes is a hang, never a slow machine.
  assert.match(pkg.scripts.test, / --test-timeout=180000 /);
  assert.match(pkg.scripts.test, / --test-force-exit /);
  assert.equal(pkg.scripts['test:changed'], 'node scripts/test-changed.js');
  assert.equal(pkg.scripts['pretest:changed'], pkg.scripts.pretest, 'the same generated-shell step npm test runs first');
});

test('arguments: --base, --files, --list; anything else is refused', () => {
  assert.deepEqual(tc.parseArgs(['--base', 'abc', '--list']), { base: 'abc', files: null, list: true, help: false });
  assert.deepEqual(tc.parseArgs(['--files=a.js,b.tsx', '--base=HEAD']).files, ['a.js', 'b.tsx']);
  assert.throws(() => tc.parseArgs(['--watch']), /unknown argument: --watch/);
  assert.throws(() => tc.resolveBase('no-such-ref-anywhere'), /not a commit in this checkout/);
  assert.equal(tc.resolveBase('HEAD').source, '--base');
});

// ── The whole thing, listing only ──────────────────────────────────────

test('--list prints the mapping and the command and runs nothing', () => {
  // A file no suite can name: its name is built here, because a literal in
  // THIS file would be read by the mapper as this suite naming it.
  const ghost = ['docs', `nobody-reads-${Date.now()}.md`].join('/');
  const out = execFileSync(process.execPath, ['scripts/test-changed.js', '--list', '--files', `scripts/test-changed.js,${ghost}`], {
    cwd: root, encoding: 'utf8',
  });
  assert.match(out, /^test:changed: 2 file\(s\) named with --files/m);
  assert.match(out, /^  scripts\/test-changed\.js → \d+ suites?$/m);
  assert.match(out, /No suite names these files/);
  assert.ok(out.includes(`\n    ${ghost}\n`), 'the unnamed file is listed under that heading');
  assert.match(out, /^Running \d+ of \d+ suites:\n  node --require \.\/tests\/lib\/test-net\.js --test --test-force-exit --test-timeout=180000 .*tests\/test-changed\.test\.js/m);
  assert.doesNotMatch(out, /^# tests/m, 'listing runs no suite');
});

// ── The guards no change names ─────────────────────────────────────────

test('a suite marked "test:changed: always" runs on every change; the marker must start its line', () => {
  const texts = new Map([
    ['tests/icons.test.js', '// test:changed: always (every feature file)\n\'use strict\';'],
    ['tests/github.test.js', "const github = require('../src/services/github');"],
    ['tests/quoted.test.js', "const note = 'see // test:changed: always';"],
  ]);
  assert.deepEqual(tc.alwaysSuites(texts), ['tests/icons.test.js']);

  // The real ones: every whole-tree guard that failed a proposal late.
  const marked = tc.alwaysSuites(new Map(fs.readdirSync(path.join(root, 'tests'))
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => [`tests/${f}`, fs.readFileSync(path.join(root, 'tests', f), 'utf8')])));
  for (const suite of ['shell-icon-set', 'theme-ink-guards', 'no-em-dash-in-copy', 'admin-ui-registry']) {
    assert.ok(marked.includes(`tests/${suite}.test.js`), `${suite} is marked`);
  }
  assert.ok(marked.length <= 12, 'a short list of fast guards, not a second npm test');

  // Listed apart from the mapping, and run even when no suite names the change.
  const ghost = ['docs', `nobody-reads-${Date.now()}.md`].join('/');
  const out = execFileSync(process.execPath, ['scripts/test-changed.js', '--list', '--files', ghost], { cwd: root, encoding: 'utf8' });
  assert.match(out, new RegExp(`^  \\+ ${marked.length} tree-wide guard suites, run on every change:$`, 'm'));
  assert.match(out, /^    tests\/shell-icon-set\.test\.js$/m);
  assert.match(out, new RegExp(`^Running ${marked.length} of \\d+ suites:`, 'm'), 'an unnamed change still runs the guards');
});

// ── The files a suite reaches only through a chain ─────────────────────

test('a "test:changed: when" line declares paths: several per line, a trailing slash dropped, only at the start of a line', () => {
  assert.deepEqual(tc.declaredPaths([
    "// test:changed: when src/templates/ (the pages built from them)",
    "// test:changed: when ./docs/a.md, docs/b.md",
    "'use strict';",
    "const note = 'see // test:changed: when src/elsewhere/';",
  ].join('\n')), ['src/templates', 'docs/a.md', 'docs/b.md']);
  assert.deepEqual(tc.declaredPaths("// test:changed: always (every feature file)"), []);
});

test('a declared directory selects its suite for any file under it, and nothing beside it', () => {
  const texts = new Map([
    ['tests/golden.test.js', "// test:changed: when src/templates/ (why)\nrequire('../src/routes/pages');"],
    ['tests/one-file.test.js', "// test:changed: when docs/a.md (why)"],
    ['tests/names-it.test.js', "// test:changed: when src/templates/ (why)\nread('src/templates/home.md');"],
  ]);
  const sel = tc.selectSuites(['src/templates/home.md', 'src/templates/deep/footer.md', 'src/templates-old/legacy.md', 'docs/a.md', 'docs/a.mdx'], texts);
  assert.deepEqual(sel.byFile.get('src/templates/home.md').suites, ['tests/golden.test.js', 'tests/names-it.test.js']);
  assert.deepEqual(sel.byFile.get('src/templates/home.md').declared, ['tests/golden.test.js'],
    'a suite that also names the file is selected by name; the declaration is only how the rest were found');
  assert.deepEqual(sel.byFile.get('src/templates/deep/footer.md').declared, ['tests/golden.test.js', 'tests/names-it.test.js']);
  assert.deepEqual(sel.byFile.get('docs/a.md').suites, ['tests/one-file.test.js']);
  assert.deepEqual(sel.unmatched, ['src/templates-old/legacy.md', 'docs/a.mdx'], 'a shared prefix is not the file or the directory');
  assert.deepEqual(sel.suites, ['tests/golden.test.js', 'tests/names-it.test.js', 'tests/one-file.test.js']);
});

test('the Mayor golden runs when any prompt changes, and every declared path exists', () => {
  const texts = new Map(fs.readdirSync(path.join(root, 'tests'))
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => [`tests/${f}`, fs.readFileSync(path.join(root, 'tests', f), 'utf8')]));
  const golden = 'tests/mayor-turn-golden.test.js';
  // routes/sessions.js -> services/mayor/prompt.js -> services/prompts.js
  // reads the file: three requires deep, past the importer mapping.
  assert.deepEqual(tc.declaredPaths(texts.get(golden)), ['src/prompts']);
  for (const [suite, text] of texts) {
    for (const declared of tc.declaredPaths(text)) {
      assert.ok(fs.existsSync(path.join(root, declared)), `${suite} declares ${declared}, which does not exist: a moved file leaves it unselected`);
    }
  }

  // Each prompt file by its real path, read from the directory: a literal
  // name here would make THIS suite name it, and run on every prompt edit.
  const prompts = fs.readdirSync(path.join(root, 'src', 'prompts')).filter((f) => f.endsWith('.md')).map((f) => `src/prompts/${f}`);
  assert.ok(prompts.length >= 2);
  const sel = tc.selectSuites(prompts, texts);
  for (const file of prompts) assert.ok(sel.byFile.get(file).suites.includes(golden), `${file} selects the golden`);

  // The listing says which suites a declaration brought in.
  const declared = prompts.find((file) => sel.byFile.get(file).declared.includes(golden));
  assert.ok(declared, 'the golden names no prompt file, so its declaration is what selects it');
  const out = execFileSync(process.execPath, ['scripts/test-changed.js', '--list', '--files', declared], { cwd: root, encoding: 'utf8' });
  assert.match(out, new RegExp(`^  ${declared.replace(/[.]/g, '\\.')} → \\d+ suites \\(incl\\. .*${golden.replace(/[.]/g, '\\.')}.*, which declares? it\\)$`, 'm'));
  assert.match(out, /^Running \d+ of \d+ suites:\n  node .* tests\/mayor-turn-golden\.test\.js/m);
});
