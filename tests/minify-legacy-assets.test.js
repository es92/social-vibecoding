'use strict';

// #6798, #7165: an image serves the legacy scripts, app.css and the kit without their
// comments and indentation (scripts/minify-legacy-assets.js). Pinned here:
// what the step may not change (names, strings, files, the order of CSS
// rules), that it refuses a file it cannot shrink, and that a checkout's
// own files are never touched by anything but the image build.
//
// Run with: node --test tests/minify-legacy-assets.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const { minifyLegacyAssets, minifyScript, minifyStylesheet, loadEsbuild, STYLESHEETS, KIT_SCRIPTS } = require('../scripts/minify-legacy-assets');

const esbuild = loadEsbuild();

test('a script keeps its names, its strings and what it does; only what a browser skips goes', () => {
  const source = `// A classic script: other scripts reach these by name.
const Greeter = {
  /* The words are data. */
  WORDS: 'hello   world',   // inner spaces are the string's own
  template: \`<p class="a  b">
    \${1 + 1}
  </p>\`,
  greet(name) {
    const unusedLocal = 1;
    return Greeter.WORDS + ', ' + name + '\\u00a0!';
  },
};
function topLevelHelper(value) { return value === undefined ? 'none' : String(value); }
var legacyGlobal = topLevelHelper();
`;
  const code = minifyScript(esbuild, source);
  assert.ok(code.length < source.length);
  assert.doesNotMatch(code, /classic script|words are data|inner spaces/, 'comments are gone');
  const run = (text) => {
    const box = {};
    vm.createContext(box);
    vm.runInContext(`${text}\n;globalThis.out = { greet: Greeter.greet('Ada'), template: Greeter.template, helper: topLevelHelper(3), legacyGlobal, names: [typeof Greeter, typeof topLevelHelper] };`, box);
    return JSON.stringify(box.out);
  };
  assert.equal(run(code), run(source), 'the same top-level names, strings and results');
  assert.match(code, /\\u00a0|\\xA0/i, 'an escape stays an escape: nothing depends on how the file is served');
});

test('the stylesheet keeps every rule and declaration in order', () => {
  const source = `/* A comment. */
.a { color: red; }
@media (min-width: 768px) {
  .b:has(#x:not(.hidden)) > .c { margin: 0 auto; }
}
.a { color: blue; }   /* later wins: order is the cascade */
.d::after { content: "\\203a"; }
`;
  const code = minifyStylesheet(esbuild, source);
  assert.ok(code.length < source.length);
  assert.doesNotMatch(code, /A comment|later wins/);
  const order = ['.a{color:red}', '@media', '.b:has(#x:not(.hidden))>.c{margin:0 auto}', '.a{color:#00f}|.a{color:blue}', '.d:after{content:"\\\\203a"}|.d::after{content:"\\\\203a"}'];
  let at = 0;
  for (const want of order) {
    const found = want.split('|').map((w) => code.indexOf(w.replace('\\\\', '\\'), at)).filter((i) => i >= 0);
    assert.ok(found.length, `${want} is still there, after the rule before it`);
    at = Math.min(...found);
  }
  assert.equal((code.match(/\.a\{/g) || []).length, 2, 'two rules for one selector are not merged');
});

test('every legacy script and app.css come out smaller and still parse, in a copy', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minify-legacy-'));
  try {
    fs.cpSync(path.join(ROOT, 'public', 'js'), path.join(tmp, 'js'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'css'));
    fs.copyFileSync(path.join(ROOT, 'public', 'css', 'app.css'), path.join(tmp, 'css', 'app.css'));
    const before = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    const results = minifyLegacyAssets({ publicDir: tmp, esbuild });
    const names = results.map((r) => r.file).sort();
    assert.ok(names.includes(path.join('js', 'app.js')) && names.includes(path.join('js', 'app-view.js')));
    assert.ok(names.includes(path.join('css', 'app.css')));
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'js')).sort(), fs.readdirSync(path.join(ROOT, 'public', 'js')).sort(),
      'the same files at the same paths: script tags and the worker\'s asset list are untouched');
    for (const r of results) {
      assert.ok(r.after < r.before, `${r.file} is smaller`);
      if (r.file.endsWith('.js')) new vm.Script(fs.readFileSync(path.join(tmp, r.file), 'utf8'), { filename: r.file });
    }
    const total = (key) => results.reduce((n, r) => n + r[key], 0);
    assert.ok(total('after') < total('before') * 0.7, 'at least 30% off the whole');
    const app = fs.readFileSync(path.join(tmp, 'js', 'app.js'), 'utf8');
    assert.match(app, /\bconst App\s*=/, 'the top-level name other scripts use is still declared');
    assert.equal(fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8'), before, 'the checkout\'s own file is not written');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a file that cannot be minified fails the build rather than shipping half a shell', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minify-legacy-bad-'));
  try {
    fs.mkdirSync(path.join(tmp, 'js'));
    fs.writeFileSync(path.join(tmp, 'js', 'broken.js'), 'const = ;');
    assert.throws(() => minifyLegacyAssets({ publicDir: tmp, esbuild }));
    assert.equal(fs.readFileSync(path.join(tmp, 'js', 'broken.js'), 'utf8'), 'const = ;', 'and it is left as it was');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// #7165, point 3: the kit the shell loads on every first visit, and every app
// with it, was still served as written (687 KB, 152 KB compressed).
test('the kit comes out smaller, at the same addresses, and still does what it did', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'minify-kit-'));
  const kit = [...KIT_SCRIPTS, 'usernode-native/v1/native.css'];
  const left = ['usernode-bridge/v1/snapdom.js', 'usernode-tailwind/v1/tailwind.js'];
  try {
    for (const rel of [...kit, ...left]) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'public', rel), path.join(tmp, rel));
    }
    const source = (rel) => fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8');
    const served = (rel) => fs.readFileSync(path.join(tmp, rel), 'utf8');
    const results = minifyLegacyAssets({ publicDir: tmp, esbuild });
    assert.deepEqual(results.map((r) => r.file.split(path.sep).join('/')).sort(), [...kit].sort(),
      'the three kit scripts and the kit sheet, and nothing beside them');
    for (const r of results) assert.ok(r.after < r.before * 0.7, `${r.file} loses at least 30%`);
    for (const rel of KIT_SCRIPTS) new vm.Script(served(rel), { filename: rel });
    for (const rel of left) assert.equal(served(rel), source(rel), `${rel} is a vendored build and is not rewritten`);
    assert.equal(served('usernode-bridge.js'), served('usernode-bridge/v1/bridge.js'),
      'the bridge is still one file at its two addresses');
    // The bridge asks which of its addresses loaded it, and the kit publishes
    // one global: both are still there by name.
    assert.match(served('usernode-bridge.js'), /document\.currentScript/);
    assert.match(served('usernode-native/v1/native.js'), /\.unNative=\{/);
    // The sheet loses comments and whitespace only: every selector and every
    // custom property the source declares is still declared, in order.
    const names = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '').match(/--[a-z0-9-]+(?=\s*:)/gi) || [];
    assert.deepEqual(names(served('usernode-native/v1/native.css')), names(source('usernode-native/v1/native.css')));
    assert.doesNotMatch(served('usernode-native/v1/native.css'), /\/\*/, 'no comment is served');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('only the image build runs it, on the hand-written sheets and scripts alone', () => {
  assert.deepEqual(STYLESHEETS, ['css/app.css', 'usernode-native/v1/native.css'], 'not the compiled Tailwind');
  assert.deepEqual(KIT_SCRIPTS, ['usernode-bridge.js', 'usernode-bridge/v1/bridge.js', 'usernode-native/v1/native.js'],
    'not snapdom or the Tailwind runtime, which arrive minified');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const [name, script] of Object.entries(pkg.scripts)) {
    assert.ok(!String(script).includes('minify-legacy-assets'), `npm run ${name} leaves the checkout readable`);
  }
  assert.ok(!fs.readFileSync(path.join(ROOT, 'scripts', 'ensure-shell-artifacts.js'), 'utf8').includes('minify-legacy-assets'));
  assert.match(fs.readFileSync(path.join(ROOT, 'Dockerfile.kubernetes'), 'utf8'), /node scripts\/minify-legacy-assets\.js/);
});
