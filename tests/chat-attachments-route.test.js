// Route tests for group-chat file attachments (#694,
// src/routes/chat.js): the upload endpoint's classification + caps, and
// the serve/preview header matrix. Security contracts pinned here:
//
//  - upload is collab-gated (404 when getAppForUser denies);
//  - serving is view-gated; unlinked rows (message_id NULL) are only
//    readable by their uploader;
//  - the plain serve route NEVER sends text/html — markdown/html/text
//    all serve as text/plain + attachment disposition + nosniff, images
//    inline with their stored type, binary as octet-stream;
//  - the /view route serves ONLY kind 'html', as text/html under
//    `Content-Security-Policy: sandbox allow-scripts` (opaque origin —
//    no allow-same-origin, ever) with Referrer-Policy: no-referrer.
//
// Harness shape follows tests/app-icons-route.test.js (override getPool
// before requiring the route, mount on a real express app), plus a
// require.cache stub for app-access so both gates are controllable.
//
// Run with: node --test tests/chat-attachments-route.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
poolMod.getPool = () => ({
  query: (sql, params) => poolQueryHandler(sql, params),
});

// Controllable app-access gate: tests set `accessGrants` to decide what
// each level resolves to. Must be stubbed BEFORE requiring the route.
const appAccessId = require.resolve('../src/services/app-access');
let accessGrants = { view: { id: 7 }, collab: { id: 7 } };
let lastAccessLevel = null;
require.cache[appAccessId] = {
  id: appAccessId,
  filename: appAccessId,
  loaded: true,
  paths: [],
  exports: {
    ACCESS_COLUMNS: 'id, slug',
    getAppForUser: async (_pool, _slug, _user, level) => {
      lastAccessLevel = level;
      return accessGrants[level] || null;
    },
    checkAppAccess: async () => true,
  },
};

const { chatRoutes } = require('../src/routes/chat');
const express = require('express');

function startServer(userId = 5) {
  const app = express();
  app.use((req, _res, next) => { req.user = { id: userId, username: 'alice' }; next(); });
  app.use(chatRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

const ATT_ID = 'c'.repeat(32);

function urlFor(server, path) {
  return `http://127.0.0.1:${server.address().port}${path}`;
}

// ── Upload ──────────────────────────────────────────────────────────

test('upload classifies a markdown file, inserts it, and returns the id', async () => {
  accessGrants = { view: { id: 7 }, collab: { id: 7 } };
  const seen = [];
  poolQueryHandler = async (sql, params) => {
    seen.push({ sql, params });
    if (/SUM\(size_bytes\)/.test(sql)) return { rows: [{ total: '0' }] };
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/apps/demo/chat-attachments?filename=notes.md'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('# Hello\n', 'utf8'),
    });
    assert.equal(res.status, 200);
    assert.equal(lastAccessLevel, 'collab', 'upload is collab-gated');
    const body = await res.json();
    assert.match(body.id, /^[a-f0-9]{32}$/);
    assert.equal(body.kind, 'markdown');
    assert.equal(body.contentType, 'text/markdown');
    const ins = seen.find((q) => /INSERT INTO chat_message_attachments/.test(q.sql));
    assert.ok(ins, 'INSERT ran');
    assert.equal(ins.params[3], 'markdown', 'kind stored');
    assert.equal(ins.params[1], 7, 'scoped to the resolved app id');
  } finally {
    server.close();
  }
});

test('upload 404s for non-collaborators without touching the DB', async () => {
  accessGrants = { view: { id: 7 }, collab: null };
  let queried = false;
  poolQueryHandler = async () => { queried = true; return { rows: [] }; };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/apps/demo/chat-attachments?filename=notes.md'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('# Hello\n', 'utf8'),
    });
    assert.equal(res.status, 404);
    assert.equal(queried, false);
  } finally {
    server.close();
  }
});

test('upload rejects an invalid file with the classifier error', async () => {
  accessGrants = { view: { id: 7 }, collab: { id: 7 } };
  poolQueryHandler = async () => ({ rows: [{ total: '0' }] });
  const server = await startServer();
  try {
    // .png extension but not PNG bytes.
    const res = await fetch(urlFor(server, '/api/apps/demo/chat-attachments?filename=fake.png'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(64, 0x41),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /doesn't look like a valid/);
  } finally {
    server.close();
  }
});

test('upload rejects when the per-app storage cap is full', async () => {
  accessGrants = { view: { id: 7 }, collab: { id: 7 } };
  const att = require('../src/services/attachments');
  poolQueryHandler = async (sql) => {
    if (/SUM\(size_bytes\)/.test(sql)) return { rows: [{ total: String(att.MAX_APP_CHAT_BYTES) }] };
    return { rows: [] };
  };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, '/api/apps/demo/chat-attachments?filename=notes.md'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('# Hello\n', 'utf8'),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /storage is full/);
  } finally {
    server.close();
  }
});

// ── Plain serve route: header matrix ────────────────────────────────

function serveRow(row) {
  poolQueryHandler = async (sql) => {
    if (/FROM chat_message_attachments/.test(sql)) return { rows: [row] };
    return { rows: [] };
  };
}

test('html via the plain route serves as text/plain + attachment (never text/html)', async () => {
  accessGrants = { view: { id: 7 }, collab: { id: 7 } };
  serveRow({
    kind: 'html', filename: 'page.html', content_type: 'text/html',
    data: Buffer.from('<script>alert(1)</script>'), message_id: 9, user_id: 5,
  });
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, `/api/apps/demo/chat-attachments/${ATT_ID}`));
    assert.equal(res.status, 200);
    assert.equal(lastAccessLevel, 'view', 'serving is view-gated');
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.match(res.headers.get('content-disposition'), /^attachment/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  } finally {
    server.close();
  }
});

test('markdown via the plain route serves as text/plain + attachment', async () => {
  accessGrants = { view: { id: 7 }, collab: { id: 7 } };
  serveRow({
    kind: 'markdown', filename: 'notes.md', content_type: 'text/markdown',
    data: Buffer.from('# hi'), message_id: 9, user_id: 5,
  });
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, `/api/apps/demo/chat-attachments/${ATT_ID}`));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.match(res.headers.get('content-disposition'), /^attachment/);
  } finally {
    server.close();
  }
});

test('images serve inline with their stored type; binary as octet-stream attachment', async () => {
  accessGrants = { view: { id: 7 }, collab: { id: 7 } };
  const server = await startServer();
  try {
    serveRow({
      kind: 'image', filename: 'Screenshot 2026-09-14 at 8.17.22\u202fAM.png', content_type: 'image/png',
      data: Buffer.from([0x89, 0x50]), message_id: 9, user_id: 5,
    });
    let res = await fetch(urlFor(server, `/api/apps/demo/chat-attachments/${ATT_ID}`));
    assert.equal(res.status, 200, 'Unicode screenshot names must not make Node reject the header');
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('content-disposition'), /^inline/);
    assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''Screenshot%202026-09-14%20at%208\.17\.22%E2%80%AFAM\.png/);

    serveRow({
      kind: 'binary', filename: 'blob.bin', content_type: 'application/octet-stream',
      data: Buffer.alloc(4), message_id: 9, user_id: 5,
    });
    res = await fetch(urlFor(server, `/api/apps/demo/chat-attachments/${ATT_ID}`));
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition'), /^attachment/);
  } finally {
    server.close();
  }
});

test('unlinked rows are only readable by their uploader', async () => {
  accessGrants = { view: { id: 7 }, collab: { id: 7 } };
  serveRow({
    kind: 'text', filename: 'a.txt', content_type: 'text/plain',
    data: Buffer.from('x'), message_id: null, user_id: 5,
  });
  const asUploader = await startServer(5);
  const asOther = await startServer(6);
  try {
    const mine = await fetch(urlFor(asUploader, `/api/apps/demo/chat-attachments/${ATT_ID}`));
    assert.equal(mine.status, 200);
    const theirs = await fetch(urlFor(asOther, `/api/apps/demo/chat-attachments/${ATT_ID}`));
    assert.equal(theirs.status, 404);
  } finally {
    asUploader.close();
    asOther.close();
  }
});

test('non-viewers and malformed ids 404', async () => {
  accessGrants = { view: null, collab: null };
  let queried = false;
  poolQueryHandler = async () => { queried = true; return { rows: [] }; };
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, `/api/apps/demo/chat-attachments/${ATT_ID}`));
    assert.equal(res.status, 404);
    assert.equal(queried, false, 'gate denies before any attachment query');
    for (const bad of ['short', 'Z'.repeat(32)]) {
      const r = await fetch(urlFor(server, `/api/apps/demo/chat-attachments/${bad}`));
      assert.equal(r.status, 404, `expected 404 for ${bad}`);
    }
  } finally {
    server.close();
  }
});

// ── Sandboxed /view route ───────────────────────────────────────────

test('/view serves html with CSP sandbox allow-scripts and no-referrer', async () => {
  accessGrants = { view: { id: 7 }, collab: { id: 7 } };
  serveRow({
    kind: 'html', filename: 'page.html',
    data: Buffer.from('<!doctype html><p>hi</p>'), message_id: 9, user_id: 5,
  });
  const server = await startServer();
  try {
    const res = await fetch(urlFor(server, `/api/apps/demo/chat-attachments/${ATT_ID}/view`));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/html/);
    assert.equal(res.headers.get('content-security-policy'), 'sandbox allow-scripts');
    assert.ok(!/allow-same-origin/.test(res.headers.get('content-security-policy')), 'never allow-same-origin');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition'), /^inline/);
  } finally {
    server.close();
  }
});

test('/view 404s for any non-html kind', async () => {
  accessGrants = { view: { id: 7 }, collab: { id: 7 } };
  for (const kind of ['image', 'markdown', 'text', 'binary']) {
    serveRow({ kind, filename: 'f', data: Buffer.from('x'), message_id: 9, user_id: 5 });
    const server = await startServer();
    try {
      const res = await fetch(urlFor(server, `/api/apps/demo/chat-attachments/${ATT_ID}/view`));
      assert.equal(res.status, 404, `expected 404 for kind=${kind}`);
    } finally {
      server.close();
    }
  }
});
