// Topochain v4 admin API — D10 database tooling, hardened (Task 13;
// SPEC 2852-2920, Global Constraints #9).
//
// Two layers of coverage, per the task brief:
//   1. Pure unit tests against `sql-console.js`'s `validateStatement` /
//      `wrapWithLimit` / `parseLimit` — no HTTP, no mock pool, just the
//      hardening rules themselves (allow-list, single-statement,
//      comment/CTE smuggling, row-cap wrapping).
//   2. HTTP-level tests mounting the real `topochainAdminRoutes` (auth
//      gates included) on a throwaway express app, backed by a SQL-
//      dispatching mock pool (same idiom as tests/board-order.test.js /
//      tests/topochain-admin-api2.test.js) — covers auth posture,
//      response shapes, the export's secret-column/table exclusions, and
//      the honest-failure marker line.
//
// Run with: node --test tests/topochain-db-tools.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// Same require.cache indirection as the other topochain admin test
// files: the mock MUST be installed on the `db/pool` module's exports
// BEFORE anything that does `const { getPool } = require('.../db/pool')`
// is required, since destructuring copies the function reference at
// require-time, not a live binding.
const poolMod = require('../src/db/pool');
let currentMockPool = null;
poolMod.getPool = () => currentMockPool;

const { topochainAdminRoutes } = require('../src/routes/topochain/admin');
const {
  validateStatement,
  wrapWithLimit,
  parseLimit,
  extractReferencedTables,
} = require('../src/services/topochain/sql-console');
const { TEMPLATES } = require('../src/services/topochain/db-query-templates');
const { QUERYABLE_TABLES } = require('../src/services/topochain/db-allowlist');
const scopeMod = require('../src/services/topochain/db-console-scope');
const consoleRoleMod = require('../src/services/topochain/db-console-role');

// `sql-console.js` holds a reference to this whole module object (`const
// consoleRole = require('./db-console-role')`, not a destructured copy),
// so overwriting these two functions on it here is visible to
// `runConsoleQuery` on every call, regardless of require order — unlike
// the `poolMod.getPool` override above, this doesn't need to happen
// before any other require. Defaults to "available" for every test in
// this file except the one that explicitly flips it off to exercise the
// 503 path.
consoleRoleMod.isAvailable = () => true;
consoleRoleMod.unavailableReason = () => null;

// ═══════════════════════════════════════════════════════════════════════
// 1. Pure unit tests — sql-console.js hardening rules
// ═══════════════════════════════════════════════════════════════════════

test('validateStatement: allows a plain SELECT against an allowed table', () => {
  const r = validateStatement('SELECT id, name FROM seasons');
  assert.equal(r.ok, true);
});

test('validateStatement: allows a WITH/CTE query that JOINs back to its own alias', () => {
  const r = validateStatement(`
    WITH latest AS (SELECT season_event_id, MAX(snapshot_at) AS at FROM leaderboard_snapshots GROUP BY season_event_id)
    SELECT ls.season_event_id, ls.user_id, ls.rank FROM leaderboard_snapshots ls JOIN latest ON latest.season_event_id = ls.season_event_id
  `);
  assert.equal(r.ok, true);
});

test('validateStatement: allows a single trailing semicolon (only whitespace after it)', () => {
  const r = validateStatement('SELECT id FROM seasons;   ');
  assert.equal(r.ok, true);
});

for (const [label, sql] of [
  ['INSERT', `INSERT INTO seasons (name) VALUES ('x')`],
  ['UPDATE', `UPDATE seasons SET name = 'x'`],
  ['DELETE', `DELETE FROM seasons`],
  ['DROP', `DROP TABLE seasons`],
  ['TRUNCATE', `TRUNCATE seasons`],
]) {
  test(`validateStatement: rejects a bare ${label} statement (not SELECT/WITH)`, () => {
    const r = validateStatement(sql);
    assert.equal(r.ok, false);
    assert.match(r.reason, /SELECT and WITH/);
  });
}

test('validateStatement: rejects multiple statements separated by a semicolon', () => {
  const r = validateStatement('SELECT 1; SELECT 2');
  assert.equal(r.ok, false);
  assert.match(r.reason, /single SQL statement/);
});

test('validateStatement: rejects a second statement even when it is itself a write', () => {
  const r = validateStatement('SELECT * FROM seasons; DELETE FROM seasons;');
  assert.equal(r.ok, false);
  assert.match(r.reason, /single SQL statement/);
});

test('validateStatement: a semicolon inside a string literal is not mistaken for a statement separator', () => {
  const r = validateStatement(`SELECT ';' AS marker FROM seasons`);
  assert.equal(r.ok, true);
});

test('validateStatement: rejects a write smuggled inside a CTE (starts with WITH, mutates inside)', () => {
  const r = validateStatement(`WITH x AS (DELETE FROM seasons RETURNING *) SELECT * FROM x`);
  assert.equal(r.ok, false);
  assert.match(r.reason, /DELETE/i);
});

test('validateStatement: a comment cannot smuggle a non-SELECT statement past the prefix check', () => {
  // The real first statement, once comments are stripped, is DELETE —
  // the leading line comment must not be read as "the query starts with
  // a comment mentioning SELECT, so it's fine".
  const r = validateStatement('-- SELECT 1\nDELETE FROM seasons');
  assert.equal(r.ok, false);
  assert.match(r.reason, /SELECT and WITH/);
});

test('validateStatement: a block comment cannot hide a DROP before the real statement', () => {
  const r = validateStatement('/* just a select, trust me */ DROP TABLE seasons');
  assert.equal(r.ok, false);
});

test('validateStatement: rejects denied substrings case-insensitively (pg_read_file and friends)', () => {
  const r1 = validateStatement(`SELECT pg_read_file('/etc/passwd')`);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /pg_read_file/i);

  const r2 = validateStatement(`select PG_Read_File('/etc/passwd')`);
  assert.equal(r2.ok, false);
});

// ── Table scope: the whole `public` schema, full stop ──────────────────
//
// The console started out scoped to the 20 topochain tables, then widened
// to the schema minus ~20 credential-bearing tables, and since #1130
// covers EVERY base table in `public` — withholding credential COLUMNS
// instead of whole tables. See db-console-scope.js's header for why, and
// note that at each step what changed is which tables are BROWSABLE, not
// which columns are readable.

test('validateStatement: allows a non-topochain platform table (the scope is the whole schema now)', () => {
  // Cold cache: the live table list has not been loaded, so the deny list
  // alone decides. That is the deliberate fallback — an unloaded cache
  // must not read as "no table exists".
  scopeMod._resetForTests();
  for (const q of [
    'SELECT id, slug FROM apps LIMIT 10',
    'SELECT id, title FROM chat_sessions LIMIT 10',
    'SELECT id, event_type FROM events LIMIT 10',
    'SELECT a.slug, e.event_type FROM apps a JOIN events e ON e.app_id = a.id',
  ]) {
    const r = validateStatement(q);
    assert.equal(r.ok, true, `${q} was rejected: ${r.reason}`);
  }
});

test('validateStatement: a credential-bearing table is QUERYABLE, with only its credential column refused (#1130)', () => {
  // INVERTED BY #1130. This used to assert that `sessions` was rejected
  // wholesale ("not available in this console"), because the console had
  // copied debug-access.js's per-TABLE deny list. It now denies the
  // credential COLUMN instead: the row's shape is readable, its secret is
  // not. Same for every other formerly-denied table.
  const ok = validateStatement('SELECT user_id, expires_at FROM sessions');
  assert.equal(ok.ok, true, `rejected: ${ok.reason}`);

  const denied = validateStatement('SELECT token, user_id FROM sessions');
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /not accessible through this console/);
  assert.match(denied.reason, /token/);
  // Specifically NOT the table-level message any more.
  assert.doesNotMatch(denied.reason, /not available in this console/);
});

test('validateStatement: every CONSOLE_CREDENTIAL_COLUMNS entry is refused on its own table, table-awarely (#1130)', () => {
  // The whole map, exhaustively — a column added to it without a working
  // rejection (a typo, say) fails here rather than shipping as a silent
  // hole. Each check references ONLY the table the column belongs to, so
  // it also proves the rejection is table-aware rather than a blanket
  // regex over the statement text.
  for (const [table, columns] of Object.entries(scopeMod.CONSOLE_CREDENTIAL_COLUMNS)) {
    for (const column of columns) {
      const r = validateStatement(`SELECT ${column} FROM ${table} LIMIT 5`);
      assert.equal(r.ok, false, `${table}.${column} was NOT refused`);
      assert.match(r.reason, /not accessible through this console/);
      assert.match(r.reason, new RegExp(column));
    }
  }
});

test('validateStatement: the generic credential column names are not blanket-denied elsewhere (#1130)', () => {
  // `token`, `code` and `user_code` became denied names when the 20
  // formerly-denied tables gained per-column entries. They are common
  // column names, so a blanket regex over them (i.e. adding them to
  // `EXCLUDED_SECRET_COLUMN_NAMES`) would have made a large share of the
  // schema unqueryable. These pass BECAUSE the check is table-scoped.
  assert.equal(validateStatement('SELECT id, code FROM season_challenges LIMIT 5').ok, true);
  assert.equal(
    validateStatement('SELECT installation_id, status FROM mobile_push_deliveries LIMIT 5').ok,
    true
  );
});

test('validateStatement: mobile_push_deliveries and mobile_push_registrations are queryable, joined (#1130 regression lock)', () => {
  // The literal report: "Query references table(s) that are not available
  // in this console: mobile_push_deliveries, mobile_push_registrations."
  // Both are in scope now — `mobile_push_deliveries` with nothing masked
  // at all (it stores no credential), `mobile_push_registrations` with
  // only its encrypted destination and lookup hash masked.
  const joined = validateStatement(
    `SELECT d.environment, d.status, d.attempts, d.last_error_code,
            r.platform, r.permission_status
       FROM mobile_push_deliveries d
       LEFT JOIN mobile_push_registrations r ON r.id = d.registration_id`
  );
  assert.equal(joined.ok, true, `rejected: ${joined.reason}`);

  // `last_error_code` must NOT trip the `activation_codes.code` denial:
  // `\bcode\b` cannot match inside `last_error_code`, and the check is
  // table-scoped anyway.
  assert.equal(
    validateStatement('SELECT last_error_code FROM mobile_push_deliveries').ok,
    true
  );

  // The registration's secret halves are still refused, on both names.
  for (const column of ['registration_enc', 'registration_hash']) {
    const r = validateStatement(`SELECT ${column} FROM mobile_push_registrations`);
    assert.equal(r.ok, false, `${column} was NOT refused`);
    assert.match(r.reason, /not accessible through this console/);
  }
});

test('db-console-scope: the console table deny list is deliberately EMPTY while prod-debug keeps its own (#1130)', () => {
  // The two capabilities diverge ON PURPOSE (see db-console-scope.js's
  // header: an automated agent on a separate pool vs. a signed-in platform
  // admin who can read the same rows less redacted two clicks away). This
  // asserts the divergence so nobody "restores consistency" by re-copying
  // DENIED_TABLES into the console — which is exactly the bug #1130 was.
  const { DENIED_TABLES, DENIED_COLUMNS } = require('../src/services/debug-access');
  assert.ok(DENIED_TABLES.size > 0, 'prod-debug must still deny tables wholesale');
  assert.equal(scopeMod.DENIED_CONSOLE_TABLES.size, 0);

  // The COLUMN list, by contrast, is SHARED — imported, never restated —
  // so a credential column added for prod-debug covers the console too.
  for (const [table, columns] of Object.entries(DENIED_COLUMNS)) {
    for (const column of columns) {
      assert.ok(
        scopeMod.isDeniedColumn(table, column),
        `${table}.${column} is denied for prod-debug but not for the console`
      );
    }
  }

  // And every table prod-debug denies wholesale is either fully readable
  // here on purpose or has an explicit per-column entry — never silently
  // half-covered. `user_ai_credentials` is the one exception: it lives in
  // the `credentials` schema, which the console's inventory query
  // (`table_schema = 'public'`) cannot see and its role has no USAGE on.
  const OUT_OF_SCHEMA = new Set(['user_ai_credentials']);
  for (const table of DENIED_TABLES) {
    if (OUT_OF_SCHEMA.has(table)) continue;
    const covered = scopeMod.FULLY_READABLE_CONSOLE_TABLES.has(table)
      || Array.isArray(scopeMod.CONSOLE_CREDENTIAL_COLUMNS[table]);
    assert.ok(
      covered,
      `${table} is denied for prod-debug but the console neither masks a column on it `
      + 'nor declares it fully readable — decide which, in db-console-scope.js'
    );
  }
});

test('validateStatement: rejects a credential COLUMN of an in-scope table, table-awarely', () => {
  const r = validateStatement('SELECT id, password FROM users LIMIT 5');
  assert.equal(r.ok, false);
  assert.match(r.reason, /not accessible through this console/);
  assert.match(r.reason, /password/);
});

test('validateStatement: a denied column name is NOT blanket-denied for tables that do not have it', () => {
  // `data` is denied for `chat_session_attachments` and nowhere else, and
  // `ip` for `waitlist_signups` and nowhere else — but six other tables
  // have a `data` column and two more have an `ip` column. Denying the
  // WORD would have made a chunk of the schema unqueryable the moment the
  // scope widened, hence `deniedColumnsForTables`, keyed by the tables the
  // query actually references.
  assert.equal(validateStatement('SELECT id, data FROM app_icons LIMIT 5').ok, true);
  assert.equal(validateStatement('SELECT id, ip FROM user_terms_consents LIMIT 5').ok, true);
  // …and the tables it IS denied for are still refused.
  const denied = validateStatement('SELECT id, data FROM chat_session_attachments LIMIT 5');
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /not accessible through this console/);
});

test('validateStatement: once the live table list is loaded, a typo is a specific "does not exist", and a cold cache never claims that', () => {
  scopeMod._resetForTests();
  // Cold: no table list, so an unknown name cannot be distinguished from
  // a real one — let it through to the database (and the role's grants)
  // rather than inventing a reason.
  assert.equal(validateStatement('SELECT id FROM nope_not_a_table').ok, true);

  scopeMod._setKnownTablesForTests(['apps', 'seasons']);
  try {
    const r = validateStatement('SELECT id FROM nope_not_a_table');
    assert.equal(r.ok, false);
    assert.match(r.reason, /do not exist in this database/);
    assert.match(r.reason, /nope_not_a_table/);
    // A table on the list still passes, and a CTE name is not mistaken
    // for a missing table.
    assert.equal(validateStatement('SELECT id FROM apps').ok, true);
    assert.equal(
      validateStatement('WITH recent AS (SELECT id FROM apps) SELECT id FROM recent').ok,
      true
    );
  } finally {
    scopeMod._resetForTests();
  }
});

test('validateStatement: allows a JOIN across two allowed topochain tables', () => {
  const r = validateStatement(
    'SELECT s.id, se.id FROM seasons s JOIN season_events se ON se.season_id = s.id'
  );
  assert.equal(r.ok, true);
});

test('validateStatement: mobile_otp_codes / mobile_auth_tokens are queryable but their hash columns are not', () => {
  // Was a table-level rejection before #1130. The wildcard ban still
  // refuses `SELECT *` on both (it refuses it on every table), but that is
  // now the ONLY thing wrong with these two queries…
  const w1 = validateStatement('SELECT * FROM mobile_otp_codes');
  assert.equal(w1.ok, false);
  assert.match(w1.reason, /wildcard/);
  const w2 = validateStatement('SELECT * FROM mobile_auth_tokens');
  assert.equal(w2.ok, false);
  assert.match(w2.reason, /wildcard/);

  // …so spelling the non-credential columns out works, which is what an
  // admin debugging a stuck login needs.
  assert.equal(
    validateStatement('SELECT email, attempts, expires_at, consumed_at FROM mobile_otp_codes').ok,
    true
  );
  assert.equal(
    validateStatement('SELECT user_id, ability, expires_at, last_used_at FROM mobile_auth_tokens').ok,
    true
  );

  // The hashes themselves stay refused.
  assert.equal(validateStatement('SELECT code_hash FROM mobile_otp_codes').ok, false);
  assert.equal(validateStatement('SELECT token_hash FROM mobile_auth_tokens').ok, false);
});

test('validateStatement: rejects an EXPLICIT reference to onchain_accounts.secret_key or .registration_code', () => {
  const r1 = validateStatement('SELECT secret_key FROM onchain_accounts');
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /secret_key/);

  const r2 = validateStatement('SELECT id, registration_code FROM onchain_accounts');
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /registration_code/);
});

test('validateStatement: rejects a bare wildcard against onchain_accounts (the by-name check alone would miss this)', () => {
  const r1 = validateStatement('SELECT * FROM onchain_accounts');
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /wildcard/);

  const r2 = validateStatement('SELECT oa.* FROM onchain_accounts oa');
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /wildcard/);
});

test('validateStatement: allows COUNT(*) — an aggregate star returns no column data, so it is not treated as a wildcard', () => {
  const r = validateStatement('SELECT tier, COUNT(*) FROM onchain_accounts GROUP BY tier');
  assert.equal(r.ok, true);
});

test('validateStatement: a bare wildcard against an allowed table with no secrets is still rejected (explicit-columns policy is blanket, not table-specific)', () => {
  const r = validateStatement('SELECT * FROM seasons');
  assert.equal(r.ok, false);
  assert.match(r.reason, /wildcard/);
});

// ── Regression tests: the two live-reproduced bypasses ─────────────────
//
// A live security review reproduced BOTH of these against the seeded
// Postgres and got real secret_key/bcrypt-hash values back before the
// fix. Bypass class 1 (comma joins) is now caught by validateStatement
// itself (extractReferencedTables was fixed to parse the whole FROM-list,
// not just its first entry). Bypass class 2 (whole-row serialization) is
// NOT reliably catchable by any regex — see the last two tests below,
// which document exactly that and rely instead on db-console-role.js's
// column-level GRANT (verified separately against the live seeded
// Postgres; see the fix report).

test('BYPASS 1 (comma join) — validateStatement now catches SELECT u.password FROM onchain_accounts a, users u', () => {
  const r = validateStatement(
    'SELECT u.password FROM onchain_accounts a, users u WHERE a.user_id = u.id'
  );
  assert.equal(r.ok, false);
  // `users` is IN scope now (the console lists every non-credential
  // table), so what stops this query is no longer "that table is not on
  // the list" — it is the per-table column deny that `users.password`
  // trips, which is the check that mattered all along. The comma-join
  // parse is still what makes the column check see `users` at all: with
  // the pre-fix regex, `password` would have been checked against
  // `onchain_accounts` only and sailed through.
  assert.match(r.reason, /not accessible through this console/);
  assert.match(r.reason, /password/);
});

test('BYPASS 1 (comma join) — three-way comma list still surfaces every table, not just the first', () => {
  const { tables } = extractReferencedTables(
    'SELECT 1 FROM onchain_accounts a, users u, sessions s WHERE true'
  );
  assert.ok(tables.has('onchain_accounts'));
  assert.ok(tables.has('users'));
  assert.ok(tables.has('sessions'));
});

test('BYPASS 1 (comma join) — a subquery inside the FROM list is not split on ITS internal comma', () => {
  const { tables } = extractReferencedTables(
    'SELECT 1 FROM (SELECT id, name FROM seasons) x, onchain_accounts y'
  );
  // Both the outer comma-list entries AND the inner subquery's own FROM
  // are found (via separate FROM occurrences) — "id, name" must NOT be
  // misread as two more "tables" from the subquery's SELECT list.
  assert.ok(tables.has('seasons'));
  assert.ok(tables.has('onchain_accounts'));
  assert.ok(!tables.has('id'));
  assert.ok(!tables.has('name'));
});

test('BYPASS 2 (whole-row serialization) — row_to_json/to_jsonb/to_json/hstore are caught by the pre-flight denylist', () => {
  for (const fn of ['row_to_json', 'to_jsonb', 'to_json', 'hstore']) {
    const r = validateStatement(`SELECT ${fn}(o) FROM onchain_accounts o`);
    assert.equal(r.ok, false, `${fn}(o) should have been rejected`);
    assert.match(r.reason, /whole-row serialization/);
  }
});

test('BYPASS 2 (whole-row serialization) — HONEST GAP: a bare row alias or a cast is NOT caught by any pre-flight check', () => {
  // These are exactly the shapes a live security review used to pull
  // real secret_key/registration_code values out of onchain_accounts —
  // neither spells out an excluded column name, uses "*", or calls one
  // of the denylisted functions above, so validateStatement has nothing
  // to reject them on. This is not a bug in the test: it is the reason
  // db-console-role.js's column-level GRANT exists at all. Confirmed
  // separately against the live seeded Postgres that BOTH now come back
  // "permission denied for table onchain_accounts" once executed as the
  // restricted role (see the fix report) — validateStatement alone
  // cannot and does not stop them.
  const bareAlias = validateStatement('SELECT o FROM onchain_accounts o');
  assert.equal(bareAlias.ok, true);

  const cast = validateStatement('SELECT o::text FROM onchain_accounts o');
  assert.equal(cast.ok, true);
});

test('extractReferencedTables: finds FROM/JOIN identifiers and CTE aliases separately', () => {
  const { tables, cteNames } = extractReferencedTables(
    'WITH latest AS (SELECT 1) SELECT * FROM seasons JOIN latest ON true'
  );
  assert.ok(tables.has('seasons'));
  assert.ok(tables.has('latest'));
  assert.ok(cteNames.has('latest'));
});

test('wrapWithLimit: wraps a plain query in an outer bounded SELECT', () => {
  const wrapped = wrapWithLimit('SELECT * FROM seasons', 100);
  assert.equal(wrapped, 'SELECT * FROM (SELECT * FROM seasons) AS _topochain_console_q LIMIT 101');
});

test('wrapWithLimit: strips a single trailing semicolon before wrapping', () => {
  const wrapped = wrapWithLimit('SELECT * FROM seasons;', 5);
  assert.equal(wrapped, 'SELECT * FROM (SELECT * FROM seasons) AS _topochain_console_q LIMIT 6');
});

test('wrapWithLimit: wraps a CTE query intact (no special-casing needed)', () => {
  const inner = 'WITH x AS (SELECT 1) SELECT * FROM x';
  const wrapped = wrapWithLimit(inner, 10);
  assert.equal(wrapped, `SELECT * FROM (${inner}) AS _topochain_console_q LIMIT 11`);
});

test('wrapWithLimit: a query that already contains the word LIMIT keeps its own inner LIMIT as an inner ceiling', () => {
  const inner = 'SELECT * FROM seasons LIMIT 3';
  const wrapped = wrapWithLimit(inner, 100);
  assert.equal(wrapped, `SELECT * FROM (${inner}) AS _topochain_console_q LIMIT 101`);
  // The inner LIMIT text is preserved verbatim inside the wrap, not
  // parsed/rewritten/removed.
  assert.match(wrapped, /FROM seasons LIMIT 3\)/);
});

for (const [label, value, expected] of [
  ['absent -> default 100', undefined, { value: 100 }],
  ['empty string -> default 100', '', { value: 100 }],
  ['valid int', 250, { value: 250 }],
  ['valid numeric string', '17', { value: 17 }],
  ['min boundary 1', 1, { value: 1 }],
  ['max boundary 1000', 1000, { value: 1000 }],
]) {
  test(`parseLimit: ${label}`, () => {
    assert.deepEqual(parseLimit(value), expected);
  });
}

for (const [label, value] of [
  ['zero', 0],
  ['negative', -5],
  ['over 1000', 1001],
  ['non-integer', 1.5],
  ['non-numeric string', 'abc'],
  ['boolean true', true],
]) {
  test(`parseLimit: rejects ${label}`, () => {
    assert.deepEqual(parseLimit(value), { error: true });
  });
}

test('templates: all eight pass validateStatement (the exact execute-endpoint gate) and reference only in-scope tables', () => {
  // Seven since #1130 added the push-delivery template (a permanent
  // regression lock on mobile_push_deliveries + mobile_push_registrations
  // staying queryable); eight with the delegation-history template, which
  // pins account_delegation_periods + its onchain_accounts/users joins
  // the same way.
  assert.equal(TEMPLATES.length, 8);
  assert.ok(TEMPLATES.some((t) => t.name === 'Delegation periods with current claimant'),
    'the delegation-history template exists');
  for (const t of TEMPLATES) {
    assert.equal(typeof t.name, 'string');
    assert.equal(typeof t.description, 'string');
    const result = validateStatement(t.query);
    assert.equal(result.ok, true, `template "${t.name}" failed validation: ${result.reason}`);
    assert.doesNotMatch(t.query.toLowerCase(), /\bmetrics\b/, 'SPEC 2920: templates must not reference the excluded metrics table');
  }
});

test('db-console-role: buildGrantStatements grants EVERY table in the schema, column-level wherever a table has denied columns', async () => {
  const mockPool = {
    async query(sql) {
      // The scope now comes from the whole `public` schema rather than a
      // hardcoded table list, so the query is unparameterised and filtered
      // to base tables.
      assert.match(sql, /information_schema\.columns/);
      assert.match(sql, /BASE TABLE/);
      return {
        rows: [
          { table: 'seasons', columns: ['id', 'name', 'description'] },
          { table: 'apps', columns: ['id', 'slug', 'db_password', 'llm_proxy_token', 'storage_api_token'] },
          { table: 'onchain_accounts', columns: ['id', 'amount', 'secret_key', 'registration_code', 'tier'] },
          { table: 'users', columns: ['id', 'username', 'password'] },
          // #1130: formerly denied wholesale, now granted column-level.
          { table: 'sessions', columns: ['token', 'user_id', 'expires_at'] },
          { table: 'app_secrets', columns: ['app_id', 'key', 'value_enc', 'value_last4', 'updated_at'] },
          { table: 'mobile_auth_tokens', columns: ['id', 'user_id', 'token_hash', 'ability'] },
          {
            table: 'mobile_push_registrations',
            columns: ['id', 'user_id', 'registration_hash', 'registration_enc', 'platform'],
          },
          // …and this one, which stores no credential at all, gets a plain
          // table grant. It is the table #1130 was reported about.
          {
            table: 'mobile_push_deliveries',
            columns: ['id', 'notification_id', 'status', 'attempts', 'last_error_code'],
          },
        ],
      };
    },
  };
  const stmts = await consoleRoleMod.buildGrantStatements(mockPool);
  // Resolving the scope also primes the validator's table cache; clear it
  // so this test cannot change what a later one sees.
  scopeMod._resetForTests();

  // Plain table grants for tables with nothing denied — including the
  // non-topochain ones the widened scope brought in.
  const seasonsStmt = stmts.find((s) => s.includes('"seasons"'));
  assert.match(seasonsStmt, /^GRANT SELECT ON public\."seasons" TO topochain_console_ro$/);

  const onchainStmt = stmts.find((s) => s.includes('"onchain_accounts"'));
  assert.match(onchainStmt, /^GRANT SELECT \(/); // column-level grant, not a plain table grant
  assert.doesNotMatch(onchainStmt, /secret_key/);
  assert.doesNotMatch(onchainStmt, /registration_code/);
  assert.match(onchainStmt, /"tier"/);

  // The platform tables get the same column-level treatment — this is
  // what keeps "browse every table" from meaning "read every column".
  const usersStmt = stmts.find((s) => s.includes('"users"'));
  assert.match(usersStmt, /^GRANT SELECT \(/);
  assert.doesNotMatch(usersStmt, /password/);
  assert.match(usersStmt, /"username"/);

  const appsStmt = stmts.find((s) => s.includes('"apps"'));
  assert.match(appsStmt, /^GRANT SELECT \(/);
  assert.doesNotMatch(appsStmt, /db_password|llm_proxy_token|storage_api_token/);
  assert.match(appsStmt, /"slug"/);

  // #1130, INVERTED: these three used to produce NO statement at all.
  // They now get a column-level grant that omits exactly the credential
  // column and keeps everything else — the change the issue asked for,
  // asserted at the layer that actually enforces it.
  for (const [table, secrets, kept] of [
    ['sessions', ['token'], 'expires_at'],
    ['app_secrets', ['value_enc', 'value_last4'], 'updated_at'],
    ['mobile_auth_tokens', ['token_hash'], 'ability'],
    ['mobile_push_registrations', ['registration_enc', 'registration_hash'], 'platform'],
  ]) {
    const stmt = stmts.find((s) => s.includes(`public."${table}"`));
    assert.ok(stmt, `${table} must be granted to the console role now`);
    assert.match(stmt, /^GRANT SELECT \(/, `${table} needs a COLUMN-level grant`);
    for (const secret of secrets) {
      assert.doesNotMatch(stmt, new RegExp(secret), `${table}.${secret} must not be granted`);
    }
    assert.match(stmt, new RegExp(`"${kept}"`), `${table}.${kept} must stay readable`);
  }

  // A formerly-denied table with no credential column at all gets a plain
  // table grant — nothing about it is withheld.
  const deliveriesStmt = stmts.find((s) => s.includes('"mobile_push_deliveries"'));
  assert.match(
    deliveriesStmt,
    /^GRANT SELECT ON public\."mobile_push_deliveries" TO topochain_console_ro$/
  );

  // And with the table deny list empty, EVERY inventory row produced
  // exactly one grant.
  assert.equal(stmts.length, 9);
});

test('db-console-role: a table whose every column is denied is dropped rather than granted empty', async () => {
  // The one case where a table still ends up with no grant at all. Nothing
  // in the real schema looks like this — `sessions` came closest and keeps
  // `user_id`/`expires_at` — but `loadConsoleScope` has to handle it,
  // because `GRANT SELECT () ON ...` is not valid SQL.
  const mockPool = {
    async query() {
      return {
        rows: [
          { table: 'sessions', columns: ['token'] },
          { table: 'seasons', columns: ['id'] },
        ],
      };
    },
  };
  const stmts = await consoleRoleMod.buildGrantStatements(mockPool);
  scopeMod._resetForTests();
  assert.equal(stmts.length, 1);
  assert.match(stmts[0], /"seasons"/);
});

// ── #1130: schema.sql cross-checks for the console's column deny map ───
//
// The console lists every base table in `public` now, so the ONLY thing
// standing between an admin and a credential value is
// `DENIED_CONSOLE_COLUMNS`. These two tests make a missing entry a red
// test rather than a quiet leak on the next deploy: the first checks the
// schema's own credential TAGS, the second sweeps every column NAME.

const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, '../src/db/schema.sql'), 'utf8'
);

test('#1130: every staging:private COLUMN in schema.sql is masked for the console too', () => {
  // The mirror of tests/prod-debug-access.test.js's identical assertion,
  // pointed at the console's lists. It CANNOT be satisfied by denying the
  // table any more (the console denies no tables), so every tagged column
  // has to be named explicitly.
  const tagged = [...SCHEMA_SQL.matchAll(
    /COMMENT ON COLUMN\s+([a-z_]+)\.([a-z_]+)\s+IS\s+'staging:private'/g
  )].map((m) => ({ table: m[1], column: m[2] }));
  assert.ok(tagged.length >= 5, `expected to find tagged columns, got ${tagged.length}`);
  for (const { table, column } of tagged) {
    assert.ok(
      scopeMod.isDeniedColumn(table, column),
      `staging:private column ${table}.${column} is readable through the SQL console — `
      + 'add it to debug-access.js\'s DENIED_COLUMNS (both roles) or to '
      + 'db-console-scope.js\'s CONSOLE_CREDENTIAL_COLUMNS'
    );
  }
});

test('#1130: no credential-SHAPED column name in schema.sql is readable without a review decision', () => {
  // A tag-based check only catches what someone remembered to tag. This
  // one sweeps every column declaration in the schema — `CREATE TABLE`
  // bodies AND the `ALTER TABLE ... ADD COLUMN` migrations, which is where
  // most new columns actually land — for names that LOOK like credentials,
  // and requires each one to be either denied or listed in
  // REVIEWED_READABLE below. Adding a name to that list is a deliberate,
  // reviewable act; forgetting about a new `*_token_hash` column is not.
  const declared = [];

  // CREATE TABLE bodies: table name, then every leading identifier of a
  // line inside the parenthesized body. Constraint lines start with
  // CHECK/UNIQUE/PRIMARY/CONSTRAINT/FOREIGN and are filtered below.
  const createRe = /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/g;
  for (const m of SCHEMA_SQL.matchAll(createRe)) {
    const table = m[1];
    for (const line of m[2].split('\n')) {
      const col = line.trim().match(/^([a-z_][a-z0-9_]*)\s+[A-Za-z]/);
      if (col) declared.push({ table, column: col[1] });
    }
  }

  const alterRe =
    /ALTER TABLE\s+(?:IF EXISTS\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/g;
  for (const m of SCHEMA_SQL.matchAll(alterRe)) {
    declared.push({ table: m[1], column: m[2] });
  }
  assert.ok(declared.length > 500, `sweep found only ${declared.length} columns — the regexes broke`);

  const NOT_A_COLUMN = new Set([
    'check', 'unique', 'primary', 'constraint', 'foreign', 'exclude', 'like',
  ]);

  // Credential-shaped names. Deliberately broad — a false positive costs
  // one line in REVIEWED_READABLE, a false negative costs a leaked secret.
  const CREDENTIAL_SHAPED =
    /(^|_)(password|passwd|secret|token|credential|apikey|api_key|private_key|secret_key|otp|code_hash|token_hash|value_enc|_enc)($|_)|^(code|user_code|value_enc|registration_enc)$|_enc$|_token$|_token_hash$|_hash$/;

  // Columns whose NAME looks like a credential but whose VALUE is not one.
  // Each is a reviewed decision; the comment is the reason.
  const REVIEWED_READABLE = new Set([
    // Public/derived identifiers and non-secret metadata.
    'apps.storage_bucket',                 // bucket NAME, not a key
    'mcp_authorization_codes.code_challenge', // the public half of PKCE
    'mcp_clients.client_id',               // public OAuth client identifier
    'mcp_tokens.client_id',
    'mcp_authorization_codes.client_id',
    'mcp_auth_audit_events.client_id',
    'cli_device_authorizations.client_id',
    'cli_access_tokens.client_id',
    'cli_auth_audit_events.client_id',
    'mobile_push_deliveries.last_error_code', // an FCM error code string
    'cli_auth_rate_limits.bucket_key',     // a hash of a rate-limit bucket, not a credential
    'cli_auth_rate_limits.tokens',         // leaky-bucket token COUNT
    'mcp_connector_hints.last_token_id',   // an mcp_tokens.id row id — the setup-hint throttle key, no token material
    'cli_access_tokens.scopes',
    'chat_sessions.handoff_request_fingerprint', // a non-reversible request digest
    'sessions.native_session_credential_reference', // public opaque reference, never bearer/cookie material

    // Foreign keys TO a credential row. The id is a row number; the secret
    // itself lives in a column that IS denied (or, for user_ai_credentials,
    // in a schema this console cannot see at all).
    'cli_auth_audit_events.access_token_id',
    'session_agent_leases.access_token_id',
    'mcp_auth_audit_events.access_token_id',
    'agent_turns.credential_id',
    'agent_turns.credential_revision',     // an INTEGER version counter

    // Content digests and chain data. `_hash` is in the pattern above
    // because credential hashes are the common case, but these hash
    // CONTENT, not secrets, and several are public by design.
    'session_visuals.commit_hash',         // a git commit sha
    'chains.block_hash',                   // public chain data
    'slot_outcome_reports.block_hash',      // public chain data
    'vrf_obligations.sender_pk_hash',      // a PUBLIC key's digest
    'app_report_ai.input_hash',            // digest of the generation input, for cache reuse
    'app_workshop_themes.input_hash',      // same: digest of the board the themes were grouped from
    'chat_sessions.pr_summary_source_body_hash', // digest of the public PR description, not a credential
    'visual_evidence_runs.plan_hash',      // SHA-256 naming the published shots, not authentication material

    // Counters and flags.
    'chat_session_messages.token_count',   // an LLM token COUNT
    'users.password_set',                  // BOOLEAN: whether one exists
  ]);

  const leaks = [];
  for (const { table, column } of declared) {
    if (NOT_A_COLUMN.has(column)) continue;
    if (!CREDENTIAL_SHAPED.test(column)) continue;
    if (REVIEWED_READABLE.has(`${table}.${column}`)) continue;
    if (scopeMod.isDeniedColumn(table, column)) continue;
    leaks.push(`${table}.${column}`);
  }

  assert.deepEqual(
    leaks, [],
    'These columns have credential-shaped names and are readable through the admin SQL '
    + 'console. For each: add it to db-console-scope.js\'s CONSOLE_CREDENTIAL_COLUMNS (or '
    + 'debug-access.js\'s DENIED_COLUMNS, which both roles share) if it really holds a '
    + 'secret — or to REVIEWED_READABLE in this test, with a reason, if it does not.'
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 2. HTTP-level tests — real router, mock pool
// ═══════════════════════════════════════════════════════════════════════

let scenario;

function handleQuery(sql) {
  const t = sql.trim();
  if (/^BEGIN/i.test(t)) return { rows: [] };
  if (/^SET LOCAL/i.test(t)) return { rows: [] };
  if (/^COMMIT/i.test(t)) return { rows: [] };
  if (/^ROLLBACK/i.test(t)) return { rows: [] };

  // db-console-scope.js's table inventory — the scope resolution that
  // both the schema endpoint and the role's grants start from. Matched
  // BEFORE the plain information_schema.columns branch below, because it
  // reads that view too (joined against information_schema.tables) and
  // returns a different row shape: `{ table, columns: [...] }`.
  if (/BASE TABLE/.test(t) && /array_agg/.test(t)) return { rows: scenario.inventoryRows || [] };

  // GET /sql-query/schema's two introspection queries.
  if (/pg_class/.test(t) && /reltuples/.test(t)) return { rows: scenario.schemaTableRows || [] };
  if (/information_schema\.columns/.test(t)) return { rows: scenario.schemaColumnRows || [] };

  // GET /database/export's per-table data query.
  const exportMatch = t.match(/^SELECT .+ FROM (\w+) ORDER BY 1$/i);
  if (exportMatch) {
    const table = exportMatch[1];
    if (scenario.failTables && scenario.failTables.has(table)) {
      throw new Error(`synthetic failure for ${table}: contains an internal detail that must never reach the client`);
    }
    return { rows: (scenario.rowsByTable && scenario.rowsByTable[table]) || [] };
  }

  // POST /sql-query/execute's wrapped console query.
  if (/_topochain_console_q/.test(t)) {
    if (scenario.executeThrows) throw scenario.executeThrows;
    const rows = scenario.executeRows || [];
    const fields = rows[0] ? Object.keys(rows[0]).map((name) => ({ name })) : [];
    return { rows, fields };
  }

  throw new Error(`Unhandled SQL in mock: ${sql}`);
}

function makeMockPool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) { calls.push(sql); return handleQuery(sql, params); },
    async connect() {
      return {
        async query(sql, params) { calls.push(sql); return handleQuery(sql, params); },
        release() {},
      };
    },
  };
}

function userMiddleware(role) {
  return (req, _res, next) => {
    if (role === 'anon') return next();
    if (role === 'user') { req.user = { id: 900, username: 'plain', isAdmin: false, canAdminWrite: false }; return next(); }
    if (role === 'readonly') { req.user = { id: 901, username: 'ro-admin', isAdmin: true, canAdminWrite: false }; return next(); }
    req.user = { id: 902, username: 'full-admin', isAdmin: true, canAdminWrite: true };
    next();
  };
}

function buildApp(role = 'admin') {
  const app = express();
  app.use(express.json());
  app.use(userMiddleware(role));
  app.use(topochainAdminRoutes({}));
  return app;
}

async function listen(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test.beforeEach(() => {
  scenario = {};
  currentMockPool = makeMockPool();
});

// ── POST /sql-query/execute ─────────────────────────────────────────────

test('execute: a blocked pattern is rejected before ever touching the pool (400, explains itself)', async () => {
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'DELETE FROM seasons' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /SELECT and WITH/);
    assert.equal(body.query, 'DELETE FROM seasons');
    assert.equal(currentMockPool.calls.length, 0, 'validation must short-circuit before any DB round-trip');
  } finally { server.close(); }
});

test('execute: a credential column is rejected with an explanation, at the endpoint (#1130)', async () => {
  // Was `SELECT id, user_id FROM sessions` expecting the table-level
  // message. That query is legitimate now, so the endpoint-level rejection
  // this test exists to cover moved to the COLUMN.
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT token, user_id FROM sessions' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /not accessible through this console/);
    assert.match(body.error, /token/);
    assert.equal(
      currentMockPool.calls.length, 0,
      'validation must short-circuit before any DB round-trip'
    );
  } finally { server.close(); }
});

test('execute: a formerly-denied push table reaches the database (#1130 regression lock)', async () => {
  scenario.executeRows = [
    { environment: 'staging-fixture', status: 'sent', attempts: 1, last_error_code: null },
  ];
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `SELECT d.environment, d.status, d.attempts, d.last_error_code
                  FROM mobile_push_deliveries d
                  LEFT JOIN mobile_push_registrations r ON r.id = d.registration_id`,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data, [
      { environment: 'staging-fixture', status: 'sent', attempts: 1, last_error_code: null },
    ]);
  } finally { server.close(); }
});

test('execute: an in-scope platform table is accepted (the widened scope reaches the endpoint, not just the validator)', async () => {
  scenario.executeRows = [{ id: 1, slug: 'demo' }];
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT id, slug FROM apps' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data, [{ id: 1, slug: 'demo' }]);
  } finally { server.close(); }
});

test('execute: a valid SELECT runs inside BEGIN TRANSACTION READ ONLY + SET LOCAL statement_timeout, wrapped with the row cap', async () => {
  scenario.executeRows = [{ id: 1, name: 'Season 1' }];
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT id, name FROM seasons' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data, [{ id: 1, name: 'Season 1' }]);
    assert.deepEqual(body.columns, ['id', 'name']);
    assert.equal(body.row_count, 1);
    assert.equal(body.limited, false);
    assert.equal(typeof body.execution_time_ms, 'number');
    assert.equal(body.query, 'SELECT id, name FROM seasons');

    assert.ok(currentMockPool.calls.some((c) => /^BEGIN TRANSACTION READ ONLY/i.test(c.trim())));
    assert.ok(currentMockPool.calls.some((c) => /^SET LOCAL statement_timeout/i.test(c.trim())));
    assert.ok(currentMockPool.calls.some((c) => c.includes('_topochain_console_q') && c.includes('LIMIT 101')));

    // BYPASS regression coverage (mock-pool level, as required by the
    // fix ruling): SET LOCAL ROLE <the console role> is issued, and
    // BEFORE the user's wrapped query runs — this is the actual
    // security boundary now (see sql-console.js's header), not a
    // detail that's merely nice to have in the right order.
    const roleIdx = currentMockPool.calls.findIndex((c) => new RegExp(`^SET LOCAL ROLE ${consoleRoleMod.ROLE}\\b`, 'i').test(c.trim()));
    const queryIdx = currentMockPool.calls.findIndex((c) => c.includes('_topochain_console_q'));
    assert.notEqual(roleIdx, -1, 'SET LOCAL ROLE must be issued');
    assert.ok(roleIdx < queryIdx, 'SET LOCAL ROLE must run BEFORE the wrapped user query');

    // Always ROLLBACK (never COMMIT) even on the happy path — nothing
    // to persist, and this is what makes the role switch transaction-
    // local (reverts either way, but ROLLBACK is the deliberately
    // inert choice — see runConsoleQuery's own comment).
    assert.ok(currentMockPool.calls.some((c) => /^ROLLBACK/i.test(c.trim())));
    assert.ok(!currentMockPool.calls.some((c) => /^COMMIT/i.test(c.trim())));
  } finally { server.close(); }
});

test('execute: the SQL console degrades to 503 (never runs unscoped) if the console role failed to bootstrap', async () => {
  scenario.executeRows = [{ id: 1 }];
  const original = consoleRoleMod.isAvailable;
  consoleRoleMod.isAvailable = () => false;
  consoleRoleMod.unavailableReason = () => 'topochain console role bootstrap failed: simulated boot failure';
  try {
    const { server, base } = await listen(buildApp('admin'));
    try {
      const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'SELECT id FROM seasons' }),
      });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.code, 'console_unavailable');
      // Never ran the query unscoped: no BEGIN/SET ROLE/wrapped-query
      // calls should have reached the pool at all.
      assert.equal(currentMockPool.calls.length, 0);
    } finally { server.close(); }
  } finally {
    consoleRoleMod.isAvailable = original;
    consoleRoleMod.unavailableReason = () => null;
  }
});

test('execute: row cap enforcement — cap+1 rows come back limited and sliced to the cap', async () => {
  scenario.executeRows = Array.from({ length: 3 }, (_, i) => ({ id: i }));
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT id FROM seasons', limit: 2 }),
    });
    const body = await res.json();
    assert.equal(body.limited, true);
    assert.equal(body.row_count, 2);
    assert.equal(body.data.length, 2);
    assert.ok(currentMockPool.calls.some((c) => c.includes('LIMIT 3')));
  } finally { server.close(); }
});

test('execute: a raw driver error is never echoed to the client', async () => {
  scenario.executeThrows = new Error('relation "top_secret_internal_table" leaked column names and a stack trace');
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT id FROM seasons' }),
    });
    assert.equal(res.status, 400);
    const raw = await res.text();
    assert.doesNotMatch(raw, /top_secret_internal_table/);
    assert.doesNotMatch(raw, /stack trace/);
    const body = JSON.parse(raw);
    assert.equal(body.success, false);
    assert.equal(body.error, 'Query failed.');
    assert.equal(body.query, 'SELECT id FROM seasons');
    assert.ok(currentMockPool.calls.some((c) => /^ROLLBACK/i.test(c.trim())), 'a failed query must roll back');
  } finally { server.close(); }
});

test('execute: base validation (missing query, oversized query, out-of-range limit) is 422', async () => {
  const { server, base } = await listen(buildApp('admin'));
  try {
    const missing = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(missing.status, 422);

    const tooLong = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT ' + '1'.repeat(10001) }),
    });
    assert.equal(tooLong.status, 422);

    const badLimit = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1', limit: 1001 }),
    });
    assert.equal(badLimit.status, 422);
  } finally { server.close(); }
});

test('execute: a view-only (readonly) admin CAN execute — it is read-only by construction', async () => {
  scenario.executeRows = [{ ok: 1 }];
  const { server, base } = await listen(buildApp('readonly'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1 AS ok FROM seasons' }),
    });
    assert.equal(res.status, 200);
  } finally { server.close(); }
});

test('execute: a non-admin gets the platform 403, never reaching the console', async () => {
  const { server, base } = await listen(buildApp('user'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'SELECT 1 FROM seasons' }),
    });
    assert.equal(res.status, 403);
  } finally { server.close(); }
});

// ── GET /sql-query/schema ───────────────────────────────────────────────

test('schema: shape per SPEC, real row estimate (not a lifetime counter), every in-scope table present and alphabetical', async () => {
  // The inventory the scope is resolved from: platform tables and
  // topochain tables side by side, plus the credential-bearing ones —
  // which are LISTED now (#1130) with their credential columns filtered
  // out by the service itself (the mock is not what filters them).
  scenario.inventoryRows = [
    { table: 'seasons', columns: ['id', 'name'] },
    { table: 'apps', columns: ['id', 'slug', 'db_password'] },
    { table: 'chat_sessions', columns: ['id', 'title'] },
    { table: 'events', columns: ['id', 'event_type'] },
    { table: 'chains', columns: ['id'] },
    { table: 'onchain_accounts', columns: ['id', 'tier', 'secret_key', 'registration_code'] },
    { table: 'sessions', columns: ['token', 'user_id'] },
    { table: 'mobile_otp_codes', columns: ['email', 'code_hash'] },
    { table: 'mobile_push_deliveries', columns: ['id', 'status', 'attempts'] },
  ];
  scenario.schemaTableRows = [{ name: 'seasons', comment: null, estimated_rows: 42.4 }];
  scenario.schemaColumnRows = [
    { table_name: 'seasons', column_name: 'id', data_type: 'bigint', nullable: false, default_value: null, comment: null, key_type: 'primary' },
    { table_name: 'seasons', column_name: 'name', data_type: 'character varying', nullable: false, default_value: null, comment: null, key_type: null },
    // A row simulating what the raw information_schema.columns query
    // WOULD return for onchain_accounts' two secret columns — the
    // service itself must filter these out; the mock is not what does
    // the filtering (see db-schema-info.js's `isDeniedColumn`).
    { table_name: 'onchain_accounts', column_name: 'secret_key', data_type: 'character varying', nullable: false, default_value: null, comment: null, key_type: null },
    { table_name: 'onchain_accounts', column_name: 'registration_code', data_type: 'character varying', nullable: false, default_value: null, comment: null, key_type: 'unique' },
    { table_name: 'onchain_accounts', column_name: 'tier', data_type: 'character varying', nullable: false, default_value: null, comment: null, key_type: null },
    // #1130: the same filtering, on a table that used to be dropped
    // wholesale. `sessions` is LISTED now, so the schema browser must not
    // show `token` in its column list — otherwise it would advertise a
    // column every drafted `SELECT` then gets rejected for.
    { table_name: 'sessions', column_name: 'token', data_type: 'character varying', nullable: false, default_value: null, comment: null, key_type: 'primary' },
    { table_name: 'sessions', column_name: 'user_id', data_type: 'integer', nullable: true, default_value: null, comment: null, key_type: 'foreign' },
    { table_name: 'mobile_push_deliveries', column_name: 'status', data_type: 'character varying', nullable: false, default_value: null, comment: null, key_type: null },
    { table_name: 'mobile_push_deliveries', column_name: 'attempts', data_type: 'integer', nullable: false, default_value: null, comment: null, key_type: null },
  ];
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/schema`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    // EVERY table in the inventory — nothing dropped (#1130).
    const names = body.data.map((t) => t.name);
    assert.deepEqual(names, [
      'apps', 'chains', 'chat_sessions', 'events', 'mobile_otp_codes',
      'mobile_push_deliveries', 'onchain_accounts', 'seasons', 'sessions',
    ]);
    // Alphabetical, so a ~108-entry list is scannable — and stable
    // regardless of the order Postgres answered in.
    assert.deepEqual(names, [...names].sort());
    // The non-topochain tables are the point of the first widening.
    for (const platformTable of ['apps', 'chat_sessions', 'events']) {
      assert.ok(names.includes(platformTable), `${platformTable} must be listed`);
    }
    // INVERTED BY #1130: these two used to be asserted ABSENT. They are
    // listed now, because hiding the table is not what protects the
    // secret — the column-level grant is.
    for (const formerlyDenied of ['sessions', 'mobile_otp_codes', 'mobile_push_deliveries']) {
      assert.ok(names.includes(formerlyDenied), `${formerlyDenied} must be listed now`);
    }

    // …and the schema browser must not ADVERTISE the masked column, or an
    // admin clicking the table drafts a SELECT that then 400s.
    const sessions = body.data.find((t) => t.name === 'sessions');
    assert.ok(!sessions.columns.some((c) => c.name === 'token'), 'sessions.token must be hidden');
    assert.deepEqual(sessions.columns.map((c) => c.name), ['user_id']);

    // A formerly-denied table with no credential at all keeps every column.
    const deliveries = body.data.find((t) => t.name === 'mobile_push_deliveries');
    assert.deepEqual(deliveries.columns.map((c) => c.name), ['status', 'attempts']);

    const seasons = body.data.find((t) => t.name === 'seasons');
    assert.equal(seasons.estimated_rows, 42); // rounded, and NOT a lifetime write counter
    assert.equal(seasons.columns.length, 2);
    assert.deepEqual(seasons.columns[0], {
      name: 'id', type: 'bigint', nullable: false, default_value: null, comment: null, key_type: 'primary',
    });

    const untouched = body.data.find((t) => t.name === 'chains');
    assert.equal(untouched.estimated_rows, 0);
    assert.deepEqual(untouched.columns, []);

    const onchainAccounts = body.data.find((t) => t.name === 'onchain_accounts');
    assert.ok(!onchainAccounts.columns.some((c) => c.name === 'secret_key'));
    assert.ok(!onchainAccounts.columns.some((c) => c.name === 'registration_code'));
    assert.ok(onchainAccounts.columns.some((c) => c.name === 'tier'));
  } finally { server.close(); }
});

// ── GET /sql-query/templates ─────────────────────────────────────────────

test('templates: HTTP endpoint returns the eight static templates', async () => {
  const { server, base } = await listen(buildApp('readonly'));
  try {
    const res = await fetch(`${base}/api/v4/admin/sql-query/templates`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.length, 8);
    for (const t of body.data) {
      assert.equal(typeof t.name, 'string');
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.query, 'string');
    }
  } finally { server.close(); }
});

// ── GET /database/export ─────────────────────────────────────────────────

test('export: a view-only admin is refused (write gate — matches the platform export\'s full-admin-only posture)', async () => {
  const { server, base } = await listen(buildApp('readonly'));
  try {
    const res = await fetch(`${base}/api/v4/admin/database/export`);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { success: false, error: 'Full admin access required.' });
  } finally { server.close(); }
});

test('export: a full admin downloads a SQL file that excludes secret columns and the two denied tables entirely', async () => {
  scenario.rowsByTable = {
    onchain_accounts: [{
      id: 5, amount: 100, identity_uid: 'uid-1', address: 'ut1abc', public_key: 'utpk1abc',
      tier: 'gold', description: null, season_event_id: null, season_id: 1, user_id: 1,
      is_used: false, used_at: null, created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
      // Simulates a row that (hypothetically) still carried the secret
      // fields — proves the leak can't happen even if the query layer
      // ever regresses, since the export only ever reads the columns
      // it asked for.
      secret_key: 'SHOULD_NEVER_LEAK_SECRET', registration_code: 'SHOULD_NEVER_LEAK_CODE',
    }],
  };
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/database/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename="topochain-export-.*\.sql"/);

    const text = await res.text();
    assert.doesNotMatch(text, /SHOULD_NEVER_LEAK_SECRET/);
    assert.doesNotMatch(text, /SHOULD_NEVER_LEAK_CODE/);
    assert.doesNotMatch(text, /CREATE TABLE IF NOT EXISTS mobile_otp_codes/);
    assert.doesNotMatch(text, /CREATE TABLE IF NOT EXISTS mobile_auth_tokens/);

    // Isolate onchain_accounts' own CREATE TABLE + INSERT section (the
    // header comment ABOVE this legitimately names the two excluded
    // columns to document the redaction — that's not a leak, so the
    // exclusion check below is scoped to onchain_accounts' own block,
    // not the whole file).
    const onchainStart = text.indexOf('CREATE TABLE IF NOT EXISTS onchain_accounts');
    const onchainEnd = text.indexOf('-- ── account_delegation_periods');
    assert.ok(onchainStart !== -1 && onchainEnd > onchainStart);
    const onchainSection = text.slice(onchainStart, onchainEnd);
    assert.doesNotMatch(onchainSection, /secret_key/);
    assert.doesNotMatch(onchainSection, /registration_code/);

    // The SQL sent to the pool for onchain_accounts must not even ask
    // for the excluded columns.
    const onchainQuery = currentMockPool.calls.find((c) => /FROM onchain_accounts/.test(c));
    assert.ok(onchainQuery);
    assert.doesNotMatch(onchainQuery, /secret_key/);
    assert.doesNotMatch(onchainQuery, /registration_code/);

    assert.match(text, /CREATE TABLE IF NOT EXISTS seasons \(/);
    assert.match(text, /INSERT INTO onchain_accounts/);
  } finally { server.close(); }
});

test('export: a real row renders as a restorable INSERT plus a sequence setval', async () => {
  scenario.rowsByTable = {
    seasons: [{
      id: 7, name: 'Season Test', description: null,
      starts_at: new Date('2026-01-01T00:00:00Z'), ends_at: new Date('2026-06-01T00:00:00Z'),
      is_active: true, internal: false, display_order: 0, pool_info: null,
      created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
    }],
  };
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/database/export`);
    const text = await res.text();
    assert.match(text, /INSERT INTO seasons \(id, name, description, starts_at, ends_at, is_active, internal, display_order, pool_info, created_at, updated_at\) VALUES \(7, 'Season Test', NULL, '2026-01-01T00:00:00\.000Z', '2026-06-01T00:00:00\.000Z', TRUE, FALSE, 0, NULL, '2026-01-01T00:00:00\.000Z', '2026-01-01T00:00:00\.000Z'\);/);
    assert.match(text, /SELECT setval\('seasons_id_seq', 7, true\);/);
  } finally { server.close(); }
});

test('export: honest failure — a mid-stream error still returns 200 (headers already committed) but ends with a visible marker line, and never continues to later tables', async () => {
  scenario.failTables = new Set(['chains']);
  const { server, base } = await listen(buildApp('admin'));
  try {
    const res = await fetch(`${base}/api/v4/admin/database/export`);
    assert.equal(res.status, 200); // the 200 was already committed before the failure
    const text = await res.text();

    // Tables ordered BEFORE 'chains' got their DDL written.
    assert.match(text, /CREATE TABLE IF NOT EXISTS seasons \(/);
    assert.match(text, /CREATE TABLE IF NOT EXISTS chains \(/); // chains' own DDL is written before its data query runs

    // The marker line is present and visible (not a silently truncated file).
    assert.match(text, /^-- EXPORT FAILED: .*chains/m);

    // Nothing after 'chains' in QUERYABLE_TABLES order was reached.
    const chainsIdx = QUERYABLE_TABLES.indexOf('chains');
    for (const later of QUERYABLE_TABLES.slice(chainsIdx + 1)) {
      assert.doesNotMatch(text, new RegExp(`CREATE TABLE IF NOT EXISTS ${later} \\(`));
    }
  } finally { server.close(); }
});
