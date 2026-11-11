'use strict';

// The connector's card-picture tools (services/mcp-tools.js):
// get_featured_illustration and propose_featured_illustration, over the
// project's Featured illustration editor's own route
// (routes/app-illustrations.js), which admits only people who may manage the
// app and turns a write into a group vote. The pictures go ahead with
// prepare_upload (kind "screenshot", services/connector-uploads.js) and are
// named by uploadId, so no image is ever written out inside a call.
//
// What these pin: the tools are offered to an external client only; the read
// shows the card's picture and any pending change; a proposal reads each
// upload back for its owner, holds it to the editor's 1 MB limit, keeps the
// card's framing unless told otherwise, sends the pair as the editor's PUT
// does and then uses the uploads up; every refusal sends nothing and says
// so; and the connector reaches the route's GET and PUT and nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');
const { z } = require('zod');

const tools = require('../src/services/mcp-tools');
const policy = require('../src/services/cli-api-policy');
const { READ_SCOPE, WRITE_SCOPE } = require('../src/services/mcp-connect-constants');

const ORIGIN = 'https://app.onhomeroom.com';
const BASE = 'http://platform.internal';
const LIGHT = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 1)]);
const DARK = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 2)]);
const HUGE = Buffer.alloc(1024 * 1024 + 1, 3);
// A preview loop: an MP4's `ftyp` box, and one past the 1.5 MB limit.
const LOOP = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 4)]);
const HUGE_LOOP = Buffer.concat([LOOP, Buffer.alloc(1536 * 1024, 5)]);

// Uploads 81 and 82 hold the two pictures, 83 one too big for a card, 84 is
// a plan and 85 was never sent.
const UPLOADS = {
  81: { kind: 'screenshot', stored: true, media_id: 'a1'.repeat(16), data: LIGHT },
  82: { kind: 'screenshot', stored: true, media_id: 'b2'.repeat(16), data: DARK },
  83: { kind: 'screenshot', stored: true, media_id: 'c3'.repeat(16), data: HUGE },
  84: { kind: 'plan', stored: true },
  85: { kind: 'screenshot', stored: false },
  86: { kind: 'video', stored: true, media_id: 'e5'.repeat(16), data: LOOP },
  87: { kind: 'video', stored: true, media_id: 'f6'.repeat(16), data: HUGE_LOOP },
};

function fakePool(queries) {
  const byMedia = new Map(Object.values(UPLOADS).filter((u) => u.media_id).map((u) => [u.media_id, u.data]));
  return {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('data, media_id')) {
        const row = UPLOADS[Number(params[0])];
        if (!row || Number(params[1]) !== 7) return { rows: [] };
        return { rows: [{ id: Number(params[0]), kind: row.kind, stored_at: row.stored ? new Date() : null, live: true,
          data: null, media_id: row.media_id || null, bytes: row.data ? row.data.length : 0, sha256: 'x' }] };
      }
      if (sql.includes('FROM issue_screenshots')) {
        assert.match(sql, /user_id = \$2 AND issue_number IS NULL/, 'only the caller\'s own unlinked picture');
        const data = Number(params[1]) === 7 ? byMedia.get(params[0]) : null;
        return { rows: data ? [{ data }] : [] };
      }
      if (sql.includes('FROM issue_videos')) {
        assert.match(sql, /user_id = \$2 AND issue_number IS NULL/, 'only the caller\'s own unlinked video');
        const data = Number(params[1]) === 7 ? byMedia.get(params[0]) : null;
        return { rows: data ? [{ data, content_type: 'video/mp4' }] : [] };
      }
      if (sql.includes('DELETE FROM connector_uploads WHERE id = ANY')) return { rows: [] };
      throw new Error(`unstubbed query: ${sql.slice(0, 80)}`);
    },
  };
}

function connector(t, { delegation = null, scopes = [READ_SCOPE, WRITE_SCOPE], respond } = {}) {
  const handlers = new Map();
  const specs = new Map();
  const calls = [];
  const queries = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const pathname = String(url).replace(BASE, '');
    const raw = init.body;
    calls.push({
      method: init.method || 'GET', pathname,
      contentType: init.headers && init.headers['content-type'],
      body: raw ? JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw) : null,
    });
    const { status = 200, body = {} } = (respond && respond(init.method || 'GET', pathname)) || {};
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  t.after(() => { globalThis.fetch = realFetch; });
  tools.registerTools({
    registerTool(name, spec, handler) { handlers.set(name, handler); specs.set(name, spec); },
  }, {
    accessToken: 'svmcp_test', scopes, user: { id: 7, username: 'ada' },
    clientName: 'Claude Code', clientId: 'c1', origin: ORIGIN, baseUrl: BASE,
    pool: fakePool(queries), config: {}, tokenId: 1, grantId: null, delegation,
  });
  return { handlers, specs, calls, queries };
}

const CURRENT = {
  illustration: { url: `/app-illustrations/${'d'.repeat(32)}`, darkUrl: null, zoom: 1.4, x: -10, y: 20, tint: 'mint' },
  pending: null,
};
const PROPOSED = { illustration: CURRENT.illustration, proposal: { id: 901, href: '#app/patch-741877/dev/governance/901' } };
const answers = (overrides = {}) => (method) => (method === 'GET'
  ? { body: overrides.current || CURRENT }
  : overrides.put || { status: 201, body: PROPOSED });

test('the tools are offered to an external client only, a read as a read and the proposal as an acting tool', (t) => {
  const external = connector(t);
  const get = external.specs.get('get_featured_illustration');
  const propose = external.specs.get('propose_featured_illustration');
  assert.ok(get && propose);
  assert.equal(get.annotations.readOnlyHint, true);
  assert.equal(propose.annotations.readOnlyHint, false);
  assert.ok(tools.ACTING_TOOLS.includes('propose_featured_illustration'));
  assert.ok(!tools.ACTING_TOOLS.includes('get_featured_illustration'));
  assert.match(propose.description, /prepare_upload \(kind "screenshot"\)/);
  assert.match(propose.description, /opens a vote in the project's group/);
  assert.equal(propose.inputSchema.tint.safeParse('chartreuse').success, false, 'the editor\'s colours only');
  assert.equal(propose.inputSchema.zoom.safeParse(4).success, false);

  const mayor = connector(t, { delegation: { kind: 'agent_mayor' } });
  assert.equal(mayor.specs.get('get_featured_illustration'), undefined);
  assert.equal(mayor.specs.get('propose_featured_illustration'), undefined);
});

test('get_featured_illustration shows the card\'s picture, framing and any pending change', async (t) => {
  const c = connector(t, { respond: () => ({ body: { ...CURRENT, pending: { id: 900, href: '#app/patch-741877/dev/governance/900' } } }) });
  const out = await c.handlers.get('get_featured_illustration')({ slug: 'patch-741877' });
  assert.equal(out.isError, undefined, JSON.stringify(out.structuredContent));
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.pathname}`), ['GET /api/apps/patch-741877/featured-illustration']);
  const s = out.structuredContent;
  assert.deepEqual(s.illustration, {
    url: `${ORIGIN}/app-illustrations/${'d'.repeat(32)}`, darkUrl: null, zoom: 1.4, x: -10, y: 20, tint: 'mint', previewUrl: null,
  });
  assert.deepEqual(s.pending, { id: 900, url: `${ORIGIN}/#app/patch-741877/dev/governance/900` });
  assert.match(s.nextStep, /already up for the group's vote/);
  assert.equal(z.object(c.specs.get('get_featured_illustration').outputSchema).safeParse(s).success, true);
  assert.equal((await c.handlers.get('get_featured_illustration')({ slug: '../admin' })).structuredContent.code, 'invalid_request');
});

test('a proposal sends both pictures as the editor\'s PUT does, keeps the card\'s framing, and uses the uploads up', async (t) => {
  const c = connector(t, { respond: answers() });
  const out = await c.handlers.get('propose_featured_illustration')({ slug: 'patch-741877', lightUploadId: 81, darkUploadId: 82 });
  assert.equal(out.isError, undefined, JSON.stringify(out.structuredContent));
  assert.deepEqual(c.calls.map((x) => `${x.method} ${x.pathname}`), [
    'GET /api/apps/patch-741877/featured-illustration',
    'PUT /api/apps/patch-741877/featured-illustration',
  ]);
  const put = c.calls[1];
  assert.equal(put.contentType, 'application/octet-stream', 'the editor route reads its pair raw, not through the JSON parser');
  assert.deepEqual(put.body, { light: LIGHT.toString('base64'), dark: DARK.toString('base64'), zoom: 1.4, x: -10, y: 20 });
  assert.deepEqual(out.structuredContent.proposal, { id: 901, url: `${ORIGIN}/#app/patch-741877/dev/governance/901` });
  assert.match(out.structuredContent.nextStep, /keeps its current picture until the vote passes/);
  const used = c.queries.find((q) => q.sql.includes('DELETE FROM connector_uploads WHERE id = ANY'));
  assert.deepEqual(used.params, [[81, 82], 7]);
  assert.equal(z.object(c.specs.get('propose_featured_illustration').outputSchema).safeParse(out.structuredContent).success, true);
});

test('framing and colour given are sent as given, a card with none starts centred, and null drops the dark picture', async (t) => {
  const c = connector(t, { respond: answers({ current: { illustration: null, pending: null } }) });
  await c.handlers.get('propose_featured_illustration')({ slug: 'bread-bot-3e3f5c', lightUploadId: 81 });
  assert.deepEqual(c.calls.at(-1).body, { light: LIGHT.toString('base64'), zoom: 1, x: 0, y: 0 });

  const framed = connector(t, { respond: answers() });
  await framed.handlers.get('propose_featured_illustration')({ slug: 'bread-bot-3e3f5c', lightUploadId: 81, zoom: 1, x: 0, y: 0, tint: 'orange' });
  assert.deepEqual(framed.calls.map((x) => x.method), ['PUT'], 'no read when all of the framing is given');
  assert.deepEqual(framed.calls[0].body, { light: LIGHT.toString('base64'), zoom: 1, x: 0, y: 0, tint: 'orange' });

  const dropDark = connector(t, { respond: answers() });
  await dropDark.handlers.get('propose_featured_illustration')({ slug: 'bread-bot-3e3f5c', darkUploadId: null });
  assert.deepEqual(dropDark.calls.at(-1).body, { dark: null, zoom: 1.4, x: -10, y: 20 });
});

test('a refusal sends no picture, says nothing was changed, and keeps the uploads', async (t) => {
  const c = connector(t, { respond: answers() });
  const propose = c.handlers.get('propose_featured_illustration');
  const cases = [
    [{ slug: 'patch-741877' }, 'invalid_request', /nothing to propose/],
    [{ slug: 'patch-741877', lightUploadId: 81, darkUploadId: 81 }, 'invalid_request', /the same upload/],
    [{ slug: 'patch-741877', lightUploadId: 84 }, 'upload_wrong_kind', /is a plan/],
    [{ slug: 'patch-741877', lightUploadId: 85 }, 'upload_not_sent', /Run the command/],
    [{ slug: 'patch-741877', lightUploadId: 99 }, 'upload_not_found', /no upload 99 of yours/],
    [{ slug: 'patch-741877', lightUploadId: 81, darkUploadId: 83 }, 'invalid_images', /dark picture is 1024 KB.*under 1 MB/],
  ];
  for (const [args, code, words] of cases) {
    const out = await propose(args);
    assert.equal(out.isError, true, JSON.stringify(args));
    assert.equal(out.structuredContent.code, code, JSON.stringify(args));
    assert.match(out.structuredContent.message, words);
    assert.match(out.structuredContent.message, /Nothing was changed\./);
  }
  assert.equal(c.calls.length, 0, 'nothing reached the route');
  assert.ok(!c.queries.some((q) => q.sql.includes('DELETE FROM connector_uploads')), 'no upload was used up');
});

test('the route\'s own refusals come back with their reason: not a manager, a change already waiting', async (t) => {
  const notManager = connector(t, { respond: () => ({ status: 403, body: { error: 'Only app managers can propose a change to this illustration.' } }) });
  const refused = await notManager.handlers.get('propose_featured_illustration')({ slug: 'patch-741877', lightUploadId: 81, zoom: 1, x: 0, y: 0 });
  assert.equal(refused.structuredContent.code, 'managers_only');
  assert.match(refused.structuredContent.message, /Only app managers.*Nothing was changed\./);

  const waiting = connector(t, { respond: answers({ put: { status: 409, body: {
    error: 'A change to this illustration is already waiting for its vote.',
    pending: { id: 900, href: '#app/patch-741877/dev/governance/900' },
  } } }) });
  const busy = await waiting.handlers.get('propose_featured_illustration')({ slug: 'patch-741877', lightUploadId: 81 });
  assert.equal(busy.structuredContent.code, 'conflict');
  assert.deepEqual(busy.structuredContent.pending, { id: 900, url: `${ORIGIN}/#app/patch-741877/dev/governance/900` });
  assert.ok(!waiting.queries.some((q) => q.sql.includes('DELETE FROM connector_uploads')), 'a refused proposal keeps the uploads');
});

test('a read-only connector reads the picture but cannot propose one', async (t) => {
  const c = connector(t, { scopes: [READ_SCOPE], respond: answers() });
  assert.equal((await c.handlers.get('get_featured_illustration')({ slug: 'patch-741877' })).isError, undefined);
  const out = await c.handlers.get('propose_featured_illustration')({ slug: 'patch-741877', lightUploadId: 81 });
  assert.equal(out.isError, true);
  assert.deepEqual(c.calls.map((x) => x.method), ['GET']);
});

test('a connector reaches the editor route\'s read and PUT, and none of its other writes', () => {
  assert.equal(policy.isConnectorApiRequest('GET', '/api/apps/patch-741877/featured-illustration'), true);
  assert.equal(policy.isConnectorApiRequest('PUT', '/api/apps/patch-741877/featured-illustration'), true);
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    assert.equal(policy.isConnectorApiRequest(method, '/api/apps/patch-741877/featured-illustration'), false, method);
  }
});

test('the charter says a proposal is a vote, one at a time, and only for a picture the person chose', () => {
  const section = require('../src/services/mcp-charter').CHARTER_SECTIONS.find((s) => s.id === 'featured-illustration');
  assert.ok(section, 'the section exists');
  for (const name of ['get_featured_illustration', 'propose_featured_illustration', 'prepare_upload']) {
    assert.match(section.text, new RegExp(name));
  }
  assert.match(section.text, /opens a vote in the project's group/);
  assert.match(section.text, /Only one change to a project's picture can wait for a vote at a time/);
  assert.match(section.text, /Propose a picture only when the person has chosen it\./);
});

test('a preview loop goes up as a video upload: sent with the PUT, held to 1.5 MB, null drops it', async (t) => {
  const c = connector(t, { respond: answers() });
  const out = await c.handlers.get('propose_featured_illustration')({ slug: 'patch-741877', previewUploadId: 86 });
  assert.equal(out.isError, undefined, JSON.stringify(out.structuredContent));
  assert.deepEqual(c.calls.at(-1).body, { preview: LOOP.toString('base64'), zoom: 1.4, x: -10, y: 20 });
  const used = c.queries.find((q) => q.sql.includes('DELETE FROM connector_uploads WHERE id = ANY'));
  assert.deepEqual(used.params, [[86], 7]);

  const big = connector(t, { respond: answers() });
  const refused = await big.handlers.get('propose_featured_illustration')({ slug: 'patch-741877', previewUploadId: 87 });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /at most 1\.5 MB/);
  assert.deepEqual(big.calls.filter((x) => x.method === 'PUT'), [], 'nothing is sent');

  const wrongKind = connector(t, { respond: answers() });
  const notVideo = await wrongKind.handlers.get('propose_featured_illustration')({ slug: 'patch-741877', previewUploadId: 81 });
  assert.equal(notVideo.isError, true);
  assert.match(notVideo.content[0].text, /takes a video/);

  const drop = connector(t, { respond: answers() });
  await drop.handlers.get('propose_featured_illustration')({ slug: 'patch-741877', previewUploadId: null });
  assert.deepEqual(drop.calls.at(-1).body, { preview: null, zoom: 1.4, x: -10, y: 20 });
  // The read names the loop, at its full address.
  const read = connector(t, { respond: () => ({ body: { illustration: { ...CURRENT.illustration, preview: { url: `/app-previews/${'a'.repeat(32)}`, type: 'video/mp4' } }, pending: null } }) });
  const got = await read.handlers.get('get_featured_illustration')({ slug: 'patch-741877' });
  assert.equal(got.structuredContent.illustration.previewUrl, `${ORIGIN}/app-previews/${'a'.repeat(32)}`);
  assert.match(c.specs.get('propose_featured_illustration').description, /previewUploadId/);
});
