'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cliAuth = require('../src/services/cli-auth');
const constants = require('../src/services/cli-auth-constants');
const routes = require('../src/routes/cli-auth');
const config = require('../src/config');

test('device and access secrets have the exact canonical 256-bit formats', () => {
  for (let i = 0; i < 100; i += 1) {
    const device = cliAuth.makeDeviceCode();
    const access = cliAuth.makeAccessToken();
    assert.equal(device.length, 49);
    assert.equal(access.length, 49);
    assert.match(device, /^svdev_[A-Za-z0-9_-]{43}$/);
    assert.match(access, /^svcli_[A-Za-z0-9_-]{43}$/);
    assert.equal(cliAuth.isCanonicalSecret(device, 'device'), true);
    assert.equal(cliAuth.isCanonicalSecret(access, 'access'), true);
    assert.equal(Buffer.from(device.slice(6), 'base64url').length, 32);
    assert.equal(Buffer.from(access.slice(6), 'base64url').length, 32);
    assert.match(cliAuth.hashSecret(device), /^[0-9a-f]{64}$/);
    assert.equal(cliAuth.tokenHint(access), `svcli_…${access.slice(-4)}`);
  }
  assert.equal(cliAuth.isCanonicalSecret(`svdev_${'A'.repeat(42)}=`, 'device'), false);
  assert.equal(cliAuth.isCanonicalSecret(`svcli_${'A'.repeat(42)}`, 'access'), false);
});

test('user codes use the nonambiguous alphabet and normalize deterministically', () => {
  for (let i = 0; i < 100; i += 1) {
    assert.match(
      cliAuth.makeUserCode(),
      /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/
    );
  }
  assert.equal(cliAuth.canonicalizeUserCode('abcd-efgh'), 'ABCD-EFGH');
  assert.equal(cliAuth.canonicalizeUserCode(' a b c d \n e-f-g-h '), 'ABCD-EFGH');
  assert.equal(cliAuth.canonicalizeUserCode('ABCI-EFGH'), null);
  assert.equal(cliAuth.canonicalizeUserCode('ABCO-EFGH'), null);
  assert.equal(cliAuth.canonicalizeUserCode('A'.repeat(33)), null);
});

test('strict request helpers reject extra state and unsafe bigint identifiers', () => {
  assert.equal(cliAuth.isExactObject({ scopes: [constants.IDENTITY_SCOPE] }, ['scopes']), true);
  assert.equal(cliAuth.isExactObject({ scopes: [], client_id: 'x' }, ['scopes']), false);
  assert.equal(cliAuth.hasExactScopes(constants.REQUIRED_SCOPES), true);
  assert.equal(cliAuth.hasExactScopes([constants.IDENTITY_SCOPE]), false);
  assert.equal(cliAuth.hasExactScopes([]), false);
  assert.equal(cliAuth.hasExactScopes([constants.IDENTITY_SCOPE, constants.IDENTITY_SCOPE]), false);
  assert.equal(cliAuth.parseCanonicalPositiveBigint('1'), '1');
  assert.equal(cliAuth.parseCanonicalPositiveBigint('001'), null);
  assert.equal(cliAuth.parseCanonicalPositiveBigint('0'), null);
  assert.equal(cliAuth.parseCanonicalPositiveBigint('9223372036854775808'), null);
  assert.deepEqual(cliAuth.parseStrictJson('{"outer":{"value":1}}'), {
    outer: { value: 1 },
  });
  assert.throws(
    () => cliAuth.parseStrictJson('{"scopes":[],"scopes":["rpc:identity:read"]}'),
    /duplicate JSON member/
  );
  assert.throws(
    () => cliAuth.parseStrictJson('{"outer":{"x":1,"x":2}}'),
    /duplicate JSON member/
  );
});

test('cursor verification rejects malformed signatures without throwing', () => {
  const malformed = [
    `payload.${'é'.repeat(43)}`,
    `payload.${'A'.repeat(42)}=`,
    `payload.${'A'.repeat(44)}`,
  ];
  for (const cursor of malformed) {
    assert.doesNotThrow(() => routes.decodeCursor({ sessionSecret: 'test-secret' }, cursor));
    assert.equal(routes.decodeCursor({ sessionSecret: 'test-secret' }, cursor), null);
  }
});

function bearerRequest(rawHeaders) {
  return { rawHeaders };
}

test('retained bearer parsing rejects missing, duplicate, joined, and malformed credentials', () => {
  const token = cliAuth.makeAccessToken();
  assert.deepEqual(routes.readBearer(bearerRequest([])), { error: 'missing_token' });
  assert.deepEqual(routes.readBearer(bearerRequest([
    'Authorization', `Bearer ${token}`,
    'authorization', `Bearer ${token}`,
  ])), { error: 'invalid_token' });
  assert.deepEqual(routes.readBearer(bearerRequest([
    'Authorization', `Bearer ${token}, Bearer ${token}`,
  ])), { error: 'invalid_token' });
  assert.deepEqual(routes.readBearer(bearerRequest([
    'Authorization', `Bearer  ${token}`,
  ])), { error: 'invalid_token' });
  assert.deepEqual(routes.readBearer(bearerRequest([
    'Authorization', `Bearer ${token}`,
  ])), { token });
});

test('CLI staging gate surface matching is exact and broad enough', () => {
  for (const requestPath of [
    '/cli/authorize',
    '/api/cli/device/code',
    '/api/cli/rpc/me',
    '/api/me/cli-tokens',
    '/api/me/cli-tokens/42',
  ]) {
    assert.equal(routes.isCliSurface({ path: requestPath }), true, requestPath);
  }
  assert.equal(routes.isCliSurface({ path: '/api/me/cli-tokens-other' }), false);
  assert.equal(routes.isCliSurface({ path: '/cli/authorize/extra' }), false);
});

test('canonical deployment origins reject path, credentials, and insecure remote HTTP', () => {
  assert.equal(
    config.canonicalCliOrigin('HTTPS://EXAMPLE.COM:443/'),
    'https://example.com'
  );
  assert.equal(config.canonicalCliOrigin('https://example.com/path'), null);
  assert.equal(config.canonicalCliOrigin('https://u:p@example.com'), null);
  assert.equal(config.canonicalCliOrigin('http://example.com'), null);
  assert.equal(
    config.canonicalCliOrigin('http://localhost:3000/', { allowLoopbackHttp: true }),
    'http://localhost:3000'
  );
  assert.equal(config.isLoopbackOrigin('http://localhost:3000'), true);
  assert.equal(config.isLoopbackOrigin('https://example.com'), false);
});

test('schema pins credential states, exact lifetimes, privacy, and audit uniqueness', () => {
  const schema = fs.readFileSync(
    path.join(__dirname, '../src/db/schema.sql'),
    'utf8'
  );
  for (const table of [
    'cli_device_authorizations',
    'cli_access_tokens',
    'cli_auth_audit_events',
  ]) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(schema, new RegExp(`COMMENT ON TABLE ${table} IS 'staging:private'`));
  }
  assert.match(schema, /expires_at = created_at \+ INTERVAL '10 minutes'/);
  assert.match(schema, /expires_at = created_at \+ INTERVAL '30 days'/);
  assert.match(schema, /cli_auth_audit_device_transition_uidx/);
  assert.match(schema, /cli_auth_audit_token_transition_uidx/);
  assert.match(schema, /CONSTRAINT cli_auth_audit_events_scopes_check/);
  assert.match(schema, /CONSTRAINT cli_auth_audit_events_metadata_object_check/);
  assert.match(schema, /CONSTRAINT cli_auth_audit_events_metadata_allowlist_check/);
  assert.match(schema, /metadata - ARRAY\['method', 'route'\]::TEXT\[\] = '\{\}'::JSONB/);
  assert.match(
    schema,
    /WHERE conrelid = 'cli_auth_audit_events'::regclass[\s\S]*position\('scopes' IN pg_get_constraintdef\(oid\)\) > 0[\s\S]*DROP CONSTRAINT %I/
  );
  const metadataUpgrade = schema.slice(schema.indexOf(
    '-- CREATE TABLE does not add new constraints to an existing deployment.'
  ), schema.indexOf('-- Shared token-bucket state.'));
  for (const marker of ['POST', 'PUT', 'PATCH', 'DELETE', '/api/%']) {
    assert.ok(
      metadataUpgrade.includes(`position('''${marker}''' IN constraint_def) = 0`),
      `metadata migration must detect a legacy constraint missing ${marker}`
    );
  }
  assert.match(schema, /ON DELETE CASCADE/);
  assert.match(schema, /ON DELETE SET NULL/);
});

test('timestamp parameters used in interval expressions are explicitly typed', () => {
  const authService = fs.readFileSync(
    path.join(__dirname, '../src/services/cli-auth.js'),
    'utf8'
  );
  const authRoutes = fs.readFileSync(
    path.join(__dirname, '../src/routes/cli-auth.js'),
    'utf8'
  );
  assert.match(authService, /\$3::timestamptz \+ INTERVAL '1 day'/);
  assert.match(authRoutes, /\$6::timestamptz \+ INTERVAL '10 minutes'/);
  assert.match(authRoutes, /\$6::timestamptz \+ INTERVAL '30 days'/);
  assert.equal((authRoutes.match(/\$4::timestamptz/g) || []).length, 2);
});

test('server mounts gate and public routes before parsing, browser routes after cookie auth', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const gate = source.indexOf('app.use(cliAuthGate(config))');
  const pre = source.indexOf('app.use(cliPreAuthRoutes(config))');
  const parser = source.indexOf('express.json()(req, res, next)');
  const apiBearer = source.indexOf('app.use(cliApiBearerAuth(config))');
  const auth = source.indexOf('app.use(authMiddleware(config))');
  const browser = source.indexOf('app.use(cliBrowserRoutes(config))');
  assert.ok(gate >= 0 && gate < pre && pre < parser);
  assert.ok(parser < apiBearer && apiBearer < auth && auth < browser);
});

test('approval shell consumes a one-click fragment without leaking it in navigation', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '../public/cli-authorize.html'),
    'utf8'
  );
  const script = fs.readFileSync(
    path.join(__dirname, '../public/js/cli-authorize.js'),
    'utf8'
  );
  assert.doesNotMatch(html, /<script(?![^>]+src=)/);
  assert.match(html, /Approve only if this code matches/);
  assert.match(html, />Authorize<\/button>/);
  assert.doesNotMatch(html, /<input|code-form|Enter the code/);
  assert.match(script, /window\.location\.hash/);
  assert.doesNotMatch(script, /window\.location\.search/);
  assert.match(script, /window\.history\.replaceState\(null, '', '\/cli\/authorize'\)/);
  assert.ok(
    script.indexOf("window.history.replaceState(null, '', '/cli/authorize')")
      < script.indexOf('/api/cli/device/approval?user_code='),
    'the launch fragment must leave browser history before request lookup'
  );
  assert.match(script, /sessionStorage/);
  assert.doesNotMatch(script, /localStorage/);
  assert.match(
    script,
    /const pendingCode = canonicalCode \|\| sessionStorage\.getItem\(STORAGE_KEY\)[\s\S]*lookup\(pendingCode\)/,
    'temporary failures must retry the same request rather than clearing it'
  );
  assert.match(
    script,
    /const initialCode = launched \|\| restored[\s\S]*if \(initialCode\)[\s\S]*lookup\(initialCode\)/,
    'same-tab login return must restore and retry the request'
  );
});

test('Settings exposes only the hint-based CLI credential list and revocation API', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../public/js/settings.js'), 'utf8');
  assert.match(html, /id="cli-tokens-section"/);
  assert.match(script, /\/api\/me\/cli-tokens/);
  assert.match(script, /token_hint/);
  assert.match(
    script,
    /if \(!reset && this\._cliTokensLoading\) return;[\s\S]*if \(reset\) \{[\s\S]*this\._cliTokenLoadId \+= 1;/,
    'an authoritative reset must supersede an in-flight pagination request'
  );
  assert.doesNotMatch(script, /access_token|token_hash/);
});

// ── #907: the agent:local scope ────────────────────────────────────────────

test('the CLI grant carries the local-agent scope, and it is not optional', () => {
  assert.equal(constants.AGENT_SCOPE, 'agent:local');
  assert.deepEqual(constants.REQUIRED_SCOPES, [
    constants.IDENTITY_SCOPE, constants.API_SCOPE, constants.AGENT_SCOPE,
  ]);
  // hasExactScopes is what the device-code endpoint enforces, so a client
  // asking for the pre-#907 pair is refused at request time rather than
  // discovering the gap when it first tries to attach.
  assert.equal(cliAuth.hasExactScopes([constants.IDENTITY_SCOPE, constants.API_SCOPE]), false);
  assert.equal(cliAuth.hasExactScopes(constants.REQUIRED_SCOPES), true);
  // Order is part of the contract: the CHECK constraints compare arrays.
  assert.equal(
    cliAuth.hasExactScopes([constants.API_SCOPE, constants.AGENT_SCOPE, constants.IDENTITY_SCOPE]),
    false
  );
});

test('the consent screen names what the new scope actually permits', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const authorize = fs.readFileSync(
    path.join(__dirname, '../src/routes/cli-auth.js'), 'utf8'
  );
  // A scope the user cannot see described is a scope they cannot consent to.
  assert.ok(/local coding agent|run coding turns/i.test(authorize + html),
    'the authorize page must describe the local-agent grant in words');
});

test('every scope CHECK constraint is widened in place, not only on a fresh CREATE', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  // Three tables constrain the scope array. CREATE TABLE IF NOT EXISTS adds
  // nothing to an existing deployment, so each needs a DO block that detects
  // the pre-#907 definition and replaces it — otherwise the first device
  // authorization after deploy fails its CHECK in production and nowhere else.
  const migrations = schema.match(/position\('agent:local' IN constraint_def\) = 0/g) || [];
  assert.equal(migrations.length, 3, 'one migration per constrained table');
  for (const table of [
    'cli_device_authorizations', 'cli_access_tokens', 'cli_auth_audit_events',
  ]) {
    assert.match(schema, new RegExp(`'${table}'::regclass`),
      `${table} must be migrated, not just created`);
  }
});

test('the local-agent tables are staging:private, like every other cli table', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');
  for (const table of ['session_agent_leases', 'local_agent_turns']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(schema, new RegExp(`COMMENT ON TABLE ${table} IS 'staging:private'`));
  }
  // One live lease per session, enforced by the database rather than by a
  // read-then-write race in the attach route.
  assert.match(schema, /session_agent_leases[\s\S]*?UNIQUE INDEX[\s\S]*?WHERE released_at IS NULL/);
  // A lease points at the credential it was minted against, so revocation can
  // find and release it. Pruning that token months later must not delete the
  // history of where a session's turns ran, hence SET NULL.
  assert.match(schema,
    /access_token_id BIGINT REFERENCES cli_access_tokens\(id\) ON DELETE SET NULL/);
});

test('revoking a credential detaches the machines that attached with it', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/cli-auth.js'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '../src/services/cli-auth.js'), 'utf8');
  // All three revocation paths: the CLI revoking itself, Settings revoking a
  // listed credential, and account recovery revoking everything.
  assert.equal((routes.match(/releaseLeasesForTokens\(/g) || []).length, 2);
  assert.match(service, /releaseLeasesForTokens\(\s*\n?\s*client, revoked\.map/);
  // Inside the caller's transaction, so a rolled-back revocation cannot
  // strand a machine that is in fact still authorized.
  assert.match(routes, /releaseLeasesForTokens\(client,/);
  // …but the wakeup happens after COMMIT.
  assert.equal((routes.match(/localAgent\.notifyReleased\(/g) || []).length, 2);
});
