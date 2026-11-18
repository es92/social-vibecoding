'use strict';

// Admin invite links to Homeroom itself (/welcome/<code>,
// services/access-links.js) against the real schema in a throwaway database:
// the preview says only whether a link still lets somebody in; the account a
// sign-in finds or makes with the link's cookie is let in and spends it, one
// link one account, two sign-ups racing on one link let in exactly one; an
// account that already has access spends nothing; and an email code carrying
// the link makes an account that never waits and gets no waitlist spot.
// Then the wiring, read from source: every sign-in path follows the cookie,
// the page is a shell document for a signed-out or waiting visitor, and the
// admin list copies the /welcome/ link. The database part is required when
// TEST_DATABASE_URL is set and skipped when no server is reachable; the
// wiring part always runs.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/** A request carrying `cookies`, and a response that records what it set and cleared. */
function exchange(cookies = {}) {
  const set = [];
  const cleared = [];
  return {
    req: { cookies, headers: {}, protocol: 'http', secure: false, get: () => undefined },
    res: {
      cookie: (name, value, opts) => set.push({ name, value, opts }),
      clearCookie: (name, opts) => cleared.push({ name, opts }),
    },
    set,
    cleared,
  };
}

test('admin invite links on the real schema: preview, one link one account, racing sign-ups, and an email code that never waits',
  { timeout: 180000 }, async (t) => {
    const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
    try { await admin.query('SELECT 1'); } catch (err) {
      await admin.end();
      if (process.env.TEST_DATABASE_URL) throw err;
      t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check'); return;
    }
    const name = 'access_links_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DSN); url.pathname = '/' + name;
    const pool = new Pool({ connectionString: String(url), max: 6 });
    const poolPath = require.resolve('../src/db/pool');
    const originalPool = require.cache[poolPath];
    t.after(async () => {
      if (originalPool) require.cache[poolPath] = originalPool;
      else delete require.cache[poolPath];
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    });
    await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));
    require.cache[poolPath] = {
      exports: { getPool: () => pool },
      loaded: true, id: poolPath, filename: poolPath, paths: originalPool ? originalPool.paths : [],
    };

    const accessLinks = require('../src/services/access-links');
    const emailSignup = require('../src/services/email-signup');
    const { createSession } = require('../src/routes/auth');

    const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
    const waiting = async (username) => (await one(
      'INSERT INTO users (username, password, has_platform_access) VALUES ($1, $2, FALSE) RETURNING id',
      [username, 'x'])).id;
    const code = async (value, note = null) => {
      await pool.query('INSERT INTO activation_codes (code, note) VALUES ($1, $2)', [value, note]);
      return value;
    };
    const access = async (id) => (await one('SELECT has_platform_access FROM users WHERE id = $1', [id])).has_platform_access;
    const spentBy = async (value) => (await one('SELECT used_by FROM activation_codes WHERE code = $1', [value])).used_by;
    const marked = async (id) => (await one(
      "SELECT COUNT(*)::int AS n FROM events WHERE user_id = $1 AND event_type = 'access_link_let_in'", [id])).n;

    await t.test('the preview says only whether the link still lets somebody in', async () => {
      await code('aaaaaaaaaaaa', 'Maya, creator campaign');
      assert.deepEqual(await accessLinks.preview(pool, 'aaaaaaaaaaaa'), { live: true, reason: null });
      assert.deepEqual(await accessLinks.preview(pool, 'bbbbbbbbbbbb'), { live: false, reason: 'unknown' });
      // No code can look like this: told without a query.
      assert.deepEqual(await accessLinks.preview(pool, 'no'), { live: false, reason: 'unknown' });
      assert.deepEqual(await accessLinks.preview(pool, '../../etc'), { live: false, reason: 'unknown' });
    });

    await t.test('a waiting account is let in and spends the link; the next account finds it used', async () => {
      const first = await waiting('first_waiter');
      const second = await waiting('second_waiter');
      const value = await code('cccccccccccc');
      assert.equal((await accessLinks.admit(pool, { code: value, userId: first })).status, 'let_in');
      assert.equal(await access(first), true);
      assert.equal(await spentBy(value), first);
      assert.equal((await accessLinks.admit(pool, { code: value, userId: second })).status, 'used');
      assert.equal(await access(second), false);
      assert.deepEqual(await accessLinks.preview(pool, value), { live: false, reason: 'used' });
    });

    await t.test('an account that already has access spends nothing', async () => {
      const inAlready = (await one(
        "INSERT INTO users (username, password, has_platform_access) VALUES ('in_already', 'x', TRUE) RETURNING id")).id;
      const value = await code('dddddddddddd');
      assert.equal((await accessLinks.admit(pool, { code: value, userId: inAlready })).status, 'already_in');
      assert.equal(await spentBy(value), null);
      assert.deepEqual(await accessLinks.preview(pool, value), { live: true, reason: null });
    });

    await t.test('a link whose account was removed stays spent', async () => {
      const gone = await waiting('gone_soon');
      const value = await code('eeeeeeeeeeee');
      assert.equal((await accessLinks.admit(pool, { code: value, userId: gone })).status, 'let_in');
      await pool.query('DELETE FROM users WHERE id = $1', [gone]);
      assert.equal(await spentBy(value), null);
      assert.deepEqual(await accessLinks.preview(pool, value), { live: false, reason: 'used' });
      const next = await waiting('after_gone');
      assert.equal((await accessLinks.admit(pool, { code: value, userId: next })).status, 'used');
      assert.equal(await access(next), false);
    });

    await t.test('two sign-ups racing on one link: exactly one is let in', async () => {
      const value = await code('ffffffffffff');
      const racers = await Promise.all(['racer_a', 'racer_b', 'racer_c', 'racer_d'].map(waiting));
      const results = await Promise.all(racers.map((userId) => accessLinks.admit(pool, { code: value, userId })));
      assert.equal(results.filter((r) => r.status === 'let_in').length, 1);
      assert.equal(results.filter((r) => r.status === 'used').length, 3);
      const winner = racers[results.findIndex((r) => r.status === 'let_in')];
      assert.equal(await spentBy(value), winner);
      const accesses = await Promise.all(racers.map(access));
      assert.equal(accesses.filter(Boolean).length, 1);
    });

    await t.test('the carried cookie is used once, whatever the answer, and a bad one is ignored', async () => {
      const who = await waiting('carried_one');
      const value = await code('gggggggggggg');
      const hop = exchange({ [accessLinks.ACCESS_COOKIE]: value });
      const result = await accessLinks.admitCarried(pool, hop.req, hop.res, who);
      assert.equal(result.status, 'let_in');
      assert.deepEqual(hop.cleared.map((c) => c.name), [accessLinks.ACCESS_COOKIE]);
      assert.equal(await access(who), true);
      assert.equal(await marked(who), 1);

      const none = exchange({});
      assert.equal(await accessLinks.admitCarried(pool, none.req, none.res, who), null);
      assert.equal(none.cleared.length, 0);

      const bad = exchange({ [accessLinks.ACCESS_COOKIE]: "x'; DROP TABLE users; --" });
      assert.equal(await accessLinks.admitCarried(pool, bad.req, bad.res, who), null);
      assert.equal(bad.cleared.length, 1);
    });

    await t.test('an email code carrying the link makes an account that never waits', async () => {
      const value = await code('hhhhhhhhhhhh');
      const email = 'creator@example.test';
      await pool.query(
        `INSERT INTO mobile_otp_codes (email, code_hash, attempts, expires_at, created_at, updated_at)
         VALUES ($1, $2, 0, NOW() + INTERVAL '10 minutes', NOW(), NOW())`,
        [email, await bcrypt.hash('123456', 4)]);
      const hop = exchange({ [accessLinks.ACCESS_COOKIE]: value });
      const verified = await emailSignup.verifyCode(pool, email, '123456', {
        createSession,
        admit: (userId) => accessLinks.admitCarried(pool, hop.req, hop.res, userId),
      });
      assert.equal(verified.created, true);
      assert.equal(verified.waitlisted, false);
      assert.equal(await access(verified.userId), true);
      assert.equal(await spentBy(value), verified.userId);
      const spots = await one('SELECT COUNT(*)::int AS n FROM waitlist_signups WHERE linked_user_id = $1', [verified.userId]);
      assert.equal(spots.n, 0);

      // Without the link the same sign-up waits, as before.
      const other = 'no.link@example.test';
      await pool.query(
        `INSERT INTO mobile_otp_codes (email, code_hash, attempts, expires_at, created_at, updated_at)
         VALUES ($1, $2, 0, NOW() + INTERVAL '10 minutes', NOW(), NOW())`,
        [other, await bcrypt.hash('123456', 4)]);
      const plain = await emailSignup.verifyCode(pool, other, '123456', { createSession });
      assert.equal(plain.waitlisted, true);
      assert.equal(await access(plain.userId), false);
    });
  });

test('admin invite links are followed by every sign-in, and the page and the admin list point at /welcome/', () => {
  const auth = read('src/routes/auth.js');
  // The email code hands the carried link to the service, which lets the
  // account in before its waitlist spot; a password sign-in follows it too.
  assert.match(auth, /admit: \(userId\) => accessLinks\.admitCarried\(pool, req, res, userId\)/);
  assert.match(auth, /await accessLinks\.admitCarried\(pool, req, res, user\.id\);/);
  const signup = read('src/services/email-signup.js');
  const finish = signup.slice(signup.indexOf('async function finishProvenEmail'));
  assert.ok(finish.indexOf('await admit(result.userId)') > -1);
  assert.ok(finish.indexOf('await admit(result.userId)') < finish.indexOf('ensureAccountSignup'),
    'the link lets the account in before it would get a waitlist spot');
  assert.match(read('src/routes/phone-auth.js'), /await accessLinks\.admitCarried\(pool, req, res, result\.userId\);/);
  const providers = read('src/routes/sign-in-providers.js');
  assert.ok(providers.indexOf('accessLinks.admitCarried(pool, req, res, result.userId)')
    < providers.indexOf('await waitlist.ensureAccountSignup(pool, { userId: result.userId });'));

  // The page is a shell document a signed-out or waiting visitor may open.
  const { isSpaDocumentPath } = loadSpaDocumentPath();
  assert.equal(isSpaDocumentPath('/welcome/608c05ca00df'), true);
  assert.equal(isSpaDocumentPath('/welcome/a/b'), false);
  assert.match(read('server.js'), /app\.use\(accessLinkRoutes\(config\)\);/);
  // The POST a waiting account makes sits under the gate's open /api/auth/.
  assert.match(read('src/routes/access-links.js'), /router\.post\('\/api\/auth\/access-link'/);

  // What the admin copies, and the landing that opens the sheet for it.
  assert.match(read('frontend/src/features/admin/admin-codes.tsx'), /\/welcome\/\$\{encodeURIComponent\(code\)\}/);
  assert.match(read('frontend/src/features/auth/landing.tsx'), /useAccessLinkPreview\(\)/);
});

/** isSpaDocumentPath, read out of the middleware without loading its dependencies. */
function loadSpaDocumentPath() {
  const src = read('src/middleware/auth.js');
  const start = src.indexOf('function isSpaDocumentPath');
  const end = src.indexOf('\n}\n', start) + 2;
  // eslint-disable-next-line no-new-func
  return { isSpaDocumentPath: new Function(`${src.slice(start, end)}; return isSpaDocumentPath;`)() };
}
