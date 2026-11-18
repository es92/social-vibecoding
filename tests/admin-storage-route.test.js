'use strict';

// #2253: the admin console's App storage endpoints (src/routes/admin.js).
//
// The permission split is the load-bearing part, as it is for the credit
// endpoints beside them: the GET is a pure read and view-only admins are
// squarely its audience, while the PUT and the sweep change what a real
// Postgres role may do and are full-admin only. The rest is validation and
// the staging demo branch.
//
// Stubbed-pool + real-express pattern, cf. tests/anthropic-credits-route.test.js.
// The service underneath is the real one; only its two Postgres seams
// (db-manager's measurement and role statements) and the notification
// creator are replaced, by swapping the module exports the service reads
// at call time.
//
// USERNODE_ENV is 'staging' at require time so the ?demo=1 branch (a
// module-level constant in admin.js) is live; the service reads the same
// variable at CALL time, so the tests that need production semantics
// unset it for their duration.
//
// Run with: node --test tests/admin-storage-route.test.js

process.env.USERNODE_ENV = 'staging';

const test = require('node:test');
const assert = require('node:assert/strict');

const GIB = 1024 * 1024 * 1024;
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// The same in-memory apps table tests/app-storage-cap.test.js drives the
// service with, so the routes are exercised against real service code.
let apps = [];
function app(id, slug, extra = {}) {
  return {
    id, slug, name: slug.replace(/-/g, ' '), self_hosted: false,
    db_size_bytes: null, db_size_measured_at: null, db_storage_cap_bytes: null,
    db_storage_frozen_at: null, db_storage_grace_until: null, db_storage_warned_at: null,
    db_storage_warn_level: null,
    ...extra,
  };
}
const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  async query(sql, params) {
    const q = norm(sql);
    const bySlug = (slug) => apps.find((a) => a.slug === slug && !a.self_hosted);
    const byId = (id) => apps.find((a) => a.id === id);
    if (/^SELECT .* FROM apps WHERE NOT self_hosted$/.test(q)) {
      return { rows: apps.filter((a) => !a.self_hosted).map((a) => ({ ...a })) };
    }
    if (/^SELECT .* FROM apps WHERE slug = \$1 AND NOT self_hosted$/.test(q)) {
      const a = bySlug(params[0]);
      return { rows: a ? [{ ...a }] : [] };
    }
    if (/^UPDATE apps SET db_storage_grace_until = \$1 WHERE slug = \$2/.test(q)) {
      const a = bySlug(params[1]);
      if (!a) return { rows: [] };
      a.db_storage_grace_until = params[0];
      return { rows: [{ id: a.id, slug: a.slug, db_storage_frozen_at: a.db_storage_frozen_at }] };
    }
    if (/^UPDATE apps SET db_storage_cap_bytes = \$1 WHERE slug = \$2/.test(q)) {
      const a = bySlug(params[1]);
      if (!a) return { rows: [] };
      a.db_storage_cap_bytes = params[0];
      return { rows: [{ id: a.id }] };
    }
    if (/^UPDATE apps SET db_size_bytes = \$1, db_size_measured_at = \$2 WHERE id = \$3$/.test(q)) {
      const a = byId(params[2]);
      a.db_size_bytes = params[0];
      a.db_size_measured_at = params[1];
      return { rows: [] };
    }
    // A transition runs under the app row's lock (a transaction).
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(q)) return { rows: [] };
    if (/^SELECT db_storage_frozen_at, db_storage_grace_until, db_storage_cap_bytes FROM apps WHERE id = \$1 FOR UPDATE$/.test(q)) {
      const a = byId(params[0]);
      return { rows: a ? [{ db_storage_frozen_at: a.db_storage_frozen_at, db_storage_grace_until: a.db_storage_grace_until, db_storage_cap_bytes: a.db_storage_cap_bytes }] : [] };
    }
    if (/^UPDATE apps SET db_storage_frozen_at = \$1, db_storage_warned_at = COALESCE\(db_storage_warned_at, \$1\), db_storage_warn_level = 2 WHERE id = \$2$/.test(q)) {
      const a = byId(params[1]);
      a.db_storage_frozen_at = params[0];
      if (!a.db_storage_warned_at) a.db_storage_warned_at = params[0];
      a.db_storage_warn_level = 2;
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE apps SET db_storage_warn_level = 1 WHERE id = \$1 AND COALESCE\(db_storage_warn_level, 0\) < 1$/.test(q)) {
      const a = byId(params[0]);
      if ((a.db_storage_warn_level || 0) >= 1) return { rows: [], rowCount: 0 };
      a.db_storage_warn_level = 1;
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE apps SET db_storage_warn_level = 2, db_storage_warned_at = COALESCE\(db_storage_warned_at, \$1\) WHERE id = \$2 AND COALESCE\(db_storage_warn_level, 0\) < 2$/.test(q)) {
      const a = byId(params[1]);
      if ((a.db_storage_warn_level || 0) >= 2) return { rows: [], rowCount: 0 };
      a.db_storage_warn_level = 2;
      if (!a.db_storage_warned_at) a.db_storage_warned_at = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE apps SET db_storage_warn_level = \$1, db_storage_warned_at = NULL WHERE id = \$2 AND \(db_storage_warn_level IS DISTINCT FROM \$1 OR db_storage_warned_at IS NOT NULL\)$/.test(q)) {
      const a = byId(params[1]);
      const next = params[0] == null ? null : Number(params[0]);
      const cur = a.db_storage_warn_level == null ? null : Number(a.db_storage_warn_level);
      if (cur === next && !a.db_storage_warned_at) return { rows: [], rowCount: 0 };
      a.db_storage_warn_level = next;
      a.db_storage_warned_at = null;
      return { rows: [], rowCount: 1 };
    }
    // The sweep's transitions are compare-and-sets on what it read: each
    // answers how many rows it changed.
    if (/^UPDATE apps SET db_storage_frozen_at = \$1, db_storage_warned_at = COALESCE/.test(q)) {
      const a = byId(params[1]);
      if (a.db_storage_frozen_at || (a.db_storage_grace_until ?? null) !== params[2] || (a.db_storage_cap_bytes ?? null) !== params[3]) return { rows: [], rowCount: 0 };
      a.db_storage_frozen_at = params[0];
      if (!a.db_storage_warned_at) a.db_storage_warned_at = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT db_storage_frozen_at FROM apps WHERE id = \$1$/.test(q)) {
      const a = byId(params[0]);
      return { rows: a ? [{ db_storage_frozen_at: a.db_storage_frozen_at }] : [] };
    }
    if (/^UPDATE apps SET db_storage_frozen_at = NULL WHERE id = \$1 AND db_storage_frozen_at IS NOT NULL$/.test(q)) {
      const a = byId(params[0]);
      if (!a.db_storage_frozen_at) return { rows: [], rowCount: 0 };
      a.db_storage_frozen_at = null;
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE apps SET db_storage_frozen_at = NULL WHERE id = \$1$/.test(q)) {
      byId(params[0]).db_storage_frozen_at = null;
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE apps SET db_storage_warned_at = \$1 WHERE id = \$2 AND db_storage_warned_at IS NULL$/.test(q)) {
      const a = byId(params[1]);
      if (a.db_storage_warned_at) return { rows: [], rowCount: 0 };
      a.db_storage_warned_at = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE apps SET db_storage_warned_at = NULL WHERE id = \$1 AND db_storage_warned_at IS NOT NULL$/.test(q)) {
      const a = byId(params[0]);
      if (!a.db_storage_warned_at) return { rows: [], rowCount: 0 };
      a.db_storage_warned_at = null;
      return { rows: [], rowCount: 1 };
    }
    // Stored files (services/app-files.js): the allowance and the figures.
    if (/^UPDATE apps SET file_storage_cap_bytes = \$1 WHERE slug = \$2 AND NOT self_hosted/.test(q)) {
      const a = bySlug(params[1]);
      if (!a) return { rows: [] };
      a.file_storage_cap_bytes = params[0];
      return { rows: [{ id: a.id, file_storage_cap_bytes: a.file_storage_cap_bytes }] };
    }
    if (/^SELECT COALESCE\(SUM\(size_bytes\), 0\)::bigint AS app_bytes/.test(q)) {
      return { rows: [{ app_bytes: '0', user_bytes: '0', staging_bytes: '0', app_owned_bytes: '0' }] };
    }
    if (/^SELECT a.slug, a.file_storage_cap_bytes/.test(q)) {
      return {
        rows: apps.filter((a) => !a.self_hosted).map((a) => ({
          slug: a.slug, file_storage_cap_bytes: a.file_storage_cap_bytes ?? null,
          file_bytes: a.slug === 'notes' ? String(640 * 1024 * 1024) : '0', app_owned_bytes: '0',
        })),
      };
    }
    return { rows: [] };
  },
});

// The two Postgres seams and the notifier, swapped on the modules the
// service reads them from at call time.
const dbManager = require('../src/services/db-manager');
const notifications = require('../src/services/notifications');
let sizes = [];
const roleCalls = [];
const notifyCalls = [];
dbManager.listAppDatabaseSizes = async () => sizes.map(([dbName, bytes]) => ({ dbName, bytes }));
// Whether a frozen app's role is read-only already: the fixture's frozen
// apps are, so holding them changes nothing.
dbManager.isAppDatabaseReadOnly = async () => true;
dbManager.setAppDatabaseWritable = async (dbName, writable) => {
  roleCalls.push([dbName, writable]);
  return { dbName, role: `${dbName}_owner`, writable };
};
notifications.createAppHealthNotification = async (_pool, args) => { notifyCalls.push(args); return []; };

const appStorageCap = require('../src/services/app-storage-cap');
// The storage clock (src/workflow/clock/) stood in for: a run now runs the
// real sweep against the stub pool, and its result is the job's last run.
const clocks = require('../src/services/clocks');
let lastRun = null;
clocks.runNow = async (job) => {
  assert.equal(job, 'app-storage-cap');
  lastRun = await appStorageCap.sweep(poolMod.getPool());
  return { result: lastRun };
};
clocks.status = async (_db, job) => ({ lastSweepAt: null, lastError: null, sweepInFlight: false, result: job === 'app-storage-cap' ? lastRun : null, nextDueAt: null });
const { adminRoutes } = require('../src/routes/admin');
const express = require('express');

const servers = {};
const bases = {};

function mount(name, user) {
  const app_ = express();
  app_.use(express.json());
  app_.use((req, _res, next) => { req.user = user; next(); });
  app_.use(adminRoutes({ jwtSecret: 'test' }));
  const server = app_.listen(0);
  servers[name] = server;
  return new Promise((r) => server.once('listening', () => {
    bases[name] = `http://127.0.0.1:${server.address().port}`;
    r();
  }));
}

test.before(async () => {
  await mount('full', { id: 1, username: 'admin', isAdmin: true, canAdminWrite: true });
  await mount('viewonly', { id: 2, username: 'mod', isAdmin: true, canAdminWrite: false });
  await mount('user', { id: 3, username: 'nobody', isAdmin: false, canAdminWrite: false });
});

test.after(() => Object.values(servers).forEach((s) => {
  if (!s) return;
  s.close();
  if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
}));

test.beforeEach(() => {
  process.env.USERNODE_ENV = 'staging';
  appStorageCap._resetForTest();
  roleCalls.length = 0;
  notifyCalls.length = 0;
  sizes = [['app_notes', GIB], ['app_big_one', 3.5 * GIB], ['app_notes_staging_s12_abcdef', 9 * GIB]];
  apps = [
    app(1, 'notes', { db_size_bytes: GIB, db_size_measured_at: '2026-09-15T11:45:00.000Z' }),
    app(2, 'big-one', { db_size_bytes: 3.5 * GIB, db_size_measured_at: '2026-09-15T11:45:00.000Z', db_storage_frozen_at: '2026-09-15T11:45:00.000Z', db_storage_warned_at: '2026-09-15T11:00:00.000Z' }),
    app(3, 'usernode', { self_hosted: true }),
  ];
});

const json = (body, method = 'PUT') => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

// ─── Reads ───────────────────────────────────────────────────────────────

test('GET lists every app biggest first with the defaults and no sweep yet', async () => {
  const res = await fetch(`${bases.full}/api/admin/storage`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.apps.map((a) => a.slug), ['big-one', 'notes'], 'the self-hosted row is not an app');
  assert.deepEqual(body.defaults, { capBytes: 3221225472, warnPercent: 80, sweepIntervalMs: 900000, fileCapBytes: 10 * GIB });
  assert.equal(body.lastSweep, null);
  const big = body.apps[0];
  assert.equal(big.state, 'frozen');
  assert.equal(big.dbSizeBytes, 3.5 * GIB);
  assert.equal(big.capBytes, 3221225472);
  assert.equal(big.capOverrideBytes, null);
  assert.equal(big.frozenAt, '2026-09-15T11:45:00.000Z');
  assert.equal(body.apps[1].state, 'ok');
  assert.equal(body.demo, undefined);
});

test('a view-only admin CAN read the figures (the GET must not chain requireAdminWrite)', async () => {
  const res = await fetch(`${bases.viewonly}/api/admin/storage`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.apps.length, 2);
});

test('a non-admin is blocked on every verb and sees no figures', async () => {
  for (const [path, init] of [
    ['/api/admin/storage', { redirect: 'manual' }],
    ['/api/admin/storage/big-one', { ...json({ graceMinutes: 60 }), redirect: 'manual' }],
    ['/api/admin/storage/sweep', { method: 'POST', redirect: 'manual' }],
  ]) {
    const res = await fetch(`${bases.user}${path}`, init);
    assert.ok(res.status >= 300, `non-admin blocked on ${path} (got ${res.status})`);
    const text = await res.text();
    assert.ok(!/big-one|dbSizeBytes|capBytes/.test(text), 'no figures reach a non-admin');
  }
  assert.deepEqual(roleCalls, []);
});

test('?demo=1 on a staging preview answers with the fixed demo rows, never the real ones', async () => {
  const body = await fetch(`${bases.full}/api/admin/storage?demo=1`).then((x) => x.json());
  assert.equal(body.demo, true);
  assert.equal(body.apps.length, 4);
  assert.ok(body.apps.every((a) => /^Staging demo app \d$/.test(a.name)));
  assert.ok(body.apps.some((a) => a.state === 'frozen'), 'one row shows the frozen state');
  assert.ok(body.apps.some((a) => a.state === 'warning'), 'one row shows the warning state');
  assert.ok(!body.apps.some((a) => a.slug === 'big-one'), 'the cloned rows are not mixed in');
  assert.deepEqual(body.defaults, { capBytes: 3221225472, warnPercent: 80, sweepIntervalMs: 900000, fileCapBytes: 10 * GIB });
});

// ─── Writes ──────────────────────────────────────────────────────────────

test('a view-only admin cannot change a cap, grant a window or run the sweep', async () => {
  for (const [path, init] of [
    ['/api/admin/storage/big-one', json({ capBytes: 8 * GIB })],
    ['/api/admin/storage/big-one', json({ graceMinutes: 60 })],
    ['/api/admin/storage/sweep', { method: 'POST' }],
  ]) {
    const res = await fetch(`${bases.viewonly}${path}`, init);
    assert.equal(res.status, 403, path);
  }
  assert.equal(apps[1].db_storage_cap_bytes, null);
  assert.equal(apps[1].db_storage_grace_until, null);
  assert.deepEqual(roleCalls, []);
});

test('PUT validates its body and slug before touching anything', async () => {
  const cases = [
    ['big-one', {}],
    ['big-one', { capBytes: -1 }],
    ['big-one', { capBytes: 1.5 }],
    ['big-one', { capBytes: '5' }],
    ['big-one', { graceMinutes: 0 }],
    ['big-one', { graceMinutes: 1441 }],
    ['big-one', { graceMinutes: 'x' }],
    ['big-one', { graceMinutes: 30.5 }],
    ['Big One', { graceMinutes: 30 }],
    ['bad/slug', { graceMinutes: 30 }],
  ];
  for (const [slug, body] of cases) {
    const res = await fetch(`${bases.full}/api/admin/storage/${encodeURIComponent(slug)}`, json(body));
    assert.equal(res.status, 400, `${slug} ${JSON.stringify(body)}`);
    const out = await res.json();
    assert.ok(out.error, 'a reason comes back');
  }
  assert.equal(apps[1].db_storage_cap_bytes, null);
  assert.equal(apps[1].db_storage_grace_until, null);
  assert.deepEqual(roleCalls, []);
});

test('PUT answers 404 for an app that does not exist or is the platform itself', async () => {
  for (const slug of ['missing', 'usernode']) {
    const res = await fetch(`${bases.full}/api/admin/storage/${slug}`, json({ capBytes: GIB }));
    assert.equal(res.status, 404, slug);
  }
});

test('PUT capBytes sets the override and null clears it, answering with the updated row', async () => {
  let res = await fetch(`${bases.full}/api/admin/storage/notes`, json({ capBytes: 8 * GIB }));
  assert.equal(res.status, 200);
  let row = await res.json();
  assert.equal(row.slug, 'notes');
  assert.equal(row.capBytes, 8 * GIB);
  assert.equal(row.capOverrideBytes, 8 * GIB);
  assert.equal(apps[0].db_storage_cap_bytes, 8 * GIB);

  res = await fetch(`${bases.full}/api/admin/storage/notes`, json({ capBytes: null }));
  assert.equal(res.status, 200);
  row = await res.json();
  assert.equal(row.capBytes, 3221225472);
  assert.equal(row.capOverrideBytes, null);
  assert.equal(apps[0].db_storage_cap_bytes, null);
  assert.deepEqual(roleCalls, [], 'a cap change alone touches no role; the next measurement applies it');
});

test('PUT graceMinutes thaws a frozen app now, in production semantics', async () => {
  delete process.env.USERNODE_ENV;
  const before = Date.now();
  const res = await fetch(`${bases.full}/api/admin/storage/big-one`, json({ graceMinutes: 60 }));
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.state, 'grace');
  assert.equal(row.frozenAt, null);
  const until = new Date(row.graceUntil).getTime();
  assert.ok(until >= before + 60 * 60 * 1000 - 5000 && until <= Date.now() + 60 * 60 * 1000 + 5000,
    'the window is an hour from now');
  assert.deepEqual(roleCalls, [['app_big_one', true]], 'the owner role is made writable at once');
});

test('PUT graceMinutes from a staging preview writes the row but touches no role', async () => {
  const res = await fetch(`${bases.full}/api/admin/storage/big-one`, json({ graceMinutes: 60 }));
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.state, 'grace');
  assert.deepEqual(roleCalls, []);
});

test('PUT with both fields applies the cap and then the window', async () => {
  delete process.env.USERNODE_ENV;
  const res = await fetch(`${bases.full}/api/admin/storage/big-one`, json({ capBytes: 5 * GIB, graceMinutes: 10 }));
  assert.equal(res.status, 200);
  const row = await res.json();
  assert.equal(row.capOverrideBytes, 5 * GIB);
  assert.equal(row.state, 'grace');
  assert.deepEqual(roleCalls, [['app_big_one', true]]);
});

// ─── The sweep ───────────────────────────────────────────────────────────

test('POST sweep runs the measurement now and reports it, and the next GET carries the summary', async () => {
  delete process.env.USERNODE_ENV;
  // big-one is frozen in the fixture; make notes the one that crosses.
  apps[1].db_storage_frozen_at = null;
  apps[1].db_storage_warned_at = null;
  sizes = [['app_notes', GIB], ['app_big_one', 3.5 * GIB], ['app_notes_staging_s12_abcdef', 9 * GIB], ['app_usernode', 9 * GIB]];

  const res = await fetch(`${bases.full}/api/admin/storage/sweep`, { method: 'POST' });
  assert.equal(res.status, 200);
  const { sweep } = await res.json();
  assert.equal(sweep.staging, false);
  assert.equal(sweep.databases, 4);
  assert.equal(sweep.measured, 2);
  assert.equal(sweep.skipped, 2, 'the staging clone and the platform');
  assert.equal(sweep.frozen, 1);
  assert.deepEqual(sweep.errors, []);
  assert.deepEqual(roleCalls, [['app_big_one', false]]);
  assert.deepEqual(notifyCalls, [{ appId: 2, detail: 'storage_full' }]);

  const body = await fetch(`${bases.full}/api/admin/storage`).then((x) => x.json());
  assert.equal(body.lastSweep.measured, 2);
  assert.equal(body.apps[0].slug, 'big-one');
  assert.equal(body.apps[0].state, 'frozen');
  assert.ok(body.apps[0].measuredAt, 'the measurement time was recorded');
});

test('POST sweep from a staging preview records figures but freezes and notifies nothing', async () => {
  apps[1].db_storage_frozen_at = null;
  apps[1].db_storage_warned_at = null;
  const res = await fetch(`${bases.full}/api/admin/storage/sweep`, { method: 'POST' });
  assert.equal(res.status, 200);
  const { sweep } = await res.json();
  assert.equal(sweep.staging, true);
  assert.equal(sweep.measured, 2);
  assert.equal(sweep.frozen, 1, 'the row is stamped so the preview shows the state');
  assert.deepEqual(roleCalls, []);
  assert.deepEqual(notifyCalls, []);
});

test('POST sweep answers 200 with the failure in the summary when measuring fails', async () => {
  const original = dbManager.listAppDatabaseSizes;
  dbManager.listAppDatabaseSizes = async () => { throw new Error('psql: connection refused'); };
  try {
    const res = await fetch(`${bases.full}/api/admin/storage/sweep`, { method: 'POST' });
    assert.equal(res.status, 200, 'the sweep never throws; the answer is the report');
    const { sweep } = await res.json();
    assert.equal(sweep.measured, 0);
    assert.deepEqual(sweep.errors, ['measure: psql: connection refused']);
  } finally {
    dbManager.listAppDatabaseSizes = original;
  }
});

test('POST sweep where no clock runs it (a staging preview) measures on the spot; a failed run says why', async () => {
  const saved = clocks.runNow;
  try {
    clocks.runNow = async () => { throw Object.assign(new Error('The job app-storage-cap cannot run now (not_armed)'), { status: 409, code: 'not_armed' }); };
    sizes = [['app_notes', GIB]];
    let res = await fetch(`${bases.full}/api/admin/storage/sweep`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sweep.measured, 1);

    clocks.runNow = async () => ({ result: null, lastError: 'psql: connection refused' });
    res = await fetch(`${bases.full}/api/admin/storage/sweep`, { method: 'POST' });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'psql: connection refused' });
  } finally {
    clocks.runNow = saved;
  }
});

test('the list carries each app\'s stored files, and PUT fileCapBytes sets its allowance', async () => {
  const list = await (await fetch(`${bases.full}/api/admin/storage`)).json();
  const notes = list.apps.find((a) => a.slug === 'notes');
  assert.equal(notes.fileBytes, 640 * 1024 * 1024);
  assert.equal(notes.fileCapBytes, 10 * GIB);
  assert.equal(notes.fileCapOverrideBytes, null);

  let res = await fetch(`${bases.full}/api/admin/storage/notes`, json({ fileCapBytes: 25 * GIB }));
  assert.equal(res.status, 200);
  let row = await res.json();
  assert.equal(row.slug, 'notes');
  assert.equal(row.fileCapBytes, 25 * GIB);
  assert.equal(row.fileCapOverrideBytes, 25 * GIB);
  assert.equal(row.capBytes, 3221225472, 'the database cap is left alone');
  assert.equal(apps[0].file_storage_cap_bytes, 25 * GIB);

  res = await fetch(`${bases.full}/api/admin/storage/notes`, json({ fileCapBytes: null }));
  row = await res.json();
  assert.equal(row.fileCapBytes, 10 * GIB);
  assert.equal(apps[0].file_storage_cap_bytes, null);

  for (const bad of [-1, 1.5, '5']) {
    const r = await fetch(`${bases.full}/api/admin/storage/notes`, json({ fileCapBytes: bad }));
    assert.equal(r.status, 400, String(bad));
  }
  assert.equal((await fetch(`${bases.full}/api/admin/storage/missing`, json({ fileCapBytes: GIB }))).status, 404);
  assert.equal((await fetch(`${bases.viewonly}/api/admin/storage/notes`, json({ fileCapBytes: GIB }))).status, 403);
});
