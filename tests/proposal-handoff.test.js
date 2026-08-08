'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function stubModule(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

function mockRes() {
  const listeners = new Map();
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    once(event, fn) {
      const entries = listeners.get(event) || [];
      entries.push(fn);
      listeners.set(event, entries);
      return this;
    },
    emit(event) {
      const entries = listeners.get(event) || [];
      listeners.delete(event);
      for (const fn of entries) fn();
    },
  };
}

function routeHandler(router, routePath, method) {
  const layer = router.stack.find((entry) => entry.route
    && entry.route.path === routePath && entry.route.methods[method]);
  if (!layer) throw new Error(`${method} ${routePath} not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeHarness() {
  const ids = {
    pool: require.resolve('../src/db/pool'),
    github: require.resolve('../src/services/github'),
    staging: require.resolve('../src/services/staging'),
    recovery: require.resolve('../src/services/staging-recovery'),
    visuals: require.resolve('../src/services/visuals'),
    activeWorkers: require.resolve('../src/services/active-workers'),
    appAccess: require.resolve('../src/services/app-access'),
    events: require.resolve('../src/services/events'),
    // #907: the staging/checks half of a handoff build now lives in a shared
    // module so a locally-run coding turn goes through the very same pipeline.
    // It has to be evicted alongside the route, or it keeps a closure over the
    // real staging and github services and the stubs below quietly stop
    // applying to everything the route delegates.
    pipeline: require.resolve('../src/services/handoff-pipeline'),
    subject: require.resolve('../src/routes/proposal-handoff'),
  };
  const original = new Map(Object.values(ids).map((id) => [id, require.cache[id]]));
  const app = {
    id: 9, slug: 'demo', name: 'Demo', repo_url: 'https://github.com/acme/demo',
    collab_visibility: 'public', view_visibility: 'public',
  };
  const state = {
    nextId: 101,
    sessions: [],
    messages: [],
    specs: [],
    github: [],
    staging: [],
    teardowns: [],
    captures: [],
    accessAppIds: [],
    accessAllowed: true,
    teardownLeaks: false,
    busy: false,
    captureBusy: false,
    stagingGate: null,
    remoteHead: null,
    archiveOnAdvance: false,
    supersedeUploadOnAdvance: false,
    rejectPending: false,
    persistStagingError: false,
    uploadHead: '3'.repeat(40),
  };
  let transactionState = null;
  const pool = {
    async query(sql, params = []) {
      const text = String(sql);
      if (text === 'BEGIN') {
        transactionState = {
          nextId: state.nextId,
          sessions: state.sessions.map((row) => ({ ...row })),
          messages: state.messages.map((message) => ({
            ...message, metadata: { ...message.metadata },
          })),
          specs: state.specs.map((row) => ({ ...row })),
        };
        return { rows: [], rowCount: 0 };
      }
      if (text === 'COMMIT') {
        transactionState = null;
        return { rows: [], rowCount: 0 };
      }
      if (text === 'ROLLBACK') {
        if (transactionState) {
          state.nextId = transactionState.nextId;
          state.sessions.splice(0, state.sessions.length, ...transactionState.sessions);
          state.messages.splice(0, state.messages.length, ...transactionState.messages);
          state.specs.splice(0, state.specs.length, ...transactionState.specs);
        }
        transactionState = null;
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT cs\.\*, a\.slug AS app_slug\s+FROM chat_sessions/.test(text)) {
        const row = state.sessions.find((s) => s.user_id === params[0]
          && s.handoff_request_id === params[1]);
        return { rows: row ? [{ ...row, app_slug: app.slug }] : [] };
      }
      if (/SELECT COUNT\(\*\) AS cnt FROM chat_sessions/.test(text)) {
        return { rows: [{ cnt: '0' }] };
      }
      if (/INSERT INTO chat_sessions/.test(text)) {
        const row = {
          id: state.nextId++, app_id: params[0], user_id: params[1], branch_name: params[2],
          status: 'active', source: params[3], handoff_request_id: params[4],
          handoff_base_sha: params[5], handoff_request_fingerprint: params[6],
          handoff_head_sha: null, handoff_uploaded_sha: null,
          handoff_local_commit_sha: null, handoff_upload_checked_sha: null,
          checks_commit_sha: null, session_title: params[7],
          spec_md: params[8], linked_issues: params[9], staging_url: null,
          check_state: null, check_error_detail: null, pr_number: null, pr_url: null,
        };
        state.sessions.push(row);
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (/SELECT version, content FROM chat_session_specs/.test(text)) {
        const rows = state.specs.filter((s) => s.session_id === Number(params[0]))
          .sort((a, b) => b.version - a.version);
        return { rows: rows.slice(0, 1) };
      }
      if (/INSERT INTO chat_session_specs/.test(text)) {
        state.specs.push({
          session_id: Number(params[0]), version: Number(params[1]),
          content: params[2], commit_sha: params[3] || null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE chat_session_specs SET commit_sha/.test(text)) {
        const row = state.specs.find((s) => s.session_id === Number(params[1])
          && s.version === Number(params[2]));
        if (row) row.commit_sha = params[0];
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (/INSERT INTO chat_session_messages/.test(text)) {
        const metadata = JSON.parse(params[3]);
        const duplicate = state.messages.some((m) => m.session_id === Number(params[0])
          && m.metadata.handoffEventId === metadata.handoffEventId);
        if (!duplicate) state.messages.push({
          session_id: Number(params[0]), role: params[1], content: params[2], metadata,
        });
        return { rows: [], rowCount: duplicate ? 0 : 1 };
      }
      if (/SELECT role, content, metadata FROM chat_session_messages/.test(text)) {
        const row = state.messages.find((m) => m.session_id === Number(params[0])
          && m.metadata.handoffEventId === params[1]);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (/SELECT cs\.\*, a\.slug AS app_slug, a\.name AS app_name/.test(text)) {
        const row = state.sessions.find((s) => s.id === Number(params[0])
          && s.user_id === Number(params[1]) && s.source === params[2]);
        return { rows: row ? [{ ...row, app_slug: app.slug, app_name: app.name,
          repo_url: app.repo_url, collab_visibility: 'public', view_visibility: 'public' }] : [] };
      }
      if (/SELECT status, checks_commit_sha FROM chat_sessions/.test(text)) {
        const row = state.sessions.find((s) => s.id === Number(params[0]));
        return { rows: row ? [{ status: row.status, checks_commit_sha: row.checks_commit_sha }] : [] };
      }
      if (/SET handoff_head_sha = \$1/.test(text)) {
        const row = state.sessions.find((s) => s.id === Number(params[1]));
        const matched = row && row.status === 'active' && row.source === params[2]
          && row.handoff_uploaded_sha === params[0]
          && (row.checks_commit_sha || null) === (params[3] || null)
          && (row.handoff_head_sha || null) === (params[4] || null)
          && (row.handoff_upload_checked_sha || null) === (params[5] || null);
        if (matched) {
          Object.assign(row, {
            handoff_head_sha: params[0],
            handoff_uploaded_sha: params[0],
            handoff_upload_checked_sha: null,
            check_state: 'pending',
            checks_commit_sha: params[0],
            staging_container_id: null,
            staging_url: null,
          });
        }
        return { rows: [], rowCount: matched ? 1 : 0 };
      }
      if (/SET handoff_uploaded_sha = \$1, handoff_local_commit_sha = \$5/.test(text)) {
        const row = state.sessions.find((s) => s.id === Number(params[1]));
        const hasUnsubmitted = row && row.handoff_uploaded_sha !== row.handoff_head_sha
          && (row.checks_commit_sha || null) === (row.handoff_upload_checked_sha || null);
        const current = hasUnsubmitted
          ? row.handoff_uploaded_sha
          : (row && (row.checks_commit_sha || row.handoff_uploaded_sha
            || row.handoff_head_sha || row.handoff_base_sha));
        const matched = row && row.status === 'active' && row.source === params[2]
          && current === params[3];
        if (matched) {
          row.handoff_upload_checked_sha = row.checks_commit_sha;
          row.handoff_uploaded_sha = params[0];
          row.handoff_local_commit_sha = params[4];
          row.check_state = null;
          row.check_error_detail = null;
        }
        return { rows: [], rowCount: matched ? 1 : 0 };
      }
      if (/SET staging_container_id = \$1, staging_url = \$2/.test(text)) {
        // #907: ownership is now an inline `source IS DISTINCT FROM 'imported'`
        // clause rather than a bound `source = $n`, because the same pipeline
        // also stages native sessions run by a local coding agent. Emulate the
        // predicate, and assert the guard is actually still in the statement.
        assert.match(text, /source IS DISTINCT FROM 'imported'/,
          'the pipeline must never stage over an imported mirror');
        const row = state.sessions.find((s) => s.id === Number(params[2]));
        const owned = row && row.source !== 'imported';
        if (/status <> 'active'/.test(text)) {
          const matched = owned
            && (row.status !== 'active' || row.checks_commit_sha === params[3]);
          if (matched) {
            row.staging_container_id = params[0];
            row.staging_url = params[1];
          }
          return { rows: [], rowCount: matched ? 1 : 0 };
        }
        if (state.persistStagingError) throw new Error('staging persistence unavailable');
        const matched = owned && row.checks_commit_sha === params[3] && row.status === 'active';
        if (matched) {
          row.staging_container_id = params[0];
          row.staging_url = params[1];
        }
        return { rows: [], rowCount: matched ? 1 : 0 };
      }
      if (/UPDATE chat_sessions SET spec_md = \$1/.test(text)) {
        const row = state.sessions.find((s) => s.id === Number(params[1]));
        row.spec_md = params[0];
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE chat_sessions SET last_activity_at/.test(text)
          || /SET check_state = 'pending'/.test(text)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { query: pool.query.bind(pool), release() {} };
    },
  };

  stubModule(ids.pool, { getPool: () => pool });
  stubModule(ids.github, {
    isEnabled: () => true,
    parseGithubUrl: () => ({ owner: 'acme', repo: 'demo' }),
    ensureBranchAtSha: async (...args) => { state.github.push(['ensure', ...args]); },
    compareCommitAncestry: async (...args) => {
      state.github.push(['compare', ...args]);
      return { status: 'ahead', aheadBy: 1 };
    },
    getBranchSha: async (...args) => {
      state.github.push(['read', ...args]);
      return state.remoteHead
        || state.sessions[0]?.handoff_uploaded_sha
        || state.sessions[0]?.checks_commit_sha
        || state.sessions[0]?.handoff_head_sha
        || BASE;
    },
    advanceBranchToSha: async (...args) => {
      state.github.push(['advance', ...args]);
      if (state.archiveOnAdvance && state.sessions[0]) state.sessions[0].status = 'archived';
      if (state.supersedeUploadOnAdvance && state.sessions[0]) {
        state.sessions[0].handoff_uploaded_sha = 'f'.repeat(40);
      }
    },
    createProposalCommit: async (...args) => {
      state.github.push(['upload', ...args]);
      return {
        sha: state.uploadHead,
        treeSha: args[2].expectedTreeSha,
        previousSha: args[2].expectedRemoteParentSha,
        localParentSha: args[2].localParentSha,
        created: true,
      };
    },
    describeGithubError: (err) => ({ message: err.message }),
  });
  stubModule(ids.staging, {
    hasInFlightBuild: () => false,
    buildAndDeployStaging: async (_config, session, _app, sha) => {
      state.staging.push([session.id, sha]);
      if (state.stagingGate) await state.stagingGate;
      return { containerId: 'container-1', stagingUrl: 'https://preview.example', hostname: 'preview' };
    },
    warmStagingCert: async () => {},
    teardownStaging: async (session) => {
      state.teardowns.push([session.id, session.staging_container_id, session.staging_url]);
      return state.teardownLeaks
        ? { removed: false, leaked: true }
        : { removed: true, leaked: false };
    },
  });
  stubModule(ids.recovery, { recordStagingBootFailure: async () => {} });
  stubModule(ids.activeWorkers, {
    isSessionBusy: () => state.busy,
    beginSessionOperation: () => () => {},
  });
  stubModule(ids.visuals, {
    hasInFlightCapture: () => state.captureBusy,
    setChecksPending: async (_pool, sessionId) => {
      if (state.rejectPending) {
        const row = state.sessions.find((candidate) => candidate.id === Number(sessionId));
        if (row) row.status = 'archived';
        return false;
      }
      return true;
    },
    notifyChecksPending: () => {},
    captureForSession: async (_config, session, _app, sha) => {
      state.captures.push([session.id, sha]);
      const row = state.sessions.find((s) => s.id === Number(session.id));
      row.check_state = 'passing';
    },
  });
  stubModule(ids.appAccess, {
    getAppForUser: async () => ({ ...app }),
    checkAppAccess: async (_pool, candidate) => {
      state.accessAppIds.push(candidate.id);
      return state.accessAllowed;
    },
  });
  stubModule(ids.events, {
    EVENT_TYPES: { DEV_SESSION_STARTED: 'dev_session_started' },
    record: () => {},
  });
  delete require.cache[ids.pipeline];
  delete require.cache[ids.subject];
  const subject = require('../src/routes/proposal-handoff');
  const router = subject.proposalHandoffRoutes({ maxGlobalSessions: 100 });
  return {
    subject, router, state,
    restore() {
      for (const [id, entry] of original) {
        if (entry) require.cache[id] = entry;
        else delete require.cache[id];
      }
      delete require.cache[ids.pipeline];
      delete require.cache[ids.subject];
    },
  };
}

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const BOT_HEAD = '3'.repeat(40);
const TREE = '4'.repeat(40);
const START_BODY = {
  schemaVersion: 1,
  requestId: 'feature-0001',
  baseSha: BASE,
  title: 'Add the useful feature',
  spec: '# Spec\n\nBuild the useful feature.',
  history: [
    { id: 'u1', kind: 'user', content: 'Please add the useful feature.', phase: 'request' },
    { id: 's1', kind: 'summary', content: 'Mapped the existing implementation.', phase: 'spec' },
  ],
  linkedIssues: [12],
};

function markUploaded(state, headSha = HEAD, localCommitSha = headSha) {
  Object.assign(state.sessions[0], {
    handoff_uploaded_sha: headSha,
    handoff_local_commit_sha: localCommitSha,
  });
}

test('handoff persistence has owner/request and per-event idempotency constraints', () => {
  const schema = fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8');
  assert.match(schema, /chat_sessions_handoff_request_idx[\s\S]*user_id, handoff_request_id/);
  assert.match(schema, /WHERE handoff_request_id IS NOT NULL/);
  assert.match(schema, /handoff_request_fingerprint VARCHAR\(64\)/);
  assert.match(schema, /handoff_uploaded_sha VARCHAR\(40\)/);
  assert.match(schema, /handoff_local_commit_sha VARCHAR\(40\)/);
  assert.match(schema, /handoff_upload_checked_sha VARCHAR\(40\)/);
  assert.match(schema, /chat_session_messages_handoff_event_idx[\s\S]*handoffEventId/);
  const server = fs.readFileSync(require.resolve('../server'), 'utf8');
  assert.match(server, /app\.use\(proposalHandoffRoutes\(config\)\)/);
  assert.match(server,
    /proposal-handoff\\\/\(\?:context\|build\|commits\)/,
    'the global 100 KiB parser delegates only handoff write bodies');
  const route = fs.readFileSync(require.resolve('../src/routes/proposal-handoff'), 'utf8');
  assert.match(route, /express\.json\(\{ limit: '512kb' \}\)/,
    'valid bounded spec, history, and test payloads share a scoped parser');
  assert.match(route, /express\.json\(\{ limit: COMMIT_UPLOAD_JSON_LIMIT \}\)/,
    'only the exact-tree upload receives the larger bounded parser');
  assert.match(route,
    /proposal-handoff\/commits'[\s\S]*requireCliMiddleware[\s\S]*drainGuard[\s\S]*commitUploadJson/,
    'CLI authentication runs before the large commit body parser');
});

test('handoff validators require a spec-first, bounded, user-visible history contract', () => {
  const { subject, restore } = makeHarness();
  try {
    const parsed = subject.parseStartBody(START_BODY);
    assert.equal(parsed.baseSha, BASE);
    assert.equal(parsed.history.length, 2);
    assert.throws(() => subject.parseStartBody({ ...START_BODY, history: [] }), /history/);
    assert.throws(() => subject.parseStartBody({
      ...START_BODY, history: [{ id: 's1', kind: 'summary', content: 'Only a summary' }],
    }), /user event/);
    assert.throws(() => subject.parseBuildBody({
      schemaVersion: 1, headSha: HEAD, unexpected: true,
    }), /unsupported field/);
    assert.doesNotThrow(() => subject.parseContextBody({
      schemaVersion: 1,
      history: [{ id: 'later-summary', kind: 'summary', content: 'Finished another local phase.' }],
    }), 'later context may be a summary without repeating a user prompt');
    const upload = subject.parseCommitUploadBody({
      schemaVersion: 1,
      localCommitSha: HEAD,
      parentSha: BASE,
      parentTreeSha: '5'.repeat(40),
      treeSha: TREE,
      message: 'Implement locally',
      authoredAt: '2026-08-04T01:02:03+04:00',
      committedAt: '2026-08-04T01:03:04+04:00',
      files: [
        { path: 'src/a.js', mode: '100644', contentBase64: 'YQ==' },
        { path: 'old.js', delete: true },
      ],
    });
    assert.equal(upload.files.length, 2);
    assert.throws(() => subject.parseCommitUploadBody({
      schemaVersion: 1, localCommitSha: HEAD, parentSha: BASE, treeSha: TREE,
      parentTreeSha: '5'.repeat(40),
      message: 'x', authoredAt: 'bad', committedAt: '2026-08-04T00:00:00Z',
      files: [{ path: '../escape', mode: '100644', contentBase64: 'not base64' }],
    }), /authoredAt|path|contentBase64/);
    assert.equal(subject.publicSessionStatus({
      id: 5,
      app_slug: 'demo',
      status: 'active',
      source: 'cli_handoff',
      branch_name: 'dev/cli-u7-feature-0001',
      handoff_base_sha: BASE,
      handoff_head_sha: HEAD,
      checks_commit_sha: HEAD,
      check_state: 'error',
      staging_url: null,
    }).state, 'failed', 'a staging boot failure must not remain stuck as deploying');
  } finally { restore(); }
});

test('build adoption is serialized per handoff session', async () => {
  const { subject, restore } = makeHarness();
  try {
    const order = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const first = subject.serializeHandoffSubmission(101, async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = subject.serializeHandoffSubmission(101, async () => {
      order.push('second:start');
      order.push('second:end');
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);
  } finally { restore(); }
});

test('an accepted local pipeline is idempotent by head and blocks a competing revision', async () => {
  const { router, state, restore } = makeHarness();
  let releaseStaging;
  state.stagingGate = new Promise((resolve) => { releaseStaging = resolve; });
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, mockRes());
    markUploaded(state);
    const build = routeHandler(router, '/api/sessions/:id/proposal-handoff/build', 'post');
    const body = {
      schemaVersion: 1,
      headSha: HEAD,
      history: [{ id: 'build-race', kind: 'summary', content: 'Built it.', phase: 'build' }],
      tests: [],
    };

    const accepted = mockRes();
    await build({
      params: { id: '101' }, body, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, accepted);
    assert.equal(accepted.statusCode, 202);

    const retry = mockRes();
    await build({
      params: { id: '101' }, body, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, retry);
    assert.equal(retry.statusCode, 202, 'a lost-response retry joins the accepted head');
    assert.equal(state.staging.length, 1, 'the retry does not launch a duplicate pipeline');

    const competing = mockRes();
    await build({
      params: { id: '101' }, body: { ...body, headSha: '3'.repeat(40) }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, competing);
    assert.equal(competing.statusCode, 409);
    assert.equal(competing.body.error, 'session_busy');
  } finally {
    releaseStaging();
    await new Promise((resolve) => setImmediate(resolve));
    restore();
  }
});

test('withdrawing while a detached handoff build runs discards its finished staging result', async () => {
  const { router, state, restore } = makeHarness();
  let releaseStaging;
  state.stagingGate = new Promise((resolve) => { releaseStaging = resolve; });
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, mockRes());
    markUploaded(state);
    const build = routeHandler(router, '/api/sessions/:id/proposal-handoff/build', 'post');
    const accepted = mockRes();
    await build({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: { schemaVersion: 1, headSha: HEAD, history: [], tests: [] },
    }, accepted);
    assert.equal(accepted.statusCode, 202);

    state.sessions[0].status = 'archived';
    releaseStaging();
    for (let i = 0; i < 10 && state.teardowns.length === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(state.teardowns, [[101, 'container-1', 'https://preview.example']]);
    assert.equal(state.sessions[0].staging_url, null,
      'an archived row never regains a preview link from the detached build');
    assert.equal(state.captures.length, 0,
      'checks never run against a preview discarded after withdrawal');
  } finally {
    releaseStaging();
    restore();
  }
});

test('a leaked preview remains discoverable when its first persistence write fails', async () => {
  const { router, state, restore } = makeHarness();
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, mockRes());
    markUploaded(state);
    state.persistStagingError = true;
    state.teardownLeaks = true;

    const build = routeHandler(router, '/api/sessions/:id/proposal-handoff/build', 'post');
    const accepted = mockRes();
    await build({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: { schemaVersion: 1, headSha: HEAD, history: [], tests: [] },
    }, accepted);
    assert.equal(accepted.statusCode, 202);
    for (let i = 0; i < 10 && !state.sessions[0].staging_url; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(state.teardowns, [[101, 'container-1', 'https://preview.example']]);
    assert.equal(state.sessions[0].staging_url, 'https://preview.example',
      'the reaper retains a durable pointer to the container that could not be removed');
    assert.equal(state.captures.length, 0);
  } finally { restore(); }
});

test('an archive that wins during GitHub adoption prevents a detached build from starting', async () => {
  const { router, state, restore } = makeHarness();
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, mockRes());
    markUploaded(state);
    state.archiveOnAdvance = true;

    const build = routeHandler(router, '/api/sessions/:id/proposal-handoff/build', 'post');
    const res = mockRes();
    await build({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: { schemaVersion: 1, headSha: HEAD, history: [], tests: [] },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'session_state_changed');
    assert.equal(state.sessions[0].status, 'archived');
    assert.equal(state.sessions[0].handoff_head_sha, null);
    assert.equal(state.staging.length, 0,
      'the archived session is not resurrected into a detached staging run');
  } finally { restore(); }
});

test('a newer upload that wins during build verification prevents stale adoption', async () => {
  const { router, state, restore } = makeHarness();
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, mockRes());
    markUploaded(state);
    state.supersedeUploadOnAdvance = true;

    const build = routeHandler(router, '/api/sessions/:id/proposal-handoff/build', 'post');
    const res = mockRes();
    await build({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: { schemaVersion: 1, headSha: HEAD, history: [], tests: [] },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'session_state_changed');
    assert.equal(state.sessions[0].handoff_head_sha, null);
    assert.equal(state.staging.length, 0);
  } finally { restore(); }
});

test('an archive after adoption but before the pending stamp still prevents staging', async () => {
  const { router, state, restore } = makeHarness();
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, mockRes());
    markUploaded(state);
    state.rejectPending = true;

    const build = routeHandler(router, '/api/sessions/:id/proposal-handoff/build', 'post');
    const res = mockRes();
    await build({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: { schemaVersion: 1, headSha: HEAD, history: [], tests: [] },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'session_state_changed');
    assert.equal(state.sessions[0].status, 'archived');
    assert.equal(state.staging.length, 0);
  } finally { restore(); }
});

test('handoff session paths require canonical positive integer ids', async () => {
  const { router, state, restore } = makeHarness();
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, mockRes());
    const beforeGithub = state.github.length;
    const build = routeHandler(router, '/api/sessions/:id/proposal-handoff/build', 'post');
    const res = mockRes();
    await build({
      params: { id: '0101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: { schemaVersion: 1, headSha: HEAD, history: [], tests: [] },
    }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(state.github.length, beforeGithub,
      'a numeric alias cannot bypass the canonical session serialization key');

    const promote = routeHandler(router, '/api/sessions/:id/promote', 'post');
    const promoteRes = mockRes();
    let promoted = false;
    await promote({
      params: { id: '0101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, promoteRes, () => { promoted = true; });
    assert.equal(promoteRes.statusCode, 404);
    assert.equal(promoted, false,
      'a numeric alias cannot fall through and bypass the exact-head promotion gate');
  } finally { restore(); }
});

test('a capture owned by the web workflow blocks local head adoption', async () => {
  const { router, state, restore } = makeHarness();
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, mockRes());
    state.captureBusy = true;
    const build = routeHandler(router, '/api/sessions/:id/proposal-handoff/build', 'post');
    const res = mockRes();
    await build({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: { schemaVersion: 1, headSha: HEAD, history: [], tests: [] },
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'session_busy');
    assert.equal(state.github.length, 1, 'only proposal_start touched GitHub');
  } finally { restore(); }
});

test('build submission rejects a commit that did not use the verified upload path', async () => {
  const { router, state, restore } = makeHarness();
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, mockRes());

    const build = routeHandler(router, '/api/sessions/:id/proposal-handoff/build', 'post');
    const res = mockRes();
    await build({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: { schemaVersion: 1, headSha: HEAD, history: [], tests: [] },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'head_not_uploaded');
    assert.match(res.body.message, /proposal_push_commit/);
    assert.equal(state.github.length, 1, 'only proposal_start may touch GitHub');
    assert.equal(state.staging.length, 0);
  } finally { restore(); }
});

test('commit upload refuses to mutate GitHub while the shared session is busy', async () => {
  const { router, state, restore } = makeHarness();
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, mockRes());
    state.busy = true;
    const upload = routeHandler(router, '/api/sessions/:id/proposal-handoff/commits', 'post');
    const res = mockRes();
    await upload({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: {
        schemaVersion: 1, localCommitSha: HEAD, parentSha: BASE,
        parentTreeSha: '5'.repeat(40), treeSha: TREE, message: 'Change',
        authoredAt: '2026-08-04T00:00:00Z', committedAt: '2026-08-04T00:00:01Z',
        files: [{ path: 'a', mode: '100644', contentBase64: 'YQ==' }],
      },
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'session_busy');
    assert.equal(state.github.filter((call) => call[0] === 'upload').length, 0);
  } finally { restore(); }
});

test('a checked web continuation supersedes an unsubmitted local upload as branch parent', async () => {
  const { subject, router, state, restore } = makeHarness();
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, mockRes());
    const upload = routeHandler(router, '/api/sessions/:id/proposal-handoff/commits', 'post');
    const first = mockRes();
    await upload({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: {
        schemaVersion: 1, localCommitSha: HEAD, parentSha: BASE,
        parentTreeSha: '5'.repeat(40), treeSha: TREE, message: 'First change',
        authoredAt: '2026-08-04T00:00:00Z', committedAt: '2026-08-04T00:00:01Z',
        files: [{ path: 'a', mode: '100644', contentBase64: 'YQ==' }],
      },
    }, first);
    assert.equal(first.statusCode, 201);

    const webHead = '6'.repeat(40);
    Object.assign(state.sessions[0], {
      checks_commit_sha: webHead,
      check_state: 'passing',
      staging_url: 'https://web-preview.example',
    });
    state.uploadHead = '7'.repeat(40);
    const second = mockRes();
    await upload({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: {
        schemaVersion: 1, localCommitSha: '8'.repeat(40), parentSha: '9'.repeat(40),
        parentTreeSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), message: 'After web',
        authoredAt: '2026-08-04T00:00:02Z', committedAt: '2026-08-04T00:00:03Z',
        files: [{ path: 'a', mode: '100644', contentBase64: 'Yg==' }],
      },
    }, second);
    assert.equal(second.statusCode, 201);
    const calls = state.github.filter((call) => call[0] === 'upload');
    assert.equal(calls[1][3].expectedRemoteParentSha, webHead);
    assert.equal(state.sessions[0].handoff_uploaded_sha, '7'.repeat(40));
    assert.equal(state.sessions[0].handoff_local_commit_sha, '8'.repeat(40));
    assert.equal(state.sessions[0].checks_commit_sha, webHead,
      'upload invalidates the verdict without relabeling the previous checked revision');
    assert.equal(state.sessions[0].check_state, null);
    assert.equal(state.sessions[0].handoff_upload_checked_sha, webHead);
    assert.equal(subject.publicSessionStatus(state.sessions[0]).state, 'uploaded',
      'a new local upload after web work remains visibly pending');

    state.uploadHead = 'c'.repeat(40);
    const third = mockRes();
    await upload({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: {
        schemaVersion: 1, localCommitSha: 'd'.repeat(40), parentSha: '8'.repeat(40),
        parentTreeSha: 'b'.repeat(40), treeSha: 'e'.repeat(40), message: 'Next local',
        authoredAt: '2026-08-04T00:00:04Z', committedAt: '2026-08-04T00:00:05Z',
        files: [{ path: 'a', mode: '100644', contentBase64: 'Yw==' }],
      },
    }, third);
    assert.equal(third.statusCode, 201);
    assert.equal(state.github.filter((call) => call[0] === 'upload')[2][3]
      .expectedRemoteParentSha, '7'.repeat(40),
      'a following local commit continues from the pending bot-owned upload');
  } finally { restore(); }
});

test('native CLI handoff persists context, adopts an exact commit, and reaches ready staging', async () => {
  const { router, state, restore } = makeHarness();
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    const startRes = mockRes();
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, startRes);
    assert.equal(startRes.statusCode, 201);
    assert.equal(startRes.body.source, 'cli_handoff');
    assert.equal(startRes.body.state, 'draft');
    assert.equal(startRes.body.webPath, '/#app/demo/dev/sessions/101');
    assert.equal(state.sessions[0].branch_name, 'dev/cli-u7-feature-0001');
    assert.deepEqual(state.messages.map((m) => [m.role, m.metadata.handoffSummary || false]), [
      ['user', false], ['assistant', true],
    ]);

    const promoteGate = routeHandler(router, '/api/sessions/:id/promote', 'post');
    const earlyPromoteRes = mockRes();
    let earlyNext = false;
    await promoteGate({
      params: { id: '101' }, cliAuthenticated: true, user: { id: 7, username: 'maker' },
    }, earlyPromoteRes, () => { earlyNext = true; });
    assert.equal(earlyPromoteRes.statusCode, 409);
    assert.equal(earlyNext, false);

    // Same request/event IDs repair safely without duplicating the session or
    // transcript. This is the retry path after a lost HTTP response.
    const retryRes = mockRes();
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, retryRes);
    assert.equal(retryRes.statusCode, 200);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.messages.length, 2);

    const versionsBeforeProgressedRetry = state.specs.length;
    Object.assign(state.sessions[0], {
      spec_md: '# Revised on the web',
      session_title: 'A later generated title',
      linked_issues: [99],
    });
    const progressedRetry = mockRes();
    await start({
      params: { slug: 'demo' }, body: START_BODY, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, progressedRetry);
    assert.equal(progressedRetry.statusCode, 200,
      'the immutable request fingerprint survives later live-field edits');
    assert.equal(state.specs.length, versionsBeforeProgressedRetry,
      'a retry never re-appends the original spec over later version history');
    Object.assign(state.sessions[0], {
      spec_md: START_BODY.spec,
      session_title: START_BODY.title,
      linked_issues: START_BODY.linkedIssues,
    });

    const conflictBody = {
      ...START_BODY,
      history: [
        { ...START_BODY.history[0], content: 'Different content under the same event ID.' },
        START_BODY.history[1],
      ],
    };
    const conflictRes = mockRes();
    await start({
      params: { slug: 'demo' }, body: conflictBody, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, conflictRes);
    assert.equal(conflictRes.statusCode, 409);
    assert.equal(conflictRes.body.error, 'request_id_conflict');

    const context = routeHandler(router, '/api/sessions/:id/proposal-handoff/context', 'post');
    const partialConflictRes = mockRes();
    await context({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
      body: {
        schemaVersion: 1,
        history: [
          { id: 'must-rollback', kind: 'summary', content: 'Do not persist me.', phase: 'build' },
          { ...START_BODY.history[0], content: 'Conflicts with the original event.' },
        ],
      },
    }, partialConflictRes);
    assert.equal(partialConflictRes.statusCode, 409);
    assert.equal(state.messages.some((m) => m.metadata.handoffEventId === 'must-rollback'), false,
      'one conflicting event rolls back the entire history batch');

    const linkedIssueConflictRes = mockRes();
    await start({
      params: { slug: 'demo' }, body: { ...START_BODY, linkedIssues: [13] },
      cliAuthenticated: true, user: { id: 7, username: 'maker' },
    }, linkedIssueConflictRes);
    assert.equal(linkedIssueConflictRes.statusCode, 409);
    assert.equal(linkedIssueConflictRes.body.error, 'request_id_conflict');

    const pushCommit = routeHandler(
      router, '/api/sessions/:id/proposal-handoff/commits', 'post'
    );
    const pushBody = {
      schemaVersion: 1,
      localCommitSha: HEAD,
      parentSha: BASE,
      parentTreeSha: '5'.repeat(40),
      treeSha: TREE,
      message: 'Implement locally',
      authoredAt: '2026-08-04T01:02:03+04:00',
      committedAt: '2026-08-04T01:03:04+04:00',
      files: [{ path: 'src/a.js', mode: '100644', contentBase64: 'YQ==' }],
    };
    const pushRes = mockRes();
    await pushCommit({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' }, body: pushBody,
    }, pushRes);
    assert.equal(pushRes.statusCode, 201);
    assert.equal(pushRes.body.localCommitSha, HEAD);
    assert.equal(pushRes.body.headSha, BOT_HEAD);
    assert.equal(pushRes.body.treeSha, TREE);
    assert.equal(state.sessions[0].handoff_uploaded_sha, BOT_HEAD);
    assert.equal(state.sessions[0].handoff_local_commit_sha, HEAD);
    assert.equal(state.sessions[0].handoff_head_sha, null,
      'upload alone does not claim that staging checked the commit');
    assert.equal(state.sessions[0].checks_commit_sha, null,
      'upload does not label an unchecked branch target as the checked revision');
    const uploadCall = state.github.find((call) => call[0] === 'upload');
    assert.equal(uploadCall[3].expectedRemoteParentSha, BASE);
    assert.equal(uploadCall[3].localParentSha, BASE);
    assert.equal(uploadCall[3].localParentTreeSha, '5'.repeat(40));

    const uploadedStatus = routeHandler(router, '/api/sessions/:id/proposal-handoff', 'get');
    const uploadedStatusRes = mockRes();
    await uploadedStatus({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' },
    }, uploadedStatusRes);
    assert.equal(uploadedStatusRes.body.state, 'uploaded');
    assert.equal(uploadedStatusRes.body.uploadedHeadSha, BOT_HEAD);
    assert.equal(uploadedStatusRes.body.headSha, null);
    assert.equal(uploadedStatusRes.body.localHeadSha, HEAD);
    assert.equal(uploadedStatusRes.body.submittedHeadSha, null);

    const build = routeHandler(router, '/api/sessions/:id/proposal-handoff/build', 'post');
    const buildRes = mockRes();
    await build({
      params: { id: '101' }, cliAuthenticated: true, user: { id: 7, username: 'maker' },
      body: {
        schemaVersion: 1,
        headSha: BOT_HEAD,
        history: [{ id: 's2', kind: 'summary', content: 'Implemented the feature.', phase: 'build' }],
        tests: [{ command: 'npm test', status: 'passed', summary: 'All tests passed.' }],
      },
    }, buildRes);
    assert.equal(buildRes.statusCode, 202);
    assert.equal(buildRes.body.headSha, BOT_HEAD);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(state.github.filter((call) => call[0] === 'compare')[0].slice(-2), [BASE, BOT_HEAD]);
    assert.deepEqual(state.staging, [[101, BOT_HEAD]]);
    assert.deepEqual(state.captures, [[101, BOT_HEAD]]);
    assert.equal(state.sessions[0].handoff_head_sha, BOT_HEAD);
    assert.equal(state.sessions[0].staging_url, 'https://preview.example');
    assert.ok(state.messages.some((m) => m.metadata.handoffEventId.startsWith(`tests:${BOT_HEAD}:`)));

    const status = uploadedStatus;
    const statusRes = mockRes();
    await status({
      params: { id: '101' }, cliAuthenticated: true, user: { id: 7, username: 'maker' },
    }, statusRes);
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.body.state, 'ready');
    assert.equal(statusRes.body.headSha, BOT_HEAD);
    assert.equal(statusRes.body.localHeadSha, HEAD);
    assert.equal(statusRes.body.submittedHeadSha, BOT_HEAD);

    const readyCheckState = state.sessions[0].check_state;
    const readyStagingUrl = state.sessions[0].staging_url;
    const pushRetryRes = mockRes();
    await pushCommit({
      params: { id: '101' }, cliAuthenticated: true,
      user: { id: 7, username: 'maker' }, body: pushBody,
    }, pushRetryRes);
    assert.equal(pushRetryRes.statusCode, 200);
    assert.equal(pushRetryRes.body.uploaded, false);
    assert.equal(state.sessions[0].check_state, readyCheckState,
      'an identical upload retry does not erase a completed verdict');
    assert.equal(state.sessions[0].staging_url, readyStagingUrl,
      'an identical upload retry preserves the checked preview');

    state.busy = true;
    const busyStatusRes = mockRes();
    await status({
      params: { id: '101' }, cliAuthenticated: true, user: { id: 7, username: 'maker' },
    }, busyStatusRes);
    assert.equal(busyStatusRes.body.state, 'checking',
      'an in-flight web operation must not expose the old checked head as ready');
    state.busy = false;

    const stagingRuns = state.staging.length;
    const readyRetryRes = mockRes();
    await build({
      params: { id: '101' }, cliAuthenticated: true, user: { id: 7, username: 'maker' },
      body: {
        schemaVersion: 1,
        headSha: BOT_HEAD,
        history: [{ id: 's2', kind: 'summary', content: 'Implemented the feature.', phase: 'build' }],
        tests: [{ command: 'npm test', status: 'passed', summary: 'All tests passed.' }],
      },
    }, readyRetryRes);
    assert.equal(readyRetryRes.statusCode, 200);
    assert.equal(readyRetryRes.body.state, 'ready');
    assert.equal(state.staging.length, stagingRuns,
      'an already-ready head retry does not rebuild healthy staging');

    const readyPromoteRes = mockRes();
    let readyNext = false;
    await promoteGate({
      params: { id: '101' }, cliAuthenticated: true, user: { id: 7, username: 'maker' },
    }, readyPromoteRes, () => { readyNext = true; });
    assert.equal(readyNext, true, 'ready CLI handoff falls through to the normal promote route');
    readyPromoteRes.emit('finish');

    // A later web turn advances the ordinary checks SHA while preserving the
    // last locally-submitted audit head and source marker. MCP status and the
    // promotion pin now follow that shared reviewed commit.
    const webHead = '6'.repeat(40);
    Object.assign(state.sessions[0], {
      checks_commit_sha: webHead,
      check_state: 'passing',
      source: 'cli_handoff',
    });
    state.remoteHead = webHead;
    const sharedStatusRes = mockRes();
    await status({
      params: { id: '101' }, cliAuthenticated: true, user: { id: 7, username: 'maker' },
    }, sharedStatusRes);
    assert.equal(sharedStatusRes.body.state, 'ready');
    assert.equal(sharedStatusRes.body.headSha, webHead);
    assert.equal(sharedStatusRes.body.localHeadSha, HEAD);
    assert.equal(sharedStatusRes.body.submittedHeadSha, BOT_HEAD);
    assert.equal(sharedStatusRes.body.source, 'cli_handoff');

    state.accessAllowed = false;
    const readsBeforeDeniedPromote = state.github.filter((call) => call[0] === 'read').length;
    const deniedPromoteRes = mockRes();
    let deniedNext = false;
    await promoteGate({
      params: { id: '101' }, user: { id: 7, username: 'maker' },
    }, deniedPromoteRes, () => { deniedNext = true; });
    assert.equal(deniedPromoteRes.statusCode, 404);
    assert.equal(deniedNext, false);
    assert.equal(state.github.filter((call) => call[0] === 'read').length, readsBeforeDeniedPromote,
      'promotion re-checks current collaboration access before touching GitHub');
    state.accessAllowed = true;

    const webReadyPromoteRes = mockRes();
    let webReadyNext = false;
    await promoteGate({
      params: { id: '101' }, user: { id: 7, username: 'maker' },
    }, webReadyPromoteRes, () => { webReadyNext = true; });
    assert.equal(webReadyNext, true, 'a checked web commit stays promotable in the shared session');
    webReadyPromoteRes.emit('finish');

    state.remoteHead = '7'.repeat(40);
    const movedPromoteRes = mockRes();
    let movedNext = false;
    await promoteGate({
      params: { id: '101' }, user: { id: 7, username: 'maker' },
    }, movedPromoteRes, () => { movedNext = true; });
    assert.equal(movedPromoteRes.statusCode, 409);
    assert.equal(movedPromoteRes.body.error, 'branch_head_changed');
    assert.equal(movedNext, false);
    assert.ok(state.accessAppIds.length > 0);
    assert.ok(state.accessAppIds.every((id) => id === 9),
      'private-app checks must receive the app id, never the session id');
  } finally { restore(); }
});

test('handoff endpoints are unavailable to browser-cookie requests', async () => {
  const { router, state, restore } = makeHarness();
  try {
    const start = routeHandler(router, '/api/apps/:slug/proposal-handoffs', 'post');
    const res = mockRes();
    await start({
      params: { slug: 'demo' }, body: START_BODY,
      user: { id: 7, username: 'maker' },
    }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'not_found' });
    assert.equal(state.sessions.length, 0);
    assert.equal(state.github.length, 0);

    const upload = routeHandler(router, '/api/sessions/:id/proposal-handoff/commits', 'post');
    const uploadRes = mockRes();
    await upload({
      params: { id: '101' }, body: {}, user: { id: 7, username: 'maker' },
    }, uploadRes);
    assert.equal(uploadRes.statusCode, 404);
    assert.deepEqual(uploadRes.body, { error: 'not_found' });
    assert.equal(state.github.length, 0);
  } finally { restore(); }
});
