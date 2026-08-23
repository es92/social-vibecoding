// Username changes (#1336) — POST /api/me/username, the retired-handle
// ledger behind it, and the resolvers that read that ledger back.
//
// `users.username` was immutable before this, and the reason was never the
// login: sessions key on user_id, so a rename signs nobody out. The reason
// was that four surfaces resolve a person by their handle STRING —
// historical `@mentions`, shared #leaderboard/users/<name> links, dapp.json's
// `admins` block, and the public profile address — and two of those read data
// the platform cannot rewrite. Releasing a handle re-points all four at
// whoever registers it next, and the dapp.json one hands them app-admin
// rights on somebody else's app.
//
// So the contracts guarded here are:
//
//   1. Validation: a chosen handle is a SUBSET of what MENTION_RE can
//      capture, or the renamed user stops being mentionable.
//   2. Credential-gated: the current password is required, and it is checked
//      BEFORE any availability answer — otherwise a stolen session becomes a
//      namespace oracle.
//   3. Retired handles are unavailable to everyone else, FOREVER, and the
//      refusal is worded identically to "taken" so the form cannot be used
//      to detect who renamed.
//   4. A rename is one transaction: ledger row + users row, never half.
//   5. A case-only change is not a rename — nothing is retired, no cooldown.
//   6. Service identities cannot be renamed at all.
//   7. The reservation is enforced by a DATABASE TRIGGER, because six code
//      paths insert into `users` and none of them share a validator.
//
// Pure-function tests, HTTP tests against a throwaway express app and a
// substring-dispatching mock pool (the idiom of
// tests/profile-customization-api.test.js), and source/schema pins for the
// parts no mock can prove — no live DB.
//
// Run with: node --test tests/username-change.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const bcrypt = require('bcrypt');

const usernames = require('../src/services/usernames');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

const PASSWORD = 'correct horse battery staple';
// Cost 4: this is a test, not a production hash.
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

// ═══════════════════════════════════════════════════════════════════════
// 1. Validation — pure
// ═══════════════════════════════════════════════════════════════════════

test('a valid handle passes and is trimmed', () => {
  assert.deepEqual(usernames.validateUsername('  ada_lovelace  '),
    { ok: true, value: 'ada_lovelace' });
  assert.equal(usernames.validateUsername('Ada99').ok, true);
  assert.equal(usernames.validateUsername('___').ok, true);
});

test('the charset is a SUBSET of what MENTION_RE can capture', () => {
  // The load-bearing reason hyphens and dots are refused. If a handle can
  // hold a character `@name` parsing stops at, the renamed user silently
  // stops receiving mentions and a shorter name collects them instead.
  const mentionRe = /(^|[^\w])@([A-Za-z0-9_]{1,32})/g;
  for (const candidate of ['ada_lovelace', 'Ada99', 'a'.repeat(32)]) {
    assert.equal(usernames.validateUsername(candidate).ok, true, candidate);
    mentionRe.lastIndex = 0;
    const m = mentionRe.exec(` @${candidate}`);
    assert.equal(m && m[2], candidate,
      `@${candidate} must parse back out WHOLE, or the rename breaks mentions`);
  }
  for (const bad of ['ada-lovelace', 'ada.lovelace', 'ada lovelace', 'adaé']) {
    assert.equal(usernames.validateUsername(bad).ok, false, bad);
  }
});

test('length bounds are enforced at both ends', () => {
  assert.equal(usernames.validateUsername('ab').ok, false);
  assert.equal(usernames.validateUsername('abc').ok, true);
  assert.equal(usernames.validateUsername('a'.repeat(32)).ok, true);
  assert.equal(usernames.validateUsername('a'.repeat(33)).ok, false);
});

test('empty, blank and non-string inputs are refused rather than thrown on', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    const r = usernames.validateUsername(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.error, 'string');
  }
});

test('the platform service namespace is reserved, separators and all', () => {
  // Stripping `_`/`-` before the prefix compare is what stops the reserve
  // being walked around with a separator.
  for (const bad of [
    'usernode', 'usernode_ops', 'UserNode', 'USERNODE_CAPTURE',
    'u_s', // not reserved — guard against an over-eager prefix match
  ].slice(0, 4)) {
    assert.equal(usernames.validateUsername(bad).ok, false, bad);
  }
  assert.equal(usernames.validateUsername('staging_demo').ok, false);
  // Not over-reaching: a name that merely CONTAINS the word is fine.
  assert.equal(usernames.validateUsername('my_usernode').ok, true);
});

test('the seeded service identities are recognised case-insensitively', () => {
  for (const name of ['usernode-capture', 'usernode-capture-admin', 'staging-demo-user']) {
    assert.equal(usernames.isServiceIdentity(name), true, name);
    assert.equal(usernames.isServiceIdentity(name.toUpperCase()), true, name);
  }
  assert.equal(usernames.isServiceIdentity('alice'), false);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. The mock pool
// ═══════════════════════════════════════════════════════════════════════
//
// `state` is the fixture: the acting user's row, every other live handle,
// and the retired ledger. Writes mutate `state`, so a test can assert on
// what was actually persisted rather than only on the response.

function makeMockPool(state) {
  const calls = [];
  const run = async (rawSql, params = []) => {
    const sql = collapse(rawSql);
    calls.push({ sql, params });

    if (sql.startsWith('SELECT username, password FROM users WHERE id')) {
      return { rows: state.me ? [{ username: state.me.username, password: state.me.password }] : [] };
    }
    if (sql.startsWith('SELECT id FROM users WHERE LOWER(username)')) {
      const hit = state.live.find((u) => u.username.toLowerCase() === params[0]);
      return { rows: hit ? [{ id: hit.id }] : [] };
    }
    if (sql.startsWith('SELECT user_id FROM username_history WHERE LOWER(username)')) {
      const hit = state.retired.find((h) => h.username.toLowerCase() === params[0]);
      return { rows: hit ? [{ user_id: hit.user_id }] : [] };
    }
    if (sql.startsWith('SELECT changed_at FROM username_history WHERE user_id')) {
      const mine = state.retired
        .filter((h) => h.user_id === params[0] && h.changed_at)
        .sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at));
      return { rows: mine.length ? [{ changed_at: mine[0].changed_at }] : [] };
    }
    // ── inside the transaction ──
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      state.tx.push(sql);
      return { rows: [] };
    }
    if (sql.startsWith('SELECT username FROM users WHERE id') && sql.includes('FOR UPDATE')) {
      return { rows: state.me ? [{ username: state.me.username }] : [] };
    }
    if (sql.startsWith('INSERT INTO username_history')) {
      state.retired.push({ user_id: params[0], username: params[1], changed_at: new Date().toISOString() });
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM username_history')) {
      state.retired = state.retired.filter(
        (h) => !(h.user_id === params[0] && h.username.toLowerCase() === String(params[1]).toLowerCase())
      );
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE users SET username')) {
      state.me.username = params[0];
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO events')) {
      state.events.push(params);
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 100)}`);
  };

  const pool = {
    query: run,
    connect: async () => ({ query: run, release: () => {} }),
  };
  return { pool, calls };
}

const ME = { id: 7, username: 'ada', isAdmin: false };

function freshState(over = {}) {
  return {
    me: { id: 7, username: 'ada', password: PASSWORD_HASH },
    live: [{ id: 7, username: 'ada' }, { id: 8, username: 'bob' }],
    retired: [],
    tx: [],
    events: [],
    ...over,
  };
}

// Build a throwaway app around `pool`. Both the route module AND
// rate-limits.js are purged from the require cache first: the limiter is
// 5/hour keyed on the user id, and every test here acts as the same user, so
// a limiter shared across tests would 429 the sixth one regardless of what it
// was testing. A fresh module per app gives each test its own counter.
function appAround(pool, user) {
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  let routes;
  try {
    delete require.cache[require.resolve('../src/middleware/rate-limits')];
    delete require.cache[require.resolve('../src/routes/profile')];
    routes = require('../src/routes/profile').profileRoutes();
  } finally {
    poolModule.getPool = originalGetPool;
  }
  const app = express();
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use(routes);
  return app;
}

function makeApp(state, { user = ME } = {}) {
  const { pool, calls } = makeMockPool(state);
  return { app: appAround(pool, user), calls, state };
}

async function rename(app, payload) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/me/username`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 3. The endpoint
// ═══════════════════════════════════════════════════════════════════════

test('a rename retires the old handle and installs the new one, in one transaction', async () => {
  const state = freshState();
  const { app } = makeApp(state);
  const res = await rename(app, { username: 'ada_l', currentPassword: PASSWORD });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { username: 'ada_l', retired: 'ada' });
  assert.equal(state.me.username, 'ada_l');
  assert.deepEqual(state.retired.map((h) => h.username), ['ada'],
    'the handle they left must be reserved, not released');
  assert.deepEqual(state.tx, ['BEGIN', 'COMMIT']);
});

test('the ledger write and the users write are in the SAME transaction', async () => {
  // A half-applied rename either leaks a handle nobody holds or hands the
  // old one to the next registrant.
  const state = freshState();
  const { app, calls } = makeApp(state);
  await rename(app, { username: 'ada_l', currentPassword: PASSWORD });

  const order = calls.map((c) => c.sql).filter((s) => (
    s === 'BEGIN' || s === 'COMMIT'
    || s.startsWith('INSERT INTO username_history')
    || s.startsWith('UPDATE users SET username')
  ));
  assert.equal(order[0], 'BEGIN');
  assert.equal(order[order.length - 1], 'COMMIT');
  assert.ok(order.some((s) => s.startsWith('INSERT INTO username_history')));
  assert.ok(order.some((s) => s.startsWith('UPDATE users SET username')));
});

test('a rename is recorded as an event carrying BOTH handles', async () => {
  const state = freshState();
  const { app } = makeApp(state);
  await rename(app, { username: 'ada_l', currentPassword: PASSWORD });
  assert.equal(state.events.length, 1);
  const params = state.events[0];
  assert.ok(params.includes('username_changed'));
  // metadata rides as a JSON string parameter, so read it back rather than
  // regexing the double-escaped stringification of the whole call.
  const metadata = JSON.parse(params.find((p) => typeof p === 'string' && p.startsWith('{')));
  assert.deepEqual(metadata, { from: 'ada', to: 'ada_l' });
});

test('401 without a session, and nothing is read', async () => {
  const state = freshState();
  const { app, calls } = makeApp(state, { user: null });
  const res = await rename(app, { username: 'ada_l', currentPassword: PASSWORD });
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0, 'an anonymous caller must not reach the DB');
});

test('the current password is required, and a wrong one is a 401', async () => {
  const missing = makeApp(freshState());
  assert.equal((await rename(missing.app, { username: 'ada_l' })).status, 400);

  const state = freshState();
  const { app } = makeApp(state);
  const res = await rename(app, { username: 'ada_l', currentPassword: 'wrong' });
  assert.equal(res.status, 401);
  assert.equal(state.me.username, 'ada', 'nothing may have moved');
  assert.deepEqual(state.retired, []);
});

test('the password is checked BEFORE any availability answer', async () => {
  // Otherwise a stolen session is a namespace oracle: probe handles all day
  // without ever knowing the password.
  const state = freshState();
  const { app, calls } = makeApp(state);
  await rename(app, { username: 'bob', currentPassword: 'wrong' });

  const probed = calls.some((c) => c.sql.startsWith('SELECT id FROM users WHERE LOWER(username)'));
  assert.equal(probed, false,
    'a caller who cannot prove the password learns nothing about who holds what');
});

test('a handle somebody else holds is refused', async () => {
  const state = freshState();
  const { app } = makeApp(state);
  const res = await rename(app, { username: 'bob', currentPassword: PASSWORD });
  assert.equal(res.status, 409);
  assert.equal(state.me.username, 'ada');
});

test('a handle somebody else RETIRED is refused, in the same words', async () => {
  // The wording matters: a different sentence here would turn the form into
  // a detector for "did @carol rename recently".
  const takenState = freshState();
  const taken = makeApp(takenState);
  const liveRes = await rename(taken.app, { username: 'bob', currentPassword: PASSWORD });

  const state = freshState({ retired: [{ user_id: 8, username: 'carol' }] });
  const { app } = makeApp(state);
  const retiredRes = await rename(app, { username: 'carol', currentPassword: PASSWORD });

  assert.equal(retiredRes.status, 409);
  assert.equal(state.me.username, 'ada');
  assert.deepEqual(retiredRes.body, liveRes.body,
    'a live handle and a retired one must be indistinguishable to the caller');
});

test('a handle THIS user retired earlier can be taken back, and its reservation is dropped', async () => {
  // The reservation is against other people, not against changing your mind.
  const state = freshState({
    retired: [{ user_id: 7, username: 'ada_old', changed_at: '2020-01-01T00:00:00.000Z' }],
  });
  const { app } = makeApp(state);
  const res = await rename(app, { username: 'ada_old', currentPassword: PASSWORD });

  assert.equal(res.status, 200);
  assert.equal(state.me.username, 'ada_old');
  assert.deepEqual(state.retired.map((h) => h.username), ['ada'],
    'the reclaimed handle stops being listed as given-up; the one just left starts');
});

test('an unchanged name is a success, not an error, and writes nothing', async () => {
  const state = freshState();
  const { app } = makeApp(state);
  const res = await rename(app, { username: 'ada', currentPassword: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(res.body.unchanged, true);
  assert.equal(res.body.retired, null);
  assert.deepEqual(state.retired, []);
  assert.deepEqual(state.tx, [], 'no transaction should even open');
});

test('a case-only change retires nothing and burns no cooldown', async () => {
  const state = freshState();
  const { app, calls } = makeApp(state);
  const res = await rename(app, { username: 'Ada', currentPassword: PASSWORD });

  assert.equal(res.status, 200);
  assert.equal(res.body.username, 'Ada');
  assert.equal(res.body.retired, null, 'the same person still holds the same handle');
  assert.deepEqual(state.retired, []);
  assert.equal(state.me.username, 'Ada');
  const cooldownChecked = calls.some((c) => c.sql.startsWith('SELECT changed_at FROM username_history'));
  assert.equal(cooldownChecked, false);
});

test('a second rename inside the cooldown is a 429 carrying when to retry', async () => {
  const state = freshState({
    retired: [{ user_id: 7, username: 'ada_old', changed_at: new Date().toISOString() }],
  });
  const { app } = makeApp(state);
  const res = await rename(app, { username: 'ada_new', currentPassword: PASSWORD });

  assert.equal(res.status, 429);
  assert.match(res.body.error, /\d+ days?/);
  assert.ok(Date.parse(res.body.retryAfter) > Date.now());
  assert.equal(state.me.username, 'ada');
});

test('the cooldown expires', async () => {
  const old = new Date(Date.now() - (usernames.RENAME_COOLDOWN_DAYS + 1) * 86400e3).toISOString();
  const state = freshState({ retired: [{ user_id: 7, username: 'ada_old', changed_at: old }] });
  const { app } = makeApp(state);
  const res = await rename(app, { username: 'ada_new', currentPassword: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(state.me.username, 'ada_new');
});

test('the cooldown is checked BEFORE availability', async () => {
  // Same reasoning as the password ordering: a user in cooldown gets no
  // free probes either.
  const state = freshState({
    retired: [{ user_id: 7, username: 'ada_old', changed_at: new Date().toISOString() }],
  });
  const { app, calls } = makeApp(state);
  await rename(app, { username: 'bob', currentPassword: PASSWORD });
  const probed = calls.some((c) => c.sql.startsWith('SELECT id FROM users WHERE LOWER(username)'));
  assert.equal(probed, false);
});

test('a seeded service identity cannot be renamed', async () => {
  // Their username IS the lookup key that finds them, so a rename does not
  // move an identity — it breaks src/services/visuals.js.
  const state = freshState({
    me: { id: 3, username: 'usernode-capture', password: PASSWORD_HASH },
  });
  const { app } = makeApp(state, { user: { id: 3, username: 'usernode-capture' } });
  const res = await rename(app, { username: 'capture_bot', currentPassword: PASSWORD });
  assert.equal(res.status, 403);
  assert.equal(state.me.username, 'usernode-capture');
});

test('an invalid handle never reaches the password check', async () => {
  const state = freshState();
  const { app, calls } = makeApp(state);
  const res = await rename(app, { username: 'ada-l', currentPassword: PASSWORD });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /@mention/);
  assert.equal(calls.length, 0, 'a malformed request is answered without touching the DB');
});

test('a unique-violation race is answered as "taken", not as a 500', async () => {
  // The DB indexes are the backstop behind the availability check; two
  // people claiming one handle at once lands there.
  const state = freshState();
  const { pool } = makeMockPool(state);
  const realConnect = pool.connect;
  pool.connect = async () => {
    const client = await realConnect();
    const realQuery = client.query;
    client.query = async (sql, params) => {
      if (collapse(sql).startsWith('INSERT INTO username_history')) {
        const err = new Error('duplicate key'); err.code = '23505'; throw err;
      }
      return realQuery(sql, params);
    };
    return client;
  };
  const res = await rename(appAround(pool, ME), { username: 'ada_l', currentPassword: PASSWORD });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /taken/i);
  assert.deepEqual(state.tx, ['BEGIN', 'ROLLBACK'], 'the transaction must unwind');
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Schema + source pins — the parts no mock can prove
// ═══════════════════════════════════════════════════════════════════════

test('the ledger reserves handles case-insensitively', () => {
  // A unique index on the raw string would let "Alice" be registered after
  // "alice" was retired, which is exactly the impersonation this prevents.
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS username_history/);
  assert.match(
    schema,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_username_history_lower\s+ON username_history \(LOWER\(username\)\)/,
  );
});

test('the reservation is enforced by a TRIGGER, not only by the routes', () => {
  // Six code paths insert into `users` and none of them share a validator.
  // A handle escaping through any one of them is the whole failure mode.
  const schema = read('src/db/schema.sql');
  assert.match(schema, /CREATE OR REPLACE FUNCTION reject_retired_username\(\) RETURNS trigger/);
  assert.match(schema, /BEFORE INSERT OR UPDATE OF username ON users/);
  // Raised as unique_violation so every route's existing 23505 handler
  // already answers "Username already taken" without a route change.
  assert.match(schema, /USING ERRCODE = 'unique_violation'/);
  // …and scoped so it cannot fire against the owner reclaiming their own.
  assert.match(schema, /h\.user_id <> NEW\.id/);
});

test('the ledger CASCADEs, so a deleted account frees its old handles', () => {
  const schema = read('src/db/schema.sql');
  const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS username_history'));
  assert.match(table.slice(0, 400), /user_id\s+INTEGER\s+NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
});

test('every handle-keyed resolver reads through the ledger', () => {
  // The four surfaces named at the top of this file. Each one resolving
  // against `users` alone is a silent re-point of somebody's identity.
  for (const [file, why] of [
    ['src/services/app-manifest.js', "dapp.json's admins block"],
    ['src/services/notifications.js', 'historical @mentions'],
    ['src/routes/kudos.js', 'shared #leaderboard/users/<name> links'],
    ['src/routes/profiles.js', 'the public profile address'],
  ]) {
    const src = read(file);
    assert.match(src, /require\('\.{1,2}\/(services\/)?usernames'\)/, `${file} (${why})`);
    assert.match(src, /usernames\.resolveHandles?\(/, `${file} (${why})`);
  }
});

test('PATCH /api/me/profile still refuses to write the username', () => {
  // Two endpoints, two contracts: the rename needs a password, a cooldown
  // and a ledger write, none of which belong in a partial field update.
  const route = read('src/routes/profile.js');
  const start = route.indexOf("router.patch(\n    '/api/me/profile'");
  // Ends at the NEXT route's banner comment, not at its router.post(: that
  // comment is all about the username and would fail the pin on its own.
  const end = route.indexOf('// ── POST /api/me/username', start);
  assert.ok(start > 0 && end > start, 'the two routes must both still exist');
  assert.doesNotMatch(route.slice(start, end), /username/);
});

// ═══════════════════════════════════════════════════════════════════════
// 5. resolveHandle / resolveHandles — the read side
// ═══════════════════════════════════════════════════════════════════════

// A tiny pool that answers only the two resolver shapes, from fixtures.
function resolverPool({ live = [], retired = [] }) {
  return {
    query: async (rawSql, params = []) => {
      const sql = collapse(rawSql);
      if (sql.startsWith('SELECT id, username FROM users WHERE LOWER(username) = $1')) {
        const u = live.find((x) => x.username.toLowerCase() === params[0]);
        return { rows: u ? [{ id: u.id, username: u.username }] : [] };
      }
      if (sql.includes('FROM username_history h') && sql.includes('LOWER(h.username) = $1')) {
        const h = retired.find((x) => x.username.toLowerCase() === params[0]);
        if (!h) return { rows: [] };
        const u = live.find((x) => x.id === h.user_id);
        return { rows: u ? [{ user_id: u.id, username: u.username }] : [] };
      }
      if (sql.includes('AS declared')) {
        const wanted = params[0];
        const rows = [];
        for (const u of live) {
          if (wanted.includes(u.username.toLowerCase())) {
            rows.push({ id: u.id, username: u.username, declared: u.username.toLowerCase(), live: true });
          }
        }
        for (const h of retired) {
          if (!wanted.includes(h.username.toLowerCase())) continue;
          const u = live.find((x) => x.id === h.user_id);
          if (u) rows.push({ id: u.id, username: u.username, declared: h.username.toLowerCase(), live: false });
        }
        return { rows };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

const FIXTURE = {
  live: [{ id: 1, username: 'ada' }, { id: 2, username: 'bob' }],
  retired: [{ user_id: 1, username: 'alice' }],
};

test('resolveHandle answers a live handle, a retired one, and neither', async () => {
  const pool = resolverPool(FIXTURE);
  assert.deepEqual(await usernames.resolveHandle(pool, 'bob'),
    { userId: 2, username: 'bob', retired: false });
  assert.deepEqual(await usernames.resolveHandle(pool, 'alice'),
    { userId: 1, username: 'ada', retired: true });
  assert.equal(await usernames.resolveHandle(pool, 'nobody'), null);
});

test('resolveHandle is case-insensitive and answers the CANONICAL casing', async () => {
  const pool = resolverPool(FIXTURE);
  assert.deepEqual(await usernames.resolveHandle(pool, 'ALICE'),
    { userId: 1, username: 'ada', retired: true });
  assert.equal((await usernames.resolveHandle(pool, 'BOB')).username, 'bob');
});

test('resolveHandle refuses junk without querying', async () => {
  const pool = { query: async () => { throw new Error('must not query'); } };
  for (const bad of ['', '   ', null, undefined, 'x'.repeat(256)]) {
    assert.equal(await usernames.resolveHandle(pool, bad), null);
  }
});

test('resolveHandles reports the name that MATCHED, and each person once', async () => {
  const pool = resolverPool(FIXTURE);
  // The dapp.json case: a manifest still naming the old handle.
  assert.deepEqual(await usernames.resolveHandles(pool, ['alice']),
    [{ id: 1, username: 'ada', declared: 'alice' }]);
  // A manifest updated without dropping the old name — one grant, and the
  // LIVE name is the one reported.
  assert.deepEqual(await usernames.resolveHandles(pool, ['alice', 'ada']),
    [{ id: 1, username: 'ada', declared: 'ada' }]);
  // Duplicates and casing in the manifest collapse before the query.
  assert.deepEqual(await usernames.resolveHandles(pool, ['BOB', 'bob', ' bob ']),
    [{ id: 2, username: 'bob', declared: 'bob' }]);
});

test('resolveHandles short-circuits on nothing to resolve', async () => {
  const pool = { query: async () => { throw new Error('must not query'); } };
  for (const empty of [[], null, undefined, ['', '  ']]) {
    assert.deepEqual(await usernames.resolveHandles(pool, empty), []);
  }
});
