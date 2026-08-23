'use strict';

// Username changes (#1336) — the ONE place that owns what a handle may be,
// who may take it, and what happens to the one they leave behind.
//
// `users.username` was immutable until this module existed, and the reason
// was never the login: sessions key on user_id (src/routes/auth.js), so a
// rename signs nobody out. The reason was that four surfaces resolve a
// person by their handle STRING, and two of them read data the platform
// does not own:
//
//   • `@name` in chat text already written  — src/services/notifications.js
//   • `#leaderboard/users/<name>` links already shared — src/routes/kudos.js
//   • `admins: [...]` in each app repo's dapp.json — src/services/app-manifest.js
//   • `/api/public/profiles/<name>`          — src/routes/profiles.js
//
// Releasing the old handle re-points all four at whoever registers it next,
// and the dapp.json one hands them app-admin rights on somebody else's app.
// So a rename RETIRES the old handle into `username_history` permanently
// (see the block comment on that table) and every resolver above reads
// `resolveHandle` here, which answers from `users` first and the retired
// ledger second.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: tighten registration.
// POST /api/auth/register still accepts any non-empty unique string, as it
// always has. `isValidUsername` below is stricter than the handles already
// in the table, and applying it retroactively would be a breaking change to
// a public endpoint that this feature has no business making. It gates the
// NEW name on a rename, nothing else.

// ─── What a chosen handle may be ───────────────────────────────────────
//
// Deliberately a SUBSET of what MENTION_RE in src/services/notifications.js
// can capture (`[A-Za-z0-9_]{1,32}`). That regex is the reason hyphens are
// out: `@ada-lovelace` parses as `@ada`, so a user who renamed into a
// hyphen would quietly stop being mentionable and someone named `ada` would
// collect their notifications. Existing hyphenated handles (the seeded
// service identities among them) predate this and keep working — they are
// simply names nobody can rename INTO.
const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
const MIN_USERNAME_LEN = 3;
const MAX_USERNAME_LEN = 32;

// The platform's own service namespace. `usernode-capture`,
// `usernode-capture-admin` and the rest are seeded by src/db/migrate.js and
// resolved BY NAME at runtime (src/services/visuals.js), so a user wearing
// one of these handles is a user impersonating platform infrastructure.
// Matched on the lowercased name with the separators stripped, so
// `usernode_capture` and `UserNodeCapture` are refused alongside the
// literal seeds.
const RESERVED_PREFIXES = ['usernode', 'staging'];

// Accounts that may never be renamed AT ALL, in either direction. These are
// the seeded service identities: their username IS the lookup key that
// finds them (`SELECT id FROM users WHERE username = 'usernode-capture'`),
// so renaming one does not move an identity, it breaks a subsystem.
const SERVICE_IDENTITIES = new Set([
  'usernode-capture',
  'usernode-capture-admin',
  'staging-demo-user',
]);

// A rename permanently removes a handle from the namespace, so it cannot be
// free. 30 days is long enough that the namespace shrinks at a human rate
// and short enough that a typo'd handle isn't a life sentence. Admins are
// not exempt — nothing about being an admin makes handle churn cheaper.
const RENAME_COOLDOWN_DAYS = 30;

function normalize(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

// Reserved-namespace check. Strips `_` and `-` before comparing so the
// prefix can't be walked around with a separator.
function isReserved(name) {
  const flat = name.toLowerCase().replace(/[_-]/g, '');
  return RESERVED_PREFIXES.some((p) => flat.startsWith(p));
}

function isServiceIdentity(name) {
  return SERVICE_IDENTITIES.has(normalize(name).toLowerCase());
}

/**
 * Validate a REQUESTED new handle. Pure — no availability check, which
 * needs the pool (see `checkAvailability`).
 * Returns { ok: true, value } or { ok: false, error } with a sentence a
 * human can act on, which is what the sheet pins under the field.
 */
function validateUsername(raw) {
  const value = normalize(raw);
  if (!value) return { ok: false, error: 'Enter a username.' };
  if (value.length < MIN_USERNAME_LEN) {
    return { ok: false, error: `Usernames are at least ${MIN_USERNAME_LEN} characters.` };
  }
  if (value.length > MAX_USERNAME_LEN) {
    return { ok: false, error: `Usernames are at most ${MAX_USERNAME_LEN} characters.` };
  }
  if (!USERNAME_RE.test(value)) {
    return { ok: false, error: 'Use letters, numbers and underscores only — so people can still @mention you.' };
  }
  if (isReserved(value)) {
    return { ok: false, error: 'That name is reserved for the platform.' };
  }
  return { ok: true, value };
}

/**
 * Is `name` free for `userId` to take? Consults BOTH the live table and the
 * retired ledger, which is the whole point of the ledger.
 *
 * A handle this same user retired earlier is available again TO THEM — the
 * reservation exists to stop other people inheriting their history, not to
 * stop them changing their mind back.
 *
 * Returns { available: true } or { available: false, error }.
 */
async function checkAvailability(pool, name, userId) {
  const lower = name.toLowerCase();

  const { rows: taken } = await pool.query(
    'SELECT id FROM users WHERE LOWER(username) = $1',
    [lower]
  );
  if (taken.length && taken[0].id !== userId) {
    return { available: false, error: 'That username is taken.' };
  }

  const { rows: retired } = await pool.query(
    'SELECT user_id FROM username_history WHERE LOWER(username) = $1',
    [lower]
  );
  if (retired.length && retired[0].user_id !== userId) {
    // Deliberately the same sentence as "taken". Whether a handle is live
    // or retired is not this endpoint's business to leak — it would turn
    // the rename form into an oracle for "did @someone rename recently".
    return { available: false, error: 'That username is taken.' };
  }

  return { available: true };
}

/**
 * When may `userId` rename next? Returns { ok: true } or
 * { ok: false, error, retryAfter } where retryAfter is an ISO timestamp.
 * Reads the ledger rather than a column on `users` so the cooldown and the
 * reservation can never disagree about when the last rename happened.
 */
async function checkCooldown(pool, userId) {
  const { rows } = await pool.query(
    `SELECT changed_at FROM username_history
      WHERE user_id = $1 ORDER BY changed_at DESC LIMIT 1`,
    [userId]
  );
  if (!rows.length) return { ok: true };

  const last = new Date(rows[0].changed_at).getTime();
  const next = last + RENAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  if (Date.now() >= next) return { ok: true };

  const days = Math.ceil((next - Date.now()) / (24 * 60 * 60 * 1000));
  return {
    ok: false,
    retryAfter: new Date(next).toISOString(),
    error: `You changed your username recently. You can change it again in ${days} day${days === 1 ? '' : 's'}.`,
  };
}

/**
 * Resolve a handle to a user, current name or retired one.
 *
 * This is the function every handle-keyed surface calls instead of
 * `SELECT ... WHERE username = $1`. It answers from `users` FIRST so a live
 * handle always beats a retired one (they can only collide across different
 * people if a user retired a name and someone… cannot, actually — the
 * unique index forbids it. The ordering is belt-and-braces and costs one
 * short-circuited query).
 *
 * Returns null for an unknown handle, else
 * `{ userId, username, retired }` where `username` is the CANONICAL current
 * handle and `retired` says the caller was asked about an old one — which
 * is how the public read routes know to answer with a redirect.
 */
async function resolveHandle(pool, raw) {
  const name = normalize(raw);
  if (!name || name.length > 255) return null;
  const lower = name.toLowerCase();

  const { rows: live } = await pool.query(
    'SELECT id, username FROM users WHERE LOWER(username) = $1',
    [lower]
  );
  if (live.length) {
    return { userId: live[0].id, username: live[0].username, retired: false };
  }

  const { rows: old } = await pool.query(
    `SELECT h.user_id, u.username
       FROM username_history h
       JOIN users u ON u.id = h.user_id
      WHERE LOWER(h.username) = $1`,
    [lower]
  );
  if (old.length) {
    return { userId: old[0].user_id, username: old[0].username, retired: true };
  }

  return null;
}

/**
 * Batch form of `resolveHandle`, for dapp.json's `admins` block — one query
 * per source instead of one per declared name.
 *
 * Returns the rows that resolved, as `{ id, username, declared }` where
 * `declared` is the lowercased name that matched. A live handle wins over a
 * retired one for the same person, and a person is returned ONCE even if
 * the manifest declares both their current and a former handle.
 */
async function resolveHandles(pool, names) {
  const lowered = [...new Set(
    (Array.isArray(names) ? names : [])
      .map((n) => normalize(n).toLowerCase())
      .filter(Boolean)
  )];
  if (!lowered.length) return [];

  const { rows } = await pool.query(
    `SELECT u.id, u.username, LOWER(u.username) AS declared, TRUE AS live
       FROM users u
      WHERE LOWER(u.username) = ANY($1::text[])
      UNION ALL
     SELECT u.id, u.username, LOWER(h.username) AS declared, FALSE AS live
       FROM username_history h
       JOIN users u ON u.id = h.user_id
      WHERE LOWER(h.username) = ANY($1::text[])`,
    [lowered]
  );

  const byUser = new Map();
  for (const row of rows) {
    const prev = byUser.get(row.id);
    // Prefer the live match so `declared` reports the name they hold now
    // when the manifest names both.
    if (!prev || (row.live && !prev.live)) byUser.set(row.id, row);
  }
  return [...byUser.values()].map((r) => ({
    id: r.id, username: r.username, declared: r.declared,
  }));
}

/**
 * Perform the rename. Retires the old handle and installs the new one in
 * ONE transaction: a half-applied rename either leaks a handle nobody
 * holds or hands the old one to the next registrant, and both are the
 * failure this whole module exists to prevent.
 *
 * A CASE-ONLY change (`ada` -> `Ada`) is not a rename: the same person
 * still holds the same handle, so it writes no ledger row and burns no
 * cooldown. Everything else retires.
 *
 * Callers MUST have validated + checked availability and cooldown first;
 * the unique indexes are the backstop, not the gate. Returns
 * `{ username, retired }` — `retired` is the old handle, or null for a
 * re-case.
 */
async function renameUser(pool, userId, nextName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Re-read the current handle INSIDE the transaction and lock the row —
    // two concurrent renames of the same account would otherwise both read
    // the same "old" name and write two ledger rows for it, and the second
    // would trip the unique index after the first had already moved on.
    const { rows } = await client.query(
      'SELECT username FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const current = rows[0].username;
    const recase = current.toLowerCase() === nextName.toLowerCase();

    if (!recase) {
      await client.query(
        'INSERT INTO username_history (user_id, username) VALUES ($1, $2)',
        [userId, current]
      );
      // Taking back a handle this same user retired earlier: drop the
      // reservation, because they hold it live again. Without this the
      // ledger would list a handle as "given up" by the very person
      // wearing it — harmless to resolveHandle (which reads `users`
      // first) but a lie to anyone reading the table, and it would keep
      // reserving a name that no longer needs reserving.
      await client.query(
        'DELETE FROM username_history WHERE user_id = $1 AND LOWER(username) = LOWER($2)',
        [userId, nextName]
      );
    }
    await client.query(
      'UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2',
      [nextName, userId]
    );

    await client.query('COMMIT');
    return { username: nextName, retired: recase ? null : current };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  MIN_USERNAME_LEN,
  MAX_USERNAME_LEN,
  RENAME_COOLDOWN_DAYS,
  SERVICE_IDENTITIES,
  validateUsername,
  isReserved,
  isServiceIdentity,
  checkAvailability,
  checkCooldown,
  resolveHandle,
  resolveHandles,
  renameUser,
};
