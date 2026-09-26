'use strict';

// Early warning for the server-wide caps (services/platform-limit-alerts.js).
//
// Three things are pinned here:
//
//   1. decide(), the whole policy, pure: which crossing notifies, which
//      only re-arms, and the margin that stops a count idling at a line
//      from paging every admin on each wobble.
//   2. evaluate(), against a recording pool: the count query is the one the
//      enforcing route runs, the level is read under a row lock and written
//      in the same transaction as the notifications, a preview records the
//      level but notifies nobody, and a second evaluation of the same
//      crossing is silent.
//   3. The wiring: the leader sweeps, the app-create routes nudge, and the
//      three copies of the detail-token format (service, push copy, drawer)
//      cannot drift apart.
//
// Run with: node --test tests/platform-limit-alerts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const limits = require('../src/services/platform-limit-alerts');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

// ─── 1. The policy ──────────────────────────────────────────────────────

test('the lines: warn at the percent (rounded up), full at the cap, none when off', () => {
  assert.deepEqual(limits.lines(50, 80), { warn: 40, full: 50 });
  assert.deepEqual(limits.lines(75, 80), { warn: 60, full: 75 });
  assert.deepEqual(limits.lines(7, 80), { warn: 6, full: 7 }, '5.6 rounds up to 6');
  assert.deepEqual(limits.lines(1, 80), { warn: 1, full: 1 });
  assert.equal(limits.lines(0, 80), null, 'MAX_APPS=0 turns the cap off');
  assert.equal(limits.lines(-5, 80), null);
  assert.equal(limits.lines(NaN, 80), null);
  assert.equal(limits.lines(undefined, 80), null);
});

test('a rise notifies the level reached; staying put notifies nothing', () => {
  const d = (used, level) => limits.decide({ used, cap: 50, percent: 80, level });
  assert.deepEqual(d(39, 'ok'), { level: 'ok', notify: null });
  assert.deepEqual(d(40, 'ok'), { level: 'warn', notify: 'warn' });
  assert.deepEqual(d(45, 'warn'), { level: 'warn', notify: null });
  assert.deepEqual(d(50, 'warn'), { level: 'full', notify: 'full' });
  assert.deepEqual(d(50, 'full'), { level: 'full', notify: null });
  assert.deepEqual(d(51, 'full'), { level: 'full', notify: null }, 'admins bypass the cap');
  // A jump straight past the warning line announces only where it landed.
  assert.deepEqual(d(50, 'ok'), { level: 'full', notify: 'full' });
});

test('a fall re-arms only once the count is 10% under the line it crossed', () => {
  const d = (used, level) => limits.decide({ used, cap: 50, percent: 80, level });
  // full re-arms under 45 (0.9 x 50); warn re-arms under 36 (0.9 x 40).
  assert.deepEqual(d(49, 'full'), { level: 'full', notify: null },
    'one app deleted and the next created must not repeat "full"');
  assert.deepEqual(d(45, 'full'), { level: 'full', notify: null });
  assert.deepEqual(d(44, 'full'), { level: 'warn', notify: null });
  assert.deepEqual(d(38, 'full'), { level: 'warn', notify: null });
  assert.deepEqual(d(35, 'full'), { level: 'ok', notify: null });
  assert.deepEqual(d(36, 'warn'), { level: 'warn', notify: null });
  assert.deepEqual(d(35, 'warn'), { level: 'ok', notify: null });
  assert.equal(limits.REARM_RATIO, 0.9);
});

test('a count idling at the line pages once, not on every wobble', () => {
  let level = 'ok';
  const notified = [];
  // 60/75 sessions is the warning line; the count wobbles around it all day.
  for (const used of [59, 60, 59, 60, 61, 58, 60, 59, 60]) {
    const out = limits.decide({ used, cap: 75, percent: 80, level });
    if (out.notify) notified.push(`${used}:${out.notify}`);
    level = out.level;
  }
  assert.deepEqual(notified, ['60:warn']);
  // It re-arms only after a real drop (under 54), and then pages again.
  for (const used of [53, 60]) {
    const out = limits.decide({ used, cap: 75, percent: 80, level });
    if (out.notify) notified.push(`${used}:${out.notify}`);
    level = out.level;
  }
  assert.deepEqual(notified, ['60:warn', '60:warn']);
});

test('raising the cap re-arms; turning it off resets; a lowered cap can jump to full', () => {
  // An admin raised MAX_APPS from 50 to 100 with 50 apps live.
  assert.deepEqual(limits.decide({ used: 50, cap: 100, percent: 80, level: 'full' }),
    { level: 'ok', notify: null });
  assert.deepEqual(limits.decide({ used: 90, cap: 0, percent: 80, level: 'full' }),
    { level: 'ok', notify: null }, 'a disabled cap never pages');
  assert.deepEqual(limits.decide({ used: 30, cap: 25, percent: 80, level: 'ok' }),
    { level: 'full', notify: 'full' });
});

test('percent 100 has no separate warning; an unknown stored level reads as ok', () => {
  assert.deepEqual(limits.decide({ used: 49, cap: 50, percent: 100, level: 'ok' }),
    { level: 'ok', notify: null });
  assert.deepEqual(limits.decide({ used: 50, cap: 50, percent: 100, level: 'ok' }),
    { level: 'full', notify: 'full' });
  assert.deepEqual(limits.decide({ used: 40, cap: 50, percent: 80, level: 'bogus' }),
    { level: 'warn', notify: 'warn' });
  assert.deepEqual(limits.decide({ used: 40, cap: 50, percent: 80, level: null }),
    { level: 'warn', notify: 'warn' });
});

test('PLATFORM_LIMIT_WARN_PERCENT is read at call time and clamped to 1..100', (t) => {
  const prior = process.env.PLATFORM_LIMIT_WARN_PERCENT;
  t.after(() => {
    if (prior === undefined) delete process.env.PLATFORM_LIMIT_WARN_PERCENT;
    else process.env.PLATFORM_LIMIT_WARN_PERCENT = prior;
  });
  delete process.env.PLATFORM_LIMIT_WARN_PERCENT;
  assert.equal(limits.warnPercent(), 80);
  for (const [raw, want] of [['90', 90], ['1', 1], ['100', 100], ['0', 80], ['101', 80], ['abc', 80]]) {
    process.env.PLATFORM_LIMIT_WARN_PERCENT = raw;
    assert.equal(limits.warnPercent(), want, raw);
  }
});

test('the detail token round-trips and fits the 32-character column', () => {
  assert.equal(limits.detailToken('apps', 'warn', 40, 50), 'apps_warn:40:50');
  assert.deepEqual(limits.parseDetail('sessions_full:75:75'),
    { limit: 'sessions', level: 'full', used: 75, cap: 75 });
  const widest = limits.detailToken('sessions', 'full', 123456789, 987654321);
  assert.ok(widest.length <= 32, widest);
  assert.equal(widest, 'sessions_full:9999999:9999999', 'figures clamp to seven digits');
  assert.equal(limits.parseDetail(widest).cap, 9999999);
  for (const bad of ['', 'apps_warn', 'apps_ok:1:2', 'disk_warn:1:2', null, undefined]) {
    assert.equal(limits.parseDetail(bad), null, String(bad));
  }
});

// ─── 2. evaluate() against a recording pool ─────────────────────────────

function fakePool({ apps = 0, sessions = 0, level = 'ok', countError = null } = {}) {
  const state = { level, queries: [], updates: [] };
  return {
    state,
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      state.queries.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
      if (/FROM apps WHERE status <> 'error'/.test(sql)) {
        if (countError) throw countError;
        return { rows: [{ n: apps }] };
      }
      if (/FROM chat_sessions/.test(sql)) return { rows: [{ n: sessions }] };
      if (/^INSERT INTO platform_limit_alerts/.test(sql)) return { rows: [] };
      if (/^SELECT level FROM platform_limit_alerts .* FOR UPDATE$/.test(sql)) {
        return { rows: [{ level: state.level }] };
      }
      if (/^UPDATE platform_limit_alerts/.test(sql)) {
        state.updates.push(params);
        state.level = params[1];
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

function recorder() {
  const calls = { create: [], publish: [] };
  return {
    calls,
    deps: {
      staging: false,
      create: async (db, args) => {
        calls.create.push(args);
        return [{ id: 11, user_id: 1 }, { id: 12, user_id: 2 }];
      },
      publish: async (pool, row) => { calls.publish.push(row.id); },
    },
  };
}

const CONFIG = { maxApps: 50, maxGlobalSessions: 75 };

test('a crossing is recorded and announced in one transaction, then published', async () => {
  const pool = fakePool({ apps: 40 });
  const { calls, deps } = recorder();
  const out = await limits.evaluate(pool, CONFIG, 'apps', deps);

  assert.deepEqual(out, {
    key: 'apps', used: 40, cap: 50, level: 'warn', notified: 'warn', recipients: 2,
  });
  assert.deepEqual(calls.create, [{ detail: 'apps_warn:40:50' }]);
  assert.deepEqual(calls.publish, [11, 12], 'each row goes out live after the commit');
  const sqls = pool.state.queries.map((q) => q.sql);
  const begin = sqls.indexOf('BEGIN');
  const lock = sqls.findIndex((s) => /FOR UPDATE$/.test(s));
  const update = sqls.findIndex((s) => /^UPDATE platform_limit_alerts/.test(s));
  const commit = sqls.indexOf('COMMIT');
  assert.ok(begin >= 0 && begin < lock && lock < update && update < commit,
    'the level is read under a row lock and written before the commit');
  assert.deepEqual(pool.state.updates[0], ['apps', 'warn', 40, 50, true]);
});

test('the same crossing evaluated again is silent', async () => {
  const pool = fakePool({ apps: 41, level: 'warn' });
  const { calls, deps } = recorder();
  const out = await limits.evaluate(pool, CONFIG, 'apps', deps);
  assert.equal(out.notified, null);
  assert.deepEqual(calls.create, []);
  assert.deepEqual(calls.publish, []);
  assert.deepEqual(pool.state.updates[0], ['apps', 'warn', 41, 50, false],
    'the figures are still refreshed');
});

test('a preview records the level but notifies nobody', async () => {
  const pool = fakePool({ sessions: 75 });
  const { calls, deps } = recorder();
  const out = await limits.evaluate(pool, CONFIG, 'sessions', { ...deps, staging: true });
  assert.equal(out.level, 'full');
  assert.equal(out.recipients, 0);
  assert.deepEqual(calls.create, []);
  assert.deepEqual(calls.publish, []);
  assert.equal(pool.state.level, 'full');
});

test('each cap counts exactly what its enforcing route counts', async () => {
  const pool = fakePool({ sessions: 10 });
  await limits.evaluate(pool, CONFIG, 'sessions', recorder().deps);
  const count = pool.state.queries.find((q) => /FROM chat_sessions/.test(q.sql)).sql;
  // routes/sessions.js's global-cap probe.
  assert.match(count, /status IN \('active', 'promoted'\)/);
  assert.match(count, /source IS DISTINCT FROM 'imported'/);
  assert.match(count, /is_synthetic = TRUE/);
  const routes = collapse(read('src/routes/sessions.js'));
  assert.ok(routes.includes("AND source IS DISTINCT FROM 'imported' AND user_id NOT IN (SELECT id FROM users WHERE is_synthetic = TRUE)"),
    'the sessions route still counts the same way');
  const apps = collapse(read('src/routes/apps.js'));
  assert.ok(apps.includes("SELECT COUNT(*)::int AS n FROM apps WHERE status <> 'error'"),
    'the apps route still counts the same way');
});

test('a cap that is off records ok and pages nobody', async () => {
  const pool = fakePool({ apps: 900, level: 'full' });
  const { calls, deps } = recorder();
  const out = await limits.evaluate(pool, { maxApps: 0 }, 'apps', deps);
  assert.equal(out.level, 'ok');
  assert.deepEqual(calls.create, []);
  assert.deepEqual(pool.state.updates[0], ['apps', 'ok', 900, null, false]);
});

test('the sweep checks every cap and one failure does not stop the other', async () => {
  const pool = fakePool({ countError: new Error('db down'), sessions: 60 });
  const { calls, deps } = recorder();
  const out = await limits.sweep(pool, CONFIG, deps);
  assert.deepEqual(out.errors, ['apps: db down']);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].key, 'sessions');
  assert.deepEqual(calls.create, [{ detail: 'sessions_warn:60:75' }]);
});

test('an unknown cap is refused, and a nudge for a cap that is off does nothing', async () => {
  await assert.rejects(limits.evaluate(fakePool(), CONFIG, 'disk', {}), /unknown platform limit/);
  const pool = fakePool({ apps: 100 });
  limits.nudge(pool, { maxApps: 0 }, 'apps');
  limits.nudge(pool, CONFIG, 'disk');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.state.queries.length, 0, 'route tests mounted with maxApps: 0 never see it');
});

// ─── 3. Wiring ──────────────────────────────────────────────────────────

test('the leader sweeps, and shutdown clears both handles', () => {
  const server = read('server.js');
  const leader = server.slice(server.indexOf('async function becomeLeader()'));
  assert.match(leader.slice(0, leader.indexOf('\n}\n')), /startPlatformLimitSweeper\(config\);/);
  assert.match(server, /function startPlatformLimitSweeper\(config\) \{/);
  assert.match(server, /clearTimeout\(platformLimitFirstRunHandle\)/);
  assert.match(server, /clearInterval\(platformLimitSweeperHandle\)/);
});

test('both app-create routes nudge the apps check on success and on refusal', () => {
  const src = read('src/routes/apps.js');
  const nudges = src.match(/platformLimits\.nudge\(pool, config, 'apps'\);/g) || [];
  assert.equal(nudges.length, 4, 'create 201, create 429, fork 201, fork 429');
});

test('the detail format is spelled identically wherever it is parsed', () => {
  const literal = String.raw`/^(apps|sessions)_(warn|full):(\d{1,7}):(\d{1,7})$/`;
  for (const rel of [
    'src/services/platform-limit-alerts.js',
    'src/services/mobile-push-policy.js',
    'frontend/src/features/notifications/notifications.js',
  ]) {
    assert.ok(read(rel).includes(literal), `${rel} parses the same token`);
  }
  assert.deepEqual(limits.LIMITS.map((l) => l.key), ['apps', 'sessions'],
    'a new cap must be added to the token pattern in all three places');
});

test('both tunables are declared so the Platform variables panel lists them', () => {
  const manifest = JSON.parse(read('dapp.json'));
  const keys = new Map(manifest.platform_env.map((entry) => [entry.key, entry]));
  assert.equal(keys.get('MAX_APPS')?.default, '50', 'matches src/config.js');
  assert.equal(keys.get('PLATFORM_LIMIT_WARN_PERCENT')?.default, String(limits.DEFAULT_WARN_PERCENT));
  assert.match(read('src/config.js'), /maxApps: parseInt\(process\.env\.MAX_APPS \|\| '50', 10\)/);
});
