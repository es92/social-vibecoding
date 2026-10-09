// #2684: the Homeroom bot's admin dashboard — routes and surface.
//
// The five endpoints under /api/admin/homeroom-bot against a mocked pool:
// the read is open to a view-only admin, the three writes are not; the
// settings route refuses `live` (this slice only triages); the rating and
// "run now" routes validate what they are given. #2726 added the fifth, the
// CSV export: write-gated like a mutation though it only reads, streamed,
// filtered by whatever the table is showing, and quoted against the
// spreadsheet formula trick. Then the surface pins: the section is
// registered in every place the console reads, the module stays inside the
// admin registry's rules, and dapp.json exercises it.
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
// The ledger the runs query reads: one ordinary row, one carrying every
// shape the CSV has to survive (a comma, a quote, a newline, and a leading
// `=` a spreadsheet would otherwise run as a formula).
const runLedger = [
  {
    id: 41, issue_number: 12, verdict: 'question', app_slug: 'todo', app_name: 'Todo',
    repo_url: 'https://github.com/usernode-bot/todo', created_at: '2026-09-21T00:00:00Z',
    mode: 'shadow', determined: false, missing_fact: 'which screen', question: 'Which screen?',
    question_default: 'the board', model: 'z-ai/glm-5.3-flash', cost_usd: 0.01,
  },
  {
    id: 40, issue_number: 11, verdict: 'ready', app_slug: 'todo', app_name: 'Todo',
    repo_url: 'https://github.com/usernode-bot/todo.git', created_at: '2026-09-20T00:00:00Z',
    mode: 'shadow', determined: true, missing_fact: 'none',
    build_note: 'Edit a,b\nthen "c"', rating: 'yes', rated_by: 'admin',
    rating_note: '=SUM(A1)', cost_usd: 0.02,
  },
];
const exportPages = [];
// Every parameter list the runs query is called with, so a filter can be
// checked where it is applied rather than by reading the rows back.
const runsParams = [];
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
      runsParams.push(params);
      // [app, verdict, cursor, limit] — the export walks the cursor, so the
      // mock answers from a fixture ledger the way Postgres would.
      const [app, verdict, cursor, limit] = params;
      exportPages.push({ app, verdict, cursor, limit });
      const rows = runLedger
        .filter((r) => (!app || r.app_slug === app))
        .filter((r) => (!verdict || r.verdict === verdict))
        .filter((r) => (cursor == null || r.id < cursor))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
      return { rows };
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
  assert.deepEqual(data.caps, { proposalsPerApp: 5, proposalsTotal: 100, questionsPerAppPerDay: 10 });
  assert.deepEqual(data.pairsWaiting, { first_version: 0, later: 0 }, 'the configurations\' pairs waiting, per scope');

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

  // #2737: the per-turn budget is admin-settable and bounded.
  res = await call('PUT', '/api/admin/homeroom-bot/settings', { turnSeconds: 5 });
  assert.equal(res.status, 400, 'a turn budget below the floor is refused');
  res = await call('PUT', '/api/admin/homeroom-bot/settings', { turnInputTokens: 10 });
  assert.equal(res.status, 400, 'so is a token budget below the floor');
  res = await call('PUT', '/api/admin/homeroom-bot/settings', { turnSeconds: 1200, turnInputTokens: 10_000_000 });
  assert.equal(res.status, 200);
  assert.ok(writes.some((w) => w[0] === 'setting' && w[1] === 'homeroom_bot_turn_seconds' && w[2] === '1200'));
  assert.ok(writes.some((w) => w[0] === 'setting' && w[1] === 'homeroom_bot_turn_input_tokens' && w[2] === '10000000'));
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

test('GET: verdict=budget selects the runs the bot stopped itself', async () => {
  who = FULL_ADMIN;
  runsParams.length = 0;
  let res = await call('GET', '/api/admin/homeroom-bot?verdict=budget');
  assert.equal(res.status, 200);
  assert.equal(runsParams.at(-1)[4], true, 'the budget-only flag is set');
  assert.equal(runsParams.at(-1)[1], null, 'and it is not passed off as a verdict');

  res = await call('GET', '/api/admin/homeroom-bot?verdict=failed');
  assert.equal(runsParams.at(-1)[4], false, 'an ordinary verdict leaves it off');
  assert.equal(runsParams.at(-1)[1], 'failed');

  res = await call('GET', '/api/admin/homeroom-bot?verdict=nonsense');
  assert.equal(runsParams.at(-1)[1], null, 'and an unknown one still selects everything');
  assert.equal(runsParams.at(-1)[4], false);
});

test('the CSV filename says when it holds only budget stops', async () => {
  who = FULL_ADMIN;
  const res = await call('GET', '/api/admin/homeroom-bot/export.csv?verdict=budget');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /homeroom-bot-verdicts-all-apps-budget-stops-/);
  assert.ok((await res.text()).split('\n')[0].split(',').includes('budget_stop'),
    'and the column is in the file');
});

test('the write gates are on the three mutations and off the read', () => {
  const admin = read('src/routes/admin.js');
  assert.match(admin, /router\.get\('\/api\/admin\/homeroom-bot', async/);
  assert.match(admin, /router\.put\('\/api\/admin\/homeroom-bot\/settings', requireAdminWrite,/);
  assert.match(admin, /router\.post\('\/api\/admin\/homeroom-bot\/runs\/:id\/rating', requireAdminWrite,/);
  assert.match(admin, /router\.post\('\/api\/admin\/homeroom-bot\/run', requireAdminWrite, drainGuard,/);
  assert.match(admin, /router\.get\('\/api\/admin\/homeroom-bot\/export\.csv', requireAdminWrite,/,
    'the bulk download sits with the mutations, not with the page read');
});

// ── The CSV export (#2726) ────────────────────────

test('GET export.csv: a view-only admin is refused; a full admin gets the whole ledger', async () => {
  who = VIEW_ADMIN;
  let res = await call('GET', '/api/admin/homeroom-bot/export.csv');
  assert.equal(res.status, 403, 'a bulk download is a full-admin artifact');

  who = FULL_ADMIN;
  exportPages.length = 0;
  res = await call('GET', '/api/admin/homeroom-bot/export.csv');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.match(res.headers.get('content-disposition'),
    /attachment; filename="homeroom-bot-verdicts-all-apps-all-verdicts-\d{4}-\d{2}-\d{2}\.csv"/,
    'the filename says what is in the file and when it was taken');

  const lines = (await res.text()).split('\n');
  const header = lines[0].split(',');
  assert.equal(header[0], 'id');
  assert.ok(header.includes('issue_url'), 'the derived issue link travels with the row');
  assert.ok(header.includes('build_note') && header.includes('rating_note') && header.includes('cost_usd'),
    'the verdict, the rating and the cost are all in the file');
  assert.ok(!header.includes('repo_url'), 'issue_url already carries it');

  // Newest first, the same order as the table.
  assert.match(lines[1], /^41,/);
  assert.match(lines[1], /https:\/\/github\.com\/usernode-bot\/todo\/issues\/12/);
  // The `.git` suffix is trimmed the way the dashboard trims it.
  assert.match(lines[2], /https:\/\/github\.com\/usernode-bot\/todo\/issues\/11/);
  assert.ok(!/todo\.git/.test(lines[2]));
});

test('export.csv quotes what a spreadsheet would otherwise eat', async () => {
  who = FULL_ADMIN;
  const body = await (await call('GET', '/api/admin/homeroom-bot/export.csv')).text();
  assert.ok(body.includes('"Edit a,b\nthen ""c""'),
    'a comma and a newline keep the field quoted, and the inner quote is doubled');
  assert.ok(body.includes("'=SUM(A1)"),
    'a leading = is defused: an admin note must never run as a formula');
  const records = body.split('\n').filter((l) => /^\d+,/.test(l));
  assert.equal(records.length, 2, 'two runs');
  assert.ok(body.split('\n').length > records.length + 2,
    'and the newline inside the quoted field stayed inside it, not a third record');
});

test('export.csv carries the filters the table is showing', async () => {
  who = FULL_ADMIN;
  exportPages.length = 0;
  const res = await call('GET', '/api/admin/homeroom-bot/export.csv?app=todo&verdict=ready');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /homeroom-bot-verdicts-todo-ready-/);
  // Counted by RECORD, not by physical line: a quoted field may hold a
  // newline of its own, which is the point of the quoting.
  const ids = (await res.text()).split('\n')
    .filter((l) => /^\d+,/.test(l))
    .map((l) => l.slice(0, l.indexOf(',')));
  assert.deepEqual(ids, ['40'], 'only the run matching both filters');
  assert.equal(exportPages[0].cursor, null, 'the first page starts at the top');
  assert.equal(exportPages[0].app, 'todo');
  assert.equal(exportPages[0].verdict, 'ready');
});

test('export.csv walks every page: a full chunk is followed by the next cursor', async () => {
  exportPages.length = 0;
  const bot = require('../src/services/homeroom-bot');
  const seen = [];
  // A chunk size of 1 forces the paging this small fixture would not.
  for await (const chunk of bot.iterateRunsForExport(poolMod.getPool(), { chunk: 1 })) {
    seen.push(chunk.map((r) => r.id));
  }
  assert.deepEqual(seen, [[41], [40]], 'one row per page, newest first');
  assert.deepEqual(exportPages.map((p) => p.cursor), [null, 41, 40],
    'each page asks for rows below the last id it saw, so none is skipped or repeated');
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
  // #3710: an app is set Live; the bot itself is on or off. A greyed-out
  // "Live (not in this build)" mode beside a live list read as a contradiction.
  assert.doesNotMatch(tsx, /<option value="live"/, 'live is not a mode');
  assert.match(tsx, /<option value="off">Off<\/option>\s*<option value="shadow">On<\/option>/);

  // #2726. The declared-check manifest is on its 20-slot floor, so the export
  // control is pinned from source here rather than spending a dapp.json slot.
  assert.match(tsx, /id="admin-homeroom-bot-export"/, 'the Verdicts card offers the export');
  assert.match(tsx, /href=\{exportHref\}/, 'a plain link, so the browser receives the stream');
  assert.match(tsx, /\/api\/admin\/homeroom-bot\/export\.csv/);
  assert.match(tsx, /canWrite \? \(\s*<a/, 'and only a full admin sees it');
  assert.ok(!/new Blob\(/.test(tsx), 'the ledger is never assembled in page memory');

  // #2737. The budget is settable from the screen, the fourth verdict is
  // filterable, and a backed-off app says so rather than looking idle.
  assert.match(tsx, /id="admin-homeroom-bot-turn-minutes"/);
  assert.match(tsx, /id="admin-homeroom-bot-turn-tokens"/);
  assert.match(tsx, /id="admin-homeroom-bot-refusals"/);

  // #2742: a budget stop is findable without expanding rows or exporting.
  // The tiles take their id as an argument rather than writing it inline.
  assert.match(tsx, /id="admin-homeroom-bot-total-budget"/, 'the totals line counts them');
  assert.match(tsx, /totals\?\.budgetStopped/, 'from its own total, not the failure count');
  assert.match(tsx, /<option value="budget">Stopped on budget<\/option>/, 'the filter finds them');
  assert.match(tsx, /run\.budget_stop \? `Stopped: \$\{run\.budget_stop\}`/, 'and the row says so unexpanded');
  assert.match(tsx, /<option value="empty">Nothing to build<\/option>/);
  assert.match(tsx, /empty: 'Nothing to build'/, 'and the verdict has a label of its own');
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

test('every verdict opens to its own detail, and only a real failure shows the failure line (#3144)', () => {
  // `empty` got a label and a badge but no branch in VerdictBody, so opening
  // one fell through to "The run failed before it produced a verdict." The
  // verdicts are read from VERDICT_LABEL, the table a new verdict has to be
  // added to anyway, so the next one cannot fall through the same way.
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  const table = tsx.slice(tsx.indexOf('const VERDICT_LABEL'), tsx.indexOf('};', tsx.indexOf('const VERDICT_LABEL')));
  const verdicts = [...table.matchAll(/^\s+(\w+): '/gm)].map((m) => m[1]);
  assert.ok(verdicts.includes('empty') && verdicts.includes('failed'), 'the table was read');
  const body = tsx.slice(tsx.indexOf('function VerdictBody'), tsx.indexOf('\n}\n', tsx.indexOf('function VerdictBody')));
  for (const verdict of verdicts.filter((v) => v !== 'failed')) {
    assert.match(body, new RegExp(`if \\(run\\.verdict === '${verdict}'\\)`),
      `${verdict} has its own branch rather than falling through to the failure line`);
  }
  const empty = body.slice(body.indexOf("if (run.verdict === 'empty')"));
  assert.match(empty.slice(0, 200), /run\.reason/, 'and an empty verdict shows the reason the bot gave');
});

test('the paused apps are set from the dashboard, and a proposal the bot opened is one click away (#3146)', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /id="admin-homeroom-bot-live-apps"/);
  // #3710: one row per app, Live or Paused, in the Settings form: the edit
  // waits for Save changes, one PUT through the same settings route as
  // every other knob.
  assert.match(tsx, /data-app-mode=\{slug\}/);
  assert.match(tsx, /data-app-mode-choice=\{`\$\{slug\}:\$\{o\.key\}`\}/);
  assert.match(tsx, /onChange=\{\(paused\) => setField\('pausedApps', paused\)\}/);
  assert.match(tsx, /else if \(key === 'pausedApps'\) patch\.pausedApps = /);
  assert.match(tsx, /write\('\/api\/admin\/homeroom-bot\/settings', 'PUT', patch,/);
  // The form is the SAVED settings plus the fields somebody touched, so a
  // refresh shows what the bot will act on, and the 30-second poll never
  // wipes an edit.
  assert.match(tsx, /const form: Form \| null = saved \? \{ \.\.\.saved, \.\.\.edits \} : null;/);
  assert.match(tsx, /setEdits\(\{\}\);\s*setFormRound\(\(n\) => n \+ 1\);\s*apply\(data as Payload\);/, 'a successful save goes back to showing the saved settings');
  assert.match(tsx, /id="admin-homeroom-bot-live-apps-state"/);
  assert.match(tsx, /id="admin-homeroom-bot-live-apps-note"/);
  assert.match(tsx, /a staging copy never acts/);
  // The link is built from the run's own app slug and session id, never
  // from a URL the API handed over.
  assert.match(tsx, /href=\{`#app\/\$\{encodeURIComponent\(run\.app_slug\)\}\/dev\/proposals\/\$\{Number\(run\.proposal_session_id\)\}`\}/);
  assert.match(tsx, /className=\{AdminUI\.btn\.link\}/);
});

test('the ledger, the dashboard and the filter agree on every verdict, follow-ups included (#3264)', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  const table = tsx.slice(tsx.indexOf('const VERDICT_LABEL'), tsx.indexOf('};', tsx.indexOf('const VERDICT_LABEL')));
  const labelled = [...table.matchAll(/^\s+(\w+): '/gm)].map((m) => m[1]).sort();
  const schema = read('src/db/schema.sql');
  // The ledger's own constraint by name: other tables have a `verdict` too.
  const checks = [...schema.matchAll(/homeroom_bot_runs_verdict_check\s+CHECK \(verdict IN \(([^)]*)\)\)/g)].map((m) => m[1]);
  assert.equal(checks.length, 2, 'the CREATE TABLE and the widening on boot');
  for (const list of checks) {
    const allowed = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(allowed, labelled, 'a verdict the ledger can hold is one the dashboard can show');
  }
  for (const v of ['answer', 'revise']) {
    assert.match(tsx, new RegExp(`<option value="${v}">`), `${v} can be filtered to`);
  }
  const admin = read('src/routes/admin.js');
  assert.match(admin, /\['question', 'ready', 'person', 'empty', 'failed', 'answer', 'revise'\]\.includes\(q\.verdict\)/);
  assert.match(tsx, /isFollowUp\(run\) \? <span className=\{`\$\{AdminUI\.badge\.outline\} ml-1`\}>follow-up<\/span>/);
});

test('a saved live app has a "Triage again" button that queues its open issues (#3480)', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  // Only on an app whose saved mode is live: the route refuses a paused app
  // anyway.
  assert.match(tsx, /\{canWrite && !savedPaused\.includes\(slug\) \? \(\s*<button[\s\S]{0,200}data-live-app-retriage=\{slug\}[\s\S]{0,300}onClick=\{\(\) => onRetriage\(slug\)\}\s*>\s*Triage again\s*<\/button>/);
  assert.match(tsx, /onRetriage=\{retriageApp\}/);
  assert.match(tsx, /write\('\/api\/admin\/homeroom-bot\/retriage-app', 'POST', \{ slug \}, 'Queued\.'\)/);
  assert.match(tsx, /will be triaged again, one at a time, oldest first\./, 'the status says what will happen, and how');
  const admin = read('src/routes/admin.js');
  assert.match(admin, /router\.post\('\/api\/admin\/homeroom-bot\/retriage-app', requireAdminWrite, drainGuard, async \(req, res\) => \{/);
  assert.match(admin, /homeroomBot\.retriageApp\(pool, \{ slug: req\.body\?\.slug, actorId: req\.user\.id \}\)/);
});

function loadBotSection() {
  globalThis.window = globalThis.window || globalThis;
  const { loadTsx } = require('./lib/render-tsx');
  return loadTsx('frontend/src/features/admin/admin-homeroom-bot.tsx', {
    stubs: {
      './admin-console.js': {
        AdminUI: new Proxy({}, {
          get: (_t, key) => (['btn', 'badge'].includes(key) ? new Proxy({}, { get: (_u, k) => `${key}-${String(k)}` }) : String(key)),
        }),
      },
      '../../lib/legacy-portals': { mountLegacyPortal() {}, unmountLegacyPortal() {} },
    },
  });
}

test('every app is Live or Paused, paused first, and the rest behind a toggle (#3710)', () => {
  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const { AppModes, appMode, withAppMode } = loadBotSection();
  const apps = [
    { slug: 'chore-wheel', name: 'Chore wheel' }, { slug: 'old-blog', name: 'Old blog' },
    { slug: 'todo', name: 'Todo' }, { slug: 'notes', name: 'Notes' },
  ];
  const props = { apps, paused: ['old-blog'], savedPaused: ['old-blog'], canWrite: true, onChange() {}, onRetriage() {} };
  const html = renderToHtml(createElement(AppModes, props));
  const order = [...html.matchAll(/data-app-mode="([^"]+)" data-mode="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(order, ['old-blog:paused']);
  assert.match(html, /id="admin-homeroom-bot-live-apps-more"[^>]*>Show the 3 live apps</);
  assert.doesNotMatch(html, /:shadow"|>Shadow</, 'there is no Shadow to choose');
  assert.doesNotMatch(html, /data-live-app-retriage="old-blog"/, 'not while the app is paused');
  const none = renderToHtml(createElement(AppModes, { ...props, paused: [], savedPaused: [] }));
  assert.match(none, /id="admin-homeroom-bot-live-apps-none"[^>]*>No app is paused: it is live on all of them\.</);
  const viewOnly = renderToHtml(createElement(AppModes, { ...props, canWrite: false }));
  assert.doesNotMatch(viewOnly, /data-live-app-retriage=/);
  assert.equal((viewOnly.match(/data-app-mode-choice="old-blog:[a-z]+"[^>]*disabled=""/g) || []).length, 2, 'a view-only admin changes nothing');
  // An unsaved pause shows, and the app keeps Triage again until it is saved.
  const draft = renderToHtml(createElement(AppModes, { ...props, paused: ['old-blog', 'todo'] }));
  assert.match(draft, /data-app-mode="todo" data-mode="paused"/);
  assert.match(draft, /data-live-app-retriage="todo"[^>]*>Triage again</);
  assert.match(draft, /not saved/);

  // The one stored list, from one choice per app.
  assert.equal(appMode('todo', []), 'live');
  assert.equal(appMode('old-blog', ['old-blog']), 'paused');
  assert.deepEqual(withAppMode('todo', 'paused', ['old-blog']), ['old-blog', 'todo']);
  assert.deepEqual(withAppMode('old-blog', 'live', ['old-blog']), []);

  const src = read('src/services/homeroom-bot.js');
  // Triage again: refused on a paused app first, and on a staging copy.
  assert.match(src, /if \(\(settings\.pausedApps \|\| \[\]\)\.includes\(slug\)\) \{\s*return \{ ok: false, status: 409, error: 'The app is paused for the bot' \};\s*\}[\s\S]{0,300}if \(!live\.inScope\(live\.liveScope\(\{ \.\.\.settings, mode: 'shadow' \}\), slug\)\) \{/);
});

test('how much the bot works on at once is set here, and what runs now is listed (#3624 stage 2)', async () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  for (const id of ['admin-homeroom-bot-live-at-once', 'admin-homeroom-bot-per-person']) {
    assert.ok(tsx.includes(`id="${id}"`), id);
  }
  assert.ok(!tsx.includes('id="admin-homeroom-bot-concurrency"'), 'no Shadow apps at once: no app is a shadow app');
  assert.match(tsx, /onChange=\{\(v\) => setField\('liveAtOnce', v\)\}/);
  assert.match(tsx, /onChange=\{\(v\) => setField\('perPerson', v\)\}/);
  assert.match(tsx, /onChange=\{\(e\) => setField\('dmChat', e\.target\.checked\)\}/);
  assert.match(tsx, /id="admin-homeroom-bot-dm-chat"/);
  assert.match(tsx, /<WorkingNow items=\{payload\?\.workingNow \|\| \[\]\} \/>/);

  const { renderToHtml, createElement } = require('./lib/render-tsx');
  const { WorkingNow, buildPatch, savedForm, dirtyFields } = loadBotSection();
  // #3710: what Save changes sends for those fields, and what it refuses.
  const saved = savedForm({ settings: { mode: 'shadow', liveAtOnce: 12, perPerson: 3, dmChat: true }, bot: null });
  const form = { ...saved, liveAtOnce: '20', perPerson: '5', dmChat: false };
  const dirty = dirtyFields({ liveAtOnce: '20', perPerson: '5', dmChat: false }, saved);
  assert.deepEqual(dirty, ['liveAtOnce', 'perPerson', 'dmChat']);
  assert.deepEqual(buildPatch(form, saved, dirty), { patch: { liveAtOnce: 20, perPerson: 5, dmChat: false }, error: null });
  assert.match(buildPatch({ ...form, liveAtOnce: '99' }, saved, ['liveAtOnce']).error, /Live requests at once must be a whole number from 1 to 24\./);
  assert.match(buildPatch({ ...form, perPerson: '7' }, saved, ['perPerson']).error, /Per person at once must be a whole number from 1 to 6\./);
  assert.equal(savedForm({ settings: { mode: 'shadow' }, bot: null }).liveAtOnce, '12', 'the server\'s defaults when unset');
  assert.equal(savedForm({ settings: { mode: 'shadow' }, bot: null }).perPerson, '3');
  const html = renderToHtml(createElement(WorkingNow, { items: [
    { appSlug: 'todo', appName: 'Todo', issueNumber: 12, since: '2026-10-02T10:00:00Z', lane: 'live', kind: 'read', person: 'ada' },
    { appSlug: 'notes', appName: 'Notes', issueNumber: 3, since: '2026-10-02T10:05:00Z', lane: 'background', kind: 'read', person: null },
    { appSlug: 'todo', appName: 'Todo', issueNumber: 9, since: '2026-10-02T09:40:00Z', lane: 'live', kind: 'build', person: 'ada' },
  ] }));
  assert.match(html, /data-working="todo#12"[^>]*><span class="badge-success">reading<\/span><span>Todo #12<\/span><span class="muted">for @ada<\/span>/);
  assert.match(html, /data-working="notes#3"[^>]*><span class="badge-default">background<\/span><span>Notes #3<\/span><span class="muted">since /);
  assert.match(html, /data-working="todo#9"[^>]*><span class="badge-success">building<\/span><span>Todo #9<\/span><span class="muted">for @ada<\/span>/);

  // Running now and Waiting in the queue count builds too, and say which is
  // which: builds run from their runs, not the queue, and were counted in
  // neither (0 running while six builds ran).
  const { workingFor, waitingFor } = loadBotSection();
  const item = (kind) => ({ appSlug: 'a', appName: 'A', issueNumber: 1, since: '', lane: 'live', kind, person: null });
  assert.equal(workingFor([item('read'), item('build'), item('build'), item('build')]), '1 reading, 3 building');
  assert.equal(workingFor([item('build'), item('build')]), '2 building', 'a zero says nothing');
  assert.equal(workingFor([{ ...item(), kind: undefined }]), '1 reading', 'a row without a kind is a read');
  assert.equal(waitingFor(4, 2), '4 to read, 2 to build');
  assert.equal(waitingFor(0, 0), '');
  assert.match(tsx, /tile\('Waiting in the queue',\s*payload \? String\(payload\.queue\.depth \+ \(payload\.queue\.buildsWaiting \|\| 0\)\) : '–', 'admin-homeroom-bot-tile-queue',/);
  const botSrc = read('src/services/homeroom-bot.js');
  assert.match(botSrc, /queue: \{ depth: depthRows\[0\]\?\.depth \|\| 0, items: queueRows, buildsWaiting: builds\.waiting \}/);
  assert.match(botSrc, /workingNow: \[\.\.\.await workingNow\(pool, settings\), \.\.\.builds\.building\]/);
  assert.match(renderToHtml(createElement(WorkingNow, { items: [] })), /id="admin-homeroom-bot-working-none"[^>]*>Nothing is running right now\./);

  who = FULL_ADMIN;
  const res = await call('PUT', '/api/admin/homeroom-bot/settings', { liveAtOnce: 20, perPerson: 5, dmChat: false });
  assert.equal(res.status, 200);
  assert.equal(settings.get('homeroom_bot_live_at_once'), '20');
  assert.equal(settings.get('homeroom_bot_per_person'), '5');
  assert.equal(settings.get('homeroom_bot_dm_chat'), 'off');
  const bad = await call('PUT', '/api/admin/homeroom-bot/settings', { liveAtOnce: 99 });
  assert.equal(bad.status, 400);
  who = VIEW_ADMIN;
  const refused = await call('PUT', '/api/admin/homeroom-bot/settings', { perPerson: 1 });
  assert.equal(refused.status, 403);
  who = FULL_ADMIN;
});

// ── #3710: one form, one Save; the header says what the bot does ─────────

test('the header says on or off and where it is live, and the chip says when it is not working', () => {
  const { modeLabel, health } = loadBotSection();
  assert.equal(modeLabel({ mode: 'off', pausedApps: ['a'] }), 'Off');
  assert.equal(modeLabel({ mode: 'shadow', pausedApps: [] }), 'On: live on every app');
  assert.equal(modeLabel({ mode: 'shadow' }), 'On: live on every app');
  assert.equal(modeLabel({ mode: 'shadow', pausedApps: ['a', 'b'] }), 'On: live on every app but 2 paused');
  const on = { mode: 'shadow' };
  assert.deepEqual(health({ mode: 'off' }, null), { tone: 'off', text: 'Not running' });
  assert.equal(health(on, null).tone, 'warn');
  assert.deepEqual(health(on, { at: '2026-10-03T10:00:00Z', paused: 'budget' }), { tone: 'warn', text: 'Paused: the weekly budget is spent' });
  assert.equal(health(on, { at: '2026-10-03T10:00:00Z', paused: 'infra', retryInMs: 60_000 }).tone, 'bad');
  assert.match(health(on, { at: '2026-10-03T10:00:00Z', paused: 'infra', retryInMs: 60_000 }).text, /^Platform fault, trying again at /);
  assert.deepEqual(health(on, { at: '2026-10-03T10:00:00Z', paused: null, refusals: [{ app: 'a', error: 'session_busy' }] }),
    { tone: 'warn', text: '1 app backing off' });
  assert.equal(health(on, { at: '2026-10-03T10:00:00Z', paused: null, refusals: [] }).tone, 'ok');

  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /id="admin-homeroom-bot-health"/);
  assert.match(tsx, /It works for everyone with platform access and acts on every app but the\s+paused ones, Homeroom&apos;s own included/, 'the intro says where it acts');
  assert.doesNotMatch(tsx, /On Shadow apps/);
  assert.doesNotMatch(tsx, /It posts nothing and claims nothing/);
});

test('Save changes sends only what changed, in the route\'s own shape, or says what is wrong first', () => {
  const { savedForm, dirtyFields, buildPatch } = loadBotSection();
  const saved = savedForm({
    settings: {
      mode: 'shadow', pausedApps: ['todo', 'notes'], userWeeklyCents: 5000,
      models: { triage: '', spec: '', build: 'z-ai/glm-5.3-flash', followup: '' }, turnSeconds: 1200, turnInputTokens: 10_000_000,
    },
    bot: { weeklyLimitCents: 15000 },
  });
  assert.equal(saved.botCap, '150.00');
  assert.equal(saved.turnMinutes, '20');
  assert.deepEqual(dirtyFields({ pausedApps: ['notes', 'todo'] }, saved), [], 'the list is a set: order is not a change');
  const edits = {
    pausedApps: ['notes'], models: { ...saved.models, triage: 'xiaomi/mimo-v2.6-pro' }, botCap: '200', userCap: '0',
    turnMinutes: '30', turnTokens: '12', mode: 'off',
  };
  const form = { ...saved, ...edits };
  const dirty = dirtyFields(edits, saved);
  assert.deepEqual(buildPatch(form, saved, dirty), {
    patch: {
      pausedApps: ['notes'], models: { triage: 'xiaomi/mimo-v2.6-pro' }, weeklyLimitCents: 20000, userWeeklyCents: 0,
      turnSeconds: 1800, turnInputTokens: 12_000_000, mode: 'off',
    },
    error: null,
  }, 'one stage changed, so one stage is sent; dollars as cents, minutes as seconds');
  assert.match(buildPatch({ ...form, models: { ...form.models, build: 'not a model' } }, saved, ['models']).error, /^Build: a model is an OpenRouter id/);
  assert.match(buildPatch({ ...form, botCap: '' }, saved, ['botCap']).error, /^The bot's weekly budget: enter a dollar amount\.$/);
  assert.match(buildPatch({ ...form, userCap: '-1' }, saved, ['userCap']).error, /0 for no limit/);
  assert.deepEqual(buildPatch({ ...form, models: { ...saved.models, build: '' } }, saved, ['models']).patch, { models: { build: '' } },
    'back to the platform default is a blank');

  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /id="admin-homeroom-bot-savebar"/);
  assert.match(tsx, /id="admin-homeroom-bot-save"[^>]*>Save changes</);
  assert.match(tsx, /id="admin-homeroom-bot-discard"[^>]*>Discard</);
  assert.equal((tsx.match(/'\/api\/admin\/homeroom-bot\/settings', 'PUT'/g) || []).length, 1, 'one place saves settings');
  assert.doesNotMatch(tsx, /onBlur=/, 'nothing saves when a field loses focus any more');
});

test('a model picked in the Benchmark fills the form in and waits for Save', () => {
  const { benchHint } = loadBotSection();
  const best = {
    stages: ['triage', 'checks_fix'], models: ['a/glm'],
    cells: {
      'triage|a/glm': { stage: 'triage', model: 'a/glm', graded: 28, accuracy: 0.75, costPerSuccess: 0.041 },
      'checks_fix|a/glm': { stage: 'checks_fix', model: 'a/glm', graded: 2, accuracy: 1, costPerSuccess: 0.27 },
    },
    best: { triage: 'triage|a/glm' },
    enough: { triage: 10, checks_fix: 2 },
  };
  assert.equal(benchHint(best, 'triage', 'a/glm'), 'Benchmark: 75% of 28 graded, $0.041 a success, the best value.');
  assert.equal(benchHint(best, 'followup', 'a/glm'), 'Benchmark (checks fix): 100% of 2 graded, $0.270 a success.');
  assert.equal(benchHint(best, 'build', 'a/glm'), 'Not benchmarked at this stage yet.');
  assert.equal(benchHint(null, 'build', 'a/glm'), '');

  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /<BenchmarkArea canWrite=\{canWrite\} active=\{tab === 'benchmark'\} inUse=\{payload\?\.bot\?\.models \|\| null\}\s+defaultModel=\{payload\?\.defaultModel \|\| null\} onUseModel=\{applyBenchModel\} \/>/,
    'the Benchmark reads the model in use from this section\'s own data, and writes its address only while it is the tab on screen');
  const fn = tsx.slice(tsx.indexOf('const applyBenchModel = '), tsx.indexOf('const liveNow = '));
  assert.match(fn, /setModel\(stage, id\);/);
  assert.match(fn, /showTab\('settings'\);/);
  assert.doesNotMatch(fn, /write\(|fetch\(/, 'nothing is saved until a person presses Save changes');
});

// The configurations' blind pairs are picked only through the connector,
// and nothing told an admin one was waiting: the Overview says so, per
// scope, beside the spend and the verdicts, and a zero says nothing.
test('the Overview says how many configuration pairs wait for a pick, and where they are picked', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  const { pairsWaitingLine } = loadBotSection();
  assert.equal(pairsWaitingLine(null), '');
  assert.equal(pairsWaitingLine(undefined), '');
  assert.equal(pairsWaitingLine({ first_version: 0, later: 0 }), '', 'zero says nothing');
  const how = 'Pairs are picked through the Homeroom connector: list_bot_configs, then get_bot_config_pair.';
  assert.equal(pairsWaitingLine({ first_version: 0, later: 1 }), `Bot configurations: 1 later-change pair waits for a pick. ${how}`);
  assert.equal(pairsWaitingLine({ first_version: 2, later: 0 }), `Bot configurations: 2 first-version pairs wait for a pick. ${how}`);
  assert.equal(pairsWaitingLine({ first_version: 1, later: 5 }),
    `Bot configurations: 1 first-version pair and 5 later-change pairs wait for a pick. ${how}`);
  // Under the totals line, on the Overview, hidden when there is nothing to say.
  const overview = tsx.slice(tsx.indexOf('id="admin-homeroom-bot-panel-overview"'), tsx.indexOf('id="admin-homeroom-bot-panel-settings"'));
  assert.match(overview, /id="admin-homeroom-bot-totals"[\s\S]*<p className=\{pairsLine \? `\$\{AdminUI\.muted\} mt-1` : 'hidden'\} id="admin-homeroom-bot-pairs-waiting">\{pairsLine\}<\/p>/);
  assert.match(tsx, /const pairsLine = pairsWaitingLine\(payload\?\.pairsWaiting\);/);
  const botSrc = read('src/services/homeroom-bot.js');
  assert.match(botSrc, /pairsWaiting: await botConfigs\(\)\.pairsWaitingByScope\(pool\),/, 'from the payload the Overview already loads');
});

test('the tabs have addresses of their own, and Settings and the Overview stay rendered', () => {
  const tsx = read('frontend/src/features/admin/admin-homeroom-bot.tsx');
  assert.match(tsx, /settings: '#admin\/homeroom-bot\/settings',/);
  assert.match(tsx, /benchmark: '#admin\/homeroom-bot\/benchmark',/);
  assert.match(tsx, /history\.replaceState\(null, '', TAB_HASH\[next\]\)/, 'replaced, never pushed');
  assert.match(tsx, /id="admin-homeroom-bot-panel-overview" role="tabpanel"[^>]*hidden=\{tab !== 'overview'\}/);
  assert.match(tsx, /id="admin-homeroom-bot-panel-settings" role="tabpanel"[^>]*hidden=\{tab !== 'settings'\}/);
  const audit = read('scripts/audit-react-ownership.mjs');
  assert.match(audit, /'#admin\/homeroom-bot\/settings'/, 'the ownership audit walks the new address');
  for (const place of ['benchmark/runs', 'benchmark/runs/936551', 'benchmark/runs/936550', 'benchmark/suites', 'benchmark/suites/936542']) {
    assert.ok(audit.includes(`'#admin/homeroom-bot/${place}'`), `the ownership audit walks the Benchmark's ${place}`);
  }
});
