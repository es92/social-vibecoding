// Route tests for app file storage (#752, src/routes/app-files.js):
// the public serving route and the shell-facing upload/delete/usage
// routes. Contracts pinned here:
//
//  - serving: 32-hex id gate (malformed ids never touch the DB), public
//    files stream with the year-long immutable header, private files
//    require a valid ?token= user JWT (404 without — non-enumerable),
//    object-missing-for-row degrades to 404, unconfigured store → 503;
//  - shell upload: view-gated (404 when getAppForUser denies), staging=1
//    stamps the row, quota/validation errors surface their structured
//    codes, MinIO-down → 503 storage_unavailable;
//  - shell delete: uploader-only.
//
// Harness shape follows tests/chat-attachments-route.test.js: override
// getPool + stub app-access BEFORE requiring the route, mount on a real
// express app, fake object store injected via the route factory's deps.
//
// Run with: node --test tests/app-files-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
require('./platform-keys').setPlatformKeys();
const platformJwt = require('../src/services/platform-jwt');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: (sql, params) => poolQueryHandler(sql, params),
});

// Controllable app-access gate, stubbed BEFORE requiring the route.
const appAccessId = require.resolve('../src/services/app-access');
let accessGrants = { view: { id: 7 } };
require.cache[appAccessId] = {
  id: appAccessId,
  filename: appAccessId,
  loaded: true,
  paths: [],
  exports: {
    ACCESS_COLUMNS: 'id, slug',
    getAppForUser: async (_pool, _slug, _user, level) => accessGrants[level] || null,
  },
};

const { appFileServeRoutes, appFileShellRoutes } = require('../src/routes/app-files');
const express = require('express');

const GOOD_ID = 'a'.repeat(32);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 1),
]);

function fakeStore(overrides = {}) {
  return {
    async putFile() {},
    async getFileStream() { return Readable.from([PNG]); },
    async removeFile() {},
    async removeAppPrefix() { return 0; },
    ...overrides,
  };
}

function startServeServer(store) {
  const app = express();
  app.use(appFileServeRoutes({}, { store }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function startShellServer(store, userId = 5) {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: userId, username: 'alice' }; next(); });
  app.use(appFileShellRoutes({}, { store }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

// ── Serving ─────────────────────────────────────────────────────────

test('serves a public file: streamed bytes, stored type, immutable cache', async () => {
  poolQueryHandler = async (_sql, params) => {
    assert.deepEqual(params, [GOOD_ID]);
    return { rows: [{ app_id: 7, filename: 'dish.png', content_type: 'image/png', visibility: 'public' }] };
  };
  const server = await startServeServer(fakeStore());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable, no-transform');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition'), /^inline; filename="dish.png"/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(PNG));
  } finally {
    server.close();
  }
});

test('malformed ids 404 without querying the DB', async () => {
  let queried = false;
  poolQueryHandler = async () => { queried = true; return { rows: [] }; };
  const server = await startServeServer(fakeStore());
  try {
    for (const bad of ['short', 'Z'.repeat(32), 'a'.repeat(31)]) {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${bad}`);
      assert.equal(res.status, 404, `expected 404 for ${bad}`);
    }
    assert.equal(queried, false);
  } finally {
    server.close();
  }
});

test('unknown id 404s', async () => {
  poolQueryHandler = async () => ({ rows: [] });
  const server = await startServeServer(fakeStore());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${'f'.repeat(32)}`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('private file: 404 without a token, served with a valid one, short private cache', async () => {
  poolQueryHandler = async () => ({
    rows: [{ app_id: 7, filename: 'p.png', content_type: 'image/png', visibility: 'private' }],
  });
  const server = await startServeServer(fakeStore());
  try {
    const base = `http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`;
    assert.equal((await fetch(base)).status, 404);
    assert.equal((await fetch(`${base}?token=garbage`)).status, 404);
    // Scoped (infrastructure) tokens are rejected like app-storage-auth.
    // A worker token is a different authority entirely now, so it fails at
    // the verifier rather than on the shape check — either way, 404.
    assert.equal(
      (await fetch(`${base}?token=${platformJwt.signWorkerToken({ sessionId: 1 })}`)).status,
      404
    );
    // A user identity minted for a DIFFERENT app must not unlock this
    // app's private file — the row's app_id is the audience checked.
    const otherApp = platformJwt.signAppIdentityToken({
      appId: 8, user: { id: 7, username: 'alice' },
    });
    assert.equal((await fetch(`${base}?token=${otherApp}`)).status, 404);
    const good = platformJwt.signAppIdentityToken({
      appId: 7, user: { id: 7, username: 'alice' },
    });
    const res = await fetch(`${base}?token=${good}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'private, max-age=3600, no-transform');
  } finally {
    server.close();
  }
});

test('object missing for an existing row degrades to 404', async () => {
  poolQueryHandler = async () => ({
    rows: [{ app_id: 7, filename: 'gone.png', content_type: 'image/png', visibility: 'public' }],
  });
  const server = await startServeServer(fakeStore({
    async getFileStream() { throw new Error('NoSuchKey'); },
  }));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`);
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('unconfigured store 503s for an existing row', async () => {
  poolQueryHandler = async () => ({
    rows: [{ app_id: 7, filename: 'x.png', content_type: 'image/png', visibility: 'public' }],
  });
  const server = await startServeServer(null);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`);
    assert.equal(res.status, 503);
  } finally {
    server.close();
  }
});

// ── Shell upload / delete / usage ───────────────────────────────────

function shellPoolHandler({ appBytes = 0, userBytes = 0, stagingBytes = 0 } = {}) {
  const inserts = [];
  const handler = async (sql, params) => {
    if (/SELECT[\s\S]*FROM app_files WHERE app_id/.test(sql)) {
      return { rows: [{ app_bytes: String(appBytes), user_bytes: String(userBytes), staging_bytes: String(stagingBytes) }] };
    }
    if (/INSERT INTO app_files/.test(sql)) {
      inserts.push(params);
      return { rows: [{ id: params[0], filename: params[4], content_type: params[5], size_bytes: params[6], visibility: params[7], owner: params[3], sha256: params[9], created_at: new Date(0) }] };
    }
    if (/SELECT id, user_id FROM app_files/.test(sql)) {
      return { rows: [{ id: params[0], user_id: 5 }] };
    }
    return { rows: [] };
  };
  handler.inserts = inserts;
  return handler;
}

test('shell upload stores the file and returns the stored shape', async () => {
  const handler = shellPoolHandler();
  poolQueryHandler = handler;
  accessGrants = { view: { id: 7 } };
  const server = await startShellServer(fakeStore());
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/files?filename=dish.png`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'X-Usernode-App-Bridge': 'isolated-v2' }, body: PNG }
    );
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.match(j.id, /^[a-f0-9]{32}$/);
    assert.equal(j.contentType, 'image/png');
    assert.equal(j.visibility, 'public');
    // INSERT params: [id, appId, userId, owner, filename, contentType, size, visibility, staging, sha256]
    assert.equal(handler.inserts.length, 1);
    assert.equal(handler.inserts[0][8], false);
  } finally {
    server.close();
  }
});

test('shell upload with staging=1 stamps the row', async () => {
  const handler = shellPoolHandler();
  poolQueryHandler = handler;
  const server = await startShellServer(fakeStore());
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/files?filename=dish.png&staging=1`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'X-Usernode-App-Bridge': 'isolated-v2' }, body: PNG }
    );
    assert.equal(res.status, 200);
    assert.equal(handler.inserts[0][8], true);
  } finally {
    server.close();
  }
});

test('shell upload is view-gated: 404 when access denied', async () => {
  poolQueryHandler = shellPoolHandler();
  accessGrants = {};
  const server = await startShellServer(fakeStore());
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/files?filename=dish.png`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'X-Usernode-App-Bridge': 'isolated-v2' }, body: PNG }
    );
    assert.equal(res.status, 404);
  } finally {
    accessGrants = { view: { id: 7 } };
    server.close();
  }
});

test('shell upload surfaces quota codes', async () => {
  const appFiles = require('../src/services/app-files');
  poolQueryHandler = shellPoolHandler({ userBytes: appFiles.PER_USER_PER_APP_CAP });
  const server = await startShellServer(fakeStore());
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/files?filename=dish.png`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'X-Usernode-App-Bridge': 'isolated-v2' }, body: PNG }
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'user_quota_exceeded');
  } finally {
    server.close();
  }
});

test('shell upload accepts a 6 MB MP3 through the raw parser as audio/mpeg', async () => {
  const handler = shellPoolHandler();
  poolQueryHandler = handler;
  accessGrants = { view: { id: 7 } };
  // 6 MB is over the image cap but under the audio cap, so this also
  // pins that the route body limit was raised above the old 6mb.
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(6 * 1024 * 1024, 0)]);
  const server = await startShellServer(fakeStore());
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/files?filename=narration.mp3`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'X-Usernode-App-Bridge': 'isolated-v2' }, body: mp3 }
    );
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.contentType, 'audio/mpeg');
    assert.equal(handler.inserts.length, 1);
    assert.equal(handler.inserts[0][5], 'audio/mpeg');
  } finally {
    server.close();
  }
});

test('serves a PDF row and a text row as attachments with nosniff', async () => {
  const server = await startServeServer(fakeStore());
  try {
    const base = `http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`;
    poolQueryHandler = async () => ({
      rows: [{ app_id: 7, filename: 'menu.pdf', content_type: 'application/pdf', visibility: 'public' }],
    });
    const pdf = await fetch(base);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(pdf.headers.get('x-content-type-options'), 'nosniff');
    assert.match(pdf.headers.get('content-disposition'), /^attachment; filename="menu.pdf"/);

    poolQueryHandler = async () => ({
      rows: [{ app_id: 7, filename: 'rows.csv', content_type: 'text/csv; charset=utf-8', visibility: 'public' }],
    });
    const csv = await fetch(base);
    assert.equal(csv.status, 200);
    assert.equal(csv.headers.get('x-content-type-options'), 'nosniff');
    assert.match(csv.headers.get('content-disposition'), /^attachment; filename="rows.csv"/);
  } finally {
    server.close();
  }
});

test('serves video and audio rows inline, and an unknown type as an attachment', async () => {
  const server = await startServeServer(fakeStore());
  try {
    const base = `http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`;
    for (const [filename, contentType] of [
      ['clip.mp4', 'video/mp4'],
      ['clip.webm', 'video/webm'],
      ['narration.ogg', 'audio/ogg'],
    ]) {
      poolQueryHandler = async () => ({
        rows: [{ app_id: 7, filename, content_type: contentType, visibility: 'public' }],
      });
      const res = await fetch(base);
      assert.equal(res.status, 200, contentType);
      assert.match(res.headers.get('content-disposition'), /^inline; /, contentType);
    }
    poolQueryHandler = async () => ({
      rows: [{ app_id: 7, filename: 'blob.bin', content_type: null, visibility: 'public' }],
    });
    const res = await fetch(base);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition'), /^attachment; /);
  } finally {
    server.close();
  }
});

test('serves an audio/ogg row with that Content-Type and nosniff', async () => {
  poolQueryHandler = async () => ({
    rows: [{ app_id: 7, filename: 'narration.ogg', content_type: 'audio/ogg', visibility: 'public' }],
  });
  const server = await startServeServer(fakeStore());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/ogg');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    server.close();
  }
});

test('shell upload stores a PDF through the raw parser as application/pdf', async () => {
  const handler = shellPoolHandler();
  poolQueryHandler = handler;
  accessGrants = { view: { id: 7 } };
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n'),
    Buffer.alloc(6 * 1024 * 1024, 0),
  ]);
  const server = await startShellServer(fakeStore());
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/files?filename=menu.pdf`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'X-Usernode-App-Bridge': 'isolated-v2' }, body: pdf }
    );
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.contentType, 'application/pdf');
    assert.equal(handler.inserts.length, 1);
    assert.equal(handler.inserts[0][5], 'application/pdf');
  } finally {
    server.close();
  }
});

test('shell upload with MinIO down → 503 storage_unavailable', async () => {
  poolQueryHandler = shellPoolHandler();
  const server = await startShellServer(fakeStore({
    async putFile() { throw new Error('connect ECONNREFUSED'); },
  }));
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/api/apps/demo/files?filename=dish.png`,
      { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'X-Usernode-App-Bridge': 'isolated-v2' }, body: PNG }
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'storage_unavailable');
  } finally {
    server.close();
  }
});

test('shell delete is uploader-only (stored row belongs to user 5)', async () => {
  poolQueryHandler = shellPoolHandler();
  const otherUser = await startShellServer(fakeStore(), 9);
  try {
    const res = await fetch(
      `http://127.0.0.1:${otherUser.address().port}/api/apps/demo/files/${GOOD_ID}`,
      { method: 'DELETE', headers: { 'X-Usernode-App-Bridge': 'isolated-v2' } }
    );
    assert.equal(res.status, 404);
  } finally {
    otherUser.close();
  }
  const owner = await startShellServer(fakeStore(), 5);
  try {
    const res = await fetch(
      `http://127.0.0.1:${owner.address().port}/api/apps/demo/files/${GOOD_ID}`,
      { method: 'DELETE', headers: { 'X-Usernode-App-Bridge': 'isolated-v2' } }
    );
    assert.equal(res.status, 200);
  } finally {
    owner.close();
  }
});

test('shell usage reports sums and the new caps', async () => {
  const appFiles = require('../src/services/app-files');
  poolQueryHandler = shellPoolHandler({ appBytes: 1234, userBytes: 234 });
  const server = await startShellServer(fakeStore());
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/apps/demo/files/usage`, { headers: { 'X-Usernode-App-Bridge': 'isolated-v2' } });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.appBytes, 1234);
    assert.equal(j.userBytes, 234);
    assert.equal(j.appCapBytes, 10 * 1024 * 1024 * 1024);
    assert.equal(j.userCapBytes, 1024 * 1024 * 1024);
    assert.equal(j.appCapBytes, appFiles.PER_APP_CAP);
    assert.equal(j.userCapBytes, appFiles.PER_USER_PER_APP_CAP);
  } finally {
    server.close();
  }
});


test('a preview identity can serve preview private files but never production private files', async () => {
  let staging = false;
  poolQueryHandler = async () => ({ rows: [{
    app_id: 7, filename: 'fixture.png', content_type: 'image/png', visibility: 'private', staging,
  }] });
  const server = await startServeServer(fakeStore());
  try {
    const user = { id: 5, username: 'fixture-user' };
    const preview = platformJwt.signAppIdentityToken({ appId: 7, user, environment: 'preview' });
    const production = platformJwt.signAppIdentityToken({ appId: 7, user, environment: 'production' });
    const base = `http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}?token=`;
    assert.equal((await fetch(base + preview)).status, 404);
    assert.equal((await fetch(base + production)).status, 200);
    staging = true;
    assert.equal((await fetch(base + preview)).status, 200);
    assert.equal((await fetch(base + production)).status, 200);
  } finally { server.close(); }
});

// ── Byte ranges ─────────────────────────────────────────────────────

test('a Range request gets 206 with only those bytes; an impossible one 416', async () => {
  const AUDIO = Buffer.concat([Buffer.from('ID3'), Buffer.from('0123456789abcdef')]);
  poolQueryHandler = async () => ({
    rows: [{
      id: GOOD_ID, app_id: 7, filename: 'chapter.mp3', content_type: 'audio/mpeg', visibility: 'public',
      size_bytes: AUDIO.length, sha256: 'e'.repeat(64),
    }],
  });
  const asked = [];
  const server = await startServeServer(fakeStore({
    async getFileStream(_appId, _id, range) {
      asked.push(range);
      return Readable.from([range ? AUDIO.subarray(range.start, range.end + 1) : AUDIO]);
    },
  }));
  const url = `http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`;
  try {
    const whole = await fetch(url);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.equal(whole.headers.get('content-length'), String(AUDIO.length));
    assert.equal(whole.headers.get('etag'), `"${'e'.repeat(64)}"`);
    assert.deepEqual(Buffer.from(await whole.arrayBuffer()), AUDIO);

    const part = await fetch(url, { headers: { range: 'bytes=3-6' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 3-6/${AUDIO.length}`);
    assert.equal(part.headers.get('content-length'), '4');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), Buffer.from('0123'));

    const tail = await fetch(url, { headers: { range: 'bytes=-2' } });
    assert.equal(tail.status, 206);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), Buffer.from('ef'));

    const beyond = await fetch(url, { headers: { range: `bytes=${AUDIO.length}-` } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers.get('content-range'), `bytes */${AUDIO.length}`);

    // The store was asked for the range itself, never the whole file to slice.
    assert.deepEqual(asked, [null, { start: 3, end: 6 }, { start: AUDIO.length - 2, end: AUDIO.length - 1 }]);
  } finally {
    server.close();
  }
});

test('a store error after the headers ends the response at once instead of leaving it waiting', async () => {
  poolQueryHandler = async () => ({
    rows: [{
      id: GOOD_ID, app_id: 7, filename: 'chapter.mp3', content_type: 'audio/mpeg', visibility: 'public',
      size_bytes: 1000, sha256: null,
    }],
  });
  const server = await startServeServer(fakeStore({
    async getFileStream() {
      // Ten of the promised 1000 bytes, then the object store fails.
      return new Readable({
        read() {
          if (this.sent) { this.destroy(new Error('connection reset by object store')); return; }
          this.sent = true;
          this.push(Buffer.alloc(10, 1));
        },
      });
    },
  }));
  try {
    const started = Date.now();
    // The connection is cut: before the headers arrive, or partway through
    // the body. Either way the client learns at once.
    await assert.rejects((async () => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`);
      await res.arrayBuffer();
    })());
    assert.ok(Date.now() - started < 3000, 'the body fails fast rather than waiting for the socket timeout');
  } finally {
    server.close();
  }
});

test('a client that goes away destroys the object-store stream', async () => {
  poolQueryHandler = async () => ({
    rows: [{
      id: GOOD_ID, app_id: 7, filename: 'chapter.mp3', content_type: 'audio/mpeg', visibility: 'public',
      size_bytes: 10 * 1024 * 1024, sha256: null,
    }],
  });
  let source;
  const destroyed = new Promise((resolve) => {
    source = new Readable({ read() { this.push(Buffer.alloc(64 * 1024, 2)); } });
    source.on('close', resolve);
  });
  const server = await startServeServer(fakeStore({ async getFileStream() { return source; } }));
  try {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/app-files/${GOOD_ID}`, { signal: controller.signal });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await Promise.race([
      destroyed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('source never destroyed')), 3000)),
    ]);
  } finally {
    server.close();
  }
});
