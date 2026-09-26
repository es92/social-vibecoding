'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
const debugAccess = require('../src/services/debug-access');
const dbExport = require('../src/services/db-export');
const { CATEGORY_DEFINITIONS } = require('../src/services/mobile-push-preferences');

const PRIVATE_TABLES = [
  'mobile_push_deployment_state',
  'mobile_push_installation_mutations',
  'mobile_push_registrations',
  'mobile_push_registration_events',
  'mobile_push_deliveries',
];

test('push schema keeps deployment and user device state private with bounded expiry', () => {
  for (const table of PRIVATE_TABLES) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
    assert.match(schema, new RegExp(`COMMENT ON TABLE ${table} IS 'staging:private'`));
    assert.ok(debugAccess.DENIED_TABLES.has(table));
    assert.ok(dbExport.EXCLUDED_TABLE_DATA.includes(table));
  }
  const registrations = schema.match(
    /CREATE TABLE IF NOT EXISTS mobile_push_registrations \([\s\S]*?\n\);/
  )?.[0];
  assert.ok(registrations, 'push registration table exists');
  assert.match(registrations, /user_id\s+INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(registrations, /session_expires_at TIMESTAMPTZ NOT NULL/);
  assert.doesNotMatch(registrations, /mobile_auth_token_id/);
  assert.match(registrations, /native_session_credential_reference VARCHAR\(47\) NOT NULL/);
  assert.match(schema,
    /mobile_push_registrations_native_credential_required_check[\s\S]*CHECK \(native_session_credential_reference IS NOT NULL\) NOT VALID/);
  assert.match(schema,
    /mobile_push_registrations_native_credential_user_fk[\s\S]*FOREIGN KEY \(native_session_credential_reference, user_id\)[\s\S]*REFERENCES native_session_credentials\(credential_reference, user_id\)/);
  assert.match(schema, /registration_id[\s\S]*ON DELETE SET NULL/);
  assert.match(schema, /platform\s+VARCHAR\(16\) CHECK \(platform IN \('android', 'ios'\)\)/,
    'delivery rows snapshot their platform before invalid registrations are deleted');
  assert.match(schema, /SET platform = registration\.platform[\s\S]*delivery\.platform IS NULL/,
    'existing live registrations backfill the diagnostic platform snapshot');
  assert.match(
    schema,
    /idx_mobile_push_deliveries_registration[\s\S]*ON mobile_push_deliveries \(registration_id\)/
  );
  assert.match(schema, /UNIQUE \(notification_id, environment, installation_id\)/);
  assert.match(schema, /CHECK \(NOT send_enabled OR send_not_before IS NOT NULL\)/);
});

test('registration lifecycle history is transient and contains no provider secret', () => {
  const table = schema.match(
    /CREATE TABLE IF NOT EXISTS mobile_push_registration_events \([\s\S]*?\n\);/
  )?.[0];
  assert.ok(table, 'registration event table exists');
  assert.match(table, /registration_id\s+BIGINT,/,
    'the deleted registration id is retained only as a scalar');
  assert.doesNotMatch(table, /registration_id\s+BIGINT\s+REFERENCES/);
  assert.doesNotMatch(table,
    /^\s*(?:registration_(?:enc|hash)|provider_token|raw_token|ciphertext|credential)\s/m);
  for (const kind of [
    'registration_created', 'registration_updated', 'token_replaced',
    'registration_reassigned', 'client_unregistered', 'provider_invalidated',
    'registration_corrupt', 'session_expired', 'firebase_project_reset',
  ]) {
    assert.match(table, new RegExp(`'${kind}'`), `${kind} is a closed event kind`);
  }
  for (const reason of [
    'client_request', 'notifications_disabled', 'permission_denied',
    'signed_out', 'account_changed', 'identity_boundary', 'terminal_reset',
    'configuration_unavailable', 'installation_reassigned', 'token_reassigned',
    'messaging/invalid-recipient', 'messaging/invalid-registration-token',
    'messaging/mismatched-credential',
    'messaging/registration-token-not-registered',
    'registration_decrypt_failed', 'mobile_session_expired',
    'firebase_project_changed',
  ]) {
    assert.match(table, new RegExp(`'${reason.replace('/', '\\/')}'`),
      `${reason} is a closed reason code`);
  }
  assert.match(table, /reason_code IS NULL OR reason_code IN/,
    'arbitrary diagnostic text cannot be stored');
  assert.match(schema,
    /idx_mobile_push_registration_events_user[\s\S]*user_id, created_at DESC, id DESC/);
  assert.match(schema,
    /idx_mobile_push_registration_events_retention[\s\S]*created_at, id/);
});

test('closed database kind registry matches the reviewed service mapping and defaults', () => {
  const seed = schema.match(
    /INSERT INTO mobile_push_kind_categories \(kind, category, default_enabled\) VALUES([\s\S]*?)ON CONFLICT \(kind\)/
  )?.[1];
  assert.ok(seed, 'closed kind/category seed exists');
  const rows = [...seed.matchAll(/\('([^']+)', '([^']+)', (TRUE|FALSE)\)/g)].map((match) => ({
    kind: match[1], category: match[2], defaultEnabled: match[3] === 'TRUE',
  }));
  const expected = CATEGORY_DEFINITIONS.flatMap((category) => category.kinds.map((kind) => ({
    kind, category: category.key, defaultEnabled: category.defaultEnabled,
  })));
  assert.deepEqual(rows, expected);
  // 22 → 27: #1374's five (proposal_vote, pr_merged, vote_digest,
  // issue_opened, app_health); 27 → 29: #1688's two (revision_recheck,
  // weekly_digest); 29 → 31: #2386's two (friend_request, friend_accept).
  // The deepEqual above is the real assertion; this count is
  // the guard against the seed and the service policy drifting by an
  // equal-and-opposite edit that leaves both lists the same length.
  // 31 → 33: #2387's two — conversation_thread_reply (under messages) and
  // thread_reply (an app-chat reply-thread reply, direct_interactions).
  // 33 → 35: #3181's session_stalled (developer_sessions) and
  // platform_limit (server-wide cap alerts, app_alerts).
  assert.equal(new Set(rows.map((row) => row.kind)).size, 35);
  assert.match(schema, /DELETE FROM mobile_push_kind_categories[\s\S]*kind NOT IN/,
    'stale policy rows cannot silently keep a removed kind push-enabled');
});

test('notification trigger checks the current account category before enqueueing', () => {
  const body = schema.match(
    /CREATE OR REPLACE FUNCTION enqueue_mobile_push_deliveries\(\)[\s\S]*?END;\n\$\$;/
  )?.[0];
  assert.ok(body, 'enqueue function exists');
  assert.match(body, /FROM mobile_push_kind_categories policy/);
  assert.match(body, /LEFT JOIN mobile_push_preferences preference/);
  assert.match(body, /preference\.user_id = NEW\.user_id/);
  assert.match(body, /preference\.category = policy\.category/);
  assert.match(body, /policy\.kind = NEW\.kind/);
  assert.match(body, /COALESCE\(preference\.enabled, policy\.default_enabled\)/);
  assert.match(body, /permission_status IN \('authorized', 'provisional'\)/);
  assert.match(body, /JOIN mobile_push_deployment_state s ON s\.environment = r\.environment/);
  assert.match(body, /s\.send_enabled/);
  assert.match(body, /NEW\.created_at[\s\S]*>= s\.send_not_before/);
  assert.match(body, /r\.user_id = NEW\.user_id/);
  assert.match(body, /r\.session_expires_at > NOW\(\)/);
  assert.match(body, /SELECT r\.id, r\.environment, r\.installation_id, r\.platform/);
  assert.match(body,
    /notification_id, registration_id, environment, installation_id, platform, expires_at/);
  assert.match(schema, /AFTER INSERT ON notifications/);
  const stateLock = body.indexOf('FROM mobile_push_deployment_state');
  const registrationLock = body.indexOf('FOR KEY SHARE OF r');
  assert.ok(stateLock >= 0 && stateLock < registrationLock,
    'deployment state is locked before registration rows');
});

test('no old handoff/provider-control tables were reintroduced', () => {
  assert.doesNotMatch(schema, /mobile_web_session_handoffs/);
  assert.doesNotMatch(schema, /mobile_push_provider_state/);
  assert.doesNotMatch(schema, /push_mutation_fingerprint|provider_attempted|canary/);
});
