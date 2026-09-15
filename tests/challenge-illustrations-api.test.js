// Challenge illustration gallery API (src/routes/topochain/challenge-illustrations.js):
// the admin list/upload/archive routes and the public image route.
//
// Same "fake Postgres" idiom as tests/topochain-admin-api2.test.js: the table
// is a plain array and one collapsed-SQL dispatcher answers the four queries
// the module issues. The platform user is injected ahead of the routers the
// way that file does it, so adminWriteGate is exercised for real.
//
// Run with: node --test tests/challenge-illustrations-api.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// Install the pool BEFORE requiring any route module: each factory reads
// getPool() when it builds its router.
const poolMod = require('../src/db/pool');
let rows = [];
let writes = 0;
let clock = Date.parse('2026-09-15T10:00:00.000Z');
const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();
poolMod.getPool = () => ({
  async query(rawSql, params = []) {
    const sql = collapse(rawSql);
    const pick = (r) => ({ id: r.id, slug: r.slug, label: r.label, tone: r.tone, archived: r.archived, created_at: r.created_at });
    if (sql === 'SELECT id, slug, label, tone, archived, created_at FROM challenge_illustrations ORDER BY created_at DESC, id DESC') {
      return { rows: [...rows].sort((a, b) => b.created_at - a.created_at).map(pick) };
    }
    if (sql.startsWith('INSERT INTO challenge_illustrations (id, slug, label, tone, content_type, data, created_by)')) {
      writes++;
      const [id, slug, label, tone, contentType, data, createdBy] = params;
      const row = { id, slug, label, tone, content_type: contentType, data, archived: false, created_by: createdBy, created_at: new Date(clock += 1000) };
      rows.push(row);
      return { rows: [pick(row)] };
    }
    if (sql.startsWith('UPDATE challenge_illustrations SET archived = $2 WHERE slug = $1')) {
      writes++;
      const row = rows.find((r) => r.slug === params[0]);
      if (row) row.archived = params[1];
      return { rows: row ? [pick(row)] : [] };
    }
    if (sql === 'SELECT content_type, data FROM challenge_illustrations WHERE id = $1') {
      const row = rows.find((r) => r.id === params[0]);
      return { rows: row ? [{ content_type: row.content_type, data: row.data }] : [] };
    }
    throw new Error(`Unhandled SQL in mock: ${sql}`);
  },
});

const {
  challengeIllustrationImageRoutes, challengeIllustrationsAdminRoutes, parseLabel,
} = require('../src/routes/topochain/challenge-illustrations');
const { topochainAdminRoutes } = require('../src/routes/topochain/admin');
const { TONES } = require('../src/routes/app-illustrations');

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#fff"/></svg>\n');

function withUser(role) {
  return (req, _res, next) => {
    if (role === 'user') req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false };
    else if (role === 'readonly') req.user = { id: 901, username: 'ro-admin', isAdmin: true, canAdminWrite: false };
    else req.user = { id: 902, username: 'full-admin', isAdmin: true, canAdminWrite: true };
    next();
  };
}

// The admin routes as composed in production (behind topochainAdminRoutes'
// router-wide read gate), plus the public image route with no user at all.
async function start(role = 'admin') {
  const app = express();
  app.use(challengeIllustrationImageRoutes({}));
  app.use(express.json());
  app.use(withUser(role));
  app.use(topochainAdminRoutes({}));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
    upload: (query, body, type = 'application/octet-stream') => fetch(`${base}/api/v4/admin/challenge-illustrations?${query}`, {
      method: 'POST', headers: { 'Content-Type': type }, body,
    }),
    patch: (slug, body) => fetch(`${base}/api/v4/admin/challenge-illustrations/${slug}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    list: () => fetch(`${base}/api/v4/admin/challenge-illustrations`),
  };
}

test.beforeEach(() => { rows = []; writes = 0; });

test('POST stores PNG, WebP and SVG with the sniffed content type, and GET lists them newest first', async () => {
  const api = await start();
  try {
    const made = [];
    for (const [file, tone, type] of [[PNG, 'teal', 'image/png'], [WEBP, 'coral', 'image/webp'], [SVG, 'mint', 'image/svg+xml']]) {
      const res = await api.upload(`label=${encodeURIComponent(`  ${type} art  `)}&tone=${tone}`, file);
      assert.equal(res.status, 201, type);
      const body = await res.json();
      assert.equal(body.success, true);
      const { data } = body;
      assert.match(data.slug, /^u-[a-f0-9]{32}$/, 'an uploaded slug the template validator already accepts');
      assert.equal(data.src, `/challenge-illustrations/${data.slug.slice(2)}`, 'the path is derived from the id');
      assert.equal(data.label, `${type} art`, 'the name is trimmed');
      assert.equal(data.tone, tone);
      assert.equal(data.archived, false);
      assert.match(data.created_at, /\+00:00$/, 'the v4 date format');
      assert.deepEqual(Object.keys(data).sort(), ['archived', 'created_at', 'label', 'slug', 'src', 'tone']);
      const stored = rows.find((r) => r.slug === data.slug);
      assert.equal(stored.content_type, type, 'the stored type comes from the bytes, not the request');
      assert.deepEqual(Buffer.from(stored.data), file);
      assert.equal(stored.created_by, 902);
      made.push(data.slug);
    }

    const listed = await api.list();
    assert.equal(listed.status, 200);
    const list = await listed.json();
    assert.equal(list.success, true);
    assert.deepEqual(list.data.map((d) => d.slug), [...made].reverse(), 'newest first');
  } finally { await api.close(); }
});

test('POST refuses a bad name or tone before it looks at the file, and writes nothing', async () => {
  const api = await start();
  try {
    const cases = [
      ['tone=teal', /name of 1 to 80 characters/],
      ['label=%20%20&tone=teal', /name of 1 to 80 characters/],
      [`label=${'a'.repeat(81)}&tone=teal`, /name of 1 to 80 characters/],
      ['label=a%01b&tone=teal', /name of 1 to 80 characters/],
      ['label=x&label=y&tone=teal', /name of 1 to 80 characters/],
      ['label=Art', /twelve tones/],
      ['label=Art&tone=lilac', /twelve tones/],
      ['label=Art&tone=Teal', /twelve tones/],
    ];
    for (const [query, message] of cases) {
      const res = await api.upload(query, PNG);
      assert.equal(res.status, 400, query);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, message, query);
    }
    assert.equal(writes, 0);
    assert.equal(parseLabel('a'.repeat(80)), 'a'.repeat(80), 'exactly 80 characters is a name');
    assert.equal(parseLabel(`${'e'.repeat(79)}${String.fromCodePoint(0x1f3a8)}`).length, 81,
      '80 code points is a name even where JavaScript counts 81 units');
    for (const tone of TONES) assert.ok(typeof tone === 'string' && /^[a-z]+$/.test(tone));
  } finally { await api.close(); }
});

test('POST refuses other formats, empty and oversized files, and an unsafe SVG with its reason', async () => {
  const api = await start();
  try {
    const expectations = [
      [JPEG, /PNG, WebP or SVG/, 'a JPEG'],
      [Buffer.from('GIF89a' + '\0'.repeat(10), 'latin1'), /PNG, WebP or SVG/, 'a GIF'],
      [Buffer.from('just some text'), /PNG, WebP or SVG/, 'plain text'],
      [Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]), /1 MB or smaller/, 'a PNG over 1 MB'],
      [Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><title>${'a'.repeat(300 * 1024)}</title></svg>`),
        /SVG files must be 256 KB or smaller/, 'an SVG over 256 KB'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>'),
        /^This SVG was refused\. The <script> element is not allowed\.$/, 'an SVG with a script'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" onload="alert(1)"></svg>'),
        /Event handler attributes such as onload are not allowed/, 'an SVG with onload'],
      [Buffer.from('<!DOCTYPE html><html><body>hi</body></html>'), /DOCTYPE/, 'an HTML page'],
    ];
    for (const [file, message, label] of expectations) {
      const res = await api.upload('label=Art&tone=teal', file);
      assert.equal(res.status, 400, label);
      assert.match((await res.json()).error, message, label);
    }
    // No body at all, and a body sent as something other than raw bytes.
    let res = await api.upload('label=Art&tone=teal', undefined);
    assert.equal(res.status, 400);
    res = await api.upload('label=Art&tone=teal', JSON.stringify({ file: 'x' }), 'application/json');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /PNG, WebP or SVG/);
    assert.equal(writes, 0);
  } finally { await api.close(); }
});

test('writes need a full admin; reads need any admin', async () => {
  rows.push({ id: 'a'.repeat(32), slug: `u-${'a'.repeat(32)}`, label: 'Kept', tone: 'teal', content_type: 'image/png', data: PNG, archived: false, created_at: new Date(clock) });

  const readonly = await start('readonly');
  try {
    assert.equal((await readonly.list()).status, 200, 'a view-only admin may read the gallery');
    let res = await readonly.upload('label=Art&tone=teal', PNG);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'Full admin access required.' });
    res = await readonly.patch(`u-${'a'.repeat(32)}`, { archived: true });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'Full admin access required.' });
    assert.equal(writes, 0);
  } finally { await readonly.close(); }

  const plain = await start('user');
  try {
    const res = await plain.list();
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'Unauthorized. Admin access required.' });
  } finally { await plain.close(); }
});

test('PATCH archives and restores; unknown or built-in slugs are 404, a bad body 400', async () => {
  const api = await start();
  try {
    const { data: made } = await (await api.upload('label=Art&tone=sage', PNG)).json();

    let res = await api.patch(made.slug, { archived: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.archived, true);
    const listed = (await (await api.list()).json()).data;
    assert.equal(listed.find((d) => d.slug === made.slug).archived, true, 'still listed, so a template naming it can draw it');

    res = await api.patch(made.slug, { archived: false });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.archived, false);

    for (const bad of [{}, { archived: 'true' }, { archived: 1 }, { archived: null }]) {
      res = await api.patch(made.slug, bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.match((await res.json()).error, /archived as true or false/);
    }
    for (const slug of [`u-${'f'.repeat(32)}`, 'block-production', `u-${'A'.repeat(32)}`, 'u-short']) {
      res = await api.patch(slug, { archived: true });
      assert.equal(res.status, 404, slug);
      assert.deepEqual(await res.json(), { success: false, error: 'Illustration not found.' });
    }
  } finally { await api.close(); }
});

test('the image route: 404s, the bytes, and headers that keep script out, archived rows included', async () => {
  const api = await start();
  try {
    const png = (await (await api.upload('label=Raster&tone=blue', PNG)).json()).data;
    const svg = (await (await api.upload('label=Vector&tone=pink', SVG)).json()).data;
    await api.patch(png.slug, { archived: true });

    for (const bad of ['xyz', 'A'.repeat(32), 'a'.repeat(31), `${'a'.repeat(32)}.svg`, 'f'.repeat(32)]) {
      assert.equal((await fetch(`${api.base}/challenge-illustrations/${bad}`)).status, 404, bad);
    }

    for (const [item, type, bytes] of [[png, 'image/png', PNG], [svg, 'image/svg+xml', SVG]]) {
      const res = await fetch(api.base + item.src);
      assert.equal(res.status, 200, `${type} is served${item === png ? ' although archived' : ''}`);
      assert.equal(res.headers.get('content-type'), type);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      assert.equal(res.headers.get('content-disposition'), 'inline');
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
    }
  } finally { await api.close(); }
});

// The image route is public only because of where it mounts and the
// PUBLIC_PATHS entry (pinned in tests/history.test.js). Neither is visible from
// this harness, so the mount order is pinned in source.
test('server.js mounts the image route before authMiddleware, beside the app illustration images', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const image = server.indexOf('app.use(challengeIllustrationImageRoutes(config));');
  const sibling = server.indexOf('app.use(illustrationImageRoutes(config));');
  const auth = server.indexOf('app.use(authMiddleware(config));');
  assert.ok(image > -1 && sibling > -1 && auth > -1);
  assert.ok(image < auth, 'before authMiddleware');
  assert.ok(image > sibling && image - sibling < 600, 'next to illustrationImageRoutes');
  assert.doesNotMatch(server, /challengeIllustrationsAdminRoutes/, 'the admin routes arrive only through topochainAdminRoutes');
});
