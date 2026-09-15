// The featured-illustration endpoint (src/routes/app-illustrations.js).
//
// #2086: a save or removal no longer writes apps.featured_illustration. Each
// write builds the complete record the app would wear and opens a
// `featured_illustration` governance proposal carrying it
// (src/services/illustration-proposals.js); the record lands when the vote
// applies it. This suite pins the framing/upload validation the endpoint
// kept, and that every write path opens a proposal rather than writing:
//
//   * POST (single light upload), PUT (the pair), PATCH (reframe) and DELETE
//     each insert an issue row of the new kind and touch no `apps` column;
//   * the proposed record is COMPLETE: a reframe carries the current urls, a
//     light-only PUT keeps the current dark image, dark:null drops it;
//   * new bytes wait in app_illustration_proposals and are served from the
//     image route under the url the card previews;
//   * a second save while one is open is a 409 that links to the open card,
//     and GET reports it as `pending`;
//   * a non-manager is refused before anything is read, and removing an
//     illustration the app never had opens nothing.
//
// Run with: node --test tests/featured-illustration-api.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const poolModule = require('../src/db/pool');
const access = require('../src/services/app-access');
const admins = require('../src/services/app-admins');
const ws = require('../src/services/ws');

// ── Mock pool ─────────────────────────────────────────────────────────────
// The state a proposal leaves behind: the issue rows, the pending image rows,
// and (never touched by the routes) the app's current illustration.
const state = { art: null, manager: true, visible: true, issues: [], images: [], appWrites: 0, messages: [], pushes: [] };
let nextIssueId = 100;
const query = async (sql, p) => {
  if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql)) return { rows: [] };
  if (sql.includes('UPDATE apps') || sql.includes('DELETE FROM app_illustrations')) { state.appWrites++; return { rows: [] }; }
  if (sql.includes('FROM issues') && sql.includes("status = 'open'")) {
    return { rows: state.issues.filter(i => i.app_id === p[0] && i.kind === p[1] && i.status === 'open').slice(0, 1) };
  }
  if (sql.includes('INSERT INTO issues')) {
    const row = { id: nextIssueId++, app_id: p[0], title: p[1], description: p[2], kind: p[3], payload: JSON.parse(p[4]), created_by: p[5], status: 'open' };
    state.issues.push(row);
    return { rows: [row] };
  }
  if (sql.includes('INSERT INTO app_illustration_proposals')) {
    state.images.push({ issue_id: p[0], app_id: p[1], id: p[2], content_type: p[3], data: p[4], dark_id: p[5], dark_content_type: p[6], dark_data: p[7] });
    return { rows: [] };
  }
  if (sql.startsWith('SELECT content_type, data FROM app_illustrations')) {
    for (const row of state.images) {
      if (row.id === p[0]) return { rows: [{ content_type: row.content_type, data: row.data }] };
      if (row.dark_id === p[0]) return { rows: [{ content_type: row.dark_content_type, data: row.dark_data }] };
    }
    return { rows: [] };
  }
  throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
};
const original = [poolModule.getPool, access.getAppForUser, admins.canManageApp, ws.sendSystemMessage, ws.pushIssueUpdate];
poolModule.getPool = () => ({ query, connect: async () => ({ query, release() {} }) });
access.getAppForUser = async () => state.visible ? { id: 1, slug: 'gym', name: 'Gym', featured_illustration: state.art } : null;
admins.canManageApp = async () => state.manager;
ws.sendSystemMessage = async (...args) => { state.messages.push(args); return {}; };
ws.pushIssueUpdate = (data) => { state.pushes.push(data); };
delete require.cache[require.resolve('../src/services/illustration-proposals')];
delete require.cache[require.resolve('../src/routes/app-illustrations')];
const { illustrationRoutes, illustrationImageRoutes, parseFraming, validateImage, TONES, LEGACY_TINTS } = require('../src/routes/app-illustrations');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 7, username: 'maker' }; next(); });
app.use(illustrationRoutes({}));
app.use(illustrationImageRoutes({}));
[poolModule.getPool, access.getAppForUser, admins.canManageApp, ws.sendSystemMessage, ws.pushIssueUpdate] = original;
delete require.cache[require.resolve('../src/services/illustration-proposals')];
delete require.cache[require.resolve('../src/routes/app-illustrations')];
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const endpoint = '/api/apps/gym/featured-illustration';

const reset = (art = null) => {
  state.art = art; state.manager = true; state.visible = true;
  state.issues = []; state.images = []; state.appWrites = 0; state.messages = []; state.pushes = [];
};
const openIssues = () => state.issues.filter(i => i.status === 'open');

test('framing and upload limits reject malformed values and active image formats', () => {
  assert.equal(parseFraming({ zoom: '1', x: 0, y: 0 }), null);
  for (const zoom of [NaN, Infinity, 0, 4]) assert.equal(parseFraming({ zoom, x: 0, y: 0 }), null);
  assert.equal(parseFraming({ zoom: 1, x: 101, y: 0 }), null);
  assert.equal(validateImage(Buffer.from('<svg/>')), null);
  assert.equal(validateImage(Buffer.alloc(1024 * 1024 + 1)), null);
  assert.equal(validateImage(png), 'image/png');
});
test('the card colour is optional, and only the palette is a card colour', () => {
  // Absent means "no override" — the card falls back to the slug's own hash —
  // so the key is left OFF the result rather than written as null, which is
  // what lets a reframe's record merge leave an already-saved colour alone.
  assert.deepEqual(parseFraming({ zoom: 1, x: 0, y: 0 }), { zoom: 1, x: 0, y: 0 });
  assert.deepEqual(parseFraming({ zoom: 1, x: 0, y: 0, tint: null }), { zoom: 1, x: 0, y: 0 });
  // The twelve tones the editor offers, plus the five tints it offered before
  // them: an illustration saved then keeps its colour through a later reframe.
  for (const tint of [...TONES, ...LEGACY_TINTS]) {
    assert.deepEqual(parseFraming({ zoom: 1, x: 0, y: 0, tint }), { zoom: 1, x: 0, y: 0, tint });
  }
  // Anything else is rejected outright rather than dropped, so a client that
  // means to set a colour is told it did not.
  for (const tint of [0, 6, -1, 2.5, '3', 'Blue', 'lilac', '', NaN, Infinity, true, {}]) {
    assert.equal(parseFraming({ zoom: 1, x: 0, y: 0, tint }), null, `rejected: ${JSON.stringify(tint)}`);
  }
});

async function withServer(fn) {
  const server = app.listen(0); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = 'GET', body, type = 'application/json') => fetch(origin + path, {
    method, headers: { 'Content-Type': type }, body: body == null ? undefined : type === 'application/json' ? JSON.stringify(body) : body,
  });
  try { await fn(request); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('a single upload opens a proposal carrying the new image, and never writes the app', async () => {
  reset();
  await withServer(async (request) => {
    let response = await request(endpoint + '?zoom=1.2&x=-15&y=22', 'POST', png, 'application/octet-stream');
    assert.equal(response.status, 201);
    const data = await response.json();
    // What the app still wears (nothing), and the card to link to.
    assert.equal(data.illustration, null);
    assert.equal(data.proposal.id, state.issues[0].id);
    assert.equal(data.proposal.href, `#app/gym/dev/governance/${state.issues[0].id}`);
    assert.equal(state.appWrites, 0, 'apps.featured_illustration is never written by the route');
    // The issue row is the proposal: the new kind, a complete proposed
    // record, the current one for the card to show beside it.
    const issue = state.issues[0];
    assert.equal(issue.kind, 'featured_illustration');
    assert.equal(issue.title, 'Add a featured illustration');
    assert.equal(issue.created_by, 7);
    assert.match(issue.description, /maker proposed adding the featured illustration/);
    assert.ok(!/—/.test(issue.description), 'platform copy carries no em dash');
    assert.equal(issue.payload.remove, false);
    assert.equal(issue.payload.current, null);
    const proposed = issue.payload.proposed;
    assert.match(proposed.url, /^\/app-illustrations\/[a-f0-9]{32}$/);
    assert.equal(proposed.x, -15); assert.equal(proposed.zoom, 1.2);
    assert.equal('tint' in proposed, false, 'an upload that picked no colour stores none');
    // The bytes wait with the proposal, served under the url the card previews.
    assert.equal(state.images.length, 1);
    assert.equal(state.images[0].issue_id, issue.id);
    response = await request(proposed.url);
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    // Announced like the other governance kinds: group chat plus the
    // proposal's own thread, and a board refresh for every open client.
    assert.equal(state.messages.length, 2);
    assert.match(state.messages[0][2], /maker proposed changing the featured illustration/);
    assert.deepEqual(state.messages[1][5], { type: 'governance', ref: issue.id });
    assert.deepEqual(state.pushes, [{ action: 'created', appSlug: 'gym', appId: 1, issueId: issue.id, kind: 'featured_illustration' }]);
    // GET now reports the open card, and a second save waits for it.
    response = await request(endpoint);
    assert.deepEqual((await response.json()).pending, data.proposal);
    response = await request(endpoint + '?zoom=1&x=0&y=0', 'POST', png, 'application/octet-stream');
    assert.equal(response.status, 409);
    const dup = await response.json();
    assert.match(dup.error, /already waiting/);
    assert.deepEqual(dup.pending, data.proposal);
    assert.equal(openIssues().length, 1);
    assert.equal(state.images.length, 1);
    // Out of the set is a 400 before anything is opened.
    state.issues = [];
    assert.equal((await request(endpoint + '?zoom=1&x=0&y=0&tint=9', 'POST', png, 'application/octet-stream')).status, 400);
    assert.equal(state.issues.length, 0);
    // A tone arrives ready; a legacy tint from a stale page is coerced back.
    assert.equal((await request(endpoint + '?zoom=1&x=0&y=0&tint=blue', 'POST', png, 'application/octet-stream')).status, 201);
    assert.equal(state.issues[0].payload.proposed.tint, 'blue');
    state.issues = [];
    assert.equal((await request(endpoint + '?zoom=1&x=0&y=0&tint=2', 'POST', png, 'application/octet-stream')).status, 201);
    assert.equal(state.issues[0].payload.proposed.tint, 2);
  });
});

test('reframe and removal propose the complete record, and a non-manager opens nothing', async () => {
  const current = { url: '/app-illustrations/' + 'a'.repeat(32), darkUrl: null, zoom: 1, x: 0, y: 0, tint: 'teal' };
  reset(current);
  await withServer(async (request) => {
    // PATCH: the current urls under the new framing; the saved colour stays
    // when none is sent, and a sent one replaces it.
    let response = await request(endpoint, 'PATCH', { zoom: 2, x: 0, y: -50 });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).illustration.tint, 'teal', 'the app still wears the current record');
    let issue = state.issues[0];
    assert.equal(issue.title, 'Change the featured illustration');
    assert.deepEqual(issue.payload.proposed, { ...current, zoom: 2, x: 0, y: -50 });
    assert.deepEqual(issue.payload.current, current);
    assert.equal(state.images.length, 0, 'a reframe carries no bytes');
    state.issues = [];
    await request(endpoint, 'PATCH', { zoom: 1, x: 0, y: 0, tint: 4 });
    assert.equal(state.issues[0].payload.proposed.tint, 4);
    assert.equal(state.appWrites, 0);
    // A reframe of nothing is a 409, as it always was.
    state.issues = []; state.art = null;
    assert.equal((await request(endpoint, 'PATCH', { zoom: 1, x: 0, y: 0 })).status, 409);
    assert.equal(state.issues.length, 0);
    // DELETE with nothing to remove opens nothing; with an illustration it
    // proposes the removal (proposed: null) and still writes nothing.
    response = await request(endpoint, 'DELETE');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { illustration: null, proposal: null });
    assert.equal(state.issues.length, 0);
    state.art = current;
    response = await request(endpoint, 'DELETE');
    assert.equal(response.status, 201);
    issue = state.issues[0];
    assert.equal(issue.title, 'Remove the featured illustration');
    assert.equal(issue.payload.proposed, null);
    assert.equal(issue.payload.remove, true);
    assert.deepEqual(issue.payload.current, current);
    assert.equal(state.appWrites, 0);
    // The open removal blocks a reframe too: one open card per app.
    assert.equal((await request(endpoint, 'PATCH', { zoom: 1, x: 0, y: 0 })).status, 409);
    assert.equal(openIssues().length, 1);
    // A non-manager is refused before anything is read or opened.
    state.issues = []; state.manager = false;
    for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await request(endpoint, method, { zoom: 1, x: 0, y: 0 })).status, 403);
    assert.equal(state.issues.length, 0);
    state.visible = false; assert.equal((await request(endpoint)).status, 404);
  });
});

test('the pair proposes one complete record: new bytes wait with it, kept images ride by url', async () => {
  reset();
  await withServer(async (request) => {
    const put = body => request(endpoint, 'PUT', JSON.stringify(body), 'application/octet-stream');
    const frame = { zoom: 2, x: 12, y: -9, tint: 'blue' };
    const light = png.toString('base64');
    const darkBytes = Buffer.concat([png, Buffer.from('dark')]);
    const dark = darkBytes.toString('base64');
    assert.equal((await put({ ...frame, dark })).status, 409, 'a dark image needs a light image under it');
    assert.equal((await put({ ...frame, light: 'not base64!' })).status, 400);
    assert.equal(state.issues.length, 0);
    let response = await put({ ...frame, light, dark });
    assert.equal(response.status, 201);
    let proposed = state.issues[0].payload.proposed;
    assert.notEqual(proposed.url, proposed.darkUrl);
    for (const [key, value] of Object.entries(frame)) assert.equal(proposed[key], value);
    // Both variants wait on the proposal's row and serve from the image route.
    assert.equal(state.images.length, 1);
    for (const [url, bytes] of [[proposed.url, png], [proposed.darkUrl, darkBytes]]) {
      response = await request(url);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
    // Once that pair is the app's record, a light-only PUT keeps the dark
    // image by url, dark:null drops it, and an undefined dark leaves it be.
    const current = proposed;
    reset(current);
    await put({ zoom: 1, x: 0, y: 0, light });
    proposed = state.issues[0].payload.proposed;
    assert.notEqual(proposed.url, current.url);
    assert.equal(proposed.darkUrl, current.darkUrl);
    assert.equal(proposed.tint, 'blue', 'the saved colour rides along when none is sent');
    assert.equal(state.images[0].dark_id, null, 'no dark bytes travel with a light-only save');
    reset(current);
    await put({ zoom: 1, x: 0, y: 0, dark: null });
    proposed = state.issues[0].payload.proposed;
    assert.equal(proposed.url, current.url);
    assert.equal(proposed.darkUrl, null);
    assert.equal(state.images.length, 0);
    reset(current);
    await put({ zoom: 1.5, x: 3, y: 4 });
    proposed = state.issues[0].payload.proposed;
    assert.deepEqual(proposed, { ...current, zoom: 1.5, x: 3, y: 4 });
    assert.equal(state.appWrites, 0);
  });
});
