// The scaffolded app template must not 401 the browser's automatic
// /favicon.ico probe. Freshly created apps used to fail immediately in
// the dev console: the template ships no favicon file, so the request
// fell through the static middleware into the auth-gated catch-all,
// which answered 401 ("Open in Homeroom") — an error on every first
// load of every new app, before the user wrote a single line.
//
// Two-layer fix, both asserted here:
//   1. index.html carries an inline data-URI SVG icon, so modern
//      browsers never request /favicon.ico at all.
//   2. server.js answers /favicon.ico with 204 before the catch-all,
//      so anything that still probes it (older browsers, direct
//      visits) gets a silent no-content instead of a 401.
//
// Run with: node --test tests/template-favicon.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { getTemplateFiles } = require('../src/services/template');

function file(files, p) {
  const f = files.find((x) => x.path === p);
  assert.ok(f, `template contains ${p}`);
  return f.content;
}

test('template index.html declares an inline data-URI favicon', () => {
  const files = getTemplateFiles('My App', 'my-app-123', 'pg://x', 'secret');
  const html = file(files, 'public/index.html');
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/,
    'inline SVG favicon link present so browsers skip the /favicon.ico probe');
});

test('template server.js answers /favicon.ico with 204 before the auth-gated catch-all', () => {
  const files = getTemplateFiles('My App', 'my-app-123', 'pg://x', 'secret');
  const server = file(files, 'server.js');
  assert.match(server, /app\.get\('\/favicon\.ico', \(_req, res\) => res\.status\(204\)\.end\(\)\)/,
    'explicit favicon route present');
  assert.ok(
    server.indexOf("app.get('/favicon.ico'") < server.indexOf("app.get('*'"),
    'favicon route registered before the catch-all'
  );
});
