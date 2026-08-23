// Profile customization (issue #982) — the write half.
//
//   PATCH  /api/me/profile   display name / bio / github / x
//   POST   /api/me/avatar    raw image bytes
//   DELETE /api/me/avatar
//   GET    /avatars/:id      the public, unauthenticated read
//
// Contracts guarded here:
//
//   1. Me-scoped: no req.user -> 401 on every write, never anonymous data.
//   2. PATCH is all-or-nothing and PARTIAL by key: only keys present in
//      the body are written, an empty string clears to NULL, and any
//      invalid field rejects the WHOLE request with field-keyed details
//      (so the sheet can pin messages and keep the user's other edits).
//   3. The username is never writable BY THIS ROUTE. It stopped being
//      unwritable platform-wide in #1336 (POST /api/me/username), but PATCH
//      must still refuse it: the rename needs the current password, a
//      cooldown and a username_history write in one transaction, and a
//      partial field update that also accepts a bio can offer none of that.
//   4. Avatar uploads are sniffed from BYTES, not from a declared type,
//      capped at 1 MB, and GIF is refused. The row's id ROTATES on every
//      upload, which is what keeps the year-long immutable cache honest.
//   5. DELETE is idempotent.
//   6. All three writes share one per-user rate-limit bucket.
//   7. GET /avatars/:id rejects a non-32-hex id without touching the DB
//      and sets the immutable cache header on a hit.
//
// Pure-function tests plus HTTP tests against a throwaway express app and
// a substring-dispatching mock pool (the idiom of
// tests/home-panels-api.test.js) — no live DB.
//
// Run with: node --test tests/profile-customization-api.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

function collapse(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// ─── Mock pool ────────────────────────────────────────────────────────
//
// `state` carries the fixture: the stored profile row and the avatar row
// (or their absence). Every write mutates `state` so a test can assert on
// what the route actually persisted rather than only on the response.
function makeMockPool(state) {
  const calls = [];
  const pool = {
    async query(rawSql, params = []) {
      const sql = collapse(rawSql);
      calls.push({ sql, params });

      if (sql.startsWith('SELECT content_type, data FROM user_avatars WHERE id')) {
        const row = state.avatar && state.avatar.id === params[0] ? state.avatar : null;
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('LEFT JOIN user_avatars av') && sql.includes('WHERE u.id')) {
        return {
          rows: [{
            display_name: state.profile.display_name ?? null,
            bio: state.profile.bio ?? null,
            github: state.profile.github ?? null,
            x: state.profile.x ?? null,
            avatar_id: state.avatar ? state.avatar.id : null,
          }],
        };
      }
      if (sql.startsWith('UPDATE users SET')) {
        // Reconstruct the SET list so a test can assert exactly which
        // columns were written and with what.
        const cols = [...sql.matchAll(/(\w+) = \$(\d+)/g)]
          .filter((m) => m[1] !== 'updated_at');
        for (const [, col, idx] of cols) {
          state.profile[col] = params[Number(idx) - 1];
        }
        state.updateCount = (state.updateCount || 0) + 1;
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO user_avatars')) {
        state.avatar = {
          id: params[0], user_id: params[1], content_type: params[2],
          size_bytes: params[3], data: params[4], sha256: params[5],
        };
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM user_avatars')) {
        state.avatar = null;
        state.deleteCount = (state.deleteCount || 0) + 1;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 90)}`);
    },
  };
  return { pool, calls };
}

// Builds an app with req.user injected (or not) and BOTH routers' pools
// swapped for the mock.
function makeApp(state, { user } = {}) {
  const { pool, calls } = makeMockPool(state);
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  let routes;
  let publicRoutes;
  try {
    delete require.cache[require.resolve('../src/routes/profile')];
    delete require.cache[require.resolve('../src/routes/avatars')];
    routes = require('../src/routes/profile').profileRoutes();
    publicRoutes = require('../src/routes/avatars').avatarRoutes();
  } finally {
    poolModule.getPool = originalGetPool;
  }
  const app = express();
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use(routes);
  app.use(publicRoutes);
  return { app, calls, state };
}

const USER = { id: 7, username: 'viewer', isAdmin: false };

function freshState(over = {}) {
  return { profile: {}, avatar: null, ...over };
}

async function request(app, method, url, { body, contentType } = {}) {
  const server = app.listen(0);
  // The harness preload (tests/lib/test-net.js) pins hostless listens to
  // 127.0.0.1, which makes the bind complete on the next tick instead of
  // synchronously — so wait for it before reading the assigned port.
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const headers = {};
    if (contentType) headers['content-type'] = contentType;
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, headers, body,
    });
    const raw = await res.arrayBuffer();
    const text = Buffer.from(raw).toString('utf8');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return {
      status: res.status,
      body: parsed,
      bytes: Buffer.from(raw),
      headers: res.headers,
    };
  } finally {
    server.close();
  }
}

const patch = (app, payload) => request(app, 'PATCH', '/api/me/profile', {
  body: JSON.stringify(payload), contentType: 'application/json',
});
const upload = (app, buf) => request(app, 'POST', '/api/me/avatar', {
  body: buf, contentType: 'application/octet-stream',
});

// ─── Image fixtures: real magic bytes, so the sniff is genuinely tested ──
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.alloc(4, 0),
  Buffer.from('WEBP', 'latin1'), Buffer.alloc(64, 3),
]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 4)]);
const NOT_AN_IMAGE = Buffer.from('this is plainly not an image at all, really', 'utf8');

// ─── Pure functions ───────────────────────────────────────────────────

const {
  validateAvatarUpload, parseProfileFields, shapeProfile,
  MAX_DISPLAY_NAME, MAX_BIO, MAX_AVATAR_BYTES,
} = require('../src/routes/profile');

test('parseProfileFields: only keys PRESENT in the body are written', () => {
  const { fields, details } = parseProfileFields({ displayName: 'Ada' });
  assert.deepEqual(details, {});
  // bio/github/x absent from the body must not appear — a partial update
  // must never blank a field the client didn't send.
  assert.deepEqual(fields, { display_name: 'Ada' });
});

test('parseProfileFields: an empty string is an explicit clear (NULL)', () => {
  const { fields } = parseProfileFields({ displayName: '', bio: '  ', github: '', x: '' });
  assert.deepEqual(fields, {
    display_name: null, bio: null, github: null, x: null,
  });
});

test('parseProfileFields: values are trimmed', () => {
  const { fields } = parseProfileFields({ displayName: '  Ada Lovelace  ', bio: ' hi ' });
  assert.equal(fields.display_name, 'Ada Lovelace');
  assert.equal(fields.bio, 'hi');
});

test('parseProfileFields: over-length display name and bio are rejected', () => {
  const long = parseProfileFields({ displayName: 'a'.repeat(MAX_DISPLAY_NAME + 1) });
  assert.ok(long.details.displayName, 'an over-length display name must be rejected');
  assert.equal(long.fields.display_name, undefined, 'nothing is written on rejection');

  const okName = parseProfileFields({ displayName: 'a'.repeat(MAX_DISPLAY_NAME) });
  assert.deepEqual(okName.details, {}, 'exactly at the limit is fine');

  const longBio = parseProfileFields({ bio: 'b'.repeat(MAX_BIO + 1) });
  assert.ok(longBio.details.bio);
  assert.deepEqual(parseProfileFields({ bio: 'b'.repeat(MAX_BIO) }).details, {});
});

test('parseProfileFields: a display name cannot carry line breaks', () => {
  // It renders on one line in the standings row and the profile header;
  // a newline would silently break both.
  assert.ok(parseProfileFields({ displayName: 'Ada\nLovelace' }).details.displayName);
  // A bio explicitly MAY (it renders whitespace-pre-line).
  assert.deepEqual(parseProfileFields({ bio: 'line one\nline two' }).details, {});
});

test('parseProfileFields: one leading @ is stripped from handles', () => {
  const { fields, details } = parseProfileFields({ github: '@octocat', x: '@jack' });
  assert.deepEqual(details, {});
  assert.equal(fields.github, 'octocat');
  assert.equal(fields.x, 'jack');
});

test('parseProfileFields: malformed handles are rejected per field', () => {
  const { fields, details } = parseProfileFields({
    github: 'has spaces', x: 'fine_handle',
  });
  assert.ok(details.github, 'a handle with a space is not a handle');
  assert.equal(details.x, undefined);
  assert.equal(fields.github, undefined, 'the bad field is not written');
  // A second @ is not stripped — only ONE leading one is.
  assert.ok(parseProfileFields({ github: '@@octocat' }).details.github);
});

test('parseProfileFields: unknown keys are ignored, not errors', () => {
  const { fields, details } = parseProfileFields({
    username: 'someone-else', isAdmin: true, password: 'nope', displayName: 'Ada',
  });
  assert.deepEqual(details, {});
  assert.deepEqual(fields, { display_name: 'Ada' },
    'username / isAdmin / password must never reach the UPDATE');
});

test('parseProfileFields: a non-object body yields no fields and no errors', () => {
  for (const body of [null, undefined, 'a string', 42]) {
    const { fields, details } = parseProfileFields(body);
    assert.deepEqual(fields, {});
    assert.deepEqual(details, {});
  }
});

test('validateAvatarUpload: bytes decide the type, not a declared header', () => {
  assert.equal(validateAvatarUpload(PNG).contentType, 'image/png');
  assert.equal(validateAvatarUpload(JPEG).contentType, 'image/jpeg');
  assert.equal(validateAvatarUpload(WEBP).contentType, 'image/webp');
});

test('validateAvatarUpload: GIF, non-images and empty bodies are refused', () => {
  assert.equal(validateAvatarUpload(GIF).ok, false,
    'GIF is refused: nothing here decodes frames and an animated avatar is unwanted');
  assert.equal(validateAvatarUpload(NOT_AN_IMAGE).ok, false);
  assert.equal(validateAvatarUpload(Buffer.alloc(0)).ok, false);
  assert.equal(validateAvatarUpload(null).ok, false);
});

test('validateAvatarUpload: the byte cap bites before the sniff', () => {
  const huge = Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)]);
  const verdict = validateAvatarUpload(huge);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /too large/i);
});

test('shapeProfile: a missing row is all-nulls, never a throw', () => {
  assert.deepEqual(shapeProfile(undefined), {
    displayName: null, bio: null, avatarUrl: null,
    links: { github: null, x: null },
  });
});

test('shapeProfile: the avatar id becomes a /avatars/ path', () => {
  const shaped = shapeProfile({ avatar_id: 'ab'.repeat(16) });
  assert.equal(shaped.avatarUrl, `/avatars/${'ab'.repeat(16)}`);
});

// ─── HTTP: me-scoping ─────────────────────────────────────────────────

test('every write is me-scoped: no session -> 401, and the DB is untouched', async () => {
  const { app, calls } = makeApp(freshState()); // no user
  const p = await patch(app, { displayName: 'Ada' });
  assert.equal(p.status, 401);
  const u = await upload(app, PNG);
  assert.equal(u.status, 401);
  const d = await request(app, 'DELETE', '/api/me/avatar');
  assert.equal(d.status, 401);
  const c = await request(app, 'GET', '/api/me/challenges/completed');
  assert.equal(c.status, 401);
  assert.equal(calls.length, 0, 'an anonymous request must never reach the pool');
});

// ─── HTTP: PATCH ──────────────────────────────────────────────────────

test('PATCH writes only the keys sent, and stamps updated_at', async () => {
  const state = freshState({ profile: { display_name: 'Old', bio: 'Old bio' } });
  const { app, calls } = makeApp(state, { user: USER });
  const res = await patch(app, { displayName: 'Ada' });
  assert.equal(res.status, 200);
  assert.equal(state.profile.display_name, 'Ada');
  assert.equal(state.profile.bio, 'Old bio', 'an unsent key is left alone');

  const update = calls.find((c) => c.sql.startsWith('UPDATE users SET'));
  assert.match(update.sql, /updated_at = NOW\(\)/);
  assert.doesNotMatch(update.sql, /username/,
    'the username is not writable by THIS route — POST /api/me/username is '
    + 'the only writer, and it is credential-gated (#1336)');
});

test('PATCH echoes the post-write profile in the /api/auth/me shape', async () => {
  const state = freshState();
  const { app } = makeApp(state, { user: USER });
  const res = await patch(app, { displayName: 'Ada', github: '@octocat' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.profile, {
    displayName: 'Ada',
    bio: null,
    avatarUrl: null,
    links: { github: 'octocat', x: null },
  });
});

test('PATCH rejects the WHOLE request when any field is invalid', async () => {
  const state = freshState({ profile: { display_name: 'Old' } });
  const { app } = makeApp(state, { user: USER });
  const res = await patch(app, { displayName: 'Ada', x: 'not a handle' });
  assert.equal(res.status, 400);
  assert.ok(res.body.details.x, 'the message is keyed to the offending field');
  assert.equal(state.profile.display_name, 'Old',
    'nothing is saved partially — the valid field must not land either');
});

test('PATCH with nothing to write is a no-op 200, not an error', async () => {
  const state = freshState({ profile: { display_name: 'Ada' } });
  const { app } = makeApp(state, { user: USER });
  const res = await patch(app, { somethingUnknown: 1 });
  assert.equal(res.status, 200);
  assert.equal(state.updateCount, undefined, 'no UPDATE is issued');
  assert.equal(res.body.profile.displayName, 'Ada');
});

// ─── HTTP: avatar upload / delete ─────────────────────────────────────

test('POST /api/me/avatar stores sniffed bytes and returns the new URL', async () => {
  const state = freshState();
  const { app } = makeApp(state, { user: USER });
  const res = await upload(app, PNG);
  assert.equal(res.status, 200);
  assert.match(res.body.avatarUrl, /^\/avatars\/[a-f0-9]{32}$/);
  assert.equal(state.avatar.content_type, 'image/png');
  assert.equal(state.avatar.size_bytes, PNG.length);
  assert.equal(state.avatar.user_id, USER.id);
  assert.match(state.avatar.sha256, /^[a-f0-9]{64}$/);
});

test('POST /api/me/avatar ROTATES the id on a second upload', async () => {
  const state = freshState();
  const { app, calls } = makeApp(state, { user: USER });
  const first = await upload(app, PNG);
  const second = await upload(app, JPEG);
  assert.notEqual(first.body.avatarUrl, second.body.avatarUrl,
    'the URL is content-addressed with a year-long immutable header — reusing '
    + 'the id would pin the old picture in every cache forever');
  assert.equal(state.avatar.content_type, 'image/jpeg');
  // The rotation has to happen in the upsert itself, not as delete+insert.
  const insert = calls.find((c) => c.sql.startsWith('INSERT INTO user_avatars'));
  assert.match(insert.sql, /ON CONFLICT \(user_id\) DO UPDATE/);
  assert.match(insert.sql, /SET id = EXCLUDED\.id/);
});

test('POST /api/me/avatar accepts PNG, JPEG and WebP', async () => {
  for (const [name, buf] of [['png', PNG], ['jpeg', JPEG], ['webp', WEBP]]) {
    const { app } = makeApp(freshState(), { user: USER });
    const res = await upload(app, buf);
    assert.equal(res.status, 200, `${name} must be accepted`);
  }
});

test('POST /api/me/avatar refuses GIF, non-images and an empty body', async () => {
  for (const [name, buf] of [['gif', GIF], ['text', NOT_AN_IMAGE], ['empty', Buffer.alloc(0)]]) {
    const state = freshState();
    const { app } = makeApp(state, { user: USER });
    const res = await upload(app, buf);
    assert.equal(res.status, 400, `${name} must be refused`);
    assert.ok(res.body.error, 'the refusal carries a sentence a human can act on');
    assert.equal(state.avatar, null, 'nothing is stored');
  }
});

test('POST /api/me/avatar refuses an over-cap body with a 400, not a parser 413', async () => {
  const state = freshState();
  const { app } = makeApp(state, { user: USER });
  // Over the 1 MB friendly cap but under the 2 MB express.raw() ceiling —
  // which is exactly why the two differ.
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_AVATAR_BYTES)]);
  assert.ok(big.length < 2 * 1024 * 1024, 'fixture must stay under the parser limit');
  const res = await upload(app, big);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /too large/i);
  assert.equal(state.avatar, null);
});

test('DELETE /api/me/avatar is idempotent', async () => {
  const state = freshState();
  const { app } = makeApp(state, { user: USER });
  await upload(app, PNG);
  assert.ok(state.avatar);
  const first = await request(app, 'DELETE', '/api/me/avatar');
  assert.equal(first.status, 200);
  assert.equal(first.body.avatarUrl, null);
  assert.equal(state.avatar, null);
  // Double-tapping "Remove photo" must not fail.
  const second = await request(app, 'DELETE', '/api/me/avatar');
  assert.equal(second.status, 200);
  assert.equal(second.body.avatarUrl, null);
});

// ─── HTTP: the public read ────────────────────────────────────────────

test('GET /avatars/:id rejects a non-32-hex id without touching the DB', async () => {
  const { app, calls } = makeApp(freshState());
  for (const id of ['nope', '../../etc/passwd', 'AB'.repeat(16), 'ab'.repeat(15)]) {
    const res = await request(app, 'GET', `/avatars/${encodeURIComponent(id)}`);
    assert.equal(res.status, 404, `${id} must 404`);
  }
  assert.equal(calls.length, 0, 'a malformed id is refused before any query');
});

test('GET /avatars/:id serves the bytes with an immutable cache header', async () => {
  const id = 'ab'.repeat(16);
  const state = freshState({
    avatar: { id, content_type: 'image/png', data: PNG },
  });
  const { app } = makeApp(state);
  const res = await request(app, 'GET', `/avatars/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.match(res.headers.get('cache-control'), /max-age=31536000/);
  assert.equal(Buffer.compare(res.bytes, PNG), 0);
});

test('GET /avatars/:id is anonymous — a well-formed miss is a plain 404', async () => {
  const { app } = makeApp(freshState());
  const res = await request(app, 'GET', `/avatars/${'cd'.repeat(16)}`);
  assert.equal(res.status, 404);
});

// ─── Source pins ──────────────────────────────────────────────────────

test('the writes share one per-user rate-limit bucket', () => {
  const limits = read('src/middleware/rate-limits.js');
  assert.match(limits, /profileWriteLimiter = makeLimiter\(\{[\s\S]*?keyByUser: true/);
  assert.match(limits, /module\.exports = \{[^}]*profileWriteLimiter/);
  const route = read('src/routes/profile.js');
  for (const surface of [
    /'\/api\/me\/profile',\s*requireUser,\s*profileWriteLimiter/,
    /'\/api\/me\/avatar',\s*requireUser,\s*profileWriteLimiter/,
  ]) {
    assert.match(route, surface);
  }
  // All three writes, not just two of them. Counted at the ROUTE level
  // (`requireUser,` immediately before it) rather than by bare occurrences
  // of the name: the import line mentions it too, and since #1336 that line
  // also destructures usernameChangeLimiter beside it.
  assert.equal(
    (route.match(/requireUser,\s*profileWriteLimiter/g) || []).length, 3,
  );
});

test('the username change does NOT share the profile-write bucket', () => {
  // Deliberately its own, much tighter bucket (#1336): every call
  // bcrypt-compares the current password, so an endpoint sharing the
  // 20/minute profile allowance would be both a password oracle and 20
  // KDF rounds a minute. The cooldown is the product rule; this is the
  // abuse ceiling underneath it.
  const limits = read('src/middleware/rate-limits.js');
  assert.match(limits, /usernameChangeLimiter = makeLimiter\(\{[\s\S]*?keyByUser: true/);
  assert.match(limits, /module\.exports = \{[^}]*usernameChangeLimiter/);
  const route = read('src/routes/profile.js');
  assert.match(route, /'\/api\/me\/username',\s*requireUser,\s*usernameChangeLimiter/);
  assert.doesNotMatch(route, /'\/api\/me\/username',\s*requireUser,\s*profileWriteLimiter/);
});

test('the avatar parser ceiling sits ABOVE the friendly cap', () => {
  // Otherwise an over-size upload gets express's opaque 413 instead of the
  // sentence validateAvatarUpload writes.
  const route = read('src/routes/profile.js');
  assert.match(route, /express\.raw\(\{ type: 'application\/octet-stream', limit: '2mb' \}\)/);
  assert.equal(MAX_AVATAR_BYTES, 1024 * 1024);
});

test('both routers are mounted in server.js, on the right side of the auth gate', () => {
  const server = read('server.js');
  assert.match(server, /require\('\.\/src\/routes\/avatars'\)/);
  assert.match(server, /require\('\.\/src\/routes\/profile'\)/);
  const authAt = server.indexOf('app.use(authMiddleware');
  assert.ok(authAt > 0, 'authMiddleware must be mounted somewhere');
  const avatarsAt = server.indexOf('app.use(avatarRoutes(config))');
  const profileAt = server.indexOf('app.use(profileRoutes(config))');
  assert.ok(avatarsAt > 0 && avatarsAt < authAt,
    'the avatar READ is public — an <img> carries no session dance');
  assert.ok(profileAt > authAt,
    'the profile WRITES are me-scoped and must sit behind the auth gate');
});

test('schema: bio plus a one-row-per-user avatar table, neither staging-private', () => {
  const schema = read('src/db/schema.sql');
  assert.match(schema, /ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS user_avatars/);
  const block = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS user_avatars'));
  assert.match(block, /user_id\s+INTEGER UNIQUE NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  // Avatars are published to other users by design, exactly like app_icons.
  assert.doesNotMatch(schema, /COMMENT ON TABLE user_avatars/);
});

test('/api/auth/me carries the profile block', () => {
  const auth = read('src/routes/auth.js');
  assert.match(auth, /LEFT JOIN user_avatars av ON av\.user_id = u\.id/);
  for (const key of ['displayName:', 'bio:', 'avatarUrl:', 'links:']) {
    assert.ok(auth.includes(key), `/api/auth/me must expose ${key}`);
  }
});

test('the service worker treats /avatars/ as content-addressed', () => {
  const { classifyRequest } = require('../public/sw.js');
  const origin = 'https://example.test';
  assert.equal(
    classifyRequest('GET', `${origin}/avatars/${'ab'.repeat(16)}`, '', 'no-cors', origin),
    'immutable'
  );
});
