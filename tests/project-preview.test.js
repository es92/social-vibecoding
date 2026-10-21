'use strict';
// A shared public project's link preview (src/services/project-preview.js,
// src/routes/project-preview.js): Share copies `/app/<slug>` for a public
// project, and that page carries its name, what it is and a cover in its
// head, so a pasted link no longer previews as the bare word "Homeroom".
//
// Run with: node --test tests/project-preview.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { PNG } = require('pngjs');

const preview = require('../src/services/project-preview');
const { loadTsx } = require('./lib/render-tsx');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const ORIGIN = 'https://app.example';
const APP = {
  id: 7, slug: 'game-corner', name: 'Game Corner', description: 'Classic games, fresh every day.',
  member_count: 87, icon_emoji: '📊', icon_url: null, icon_color: '#2e6660',
};

const pixel = (png, x, y) => {
  const o = (y * png.width + x) * 4;
  return [png.data[o], png.data[o + 1], png.data[o + 2]];
};

test('the tags name the project, say what it is, and point at its page and its cover', () => {
  const tags = preview.previewTags(APP, ORIGIN);
  assert.match(tags, /<meta property="og:title" content="Game Corner">/);
  assert.match(tags, /<meta property="og:description" content="Classic games, fresh every day\. 87 members are making it together on Homeroom\.">/);
  assert.match(tags, /<meta property="og:url" content="https:\/\/app\.example\/app\/game-corner">/);
  assert.match(tags, /<meta property="og:image" content="https:\/\/app\.example\/api\/public\/apps\/game-corner\/cover\.png">/);
  assert.match(tags, /<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">/);
  assert.match(tags, /<meta name="twitter:card" content="summary_large_image">/);
  // A small count says nothing (the cards' minimum, guest-data MIN_MEMBERS).
  assert.equal(preview.descriptionOf({ ...APP, member_count: 3 }), 'Classic games, fresh every day. Made together on Homeroom.');
  assert.equal(preview.descriptionOf({ ...APP, description: null, member_count: 30 }), '30 members are making it together on Homeroom.');
  // Words a project chose are attribute text, never markup.
  assert.match(preview.previewTags({ ...APP, name: 'A "quoted" <b>' }, ORIGIN), /content="A &quot;quoted&quot; &lt;b&gt;"/);
  // An icon the server cannot draw: the icon itself, as a small card.
  const small = preview.previewTags({ ...APP, icon_url: '/app-icons/abc' }, ORIGIN, { cover: false });
  assert.match(small, /<meta name="twitter:card" content="summary">/);
  assert.match(small, /<meta property="og:image" content="https:\/\/app\.example\/app-icons\/abc">/);
  assert.doesNotMatch(small, /og:image:width/);
});

test('the shell keeps everything and gains the tags before </head>, named for the project', () => {
  const html = '<html><head><title>Homeroom</title></head><body></body></html>';
  const out = preview.withPreview(html, '<meta property="og:title" content="X">', 'Game Corner');
  assert.equal(out, '<html><head><title>Game Corner · Homeroom</title><meta property="og:title" content="X">\n</head><body></body></html>');
});

test('the cover: the project\'s colour, its icon on a rounded tile in the middle, 1200 by 630', () => {
  const png = PNG.sync.read(preview.coverPng(APP, null));
  assert.deepEqual([png.width, png.height], [1200, 630]);
  assert.deepEqual(pixel(png, 5, 5), [0x2e, 0x66, 0x60], 'the set colour');
  // The tile is white where the emoji is not, and rounded at its corners.
  assert.deepEqual(pixel(png, 600 - 140, 315 - 100), [255, 255, 255]);
  assert.deepEqual(pixel(png, 450 + 1, 165 + 1), [0x2e, 0x66, 0x60], 'outside the rounded corner');
  // A PNG icon with no colour set lends its own.
  const icon = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < icon.data.length; i += 4) { icon.data[i] = 200; icon.data[i + 1] = 40; icon.data[i + 2] = 40; icon.data[i + 3] = 255; }
  const red = PNG.sync.read(preview.coverPng({ ...APP, icon_emoji: null, icon_color: null, icon_url: '/app-icons/x' },
    { contentType: 'image/png', data: PNG.sync.write(icon) }));
  assert.deepEqual(pixel(red, 5, 5), [200, 40, 40]);
  assert.deepEqual(pixel(red, 600, 315), [200, 40, 40]);
  // A JPEG cannot be drawn here: no cover, and the link shows the icon.
  const jpeg = { contentType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]) };
  const noEmoji = { ...APP, icon_emoji: null, icon_url: '/app-icons/x' };
  assert.equal(preview.coverPng(noEmoji, jpeg), null);
  assert.equal(preview.canDrawCover(noEmoji, jpeg), false);
  // No icon at all: the name's swatch, as the client picks it.
  const { swatchFor } = loadTsx('frontend/src/lib/community-color.ts');
  assert.equal(preview.swatchFor('game-corner'), swatchFor('game-corner'));
});

// The routes, against a database that knows one public project.
function fakePool() {
  return {
    async query(sql, params = []) {
      const s = String(sql);
      if (/SELECT 1 FROM apps WHERE slug = \$1/.test(s)) return { rows: params[0] === 'game-corner' ? [{}] : [] };
      if (/FROM apps a/.test(s) && /last_deploy_at DESC NULLS LAST/.test(s)) {
        return params[1] === 'game-corner' ? { rows: [{
          id: 7, name: 'Game Corner', slug: 'game-corner', status: 'running', view_visibility: 'public', collab_visibility: 'public',
          icon_emoji: '📊', icon_image_id: null, icon_color: '#2e6660', anon_shell: 'gated', guest_shell: null,
          description: 'Classic games, fresh every day.', member_count: 87, active_users: 42,
        }] } : { rows: [] };
      }
      return { rows: [] };
    },
  };
}

async function startServer({ user = null } = {}) {
  const poolPath = require.resolve('../src/db/pool');
  const routePath = require.resolve('../src/routes/project-preview');
  const original = require.cache[poolPath];
  require.cache[poolPath] = { exports: { getPool: () => fakePool() }, loaded: true, id: poolPath, filename: poolPath, paths: [] };
  delete require.cache[routePath];
  try {
    const routes = require('../src/routes/project-preview');
    const app = express();
    app.use((req, res, next) => { req.user = user; next(); });
    app.use(routes({}));
    app.use((req, res) => res.status(404).send('catch-all'));
    return await new Promise((resolve) => {
      const server = app.listen(0, () => resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      }));
    });
  } finally {
    if (original) require.cache[poolPath] = original; else delete require.cache[poolPath];
    delete require.cache[routePath];
  }
}

test('GET /app/<slug>: a public project\'s page carries its preview; anything else, and a signed-in load, is the catch-all\'s', async (t) => {
  if (!fs.existsSync(path.join(__dirname, '..', 'public', 'index.html'))) { t.skip('no built shell'); return; }
  const srv = await startServer();
  try {
    const page = await fetch(`${srv.base}/app/game-corner`, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>Game Corner · Homeroom<\/title>/);
    assert.match(html, /<meta property="og:image" content="http:\/\/127\.0\.0\.1:\d+\/api\/public\/apps\/game-corner\/cover\.png">/);
    assert.ok(html.indexOf('og:title') < html.indexOf('</head>'));
    const secret = await fetch(`${srv.base}/app/secret-thing`, { headers: { accept: 'text/html' } });
    assert.equal(await secret.text(), 'catch-all', 'nothing said about a project that is not public');
    const cover = await fetch(`${srv.base}/api/public/apps/game-corner/cover.png`);
    assert.equal(cover.headers.get('content-type'), 'image/png');
    const png = PNG.sync.read(Buffer.from(await cover.arrayBuffer()));
    assert.deepEqual([png.width, png.height], [1200, 630]);
    assert.equal((await fetch(`${srv.base}/api/public/apps/secret-thing/cover.png`)).status, 404);
  } finally { await srv.close(); }
  const member = await startServer({ user: { id: 1 } });
  try {
    const own = await fetch(`${member.base}/app/game-corner`, { headers: { accept: 'text/html' } });
    assert.equal(await own.text(), 'catch-all', 'a member\'s own load is the plain shell');
  } finally { await member.close(); }
});

test('mounted after sign-in is read and before the catch-all; Share copies the page for a public project', () => {
  const server = read('server.js');
  const at = server.indexOf('app.use(projectPreviewRoutes(config));');
  assert.ok(at > server.indexOf('app.use(authMiddleware(config));'));
  assert.ok(at < server.indexOf("app.get('*', (req, res)"));
  const { publicPageUrl } = loadTsx('frontend/src/features/dialogs/share.tsx');
  globalThis.location = { origin: 'https://app.example' };
  try {
    assert.equal(publicPageUrl({ slug: 'game-corner', view_visibility: 'public' }), 'https://app.example/app/game-corner');
    assert.equal(publicPageUrl({ slug: 'secret', view_visibility: 'private' }), null);
    assert.equal(publicPageUrl({ slug: 'usernode-2d5619', view_visibility: 'public', self_hosted: true }), null);
  } finally { delete globalThis.location; }
  assert.match(read('frontend/src/features/dialogs/share.tsx'), /const share = page \|\| \(window\.AppView\?\.appData\?\.share_url as string\) \|\| raw;/);
  assert.match(read('frontend/src/features/apps/browse.js'), /if \(app\.view_visibility === 'public' && app\.slug && typeof location !== 'undefined'\) \{\s+return `\$\{location\.origin\}\/app\/\$\{encodeURIComponent\(app\.slug\)\}`;/);
});
