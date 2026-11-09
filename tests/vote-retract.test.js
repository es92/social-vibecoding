'use strict';

// The review flow's Undo: DELETE /api/sessions/:id/vote takes the viewer's
// vote on a change back while the change is still up for a vote.
//
//   1. the vote is removed under the proposal's row lock, in its own
//      transaction, and the derived state follows it: the author's "voted"
//      notification goes, the proposal's thread says the vote was taken
//      back, the tally is pushed, the retraction is recorded, and a Yes
//      reopens the "ready to try" cards it settled. No merge is asked for;
//   2. no vote of theirs counting now is an idempotent 200 that touches
//      nothing;
//   3. a change being merged, merged or closed is refused (409 vote_locked),
//      and so is a retraction made against an epoch the change has moved on
//      from (the cast route's revision-changed answer);
//   4. the gates are the cast route's: the shared vote limiter, the
//      membership gate (403 join_required) and the router's collab guard.
//
// The client half (AppView.retractVote) is in
// tests/vote-retract-client.test.js.
//
// Run with: node --test tests/vote-retract.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const HEAD = 'a'.repeat(40);

function stub(id, exports) {
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
}

// A proposal up for a vote at epoch 2, with the viewer's current Yes on it.
function makePool({ status = 'promoted', epoch = 2, vote = { vote: 'yes', epoch: 2 }, missing = false, author = 9 } = {}) {
  const state = { status, epoch, vote, missing, author, told: [], withdrew: null };
  const log = [];
  const sessionRow = () => ({
    id: 7, app_id: 5, user_id: 9, status: state.status, pr_number: 26, pr_title: 'Dark mode',
    branch_name: 'usernode/dark-mode', source: 'native', reviewed_head_sha: HEAD,
    imported_pr_head_sha: null, app_slug: 'widget',
  });
  const client = {
    released: 0,
    async query(sql, params) {
      const text = String(sql).trim();
      log.push(text.split(/\s+/).slice(0, 3).join(' '));
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (/FROM chat_sessions WHERE id = \$1 FOR UPDATE/.test(text)) {
        return { rows: state.missing ? [] : [{ status: state.status, approval_epoch: state.epoch, user_id: state.author }] };
      }
      if (/UPDATE chat_sessions SET author_yes_withdrawn_epoch/.test(text)) {
        assert.deepEqual(params, [7, 3], 'the caller\'s own row, and no one else\'s');
        assert.match(text, /user_id = \$2/, 'only the author marks it');
        state.withdrew = state.epoch;
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM pr_votes/.test(text)) {
        assert.deepEqual(params, [7, 3], 'only the caller\'s own vote on this change');
        assert.match(text, /pv\.approval_epoch = cs\.approval_epoch/, 'only the vote that counts now');
        const v = state.vote;
        if (!v || v.epoch !== state.epoch) return { rows: [], rowCount: 0 };
        state.vote = null;
        assert.match(text, /cs\.user_id AS author_id/, 'the row says whose change it is');
        return { rows: [{ vote: v.vote, reason: v.reason || null, author_id: state.author }], rowCount: 1 };
      }
      if (/INSERT INTO wf_events/.test(text)) {
        state.told.push({ text, params });
        return { rows: [{}] };
      }
      throw new Error(`unexpected client query: ${text.slice(0, 80)}`);
    },
    release() { this.released += 1; },
  };
  return {
    state,
    log,
    client,
    async connect() { return client; },
    async query(sql) {
      const text = String(sql);
      if (/FROM chat_sessions cs JOIN apps a ON cs\.app_id = a\.id\s+WHERE cs\.id = \$1/.test(text)) {
        return { rows: state.missing ? [] : [sessionRow()] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function loadVotes(pool, { member = true, reopened = 1 } = {}) {
  const ids = {
    logger: require.resolve('../src/services/logger'),
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    notifications: require.resolve('../src/services/notifications'),
    events: require.resolve('../src/services/events'),
    appAccess: require.resolve('../src/services/app-access'),
    communities: require.resolve('../src/services/communities'),
    botDm: require.resolve('../src/services/homeroom-bot-dm'),
    platform: require.resolve('../src/workflow/platform.ts'),
    subject: require.resolve('../src/routes/votes'),
  };
  const orig = {};
  for (const [k, id] of Object.entries(ids)) orig[k] = require.cache[id];
  const realCommunities = require('../src/services/communities');
  const realBotDm = require('../src/services/homeroom-bot-dm');

  const seen = {
    systemMessages: [], voteUpdates: [], bells: [], withdrawn: [], events: [],
    reopened: [], merges: [],
  };
  stub(ids.logger, { info() {}, warn() {}, error() {}, debug() {} });
  stub(ids.pool, { getPool: () => pool });
  stub(ids.ws, {
    sendSystemMessage: async (_pool, appId, content, msgType, metadata, thread) => {
      seen.systemMessages.push({ appId, content, msgType, metadata, thread });
      return { id: 1, createdAt: new Date().toISOString() };
    },
    pushNotificationToUser(userId, msg) { seen.bells.push({ userId, msg }); },
    pushVoteUpdate(data) { seen.voteUpdates.push(data); },
    pushSessionUpdate() {},
    broadcastGlobalScoped() {},
  });
  stub(ids.notifications, {
    withdrawProposalVoteNotification: async (_pool, args) => { seen.withdrawn.push(args); return [9]; },
    markReadForSession: async () => 0,
    createProposalVoteNotification: async () => [],
    hydrateAndPush: async () => {},
  });
  stub(ids.events, {
    record: (_pool, ev) => { seen.events.push(ev); },
    EVENT_TYPES: {
      PR_VOTE_CAST: 'pr_vote_cast', PR_VOTE_RECEIVED: 'pr_vote_received', PR_VOTE_RETRACTED: 'pr_vote_retracted',
      PR_PROMOTED: 'pr_promoted', PR_MERGED: 'pr_merged',
    },
  });
  stub(ids.appAccess, { ...require('../src/services/app-access'), sessionCollabGuard: () => (_req, _res, next) => next() });
  stub(ids.communities, {
    ...realCommunities,
    requireSessionMembership: () => (req, res, next) => (member
      ? next()
      : res.status(403).json({ error: 'join_required', code: 'join_required', app: { slug: 'widget' } })),
  });
  stub(ids.botDm, {
    ...realBotDm,
    noteApprovalWithdrawn: async (_pool, sessionId, userId) => { seen.reopened.push({ sessionId, userId }); return reopened; },
  });
  stub(ids.platform, {
    wantMerge: async (m) => { seen.merges.push(m); },
  });

  delete require.cache[ids.subject];
  const subject = require(ids.subject);
  const restore = () => {
    for (const [k, id] of Object.entries(ids)) {
      if (orig[k]) require.cache[id] = orig[k]; else delete require.cache[id];
    }
  };
  return { subject, seen, restore };
}

async function withServer(pool, opts, fn) {
  const ctx = loadVotes(pool, opts);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 3, username: 'evan' }; next(); });
  app.use(ctx.subject.voteRoutes({ jwtSecret: 's', maxUserPromotedSessions: 3 }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const retract = (body) => fetch(`${base}/api/sessions/7/vote`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  try {
    await fn({ ...ctx, retract });
  } finally {
    server.close();
    ctx.restore();
  }
}

// ── 1. A vote taken back, and what follows it ─────────────────────────

test('a current Yes is taken back under the row lock, and everything derived from it follows', async () => {
  const pool = makePool();
  await withServer(pool, {}, async (ctx) => {
    const r = await ctx.retract({ expectedEpoch: 2 });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, retracted: true, merged: false, vote: 'yes', readyReopened: true });
    assert.equal(pool.state.vote, null, 'the row is gone');
    assert.deepEqual(pool.log, ['BEGIN', 'SELECT status, approval_epoch', 'DELETE FROM pr_votes', 'WITH told AS', 'COMMIT'],
      'the lock first, then the delete, in one transaction');
    assert.equal(pool.client.released, 1);

    assert.deepEqual(ctx.seen.withdrawn, [{ sessionId: 7, voterId: 3 }], 'the author\'s "voted yes" goes');
    assert.deepEqual(ctx.seen.bells, [{ userId: 9, msg: { type: 'notifications_changed' } }], 'and their bell re-syncs');
    assert.deepEqual(ctx.seen.reopened, [{ sessionId: 7, userId: 3 }], 'a Yes reopens the ready cards it settled');
    // The bot's change machine hears it in the retraction's own transaction:
    // the asker's card is read again, with no "approved it" line.
    assert.equal(pool.state.told.length, 1);
    assert.match(pool.state.told[0].text, /'Voted'[\s\S]*'retracted'[\s\S]*wi\.machine = 'bot-change' AND wi\.key = 'session:' \|\| \$1::int/);
    assert.deepEqual(pool.state.told[0].params, [7, 3, 2]);

    assert.equal(ctx.seen.systemMessages.length, 1);
    const line = ctx.seen.systemMessages[0];
    assert.equal(line.content, 'evan took back their vote on PR #26: Dark mode');
    assert.equal(line.msgType, 'system', 'a notice, never parsed as a vote line');
    assert.deepEqual(line.thread, { type: 'session', ref: 7 }, 'in the proposal\'s own thread, never a channel');
    assert.deepEqual(line.metadata, { voteRetracted: { sessionId: 7, prNumber: 26, vote: 'yes' } });

    assert.deepEqual(ctx.seen.voteUpdates, [{ sessionId: 7, appSlug: 'widget', merged: false }], 'the tally is pushed');
    assert.deepEqual(ctx.seen.events, [{
      type: 'pr_vote_retracted', userId: 3, appId: 5, sessionId: 7, metadata: { vote: 'yes' },
    }]);
    // Give any stray background work a turn: a retraction never asks for a merge.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(ctx.seen.merges, [], 'no merge attempt from a retraction');
  });
});

test('a No taken back reopens no ready card, and answers without readyReopened', async () => {
  const pool = makePool({ vote: { vote: 'no', epoch: 2, reason: 'Too dark' } });
  await withServer(pool, {}, async (ctx) => {
    const r = await ctx.retract();
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, retracted: true, merged: false, vote: 'no' });
    assert.deepEqual(ctx.seen.reopened, []);
    assert.equal(ctx.seen.systemMessages.length, 1);
    assert.equal(ctx.seen.events[0].metadata.vote, 'no');
  });
});

test('a Yes whose ready cards were not settled answers without readyReopened', async () => {
  const pool = makePool();
  await withServer(pool, { reopened: 0 }, async (ctx) => {
    const r = await ctx.retract();
    assert.deepEqual(await r.json(), { ok: true, retracted: true, merged: false, vote: 'yes' });
  });
});

// ── 1b. #6477: the author's own retraction ────────────────────────────

test('#6477: the author taking their vote back marks this version, so proposing is no longer their yes', async () => {
  const pool = makePool({ author: 3 });
  await withServer(pool, {}, async (ctx) => {
    const r = await ctx.retract({ expectedEpoch: 2 });
    assert.equal(r.status, 200);
    assert.equal(pool.state.withdrew, 2, 'the current approval epoch is stamped, in the same transaction');
    assert.ok(pool.log.includes('UPDATE chat_sessions SET'), 'the stamp is written in the same transaction');
  });
});

test('#6477: someone else taking a vote back does not mark the author’s proposing yes', async () => {
  const pool = makePool({ author: 9 });
  await withServer(pool, {}, async (ctx) => {
    const r = await ctx.retract({ expectedEpoch: 2 });
    assert.equal(r.status, 200);
    assert.equal(pool.state.withdrew, null);
    assert.ok(!pool.log.includes('UPDATE chat_sessions SET'));
  });
});

test('#6477: a refused retraction leaves the author’s proposing yes alone', async () => {
  const pool = makePool({ author: 3, status: 'merging' });
  await withServer(pool, {}, async (ctx) => {
    const r = await ctx.retract({ expectedEpoch: 2 });
    assert.equal(r.status, 409);
    assert.equal(pool.state.withdrew, null);
  });
});

// ── 2. Nothing to take back ───────────────────────────────────────────

test('no current vote is an idempotent 200 that touches nothing', async () => {
  for (const vote of [null, { vote: 'yes', epoch: 1 }]) {
    const pool = makePool({ vote });
    await withServer(pool, {}, async (ctx) => {
      const r = await ctx.retract({ expectedEpoch: 2 });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true, unchanged: true });
      if (vote) assert.deepEqual(pool.state.vote, vote, 'a vote on an earlier version stays: it names the voter as asked back');
      assert.deepEqual(ctx.seen.withdrawn, []);
      assert.deepEqual(ctx.seen.systemMessages, []);
      assert.deepEqual(ctx.seen.voteUpdates, []);
      assert.deepEqual(ctx.seen.events, []);
      assert.deepEqual(ctx.seen.reopened, []);
    });
  }
});

// ── 3. Locked, or moved on ────────────────────────────────────────────

test('a change being merged, merged, closed or not proposed refuses with vote_locked', async () => {
  for (const status of ['merging', 'merged', 'archived', 'active']) {
    const pool = makePool({ status });
    await withServer(pool, {}, async (ctx) => {
      const r = await ctx.retract({ expectedEpoch: 2 });
      assert.equal(r.status, 409, status);
      const body = await r.json();
      assert.equal(body.code, 'vote_locked');
      assert.match(body.error, /no longer open for voting/);
      assert.ok(pool.state.vote, `${status}: the vote stays`);
      assert.deepEqual(pool.log, ['BEGIN', 'SELECT status, approval_epoch', 'ROLLBACK'], `${status}: nothing deleted`);
      assert.equal(pool.client.released, 1);
      assert.deepEqual(ctx.seen.systemMessages, []);
      assert.deepEqual(ctx.seen.events, []);
    });
  }
});

test('a retraction against an epoch the change has moved on from is refused with the current epoch', async () => {
  const pool = makePool({ epoch: 3, vote: { vote: 'yes', epoch: 3 } });
  await withServer(pool, {}, async (ctx) => {
    const r = await ctx.retract({ expectedEpoch: 2 });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.headChanged, true);
    assert.equal(body.refreshRequired, true);
    assert.equal(body.approvalEpoch, 3, 'the next press can land without a refetch');
    assert.equal(body.reviewedHeadSha, HEAD);
    assert.ok(pool.state.vote, 'the vote stays');
    assert.ok(!pool.log.includes('DELETE FROM pr_votes'));
    assert.deepEqual(ctx.seen.systemMessages, []);
  });
});

test('a change that does not exist is a 404', async () => {
  const pool = makePool({ missing: true });
  await withServer(pool, {}, async (ctx) => {
    const r = await ctx.retract();
    assert.equal(r.status, 404);
  });
});

// ── 4. The cast route's gates ─────────────────────────────────────────

test('a non-member is refused with join_required before anything is read', async () => {
  const pool = makePool();
  await withServer(pool, { member: false }, async (ctx) => {
    const r = await ctx.retract();
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'join_required');
    assert.deepEqual(pool.log, []);
    assert.ok(pool.state.vote);
  });
});

test('the route mounts the cast route\'s limiter and membership gate, under the collab guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'votes.js'), 'utf8');
  assert.ok(src.includes("router.delete('/api/sessions/:id/vote', governanceVoteLimiter, requireMembership, async (req, res) => {"));
  assert.ok(src.includes("router.use('/api/sessions/:id', appAccess.sessionCollabGuard(pool));"));
  const start = src.indexOf("router.delete('/api/sessions/:id/vote'");
  const body = src.slice(start, src.indexOf("router.get('/api/sessions/:id/votes'", start));
  assert.ok(body.indexOf('isCliCredentialManagementSession(req, session)') < body.indexOf('retractVote({'),
    'the CLI credential boundary holds before the vote is touched');
  assert.doesNotMatch(body, /wantMerge|settleVoteInBackground/, 'a retraction never asks for a merge');
  // The demo Needs-you cards' Undo is answered, as their vote is.
  const demo = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'workshop-overview.js'), 'utf8');
  assert.match(demo, /router\.delete\('\/api\/sessions\/:id\/vote', \(req, res, next\) => \{\s+if \(!isDemoNeedsProposal\(req\.params\.id\)\) return next\(\);/);
});

// ── The pieces the route hands off to ─────────────────────────────────

test('withdrawProposalVoteNotification deletes the voter\'s row on the change and names whose bell changed', async () => {
  const notifications = require('../src/services/notifications');
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [{ user_id: 9 }, { user_id: 9 }] };
    },
  };
  assert.deepEqual(await notifications.withdrawProposalVoteNotification(pool, { sessionId: 7, voterId: 3 }), [9]);
  assert.match(calls[0].sql, /DELETE FROM notifications\s+WHERE kind = 'proposal_vote' AND session_id = \$1 AND source_user_id = \$2/);
  assert.deepEqual(calls[0].params, [7, 3]);
  assert.deepEqual(await notifications.withdrawProposalVoteNotification(pool, { sessionId: 7 }), []);
  assert.equal(calls.length, 1, 'no voter, no query');
});

test('noteApprovalWithdrawn reopens only the cards a Yes answered, on every device', async () => {
  const dm = require('../src/services/homeroom-bot-dm');
  const cards = [
    { message_id: 11, conversation_id: 4, meta: { ready: {}, status: 'answered', chosen: 'approve', answer: 'Approve', goesLive: { soon: true } } },
    { message_id: 12, conversation_id: 4, meta: { ready: {}, status: 'closed', updated: true } },
    { message_id: 13, conversation_id: 4, meta: { ready: {}, status: 'open' } },
    { message_id: 14, conversation_id: 4, meta: { status: 'answered', chosen: 'approve' } },
  ];
  const writes = [];
  const pool = {
    async query(sql, params) {
      const text = String(sql);
      if (/FROM homeroom_bot_dm_messages d/.test(text)) return { rows: cards };
      if (/SELECT metadata, conversation_id, sender_id, thread_root_id FROM conversation_messages/.test(text)) {
        const card = cards.find((c) => c.message_id === params[0]);
        return { rows: [{ metadata: { homeroomBot: card.meta }, conversation_id: 4, sender_id: 1, thread_root_id: null }] };
      }
      if (/UPDATE conversation_messages SET metadata/.test(text)) {
        writes.push({ id: params[0], meta: JSON.parse(params[1]).homeroomBot });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const pushed = [];
  const ws = { pushConversationEvent: (members, ev) => pushed.push({ members, ev }) };
  assert.equal(await dm.noteApprovalWithdrawn(pool, 7, 3, { ws }), 1);
  assert.deepEqual(writes, [{
    id: 11,
    meta: { ready: {}, status: 'open', chosen: null, answer: null, goesLive: null },
  }], 'the card offers Approve again and no longer says it goes live');
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0].members, [1, 3]);
  assert.equal(pushed[0].ev.messageId, 11);

  const broken = { async query() { throw new Error('db down'); } };
  assert.equal(await dm.noteApprovalWithdrawn(broken, 7, 3, { ws }), 0, 'never throws');
});
