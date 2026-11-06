'use strict';

// The browse-card and collaborator-invite staging fixtures (#1120 slice 6).
//
// These rows exist so two Tier-A surfaces can be REVIEWED in a preview:
// `AppCard.iconTileFor`'s three-arm icon choice plus the requires-login
// chip, and the collaborator arm of the notifications drawer's Invites
// card. A fixture set that drifts out of step with the branches it covers
// fails silently — the screen still renders, it just renders one arm four
// times — so what is pinned here is the CORRESPONDENCE between the fixtures
// and the branches, not the row count.
//
// Source-level, deliberately: seeding runs against a live Postgres on boot,
// and there is none in a unit run. Everything asserted below is a property
// of the seed's text, which is where a drift would land.
//
// Run with: node --test tests/staging-browse-card-fixtures.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migrate = fs.readFileSync(path.join(root, 'src/db/migrate.js'), 'utf8');
const appCard = fs.readFileSync(
  path.join(root, 'frontend/src/features/apps/app-card.js'), 'utf8');

/** The body of the seed function, from its declaration to the next one. */
function seedBody() {
  const from = migrate.indexOf('async function seedStagingBrowseCardBranches(');
  assert.notEqual(from, -1, 'seedStagingBrowseCardBranches is gone');
  const next = migrate.indexOf('\nasync function ', from + 1);
  return migrate.slice(from, next === -1 ? migrate.length : next);
}

test('the seed runs on boot and only on staging', () => {
  // Registration is half the fixture: a seed nobody calls is rows that
  // never exist, and the failure looks exactly like an empty screen.
  assert.match(migrate, /await seedStagingBrowseCardBranches\(pool, config\);/,
    'the seed is not called from the boot sequence');
  // Ordering matters — the collaborator/favorite rows resolve the owner
  // seedStagingYourApps creates.
  assert.ok(
    migrate.indexOf('await seedStagingYourApps(pool, config);')
      < migrate.indexOf('await seedStagingBrowseCardBranches(pool, config);'),
    'the browse-card seed must run after seedStagingYourApps, which creates its owner');

  const body = seedBody();
  assert.match(body, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/,
    'the seed must be a strict no-op outside staging — USERNODE_ENV gates DATA, '
    + 'and this is data');
  assert.match(body, /catch \(err\)[\s\S]*log\.warn\(/,
    'a fixture bug must not block boot; every seed in this file is best-effort');
});

test('every fixture row is idempotent', () => {
  const body = seedBody();
  const inserts = body.match(/INSERT INTO [a-z_]+/g) || [];
  assert.ok(inserts.length >= 4, `only ${inserts.length} inserts — the seed shrank`);
  // Two spellings are acceptable: ON CONFLICT, or a NOT EXISTS guard for the
  // notification, which has no natural unique key to conflict on.
  const guards = (body.match(/ON CONFLICT/g) || []).length
    + (body.match(/WHERE NOT EXISTS/g) || []).length;
  assert.ok(guards >= inserts.length,
    `${inserts.length} inserts but only ${guards} idempotency guards — every staging `
    + 'seed re-runs on every boot');
});

test('the four apps cover the four tile branches, one each', () => {
  const body = seedBody();
  const table = body.slice(body.indexOf('const APPS = ['), body.indexOf('];', body.indexOf('const APPS = [')));

  // The arms AppCard.iconTileFor actually branches on. Read from the
  // component, so deleting an arm there fails here rather than leaving a
  // fixture covering nothing.
  assert.match(appCard, /if \(app\.icon_url\)/, 'the image arm moved');
  assert.match(appCard, /if \(app\.icon_emoji\)/, 'the emoji arm moved');

  const rows = table.split('{ id:').slice(1);
  assert.equal(rows.length, 4, 'the fixture set is four apps: image, emoji, gated, letter');

  const withIcon = rows.filter((r) => /iconId: '[^']/.test(r));
  const withEmoji = rows.filter((r) => /emoji: '[^']/.test(r));
  const gated = rows.filter((r) => /anonShell: 'gated'/.test(r));
  assert.equal(withIcon.length, 1, 'exactly one app exercises the image arm');
  assert.equal(withEmoji.length, 1, 'exactly one app exercises the emoji arm');
  assert.equal(gated.length, 1, 'exactly one app exercises the requires-login chip');
  // The letter fallback is the arm you get by carrying neither, so it is
  // only covered while some row carries neither.
  const bare = rows.filter((r) => /iconId: null/.test(r) && /emoji: null/.test(r)
    && /anonShell: 'public'/.test(r));
  assert.equal(bare.length, 1,
    'no app carries neither icon nor gate — the first-letter fallback, which is what '
    + 'most real apps render, would go uncovered');

  // The image arm is only real if /app-icons/:id resolves.
  assert.match(body, /INSERT INTO app_icons/,
    'the image fixture needs an app_icons blob — apps.icon_image_id alone 404s');

  // ...and the blob is only reachable if the id passes the route's guard.
  // src/routes/app-icons.js 404s on a malformed id BEFORE it queries, so a
  // readable id inserts, is handed to the client as an icon_url, and then
  // 404s from the <img> on every screen that lists apps — one console error
  // on nearly every route. Read the guard from the route so a change there
  // fails here rather than in a proposal check.
  const route = fs.readFileSync(path.join(root, 'src/routes/app-icons.js'), 'utf8');
  const guard = route.match(/if \(!(\/[^/]+\/)\.test\(id\)\) return res\.status\(404\)/);
  assert.ok(guard, 'the /app-icons/:id id guard moved — re-point this assertion');
  const idRe = new RegExp(guard[1].slice(1, -1));
  for (const [, id] of body.matchAll(/iconId: '([^']+)'/g)) {
    assert.match(id, idRe,
      `iconId '${id}' does not satisfy the /app-icons/:id guard ${guard[1]} — the route `
      + 'rejects it with a 404 before it ever reaches the table');
  }
});

test('the fixtures are obviously fake and cannot be signed in as', () => {
  const body = seedBody();
  for (const name of body.match(/name: '[^']+'/g) || []) {
    assert.match(name, /'Staging demo app — /,
      `${name} does not carry the mock-data prefix — a reviewer cannot tell it from a real app`);
  }
  for (const slug of body.match(/slug: '[^']+'/g) || []) {
    assert.match(slug, /'staging-demo-/, `${slug} is not in the staging-demo namespace`);
  }
  // Ids in the agreed obviously-fake block, clear of cloned production rows
  // and of the 9000xx/9001xx fixtures above it.
  const ids = (body.match(/\bid: (9\d{5})/g) || []).map((s) => Number(s.slice(4)));
  assert.equal(ids.length, 4);
  for (const id of ids) {
    assert.ok(id >= 900200 && id < 900300,
      `${id} is outside the 9002xx block this seed reserved — check it against the other `
      + 'fixture blocks in migrate.js before moving it');
  }
  assert.equal(new Set(ids).size, ids.length, 'duplicate fixture app ids');
});

test('the collaborator invite is pending, and paired with its notification', () => {
  const body = seedBody();
  // 'invited' is the whole point: a 'member' row grants access and renders
  // nothing in the Invites card.
  assert.match(body, /INSERT INTO app_collaborators[\s\S]{0,200}'invited'/,
    "the invite must be status 'invited' — 'member' is not a pending invite");
  assert.match(body, /'collab_invite'/,
    'the notification row is what bumps the bell and writes the history entry');
  // The approver arm is seeded elsewhere; this seed must not duplicate it.
  assert.doesNotMatch(body, /app_approvers/,
    'the approver invite belongs to seedStagingNotifications — two seeds writing the '
    + 'same pending row is how a fixture ends up in an unknown state');
});
