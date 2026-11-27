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
  created_at: '2026-10-03T12:00:00.000Z',
};
const ldJson = (tags) => [...tags.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
const ldData = (tags) => JSON.parse(ldJson(tags)[0][1]);

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
  // Its size is said when the server could read it off the icon's bytes.
  const sized = preview.previewTags({ ...APP, icon_url: '/app-icons/abc' }, ORIGIN, { cover: false, imageSize: { width: 512, height: 512 } });
  assert.match(sized, /<meta property="og:image:width" content="512">\n<meta property="og:image:height" content="512">/);
  // In a post on X a playable project stays a player card (request 6274), whatever its picture.
  assert.match(preview.previewTags(APP, ORIGIN, { player: true }), /<meta name="twitter:card" content="player">/);
});

test('a picture\'s size is read from its first bytes: PNG, JPEG, GIF and WebP', () => {
  const png = new PNG({ width: 48, height: 32 });
  assert.deepEqual(preview.pictureSize(PNG.sync.write(png)), { width: 48, height: 32 });
  const gif = Buffer.alloc(32); gif.write('GIF89a', 'latin1'); gif.writeUInt16LE(300, 6); gif.writeUInt16LE(200, 8);
  assert.deepEqual(preview.pictureSize(gif), { width: 300, height: 200 });
  // A JPEG: start of image, one application segment to step over, then the frame header.
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14),
    Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, 0x02, 0x00, 0x01, 0x80]), Buffer.alloc(16),
  ]);
  assert.deepEqual(preview.pictureSize(jpeg), { width: 384, height: 512 });
  // The brand's own files: a lossy WebP and a WebP with alpha.
  const brand = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'brand', f));
  assert.deepEqual(preview.pictureSize(brand('sky.webp')), { width: 1920, height: 1080 });
  assert.deepEqual(preview.pictureSize(brand('landing-communities.webp')), { width: 1060, height: 656 });
  for (const bad of [null, 'text', Buffer.alloc(0), Buffer.alloc(64), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')]) {
    assert.equal(preview.pictureSize(bad), null);
  }
});

test('the front page, signed out: a title that says what Homeroom is, a picture, its one address, and who it is', () => {
  const tags = preview.landingTags({ origin: 'https://forged.example', canonical: ORIGIN });
  assert.equal(preview.LANDING_TITLE, 'Homeroom: make apps together, one vote at a time');
  // The description is the shell's own sentence, word for word.
  assert.ok(read('frontend/src/head.html').includes(`<meta name="description" content="${preview.LANDING_DESCRIPTION}">`));
  for (const tag of [
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Homeroom">',
    `<meta property="og:title" content="${preview.LANDING_TITLE}">`,
    `<meta property="og:description" content="${preview.LANDING_DESCRIPTION}">`,
    '<meta property="og:url" content="https://app.example/">',
    '<link rel="canonical" href="https://app.example/">',
    `<meta name="description" content="${preview.LANDING_DESCRIPTION}">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${preview.LANDING_TITLE}">`,
    '<meta name="twitter:image" content="https://app.example/brand/sky.webp">',
    '<meta property="og:image" content="https://app.example/brand/sky.webp">',
    '<meta property="og:image:type" content="image/webp">',
    '<meta property="og:image:width" content="1920">',
    '<meta property="og:image:height" content="1080">',
  ]) assert.ok(tags.includes(tag), tag);
  // The configured address names everything: the request's own host names nothing.
  assert.doesNotMatch(tags, /forged/);
  // The picture is a file the repository has, at the size the tags say, on a public path.
  const picture = fs.readFileSync(path.join(__dirname, '..', 'public', preview.LANDING_PICTURE.path));
  assert.deepEqual(preview.pictureSize(picture), { width: preview.LANDING_PICTURE.width, height: preview.LANDING_PICTURE.height });
  assert.match(read('src/middleware/auth.js').match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/)[1], /'\/brand\/',/);

  const blocks = ldJson(tags);
  assert.equal(blocks.length, 1);
  const graph = JSON.parse(blocks[0][1])['@graph'];
  const site = graph.find((n) => n['@type'] === 'WebSite');
  const org = graph.find((n) => n['@type'] === 'Organization');
  assert.deepEqual([site.name, site.url, site.description], ['Homeroom', 'https://app.example/', preview.LANDING_DESCRIPTION]);
  assert.equal(site.publisher['@id'], org['@id']);
  assert.deepEqual([org.name, org.url, org.logo], ['Homeroom', 'https://app.example/', 'https://app.example/brand/homeroom-mark.png']);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'brand', 'homeroom-mark.png')));

  // No configured address (a staging copy, a local server): no canonical and
  // no og:url; the picture comes from where the page was asked for.
  const staging = preview.landingTags({ origin: 'https://pr-1.example', canonical: null });
  assert.doesNotMatch(staging, /rel="canonical"|og:url/);
  assert.match(staging, /<meta property="og:image" content="https:\/\/pr-1\.example\/brand\/sky\.webp">/);
  // A value that is not an origin is never written into the page.
  const odd = preview.landingTags({ origin: 'javascript:alert(1)', canonical: 'https://app.example/"><script>' });
  assert.doesNotMatch(odd, /rel="canonical"|og:url|og:image|ld\+json|alert/);
  assert.match(odd, /<meta name="twitter:card" content="summary">/);

  // In the shell: exactly that title, one description, one canonical.
  const html = '<html>\n<head>\n<title>Homeroom</title>\n'
    + `  <meta name="description" content="${preview.LANDING_DESCRIPTION}">\n`
    + '</head>\n<body></body>\n</html>';
  const out = preview.withHead(html, tags, preview.LANDING_TITLE);
  assert.match(out, /<title>Homeroom: make apps together, one vote at a time<\/title>/);
  assert.equal((out.match(/<title>/g) || []).length, 1);
  assert.equal((out.match(/name="description"/g) || []).length, 1);
  assert.equal((out.match(/rel="canonical"/g) || []).length, 1);
  assert.ok(out.indexOf('ld+json') < out.indexOf('</head>'));
});

test('a reader with no JavaScript gets the page in words: one heading, escaped, in a noscript block at the end of the body', () => {
  // A public project: its name, the sentence its description tag carries, its address.
  const project = preview.projectContent(APP);
  assert.match(project, /^<noscript><h1>Game Corner<\/h1><p>Classic games, fresh every day\. 87 members are making it together on Homeroom\.<\/p>/);
  assert.match(project, /<a href="\/app\/game-corner">Open Game Corner<\/a>/);
  assert.match(project, /<\/noscript>$/);
  assert.ok(project.includes(`<p>${preview.descriptionOf(APP)}</p>`), 'the words are the head\'s own');
  // Nothing a project is named can close the block or start a tag.
  const odd = preview.projectContent({ ...APP, name: '</noscript><script>alert(1)</script>', description: '<img src=x onerror="x"> & more' });
  assert.equal((odd.match(/<\/noscript>/g) || []).length, 1);
  assert.doesNotMatch(odd, /<script|<img/);
  assert.match(odd, /&lt;\/noscript&gt;&lt;script&gt;/);
  assert.match(odd, /&lt;img src=x onerror=&quot;x&quot;&gt; &amp; more/);

  // The front page: the title and description of its head, then the listed projects.
  const landing = preview.landingContent([
    { slug: 'game-corner', name: 'Game Corner' },
    { slug: 'plant-pal', name: 'Plant <b>Pal</b> & "friends"' },
    { slug: '', name: 'No address' },
    null,
  ]);
  assert.ok(landing.startsWith(`<noscript><h1>${preview.LANDING_TITLE}</h1><p>${preview.LANDING_DESCRIPTION}</p>`));
  assert.match(landing, /<h2>Public projects on Homeroom<\/h2><ul><li><a href="\/app\/game-corner">Game Corner<\/a><\/li><li><a href="\/app\/plant-pal">Plant &lt;b&gt;Pal&lt;\/b&gt; &amp; &quot;friends&quot;<\/a><\/li><\/ul>/);
  assert.doesNotMatch(landing, /No address/);
  // A page of links, never the whole directory; and no empty list.
  const many = Array.from({ length: 80 }, (_, i) => ({ slug: `p-${i}`, name: `P ${i}` }));
  assert.equal(preview.LANDING_LINKS_MAX, 50);
  assert.equal((preview.landingContent(many).match(/<li>/g) || []).length, 50);
  assert.doesNotMatch(preview.landingContent([]), /<h2>|<ul>/);
  // One top-level heading each: the shell itself serves none (PR #7192).
  for (const block of [project, landing]) assert.equal((block.match(/<h1[\s>]/g) || []).length, 1);

  // It goes in as the last thing in the body, with no space around it: the
  // client hydrates the body's children, and leaves what follows them alone.
  const html = '<html><head><title>Homeroom</title></head><body class="x"><main></main><script src="/js/app.js"></script></body>\n</html>\n';
  assert.equal(preview.withBody(html, project),
    `<html><head><title>Homeroom</title></head><body class="x"><main></main><script src="/js/app.js"></script>${project}</body>\n</html>\n`);
  assert.equal(preview.withBody(html, ''), html);
  assert.equal(preview.withBody('<p>no body</p>', project), '<p>no body</p>');
});

test('GET /: signed out, the shell carries the front page\'s tags; its address is the configured one, never the Host', async (t) => {
  if (!fs.existsSync(path.join(__dirname, '..', 'public', 'index.html'))) { t.skip('no built shell'); return; }
  const before = { domain: process.env.USERNODE_DOMAIN, env: process.env.USERNODE_ENV };
  const restore = () => {
    for (const [key, value] of [['USERNODE_DOMAIN', before.domain], ['USERNODE_ENV', before.env]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  process.env.USERNODE_DOMAIN = 'app.example';
  delete process.env.USERNODE_ENV;
  try {
    const srv = await startServer();
    try {
      const page = await fetch(`${srv.base}/?report=app`, { headers: { accept: 'text/html', 'x-forwarded-host': 'forged.example' } });
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('link'), '<https://app.example/>; rel="canonical"');
      assert.equal(page.headers.get('x-robots-tag'), null);
      const html = await page.text();
      assert.match(html, /<title>Homeroom: make apps together, one vote at a time<\/title>/);
      assert.match(html, /<link rel="canonical" href="https:\/\/app\.example\/">/);
      assert.match(html, /<meta property="og:url" content="https:\/\/app\.example\/">/);
      assert.match(html, /<meta property="og:image" content="https:\/\/app\.example\/brand\/sky\.webp">/);
      assert.doesNotMatch(html, /forged\.example/);
      assert.equal((html.match(/name="description"/g) || []).length, 1);
      assert.equal((html.match(/<title>/g) || []).length, 1);
      assert.ok(html.indexOf('ld+json') < html.indexOf('</head>'));
      // In words for a reader with no JavaScript: what Homeroom is, and the
      // projects the sitemap lists (the diagnostic app nobody uses is not one).
      const words = html.match(/<noscript>[\s\S]*?<\/noscript>/g) || [];
      assert.equal(words.length, 1);
      assert.ok(html.endsWith(`${words[0]}</body>\n</html>\n`), 'the last thing in the body');
      assert.match(words[0], /<h1>Homeroom: make apps together, one vote at a time<\/h1>/);
      assert.match(words[0], /<li><a href="\/app\/game-corner">Game Corner<\/a><\/li>/);
      assert.doesNotMatch(words[0], /echo-diagnostic|forged\.example/);
      assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'the page\'s one top-level heading');
      // Something that is not a page (a fetch for JSON) is not answered here.
      assert.equal(await (await fetch(`${srv.base}/`, { headers: { accept: 'application/json' } })).text(), 'catch-all');
      // A staging copy names no address, in the header or the page.
      process.env.USERNODE_ENV = 'staging';
      const staged = await fetch(`${srv.base}/`, { headers: { accept: 'text/html' } });
      assert.equal(staged.headers.get('link'), null);
      const stagedHtml = await staged.text();
      assert.doesNotMatch(stagedHtml, /rel="canonical"|og:url/);
      assert.match(stagedHtml, /<meta property="og:title" content="Homeroom: make apps together, one vote at a time">/);
    } finally { await srv.close(); }
    delete process.env.USERNODE_ENV;
    const member = await startServer({ user: { id: 1 } });
    try {
      assert.equal(await (await fetch(`${member.base}/`, { headers: { accept: 'text/html' } })).text(), 'catch-all', 'a member\'s own load is the plain shell');
    } finally { await member.close(); }
  } finally { restore(); }
});

test('the shell keeps everything and gains the tags before </head>, named for the project', () => {
  const html = '<html><head><title>Homeroom</title></head><body></body></html>';
  const out = preview.withPreview(html, '<meta property="og:title" content="X">', 'Game Corner');
  assert.equal(out, '<html><head><title>Game Corner · Homeroom</title><meta property="og:title" content="X">\n</head><body></body></html>');
});

test('the page tells a search engine what the project is, and the day it was made', () => {
  const tags = preview.previewTags(APP, ORIGIN);
  assert.equal(ldJson(tags).length, 1, 'exactly one data block');
  const data = ldData(tags);
  assert.equal(data['@context'], 'https://schema.org');
  assert.equal(data['@type'], 'WebApplication');
  assert.equal(data.name, 'Game Corner');
  assert.equal(data.description, 'Classic games, fresh every day. 87 members are making it together on Homeroom.');
  assert.equal(data.url, preview.pageUrl(ORIGIN, 'game-corner'));
  assert.equal(data.dateCreated, '2026-10-03');
  assert.equal(data.image, 'https://app.example/api/public/apps/game-corner/cover.png');
  assert.deepEqual(data.isPartOf, { '@type': 'WebSite', name: 'Homeroom', url: 'https://app.example/' });
  assert.deepEqual(data.publisher, { '@type': 'Organization', name: 'Homeroom', url: 'https://app.example/' });

  // No readable date: the date line is left out, the rest of the record stays.
  const noDate = ldData(preview.previewTags({ ...APP, created_at: 'not a date' }, ORIGIN));
  assert.equal('dateCreated' in noDate, false);
  assert.equal(noDate.name, 'Game Corner');
  // No picture: no image.
  const noImage = ldData(preview.previewTags({ ...APP, icon_url: null, icon_emoji: null }, ORIGIN, { cover: false }));
  assert.equal('image' in noImage, false);

  // A name that tries to close the data block stays inside it.
  const evil = preview.previewTags({ ...APP, name: 'x</script><script>alert(1)</script>' }, ORIGIN);
  assert.equal((evil.match(/<\/script>/g) || []).length, 1, 'the only </script> is the block’s own');
  assert.equal(ldData(evil).name, 'x</script><script>alert(1)</script>');
});

test('the project page has one description: the shell’s is taken out, the project’s goes in', () => {
  const html = '<html>\n<head>\n<title>Homeroom</title>\n'
    + '  <meta name="description" content="Homeroom is where people make apps together: suggest a change, vote on it, and see it go live.">\n'
    + '</head>\n<body></body>\n</html>';
  const out = preview.withPreview(html, preview.previewTags(APP, ORIGIN), 'Game Corner');
  assert.equal((out.match(/name="description"/g) || []).length, 1);
  assert.doesNotMatch(out, /is where people make apps together/);
  assert.match(out, /<meta name="description" content="Classic games, fresh every day\. 87 members are making it together on Homeroom\.">/);

  // An older document without the shell line still gets the project's.
  const old = preview.withPreview('<html><head><title>Homeroom</title></head></html>', preview.previewTags(APP, ORIGIN), 'Game Corner');
  assert.equal((old.match(/name="description"/g) || []).length, 1);
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
        const game = {
          id: 7, name: 'Game Corner', slug: 'game-corner', status: 'running', view_visibility: 'public', collab_visibility: 'public',
          icon_emoji: '📊', icon_image_id: null, icon_color: '#2e6660', anon_shell: 'gated', guest_shell: null,
          description: 'Classic games, fresh every day.', member_count: 87, active_users: 42,
          created_at: '2026-06-19T00:00:00.000Z', last_merged_at: '2026-10-20T08:00:00.000Z',
        };
        // The whole directory (the sitemap): the game, and a diagnostic app
        // nobody uses that says nothing about itself.
        const idle = {
          ...game, id: 8, name: 'Echo diagnostic', slug: 'echo-diagnostic', description: null, active_users: 0,
          last_merged_at: null, created_at: '2026-05-01T00:00:00.000Z',
        };
        if (params[1] == null) return { rows: [game, idle] };
        return params[1] === 'game-corner' ? { rows: [game] } : { rows: [] };
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
    assert.match(html, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:\d+\/app\/game-corner">/);
    assert.ok(html.indexOf('og:title') < html.indexOf('</head>'));
    // The page in words, for a reader with no JavaScript.
    const words = html.match(/<noscript>[\s\S]*?<\/noscript>/g) || [];
    assert.equal(words.length, 1);
    assert.ok(html.endsWith(`${words[0]}</body>\n</html>\n`), 'the last thing in the body');
    assert.match(words[0], /<h1>Game Corner<\/h1><p>Classic games, fresh every day\. 87 members are making it together on Homeroom\.<\/p>/);
    assert.match(words[0], /<a href="\/app\/game-corner">Open Game Corner<\/a>/);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'the page\'s one top-level heading');
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
});

test('one address per project for a search engine: the canonical link names the clean path', () => {
  const tags = preview.previewTags(APP, ORIGIN);
  assert.match(tags, /<link rel="canonical" href="https:\/\/app\.example\/app\/game-corner">/);
  assert.equal(preview.pageUrl(ORIGIN, 'game-corner'), 'https://app.example/app/game-corner');
});

test('robots.txt lets search engines in and names the sitemap; a staging copy keeps them out', () => {
  const { robotsTxt } = require('../src/routes/project-preview');
  assert.equal(robotsTxt(ORIGIN, { staging: false }), 'User-agent: *\nAllow: /\nSitemap: https://app.example/sitemap.xml\n');
  assert.equal(robotsTxt(ORIGIN, { staging: true }), 'User-agent: *\nDisallow: /\n');
  // A crawler has no session: both are public paths, whole file names.
  const auth = read('src/middleware/auth.js');
  const publicPaths = auth.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/)[1];
  assert.match(publicPaths, /'\/robots\.txt',\n  '\/sitemap\.xml',/);
});

test('the sitemap lists the front page and each public project worth finding, at its clean address', async () => {
  const { worthListing, sitemapXml } = require('../src/routes/project-preview');
  assert.equal(worthListing({ description: 'A shared todo app.', active_users: 0 }), true);
  assert.equal(worthListing({ description: null, active_users: 3 }), true);
  assert.equal(worthListing({ description: '  ', active_users: 0 }), false, 'says nothing and nobody uses it');
  assert.equal(worthListing(null), false);
  const xml = sitemapXml(ORIGIN, [
    { slug: 'game-corner', description: 'Games', active_users: 4, last_merged_at: '2026-10-20T08:00:00.000Z' },
    { slug: 'quiet', description: null, active_users: 0 },
    { slug: 'Bad Slug', description: 'x', active_users: 1 },
  ]);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.deepEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]),
    ['https://app.example/', 'https://app.example/communities', 'https://app.example/app/game-corner']);
  assert.match(xml, /<loc>https:\/\/app\.example\/app\/game-corner<\/loc><lastmod>2026-10-20<\/lastmod>/);
  // A public project with a description and no merges is listed at once, with
  // the day it was made as its last change.
  const fresh = sitemapXml(ORIGIN, [
    { slug: 'made-today', description: 'A fresh app.', active_users: 0, created_at: '2026-11-20T09:15:00.000Z', last_merged_at: null },
  ]);
  assert.match(fresh, /<loc>https:\/\/app\.example\/app\/made-today<\/loc><lastmod>2026-11-20<\/lastmod>/);

  const srv = await startServer();
  try {
    const robots = await fetch(`${srv.base}/robots.txt`);
    assert.equal(robots.headers.get('content-type'), 'text/plain; charset=utf-8');
    const sitemap = await fetch(`${srv.base}/sitemap.xml`);
    assert.equal(sitemap.status, 200);
    assert.match(sitemap.headers.get('content-type'), /^application\/xml/);
    const body = await sitemap.text();
    assert.match(body, /<loc>http:\/\/127\.0\.0\.1:\d+\/app\/game-corner<\/loc>/);
    assert.doesNotMatch(body, /echo-diagnostic/, 'nothing about itself and nobody in it');
    assert.match(body, /<loc>http:\/\/127\.0\.0\.1:\d+\/<\/loc><lastmod>2026-10-20<\/lastmod>/, 'the front page, dated by its newest project');
    assert.match(body, /<loc>http:\/\/127\.0\.0\.1:\d+\/communities<\/loc>/);
  } finally { await srv.close(); }
});

test('on production a project page, the sitemap and robots.txt name the configured address, whatever Host asked', async (t) => {
  if (!fs.existsSync(path.join(__dirname, '..', 'public', 'index.html'))) { t.skip('no built shell'); return; }
  const before = { domain: process.env.USERNODE_DOMAIN, env: process.env.USERNODE_ENV };
  t.after(() => {
    for (const [key, value] of [['USERNODE_DOMAIN', before.domain], ['USERNODE_ENV', before.env]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.USERNODE_DOMAIN = 'app.example';
  delete process.env.USERNODE_ENV;
  const srv = await startServer();
  try {
    const forged = { accept: 'text/html', 'x-forwarded-host': 'evil.example' };
    const html = await (await fetch(`${srv.base}/app/game-corner`, { headers: forged })).text();
    assert.match(html, /<link rel="canonical" href="https:\/\/app\.example\/app\/game-corner">/);
    assert.match(html, /<meta property="og:url" content="https:\/\/app\.example\/app\/game-corner">/);
    assert.match(html, /"url":"https:\/\/app\.example\/app\/game-corner"/);
    assert.doesNotMatch(html, /evil\.example\/app\//);
    const sitemap = await (await fetch(`${srv.base}/sitemap.xml`, { headers: forged })).text();
    assert.match(sitemap, /<loc>https:\/\/app\.example\/<\/loc>/);
    assert.match(sitemap, /<loc>https:\/\/app\.example\/communities<\/loc>/);
    assert.match(sitemap, /<loc>https:\/\/app\.example\/app\/game-corner<\/loc>/);
    assert.doesNotMatch(sitemap, /evil\.example|127\.0\.0\.1/);
    assert.equal(await (await fetch(`${srv.base}/robots.txt`, { headers: forged })).text(),
      'User-agent: *\nAllow: /\nSitemap: https://app.example/sitemap.xml\n');
  } finally { await srv.close(); }
});

test('the sitemap dates the front page by its newest listed project and the communities page by the build, never by now', () => {
  const { sitemapXml } = require('../src/routes/project-preview');
  const communities = require('../src/services/communities-page');
  const apps = [
    { slug: 'older', description: 'Old', active_users: 1, last_merged_at: '2026-09-02T08:00:00.000Z' },
    { slug: 'newer', description: 'New', active_users: 1, created_at: '2026-11-21T23:59:00.000Z' },
    // Not listed, so its date is not the front page's.
    { slug: 'quiet', description: null, active_users: 0, last_merged_at: '2026-11-25T00:00:00.000Z' },
  ];
  const xml = sitemapXml(ORIGIN, apps, { pageDay: '2026-11-24' });
  assert.match(xml, /<url><loc>https:\/\/app\.example\/<\/loc><lastmod>2026-11-21<\/lastmod><\/url>/);
  assert.match(xml, /<url><loc>https:\/\/app\.example\/communities<\/loc><lastmod>2026-11-24<\/lastmod><\/url>/);
  assert.equal(sitemapXml(ORIGIN, apps, { pageDay: '2026-11-24' }), xml, 'the same input gives the same dates');
  // Nothing to date them by: no date, never today's.
  const bare = sitemapXml(ORIGIN, []);
  assert.match(bare, /<url><loc>https:\/\/app\.example\/<\/loc><\/url>\n {2}<url><loc>https:\/\/app\.example\/communities<\/loc><\/url>/);
  assert.doesNotMatch(sitemapXml(ORIGIN, [], { pageDay: 'yesterday"><x' }), /lastmod|yesterday/);
  assert.equal(communities.documentDay(Date.UTC(2026, 10, 24, 15, 30)), '2026-11-24');
  assert.equal(communities.documentDay(0), null, 'a build that zeroes file times gives no date');
  assert.equal(communities.documentDay(undefined), null);
  // The route reads the built document's time, and nothing reads the clock.
  const route = read('src/routes/project-preview.js');
  assert.match(route, /communitiesPage\.documentDay\(built\.mtimeMs\)/);
  assert.doesNotMatch(route.slice(route.indexOf('function sitemapXml'), route.indexOf('function projectPreviewRoutes')), /Date\.now|new Date\(\)/);
});

test('the page about private communities has its own title, description and one address in its head', () => {
  const communities = require('../src/services/communities-page');
  // Its words are the page's own: the headline and the two sentences under it.
  const catalog = JSON.parse(read('frontend/locales/en/auth.json'));
  assert.equal(communities.TITLE, catalog['guest.groups.title'].text);
  assert.equal(communities.DESCRIPTION, catalog['guest.groups.sub'].text.replace(/<\/?\d+>/g, ''));
  assert.ok(read('frontend/src/features/auth/story.tsx').includes(`export const COMMUNITIES_PATH = '${communities.COMMUNITIES_PATH}';`));

  const tags = communities.communitiesTags(ORIGIN);
  assert.match(tags, /<meta name="description" content="Say what your group needs and Homeroom builds it\. Only the people you invite can see it\.">/);
  assert.match(tags, /<link rel="canonical" href="https:\/\/app\.example\/communities">/);
  assert.match(tags, /<meta property="og:url" content="https:\/\/app\.example\/communities">/);
  assert.match(tags, /<meta property="og:title" content="An app for your group, made by your group">/);
  // No configured address (or a staging copy): the words, and no address.
  for (const origin of [null, '', 'https://evil.example/"><x']) {
    const bare = communities.communitiesTags(origin);
    assert.match(bare, /<meta name="description"/);
    assert.doesNotMatch(bare, /canonical|og:url|evil/);
  }

  const shell = '<html><head><title>Homeroom</title>\n'
    + '  <meta name="description" content="Homeroom is where people make apps together: suggest a change, vote on it, and see it go live.">\n'
    + '</head><body></body></html>';
  const html = communities.withCommunitiesHead(shell, ORIGIN);
  assert.match(html, /<title>An app for your group, made by your group · Homeroom<\/title>/);
  assert.equal((html.match(/<meta name="description"/g) || []).length, 1, 'one description: the page\'s own');
  assert.equal((html.match(/rel="canonical"/g) || []).length, 1);
  assert.ok(html.indexOf('rel="canonical"') < html.indexOf('</head>'));
});

test('GET /communities: signed out it is that page, indexable, named by the configured address and never the Host', async (t) => {
  if (!fs.existsSync(path.join(__dirname, '..', 'public', 'index.html'))) { t.skip('no built shell'); return; }
  const before = { domain: process.env.USERNODE_DOMAIN, env: process.env.USERNODE_ENV };
  t.after(() => {
    for (const [key, value] of [['USERNODE_DOMAIN', before.domain], ['USERNODE_ENV', before.env]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const srv = await startServer();
  const get = (headers = {}) => fetch(`${srv.base}/communities?from=mail`, { headers: { accept: 'text/html', ...headers } });
  try {
    process.env.USERNODE_DOMAIN = 'app.example.com';
    delete process.env.USERNODE_ENV;
    const page = await get({ 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-robots-tag'), null, 'a search engine may list it');
    const html = await page.text();
    assert.match(html, /<title>An app for your group, made by your group · Homeroom<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/app\.example\.com\/communities">/);
    assert.doesNotMatch(html, /evil\.example/, 'a forged Host names nothing');
    assert.equal((html.match(/<meta name="description"/g) || []).length, 1);

    // A staging copy, or no configured address: the page, with no canonical.
    process.env.USERNODE_ENV = 'staging';
    assert.doesNotMatch(await (await get()).text(), /rel="canonical"/);
    delete process.env.USERNODE_ENV;
    delete process.env.USERNODE_DOMAIN;
    const unnamed = await (await get({ 'x-forwarded-host': 'evil.example' })).text();
    assert.match(unnamed, /<title>An app for your group, made by your group · Homeroom<\/title>/);
    assert.doesNotMatch(unnamed, /rel="canonical"|evil\.example/);
  } finally { await srv.close(); }
  // A signed-in load is the shell's own screen: the catch-all's.
  const member = await startServer({ user: { id: 1 } });
  try {
    assert.equal(await (await fetch(`${member.base}/communities`, { headers: { accept: 'text/html' } })).text(), 'catch-all');
  } finally { await member.close(); }
  // The gate lets a visitor with no session reach it, and robots.txt allows it.
  assert.match(read('src/middleware/auth.js'), /\|\| pathname === '\/communities'/);
});
