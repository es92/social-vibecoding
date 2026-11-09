'use strict';

// Connector uploads: a coding agent sends a plan, a video or a screenshot
// with a one-time curl command instead of writing the file out inside a tool
// call (services/connector-uploads.js).
//
// What these pin, in the order an upload lives:
//
//   1. The credential: 256 random bits behind `svcu_`, stored as a SHA-256
//      hash only, minted for one upload of one kind for one user, and
//      printed in prepare_upload's `command` and nowhere else.
//   2. The route (src/routes/connector-uploads.js): the address bucket before
//      any lookup, the token before any body byte, the body read against its
//      kind's limit and checked for what its kind says it is. A command
//      stores ONE file: a second upload with it is refused, so a token that
//      leaked cannot swap what its owner is about to file.
//   3. post_spec with specUploadId posts the uploaded plan exactly as an
//      inline spec, and create_request with videoUploadId and
//      screenshotUploadIds files them through the same route as the
//      feedback dialog's, then the uploads are used up.
//   4. The token never reaches a log line, and the redactor masks its shape.
//
// Run with: node --test tests/connector-uploads.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { z } = require('zod');

const uploads = require('../src/services/connector-uploads');
const { connectorUploadRoutes, checkFile } = require('../src/routes/connector-uploads');
const tools = require('../src/services/mcp-tools');
const logger = require('../src/services/logger');
const { redactString } = require('../src/services/log-redaction');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');
const feedback = require('../src/routes/feedback');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const SCHEMA_SRC = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '../src/routes/connector-uploads.js'), 'utf8');
const SERVICE_SRC = fs.readFileSync(path.join(__dirname, '../src/services/connector-uploads.js'), 'utf8');

const ORIGIN = 'https://app.onhomeroom.com';
const PLAN = '<article data-spec><h1>Threads</h1><p>Every discussion becomes one thread.</p>'
  + '<section data-spec-tab="user"><p>What people see.</p></section>'
  + '<section data-spec-tab="tech"><p>How.</p></section></article>';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A tiny MP4: the `ftyp` box is all the sniffer reads.
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

// A pool that answers by SQL substring, recording every call.
function fakePool(handlers, queries = []) {
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql, params });
      for (const [needle, rows] of handlers) {
        if (sql.includes(needle)) return { rows: typeof rows === 'function' ? rows(params) : rows };
      }
      throw new Error(`unstubbed query: ${sql.slice(0, 80)}`);
    },
  };
}

// ── 1. The credential ──────────────────────────────────────────────────

test('a token is 256 random bits behind svcu_, and only its hash is ever stored', () => {
  const a = uploads.makeToken();
  const b = uploads.makeToken();
  assert.match(a, /^svcu_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(uploads.isCanonicalToken(a), true);
  assert.equal(uploads.isCanonicalToken(`svpu_${a.slice(5)}`), false, 'the patch upload\'s token is not one of these');
  assert.equal(uploads.hashToken(a), sha(Buffer.from(a)));
  assert.equal(uploads.tokenFromHeader(`Bearer ${a}`), a);
  assert.equal(uploads.tokenFromHeader(a), null, 'only the Bearer form');
  assert.equal(uploads.tokenFromHeader(`Bearer ${a}x`), null);
  assert.match(SCHEMA_SRC, /CREATE TABLE IF NOT EXISTS connector_uploads \(/);
  assert.match(SCHEMA_SRC, /token_hash\s+TEXT NOT NULL UNIQUE CHECK \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(SCHEMA_SRC, /COMMENT ON TABLE connector_uploads IS 'staging:private';/);
});

test('minting binds one upload of one kind to its owner, stores the hash, and drops the oldest unused past the cap', async () => {
  const queries = [];
  const pool = fakePool([
    ['DELETE FROM connector_uploads\n        WHERE expires_at', []],
    ['INSERT INTO connector_uploads', [{ id: 41, expires_at: '2026-10-30T10:00:00Z' }]],
    ['DELETE FROM connector_uploads\n      WHERE user_id', []],
  ], queries);
  const out = await uploads.mintUpload(pool, { userId: 7, kind: 'video', origin: `${ORIGIN}/mcp` });
  assert.equal(out.ok, true);
  assert.equal(out.uploadId, 41);
  assert.equal(out.url, `${ORIGIN}/api/connector-uploads/41`);
  assert.equal(out.maxBytes, feedback.MAX_VIDEO_BYTES);
  const insert = queries.find((q) => q.sql.includes('INSERT INTO connector_uploads'));
  assert.deepEqual(insert.params, [7, 'video', uploads.hashToken(out.token), uploads.TOKEN_TTL_HOURS]);
  assert.ok(!JSON.stringify(insert.params).includes(out.token), 'the token itself is never stored');
  const cap = queries.find((q) => q.sql.includes('WHERE user_id = $1 AND stored_at IS NULL'));
  assert.deepEqual(cap.params, [7, uploads.MAX_OPEN_PER_USER]);

  assert.equal((await uploads.mintUpload(pool, { userId: 7, kind: 'zip', origin: ORIGIN })).code, 'invalid_request');
  assert.equal((await uploads.mintUpload(pool, { userId: 7, kind: 'plan', origin: 'not a url' })).ok, false);
  assert.equal((await uploads.mintUpload(pool, { userId: null, kind: 'plan', origin: ORIGIN })).ok, false);
});

test('each kind is held to the limit of the field it feeds', () => {
  assert.equal(uploads.maxBytesFor('plan'), require('../src/services/request-specs').MAX_SPEC_HTML_CHARS * 4);
  assert.equal(uploads.maxBytesFor('video'), 50 * 1024 * 1024);
  assert.equal(uploads.maxBytesFor('screenshot'), feedback.MAX_SCREENSHOT_BYTES);
  assert.equal(uploads.maxBytesFor('design'), require('../src/services/attachments').MAX_HTML_BYTES);
  assert.equal(uploads.maxBytesFor('zip'), 0);
  assert.deepEqual([...uploads.KINDS], ['plan', 'video', 'screenshot', 'design']);
});

// ── 2. The route ───────────────────────────────────────────────────────

const TOKEN = uploads.makeToken();
const OTHER = uploads.makeToken();

// Upload 51 (a plan), 52 (a video) and 53 (a screenshot) hold TOKEN; 54
// holds OTHER. `state` can expire them; a stored file marks its row used.
function routePool(state, queries) {
  return fakePool([
    ['token_hash, stored_at', (params) => {
      const id = Number(params[0]);
      const kinds = { 51: 'plan', 52: 'video', 53: 'screenshot', 54: 'plan' };
      if (!kinds[id]) return [];
      return [{
        id, user_id: 7, kind: kinds[id], token_hash: uploads.hashToken(id === 54 ? OTHER : TOKEN),
        stored_at: state.stored.has(id) ? new Date() : null, live: !state.expired,
      }];
    }],
    ['INSERT INTO issue_videos', () => []],
    ['INSERT INTO issue_screenshots', () => []],
    ['UPDATE connector_uploads', (params) => {
      const id = Number(params[0]);
      if (state.stored.has(id) || state.raced) return [];
      state.stored.add(id);
      return [{ id }];
    }],
    ['DELETE FROM issue_', () => []],
  ], queries);
}

async function withRoute(fn, { limiter } = {}) {
  const state = { expired: false, raced: false, stored: new Set() };
  const queries = [];
  const limits = [];
  const app = express();
  app.use(connectorUploadRoutes({}, {
    pool: routePool(state, queries),
    limiter: async (opts) => {
      limits.push(opts);
      return limiter ? limiter(opts) : { allowed: true, retryAfter: 0 };
    },
  }));
  app.use(express.json());
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (id, body, headers = {}) => fetch(`${base}/api/connector-uploads/${id}`, { method: 'PUT', headers, body });
  try {
    await fn({ put, base, state, queries, limits });
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close();
  }
}

const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });

test('a plan is stored byte for byte, once, and the answer says what to call next', async () => {
  await withRoute(async ({ put, base, queries, limits }) => {
    const body = Buffer.from(PLAN);
    // curl's --data-binary sends a form type; the route reads any.
    const res = await put(51, body, { ...auth(), 'content-type': 'application/x-www-form-urlencoded' });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const json = await res.json();
    assert.deepEqual(
      { ok: json.ok, uploadId: json.uploadId, kind: json.kind, bytes: json.bytes, sha256: json.sha256 },
      { ok: true, uploadId: 51, kind: 'plan', bytes: body.length, sha256: sha(body) }
    );
    assert.match(json.nextStep, /post_spec with specUploadId 51/);
    const update = queries.find((q) => q.sql.includes('UPDATE connector_uploads'));
    assert.ok(update.params[1].equals(body));
    assert.equal(update.params[4], 'text/html');
    assert.match(update.sql, /stored_at IS NULL AND expires_at > NOW\(\)/, 'claimed only while unused and live');
    assert.deepEqual(limits.map((l) => l.namespace), ['connector-upload-ip', 'connector-upload-user']);
    assert.equal(limits[1].subject, '7');

    // The command is spent: the same token stores nothing else, POST or PUT.
    const again = await fetch(`${base}/api/connector-uploads/51`, { method: 'POST', headers: auth(), body: PLAN });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).error, 'upload_used');
  });
});

test('a video and a screenshot go where the feedback dialog\'s go, unlinked, and the row names them', async () => {
  await withRoute(async ({ put, queries }) => {
    const v = await put(52, MP4, auth());
    assert.equal(v.status, 201);
    assert.match((await v.json()).nextStep, /create_request with videoUploadId 52/);
    const vIns = queries.find((q) => q.sql.includes('INSERT INTO issue_videos'));
    assert.match(vIns.params[0], /^[0-9a-f]{32}$/);
    assert.deepEqual(vIns.params.slice(1, 4), [7, 'video/mp4', MP4.length]);
    assert.ok(vIns.params[4].equals(MP4));
    const vUpd = queries.find((q) => q.sql.includes('UPDATE connector_uploads') && q.params[0] === 52);
    assert.equal(vUpd.params[1], vIns.params[0], 'the row names the stored clip');

    const s = await put(53, PNG, auth());
    assert.equal(s.status, 201);
    const sJson = await s.json();
    assert.match(sJson.nextStep, /53 in screenshotUploadIds, or show it in a plan's text/);
    const sIns = queries.find((q) => q.sql.includes('INSERT INTO issue_screenshots'));
    assert.equal(sJson.path, `/issue-images/${sIns.params[0]}`, 'the path a plan\'s text shows it at');
    assert.deepEqual(sIns.params.slice(1, 3), [7, 'image/png']);
  });
});

test('two uploads racing on one command store one file, and the loser\'s copy is removed', async () => {
  await withRoute(async ({ put, state, queries }) => {
    state.raced = true;
    const res = await put(52, MP4, auth());
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error, 'upload_used');
    const ins = queries.find((q) => q.sql.includes('INSERT INTO issue_videos'));
    const del = queries.find((q) => q.sql.includes('DELETE FROM issue_videos'));
    assert.equal(del.params[0], ins.params[0]);
    assert.match(del.sql, /issue_number IS NULL/);
  });
});

test('a missing, wrong, other upload\'s or expired token is refused, and no byte is read or stored', async () => {
  await withRoute(async ({ put, state, queries }) => {
    for (const [headers, id] of [[{}, 51], [auth(OTHER), 51], [auth(TOKEN), 54], [auth(TOKEN), 99], [{ authorization: TOKEN }, 51]]) {
      const res = await put(id, PLAN, headers);
      assert.equal(res.status, 401);
      assert.equal((await res.json()).error, 'invalid_upload_token');
    }
    state.expired = true;
    const late = await put(51, PLAN, auth());
    assert.equal(late.status, 401);
    assert.equal((await late.json()).error, 'upload_token_expired');
    assert.ok(!queries.some((q) => /UPDATE connector_uploads|INSERT INTO issue_/.test(q.sql)), 'nothing stored');
  });
});

test('a file that is not what its kind says, empty or over its limit is refused and the command stays usable', async () => {
  await withRoute(async ({ put, queries }) => {
    const cases = [
      [51, Buffer.from([0xff, 0xfe, 0x00]), 400, 'invalid_plan'],
      [51, Buffer.from('   \n'), 400, 'invalid_request'],
      [52, PNG, 400, 'invalid_video'],
      [53, MP4, 400, 'invalid_screenshot'],
      [53, Buffer.alloc(feedback.MAX_SCREENSHOT_BYTES + 10, 1), 413, 'upload_too_large'],
    ];
    for (const [id, body, status, code] of cases) {
      const res = await put(id, body, auth());
      assert.equal(res.status, status, code);
      assert.equal((await res.json()).error, code);
    }
    const empty = await put(51, Buffer.alloc(0), auth());
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error, 'upload_empty');
    assert.ok(!queries.some((q) => /UPDATE connector_uploads|INSERT INTO issue_/.test(q.sql)), 'nothing stored');
    // And the command still works afterwards.
    assert.equal((await put(51, PLAN, auth())).status, 201);
  });
});

test('checkFile holds a plan to post_spec\'s own rules', () => {
  const tooLong = `<article data-spec><h1>T</h1><p>${'x'.repeat(require('../src/services/request-specs').MAX_SPEC_HTML_CHARS)}</p></article>`;
  const out = checkFile('plan', Buffer.from(tooLong));
  assert.equal(out.ok, false);
  assert.equal(out.code, 'spec_too_long');
  assert.ok(out.limitChars > 0);
  assert.equal(checkFile('plan', Buffer.from('# Plan\n\nWords.')).contentType, 'text/markdown');
});

test('#6534: a design upload is one HTML file, under the chat composer\'s own limit', () => {
  const ok = checkFile('design', Buffer.from('<!doctype html><html><body><p>Before and after</p></body></html>'));
  assert.equal(ok.ok, true);
  assert.equal(ok.contentType, 'text/html');
  const png = checkFile('design', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(40, 1)]));
  assert.equal(png.ok, false);
  assert.equal(png.code, 'invalid_design');
  const over = checkFile('design', Buffer.alloc(require('../src/services/attachments').MAX_HTML_BYTES + 10, 0x61));
  assert.equal(over.ok, false);
  assert.equal(over.code, 'upload_too_large');
});

test('the route is rate-limited, closed on a staging preview, and mounted before the parsers and auth', async () => {
  await withRoute(async ({ put, queries }) => {
    const res = await put(51, PLAN, auth());
    assert.equal(res.status, 429);
    assert.equal(queries.length, 0, 'refused before the token was looked up');
  }, { limiter: () => ({ allowed: false, retryAfter: 30 }) });
  await withRoute(async ({ put, queries }) => {
    assert.equal((await put(51, PLAN, auth())).status, 503);
    assert.equal(queries.length, 0);
  }, { limiter: () => { throw new Error('db down'); } });
  assert.match(ROUTE_SRC, /consumeSharedTokenBucket/);

  const prior = process.env.USERNODE_ENV;
  process.env.USERNODE_ENV = 'staging';
  try {
    await withRoute(async ({ put }) => { assert.equal((await put(51, PLAN, auth())).status, 404); });
  } finally {
    if (prior === undefined) delete process.env.USERNODE_ENV; else process.env.USERNODE_ENV = prior;
  }

  const mount = SERVER_SRC.indexOf('connectorUploadRoutes(config)');
  assert.ok(mount > 0, 'mounted');
  assert.ok(mount < SERVER_SRC.indexOf('express.json()(req, res, next)'), 'before the global JSON parser');
  assert.ok(mount < SERVER_SRC.indexOf('app.use(authMiddleware(config))'), 'before authMiddleware');
  assert.ok(mount < SERVER_SRC.indexOf('app.use(cliApiBearerAuth(config))'), 'before the CLI bearer');
});

// ── 3. The connector ───────────────────────────────────────────────────

// Uploads 61 (plan), 62 (video), 63 and 64 (screenshots) belong to user 7
// and have been sent; 65 is a plan whose command was never run.
function connectorPool(queries) {
  const rows = {
    61: { kind: 'plan', stored: true, data: Buffer.from(PLAN) },
    62: { kind: 'video', stored: true, media_id: 'f6'.repeat(16) },
    63: { kind: 'screenshot', stored: true, media_id: 'a1'.repeat(16) },
    64: { kind: 'screenshot', stored: true, media_id: 'b2'.repeat(16) },
    65: { kind: 'plan', stored: false },
  };
  return fakePool([
    ['data, media_id', (params) => {
      const row = rows[Number(params[0])];
      if (!row || Number(params[1]) !== 7) return [];
      return [{
        id: Number(params[0]), kind: row.kind, stored_at: row.stored ? new Date() : null, live: true,
        data: row.data || null, media_id: row.media_id || null, bytes: 10, sha256: 'x',
      }];
    }],
    ['DELETE FROM connector_uploads WHERE id = ANY', []],
    ['DELETE FROM connector_uploads\n        WHERE expires_at', []],
    ['INSERT INTO connector_uploads', [{ id: 77, expires_at: '2026-10-30T10:00:00Z' }]],
    ['DELETE FROM connector_uploads\n      WHERE user_id', []],
  ], queries);
}

function connector({ delegation = null } = {}) {
  const handlers = new Map();
  const specs = new Map();
  const calls = [];
  const queries = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const pathname = String(url).replace('http://platform.internal', '');
    calls.push({ method: init.method || 'GET', pathname, body: init.body ? JSON.parse(init.body) : null });
    let body = { issue: { id: 5, github_issue_number: 88, title: 'Discussions become threads' } };
    if (pathname.endsWith('/spec')) body = { sessionId: 9, version: 1, format: 'html', htmlChars: PLAN.length, createdRecord: true };
    return { ok: true, status: 201, text: async () => JSON.stringify(body) };
  };
  tools.registerTools({
    registerTool(name, spec, handler) { handlers.set(name, handler); specs.set(name, spec); },
  }, {
    accessToken: 'svmcp_test',
    scopes: [READ_SCOPE, WRITE_SCOPE],
    user: { id: 7, username: 'ada' },
    clientName: 'Claude', clientId: 'c1',
    origin: ORIGIN, baseUrl: 'http://platform.internal',
    pool: connectorPool(queries), config: {}, tokenId: null, grantId: null, delegation,
  });
  return { handlers, specs, calls, queries, restore: () => { globalThis.fetch = realFetch; } };
}

test('prepare_upload prints a command for one file, with the token in the command and nowhere else', async () => {
  const c = connector();
  try {
    const out = await c.handlers.get('prepare_upload')({ kind: 'video', file: "/Users/ada/Evan's walkthrough.mp4" });
    assert.equal(out.isError, undefined, JSON.stringify(out.structuredContent));
    const s = out.structuredContent;
    assert.equal(s.uploadId, 77);
    assert.equal(s.kind, 'video');
    assert.equal(s.maxBytes, 50 * 1024 * 1024);
    const token = /Bearer (svcu_[A-Za-z0-9_-]{43})/.exec(s.command)[1];
    assert.equal(s.command,
      `curl -sS --max-time 600 -X PUT -H 'Authorization: Bearer ${token}' `
      + `--data-binary @'/Users/ada/Evan'\\''s walkthrough.mp4' ${ORIGIN}/api/connector-uploads/77`,
      'a path with a quote in it survives the shell');
    const others = { ...s };
    delete others.command;
    assert.ok(!JSON.stringify(others).includes(token), 'no other field carries the token');
    assert.match(s.nextStep, /pass 77 as create_request's videoUploadId/);
    assert.equal(z.object(c.specs.get('prepare_upload').outputSchema).safeParse(s).success, true);

    const plain = await c.handlers.get('prepare_upload')({ kind: 'plan' });
    assert.match(plain.structuredContent.command, /--max-time 120 .*--data-binary @'FILE' /);
    assert.match(plain.structuredContent.nextStep, /FILE replaced by the file's path/);
    const bad = await c.handlers.get('prepare_upload')({ kind: 'plan', file: 'a\nb' });
    assert.equal(bad.structuredContent.code, 'invalid_request');
  } finally { c.restore(); }
});

test('post_spec posts an uploaded plan exactly as an inline one, then uses the upload up', async () => {
  const c = connector();
  try {
    const out = await c.handlers.get('post_spec')({ slug: 'usernode-2d5619', requestNumber: 6100, specUploadId: 61 });
    assert.equal(out.isError, undefined, JSON.stringify(out.structuredContent));
    assert.deepEqual(c.calls, [{ method: 'POST', pathname: '/api/apps/usernode-2d5619/issues/6100/spec', body: { spec: PLAN } }]);
    const used = c.queries.find((q) => q.sql.includes('DELETE FROM connector_uploads WHERE id = ANY'));
    assert.deepEqual(used.params, [[61], 7]);

    // Not both, not one that was never sent, not one of another kind.
    const both = await c.handlers.get('post_spec')({ slug: 'a', requestNumber: 1, spec: PLAN, specUploadId: 61 });
    assert.match(both.structuredContent.message, /not both/);
    const unsent = await c.handlers.get('post_spec')({ slug: 'a', requestNumber: 1, specUploadId: 65 });
    assert.equal(unsent.structuredContent.code, 'upload_not_sent');
    const wrong = await c.handlers.get('post_spec')({ slug: 'a', requestNumber: 1, specUploadId: 62 });
    assert.equal(wrong.structuredContent.code, 'upload_wrong_kind');
    const missing = await c.handlers.get('post_spec')({ slug: 'a', requestNumber: 1, specUploadId: 99 });
    assert.equal(missing.structuredContent.code, 'upload_not_found');
    assert.equal(c.calls.length, 1, 'none of the refusals posted anything');
  } finally { c.restore(); }
});

test('create_request files uploaded screenshots and a video through the request route, then uses them up', async () => {
  const c = connector();
  try {
    const out = await c.handlers.get('create_request')({
      slug: 'usernode-2d5619', title: 'Discussions become threads', description: 'The walkthrough.',
      screenshotUploadIds: [63, 64], videoUploadId: 62,
    });
    assert.equal(out.isError, undefined, JSON.stringify(out.structuredContent));
    assert.deepEqual(c.calls, [{
      method: 'POST', pathname: '/api/apps/usernode-2d5619/issues',
      body: {
        title: 'Discussions become threads', description: 'The walkthrough.', kind: 'general',
        screenshotIds: ['a1'.repeat(16), 'b2'.repeat(16)], videoId: 'f6'.repeat(16),
      },
    }]);
    const s = out.structuredContent;
    assert.deepEqual(s.images, [`${ORIGIN}/issue-images/${'a1'.repeat(16)}`, `${ORIGIN}/issue-images/${'b2'.repeat(16)}`]);
    assert.equal(s.video, `${ORIGIN}/issue-videos/${'f6'.repeat(16)}`);
    assert.equal(z.object(c.specs.get('create_request').outputSchema).safeParse(s).success, true);
    const used = c.queries.find((q) => q.sql.includes('DELETE FROM connector_uploads WHERE id = ANY'));
    assert.deepEqual(used.params, [[63, 64, 62], 7]);
  } finally { c.restore(); }
});

test('a wrong upload files nothing, and screenshots count together against the limit', async () => {
  const c = connector();
  try {
    const wrong = await c.handlers.get('create_request')({ slug: 'a', title: 'T', videoUploadId: 63 });
    assert.equal(wrong.structuredContent.code, 'upload_wrong_kind');
    const many = await c.handlers.get('create_request')({ slug: 'a', title: 'T', screenshotUploadIds: [63, 64, 63, 64] });
    assert.equal(many.structuredContent.code, 'invalid_images');
    assert.match(many.structuredContent.message, /at most 3 screenshots; 4 were sent/);
    assert.equal(c.calls.length, 0);
    const plain = await c.handlers.get('create_request')({ slug: 'a', title: 'Dark mode' });
    assert.equal(plain.structuredContent.video, null);
    assert.deepEqual(c.calls[0].body, { title: 'Dark mode', description: null, kind: 'general' }, 'no new keys at all');
  } finally { c.restore(); }
});

test('only an external client is offered uploads; the Mayor is not, and is refused if it tries', async () => {
  const mayor = connector({ delegation: { kind: 'agent_mayor' } });
  const external = connector();
  try {
    assert.ok(external.specs.get('prepare_upload'));
    assert.ok(external.specs.get('post_spec').inputSchema.specUploadId);
    assert.ok(external.specs.get('create_request').inputSchema.videoUploadId);
    assert.match(external.specs.get('create_request').description, /prepare_upload/);
    assert.equal(mayor.specs.get('prepare_upload'), undefined);
    const own = mayor.specs.get('create_request');
    assert.equal(own.inputSchema.videoUploadId, undefined);
    const out = await mayor.handlers.get('create_request')({ slug: 'a', title: 'T', videoUploadId: 62 });
    assert.equal(out.isError, true);
    assert.equal(mayor.calls.length, 0);
  } finally { external.restore(); mayor.restore(); }
  assert.ok(tools.ACTING_TOOLS.includes('prepare_upload'));
});

// ── 4. Secrets ─────────────────────────────────────────────────────────

test('the token never reaches a log call, the redactor masks it, and the console and prod debug hide the table', async () => {
  const seen = [];
  const orig = { info: logger.info, warn: logger.warn, error: logger.error };
  for (const level of Object.keys(orig)) logger[level] = (...args) => { seen.push(JSON.stringify(args)); };
  try {
    await withRoute(async ({ put }) => {
      await put(51, PLAN, auth());
      await put(51, PLAN, auth(OTHER));
    });
  } finally {
    Object.assign(logger, orig);
  }
  assert.ok(seen.length > 0);
  for (const line of seen) assert.ok(!line.includes(TOKEN) && !line.includes(OTHER), 'no token in a log line');
  assert.equal(redactString(`curl -H 'Authorization: Bearer ${TOKEN}'`).includes(TOKEN), false);
  // The service hands the token back to its caller and to nothing else.
  assert.doesNotMatch(SERVICE_SRC, /log\.[a-z]+\([^;]*\btoken\b[,}]/);

  const debug = fs.readFileSync(path.join(__dirname, '../src/services/debug-access.js'), 'utf8');
  assert.match(debug, /'connector_uploads',/);
  const scope = fs.readFileSync(path.join(__dirname, '../src/services/topochain/db-console-scope.js'), 'utf8');
  assert.match(scope, /connector_uploads: \['token_hash', 'data'\]/);
});
