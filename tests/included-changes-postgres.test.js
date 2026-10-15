'use strict';

// A change that went live inside another one, against the real schema
// (services/included-changes.js).
//
// The production run-through it comes from (Flat 4B Chores, 5 Oct 2026):
// request #1 "First version of Flat 4B Chores" was built by the Homeroom bot
// as PR 3 and waited for approval. Asked in the group chat to fix it, the bot
// built PR 8 (request #7) on PR 3's branch, so PR 8 carried PR 3's commit.
// PR 8 merged, squashed. PR 3 stayed open, request #1 stayed open, and the
// App tab still said "Step 6 of 7: Approval" over the live app.
//
// What only the database can show: the compare-and-set marks only the change
// whose head the merged pull request carried, with the merge's own time and
// commit; the project's first version then reads live
// (homeroom-bot-dm.js firstVersionState) and its request "approved and
// live"; the bot's queued work on it goes (homeroom-bot.js
// noteRequestMerged); the journey records the first version live; the
// request's twin row and bounty settle; the change page's read names the
// carrying change and undo refuses it. And the other order, the lower change
// merging first, includes nothing. GitHub is stubbed, as the merge tests do.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');

const DSN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

const sha = (c) => c.repeat(40);

test('a change built on another carries it live, against the full PostgreSQL schema', { timeout: 180000 }, async (t) => {
  const admin = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000 });
  try { await admin.query('SELECT 1'); } catch (err) {
    await admin.end();
    if (process.env.TEST_DATABASE_URL) throw err;
    t.skip('PostgreSQL unavailable; set TEST_DATABASE_URL to require this check');
    return;
  }
  const name = `included_${crypto.randomBytes(6).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DSN); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: String(url), max: 8 });
  const cleanup = [];
  t.after(async () => {
    for (const step of cleanup) await step();
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  await pool.query(fs.readFileSync(require.resolve('../src/db/schema.sql'), 'utf8'));

  const included = require('../src/services/included-changes');
  const dm = require('../src/services/homeroom-bot-dm');
  const progress = require('../src/services/homeroom-bot-progress');
  const watcher = require('../src/services/issue-close-watcher');

  let seq = 0;
  async function user(prefix, { synthetic = false } = {}) {
    const { rows } = await pool.query(
      `INSERT INTO users (username, password, has_platform_access, is_synthetic)
       VALUES ($1, 'x', TRUE, $2) RETURNING id, username`,
      [synthetic ? prefix : `${prefix}_${++seq}`, synthetic],
    );
    return rows[0];
  }
  const bot = await user('homeroom_bot', { synthetic: true });
  const jordan = await user('jordan');
  const sam = await user('sam');

  async function project(slug) {
    const { rows: [row] } = await pool.query(
      `INSERT INTO apps (name, slug, status, created_by, repo_url, view_visibility, collab_visibility)
       VALUES ('Flat 4B Chores', $1, 'running', $2, $3, 'public', 'public') RETURNING *`,
      [slug, jordan.id, `https://github.com/usernode-bot/${slug}`],
    );
    await pool.query(`INSERT INTO app_collaborators (app_id, user_id, status) VALUES ($1, $2, 'member')`, [row.id, jordan.id]);
    return row;
  }
  async function change(app, fields) {
    const f = {
      user_id: bot.id, status: 'promoted', linked_issues: [], check_state: 'passing', merged_at: null,
      merge_commit_sha: null, active_turn: null, ...fields,
    };
    const { rows: [row] } = await pool.query(
      `INSERT INTO chat_sessions (app_id, user_id, status, pr_number, pr_title, linked_issues, reviewed_head_sha,
                                  check_state, promoted_at, merged_at, merge_commit_sha, active_turn)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() - INTERVAL '1 hour', $9, $10, $11) RETURNING *`,
      [app.id, f.user_id, f.status, f.pr_number, f.pr_title, f.linked_issues, f.head, f.check_state,
       f.merged_at, f.merge_commit_sha, f.active_turn],
    );
    return row;
  }
  // The merged change as finalizeMerge holds it.
  const asMerged = async (session) => (await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`,
    [session.id],
  )).rows[0];
  const statusOf = async (id) => (await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id])).rows[0].status;

  // GitHub and the realtime layer stand in; the bot's bookkeeping, the
  // journey, the bounty and the twin row are the real ones.
  function deps({ commits }) {
    const calls = [];
    const rec = (name) => async (...args) => { calls.push([name, ...args.filter((a) => !(a && typeof a.query === 'function'))]); return true; };
    return {
      calls,
      deps: {
        github: {
          isEnabled: () => true,
          listPullRequestCommitShas: async (owner, repo, n) => { calls.push(['list', owner, repo, n]); return { shas: commits, complete: true }; },
          createIssueComment: rec('comment'),
          closePR: rec('closePR'),
          closeIssue: rec('closeIssue'),
          noteIssuesClosed() {},
          unsuppressIssues() {},
        },
        ws: { sendSystemMessage: rec('line'), sendBotMessage: rec('bot'), pushVoteUpdate: (d) => { calls.push(['vote_update', d]); } },
        staging: { teardownStaging: rec('teardown') },
        worker: { retireWorker: rec('retire') },
        notifications: { createPrMergedNotification: async (_p, a) => { calls.push(['notify', a]); return []; }, hydrateAndPush: rec('push') },
        agentSessions: { noteChangeClosed: rec('agent') },
        dm: { noteProposalMerged: rec('dm') },
        watcher: {
          bustAndBroadcast: (a) => { calls.push(['bust', a.closed]); },
          resolveSupersededProposals: () => {},
          withdrawBotProposals: () => {},
          closeTwinRows: watcher.closeTwinRows,
        },
        isSessionBusy: () => false,
      },
    };
  }

  // ── The run-through ───────────────────────────────────────────────────
  const app = await project('flat-4b-chores-e98ecd');
  await pool.query(
    `INSERT INTO homeroom_bot_first_versions (app_id, user_id, brief, bot_builds, status, issue_number, filed_at)
     VALUES ($1, $2, 'Who does which chore this week', TRUE, 'filed', 1, NOW())`,
    [app.id, jordan.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_requesters (app_id, issue_number, user_id, issue_title, first_version)
     VALUES ($1, 1, $2, 'First version of Flat 4B Chores', TRUE), ($1, 7, $3, 'Fix mark as done', FALSE)`,
    [app.id, jordan.id, sam.id],
  );
  // The request's twin row, and a bounty sam pledged on it.
  await pool.query(
    `INSERT INTO issues (app_id, github_issue_number, title, kind, created_by, status)
     VALUES ($1, 1, 'First version of Flat 4B Chores', 'general', $2, 'open')`,
    [app.id, jordan.id],
  );
  await pool.query(
    `INSERT INTO issue_bounties (app_id, github_issue_number, giver_user_id, week_start) VALUES ($1, 1, $2, CURRENT_DATE)`,
    [app.id, sam.id],
  );

  const pr3 = await change(app, { pr_number: 3, pr_title: 'First version of Flat 4B Chores', linked_issues: [1], head: sha('3') });
  const pr8 = await change(app, {
    pr_number: 8, pr_title: 'Fix mark as done in Jordan’s first version', linked_issues: [7], head: sha('8'),
    status: 'merged', merged_at: new Date('2026-10-05T11:00:00Z'), merge_commit_sha: sha('c'),
  });
  // Up for a vote beside them: one never built on, one whose turn is running,
  // and one holding a secret value of its own. Each would be on the list.
  const pr5 = await change(app, { user_id: sam.id, pr_number: 5, pr_title: 'Dark mode', head: sha('5') });
  const pr9 = await change(app, { user_id: sam.id, pr_number: 9, pr_title: 'Rota colours', head: sha('9'), active_turn: { mode: 'chat' } });
  const pr10 = await change(app, { user_id: sam.id, pr_number: 10, pr_title: 'Reminders', head: sha('a') });
  await pool.query(
    `INSERT INTO pending_secret_declarations (app_id, session_id, scope, key, declaration, created_by)
     VALUES ($1, $2, 'app', 'PUSH_KEY', '{}'::jsonb, $3)`,
    [app.id, pr10.id, sam.id],
  );
  await pool.query(
    `INSERT INTO homeroom_bot_runs (app_id, issue_number, mode, verdict, build_ok, proposal_session_id)
     VALUES ($1, 1, 'live', 'ready', TRUE, $2), ($1, 7, 'live', 'ready', TRUE, $3)`,
    [app.id, pr3.id, pr8.id],
  );

  await t.test('before: the first version waits for approval over the live app', async () => {
    const state = await dm.firstVersionState(pool, app.id);
    assert.ok(state, 'the bug: still being built');
    assert.equal(state.ready, true, 'Step 6 of 7: Approval');
  });

  // A reply on request #1 queued for the bot, which its merge would drop.
  await pool.query(`INSERT INTO homeroom_bot_queue (app_id, issue_number, priority, reason) VALUES ($1, 1, 1, 'reply')`, [app.id]);

  const { deps: d, calls } = deps({ commits: [sha('3'), sha('8'), sha('9'), sha('a')] });
  let out;
  await t.test('PR 8 merging marks PR 3 merged as included in it, and nothing else', async () => {
    out = await included.includeStackedChanges({ pool, session: await asMerged(pr8), deps: d });
    assert.deepEqual(out.included, [pr3.id]);
    const { rows: [row] } = await pool.query('SELECT * FROM chat_sessions WHERE id = $1', [pr3.id]);
    assert.equal(row.status, 'merged');
    assert.equal(row.included_in_session_id, pr8.id);
    assert.equal(row.merge_commit_sha, sha('c'), 'the merge it went live in');
    assert.equal(new Date(row.merged_at).toISOString(), '2026-10-05T11:00:00.000Z', 'and its time');
    assert.equal(await statusOf(pr5.id), 'promoted', 'a change never built on is left alone');
    assert.equal(await statusOf(pr9.id), 'promoted', 'a change whose turn is running decides for itself');
    assert.equal(await statusOf(pr10.id), 'promoted', 'a secret value waits for its own merge');
    assert.deepEqual(calls[0], ['list', 'usernode-bot', 'flat-4b-chores-e98ecd', 8], 'one read of the merged pull request');
  });

  await t.test('then it is settled the way its own merge would have', async () => {
    const [did] = await out.done;
    assert.deepEqual(did, { id: pr3.id, prClosed: true, requestsClosed: [1] });
    const find = (name) => calls.filter((c) => c[0] === name);
    // And its request ends with the bot's line that it is live (live.announceLive).
    assert.deepEqual(find('comment'), [
      ['comment', 'usernode-bot', 'flat-4b-chores-e98ecd', 3, 'Included in #8, which went live.'],
      ['comment', 'usernode-bot', 'flat-4b-chores-e98ecd', 1, 'Homeroom bot\'s change for this is live: First version of Flat 4B Chores.'],
    ]);
    const said = find('bot');
    assert.equal(said.length, 1);
    assert.match(said[0][2].content, /^It's live\. First version of Flat 4B Chores is in .+ now\.$/);
    assert.deepEqual(said[0][2].thread, { type: 'issue', ref: 1 });
    assert.deepEqual(find('closePR'), [['closePR', 'usernode-bot', 'flat-4b-chores-e98ecd', 3]]);
    assert.deepEqual(find('closeIssue'), [['closeIssue', 'usernode-bot', 'flat-4b-chores-e98ecd', 1]], 'request #1, never #7');
    assert.match(find('line')[0][2], /^PR #3: First version of Flat 4B Chores went live as part of PR #8: /);
    assert.equal(find('dm')[0][1].id, pr3.id, 'whoever asked for it hears it is live');

    // The first version is live: the App tab shows the app.
    assert.equal(await dm.firstVersionState(pool, app.id), null);
    // Its request reads approved and live in the bot's words.
    const states = await progress.requestStates(pool, { userId: jordan.id });
    const first = states.find((s) => Number(s.row.issue_number) === 1);
    assert.equal(first.state, null, 'nothing in progress');
    assert.equal(progress.outcomeOf(first.row), 'approved and live');
    // The bot's queued reply on it is gone (homeroom-bot.js noteRequestMerged).
    const { rows: queued } = await pool.query('SELECT 1 FROM homeroom_bot_queue WHERE app_id = $1 AND issue_number = 1', [app.id]);
    assert.equal(queued.length, 0);
    // The journey records the first version live, for whoever asked.
    const { rows: [live] } = await pool.query(
      `SELECT metadata FROM events WHERE event_type = 'change_live' AND session_id = $1`, [pr3.id]);
    assert.equal(live.metadata.firstVersion, true);
    assert.ok(live.metadata.requesterIds.includes(jordan.id));
    // The request's twin row closed, and sam's bounty went to its author.
    await new Promise((r) => setTimeout(r, 50));
    const { rows: [twin] } = await pool.query(
      `SELECT status FROM issues WHERE app_id = $1 AND github_issue_number = 1 AND kind = 'general'`, [app.id]);
    assert.equal(twin.status, 'closed');
    const { rows: [bounty] } = await pool.query(
      'SELECT status, awarded_session_id FROM issue_bounties WHERE app_id = $1 AND github_issue_number = 1', [app.id]);
    assert.equal(bounty.status, 'awarded');
    assert.equal(bounty.awarded_session_id, pr3.id);
  });

  await t.test('a second pass finds nothing more to include', async () => {
    const again = deps({ commits: [sha('3'), sha('8')] });
    const second = await included.includeStackedChanges({ pool, session: await asMerged(pr8), deps: again.deps });
    assert.deepEqual(second.included, []);
  });

  await t.test('its page names the carrying change, and undo refuses it', async () => {
    const express = require('express');
    const { getPool } = require('../src/db/pool');
    const config = { databaseUrl: String(url), selfAppSlug: 'no-such-self-app', selfAppPublicVoting: true };
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.user = { id: jordan.id, username: jordan.username, isAdmin: false, hasPlatformAccess: true };
      next();
    });
    server.use(require('../src/routes/votes').voteRoutes(config));
    const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
    cleanup.push(async () => {
      await new Promise((r) => listener.close(r));
      await getPool(config).end().catch(() => {});
    });
    const base = `http://127.0.0.1:${listener.address().port}`;

    const res = await fetch(`${base}/api/apps/${app.slug}/proposals/${pr3.id}`);
    assert.equal(res.status, 200);
    const { proposal } = await res.json();
    assert.equal(proposal.status, 'merged');
    assert.equal(proposal.included_in_session_id, pr8.id);
    assert.equal(proposal.included_in_pr_number, 8);
    assert.equal(proposal.included_in_pr_title, 'Fix mark as done in Jordan’s first version');
    const own = await (await fetch(`${base}/api/apps/${app.slug}/proposals/${pr8.id}`)).json();
    assert.equal(own.proposal.included_in_session_id, null, 'the carrying change merged on its own');

    const undo = await fetch(`${base}/api/sessions/${pr3.id}/undo`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(undo.status, 409);
    const body = await undo.json();
    assert.equal(body.error, 'This change went live as part of another change. Undo that change instead.');
    assert.equal(body.includedInSessionId, pr8.id);
    const { rows: reverts } = await pool.query('SELECT 1 FROM chat_sessions WHERE revert_of_session_id = $1', [pr3.id]);
    assert.equal(reverts.length, 0, 'no revert started');
  });

  await t.test('the other order: the lower change merging first includes nothing', async () => {
    const other = await project('flat-4c-chores');
    const lower = await change(other, {
      pr_number: 3, pr_title: 'First version', linked_issues: [1], head: sha('d'),
      status: 'merged', merged_at: new Date(), merge_commit_sha: sha('e'),
    });
    // The stacked one carries the lower one's commit, but the lower pull
    // request's own commits are only its own.
    const stacked = await change(other, { pr_number: 8, pr_title: 'Fix', linked_issues: [7], head: sha('f') });
    const run = deps({ commits: [sha('d')] });
    const res = await included.includeStackedChanges({ pool, session: await asMerged(lower), deps: run.deps });
    assert.deepEqual(res.included, []);
    assert.equal(await statusOf(stacked.id), 'promoted', 'it goes on to its own vote');
    assert.equal(run.calls.filter((c) => c[0] !== 'list').length, 0);
  });
});
