'use strict';

// The Sort-control staging fixtures (#1383).
//
// `chat_sessions` is `staging:private`: the clone gets the schema and none of
// the rows, so every app in every preview has ZERO merged proposals unless
// something seeds them. Four of the directory's five orders rank on that
// column family, which means without this fixture the Sort control looks
// identical under four settings — and the declared checks and the before/after
// captures are all shot against a list nothing ranked. What is pinned below is
// therefore the CORRESPONDENCE between the fixture profiles and the orders
// they have to separate, not the row count.
//
// Discover's Sort control went with One Home (#6361). The rows stay: they
// are the merge history a preview's projects show (a guest project page's
// last change, the directory's last_merged_at), and the profiles still keep
// those apps apart.
//
// Source-level, deliberately: seeding runs against a live Postgres on boot and
// there is none in a unit run. Everything asserted here is a property of the
// seed's text, which is where a drift would land.
//
// Run with: node --test tests/staging-app-sort-fixtures.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migrate = fs.readFileSync(path.join(root, 'src/db/migrate.js'), 'utf8');

/** The body of the seed function, from its declaration to the next one. */
function seedBody() {
  const from = migrate.indexOf('async function seedStagingAppSortSignals(');
  assert.notEqual(from, -1, 'seedStagingAppSortSignals is gone');
  const next = migrate.indexOf('\nasync function ', from + 1);
  return migrate.slice(from, next === -1 ? migrate.length : next);
}

test('the seed runs on boot, after the fixtures it ranks, and only on staging', () => {
  assert.match(migrate, /await seedStagingAppSortSignals\(pool\);/,
    'the seed is not called from the boot sequence — an uncalled seed and an '
    + 'empty screen look exactly alike');
  assert.ok(
    migrate.indexOf('await seedStagingBrowseCardBranches(pool, config);')
      < migrate.indexOf('await seedStagingAppSortSignals(pool);'),
    'this seed re-stamps the browse-card fixture apps, so it must run after them');

  const body = seedBody();
  assert.match(body, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/,
    'USERNODE_ENV gates DATA, and this is data — it must be a strict no-op in prod');
  assert.match(body, /catch \(err\)[\s\S]*log\.warn\(/,
    'a fixture bug must not block boot');
});

test('the fixture rows are fake identities, never the person opening the preview', () => {
  const body = seedBody();
  assert.match(body, /username = \$1', \['staging-demo-user'\]/,
    'every seeded proposal is owned by the demo user');
  assert.match(body, /\[p\.appId, ownerId, branch,/,
    'every insert is attributed to that demo owner and nothing else');
  assert.doesNotMatch(body.slice(0, body.indexOf('\n}\n')), /req\.user/,
    'seeding rows onto the visitor hands the preview a signal production will '
    + 'not have — see the "seeded data must not fabricate a signal" rule');
  assert.match(body, /\[staging fixture\]/,
    'seeded content is labelled so it cannot be mistaken for real proposals');
});

test('the inserts are idempotent — staging re-runs them on every push', () => {
  const body = seedBody();
  const inserts = body.match(/INSERT INTO [a-z_]+/g) || [];
  assert.equal(inserts.length, 1, 'one insert; adjust the guard check if that changes');
  assert.match(body, /SELECT id FROM chat_sessions WHERE app_id = \$1 AND branch_name = \$2/,
    'the (app_id, branch_name) existence guard is the idempotency key');
  assert.match(body, /if \(existing\.length\) continue;/);
  // The app re-stamp is an UPDATE, which is idempotent by construction — but
  // only because the ages are relative to NOW(), not absolute.
  assert.match(body, /SET created_at = NOW\(\) - \(\$2::int \* INTERVAL '1 day'\)/);
});

test('the rows carry an EXPLICIT merged_at — the arm older fixtures leave NULL', () => {
  const body = seedBody();
  assert.match(body, /status, votes_required, created_at, merged_at\)/);
  // merged_at arrived in a later ALTER TABLE, so /api/apps COALESCEs to
  // created_at for the history that predates it. This fixture is what
  // exercises the populated side of that COALESCE in a preview.
  assert.match(body, /'merged', 1,\s*\n\s*NOW\(\) - \(\$7::int \* INTERVAL '1 hour'\),\s*\n\s*NOW\(\) - \(\$7::int \* INTERVAL '1 hour'\)\)/);
});

test('every query binds as many values as its SQL asks for', () => {
  // The bug this exists for: the INSERT read $7 and passed six values, so the
  // seed threw "bind message supplies 6 parameters" on every staging boot and
  // the whole fixture silently did nothing. Nothing above catches that — the
  // SQL was right, the params were right, and only their ARITY disagreed. It
  // surfaced by booting the app, which no unit run does.
  const body = seedBody();
  const calls = [...body.matchAll(/pool\.query\(/g)].map((m) => m.index);
  assert.ok(calls.length >= 3, 'the seed stopped issuing queries');

  for (const at of calls) {
    // Walk from the open paren to its match, tracking nesting and the three
    // string flavours, so a `[` inside a template literal cannot end the args.
    const open = body.indexOf('(', at);
    let depth = 0, quote = null, end = -1;
    for (let i = open; i < body.length; i++) {
      const c = body[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    assert.notEqual(end, -1, 'unbalanced pool.query( in the seed');
    const args = body.slice(open + 1, end);

    const highest = [...args.matchAll(/\$(\d+)/g)]
      .reduce((n, m) => Math.max(n, Number(m[1])), 0);
    if (!highest) continue; // a query with no placeholders binds nothing

    // The bindings are the bracketed array that follows the SQL.
    const arrAt = args.indexOf('[');
    assert.notEqual(arrAt, -1, `a query uses $${highest} and passes no array`);
    let d = 0, q = null, bindings = 1;
    for (let i = arrAt; i < args.length; i++) {
      const c = args[i];
      if (q) {
        if (c === '\\') i++;
        else if (c === q) q = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { q = c; continue; }
      if (c === '[' || c === '(' || c === '{') d++;
      else if (c === ']' || c === ')' || c === '}') { d--; if (!d) break; }
      else if (c === ',' && d === 1) bindings++;
    }
    assert.equal(bindings, highest,
      `a seed query reads up to $${highest} but binds ${bindings} value(s) — `
      + 'postgres rejects the whole statement at run time');
  }
});

test('the four profiles put a DIFFERENT app on top under each order', () => {
  const body = seedBody();
  const table = body.slice(body.indexOf('const PROFILES = ['),
    body.indexOf('\n  ];', body.indexOf('const PROFILES = [')));

  const profiles = [...table.matchAll(
    /appId: (\d+), createdDaysAgo: (\d+), deployedDaysAgo: (\d+),\s*\n?\s*merged: \[([^\]]*)\]/g
  )].map((m) => ({
    appId: Number(m[1]),
    createdDaysAgo: Number(m[2]),
    deployedDaysAgo: Number(m[3]),
    // Entries are hoursAgo, some written as `N * 24`; the mapped variant
    // (`.map((d) => d * 24)`) is days, so scale it the same way.
    hours: m[4].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const mult = /\*\s*24\s*$/.test(s) || /\.map\(/.test(table.slice(table.indexOf(m[0])))
        ? 1 : 1;
      return Function(`"use strict"; return (${s})`)() * mult;
    }),
  }));
  assert.equal(profiles.length, 4, 'four fixture apps, one per branch');

  const daysScaled = (p) => (
    /\.map\(\(d\) => d \* 24\)/.test(table.split(String(p.appId))[1] || '') ? 24 : 1
  );
  const hoursOf = (p) => p.hours.map((h) => h * daysScaled(p));
  const recent = (p) => hoursOf(p).filter((h) => h <= 30 * 24).length;
  const lifetime = (p) => p.hours.length;
  const byId = Object.fromEntries(profiles.map((p) => [p.appId, p]));

  // Most active = most merged in the last 30 days.
  const topActive = profiles.slice().sort((a, b) => recent(b) - recent(a))[0];
  // Most changes merged = the deepest lifetime history.
  const topMerged = profiles.slice().sort((a, b) => lifetime(b) - lifetime(a))[0];
  // Newest = the smallest age.
  const topNew = profiles.slice().sort((a, b) => a.createdDaysAgo - b.createdDaysAgo)[0];

  assert.notEqual(topActive.appId, topMerged.appId,
    '"Most active" and "Most changes merged" must not lead with the same app, '
    + 'or a reviewer cannot tell the two orders apart');
  assert.notEqual(topNew.appId, topActive.appId);
  assert.notEqual(topNew.appId, topMerged.appId);
  assert.equal(lifetime(byId[900204]), 0,
    'one app must have merged nothing at all — the NULL last_merged_at arm');
  assert.ok(byId[900204].createdDaysAgo > topNew.createdDaysAgo);
});
