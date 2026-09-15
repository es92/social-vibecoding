// Topochain schema — the 21 tables migrated from SPEC §3.4 plus the new
// `mobile_auth_tokens` table (plan Global Constraints #4).
//
// Topochain (testnet competition: seasons → events → challenges,
// block-production scoring, leaderboard) becomes a native part of this
// platform. This test is a static, no-database assertion over the SQL
// text appended to schema.sql: every table exists as
// `CREATE TABLE IF NOT EXISTS` (idempotent), the four partial unique
// indexes and two replay-protection indexes exist verbatim, the
// registration_code unique exists, the custom max(bytea) aggregate is
// guarded, and every timestamp column in the new block is TIMESTAMPTZ
// (never plain TIMESTAMP).
//
// Static assertions on the SQL source — no database required.
//
// Run with: node --test tests/topochain-schema.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'src/db/schema.sql'), 'utf8');

// Isolate the topochain block so column-count / TIMESTAMP spot-checks
// can't accidentally match unrelated platform tables earlier in the file.
const blockStart = schema.indexOf('Topochain (testnet competition) — SPEC §3.4 schema');
assert.ok(blockStart > 0, 'the topochain schema block header exists');
// Later sections (mobile push notifications from #844, then the
// onboarding-flow-alignment block) follow the topochain block in
// schema.sql; bound the slice at whichever header comes first so the
// table-count and TIMESTAMPTZ pins below keep asserting over the
// topochain block alone.
const blockEnd = [
  schema.indexOf('Mobile push notifications —', blockStart),
  schema.indexOf('Onboarding flow alignment —', blockStart),
].filter((i) => i > 0).reduce((a, b) => Math.min(a, b), Infinity);
const block = Number.isFinite(blockEnd)
  ? schema.slice(blockStart, blockEnd) : schema.slice(blockStart);

// Extracts the full `CREATE TABLE IF NOT EXISTS <name> ( ... );` text for
// one table, so column assertions can't bleed across table boundaries.
function tableText(name) {
  const marker = `CREATE TABLE IF NOT EXISTS ${name} (`;
  const start = block.indexOf(marker);
  assert.ok(start >= 0, `schema.sql declares ${name}`);
  const end = block.indexOf(');', start);
  assert.ok(end > start, `${name} has a closing );`);
  return block.slice(start, end + 2);
}

const TABLES = [
  'seasons', 'season_events', 'user_enrollments', 'challenge_kinds',
  'challenge_templates', 'challenges', 'user_activities', 'onchain_accounts',
  'account_delegation_periods', 'leaderboard_snapshots', 'token_allocation',
  'epoch_stats', 'chains', 'vrf_obligations', 'vrf_obligations_sync_state',
  'slot_outcome_reports', 'mobile_logs', 'mobile_otp_codes',
  'app_version_configs', 'terms_versions', 'user_terms_consents',
  'mobile_auth_tokens',
];

// ─── All 22 tables exist, idempotently ─────────────────────────────

test('all 22 topochain tables are declared as CREATE TABLE IF NOT EXISTS', () => {
  assert.equal(TABLES.length, 22, 'the 21 SPEC §3.4 tables plus mobile_auth_tokens');
  for (const name of TABLES) {
    assert.match(block, new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(`),
      `${name} must be created idempotently`);
  }
});

// The 22 tables above plus `challenge_illustrations`, the art admins upload
// from the challenge template form's gallery. It is platform content rather
// than a SPEC §3.4 table, so it is pinned by its own test below instead of
// joining TABLES, whose entries mirror the db tools' allowlist and all carry
// the surrogate keys checked further down.
test('exactly 23 CREATE TABLE statements in this block: the 22 above plus challenge_illustrations', () => {
  const matches = block.match(/CREATE TABLE IF NOT EXISTS/g) || [];
  assert.equal(matches.length, 23);
});

// ─── Dependency order (FK targets declared before their referencing table) ──

test('tables are declared in dependency order', () => {
  const positions = TABLES.map((name) => ({
    name,
    at: block.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`),
  }));
  const at = (name) => positions.find((p) => p.name === name).at;
  assert.ok(at('seasons') < at('season_events'), 'seasons before season_events');
  assert.ok(at('season_events') < at('user_enrollments'), 'season_events before user_enrollments');
  assert.ok(at('challenge_kinds') < at('challenge_templates'), 'challenge_kinds before challenge_templates');
  assert.ok(at('challenge_templates') < at('challenges'), 'challenge_templates before challenges');
  assert.ok(at('challenges') < at('user_activities'), 'challenges before user_activities');
  assert.ok(at('season_events') < at('onchain_accounts'), 'season_events before onchain_accounts');
  assert.ok(at('terms_versions') < at('user_terms_consents'), 'terms_versions before user_terms_consents');
});

// ─── Column presence spot-checks per table ─────────────────────────

test('seasons has every SPEC column', () => {
  const t = tableText('seasons');
  for (const col of ['id', 'name', 'description', 'starts_at', 'ends_at', 'is_active',
    'internal', 'display_order', 'pool_info', 'created_at', 'updated_at']) {
    assert.match(t, new RegExp(`\\b${col}\\b`), `seasons.${col}`);
  }
  assert.match(t, /id\s+BIGSERIAL PRIMARY KEY/);
  assert.match(t, /is_active\s+BOOLEAN NOT NULL DEFAULT TRUE/);
  assert.match(t, /internal\s+BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(t, /display_order\s+INTEGER NOT NULL DEFAULT 0/);
});

test('season_events has every SPEC column including the self-referential FK', () => {
  const t = tableText('season_events');
  for (const col of ['id', 'name', 'description', 'starts_at', 'ends_at', 'is_active',
    'scoring_formula', 'created_at', 'updated_at', 'start_epoch', 'end_epoch', 'internal',
    'disclaimer', 'display_leaderboard', 'score_start_time', 'score_end_time',
    'display_disclaimer', 'chain_id', 'rank_based_on_bp_or_success_rate',
    'display_activities', 'season_id', 'type', 'account_inheritance_mode',
    'account_source_season_event_id']) {
    assert.match(t, new RegExp(`\\b${col}\\b`), `season_events.${col}`);
  }
  assert.match(t, /scoring_formula\s+JSONB NOT NULL/, 'scoring_formula is JSONB and required');
  assert.match(t, /season_id\s+BIGINT REFERENCES seasons\(id\) ON DELETE CASCADE/);
  assert.match(t, /account_source_season_event_id\s+BIGINT REFERENCES season_events\(id\)/,
    'self-referential FK to season_events(id)');
  assert.match(t, /chain_id\s+TEXT,/, 'chain_id stays TEXT — no FK by design');
  assert.match(t, /rank_based_on_bp_or_success_rate\s+VARCHAR\(255\) NOT NULL DEFAULT 'BP'/);
  assert.match(t, /type\s+VARCHAR\(20\) NOT NULL DEFAULT 'regular'/);
  assert.match(t, /account_inheritance_mode\s+VARCHAR\(32\) NOT NULL DEFAULT 'none'/);
});

test('user_enrollments FKs and the season-vs-event partial uniques', () => {
  const t = tableText('user_enrollments');
  assert.match(t, /user_id\s+BIGINT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(t, /season_id\s+BIGINT NOT NULL REFERENCES seasons\(id\) ON DELETE CASCADE/);
  assert.match(t, /season_event_id\s+BIGINT REFERENCES season_events\(id\)/);
  assert.match(t, /registered_at\s+TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP/);
});

test('challenge_kinds PK is a VARCHAR(100) slug', () => {
  const t = tableText('challenge_kinds');
  assert.match(t, /id\s+VARCHAR\(100\) PRIMARY KEY/);
});

test('challenge_templates and challenges both FK `kind` to challenge_kinds', () => {
  const templates = tableText('challenge_templates');
  const challenges = tableText('challenges');
  assert.match(templates, /kind\s+VARCHAR\(100\) REFERENCES challenge_kinds\(id\)/);
  assert.match(challenges, /kind\s+VARCHAR\(100\) REFERENCES challenge_kinds\(id\)/);
  assert.match(challenges, /season_event_id\s+BIGINT NOT NULL REFERENCES season_events\(id\) ON DELETE CASCADE/);
  assert.match(templates, /metric_target\s+NUMERIC\(20,4\)/);
});

// The artwork slug is TEMPLATE-level only. CREATE TABLE IF NOT EXISTS is a
// no-op on a database that already has the table, so the column needs both
// halves: the declaration for a fresh database, and the idempotent ALTER for
// every database migrated before it (migrate.js replays this file each boot).
// tableText() stops at the table's own `);`, so the ALTER is pinned against the
// whole block.
test('challenge_templates.illustration reaches fresh AND existing databases', () => {
  assert.match(tableText('challenge_templates'), /\billustration\s+VARCHAR\(64\)\n\);/,
    'declared as the last column, nullable, sized for a slug');
  assert.match(block,
    /^ALTER TABLE challenge_templates ADD COLUMN IF NOT EXISTS illustration VARCHAR\(64\);$/m);
  assert.doesNotMatch(tableText('challenges'), /\billustration\b/,
    'a challenge has no artwork of its own; it shows its template\'s');
});

// Uploaded challenge artwork. A template names a row by slug (`u-` plus the
// id) in the same `illustration` column, so there is deliberately no foreign
// key in either direction: a missing row draws the kind icon, like a built-in
// slug from another build, and archiving rather than deleting is what keeps a
// named row available. The id doubles as the public file id, hence 32 hex
// characters rather than a BIGSERIAL.
test('challenge_illustrations: declared after the template illustration column, keyed by its file id', () => {
  const t = tableText('challenge_illustrations');
  assert.match(t, /\bid\s+VARCHAR\(32\) PRIMARY KEY/, 'the random 32-hex file id');
  assert.match(t, /\bslug\s+VARCHAR\(64\) NOT NULL UNIQUE/, 'sized like challenge_templates.illustration');
  assert.match(t, /\blabel\s+VARCHAR\(80\) NOT NULL/);
  assert.match(t, /\btone\s+VARCHAR\(16\) NOT NULL/);
  assert.match(t, /\bcontent_type\s+TEXT NOT NULL/);
  assert.match(t, /\bdata\s+BYTEA NOT NULL/);
  assert.match(t, /\barchived\s+BOOLEAN NOT NULL DEFAULT FALSE/, 'archive, never delete');
  assert.match(t, /\bcreated_by\s+INTEGER REFERENCES users\(id\) ON DELETE SET NULL/);
  assert.match(t, /\bcreated_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.doesNotMatch(t, /REFERENCES challenge_templates/);
  assert.doesNotMatch(tableText('challenge_templates'), /REFERENCES challenge_illustrations/);
  assert.ok(block.indexOf('CREATE TABLE IF NOT EXISTS challenge_illustrations (')
    > block.indexOf('ALTER TABLE challenge_templates ADD COLUMN IF NOT EXISTS illustration VARCHAR(64);'));
});

test('challenges.challenge_template_id has no ON DELETE action (RESTRICT/NO ACTION), per SPEC §D4', () => {
  // SPEC §D4 calls the source's cascading template delete "destructive
  // with no guard" (silently wipes every challenge using the template,
  // then their scored user_activities) and requires v4 to REFUSE
  // deletion while challenges still reference it. The FK must therefore
  // default to NO ACTION/RESTRICT, never CASCADE, so a direct DB delete
  // fails closed even if a future API-level guard is bypassed.
  const t = tableText('challenges');
  assert.match(t, /challenge_template_id\s+BIGINT NOT NULL REFERENCES challenge_templates\(id\),/,
    'no ON DELETE clause at all — defaults to NO ACTION');
  assert.ok(!/challenge_template_id[^,]*ON DELETE CASCADE/.test(t),
    'must never cascade: that would silently wipe challenges and their scored history');
});

test('user_activities required columns and the soft (no-FK) added_by column', () => {
  const t = tableText('user_activities');
  assert.match(t, /user_id\s+BIGINT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(t, /season_event_id\s+BIGINT NOT NULL REFERENCES season_events\(id\) ON DELETE CASCADE/);
  assert.match(t, /challenge_id\s+BIGINT NOT NULL REFERENCES challenges\(id\) ON DELETE CASCADE/);
  assert.match(t, /points\s+NUMERIC\(10,2\) NOT NULL DEFAULT 0/);
  assert.match(t, /source\s+VARCHAR\(255\) NOT NULL DEFAULT 'admin_ui'/);
  assert.match(t, /added_by\s+BIGINT,/, 'added_by carries no FK (admins are not migrated)');
  assert.ok(!/added_by\s+BIGINT REFERENCES/.test(t), 'added_by must not gain a FK');
  assert.match(t, /activity_at\s+TIMESTAMPTZ NOT NULL/);
});

test('onchain_accounts: registration_code unique, secret_key present, user_id SET NULL', () => {
  const t = tableText('onchain_accounts');
  assert.match(t, /registration_code\s+VARCHAR\(64\) NOT NULL UNIQUE/, 'registration_code unique');
  assert.match(t, /secret_key\s+VARCHAR\(64\) NOT NULL/);
  assert.match(t, /season_id\s+BIGINT NOT NULL REFERENCES seasons\(id\) ON DELETE CASCADE/);
  assert.match(t, /season_event_id\s+BIGINT REFERENCES season_events\(id\) ON DELETE CASCADE/);
  assert.match(t, /user_id\s+BIGINT REFERENCES users\(id\) ON DELETE SET NULL/,
    'nullable user_id preserves the row (SET NULL, not CASCADE)');
});

test('account_delegation_periods: history model — no FK, no full unique, one OPEN period per account', () => {
  const t = tableText('account_delegation_periods');
  assert.match(t, /account\s+VARCHAR\(255\) NOT NULL/);
  assert.ok(!/account\s+VARCHAR\(255\) NOT NULL UNIQUE/.test(t),
    'the full unique is gone — re-delegation appends a period instead of overwriting');
  assert.ok(!t.includes('REFERENCES'), 'no FK columns at all in this table');
  // The real invariant, as a partial unique index: at most one open
  // period per account, any number of closed historical ones.
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS uq_account_delegation_periods_open\s+ON account_delegation_periods \(account\) WHERE ended_at IS NULL/);
  // Existing databases converge by dropping the old column constraint.
  assert.match(schema, /ALTER TABLE account_delegation_periods DROP CONSTRAINT IF EXISTS account_delegation_periods_account_key/);
});

test('leaderboard_snapshots: extra_points and the plain unique', () => {
  const t = tableText('leaderboard_snapshots');
  assert.match(t, /extra_points\s+NUMERIC\(15,2\) NOT NULL DEFAULT 0/);
  assert.match(t, /UNIQUE \(season_event_id, user_id, snapshot_at\)/);
  assert.match(t, /challenge_details\s+JSONB/);
});

test('token_allocation.updated_by carries no FK (source admins are not migrated)', () => {
  const t = tableText('token_allocation');
  assert.match(t, /updated_by\s+BIGINT,/);
  assert.ok(!/updated_by\s+BIGINT REFERENCES/.test(t));
  assert.match(t, /UNIQUE \(user_id, season_id\)/);
});

test('epoch_stats.user_id is nullable and SET NULL, keeping wallet-only rows', () => {
  const t = tableText('epoch_stats');
  assert.match(t, /user_id\s+BIGINT REFERENCES users\(id\) ON DELETE SET NULL/);
  assert.match(t, /UNIQUE \(chain_id, epoch, wallet_address\)/);
});

test('chains and vrf tables carry no foreign keys at all', () => {
  for (const name of ['chains', 'vrf_obligations', 'vrf_obligations_sync_state']) {
    const t = tableText(name);
    assert.ok(!t.includes('REFERENCES'), `${name} has no FK columns`);
  }
});

test('slot_outcome_reports.user_id is a plain column, no FK, per spec', () => {
  const t = tableText('slot_outcome_reports');
  assert.match(t, /user_id\s+BIGINT,/);
  assert.ok(!/user_id\s+BIGINT REFERENCES/.test(t));
  assert.match(t, /UNIQUE \(chain_id, wallet_address, report_uid\)/);
  assert.ok(!/\bmetric_id\b/.test(t), 'metric_id was dropped (referenced an excluded table)');
});

test('mobile_otp_codes and app_version_configs/terms_versions carry no FKs', () => {
  for (const name of ['mobile_otp_codes', 'app_version_configs', 'terms_versions']) {
    const t = tableText(name);
    assert.ok(!t.includes('REFERENCES'), `${name} has no FK columns`);
  }
  assert.match(tableText('app_version_configs'), /os\s+VARCHAR\(255\) NOT NULL UNIQUE/);
  assert.match(tableText('terms_versions'), /version\s+VARCHAR\(255\) NOT NULL UNIQUE/);
});

test('user_terms_consents FKs and unique', () => {
  const t = tableText('user_terms_consents');
  assert.match(t, /user_id\s+BIGINT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(t, /terms_version_id\s+BIGINT NOT NULL REFERENCES terms_versions\(id\)/);
  assert.match(t, /UNIQUE \(user_id, terms_version_id\)/);
});

test('mobile_auth_tokens matches Global Constraints #4 exactly', () => {
  const t = tableText('mobile_auth_tokens');
  assert.match(t, /id\s+BIGSERIAL PRIMARY KEY/);
  assert.match(t, /user_id\s+BIGINT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(t, /token_hash\s+VARCHAR\(64\) NOT NULL UNIQUE/);
  assert.match(t, /ability\s+VARCHAR\(20\) NOT NULL/);
  assert.match(t, /expires_at\s+TIMESTAMPTZ NOT NULL,/);
  assert.match(t, /last_used_at\s+TIMESTAMPTZ,/);
  assert.match(t, /created_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
});

// ─── Partial unique indexes (SPEC keys) ────────────────────────────

test('user_enrollments has both partial uniques (season-wide vs per-event)', () => {
  assert.match(block,
    /CREATE UNIQUE INDEX IF NOT EXISTS user_enrollments_user_season_event_unique\s+ON user_enrollments \(user_id, season_event_id\) WHERE season_event_id IS NOT NULL;/);
  assert.match(block,
    /CREATE UNIQUE INDEX IF NOT EXISTS user_enrollments_user_season_unique\s+ON user_enrollments \(user_id, season_id\) WHERE season_event_id IS NULL;/);
});

test('onchain_accounts has both partial uniques (season-wide vs per-event public_key)', () => {
  assert.match(block,
    /CREATE UNIQUE INDEX IF NOT EXISTS onchain_accounts_season_event_public_key_unique\s+ON onchain_accounts \(season_event_id, public_key\) WHERE season_event_id IS NOT NULL;/);
  assert.match(block,
    /CREATE UNIQUE INDEX IF NOT EXISTS onchain_accounts_season_public_key_unique\s+ON onchain_accounts \(season_id, public_key\) WHERE season_event_id IS NULL;/);
});

test('onchain_accounts enforces 0..1 season-scoped account per (user, season); legacy event-scoped rows are exempt', () => {
  assert.match(block,
    /CREATE UNIQUE INDEX IF NOT EXISTS onchain_accounts_user_season_unique\s+ON onchain_accounts \(user_id, season_id\)\s+WHERE user_id IS NOT NULL AND season_event_id IS NULL;/);
});

// ─── Replay-protection indexes (SPEC §4.10, restoring dropped completion tables) ──

test('the two user_activities anti-replay partial unique indexes exist verbatim', () => {
  assert.match(block,
    /CREATE UNIQUE INDEX IF NOT EXISTS user_activities_completion_unique\s+ON user_activities \(user_id, challenge_id\)\s+WHERE metadata->>'kind' = 'challenge_completion';/);
  assert.match(block,
    /CREATE UNIQUE INDEX IF NOT EXISTS user_activities_nullifier_unique\s+ON user_activities \(challenge_id, \(metadata->>'nullifier_hex'\)\)\s+WHERE metadata->>'nullifier_hex' IS NOT NULL;/);
});

// ─── max(bytea) aggregate guard ─────────────────────────────────────

test('a bytea_larger helper and a guarded max(bytea) aggregate exist', () => {
  assert.match(block, /CREATE OR REPLACE FUNCTION bytea_larger\(a BYTEA, b BYTEA\) RETURNS BYTEA AS \$\$/);
  assert.match(block, /LANGUAGE SQL IMMUTABLE/);
  const guardStart = block.indexOf('DO $$', block.indexOf('bytea_larger'));
  assert.ok(guardStart > 0, 'a DO $$ guard follows the helper function');
  const guardEnd = block.indexOf('END $$;', guardStart);
  const guard = block.slice(guardStart, guardEnd);
  assert.match(guard, /IF NOT EXISTS \(/, 'guarded by an existence check');
  assert.match(guard, /pg_aggregate/);
  assert.match(guard, /pg_proc/);
  assert.match(guard, /proname = 'max' AND t\.typname = 'bytea'/);
  assert.match(guard, /CREATE AGGREGATE max\(BYTEA\) \(/);
  assert.match(guard, /SFUNC = bytea_larger/);
  assert.match(guard, /STYPE = BYTEA/);
});

// ─── Idempotency shape ──────────────────────────────────────────────

test('every index in the new block is created with IF NOT EXISTS', () => {
  const indexStatements = block.match(/CREATE (?:UNIQUE )?INDEX[^;]*;/g) || [];
  assert.ok(indexStatements.length > 20, 'the block declares a substantial number of indexes');
  for (const stmt of indexStatements) {
    assert.match(stmt, /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/, `not idempotent: ${stmt.slice(0, 80)}`);
  }
});

test('no bare CREATE INDEX / CREATE TABLE without IF NOT EXISTS in the new block', () => {
  assert.ok(!/CREATE INDEX(?! IF NOT EXISTS)/.test(block));
  assert.ok(!/CREATE UNIQUE INDEX(?! IF NOT EXISTS)/.test(block));
  assert.ok(!/CREATE TABLE(?! IF NOT EXISTS)/.test(block));
});

test('index names follow idx_<table>_<cols> convention', () => {
  const plainIndexNames = [...block.matchAll(/CREATE INDEX IF NOT EXISTS (\w+) ON (\w+)/g)];
  assert.ok(plainIndexNames.length > 20);
  for (const [, indexName, tableName] of plainIndexNames) {
    assert.ok(indexName.startsWith(`idx_${tableName}_`),
      `${indexName} on ${tableName} should start with idx_${tableName}_`);
  }
});

// SQL-only view of the block: strips `--` comment lines so prose (which
// legitimately talks about "JSON→JSONB" migrations, or the
// CURRENT_TIMESTAMP keyword) can't be mistaken for a type declaration.
const sqlOnly = block
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

test('no bare TIMESTAMP (without time zone) columns in the new block', () => {
  // TIMESTAMPTZ itself contains the substring "TIMESTAMP", and the
  // CURRENT_TIMESTAMP keyword is a legitimate default value (not a type),
  // so only reject a bare "TIMESTAMP" that is neither of those.
  assert.ok(!/(?<!CURRENT_)TIMESTAMP(?!TZ)\b/.test(sqlOnly),
    'every timestamp column must be TIMESTAMPTZ');
});

test('every JSON-shaped column in the new block is JSONB, never JSON', () => {
  for (const col of ['scoring_formula', 'metadata', 'raw', 'payload', 'challenge_details']) {
    const re = new RegExp(`${col}\\s+JSONB\\b`);
    assert.match(sqlOnly, re, `${col} must be JSONB`);
  }
  assert.ok(!/\bJSON\b(?!B)/.test(sqlOnly), 'no bare JSON columns remain (JSONB only)');
});

test('spot-check: every surrogate PK in the new block is BIGSERIAL (except the two documented exceptions)', () => {
  // Every table except challenge_kinds and vrf_obligations_sync_state
  // uses a BIGSERIAL surrogate `id` PK.
  const surrogateTables = TABLES.filter(
    (n) => n !== 'challenge_kinds' && n !== 'vrf_obligations_sync_state'
  );
  assert.ok(surrogateTables.length >= 19);
  for (const name of surrogateTables) {
    assert.match(tableText(name), /id\s+BIGSERIAL PRIMARY KEY/, `${name}.id is BIGSERIAL`);
  }
  // challenge_kinds.id is a VARCHAR(100) slug PK per SPEC.
  assert.match(tableText('challenge_kinds'), /id\s+VARCHAR\(100\) PRIMARY KEY/);
  // vrf_obligations_sync_state.chain_id is a VARCHAR(64) PK (one cursor row per chain).
  assert.match(tableText('vrf_obligations_sync_state'), /chain_id\s+VARCHAR\(64\) PRIMARY KEY/);
});
