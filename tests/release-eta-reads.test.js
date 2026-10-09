// The reads that carry `release` to the surfaces (#4309 follow-up): each one
// asks services/release-watch.js releasesFor about the changes it shows going
// live, and nothing else. Its SQL keeps only merged, not-live changes of the
// self-hosted app, so a child app's change and one still being merged come
// back without one and keep their words (tests/release-eta-surfaces.test.js).
//
// Fake pools: the Postgres suites for these reads skip without
// TEST_DATABASE_URL, and these pin only what this change added to them.
//
// Run with: node --test tests/release-eta-reads.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const releaseWatch = require('../src/services/release-watch');

const MIN = 60 * 1000;
const NOW = Date.now();

// One pool for every read below: `answer(sql, params)` first, then the two
// queries releasesFor makes. Change 50 is the Homeroom merge waiting for its
// release; anything else asked about is not one (a child app's, or still
// being merged), as the SQL would say.
function pool(answer) {
  const queries = [];
  return {
    queries,
    asked: () => queries.filter((q) => /cs\.id = ANY\(\$1::int\[\]\)/.test(q.sql)).map((q) => q.params[0]),
    async query(sql, params) {
      sql = String(sql);
      queries.push({ sql, params });
      const rows = answer(sql, params);
      if (rows !== undefined) return { rows, rowCount: rows.length };
      if (/cs\.id = ANY\(\$1::int\[\]\)/.test(sql)) {
        return { rows: params[0].includes(50) ? [{ id: 50, merged_at: new Date(NOW - MIN) }] : [] };
      }
      if (/FROM apps a\s+LEFT JOIN LATERAL/.test(sql)) {
        return { rows: [{ id: 1, main_sha: null, last_deploy_at: new Date(NOW - 3 * MIN), release_stall: null,
          release_run: null, newest_at: new Date(NOW - MIN) }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const EXPECTED = () => ({ state: 'next', etaAt: new Date(NOW + 8 * MIN).toISOString() });
const APP = (over = {}) => ({
  id: 3, slug: 'usernode-2d5619', name: 'Homeroom', created_by: 1, self_hosted: true,
  collab_visibility: 'public', view_visibility: 'public', moderation_suspended_at: null, ...over,
});

test.beforeEach(() => releaseWatch._forTest.resetOutlook());

test('agent sessions: a Homeroom change going live carries its release; a child app\'s is not asked about', async () => {
  const agentSessions = require('../src/services/agent-sessions');
  const row = (id, change) => ({ id, user_id: 4, title: 't', title_source: 'auto', status: 'open', ...change });
  const p = pool((sql) => {
    if (/FROM agent_sessions s/.test(sql) && /LIMIT \$4/.test(sql)) {
      return [
        row(7, { change_id: 50, change_status: 'merging', change_app_slug: 'usernode-2d5619', change_app_self_hosted: true }),
        row(8, { change_id: 60, change_status: 'merging', change_app_slug: 'notes', change_app_self_hosted: false }),
        row(9, { change_id: 70, change_status: 'merging', change_app_slug: 'usernode-2d5619', change_app_self_hosted: true }),
        row(10, { change_id: 80, change_status: 'promoted', change_app_slug: 'usernode-2d5619', change_app_self_hosted: true }),
      ];
    }
    return undefined;
  });
  const { sessions } = await agentSessions.listAgentSessions(p, { userId: 4 });
  assert.deepEqual(sessions[0].activeChange.release, EXPECTED());
  assert.equal(sessions[1].activeChange.release, undefined, 'a child app\'s');
  assert.equal(sessions[2].activeChange.release, undefined, 'still being merged: the read finds no merged row');
  assert.equal(sessions[3].activeChange.release, undefined);
  assert.deepEqual(p.asked(), [[50, 70]], 'one read, for the Homeroom changes going live only');

  // Nothing going live: no read at all.
  const quiet = pool((sql) => (/FROM agent_sessions s/.test(sql) ? [row(10, { change_id: 80, change_status: 'active', change_app_self_hosted: true })] : undefined));
  await agentSessions.listAgentSessions(quiet, { userId: 4 });
  assert.deepEqual(quiet.asked(), []);
});

test('agent sessions: the conversation and its changes drawer', async () => {
  const agentSessions = require('../src/services/agent-sessions');
  const change = { change_id: 50, change_status: 'merging', change_app_slug: 'usernode-2d5619', change_app_self_hosted: true };
  const p = pool((sql) => {
    if (/FROM agent_sessions s/.test(sql)) return [{ id: 7, user_id: 4, title: 't', title_source: 'auto', status: 'open', ...change }];
    if (/FROM chat_sessions c JOIN apps a/.test(sql)) return [change, { ...change, change_id: 49, change_status: 'merged' }];
    return undefined;
  });
  const session = await agentSessions.getAgentSession(p, { userId: 4, id: 7 });
  assert.deepEqual(session.activeChange.release, EXPECTED());
  assert.deepEqual(session.changes[0].release, EXPECTED());
  assert.equal(session.changes[1].release, undefined, 'live');
  assert.deepEqual(p.asked(), [[50]]);
});

test('the bot DM\'s ready cards: a Homeroom merge going live says when', async () => {
  const dm = require('../src/services/homeroom-bot-dm');
  const card = (message_id, session_id, status, app) => ({ message_id, session_id, status, live_at: null, ...app });
  const p = pool((sql) => (/FROM homeroom_bot_dm_messages d/.test(sql) ? [
    card(1, 50, 'merged', APP()),
    card(2, 60, 'merged', APP({ id: 4, slug: 'notes', name: 'Notes', self_hosted: false })),
    card(3, 70, 'merging', APP()),
  ] : undefined));
  const states = await dm.readyStates(p, { user: { id: 4 } });
  assert.deepEqual(states.map((s) => [s.messageId, s.state, s.release || null]), [
    [1, 'going_live', EXPECTED()],
    [2, 'going_live', null],
    [3, 'going_live', null],
  ]);
  assert.deepEqual(p.asked(), [[50]], 'only a merged change of the self-hosted app is asked about');
});

test('the bot DM\'s activity cards: one going live says when', async () => {
  const activity = require('../src/services/homeroom-bot-activity');
  const at = new Date(NOW - 30 * MIN);
  const card = (message_id, proposal_session_id, slug) => ({
    message_id, app_id: 3, issue_number: message_id, created_at: at, first_at: at, began: at, slug, name: slug,
    look_at: null, started_at: null, earlier_runs: null, next_at: null,
    run_id: message_id, verdict: 'ready', build_ok: true, build_error: null, cap_suppressed: false, run_at: at,
    proposal_session_id, proposal_pr_number: null, build_waiting_at: null, build_status: 'merged',
    proposal_status: 'merging', proposal_at: at, told: true, needs_look: false,
  });
  const p = pool((sql) => {
    if (/WITH stamped AS/.test(sql)) return [card(31, 50, 'usernode-2d5619'), card(32, 60, 'notes')];
    if (/FROM apps\s+WHERE slug = ANY/.test(sql)) return [APP(), APP({ id: 4, slug: 'notes', self_hosted: false })];
    return undefined;
  });
  const { cards } = await activity.cardsFor(p, { user: { id: 4 }, deps: { dm: { readyStates: async () => [] } } });
  assert.deepEqual(cards.map((c) => [c.messageId, c.outcome, c.release || null]), [
    [31, 'going_live', EXPECTED()],
    [32, 'going_live', null],
  ]);
  assert.deepEqual(p.asked(), [[50, 60]], 'the SQL, not the caller, tells a child app\'s apart');
});

test('the bot\'s tray: a History entry going live says when', async () => {
  const tray = require('../src/services/homeroom-bot-tray');
  const at = new Date(NOW - 20 * MIN);
  const run = (id, proposal_session_id, slug) => ({
    id, issue_number: id, verdict: 'ready', build_ok: true, build_error: null, cap_suppressed: false,
    proposal_session_id, proposal_pr_number: null, created_at: at, awaiting_go_at: null, request_closed: false, plan_only: false,
    proposal_status: 'merging', proposal_at: at, merged_at: null, slug, name: slug, issue_title: 'Say when', first_version: false,
  });
  const p = pool((sql) => {
    if (/FROM homeroom_bot_requesters q/.test(sql)) return [run(12, 50, 'usernode-2d5619'), run(13, 60, 'notes')];
    if (/FROM apps WHERE slug = ANY/.test(sql)) return [APP(), APP({ id: 4, slug: 'notes', self_hosted: false })];
    return undefined;
  });
  const work = await tray.workFor(p, { user: { id: 4 }, settings: { mode: 'off' } });
  const byApp = new Map(work.history.map((job) => [job.appSlug, job]));
  assert.equal(byApp.get('usernode-2d5619').outcome, 'going_live');
  assert.deepEqual(byApp.get('usernode-2d5619').release, EXPECTED());
  assert.equal(byApp.get('notes').release, undefined);
});

test('a project\'s chat: the requester\'s card, approved and merged into Homeroom, says when', async () => {
  const chat = require('../src/services/homeroom-bot-chat');
  const state = (chat_message_id, session_id, session_status) => ({
    chat_message_id, kind: 'filed', issue_number: chat_message_id, app_id: 3, chip: null, queued: false, queue_waiting: false,
    queue_reason: null, first_version: false, issue_status: 'open', run_id: 7, verdict: 'ready', build_ok: true, build_error: null,
    cap_suppressed: false, proposal_session_id: session_id, build_waiting_at: null, build_status: null,
    session_id, session_status, check_state: 'passing',
  });
  const p = pool((sql) => (/FROM chat_bot_requests r/.test(sql)
    ? [state(5, 50, 'merged'), state(6, 70, 'merging'), state(8, 80, 'promoted')] : undefined));
  const rows = [5, 6, 8].map((id) => ({ chat_message_id: id, kind: 'filed', issue_number: id, title: 'Dark mode', session_id: null, app_id: 3 }));
  const deps = { dm: { botAccount: async () => ({ id: 99 }), typicalMinutes: async () => null, approvalState: async () => null } };
  const cards = await chat.cardsOf(p, { appId: 3, user: { id: 4 }, rows, deps });
  assert.deepEqual(cards.map((c) => [c.messageId, c.state && c.state.stage, (c.state && c.state.release) || null]), [
    [5, 'approved', EXPECTED()],
    [6, 'approved', null],
    [8, 'proposed', null],
  ]);
  assert.deepEqual(p.asked(), [[50, 70]], 'approved cards only');
});

test('the leaderboard\'s change lists ask about the rows going live', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'routes', 'kudos.js'), 'utf8');
  assert.equal((src.match(/await withReleases\(pool, rows\);/g) || []).length, 2, 'Top changes and a person\'s changes');
  assert.match(src, /row\.status === 'merging' && row\.session_id != null/);
});
