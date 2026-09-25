// Topochain v4 admin API — D2 users (SPEC 2271-2405, v1 `/admin/
// participants`; Task 11). Every mutating route is gated by
// `adminWriteGate`; reads are covered by the router-wide `adminReadGate`
// applied in ../admin.js.
//
// Judgment call: the source's `participants` table doesn't exist here —
// Global Constraints #7 folds every topochain user into the platform's
// own `users` table, which is ALSO the login table (`username` NOT NULL
// UNIQUE, `password` NOT NULL). An admin-created "user" via POST here (or
// a CSV-imported one) has no platform login of their own, so both
// columns need a value that satisfies the constraints without granting a
// usable account: `password` gets a random, nobody-knows-it bcrypt hash
// (the same trick the web email-signup flow uses); `username` gets an
// opaque `topochain_<hex>` token rather than reusing `email` the way
// email-signup.js does, so an admin-entered email can never collide with —
// or silently double as — a real platform login username.
'use strict';

const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getPool } = require('../../../db/pool');
const log = require('../../../services/logger');
const { computeOwnStanding } = require('../../../services/topochain/standings');
const { adminWriteGate } = require('./auth');
const managedOpenRouter = require('../../../services/openrouter-managed-keys');
const { toIntId, toBool } = require('./util');
const {
  ok, fail, iso, paginate, meta, csvField, ValidationError,
} = require('../helpers');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Cost factor for the synthetic "unusable" password hash (see the
// top-of-file comment). A real user password uses this repo's normal
// bcrypt cost (12, src/middleware/auth.js) because it protects a secret
// someone might actually try to crack; this hash protects nothing —
// `password_set = FALSE` on every row that gets one blocks any login
// attempt outright (the platform login path checks it BEFORE
// ever comparing a password), so the value only needs to exist to
// satisfy the NOT NULL column. A low cost keeps `import-csv` (which can
// mint many of these per call, inside one transaction — see its own
// comment) from holding a write transaction open for a non-trivial
// amount of wall-clock time on a large batch (code-review finding).
const UNUSABLE_PASSWORD_BCRYPT_COST = 4;

// The pre-INSERT/pre-UPDATE `SELECT id FROM users WHERE lower(email) =
// lower($1)` check (both create and update) is a plain read, not a lock —
// a genuinely concurrent request for the SAME email can still slip past
// it and hit `users_email_lower_unique` (schema.sql) at write time
// (code-review finding). Rather than SELECT ... FOR UPDATE-ing an
// unrelated caller's row (a worse trade-off than the rare race itself),
// the write's own unique-violation is caught and mapped to the same 422
// the pre-check produces — defense in depth, not a replacement for the
// pre-check (which still gives the common case a clean 422 without ever
// reaching the DB write). Matches BOTH constraint names: a database that
// hasn't rebooted onto the lower(email) index yet (or where a legacy
// case-variant duplicate blocked its creation) still raises on the old
// raw-column `users_email_unique`.
function isEmailUniqueViolation(err) {
  return err && err.code === '23505' && typeof err.constraint === 'string'
    && (err.constraint.includes('users_email_lower_unique') || err.constraint.includes('users_email_unique'));
}

// ─── Row shaping ────────────────────────────────────────────────────────

// The columns this endpoint group exposes off the shared `users` table —
// deliberately excludes login/secret columns (`password`, `is_admin`,
// `admin_readonly`, `anthropic_key_*`, `wallet_link_*`, session-adjacent
// fields) that have nothing to do with the topochain user profile.
const USER_COLUMNS = [
  'id', 'username', 'email', 'telegram', 'discord', 'display_name', 'exclude_podium',
  'accept_logs', 'github', 'x', 'country', 'city', 'referrer', 'referrer_handle',
  'is_in_waitlist', 'created_at', 'updated_at',
];
const USER_SELECT = USER_COLUMNS.join(', ');
const USER_SELECT_QUALIFIED = USER_COLUMNS.map((c) => `u.${c}`).join(', ');

function formatUser(row, { events = [], onchainAccounts = [], globalLeaderboard } = {}) {
  const out = {
    id: Number(row.id),
    username: row.username,
    email: row.email,
    telegram: row.telegram,
    discord: row.discord,
    display_name: row.display_name,
    exclude_podium: row.exclude_podium,
    accept_logs: row.accept_logs,
    github: row.github,
    x: row.x,
    country: row.country,
    city: row.city,
    referrer: row.referrer,
    referrer_handle: row.referrer_handle,
    is_in_waitlist: row.is_in_waitlist,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    events,
    onchain_accounts: onchainAccounts,
  };
  // Only GET /:id populates this (SPEC 2334); omitted everywhere else
  // rather than sent as null, matching helpers.js's own omit-when-absent
  // convention for optional keys.
  if (globalLeaderboard !== undefined) out.global_leaderboard = globalLeaderboard;
  return out;
}

function formatEventPivot(r) {
  return { id: Number(r.event_id), name: r.event_name, pivot: { registered_at: iso(r.registered_at) } };
}

// One shape covering both of the source's inconsistent branches (SPEC
// 2295's ⚠ note — id/registration_code/amount/address from the "with
// event_id" branch, id/user_id/event_id/address/tier/is_used from the
// show endpoint) — a superset, so no caller loses a field it used to get.
function formatAccount(r) {
  return {
    id: Number(r.id),
    season_event_id: r.season_event_id != null ? Number(r.season_event_id) : null,
    registration_code: r.registration_code,
    amount: Number(r.amount),
    address: r.address,
    tier: r.tier,
    is_used: r.is_used,
  };
}

// Batch-loads events + onchain_accounts for a set of user ids in two
// queries total, regardless of how many users are being formatted — the
// v4 fix for the source's N+1 per-row account lookup (SPEC 2295's note).
// Season-wide enrollments (season_event_id IS NULL) are NOT surfaced in
// the `events` array: there is no single event to name for them (mirrors
// the source pivot table, which only ever linked a user to one specific
// phase at a time).
async function loadRelations(pool, userIds) {
  const eventsByUser = new Map();
  const accountsByUser = new Map();
  if (!userIds.length) return { eventsByUser, accountsByUser };

  const { rows: eventRows } = await pool.query(
    `SELECT ue.user_id, se.id AS event_id, se.name AS event_name, ue.registered_at
       FROM user_enrollments ue
       JOIN season_events se ON se.id = ue.season_event_id
      WHERE ue.user_id = ANY($1) AND ue.season_event_id IS NOT NULL
      ORDER BY ue.registered_at ASC, se.id ASC`,
    [userIds]
  );
  for (const r of eventRows) {
    const uid = Number(r.user_id);
    if (!eventsByUser.has(uid)) eventsByUser.set(uid, []);
    eventsByUser.get(uid).push(formatEventPivot(r));
  }

  const { rows: acctRows } = await pool.query(
    `SELECT id, user_id, season_event_id, registration_code, amount, address, tier, is_used
       FROM onchain_accounts WHERE user_id = ANY($1) ORDER BY id ASC`,
    [userIds]
  );
  for (const r of acctRows) {
    const uid = Number(r.user_id);
    if (!accountsByUser.has(uid)) accountsByUser.set(uid, []);
    accountsByUser.get(uid).push(formatAccount(r));
  }

  return { eventsByUser, accountsByUser };
}

// ─── Field parsing (shared by create + update) ─────────────────────────
//
// Returns `fields`, containing a key ONLY for what `body` actually sent
// (present-with-null included) — callers use `'key' in fields` to tell
// "omitted" from "explicitly cleared", which is exactly the distinction
// update needs (SPEC 2344's ⚠ + the v4 fix) and create doesn't care about
// (omitted and explicit null both just mean "no value" on a fresh row).
function parseUserFields(body, details) {
  const fields = {};

  for (const key of ['email', 'telegram', 'discord', 'display_name']) {
    if (body[key] === undefined) continue;
    if (body[key] === null) { fields[key] = null; continue; }
    if (typeof body[key] !== 'string' || body[key].length === 0 || body[key].length > 255) {
      details[key] = [`The ${key} field must be a string of at most 255 characters.`];
      continue;
    }
    if (key === 'email' && !EMAIL_RE.test(body[key].trim())) {
      details.email = ['The email field must be a valid email address.'];
      continue;
    }
    // Emails are stored in normalized lower-case form everywhere (the
    // web email-signup flow already does this — email-signup.js's
    // validateEmailField), so login and the uniqueness checks can match
    // case-insensitively (issue #1269).
    fields[key] = key === 'email' ? body[key].trim().toLowerCase() : body[key];
  }

  if (body.accept_logs !== undefined) {
    const b = toBool(body.accept_logs);
    if (b === undefined) details.accept_logs = ['The accept_logs field must be a boolean.'];
    else fields.accept_logs = b;
  }

  // v4 rename: source `phase_ids` -> `season_event_ids` (Global
  // Constraints #10). Replaces the WHOLE event-scoped enrollment set —
  // handled by the route itself, not here, since it needs a DB
  // round-trip to validate each id.
  if (body.season_event_ids !== undefined) {
    if (!Array.isArray(body.season_event_ids)) {
      details.season_event_ids = ['The season_event_ids field must be an array.'];
    } else {
      const ids = body.season_event_ids.map((v) => toIntId(v));
      if (ids.some((v) => !v)) {
        details.season_event_ids = ['Each season_event_ids entry must be a valid id.'];
      } else {
        fields.season_event_ids = [...new Set(ids)];
      }
    }
  }

  return fields;
}

function usersAdminRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // ── GET /api/v4/admin/users (SPEC 2273-2296) ─────────────────────────
  //
  // THE FIX (SPEC 2295's ⚠ two-shapes note): one consistent response
  // shape regardless of whether `season_event_id` is given — it only
  // changes WHICH users are included (enrolled in that event/season),
  // never the shape of each row.
  router.get('/api/v4/admin/users', async (req, res) => {
    try {
      const { page, perPage } = paginate(req, { defaultPerPage: 200 }); // SPEC 2277
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

      let seasonEventId = null;
      let eventSeasonId = null;
      if (req.query.season_event_id !== undefined) {
        seasonEventId = toIntId(req.query.season_event_id);
        if (!seasonEventId) return fail(res, 404, 'Event not found.');
        const { rows } = await pool.query('SELECT season_id FROM season_events WHERE id = $1', [seasonEventId]);
        if (!rows.length) return fail(res, 404, 'Event not found.');
        eventSeasonId = rows[0].season_id;
      }

      const params = [];
      let joinClause = '';
      if (seasonEventId) {
        params.push(seasonEventId, eventSeasonId);
        joinClause = `JOIN user_enrollments ue_filter ON ue_filter.user_id = u.id
                        AND (ue_filter.season_event_id = $${params.length - 1}
                             OR (ue_filter.season_event_id IS NULL AND ue_filter.season_id = $${params.length}))`;
      }
      let whereClause = '';
      if (search) {
        params.push(`%${search}%`);
        whereClause = `WHERE (u.email ILIKE $${params.length} OR u.telegram ILIKE $${params.length}
                              OR u.discord ILIKE $${params.length} OR u.display_name ILIKE $${params.length})`;
      }

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(DISTINCT u.id)::int AS c FROM users u ${joinClause} ${whereClause}`,
        params
      );
      const total = countRows[0].c;

      const dataParams = [...params, perPage, (page - 1) * perPage];
      const { rows } = await pool.query(
        `SELECT DISTINCT ${USER_SELECT_QUALIFIED}
           FROM users u ${joinClause} ${whereClause}
          ORDER BY u.id DESC
          LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
        dataParams
      );

      const ids = rows.map((r) => Number(r.id));
      const { eventsByUser, accountsByUser } = await loadRelations(pool, ids);
      const data = rows.map((r) => formatUser(r, {
        events: eventsByUser.get(Number(r.id)) || [],
        onchainAccounts: accountsByUser.get(Number(r.id)) || [],
      }));

      return ok(res, { data }, { meta: meta(page, perPage, total) });
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(res, err.status, err.message, { details: err.details, code: err.code });
      }
      log.error('topochain-admin', 'GET /admin/users failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── POST /api/v4/admin/users (SPEC 2298-2317) ────────────────────────
  router.post('/api/v4/admin/users', adminWriteGate, async (req, res) => {
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const details = {};
      const fields = parseUserFields(body, details);
      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const email = fields.email ?? null;
      const telegram = fields.telegram ?? null;
      const discord = fields.discord ?? null;
      const displayName = fields.display_name ?? null;
      const acceptLogs = fields.accept_logs ?? true;
      const seasonEventIds = fields.season_event_ids ?? [];

      if (!email && !telegram && !discord) {
        return fail(res, 422, 'At least one identifier (email, telegram, or discord) is required.');
      }

      // v4 addition (§8.3): unique email, post-dedupe — the source has no
      // uniqueness check at all here (SPEC 2317's note).
      if (email) {
        const { rows } = await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
        if (rows.length) {
          return fail(res, 422, 'The email has already been taken.', {
            details: { email: ['The email has already been taken.'] },
          });
        }
      }

      let eventRows = [];
      if (seasonEventIds.length) {
        const { rows } = await client.query('SELECT id, season_id FROM season_events WHERE id = ANY($1)', [seasonEventIds]);
        if (rows.length !== seasonEventIds.length) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_event_ids: ['One or more selected season_event_ids are invalid.'] },
          });
        }
        // GUARD (code-review finding): `user_enrollments.season_id` is
        // NOT NULL but `season_events.season_id` is nullable — an event
        // with no season can't be enrolled into under this schema (there
        // is no season_id to denormalize onto the enrollment row), so
        // this rejects with a clear 422 instead of letting the INSERT
        // below hit the NOT NULL constraint and 500.
        if (rows.some((r) => r.season_id == null)) {
          return fail(res, 422, 'The given data was invalid.', {
            details: { season_event_ids: ['One or more selected season_event_ids belong to no season and cannot be enrolled into.'] },
          });
        }
        eventRows = rows;
      }

      const username = `topochain_${crypto.randomBytes(12).toString('hex')}`;
      const unusablePasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), UNUSABLE_PASSWORD_BCRYPT_COST);

      await client.query('BEGIN');
      try {
        const { rows: insertRows } = await client.query(
          `INSERT INTO users (username, password, password_set, email, telegram, discord, display_name, accept_logs, is_admin, created_at, updated_at)
           VALUES ($1, $2, FALSE, $3, $4, $5, $6, $7, FALSE, NOW(), NOW())
           RETURNING ${USER_SELECT}`,
          [username, unusablePasswordHash, email, telegram, discord, displayName, acceptLogs]
        );
        const user = insertRows[0];

        for (const ev of eventRows) {
          await client.query(
            `INSERT INTO user_enrollments (season_event_id, user_id, season_id, registered_at, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW(), NOW()) ON CONFLICT DO NOTHING`,
            [ev.id, user.id, ev.season_id]
          );
        }
        await client.query('COMMIT');

        // #2568: an admin-created account gets its included OpenRouter key
        // like any other, once its row has committed. Best effort by
        // construction — ensureIncludedKey never throws — so creating the
        // account cannot fail because OpenRouter's management API did.
        // The BULK IMPORT below deliberately does NOT do this: those rows
        // are enrollment records for people who have not signed up, and a
        // company-funded key per imported row is not what that spreadsheet
        // asked for. Anyone who does sign in gets one from the lazy path in
        // GET /api/me/coding-agent.
        await managedOpenRouter.ensureIncludedKey({
          pool, userId: user.id, config, reason: 'admin_created',
        });

        const { eventsByUser } = await loadRelations(pool, [user.id]);
        return res.status(201).json({
          success: true,
          data: formatUser(user, { events: eventsByUser.get(Number(user.id)) || [] }),
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    } catch (err) {
      if (isEmailUniqueViolation(err)) {
        return fail(res, 422, 'The email has already been taken.', {
          details: { email: ['The email has already been taken.'] },
        });
      }
      log.error('topochain-admin', 'POST /admin/users failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    } finally {
      client.release();
    }
  });

  // ── POST /api/v4/admin/users/import-csv (SPEC 2361-2394) ─────────────
  // Registered ahead of GET/PUT/DELETE /:id (same segment shape as a
  // path param) purely for defensive clarity — see the D3 file for where
  // this ordering is load-bearing.
  router.post('/api/v4/admin/users/import-csv', adminWriteGate, async (req, res) => {
    const client = await pool.connect();
    try {
      const body = req.body || {};
      const details = {};

      const seasonEventId = toIntId(body.season_event_id);
      if (!seasonEventId) details.season_event_id = ['The season_event_id field is required.'];

      const participants = Array.isArray(body.participants) ? body.participants : null;
      if (!participants || participants.length === 0) {
        details.participants = ['The participants field is required and must have at least 1 item.'];
      }

      let linkAccounts = false;
      if (body.link_accounts !== undefined) {
        const b = toBool(body.link_accounts);
        if (b === undefined) details.link_accounts = ['The link_accounts field must be a boolean.'];
        else linkAccounts = b;
      }

      let minBalance = null;
      let maxBalance = null;
      if (body.min_balance !== undefined && body.min_balance !== null) {
        const n = Number(body.min_balance);
        if (!Number.isInteger(n) || n < 0) details.min_balance = ['The min_balance field must be an integer >= 0.'];
        else minBalance = n;
      }
      if (body.max_balance !== undefined && body.max_balance !== null) {
        const n = Number(body.max_balance);
        if (!Number.isInteger(n) || n < 0) details.max_balance = ['The max_balance field must be an integer >= 0.'];
        else maxBalance = n;
      }

      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const { rows: eventRows } = await client.query('SELECT id, season_id FROM season_events WHERE id = $1', [seasonEventId]);
      const event = eventRows[0];
      if (!event) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_event_id: ['The selected season_event_id is invalid.'] },
        });
      }
      // GUARD (code-review finding): same NOT NULL mismatch as create/
      // update — an event with no season has no season_id to denormalize
      // onto the user_enrollments rows this import would create.
      if (event.season_id == null) {
        return fail(res, 422, 'The given data was invalid.', {
          details: { season_event_id: ['The selected season_event_id belongs to no season and cannot be imported into.'] },
        });
      }

      // Unused accounts, highest-balance-first (SPEC 2390's "link_accounts
      // assigns unused accounts highest-balance-first"). The queue is the
      // SEASON pool (season-scoped rows, `season_event_id IS NULL`) — the
      // same pool wallet/provision claims from — not the event's legacy
      // rows: accounts are 0..1 per (user, season) now
      // (`onchain_accounts_user_season_unique`), while enrollment below
      // stays event-scoped as the participation record.
      // Fetched once, consumed in order as rows are processed below —
      // NOT re-queried per row (that would be the source's N+1 shape).
      let accountQueue = [];
      if (linkAccounts) {
        const boundParams = [event.season_id];
        let boundClause = '';
        if (minBalance != null) { boundParams.push(minBalance); boundClause += ` AND amount >= $${boundParams.length}`; }
        if (maxBalance != null) { boundParams.push(maxBalance); boundClause += ` AND amount <= $${boundParams.length}`; }
        const { rows } = await client.query(
          `SELECT id, amount FROM onchain_accounts
            WHERE season_id = $1 AND season_event_id IS NULL
              AND user_id IS NULL AND is_used = FALSE ${boundClause}
            ORDER BY amount DESC, id ASC`,
          boundParams
        );
        accountQueue = rows;
      }

      const counters = {
        created_count: 0, linked_count: 0, unassigned_count: 0,
        skipped_count: 0, added_to_phase_count: 0, already_in_phase_count: 0,
        already_linked_count: 0,
      };
      const errors = [];

      // THE FIX (SPEC 2394's ⚠ "no transaction" note): the whole import
      // runs inside one BEGIN/COMMIT — a mid-import DB failure rolls back
      // every row this call touched, never leaving partial data. A
      // per-ROW validation failure (bad email/username) is NOT a DB
      // failure — it's caught inline, recorded in `errors`, and the loop
      // continues within the SAME transaction.
      await client.query('BEGIN');
      try {
        let queueIndex = 0;
        for (let i = 0; i < participants.length; i++) {
          const row = participants[i] || {};
          const rowNum = i + 1;
          // Lower-cased like every other email write path (issue #1269).
          const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
          const username = typeof row.username === 'string' ? row.username.trim() : '';

          if (!email || !EMAIL_RE.test(email)) {
            errors.push(`Row ${rowNum}: email is required and must be a valid email address.`);
            counters.skipped_count += 1;
            continue;
          }
          if (!username) {
            errors.push(`Row ${rowNum}: username is required.`);
            counters.skipped_count += 1;
            continue;
          }

          // Matched by email OR username (mapped to `discord` per SPEC
          // 2361's column mapping) — an existing user is enrolled, never
          // duplicated (SPEC 2390's note).
          const { rows: userRows } = await client.query(
            'SELECT id FROM users WHERE lower(email) = lower($1) OR discord = $2 LIMIT 1',
            [email, username]
          );
          let userId;
          if (userRows.length) {
            userId = userRows[0].id;
          } else {
            const loginName = `topochain_${crypto.randomBytes(12).toString('hex')}`;
            const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), UNUSABLE_PASSWORD_BCRYPT_COST);
            const { rows: createdRows } = await client.query(
              `INSERT INTO users (username, password, password_set, email, discord, is_admin, created_at, updated_at)
               VALUES ($1, $2, FALSE, $3, $4, FALSE, NOW(), NOW()) RETURNING id`,
              [loginName, passwordHash, email, username]
            );
            userId = createdRows[0].id;
            counters.created_count += 1;
          }

          const { rows: enrollRows } = await client.query(
            `SELECT id FROM user_enrollments
              WHERE user_id = $1 AND (season_event_id = $2 OR (season_event_id IS NULL AND season_id = $3))`,
            [userId, seasonEventId, event.season_id]
          );
          if (enrollRows.length) {
            counters.already_in_phase_count += 1;
          } else {
            await client.query(
              `INSERT INTO user_enrollments (season_event_id, user_id, season_id, registered_at, created_at, updated_at)
               VALUES ($1, $2, $3, NOW(), NOW(), NOW())`,
              [seasonEventId, userId, event.season_id]
            );
            counters.added_to_phase_count += 1;
          }

          if (linkAccounts) {
            // GUARD: a user who already holds ANY account in this season —
            // season-scoped or a legacy event-scoped row — is never linked
            // a second one. Double-linking is exactly what produced the
            // historical multi-account users the per-season unique now
            // forbids, and for legacy rows the DB index can't backstop us.
            const { rows: ownedRows } = await client.query(
              'SELECT 1 FROM onchain_accounts WHERE user_id = $1 AND season_id = $2 LIMIT 1',
              [userId, event.season_id]
            );
            if (ownedRows.length) {
              counters.already_linked_count += 1;
              continue;
            }
            const account = accountQueue[queueIndex];
            if (account) {
              queueIndex += 1;
              await client.query(
                `UPDATE onchain_accounts SET user_id = $1, is_used = TRUE, used_at = NOW(), updated_at = NOW() WHERE id = $2`,
                [userId, account.id]
              );
              counters.linked_count += 1;
            } else {
              // THE FIX (SPEC 2394's ⚠ "unassigned_count can go negative"
              // note): counted by directly incrementing once per row that
              // wanted an account and didn't get one, so this can never
              // go negative — unlike a source-style `pool_size -
              // linked_count` subtraction that assumed every row wanted
              // one and could under/over-count.
              counters.unassigned_count += 1;
            }
          }
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }

      return ok(res, {
        data: { ...counters, errors },
        message: `Import completed. Created ${counters.created_count}, linked ${counters.linked_count}, `
          + `added ${counters.added_to_phase_count} to the event.`,
      });
    } catch (err) {
      log.error('topochain-admin', 'POST /admin/users/import-csv failed', { message: err.message });
      return fail(res, 500, 'Import failed.');
    } finally {
      client.release();
    }
  });

  // ── GET /api/v4/admin/users/export-csv/:seasonEventId (SPEC 2396-2405) ─
  //
  // `adminWriteGate` on a GET (security-review finding): SPEC says only
  // "Auth: admin", but this endpoint streams every enrolled user's email
  // AND registration_code out of the system as a file — the same "can
  // this admin walk away with the data" reasoning that already puts
  // /api/v4/admin/database/export behind the write gate (see db-tools.js's
  // PRIVILEGE LEVEL comment). A view-only admin can read the same fields
  // in the paginated JSON UI, but a bulk downloadable artifact is a
  // different exposure class; full admins only, consistently.
  router.get('/api/v4/admin/users/export-csv/:seasonEventId', adminWriteGate, async (req, res) => {
    try {
      const seasonEventId = toIntId(req.params.seasonEventId);
      if (!seasonEventId) return fail(res, 404, 'Event not found.');

      const { rows: eventRows } = await pool.query('SELECT id, season_id FROM season_events WHERE id = $1', [seasonEventId]);
      const event = eventRows[0];
      if (!event) return fail(res, 404, 'Event not found.');

      const { rows } = await pool.query(
        `WITH enrolled AS (
           SELECT DISTINCT user_id FROM user_enrollments
            WHERE season_event_id = $1 OR (season_event_id IS NULL AND season_id = $2)
         )
         SELECT u.email, u.discord AS username, acct.registration_code
           FROM enrolled e
           JOIN users u ON u.id = e.user_id
           LEFT JOIN LATERAL (
             SELECT registration_code FROM onchain_accounts oa
              WHERE oa.user_id = u.id AND (oa.season_event_id = $1 OR (oa.season_event_id IS NULL AND oa.season_id = $2))
              ORDER BY (oa.season_event_id IS NULL) ASC, oa.id DESC LIMIT 1
           ) acct ON TRUE
          ORDER BY u.id ASC`,
        [seasonEventId, event.season_id]
      );

      res.status(200);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="season-event-${seasonEventId}-users.csv"`);
      // Written line-by-line rather than buffered into one string first
      // (SPEC 2405's note: v4 should stream, not buffer the whole file).
      res.write('email,username,code\n');
      for (const r of rows) {
        res.write(`${csvField(r.email)},${csvField(r.username)},${csvField(r.registration_code || '')}\n`);
      }
      return res.end();
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/users/export-csv failed', { message: err.message });
      if (!res.headersSent) return fail(res, 500, 'Internal server error.');
      return res.end();
    }
  });

  // ── GET /api/v4/admin/users/:id (SPEC 2319-2334) ─────────────────────
  router.get('/api/v4/admin/users/:id', async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'User not found.');

      const { rows } = await pool.query(`SELECT ${USER_SELECT} FROM users WHERE id = $1`, [id]);
      const user = rows[0];
      if (!user) return fail(res, 404, 'User not found.');

      const { eventsByUser, accountsByUser } = await loadRelations(pool, [id]);

      // `global_leaderboard` (SPEC 2334): the source's season-less row,
      // or null. There's no global_leaderboard TABLE in this schema
      // (Global Constraints — all-time standings are always derived), so
      // this reads the same shared §4.10 aggregate every other all-time
      // view is built on (services/topochain/standings.js), scoped to one
      // user: computeOwnStanding ranks in SQL and returns only this row,
      // rather than materialising every participant to `.find()` one.
      // The admin Support section (routes/admin-support.js) reads the
      // same function, so the two screens can never disagree on rank.
      const { own } = await computeOwnStanding(pool, { seasonId: null, userId: id });
      const globalLeaderboard = own ? {
        rank: own.rank,
        total_points: own.total_points,
        extra_points: own.extra_points,
        events_participated: own.events_participated,
        total_produced_blocks: own.total_produced_blocks,
      } : null;

      return ok(res, {
        data: formatUser(user, {
          events: eventsByUser.get(id) || [],
          onchainAccounts: accountsByUser.get(id) || [],
          globalLeaderboard,
        }),
      });
    } catch (err) {
      log.error('topochain-admin', 'GET /admin/users/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // ── PUT|PATCH /api/v4/admin/users/:id (SPEC 2336-2346) ───────────────
  //
  // THE FIXES (SPEC 2346's ⚠, §4.8 rule 7): identifiers ARE clearable
  // with an explicit `null` (source: an omitted OR null value both keep
  // the existing one — nothing is ever clearable); the "at least one
  // identifier" rule from create IS enforced here too (source: not
  // enforced at all on update).
  async function updateUser(req, res) {
    const id = toIntId(req.params.id);
    if (!id) return fail(res, 404, 'User not found.');

    const client = await pool.connect();
    try {
      const { rows: existingRows } = await client.query(`SELECT ${USER_SELECT} FROM users WHERE id = $1`, [id]);
      const existing = existingRows[0];
      if (!existing) return fail(res, 404, 'User not found.');

      const body = req.body || {};
      const details = {};
      const fields = parseUserFields(body, details);
      if (Object.keys(details).length) return fail(res, 422, 'The given data was invalid.', { details });

      const effectiveEmail = 'email' in fields ? fields.email : existing.email;
      const effectiveTelegram = 'telegram' in fields ? fields.telegram : existing.telegram;
      const effectiveDiscord = 'discord' in fields ? fields.discord : existing.discord;
      if (!effectiveEmail && !effectiveTelegram && !effectiveDiscord) {
        return fail(res, 422, 'At least one identifier (email, telegram, or discord) is required.');
      }

      if ('email' in fields && fields.email && fields.email !== existing.email) {
        const { rows } = await client.query('SELECT id FROM users WHERE lower(email) = lower($1) AND id != $2', [fields.email, id]);
        if (rows.length) {
          return fail(res, 422, 'The email has already been taken.', {
            details: { email: ['The email has already been taken.'] },
          });
        }
      }

      let eventRows = null;
      if ('season_event_ids' in fields) {
        const ids = fields.season_event_ids;
        if (ids.length) {
          const { rows } = await client.query('SELECT id, season_id FROM season_events WHERE id = ANY($1)', [ids]);
          if (rows.length !== ids.length) {
            return fail(res, 422, 'The given data was invalid.', {
              details: { season_event_ids: ['One or more selected season_event_ids are invalid.'] },
            });
          }
          // GUARD (code-review finding) — same NOT NULL mismatch as create.
          if (rows.some((r) => r.season_id == null)) {
            return fail(res, 422, 'The given data was invalid.', {
              details: { season_event_ids: ['One or more selected season_event_ids belong to no season and cannot be enrolled into.'] },
            });
          }
          eventRows = rows;
        } else {
          eventRows = [];
        }
      }

      const userColumnKeys = ['email', 'telegram', 'discord', 'display_name', 'accept_logs'].filter((k) => k in fields);

      await client.query('BEGIN');
      try {
        if (userColumnKeys.length) {
          const setClauses = userColumnKeys.map((col, i) => `${col} = $${i + 2}`);
          const values = userColumnKeys.map((col) => fields[col]);
          await client.query(
            `UPDATE users SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1`,
            [id, ...values]
          );
        }

        // `season_event_ids` REPLACES the whole event-scoped enrollment
        // set (SPEC 2344: "detaching omitted events") — season-wide
        // (season_event_id IS NULL) enrollments are untouched; this only
        // ever manages the per-event rows.
        if (eventRows !== null) {
          const ids = eventRows.map((e) => e.id);
          await client.query(
            `DELETE FROM user_enrollments
              WHERE user_id = $1 AND season_event_id IS NOT NULL AND season_event_id != ALL($2::bigint[])`,
            [id, ids]
          );
          for (const ev of eventRows) {
            await client.query(
              `INSERT INTO user_enrollments (season_event_id, user_id, season_id, registered_at, created_at, updated_at)
               VALUES ($1, $2, $3, NOW(), NOW(), NOW()) ON CONFLICT DO NOTHING`,
              [ev.id, id, ev.season_id]
            );
          }
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }

      const { rows: updatedRows } = await pool.query(`SELECT ${USER_SELECT} FROM users WHERE id = $1`, [id]);
      const { eventsByUser } = await loadRelations(pool, [id]);
      return ok(res, {
        data: formatUser(updatedRows[0], { events: eventsByUser.get(id) || [] }),
      });
    } catch (err) {
      if (isEmailUniqueViolation(err)) {
        return fail(res, 422, 'The email has already been taken.', {
          details: { email: ['The email has already been taken.'] },
        });
      }
      log.error('topochain-admin', 'PUT /admin/users/:id failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    } finally {
      client.release();
    }
  }
  router.put('/api/v4/admin/users/:id', adminWriteGate, updateUser);
  router.patch('/api/v4/admin/users/:id', adminWriteGate, updateUser);

  // ── PATCH /api/v4/admin/users/:id/toggle-exclude-podium (SPEC 2348-2352) ─
  //
  // THE FIX (SPEC 2352's ⚠): message derived from the REFRESHED row this
  // same statement just returned — never a stale pre-toggle flag, so it
  // can never contradict `data.exclude_podium`.
  router.patch('/api/v4/admin/users/:id/toggle-exclude-podium', adminWriteGate, async (req, res) => {
    try {
      const id = toIntId(req.params.id);
      if (!id) return fail(res, 404, 'User not found.');

      const { rows } = await pool.query(
        `UPDATE users SET exclude_podium = NOT exclude_podium, updated_at = NOW()
          WHERE id = $1 RETURNING ${USER_SELECT}`,
        [id]
      );
      if (!rows.length) return fail(res, 404, 'User not found.');
      const user = rows[0];

      const { eventsByUser, accountsByUser } = await loadRelations(pool, [id]);
      return ok(res, {
        data: formatUser(user, {
          events: eventsByUser.get(id) || [],
          onchainAccounts: accountsByUser.get(id) || [],
        }),
      }, {
        // #1558: the console never surfaces this string (the screen refetches
        // instead), but the API tester does, and "internal tester" described
        // the same action in a third vocabulary — neither the column's nor
        // the button's. It says what changed now.
        message: user.exclude_podium
          ? 'User excluded from leaderboard ranking.'
          : 'User included in leaderboard ranking.',
      });
    } catch (err) {
      log.error('topochain-admin', 'PATCH /admin/users/:id/toggle-exclude-podium failed', { message: err.message });
      return fail(res, 500, 'Internal server error.');
    }
  });

  // The same transaction and last-admin lock as the platform account API.
  router.delete('/api/v4/admin/users/:id', adminWriteGate, async (req, res) => {
    try {
      const result = await require('../../../services/account-deletion').deleteAccount(pool, {
        userId: toIntId(req.params.id), actorId: req.user.id, mode: 'admin', confirmation: req.body?.confirmation,
      });
      void require('../../../services/account-deletion-cleanup').sweep(pool, config).catch(() => {});
      return ok(res, result, { message: 'Account deleted. External cleanup may still be pending.' });
    } catch (err) {
      if (err instanceof require('../../../services/account-deletion').AccountDeletionError) return fail(res, err.status, err.message);
      log.error('topochain-admin', 'Account deletion failed', { code: err.code || 'internal_error' });
      return fail(res, 500, 'Account deletion could not be completed.');
    }
  });

  return router;
}

module.exports = { usersAdminRoutes, formatUser };
