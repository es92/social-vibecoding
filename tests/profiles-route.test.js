'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');

const BOB_AVATAR = '0123456789abcdef0123456789abcdef';

function initialUsers() {
  return [
    {
      id: 1,
      username: 'alice',
      display_name: 'Alice',
      bio: null,
      avatar_id: null,
      profile_published: false,
      profile_disabled_at: null,
      email: 'alice@example.test',
      usernode_pubkey: 'ut1secret',
    },
    {
      id: 2,
      username: 'bob',
      display_name: 'Bob Builder',
      bio: 'Ships useful things.',
      avatar_id: BOB_AVATAR,
      profile_published: true,
      profile_disabled_at: null,
      email: 'bob@example.test',
      usernode_pubkey: 'ut1private',
    },
    {
      id: 3,
      username: 'carol',
      display_name: 'Carol',
      bio: null,
      avatar_id: null,
      profile_published: true,
      profile_disabled_at: '2026-08-01T00:00:00.000Z',
    },
    {
      id: 9,
      username: 'admin',
      display_name: null,
      bio: null,
      avatar_id: null,
      profile_published: false,
      profile_disabled_at: null,
    },
  ];
}

// Retired handles (#1336), mirroring `username_history`: alice renamed
// from `ada`, so `/api/public/profiles/ada` must still reach user 1 and
// say so via `moved`.
function initialRetired() {
  return [{ user_id: 1, username: 'ada' }];
}

function makePool() {
  const state = { users: initialUsers(), retired: initialRetired(), reports: [], calls: [] };

  const query = async (sql, params = []) => {
    const s = String(sql);
    state.calls.push({ sql: s, params });

    // usernames.resolveHandle, live arm.
    if (/SELECT id, username FROM users WHERE LOWER\(username\) = \$1/.test(s)) {
      const user = state.users.find((c) => c.username.toLowerCase() === params[0]);
      return { rows: user ? [{ id: user.id, username: user.username }] : [] };
    }
    // usernames.resolveHandle, retired arm.
    if (/FROM username_history h/.test(s) && /LOWER\(h\.username\) = \$1/.test(s)) {
      const row = state.retired.find((h) => h.username.toLowerCase() === params[0]);
      if (!row) return { rows: [] };
      const user = state.users.find((c) => c.id === row.user_id);
      return { rows: user ? [{ user_id: user.id, username: user.username }] : [] };
    }
    // The PUBLIC read. Keyed on id since #1336 (the name was resolved a
    // query earlier), so it is told apart from the owner read below by its
    // publish/disable filters rather than by its WHERE column.
    if (/SELECT u\.username, u\.display_name/.test(s)
        && /WHERE u\.id = \$1/.test(s)
        && /profile_published = TRUE/.test(s)) {
      const user = state.users.find((candidate) => (
        candidate.id === params[0]
        && candidate.profile_published
        && !candidate.profile_disabled_at
      ));
      return { rows: user ? [{ ...user }] : [] };
    }
    if (/SELECT u\.username, u\.display_name/.test(s) && /WHERE u\.id = \$1/.test(s)) {
      const user = state.users.find((candidate) => candidate.id === params[0]);
      return { rows: user ? [{ ...user }] : [] };
    }
    if (/UPDATE users/.test(s) && /SET profile_published = \$1/.test(s)) {
      const user = state.users.find((candidate) => candidate.id === params[1]);
      if (!user) return { rows: [], rowCount: 0 };
      user.profile_published = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT id, username FROM users/.test(s) && /FOR UPDATE/.test(s)) {
      const user = state.users.find((candidate) => candidate.username === params[0]);
      return { rows: user ? [{ id: user.id, username: user.username }] : [] };
    }
    if (/SELECT id FROM users/.test(s) && /FOR UPDATE/.test(s)) {
      const user = state.users.find((candidate) => (
        candidate.username === params[0]
        && candidate.profile_published
        && !candidate.profile_disabled_at
      ));
      return { rows: user ? [{ id: user.id }] : [] };
    }
    if (/INSERT INTO profile_reports/.test(s)) {
      const duplicate = state.reports.some((report) => (
        report.profile_user_id === params[0]
        && report.reporter_user_id === params[1]
        && report.status === 'pending'
      ));
      if (!duplicate) {
        state.reports.push({
          id: state.reports.length + 1,
          profile_user_id: params[0],
          reporter_user_id: params[1],
          reason: params[2],
          detail: params[3],
          status: 'pending',
          created_at: new Date().toISOString(),
          resolved_at: null,
          resolved_by: null,
        });
      }
      return { rows: [], rowCount: duplicate ? 0 : 1 };
    }
    if (/FROM profile_reports pr/.test(s)) {
      const rows = state.reports
        .filter((report) => report.status === params[0])
        .map((report) => ({
          ...report,
          profile_username: state.users.find((u) => u.id === report.profile_user_id).username,
          reporter_username: state.users.find((u) => u.id === report.reporter_user_id).username,
          resolved_by_username: state.users.find((u) => u.id === report.resolved_by)?.username || null,
        }));
      return { rows };
    }
    if (/UPDATE profile_reports/.test(s) && /status = 'dismissed'/.test(s)) {
      const report = state.reports.find((candidate) => (
        candidate.id === params[1] && candidate.status === 'pending'
      ));
      if (!report) return { rows: [] };
      report.status = 'dismissed';
      report.resolved_by = params[0];
      report.resolved_at = new Date().toISOString();
      return { rows: [{ id: report.id, status: report.status }] };
    }
    if (/UPDATE users/.test(s) && /profile_disabled_at = CASE/.test(s)) {
      const user = state.users.find((candidate) => candidate.id === params[3]);
      user.profile_disabled_at = params[0] ? new Date().toISOString() : null;
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE profile_reports/.test(s) && /status = 'resolved'/.test(s)) {
      for (const report of state.reports) {
        if (report.profile_user_id === params[1] && report.status === 'pending') {
          report.status = 'resolved';
          report.resolved_by = params[0];
          report.resolved_at = new Date().toISOString();
        }
      }
      return { rows: [] };
    }
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(s.trim())) return { rows: [] };
    throw new Error(`Unhandled SQL: ${s.slice(0, 180)}`);
  };

  return {
    state,
    query,
    connect: async () => ({ query, release() {} }),
  };
}

async function start(pool) {
  const poolPath = require.resolve('../src/db/pool');
  const oldPool = require.cache[poolPath];
  require.cache[poolPath] = {
    exports: { getPool: () => pool },
    loaded: true,
    id: poolPath,
    filename: poolPath,
    paths: oldPool?.paths || [],
  };
  delete require.cache[require.resolve('../src/routes/profiles')];
  const { publicProfileRoutes } = require('../src/routes/profiles');
  if (oldPool) require.cache[poolPath] = oldPool;
  else delete require.cache[poolPath];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const name = req.headers['x-test-user'];
    if (name === 'alice') {
      req.user = { id: 1, username: 'alice', isAdmin: false, canAdminWrite: false };
    }
    if (name === 'bob') {
      req.user = { id: 2, username: 'bob', isAdmin: false, canAdminWrite: false };
    }
    if (name === 'admin') {
      req.user = { id: 9, username: 'admin', isAdmin: true, canAdminWrite: true };
    }
    if (name === 'viewer') {
      req.user = { id: 8, username: 'viewer', isAdmin: true, canAdminWrite: false };
    }
    next();
  });
  app.use(publicProfileRoutes({}));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function request(server, route, options = {}) {
  const res = await fetch(server.url + route, options);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

function jsonOptions(user, body, method = 'POST') {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      ...(user ? { 'x-test-user': user } : {}),
    },
    body: JSON.stringify(body),
  };
}

test('public exact lookup is opt-in, no-store, and returns only shared profile fields', async () => {
  const pool = makePool();
  const server = await start(pool);
  try {
    const found = await request(server, '/api/public/profiles/bob');
    assert.equal(found.status, 200);
    assert.match(found.headers.get('cache-control'), /no-store/);
    assert.deepEqual(
      Object.keys(found.body.profile).sort(),
      ['avatarUrl', 'bio', 'displayName', 'url', 'username']
    );
    assert.equal(found.body.profile.avatarUrl, `/avatars/${BOB_AVATAR}`);
    assert.equal(JSON.stringify(found.body).includes('ut1private'), false);
    assert.equal(JSON.stringify(found.body).includes('bob@example.test'), false);

    const hidden = await request(server, '/api/public/profiles/alice');
    const disabled = await request(server, '/api/public/profiles/carol');
    const missing = await request(server, '/api/public/profiles/nobody');
    assert.deepEqual(
      [hidden, disabled, missing].map((result) => ({
        status: result.status,
        body: result.body,
      })),
      Array(3).fill({ status: 404, body: { error: 'Profile not found' } })
    );
  } finally {
    await server.close();
  }
});

test('owner publication state reuses the existing display name, bio and stored avatar', async () => {
  const pool = makePool();
  const server = await start(pool);
  try {
    const owner = await request(server, '/api/me/public-profile', {
      headers: { 'x-test-user': 'alice' },
    });
    assert.equal(owner.status, 200);
    assert.equal(owner.body.published, false);
    assert.equal(owner.body.profile.displayName, 'Alice');

    const unknown = await request(
      server,
      '/api/me/public-profile',
      jsonOptions('alice', { published: true, wallet: 'ut1leak' }, 'PATCH')
    );
    assert.equal(unknown.status, 400);

    const published = await request(
      server,
      '/api/me/public-profile',
      jsonOptions('alice', { published: true }, 'PATCH')
    );
    assert.equal(published.status, 200);
    assert.equal(published.body.published, true);
    const publicRead = await request(server, '/api/public/profiles/alice');
    assert.equal(publicRead.status, 200);
    assert.equal(publicRead.body.profile.displayName, 'Alice');
  } finally {
    await server.close();
  }
});

test('reports are authenticated, generic, idempotent, and lock against moderation updates', async () => {
  const pool = makePool();
  const server = await start(pool);
  const report = jsonOptions('alice', { reason: 'spam', detail: 'Repeated links' });
  try {
    const anonymous = await request(
      server,
      '/api/profiles/bob/report',
      jsonOptions(null, { reason: 'spam' })
    );
    assert.equal(anonymous.status, 401);
    assert.equal((await request(server, '/api/profiles/bob/report', report)).status, 202);
    assert.equal((await request(server, '/api/profiles/bob/report', report)).status, 202);
    assert.equal((await request(server, '/api/profiles/nobody/report', report)).status, 202);
    assert.equal(pool.state.reports.length, 1);

    const self = await request(
      server,
      '/api/profiles/alice/report',
      jsonOptions('alice', { reason: 'other' })
    );
    assert.equal(self.status, 400);
    const lock = pool.state.calls.find((call) => (
      /SELECT id FROM users/.test(call.sql) && /profile_published/.test(call.sql)
    ));
    assert.match(lock.sql, /FOR UPDATE/);
    assert.doesNotMatch(lock.sql, /FOR KEY SHARE/);
  } finally {
    await server.close();
  }
});

test('full admins can take down, restore, and dismiss reports; view-only admins cannot write', async () => {
  const pool = makePool();
  const server = await start(pool);
  try {
    await request(
      server,
      '/api/profiles/bob/report',
      jsonOptions('alice', { reason: 'impersonation', detail: null })
    );
    const listed = await request(server, '/api/admin/profile-reports', {
      headers: { 'x-test-user': 'viewer' },
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.reports.length, 1);

    const denied = await request(
      server,
      '/api/admin/profiles/bob/moderation',
      jsonOptions('viewer', { disabled: true, reason: 'confirmed' })
    );
    assert.equal(denied.status, 403);

    const disabled = await request(
      server,
      '/api/admin/profiles/bob/moderation',
      jsonOptions('admin', { disabled: true, reason: 'confirmed impersonation' })
    );
    assert.equal(disabled.status, 200);
    assert.equal((await request(server, '/api/public/profiles/bob')).status, 404);
    assert.equal(pool.state.reports[0].status, 'resolved');

    const restored = await request(
      server,
      '/api/admin/profiles/bob/moderation',
      jsonOptions('admin', { disabled: false, reason: null })
    );
    assert.equal(restored.status, 200);
    assert.equal((await request(server, '/api/public/profiles/bob')).status, 200);

    await request(
      server,
      '/api/profiles/bob/report',
      jsonOptions('alice', { reason: 'spam', detail: null })
    );
    const pending = pool.state.reports.find((report) => report.status === 'pending');
    const dismissDenied = await request(
      server,
      `/api/admin/profile-reports/${pending.id}/dismiss`,
      jsonOptions('viewer', {})
    );
    assert.equal(dismissDenied.status, 403);
    const dismissed = await request(
      server,
      `/api/admin/profile-reports/${pending.id}/dismiss`,
      jsonOptions('admin', {})
    );
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body.report.status, 'dismissed');
  } finally {
    await server.close();
  }
});

test('schema, routing and bundled profile UI pin privacy and current-shell integration', () => {
  const root = path.join(__dirname, '..');
  const schema = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');
  const route = fs.readFileSync(path.join(root, 'src/routes/profiles.js'), 'utf8');
  // #1191 slice 6 converted #profile-root to React. profile.js kept the
  // fetches and the writes; the public card's markup moved to
  // public-profile-card.tsx and the rule that decides who may report moved to
  // profile-store.js. All three are asserted on below, because the privacy
  // guarantees this test pins are spread across them now.
  const profile = fs.readFileSync(
    path.join(root, 'frontend/src/features/profile/profile.js'),
    'utf8'
  );
  const profileStore = fs.readFileSync(
    path.join(root, 'frontend/src/features/profile/profile-store.js'),
    'utf8'
  );
  const publicCard = fs.readFileSync(
    path.join(root, 'frontend/src/features/profile/public-profile-card.tsx'),
    'utf8'
  );
  const app = fs.readFileSync(path.join(root, 'public/js/app.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

  assert.match(schema, /profile_user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(schema, /reporter_user_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(schema, /COMMENT ON TABLE profile_reports IS 'staging:private'/);
  assert.doesNotMatch(schema, /ADD COLUMN IF NOT EXISTS profile_(display_name|bio|avatar_url)/);
  assert.match(route, /LEFT JOIN user_avatars/);
  assert.doesNotMatch(route, /profile_(display_name|bio|avatar_url)/);
  // A stranger's display name and bio are attacker-controlled, so they have to
  // reach the page as text. JSX children are text nodes by construction, which
  // is the React spelling of the old `textContent = text` helper.
  assert.match(publicCard, /\{profile\.displayName \|\| profile\.username\}/);
  assert.match(publicCard, /\{profile\.bio\}/);
  assert.match(publicCard, /referrerPolicy="no-referrer"/);
  assert.match(profileStore, /viewer\.hasPlatformAccess !== false/);
  assert.match(publicCard, /absolute inset-0 w-full h-full object-cover/);
  assert.doesNotMatch(profile, /innerHTML\s*=/);
  assert.doesNotMatch(publicCard, /dangerouslySetInnerHTML/);
  assert.match(app, /publicProfileRoute/);
  assert.match(app, /Profile\.open\(username\)/);
  assert.match(server, /publicProfileRoutes\(config\)/);
  assert.equal(fs.existsSync(path.join(root, 'public/js/profile.js')), false);
});

// ── Retired handles (#1336) ───────────────────────────────────────────

test('resolving an old handle does not bypass the opt-in publish gate', async () => {
  // user 1 is `alice` now and retired `ada`; she is NOT published. The
  // resolve only maps a name to a person — publishing is a separate answer.
  const pool = makePool();
  const server = await start(pool);
  try {
    const res = await request(server, '/api/public/profiles/ada');
    assert.equal(res.status, 404);
    assert.ok(
      pool.state.calls.some((c) => /FROM username_history h/.test(c.sql)),
      'the retired ledger must actually be consulted',
    );
  } finally {
    await server.close();
  }
});

test('a published profile reached by its old handle answers, and says it moved', async () => {
  const pool = makePool();
  pool.state.users.find((u) => u.id === 1).profile_published = true;
  const server = await start(pool);
  try {
    const res = await request(server, '/api/public/profiles/ada');
    assert.equal(res.status, 200);
    assert.equal(res.body.profile.username, 'alice',
      'the body carries the CANONICAL handle, not the one that was asked for');
    assert.deepEqual(res.body.moved, { from: 'ada', to: 'alice' });
  } finally {
    await server.close();
  }
});

test('a live handle is a plain hit — no `moved` hint', async () => {
  const pool = makePool();
  const server = await start(pool);
  try {
    const res = await request(server, '/api/public/profiles/bob');
    assert.equal(res.status, 200);
    assert.equal(res.body.moved, undefined,
      'only a retired handle is a redirect; a live one is just a hit');
  } finally {
    await server.close();
  }
});

test('a handle nobody ever held is still a plain 404', async () => {
  const pool = makePool();
  const server = await start(pool);
  try {
    const res = await request(server, '/api/public/profiles/nobody');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Profile not found' });
  } finally {
    await server.close();
  }
});
