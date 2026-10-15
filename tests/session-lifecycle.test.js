// Tests for src/services/session-lifecycle.js — the reversible-archive
// surface added with the stale-promoted-PR policy.
//
// Like pr-metadata.test.js we stub the Docker/GitHub/WS collaborators via
// require.cache so nothing real spins up, then drive archiveSession /
// unarchiveSession / purgeArchivedCc against a mock pool and assert both
// the SQL the service issues and the side-effects it triggers.
//
// Run with: node --test tests/session-lifecycle.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Mock pool ───────────────────────────────────────────────────────────
// Matches each query() against a list of [regex, rows] handlers (first
// match wins) and records every call so tests can assert on the SQL.
function makePool(handlers) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, rows] of handlers) {
        if (re.test(sql)) {
          return { rows: typeof rows === 'function' ? rows(params) : rows };
        }
      }
      return { rows: [] };
    },
    // Returns true if any issued query matched `re`.
    issued(re) { return calls.some((c) => re.test(c.sql)); },
  };
}

// ── Collaborator stubs ────────────────────────────────────────────────────
// Install before requiring the subject; returns { subject, spies, restore }.
function loadWithStubs() {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    staging: require.resolve('../src/services/staging'),
    worker: require.resolve('../src/services/worker'),
    activeWorkers: require.resolve('../src/services/active-workers'),
    workerProgress: require.resolve('../src/services/worker-progress'),
    github: require.resolve('../src/services/github'),
    ws: require.resolve('../src/services/ws'),
    subject: require.resolve('../src/services/session-lifecycle'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];

  const spies = {
    teardownStaging: [],
    destroyWorker: [],
    destroyCcVolume: [],
    workerProgressClear: [],
    closePR: [],
    reopenPR: [],
    reopenShouldThrow: false,
    getPR: [],
    getPRResult: null,
    getPRShouldThrow: false,
    pushSessionUpdate: [],
    pushIssueUpdate: [],
    sendSystemMessage: [],
    sendSystemMessageShouldThrow: false,
    busySessionIds: new Set(),
  };

  const stub = (id, exports) => {
    require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
  };

  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.staging, {
    teardownStaging: async (session, app) => { spies.teardownStaging.push({ session, app }); },
  });
  stub(ids.worker, {
    workerContainerName: (sessionId) => `usernode-worker-${sessionId}`,
    destroyWorker: async (name) => { spies.destroyWorker.push(name); },
    destroyCcVolume: async (sessionId) => { spies.destroyCcVolume.push(sessionId); },
    isInFlight: () => false,
  });
  stub(ids.activeWorkers, {
    isSessionBusy: (sessionId) => spies.busySessionIds.has(Number(sessionId)),
  });
  stub(ids.workerProgress, {
    clear: (sessionId) => { spies.workerProgressClear.push(sessionId); },
  });
  stub(ids.github, {
    closePR: async (owner, repo, pr) => { spies.closePR.push({ owner, repo, pr }); },
    reopenPR: async (owner, repo, pr) => {
      spies.reopenPR.push({ owner, repo, pr });
      if (spies.reopenShouldThrow) throw new Error('branch deleted');
    },
    getPR: async (owner, repo, pr) => {
      spies.getPR.push({ owner, repo, pr });
      if (spies.getPRShouldThrow) throw new Error('api hiccup');
      return spies.getPRResult;
    },
  });
  stub(ids.ws, {
    pushSessionUpdate: (payload) => { spies.pushSessionUpdate.push(payload); },
    pushIssueUpdate: (payload) => { spies.pushIssueUpdate.push(payload); },
    sendSystemMessage: async (pool, appId, content, msgType, metadata) => {
      spies.sendSystemMessage.push({ appId, content, msgType, metadata });
      if (spies.sendSystemMessageShouldThrow) throw new Error('chat insert failed');
    },
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);

  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, spies, ids, restore };
}

const REPO = 'https://github.com/acme/widget';

test('archiveSession: keeps CC volume by default (reversible), closes PR, tears down', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 7 }]],
      [/SELECT cs\.\*/, [{
        id: 7, app_slug: 'widget', repo_url: REPO,
        pr_number: 12, staging_container_id: 'sc-1', cc_purged: false,
      }]],
    ]);

    const res = await subject.archiveSession({ pool, sessionId: 7, userId: 3, reason: 'manual' });

    assert.equal(res.archived, true);
    assert.equal(res.appSlug, 'widget');
    // PR closed, worker destroyed, staging torn down...
    assert.deepEqual(spies.closePR, [{ owner: 'acme', repo: 'widget', pr: 12 }]);
    assert.deepEqual(spies.destroyWorker, ['usernode-worker-7']);
    assert.equal(spies.teardownStaging.length, 1);
    // ...but the CC volume is PRESERVED (the whole point of reversible archive).
    assert.deepEqual(spies.destroyCcVolume, []);
    assert.equal(pool.issued(/SET cc_purged = TRUE/), false);
    // #851: the staging columns are nulled by teardownStaging, which is the
    // ONLY place that knows whether the container actually went away. This
    // caller used to run its own nulling UPDATE on top; that is exactly how a
    // failed removal ended up with a live container and a nulled row, so the
    // duplicate is gone and the chokepoint above owns it.
    assert.equal(pool.issued(/staging_container_id = NULL/), false,
      'the caller must not null behind the chokepoint (see tests/staging-teardown-leak.test.js)');
    assert.equal(spies.pushSessionUpdate[0].action, 'archived');
  } finally {
    restore();
  }
});

test('finalizeArchivedSession cleans up a predecessor whose status changed in another transaction', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SELECT cs\.\*/, [{
        id: 7, app_id: 2, app_slug: 'widget', repo_url: REPO,
        pr_number: null, staging_container_id: 'sc-1', linked_issues: [1647],
      }]],
    ]);

    const res = await subject.finalizeArchivedSession({
      pool, sessionId: 7, userId: 3, reason: 'proposal-replaced',
    });

    assert.deepEqual(res, { archived: true, appSlug: 'widget' });
    assert.equal(pool.issued(/SET status = 'archived'/), false,
      'the predecessor and successor status changes belong to the caller transaction');
    assert.equal(spies.teardownStaging.length, 1);
    assert.deepEqual(spies.destroyWorker, ['usernode-worker-7']);
    assert.equal(spies.pushSessionUpdate[0].action, 'archived');
  } finally {
    restore();
  }
});

test('archiveSession: ownerClause omitted for system calls (no userId)', async () => {
  const { subject, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 9 }]],
      [/SELECT cs\.\*/, [{ id: 9, app_slug: 'w', repo_url: REPO, pr_number: null }]],
    ]);
    await subject.archiveSession({ pool, sessionId: 9, reason: 'stale-pr' });
    const upd = pool.calls.find((c) => /SET status = 'archived'/.test(c.sql));
    assert.ok(!/user_id = \$2/.test(upd.sql), 'system archive must not scope by user_id');
    assert.deepEqual(upd.params, [9]);
  } finally {
    restore();
  }
});

test('archiveSession: purgeCc=true destroys the CC volume immediately', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 5 }]],
      [/SELECT cs\.\*/, [{ id: 5, app_slug: 'w', repo_url: REPO, pr_number: null }]],
    ]);
    await subject.archiveSession({ pool, sessionId: 5, purgeCc: true });
    assert.deepEqual(spies.destroyCcVolume, [5]);
    assert.equal(pool.issued(/SET cc_purged = TRUE/), true);
  } finally {
    restore();
  }
});

test('archiveSession: owner-scopes the UPDATE by user_id when a userId is given', async () => {
  // Backs the proposal-card Withdraw button: POST /api/sessions/:id/archive
  // passes req.user.id, so the archive only matches the proposer's own row.
  const { subject, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 7 }]],
      [/SELECT cs\.\*/, [{ id: 7, app_slug: 'w', repo_url: REPO, pr_number: null }]],
    ]);
    await subject.archiveSession({ pool, sessionId: 7, userId: 3, reason: 'manual' });
    const upd = pool.calls.find((c) => /SET status = 'archived'/.test(c.sql));
    assert.match(upd.sql, /AND user_id = \$2/, 'owner-scoped on the caller');
    assert.match(upd.sql, /status IN \('active', 'promoted', 'paused'\)/,
      'only matches still-live rows (a merging/merged PR is left alone)');
    assert.deepEqual(upd.params, [7, 3], 'params carry sessionId + userId');
  } finally {
    restore();
  }
});

test('archiveSession: returns archived=false when no row matched (non-owner tap)', async () => {
  // A non-owner POST matches no row (the AND user_id = $2 fails), so the
  // archive is a harmless no-op: no PR close, no teardown, no chat line.
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([[/SET status = 'archived'/, []]]);
    const res = await subject.archiveSession({ pool, sessionId: 1, userId: 2 });
    assert.equal(res.archived, false);
    assert.deepEqual(spies.destroyWorker, []);
    assert.deepEqual(spies.closePR, []);
    assert.deepEqual(spies.sendSystemMessage, []);
  } finally {
    restore();
  }
});

test('archiveSession: a rename/visibility PR row archives like any promoted session', async () => {
  // Rename ('rename/…') and visibility ('visibility/…') PRs are ordinary
  // promoted chat_sessions rows, so withdrawing them via the same archive
  // path closes the PR and posts the withdrawal line with no special-casing.
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 8 }]],
      [/SELECT cs\.\*/, [{
        id: 8, app_id: 4, app_slug: 'widget', repo_url: REPO,
        branch_name: 'rename/cooler-name', pr_number: 21,
        pr_title: 'Rename to "Cooler App"', owner_username: 'evan',
      }]],
    ]);
    const res = await subject.archiveSession({ pool, sessionId: 8, userId: 3, reason: 'manual' });
    assert.equal(res.archived, true);
    assert.deepEqual(spies.closePR, [{ owner: 'acme', repo: 'widget', pr: 21 }]);
    assert.equal(spies.sendSystemMessage[0].content, 'evan withdrew “Rename to "Cooler App"”.');
  } finally {
    restore();
  }
});

// ── PR-withdrawn group-chat announcement (#200) ─────────────────────────

// One request, one story: the change by its title, never "PR #N".
test('archiveSession: manual archive announces "<user> withdrew “Title”."', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 7 }]],
      [/SELECT cs\.\*/, [{
        id: 7, app_id: 4, app_slug: 'whiteboard', repo_url: REPO,
        pr_number: 53, pr_title: 'Add sticky notes', owner_username: 'evan',
      }]],
    ]);

    const res = await subject.archiveSession({ pool, sessionId: 7, userId: 3, reason: 'manual' });

    assert.equal(res.archived, true);
    assert.equal(spies.sendSystemMessage.length, 1);
    assert.equal(spies.sendSystemMessage[0].appId, 4);
    assert.equal(spies.sendSystemMessage[0].content, 'evan withdrew “Add sticky notes”.');
    assert.equal(spies.sendSystemMessage[0].msgType, 'system');
  } finally {
    restore();
  }
});

test('archiveSession: sweeper archive announces the actor-less form', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 9 }]],
      [/SELECT cs\.\*/, [{
        // owner_username present but no userId — the actor-less wording
        // must win (nobody clicked anything; the sweeper did this).
        id: 9, app_id: 4, app_slug: 'w', repo_url: REPO,
        pr_number: 99, pr_title: null, owner_username: 'evan',
      }]],
    ]);

    await subject.archiveSession({ pool, sessionId: 9, reason: 'stale-pr' });

    assert.equal(spies.sendSystemMessage.length, 1);
    // pr_title null → "This change", never the bare PR number.
    assert.equal(spies.sendSystemMessage[0].content,
      'This change went quiet and was set aside. It can always come back as a new change.');
    assert.equal(spies.sendSystemMessage[0].msgType, 'system');
  } finally {
    restore();
  }
});

test('#11 (WP3): the Homeroom bot withdrawing its own proposal says so, never that it went quiet', async () => {
  for (const [reason, said] of [
    ['superseded', '“Watering reminders” was withdrawn: another change for the same request covers it.'],
    // Its requests closed another way: a person's change, a vote, GitHub.
    ['request-closed', '“Watering reminders” was withdrawn: the request it was built for is closed.'],
    ['withdrawn', '“Watering reminders” was withdrawn.'],
  ]) {
    const { subject, spies, restore } = loadWithStubs();
    try {
      const pool = makePool([
        [/SET status = 'archived'/, [{ id: 9 }]],
        [/SELECT cs\.\*/, [{
          id: 9, app_id: 4, app_slug: 'w', repo_url: REPO, pr_number: 99, pr_title: 'Watering reminders', owner_username: 'homeroom_bot',
        }]],
      ]);
      // The system's archive: no user, as the bot's DM tool calls it.
      await subject.archiveSession({ pool, sessionId: 9, reason });
      assert.equal(spies.sendSystemMessage[0].content, said, reason);
    } finally {
      restore();
    }
  }
});

test('archiveSession: no announcement when the session has no PR', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 5 }]],
      [/SELECT cs\.\*/, [{ id: 5, app_id: 4, app_slug: 'w', repo_url: REPO, pr_number: null, owner_username: 'evan' }]],
    ]);
    await subject.archiveSession({ pool, sessionId: 5, userId: 3 });
    assert.deepEqual(spies.sendSystemMessage, []);
  } finally {
    restore();
  }
});

test('archiveSession: a failing chat insert never fails the archive', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    spies.sendSystemMessageShouldThrow = true;
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 7 }]],
      [/SELECT cs\.\*/, [{
        id: 7, app_id: 4, app_slug: 'widget', repo_url: REPO,
        pr_number: 12, pr_title: 'Fix nav', owner_username: 'evan',
      }]],
    ]);

    const res = await subject.archiveSession({ pool, sessionId: 7, userId: 3, reason: 'manual' });

    assert.equal(res.archived, true, 'chat failure is non-fatal');
    assert.equal(spies.sendSystemMessage.length, 1, 'the send was attempted');
    assert.deepEqual(spies.closePR, [{ owner: 'acme', repo: 'widget', pr: 12 }]);
    assert.equal(spies.pushSessionUpdate[0].action, 'archived');
  } finally {
    restore();
  }
});

test('unarchiveSession: restores to paused and reopens the PR', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'paused', archived_at = NULL/, [{ id: 7 }]],
      [/SELECT cs\.\*/, [{ id: 7, app_slug: 'widget', repo_url: REPO, pr_number: 12, cc_purged: false }]],
    ]);
    const res = await subject.unarchiveSession({ pool, sessionId: 7, userId: 3 });
    assert.equal(res.unarchived, true);
    assert.equal(res.ccPurged, false);
    assert.equal(res.prReopened, true);
    assert.deepEqual(spies.reopenPR, [{ owner: 'acme', repo: 'widget', pr: 12 }]);
    assert.equal(spies.pushSessionUpdate[0].action, 'unarchived');
  } finally {
    restore();
  }
});

test('unarchiveSession: surfaces ccPurged and survives a failed PR reopen', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    spies.reopenShouldThrow = true;
    const pool = makePool([
      [/SET status = 'paused', archived_at = NULL/, [{ id: 8 }]],
      [/SELECT cs\.\*/, [{ id: 8, app_slug: 'w', repo_url: REPO, pr_number: 99, cc_purged: true }]],
    ]);
    const res = await subject.unarchiveSession({ pool, sessionId: 8 });
    assert.equal(res.unarchived, true);
    assert.equal(res.ccPurged, true, 'caller is told memory was already purged');
    assert.equal(res.prReopened, false, 'reopen failure is non-fatal');
    assert.equal(spies.pushSessionUpdate[0].action, 'unarchived');
  } finally {
    restore();
  }
});

// ── unarchive self-heal: a definitively-closed PR reference is cleared ──
// Carrying a closed pr_number through unarchive → promote is what made a
// re-promoted proposal permanently unmergeable (session 2398 / PR #26).
// When the reopen fails AND GitHub definitively reports closed-unmerged,
// the dead reference is dropped so the next promote mints a fresh PR on
// the same branch. Transient GET failures and merged PRs leave the row
// untouched.

test('unarchiveSession: failed reopen + definitively closed-unmerged PR clears pr_number/pr_url', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    spies.reopenShouldThrow = true;
    spies.getPRResult = { state: 'closed', merged: false };
    const pool = makePool([
      [/SET status = 'paused', archived_at = NULL/, [{ id: 9 }]],
      [/SELECT cs\.\*/, [{ id: 9, app_slug: 'widget', repo_url: REPO, pr_number: 26, cc_purged: false }]],
    ]);
    const res = await subject.unarchiveSession({ pool, sessionId: 9, userId: 3 });
    assert.equal(res.unarchived, true);
    assert.equal(res.prReopened, false);
    assert.deepEqual(spies.getPR, [{ owner: 'acme', repo: 'widget', pr: 26 }]);
    assert.ok(pool.issued(/SET pr_number = NULL, pr_url = NULL/),
      'the dead PR reference is dropped so promote mints a fresh PR');
  } finally {
    restore();
  }
});

test('unarchiveSession: failed reopen on a MERGED PR leaves the reference in place', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    spies.reopenShouldThrow = true;
    spies.getPRResult = { state: 'closed', merged: true };
    const pool = makePool([
      [/SET status = 'paused', archived_at = NULL/, [{ id: 9 }]],
      [/SELECT cs\.\*/, [{ id: 9, app_slug: 'widget', repo_url: REPO, pr_number: 26, cc_purged: false }]],
    ]);
    const res = await subject.unarchiveSession({ pool, sessionId: 9 });
    assert.equal(res.unarchived, true);
    assert.equal(pool.issued(/SET pr_number = NULL/), false,
      'a merged PR reference is history, not a dead end — keep it');
  } finally {
    restore();
  }
});

test('unarchiveSession: failed reopen + transient GET failure leaves the reference in place', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    spies.reopenShouldThrow = true;
    spies.getPRShouldThrow = true;
    const pool = makePool([
      [/SET status = 'paused', archived_at = NULL/, [{ id: 9 }]],
      [/SELECT cs\.\*/, [{ id: 9, app_slug: 'widget', repo_url: REPO, pr_number: 26, cc_purged: false }]],
    ]);
    const res = await subject.unarchiveSession({ pool, sessionId: 9 });
    assert.equal(res.unarchived, true, 'the GET failure is non-fatal');
    assert.equal(pool.issued(/SET pr_number = NULL/), false,
      'never clear on an unconfirmed state — the promote-time guard catches it');
  } finally {
    restore();
  }
});

test('unarchiveSession: returns unarchived=false for a non-archived row', async () => {
  const { subject, restore } = loadWithStubs();
  try {
    const pool = makePool([[/SET status = 'paused', archived_at = NULL/, []]]);
    const res = await subject.unarchiveSession({ pool, sessionId: 1, userId: 2 });
    assert.equal(res.unarchived, false);
  } finally {
    restore();
  }
});

// ── pauseSession ──────────────────────────────────────────────────────────
// The status predicate here is load-bearing for the per-user session cap
// (#193): the cap counts only status='active' rows precisely because
// pauseSession refuses to demote 'promoted' ones (their PR must stay up
// for the merge vote). If pauseSession ever started flipping promoted
// rows — or stopped being scoped to 'active' — the cap's accounting and
// the vote endpoints would both break.

test('pauseSession: pauses an active row, destroys worker, leaves staging up', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'paused'\s+WHERE/, [{ id: 7 }]],
      [/SELECT cs\.\*/, [{ id: 7, app_slug: 'widget', repo_url: REPO, pr_number: 12 }]],
    ]);
    const res = await subject.pauseSession({ pool, sessionId: 7, userId: 3, reason: 'manual' });
    assert.equal(res.paused, true);
    assert.equal(res.appSlug, 'widget');
    assert.deepEqual(spies.destroyWorker, ['usernode-worker-7']);
    assert.deepEqual(spies.workerProgressClear, [7]);
    // Staging is intentionally NOT torn down on pause (kept warm for resume).
    assert.equal(spies.teardownStaging.length, 0);
    assert.equal(spies.pushSessionUpdate[0].action, 'paused');
  } finally {
    restore();
  }
});

test('pauseSession: only targets status=active rows (promoted are refused)', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    // No handler returns a row for the UPDATE — same as the DB seeing a
    // 'promoted' (or already-paused/archived) row: zero rows match.
    const pool = makePool([[/SET status = 'paused'\s+WHERE/, []]]);
    const res = await subject.pauseSession({ pool, sessionId: 11, userId: 3, reason: 'manual' });
    assert.equal(res.paused, false);
    // Nothing torn down, nobody notified.
    assert.deepEqual(spies.destroyWorker, []);
    assert.deepEqual(spies.pushSessionUpdate, []);
    // The UPDATE itself must be scoped to status = 'active' — that's the
    // guarantee the cap predicate relies on.
    const upd = pool.calls.find((c) => /SET status = 'paused'/.test(c.sql));
    assert.ok(/status = 'active'/.test(upd.sql), "pause UPDATE must be scoped to status = 'active'");
    assert.match(upd.sql, /source IS DISTINCT FROM 'imported'/,
      'worker lifecycle must not pause worker-less imported rows');
  } finally {
    restore();
  }
});

// #3181: a pause the platform makes while a turn is still open on the
// session ends that turn (the worker goes with it), so its owner is told the
// session stopped before finishing. A pause the owner asked for, a session
// with no turn open, and a turn that only has its cleanup left stay silent.
async function pauseWith({ reason, activeTurn, isHeadless = false }) {
  const { subject, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'paused'\s+WHERE/, [{ id: 7 }]],
      [/SELECT cs\.\*/, [{
        id: 7, user_id: 3, app_id: 21, app_slug: 'widget', is_headless: isHeadless,
        active_turn: activeTurn,
      }]],
    ]);
    const res = await subject.pauseSession({ pool, sessionId: 7, reason });
    assert.equal(res.paused, true);
    return pool.calls.find((c) => /INSERT INTO notifications[\s\S]*'session_stalled'/.test(c.sql)) || null;
  } finally {
    restore();
  }
}

const OPEN_TURN = { turnId: 't-1', phase: 'executing', mode: 'build' };

test('pauseSession: a system pause mid-turn tells the owner it stopped before finishing', async () => {
  for (const reason of ['lru', 'pressure', 'auto-idle']) {
    const insert = await pauseWith({ reason, activeTurn: OPEN_TURN });
    assert.ok(insert, `${reason}: a session_stalled notification is created`);
    assert.deepEqual(insert.params, [3, 21, 7], 'for the owner, on the app, about this session');
  }
  // A tail still to run is a turn still open too.
  assert.ok(await pauseWith({ reason: 'lru', activeTurn: { turnId: 't-1', phase: 'tail_pending' } }));
});

test('pauseSession: an owner pause, an idle session or a finished turn stays silent', async () => {
  assert.equal(await pauseWith({ reason: 'manual', activeTurn: OPEN_TURN }), null,
    'the owner paused it: a deliberate end, like pressing stop');
  assert.equal(await pauseWith({ reason: 'agent-session-switch', activeTurn: OPEN_TURN }), null,
    'parking a change is the owner too');
  assert.equal(await pauseWith({ reason: 'lru', activeTurn: null }), null,
    'nothing was running: the normal pause of an idle, finished session');
  assert.equal(await pauseWith({
    reason: 'lru', activeTurn: { turnId: 't-1', phase: 'cleanup_pending' },
  }), null, 'only the cleanup was left, so the turn had finished');
  assert.equal(await pauseWith({ reason: 'lru', activeTurn: OPEN_TURN, isHeadless: true }), null,
    'headless runs report through auto_solve_done');
});

test('freeGlobalSlot skips non-worker proposal pipelines that own the session', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    spies.busySessionIds.add(7);
    const pool = makePool([
      [/SELECT id FROM chat_sessions/, [{ id: 7 }, { id: 8 }]],
      [/SET status = 'paused'\s+WHERE/, (params) => [{ id: params[0] }]],
      [/SELECT cs\.\*/, (params) => [{ id: params[0], app_slug: 'widget' }]],
    ]);

    const result = await subject.freeGlobalSlot({ pool, graceMs: 1000 });

    assert.deepEqual(result, { freed: true, sessionId: 8 });
    const pause = pool.calls.find((call) => /SET status = 'paused'/.test(call.sql));
    assert.equal(pause.params[0], 8,
      'capacity eviction leaves the in-flight CLI staging/check pipeline alone');
    const candidates = pool.calls.find((call) => /SELECT id FROM chat_sessions/.test(call.sql));
    assert.match(candidates.sql, /source IS DISTINCT FROM 'imported'/,
      'worker capacity eviction ignores worker-less imported rows');
  } finally { restore(); }
});

test('purgeArchivedCc: destroys the volume and flips cc_purged', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([[/SET cc_purged = TRUE/, []]]);
    const res = await subject.purgeArchivedCc({ pool, sessionId: 42 });
    assert.equal(res.purged, true);
    assert.deepEqual(spies.destroyCcVolume, [42]);
    assert.equal(pool.issued(/SET cc_purged = TRUE/), true);
  } finally {
    restore();
  }
});


test('archiveSession: an owned imported PR closes through the same lifecycle', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = makePool([
      [/SET status = 'archived'/, [{ id: 17 }]],
      [/SELECT cs\.\*/, [{ id: 17, source: 'imported', app_slug: 'widget', repo_url: REPO, pr_number: 31 }]],
    ]);
    assert.equal((await subject.archiveSession({ pool, sessionId: 17, userId: 3, reason: 'manual' })).archived, true);
    assert.deepEqual(spies.closePR, [{ owner: 'acme', repo: 'widget', pr: 31 }]);
    const transition = pool.calls.find((c) => /SET status = 'archived'/.test(c.sql));
    assert.match(transition.sql, /user_id = \$2/);
    assert.deepEqual(transition.params, [17, 3]);
  } finally { restore(); }
});

// 14 Oct 2026 (#5162's follow-up): a durable build holds its session for its
// whole run (services/build-runs.js holdsSession), its turns and the time
// between them, wherever the build runs: a build on a draining process can
// sit idle between turns past either grace. Slot eviction never pauses such
// a session (pausing destroys its worker), still pauses the others, and a
// read that fails leaves it as it was before.
const HELD_SQL = /FROM wf_instances w/;

function slotPool({ candidates, held = new Set(), holdsFail = false }) {
  return makePool([
    [HELD_SQL, (params) => {
      if (holdsFail) throw new Error('connection reset');
      return [{ held: held.has(Number(params[0])) }];
    }],
    [/SELECT id FROM chat_sessions/, candidates.map((id) => ({ id }))],
    [/SET status = 'paused'\s+WHERE/, (params) => [{ id: params[0] }]],
    [/SELECT cs\.\*/, (params) => [{ id: params[0], app_slug: 'widget' }]],
  ]);
}

const pausedIn = (pool) => pool.calls.filter((c) => /SET status = 'paused'/.test(c.sql)).map((c) => c.params[0]);
const askedIn = (pool) => pool.calls.filter((c) => HELD_SQL.test(c.sql)).map((c) => c.params[0]);

test('freeGlobalSlot never pauses a session a durable build holds, and pauses the next one', async () => {
  const { subject, spies, restore } = loadWithStubs();
  try {
    const pool = slotPool({ candidates: [7, 8], held: new Set([7]) });
    assert.deepEqual(await subject.freeGlobalSlot({ pool, graceMs: 1000 }), { freed: true, sessionId: 8 });
    assert.deepEqual(pausedIn(pool), [8]);
    assert.deepEqual(spies.destroyWorker, ['usernode-worker-8'], 'the held build\'s worker is not touched');
    assert.deepEqual(askedIn(pool), [7, 8], 'asked of each session it would pause, in its order');
    // Only held ones: nothing is freed.
    const all = slotPool({ candidates: [7], held: new Set([7]) });
    assert.deepEqual(await subject.freeGlobalSlot({ pool: all, graceMs: 1000 }), { freed: false });
    assert.deepEqual(pausedIn(all), []);
    // A busy one is skipped before it is asked about.
    spies.busySessionIds.add(8);
    const busy = slotPool({ candidates: [8, 9] });
    await subject.freeGlobalSlot({ pool: busy, graceMs: 1000 });
    assert.deepEqual(askedIn(busy), [9]);
  } finally { restore(); }
});

test('freeUserSlot never pauses a session a durable build holds, and pauses the next one', async () => {
  const { subject, restore } = loadWithStubs();
  try {
    const pool = slotPool({ candidates: [7, 8], held: new Set([7]) });
    assert.deepEqual(await subject.freeUserSlot({ pool, userId: 3 }), { freed: true, sessionId: 8 });
    assert.deepEqual(pausedIn(pool), [8]);
    const all = slotPool({ candidates: [7], held: new Set([7]) });
    assert.deepEqual(await subject.freeUserSlot({ pool: all, userId: 3 }), { freed: false });
  } finally { restore(); }
});

test('slot eviction: when whether a build holds the session cannot be read, it pauses as before', async () => {
  const { subject, restore } = loadWithStubs();
  try {
    const global = slotPool({ candidates: [7, 8], held: new Set([7]), holdsFail: true });
    assert.deepEqual(await subject.freeGlobalSlot({ pool: global, graceMs: 1000 }), { freed: true, sessionId: 7 });
    const user = slotPool({ candidates: [7, 8], held: new Set([7]), holdsFail: true });
    assert.deepEqual(await subject.freeUserSlot({ pool: user, userId: 3 }), { freed: true, sessionId: 7 });
  } finally { restore(); }
});
