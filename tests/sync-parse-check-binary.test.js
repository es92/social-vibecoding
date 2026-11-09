'use strict';

// worker/sync-parse-check.js without the checkout's own esbuild: it runs the
// worker image's esbuild binary as a command (worker/Dockerfile builds it from
// source with a patched Go, 9 Nov 2026: npm's prebuilt one carried Go 1.23.12,
// whose standard library the release's image scan blocked).
//
// A stub binary stands in for it and prints esbuild's own error format; when a
// real esbuild binary is at hand (the worker image's, or
// SYNC_PARSE_REAL_ESBUILD), it is run too, so the parsing of its output is
// checked against the real thing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The script looks for the frontend's esbuild beside the checkout it runs in
// AND beside itself (this repository's own frontend/node_modules, which the
// test preflight may have installed), so each test runs a copy of it from its
// own workspace.
const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'worker', 'sync-parse-check.js'), 'utf8');

// esbuild's command line, in miniature: refuses a line that starts with `**`,
// the way the real one prints it (0-based column), and exits 1.
const STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);
const file = (args.find((a) => a.startsWith('--sourcefile=')) || '--sourcefile=<stdin>').slice(13);
let source = '';
process.stdin.on('data', (d) => { source += d; });
process.stdin.on('end', () => {
  if (process.env.STUB_DIE) process.kill(process.pid, 'SIGKILL');
  const lines = source.split('\\n');
  const at = lines.findIndex((l) => l.startsWith('**'));
  if (at < 0) process.exit(0);
  process.stderr.write('\\u2718 [ERROR] Unexpected "**"\\n\\n    ' + file + ':' + (at + 1) + ':0:\\n      ' + (at + 1) + ' \\u2502 **\\n        \\u2575 ^\\n\\n');
  process.exit(1);
});
`;

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-parse-bin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'worker'));
  fs.writeFileSync(path.join(dir, 'worker', 'sync-parse-check.js'), SCRIPT_SOURCE);
  const bin = path.join(dir, 'stub-esbuild');
  fs.writeFileSync(bin, STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'good.tsx'), 'export const a = <div>{1}</div>;\n');
  fs.writeFileSync(path.join(dir, 'bad.tsx'), 'const a = 1;\n/*\n** doc\n*/\n');
  fs.writeFileSync(path.join(dir, 'fine.js'), 'module.exports = 1;\n');
  return { dir, bin };
}

function run(cwd, files, env = {}) {
  const out = spawnSync(process.execPath, [path.join(cwd, 'worker', 'sync-parse-check.js'), ...files], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

test('with no frontend esbuild, the image binary checks TypeScript and its error is file:line:column', (t) => {
  const { dir, bin } = workspace(t);
  const out = run(dir, ['good.tsx', 'bad.tsx', 'fine.js'], { SYNC_PARSE_ESBUILD_BIN: bin });
  assert.equal(out.status, 1);
  assert.equal(out.stdout, 'bad.tsx:3:1: Unexpected "**"\n', 'only the file that does not parse, 1-based column');
  assert.equal(out.stderr, '');
});

test('a binary that is not there checks nothing and fails nothing, and says so', (t) => {
  const { dir } = workspace(t);
  const out = run(dir, ['bad.tsx'], { SYNC_PARSE_ESBUILD_BIN: path.join(dir, 'missing') });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
  assert.match(out.stderr, /esbuild is not installed; bad\.tsx was not checked/);
});

test('a binary that dies instead of answering is not a parse failure', (t) => {
  const { dir, bin } = workspace(t);
  const out = run(dir, ['bad.tsx'], { SYNC_PARSE_ESBUILD_BIN: bin, STUB_DIE: '1' });
  assert.equal(out.status, 0, 'a gate that cannot run must not stop the push');
  assert.equal(out.stdout, '');
  assert.match(out.stderr, /esbuild could not run \(SIGKILL\); bad\.tsx was not checked/);
});

test('the checkout\'s own esbuild still comes first', (t) => {
  const { dir, bin } = workspace(t);
  const mod = path.join(dir, 'frontend', 'node_modules', 'esbuild');
  fs.mkdirSync(mod, { recursive: true });
  fs.writeFileSync(path.join(mod, 'package.json'), JSON.stringify({ name: 'esbuild', main: 'index.js' }));
  // Refuses nothing: had the binary been used, bad.tsx would fail.
  fs.writeFileSync(path.join(mod, 'index.js'), 'module.exports = { transformSync() { return { code: "" }; } };\n');
  const out = run(dir, ['bad.tsx'], { SYNC_PARSE_ESBUILD_BIN: bin });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, '');
});

// A real esbuild binary, when one is here: the worker image's (the unit suite
// runs in it), or one named by SYNC_PARSE_REAL_ESBUILD.
function realEsbuild() {
  for (const candidate of [process.env.SYNC_PARSE_REAL_ESBUILD, '/usr/local/bin/esbuild']) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

test('the real esbuild binary\'s errors are read the same way', (t) => {
  const real = realEsbuild();
  if (!real) { t.skip('no esbuild binary here; the worker image has one at /usr/local/bin/esbuild'); return; }
  const { dir } = workspace(t);
  fs.writeFileSync(path.join(dir, 'broken.ts'), 'let a b\n');
  fs.writeFileSync(path.join(dir, 'ok.ts'), 'export const n: number = 1;\n');
  const out = run(dir, ['broken.ts', 'ok.ts', 'good.tsx'], { SYNC_PARSE_ESBUILD_BIN: real });
  assert.equal(out.status, 1);
  assert.equal(out.stdout, 'broken.ts:1:7: Expected ";" but found "b"\n');
});
