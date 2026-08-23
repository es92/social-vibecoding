// Tests for GET /api/leaderboard/users/:username/prs (src/routes/kudos.js)
//
// The (#60) profile drill-in endpoint: every PR a user has PROPOSED,
// newest first, with per-PR kudos credit (direct pr_kudos + awarded
// issue bounties), headline stats, and keyset pagination. Public via
// the '/api/leaderboard/' PUBLIC_PATHS prefix, so the privacy filters
// (public apps only, no headless rows, proposed statuses only) are the
// main thing under test.
//
// Same harness as tests/kudos.test.js: kudosRoutes(config) mounted on a
// throwaway Express app, getPool() swapped for an in-memory mock that
// pattern-matches the handler's three queries and applies the same
// filter semantics in JS over seeded state. The mock also records every
// SQL string so the tests can assert the privacy predicates are
// actually present in the queries (not just emergent from the canned
// rows).
//
// Run with: node --test tests/leaderboard-user-prs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// ─── Module-cache pool/ws stubbing (same pattern as kudos.test.js) ───

function withMockPool(mockPool, fn) {
  const poolModulePath = require.resolve('../src/db/pool');
  const original = require.cache[poolModulePath];
  const stub = {
    exports: { getPool: () => mockPool },
    loaded: true,
    id: poolModulePath,
    filename: poolModulePath,
    paths: original ? original.paths : [],
  };
  require.cache[poolModulePath] = stub;
  delete require.cache[require.resolve('../src/routes/kudos')];
  const wsPath = require.resolve('../src/services/ws');
  const origWs = require.cache[wsPath];
  require.cache[wsPath] = {
    exports: {
      pushNotificationToUser: () => 0,
      pushKudosUpdate: () => {},
    },
    loaded: true,
    id: wsPath,
    filename: wsPath,
    paths: origWs ? origWs.paths : [],
  };
  try {
    return fn();
  } finally {
    if (original) require.cache[poolModulePath] = original;
    else delete require.cache[poolModulePath];
    if (origWs) require.cache[wsPath] = origWs;
    else delete require.cache[wsPath];
    delete require.cache[require.resolve('../src/routes/kudos')];
  }
}

// ─── In-memory mock pool ─────────────────────────────────────────
//
// State shape:
//   users:    [{ id, username }]
//   sessions: [{ id, user_id, status, promoted_at, merged_at, created_at,
//                is_headless, app_public, pr_number, pr_url, pr_title,
//                app_slug, app_name }]
//   kudos:    [{ session_id }]                       (direct pr_kudos)
//   bounties: [{ awarded_session_id, status }]       (issue_bounties)
function makeMockPool(state) {
  const calls = [];

  const PROPOSED = ['promoted', 'merging', 'merged'];
  // Mirror of the handler's proposedFilter semantics.
  const eligible = (cs, userId) =>
    cs.user_id === userId &&
    !cs.is_headless &&
    cs.app_public &&
    (PROPOSED.includes(cs.status) ||
      (cs.status === 'archived' && cs.promoted_at != null));

  const credit = (sessionId) =>
    state.kudos.filter((k) => k.session_id === sessionId).length +
    state.bounties.filter(
      (b) => b.status === 'awarded' && b.awarded_session_id === sessionId
    ).length;

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    // ---- user lookup by handle ----
    // Since #1336 this goes through usernames.resolveHandle: `users` first,
    // then the retired-handle ledger, so a #leaderboard/users/<name> link
    // shared before its owner renamed still lands on them.
    if (/SELECT id, username FROM users WHERE LOWER\(username\) = \$1/i.test(s)) {
      const u = state.users.find((x) => x.username.toLowerCase() === params[0]);
      return { rows: u ? [{ id: u.id, username: u.username }] : [] };
    }
    if (/FROM username_history h/i.test(s)) {
      const h = state.retired.find((x) => x.username.toLowerCase() === params[0]);
      if (!h) return { rows: [] };
      const u = state.users.find((x) => x.id === h.user_id);
      return { rows: u ? [{ user_id: u.id, username: u.username }] : [] };
    }

    // ---- stats aggregate ----
    if (/AS prs_total/i.test(s)) {
      const userId = params[0];
      const list = state.sessions.filter((cs) => eligible(cs, userId));
      const merged = list.filter((cs) => cs.status === 'merged');
      return {
        rows: [{
          prs_total: list.length,
          prs_merged: merged.length,
          kudos_merged: merged.reduce((acc, cs) => acc + credit(cs.id), 0),
        }],
      };
    }

    // ---- page query ----
    if (/AS kudos_count/i.test(s)) {
      const userId = params[0];
      const hasBefore = /cs\.created_at < \$2/i.test(s);
      const before = hasBefore ? params[1] : null;
      const limit = params[params.length - 1];
      const rows = state.sessions
        .filter((cs) => eligible(cs, userId))
        .filter((cs) => (before ? cs.created_at < before : true))
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        .slice(0, limit)
        .map((cs) => ({
          session_id: cs.id,
          pr_number: cs.pr_number ?? null,
          pr_url: cs.pr_url ?? null,
          pr_title: cs.pr_title ?? null,
          status: cs.status,
          created_at: cs.created_at,
          promoted_at: cs.promoted_at ?? null,
          merged_at: cs.merged_at ?? null,
          app_slug: cs.app_slug || 'app',
          app_name: cs.app_name || 'App',
          kudos_count: credit(cs.id),
        }));
      return { rows };
    }

    throw new Error(`unhandled mock SQL: ${s.slice(0, 80)}`);
  }

  return { query, calls };
}

// The endpoint is public (PUBLIC_PATHS prefix) — by default mount it
// with NO req.user shim to prove it never depends on one.
async function startTestServer(pool, user = null) {
  return withMockPool(pool, async () => {
    const { kudosRoutes } = require('../src/routes/kudos');
    const app = express();
    app.use(express.json());
    if (user) app.use((req, _res, next) => { req.user = user; next(); });
    app.use(kudosRoutes({}));
    return new Promise((resolve) => {
      const server = app.listen(0, () => {
        const port = server.address().port;
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          close: () => new Promise((r) => server.close(r)),
        });
      });
    });
  });
}

const iso = (h) => new Date(Date.UTC(2026, 4, 20) - h * 3600 * 1000).toISOString();

// Seeded state used by most tests: alice has one session of every kind,
// only four of which should surface (merged, promoted, merging,
// archived-after-promotion).
function fixtureState() {
  return {
    users: [{ id: 1, username: 'alice' }, { id: 2, username: 'bob' }],
    // Retired handles (#1336), mirroring `username_history`.
    retired: [],
    sessions: [
      { id: 10, user_id: 1, status: 'merged', promoted_at: iso(9), merged_at: iso(8),
        created_at: iso(10), is_headless: false, app_public: true,
        pr_number: 101, pr_url: 'https://github.com/x/y/pull/101', pr_title: 'Merged PR' },
      { id: 11, user_id: 1, status: 'promoted', promoted_at: iso(19),
        created_at: iso(20), is_headless: false, app_public: true,
        pr_number: 102, pr_title: 'Open PR' },
      { id: 12, user_id: 1, status: 'merging', promoted_at: iso(29),
        created_at: iso(30), is_headless: false, app_public: true,
        pr_number: 103, pr_title: 'Merging PR' },
      { id: 13, user_id: 1, status: 'archived', promoted_at: iso(39),
        created_at: iso(40), is_headless: false, app_public: true,
        pr_number: 104, pr_title: 'Closed PR' },
      // Excluded: archived draft (never promoted)
      { id: 14, user_id: 1, status: 'archived', promoted_at: null,
        created_at: iso(50), is_headless: false, app_public: true, pr_number: 105 },
      // Excluded: active draft
      { id: 15, user_id: 1, status: 'active', promoted_at: null,
        created_at: iso(1), is_headless: false, app_public: true, pr_number: 106 },
      // Excluded: headless auto session, even though merged
      { id: 16, user_id: 1, status: 'merged', promoted_at: iso(5),
        created_at: iso(5), is_headless: true, app_public: true, pr_number: 107 },
      // Excluded: merged PR on a view-private app
      { id: 17, user_id: 1, status: 'merged', promoted_at: iso(6),
        created_at: iso(6), is_headless: false, app_public: false, pr_number: 108 },
      // Someone else's PR
      { id: 18, user_id: 2, status: 'merged', promoted_at: iso(7),
        created_at: iso(7), is_headless: false, app_public: true, pr_number: 109 },
    ],
    kudos: [
      { session_id: 10 }, { session_id: 10 },     // 2 direct on the merged PR
      { session_id: 11 },                          // 1 on the open PR
    ],
    bounties: [
      { awarded_session_id: 10, status: 'awarded' },  // counts: +1 merged credit
      { awarded_session_id: 11, status: 'open' },     // open — must NOT count
    ],
  };
}

// ─── Tests ───────────────────────────────────────────────────────

test('404 for unknown username', async () => {
  const pool = makeMockPool(fixtureState());
  const srv = await startTestServer(pool);
  try {
    const res = await fetch(`${srv.baseUrl}/api/leaderboard/users/nobody/prs`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, 'User not found');
  } finally { await srv.close(); }
});

test('400 for an invalid before timestamp', async () => {
  const pool = makeMockPool(fixtureState());
  const srv = await startTestServer(pool);
  try {
    const res = await fetch(`${srv.baseUrl}/api/leaderboard/users/alice/prs?before=garbage`);
    assert.equal(res.status, 400);
  } finally { await srv.close(); }
});

test('lists only proposed PRs with credit-union kudos counts and stats', async () => {
  const pool = makeMockPool(fixtureState());
  const srv = await startTestServer(pool);
  try {
    const res = await fetch(`${srv.baseUrl}/api/leaderboard/users/alice/prs`);
    assert.equal(res.status, 200);
    const body = await res.json();

    // Shape
    assert.deepEqual(body.user, { user_id: 1, username: 'alice' });
    assert.ok(body.stats);
    assert.ok(Array.isArray(body.items));

    // Only the 4 proposed sessions, newest first
    assert.deepEqual(body.items.map((i) => i.session_id), [10, 11, 12, 13]);

    // archived-after-promotion surfaces with its raw status
    const closed = body.items.find((i) => i.session_id === 13);
    assert.equal(closed.status, 'archived');

    // kudos credit: 2 direct + 1 awarded bounty on the merged PR; the
    // OPEN bounty on session 11 must not count.
    assert.equal(body.items.find((i) => i.session_id === 10).kudos_count, 3);
    assert.equal(body.items.find((i) => i.session_id === 11).kudos_count, 1);
    assert.equal(body.items.find((i) => i.session_id === 12).kudos_count, 0);

    // Stats over the full filtered set
    assert.deepEqual(body.stats, { prs_total: 4, prs_merged: 1, kudos_merged: 3 });

    // Short page → no cursor
    assert.equal(body.nextBefore, null);
  } finally { await srv.close(); }
});

test('privacy predicates are present in the SQL itself', async () => {
  const pool = makeMockPool(fixtureState());
  const srv = await startTestServer(pool);
  try {
    await fetch(`${srv.baseUrl}/api/leaderboard/users/alice/prs`);
    const pageSql = pool.calls.find((c) => /AS kudos_count/.test(c.sql)).sql;
    const statsSql = pool.calls.find((c) => /AS prs_total/.test(c.sql)).sql;
    for (const sql of [pageSql, statsSql]) {
      assert.match(sql, /cs\.is_headless = FALSE/);
      assert.match(sql, /a\.view_visibility = 'public'/);
      assert.match(sql, /cs\.status = 'archived' AND cs\.promoted_at IS NOT NULL/);
    }
  } finally { await srv.close(); }
});

test('keyset pagination: full page returns nextBefore, follow-up page continues', async () => {
  const pool = makeMockPool(fixtureState());
  const srv = await startTestServer(pool);
  try {
    const res1 = await fetch(`${srv.baseUrl}/api/leaderboard/users/alice/prs?limit=2`);
    const page1 = await res1.json();
    assert.deepEqual(page1.items.map((i) => i.session_id), [10, 11]);
    assert.equal(page1.nextBefore, page1.items[1].created_at);

    const res2 = await fetch(
      `${srv.baseUrl}/api/leaderboard/users/alice/prs?limit=2&before=${encodeURIComponent(page1.nextBefore)}`
    );
    const page2 = await res2.json();
    assert.deepEqual(page2.items.map((i) => i.session_id), [12, 13]);
    assert.equal(page2.nextBefore, page2.items[1].created_at);

    const res3 = await fetch(
      `${srv.baseUrl}/api/leaderboard/users/alice/prs?limit=2&before=${encodeURIComponent(page2.nextBefore)}`
    );
    const page3 = await res3.json();
    assert.deepEqual(page3.items, []);
    assert.equal(page3.nextBefore, null);
  } finally { await srv.close(); }
});

test('user with no proposed PRs returns empty items and zeroed stats', async () => {
  const state = fixtureState();
  state.users.push({ id: 3, username: 'carol' });
  const pool = makeMockPool(state);
  const srv = await startTestServer(pool);
  try {
    const res = await fetch(`${srv.baseUrl}/api/leaderboard/users/carol/prs`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items, []);
    assert.deepEqual(body.stats, { prs_total: 0, prs_merged: 0, kudos_merged: 0 });
    assert.equal(body.nextBefore, null);
  } finally { await srv.close(); }
});

// ── Retired handles (#1336) ───────────────────────────────────────────
//
// A #leaderboard/users/<name> link is the most-shared address on the
// platform, and it is keyed on a handle. Renaming used to be impossible, so
// the link could not rot; now the handle is retired rather than released and
// the route resolves through that ledger instead of 404ing.

test('a link shared before the rename resolves, and reports the new handle', async () => {
  const state = fixtureState();
  state.users = [{ id: 1, username: 'ada' }, { id: 2, username: 'bob' }];
  state.retired = [{ user_id: 1, username: 'alice' }];
  const pool = makeMockPool(state);
  const srv = await startTestServer(pool);
  try {
    const res = await fetch(`${srv.baseUrl}/api/leaderboard/users/alice/prs`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.user, { user_id: 1, username: 'ada' },
      'the payload names the handle they hold NOW');
    assert.deepEqual(body.moved, { from: 'alice', to: 'ada' },
      'and says so, so the client can correct the address');
  } finally { await srv.close(); }
});

test('a live handle carries no `moved` hint', async () => {
  const pool = makeMockPool(fixtureState());
  const srv = await startTestServer(pool);
  try {
    const res = await fetch(`${srv.baseUrl}/api/leaderboard/users/alice/prs`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).moved, undefined);
  } finally { await srv.close(); }
});

test('a handle nobody ever held is still a 404', async () => {
  const state = fixtureState();
  state.retired = [{ user_id: 1, username: 'alice' }];
  const pool = makeMockPool(state);
  const srv = await startTestServer(pool);
  try {
    const res = await fetch(`${srv.baseUrl}/api/leaderboard/users/nobody/prs`);
    assert.equal(res.status, 404);
  } finally { await srv.close(); }
});
