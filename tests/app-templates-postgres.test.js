'use strict';

// Each ready-made app (services/app-templates.js), generated exactly as a
// new project's repository is, then RUN: `node server.js` against a
// throwaway PostgreSQL database, signed in with a platform-shaped token, and
// driven through its API. This is the proof that a project made from one
// works on its first deploy, with nothing built first, not only that its
// files look right (tests/app-templates.test.js).
//
// Per app: a production boot seeds nothing; a staging boot seeds the rows
// its declared checks read, and a second boot does not seed them again; the
// screen is served to a signed-in visitor and the API refuses anyone else;
// the app's own flows work, "now" included where it decides what shows
// (x-usernode-now, which only a staging container reads); SIGTERM drains
// and exits 0.
//
// The chore list asks the platform who is in the group (GET /members, the
// platform conventions' "Members"): a stand-in platform answers it here,
// for members only, as the real one does.
//
// The game starters play over a WebSocket (game/live.js): their flows open
// real ones, as a page does, beside the plain requests.
//
// The app's dependencies (express, pg, jsonwebtoken, and ws for a game)
// resolve from this repository's node_modules through NODE_PATH. Skipped when no server is
// reachable, required when TEST_DATABASE_URL is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const { getTemplateFiles } = require('../src/services/template');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const APP_ID = '77';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function token(id, username, audience = `usernode:app:${APP_ID}`) {
  return jwt.sign({ id, username, pur: 'iframe' }, privateKey, {
    algorithm: 'RS256', issuer: 'usernode', audience, expiresIn: '10m',
  });
}

const ada = token(101, 'ada');
const grace = token(102, 'grace');
const sam = token(103, 'sam');
const DAY = 24 * 60 * 60 * 1000;

/**
 * A game's live connection, as its page opens one (/api/live?token=):
 * `opened` resolves once connected, or rejects with the refusal's status;
 * `next(test)` reads on from the last message it returned and resolves with
 * the first that passes `test`, skipping the rest.
 *
 * A message that arrives while nobody is waiting is kept until it is read.
 * The ws client hands over every frame of one socket read in a single
 * synchronous run, before the code awaiting the first of them resumes, so
 * two messages sent back to back (a winning roll's view, then the room's
 * "over") both land before the test asks for the second whenever the test
 * process reads late, as it does on a loaded runner. Dropping them timed the
 * board game out there.
 */
function liveOf(app, tok) {
  const WebSocket = require('ws');
  const ws = new WebSocket(`${app.base.replace(/^http/, 'ws')}/api/live${tok ? `?token=${encodeURIComponent(tok)}` : ''}`);
  const unread = [];
  let waiter = null;
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (!waiter) unread.push(msg);
    else if (waiter.test(msg)) { const w = waiter; waiter = null; w.resolve(msg); }
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    ws.once('error', (err) => reject(err));
  });
  opened.catch(() => {});
  return {
    opened,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next(test, ms = 6000) {
      assert.equal(waiter, null, 'one next() at a time on a live connection');
      while (unread.length) {
        const msg = unread.shift();
        if (test(msg)) return Promise.resolve(msg);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiter = null; reject(new Error('no such message in time')); }, ms);
        waiter = { test, resolve: (m) => { clearTimeout(timer); resolve(m); } };
      });
    },
    close: () => ws.close(),
  };
}
const isView = (test = () => true) => (m) => m.t === 'view' && test(m.view);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function writeRepo(template) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `starter-${template}-`));
  for (const f of getTemplateFiles('Demo App', 'demo-app-abc123', 'postgres://unused', null, { template })) {
    fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, f.path), f.content);
  }
  return dir;
}

/**
 * The platform's members route, as the real one answers it: the project's
 * members to a member's user token, 403 not_a_member to anyone else.
 */
async function platform() {
  const members = [{ id: 101, username: 'ada' }, { id: 102, username: 'grace' }];
  const asked = [];
  const server = http.createServer((req, res) => {
    const who = jwt.decode(String(req.headers['x-usernode-user-token'] || ''));
    asked.push(req.url);
    if (!req.url.startsWith('/v1/members')) { res.writeHead(404); return res.end(); }
    if (!who || !members.some((m) => m.id === who.id)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ code: 'not_a_member' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ members, has_more: false }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, asked, close: () => new Promise((r) => server.close(r)) };
}

/** `node server.js` in `dir`, resolved once it is listening. */
async function boot(dir, dbUrl, env, extra = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      NODE_PATH: path.join(__dirname, '..', 'node_modules'),
      DATABASE_URL: dbUrl,
      USERNODE_JWT_PUBLIC_KEY: publicKey,
      USERNODE_APP_ID: APP_ID,
      USERNODE_ENV: env,
      PORT: String(port),
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), 20000);
    child.stdout.on('data', () => { if (out.includes('Listening on :')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}:\n${out}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  async function call(method, url, { as, body, raw, now } = {}) {
    const headers = {};
    if (as) headers['x-usernode-token'] = as;
    if (now) headers['x-usernode-now'] = now;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return res;
    return { status: res.status, data: await res.json().catch(() => null) };
  }
  async function stop() {
    if (child.exitCode !== null) return child.exitCode;
    const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
    if (code === 'timeout') child.kill('SIGKILL');
    return code;
  }
  return { call, stop, base, output: () => out };
}

test('every ready-made app runs: seeds in staging only, serves its screen, refuses strangers, works, and drains', { timeout: 240000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
  }
  const made = [];
  const dirs = [];
  const members = await platform();
  async function database() {
    const name = 'starter_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    made.push(name);
    const url = new URL(DSN); url.pathname = '/' + name;
    return String(url);
  }
  t.after(async () => {
    for (const name of made) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end();
    await members.close();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  const env = { USERNODE_PLATFORM_API_V1_URL: members.url };

  // What every app shares: the screen for a signed-in visitor, nothing for
  // anyone else, and a clean exit on SIGTERM.
  async function common(app, apiPath) {
    const page = await app.call('GET', `/?token=${encodeURIComponent(ada)}`, { raw: true });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<script (?:type="module" )?src="\/app\.js"><\/script>/);
    const script = await app.call('GET', '/app.js', { raw: true });
    assert.equal(script.status, 200, 'the screen\'s script is served as a static file');
    assert.equal((await app.call('GET', apiPath)).status, 401, 'no token, no data');
    assert.equal((await app.call('GET', apiPath, { as: token(101, 'ada', 'usernode:app:999') })).status, 401,
      'a token minted for another app is refused');
    assert.equal((await app.call('GET', '/health')).status, 200);
  }

  async function run(template, apiPath, seeded, flows) {
    const dir = writeRepo(template);
    dirs.push(dir);
    // Production: the tables and nothing in them.
    const prodDb = await database();
    let app = await boot(dir, prodDb, 'production', env);
    assert.equal(seeded((await app.call('GET', apiPath, { as: ada })).data), 0, 'production seeds nothing');
    assert.equal(await app.stop(), 0, `SIGTERM drains and exits 0:\n${app.output()}`);
    assert.match(app.output(), /\[shutdown\] SIGTERM received, draining/);

    // Staging: the seed, once, however many times the preview boots.
    const stagingDb = await database();
    app = await boot(dir, stagingDb, 'staging', env);
    const first = seeded((await app.call('GET', apiPath, { as: ada })).data);
    assert.ok(first > 0, 'staging seeds what its checks read');
    assert.equal(await app.stop(), 0);
    app = await boot(dir, stagingDb, 'staging', env);
    assert.equal(seeded((await app.call('GET', apiPath, { as: ada })).data), first, 'a second boot does not seed again');
    await common(app, apiPath);
    await flows(app);
    assert.equal(await app.stop(), 0, app.output());
  }

  const demo = (rows, key = 'name') => rows.filter((r) => String(r[key]).startsWith('Staging demo')).length;

  await t.test('a tier list: anyone adds, each ranks, the group\'s tier is where the average lands', async () => {
    await run('tier-list-restaurants', '/api/items', (d) => demo(d.items), async (app) => {
      const seeded = (await app.call('GET', '/api/items', { as: ada })).data;
      assert.deepEqual(seeded.items.find((i) => i.id === 900001).tier, 'S', 'the group\'s S row has an item');
      assert.equal(seeded.items.find((i) => i.id === 900005).tier, null, 'one nobody has ranked yet');
      // The board opens on Yours: whoever the check signs in as has ranked
      // nothing, so every item waits in the tray as a chip to drag.
      assert.ok(seeded.items.length > 0 && seeded.items.every((i) => i.yours === null), 'the check\'s tray has items');

      assert.equal((await app.call('POST', '/api/items', { as: ada, body: { name: '   ' } })).status, 400);
      const added = await app.call('POST', '/api/items', { as: ada, body: { name: '  Noodle   Bar ' } });
      assert.equal(added.status, 201);
      const id = added.data.id;
      const again = await app.call('POST', '/api/items', { as: grace, body: { name: 'noodle bar' } });
      assert.equal(again.status, 409, 'the same name twice is one item');
      assert.match(again.data.error, /is already on the list/);

      assert.equal((await app.call('PUT', `/api/items/${id}/tier`, { as: ada, body: { tier: 'Z' } })).status, 400);
      assert.equal((await app.call('PUT', '/api/items/999999/tier', { as: ada, body: { tier: 'S' } })).status, 404);
      await app.call('PUT', `/api/items/${id}/tier`, { as: ada, body: { tier: 'S' } });
      await app.call('PUT', `/api/items/${id}/tier`, { as: grace, body: { tier: 'B' } });
      let item = (await app.call('GET', '/api/items', { as: grace })).data.items.find((i) => i.id === id);
      assert.deepEqual([item.name, item.by, item.mine, item.votes, item.average, item.tier, item.yours],
        ['Noodle Bar', 'ada', false, 2, 4, 'A', 'B']);
      // A tie goes up: 4.5 is S.
      await app.call('PUT', `/api/items/${id}/tier`, { as: grace, body: { tier: 'A' } });
      item = (await app.call('GET', '/api/items', { as: ada })).data.items.find((i) => i.id === id);
      assert.deepEqual([item.average, item.tier, item.yours], [4.5, 'S', 'S']);
      // Tapping your tier again takes it back out.
      assert.deepEqual((await app.call('PUT', `/api/items/${id}/tier`, { as: ada, body: { tier: null } })).data, { tier: null });
      item = (await app.call('GET', '/api/items', { as: ada })).data.items.find((i) => i.id === id);
      assert.deepEqual([item.votes, item.tier, item.yours], [1, 'A', null]);

      assert.equal((await app.call('DELETE', `/api/items/${id}`, { as: grace })).status, 403, 'only whoever added it removes it');
      assert.equal((await app.call('DELETE', `/api/items/${id}`, { as: ada })).status, 200);
      assert.ok(!(await app.call('GET', '/api/items', { as: ada })).data.items.some((i) => i.id === id));
    });
  });

  await t.test('a grocery list: Todo List\'s rules for one shared list', async () => {
    // Production has no staging rows, so its first visitor is offered the
    // examples instead; a staging list already has rows, so it is not.
    const staged = (d) => {
      const n = demo(d.items, 'text');
      if (!n) {
        assert.deepEqual(d.items.map((i) => [i.text, i.checked, i.category_id]),
          [['Milk', false], ['Eggs', false], ['Coffee', false], ['Bread', true]].map((r) => r.concat(d.categories[0].id)),
          'a new list starts with a few examples in General, offered once');
      }
      return n;
    };
    await run('grocery-list', '/api/list', staged, async (app) => {
      const get = async (as = ada) => (await app.call('GET', '/api/list', { as })).data;
      const item = (list, id) => list.items.find((i) => i.id === id);
      let list = await get();
      const general = list.categories[0];
      assert.equal(general.is_default, true, 'General first');
      assert.deepEqual(list.categories.slice(1).map((c) => c.id), [900001, 900002, 900003]);
      assert.equal(list.list.due_dates_enabled, false);

      // Quick-add goes to the top of General; a retried add is the same item.
      const coffee = item(list, 900001);
      const oat = await app.call('POST', '/api/items', { as: ada, body: { text: ' Oat milk ', client_op_id: 'op-1' } });
      assert.equal(oat.status, 200);
      assert.deepEqual([oat.data.item.text, oat.data.item.category_id, oat.data.item.created_by], ['Oat milk', general.id, 'ada']);
      assert.ok(oat.data.item.sort_order < coffee.sort_order, 'at the top');
      const again = await app.call('POST', '/api/items', { as: ada, body: { text: 'Oat milk', client_op_id: 'op-1' } });
      assert.equal(again.data.item.id, oat.data.item.id, 'idempotent');
      assert.equal((await get()).items.filter((i) => i.text === 'Oat milk').length, 1);
      assert.equal((await app.call('POST', '/api/items', { as: ada, body: { text: '  ' } })).status, 400);

      // Into a category: its top.
      const lemons = (await app.call('POST', '/api/categories/900001/items', { as: ada, body: { text: 'Lemons' } })).data.item;
      assert.deepEqual([lemons.category_id, lemons.sort_order], [900001, 0]);
      assert.equal((await app.call('POST', '/api/categories/999/items', { as: ada, body: { text: 'x' } })).status, 404);

      // Ticking keeps the place and says who; the activity line is somebody else's.
      const ticked = (await app.call('PATCH', `/api/items/${lemons.id}`, { as: grace, body: { checked: true } })).data.item;
      assert.deepEqual([ticked.checked, ticked.last_checked_by, ticked.sort_order], [true, 'grace', 0]);
      list = await get();
      assert.deepEqual(list.activity, { actor: 'grace', verb: 'checked', text: 'Lemons' });
      assert.equal((await get(grace)).activity.actor !== 'grace', true, 'never your own');
      const order = list.items.map((i) => i.checked);
      assert.deepEqual(order, order.slice().sort((a, b) => a - b), 'open items first, then ticked');
      const unticked = (await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { checked: false } })).data.item;
      assert.deepEqual([unticked.checked, unticked.completed_at, unticked.last_checked_by, unticked.sort_order], [false, null, 'ada', 0]);

      // Edit, and move to another category: its end.
      assert.equal((await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { text: 'Limes' } })).data.item.text, 'Limes');
      assert.equal((await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { text: ' ' } })).status, 400);
      const moved = (await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { category_id: 900002 } })).data.item;
      assert.equal(moved.category_id, 900002);
      assert.ok(moved.sort_order > item(list, 900005).sort_order, 'at the end');
      assert.equal((await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { category_id: 999 } })).status, 400);
      assert.equal((await app.call('PATCH', '/api/items/999999', { as: ada, body: { text: 'x' } })).status, 404);

      // Due dates: wall-clock values, a time only with a date, off keeps them.
      assert.equal((await app.call('PATCH', '/api/list', { as: grace, body: { due_dates_enabled: true } })).status, 200);
      assert.equal((await get()).list.due_dates_enabled, true);
      assert.equal((await app.call('PATCH', '/api/list', { as: grace, body: {} })).status, 400);
      let due = (await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { due_date: '2026-10-10', due_time: '18:30' } })).data.item;
      assert.deepEqual([due.due_date, due.due_time], ['2026-10-10', '18:30']);
      assert.equal((await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { due_date: '10/10/2026' } })).status, 400);
      assert.equal((await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { due_time: '25:00' } })).status, 400);
      await app.call('PATCH', '/api/list', { as: grace, body: { due_dates_enabled: false } });
      assert.equal(item(await get(), lemons.id).due_date, '2026-10-10', 'switching due dates off keeps them');
      due = (await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { due_date: null } })).data.item;
      assert.deepEqual([due.due_date, due.due_time], [null, null], 'clearing the date clears the time');
      due = (await app.call('PATCH', `/api/items/${lemons.id}`, { as: ada, body: { due_time: '09:00' } })).data.item;
      assert.equal(due.due_time, null, 'no time without a date');

      // Removing says who removed what, after the item is gone.
      assert.equal((await app.call('DELETE', `/api/items/${oat.data.item.id}`, { as: grace })).status, 200, 'it is everyone\'s list');
      assert.equal((await app.call('DELETE', `/api/items/${oat.data.item.id}`, { as: grace })).status, 404);
      assert.deepEqual((await get()).activity, { actor: 'grace', verb: 'removed', text: 'Oat milk' });

      // Categories: add at the end, rename, reorder with General pinned.
      const bakery = (await app.call('POST', '/api/categories', { as: ada, body: { name: 'Bakery' } })).data.category;
      assert.equal(bakery.is_default, false);
      assert.equal((await app.call('POST', '/api/categories', { as: ada, body: { name: '' } })).status, 400);
      await app.call('PATCH', `/api/categories/${bakery.id}`, { as: grace, body: { name: 'Bread' } });
      const ids = [900003, bakery.id, general.id, 900001, 900002];
      assert.equal((await app.call('POST', '/api/categories/reorder', { as: ada, body: { categoryIds: ids } })).status, 200);
      list = await get();
      assert.deepEqual(list.categories.map((c) => c.id), [general.id, 900003, bakery.id, 900001, 900002]);
      assert.equal(list.categories[2].name, 'Bread');
      assert.equal((await app.call('POST', '/api/categories/reorder', { as: ada, body: { categoryIds: ['x'] } })).status, 400);

      // Reorder one section of a category by hand.
      await app.call('POST', '/api/categories/900001/reorder-items', { as: ada, body: { itemIds: [900004, 900002] } });
      list = await get();
      assert.deepEqual(list.items.filter((i) => i.category_id === 900001 && !i.checked).map((i) => i.id), [900004, 900002]);

      // Deleting a category deletes its items, and records each removal.
      assert.equal((await app.call('DELETE', '/api/categories/900002', { as: grace })).status, 200);
      list = await get();
      assert.ok(!list.items.some((i) => i.id === lemons.id || i.id === 900005));
      assert.equal(list.activity.verb, 'removed');

      // Markdown import: add merges by name (General is the General part);
      // replace starts again. The last category cannot go.
      const imported = await app.call('POST', '/api/import', { as: ada, body: { mode: 'add', categories: [
        { name: 'bread', items: [{ text: 'Sourdough' }, { text: 'Bagels', checked: true }] },
        { name: 'General', items: [{ text: 'Salt' }] },
      ] } });
      assert.equal(imported.status, 200);
      list = await get();
      assert.equal(list.categories.length, 4, 'nothing new: both merged');
      assert.deepEqual(list.items.filter((i) => i.category_id === bakery.id).map((i) => [i.text, i.checked]), [['Sourdough', false], ['Bagels', true]]);
      assert.ok(list.items.some((i) => i.text === 'Salt' && i.category_id === general.id));
      assert.equal((await app.call('POST', '/api/import', { as: ada, body: { categories: [] } })).status, 400);
      await app.call('POST', '/api/import', { as: ada, body: { mode: 'replace', categories: [{ name: 'General', items: [{ text: 'Only this' }] }] } });
      list = await get();
      assert.deepEqual([list.categories.length, list.categories[0].is_default, list.items.map((i) => i.text)], [1, true, ['Only this']]);
      const last = await app.call('DELETE', `/api/categories/${list.categories[0].id}`, { as: ada });
      assert.deepEqual([last.status, last.data.error], [400, "Can't delete the only category: a list needs at least one"]);
    });
  });

  await t.test('a chore list: always one person\'s or taking turns round the project\'s members, moving on every Monday', async () => {
    await run('chore-list', '/api/chores', (d) => demo(d.chores), async (app) => {
      const thursday = '2026-10-08T12:00:00Z';
      const nextMonday = '2026-10-12T09:00:00Z';
      const week = await app.call('GET', '/api/chores', { as: ada, now: thursday });
      assert.equal(week.data.week, '2026-10-05', 'the Monday of the week, UTC');
      assert.equal(week.data.rota, 'ok');
      assert.equal(week.data.people, 2);
      assert.deepEqual(week.data.members.map((m) => m.username), ['ada', 'grace'], 'the platform\'s member list, for the picker');
      const turning = week.data.chores.filter((c) => !c.fixed);
      assert.ok(turning.every((c) => c.turn === 'ada' || c.turn === 'grace'), 'only the project\'s members');
      assert.ok(turning.some((c) => c.turn === 'ada') && turning.some((c) => c.turn === 'grace'), 'shared out');
      const first = turning[0];
      assert.equal(first.yours, first.turn === 'ada');
      assert.equal(first.next, first.turn === 'ada' ? 'grace' : 'ada', 'next week is the next member');
      const plants = week.data.chores.find((c) => c.id === 900005);
      assert.deepEqual([plants.fixed, plants.turn, plants.next], [true, 'staging-demo-user', null], 'always the same person\'s');
      const later = await app.call('GET', '/api/chores', { as: ada, now: nextMonday });
      assert.equal(later.data.week, '2026-10-12');
      assert.equal(later.data.chores.find((c) => c.id === first.id).turn, first.next, 'on Monday it moves on');

      // Always Grace's, then taking turns again.
      const mow = await app.call('POST', '/api/chores', { as: ada, body: { name: 'Mow the lawn', assigneeId: 102 } });
      assert.equal(mow.status, 201);
      let chore = (await app.call('GET', '/api/chores', { as: ada, now: thursday })).data.chores.find((c) => c.id === mow.data.id);
      assert.deepEqual([chore.fixed, chore.turn, chore.yours], [true, 'grace', false]);
      chore = (await app.call('GET', '/api/chores', { as: grace, now: thursday })).data.chores.find((c) => c.id === mow.data.id);
      assert.equal(chore.yours, true);
      assert.equal((await app.call('POST', '/api/chores', { as: ada, body: { name: 'Bins', assigneeId: 103 } })).status, 400,
        'nobody outside the project gets a chore');
      await app.call('PATCH', `/api/chores/${mow.data.id}`, { as: grace, body: { name: 'Mow the lawn and edges', assigneeId: null } });
      chore = (await app.call('GET', '/api/chores', { as: ada, now: thursday })).data.chores.find((c) => c.id === mow.data.id);
      assert.deepEqual([chore.name, chore.fixed], ['Mow the lawn and edges', false]);
      assert.ok(chore.turn === 'ada' || chore.turn === 'grace');

      // Done this week only.
      assert.deepEqual((await app.call('PUT', `/api/chores/${mow.data.id}/done`, { as: grace, body: { done: true }, now: thursday })).data, { done: true });
      chore = (await app.call('GET', '/api/chores', { as: ada, now: thursday })).data.chores.find((c) => c.id === mow.data.id);
      assert.deepEqual([chore.done, chore.doneBy], [true, 'grace']);
      chore = (await app.call('GET', '/api/chores', { as: ada, now: nextMonday })).data.chores.find((c) => c.id === mow.data.id);
      assert.equal(chore.done, false, 'a new week starts undone');
      assert.equal((await app.call('PUT', '/api/chores/999999/done', { as: ada, body: { done: true } })).status, 404);

      // Somebody the platform does not count as a member sees the chores, not the rota.
      const outsider = await app.call('GET', '/api/chores', { as: sam });
      assert.equal(outsider.data.rota, 'not_member');
      assert.deepEqual(outsider.data.members, []);
      assert.ok(outsider.data.chores.filter((c) => !c.fixed).every((c) => c.turn === null && !c.yours));
      // The declared check's fixed rota, in staging and on ?demo=1 only.
      const fixed = await app.call('GET', '/api/chores?demo=1', { as: sam });
      assert.deepEqual([...new Set(fixed.data.chores.filter((c) => !c.fixed).map((c) => c.turn))].sort(), ['sam', 'staging-demo-ana', 'staging-demo-ben']);
      assert.ok(members.asked.every((u) => u === '/v1/members?limit=200'), 'one route, the conventions\' own');
      assert.equal((await app.call('DELETE', `/api/chores/${mow.data.id}`, { as: ada })).status, 200);
    });
  });

  await t.test('a lending library: who has it now, asking for it, handing it on, and back with its owner', async () => {
    await run('lending-library', '/api/things', (d) => demo(d.things), async (app) => {
      const seeded = (await app.call('GET', '/api/things', { as: ada })).data.things;
      assert.ok(seeded.some((x) => !x.atHome), 'one with somebody else');
      assert.ok(seeded.some((x) => x.asks.length), 'and one somebody asked for');

      const drill = await app.call('POST', '/api/things', { as: ada, body: { name: 'Drill', note: 'Bits in the case' } });
      assert.equal(drill.status, 201);
      const id = drill.data.id;
      const now = '2026-10-08T12:00:00.000Z';
      let thing = (await app.call('GET', '/api/things', { as: ada })).data.things.find((x) => x.id === id);
      assert.deepEqual([thing.atHome, thing.withMe, thing.mine, thing.holder], [true, true, true, 'ada'], 'it starts on your shelf');
      assert.equal((await app.call('POST', `/api/things/${id}/ask`, { as: ada })).status, 400, 'you have it already');

      // Grace and Sam ask; Ada hands it to Grace.
      assert.equal((await app.call('POST', `/api/things/${id}/ask`, { as: grace, now })).status, 201);
      assert.equal((await app.call('POST', `/api/things/${id}/ask`, { as: grace, now })).status, 201, 'asking again does nothing');
      await app.call('POST', `/api/things/${id}/ask`, { as: sam, now: '2026-10-08T13:00:00.000Z' });
      thing = (await app.call('GET', '/api/things', { as: ada })).data.things[0];
      assert.equal(thing.id, id, 'what you have and somebody asked for comes first');
      assert.deepEqual(thing.asks.map((a) => a.username), ['grace', 'sam'], 'first come, first served');
      assert.equal((await app.call('POST', `/api/things/${id}/hand`, { as: sam, body: { to: 102 } })).status, 403, 'not yours to hand on');
      assert.equal((await app.call('POST', `/api/things/${id}/hand`, { as: ada, body: { to: 999 } })).status, 400, 'only to somebody who asked');
      assert.equal((await app.call('POST', `/api/things/${id}/hand`, { as: ada, body: { to: 102 }, now })).status, 200);
      thing = (await app.call('GET', '/api/things', { as: grace })).data.things.find((x) => x.id === id);
      assert.deepEqual([thing.atHome, thing.withMe, thing.holder, thing.since, thing.asks.map((a) => a.username)],
        [false, true, 'grace', now, ['sam']], 'with Grace, and Sam is still in line');

      // Grace hands it on to Sam; Sam takes his ask back meanwhile is not needed.
      assert.equal((await app.call('POST', `/api/things/${id}/hand`, { as: grace, body: { to: 103 } })).status, 200);
      thing = (await app.call('GET', '/api/things', { as: sam })).data.things.find((x) => x.id === id);
      assert.deepEqual([thing.holder, thing.asks.length], ['sam', 0]);
      // Grace asks again, then takes it back.
      await app.call('POST', `/api/things/${id}/ask`, { as: grace });
      assert.equal((await app.call('DELETE', `/api/things/${id}/ask`, { as: grace })).status, 200);
      assert.equal((await app.call('GET', '/api/things', { as: grace })).data.things.find((x) => x.id === id).askedByMe, false);

      assert.equal((await app.call('DELETE', `/api/things/${id}`, { as: ada })).status, 403, 'not while somebody else has it');
      assert.equal((await app.call('POST', `/api/things/${id}/back`, { as: grace })).status, 403);
      assert.equal((await app.call('POST', `/api/things/${id}/back`, { as: ada })).status, 200, 'its owner says it is back');
      thing = (await app.call('GET', '/api/things', { as: ada })).data.things.find((x) => x.id === id);
      assert.equal(thing.atHome, true);
      assert.equal((await app.call('DELETE', `/api/things/${id}`, { as: grace })).status, 403, 'only its owner takes it out');
      assert.equal((await app.call('DELETE', `/api/things/${id}`, { as: ada })).status, 200);
    });
  });

  await t.test('a potluck planner: who brings what by course, coming up by "now"', async () => {
    await run('potluck-planner', '/api/potlucks', (d) => demo(d.upcoming, 'title'), async (app) => {
      const seeded = (await app.call('GET', '/api/potlucks', { as: ada })).data;
      const demoPotluck = seeded.upcoming.find((p) => p.id === 900001);
      assert.ok(demoPotluck.courses.some((c) => c.dishes.length), 'the check\'s dishes');
      assert.ok(demoPotluck.courses.some((c) => c.course !== 'Other' && !c.dishes.length), 'and a course nobody has taken');
      assert.ok(demoPotluck.messages.length, 'and its chat');

      const now = '2026-10-08T12:00:00.000Z';
      const startsAt = '2026-10-10T18:00:00.000Z';
      assert.equal((await app.call('POST', '/api/potlucks', { as: ada, body: { title: 'x', startsAt: 'soon' } })).status, 400);
      assert.equal((await app.call('POST', '/api/potlucks', { as: ada, body: { title: 'x', startsAt: '2026-10-01T18:00:00Z' }, now })).status, 400, 'not in the past');
      const plan = await app.call('POST', '/api/potlucks', { as: ada, body: { title: 'Harvest potluck', startsAt, place: 'Ada\'s place' }, now });
      assert.equal(plan.status, 201);
      const id = plan.data.id;
      assert.equal((await app.call('POST', `/api/potlucks/${id}/dishes`, { as: grace, body: { course: 'Snacks', dish: 'Crisps' } })).status, 400);
      const pie = await app.call('POST', `/api/potlucks/${id}/dishes`, { as: grace, body: { course: 'Desserts', dish: 'Apple pie' } });
      assert.equal(pie.status, 201);
      await app.call('POST', `/api/potlucks/${id}/dishes`, { as: sam, body: { course: 'Mains', dish: 'Chili' } });

      let p = (await app.call('GET', '/api/potlucks', { as: grace, now })).data.upcoming.find((x) => x.id === id);
      assert.deepEqual([p.title, p.startsAt, p.place, p.host, p.mine, p.dishes], ['Harvest potluck', startsAt, 'Ada\'s place', 'ada', false, 2]);
      assert.deepEqual(p.messages, [], 'a new potluck\'s chat is empty');
      const desserts = p.courses.find((c) => c.course === 'Desserts');
      assert.deepEqual(desserts.dishes.map((d) => [d.dish, d.by, d.mine, d.canRemove]), [['Apple pie', 'grace', true, true]]);
      assert.deepEqual(p.courses.map((c) => c.course), ['Mains', 'Sides', 'Salads', 'Desserts', 'Drinks', 'Other']);
      // Coming up until six hours after it starts, then past.
      const after = (await app.call('GET', '/api/potlucks', { as: ada, now: '2026-10-10T22:00:00Z' })).data;
      assert.ok(after.upcoming.some((x) => x.id === id), 'still on that evening');
      const gone = (await app.call('GET', '/api/potlucks', { as: ada, now: '2026-10-12T12:00:00Z' })).data;
      assert.ok(!gone.upcoming.some((x) => x.id === id) && gone.past.some((x) => x.id === id), 'then past');

      // Reactions toggle; comments and the chat are kept in order.
      assert.equal((await app.call('POST', `/api/dishes/${pie.data.id}/reactions`, { as: ada, body: { emoji: '🍕' } })).status, 400);
      assert.deepEqual((await app.call('POST', `/api/dishes/${pie.data.id}/reactions`, { as: ada, body: { emoji: '😋' } })).data, { on: true });
      await app.call('POST', `/api/dishes/${pie.data.id}/reactions`, { as: sam, body: { emoji: '😋' } });
      await app.call('POST', `/api/dishes/${pie.data.id}/reactions`, { as: sam, body: { emoji: '🔥' } });
      assert.deepEqual((await app.call('POST', `/api/dishes/${pie.data.id}/reactions`, { as: sam, body: { emoji: '🔥' } })).data, { on: false }, 'again takes it back');
      assert.equal((await app.call('POST', `/api/dishes/${pie.data.id}/comments`, { as: ada, body: { text: ' ' } })).status, 400);
      await app.call('POST', `/api/dishes/${pie.data.id}/comments`, { as: ada, body: { text: 'Is it the one with cinnamon?' }, now });
      await app.call('POST', `/api/dishes/${pie.data.id}/comments`, { as: grace, body: { text: 'Yes!' }, now: '2026-10-08T12:05:00.000Z' });
      assert.equal((await app.call('POST', `/api/potlucks/${id}/messages`, { as: sam, body: { text: '' } })).status, 400);
      await app.call('POST', `/api/potlucks/${id}/messages`, { as: sam, body: { text: 'Who has a big table?' }, now });
      await app.call('POST', `/api/potlucks/${id}/messages`, { as: ada, body: { text: 'Mine folds out' }, now: '2026-10-08T12:01:00.000Z' });
      assert.equal((await app.call('POST', '/api/potlucks/999999/messages', { as: ada, body: { text: 'hi' } })).status, 404);
      p = (await app.call('GET', '/api/potlucks', { as: grace, now })).data.upcoming.find((x) => x.id === id);
      const pieNow = p.courses.find((c) => c.course === 'Desserts').dishes[0];
      assert.deepEqual(pieNow.reactions.map((r) => [r.emoji, r.count, r.mine, r.people]), [['😋', 2, false, ['ada', 'sam']]]);
      assert.deepEqual(pieNow.comments.map((c) => [c.by, c.text, c.mine]), [['ada', 'Is it the one with cinnamon?', false], ['grace', 'Yes!', true]]);
      assert.deepEqual(p.messages.map((m) => [m.by, m.text]), [['sam', 'Who has a big table?'], ['ada', 'Mine folds out']], 'oldest first');

      const chili = p.courses.find((c) => c.course === 'Mains').dishes.find((d) => d.dish === 'Chili');
      assert.equal((await app.call('DELETE', `/api/dishes/${chili.id}`, { as: grace })).status, 403, 'not somebody else\'s dish');
      assert.equal((await app.call('DELETE', `/api/dishes/${chili.id}`, { as: ada })).status, 200, 'the host can');
      assert.equal((await app.call('DELETE', `/api/potlucks/${id}`, { as: grace })).status, 403, 'only the host calls it off');
      assert.equal((await app.call('DELETE', `/api/potlucks/${id}`, { as: ada })).status, 200);
      p = (await app.call('GET', '/api/potlucks', { as: ada, now })).data.upcoming.find((x) => x.id === id);
      assert.equal(p, undefined);
    });
  });

  // ── The game starters ──────────────────────────────────────────────────

  // Nobody without a token, nor with another app's, gets a live connection.
  async function refusesStrangers(app) {
    for (const bad of [null, token(101, 'ada', 'usernode:app:999'), 'not-a-token']) {
      await assert.rejects(liveOf(app, bad).opened, (err) => err.status === 401, String(bad && bad.slice(0, 8)));
    }
  }

  await t.test('a board game: the lobby, turns over the live connection, a roll made for somebody away, a winner kept', async () => {
    const roomCount = (d) => d.players.length + d.leaders.length;
    await run('game-board', '/api/room', roomCount, async (app) => {
      await refusesStrangers(app);
      const a = liveOf(app, ada);
      let first = a.next(isView());
      await a.opened;
      let v = (await first).view;
      assert.deepEqual([v.phase, v.players.map((p) => p.username), v.you.joined], ['lobby', ['staging-demo-ana'], false]);
      assert.deepEqual(v.leaders.map((l) => [l.username, l.wins]), [['staging-demo-ana', 1], ['staging-demo-user', 1]]);
      let p = a.next(isView((x) => x.players.length === 2));
      a.send({ t: 'join' });
      await p;
      // A plain request is the same room, and the socket hears it.
      p = a.next(isView((x) => x.players.length === 3));
      assert.equal((await app.call('POST', '/api/room/join', { as: grace })).status, 200);
      v = (await p).view;
      assert.deepEqual(v.players.map((x) => [x.username, x.here]), [['staging-demo-ana', false], ['ada', true], ['grace', true]]);
      p = a.next(isView((x) => x.phase === 'playing'));
      a.send({ t: 'start' });
      v = (await p).view;
      assert.equal(v.game.order[v.game.turn], 900001, 'the first seat starts');
      p = a.next((m) => m.t === 'error');
      a.send({ t: 'act', action: { type: 'roll' } });
      assert.equal((await p).error, 'It is not your turn yet.');
      v = (await a.next(isView((x) => x.game && x.game.rollNo >= 1))).view;
      assert.match(v.game.log[0].text, /^@staging-demo-ana rolled \d \(rolled for them\)/, 'away: rolled for her');
      assert.equal((await app.call('POST', '/api/room/act', { as: sam, body: { action: { type: 'roll' } } })).status, 409, 'watching, not playing');
      a.close();
    });
    // A game to its winner, on a fresh production room, kept across a restart.
    const dir = writeRepo('game-board');
    dirs.push(dir);
    const db = await database();
    let prod = await boot(dir, db, 'production', env);
    const a = liveOf(prod, ada);
    await a.opened;
    let p = a.next(isView((x) => x.players.length === 1));
    a.send({ t: 'join' });
    await p;
    p = a.next(isView((x) => x.phase === 'playing'));
    a.send({ t: 'start' });
    await p;
    let over = null;
    for (let i = 0; i < 80 && !over; i += 1) {
      p = a.next(isView((x) => x.game && x.game.rollNo === i + 1));
      a.send({ t: 'act', action: { type: 'roll' } });
      const after = (await p).view;
      if (after.phase === 'over') over = after;
      else if (after.game.winner != null) over = (await a.next(isView((x) => x.phase === 'over'))).view;
    }
    assert.ok(over, 'somebody reaches the finish');
    assert.deepEqual(over.results.map((r) => [r.username, r.place, r.score]), [['ada', 1, 30]]);
    const leaders = (await a.next(isView((x) => x.leaders.length === 1))).view.leaders;
    assert.deepEqual(leaders.map((l) => [l.username, l.wins, l.played]), [['ada', 1, 1]]);
    a.close();
    await new Promise((r) => setTimeout(r, 600)); // the room saves a moment after a change
    assert.equal(await prod.stop(), 0, prod.output());
    prod = await boot(dir, db, 'production', env);
    const back = (await prod.call('GET', '/api/room', { as: ada })).data;
    assert.deepEqual([back.phase, back.players.map((x) => x.username), back.leaders.length], ['over', ['ada'], 1], 'saved across a restart');
    assert.equal((await prod.call('POST', '/api/room/again', { as: ada })).data.phase, 'lobby');
    assert.equal(await prod.stop(), 0);
  });

  await t.test('trivia: questions about each other, the answer hidden until it shows, scored live', async () => {
    const roomCount = (d) => d.players.length + d.leaders.length;
    await run('game-trivia', '/api/room', roomCount, async (app) => {
      await refusesStrangers(app);
      // The bank: your own questions in full, everyone else's only counted.
      assert.equal((await app.call('POST', '/api/questions', { as: grace, body: { text: 'My first job?', answer: 'Baker', wrong: [] } })).status, 400);
      assert.equal((await app.call('POST', '/api/questions', { as: grace, body: { text: 'My first job?', answer: 'Baker', wrong: ['baker'] } })).status, 400, 'every answer different');
      const q = await app.call('POST', '/api/questions', { as: grace, body: { text: 'My first job?', answer: 'Baker', wrong: ['Lifeguard', 'Paper round'] } });
      assert.equal(q.status, 201);
      const graceBank = (await app.call('GET', '/api/questions', { as: grace })).data;
      assert.deepEqual(graceBank.mine.map((x) => [x.text, x.answer, x.wrong]), [['My first job?', 'Baker', ['Lifeguard', 'Paper round']]]);
      const adaBank = (await app.call('GET', '/api/questions', { as: ada })).data;
      assert.deepEqual(adaBank.mine, []);
      assert.ok(!JSON.stringify(adaBank).includes('Baker'), 'nobody else sees the answer');
      assert.equal((await app.call('GET', '/api/questions')).status, 401);
      // A game: everyone here answers, then the answer shows with the points.
      const a = liveOf(app, ada);
      const g = liveOf(app, grace);
      await Promise.all([a.opened, g.opened]);
      let p = a.next(isView((x) => x.players.length === 3));
      a.send({ t: 'join' });
      g.send({ t: 'join' });
      await p;
      p = a.next(isView((x) => x.phase === 'playing'));
      a.send({ t: 'start' });
      let v = (await p).view;
      assert.equal(v.game.of, 6, 'every question in the bank, up to eight');
      assert.equal(v.game.question.correct, null, 'not before it shows');
      const author = v.game.question.authorId;
      const answers = [[a, 101], [g, 102]].filter(([, id]) => id !== author);
      if (answers.length < 2) {
        p = g.next((m) => m.t === 'error');
        g.send({ t: 'act', action: { type: 'answer', choice: 0 } });
        assert.match((await p).error, /about you/);
      }
      p = a.next(isView((x) => x.game && x.game.stage === 'reveal'));
      for (const [s] of answers) s.send({ t: 'act', action: { type: 'answer', choice: 0 } });
      v = (await p).view;
      assert.equal(typeof v.game.question.correct, 'number', 'it shows once everyone here answered');
      assert.equal(Object.keys(v.game.picks).length, answers.length);
      const right = Object.entries(v.game.picks).filter(([, c]) => c === v.game.question.correct).map(([id]) => Number(id));
      for (const id of right) assert.ok(v.game.points[id] >= 100, 'a right answer scores');
      a.close();
      g.close();
      assert.equal((await app.call('DELETE', `/api/questions/${q.data.id}`, { as: ada })).status, 404, 'only its author');
      assert.equal((await app.call('DELETE', `/api/questions/${q.data.id}`, { as: grace })).status, 200);
    });
  });

  await t.test('the space game: a run ticks live, ships fly by their own page, and the run is kept when it ends', async () => {
    await run('game-space', '/api/room', (d) => d.leaders.length, async (app) => {
      await refusesStrangers(app);
      const a = liveOf(app, ada);
      await a.opened;
      let p = a.next(isView((x) => x.players.length === 1));
      a.send({ t: 'join' });
      await p;
      p = a.next(isView((x) => x.phase === 'playing'));
      a.send({ t: 'start' });
      const v = (await p).view;
      const ship = v.game.ships.find((s) => s[0] === 101);
      // Frames arrive about twenty times a second.
      let frames = 0;
      const started = Date.now();
      while (Date.now() - started < 1000) {
        // eslint-disable-next-line no-await-in-loop
        await a.next((m) => m.t === 'frame');
        frames += 1;
      }
      assert.ok(frames >= 12, `${frames} frames in a second`);
      // A storm is the numbers every page works its sparks out from.
      const stormy = await a.next((m) => m.t === 'frame' && m.frame.storms.length);
      assert.ok(['interval', 'n', 'v', 'a0'].every((k) => k in stormy.frame.storms[0]));
      a.send({ t: 'input', input: { x: ship[1] + 15, y: ship[2] - 5 } });
      const moved = await a.next((m) => m.t === 'frame' && m.frame.ships.some((s) => s[0] === 101 && s[1] === ship[1] + 15 && s[2] === ship[2] - 5));
      assert.ok(moved, 'the server takes the page\'s word for where its ship is');
      a.send({ t: 'input', input: { x: ship[1] + 315, y: ship[2] - 5 } });
      const later = await a.next((m) => m.t === 'frame');
      assert.equal(later.frame.ships.find((s) => s[0] === 101)[1], ship[1] + 15, 'but not a jump');
      // Its page saw a spark touch it: a shield goes, and everyone hears.
      await a.next((m) => m.t === 'frame' && m.frame.now > m.frame.ships.find((s) => s[0] === 101)[5]);
      const p2 = a.next((m) => m.t === 'event');
      a.send({ t: 'act', action: { type: 'hit' } });
      assert.deepEqual((await p2).event, { type: 'hit', id: 101, shields: 2 });
      // Grace drops in mid-run; then both leave and the run is over and kept.
      assert.equal((await app.call('POST', '/api/room/join', { as: grace })).status, 200);
      const both = await a.next((m) => m.t === 'frame' && m.frame.ships.length === 2);
      assert.ok(both);
      p = a.next(isView((x) => x.phase === 'over'));
      await app.call('POST', '/api/room/leave', { as: grace });
      a.send({ t: 'leave' });
      const over = (await p).view;
      assert.deepEqual(over.results.map((r) => r.username).sort(), ['ada', 'grace'], 'everyone who flew');
      const kept = await a.next(isView((x) => x.leaders.some((l) => l.username === 'ada')));
      assert.ok(kept);
      a.close();
    });
  });

  await t.test('the block world: always on, every block sent to everyone as it is placed, and checked', async () => {
    await run('game-blocks', '/api/room', (d) => (d.game ? d.game.count : 0), async (app) => {
      await refusesStrangers(app);
      const a = liveOf(app, ada);
      const g = liveOf(app, grace);
      const first = a.next(isView());
      await Promise.all([a.opened, g.opened]);
      const v = (await first).view;
      assert.equal(v.phase, 'playing', 'no lobby');
      assert.ok(v.game.blocks.length > 50, 'the staging demo world');
      const empty = [5, 0, 25];
      assert.ok(!v.game.blocks.some((b) => b[0] === empty[0] && b[1] === empty[1] && b[2] === empty[2]));
      let p = g.next((m) => m.t === 'event');
      a.send({ t: 'act', action: { type: 'place', x: empty[0], y: empty[1], z: empty[2], c: 4 } });
      assert.deepEqual((await p).event, { type: 'place', x: 5, y: 0, z: 25, c: 4, by: 'ada' }, 'grace sees it at once');
      p = g.next((m) => m.t === 'error');
      g.send({ t: 'act', action: { type: 'place', x: 5, y: 0, z: 25, c: 1 } });
      assert.match((await p).error, /already/);
      g.send({ t: 'act', action: { type: 'place', x: 99, y: 0, z: 0, c: 1 } });
      assert.match((await g.next((m) => m.t === 'error')).error, /outside/);
      // Where ada is flying shows on grace's screen.
      a.send({ t: 'input', input: { x: 6.5, y: 3, z: 25, yaw: 1.25, c: 2 } });
      const there = await g.next((m) => m.t === 'frame' && m.frame.builders.length);
      assert.deepEqual(there.frame.builders[0], [101, 'ada', 6.5, 3, 25, 1.25, 2]);
      const room = (await app.call('GET', '/api/room', { as: grace })).data;
      assert.ok(room.game.blocks.some((b) => b.join() === '5,0,25,4'), 'a plain request sees the same world');
      assert.equal((await app.call('POST', '/api/room/act', { as: grace, body: { action: { type: 'remove', x: 5, y: 0, z: 25 } } })).status, 200);
      assert.equal((await app.call('POST', '/api/room/act', { body: { action: { type: 'remove', x: 6, y: 0, z: 25 } } })).status, 401, 'no account, no building');
      a.close();
      g.close();
    });
  });
});
