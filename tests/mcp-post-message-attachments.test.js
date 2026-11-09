'use strict';

// #6534: post_message can carry pictures and an HTML design.
//
// The connector checks every file before it uploads one, sends the bytes to
// the chat route's own attachment door (which applies membership, the collab
// gate and the storage cap), then posts one message naming the uploads. A
// refusal anywhere posts nothing.
//
// Run with: node --test tests/mcp-post-message-attachments.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const tools = require('../src/services/mcp-tools');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');

const ORIGIN = 'https://app.onhomeroom.com';
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// Signature, then the IHDR's width and height (1x1): checkRequestImages reads
// both from the header.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  Buffer.alloc(16, 1),
]);
const DESIGN = '<!doctype html><html><body><h1>Before and after</h1></body></html>';

function fakePool() {
  const rows = {
    66: { kind: 'design', stored: true, data: Buffer.from(DESIGN) },
  };
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (sql.includes('data, media_id')) {
        const row = rows[Number(params[0])];
        if (!row || Number(params[1]) !== 7) return { rows: [] };
        return {
          rows: [{
            id: Number(params[0]), kind: row.kind, stored_at: row.stored ? new Date() : null, live: true,
            data: row.data || null, media_id: row.media_id || null, bytes: 10, sha256: 'x',
          }],
        };
      }
      if (sql.includes('DELETE FROM connector_uploads WHERE id = ANY')) return { rows: [] };
      throw new Error(`unstubbed query: ${sql.slice(0, 80)}`);
    },
  };
}

// A platform that answers the two routes post_message uses, recording each.
function connector({ platform } = {}) {
  const handlers = new Map();
  const specs = new Map();
  const calls = [];
  const realFetch = globalThis.fetch;
  let attached = 0;
  globalThis.fetch = async (url, init = {}) => {
    const pathname = String(url).replace('http://platform.internal', '');
    const call = { method: init.method || 'GET', pathname, body: Buffer.isBuffer(init.body) ? init.body : (init.body ? JSON.parse(init.body) : null) };
    calls.push(call);
    const answer = platform ? platform(call, { nextId: () => `a${String(++attached).padStart(31, '0')}` }) : null;
    if (answer) {
      return { ok: answer.status < 400, status: answer.status, text: async () => JSON.stringify(answer.body) };
    }
    if (pathname.includes('/chat-attachments')) {
      const filename = decodeURIComponent(new URL(url).searchParams.get('filename') || 'file');
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          id: `a${String(++attached).padStart(31, '0')}`, kind: filename.endsWith('.html') ? 'html' : 'image',
          filename, contentType: filename.endsWith('.html') ? 'text/html' : 'image/png', sizeBytes: 10, meta: null,
        }),
      };
    }
    return {
      ok: true, status: 201,
      text: async () => JSON.stringify({ message: { id: 99, posted_via: 'agent', metadata: {}, content: '' } }),
    };
  };
  const pool = fakePool();
  tools.registerTools({
    registerTool(name, spec, handler) { handlers.set(name, handler); specs.set(name, spec); },
  }, {
    accessToken: 'svmcp_test',
    scopes: [READ_SCOPE, WRITE_SCOPE],
    user: { id: 7, username: 'ada' },
    clientName: 'Claude', clientId: 'c1',
    origin: ORIGIN, baseUrl: 'http://platform.internal',
    pool, config: {}, tokenId: null, grantId: null, delegation: null,
  });
  return {
    handlers, specs, calls, pool,
    restore: () => { globalThis.fetch = realFetch; },
  };
}

const image = (buf = PNG) => ({ data: buf.toString('base64'), sha256: sha(buf) });
const posts = (calls) => calls.filter((c) => c.pathname.endsWith('/messages'));
const uploads = (calls) => calls.filter((c) => c.pathname.includes('/chat-attachments'));

test('two images on a change\'s thread post one message carrying both, in order', async () => {
  const c = connector();
  try {
    const out = await c.handlers.get('post_message')({
      slug: 'usernode-2d5619', threadType: 'session', ref: 6508,
      content: 'The admit email, before and after.',
      images: [image(PNG), image(PNG)],
    });
    assert.equal(out.isError, undefined, JSON.stringify(out.structuredContent));
    const sent = uploads(c.calls);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].pathname, '/api/apps/usernode-2d5619/chat-attachments?filename=picture-1.png');
    assert.equal(sent[1].pathname, '/api/apps/usernode-2d5619/chat-attachments?filename=picture-2.png');
    assert.ok(Buffer.isBuffer(sent[0].body), 'the bytes go as raw octet-stream, never base64 in JSON');
    const [posted] = posts(c.calls);
    assert.equal(posted.body.content, 'The admit email, before and after.');
    assert.equal(posted.body.thread_type, 'session');
    assert.equal(posted.body.thread_ref, 6508);
    assert.equal(posted.body.attachment_ids.length, 2);
    assert.equal(out.structuredContent.attachments.length, 2);
    assert.equal(out.structuredContent.attachments[0].kind, 'image');
  } finally { c.restore(); }
});

test('a message may be attachments only', async () => {
  const c = connector();
  try {
    const out = await c.handlers.get('post_message')({
      slug: 'app', threadType: 'issue', ref: 12, images: [image()],
    });
    assert.equal(out.isError, undefined, JSON.stringify(out.structuredContent));
    assert.equal(posts(c.calls)[0].body.content, '');
  } finally { c.restore(); }
});

test('empty with nothing attached is still refused', async () => {
  const c = connector();
  try {
    const out = await c.handlers.get('post_message')({ slug: 'app', threadType: 'issue', ref: 12 });
    assert.equal(out.structuredContent.code, 'invalid_request');
    assert.equal(c.calls.length, 0);
  } finally { c.restore(); }
});

test('a damaged hash refuses the whole message before any upload', async () => {
  const c = connector();
  try {
    const out = await c.handlers.get('post_message')({
      slug: 'app', threadType: 'issue', ref: 12, content: 'Pictures.',
      images: [{ data: PNG.toString('base64'), sha256: '0'.repeat(64) }],
    });
    assert.equal(out.structuredContent.code, 'invalid_images');
    assert.match(out.structuredContent.message, /SHA-256/);
    assert.equal(c.calls.length, 0, 'nothing was uploaded and nothing was posted');
  } finally { c.restore(); }
});

test('more than four files refuses the whole message, naming both numbers', async () => {
  const c = connector();
  try {
    const out = await c.handlers.get('post_message')({
      slug: 'app', threadType: 'issue', ref: 12, content: 'Pictures.',
      images: [image(), image(), image(), image(), image()],
    });
    assert.equal(out.structuredContent.code, 'invalid_images');
    assert.equal(c.calls.length, 0);
  } finally { c.restore(); }
});

test('a full project refuses the message with the limit, and nothing is posted', async () => {
  const c = connector({
    platform: (call) => (call.pathname.includes('/chat-attachments')
      ? { status: 400, body: { error: 'This app\'s chat attachment storage is full (200 MB max)' } }
      : null),
  });
  try {
    const out = await c.handlers.get('post_message')({
      slug: 'app', threadType: 'issue', ref: 12, content: 'Pictures.', images: [image()],
    });
    assert.equal(out.isError, true);
    assert.match(JSON.stringify(out.structuredContent), /storage is full \(200 MB max\)/);
    assert.equal(posts(c.calls).length, 0);
  } finally { c.restore(); }
});

test('a non-member gets join_required from the route', async () => {
  const c = connector({
    platform: (call) => (call.pathname.endsWith('/messages')
      ? { status: 403, body: { code: 'join_required', error: 'join_required', message: 'Join the community to post.' } }
      : null),
  });
  try {
    const out = await c.handlers.get('post_message')({
      slug: 'app', threadType: 'issue', ref: 12, content: 'Hello.',
    });
    assert.equal(out.isError, true);
    assert.equal(out.structuredContent.code, 'join_required');
  } finally { c.restore(); }
});

test('a design upload posts an HTML attachment under the message', async () => {
  const c = connector();
  try {
    const out = await c.handlers.get('post_message')({
      slug: 'app', threadType: 'issue', ref: 12, content: 'Here is your design.',
      designUploadId: 66,
    });
    assert.equal(out.isError, undefined, JSON.stringify(out.structuredContent));
    const sent = uploads(c.calls);
    assert.equal(sent.length, 1);
    assert.match(sent[0].pathname, /filename=design\.html$/);
    assert.equal(sent[0].body.toString('utf8'), DESIGN);
    assert.equal(out.structuredContent.attachments[0].kind, 'html');
    const used = c.pool.queries.find((q) => q.sql.includes('DELETE FROM connector_uploads WHERE id = ANY'));
    assert.deepEqual(used.params, [[66], 7]);
  } finally { c.restore(); }
});

test('prepare_upload offers design, and post_message offers the attachment fields', async () => {
  const external = connector();
  try {
    assert.equal(external.specs.get('prepare_upload').inputSchema.kind.safeParse('design').success, true);
    assert.ok(external.specs.get('post_message').inputSchema.images);
    assert.ok(external.specs.get('post_message').inputSchema.screenshotUploadIds);
    assert.ok(external.specs.get('post_message').inputSchema.designUploadId);
    assert.match(external.specs.get('post_message').description, /designUploadId/);
    assert.match(external.specs.get('prepare_upload').description, /kind "design"/);
  } finally { external.restore(); }
});
