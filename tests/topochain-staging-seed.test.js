// Topochain staging seed fixtures (plan Task 4): `seedStagingTopochain`
// in src/db/migrate.js.
//
// The topochain block of schema.sql (Task 1) is brand new — none of its
// 22 tables carry a row outside a real topochain data load (Task 16),
// and a handful (`token_allocation`, `user_terms_consents`, the mobile_*
// tables) are additionally `staging:private` at the table level, so a
// staging clone truncates them entirely. Without a seed, every /api/v4
// public/admin/mobile screen built in later tasks has nothing to render
// in a staging preview.
//
// Two layers, mirroring tests/dashboard-spend-distribution.test.js:
//   1. Behavioural — invoke the real `seedStagingTopochain` (exported from
//      migrate.js for this purpose) against a mock pool that records every
//      `query(sql, params)` call. Catches runtime failures a source-text
//      regex can't: throws, wrong param flow, mismatched placeholder
//      counts, and the case where the staging gate doesn't actually
//      short-circuit before issuing any query.
//   2. Static — no-database assertions over the SQL text appended to
//      src/db/migrate.js, same style as tests/topochain-schema.test.js
//      (block-isolation via indexOf/slice).
// No live Postgres is required or used in either layer.
//
// Run with: node --test tests/topochain-staging-seed.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { seedStagingTopochain } = require('../src/db/migrate');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/db/migrate.js'), 'utf8');
const DAPP_TESTS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'dapp.json'), 'utf8')
).tests || [];

// ─── 1. Behavioural: mock pool records every query(sql, params) call ────

function mockPool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

// Restored in test.after() so this file never leaks its override into any
// test run after it in the same process.
const ORIGINAL_USERNODE_ENV = process.env.USERNODE_ENV;
test.after(() => {
  if (ORIGINAL_USERNODE_ENV === undefined) delete process.env.USERNODE_ENV;
  else process.env.USERNODE_ENV = ORIGINAL_USERNODE_ENV;
});

test('outside staging: the seeder issues zero queries', async () => {
  process.env.USERNODE_ENV = 'production';
  const pool = mockPool();
  await seedStagingTopochain(pool, {});
  assert.equal(pool.calls.length, 0, 'no query() call should happen when USERNODE_ENV !== staging');
});

test('in staging: every INSERT the seeder issues contains an ON CONFLICT guard', async () => {
  process.env.USERNODE_ENV = 'staging';
  const pool = mockPool();
  await seedStagingTopochain(pool, {});
  assert.ok(pool.calls.length >= 15, `expected a substantial number of queries, got ${pool.calls.length}`);
  const inserts = pool.calls.filter((c) => /INSERT INTO/.test(c.sql));
  assert.ok(inserts.length >= 15, 'most/all calls should be INSERT statements');
  for (const call of inserts) {
    // The blanket terms-consent INSERT (issue #1297) arbiters on its
    // natural key — its BIGSERIAL id is generated, so `(id)` would guard
    // nothing there. Every fixture keyed on an invented 9005xx id keeps
    // the `(id)` arbiter.
    assert.match(call.sql,
      /ON CONFLICT \((id|user_id, terms_version_id)\) DO NOTHING/,
      `INSERT without ON CONFLICT: ${call.sql.slice(0, 80)}`);
  }
});

test('in staging: every query\'s params array length matches its highest $N placeholder', async () => {
  process.env.USERNODE_ENV = 'staging';
  const pool = mockPool();
  await seedStagingTopochain(pool, {});
  assert.ok(pool.calls.length > 0);
  for (const call of pool.calls) {
    const placeholderNums = [...call.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const maxPlaceholder = placeholderNums.length ? Math.max(...placeholderNums) : 0;
    const paramsLen = call.params ? call.params.length : 0;
    assert.equal(paramsLen, maxPlaceholder,
      `params length (${paramsLen}) must equal the highest placeholder ($${maxPlaceholder}) for: ${call.sql.slice(0, 80)}`);
  }
});

test('in staging: the seeder runs to completion without throwing against a permissive mock pool', async () => {
  process.env.USERNODE_ENV = 'staging';
  const pool = mockPool();
  await assert.doesNotReject(seedStagingTopochain(pool, {}));
});

// ─── 2. Static: source-text assertions over migrate.js ──────────────────

// Isolate the function body: from its declaration to the next top-level
// `async function`, same slicing idiom as
// tests/dashboard-spend-distribution.test.js.
const fnStart = src.indexOf('async function seedStagingTopochain');
assert.ok(fnStart > 0, 'seedStagingTopochain must be defined in migrate.js');
const nextFnStart = src.indexOf('\nasync function', fnStart + 10);
assert.ok(nextFnStart > fnStart, 'a following function declaration must exist to bound the slice');
const body = src.slice(fnStart, nextFnStart);

// ─── Definition, staging gate, call site ───────────────────────────────

test('seedStagingTopochain is defined with the (pool, config) signature', () => {
  assert.match(src, /async function seedStagingTopochain\(pool, config\)/);
});

test('the Android inactive rule is applied before the fallible fixture block', () => {
  const updateAt = body.indexOf("WHERE os = 'android'");
  const usersAt = body.indexOf('// ─── Users');
  assert.ok(updateAt > -1 && usersAt > -1 && updateAt < usersAt,
    'a later fixture collision must not suppress the deterministic admin warning');
});

test('seedStagingTopochain is a strict no-op outside staging (gate is the first statement)', () => {
  const afterSignature = body.slice(body.indexOf(') {') + 3);
  const firstStatement = afterSignature.split('\n').find((l) => l.trim().length > 0);
  assert.match(firstStatement, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/,
    'the staging gate must be the very first statement in the function body');
});

test('migrate() calls seedStagingTopochain(pool, config) inside the staging seed run', () => {
  assert.match(src, /await seedStagingTopochain\(pool, config\);/);
  // It must be called alongside the other seedStaging* calls, before the
  // backfills/sweeps that follow in migrate().
  const migrateStart = src.indexOf('async function migrate(config)');
  const migrateBody = src.slice(migrateStart, src.indexOf('\n}', migrateStart));
  assert.match(migrateBody, /await seedStagingTopochain\(pool, config\);/,
    'the call must live inside migrate(), not just exist somewhere in the file');
});

test('best-effort: the whole seed body is wrapped in try/catch with log.warn on failure', () => {
  assert.match(body, /try\s*\{/);
  assert.match(body, /\} catch \(err\) \{/);
  assert.match(body, /log\.warn\('db', 'Topochain staging fixtures seeding failed'/);
});

// ─── Idempotency: every INSERT is followed by an ON CONFLICT guard ─────

test('every INSERT INTO in the seeder has a matching ON CONFLICT guard (idempotent on reboot)', () => {
  const inserts = body.match(/INSERT INTO \w+/g) || [];
  // Two arbiter shapes: `(id)` for every fixture keyed on an invented
  // 9005xx id, and the natural key for the blanket terms-consent
  // INSERT ... SELECT (issue #1297), whose BIGSERIAL id is generated so
  // `(id)` would guard nothing there.
  const conflicts = body.match(
    /ON CONFLICT \((id|user_id, terms_version_id)\) DO NOTHING/g) || [];
  assert.ok(inserts.length >= 15, `expected a substantial number of INSERT statements, got ${inserts.length}`);
  assert.equal(inserts.length, conflicts.length,
    'every INSERT INTO must be paired with exactly one ON CONFLICT ... DO NOTHING guard');
});

test('fixed ids used throughout live in the obviously-fake 900500+ range', () => {
  // Every literal 6-digit numeric id in the body should sit in the 900500+
  // range this block documents for itself (a slice of the platform-wide
  // 900xxx staging-demo convention — see seedStagingWalletUsers et al).
  //
  // The window is 900500-900999, not 9005xx: the per-viewer id blocks start
  // at 900520 and reserve 20 EACH with no upper bound, so a fourth tester
  // identity would take 900580-900599. Fixture blocks added after the
  // viewers therefore have to sit above 900599 to stay clear of that growth
  // (the season-event snapshots are at 900600+), and pinning 9005xx would
  // push them back into the collision they were moved out of.
  const sixDigitIds = body.match(/\b9\d{5}\b/g) || [];
  assert.ok(sixDigitIds.length > 20, 'a substantial number of fixed ids are used');
  for (const id of sixDigitIds) {
    assert.match(id, /^900[5-9]\d\d$/, `id ${id} should be in the 900500-900999 staging-demo range`);
  }
});

// ─── Content spot-checks per the brief's fixture list ──────────────────

test('3 seasons in ONE statement: running, closed, and internal-and-empty', () => {
  assert.match(body, /INSERT INTO seasons/);
  assert.equal((body.match(/INSERT INTO seasons/g) || []).length, 1,
    'all rows belong to the same statement — a second INSERT would be a second failure point');
  const start = body.indexOf('INSERT INTO seasons');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  assert.match(block, /NOW\(\) - INTERVAL '60 days', NOW\(\) \+ INTERVAL '30 days', TRUE/,
    'the running season is is_active = TRUE and spans now');
  // The admin Seasons list renders an active/closed badge and orders by
  // display_order; with one always-active row neither was reviewable.
  assert.match(block, /NOW\(\) - INTERVAL '240 days', NOW\(\) - INTERVAL '150 days', FALSE/,
    'the archive season ended months ago and is is_active = FALSE');
  assert.match(block, /Staging Demo Season — Archive/);
  // The third season is internal AND has nothing referencing it, which
  // makes it the only row whose admin DELETE gets past the 409
  // `season_in_use` guard — the happy path of the delete flow is
  // otherwise unreachable without first creating a season by hand.
  assert.match(block, /Staging Demo Season — Internal Dry Run/);
  assert.match(block, /NOW\(\) - INTERVAL '5 days', NOW\(\) \+ INTERVAL '25 days', TRUE, TRUE, 2/,
    'the internal season is active, spans now, and is internal = TRUE');
  // Nothing may hang off the internal season — being empty is the whole
  // point of it — so its id must not reach any other statement's params.
  const eventsIdx = body.indexOf('INSERT INTO season_events');
  const eventsParams = body.slice(body.indexOf('ON CONFLICT (id) DO NOTHING', eventsIdx),
    body.indexOf(');', eventsIdx));
  assert.ok(!eventsParams.includes('SEASON_INTERNAL_ID'),
    'no season event may hang off the internal season');
});

test("6 season_events: regular (current), type='season', a fully-past one, an archive-season one, a challenge-free one and a season-less one", () => {
  const start = body.indexOf('INSERT INTO season_events');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  assert.match(block, /'\{"metrics": \[\], "offchain_weight": 1\}'::jsonb/g);
  assert.match(block, /100, 130/, 'the regular event carries a start_epoch/end_epoch range');
  assert.match(block, /'regular'/);
  assert.match(block, /'season'/);
  const scoringFormulaCount = (block.match(/::jsonb/g) || []).length;
  assert.equal(scoringFormulaCount, 6, 'all six season_events rows carry a scoring_formula');

  // The sixth row is the only one with season_id = NULL: it is what the
  // Seasons screen's "not assigned to a season" panel and the events
  // list's `season_id=none` filter exist to surface.
  assert.match(block, /\(\$8, NULL, 'Staging Demo Event — Unassigned Sprint'/);
  assert.equal((block.match(/^\s*\(\$\d+, NULL, 'Staging Demo Event/gm) || []).length, 1,
    'exactly one season-less event — the rest must stay scoped to a season');

  // The archive event hangs off the CLOSED season ($6), which is what
  // gives the admin events list two scopes to tell apart; the unfilled
  // one hangs off the running season ($3) and is the only event with no
  // challenges, so the per-event "No challenges yet" empty state is
  // reachable in a preview.
  assert.match(block, /\(\$5, \$6, 'Staging Demo Event — Archive Sprint'/);
  assert.match(block, /\(\$7, \$3, 'Staging Demo Event — Unfilled Sprint'/);
  // Both are is_active = FALSE, so no public surface (the leaderboard's
  // event picker, the between-events fallback) shifts because of them.
  assert.match(block, /NOW\(\) - INTERVAL '230 days', NOW\(\) - INTERVAL '200 days', FALSE/);
  assert.match(block, /NOW\(\) \+ INTERVAL '20 days', NOW\(\) \+ INTERVAL '50 days', FALSE/);

  // The third event exists specifically so the between-events fallback
  // (public/js/topochain-events.js) is reachable in a staging preview: the
  // other two both span "now", so without a fully-past event the
  // "nothing is running right now" state can never be reviewed.
  assert.match(block, /NOW\(\) - INTERVAL '120 days', NOW\(\) - INTERVAL '90 days'/,
    'the third event is entirely in the past');
  assert.match(block, /Finished Sprint/);
});

test("the type='season' fixture starts with the preview and is refreshed on reboot", async () => {
  // #999: the leaderboard now opens on the season aggregate
  // (DEFAULT_PUBLIC_EVENT_SQL step 1), which is guarded on
  // `starts_at <= NOW()`. This fixture used to start at NOW() + 15 days, so
  // the guard skipped it and a staging preview kept defaulting to the
  // regular event — i.e. the new default was unreviewable, and a tester
  // would have seen no change at all. It must also start after any real
  // season rows inherited from the production clone: a newer, still-empty
  // season board would otherwise win and leave the fixture table hidden.
  const start = body.indexOf('INSERT INTO season_events');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  // Slice from the fixture's NAME to the end of that VALUES row (the next
  // row starts with `($4,`) — the row's own description mentions "type=",
  // so keying off that would match inside the prose.
  const seasonRow = block.slice(block.indexOf('Season Standings'), block.indexOf('($4, $3,'));
  assert.match(seasonRow,
    /NOW\(\), NOW\(\) \+ INTERVAL '30 days'/,
    'the fixture must be the newest already-started season event');
  assert.doesNotMatch(block, /NOW\(\) \+ INTERVAL '15 days', NOW\(\) \+ INTERVAL '30 days'/,
    'the old future-only window must be gone');

  process.env.USERNODE_ENV = 'staging';
  const pool = mockPool();
  await seedStagingTopochain(pool, {});
  const refresh = pool.calls.find((call) => (
    /UPDATE season_events/.test(call.sql)
    && /SET starts_at = NOW\(\)/.test(call.sql)
  ));
  assert.ok(refresh, 'an existing preview database must refresh the fixture window on reboot');
  assert.deepEqual(refresh.params, [900501], 'only the fixed staging season event is refreshed');
});

test('the season event carries its own leaderboard snapshots', () => {
  // Without rows on the season event the aggregate is just
  // EVENT_REGULAR + EVENT_ENDED, whose ordering matches the regular event's
  // own board — so a tester could not tell the season path from the
  // per-event path, which is exactly the bug being fixed.
  const blocks = body.split('INSERT INTO leaderboard_snapshots').slice(1);
  const seasonBlock = blocks.find((b) => b.includes('$7, $6, 1, 4200'));
  assert.ok(seasonBlock, 'a snapshot block must target the season event');
  const rows = seasonBlock.slice(0, seasonBlock.indexOf('ON CONFLICT'));

  // Two snapshot times, so the "latest snapshot per (user, event)" rule the
  // aggregate depends on (standings.js's DISTINCT ON) is genuinely
  // exercised on this event — the earlier totals are strictly lower, so a
  // rule that picked the wrong row would visibly under-count. Both times
  // reuse the regular block's own interpolated constants.
  assert.equal((rows.match(/\$\{EARLIER_SNAPSHOT\}/g) || []).length, 6);
  assert.equal((rows.match(/\$\{LATER_SNAPSHOT\}/g) || []).length, 6);

  // The podium-EXCLUDED fixture user leads on POINTS (4600 -> 5200 season
  // total) so the "—" rank, the non-podium tag and the home widget's
  // podium-skip all stay reachable on the DEFAULT board, not just on the
  // regular event's.
  assert.match(rows, /\$7, \$1, 1, 4600/,
    'seasonWide1 (exclude_podium) must top the season board on points');
  // ...and `mixed`, third on the regular event, tops the season podium — so
  // "the default board changed" is provable from the preview alone.
  assert.match(rows, /\$7, \$6, 1, 4200/);
});

test('4 challenge_kinds', () => {
  const start = body.indexOf('INSERT INTO challenge_kinds');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  for (const kind of ['REPORT_BUG_CHALLENGE', 'SEND_TRANSACTION_CHALLENGE',
    'SOCIAL_SHARE_CHALLENGE', 'INVITE_PARTICIPANT_CHALLENGE']) {
    assert.match(block, new RegExp(`'${kind}'`));
  }
});

test('5 challenge_templates', () => {
  const start = body.indexOf('INSERT INTO challenge_templates');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 5);
});

// The artwork slugs. An INSERT guarded by ON CONFLICT (id) DO NOTHING only
// lands on a database that has none of these ids, so the backfill is what gives
// an existing staging clone its pictures. It runs on every staging boot, so it
// is scoped to rows no admin has saved (updated_at = created_at): a template an
// organiser cleared to (none) is NULL too, and must stay bare. The two lists
// must name the same slugs, and every slug must be one the client registry
// draws — a slug it does not know renders the fallback, which would look like
// a bug.
test('seeded templates carry registry artwork, and a backfill of untouched rows repeats it for older databases', async () => {
  const registry = fs.readFileSync(
    path.join(__dirname, '..', 'frontend/src/lib/challenge-illustrations.ts'), 'utf8');
  const members = new Set([...registry.matchAll(/^\s*'([a-z0-9-]+)': \{ label:/gm)].map((m) => m[1]));
  assert.ok(members.size >= 9, 'the registry keys parse out of the source');

  const inserted = new Map();
  let statements = 0;
  for (let start = body.indexOf('INSERT INTO challenge_templates'); start >= 0;
    start = body.indexOf('INSERT INTO challenge_templates', start + 1)) {
    statements += 1;
    const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
    assert.match(block, /metric_label, illustration, created_at, updated_at\)/,
      'illustration sits just before created_at');
    for (const m of block.matchAll(/\((9005\d\d),\s[\s\S]*?,\s+(NULL|'[a-z0-9-]+'),\s+NOW\(\),\s+NOW\(\)\)/g)) {
      inserted.set(Number(m[1]), m[2] === 'NULL' ? null : m[2].slice(1, -1));
    }
  }
  assert.equal(statements, 2);
  assert.equal(inserted.size, 8, 'every seeded template row carries an illustration value');
  const drawn = new Map([...inserted].filter(([, slug]) => slug !== null));
  for (const [id, slug] of drawn) assert.ok(members.has(slug), `template ${id}: ${slug} is a registry slug`);
  assert.ok([...inserted.values()].includes(null), 'a seeded template keeps the kind-icon fallback in view');

  process.env.USERNODE_ENV = 'staging';
  const pool = mockPool();
  await seedStagingTopochain(pool, {});
  const backfills = pool.calls.filter((c) => /^UPDATE challenge_templates SET illustration\b/.test(c.sql));
  for (const call of backfills) {
    assert.equal(call.sql,
      'UPDATE challenge_templates SET illustration = $2 WHERE id = $1 AND illustration IS NULL AND updated_at = created_at',
      'never overwrites a picture an organiser chose, nor undoes one they cleared');
  }
  assert.deepEqual(new Map(backfills.map((c) => c.params)), drawn,
    'the backfill names exactly the slugs the INSERTs seed');
});

test('14 challenges split across four of the five season_events', () => {
  const start = body.indexOf('INSERT INTO challenges');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9\d{5}, \$/gm) || [];
  assert.equal(ids.length, 14);
  const regularEventRows = block.match(/\(9\d{5}, \$1,/g) || [];
  const seasonEventRows = block.match(/\(9\d{5}, \$2,/g) || [];
  // The ended event needs its own challenges, or selecting it renders an
  // empty list that reads like the fallback is broken.
  const endedEventRows = block.match(/\(9\d{5}, \$3,/g) || [];
  const archiveEventRows = block.match(/\(9\d{5}, \$4,/g) || [];
  assert.equal(regularEventRows.length, 5, '5 challenges on the regular event');
  assert.equal(seasonEventRows.length, 3, '3 challenges on the season-type event');
  assert.equal(endedEventRows.length, 2, '2 challenges on the fully-past event');
  assert.equal(archiveEventRows.length, 4, '4 challenges on the archive-season event');

  // EVENT_EMPTY_ID is deliberately absent: it is the ONLY event with no
  // challenges, which is the only way the admin challenge list's empty
  // state can be looked at in a preview. A challenge added to it here
  // would silently delete that coverage.
  assert.equal((block.match(/\(9\d{5}, \$5,/g) || []).length, 0,
    'the unfilled event must stay challenge-free');
});

test('the archive challenges cover disabled and non-contiguous display orders', () => {
  const start = body.indexOf('INSERT INTO challenges');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  // Every other fixture challenge is enabled, so "Enable" (the control the
  // list offers on a disabled row) was unreachable in a preview.
  assert.equal((block.match(/', FALSE, \d+, FALSE/g) || []).length, 1,
    'exactly one disabled challenge fixture');
  // Contiguous 1..n orders make a reorder bug invisible — any renumbering
  // looks right. The archive event's 2/6/11 has gaps for that reason.
  for (const order of [', 2, TRUE', ', 6, FALSE', ', 11, FALSE']) {
    assert.ok(block.includes(order), `non-contiguous display order ${order} must be seeded`);
  }
});

test('8 users with emails, one exclude_podium=TRUE, one with a real bcrypt password', () => {
  const start = body.indexOf('INSERT INTO users');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const usernames = block.match(/staging-demo-topochain-participant-\d/g) || [];
  assert.equal(new Set(usernames).size, 8, '8 distinct fixture usernames');
  const emails = block.match(/staging-demo-topochain-\d@example\.invalid/g) || [];
  assert.equal(new Set(emails).size, 8, '8 distinct fixture emails');
  // exclude_podium and accept_logs are adjacent columns, so pin the pair:
  // exactly one row is podium-excluded, and exactly one has accept_logs
  // switched off (the column defaults to TRUE, so a screen showing it needs
  // a FALSE row or the column is the same all the way down).
  assert.equal((block.match(/', TRUE, TRUE,/g) || []).length, 1,
    'exactly one exclude_podium = TRUE row');
  assert.equal((block.match(/', FALSE, FALSE,/g) || []).length, 1,
    'exactly one accept_logs = FALSE row');
  assert.match(body, /const realHash = await bcrypt\.hash\(/, 'a real bcrypt hash is computed');
  assert.match(block, /\$7,/, 'the bcrypt hash param is used in place of the sentinel password for one user');
});

test('the block-producer queue has one pending and one released row', () => {
  // GET /api/v4/admin/bp-queue is literally `users WHERE bp_requested_at IS
  // NOT NULL`, and its status filter splits on bp_released_at. With no
  // requesting user the admin screen's queue is empty in every preview and
  // both the table and its filter read as broken rather than as unused.
  const start = body.indexOf('INSERT INTO users');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  assert.match(block, /bp_requested_at, bp_released_at/,
    'the queue columns are set in the users INSERT, not by a later UPDATE');
  assert.match(block, /NOW\(\) - INTERVAL '12 days', NULL\)/, 'one pending request');
  assert.match(block, /NOW\(\) - INTERVAL '25 days', NOW\(\) - INTERVAL '20 days'\)/,
    'one already-released request');
  assert.equal((block.match(/NULL, NULL\)/g) || []).length, 6,
    'the other six users are not in the queue');
});

test('7 waitlist_signups, one per thing the admin screen renders differently', () => {
  const start = body.indexOf('INSERT INTO waitlist_signups');
  assert.ok(start > 0, 'the admin Waitlist screen reads waitlist_signups, which a staging clone empties');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d, '/gm) || [];
  assert.equal(ids.length, 7);
  assert.equal((block.match(/@example\.invalid/g) || []).length, 7,
    'every fixture address is .invalid — nothing here is ever mailed');
  // One row per state that renders differently on the screen.
  assert.match(block, /NULL, NULL, NULL, NULL, NULL\)/, 'one unconfirmed, answer-less, pending row');
  assert.match(block, /NOW\(\) - INTERVAL '20 days', \$1,/, 'one released row linked to a fixture user');
  assert.equal((block.match(/'::jsonb/g) || []).length, 6, 'six rows carry survey answers');
});

// #1544 added the other half of the invite graph to the screen — who a row
// came in THROUGH, not just how many it brought. Both directions have to be
// seeded or the Referrals column is an empty cell on every row in a preview.
test('the waitlist fixtures seed both directions of the invite graph', () => {
  const start = body.indexOf('INSERT INTO waitlist_signups');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  assert.match(block, /confirmed_at, invited_by\)/,
    'invited_by is set in the INSERT, not by a later UPDATE');
  const referrals = (block.match(/, 900500\)/g) || []).length;
  assert.equal(referrals, 2, 'two rows came in through 900500, so it reads "Brought in 2"');
  assert.match(block, /"admit_together": true/,
    'and one row still carries the retired buddy flag (#1534), so a preview '
    + 'exercises the fallback that shows a stopped-being-known key under '
    + '"Other answers" instead of dropping what a signup actually submitted');
});

// The Answers column counts against the live section total, so the row that
// exists to show a filled-in survey has to actually fill every section in.
// It used to carry the retired {role, chain, why} shape, which answers none
// of them, and would have read "0 of 7 answered" (#1544).
test('the rich waitlist fixture answers every survey section', () => {
  const start = body.indexOf('INSERT INTO waitlist_signups');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const row = block.slice(block.indexOf('(900500,'), block.indexOf('(900501,'));
  for (const key of ['made_url', 'country', 'discovery', 'group', 'loss', 'handles',
    'followed_claim']) {
    assert.ok(row.includes(`"${key}"`), `900500 answers the ${key} section`);
  }
  // The values are real option codes, not invented strings: the screen
  // labels them through /api/public/waitlist/options, so a made-up code
  // renders as the code and looks like the lookup is broken.
  const { DISCOVERY_SOURCES, GROUP_SIZES, GROUP_ROLES, LOSS_ANSWERS, LOSS_KINDS } =
    require('../src/services/waitlist-questions');
  const answers = JSON.parse(row.slice(row.indexOf("'{") + 1, row.indexOf("}'") + 1));
  assert.ok(DISCOVERY_SOURCES[answers.discovery.source]);
  assert.ok(GROUP_SIZES[answers.group.size]);
  assert.ok(GROUP_ROLES[answers.group.role]);
  assert.ok(LOSS_ANSWERS[answers.loss.had]);
  for (const k of answers.loss.kind) assert.ok(LOSS_KINDS[k]);
});

// The two country fixtures are the whole point of the ISO-list change being
// reviewable: an admin opening "Survey answers" has to see a NAME. 900500
// carries the country the curated list could not express, and 900503 carries
// a namespaced retired region so the two render distinguishably side by side.
test('the waitlist fixtures seed both a real country and a retired region', () => {
  const start = body.indexOf('INSERT INTO waitlist_signups');
  const block = body.slice(start, body.indexOf('INSERT INTO user_enrollments', start));
  assert.match(block, /"country": "UY"/, 'Uruguay — the country from the report (#1527)');
  assert.match(block, /"country": "X-LA"/,
    'and a namespaced retired region, which must NOT read as Laos');
  // ON CONFLICT DO NOTHING means the literal only lands on a virgin DB, so
  // both are re-asserted for a re-cloned staging database.
  for (const [id, code] of [['900500', 'UY'], ['900503', 'X-LA']]) {
    assert.ok(
      new RegExp(`\\[${id}, '${code}'\\]`).test(block),
      `row ${id}'s country is re-asserted by a follow-up UPDATE`
    );
  }
  assert.equal((block.match(/UPDATE waitlist_signups/g) || []).length, 3,
    'one UPDATE per re-asserted fixture, and no broader rewrite');
  // The third is 900500's answers, rewritten wholesale because the row used
  // to carry the retired {role, chain, why} shape and ON CONFLICT DO NOTHING
  // would leave a re-cloned database showing "0 of 7 answered" forever. It is
  // gated on that shape being present so it is a no-op on a correct row.
  assert.match(block, /AND answers->>'role' IS NOT NULL/,
    "the wholesale rewrite only fires on the retired shape it is replacing");
});

test('user_enrollments: a mix of season-wide (NULL event) and event-scoped rows, every row carrying the same season_id', () => {
  const start = body.indexOf('INSERT INTO user_enrollments');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const rows = block.match(/\(9\d{5}, [^,]+, \$\d+, (\$\d+), NOW/g) || [];
  assert.ok(rows.length >= 8, 'a substantial number of enrollment rows');
  const seasonIdTokens = new Set(rows.map((r) => r.match(/\$\d+, NOW/)[0].split(',')[0].trim()));
  assert.equal(seasonIdTokens.size, 1,
    'every enrollment row must reference the SAME season_id placeholder (the scope invariant, enforced by construction)');
  assert.match(block, /\(\d+, NULL, /, 'at least one season-wide (NULL season_event_id) row');
  assert.ok(/\(\d+, \$\d, \$\d, /.test(block), 'at least one event-scoped row');
});

test('6 onchain_accounts, some assigned/used, some unassigned/unused, with a fake secret_key', () => {
  const start = body.indexOf('INSERT INTO onchain_accounts');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 6);
  assert.match(block, /sk_staging_demo_fake_/, 'secret_key is an obviously-fake fixture value');
  assert.match(block, /TRUE,\s*\n\s*NOW\(\) - INTERVAL/, 'at least one used account carries used_at');
  assert.match(block, /NULL, FALSE, NULL/, 'at least one unassigned (user_id NULL), unused account');
});

test('user_activities span multiple challenges with the challenge_completion replay-guard metadata', () => {
  const start = body.indexOf('INSERT INTO user_activities');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9\d{5},/gm) || [];
  assert.equal(ids.length, 12);
  assert.match(block, /'\{"kind": "challenge_completion"\}'::jsonb/);
  const challengeIds = new Set((block.match(/, (900500|900501|900502|900503|900504|900505|900506|900507)\)/g) || []));
  assert.ok(challengeIds.size >= 6, 'activities reference a variety of distinct challenges');
  // The activities screen filters by event, and until the archive rows
  // existed every row belonged to the running season — so the filter could
  // only ever return everything.
  assert.equal((block.match(/\(9007\d\d, \$[89], \$7,/g) || []).length, 4,
    '4 activities on the archive event, for the two block-producer-queue users');
  // NO row may carry a NULL challenge_id. This used to assert exactly one,
  // to put the activities table's "—" cell (its stand-in for "not tied to a
  // challenge") on screen — but user_activities.challenge_id is BIGINT NOT
  // NULL REFERENCES challenges(id), so that row failed the insert on every
  // boot and, because the seed's try/catch only warns, took the entire
  // Topochain fixture block down with it. The "—" fallback is unreachable
  // defensive code in admin-topochain.js, not a state a fixture can reach.
  assert.equal((block.match(/INTERVAL '\d+ days', NULL\)/g) || []).length, 0,
    'challenge_id is NOT NULL — a NULL here kills the whole Topochain seed');
});

// The home-screen Challenges card (#911) can draw four states, and a seed
// that omits one leaves it unreviewable — nobody can approve a state that
// never renders. The finished NUMERIC one (900514) is the newest and the
// easiest to lose: it only reads as finished if the ledger credits it all
// the way to its target, so the row count here is load-bearing.
test('the open challenge fixtures cover every state the home card can draw', () => {
  const start = body.indexOf('OPEN challenges for the home-screen');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  for (const id of ['900510', '900511', '900512', '900513', '900514']) {
    assert.match(block, new RegExp(`\\(${id}, \\$1,`), `challenge ${id} must be seeded open`);
  }
  // Open means enabled AND NOT organiser-completed AND inside the window.
  assert.equal((block.match(/TRUE, 1\d, FALSE,/g) || []).length, 5,
    'all five are enabled and not organiser-completed');
  assert.equal((block.match(/NOW\(\) - INTERVAL '5 days', NOW\(\) \+ INTERVAL '10 days'/g) || []).length, 5,
    'all five sit inside their schedule window');

  // 900514 hangs off the numeric template whose target the viewer loop
  // credits in full.
  assert.match(block, /\(900514, \$1, 900507,/);
  const templates = body.slice(body.indexOf('INSERT INTO challenge_templates', body.indexOf('#911')));
  assert.match(templates, /\(900507,[\s\S]*?'count', 5, 'Proposals voted'/);
});

test("the viewer loop credits the finished numeric all the way to its target", () => {
  const start = body.indexOf('INSERT INTO user_activities', body.indexOf('const VIEWER_USERNAMES'));
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  // Five rows on 900514 — one short and the bar stops at 4/5 and the glyph
  // stays a hollow ring, which is the state that is ALREADY covered.
  assert.equal((block.match(/, 900514\)/g) || []).length, 5,
    'a target of five needs five ledger rows to read as done');
  // …and the other two numeric fixtures stay part-filled, so "in progress"
  // and "finished" are both on screen.
  assert.equal((block.match(/, 900512\)/g) || []).length, 3, '900512 stays at 3 of 8');
  assert.equal((block.match(/, 900513\)/g) || []).length, 3, '900513 stays at 3 of 5');
  // Every id must stay inside the viewer's own block — base+14..base+19 is
  // the remaining slack, and overflowing into the next viewer's block is
  // swallowed by ON CONFLICT (id) rather than failing.
  const offsets = (block.match(/\$\{base \+ (\d+)\}/g) || [])
    .map((m) => Number(m.match(/\d+/)[0]));
  assert.ok(Math.max(...offsets) < 20, 'the viewer id block is 20 wide');
  assert.match(body, /const base = 900520 \+ slot \* 20;/);
});

test('epoch_stats: 3 epochs x 3 wallets, including one wallet-only (user_id NULL) row per epoch', () => {
  const start = body.indexOf('INSERT INTO epoch_stats');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 9);
  for (const epoch of [100, 101, 102]) {
    const count = (block.match(new RegExp(`, ${epoch}, `, 'g')) || []).length;
    assert.equal(count, 3, `epoch ${epoch} must appear once per wallet (3 rows)`);
  }
  assert.equal((block.match(/, NULL, \d+,/g) || []).length, 3, '3 wallet-only rows (user_id NULL)');
});

test('leaderboard_snapshots: 2 snapshot times x 6 users, plus 4 on the ended event', () => {
  const start = body.indexOf('INSERT INTO leaderboard_snapshots');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 16);
  const earlierRows = (block.match(/EARLIER_SNAPSHOT/g) || []).length;
  const laterRows = (block.match(/LATER_SNAPSHOT/g) || []).length;
  assert.equal(earlierRows, 6);
  assert.equal(laterRows, 6);
  // Two events are targeted now: the regular one (12 rows across two
  // snapshot times) and the fully-past one (4 rows), so a preview of the
  // between-events fallback shows a POPULATED table under the "nothing is
  // running right now" caption rather than an empty one.
  const eventTokens = new Set((block.match(/\(9005\d\d, (\$\d),/g) || []).map((m) => m.match(/\$\d/)[0]));
  assert.equal(eventTokens.size, 2, 'snapshots target the regular event and the ended one');
  const endedRows = (block.match(/NOW\(\) - INTERVAL '90 days'/g) || []).length;
  assert.equal(endedRows, 4, '4 standings rows on the fully-past event');
});

test('1 terms_version + 2 explicit user_terms_consents', () => {
  assert.equal((body.match(/INSERT INTO terms_versions/g) || []).length, 1);
  const start = body.indexOf('INSERT INTO user_terms_consents');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 2);
});

test('blanket accepted consent for every remaining cloned user (issue #1297)', () => {
  // The web shell auto-prompts any signed-in user whose consent for the
  // current published version is null, so the seed must erase that state
  // for every cloned account or the sheet slides over every preview route
  // the declared checks screenshot. Natural-key arbiter, not (id): the
  // blanket rows ride the BIGSERIAL default.
  const start = body.indexOf('SELECT u.id, 900500, \'accepted\'');
  assert.ok(start > 0, 'the blanket INSERT ... SELECT over users must exist');
  const block = body.slice(body.lastIndexOf('INSERT INTO user_terms_consents', start), start + 400);
  assert.match(block, /FROM users u/);
  assert.match(block, /ON CONFLICT \(user_id, terms_version_id\) DO NOTHING/);
});

test('1 app_version_config per OS (ios, android)', () => {
  const start = body.indexOf('INSERT INTO app_version_configs');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  assert.match(block, /'ios'/);
  assert.match(block, /'android'/);
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 2);
  assert.match(body, /UPDATE app_version_configs[\s\S]*?SET is_active = FALSE[\s\S]*?WHERE os = 'android'/,
    'the cloned staging DB always carries one deterministic inactive-rule warning');
});

test('the Android rule is DEACTIVATED, not merely offered as an inactive insert', () => {
  // The insert above skips an OS the clone already configured, and
  // production keeps BOTH ios and android active — so on a prod-cloned
  // staging DB neither fixture row lands and the admin screen's "No
  // active version rule for Android" warning cannot render (dapp.json
  // asserts exactly that text on /#admin/app-version). The
  // declared state has to be forced, whatever the clone brought.
  const start = body.indexOf('INSERT INTO app_version_configs');
  const after = body.slice(start);
  const upd = after.slice(after.indexOf('UPDATE app_version_configs'));
  const stmt = upd.slice(0, upd.indexOf('`'));
  assert.match(stmt, /SET is_active = FALSE/);
  assert.match(stmt, /WHERE os = 'android'/);
  // iOS is left exactly as the clone had it — one OS gated, one OS open is
  // the contrast the warning exists to draw.
  assert.ok(!/'ios'/.test(stmt), 'the iOS rule must not be touched');
  const check = DAPP_TESTS.find((t) => t.path === '/#admin/app-version'
    && /No active version rule/i.test(t.expectText || ''));
  assert.ok(check, 'the declared check this fixture exists for is still there');
});

test('obsolete legacy delegation fixtures are retired only before cutover', () => {
  assert.equal((body.match(/INSERT INTO account_delegation_periods/g) || []).length, 0);
  assert.match(body, /DELETE FROM account_delegation_periods/);
  assert.match(body, /id = 900500[\s\S]*ut1stagingdemotopochainacct000001/);
  assert.match(body, /id = 900501[\s\S]*ut1stagingdemotopochainacct000004/);
  assert.match(
    body,
    /NOT EXISTS \([\s\S]*native_epoch_delegation_fences[\s\S]*cutover_epoch IS NOT NULL/,
  );
});

test('token_allocation for 3 users', () => {
  const start = body.indexOf('INSERT INTO token_allocation');
  const block = body.slice(start, body.indexOf('ON CONFLICT (id) DO NOTHING', start));
  const ids = block.match(/^\s*\(9005\d\d,/gm) || [];
  assert.equal(ids.length, 3);
});

// ─── 3. The signed-in viewer's own rows ─────────────────────────────────
//
// Everything above belongs to six fixture users nobody logs in as. The
// #profile screen renders the SIGNED-IN user, so a tester who opens it in
// a preview saw an empty screen — indistinguishable from a broken one.
//
// Three identities look at that screen and all three need rows: the
// interactive admin login, plus `usernode-capture` (screenshots) and
// `usernode-capture-admin` (declared dapp.json checks). Seeding only one
// of them is exactly the regression these tests exist to catch.

const VIEWERS = ['staging-admin', 'usernode-capture', 'usernode-capture-admin'];

// mockPool() answers every statement with zero rows, so the viewer loop
// never runs under it. This variant resolves the username lookup, and can
// resolve it in any order / with any subset.
function viewerPool(usernames) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM users WHERE username = ANY/.test(sql)) {
        return { rows: usernames.map((username, i) => ({ id: 700 + i, username })) };
      }
      return { rows: [] };
    },
  };
}

// The viewer INSERTs, keyed by table, from one seeder run.
async function viewerInserts(usernames) {
  process.env.USERNODE_ENV = 'staging';
  const pool = viewerPool(usernames);
  await seedStagingTopochain(pool, { adminUsername: VIEWERS[0] });
  // The viewers own the 900520+ id blocks; every fixture row above them
  // stops at 900516.
  return pool.calls.filter((c) => /INSERT INTO/.test(c.sql) && /\(9005[2-9]\d,/.test(c.sql));
}

test('the viewer lookup asks for all three tester identities', async () => {
  process.env.USERNODE_ENV = 'staging';
  const pool = viewerPool(VIEWERS);
  await seedStagingTopochain(pool, { adminUsername: VIEWERS[0] });
  const lookup = pool.calls.find((c) => /FROM users WHERE username = ANY/.test(c.sql));
  assert.ok(lookup, 'the seeder must resolve its viewers by username');
  assert.deepEqual(lookup.params[0].slice().sort(), VIEWERS.slice().sort(),
    'screenshots sign as usernode-capture and dapp.json checks as usernode-capture-admin');
});

test('every resolved viewer gets its own profile fixture block', async () => {
  const inserts = await viewerInserts(VIEWERS);
  const perTable = {};
  for (const call of inserts) {
    const table = call.sql.match(/INSERT INTO (\w+)/)[1];
    (perTable[table] ||= []).push(call);
  }
  // The six tables the #profile screen reads.
  for (const table of ['onchain_accounts', 'user_enrollments', 'user_activities',
    'leaderboard_snapshots', 'token_allocation', 'epoch_stats']) {
    assert.equal(perTable[table]?.length, 3,
      `${table} must be seeded once per viewer, not once in total`);
  }
  // Three distinct users, three distinct wallets.
  const userIds = new Set(perTable.onchain_accounts.map((c) => c.params[0]));
  const wallets = new Set(perTable.onchain_accounts.map((c) => c.params[1]));
  assert.equal(userIds.size, 3);
  assert.equal(wallets.size, 3, 'a shared address would collide on the unique index');
});

test('no two viewers share a row id (ON CONFLICT would silently drop the second)', async () => {
  const inserts = await viewerInserts(VIEWERS);
  const seen = new Map();
  for (const call of inserts) {
    const table = call.sql.match(/INSERT INTO (\w+)/)[1];
    for (const [, id] of call.sql.matchAll(/\((9\d{5}),/g)) {
      const key = `${table}#${id}`;
      assert.ok(!seen.has(key), `id ${id} reused in ${table} across viewers`);
      seen.set(key, true);
    }
  }
  assert.ok(seen.size >= 18, `expected ≥18 viewer rows, got ${seen.size}`);
});

test("a viewer's id block is keyed off its username, not the result order", async () => {
  // Staging containers rebuild on every push, and the capture identities
  // are created by a separate bootstrap — so the set of existing viewers,
  // and the order Postgres returns them in, both vary between boots. If
  // the ids moved with the result order, the reseed would insert the same
  // rows again under fresh ids and ON CONFLICT (id) would never fire.
  const idsFor = (calls) => calls
    .filter((c) => /INSERT INTO onchain_accounts/.test(c.sql))
    .map((c) => c.sql.match(/VALUES \((9\d{5}),/)[1]);

  const all = idsFor(await viewerInserts(VIEWERS));
  const reversed = idsFor(await viewerInserts(VIEWERS.slice().reverse()));
  assert.deepEqual(reversed.slice().reverse(), all, 'result order must not move any id');

  // And with the admin login absent entirely, the capture identities keep
  // the ids they had.
  const captureOnly = idsFor(await viewerInserts(VIEWERS.slice(1)));
  assert.deepEqual(captureOnly, all.slice(1),
    'a missing identity must not shift the remaining viewers onto new ids');
});

test('an unknown username is skipped rather than seeded into slot -1', async () => {
  const inserts = await viewerInserts(['someone-else']);
  assert.equal(inserts.length, 0,
    'indexOf() === -1 must be guarded — 900520 + -10 is another block');
});

test("the viewer's leaderboard row does not claim a contradictory rank 1", () => {
  const block = body.slice(body.indexOf('const VIEWER_USERNAMES'));
  const snapshot = block.slice(block.indexOf('INSERT INTO leaderboard_snapshots'));
  // Three viewers all seeded as #1 with different totals reads as a bug in
  // the screen. Rank 2 on 350 points ties an existing fixture user.
  assert.match(snapshot.slice(0, snapshot.indexOf('ON CONFLICT')), /\$1, 2, 350,/);
});
