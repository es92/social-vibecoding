// #2684: the Homeroom bot's admin dashboard — routes and surface.
//
// The four endpoints under /api/admin/homeroom-bot against a mocked pool:
// the read is open to a view-only admin, the three writes are not; the
// settings route refuses `live` (this slice only triages); the rating and
// "run now" routes validate what they are given. Then the surface pins:
// the section is registered in every place the console reads, the module
// stays inside the admin registry's rules, and dapp.json exercises it.
//
// Run with: node --test tests/admin-homeroom-bot.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// ── A stateful mock of what the service reads and writes ────────────────

const settings = new Map([['homeroom_bot_mode', 'off']]);
const writes = [];
let runRow = { id: 41, rating: null, rating_note: null, rated_at: null };
// Whether the bot's users row exists yet: the dashboard creates it on load
// when it does not, so the cap box is never blank (#2684 follow-up).
let botExists = true;

const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  async query(sql, params) {
    const s = String(sql);
    if (/SELECT key, value FROM platform_settings/.test(s)) {
      return { rows: [...settings.entries()].map(([key, value]) => ({ key, value })) };
    }
    if (/INSERT INTO platform_settings/.test(s)) { settings.set(params[0], params[1]); writes.push(['setting', params[0], params[1]]); return { rows: [] }; }
    if (/UPDATE users SET weekly_limit_cents/.test(s)) { writes.push(['cap', params[0]]); return { rows: [] }; }
    if (/INSERT INTO users/.test(s)) { botExists = true; writes.push(['bot-user', params[0]]); return { rows: [] }; }
    if (/SELECT is_synthetic FROM users/.test(s)) return { rows: [{ is_synthetic: true }] };
    if (/FROM users WHERE username = \$1/.test(s)) {
      return { rows: botExists ? [{ id: 77, username: 'homeroom_bot', weekly_limit_cents: 15000 }] : [] };
    }
    if (/COUNT\(\*\)::int AS runs/.test(s)) return { rows: [{ runs: 3, questions: 1, ready: 1, person: 1, failed: 0, rated: 2, agreed: 1, suppressed: 0, cost_usd: 0.12 }] };
    if (/FROM homeroom_bot_queue q JOIN apps/.test(s)) return { rows: [] };
    if (/COUNT\(\*\)::int AS depth/.test(s)) return { rows: [{ depth: 4 }] };
    if (/FROM homeroom_bot_runs r/.test(s)) {
      return { rows: [{ id: 41, issue_number: 12, verdict: 'question', app_slug: 'todo', app_name: 'Todo', repo_url: 'https://github.com/usernode-bot/todo', created_at: '2026-09-21T00:00:00Z' }] };
    }
    if (/SELECT slug, name FROM apps/.test(s)) return { rows: [{ slug: 'todo', name: 'Todo' }] };
    if (/UPDATE homeroom_bot_runs/.test(s)) {
      if (params[0] !== 41) return { rows: [] };
      runRow = { ...runRow, rating: params[1], rating_note: params[3], rated_at: params[1] ? 'now' : null };
      writes.push(['rating', params[0], params[1], params[2]]);
      return { rows: [runRow] };
    }
    if (/SELECT id, slug FROM apps WHERE slug/.test(s)) {
      return { rows: params[0] === 'todo' ? [{ id: 9, slug: 'todo' }] : [] };
    }
    if (/INSERT INTO homeroom_bot_queue/.test(s)) {
      writes.push(['enqueue', params[0], params[1], params[2]]);
      return { rows: [{ id: 5, app_id: params[0], issue_number: params[1], priority: 0, reason: 'admin', enqueued_at: 'now' }] };
    }
    // limits.getWeeklySpentCents / usesIncludedKey and the like: nothing.
    return { rows: [] };
  },
});

const { adminRoutes } = require('../src/routes/admin');
const express = require('express');

const NORMAL = { id: 2, username: 'pat', isAdmin: false, canAdminWrite: false };
const VIEW_ADMIN = { id: 3, username: 'viewer', isAdmin: true, canAdminWrite: false };
const FULL_ADMIN = { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true };

let server;
let base;
let who = FULL_ADMIN;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use(adminRoutes({ jwtSecret: 'test', openrouterDefaultCodexModel: 'z-ai/glm-5.3-flash' }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const call = (method, url, body) => fetch(`${base}${url}`, {
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('GET /api/admin/homeroom-bot: a view-only admin reads the whole dashboard; a non-admin cannot', async () => {
  who = VIEW_ADMIN;
  const res = await call('GET', '/api/admin/homeroom-bot?app=todo&verdict=question');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.settings.mode, 'off');
  assert.deepEqual(data.modes, ['off', 'shadow', 'live']);
  assert.equal(data.bot.username, 'homeroom_bot');
  assert.equal(data.bot.weeklyLimitCents, 15000);
  assert.equal(data.bot.model, 'z-ai/glm-5.3-flash');
  assert.equal(data.totals.runs, 3);
  assert.equal(data.queue.depth, 4);
  assert.equal(data.runs.length, 1);
  assert.equal(data.runs[0].issueUrl, 'https://github.com/usernode-bot/todo/issues/12');
  assert.deepEqual(data.caps, { proposalsPerApp: 2, questionsPerAppPerDay: 10 });

  // adminMiddleware sends a non-admin back to the shell (a redirect, since
  // the mounted router sees a path without the /api prefix).
  who = NORMAL;
  const denied = await fetch(`${base}/api/admin/homeroom-bot`, { redirect: 'manual' });
  assert.ok(denied.status === 302 || denied.status === 403, `non-admin is turned away (${denied.status})`);
  who = FULL_ADMIN;
});

test('GET creates the bot user when it does not exist yet, so the cap is never blank', async () => {
  botExists = false;
  writes.length = 0;
  const res = await call('GET', '/api/admin/homeroom-bot');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(writes.some((w) => w[0] === 'bot-user' && w[1] === 'homeroom_bot'), 'the users row is created on load');
  assert.equal(data.bot.username, 'homeroom_bot');
  assert.equal(data.bot.weeklyLimitCents, 15000);
});

test('PUT settings: refused for a view-only admin, refuses live, accepts shadow and a cap', async () => {
  who = VIEW_ADMIN;
  let res = await call('PUT', '/api/admin/homeroom-bot/settings', { mode: 'shadow' });
  assert.equal(res.status, 403);
  who = FULL_ADMIN;

  res = await call('PUT', '/api/admin/homeroom-bot/settings', { mode: 'live' });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /shadow mode/);
  assert.equal(settings.get('homeroom_bot_mode'), 'off', 'a refused patch writes nothing');

  res = await call('PUT', '/api/admin/homeroom-bot/settings', { batchSize: 0 });
  assert.equal(res.status, 400);
  res = await call('PUT', '/api/admin/homeroom-bot/settings', { batchSize: 501 });
  assert.equal(res.status, 400);
  res = await call('PUT', '/api/admin/homeroom-bot/settings', { batchSize: 100 });
  assert.equal(res.status, 200, 'the default is 100 and the ceiling 500');
  res = await call('PUT', '/api/admin/homeroom-bot/settings', {});
  assert.equal(res.status, 400);

  writes.length = 0;
  res = await call('PUT', '/api/admin/homeroom-bot/settings', { mode: 'shadow', weeklyLimitCents: 20000, pausedApps: ['todo'] });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.settings.mode, 'shadow', 'the response is the refreshed dashboard');
  assert.deepEqual(data.settings.pausedApps, ['todo']);
  assert.ok(writes.some((w) => w[0] === 'setting' && w[1] === 'homeroom_bot_mode' && w[2] === 'shadow'));
  assert.ok(writes.some((w) => w[0] === 'cap' && w[1] === 20000), 'the cap lands on the bot users row');
});

test('POST rating: validates, 404s an unknown run, records yes/no and clears', async () => {
  who = VIEW_ADMIN;
  let res = await call('POST', '/api/admin/homeroom-bot/runs/41/rating', { rating: 'yes' });
  assert.equal(res.status, 403);
  who = FULL_ADMIN;

  res = await call('POST', '/api/admin/homeroom-bot/runs/41/rating', { rating: 'maybe' });
  assert.equal(res.status, 400);
  res = await call('POST', '/api/admin/homeroom-bot/runs/abc/rating', { rating: 'yes' });
  assert.equal(res.status, 400);
  res = await call('POST', '/api/admin/homeroom-bot/runs/999/rating', { rating: 'yes' });
  assert.equal(res.status, 404);

  writes.length = 0;
  res = await call('POST', '/api/admin/homeroom-bot/runs/41/rating', { rating: 'no', note: 'asked what the code already says' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).run.rating, 'no');
  assert.deepEqual(writes[0], ['rating', 41, 'no', 1], 'recorded with the rating admin');

  res = await call('POST', '/api/admin/homeroom-bot/runs/41/rating', { rating: null });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).run.rating, null);
});

test('POST run: validates the target, 404s an unknown app, and queues at the head', async () => {
  who = VIEW_ADMIN;
  let res = await call('POST', '/api/admin/homeroom-bot/run', { slug: 'todo', issueNumber: 12 });
  assert.equal(res.status, 403);
  who = FULL_ADMIN;

  res = await call('POST', '/api/admin/homeroom-bot/run', { slug: 'todo', issueNumber: 0 });
  assert.equal(res.status, 400);
  res = await call('POST', '/api/admin/homeroom-bot/run', { slug: 'Nope!', issueNumber: 1 });
  assert.equal(res.status, 400);
  res = await call('POST', '/api/admin/homeroom-bot/run', { slug: 'missing', issueNumber: 1 });
  assert.equal(res.status, 404);

  writes.length = 0;
  res = await call('POST', '/api/admin/homeroom-bot/run', { slug: 'todo', issueNumber: 12 });
  assert.equal(res.status, 202);
  const data = await res.json();
  assert.equal(data.item.priority, 0);
  assert.deepEqual(writes[0], ['enqueue', 9, 12, 1]);
});

// ── Surface pins ─────────────────────────────────────────────────────────

test('the write gates are on the three mutations and off the read', () => {
  const admin = read('src/routes/admin.js');
  assert.match(admin, /router\.get\('\/api\/admin\/homeroom-bot', async/);
  assert.match(admin, /router\.put\('\/api\/admin\/homeroom-bot\/settings', requireAdminWrite,/);
  assert.match(admin, /router\.post\('\/api\/admin\/homeroom-bot\/runs\/:id\/rating', requireAdminWrite,/);
  assert.match(admin, /router\.post\('\/api\/admin\/homeroom-bot\/run', requireAdminWrite, drainGuard,/);
});

test('the section is registered everywhere the console reads, inside the registry rules', () => {
  const consoleJs = read('frontend/src/features/admin/admin-console.js');
  const sectionBlock = consoleJs.slice(consoleJs.indexOf('SECTIONS: ['), consoleJs.indexOf('isOpen()'));
  assert.match(sectionBlock, /\{ key: 'homeroom-bot', label: 'Homeroom bot', group: 'Platform' \}/);
  assert.match(consoleJs, /'homeroom-bot': 'AdminHomeroomBot'/);
  const sections = read('frontend/src/features/admin/sections.ts');
  assert.ok(sections.includes("import './admin-homeroom-bot.tsx';"), 'the barrel imports the module');

  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.ok(!/from '@\/components\/ui\//.test(tsx), 'the console never reaches for the shell primitives');
  assert.match(tsx, /window as any\)\.AdminHomeroomBot = AdminHomeroomBot/);
  assert.match(tsx, /canWrite\(\)/, 'the writes are gated in the UI too');
  assert.ok(!/target="_blank"/.test(tsx), 'nothing in the console opens a new tab');
  assert.match(tsx, /<option value="live" disabled>/, 'live is shown but not offered');
});

test('dapp.json exercises the dashboard on ids the module renders', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  const ours = dapp.tests.filter((t) => t.path === '/#admin/homeroom-bot');
  assert.ok(ours.length >= 2, 'at least two checks on the section');
  for (const t of ours) {
    const id = (t.expectSelector.match(/#([a-z0-9-]+)/) || [])[1];
    assert.ok(id && tsx.includes(`id="${id}"`), `${t.expectSelector} is rendered by the module`);
  }
});
