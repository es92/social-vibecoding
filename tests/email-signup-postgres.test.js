'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Client, Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@localhost:5432/postgres';

const DDL = `
  CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    email_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    email_confirmed_at TIMESTAMPTZ,
    password_set BOOLEAN NOT NULL DEFAULT FALSE,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    admin_readonly BOOLEAN NOT NULL DEFAULT FALSE,
    has_platform_access BOOLEAN NOT NULL DEFAULT FALSE,
    platform_access_granted_at TIMESTAMPTZ,
    needs_username_choice BOOLEAN NOT NULL DEFAULT FALSE,
    -- Communities, stage 5: the join screen's flag, set by the same INSERT.
    needs_communities_choice BOOLEAN NOT NULL DEFAULT FALSE,
    -- The one list (2026-10-01): a new account's Getting started gate, set
    -- by the same INSERT.
    getting_started_gate BOOLEAN NOT NULL DEFAULT FALSE,
    -- chooseFirstUsername stamps it (QA 2026-09-24 Q12's handle choice).
    updated_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX users_email_lower_unique
    ON users (lower(email)) WHERE email IS NOT NULL;
  -- The handle a new account types at set-password goes through
  -- checkAvailability, which consults the retired-handle ledger as well as
  -- the live table (#2563; since #3575 nothing is derived from the address).
  CREATE TABLE username_history (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username VARCHAR(255) NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE sessions (
    token VARCHAR(64) PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    native_session_credential_reference VARCHAR(47)
  );
  CREATE TABLE mobile_otp_codes (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    code_hash VARCHAR(255) NOT NULL,
    attempts SMALLINT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
  );
  CREATE TABLE web_signup_sessions (
    token_hash VARCHAR(64) PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE mobile_auth_tokens (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    ability VARCHAR(20) NOT NULL CHECK (ability = 'session'),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE seasons (
    id BIGINT PRIMARY KEY,
    internal BOOLEAN NOT NULL,
    is_active BOOLEAN NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE onchain_accounts (
    id BIGINT PRIMARY KEY,
    address VARCHAR(100) NOT NULL,
    public_key VARCHAR(64) NOT NULL,
    secret_key VARCHAR(64) NOT NULL,
    season_event_id BIGINT,
    season_id BIGINT NOT NULL REFERENCES seasons(id),
    user_id INTEGER REFERENCES users(id),
    updated_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX onchain_accounts_user_season_unique
    ON onchain_accounts (user_id, season_id)
    WHERE user_id IS NOT NULL AND season_event_id IS NULL;
  CREATE TABLE user_enrollments (
    id BIGSERIAL PRIMARY KEY,
    season_event_id BIGINT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    season_id BIGINT NOT NULL REFERENCES seasons(id),
    registered_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX user_enrollments_user_season_unique
    ON user_enrollments (user_id, season_id) WHERE season_event_id IS NULL;
  CREATE TABLE native_session_credentials (
    credential_reference VARCHAR(47) PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES onchain_accounts(id),
    user_id INTEGER REFERENCES users(id),
    mobile_auth_token_id BIGINT REFERENCES mobile_auth_tokens(id),
    state TEXT,
    expires_at TIMESTAMPTZ
  );
  CREATE TABLE waitlist_signups (
    email VARCHAR(255) PRIMARY KEY,
    linked_user_id INTEGER,
    released_at TIMESTAMPTZ
  );
  CREATE TABLE mail_deliveries (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    recipient_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

async function withDatabase(t, run) {
  const admin = new Client({ connectionString: DSN, connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    await admin.end().catch(() => {});
    return t.skip(`no postgres reachable at ${DSN}: ${error.message || error.code || error}`);
  }

  const schema = `email_signup_test_${process.pid}`;
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: DSN,
    connectionTimeoutMillis: 3000,
    options: `-c search_path=${schema}`,
  });
  try {
    await pool.query(DDL);
    await run(pool);
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

function cookieValue(headers, name) {
  const cookies = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  const match = cookies.map((cookie) => new RegExp(`(?:^|, )${name}=([^;]*)`).exec(cookie))
    .find(Boolean);
  return match ? decodeURIComponent(match[1]) : null;
}

test('real PostgreSQL web signup keeps authority in HttpOnly cookies', async (t) => {
  await withDatabase(t, async (pool) => {
    const poolPath = require.resolve('../src/db/pool');
    const authPath = require.resolve('../src/routes/auth');
    const mobilePath = require.resolve('../src/routes/topochain/mobile');
    const mail = require('../src/services/mail');
    const originalPool = require.cache[poolPath];
    const originalSend = mail.sendOtpMail;
    const originalPrune = mail.pruneDeliveries;
    let code = null;
    require.cache[poolPath] = {
      exports: { getPool: () => pool },
      loaded: true,
      id: poolPath,
      filename: poolPath,
      paths: originalPool ? originalPool.paths : [],
    };
    mail.sendOtpMail = async (_config, _email, value) => { code = value; };
    mail.pruneDeliveries = async () => {};
    delete require.cache[authPath];
    delete require.cache[mobilePath];

    const { authRoutes } = require('../src/routes/auth');
    const { topochainMobileRoutes } = require('../src/routes/topochain/mobile');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(topochainMobileRoutes({}));
    app.use(authRoutes({}));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const request = await fetch(`${base}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'New.User@example.com' }),
      });
      assert.equal(request.status, 200);
      assert.match(code, /^[0-9]{6}$/);

      const verify = await fetch(`${base}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new.user@example.com', code }),
      });
      assert.equal(verify.status, 200);
      // QA 2026-09-24 Q12: additive fields so the set-password step can say
      // that the code just created the account, ask for the handle, and say
      // before the waiting room that it queues. `ok` and `next` are what
      // they always were. #3575: no `suggestedUsername` — the field the
      // person types into starts empty.
      assert.deepEqual(await verify.json(), {
        ok: true,
        next: 'set-password',
        created: true,
        needsUsername: true,
        waitlisted: true,
      });
      const signupCookie = cookieValue(verify.headers, 'usernode_signup');
      assert.match(signupCookie, /^[0-9a-f]{64}$/);
      assert.match(verify.headers.get('set-cookie'), /HttpOnly/i);
      assert.match(verify.headers.get('set-cookie'), /Path=\/api\/auth\/otp/i);

      // #2563 + #3575: the address is NEVER the handle, and neither is
      // anything derived from it. Until the person chooses, the row holds an
      // opaque placeholder — not `newuser`, which is what the local part
      // `New.User` used to become — and is marked as still owing a choice.
      const pendingRow = (await pool.query(
        'SELECT username, needs_username_choice, needs_communities_choice, getting_started_gate FROM users WHERE email = $1',
        ['new.user@example.com'],
      )).rows[0];
      assert.match(pendingRow.username, /^member_[0-9a-f]{18}$/);
      assert.equal(pendingRow.needs_username_choice, true);
      assert.equal(pendingRow.needs_communities_choice, true,
        'a new account is asked which communities to join, after its username');
      assert.equal(pendingRow.getting_started_gate, true,
        'and starts on the Getting started list that gates its season (2026-10-01)');

      const setPassword = (payload) => fetch(`${base}/api/auth/otp/set-password`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `usernode_signup=${signupCookie}`,
        },
        body: JSON.stringify({
          password: 'correct horse battery staple',
          passwordConfirmation: 'correct horse battery staple',
          ...payload,
        }),
      });

      // #3575: a new account does not finish sign-up without typing a
      // handle. Refused as a username error, and nothing is spent: no
      // session, no password, and the signup cookie still works.
      const unnamed = await setPassword({});
      assert.equal(unnamed.status, 422);
      assert.deepEqual(await unnamed.json(), {
        error: 'Enter a username.',
        code: 'username_required',
        field: 'username',
      });
      assert.doesNotMatch(unnamed.headers.get('set-cookie') || '', /usernode_signup=;/);
      assert.equal(cookieValue(unnamed.headers, 'session'), null);
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM web_signup_sessions',
      )).rows[0].count, 1);
      assert.equal((await pool.query(
        'SELECT password_set FROM users WHERE email = $1',
        ['new.user@example.com'],
      )).rows[0].password_set, false);

      const complete = await setPassword({ username: 'New_User' });
      assert.equal(complete.status, 200);
      const body = await complete.json();
      assert.deepEqual(Object.keys(body), ['user']);
      assert.equal(body.user.username, 'New_User');
      assert.equal('token' in body, false);
      const createdRow = (await pool.query(
        'SELECT username, email, needs_username_choice, needs_communities_choice FROM users WHERE email = $1',
        ['new.user@example.com'],
      )).rows[0];
      assert.equal(createdRow.username, 'New_User');
      assert.equal(createdRow.needs_username_choice, false);
      assert.equal(createdRow.needs_communities_choice, true);
      const sessionCookie = cookieValue(complete.headers, 'session');
      assert.match(sessionCookie, /^[0-9a-f]{64}$/);
      assert.match(complete.headers.get('set-cookie'), /HttpOnly/i);

      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM web_signup_sessions',
      )).rows[0].count, 0);
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM sessions WHERE token = $1',
        [sessionCookie],
      )).rows[0].count, 1);
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM mobile_auth_tokens',
      )).rows[0].count, 0);

      const replay = await fetch(`${base}/api/auth/otp/set-password`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `usernode_signup=${signupCookie}`,
        },
        body: JSON.stringify({ password: 'another password', passwordConfirmation: 'another password' }),
      });
      assert.equal(replay.status, 422);
      assert.equal((await replay.json()).code, 'invalid_signup_session');

      const { rows: sourceRows } = await pool.query(
        `INSERT INTO users
           (username, password, email, email_confirmed, password_set)
         VALUES ('legacy@example.com', 'unused', 'legacy@example.com', TRUE, TRUE)
         RETURNING id`,
      );
      const sourceId = sourceRows[0].id;
      await pool.query(
        `INSERT INTO seasons (id, internal, is_active, starts_at, ends_at)
         VALUES (10, FALSE, TRUE, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day')`,
      );
      await pool.query(
        `INSERT INTO onchain_accounts
           (id, address, public_key, secret_key, season_id, user_id, updated_at)
         VALUES (400, 'ut1legacy', 'utpk1legacy', 'utsk1legacy', 10, $1, NOW())`,
        [sourceId],
      );
      await pool.query(
        `INSERT INTO mobile_auth_tokens
           (user_id, token_hash, ability, expires_at)
         VALUES ($1, repeat('a', 64), 'session', NOW() + INTERVAL '1 day')`,
        [sourceId],
      );

      code = null;
      const claimCodeRequest = await fetch(`${base}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'legacy@example.com' }),
      });
      assert.equal(claimCodeRequest.status, 200);
      assert.match(code, /^[0-9]{6}$/);

      const claim = await fetch(`${base}/api/v4/mobile/wallet/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `session=${sessionCookie}`,
        },
        body: JSON.stringify({ email: 'legacy@example.com', code }),
      });
      assert.equal(claim.status, 200);
      const claimed = await claim.json();
      assert.equal(claimed.claimed, true);
      assert.equal(claimed.address, 'ut1legacy');
      assert.equal('secret_key' in claimed, false);
      assert.equal((await pool.query(
        'SELECT user_id FROM onchain_accounts WHERE id = 400',
      )).rows[0].user_id, body.user.id);
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM user_enrollments WHERE user_id = $1 AND season_id = 10',
        [body.user.id],
      )).rows[0].count, 1);
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM mobile_auth_tokens WHERE user_id = $1',
        [sourceId],
      )).rows[0].count, 0);

      // A key already published to a protocol-2 installation cannot be
      // revoked by deleting a server bearer. Keep ownership unchanged until
      // the deferred on-chain key-rotation primitive exists.
      await pool.query(
        'UPDATE onchain_accounts SET user_id = $1 WHERE id = 400',
        [sourceId],
      );
      await pool.query(
        'DELETE FROM user_enrollments WHERE user_id = $1 AND season_id = 10',
        [body.user.id],
      );
      await pool.query(
        `INSERT INTO native_session_credentials (credential_reference, account_id)
         VALUES ('nsc_bound_legacy_wallet', 400)`,
      );
      code = null;
      await fetch(`${base}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'legacy@example.com' }),
      });
      const blockedClaim = await fetch(`${base}/api/v4/mobile/wallet/claim`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `session=${sessionCookie}`,
        },
        body: JSON.stringify({ email: 'legacy@example.com', code }),
      });
      assert.equal(blockedClaim.status, 409);
      assert.equal((await blockedClaim.json()).code, 'wallet_claim_requires_key_rotation');
      assert.equal((await pool.query(
        'SELECT user_id FROM onchain_accounts WHERE id = 400',
      )).rows[0].user_id, sourceId);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      mail.sendOtpMail = originalSend;
      mail.pruneDeliveries = originalPrune;
      if (originalPool) require.cache[poolPath] = originalPool;
      else delete require.cache[poolPath];
      delete require.cache[authPath];
      delete require.cache[mobilePath];
    }
  });
});

// Issue #1586. `verifyCode()` used to answer a correct code with the same
// generic `invalid_or_expired_code` a WRONG code gets whenever the matched
// account had `password_set` — which is every account the flow itself had
// ever completed, so email sign-in worked exactly once per person. These four
// cases pin the branch table that replaced that single gate.
test('an email code branches on the account it matches (#1586)', async (t) => {
  await withDatabase(t, async (pool) => {
    const poolPath = require.resolve('../src/db/pool');
    const authPath = require.resolve('../src/routes/auth');
    const limitsPath = require.resolve('../src/middleware/rate-limits');
    const mail = require('../src/services/mail');
    const originalPool = require.cache[poolPath];
    const originalSend = mail.sendOtpMail;
    const originalPrune = mail.pruneDeliveries;
    let code = null;
    require.cache[poolPath] = {
      exports: { getPool: () => pool },
      loaded: true,
      id: poolPath,
      filename: poolPath,
      paths: originalPool ? originalPool.paths : [],
    };
    mail.sendOtpMail = async (_config, _email, value) => { code = value; };
    mail.pruneDeliveries = async () => {};
    delete require.cache[authPath];
    // The auth limiters are module-level singletons with one shared store, so
    // this file's other test has already spent part of the OTP-request budget
    // for 127.0.0.1. Re-require them for a fresh set of buckets.
    delete require.cache[limitsPath];

    const { authRoutes } = require('../src/routes/auth');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(authRoutes({}));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    // Ask for a code and hand back the one the mail transport was given.
    const freshCode = async (email) => {
      code = null;
      const res = await fetch(`${base}/api/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      assert.equal(res.status, 200);
      assert.match(code, /^[0-9]{6}$/);
      return code;
    };
    const verify = (email, value) => fetch(`${base}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: value }),
    });
    const seed = async (email, columns) => {
      const { rows } = await pool.query(
        `INSERT INTO users (username, password, email, ${Object.keys(columns).join(', ')})
         VALUES ($1, 'unused', $1, ${Object.keys(columns).map((_, i) => `$${i + 2}`).join(', ')})
         RETURNING id`,
        [email, ...Object.values(columns)],
      );
      return rows[0].id;
    };

    try {
      // ── The fix: password set AND email confirmed → signed straight in ──
      const signInId = await seed('has.password@example.com', {
        email_confirmed: true, password_set: true, is_admin: false,
      });
      const signedIn = await verify(
        'has.password@example.com',
        await freshCode('has.password@example.com'),
      );
      assert.equal(signedIn.status, 200);
      const signedInBody = await signedIn.json();
      assert.equal(signedInBody.ok, true);
      assert.equal(signedInBody.next, 'signed-in');
      assert.equal(signedInBody.user.id, signInId);
      assert.equal(signedInBody.user.username, 'has.password@example.com');
      // Shaped like /api/auth/login's response, so the client can finish the
      // same way it does after a password sign-in.
      assert.equal(signedInBody.user.isAdmin, false);

      const sessionCookie = cookieValue(signedIn.headers, 'session');
      assert.match(sessionCookie, /^[0-9a-f]{64}$/);
      assert.match(signedIn.headers.get('set-cookie'), /HttpOnly/i);
      assert.equal((await pool.query(
        'SELECT user_id FROM sessions WHERE token = $1',
        [sessionCookie],
      )).rows[0].user_id, signInId);
      // No password to set up, so no continuation is handed out at all.
      assert.equal(cookieValue(signedIn.headers, 'usernode_signup'), '');
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM web_signup_sessions WHERE user_id = $1',
        [signInId],
      )).rows[0].count, 0);

      // ── Password set, email NEVER confirmed → routed to the password form ──
      const legacyId = await seed('unconfirmed@example.com', {
        email_confirmed: false, password_set: true, is_admin: false,
      });
      const refused = await verify(
        'unconfirmed@example.com',
        await freshCode('unconfirmed@example.com'),
      );
      assert.equal(refused.status, 422);
      const refusedBody = await refused.json();
      assert.equal(refusedBody.code, 'password_required');
      assert.match(refusedBody.error, /signs in with a password/);
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM sessions WHERE user_id = $1',
        [legacyId],
      )).rows[0].count, 0);
      // Refusing does not confirm the address behind the person's back.
      assert.equal((await pool.query(
        'SELECT email_confirmed FROM users WHERE id = $1',
        [legacyId],
      )).rows[0].email_confirmed, false);

      // ── An admin account is never signed in by a code ──────────────────
      const adminId = await seed('admin@example.com', {
        email_confirmed: true, password_set: true, is_admin: true,
      });
      const adminRefused = await verify(
        'admin@example.com',
        await freshCode('admin@example.com'),
      );
      assert.equal(adminRefused.status, 422);
      assert.equal((await adminRefused.json()).code, 'admin_password_required');
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM sessions WHERE user_id = $1',
        [adminId],
      )).rows[0].count, 0);

      // ── A correct code is consumed on every branch, refusals included ──
      assert.equal((await pool.query(
        `SELECT COUNT(*)::int AS count FROM mobile_otp_codes
          WHERE consumed_at IS NULL
            AND email IN ('has.password@example.com', 'unconfirmed@example.com',
                          'admin@example.com')`,
      )).rows[0].count, 0);

      // ── Verifying mints a session, so it sits behind the mint boundary ──
      const whileSignedIn = await fetch(`${base}/api/auth/otp/verify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `session=${sessionCookie}`,
        },
        body: JSON.stringify({ email: 'has.password@example.com', code: '000000' }),
      });
      assert.equal(whileSignedIn.status, 409);
      assert.equal((await whileSignedIn.json()).code, 'logout_required');
      // Requesting one does NOT: the wallet-recovery dialog and the mobile
      // wallet-claim flow both ask for a code while signed in.
      const requestWhileSignedIn = await fetch(`${base}/api/auth/otp/request`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `session=${sessionCookie}`,
        },
        body: JSON.stringify({ email: 'has.password@example.com' }),
      });
      assert.equal(requestWhileSignedIn.status, 200);

      // ── The regression itself: a SECOND code for an account the flow
      //    already completed signs in instead of reading as mistyped ──────
      const firstVerify = await verify(
        'twice@example.com',
        await freshCode('twice@example.com'),
      );
      assert.equal(firstVerify.status, 200);
      assert.equal((await firstVerify.json()).next, 'set-password');
      const signupCookie = cookieValue(firstVerify.headers, 'usernode_signup');
      const setPassword = await fetch(`${base}/api/auth/otp/set-password`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `usernode_signup=${signupCookie}`,
        },
        body: JSON.stringify({
          password: 'correct horse battery staple',
          passwordConfirmation: 'correct horse battery staple',
          // #3575: a new account names itself to finish.
          username: 'twice_here',
        }),
      });
      assert.equal(setPassword.status, 200);
      const createdId = (await setPassword.json()).user.id;

      const secondVerify = await verify(
        'twice@example.com',
        await freshCode('twice@example.com'),
      );
      assert.equal(secondVerify.status, 200);
      const secondBody = await secondVerify.json();
      assert.equal(secondBody.next, 'signed-in');
      assert.equal(secondBody.user.id, createdId);

      // ── The password-less branch is unchanged, and stamps the address ──
      const setupId = await seed('no.password@example.com', {
        email_confirmed: false, password_set: false, is_admin: false,
      });
      const setup = await verify(
        'no.password@example.com',
        await freshCode('no.password@example.com'),
      );
      assert.equal(setup.status, 200);
      // QA 2026-09-24 Q12: an account that already existed is not "created",
      // and one that never owed a handle is not asked for one.
      assert.deepEqual(await setup.json(), {
        ok: true,
        next: 'set-password',
        created: false,
        needsUsername: false,
        waitlisted: true,
      });
      assert.match(cookieValue(setup.headers, 'usernode_signup'), /^[0-9a-f]{64}$/);
      assert.equal((await pool.query(
        'SELECT COUNT(*)::int AS count FROM web_signup_sessions WHERE user_id = $1',
        [setupId],
      )).rows[0].count, 1);
      // Reading the code proves the mailbox, so the confirmation is stamped
      // here — which stops the row ageing into the refusal branch above.
      assert.equal((await pool.query(
        'SELECT email_confirmed FROM users WHERE id = $1',
        [setupId],
      )).rows[0].email_confirmed, true);

      // #3575 is about NEW accounts. One that already existed and never owed
      // a handle finishes without being asked, and keeps the one it has.
      const setupDone = await fetch(`${base}/api/auth/otp/set-password`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `usernode_signup=${cookieValue(setup.headers, 'usernode_signup')}`,
        },
        body: JSON.stringify({
          password: 'correct horse battery staple',
          passwordConfirmation: 'correct horse battery staple',
        }),
      });
      assert.equal(setupDone.status, 200);
      assert.equal((await setupDone.json()).user.username, 'no.password@example.com');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      mail.sendOtpMail = originalSend;
      mail.pruneDeliveries = originalPrune;
      if (originalPool) require.cache[poolPath] = originalPool;
      else delete require.cache[poolPath];
      delete require.cache[authPath];
      delete require.cache[limitsPath];
    }
  });
});

// #1548 made the invite link request a code by itself, which turns an
// ordinary reload into a second request for the same address. The mail
// layer already refuses to SEND inside RULES.otp.minGapMs, so before this
// rule the reload silently replaced the live code with one nobody could
// read — the recipient's email held a code the server had already thrown
// away. Reusing the outstanding code inside the same window is what makes
// the auto-send safe to repeat.
test('a repeat code request inside the min gap reuses the outstanding code', async (t) => {
  await withDatabase(t, async (pool) => {
    const poolPath = require.resolve('../src/db/pool');
    const authPath = require.resolve('../src/routes/auth');
    const mail = require('../src/services/mail');
    const originalPool = require.cache[poolPath];
    const originalSend = mail.sendOtpMail;
    const originalPrune = mail.pruneDeliveries;
    const sent = [];
    require.cache[poolPath] = {
      exports: { getPool: () => pool },
      loaded: true,
      id: poolPath,
      filename: poolPath,
      paths: originalPool ? originalPool.paths : [],
    };
    mail.sendOtpMail = async (_config, _email, value) => { sent.push(value); };
    mail.pruneDeliveries = async () => {};
    delete require.cache[authPath];

    const { authRoutes } = require('../src/routes/auth');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(authRoutes({}));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const request = () => fetch(`${base}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'invited@example.com' }),
    });
    const liveRow = async () => (await pool.query(
      `SELECT id, code_hash FROM mobile_otp_codes
        WHERE email = 'invited@example.com' AND consumed_at IS NULL`,
    )).rows;

    try {
      assert.equal((await request()).status, 200);
      const first = await liveRow();
      assert.equal(first.length, 1);
      assert.equal(sent.length, 1);

      // The reload. Same 200 (the endpoint never tells a caller whether an
      // address exists), but the row and the code behind it must survive.
      assert.equal((await request()).status, 200);
      const second = await liveRow();
      assert.equal(second.length, 1);
      assert.equal(second[0].id, first[0].id, 'the outstanding code must be reused');
      assert.equal(second[0].code_hash, first[0].code_hash);
      assert.equal(sent.length, 1, 'a reused code must not be re-sent');

      // A wrong guess ends the reuse: whoever is typing has seen the code
      // fail, so the next request has to be a genuinely new one.
      await pool.query(
        `UPDATE mobile_otp_codes SET attempts = 1 WHERE id = $1`, [first[0].id],
      );
      assert.equal((await request()).status, 200);
      const third = await liveRow();
      assert.equal(third.length, 1);
      assert.notEqual(third[0].id, first[0].id, 'a guessed-at code must be replaced');
      assert.equal(sent.length, 2);

      // And so does age. Past the window the code is replaced even though it
      // is unexpired and untouched, so "send a new code" means what it says.
      await pool.query(
        `UPDATE mobile_otp_codes
            SET created_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`,
        [third[0].id],
      );
      assert.equal((await request()).status, 200);
      const fourth = await liveRow();
      assert.equal(fourth.length, 1);
      assert.notEqual(fourth[0].id, third[0].id, 'an aged code must be replaced');
      assert.equal(sent.length, 3);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      mail.sendOtpMail = originalSend;
      mail.pruneDeliveries = originalPrune;
      if (originalPool) require.cache[poolPath] = originalPool;
      else delete require.cache[poolPath];
      delete require.cache[authPath];
    }
  });
});

// QA 2026-09-24 Q12: the set-password step asks a new account for its handle
// instead of the waiting room introducing one the person never chose. Since
// #3575 the field starts empty and is required for an account that has never
// chosen; a refused or missing name leaves the signup session unspent so the
// corrected submit works.
test('set-password takes the first handle, and a refused one keeps the session', async (t) => {
  await withDatabase(t, async (pool) => {
    const poolPath = require.resolve('../src/db/pool');
    const authPath = require.resolve('../src/routes/auth');
    const limitsPath = require.resolve('../src/middleware/rate-limits');
    const mail = require('../src/services/mail');
    const originalPool = require.cache[poolPath];
    const originalSend = mail.sendOtpMail;
    const originalPrune = mail.pruneDeliveries;
    let code = null;
    require.cache[poolPath] = {
      exports: { getPool: () => pool },
      loaded: true,
      id: poolPath,
      filename: poolPath,
      paths: originalPool ? originalPool.paths : [],
    };
    mail.sendOtpMail = async (_config, _email, value) => { code = value; };
    mail.pruneDeliveries = async () => {};
    delete require.cache[authPath];
    delete require.cache[limitsPath];

    const { authRoutes } = require('../src/routes/auth');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(authRoutes({}));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, cookie) => fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

    try {
      await pool.query(
        `INSERT INTO users (username, password) VALUES ('taken_name', 'unused')`,
      );
      assert.equal((await post('/api/auth/otp/request', { email: 'pick.me@example.com' })).status, 200);
      const verified = await post('/api/auth/otp/verify', { email: 'pick.me@example.com', code });
      assert.equal(verified.status, 200);
      const vBody = await verified.json();
      assert.equal(vBody.created, true);
      assert.equal(vBody.needsUsername, true);
      // #3575: nothing derived from `pick.me@` is offered, or stored.
      assert.equal('suggestedUsername' in vBody, false);
      assert.equal((await pool.query(
        "SELECT COUNT(*)::int AS n FROM users WHERE username ILIKE '%pick%'",
      )).rows[0].n, 0);
      const cookie = `usernode_signup=${cookieValue(verified.headers, 'usernode_signup')}`;
      const pw = { password: 'correct horse battery staple', passwordConfirmation: 'correct horse battery staple' };

      // No name at all is refused the same way, as is a blank one: the
      // person has to type one (#3575).
      for (const blank of [{}, { username: '' }]) {
        const r = await post('/api/auth/otp/set-password', { ...pw, ...blank }, cookie);
        assert.equal(r.status, 422);
        const b = await r.json();
        assert.equal(b.code, 'username_required');
        assert.equal(b.field, 'username');
      }
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM web_signup_sessions')).rows[0].n, 1);

      // A malformed name is refused as a username error, and the signup
      // session survives it.
      let res = await post('/api/auth/otp/set-password', { ...pw, username: 'bad name!' }, cookie);
      assert.equal(res.status, 422);
      let body = await res.json();
      assert.equal(body.code, 'invalid_username');
      assert.equal(body.field, 'username');
      assert.doesNotMatch(res.headers.get('set-cookie') || '', /usernode_signup=;/);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM web_signup_sessions')).rows[0].n, 1);

      // So does a taken one (case-insensitively, as everywhere else).
      res = await post('/api/auth/otp/set-password', { ...pw, username: 'Taken_Name' }, cookie);
      assert.equal(res.status, 422);
      body = await res.json();
      assert.equal(body.code, 'username_taken');
      assert.equal(body.field, 'username');
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM web_signup_sessions')).rows[0].n, 1);
      assert.equal((await pool.query(
        "SELECT password_set FROM users WHERE email = 'pick.me@example.com'",
      )).rows[0].password_set, false, 'nothing was written by a refused submit');

      // The corrected submit sets the password AND the handle, clears the
      // first-run flag, and signs in under the chosen name.
      res = await post('/api/auth/otp/set-password', { ...pw, username: 'Ada_Picked' }, cookie);
      assert.equal(res.status, 200);
      body = await res.json();
      assert.equal(body.user.username, 'Ada_Picked');
      const row = (await pool.query(
        "SELECT username, needs_username_choice, password_set FROM users WHERE email = 'pick.me@example.com'",
      )).rows[0];
      assert.deepEqual(row, { username: 'Ada_Picked', needs_username_choice: false, password_set: true });
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM web_signup_sessions')).rows[0].n, 0);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM username_history')).rows[0].n, 0,
        'a first choice retires nothing');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      mail.sendOtpMail = originalSend;
      mail.pruneDeliveries = originalPrune;
      if (originalPool) require.cache[poolPath] = originalPool;
      else delete require.cache[poolPath];
      delete require.cache[authPath];
      delete require.cache[limitsPath];
    }
  });
});
