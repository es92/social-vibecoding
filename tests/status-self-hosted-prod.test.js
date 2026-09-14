// The self-hosted app is not a missing container.
//
// The platform hosts itself as app 10, and the admin status screen looked
// for its production container at `usernode-app-<slug>` like every other
// app's. That container has never existed: the platform runs as the
// blue/green pair its deploy workflow manages. So the "Prod missing" counter
// sat at 1 and the drift list held one phantom entry, on every poll, forever
// — a red indicator whose only meaning was "the platform is the platform".
//
// The cost of an always-red indicator is that it stops being read. It was at
// the top of the status screen while three real worker bootstrap failures
// went unnoticed below it.
//
// Run with: node --test tests/status-self-hosted-prod.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

const APP_COLUMNS = {
  id: 1, name: 'App', slug: 'app', repo_url: null, container_id: null,
  status: 'ready', created_at: new Date().toISOString(), image_ref: null,
  build_ref: null, runtime_kind: 'docker', runtime_name: null,
  self_hosted: false, created_by_username: 'someone',
  open_sessions: '0', open_issues: '0',
};

// Load status.js against canned DB rows and an EMPTY container inventory —
// so every app's production container looks missing, which is the whole
// point: only the self-hosted one should be forgiven for it.
function loadStatus(appRows, { sessions = [], busy = [], building = [], runtimeSnapshot } = {}) {
  const ids = {
    pool: require.resolve('../src/db/pool'),
    activeWorkers: require.resolve('../src/services/active-workers'),
    staging: require.resolve('../src/services/staging'),
    runtimeStatus: require.resolve('../src/services/runtime-status'),
    deployStatus: require.resolve('../src/services/deploy-status'),
    nodeStatus: require.resolve('../src/services/node-status'),
    worker: require.resolve('../src/services/worker'),
    workerProgress: require.resolve('../src/services/worker-progress'),
    logger: require.resolve('../src/services/logger'),
    subject: require.resolve('../src/services/status'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const EMPTY_CENSUS = {
    global_used: '0', active: '0', promoted: '0', paused: '0',
    archived: '0', stale_notified: '0', archived_resumable: '0',
  };
  stub(ids.pool, {
    getPool: () => ({
      query: async (sql) => {
        const text = String(sql);
        if (/FROM apps a/.test(text)) return { rows: appRows, rowCount: appRows.length };
        if (/FROM chat_sessions cs/.test(text)) return { rows: sessions, rowCount: sessions.length };
        if (/FROM llm_usage/.test(text)) return { rows: [], rowCount: 0 };
        if (/FROM chat_sessions$/m.test(text)) return { rows: [EMPTY_CENSUS], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    }),
  });
  stub(ids.activeWorkers, { isSessionBusy: (id) => busy.includes(id) });
  stub(ids.staging, { hasInFlightBuild: (id) => building.includes(id) });
  stub(ids.runtimeStatus, {
    snapshot: async () => runtimeSnapshot || ({ resources: [], stats: {}, runtimeKind: 'docker' }),
    listDockerContainers: async () => [],
    getDockerStats: async () => ({}),
  });
  stub(ids.deployStatus, { read: () => null });
  stub(ids.nodeStatus, { get: () => null, getExplorer: () => null });
  stub(ids.worker, { warmRegistrySnapshot: () => [] });
  stub(ids.workerProgress, { get: () => null });
  const noop = () => {};
  stub(ids.logger, { info: noop, warn: noop, error: noop, debug: noop, tail: () => [] });

  delete require.cache[ids.subject];
  const status = require('../src/services/status');
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k];
      else delete require.cache[id];
    }
    delete require.cache[require.resolve('../src/services/status')];
  };
  return { status, restore };
}

test('a self-hosted app is neither prod-missing nor drift', async () => {
  const { status, restore } = loadStatus([
    { ...APP_COLUMNS, id: 10, slug: 'usernode-2d5619', name: 'Homeroom', self_hosted: true },
  ]);
  try {
    const data = await status.gather({}, { isAdmin: true });
    assert.equal(data.summary.prodMissing, 0);
    assert.deepEqual(data.driftContainers, []);
    const self = data.apps.find((a) => a.slug === 'usernode-2d5619');
    assert.equal(self.prodMissing, false);
    assert.equal(self.selfHosted, true, 'the reason is carried to the UI, not just suppressed');
  } finally { restore(); }
});

test('an ordinary app with no container is STILL reported missing', async () => {
  // The counter has to keep working. Suppressing the self-app is a targeted
  // exclusion, not a way to make the indicator quiet.
  const { status, restore } = loadStatus([
    { ...APP_COLUMNS, id: 1, slug: 'ordinary', self_hosted: false },
  ]);
  try {
    const data = await status.gather({}, { isAdmin: true });
    assert.equal(data.summary.prodMissing, 1);
    assert.deepEqual(data.driftContainers, [
      { kind: 'app', slug: 'ordinary', expected: 'usernode-app-ordinary' },
    ]);
    assert.equal(data.apps[0].selfHosted, false);
  } finally { restore(); }
});

test('a mixed fleet counts only the ordinary app', async () => {
  const { status, restore } = loadStatus([
    { ...APP_COLUMNS, id: 1, slug: 'ordinary' },
    { ...APP_COLUMNS, id: 10, slug: 'usernode-2d5619', self_hosted: true },
    // `creating` was already excluded; that exclusion must survive.
    { ...APP_COLUMNS, id: 2, slug: 'brand-new', status: 'creating' },
  ]);
  try {
    const data = await status.gather({}, { isAdmin: true });
    assert.equal(data.summary.prodMissing, 1);
    assert.deepEqual(data.driftContainers.map((d) => d.slug), ['ordinary']);
  } finally { restore(); }
});

test('unobserved preview inventory cannot report missing production or preview workloads', async () => {
  const old = new Date(Date.now() - 10 * 60000).toISOString();
  const { status, restore } = loadStatus([APP_COLUMNS], {
    runtimeSnapshot: { runtimeKind: 'preview', available: false, resources: [], host: null },
    sessions: [{ id: 42, app_id: 1, branch_name: 'dev/example', pr_number: 42,
      staging_runtime_name: 'sv-preview-1-s42', created_at: old, last_activity_at: old }],
  });
  try {
    for (const isAdmin of [true, false]) {
      const data = await status.gather({}, { isAdmin });
      assert.equal(data.runtimeKind, 'preview');
      assert.equal(data.runtimeAvailable, false);
      for (const key of ['prodRunning', 'prodMissing', 'stagingRunning', 'workersReady', 'stuckSessions']) {
        assert.equal(data.summary[key], null, `${key} must not claim zero`);
      }
      assert.deepEqual(data.driftContainers, []);
      assert.deepEqual(data.stuckSessions, []);
      assert.equal(data.apps[0].runtimeAvailable, false);
      assert.equal(data.apps[0].prodMissing, false);
      assert.equal(data.apps[0].sessions[0].runtimeAvailable, false);
      assert.equal(data.apps[0].sessions[0].stagingDriftWarning, false);
    }
  } finally { restore(); }
});

test('the apps query actually selects self_hosted', async () => {
  // Without the column the flag reads undefined and the exclusion silently
  // never fires — a failure mode with no symptom other than the old bug.
  const source = require('node:fs').readFileSync('src/services/status.js', 'utf8');
  assert.match(source, /a\.runtime_name, a\.self_hosted,/);
});

test('the row says self-hosted rather than missing', async () => {
  // The counters and the per-app pill are two separate renders of the same
  // fact. Fixing only the counter leaves the one app that is definitely up
  // wearing a red "prod: missing" pill, which is the whole reason the three
  // real bootstrap failures went unread underneath it.
  const source = require('node:fs').readFileSync(
    'frontend/src/features/admin/admin-status.tsx', 'utf8');
  assert.match(source, /const selfHostedNoContainer = !!a\.selfHosted && !a\.prod;/);
  assert.match(source, /prod: \$\{prodLabel\}/);
  // Green, not red, and not the word the platform never expected to see.
  assert.match(source, /selfHostedNoContainer\s*\n?\s*\? 'running'/);
  assert.match(source, /selfHostedNoContainer\s*\n?\s*\? 'self-hosted'/);
});


test('missing-preview reporting excludes first turns, handoffs, active work and recent activity', async () => {
  const old = new Date(Date.now() - 10 * 60000).toISOString();
  const session = { app_id: 1, branch_name: 'dev/example', created_at: old,
    last_activity_at: old, pr_number: 42, staging_url: null };
  const sessions = [
    { ...session, id: 1, pr_number: null }, // First coding turn.
    { ...session, id: 2, pr_number: null, source: 'cli_handoff' },
    { ...session, id: 3, has_active_turn: true },
    { ...session, id: 4 }, // In-memory recovery/operation.
    { ...session, id: 5 }, // Preview build in progress.
    { ...session, id: 6, last_activity_at: new Date().toISOString() },
    { ...session, id: 7 }, // Submitted, idle and preview absent.
    { ...session, id: 8, staging_url: 'https://preview.example' },
    { ...session, id: 9, pr_number: null, staging_build_ref: 'builds/previous' },
  ];
  const { status, restore } = loadStatus([APP_COLUMNS], { sessions, busy: [4], building: [5] });
  try {
    const data = await status.gather({}, { isAdmin: true });
    assert.deepEqual(data.stuckSessions.map(s => s.id), [7, 9]);
    assert.equal(data.summary.stuckSessions, 2);
  } finally { restore(); }
});
