'use strict';

// test:changed: when src/ server.js sql-dynamic-baseline.json (backend SQL changes must match the reviewed dynamic inventory)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
let inventoryCheck;
let inventory;

test.before(() => {
  inventoryCheck = spawnSync(process.execPath, ['scripts/check-sql.js', '--inventory-only'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(inventoryCheck.status, 0, inventoryCheck.stderr || inventoryCheck.stdout);
  const { collectQueryInventory } = require('../scripts/check-sql');
  inventory = collectQueryInventory();
});

test('SQL inventory covers static application queries and matches the reviewed dynamic baseline', () => {
  const summary = inventoryCheck.stdout.match(
    /SQL inventory: (\d+) static query variants from (\d+) \.query\(\) calls; (\d+) dynamic calls/
  );
  assert.ok(summary, `missing inventory summary: ${inventoryCheck.stdout}`);
  const [, staticCount, callCount, dynamicCount] = summary.map(Number);
  assert.ok(callCount > 2000, 'the inventory must cover the whole backend, not a hand-picked subset');
  assert.ok(staticCount / callCount > 0.9, 'at least 90% of query calls must reach PostgreSQL validation');
  assert.ok(dynamicCount > 0, 'runtime-built SQL must remain visible in the reviewed baseline');
});

test('the inventory carries the exact PostgreSQL parameter contexts from #1177', () => {
  // The pull-request import's INSERT: parameters read in more than one
  // context ($17 tested and stored, $8 stored twice) keep their casts.
  const votes = inventory.queries.find(({ text }) => (
    text.includes("CASE WHEN $17::text IS NULL THEN NULL ELSE $8::text END")
  ));
  assert.ok(votes, 'expected to inventory the pull-request import query');
  assert.match(votes.text, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7::text,/);
  assert.match(votes.text, /'imported', \$8::text, \$9, \$10, \$11,/);
});

test('the checker uses PostgreSQL Parse + Describe without executing queries', () => {
  const checker = read('scripts/check-sql.js');
  assert.match(checker, /\.unsafe\(queryText, \[\], \{ prepare: true \}\)\.describe\(\)/);

  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(
    Object.keys(pkg.devDependencies).filter((name) => (
      name.includes('safeql') || name === 'eslint' || name === 'typescript-eslint' || name === 'libpg-query'
    )),
    []
  );
  assert.equal(pkg.devDependencies.postgres, '3.4.9');
  assert.equal(pkg.devDependencies.typescript, '6.0.3');
});

test('the Discover flag write gives each parameter one explicit PostgreSQL type', () => {
  const flag = inventory.queries.find(({ text }) => (
    text.startsWith('UPDATE apps SET directory_review_status = $2')
  ));
  assert.ok(flag, 'the admin flag write must reach PostgreSQL validation');
  assert.match(flag.text, /directory_review_status = \$2::text/);
  assert.match(flag.text, /directory_reviewed_at = CASE WHEN \$3::boolean THEN NOW\(\) ELSE NULL END/);
  assert.match(flag.text, /directory_reviewed_sha = NULL/);
});

test('proposal unit suites run SQL validation against the worker PostgreSQL 17 planner', () => {
  const dockerfile = read('worker/Dockerfile');
  assert.match(dockerfile, /postgresql-17 postgresql-contrib-17/);
  assert.match(dockerfile, /PATH=\/usr\/lib\/postgresql\/17\/bin/);
  assert.doesNotMatch(dockerfile, /postgresql-15 postgresql-contrib-15/);

  const unitSuite = read('src/services/unit-suite.js');
  assert.match(unitSuite, /includes\('scripts\/check-sql\.js'\)/);
  assert.match(unitSuite, /SQL_CHECK_CONNECTION_URL=postgres:\/\/postgres:postgres@127\.0\.0\.1:5432\/postgres/);
  assert.match(unitSuite, /npm run lint:sql[\s\S]*npm test/);
  assert.match(unitSuite, /CREATE DATABASE usernode[\s\S]*export SQL_CHECK_CONNECTION_URL/, 'parallel clone suites share a preprovisioned maintenance database');
  // The suites that load the whole schema run in parallel against this
  // server: at the default lock table, a dozen at once failed with "out of
  // shared memory" (5 October 2026). 1024 holds them. Each of them also ends
  // with DROP DATABASE, whose checkpoint waited for the disk until the
  // server was started without crash safety (7 October 2026). It has nothing
  // to keep: the data directory is discarded with the job's container.
  assert.match(unitSuite, /pg_ctl -D \/home\/node\/pgdata -w -o "-c max_locks_per_transaction=1024 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" -l \/tmp\/unit-suite-postgres\.log start/);
});

test('SQL validation always audits debug permissions on the existing complete shadow schema', () => {
  const checker = read('scripts/check-sql.js');
  assert.match(checker, /await applySchema\(shadow\.shadowUrl\);[\s\S]*?const debugPolicy = await validateDebugAccess\(shadow\.shadowUrl\);/);
  assert.match(checker, /requireAllColumns: true/);
  assert.match(checker, /await reader\.connect\(\)/, 'probes use the restricted login');
  assert.match(checker, /DROP OWNED BY/);
  assert.match(checker, /DROP ROLE/);
});


test('SQL validation audits preview data approval on the same complete shadow database', () => {
  const checker=read('scripts/check-sql.js');
  assert.match(checker,/await applySchema\(shadow\.shadowUrl\);\s+const previewPolicy = await validatePlatformPreviewPolicy\(shadow\.shadowUrl\);/);
  assert.match(checker,/preview\.verifyCatalog\(catalog\)/);
});
