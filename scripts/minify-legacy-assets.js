'use strict';

// The legacy scripts under public/js and the shell's own stylesheet are
// served as they are written: app-view.js is 1.7 MB, about half of it
// comments and indentation, and app.css 1.9 MB. This drops what a browser
// does not need to run them (#6798). An image build runs it once, on the
// copy the image serves; a checkout keeps its readable files, and so do the
// tests, which read these sources by path.
//
// The kit goes through it too (#7165, point 3): the bridge, native.js and
// native.css are loaded by the shell on every first visit and by every app,
// and were still 687 KB as written, about half of it comments.
//
// What it will not change:
//   - names. No identifier is renamed: these are classic scripts that reach
//     each other through top-level bindings (`App`, `AppView`, ...).
//   - files and paths. Each file is rewritten in place, so the script tags,
//     their order and the service worker's asset list are untouched.
//   - the order of CSS rules. app.css loses whitespace and comments only: it
//     was written against a cascade (native.css, app.css, tailwind.css), and
//     merging or reordering rules is not this step's.
//
// A file that does not come out smaller, or does not parse, is left as it
// was and named, and the build fails: a half-minified shell is not served.

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const ROOT = path.join(__dirname, '..');

// esbuild is the frontend's (its lockfile pins it); the root package has none.
function loadEsbuild(root = ROOT) {
  return createRequire(path.join(root, 'frontend', 'package.json'))('esbuild');
}

function scripts(publicDir) {
  const dir = path.join(publicDir, 'js');
  const out = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.min.js')) out.push(file);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

// The kit's hand-written scripts, by path: the bridge at both of its
// addresses (the shell's and the one apps load, which a test holds to be one
// file) and the native kit. Its address and its name stay as they are, so an
// app's script tag and the worker's asset list still find it. snapdom.js and
// the Tailwind runtime beside them are other people's builds, already
// minified, and are left alone.
const KIT_SCRIPTS = [
  'usernode-bridge.js',
  'usernode-bridge/v1/bridge.js',
  'usernode-native/v1/native.js',
];

// The hand-written sheets: the shell's own and the kit's. tailwind.css is
// compiled, and minified, by its own build.
const STYLESHEETS = ['css/app.css', 'usernode-native/v1/native.css'];

function minifyScript(esbuild, source) {
  return esbuild.transformSync(source, {
    loader: 'js',
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    legalComments: 'none',
    charset: 'ascii',
  }).code;
}

function minifyStylesheet(esbuild, source) {
  return esbuild.transformSync(source, {
    loader: 'css',
    minifyWhitespace: true,
    minifySyntax: false,
    legalComments: 'none',
    charset: 'ascii',
  }).code;
}

function minifyLegacyAssets({ publicDir = path.join(ROOT, 'public'), esbuild = loadEsbuild(), write = true } = {}) {
  const results = [];
  const one = (file, minify) => {
    const source = fs.readFileSync(file, 'utf8');
    const code = minify(esbuild, source);
    const before = Buffer.byteLength(source);
    const after = Buffer.byteLength(code);
    if (!(after > 0) || after > before) {
      throw new Error(`minify-legacy-assets: ${path.relative(publicDir, file)} did not come out smaller (${before} -> ${after})`);
    }
    if (write) fs.writeFileSync(file, code);
    results.push({ file: path.relative(publicDir, file), before, after });
  };
  for (const file of scripts(publicDir)) one(file, minifyScript);
  for (const rel of KIT_SCRIPTS) {
    const file = path.join(publicDir, rel);
    if (fs.existsSync(file)) one(file, minifyScript);
  }
  for (const rel of STYLESHEETS) {
    const file = path.join(publicDir, rel);
    if (fs.existsSync(file)) one(file, minifyStylesheet);
  }
  return results;
}

if (require.main === module) {
  const results = minifyLegacyAssets();
  const sum = (key) => results.reduce((n, r) => n + r[key], 0);
  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`[minify-legacy-assets] ${results.length} files, ${kb(sum('before'))} -> ${kb(sum('after'))}`);
}

module.exports = { minifyLegacyAssets, minifyScript, minifyStylesheet, loadEsbuild, STYLESHEETS, KIT_SCRIPTS };
