'use strict';

// The platform's ONE username-directory implementation (issue #1195).
//
// Three surfaces read it and must never drift apart:
//   • GET /api/app-platform/users/{lookup,search}  — app containers
//     (src/routes/app-platform-api.js), app token + user token.
//   • GET /api/app-directory/users/{lookup,search} — the shell's bridge
//     relay (src/routes/app-directory.js), browser session.
//   • GET /api/users/search                        — the platform's own
//     collaborator/app-admin invite typeahead (src/routes/collaborators.js).
//
// One matching rule, one escaping rule, one ordering rule, and — the
// point of the exercise — ONE projection. A directory answer is
// `{ id, username }` and nothing else: no display_name, bio, avatar,
// email, usernode_pubkey, locale, is_admin, created_at or profile_*
// column may ever join this SELECT list. `username` is the canonical route
// key and is already public; everything else on the users row is either
// private or gated behind the opt-in public-profile allowlist in
// src/routes/profiles.js. It stopped being IMMUTABLE in #1336 — lookupExact
// resolves retired handles through src/services/usernames.js, and always
// answers with the current one.

// users.username is VARCHAR(255) — anything longer cannot match a row,
// so it is a bad request rather than a miss.
const MAX_USERNAME_LEN = 255;
// Retired-handle resolution for lookupExact (see the note there).
const usernames = require('./usernames');
// Prefix queries are clipped, matching the invite typeahead's own clip.
const MAX_QUERY_LEN = 32;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;

// The complete field allowlist. Kept as a constant so the projection and
// the tests that guard it read from the same place.
const USER_FIELDS = ['id', 'username'];

// Escape LIKE metacharacters so a literal %, _ or \ in the query can't
// widen a prefix match into a whole-table scan. Paired with an explicit
// ESCAPE '\' in every LIKE below.
function escapeLike(s) {
  return s.replace(/([\\%_])/g, '\\$1');
}

function projectUser(row) {
  return { id: row.id, username: row.username };
}

// Normalize a lookup handle. Returns null for anything that cannot be a
// username — callers turn that into a 400, so "no such handle" (200
// found:false) stays distinguishable from "you sent nonsense".
function normalizeUsername(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_USERNAME_LEN) return null;
  return trimmed;
}

// Normalize a prefix query: trim, clip. An empty result means "return
// nothing" — never "return the whole table".
function normalizeQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_QUERY_LEN);
}

// Absent/unparseable → the default; out of range → clamped to the bound.
function clampLimit(raw, { def = DEFAULT_SEARCH_LIMIT, max = MAX_SEARCH_LIMIT } = {}) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}

// Exact-handle existence check, case-insensitively.
//
// users.username is UNIQUE, but Postgres uniqueness is case-SENSITIVE
// and registration (src/routes/auth.js) normalizes nothing, so
// case-collided pairs genuinely exist in production. Resolution:
//
//   1. A case-EXACT row wins outright (this is what login matches on).
//   2. Otherwise a single case-insensitive row is the answer.
//   3. Otherwise the lowest id is returned with `ambiguous: true`, so an
//      app can ask the user which one they meant instead of silently
//      inviting the wrong person.
//
// `username` in the reply is always the CANONICAL stored casing, so an
// app that persists it stores the handle the way its owner wrote it.
async function lookupExact(pool, username) {
  const name = normalizeUsername(username);
  if (name === null) return { found: false, user: null, ambiguous: false };

  // LIMIT 2 is all the collision rule needs: whether a second
  // case-insensitive row exists, and which row sorts first.
  const { rows } = await pool.query(
    `SELECT id, username FROM users
      WHERE LOWER(username) = LOWER($1)
      ORDER BY (username = $1) DESC, id
      LIMIT 2`,
    [name]
  );
  if (rows.length) {
    const exact = rows[0].username === name;
    return {
      found: true,
      user: projectUser(rows[0]),
      ambiguous: !exact && rows.length > 1,
    };
  }

  // No live holder — try the retired-handle ledger (#1336). An app that
  // stored `@alice` last year must keep resolving her after she renamed;
  // that is the whole reason the handle stays reserved instead of returning
  // to the pool. Never ambiguous: `username_history` carries a unique index
  // on LOWER(username), so a retired handle has exactly one owner.
  //
  // The reply still projects the user's CANONICAL CURRENT handle, not the
  // one that was asked for, so an app that re-persists the answer converges
  // on the live name instead of pinning the old one forever.
  //
  // Deliberately NOT extended to searchPrefix below: a typeahead offering
  // handles nobody wears is a typeahead offering the wrong person.
  const resolved = await usernames.resolveHandle(pool, name);
  if (!resolved) return { found: false, user: null, ambiguous: false };
  return {
    found: true,
    user: projectUser({ id: resolved.userId, username: resolved.username }),
    ambiguous: false,
  };
}

// Case-insensitive PREFIX search. Prefix-only on purpose: LIKE 'q%' is
// servable by an index — idx_users_username_lower_pattern on
// LOWER(username) in schema.sql (#1213); text_pattern_ops because a
// non-C collation's default opclass cannot turn a LIKE prefix into an
// index range — and matches what the platform's own typeahead has
// always done, while LIKE '%q%' turns every keystroke into a table scan.
//
// `excludeAppId` filters out users who already hold any app_collaborators
// row (member or invited) on that app — used only by the platform's own
// invite typeahead, which must not suggest people already on the list.
async function searchPrefix(pool, q, limit, opts = {}) {
  const prefix = normalizeQuery(q);
  if (!prefix) return { users: [], hasMore: false };

  const n = clampLimit(limit, opts);
  const escaped = escapeLike(prefix);
  const excludeAppId = opts.excludeAppId ?? null;

  // Fetch n+1 so an extra row signals there is more to find — the same
  // trick the governance feed uses for its cursor pages.
  const { rows } = await pool.query(
    `SELECT id, username FROM users
      WHERE LOWER(username) LIKE LOWER($1) || '%' ESCAPE '\\'
        AND ($2::int IS NULL OR id NOT IN (
          SELECT user_id FROM app_collaborators WHERE app_id = $2
        ))
      ORDER BY LOWER(username), id
      LIMIT $3`,
    [escaped, excludeAppId, n + 1]
  );

  let hasMore = false;
  if (rows.length > n) {
    hasMore = true;
    rows.length = n;
  }
  return { users: rows.map(projectUser), hasMore };
}

module.exports = {
  lookupExact,
  searchPrefix,
  normalizeUsername,
  normalizeQuery,
  clampLimit,
  escapeLike,
  projectUser,
  USER_FIELDS,
  MAX_USERNAME_LEN,
  MAX_QUERY_LEN,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
};
