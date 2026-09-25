'use strict';

// The Support API (src/routes/admin-support.js): every route admin-only, the
// two writes behind requireAdminWrite, and no credential column in any query.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SRC = read('src/routes/admin-support.js');
const SCHEMA = read('src/db/schema.sql');
const SERVER = read('server.js');
const MIGRATE = read('src/db/migrate.js');
const { likePattern, eventStatus } = require('../src/routes/admin-support');

function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}
const CODE = code(SRC);

test('the router is mounted and every support path is admin-only', () => {
  assert.match(SERVER, /require\('\.\/src\/routes\/admin-support'\)/);
  assert.match(SERVER, /app\.use\(adminSupportRoutes\(config\)\)/);
  assert.match(CODE, /router\.use\('\/api\/admin\/support', adminMiddleware\)/);
  const routes = [...CODE.matchAll(/router\.(get|post|put|patch|delete)\('([^']+)'/g)];
  assert.ok(routes.length >= 9, 'search, summary, points, timeline, kudos, history, pickers and two writes');
  for (const [, , p] of routes) assert.ok(p.startsWith('/api/admin/support/'), `${p} sits under the admin prefix`);
});

test('the two writes require write access and nothing else writes', () => {
  const writes = [...CODE.matchAll(/router\.(post|put|patch|delete)\('([^']+)',\s*(\w+)/g)];
  assert.deepStrictEqual(writes.map((w) => w[2]).sort(), [
    '/api/admin/support/actions/:actionId/reverse',
    '/api/admin/support/users/:id/points-adjustment',
  ]);
  for (const w of writes) assert.strictEqual(w[3], 'requireAdminWrite', `${w[2]} uses requireAdminWrite`);
  assert.doesNotMatch(CODE, /\bUPDATE\s+user_activities\b|\bDELETE\s+FROM\s+user_activities\b/i,
    'adjustments are append-only');
});

test('no credential column is ever selected', () => {
  // public_key is not a credential: search may match a pasted one, and it is
  // never selected.
  for (const col of ['password', 'anthropic_key_enc', 'wallet_link_token', 'secret_key',
    'registration_code', 'key_hash', 'credentials.']) {
    assert.ok(!CODE.includes(col), `${col} does not appear in query code`);
  }
  assert.doesNotMatch(CODE, /\bu\.\*|users\.\*|SELECT \*\s+FROM (users|onchain_accounts)\b/i);
});

test('validation copy is plain and em-dash free', () => {
  assert.ok(SRC.includes('Type at least 3 characters, or a user id.'));
  assert.ok(SRC.includes('This adjustment has already been reversed.'));
  assert.ok(!/—|&mdash;|\\u2014/.test(CODE.replace(/^\s*\/\/.*$/gm, '')), 'no em dash in response copy');
});

test('likePattern escapes wildcards; eventStatus classifies windows', () => {
  assert.strictEqual(likePattern('a_b%c'), '%a\\_b\\%c%');
  assert.strictEqual(likePattern('x\\y'), '%x\\\\y%');
  const now = Date.parse('2026-06-01T00:00:00Z');
  assert.strictEqual(eventStatus('2026-07-01', '2026-08-01', now), 'upcoming');
  assert.strictEqual(eventStatus('2026-04-01', '2026-05-01', now), 'ended');
  assert.strictEqual(eventStatus('2026-05-01', '2026-07-01', now), 'running');
});

test('support_actions is private and reversal is unique in the database', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS support_actions \(/);
  assert.match(SCHEMA, /COMMENT ON TABLE support_actions IS 'staging:private'/);
  assert.match(SCHEMA, /CREATE UNIQUE INDEX IF NOT EXISTS user_activities_support_reversal_unique/);
});

test('the staging seed is gated, fake and idempotent', () => {
  const start = MIGRATE.indexOf('async function seedStagingSupportUser(pool)');
  assert.ok(start > 0);
  const body = MIGRATE.slice(start, MIGRATE.indexOf('\n}\n', start));
  assert.match(body, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/);
  assert.match(body, /'staging-demo-support'/);
  assert.match(MIGRATE, /await seedStagingSupportUser\(pool\);/);
  const inserts = body.match(/INSERT INTO/g).length;
  const guarded = body.match(/ON CONFLICT/g).length;
  assert.ok(guarded >= inserts - 1, 'every insert but the existence-checked events is ON CONFLICT guarded');
});
