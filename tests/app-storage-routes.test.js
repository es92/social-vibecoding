'use strict';

// Route tests for the app server's storage API (src/routes/app-storage.js):
// files an app keeps for itself, uploaded, listed, read and measured with
// its app token alone. Contracts pinned here:
//
//  - `?owner=app` stores a file with no uploader, counted against the
//    app's allowance (its own figure when an admin set one) and never a
//    person's, with the stored bytes' SHA-256;
//  - a person's upload still needs their token (missing_user_token);
//  - an app pages through its own files by id, reads one back (a Range
//    header reads part of it), and never sees another app's;
//  - app-owned uploads have their own, higher rate limit;
//  - usage without a user token has no person's figures.
//
// Harness: getPool overridden BEFORE requiring the route, a real express
// app on loopback (the private-IP gate passes), an in-memory app_files
// table and object store.
//
// Run with: node --test tests/app-storage-routes.test.js

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { Readable } = require('stream');
require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

const APP_TOKEN = 'b'.repeat(64);
const OTHER_TOKEN = 'c'.repeat(64);
const APPS = [
  { id: 11, slug: 'reader', storage_api_token: APP_TOKEN, file_storage_cap_bytes: null },
  { id: 12, slug: 'other', storage_api_token: OTHER_TOKEN, file_storage_cap_bytes: null },
];
let files = [];

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  async query(sql, params) {
    const q = norm(sql);
    if (/FROM apps WHERE storage_api_token = \$1/.test(q)) {
      const app = APPS.find((a) => a.storage_api_token === params[0]);
      return { rows: app ? [{ id: app.id, slug: app.slug, storage_api_token: app.storage_api_token }] : [] };
    }
    if (/^SELECT id FROM users WHERE id = \$1$/.test(q)) return { rows: [{ id: params[0] }] };
    if (/^SELECT file_storage_cap_bytes FROM apps WHERE id = \$1$/.test(q)) {
      const app = APPS.find((a) => a.id === params[0]);
      return { rows: app ? [{ file_storage_cap_bytes: app.file_storage_cap_bytes }] : [] };
    }
    if (/^SELECT COALESCE\(SUM\(size_bytes\), 0\)::bigint AS app_bytes/.test(q)) {
      const [appId, userId, staging] = params;
      const mine = files.filter((f) => f.app_id === appId && (staging == null || f.staging === staging));
      const sum = (list) => String(list.reduce((n, f) => n + f.size_bytes, 0));
      return {
        rows: [{
          app_bytes: sum(mine),
          user_bytes: sum(mine.filter((f) => f.user_id === userId)),
          staging_bytes: sum(mine.filter((f) => f.staging)),
          app_owned_bytes: sum(mine.filter((f) => f.owner === 'app')),
        }],
      };
    }
    if (/^INSERT INTO app_files/.test(q)) {
      const [id, appId, userId, owner, filename, contentType, size, visibility, staging, sha256] = params;
      const row = {
        id, app_id: appId, user_id: userId, owner, filename, content_type: contentType,
        size_bytes: size, visibility, staging, sha256, created_at: new Date('2026-11-18T00:00:00Z'),
      };
      files.push(row);
      return { rows: [row] };
    }
    if (/FROM app_files WHERE app_id = \$1 AND NOT staging AND \(\$2::text IS NULL OR owner = \$2\)/.test(q)) {
      const [appId, owner, after, limit] = params;
      const rows = files
        .filter((f) => f.app_id === appId && !f.staging && (owner == null || f.owner === owner)
          && (after == null || f.id > after))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, limit);
      return { rows };
    }
    if (/FROM app_files WHERE id = \$1 AND app_id = \$2 AND NOT staging$/.test(q)) {
      return { rows: files.filter((f) => f.id === params[0] && f.app_id === params[1] && !f.staging) };
    }
    return { rows: [] };
  },
});

const objects = new Map();
const store = {
  async putFile(appId, id, data) { objects.set(`${appId}/${id}`, Buffer.from(data)); },
  async getFileStream(appId, id, range = null) {
    const data = objects.get(`${appId}/${id}`);
    if (!data) throw new Error('NoSuchKey');
    return Readable.from([range ? data.subarray(range.start, range.end + 1) : data]);
  },
  async removeFile(appId, id) { objects.delete(`${appId}/${id}`); },
  async removeAppPrefix() { return 0; },
};

const express = require('express');
const appStorageRoutes = require('../src/routes/app-storage');

// One app per test: the rate limiters keep their counts per router.
async function withServer(fn) {
  const app = express();
  app.use(appStorageRoutes({}, { store }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/api/app-storage`);
  } finally {
    server.close();
  }
}

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 7)]);
const JSON_BYTES = Buffer.from(JSON.stringify({ chapter: 3, text: 'It was a dark and stormy night.' }));
const appHeaders = (token = APP_TOKEN) => ({ 'x-usernode-app-token': token });

function upload(base, { query = '', body = MP3, headers = appHeaders() } = {}) {
  return fetch(`${base}/files?${query}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    body,
  });
}

beforeEach(() => {
  files = [];
  objects.clear();
  APPS[0].file_storage_cap_bytes = null;
});

test('owner=app stores a file with no uploader, its SHA-256 and owner app', async () => {
  await withServer(async (base) => {
    const res = await upload(base, { query: 'filename=chapter-3.mp3&owner=app' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.owner, 'app');
    assert.equal(body.contentType, 'audio/mpeg');
    assert.equal(body.sha256, crypto.createHash('sha256').update(MP3).digest('hex'));
    assert.equal(files.length, 1);
    assert.equal(files[0].user_id, null);
    assert.equal(files[0].owner, 'app');
    assert.ok(objects.has(`11/${body.id}`));
  });
});

test('a user token sent with owner=app does not make the file theirs', async () => {
  await withServer(async (base) => {
    const userToken = platformJwt.signAppIdentityToken({ appId: 11, user: { id: 7, username: 'ada' } });
    const res = await upload(base, {
      query: 'filename=chapter-3.mp3&owner=app',
      headers: { ...appHeaders(), 'x-usernode-user-token': userToken },
    });
    assert.equal(res.status, 200);
    assert.equal(files[0].user_id, null);
    assert.equal(files[0].owner, 'app');
  });
});

test('a person\'s upload still needs their token', async () => {
  await withServer(async (base) => {
    for (const query of ['filename=a.mp3', 'filename=a.mp3&owner=user']) {
      const res = await upload(base, { query });
      assert.equal(res.status, 401, query);
      assert.equal((await res.json()).code, 'missing_user_token');
    }
    const bad = await upload(base, { query: 'filename=a.mp3&owner=someone' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'invalid_owner');
    assert.equal(files.length, 0);
  });
});

test('an app file counts against the app allowance only, which an admin can set', async () => {
  // A person's 1 GB is long gone; the app's own file still fits.
  files.push({
    id: 'f'.repeat(32), app_id: 11, user_id: null, owner: 'app', size_bytes: 2 * 1024 * 1024 * 1024,
    staging: false, filename: 'big.mp3', content_type: 'audio/mpeg', visibility: 'public',
  });
  await withServer(async (base) => {
    const ok = await upload(base, { query: 'filename=more.mp3&owner=app' });
    assert.equal(ok.status, 200);
    APPS[0].file_storage_cap_bytes = 2 * 1024 * 1024 * 1024;
    const full = await upload(base, { query: 'filename=more.mp3&owner=app' });
    assert.equal(full.status, 400);
    const body = await full.json();
    assert.equal(body.code, 'app_quota_exceeded');
    assert.match(body.error, /2 GB max/);
  });
});

test('an app lists its own files a page at a time, with sizes and digests', async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await upload(base, { query: `filename=c${i}.json&owner=app`, body: JSON_BYTES })).status, 200);
    }
    // Another app's file never shows.
    assert.equal((await upload(base, {
      query: 'filename=theirs.json&owner=app', body: JSON_BYTES, headers: appHeaders(OTHER_TOKEN),
    })).status, 200);

    const first = await (await fetch(`${base}/files?owner=app&limit=2`, { headers: appHeaders() })).json();
    assert.equal(first.ok, true);
    assert.equal(first.files.length, 2);
    assert.ok(first.next);
    assert.equal(first.files[0].sha256, crypto.createHash('sha256').update(JSON_BYTES).digest('hex'));
    const second = await (await fetch(`${base}/files?owner=app&limit=2&after=${first.next}`, { headers: appHeaders() })).json();
    assert.equal(second.files.length, 1);
    assert.equal(second.next, null);
    const ids = [...first.files, ...second.files].map((f) => f.id);
    assert.deepEqual(ids, files.filter((f) => f.app_id === 11).map((f) => f.id).sort());

    for (const query of ['owner=nobody', 'after=zzz', 'limit=0', 'limit=1001']) {
      assert.equal((await fetch(`${base}/files?${query}`, { headers: appHeaders() })).status, 400, query);
    }
  });
});

test('an app reads back its own file, whole or one range, and never another app\'s', async () => {
  await withServer(async (base) => {
    const stored = await (await upload(base, {
      query: 'filename=c.json&owner=app&visibility=private', body: JSON_BYTES,
    })).json();
    const whole = await fetch(`${base}/files/${stored.id}`, { headers: appHeaders() });
    assert.equal(whole.status, 200);
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), JSON_BYTES);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(whole.headers.get('etag'), `"${stored.sha256}"`);

    const part = await fetch(`${base}/files/${stored.id}`, { headers: { ...appHeaders(), range: 'bytes=2-9' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 2-9/${JSON_BYTES.length}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), JSON_BYTES.subarray(2, 10));

    const other = await fetch(`${base}/files/${stored.id}`, { headers: appHeaders(OTHER_TOKEN) });
    assert.equal(other.status, 404);
  });
});

test('app-owned uploads have their own limit, above a person\'s 20 a minute', async () => {
  await withServer(async (base) => {
    for (let i = 0; i < 25; i++) {
      const res = await upload(base, { query: `filename=c${i}.mp3&owner=app` });
      assert.equal(res.status, 200, `upload ${i}`);
    }
  });
});

test('usage without a user token reports the app and no person', async () => {
  await withServer(async (base) => {
    await upload(base, { query: 'filename=c.mp3&owner=app' });
    const usage = await (await fetch(`${base}/usage`, { headers: appHeaders() })).json();
    assert.equal(usage.ok, true);
    assert.equal(usage.appBytes, MP3.length);
    assert.equal(usage.appOwnedBytes, MP3.length);
    assert.equal(usage.appCapBytes, 10 * 1024 * 1024 * 1024);
    assert.equal(usage.userBytes, null);
    assert.equal(usage.userCapBytes, null);
  });
});

test('a file whose object is gone reads back as the route\'s JSON 404', async () => {
  await withServer(async (base) => {
    const stored = await (await upload(base, { query: 'filename=c.json&owner=app', body: JSON_BYTES })).json();
    objects.delete(`11/${stored.id}`);
    const res = await fetch(`${base}/files/${stored.id}`, { headers: appHeaders() });
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await res.json(), { ok: false, code: 'not_found', error: 'File not found' });
  });
});
