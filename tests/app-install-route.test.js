// Route tests for the per-app home-screen install (#1508,
// src/routes/app-install.js): the app's manifest and the page that carries
// it. Contracts pinned here:
//
//  - both routes answer through getAppForUser at 'view', and a denial is a
//    404 (never a 403), so a private app is not enumerable this way;
//  - no session: the manifest 404s, the page renders its sign-in variant;
//  - a malformed slug never reaches the app lookup;
//  - the manifest is application/manifest+json, private and uncached,
//    keyed to /app/<slug>/full with the app's own scope, with the PNG
//    icon's real dimensions read once per icon id;
//  - the page carries its manifest link with credentials, the
//    apple-touch-icon and the escaped name;
//  - an icon header read that fails degrades the icon to sizes "any".
//
// Harness shape follows tests/app-files-route.test.js: override getPool +
// stub app-access BEFORE requiring the route, mount on a real express app.
//
// Run with: node --test tests/app-install-route.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: (sql, params) => poolQueryHandler(sql, params),
});

// Controllable app-access gate, stubbed BEFORE requiring the route.
const appAccessId = require.resolve('../src/services/app-access');
let accessCalls = [];
let viewGrant = null;
require.cache[appAccessId] = {
  id: appAccessId,
  filename: appAccessId,
  loaded: true,
  paths: [],
  exports: {
    ACCESS_COLUMNS: 'id, slug, created_by, self_hosted, collab_visibility, view_visibility',
    getAppForUser: async (_pool, slug, user, level, columns) => {
      accessCalls.push({ slug, user, level, columns });
      return level === 'view' ? viewGrant : null;
    },
  },
};

const { appInstallRoutes } = require('../src/routes/app-install');

const ICON_ID = 'b'.repeat(32);
const USER = { id: 5, username: 'alice', isAdmin: false };
const APP = {
  id: 7, slug: 'recipe-box', name: 'Tom & Jerry <3', icon_emoji: null, icon_image_id: ICON_ID,
  manifest_snapshot: { description: 'Keeps recipes.' },
};

function pngHeader(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// One server per test: the route keeps an in-process icon cache, and a
// fresh router is what keeps one test's cache out of the next.
function startServer(user) {
  const app = express();
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use(appInstallRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function get(server, path) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { redirect: 'manual' });
  const body = await res.text();
  return { res, body };
}

beforeEach(() => {
  accessCalls = [];
  viewGrant = { ...APP };
  poolQueryHandler = async (sql) => {
    assert.match(sql, /FROM app_icons WHERE id = \$1/);
    return { rows: [{ content_type: 'image/png', head: pngHeader(192, 192) }] };
  };
});

// ── No session ──────────────────────────────────────────────────────

test('no session: the manifest 404s and the page renders the sign-in variant', async () => {
  const server = await startServer(null);
  try {
    const manifest = await get(server, '/app/recipe-box/manifest.webmanifest');
    assert.equal(manifest.res.status, 404);
    assert.equal(manifest.res.headers.get('cache-control'), 'private, no-store');

    const page = await get(server, '/app/recipe-box/install');
    assert.equal(page.res.status, 200);
    assert.match(page.res.headers.get('content-type'), /^text\/html/);
    assert.equal(page.res.headers.get('cache-control'), 'private, no-store');
    assert.match(page.body, /Sign in to Homeroom/);
    assert.ok(page.body.includes('href="/app/recipe-box"'), 'the shell route handles login and continues');
    assert.ok(!page.body.includes('id="app-install"'), 'the sign-in variant is not the install page');
    assert.doesNotMatch(page.body, /manifest\.webmanifest/);
    assert.deepEqual(accessCalls, [], 'nothing is looked up without a session');
  } finally {
    server.close();
  }
});

// ── The gate ────────────────────────────────────────────────────────

test('a malformed slug 404s without touching the app lookup', async () => {
  const server = await startServer(USER);
  try {
    for (const bad of ['Recipe_Box', '-leading', 'a%20b']) {
      const manifest = await get(server, `/app/${bad}/manifest.webmanifest`);
      assert.equal(manifest.res.status, 404, `manifest: expected 404 for ${bad}`);
      const page = await get(server, `/app/${bad}/install`);
      assert.equal(page.res.status, 404, `page: expected 404 for ${bad}`);
    }
    assert.deepEqual(accessCalls, []);
  } finally {
    server.close();
  }
});

test('a denied or unknown app is a 404 on both routes, and the same 404', async () => {
  viewGrant = null;
  const server = await startServer(USER);
  try {
    const manifest = await get(server, '/app/recipe-box/manifest.webmanifest');
    assert.equal(manifest.res.status, 404);
    assert.deepEqual(JSON.parse(manifest.body), { error: 'App not found' });

    const page = await get(server, '/app/recipe-box/install');
    assert.equal(page.res.status, 404);
    assert.match(page.body, /App not found/);
    assert.ok(!page.body.includes('Tom'), 'nothing about the app leaks into the 404');

    assert.equal(accessCalls.length, 2);
    for (const call of accessCalls) {
      assert.equal(call.level, 'view');
      assert.equal(call.slug, 'recipe-box');
      assert.equal(call.user, USER);
      // ACCESS_COLUMNS in full (checkAppAccess reads view_visibility off the
      // row) plus what the manifest and the page need.
      assert.match(call.columns, /^id, slug, created_by, self_hosted, collab_visibility, view_visibility, /);
      for (const col of ['name', 'icon_emoji', 'icon_image_id', 'manifest_snapshot']) {
        assert.ok(call.columns.split(', ').includes(col), `selects ${col}`);
      }
    }
  } finally {
    server.close();
  }
});

// ── The manifest ────────────────────────────────────────────────────

test('the manifest is the app\'s own, with the PNG icon\'s real size, read once per id', async () => {
  let iconReads = 0;
  poolQueryHandler = async (sql, params) => {
    iconReads += 1;
    assert.match(sql, /^SELECT content_type, substring\(data FROM 1 FOR 32\) AS head FROM app_icons WHERE id = \$1$/);
    assert.deepEqual(params, [ICON_ID]);
    return { rows: [{ content_type: 'image/png', head: pngHeader(384, 384) }] };
  };
  const server = await startServer(USER);
  try {
    const { res, body } = await get(server, '/app/recipe-box/manifest.webmanifest');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/manifest\+json/);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const manifest = JSON.parse(body);
    assert.equal(manifest.id, '/app/recipe-box/full');
    assert.equal(manifest.start_url, '/app/recipe-box/full');
    assert.equal(manifest.scope, '/app/recipe-box/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.name, 'Tom & Jerry <3');
    assert.equal(manifest.short_name, 'Tom & Jerry <3');
    assert.equal(manifest.description, 'Keeps recipes.');
    assert.equal(manifest.background_color, '#f4f2e4');
    assert.equal(manifest.theme_color, '#f4f2e4');
    assert.deepEqual(manifest.icons, [
      { src: `/app-icons/${ICON_ID}`, sizes: '384x384', type: 'image/png', purpose: 'any' },
    ]);

    // Ids are immutable, so the header is read once and remembered.
    await get(server, '/app/recipe-box/manifest.webmanifest');
    await get(server, '/app/recipe-box/manifest.webmanifest');
    assert.equal(iconReads, 1);
  } finally {
    server.close();
  }
});

test('an emoji app declares the SVG tile plus the platform PNGs, and reads no icon', async () => {
  viewGrant = { ...APP, icon_image_id: null, icon_emoji: '🍕', manifest_snapshot: null };
  let iconReads = 0;
  poolQueryHandler = async () => { iconReads += 1; return { rows: [] }; };
  const server = await startServer(USER);
  try {
    const { res, body } = await get(server, '/app/recipe-box/manifest.webmanifest');
    assert.equal(res.status, 200);
    const manifest = JSON.parse(body);
    assert.equal(manifest.description, undefined, 'no snapshot, no description');
    assert.equal(manifest.icons.length, 4);
    assert.equal(manifest.icons[0].type, 'image/svg+xml');
    assert.ok(decodeURIComponent(manifest.icons[0].src).includes('🍕'));
    assert.equal(manifest.icons[1].src, '/icons/v2/icon-192.png');
    assert.equal(manifest.icons[3].purpose, 'maskable');
    assert.equal(iconReads, 0);
  } finally {
    server.close();
  }
});

test('a failed icon header read degrades to sizes "any" rather than a 500', async () => {
  poolQueryHandler = async () => { throw new Error('connection terminated'); };
  const server = await startServer(USER);
  try {
    const { res, body } = await get(server, '/app/recipe-box/manifest.webmanifest');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(body).icons, [
      { src: `/app-icons/${ICON_ID}`, sizes: 'any', purpose: 'any' },
    ]);
  } finally {
    server.close();
  }
});

test('a non-PNG icon keeps its stored type with sizes "any"', async () => {
  poolQueryHandler = async () => ({
    rows: [{ content_type: 'image/jpeg', head: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(29)]) }],
  });
  const server = await startServer(USER);
  try {
    const { body } = await get(server, '/app/recipe-box/manifest.webmanifest');
    assert.deepEqual(JSON.parse(body).icons, [
      { src: `/app-icons/${ICON_ID}`, sizes: 'any', type: 'image/jpeg', purpose: 'any' },
    ]);
  } finally {
    server.close();
  }
});

test('an app lookup failure is a 500 on both routes', async () => {
  require.cache[appAccessId].exports.getAppForUser = async () => { throw new Error('db down'); };
  const server = await startServer(USER);
  try {
    assert.equal((await get(server, '/app/recipe-box/manifest.webmanifest')).res.status, 500);
    assert.equal((await get(server, '/app/recipe-box/install')).res.status, 500);
  } finally {
    server.close();
    require.cache[appAccessId].exports.getAppForUser = async (_pool, slug, user, level, columns) => {
      accessCalls.push({ slug, user, level, columns });
      return level === 'view' ? viewGrant : null;
    };
  }
});

// ── The page ────────────────────────────────────────────────────────

test('the install page is a standalone document carrying the app\'s manifest and icon', async () => {
  const server = await startServer(USER);
  try {
    const { res, body } = await get(server, '/app/recipe-box/install');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.ok(body.startsWith('<!DOCTYPE html>'), 'not the SPA shell');
    assert.ok(body.includes('id="app-install"'));
    assert.ok(body.includes('<link rel="manifest" href="/app/recipe-box/manifest.webmanifest" crossorigin="use-credentials">'));
    assert.ok(body.includes(`<link rel="apple-touch-icon" href="/app-icons/${ICON_ID}">`));
    assert.ok(body.includes('<title>Tom &amp; Jerry &lt;3</title>'));
    assert.ok(body.includes('<h1>Tom &amp; Jerry &lt;3</h1>'));
    assert.ok(!body.includes('Jerry <3'), 'the raw name never reaches the markup');
    assert.ok(body.includes('href="/app/recipe-box"'), 'Back to the app');
    assert.ok(body.includes('href="/app/recipe-box/full"'), 'Open, when already installed');
    // The page needs no icon header: the manifest reads that on its own.
    assert.equal(accessCalls.length, 1);
  } finally {
    server.close();
  }
});

test('an emoji app\'s page offers iOS the platform icon and draws the emoji', async () => {
  viewGrant = { ...APP, icon_image_id: null, icon_emoji: '🍕' };
  const server = await startServer(USER);
  try {
    const { body } = await get(server, '/app/recipe-box/install');
    assert.ok(body.includes('<link rel="apple-touch-icon" href="/apple-touch-icon.png">'));
    assert.ok(body.includes('<span aria-hidden="true">🍕</span>'));
    assert.doesNotMatch(body, /app-icons\//);
  } finally {
    server.close();
  }
});
