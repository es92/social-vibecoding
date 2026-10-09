'use strict';

const crypto = require('crypto');

// Username changes — the ONE place that owns what a handle may be,
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
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: re-check handles that exist.
// `validateUsername` below is stricter than the handles already in the
// table (hyphenated seeds, legacy registrations), and applying it
// retroactively would lock people out of names they hold. It gates a NEW
// name only: a rename, a first choice, and (since QA 2026-09-24 Q11)
// POST /api/auth/register, which used to accept any non-empty unique
// string. That was the door #1377's unbranchable handle came through, and
// it left the sign-up form with looser rules than the rename sheet, so a
// person could register a name they could never rename back into.

// ─── What a chosen handle may be ───────────────────────────────────────
//
// Deliberately a SUBSET of what MENTION_RE in src/services/notifications.js
// can capture (`[A-Za-z0-9_]{1,32}`). That regex is the reason hyphens are
// out: `@ada-lovelace` parses as `@ada`, so a user who renamed into a
// hyphen would quietly stop being mentionable and someone named `ada` would
// collect their notifications. Existing hyphenated handles (the seeded
// service identities among them) predate this and keep working — they are
// simply names nobody can rename INTO.
// It is ALSO a subset of src/services/branch-names.js's
// BRANCH_SAFE_CHARS_RE, and must stay one. Dev sessions mint a branch as
// `dev/<username>-<timestamp>`, and #1377 is the bug where a username the
// push proxy's charset rejected stranded 47 minutes of agent work behind
// `bad_branch`. That bug was reached by REGISTERING such a name; a rename
// is a second door to it, and this charset is what keeps that door shut.
// tests/username-change.test.js pins the subset relationship, so widening
// this without widening that one fails the suite rather than production.
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
// B9 (E8): and `homeroom`, so "@Homeroom bot" (the platform's bot, mentioned
// in a project's chat) can never notify a person who took the name. People
// who already hold such a name keep it; only new names are refused.
const RESERVED_PREFIXES = ['usernode', 'staging', 'homeroom'];

// Accounts that may never be renamed AT ALL, in either direction. These are
// the seeded service identities: their username IS the lookup key that
// finds them (`SELECT id FROM users WHERE username = 'usernode-capture'`),
// so renaming one does not move an identity, it breaks a subsystem.
const SERVICE_IDENTITIES = new Set([
  'usernode-capture',
  'usernode-capture-admin',
  // Exists only in disposable paired-shots databases, where the browser
  // needs a real full-admin session to review protected surfaces.
  'usernode-shots-full-admin',
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
    return { ok: false, error: 'Use letters, numbers and underscores only, so people can still @mention you.' };
  }
  if (isReserved(value)) {
    return { ok: false, error: 'That name is reserved for the platform.' };
  }
  return { ok: true, value };
}

// ─── The stand-in a new account holds until it chooses (#2563, #3575) ──
//
// Email sign-up used to write the address itself into `users.username`, so
// a member who signed in as `ada.lovelace@example.com` was that string to
// everyone else on the platform. #2563 stopped that by storing a SUGGESTION
// derived from the address's local part (`adalovelace`), marking the account
// `needs_username_choice`, and prefilling that suggestion wherever the
// person was asked.
//
// #3575 removed the suggestion too. A prefilled field that one press of
// "Create account" accepts is a username generated from the email in all
// but name — the thing the request asked us not to do ("They should have to
// manually set a username") — and the name it generated was a public copy of
// the private half of the address. So nothing on the platform derives a
// handle from an email address any more: a new account holds the opaque
// placeholder below, and every field that asks for the handle starts EMPTY
// (the set-password step in frontend/src/features/auth/login.tsx, and the
// first-run gate in frontend/src/features/auth/username-first-run.js).

/**
 * The handle a new account holds between being created and choosing one.
 * Opaque ON PURPOSE: it must not be the email address (#2563), must not be
 * derived from it (#3575), and must not read as anybody's real name. The
 * account carries `needs_username_choice` alongside it, and the email
 * sign-up will not finish without a choice (completePassword in
 * email-signup.js), so a person signing up never enters Homeroom wearing it.
 *
 * Shaped like the `topochain_<hex>` handles admin-created accounts get
 * (src/routes/topochain/admin/users.js), for the same reason: it satisfies
 * a NOT NULL UNIQUE column without doubling as anybody's real name. 72 bits
 * of randomness, so the retry around email-signup.js's insert is a backstop
 * that should never run, not a loop that expects to.
 */
function placeholderUsername() {
  return `member_${crypto.randomBytes(9).toString('hex')}`;
}

/**
 * Handles to try, in order, for somebody who gave their NAME rather than a
 * handle: an invite's phone sign-up, whose sheet asks "Your name" and no
 * username (firebase-phone-auth.js finishWithName). Not the derivation
 * #3575 removed: that one published the private half of an email address,
 * and this is the name the person just typed for the group to see. The
 * first is the name folded to the handle alphabet (accents dropped, every
 * other run of characters an underscore); the rest add digits, for when it
 * is taken or reserved. A name with nothing foldable (a script the handle
 * alphabet lacks) starts from `member`. The handle is PROVISIONAL: seen in
 * the private groups that invited them, and replaced by one they pick
 * before anything public shows it (replaceProvisionalUsername).
 */
function handlesFromName(rawName, tries = 6) {
  const folded = String(rawName || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
    .replace(/_+$/, '');
  const base = folded.length >= MIN_USERNAME_LEN ? folded : (folded ? `${folded}_member` : 'member');
  const out = [];
  if (validateUsername(base).ok) out.push(base);
  while (out.length < tries) {
    const next = `${isReserved(base) ? 'member' : base}_${crypto.randomInt(100, 10000)}`;
    if (validateUsername(next).ok && !out.includes(next)) out.push(next);
  }
  return out;
}

/**
 * The handle an email sign-up's username field arrives holding (#4596):
 * the letters and digits before the @, lowercased, with dots and every
 * other character dropped, cut to the 32 a handle may hold. `Ada.Lovelace+hr@`
 * is `adalovelace`. Null when what is left is too short or reserved, and
 * the field then starts empty. #4596 deliberately overturns #3575 for this
 * flow: the field is prefilled, the person can change it, and set-password
 * still takes only what the field sends.
 */
function usernameFromEmail(rawEmail) {
  const local = String(rawEmail || '').split('@')[0] || '';
  const base = local
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase()
    .slice(0, MAX_USERNAME_LEN);
  return validateUsername(base).ok ? base : null;
}

/**
 * `usernameFromEmail`, made free for `userId`: the name itself when nobody
 * holds it, else the name with the smallest number that is (`alex2`,
 * `alex3`, …), cut so the number still fits. Free means what
 * checkAvailability means: case-insensitive, over the live table and the
 * retired ledger, and a name this account holds or retired is its own. One
 * query for the first 100 candidates; null when none of them is free, and
 * the field then starts empty.
 */
async function suggestUsernameForEmail(pool, rawEmail, userId, tries = 100) {
  const base = usernameFromEmail(rawEmail);
  if (!base) return null;
  const candidates = [base];
  for (let n = 2; candidates.length < tries; n += 1) {
    const suffix = String(n);
    const name = `${base.slice(0, MAX_USERNAME_LEN - suffix.length)}${suffix}`;
    if (validateUsername(name).ok) candidates.push(name);
  }
  const { rows } = await pool.query(
    `SELECT LOWER(username) AS name FROM users
      WHERE LOWER(username) = ANY($1::text[]) AND id IS DISTINCT FROM $2
     UNION
     SELECT LOWER(username) AS name FROM username_history
      WHERE LOWER(username) = ANY($1::text[]) AND user_id IS DISTINCT FROM $2`,
    [candidates, userId == null ? null : userId]
  );
  const taken = new Set(rows.map((r) => r.name));
  return candidates.find((name) => !taken.has(name)) || null;
}

/**
 * Replace a PROVISIONAL handle (users.username_provisional_since: made from
 * an invite phone sign-up's name, seen only in private groups) with the one
 * the person picks before going anywhere public. Like chooseFirstUsername,
 * not a rename: no ledger row and no cooldown, because this is the first
 * handle they chose. Keeping the provisional one is a choice too (it is
 * theirs, so checkAvailability lets them). Returns null when the account's
 * handle is not provisional.
 */
async function replaceProvisionalUsername(pool, userId, nextName) {
  const { rows } = await pool.query(
    `UPDATE users
        SET username = $1, username_provisional_since = NULL, updated_at = NOW()
      WHERE id = $2 AND username_provisional_since IS NOT NULL
      RETURNING username`,
    [nextName, userId]
  );
  return rows.length ? { username: rows[0].username } : null;
}

/** Whether `userId` holds a provisional handle (see replaceProvisionalUsername). */
async function isProvisional(pool, userId) {
  if (!userId) return false;
  const { rows } = await pool.query(
    'SELECT 1 FROM users WHERE id = $1 AND username_provisional_since IS NOT NULL',
    [userId]
  );
  return rows.length > 0;
}

/** The refusal a public place answers a provisional handle with. */
const USERNAME_REQUIRED = Object.freeze({
  error: 'Pick a username first. Public places show your username, not your name.',
  code: 'username_required',
});

/**
 * Take the first handle. NOT a rename: this account has never had one.
 *
 * Deliberately different from `renameUser` in three ways, and each is the
 * point rather than a shortcut:
 *
 *  • No `username_history` row. The ledger reserves a RETIRED HANDLE so
 *    the next registrant cannot inherit its mentions, links and dapp.json
 *    admin rights. What is being left behind here is an email address or
 *    an opaque placeholder, which nobody mentioned, linked or declared —
 *    and writing an address into a table every handle resolver reads would
 *    put it one `/api/public/profiles/<name>` away from being public.
 *  • No cooldown burned. The 30-day window prices handle churn; picking a
 *    name for the first time is not churn, and charging for it would leave
 *    a typo in place for a month.
 *  • Gated on `needs_username_choice` inside the UPDATE, so a replayed
 *    request cannot walk somebody through the free path twice. Returns
 *    null when the flag is already clear, which the route answers 409.
 */
async function chooseFirstUsername(pool, userId, nextName) {
  const { rows } = await pool.query(
    `UPDATE users
        SET username = $1, needs_username_choice = FALSE, updated_at = NOW()
      WHERE id = $2 AND needs_username_choice = TRUE
      RETURNING username`,
    [nextName, userId]
  );
  return rows.length ? { username: rows[0].username } : null;
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
  placeholderUsername,
  handlesFromName,
  usernameFromEmail,
  suggestUsernameForEmail,
  replaceProvisionalUsername,
  isProvisional,
  USERNAME_REQUIRED,
  chooseFirstUsername,
  checkAvailability,
  checkCooldown,
  resolveHandle,
  resolveHandles,
  renameUser,
};
