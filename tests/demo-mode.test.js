// Demo mode — a synthetic partner, on one app, for recording the proposal
// flow (routes/demo-mode.js).
//
// What matters here is the containment more than the happy path. A
// triggerable account that proposes and votes is, in the wrong shape, a
// lever for manufacturing consent; these tests pin the shape that keeps it
// harmless — every route refuses outside demo mode and outside the creator,
// the partner cannot sign in, and what it does inside demo mode goes through
// the same paths a person's click does, so nothing is simulated.
//
// Run with: node --test tests/demo-mode.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const REPO = 'https://github.com/usernode-bot/demo-app';
// The creator, and a full platform admin: demo mode needs both.
const CREATOR = { id: 7, username: 'evan', isAdmin: true, canAdminWrite: true };
// The same creator without the admin half.
const PLAIN_CREATOR = { id: 7, username: 'evan', isAdmin: false, canAdminWrite: false };
// A view-only admin is not a full admin: canAdminWrite is the gate, not isAdmin.
const READONLY_ADMIN_CREATOR = { id: 7, username: 'evan', isAdmin: true, adminReadonly: true, canAdminWrite: false };
// A full platform admin who is NOT the creator, on purpose: admin is required
// on top of creator, never accepted instead of it.
const ADMIN = { id: 8, username: 'ops', isAdmin: true, canAdminWrite: true };

// ── World ────────────────────────────────────────────────────────────────
const state = {};
const calls = {};
// Every recorded call in the order it happened, for the tests where the
// order IS the behaviour (a vote landing before the notification leaves).
const seq = [];
const record = (name) => (...args) => { (calls[name] ||= []).push(args); seq.push(name); };
function resetWorld() {
  state.apps = new Map([
    ['demo-app', {
      id: 1, slug: 'demo-app', name: 'Demo App', created_by: 7, self_hosted: false,
      repo_url: REPO, main_sha: 'm'.repeat(40),
      demo_mode: true, demo_partner_id: 50, demo_base_sha: 'b'.repeat(40),
      approver_policy: 'anyone', approvals_required: 2, demo_prev_approvals: null,
    }],
    ['plain-app', {
      id: 2, slug: 'plain-app', name: 'Plain App', created_by: 7, self_hosted: false,
      repo_url: 'https://github.com/usernode-bot/plain-app', main_sha: 'p'.repeat(40),
      demo_mode: false, demo_partner_id: null, demo_base_sha: null,
      approver_policy: 'anyone', approvals_required: null, demo_prev_approvals: null,
    }],
    ['homeroom', {
      id: 3, slug: 'homeroom', name: 'Homeroom', created_by: 7, self_hosted: true,
      repo_url: 'https://github.com/Usernode-Labs/social-vibecoding', demo_mode: false,
    }],
  ]);
  state.users = new Map([[50, { id: 50, username: 'sam', is_synthetic: true }]]);
  state.sessions = [];
  state.queries = [];
  state.nextId = 100;
  state.activeIds = [7, 50];
  state.notify = true;
  state.voteRowCount = 1;
  state.tally = [];
  state.mainMoves = true;
  state.patchResult = {
    ok: true, branch: 'usernode/patch-u50-tdemo-1-abc123', headSha: 'd'.repeat(40),
    cleanup: async () => { record('patchCleanup')(); },
  };
  state.prFails = false;
  // What GitHub answers when promote re-reads the pull request: open, at
  // the head the branch path proposes.
  state.pr = { merged: false, state: 'open', head: { sha: 'c'.repeat(40) } };
  state.prFetchFails = false;
  seq.length = 0;
  for (const k of Object.keys(calls)) delete calls[k];
}
resetWorld();

// ── Module stubs, installed BEFORE the router loads ─────────────────────
//
// The router borrows recordVote/checkAndMerge from routes/votes.js and
// reaches GitHub, Docker and the websocket layer through their services. In
// a test those are the things to OBSERVE, not run — and several are heavy
// to even load — so they are placed in the require cache and the router
// resolves to them by its ordinary module path.
function stubModule(rel, exportsObj) {
  const full = require.resolve(rel);
  require.cache[full] = { id: full, filename: full, loaded: true, exports: exportsObj };
  return exportsObj;
}
stubModule('../src/services/github', {
  isEnabled: () => true,
  getRepoHead: async () => ({ headSha: 'a'.repeat(40) }),
  getBranchSha: async (_o, _r, branch) => {
    if (branch === 'missing') throw new Error('Not Found');
    return 'c'.repeat(40);
  },
  createPR: async (...args) => {
    record('createPR')(...args);
    if (state.prFails) throw new Error('422 Validation Failed');
    return { number: 42, html_url: 'https://github.com/usernode-bot/demo-app/pull/42' };
  },
  getBotUsername: async () => 'usernode-bot',
  getPR: async (...args) => {
    record('getPR')(...args);
    if (state.prFetchFails) throw new Error('503 Service Unavailable');
    return state.pr;
  },
  closePR: async (...args) => { record('closePR')(...args); },
  forceBranchToSha: async (...args) => {
    record('forceBranchToSha')(...args);
    return { previousSha: 'z'.repeat(40), sha: args[3], updated: state.mainMoves };
  },
});
stubModule('../src/services/staging', {
  rebuildProduction: async (...args) => {
    record('rebuildProduction')(...args);
    return { containerId: 'cid', sha: 'b'.repeat(40) };
  },
});
stubModule('../src/services/ws', {
  sendSystemMessage: async (...args) => { record('sendSystemMessage')(...args); },
  pushSessionUpdate: record('pushSessionUpdate'),
  pushVoteUpdate: record('pushVoteUpdate'),
  pushNotificationToUser: record('pushNotificationToUser'),
});
stubModule('../src/services/notifications', {
  createPrProposedNotifications: async (...args) => {
    record('createPrProposedNotifications')(...args);
    return state.notify ? [{ id: 900, user_id: 7, kind: 'pr_proposed' }] : [];
  },
  serialize: (row) => row,
  createProposalVoteNotification: async (...args) => {
    record('createProposalVoteNotification')(...args);
    return [];
  },
});
stubModule('../src/services/pr-import-sync', { kickImportedChecks: record('kickImportedChecks') });
stubModule('../src/services/external-agent-patch', {
  MAX_PATCH_BYTES: 256 * 1024,
  applyPatch: async (...args) => { record('applyPatch')(...args); return state.patchResult; },
});
stubModule('../src/services/session-lifecycle', {
  teardownStagingForSession: async (...args) => {
    record('teardownStagingForSession')(...args);
    return { torn: true };
  },
});
stubModule('../src/routes/votes', {
  recordVote: async (...args) => {
    record('recordVote')(...args);
    return { rowCount: state.voteRowCount };
  },
  checkAndMerge: async (...args) => {
    record('checkAndMerge')(...args);
    return { merged: false };
  },
});
stubModule('../src/services/topic-attributes', {
  selfAssignProposal: async (...args) => { record('selfAssignProposal')(...args); },
});
stubModule('../src/services/events', {
  EVENT_TYPES: { PR_PROMOTED: 'pr_promoted', PR_VOTE_CAST: 'pr_vote_cast' },
  record: record('event'),
});

// Light modules, patched in place.
const activeUsers = require('../src/services/active-users');
activeUsers.listActiveUserIds = async () => state.activeIds.slice();
activeUsers.isUserActive = async (_pool, _appId, userId) => state.activeIds.includes(userId);
const notificationPreferences = require('../src/services/notification-preferences');
notificationPreferences.allowsKind = async () => state.notify;
const governanceService = require('../src/services/governance');
governanceService.getGovernance = async (_pool, appId) => {
  const app = [...state.apps.values()].find((a) => a.id === appId) || {};
  return {
    approverPolicy: app.approver_policy === 'invited' ? 'invited' : 'anyone',
    approvalsRequired: app.approvals_required ?? null,
  };
};
governanceService.invalidateGovernance = record('invalidateGovernance');
const appAccess = require('../src/services/app-access');
appAccess.getAppForUser = async (_pool, slug) => (state.apps.get(slug) ? { ...state.apps.get(slug) } : null);

// ── The pool: the statements the routes issue, answered from the world ──
const poolMod = require('../src/db/pool');
poolMod.getPool = () => ({
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    state.queries.push({ sql: s, params });
    if (s.startsWith('SELECT id, username, is_synthetic FROM users WHERE id = $1')) {
      const u = state.users.get(params[0]);
      return { rows: u ? [u] : [] };
    }
    if (s.startsWith('INSERT INTO users')) {
      const id = state.nextId++;
      const u = { id, username: params[0], is_synthetic: true, password: params[1] };
      state.users.set(id, u);
      return { rows: [{ id, username: u.username, is_synthetic: true }], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM users')) {
      state.users.delete(params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('FROM users WHERE LOWER(username)')) return { rows: [] };
    if (s.includes('FROM username_history')) return { rows: [] };
    if (s.startsWith('UPDATE apps SET demo_mode = TRUE')) {
      const app = [...state.apps.values()].find((a) => a.id === params[2]);
      Object.assign(app, {
        demo_mode: true, demo_partner_id: params[0], demo_base_sha: params[1],
        // The CASE: the snapshot is only taken on the way in.
        demo_prev_approvals: app.demo_mode ? app.demo_prev_approvals : (app.approvals_required ?? null),
        approvals_required: params[3] ?? null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE apps SET demo_mode = FALSE')) {
      const app = [...state.apps.values()].find((a) => a.id === params[0]);
      Object.assign(app, {
        demo_mode: false, demo_partner_id: null, demo_base_sha: null,
        approvals_required: app.demo_mode ? (app.demo_prev_approvals ?? null) : (app.approvals_required ?? null),
        demo_prev_approvals: null,
      });
      return { rows: [{ approvals_required: app.approvals_required }], rowCount: 1 };
    }
    if (s.startsWith('SELECT cs.*, a.slug AS app_slug')) {
      const open = state.sessions
        .filter((x) => x.app_id === params[0] && x.user_id === params[1]
          && ['active', 'promoted', 'merging'].includes(x.status))
        .sort((a, b) => b.id - a.id)[0];
      return { rows: open ? [{
        ...open, app_slug: 'demo-app', app_name: 'Demo App', repo_url: REPO, app_self_hosted: false,
      }] : [] };
    }
    if (s.startsWith('SELECT id, pr_number, status FROM chat_sessions')) {
      return { rows: state.sessions
        .filter((x) => x.app_id === params[0] && x.user_id === params[1])
        .map(({ id, pr_number, status }) => ({ id, pr_number, status })) };
    }
    if (s.startsWith('INSERT INTO chat_sessions')) {
      const id = state.nextId++;
      state.sessions.push({
        id, app_id: params[0], user_id: params[1], branch_name: params[2], pr_number: params[3],
        pr_url: params[4], pr_title: params[5], status: params[13], source: 'imported',
        imported_pr_head_sha: params[6], imported_pr_author: params[7],
      });
      return { rows: [{ id, status: params[13] }], rowCount: 1 };
    }
    if (s.startsWith("UPDATE chat_sessions SET status = 'promoted'")) {
      const row = state.sessions.find((x) => x.id === params[0] && x.status === 'active');
      if (row) row.status = 'promoted';
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('DELETE FROM chat_sessions WHERE id = ANY')) {
      const ids = new Set(params[0]);
      state.sessions = state.sessions.filter((x) => !ids.has(x.id));
      return { rows: [], rowCount: ids.size };
    }
    if (s.startsWith('SELECT vote, COUNT(*)::int AS n FROM pr_votes')) return { rows: state.tally };
    return { rows: [], rowCount: 0 };
  },
});

const { demoModeRoutes, validBranch } = require('../src/routes/demo-mode');

let server;
let base;
let currentUser = CREATOR;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = currentUser; next(); });
  app.use(demoModeRoutes({}));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
test.beforeEach(() => { resetWorld(); currentUser = CREATOR; });

const call = async (method, p, body) => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const post = (p, body = {}) => call('POST', p, body);
const get = (p) => call('GET', p);
const queriesLike = (prefix) => state.queries.filter((q) => q.sql.startsWith(prefix));
// The merge check runs after the response; give it the turn it needs.
const settle = () => new Promise((r) => setImmediate(r));

// ── Containment ──────────────────────────────────────────────────────────

test('outside demo mode, every route refuses — the creator included', async () => {
  for (const p of ['/api/apps/plain-app/demo/propose', '/api/apps/plain-app/demo/vote', '/api/apps/plain-app/demo/reset']) {
    const r = await post(p, { branch: 'x', title: 'y' });
    assert.equal(r.status, 403, p);
    assert.match(r.body.error, /not in demo mode/);
  }
  assert.equal(calls.createPR, undefined, 'nothing reached GitHub');
  assert.equal(calls.recordVote, undefined, 'and no vote was written');
});

test('on somebody else\'s app, every route refuses — a platform admin included', async () => {
  currentUser = ADMIN;
  for (const p of ['/api/apps/demo-app/demo-mode', '/api/apps/demo-app/demo/propose', '/api/apps/demo-app/demo/vote', '/api/apps/demo-app/demo/reset']) {
    const r = await post(p, { enabled: true, partnerName: 'x', branch: 'x', title: 'y' });
    assert.equal(r.status, 403, p);
    assert.match(r.body.error, /creator/);
  }
  const s = await get('/api/apps/demo-app/demo');
  assert.equal(s.status, 403);
});

test('a creator who is not a full platform admin is refused: the admin half is required too', async () => {
  for (const who of [PLAIN_CREATOR, READONLY_ADMIN_CREATOR]) {
    currentUser = who;
    const label = who.isAdmin ? 'view-only admin creator' : 'plain creator';
    for (const p of ['/api/apps/demo-app/demo-mode', '/api/apps/demo-app/demo/propose', '/api/apps/demo-app/demo/vote', '/api/apps/demo-app/demo/reset']) {
      const r = await post(p, { enabled: true, partnerName: 'x', branch: 'x', title: 'y' });
      assert.equal(r.status, 403, `${label}: ${p}`);
      assert.match(r.body.error, /full platform admin/);
    }
    const s = await get('/api/apps/demo-app/demo');
    assert.equal(s.status, 403, `${label}: status`);
  }
  assert.equal(calls.createPR, undefined);
  assert.equal(queriesLike('UPDATE apps SET demo_mode').length, 0, 'nothing was switched');
});

test('the platform app can never be put in demo mode', async () => {
  const r = await post('/api/apps/homeroom/demo-mode', { enabled: true, partnerName: 'sam' });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /platform app/);
});

test('the partner cannot sign in, and a session naming it is no session', () => {
  const login = read('src/routes/auth.js');
  // Every way a login finds a row carries the flag…
  assert.equal((login.match(/admin_readonly, is_synthetic FROM users WHERE/g) || []).length, 2,
    'the email and username lookups');
  assert.match(login, /u\.admin_readonly, u\.is_synthetic\s+FROM username_history/, 'and the retired-name lookup');
  // …and the compare loop steps over it before bcrypt runs.
  assert.match(login, /if \(candidate\.row\.is_synthetic\) continue;/);
  const mw = read('src/middleware/auth.js');
  assert.match(mw, /u\.has_platform_access, u\.is_synthetic,/);
  assert.match(mw, /&& !rows\[0\]\.is_synthetic/);
  assert.match(read('src/db/schema.sql'),
    /ALTER TABLE users ADD COLUMN IF NOT EXISTS is_synthetic BOOLEAN NOT NULL DEFAULT FALSE/);
});

// ── The switch ──────────────────────────────────────────────────────────

test('switching on makes a partner that is synthetic from its first byte, with standing here only', async () => {
  const r = await post('/api/apps/plain-app/demo-mode', { enabled: true, partnerName: 'sam_demo' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.demoMode, true);
  assert.equal(r.body.partner.username, 'sam_demo');
  assert.equal(r.body.baseSha, 'a'.repeat(40), 'where main stands now, read live');

  const [insert] = queriesLike('INSERT INTO users');
  assert.match(insert.sql, /is_synthetic\) VALUES \(\$1, \$2, FALSE, FALSE, TRUE\)/,
    'flagged in the statement that creates it');
  assert.match(insert.params[1], /^\$2[aby]\$/, 'a bcrypt hash of something random, not a password anybody knows');

  const app = state.apps.get('plain-app');
  assert.equal(app.demo_mode, true);
  assert.equal(app.demo_partner_id, r.body.partner.id);
  const [activity] = queriesLike('INSERT INTO app_activity');
  assert.deepEqual(activity.params, [2, r.body.partner.id], 'standing on THIS app');
  const [member] = queriesLike('INSERT INTO app_collaborators');
  assert.deepEqual(member.params.slice(0, 2), [2, r.body.partner.id]);
});

test('a partner name is a username: the platform\'s own rules apply', async () => {
  let r = await post('/api/apps/plain-app/demo-mode', { enabled: true, partnerName: 'no' });
  assert.equal(r.status, 400, 'too short');
  r = await post('/api/apps/plain-app/demo-mode', { enabled: true, partnerName: 'usernodecapture' });
  assert.equal(r.status, 400, 'a platform service identity is refused');
  r = await post('/api/apps/plain-app/demo-mode', { enabled: true });
  assert.equal(r.status, 400, 'a first switch-on needs a name');
  assert.equal(queriesLike('INSERT INTO users').length, 0);
});

test('switching off is refused while the partner still has proposals, then removes the partner', async () => {
  state.sessions.push({ id: 9, app_id: 1, user_id: 50, status: 'merged', pr_number: 41 });
  let r = await post('/api/apps/demo-app/demo-mode', { enabled: false });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Reset/);
  assert.equal(state.apps.get('demo-app').demo_mode, true, 'still on');

  state.sessions = [];
  r = await post('/api/apps/demo-app/demo-mode', { enabled: false });
  assert.equal(r.status, 200);
  assert.equal(state.apps.get('demo-app').demo_mode, false);
  assert.equal(state.apps.get('demo-app').demo_partner_id, null);
  assert.equal(state.users.has(50), false, 'the synthetic row goes with it');
  const [del] = queriesLike('DELETE FROM users');
  assert.match(del.sql, /is_synthetic = TRUE/, 'and only ever a synthetic row');
});

// ── Propose ─────────────────────────────────────────────────────────────

test('proposing opens a real PR, files it as the partner\'s, and fires the real vote notification', async () => {
  const r = await post('/api/apps/demo-app/demo/propose', {
    branch: 'demo/animations', title: 'Smooth category animations',
    summary: 'Categories glide open and closed.', description: 'CSS transitions on the list.',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.prNumber, 42);
  assert.equal(r.body.notified, 1);
  assert.equal(r.body.held, false);

  // The PR: from the named branch, on the app's own repo.
  const [[owner, repo, pr]] = calls.createPR;
  assert.equal(`${owner}/${repo}`, 'usernode-bot/demo-app');
  assert.equal(pr.branch, 'demo/animations');
  assert.equal(pr.title, 'Smooth category animations');

  // The proposal: the partner's, promoted, imported (so the preview, checks
  // and merge machinery apply), pinned to the branch head, the bot as PR
  // author.
  const [insert] = queriesLike('INSERT INTO chat_sessions');
  assert.equal(insert.params[13], 'promoted', 'straight to the vote');
  assert.match(insert.sql, /CASE WHEN \$14::text = 'promoted' THEN NOW\(\) END/, 'promoted_at set with it');
  assert.equal(insert.params[1], 50, 'owned by the partner');
  assert.equal(insert.params[6], 'c'.repeat(40), 'the branch head, as reviewed');
  assert.equal(insert.params[7], 'usernode-bot');
  assert.equal(insert.params[12], 'Categories glide open and closed.', 'the voter-facing summary lands');
  assert.equal(calls.selfAssignProposal[0][3].id, 50);
  assert.equal(calls.kickImportedChecks[0][0].headSha, 'c'.repeat(40), 'preview + checks on that head');

  // The notification — the beat the feature exists for — through the same
  // fan-out the promote route uses, with the partner as proposer so it is
  // the one excluded, pushed live to whoever it reached.
  const [[, fanout]] = calls.createPrProposedNotifications;
  assert.deepEqual(fanout, { appId: 1, sessionId: r.body.sessionId, proposerId: 50 });
  const [[toUser, push]] = calls.pushNotificationToUser;
  assert.equal(toUser, 7);
  assert.equal(push.type, 'notification_new');
  assert.equal(push.notification.source_username, 'sam');
  assert.equal(push.notification.pr_title, 'Smooth category animations');

  // And the group hears it the way it hears any promotion.
  assert.equal(calls.sendSystemMessage[0][2], 'sam promoted PR #42: Smooth category animations for voting');
  assert.equal(calls.pushSessionUpdate[0][0].action, 'promoted');
  assert.equal(calls.event[0][1].userId, 50);
});

test('one demo proposal at a time, and only from a branch that exists', async () => {
  let r = await post('/api/apps/demo-app/demo/propose', { branch: 'missing', title: 'x' });
  assert.equal(r.status, 404);
  assert.equal(calls.createPR, undefined);
  r = await post('/api/apps/demo-app/demo/propose', { branch: '../evil', title: 'x' });
  assert.equal(r.status, 400);
  r = await post('/api/apps/demo-app/demo/propose', { branch: 'demo/one', title: 'One' });
  assert.equal(r.status, 200);
  r = await post('/api/apps/demo-app/demo/propose', { branch: 'demo/two', title: 'Two' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Reset/);
  assert.equal(calls.createPR.length, 1);
});

// ── Hold, then promote ──────────────────────────────────────────────────

test('held, a proposal opens its PR and builds its preview, and nobody hears a thing', async () => {
  const r = await post('/api/apps/demo-app/demo/propose', {
    branch: 'demo/animations', title: 'Smooth category animations', hold: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.held, true);
  assert.equal(r.body.notified, 0);
  assert.equal(r.body.prNumber, 42, 'the PR is real and open');

  // Filed as the partner's unshared in-progress work: 'active', no
  // promoted_at, and nothing sets shared_at — which is what keeps it off
  // the In-progress area and the vote list alike.
  const [insert] = queriesLike('INSERT INTO chat_sessions');
  assert.equal(insert.params[13], 'active');
  assert.doesNotMatch(insert.sql, /shared_at/);
  assert.equal(state.sessions[0].status, 'active');
  // The build starts now, so it is minutes old when the cue comes.
  assert.equal(calls.kickImportedChecks[0][0].headSha, 'c'.repeat(40));
  assert.equal(calls.kickImportedChecks[0][0].session.status, 'active');
  // And nothing was said: no chat line, no session update, no event, no
  // notification.
  assert.equal(calls.sendSystemMessage, undefined);
  assert.equal(calls.pushSessionUpdate, undefined);
  assert.equal(calls.event, undefined);
  assert.equal(calls.createPrProposedNotifications, undefined);
  assert.equal(calls.pushNotificationToUser, undefined);
});

test('promoting a held proposal is the announcement, with the partner\'s vote on the card before the notification leaves', async () => {
  await post('/api/apps/demo-app/demo/propose', {
    branch: 'demo/animations', title: 'Smooth category animations', hold: true,
  });
  seq.length = 0;
  const r = await post('/api/apps/demo-app/demo/promote', { vote: 'yes' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.voted, 'yes');
  assert.equal(r.body.notified, 1);
  assert.equal(r.body.prNumber, 42);

  // The pull request was re-read first, and it is still what was proposed.
  assert.deepEqual(calls.getPR[0], ['usernode-bot', 'demo-app', 42]);
  // The same write routes/votes.js makes, guarded on the held status.
  const [update] = queriesLike("UPDATE chat_sessions SET status = 'promoted'");
  assert.match(update.sql, /promoted_at = NOW\(\), stale_notified_at = NULL WHERE id = \$1 AND status = 'active'/);
  assert.equal(state.sessions[0].status, 'promoted');
  assert.equal(queriesLike('INSERT INTO app_activity').length, 2, 'standing refreshed at both cues');

  // The group hears the promotion, then the vote, in that order; the
  // notification leaves after both, so the card it opens already reads
  // "voted yes".
  assert.deepEqual(calls.sendSystemMessage.map((c) => c[2]), [
    'sam promoted PR #42: Smooth category animations for voting',
    'sam promoted PR #42: Smooth category animations for voting',
    'sam voted yes on PR #42: Smooth category animations',
  ]);
  assert.equal(calls.pushSessionUpdate[0][0].action, 'promoted');
  assert.equal(calls.event[0][1].type, 'pr_promoted');
  assert.equal(calls.event[1][1].type, 'pr_vote_cast');
  const [[recorded]] = calls.recordVote;
  assert.equal(recorded.userId, 50);
  assert.equal(recorded.headSha, 'c'.repeat(40), 'stamped with the head that was proposed');
  assert.equal(recorded.revisionEnforced, true);
  assert.ok(seq.indexOf('recordVote') < seq.indexOf('createPrProposedNotifications'),
    'the vote lands before the fan-out');
  const [[, fanout]] = calls.createPrProposedNotifications;
  assert.deepEqual(fanout, { appId: 1, sessionId: r.body.sessionId, proposerId: 50 });
  assert.equal(calls.pushNotificationToUser[0][0], 7);
  assert.equal(calls.pushNotificationToUser[0][1].notification.pr_title, 'Smooth category animations');
  assert.equal(calls.pushNotificationToUser[0][1].notification.source_username, 'sam');
  await settle();
  assert.equal(calls.checkAndMerge[0][2].id, r.body.sessionId, 'a vote is followed by the merge check, as always');
});

test('promoted without a vote, the card is clean and the partner can still vote afterwards', async () => {
  await post('/api/apps/demo-app/demo/propose', { branch: 'demo/animations', title: 'Smooth', hold: true });
  const r = await post('/api/apps/demo-app/demo/promote', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.voted, null);
  assert.equal(r.body.notified, 1);
  assert.equal(calls.recordVote, undefined);
  await settle();
  assert.equal(calls.checkAndMerge, undefined, 'no vote, no merge check');
  const v = await post('/api/apps/demo-app/demo/vote', {});
  assert.equal(v.status, 200);
  assert.equal(calls.recordVote.length, 1);
});

test('promote refuses when nothing is held, when it is already up for the vote, and when the pull request is no longer what was proposed', async () => {
  let r = await post('/api/apps/demo-app/demo/promote', {});
  assert.equal(r.status, 404);
  // A proposal that went straight to the vote is not held.
  await post('/api/apps/demo-app/demo/propose', { branch: 'demo/animations', title: 'x' });
  r = await post('/api/apps/demo-app/demo/promote', {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already up for the vote/);

  // Held, but GitHub says otherwise: every refusal fails closed and writes
  // nothing.
  state.sessions = [];
  // The straight-to-vote proposal above notified, as it should; from here
  // on, silence is the thing under test.
  delete calls.createPrProposedNotifications;
  await post('/api/apps/demo-app/demo/propose', { branch: 'demo/animations', title: 'x', hold: true });
  state.prFetchFails = true;
  r = await post('/api/apps/demo-app/demo/promote', {});
  assert.equal(r.status, 503);
  state.prFetchFails = false;
  state.pr = { merged: true, state: 'closed', head: { sha: 'c'.repeat(40) } };
  r = await post('/api/apps/demo-app/demo/promote', {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already merged/);
  state.pr = { merged: false, state: 'closed', head: { sha: 'c'.repeat(40) } };
  r = await post('/api/apps/demo-app/demo/promote', {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /closed/);
  state.pr = { merged: false, state: 'open', head: { sha: 'e'.repeat(40) } };
  r = await post('/api/apps/demo-app/demo/promote', {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /moved/);
  assert.equal(queriesLike("UPDATE chat_sessions SET status = 'promoted'").length, 0, 'nothing was promoted');
  assert.equal(state.sessions[0].status, 'active', 'still held');
  assert.equal(calls.createPrProposedNotifications, undefined, 'and nobody was told');
});

test('a vote on a held proposal is refused with the way forward', async () => {
  await post('/api/apps/demo-app/demo/propose', { branch: 'demo/animations', title: 'x', hold: true });
  const r = await post('/api/apps/demo-app/demo/vote', {});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /held/);
  assert.match(r.body.error, /demo\/promote/);
  assert.equal(calls.recordVote, undefined);
});

test('one at a time counts a held proposal, and reset takes a held one down', async () => {
  await post('/api/apps/demo-app/demo/propose', { branch: 'demo/one', title: 'One', hold: true });
  let r = await post('/api/apps/demo-app/demo/propose', { branch: 'demo/two', title: 'Two' });
  assert.equal(r.status, 409);
  r = await post('/api/apps/demo-app/demo/reset', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sessionsRemoved, 1);
  assert.deepEqual(calls.closePR.map((c) => c[2]), [42], 'the held PR is closed like any open one');
  assert.deepEqual(state.sessions, []);
});

// ── Vote ────────────────────────────────────────────────────────────────

test('the partner\'s vote is a real vote: recordVote under revision, then checkAndMerge', async () => {
  state.sessions.push({
    id: 9, app_id: 1, user_id: 50, status: 'promoted', pr_number: 42,
    pr_title: 'Smooth category animations', source: 'imported', imported_pr_head_sha: 'c'.repeat(40),
  });
  const r = await post('/api/apps/demo-app/demo/vote', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vote, 'yes');

  const [[recorded]] = calls.recordVote;
  assert.equal(recorded.userId, 50);
  assert.equal(recorded.vote, 'yes');
  assert.equal(recorded.headSha, 'c'.repeat(40), 'stamped with the reviewed head');
  assert.equal(recorded.revisionEnforced, true, 'under the row lock, like a click');
  assert.equal(recorded.session.id, 9);

  await settle();
  assert.equal(calls.checkAndMerge[0][2].id, 9, 'the merge check runs on the same session');
  assert.equal(calls.sendSystemMessage[0][2], 'sam voted yes on PR #42: Smooth category animations');
  assert.deepEqual(calls.sendSystemMessage[0][5], { type: 'session', ref: 9 }, 'in the proposal\'s thread');
  assert.deepEqual(calls.pushVoteUpdate[0][0], { sessionId: 9, appSlug: 'demo-app', merged: false });
  assert.equal(calls.createProposalVoteNotification, undefined,
    'no notification to an account that cannot read one');
});

test('a vote with nothing open, or on a proposal that just closed, is refused', async () => {
  let r = await post('/api/apps/demo-app/demo/vote', {});
  assert.equal(r.status, 404);
  state.sessions.push({
    id: 9, app_id: 1, user_id: 50, status: 'promoted', pr_number: 42,
    source: 'imported', imported_pr_head_sha: 'c'.repeat(40),
  });
  state.voteRowCount = 0;
  r = await post('/api/apps/demo-app/demo/vote', {});
  assert.equal(r.status, 409);
  await settle();
  assert.equal(calls.checkAndMerge, undefined, 'nothing to merge-check when nothing was written');
});

// ── The approvals rule ──────────────────────────────────────────────────

test('switching on puts the app on "at least 2 approvals", and switching off puts its own rule back', async () => {
  // A creator who had deliberately set five.
  const app = state.apps.get('plain-app');
  app.approvals_required = 5;
  let r = await post('/api/apps/plain-app/demo-mode', { enabled: true, partnerName: 'pat' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.approvalsRequired, 2, 'the card counts "1 of 2" while the take runs');
  assert.equal(app.approvals_required, 2);
  assert.equal(app.demo_prev_approvals, 5, 'what it was is kept, not lost');
  assert.equal(calls.invalidateGovernance.length, 1, 'the governance cache is a cache');
  // The two guards live in the statements, so they are pinned there: a fake
  // pool can only answer what it is asked, and what it is asked IS the
  // behaviour here.
  const [onSql] = queriesLike('UPDATE apps SET demo_mode = TRUE');
  assert.match(onSql.sql,
    /demo_prev_approvals = CASE WHEN demo_mode THEN demo_prev_approvals ELSE approvals_required END/,
    'the snapshot is taken on the way in and only then');
  assert.match(onSql.sql, /approvals_required = \$4/, 'and the rule is written');
  assert.equal(onSql.params[3], 2);

  // Switching on again must not snapshot demo mode's own value over it.
  r = await post('/api/apps/plain-app/demo-mode', { enabled: true, partnerName: 'pat' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(app.demo_prev_approvals, 5);

  r = await post('/api/apps/plain-app/demo-mode', { enabled: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.approvalsRequired, 5);
  assert.equal(app.approvals_required, 5, 'the creator\'s own rule is back');
  assert.equal(app.demo_prev_approvals, null);
  const [offSql] = queriesLike('UPDATE apps SET demo_mode = FALSE');
  assert.match(offSql.sql,
    /approvals_required = CASE WHEN demo_mode THEN demo_prev_approvals ELSE approvals_required END/,
    'switching off an app that is already off must not read an empty snapshot as the default strategy');
  assert.match(offSql.sql, /demo_prev_approvals = NULL/);
  assert.equal(calls.invalidateGovernance.length, 3);
});

test('an app on the default strategy is restored to it, not to a number', async () => {
  const app = state.apps.get('plain-app');
  assert.equal(app.approvals_required, null, 'the default strategy, which is NULL');
  await post('/api/apps/plain-app/demo-mode', { enabled: true, partnerName: 'pat' });
  assert.equal(app.approvals_required, 2);
  assert.equal(app.demo_prev_approvals, null);
  const off = await post('/api/apps/plain-app/demo-mode', { enabled: false });
  assert.equal(off.body.approvalsRequired, null);
  assert.equal(app.approvals_required, null, 'back on the timed rule it was on');
});

test('the number is the caller\'s, within the platform\'s own bounds, and null keeps the timed rule', async () => {
  const app = state.apps.get('plain-app');
  let r = await post('/api/apps/plain-app/demo-mode', { enabled: true, partnerName: 'pat', approvals: 3 });
  assert.equal(r.body.approvalsRequired, 3);
  assert.equal(app.approvals_required, 3);

  // Explicitly null: the app keeps its own timed rule, for a take that wants
  // the countdown on camera.
  r = await post('/api/apps/plain-app/demo-mode', { enabled: true, partnerName: 'pat', approvals: null });
  assert.equal(r.body.approvalsRequired, null);
  assert.equal(app.approvals_required, null);

  for (const bad of [0, -1, 2.5, 51, 'two']) {
    r = await post('/api/apps/plain-app/demo-mode', { enabled: true, partnerName: 'pat', approvals: bad });
    assert.equal(r.status, 400, `approvals: ${JSON.stringify(bad)}`);
    assert.match(r.body.error, /whole number between 1 and 50/);
  }
  assert.equal(app.approvals_required, null, 'a refused number changed nothing');
});

// ── Reset ───────────────────────────────────────────────────────────────

test('reset takes the partner\'s proposals down, puts main back, and rebuilds', async () => {
  state.sessions.push(
    { id: 9, app_id: 1, user_id: 50, status: 'merged', pr_number: 42 },
    { id: 10, app_id: 1, user_id: 50, status: 'promoted', pr_number: 43 },
    // Somebody else's proposal on the same app: not the partner's, not touched.
    { id: 11, app_id: 1, user_id: 7, status: 'promoted', pr_number: 44 },
  );
  const r = await post('/api/apps/demo-app/demo/reset', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sessionsRemoved, 2);
  assert.deepEqual(r.body.main, { from: 'z'.repeat(40), to: 'b'.repeat(40), moved: true });
  assert.equal(r.body.redeploy, 'started');

  assert.deepEqual(calls.teardownStagingForSession.map((c) => c[0].sessionId), [9, 10]);
  assert.deepEqual(calls.closePR.map((c) => c[2]), [43], 'the open PR is closed; the merged one is history');
  const [del] = queriesLike('DELETE FROM chat_sessions');
  assert.deepEqual(del.params[0], [9, 10]);
  assert.deepEqual(state.sessions.map((s) => s.id), [11], 'the creator\'s own proposal survives');
  assert.deepEqual(calls.forceBranchToSha[0], ['usernode-bot', 'demo-app', 'main', 'b'.repeat(40)]);
  await settle();
  assert.equal(calls.rebuildProduction[0][1].slug, 'demo-app');
  assert.equal(queriesLike('INSERT INTO app_activity').length, 1, 'standing refreshed for the next take');
});

test('when nothing merged, main is already at the base and nothing rebuilds', async () => {
  state.mainMoves = false;
  const r = await post('/api/apps/demo-app/demo/reset', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.main.moved, false);
  assert.equal(r.body.redeploy, 'skipped');
  await settle();
  assert.equal(calls.rebuildProduction, undefined);
});

// ── Status ──────────────────────────────────────────────────────────────

test('status names what would spoil the take, and is quiet when nothing would', async () => {
  state.notify = false;
  let r = await get('/api/apps/demo-app/demo');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ready, false);
  assert.equal(r.body.notifyOnNewProposals, false);
  assert.equal(r.body.reasons.length, 1);
  assert.match(r.body.reasons[0], /New proposals to vote on/);
  assert.equal(r.body.required, 2);

  state.notify = true;
  r = await get('/api/apps/demo-app/demo');
  assert.equal(r.body.ready, true);
  assert.deepEqual(r.body.reasons, []);
  assert.equal(r.body.partner.username, 'sam');
  assert.equal(r.body.baseSha, 'b'.repeat(40));

  // Approvals mode counts VOTES, so how lately anybody used the app does not
  // enter into the threshold — the reason that would have named it is gone.
  state.activeIds = [50];
  r = await get('/api/apps/demo-app/demo');
  assert.equal(r.body.creatorActive, false);
  assert.equal(r.body.required, 2, 'the rule is the number, not the electorate');
  assert.equal(r.body.approvalsRequired, 2);
  assert.deepEqual(r.body.reasons, [], 'nothing about this would spoil the take');

  // On the app's own timed rule, the old arithmetic is what applies: one
  // active voter means one yes merges, which is the take spoiled.
  state.apps.get('demo-app').approvals_required = null;
  r = await get('/api/apps/demo-app/demo');
  assert.equal(r.body.ready, false);
  assert.equal(r.body.approvalsRequired, null);
  assert.equal(r.body.required, 1);
  assert.ok(r.body.reasons.some((x) => /not counted as a voter/.test(x)));
  assert.ok(r.body.reasons.some((x) => /expects 2/.test(x)));
  assert.ok(r.body.reasons.some((x) => /Goes live in ~3d/.test(x)),
    'and the card would count down rather than tally');
});

test('status reports the open proposal with its tally', async () => {
  state.sessions.push({
    id: 9, app_id: 1, user_id: 50, status: 'promoted', pr_number: 42,
    pr_title: 'Smooth', pr_url: 'u', staging_url: 's',
  });
  state.tally = [{ vote: 'yes', n: 1 }];
  const r = await get('/api/apps/demo-app/demo');
  assert.deepEqual(r.body.openProposal, {
    sessionId: 9, status: 'promoted', held: false, prNumber: 42, prUrl: 'u', title: 'Smooth', stagingUrl: 's',
    checkState: null, previewReady: true,
    votes: { yes: 1, no: 0 },
  });
});

test('status reports a held proposal, and whether its preview is built yet', async () => {
  state.sessions.push({
    id: 9, app_id: 1, user_id: 50, status: 'active', pr_number: 42, pr_title: 'Smooth', pr_url: 'u',
    staging_url: null, check_state: 'pending',
  });
  let r = await get('/api/apps/demo-app/demo');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.openProposal.held, true);
  assert.equal(r.body.openProposal.status, 'active');
  assert.equal(r.body.openProposal.checkState, 'pending');
  assert.equal(r.body.openProposal.previewReady, false);
  // Minutes later: the preview is up and the checks have run.
  Object.assign(state.sessions[0], { staging_url: 's', check_state: 'passing' });
  r = await get('/api/apps/demo-app/demo');
  assert.equal(r.body.openProposal.checkState, 'passing');
  assert.equal(r.body.openProposal.previewReady, true);
  assert.equal(r.body.openProposal.held, true, 'built is not announced');
});

test('branch names are refs, never paths', () => {
  assert.equal(validBranch('demo/animations'), true);
  assert.equal(validBranch('feature-1.2'), true);
  assert.equal(validBranch('../main'), false);
  assert.equal(validBranch('a..b'), false);
  assert.equal(validBranch('x/'), false);
  assert.equal(validBranch('x.lock'), false);
  assert.equal(validBranch(''), false);
});

// ── Propose from a patch ──────────────────────────────────────────────

test('a patch is applied at the live head as the bot, and the proposal opens from the branch it made', async () => {
  // The app's repository is bot-owned and the creator cannot push to it, so
  // this is the usual way a change arrives. Same service submit_work's patch
  // shape uses; what is pinned here is what it is handed.
  const patch = 'diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-old\n+new\n';
  const r = await post('/api/apps/demo-app/demo/propose', { patch, title: 'Smooth category animations' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.headSha, 'd'.repeat(40), 'the head the patch produced');

  const [[applied]] = calls.applyPatch;
  assert.equal(`${applied.owner}/${applied.repo}`, 'usernode-bot/demo-app');
  assert.equal(applied.patch, patch, 'the patch, byte for byte');
  assert.equal(applied.baseSha, 'a'.repeat(40), 'main\'s LIVE head, not the recorded base or the deployed sha');
  assert.equal(applied.userId, 50, 'attributed to the partner');
  assert.equal(calls.getBranchSha, undefined, 'no branch was looked up: the patch made one');
  const [[, , pr]] = calls.createPR;
  assert.equal(pr.branch, 'usernode/patch-u50-tdemo-1-abc123', 'the PR opens from the branch applyPatch pushed');
  const [insert] = queriesLike('INSERT INTO chat_sessions');
  assert.equal(insert.params[2], 'usernode/patch-u50-tdemo-1-abc123');
  assert.equal(insert.params[6], 'd'.repeat(40));
  assert.equal(calls.patchCleanup, undefined, 'the branch is kept: the PR opened');
});

test('a patch the platform refuses proposes nothing, with the platform\'s own reason', async () => {
  state.patchResult = { ok: false, code: 'patch_too_large', message: 'That patch is 300 KB, over the 256 KB a patch can be.' };
  let r = await post('/api/apps/demo-app/demo/propose', { patch: 'diff --git a/x b/x', title: 'x' });
  assert.equal(r.status, 413);
  assert.match(r.body.error, /300 KB/);
  assert.equal(r.body.code, 'patch_too_large');
  assert.equal(calls.createPR, undefined);
  assert.equal(queriesLike('INSERT INTO chat_sessions').length, 0);

  state.patchResult = { ok: false, code: 'patch_did_not_apply', message: 'The patch does not apply at that commit.' };
  r = await post('/api/apps/demo-app/demo/propose', { patch: 'diff --git a/x b/x', title: 'x' });
  assert.equal(r.status, 409);
});

test('when the PR does not open, the branch the patch pushed is removed again', async () => {
  state.prFails = true;
  const r = await post('/api/apps/demo-app/demo/propose', { patch: 'diff --git a/x b/x', title: 'x' });
  assert.equal(r.status, 502);
  assert.equal(calls.patchCleanup.length, 1, 'applyPatch\'s cleanup ran');
  assert.equal(queriesLike('INSERT INTO chat_sessions').length, 0, 'and nothing was proposed');
  assert.equal(calls.createPrProposedNotifications, undefined, 'so nobody was notified');
});

test('branch and patch are one or the other', async () => {
  let r = await post('/api/apps/demo-app/demo/propose', { branch: 'demo/x', patch: 'diff --git a/x b/x', title: 'x' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not both/);
  r = await post('/api/apps/demo-app/demo/propose', { title: 'x' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /branch .* or patch/);
  assert.equal(calls.applyPatch, undefined);
  assert.equal(calls.createPR, undefined);
});
