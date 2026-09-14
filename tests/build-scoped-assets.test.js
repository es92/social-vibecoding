// Build-scoped asset URLs (/b/<build sha>/…): the one lane where the shell's
// scripts and stylesheets may be cached immutable.
//
// The scheme has four halves that must agree with each other — the URL the
// document is generated with (scripts/shell-stamp.js), the URL the shell tree
// hydrates with (frontend/src/lib/asset-url.ts), the URL the worker precaches
// and answers cache-first (public/sw.js), and the route the server serves it
// from (src/services/static-cache.js). Two of them run on the far side of a
// build boundary the checkout never crosses — a staging preview is built
// without a GIT_SHA, so its document keeps the plain paths and the platform's
// own checks never see a scoped URL. So every pair is pinned here instead.
//
// Run with: node --test tests/build-scoped-assets.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const stamp = require('../scripts/shell-stamp');
const {
  buildScopedAssetHandler, shellBuildId, IMMUTABLE, REVALIDATE, SHELL_BUILD_HEADER,
} = require('../src/services/static-cache');
const sw = require('../public/sw.js');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const SHA = 'abc1234def5678';

// ── scripts/shell-stamp.js: the URL the document is generated with ─────

test('buildScopedAssetUrl scopes scripts and stylesheets under /b/<sha>/ and nothing else', () => {
  assert.equal(stamp.buildScopedAssetUrl('/js/app.js', SHA), `/b/${SHA}/js/app.js`);
  assert.equal(stamp.buildScopedAssetUrl('/css/app.css', SHA), `/b/${SHA}/css/app.css`);
  assert.equal(stamp.buildScopedAssetUrl('/shell/assets/shell.js', SHA), `/b/${SHA}/shell/assets/shell.js`);
  assert.equal(stamp.buildScopedAssetUrl('/usernode-native/v1/native.css', SHA), `/b/${SHA}/usernode-native/v1/native.css`);
  assert.equal(stamp.buildScopedAssetUrl('/usernode-bridge.js', SHA), `/b/${SHA}/usernode-bridge.js`);
  // Normalized like the document's <meta>: trimmed and case-folded.
  assert.equal(stamp.buildScopedAssetUrl('/js/app.js', ' ABC1234DEF5678 '), `/b/${SHA}/js/app.js`);
  // What a build does not own keeps its URL: the document, the manifest, the
  // icons — and the worker, whose URL is the registration.
  for (const plain of ['/manifest.webmanifest', '/icons/icon-192.png', '/index.html', '/sw.js', '/', '/app-icons/x.png']) {
    assert.equal(stamp.buildScopedAssetUrl(plain, SHA), plain, `${plain} must not be scoped`);
  }
  // No build id, no prefix.
  assert.equal(stamp.buildScopedAssetUrl('/js/app.js', 'dev'), '/js/app.js');
  assert.equal(stamp.buildScopedAssetUrl('/js/app.js', undefined), '/js/app.js');
  assert.equal(stamp.buildScopedAssetUrl('/js/app.js', 'not-a-sha'), '/js/app.js');
  // Already scoped stays scoped: never /b/x/b/x/.
  assert.equal(stamp.buildScopedAssetUrl(`/b/${SHA}/js/app.js`, SHA), `/b/${SHA}/js/app.js`);
});

test('parseBuildScopedPath recognizes exactly the scheme buildScopedAssetUrl emits', () => {
  assert.deepEqual(stamp.parseBuildScopedPath(`/b/${SHA}/js/app.js`), { build: SHA, path: '/js/app.js' });
  assert.deepEqual(
    stamp.parseBuildScopedPath('/b/abcdef0/shell/assets/shell-sections.js'),
    { build: 'abcdef0', path: '/shell/assets/shell-sections.js' },
  );
  for (const other of [
    '/js/app.js', '/b/', '/b/abc', `/b/${SHA}`, '/b/ABC1234/js/app.js', '/b/xyz1234/js/app.js',
    '/b/abc123/js/app.js', '/bb/abc1234/js/app.js', `/x/b/${SHA}/js/app.js`, '',
  ]) {
    assert.equal(stamp.parseBuildScopedPath(other), null, `${other} is not build-scoped`);
  }
});

test('prefixShellAssetUrls rewrites only local script srcs and stylesheet hrefs, in place', () => {
  const html = [
    '<meta name="platform-build" content="dev">',
    '<script src="/usernode-bridge.js"></script>',
    '<link rel="stylesheet" href="/css/app.css">',
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">',
    '<script type="module" src="/shell/assets/shell.js"></script>',
    '<script src="https://cdn.example/x.js"></script>',
    '<script src="/js/app.js"></script>',
  ].join('\n');
  const out = stamp.prefixShellAssetUrls(html, SHA);
  assert.ok(out.includes(`<script src="/b/${SHA}/usernode-bridge.js"></script>`));
  assert.ok(out.includes(`<link rel="stylesheet" href="/b/${SHA}/css/app.css">`));
  assert.ok(out.includes(`<script type="module" src="/b/${SHA}/shell/assets/shell.js"></script>`));
  assert.ok(out.includes(`<script src="/b/${SHA}/js/app.js"></script>`));
  assert.ok(out.includes('<link rel="manifest" href="/manifest.webmanifest">'), 'the manifest keeps its URL');
  assert.ok(out.includes('href="/icons/icon-192.png"'), 'icons keep theirs');
  assert.ok(out.includes('<script src="https://cdn.example/x.js"></script>'), 'cross-origin is untouched');
  assert.ok(out.includes('<meta name="platform-build" content="dev">'), 'nothing but the two attributes moves');
  assert.equal(stamp.prefixShellAssetUrls(html, 'dev'), html, 'a dev build is untouched');
  assert.equal(stamp.prefixShellAssetUrls(out, SHA), out, 'idempotent on an already-scoped document');
});

// Strip whatever build the checkout's document happens to carry, so this
// test reads the same whether pretest generated it as `dev` or a developer
// built it under a GIT_SHA.
function plainDocument() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  return html.replace(/\/b\/[0-9a-f]{7,40}\//g, '/');
}

const TAG_SRC_RE = /<(?:script|link)\b[^>]*?\s(?:src|href)="(\/[^"]*)"/g;

test('on the generated document, prefixShellAssetUrls scopes exactly its scripts and stylesheets', () => {
  const plain = plainDocument();
  const out = stamp.prefixShellAssetUrls(plain, SHA);
  const srcs = (h) => [...h.matchAll(TAG_SRC_RE)].map((m) => m[1]);
  const before = srcs(plain);
  const after = srcs(out);
  assert.equal(before.length, after.length, 'no tag gained or lost');
  before.forEach((p, i) => {
    assert.equal(after[i], stamp.buildScopedAssetUrl(p, SHA), `${p} → ${after[i]}`);
  });
  // Everything else is byte-identical: strip the prefix back out and compare.
  assert.equal(out.split(`/b/${SHA}/`).join('/'), plain);
  const scoped = after.filter((p) => p.startsWith(`/b/${SHA}/`));
  assert.ok(scoped.length >= 30, `expected the shell's ~34 scripts and stylesheets scoped, got ${scoped.length}`);
  assert.ok(scoped.includes(`/b/${SHA}/shell/assets/shell.js`), 'the React entry');
  assert.ok(scoped.includes(`/b/${SHA}/js/app.js`), 'the last body script');
  assert.ok(scoped.includes(`/b/${SHA}/css/tailwind.css`), 'the compiled stylesheet');
  assert.ok(after.includes('/manifest.webmanifest'), 'the manifest stays plain');
});

// ── frontend/src/lib/asset-url.ts: the URL the shell tree hydrates with ──

function withGitSha(value, fn) {
  const prev = process.env.GIT_SHA;
  if (value === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.GIT_SHA; else process.env.GIT_SHA = prev;
  }
}

test('the shell tree renders the same URL the document is generated with, for the same GIT_SHA', () => {
  withGitSha(SHA.toUpperCase(), () => {
    // loadTsx evaluates a fresh module, so the id is read from THIS env.
    const { assetUrl, documentBuildId } = loadTsx('frontend/src/lib/asset-url.ts');
    assert.equal(documentBuildId(), SHA);
    for (const p of ['/js/app.js', '/js/nav-link.js', '/css/app.css', '/shell/assets/shell.js', '/usernode-bridge.js', '/manifest.webmanifest', '/sw.js']) {
      assert.equal(assetUrl(p), stamp.buildScopedAssetUrl(p, SHA), `${p} (document)`);
      assert.equal(assetUrl(p), sw.shellAssetUrl(p, SHA), `${p} (worker)`);
    }
  });
  withGitSha('dev', () => {
    const dev = loadTsx('frontend/src/lib/asset-url.ts');
    assert.equal(dev.documentBuildId(), null);
    assert.equal(dev.assetUrl('/js/app.js'), '/js/app.js');
  });
  withGitSha(undefined, () => {
    const unset = loadTsx('frontend/src/lib/asset-url.ts');
    assert.equal(unset.documentBuildId(), null);
    assert.equal(unset.assetUrl('/js/app.js'), '/js/app.js');
  });
});

test('every legacy <script> in Shell.tsx goes through assetUrl, and the head through prefixShellAssetUrls', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'frontend/src/Shell.tsx'), 'utf8');
  const scoped = shell.match(/<script src=\{assetUrl\('\/js\/[a-z-]+\.js'\)\} \/>/g) || [];
  const plain = shell.match(/<script src="\/js\/[a-z-]+\.js" \/>/g) || [];
  assert.equal(plain.length, 0, `a plain src would revalidate on every load in a deploy: ${plain.join(' ')}`);
  // #1891 moved launchpad.js into the React bundle; shell-script-order.test.js
  // pins the same 24 remaining legacy scripts at the end of <body>.
  assert.equal(scoped.length, 24, 'the 24 legacy scripts');
  assert.match(shell, /import \{ assetUrl \} from '\.\/lib\/asset-url';/);

  const build = fs.readFileSync(path.join(ROOT, 'frontend/scripts/build-shell.mjs'), 'utf8');
  assert.match(build, /prefixShellAssetUrls\(head, buildSha\)/, 'the head is rewritten for the build');
  assert.match(build, /buildScopedAssetUrl\('\/shell\/assets\/shell\.js', buildSha\)/, 'so is the React entry tag');
  assert.ok(build.indexOf('const buildSha = normalizeBuildSha(process.env.GIT_SHA);') < build.indexOf('const entryTag ='),
    'the build id is known before the entry tag is composed');
});

// ── public/sw.js: the URL the worker precaches and answers cache-first ──

test('the worker classifies a build-scoped script as a shell asset and scopes SHELL_ASSETS the same way', () => {
  const origin = 'https://social.example';
  assert.equal(sw.classifyRequest('GET', `${origin}/b/${SHA}/js/app.js`, '*/*', 'no-cors', origin), 'shell');
  assert.equal(sw.classifyRequest('GET', `${origin}/b/${SHA}/css/app.css`, 'text/css,*/*', 'no-cors', origin), 'shell');
  assert.equal(sw.classifyRequest('GET', `${origin}/b/${SHA}/shell/assets/shell-sections.js`, '*/*', 'cors', origin), 'shell');
  for (const p of sw.SHELL_ASSETS) {
    assert.equal(sw.shellAssetUrl(p, SHA), stamp.buildScopedAssetUrl(p, SHA), p);
    assert.equal(sw.shellAssetUrl(p, null), p, `${p} without a build id`);
  }
  assert.equal(sw.shellAssetUrl(`/b/${SHA}/js/app.js`, SHA), `/b/${SHA}/js/app.js`, 'never double-scoped');
  assert.deepEqual(sw.parseBuildScopedPath(`/b/${SHA}/js/app.js`), stamp.parseBuildScopedPath(`/b/${SHA}/js/app.js`));
  assert.equal(sw.parseBuildScopedPath('/js/app.js'), null);
  assert.equal(sw.isBuildScopedAssetPath('/sw.js'), false);
});

test("the worker answers build-scoped URLs cache-first and precaches the document's own build", () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
  const shellFn = src.slice(src.indexOf('async function networkFirstShell'), src.indexOf('async function networkFirstNavigate'));
  // Cache-first: the scoped branch returns a hit before any race or deadline,
  // and stores a network answer only when the server confirms the build.
  const branch = shellFn.indexOf('const scoped = parseBuildScopedPath(');
  assert.ok(branch > -1, 'networkFirstShell recognizes a build-scoped URL');
  assert.ok(branch < shellFn.indexOf('if (shellFromCacheThisLoad)'), 'ahead of the slow-connection shortcut');
  assert.ok(branch < shellFn.indexOf('if (documentBuildThisLoad)'), 'ahead of the plain-path build check');
  assert.match(shellFn, /if \(scoped\) \{\s*const hit = await cache\.match\(event\.request\);\s*if \(hit\) return hit;/);
  assert.match(shellFn, /buildIdOf\(res\) === scoped\.build/, 'a rollout answer from another build is served but never stored');

  // Precache: fetch the document first, cache its assets at the URLs it loads,
  // and only then promote the targeted document and prune the prior build.
  const pre = src.slice(src.indexOf('async function precacheShell'), src.indexOf("self.addEventListener('install'"));
  assert.match(pre, /const \[documentPath, \.\.\.assets\] = SHELL_ASSETS;/);
  assert.match(pre, /build = buildIdOf\(doc\);/);
  assert.match(pre, /shellAssetUrl\(path, build\)/);
  assert.match(pre, /buildIdOf\(res\) !== build\) throw/);
  assert.match(pre, /expectedBuild && build !== expectedBuild/);
  assert.match(pre, /pruneOtherBuilds\(cache, build\)/);
  assert.match(src, /await precacheShell\(shell\);/, 'install() precaches through it');
  assert.match(src, /await precacheShell\(cache, \{[\s\S]*?reload: true,[\s\S]*?expectedBuild,[\s\S]*?documentLast: true/,
    'the deploy prefetch bypasses HTTP cache and names the exact build it will promote');
  assert.equal(sw.SHELL_ASSETS[0], '/index.html', 'the document is the first entry: precacheShell reads the build id off it');
  // A FLOOR, not an exact match. What this line is about is that the shell
  // cache is versioned past the plain-path precache a v7 worker filled — any
  // later version satisfies that equally. Pinning the exact string instead
  // made every future bump break this test, which is a tax on the one lever
  // that retires a stale cache fleet-wide (see the note above SW_VERSION).
  const swVersion = Number(String(sw.SW_VERSION).replace(/^v/, ''));
  assert.ok(Number.isInteger(swVersion) && swVersion >= 8,
    `the shell cache is versioned past the plain-path precache (got ${sw.SW_VERSION})`);
});

// ── src/services/static-cache.js + server.js: the route that serves it ──

function withServer(env, fn) {
  const express = require('express');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-scoped-'));
  fs.mkdirSync(path.join(dir, 'js'));
  fs.mkdirSync(path.join(dir, 'css'));
  fs.writeFileSync(path.join(dir, 'js', 'app.js'), 'window.APP = 1;');
  fs.writeFileSync(path.join(dir, 'css', 'app.css'), 'body {}');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(dir, 'sw.js'), '// worker');
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
  const app = express();
  app.use(buildScopedAssetHandler(dir, env));
  app.use((req, res) => res.status(418).type('text').send('fell through'));
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const { port } = server.address();
      const get = (p, method = 'GET') => new Promise((res, rej) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method }, (r) => {
          let body = '';
          r.setEncoding('utf8');
          r.on('data', (c) => { body += c; });
          r.on('end', () => res({
            status: r.statusCode,
            cc: r.headers['cache-control'] || null,
            build: r.headers[SHELL_BUILD_HEADER.toLowerCase()] || null,
            body,
          }));
        });
        req.on('error', rej);
        req.end();
      });
      try {
        await fn(get);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
}

test('a matching build is served immutable with its build id; any other sha revalidates', async () => {
  await withServer({ GIT_SHA: SHA }, async (get) => {
    const fresh = await get(`/b/${SHA}/js/app.js`);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.cc, IMMUTABLE);
    assert.equal(fresh.build, SHA);
    assert.equal(fresh.body, 'window.APP = 1;');
    assert.equal(IMMUTABLE, 'public, max-age=31536000, immutable');
    assert.equal((await get(`/b/${SHA}/css/app.css`)).cc, IMMUTABLE);
    // A query string does not change the file and rides along.
    assert.equal((await get(`/b/${SHA}/js/app.js?v=1`)).status, 200);
    // HEAD answers like GET.
    const head = await get(`/b/${SHA}/js/app.js`, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.cc, IMMUTABLE);
    // Another build's sha: this server is not that build. It serves the file
    // it has, under the revalidate policy, with ITS build id so the worker
    // can see the disagreement and decline to cache the answer.
    const stale = await get('/b/0123456789abcdef/js/app.js');
    assert.equal(stale.status, 200);
    assert.equal(stale.cc, REVALIDATE);
    assert.equal(stale.build, SHA);
    assert.equal(stale.body, 'window.APP = 1;');
    // Not a build's to own: the document, the worker, the manifest.
    for (const p of [`/b/${SHA}/index.html`, `/b/${SHA}/sw.js`, `/b/${SHA}/manifest.webmanifest`, `/b/${SHA}/`]) {
      assert.equal((await get(p)).status, 404, `${p} must 404`);
    }
    // A missing file is a 404 — never the SPA fallback, which would feed a
    // <script> tag an HTML body.
    assert.equal((await get(`/b/${SHA}/js/missing.js`)).status, 404);
    // Writes are refused.
    assert.equal((await get(`/b/${SHA}/js/app.js`, 'POST')).status, 404);
    // Not build-scoped at all: falls through to whatever comes next.
    assert.equal((await get('/js/app.js')).status, 418);
    assert.equal((await get('/b/not-a-sha/js/app.js')).status, 418);
  });
});

test('a process with no build id never serves a scoped URL immutable', async () => {
  await withServer({ GIT_SHA: 'dev' }, async (get) => {
    const res = await get(`/b/${SHA}/js/app.js`);
    assert.equal(res.status, 200);
    assert.equal(res.cc, REVALIDATE);
    assert.equal(res.build, null);
  });
});

test('server.js mounts the handler ahead of the plain static handler, and auth lets /b/ through', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const mount = server.indexOf("app.use(buildScopedAssetHandler(path.join(__dirname, 'public')));");
  const plain = server.indexOf("app.use(express.static(path.join(__dirname, 'public'), {");
  assert.ok(mount > -1, 'buildScopedAssetHandler is mounted');
  assert.ok(plain > mount, 'ahead of the plain static handler');
  assert.match(server,
    /buildScopedAssetHandler,[\s\S]{0,80}?\} = require\('\.\/src\/services\/static-cache'\)/);

  const auth = fs.readFileSync(path.join(ROOT, 'src/middleware/auth.js'), 'utf8');
  const m = auth.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m && /'\/b\/'/.test(m[1]),
    "'/b/' is a public prefix — a deployed document loads every script from it, signed in or not");
});

test('shellBuildId and the document meta normalize a GIT_SHA the same way', () => {
  for (const [raw, want] of [[SHA, SHA], [' ABC1234DEF5678 ', SHA], ['dev', null], ['', null], ['abc123', null], [undefined, null]]) {
    assert.equal(shellBuildId({ GIT_SHA: raw }), want, `shellBuildId(${JSON.stringify(raw)})`);
    assert.equal(stamp.normalizeBuildSha(raw), want === null ? 'dev' : want, `normalizeBuildSha(${JSON.stringify(raw)})`);
  }
});

test('the ensure step treats a document built for another build id as stale', () => {
  const ensure = fs.readFileSync(path.join(ROOT, 'scripts/ensure-shell-artifacts.js'), 'utf8');
  assert.match(ensure, /readBuildMeta\(html\) === normalizeBuildSha\(process\.env\.GIT_SHA\)/,
    'a `dev` document under a GIT_SHA (or the reverse) must be rebuilt, not served');
});
