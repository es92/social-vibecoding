'use strict';

// Blue-green deploy guards: the migration lock (src/services/db-locks.js),
// that no process leads (the background work is the workflow's), the compose
// color pair, the rollout script's cutover ordering, and rollback.sh's
// deterministic single-color recovery. The scripts and compose file are
// config, so — same pattern as tests/host-deployer.test.js — the strongest
// cheap guard is pinning the load-bearing lines; db-locks.js additionally
// gets functional coverage for the paths that don't need a live Postgres.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const dbLocks = require('../src/services/db-locks');
const serverJs = read('server.js');
const compose = read('docker-compose.yml');
const rolloutSh = read('scripts', 'platform-rollout.sh');
const deploySh = read('scripts', 'deploy.sh');
const rollbackSh = read('scripts', 'rollback.sh');

function withLeaderLockEnv(value, fn) {
  const prev = process.env.PLATFORM_LEADER_LOCK;
  if (value === undefined) delete process.env.PLATFORM_LEADER_LOCK;
  else process.env.PLATFORM_LEADER_LOCK = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.PLATFORM_LEADER_LOCK;
      else process.env.PLATFORM_LEADER_LOCK = prev;
    });
}

// ── db-locks.js: the migration lock ──────────────────────────────────

test('PLATFORM_LEADER_LOCK (the infrastructure\'s name) turns the migration lock on with 1 or true; it is off by default', async () => {
  await withLeaderLockEnv(undefined, () => assert.strictEqual(dbLocks.migrationLockEnabled(), false));
  await withLeaderLockEnv('1', () => assert.strictEqual(dbLocks.migrationLockEnabled(), true));
  await withLeaderLockEnv('true', () => assert.strictEqual(dbLocks.migrationLockEnabled(), true));
  await withLeaderLockEnv('0', () => assert.strictEqual(dbLocks.migrationLockEnabled(), false));
});


function fakePool() {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
    release: () => calls.push({ sql: '<release>' }),
  };
  return { pool: { connect: async () => client }, calls };
}

test('withMigrationLock is a pass-through when the lock is disabled', async () => {
  await withLeaderLockEnv(undefined, async () => {
    const { pool, calls } = fakePool();
    const out = await dbLocks.withMigrationLock(pool, async () => 'ran');
    assert.strictEqual(out, 'ran');
    assert.strictEqual(calls.length, 0, 'must not touch the pool in single-instance mode');
  });
});

test('withMigrationLock serializes via the advisory lock and always unlocks', async () => {
  await withLeaderLockEnv('1', async () => {
    const { pool, calls } = fakePool();
    const out = await dbLocks.withMigrationLock(pool, async () => 'migrated');
    assert.strictEqual(out, 'migrated');
    assert.match(calls[0].sql, /pg_advisory_lock/);
    assert.deepStrictEqual(calls[0].params, [dbLocks.MIGRATE_LOCK_KEY]);
    assert.match(calls[1].sql, /pg_advisory_unlock/);
    assert.strictEqual(calls[2].sql, '<release>', 'the dedicated connection goes back to the pool');

    // The unlock + release must survive a throwing migration.
    const second = fakePool();
    await assert.rejects(
      () => dbLocks.withMigrationLock(second.pool, async () => { throw new Error('ddl boom'); }),
      /ddl boom/
    );
    assert.match(second.calls[1].sql, /pg_advisory_unlock/,
      'a failed migration must still release the lock or the other color hangs forever');
    assert.strictEqual(second.calls[2].sql, '<release>');
  });
});

// ── server.js: no leader ──────────────────────────────────────────────

test('server.js runs migrations under the migration lock, and the read-only roles with them', () => {
  assert.match(serverJs, /await withMigrationLock\(getPool\(config\), async \(\) => \{\n\s*const result = await migrate\(config\);\n\s*await require\('\.\/src\/services\/db-roles'\)\.ensureRoles\(config\);/,
    'two booting colors must never run DDL concurrently, nor set the roles up at once');
});

test('no process leads: what a leader ran is the workflow\'s, which every color runs at once', () => {
  const startBody = serverJs.slice(
    serverJs.indexOf('async function start()'),
    serverJs.indexOf('// Boot only when run as the entry point')
  );
  assert.ok(startBody.length > 0, 'start() exists');
  // No election, no leader timers: the races blue-green once prevented with
  // a leader (adoption, resume, the watchdog) are work items and clocks
  // claimed under leases in Postgres (src/workflow/turn/, clock/).
  for (const gone of ['becomeLeader', 'createLeadership', 'leaderTimers', 'leader-timers', 'services/leadership',
    'recoverActiveWorkers(', 'resumeHeadlessRuns', 'startTurnWatchdog(', 'sweepOrphanTurns(',
    'restoreMissingQuickReplies(', 'startLocalAgentLeaseSweeper(', 'reconcilePendingTurnCleanup(',
    "require('./src/services/estimate-backfill').start",
    // The platform's scheduled jobs are clocks of the workflow too.
    'mobilePush.start()', 'check-retention', 'startTitleHealSweeper', 'auditExistingRepoPrivacy',
    'vote-digest', 'welcome-dm', 'challenge-scorer',
    'observeMergedOnGithub(', 'reconcileStuckChecks(', 'recoverSessions(', 'startSessionAutoPauseSweeper(',
    'startStalePrSweeper(', 'startStuckChecksSweeper(', "require('./src/services/fixed-check-sync').start",
    "require('./src/services/main-drift-poller').start", "require('./src/services/app-heal').start",
    'app-creation-owner', 'startCommitSweep', 'first-request-sweep', "require('./src/services/starter-images').start",
    "require('./src/services/language-sync-runner').start", 'startOnBoot', 'ensurePlatformAssetBackend',
    'reconcileAppGateIngresses']) {
    assert.ok(!serverJs.includes(gone), `no leader runs ${gone}`);
  }
  const clock = read('src', 'workflow', 'clock', 'services.ts');
  // The wallet-link poller too: one run at a time, its cursor durable,
  // never a timer per serving process.
  assert.ok(!serverJs.includes('chainPoller.start(config)'), 'no process polls the chain on a timer of its own');
  for (const job of ['turn-leftovers', 'estimate-backfill', 'local-agent-leases', 'wallet-links']) {
    assert.match(clock, new RegExp(`name: '${job}'`), `the ${job} clock`);
  }

  // Per-instance services every color needs to serve traffic.
  for (const perInstance of [
    'app.listen(config.port',
    'ws.attach(server, config)',
    'genesisAccounts.start()',
    'statusService.start(config)',
  ]) {
    assert.ok(startBody.includes(perInstance), `start() must run per-instance: ${perInstance}`);
  }
});

test('no process sweeps workers of its own: idle workers are the worker-eviction clock\'s', () => {
  // A web process never leads (docs/plans/web-and-conductor.md), and the
  // worker of a turn it ran is any process's to use next: idle eviction is
  // one clock reading session_workers (services/worker-eviction.js).
  assert.doesNotMatch(serverJs, /startIdleEvictionSweeper|sweepIdleWarmWorkers|sweepLeftWarmWorkers/);
  const clock = fs.readFileSync(path.join(__dirname, '..', 'src/workflow/clock/services.ts'), 'utf8');
  assert.match(clock, /name: 'worker-eviction'[\s\S]*?legacy\('services\/worker-eviction'\)\.sweep\(pool\)/);
});

// ── docker-compose.yml: the color pair ────────────────────────────────

test('compose defines both colors off one anchor, with the shared alias and the migration lock', () => {
  assert.match(compose, /x-usernode-platform: &usernode-platform/);
  assert.match(compose, /usernode-blue:\n    <<: \*usernode-platform\n    container_name: usernode-blue\n    hostname: usernode-blue/);
  assert.match(compose, /usernode-green:\n    <<: \*usernode-platform\n    container_name: usernode-green\n    hostname: usernode-green/);
  assert.doesNotMatch(compose, /container_name: usernode\n/,
    'the single pre-blue-green platform service must be gone');
  assert.match(compose, /aliases:\n\s+- usernode/,
    'both colors must carry the `usernode` network alias for PLATFORM_INTERNAL_URL and the Caddy fallbacks');
  assert.match(compose, /PLATFORM_LEADER_LOCK: "1"/,
    'two booting colors must take the migration lock');
  assert.match(compose, /image: usernode-platform:latest/,
    'one shared tag: build either color, both reference the same image');
  assert.match(compose, /\.\/caddy\/active:\/etc\/caddy\/active:ro/,
    'caddy must see the rollout-managed active-color snippet');
});

// ── platform-rollout.sh: cutover ordering ─────────────────────────────

test('rollout flips traffic before stopping the old color, and gates on health', () => {
  const idleUp = rolloutSh.indexOf('docker compose up -d --no-deps --force-recreate "usernode-$IDLE"');
  const health = rolloutSh.indexOf('wait_healthy "usernode-$IDLE"');
  const flip = rolloutSh.indexOf('write_active "$IDLE"');
  const stopOld = rolloutSh.indexOf('docker compose stop -t "$DRAIN_TIMEOUT" "usernode-$LIVE"');
  assert.ok(idleUp !== -1 && health !== -1 && flip !== -1 && stopOld !== -1);
  assert.ok(idleUp < health && health < flip && flip < stopOld,
    'start idle → health gate → flip caddy → stop old, in that order');
  assert.match(rolloutSh, /reload_caddy/, 'the flip is applied via graceful reload');
  assert.match(rolloutSh, /write_active "\$LIVE"/,
    'a failed reload must revert the active file to the still-live color');
});

test('rollout health poll needs two consecutive successes', () => {
  const waitFn = rolloutSh.slice(rolloutSh.indexOf('wait_healthy() {'));
  assert.match(waitFn.slice(0, 700), /streak/,
    'one 200 from a mid-boot process is not health — do not flip traffic on it');
  assert.match(waitFn.slice(0, 700), /-ge 2/);
});

test('rollout seeds the active file on demand and removes the legacy container', () => {
  assert.match(rolloutSh, /--ensure-active-file/);
  assert.match(rolloutSh, /docker rm -f usernode >\/dev\/null/,
    'the pre-blue-green container runs no leader lock; leaving it up double-runs every sweeper');
  assert.match(deploySh, /platform-rollout\.sh --ensure-active-file/,
    'deploy.sh must seed the file before caddy (re)starts or the Caddyfile import fails');
});

// ── rollback.sh: deterministic kill-switch ────────────────────────────

test('rollback converges on blue and handles pre-blue-green trees', () => {
  assert.match(rollbackSh, /grep -qx usernode-blue/,
    'must detect whether the rolled-back tree is blue-green at all');
  assert.match(rollbackSh, /docker compose stop -t 10 usernode-green/,
    'deterministic post-rollback state: green stopped, blue live');
  assert.match(rollbackSh, /cat > caddy\/active\/platform-upstream\.caddy/,
    'the active file is written inline — the kill-switch cannot depend on the rolled-back rollout script');
  assert.match(rollbackSh, /reverse_proxy usernode-blue:3000/);
  assert.match(rollbackSh, /docker compose up -d usernode-db usernode-node usernode-minio acme-dns caddy/,
    'scoped service list — an unscoped up would start both colors');
  assert.match(rollbackSh, /docker rm -f usernode-blue usernode-green/,
    'rolling back ACROSS the blue-green boundary must clear the color containers');
  // The unscoped `up -d --build` may only exist in the legacy (pre-blue-
  // green tree) branch — inside the blue-green branch it would start both
  // colors at once.
  const bgBranch = rollbackSh.slice(
    rollbackSh.indexOf('grep -qx usernode-blue'),
    rollbackSh.indexOf('else')
  );
  assert.doesNotMatch(bgBranch, /docker compose up -d --build/,
    'the blue-green branch must never do an unscoped build-up');
});

test('the active-color file is host state: excluded from every deploy rsync', () => {
  const deployerSh = read('scripts', 'usernode-deployer.sh');
  const workflow = read('.github', 'workflows', 'deploy.yml');
  assert.match(deployerSh, /--exclude=caddy\/active/);
  assert.match(workflow, /--exclude=caddy\/active/);
  assert.match(rollbackSh, /--exclude=caddy\/active/);
});
