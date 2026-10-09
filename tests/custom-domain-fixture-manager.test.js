'use strict';

// The #4405 Custom domain fixture must be managed by the identity that
// actually runs the proposal checks.
//
// What broke: the declared check "The hub's ⋯ menu offers Custom domain in
// its Settings & rules panel to whoever manages the project (#4405)" failed
// on every proposal from the day it merged. The ⋯ menu draws the
// `data-plus="domain"` row only when the app's `can_manage` is true
// (frontend/src/features/dev-board/actions-row.tsx), and seedStagingCustomDomains
// made `staging-code-signin@usernode.test` the app admin of
// staging-demo-custom-domain on the belief that the checks sign in as that
// account. They do not: the proposal-checks assertion suite signs as the
// VIEW-ONLY `usernode-capture-admin` (selectCaptureTokens in
// src/services/visuals.js, tests/capture-admin-token.test.js), whose admin
// rank is read-only and so never grants can_manage
// (accessFlags in src/routes/apps.js). Signed in as the account the fixture
// granted, the row was there, which is why it looked right by hand.
//
// The fix: the seed makes `usernode-capture-admin` an app admin of the
// project too, after the seed that creates it.
//
// Source-invariant test, same shape as
// tests/staging-pill-fixture-visibility.test.js: it reads the seed, the
// route flags and dapp.json rather than booting Postgres.
//
// Run with: node --test tests/custom-domain-fixture-manager.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const MIGRATE_SRC = read('src/db/migrate.js');
const VISUALS_SRC = read('src/services/visuals.js');
const APPS_ROUTE_SRC = read('src/routes/apps.js');
const ACTIONS_ROW_SRC = read('frontend/src/features/dev-board/actions-row.tsx');
const DAPP = JSON.parse(read('dapp.json'));

const SEED = 'seedStagingCustomDomains';
const FIXTURE_SLUG = 'staging-demo-custom-domain';
const CHECKS_IDENTITY = 'usernode-capture-admin';

function seedBody(name) {
  const start = MIGRATE_SRC.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `found ${name} definition`);
  const end = MIGRATE_SRC.indexOf('\nasync function ', start + 1);
  assert.ok(end > start, `found the function after ${name}`);
  return MIGRATE_SRC.slice(start, end);
}

test('the declared checks sign in as the view-only capture admin', () => {
  assert.match(VISUALS_SRC, /const CAPTURE_ADMIN_USERNAME = 'usernode-capture-admin';/);
  assert.match(VISUALS_SRC, /testsToken: adminToken \|\| screenshot/,
    'the assertion suite prefers the capture-admin token');
});

test('a view-only admin does not manage an app it is not an app admin of', () => {
  // can_manage reads canAdminWrite (never true for a read-only admin), the
  // creator, or the app_admins grant: only the grant can reach the checks.
  assert.match(APPS_ROUTE_SRC,
    /can_manage: canAdminWrite \|\| \(user\?\.id != null && app\.created_by === user\.id\) \|\| isAppAdmin,/);
});

test('the Custom domain row is drawn only for whoever manages the project', () => {
  const at = ACTIONS_ROW_SRC.indexOf('data-plus="domain"');
  assert.ok(at > 0, 'the ⋯ menu has a Custom domain row');
  const gate = ACTIONS_ROW_SRC.slice(ACTIONS_ROW_SRC.lastIndexOf('{typeof window', at), at);
  assert.match(gate, /appData\?\.can_manage && !selfHosted/);
});

test(`${SEED} makes the checks identity an app admin of ${FIXTURE_SLUG}`, () => {
  const body = seedBody(SEED);
  assert.ok(body.includes(`'${FIXTURE_SLUG}'`), 'the seed creates the fixture project');
  const grant = body.slice(body.indexOf('INSERT INTO app_admins'));
  assert.ok(grant.length > 0, 'the seed writes app_admins');
  const stmt = grant.slice(0, grant.indexOf('ON CONFLICT'));
  assert.match(stmt, /SELECT 900140, id FROM users/, 'grants on the fixture app (id 900140)');
  assert.ok(stmt.includes(`'${CHECKS_IDENTITY}'`),
    `the app_admins grant names ${CHECKS_IDENTITY}, the account the checks sign in as`);
  // The settings panel lists the declared names; keep it consistent.
  const appInsert = body.slice(body.indexOf('INSERT INTO apps'), body.indexOf('INSERT INTO app_admins'));
  assert.ok(appInsert.includes(`'${CHECKS_IDENTITY}'`), 'admin_usernames names it too');
});

test(`${SEED} runs after the seed that creates ${CHECKS_IDENTITY}`, () => {
  const created = MIGRATE_SRC.indexOf('await seedCaptureAdminUser(pool);');
  const seeded = MIGRATE_SRC.indexOf(`await ${SEED}(pool);`);
  assert.ok(created > 0 && seeded > 0, 'both seeds are called');
  assert.ok(created < seeded, 'the grant finds the user row');
});

test('the declared Custom domain check still asserts the row on the fixture', () => {
  const check = DAPP.tests.find((t) => t.expectSelector === "#dev-plus-menu [data-plus='domain']");
  assert.ok(check, 'the check is declared');
  assert.ok(check.path.includes(`#app/${FIXTURE_SLUG}/dev`), 'it opens the fixture project');
});
