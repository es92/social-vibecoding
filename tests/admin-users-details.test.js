'use strict';

// The admin Users section: tidy list rows, and a details view behind "More"
// (#admin/users/<id>) that holds every per-user dial. Source-level pins, in
// the same style as topochain-admin-screens.test.js.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const USERS = read('frontend/src/features/admin/admin-users.tsx');
const PROGRAMME = read('frontend/src/features/admin/topochain/programme-users.tsx');
const DELETIONS = read('frontend/src/features/admin/account-deletions.tsx');
const MIGRATE = read('src/db/migrate.js');
const DAPP = JSON.parse(read('dapp.json'));

// Strip comments so prose (which may use em dashes or name credentials while
// explaining why they are absent) does not trip the code-only assertions.
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

test('the details view exists and reads the v4 programme profile', () => {
  assert.match(USERS, /function UserDetails\(/);
  assert.match(USERS, /id="admin-user-details"/);
  assert.match(USERS, /fetchJson\(`\/api\/v4\/admin\/users\/\$\{encodeURIComponent\(user\.id\)\}`\)/);
  assert.match(USERS, /send\('PUT', `\/api\/v4\/admin\/users\/\$\{encodeURIComponent\(user\.id\)\}`/);
  assert.match(USERS, /Add an email, Telegram or Discord to save programme details\./,
    'the v4 PUT needs one identifier, so Save says why it is disabled');
});

test('the details view reuses the existing write routes and pinned hooks', () => {
  for (const route of [
    '/api/admin/users/${user.id}/is-admin',
    '/api/admin/users/${user.id}/app-quota',
    '/api/admin/users/${user.id}/wallet',
    '/api/admin/users/${user.id}/reset-password',
    '/api/admin/openrouter-keys/${user.openrouter_key_id}',
  ]) assert.ok(USERS.includes(route), `reuses ${route}`);
  assert.match(USERS, /commitLimit\('daily-limit', 'Cap', 'daily_limit_cents'\)/);
  assert.match(USERS, /commitLimit\('weekly-limit', 'Weekly cap', 'weekly_limit_cents'\)/);
  for (const hook of ['admin-role-select', 'admin-quota-input', 'admin-user-limit-input',
    'admin-user-weekly-limit-input', 'admin-wallet-input', 'admin-openrouter-toggle',
    'admin-openrouter-delete', 'admin-reset-pw-btn', 'admin-delete-user-btn', 'admin-user-tier']) {
    assert.ok(USERS.includes(hook), `keeps the ${hook} hook`);
  }
});

test('the #admin/users/<id> tail is written only while inside the section', () => {
  assert.match(USERS, /if \(!String\(location\.hash \|\| ''\)\.startsWith\('#admin\/users'\)\) return;/);
  assert.match(USERS, /history\.replaceState\(null, '', target\)/);
  assert.match(USERS, /\^#admin\\\/users\\\/\(\\d\+\)/, 'a deep link opens the details view on mount');
  assert.match(USERS, /User #\$\{detailId\} was not found\./);
});

test('no credential is read or rendered by the new screens', () => {
  for (const src of [USERS, PROGRAMME]) {
    assert.ok(!/password_hash|api_key|registration_code|\bsecret\b/i.test(code(src)));
  }
});

test('the list keeps its hooks, pages by 50, and moves bulk quota to the footer', () => {
  for (const id of ['admin-users-filter', 'admin-user-list', 'admin-bulk-quota-control',
    'admin-bulk-quota-input', 'admin-bulk-quota-btn']) {
    assert.ok(USERS.includes(`id="${id}"`), `keeps #${id}`);
  }
  assert.ok(USERS.indexOf('id="admin-bulk-quota-control"') > USERS.indexOf('id="admin-user-list"'),
    'Set all quotas sits under the list, not above it');
  assert.match(USERS, /const PAGE = 50;/);
  assert.match(USERS, />Show 50 more</);
  assert.match(USERS, /data-user-more=\{user\.id\}/);
  assert.match(USERS, /`App slot requests \(\$\{requestCount\}\)`/);
  assert.ok(USERS.indexOf('id="admin-users-programme"') < USERS.indexOf('<AccountDeletions />'),
    'deleted account cleanup is the last card');
});

test('programme users: More and an overflow menu, no Edit, no Email column', () => {
  assert.match(PROGRAMME, /data-more-u=\{u\.id\}/);
  assert.ok(!/data-edit-u/.test(PROGRAMME), 'editing lives in the details view');
  assert.ok(!/label: 'Email'/.test(PROGRAMME));
  assert.match(PROGRAMME, /data-delete-u=\{u\.id\}/);
  assert.match(PROGRAMME, /onOpenDetails\?: \(id: number\) => void/);
  assert.match(USERS, /<ProgrammeUsers onOpenDetails=\{openDetails\} \/>/);
});

test('deleted account cleanup is padded and collapsible', () => {
  assert.match(DELETIONS, /aria-label="Deleted account cleanup"/);
  assert.match(DELETIONS, /mt-6 p-4/);
  assert.match(DELETIONS, /aria-expanded=\{open\}/);
  assert.match(DELETIONS, /all cleaned up/);
});

test('no em dash in the user-facing strings of the new screens', () => {
  for (const [name, src] of [['admin-users', USERS], ['programme-users', PROGRAMME], ['account-deletions', DELETIONS]]) {
    const lines = code(src).split('\n')
      // A lone dash is the placeholder for a missing value.
      .filter((l) => l.includes('—') && !/\|\| '—'/.test(l));
    assert.deepStrictEqual(lines, [], `${name} has no em dash in copy`);
  }
});

test('staging seeds a fake user for the details view, and dapp.json checks it', () => {
  const fn = MIGRATE.slice(MIGRATE.indexOf('async function seedStagingAdminDetailsUser'));
  assert.ok(fn.length > 0 && /USERNODE_ENV !== 'staging'/.test(fn.slice(0, 400)), 'gated on staging');
  assert.match(fn, /900301/);
  assert.match(fn, /ON CONFLICT/);
  assert.match(MIGRATE, /await seedStagingAdminDetailsUser\(pool\);/);
  const check = DAPP.tests.find((t) => t.path === '/#admin/users/900301');
  assert.ok(check, 'a declared check opens the deep link');
  // Folded into the #1788 weekly-cap check (the manifest keeps 20 slots
  // clear of MAX_DECLARED_TESTS), since that input now lives in this view.
  assert.match(check.expectSelector, /^#admin-user-details /);
  // Declared checks sign in as a VIEW-ONLY admin, who sees the cap as text:
  // selecting the write-only input failed on every run.
  assert.equal(check.expectSelector, '#admin-user-details .admin-user-weekly-limit-value');
  assert.match(USERS, /<span className="admin-user-weekly-limit-value">/,
    'the read-only cap carries the class the check selects');
});

test('details cards come from the shared parts and link to Support', () => {
  assert.match(USERS, /from '\.\/admin-detail-parts\.tsx'/);
  assert.match(USERS, /id="admin-user-details-open-support"/);
  assert.match(USERS, /location\.hash = `#admin\/support\/\$\{user\.id\}`/);
  assert.match(USERS, /data-open-support=\{user\.id\}/);
});
