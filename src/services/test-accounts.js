'use strict';

// Test accounts: a genuinely new account for first-time-user testing, minted
// by a full platform admin through the connector (create_test_account,
// routes/test-accounts.js) and retired with one call when testing is done.
//
// Why a new account rather than "Reset first run" on an old one: a reset
// brings back the join screen and the tour but keeps memberships, votes and
// history, so the First challenges show progress a newcomer would not have. A test
// account is a REAL account — it signs in through the ordinary form (username
// and a generated password is the one method that works on the web and in the
// iOS app, against local, staging and production alike), auto-joins the
// Homeroom community and can vote — and that is exactly why it is fenced:
//
//   * users.test_account_created_at marks it, for good (schema.sql).
//   * Its votes on an app a real person made are recorded and shown but not
//     counted, and it is left out of the active-member denominator
//     (counts_toward_outcome in schema.sql; D1).
//   * Leaderboards (exclude_podium) and the Journey page (a 'test' left-out
//     entry) do not see it.
//   * No welcome DM unless the creator asked (test_account_welcome_dm: it
//     puts staff into a group with the account); never a season wallet on a
//     native sign-in (native-session-protocol.js; D2). Homeroom bot's hellos
//     (the tour's, a maker's, a joiner's, a member's) are not fenced: they
//     reach it as they reach a newcomer, however it was made (#4897).
//   * At most MAX_LIVE at once, so app slots, the wallet pool and the bot's 50
//     DM places cannot be drained by a loop.
//
// The password is returned ONCE, to the admin who asked, and never logged,
// stored in plain text or written to an event or audit payload.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const log = require('./logger');
const usernames = require('./usernames');
const waitlist = require('./waitlist');
const journeyLeftOut = require('./journey-left-out');
const { withTransaction } = require('./cli-auth');

const MAX_LIVE = 25;
const NOTE_MAX = 200;
const PASSWORD_BYTES = 12;
const BCRYPT_COST = 12;
const RETIRE_CONFIRMATION = 'RETIRE';
// One advisory lock serialises creates, so two admins at 24 cannot both make
// the 25th and the 26th.
const CAP_LOCK_KEY = 'test-accounts:cap';

class TestAccountError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function fail(status, code, message, extra) {
  throw new TestAccountError(status, code, message, extra);
}

// The one-time password: 16 base64url characters, 96 bits.
function generatePassword() {
  return crypto.randomBytes(PASSWORD_BYTES).toString('base64url');
}

function parseFlag(value, fallback, field) {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') fail(400, 'invalid_request', `${field} must be true or false.`, { field });
  return value;
}

function parseNote(value) {
  const note = value == null ? '' : String(value).trim();
  if (note.length > NOTE_MAX) {
    fail(400, 'note_too_long', `Keep the note to ${NOTE_MAX} characters.`, { field: 'note', limitChars: NOTE_MAX, actualChars: note.length });
  }
  return note;
}

function parseCreate(body) {
  const b = body && typeof body === 'object' ? body : {};
  let username = null;
  if (b.username != null && String(b.username).trim() !== '') {
    const check = usernames.validateUsername(b.username);
    if (!check.ok) fail(400, 'invalid_username', check.error, { field: 'username' });
    username = check.value;
  }
  return {
    username,
    platformAccess: parseFlag(b.platformAccess, true, 'platformAccess'),
    welcomeDm: parseFlag(b.welcomeDm, false, 'welcomeDm'),
    note: parseNote(b.note),
  };
}

/**
 * Make one test account as full admin `actorId`. Everything that decides
 * what the account is commits together: the row, its access, its Journey
 * entry and the audit row. (The Homeroom bot works for it as for anybody let
 * in.) Only the included OpenRouter key
 * is made after the commit, as sign-up makes it, because it calls out.
 *
 * Returns { userId, username, password, needsUsernameChoice, platformAccess,
 * welcomeDm, note }. The password is in nothing else.
 */
async function create(pool, body, { actorId, config = {} } = {}) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail(403, 'forbidden', 'A full administrator is required.');
  const input = parseCreate(body);
  const password = generatePassword();
  // Hashed before the transaction: bcrypt must not run while locks are held.
  const hash = await bcrypt.hash(password, BCRYPT_COST);

  let created;
  try {
    created = await withTransaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [CAP_LOCK_KEY]);
      const { rows: [{ n }] } = await client.query(
        `SELECT COUNT(*)::int AS n FROM users
          WHERE test_account_created_at IS NOT NULL AND anonymised_at IS NULL`
      );
      if (n >= MAX_LIVE) {
        fail(429, 'at_capacity', `There are already ${n} live test accounts, the most allowed at once. `
          + 'Retire one you have finished with (list_test_accounts shows them), then try again.', { live: n, max: MAX_LIVE });
      }
      if (input.username) {
        const free = await usernames.checkAvailability(client, input.username, null);
        if (!free.available) fail(409, 'username_taken', free.error, { field: 'username' });
      }
      const username = input.username || usernames.placeholderUsername();
      // terms consent and tour_done_at stay unset, so the terms, the
      // community picker, the tour and the First challenges all come up as they do
      // for a real newcomer. With no username the account wears a
      // placeholder and needs_username_choice, so the tester picks a handle
      // in the real first-run step (frontend/src/features/auth/
      // username-first-run.js). exclude_podium keeps it off the leaderboards.
      const { rows: [user] } = await client.query(
        `INSERT INTO users (username, password, password_set, needs_username_choice,
                            needs_communities_choice, getting_started_gate, exclude_podium,
                            test_account_created_by, test_account_created_at, test_account_welcome_dm)
         VALUES ($1, $2, TRUE, $3, TRUE, TRUE, TRUE, $4, NOW(), $5)
         RETURNING id, username`,
        [username, hash, !input.username, actorId, input.welcomeDm]
      );
      // Let in the way an invite lets somebody in, never as a release by
      // hand: manualRelease would make it invite generation 0, with skips
      // to hand out. The access triggers run here as for anybody let in —
      // it joins the Homeroom community, and queued community invites apply.
      if (input.platformAccess) await waitlist.grantPlatformAccess(client, user.id);
      await journeyLeftOut.addTestInTransaction(client, {
        userId: user.id, note: input.note || 'Test account (create_test_account)',
      }, { actorId });
      await client.query(
        `INSERT INTO support_actions (actor_user_id, target_user_id, action, reason, payload)
         VALUES ($1, $2, 'test_account_create', $3, $4::jsonb)`,
        [actorId, user.id, input.note || null, JSON.stringify({
          usernameChosen: !!input.username,
          platformAccess: input.platformAccess,
          welcomeDm: input.welcomeDm,
        })]
      );
      return user;
    });
  } catch (err) {
    if (err instanceof TestAccountError) throw err;
    if (err && err.code === '23505') fail(409, 'username_taken', 'That username is taken.', { field: 'username' });
    throw err;
  }
  journeyLeftOut.forget(pool);

  // #2568: the included OpenRouter key, as /api/auth/register makes it.
  // Never throws.
  const managedOpenRouter = require('./openrouter-managed-keys');
  await managedOpenRouter.ensureIncludedKey({ pool, userId: created.id, config, reason: 'test_account' });

  log.info('test-accounts', 'Test account created', {
    userId: created.id, by: actorId, usernameChosen: !!input.username,
    platformAccess: input.platformAccess, welcomeDm: input.welcomeDm,
  });
  return {
    userId: created.id,
    username: created.username,
    password,
    needsUsernameChoice: !input.username,
    platformAccess: input.platformAccess,
    welcomeDm: input.welcomeDm,
    note: input.note || null,
  };
}

/**
 * The live test accounts, newest first: who made each, when, when it was
 * last seen (its latest sign-in or day of app use), its note, its address
 * (one a test release email made has one), and the apps it created with
 * their status. Retired (anonymised) ones are not listed.
 */
async function list(pool) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.email, u.test_account_created_at AS created_at,
            c.username AS created_by,
            GREATEST(
              (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id),
              (SELECT MAX(aa.date)::timestamptz FROM app_activity aa WHERE aa.user_id = u.id)
            ) AS last_active_at,
            (SELECT sa.reason FROM support_actions sa
              WHERE sa.target_user_id = u.id AND sa.action = 'test_account_create'
              ORDER BY sa.id DESC LIMIT 1) AS note,
            COALESCE((SELECT json_agg(json_build_object('slug', a.slug, 'status', a.status) ORDER BY a.id)
                        FROM apps a WHERE a.created_by = u.id), '[]'::json) AS apps
       FROM users u
       LEFT JOIN users c ON c.id = u.test_account_created_by
      WHERE u.test_account_created_at IS NOT NULL AND u.anonymised_at IS NULL
      ORDER BY u.test_account_created_at DESC, u.id DESC`
  );
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    email: r.email || null,
    createdBy: r.created_by || null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    lastActiveAt: r.last_active_at ? new Date(r.last_active_at).toISOString() : null,
    note: r.note || null,
    apps: (Array.isArray(r.apps) ? r.apps : []).map((a) => ({ slug: String(a.slug), status: a.status == null ? null : String(a.status) })),
  }));
}

/**
 * Retire one test account as full admin `actorId`: take down every app it
 * created (the same teardown DELETE /api/apps/:slug runs), then delete the
 * account through the ordinary admin deletion, which anonymises the row,
 * revokes its sessions and native credentials and withdraws its open votes.
 *
 * Refuses any account that is not a test account. If an app cannot be taken
 * down it stops there and reports what it had removed: the account is never
 * deleted with its apps orphaned. Calling it again finishes the job.
 */
async function retire(pool, { userId, confirmation }, { actorId, config = {} } = {}) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail(403, 'forbidden', 'A full administrator is required.');
  if (!Number.isSafeInteger(userId) || userId <= 0) fail(400, 'invalid_request', 'userId must be a test account\'s id.');
  if (confirmation !== RETIRE_CONFIRMATION) {
    fail(400, 'confirmation_required', `Pass confirm: "${RETIRE_CONFIRMATION}" to retire a test account.`);
  }
  const { rows: [user] } = await pool.query(
    'SELECT id, username, test_account_created_at, anonymised_at FROM users WHERE id = $1',
    [userId]
  );
  if (!user || !user.test_account_created_at) {
    fail(404, 'not_test_account', 'That account is not a test account. Only accounts made with create_test_account can be retired here.');
  }
  if (user.anonymised_at) fail(409, 'already_retired', 'That test account has already been retired.');

  const { rows: apps } = await pool.query(
    'SELECT * FROM apps WHERE created_by = $1 ORDER BY id',
    [userId]
  );
  const { teardownApp } = require('./app-teardown');
  const removedApps = [];
  for (const app of apps) {
    try {
      await teardownApp(pool, config, app);
      removedApps.push(app.slug);
    } catch (err) {
      log.error('test-accounts', 'App teardown failed while retiring a test account', {
        userId, slug: app.slug, err: err.message,
      });
      fail(502, 'app_delete_failed', `Could not take down ${app.slug}, so the account was left in place. `
        + 'Nothing else was changed after that app. Retire it again to finish.', {
        removedApps, failedApp: app.slug,
      });
    }
  }

  const accountDeletion = require('./account-deletion');
  let deletion;
  try {
    deletion = await accountDeletion.deleteAccount(pool, {
      userId, actorId, mode: 'admin', confirmation: 'DELETE',
    });
  } catch (err) {
    if (err instanceof accountDeletion.AccountDeletionError) {
      fail(err.status || 400, err.code || 'delete_failed', err.message, { removedApps });
    }
    throw err;
  }
  await pool.query(
    `INSERT INTO support_actions (actor_user_id, target_user_id, action, payload)
     VALUES ($1, $2, 'test_account_retire', $3::jsonb)`,
    [actorId, userId, JSON.stringify({ username: user.username, apps: removedApps, deletionId: deletion.deletionId })]
  );
  log.info('test-accounts', 'Test account retired', { userId, by: actorId, apps: removedApps.length });
  return {
    userId,
    username: user.username,
    appsDeleted: removedApps,
    deletionId: deletion.deletionId,
  };
}

// "You're in" (frontend/src/features/first-session) tells an account that a
// link's own sign-up just made what Homeroom is, and an account that was
// already there only where it is. A real account is new when it was made
// within the hour before it joined (community-invites.js standing,
// collab-invites.js welcomeFor). A test account is made ahead of time by an
// admin, so its created_at says nothing about when its first run began, and
// the first-session run-through of 5 October 2026 met the welcome for an
// account that was already there. Its first run begins at its first sign-in,
// the way a real one begins at its sign-up: the oldest of its sessions on
// record, which is the only record a sign-in leaves (list() reads the newest
// the same way). Only a test account is read here, so nothing about a real
// account changes.
const FIRST_RUN_SQL = `
  SELECT MIN(s.created_at) >= $2::timestamptz - INTERVAL '1 hour' AS first_run
    FROM users u
    JOIN sessions s ON s.user_id = u.id
   WHERE u.id = $1 AND u.test_account_created_at IS NOT NULL`;

/**
 * Whether `userId` is a test account on its first run at `at` (default now):
 * signed in for the first time within the hour before it. False for every
 * real account, for a test account first signed in earlier, and for a read
 * that fails. Never throws: it only decides which welcome is shown.
 */
async function onFirstRun(db, userId, at = new Date()) {
  const id = Number(userId);
  const when = at instanceof Date ? at : new Date(at);
  if (!Number.isSafeInteger(id) || id <= 0 || Number.isNaN(when.getTime())) return false;
  try {
    const { rows } = await db.query(FIRST_RUN_SQL, [id, when.toISOString()]);
    return rows[0]?.first_run === true;
  } catch (err) {
    log.warn('test-accounts', 'Could not read whether a test account is on its first run', { userId: id, err: err.message });
    return false;
  }
}

// ── One-time phone sign-ins ─────────────────────────────────────────────
//
// The invite's Join sheet signs a newcomer up with a phone, so a first run
// through it needs a number that signs in. On a local stack PHONE_TEST_CODE
// does that (services/firebase-phone-auth.js, TEST NUMBERS); it is refused in
// production. Here a full admin mints ONE sign-in instead, in any
// environment: a fictional test number and a random six-digit code that
// works once, within PHONE_SIGN_IN_TTL_MS and PHONE_SIGN_IN_TRIES. Nothing
// standing lives on the server to leak or guess; the code is returned once
// and only its bcrypt hash is kept. The account the code makes is a test
// account (firebase-phone-auth.js markTestAccount), counted against
// MAX_LIVE from the moment the code is minted.

const PHONE_SIGN_IN_TTL_MS = 30 * 60 * 1000;
const PHONE_SIGN_IN_TRIES = 5;
// Numbers are picked from +1 415 555 0100–0199 when the admin names none.
const PHONE_AREA = '415';
const PHONE_CODE_COST = 10;

function testNumbersFor(area = PHONE_AREA) {
  const out = [];
  for (let n = 0; n < 100; n++) out.push(`+1${area}55501${String(n).padStart(2, '0')}`);
  return out;
}

/**
 * Mint one sign-in as full admin `actorId`. `phoneNumber` is optional: a
 * test number to use (one a live test account holds signs in to that
 * account), or a free one is picked. Returns { phoneNumber, code, expiresAt,
 * signsInTo } where signsInTo is the username the number already belongs to,
 * or null for a brand-new account. The code is in nothing else.
 */
async function mintPhoneSignIn(pool, { phoneNumber, actorId, config = {} } = {}) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail(403, 'forbidden', 'A full administrator is required.');
  const phoneAuth = require('./firebase-phone-auth');
  if (!phoneAuth.offered(config)) {
    fail(409, 'phone_sign_in_off', 'Phone sign-in is not set up on this server, so a test number has nothing to sign in to.');
  }
  let wanted = null;
  if (phoneNumber != null && String(phoneNumber).trim() !== '') {
    wanted = phoneAuth.normalizePhone(String(phoneNumber));
    if (!phoneAuth.isTestNumber(wanted)) {
      fail(400, 'not_test_number', 'Use a test number: +1, any area code, then 555 0100 to 0199. Or leave it out for a free one.', { field: 'phoneNumber' });
    }
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  // Hashed before the transaction: bcrypt must not run while locks are held.
  const hash = await bcrypt.hash(code, PHONE_CODE_COST);

  const minted = await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [CAP_LOCK_KEY]);
    let signsInTo = null;
    let number = wanted;
    if (number) {
      const { rows: [holder] } = await client.query(
        `SELECT u.username, u.test_account_created_at IS NOT NULL AS test_account
           FROM user_phone_identities i JOIN users u ON u.id = i.user_id
          WHERE i.phone_e164 = $1`,
        [number]
      );
      if (holder && !holder.test_account) {
        fail(409, 'number_in_use', 'That number belongs to an account that is not a test account, so it cannot be signed in to here.');
      }
      signsInTo = holder ? holder.username : null;
      // One live code per number: a new one replaces the last.
      await client.query(
        `UPDATE test_phone_sign_ins SET expires_at = NOW()
          WHERE phone_e164 = $1 AND used_at IS NULL AND expires_at > NOW()`,
        [number]
      );
    } else {
      const { rows: taken } = await client.query(
        `SELECT phone_e164 FROM user_phone_identities WHERE phone_e164 = ANY($1::varchar[])
          UNION
         SELECT phone_e164 FROM test_phone_sign_ins
          WHERE phone_e164 = ANY($1::varchar[]) AND used_at IS NULL AND expires_at > NOW()`,
        [testNumbersFor()]
      );
      const held = new Set(taken.map((r) => r.phone_e164));
      const free = testNumbersFor().filter((n) => !held.has(n));
      if (!free.length) {
        fail(409, 'no_free_number', 'Every +1 415 555 01xx number is in use. Retire a test account, or name another area code\'s 555 01xx number.');
      }
      number = free[crypto.randomInt(0, free.length)];
    }
    if (!signsInTo) {
      // A new account will count against the cap, so a live code does too.
      const { rows: [{ n }] } = await client.query(
        `SELECT (SELECT COUNT(*) FROM users
                  WHERE test_account_created_at IS NOT NULL AND anonymised_at IS NULL)
              + (SELECT COUNT(*) FROM test_phone_sign_ins
                  WHERE used_at IS NULL AND expires_at > NOW()) AS n`
      );
      if (Number(n) >= MAX_LIVE) {
        fail(429, 'at_capacity', `There are already ${n} live test accounts and unused sign-ins, the most allowed at once. `
          + 'Retire one you have finished with (list_test_accounts shows them), then try again.', { live: Number(n), max: MAX_LIVE });
      }
    }
    const { rows: [row] } = await client.query(
      `INSERT INTO test_phone_sign_ins (phone_e164, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(secs => $4))
       RETURNING id, expires_at`,
      [number, hash, actorId, PHONE_SIGN_IN_TTL_MS / 1000]
    );
    return { id: row.id, phoneNumber: number, expiresAt: row.expires_at, signsInTo };
  });

  log.info('test-accounts', 'Test phone sign-in minted', {
    id: minted.id, by: actorId, phone: `…${minted.phoneNumber.slice(-4)}`, existing: !!minted.signsInTo,
  });
  return {
    phoneNumber: minted.phoneNumber,
    code,
    expiresAt: new Date(minted.expiresAt).toISOString(),
    signsInTo: minted.signsInTo,
  };
}

/**
 * Spend the live code for `phoneNumber` if `code` is it. Every try counts,
 * right or wrong, and a code is gone after PHONE_SIGN_IN_TRIES. Returns
 * { id, createdBy } for the sign-in it spent, or null.
 */
async function redeemPhoneSignIn(pool, phoneNumber, code) {
  if (typeof phoneNumber !== 'string' || !/^[0-9]{6}$/.test(String(code || ''))) return null;
  const { rows } = await pool.query(
    `UPDATE test_phone_sign_ins SET attempts = attempts + 1
      WHERE phone_e164 = $1 AND used_at IS NULL AND expires_at > NOW() AND attempts < $2
      RETURNING id, code_hash, created_by`,
    [phoneNumber, PHONE_SIGN_IN_TRIES]
  );
  for (const row of rows) {
    if (!(await bcrypt.compare(String(code), row.code_hash))) continue;
    const { rows: spent } = await pool.query(
      'UPDATE test_phone_sign_ins SET used_at = NOW() WHERE id = $1 AND used_at IS NULL RETURNING id',
      [row.id]
    );
    if (spent.length) return { id: Number(row.id), createdBy: row.created_by == null ? null : Number(row.created_by) };
  }
  return null;
}

// ── Test release emails ─────────────────────────────────────────────────
//
// The waitlist's "you're in" mail (mail/templates.js waitlistReleased) and
// the sign-up its link starts are reached only from a released waitlist row,
// and the one way to get a mail sent used to be admitting a real person. Here
// a full admin sends that mail to an address they read (any address, or a
// fresh +test alias of their own when they name none) through the sender
// and throttle Admit uses, so the mail, its link and the sign-up after it are
// the real thing from the inbox on. Changing the mail and sending it again is
// one call.
//
// A send makes the address a waitlist row, confirmed and released like an
// admitted signup, and marks it in test_waitlist_releases, which keeps it out
// of Admin → Waitlist and the Journey's admitted cohorts. The NEW account the
// address then makes is a test account (waitlist.linkUserByEmail →
// adoptReleasedAccount below): marked before it is let in, so the welcome DM
// trigger and every other fence see a test account from the start; let in
// without manualRelease, as create() does; counted against MAX_LIVE once
// made; and retired like any other, which deletes the row with it. An address
// that belongs to a real account or a real signup is refused. A release no
// account used is withdrawn, row and all, RELEASE_TTL_DAYS after its last
// send, by the next send.

const RELEASE_TTL_DAYS = 7;

function parseRelease(body) {
  const b = body && typeof body === 'object' ? body : {};
  let email = null;
  if (b.email != null && String(b.email).trim() !== '') {
    email = waitlist.normalizeEmail(String(b.email));
    if (!email) fail(400, 'invalid_email', 'Enter a valid email address.', { field: 'email' });
  }
  return {
    email,
    welcomeDm: parseFlag(b.welcomeDm, false, 'welcomeDm'),
    note: parseNote(b.note),
  };
}

// you+test1a2b3c@example.com for the admin's own confirmed address: a new
// address every time, which the mail throttle (three a day per address)
// never meets twice, delivered to the admin's own inbox by any provider that
// honours a +tag.
async function ownTestAlias(pool, actorId) {
  const { rows: [me] } = await pool.query(
    'SELECT email, email_confirmed FROM users WHERE id = $1',
    [actorId]
  );
  const own = me && me.email_confirmed === true ? waitlist.normalizeEmail(me.email) : null;
  const at = own ? own.lastIndexOf('@') : -1;
  const alias = at > 0
    ? waitlist.normalizeEmail(`${own.slice(0, at).replace(/\+.*$/, '')}+test${crypto.randomBytes(3).toString('hex')}${own.slice(at)}`)
    : null;
  if (!alias) {
    fail(400, 'email_required', 'Name the address to send to: your account has no confirmed email to make a +test alias of.', { field: 'email' });
  }
  return alias;
}

/**
 * Send the waitlist's "you're in" mail to a test address as full admin
 * `actorId`. `body` is { email?, welcomeDm?, note? }. Returns { email,
 * signupId, hasAccount, signsInTo, welcomeDm, note, mail } where mail is the
 * delivery's own record ({ status, error }, mail_deliveries' vocabulary):
 * the send never throws, so this is the only way to know whether the mail
 * went out or the throttle held it back.
 */
async function sendRelease(pool, body, { actorId, config = {} } = {}) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0) fail(403, 'forbidden', 'A full administrator is required.');
  const input = parseRelease(body);
  const email = input.email || await ownTestAlias(pool, actorId);

  let release;
  try {
    release = await withTransaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [CAP_LOCK_KEY]);
      await client.query(
        `DELETE FROM waitlist_signups w USING test_waitlist_releases t
          WHERE t.signup_id = w.id AND w.linked_user_id IS NULL AND t.used_by IS NULL
            AND t.last_sent_at < NOW() - make_interval(days => $1)`,
        [RELEASE_TTL_DAYS]
      );
      // A real account first, so it is the one refused.
      const { rows: [account] } = await client.query(
        `SELECT id, username, has_platform_access,
                test_account_created_at IS NOT NULL AS test_account
           FROM users
          WHERE LOWER(email) = $1 AND anonymised_at IS NULL
          ORDER BY (test_account_created_at IS NULL) DESC, id
          LIMIT 1`,
        [email]
      );
      if (account && !account.test_account) {
        fail(409, 'real_account', 'That address belongs to a real account, so no test release goes to it. '
          + 'Use an address only you read, or leave email out for a +test alias of your own.', { field: 'email' });
      }
      const { rows: [signup] } = await client.query(
        `SELECT w.id, t.signup_id IS NOT NULL AS test_release
           FROM waitlist_signups w
           LEFT JOIN test_waitlist_releases t ON t.signup_id = w.id
          WHERE LOWER(w.email) = $1`,
        [email]
      );
      if (signup && !signup.test_release) {
        fail(409, 'real_signup', 'That address is on the waitlist as a real signup, so no test release goes to it. '
          + 'Use an address only you read, or leave email out for a +test alias of your own.', { field: 'email' });
      }
      if (!account) {
        // Its link makes a new test account, so that account needs a place.
        const { rows: [{ n }] } = await client.query(
          `SELECT COUNT(*)::int AS n FROM users
            WHERE test_account_created_at IS NOT NULL AND anonymised_at IS NULL`
        );
        if (n >= MAX_LIVE) {
          fail(429, 'at_capacity', `There are already ${n} live test accounts, the most allowed at once, and this email's link would make another. `
            + 'Retire one you have finished with (list_test_accounts shows them), then try again.', { live: n, max: MAX_LIVE });
        }
      }

      let row;
      if (signup) {
        ({ rows: [row] } = await client.query(
          `UPDATE waitlist_signups
              SET released_at = COALESCE(released_at, NOW()),
                  confirmed_at = COALESCE(confirmed_at, NOW()),
                  more_token = COALESCE(more_token, $2)
            WHERE id = $1
            RETURNING id, more_token`,
          [signup.id, crypto.randomBytes(24).toString('hex')]
        ));
        await client.query(
          `UPDATE test_waitlist_releases
              SET last_sent_at = NOW(), welcome_dm = $2, note = COALESCE($3, note)
            WHERE signup_id = $1`,
          [row.id, input.welcomeDm, input.note || null]
        );
      } else {
        // Confirmed and released, the state of a signup an admin admits.
        // more_token is the capability the mail's link carries, as Admit's.
        ({ rows: [row] } = await client.query(
          `INSERT INTO waitlist_signups (email, confirmed_at, released_at, more_token)
           VALUES ($1, NOW(), NOW(), $2)
           RETURNING id, more_token`,
          [email, crypto.randomBytes(24).toString('hex')]
        ));
        await client.query(
          `INSERT INTO test_waitlist_releases (signup_id, created_by, welcome_dm, note)
           VALUES ($1, $2, $3, $4)`,
          [row.id, actorId, input.welcomeDm, input.note || null]
        );
      }
      if (account) {
        // The address already has a live test account: the mail is the
        // "sign in" one, and the release lets the account in if it waits.
        await client.query('UPDATE waitlist_signups SET linked_user_id = $2 WHERE id = $1', [row.id, account.id]);
        await client.query('UPDATE test_waitlist_releases SET used_by = $2 WHERE signup_id = $1', [row.id, account.id]);
        if (!account.has_platform_access) await waitlist.grantPlatformAccess(client, account.id);
      }
      return { signupId: Number(row.id), moreToken: row.more_token, account: account || null };
    });
  } catch (err) {
    if (err instanceof TestAccountError) throw err;
    // A join for the same address landed between the read and the insert.
    if (err && err.code === '23505') {
      fail(409, 'real_signup', 'That address joined the waitlist just now, so no test release goes to it.', { field: 'email' });
    }
    throw err;
  }

  // The mail Admit sends (routes/topochain/admin/waitlist.js sendReleaseMail),
  // with its store-listing steps and, for an address with no account yet,
  // its one-time sign-in link (services/release-links.js), freshly minted
  // so the newest mail's link is the one that works. A failed lookup or
  // mint drops only that part: the link still prefills the address and
  // sends a code.
  const mobile = await require('./mobile-store-links').loadMobileAppUrls(pool).catch((err) => {
    log.warn('test-accounts', 'Release mail mobile links failed', { message: err.message });
    return null;
  });
  let signInToken = null;
  if (!release.account) {
    signInToken = await require('./release-links').mint(pool, { signupId: release.signupId, email }).catch((err) => {
      log.error('test-accounts', 'Release sign-in link not minted', { signupId: release.signupId, message: err.message });
      return null;
    });
  }
  const { rows: [{ at }] } = await pool.query('SELECT clock_timestamp() AS at');
  await require('./mail').sendWaitlistReleaseMail(config, email, {
    mobile,
    hasAccount: !!release.account,
    signInToken,
    moreToken: release.moreToken || null,
  });
  const { rows: [delivery] } = await pool.query(
    `SELECT status, error FROM mail_deliveries
      WHERE recipient = $1 AND kind = 'waitlist_released' AND created_at >= $2
      ORDER BY id DESC
      LIMIT 1`,
    [email, at]
  );

  log.info('test-accounts', 'Test release email sent', {
    signupId: release.signupId, by: actorId, existing: !!release.account,
    status: delivery ? delivery.status : null,
  });
  return {
    email,
    signupId: release.signupId,
    hasAccount: !!release.account,
    signsInTo: release.account ? release.account.username : null,
    welcomeDm: input.welcomeDm,
    note: input.note || null,
    mail: delivery
      ? { status: String(delivery.status), error: delivery.error ? String(delivery.error) : null }
      : { status: 'unknown', error: null },
  };
}

/**
 * The test releases no account has used yet, newest send first, each with
 * when it is withdrawn if nobody signs up from it.
 */
async function listReleases(pool) {
  const { rows } = await pool.query(
    `SELECT w.id, w.email, t.created_at, t.last_sent_at, t.note, c.username AS created_by,
            t.last_sent_at + make_interval(days => $1) AS expires_at
       FROM test_waitlist_releases t
       JOIN waitlist_signups w ON w.id = t.signup_id
       LEFT JOIN users c ON c.id = t.created_by
      WHERE t.used_by IS NULL AND w.linked_user_id IS NULL
      ORDER BY t.last_sent_at DESC, w.id DESC`,
    [RELEASE_TTL_DAYS]
  );
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  return rows.map((r) => ({
    signupId: Number(r.id),
    email: r.email,
    createdBy: r.created_by || null,
    createdAt: iso(r.created_at),
    lastSentAt: iso(r.last_sent_at),
    expiresAt: iso(r.expires_at),
    note: r.note || null,
  }));
}

/**
 * Make `userId`, the NEW account a test release's address just made, a test
 * account and let it in: waitlist.linkUserByEmail calls this, and only for
 * an account the sign-up created. One transaction, marked before the grant,
 * so the welcome DM trigger (test_account_welcome_dm) and every other fence
 * already see a test account when access arrives. Returns true when it let
 * the account in.
 */
async function adoptReleasedAccount(pool, { userId, signupId }) {
  const letIn = await withTransaction(pool, async (client) => {
    const { rows: [release] } = await client.query(
      `UPDATE test_waitlist_releases SET used_by = $2
        WHERE signup_id = $1
        RETURNING created_by, welcome_dm, note`,
      [signupId, userId]
    );
    if (!release) return false;
    await client.query(
      `UPDATE users
          SET test_account_created_at = COALESCE(test_account_created_at, NOW()),
              test_account_created_by = COALESCE(test_account_created_by, $2),
              test_account_welcome_dm = $3,
              exclude_podium = TRUE, updated_at = NOW()
        WHERE id = $1`,
      [userId, release.created_by, release.welcome_dm]
    );
    await journeyLeftOut.addTestInTransaction(client, {
      userId, note: release.note || 'Test release email (send_test_release_email)',
    }, { actorId: release.created_by });
    await client.query(
      `INSERT INTO support_actions (actor_user_id, target_user_id, action, reason, payload)
       VALUES ($1, $2, 'test_account_create', $3, $4::jsonb)`,
      [release.created_by, userId, release.note || null, JSON.stringify({ via: 'test_release', signupId: Number(signupId) })]
    );
    // Not a release by hand: no invite generation 0, as create() lets in.
    return waitlist.grantPlatformAccess(client, userId);
  });
  journeyLeftOut.forget(pool);
  return letIn;
}

module.exports = {
  MAX_LIVE,
  NOTE_MAX,
  RETIRE_CONFIRMATION,
  PHONE_SIGN_IN_TTL_MS,
  PHONE_SIGN_IN_TRIES,
  RELEASE_TTL_DAYS,
  TestAccountError,
  create,
  list,
  retire,
  generatePassword,
  onFirstRun,
  mintPhoneSignIn,
  redeemPhoneSignIn,
  sendRelease,
  listReleases,
  adoptReleasedAccount,
};
